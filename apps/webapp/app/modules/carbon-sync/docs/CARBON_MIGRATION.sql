-- =============================================================================
-- Fieldkit shelf.nu ↔ Carbon ERP integration — Carbon-side migration
--
-- Apply this against your Carbon Supabase project. Idempotent; safe to re-run.
--
-- Parts:
--   1. Webhook subscriptions for `customerContact` and `contact` tables
--      (so Shelf can react to contact/link changes via Carbon's existing
--      webhook UI).
--   2. New `item.visibleInShelf` column controlling whether Carbon items
--      appear as Shelf Assets. Defaults true for Serial-tracked items
--      (handled by trigger) and false for everything else.
--   3. Drop the early `customer-asset-storage` machinery
--      (`customerAssetEvent` table and `item.customerId` column). Shelf is
--      now canonical for instance-level customer ownership.
--
-- HOW TO APPLY
--
-- Supabase Studio: open the SQL Editor for the Carbon project and paste
-- this file in. Run.
--
-- Verification:
--   SELECT name, "table" FROM "webhookTable" ORDER BY name;
--     -- should include Customer, Customer Contact, Contact
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'item' AND column_name = 'visibleInShelf';
--     -- should return one row
--   SELECT table_name FROM information_schema.tables
--     WHERE table_name = 'customerAssetEvent';
--     -- should return zero rows
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Webhook subscriptions for customerContact + contact
-- -----------------------------------------------------------------------------
INSERT INTO "webhookTable" ("table", "module", "name") VALUES
  ('customerContact', 'Sales', 'Customer Contact')
ON CONFLICT ("table") DO NOTHING;

INSERT INTO "webhookTable" ("table", "module", "name") VALUES
  ('contact', 'Sales', 'Contact')
ON CONFLICT ("table") DO NOTHING;

CREATE OR REPLACE TRIGGER "customerContactInsertWebhook"
AFTER INSERT ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_insert();

CREATE OR REPLACE TRIGGER "customerContactUpdateWebhook"
AFTER UPDATE ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_update();

CREATE OR REPLACE TRIGGER "customerContactDeleteWebhook"
AFTER DELETE ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_delete();

CREATE OR REPLACE TRIGGER "contactInsertWebhook"
AFTER INSERT ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_insert();

CREATE OR REPLACE TRIGGER "contactUpdateWebhook"
AFTER UPDATE ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_update();

CREATE OR REPLACE TRIGGER "contactDeleteWebhook"
AFTER DELETE ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_delete();

-- -----------------------------------------------------------------------------
-- 2) item.visibleInShelf
--
-- Drives whether a Carbon item appears as a Shelf Asset. Combined with the
-- item's tracking type:
--   visibleInShelf = true + Serial          → Shelf mints 1 INSTANCE per unit
--   visibleInShelf = true + Inventory/Batch → Shelf mints 1 CONSUMABLE per SKU
--   visibleInShelf = true + Non-Inventory   → no Shelf row
--   visibleInShelf = false                   → no Shelf row
-- -----------------------------------------------------------------------------
ALTER TABLE "item"
  ADD COLUMN IF NOT EXISTS "visibleInShelf" BOOLEAN NOT NULL DEFAULT false;

-- Default to true on INSERT for serial-tracked items. Operators can override
-- by toggling the column after creation.
CREATE OR REPLACE FUNCTION public.set_visible_in_shelf_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."itemTrackingType" = 'Serial' AND NEW."visibleInShelf" IS NOT DISTINCT FROM false THEN
    NEW."visibleInShelf" := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "itemVisibleInShelfDefault" ON "item";
CREATE TRIGGER "itemVisibleInShelfDefault"
BEFORE INSERT ON "item"
FOR EACH ROW EXECUTE FUNCTION public.set_visible_in_shelf_default();

-- Backfill: turn on for existing serial-tracked items.
UPDATE "item"
  SET "visibleInShelf" = true
  WHERE "itemTrackingType" = 'Serial' AND "visibleInShelf" = false;

-- -----------------------------------------------------------------------------
-- 3) Drop the early customer-asset-storage machinery
--
-- Shelf is now canonical for instance-level customer ownership
-- (`Asset.carbonCustomerId`) and movement events (`ActivityEvent`).
-- Carbon stops tracking customer-owned assets via `item.customerId` and
-- `customerAssetEvent`.
--
-- The `parts` view and `get_part_details` function (added in Carbon's
-- 20260413000000_customer-asset-storage.sql) both project `item.customerId`,
-- so we drop them first, drop the column, then recreate without that
-- column. The recreated definitions are byte-identical to the originals
-- minus the `customerId` references.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS "parts";
DROP FUNCTION IF EXISTS get_part_details(TEXT);
DROP TABLE IF EXISTS "customerAssetEvent";

ALTER TABLE "item" DROP COLUMN IF EXISTS "customerId";

