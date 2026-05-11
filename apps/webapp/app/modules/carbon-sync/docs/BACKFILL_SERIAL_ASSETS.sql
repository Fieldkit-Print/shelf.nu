-- =============================================================================
-- One-time backfill: mint Shelf Assets for existing Carbon serial units
-- =============================================================================
--
-- Run this against Shelf's database after:
--
--   1. CARBON_MIGRATION.sql       (Carbon side; adds visibleInShelf etc.)
--   2. CONTRACT_VIEWS_CARBON.sql  (Carbon side; defines v1_parts,
--                                  v1_tracked_entities, v1_item_ledger)
--   3. FDW_SETUP_SHELF.sql        (Shelf side; re-imports carbon_remote)
--   4. Prisma migration 20260511180000_asset_carbon_tracked_entity_id
--
-- Selects every trackedEntity in Fieldkit's Carbon company whose parent
-- item is serial-tracked + active, joins to its earliest itemLedger row
-- to confirm the unit was actually received into inventory, then inserts
-- one INSTANCE Asset per row. The unique constraint on
-- Asset.carbonTrackedEntityId makes the script idempotent — re-running
-- only inserts rows for trackedEntities not yet linked to a Shelf Asset.
--
-- After this lands, Asset.sequentialId will be NULL on the inserted rows
-- (Shelf's app-level sequencer doesn't run from SQL). The next time a
-- user opens each asset's detail page, or the next itemLedger webhook
-- for that unit, will populate sequentialId and push it back into
-- Carbon's trackedEntity.attributes.
--
-- =============================================================================

-- Replace these two values before running:
--   :org_id     — Shelf Organization id that hosts customer tenancy
--                 (the value of FIELDKIT_PRIMARY_ORGANIZATION_ID)
--   :company_id — Fieldkit's Carbon company id
--                 (the value of FIELDKIT_CARBON_COMPANY_ID)
\set org_id     'REPLACE_WITH_ORGANIZATION_ID'
\set company_id 'REPLACE_WITH_FIELDKIT_CARBON_COMPANY_ID'

INSERT INTO "Asset" (
  id,
  "userId",
  "organizationId",
  title,
  description,
  "thumbnailImage",
  value,
  kind,
  "carbonPartId",
  "carbonTrackedEntityId",
  "availableToBook",
  status,
  "createdAt",
  "updatedAt"
)
SELECT
  -- cuid()-style isn't built into Postgres; gen_random_uuid stripped of
  -- dashes is the closest single-statement substitute. The shape doesn't
  -- matter — Shelf's app code reads by carbonTrackedEntityId on subsequent
  -- updates, not by id.
  'asset_' || replace(gen_random_uuid()::text, '-', '')           AS id,
  (SELECT "userId" FROM "Organization" WHERE id = :'org_id')      AS "userId",
  :'org_id'                                                       AS "organizationId",
  p.name || ' #' || COALESCE(te.readable_id, te.id)               AS title,
  p.description                                                   AS description,
  p.thumbnail_url                                                 AS "thumbnailImage",
  p.standard_cost                                                 AS value,
  'INSTANCE'                                                      AS kind,
  earliest_ledger.item_id                                         AS "carbonPartId",
  te.id                                                           AS "carbonTrackedEntityId",
  true                                                            AS "availableToBook",
  'AVAILABLE'                                                     AS status,
  NOW()                                                           AS "createdAt",
  NOW()                                                           AS "updatedAt"
FROM carbon_remote.v1_tracked_entities te
JOIN LATERAL (
  -- Earliest itemLedger row for this tracked entity tells us which
  -- item it represents (trackedEntity has no direct itemId).
  SELECT il.item_id
  FROM carbon_remote.v1_item_ledger il
  WHERE il.tracked_entity_id = te.id
    AND il.quantity > 0
  ORDER BY il.posting_date ASC
  LIMIT 1
) earliest_ledger ON true
JOIN carbon_remote.v1_parts p ON p.id = earliest_ledger.item_id
WHERE te.company_id = :'company_id'
  AND p.active = true
  AND p.tracking_type = 'Serial'
ON CONFLICT ("carbonTrackedEntityId") DO NOTHING;

-- Verify
SELECT
  COUNT(*) AS minted_count,
  kind,
  status
FROM "Asset"
WHERE "organizationId" = :'org_id'
  AND "carbonTrackedEntityId" IS NOT NULL
GROUP BY kind, status;