-- Recreate parts view without customerId.
CREATE OR REPLACE VIEW "parts" WITH (SECURITY_INVOKER=true) AS
WITH latest_items AS (
  SELECT DISTINCT ON (i."readableId", i."companyId")
    i.*,
    mu.id as "modelUploadId",
    mu."modelPath",
    mu."thumbnailPath" as "modelThumbnailPath",
    mu."name" as "modelName",
    mu."size" as "modelSize"
  FROM "item" i
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  ORDER BY i."readableId", i."companyId", i."createdAt" DESC NULLS LAST
),
item_revisions AS (
  SELECT
    i."readableId",
    i."companyId",
    json_agg(
      json_build_object(
        'id', i.id,
        'revision', i."revision",
        'name', i."name",
        'description', i."description",
        'active', i."active",
        'createdAt', i."createdAt"
      ) ORDER BY i."createdAt"
    ) as "revisions"
  FROM "item" i
  GROUP BY i."readableId", i."companyId"
)
SELECT
  li."active",
  li."assignee",
  li."defaultMethodType",
  li."description",
  li."itemTrackingType",
  li."name",
  li."replenishmentSystem",
  li."unitOfMeasureCode",
  li."notes",
  li."revision",
  li."readableId",
  li."readableIdWithRevision",
  li."id",
  li."companyId",
  CASE
    WHEN li."thumbnailPath" IS NULL AND li."modelThumbnailPath" IS NOT NULL THEN li."modelThumbnailPath"
    ELSE li."thumbnailPath"
  END as "thumbnailPath",
  li."modelPath",
  li."modelName",
  li."modelSize",
  ps."supplierIds",
  uom.name as "unitOfMeasure",
  ir."revisions",
  p."customFields",
  p."tags",
  ic."itemPostingGroupId",
  (
    SELECT COALESCE(
      jsonb_object_agg(
        eim."integration",
        CASE
          WHEN eim."metadata" IS NOT NULL THEN eim."metadata"
          ELSE to_jsonb(eim."externalId")
        END
      ) FILTER (WHERE eim."externalId" IS NOT NULL OR eim."metadata" IS NOT NULL),
      '{}'::jsonb
    )
    FROM "externalIntegrationMapping" eim
    WHERE eim."entityType" = 'item' AND eim."entityId" = li.id
  ) AS "externalId",
  li."createdBy",
  li."createdAt",
  li."updatedBy",
  li."updatedAt"
FROM "part" p
INNER JOIN latest_items li ON li."readableId" = p."id" AND li."companyId" = p."companyId"
LEFT JOIN item_revisions ir ON ir."readableId" = p."id" AND ir."companyId" = p."companyId"
LEFT JOIN (
  SELECT
    "itemId",
    "companyId",
    string_agg(ps."supplierPartId", ',') AS "supplierIds"
  FROM "supplierPart" ps
  GROUP BY "itemId", "companyId"
) ps ON ps."itemId" = li."id" AND ps."companyId" = li."companyId"
LEFT JOIN "unitOfMeasure" uom ON uom.code = li."unitOfMeasureCode" AND uom."companyId" = li."companyId"
LEFT JOIN "itemCost" ic ON ic."itemId" = li.id;

-- Recreate get_part_details without customerId.
CREATE OR REPLACE FUNCTION get_part_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "visibleInShelf" BOOLEAN,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "unitOfMeasure" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY i."createdAt" DESC
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."description",
    i."itemTrackingType",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."visibleInShelf",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    uom.name as "unitOfMeasure",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ir."revisions",
    p."customFields",
    p."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt"
  FROM "part" p
  LEFT JOIN "item" i ON i."readableId" = p."id" AND i."companyId" = p."companyId"
  LEFT JOIN item_revisions ir ON true
  LEFT JOIN (
    SELECT
      ps."itemId",
      string_agg(ps."supplierPartId", ',') AS "supplierIds"
    FROM "supplierPart" ps
    GROUP BY ps."itemId"
  ) ps ON ps."itemId" = i.id
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 5) get_consumable_details — expose visibleInShelf
--
-- Same rationale as get_part_details above: the Carbon Consumable detail
-- sidebar reads visibleInShelf from this RPC so the toggle reflects current
-- state. Run this only if you've also taken the Carbon UI deploy that adds
-- the toggle to ConsumableProperties (it's tolerant if you don't — the
-- toggle just always reads as off until the RPC is re-deployed).
-- =============================================================================

DROP FUNCTION IF EXISTS get_consumable_details(TEXT);
CREATE OR REPLACE FUNCTION get_consumable_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "visibleInShelf" BOOLEAN,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelUploadId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "supplierIds" TEXT,
    "unitOfMeasure" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY i."createdAt"
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."description",
    i."itemTrackingType",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."visibleInShelf",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelUploadId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ps."supplierIds",
    uom.name as "unitOfMeasure",
    ir."revisions",
    c."customFields",
    c."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt"
  FROM "consumable" c
  LEFT JOIN "item" i ON i."readableId" = c."id" AND i."companyId" = c."companyId"
  LEFT JOIN item_revisions ir ON true
  LEFT JOIN (
    SELECT
      ps."itemId",
      string_agg(ps."supplierPartId", ',') AS "supplierIds"
    FROM "supplierPart" ps
    GROUP BY ps."itemId"
  ) ps ON ps."itemId" = i.id
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- Next steps (in Carbon UI, not SQL):
--
-- Settings → Webhooks → New webhook (do this three times — once per table):
--
--   1) Name: "shelf customer sync"
--      Table: Customer
--      URL:   https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
--      Events: ✓ Insert  ✓ Update  ✓ Delete
--
--   2) Name: "shelf customer-contact sync"
--      Table: Customer Contact
--      URL:   https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
--      Events: ✓ Insert  ✓ Update  ✓ Delete
--
--   3) Name: "shelf contact sync"
--      Table: Contact
--      URL:   https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
--      Events:           ✓ Update              (Insert and Delete are no-ops)
--
--   4) Name: "shelf item sync"
--      Table: Item   (Carbon already exposes this table)
--      URL:   https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
--      Events: ✓ Insert  ✓ Update  ✓ Delete
--
-- Use the same `?token=...` value across all four. It must match the
-- `CARBON_WEBHOOK_SECRET` env var on the shelf service (Render).
--
-- Then apply ./CONTRACT_VIEWS_CARBON.sql to expose the v1_* foreign-view
-- contracts that Shelf reads via FDW.
-- =============================================================================
