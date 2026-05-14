-- =============================================================================
-- Carbon-side contract views (consumed by Shelf via FDW)
--
-- Apply against the Carbon Supabase project AFTER CARBON_MIGRATION.sql.
-- Idempotent; safe to re-run.
--
-- This file:
--   1. Creates the `public_api` schema (the public face of Carbon's data).
--   2. Creates a least-privilege role `shelf_fdw_reader` that Shelf's FDW
--      user mapping authenticates as.
--   3. Defines `public_api.v1_*` views that Shelf will import as foreign
--      tables under the `carbon_remote` schema on its own database.
--
-- These views are the contract. Underlying Carbon tables can evolve;
-- the v1_ surface stays put. Breaking changes go into v2_* in parallel
-- with a deprecation window.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Setup: schema + role
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS public_api;

-- ⚠️ Replace this placeholder password before running, or rotate after the
-- initial setup. Easier: keep it as a Supabase Vault secret and let the
-- Shelf-side `CREATE USER MAPPING` reference the secret name.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shelf_fdw_reader') THEN
    CREATE ROLE shelf_fdw_reader WITH LOGIN PASSWORD 'REPLACE_ME_AT_DEPLOY';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public_api TO shelf_fdw_reader;
-- Carbon's underlying tables stay invisible to this role; only what we
-- explicitly grant on each view is accessible. We do NOT grant USAGE on
-- the `public` schema.

-- -----------------------------------------------------------------------------
-- v1_customers
--
-- Customer master fields Shelf needs for the admin pages and CUSTOMER
-- role lookups.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_customers AS
  SELECT
    c.id,
    c."companyId"               AS company_id,
    c.name                      AS display_name,
    c."customerStatusId"        AS customer_status_id,
    cs.name                     AS status,
    c."createdAt"               AS created_at,
    c."updatedAt"               AS updated_at
  FROM public.customer c
  LEFT JOIN public."customerStatus" cs
    ON cs.id = c."customerStatusId" AND cs."companyId" = c."companyId";

GRANT SELECT ON public_api.v1_customers TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_customer_contacts
--
-- Customer ↔ contact junction joined with the contact row. One row per
-- (customerId, contactId).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_customer_contacts AS
  SELECT
    cc.id            AS link_id,
    ct."companyId"   AS company_id,
    cc."customerId"  AS customer_id,
    cc."contactId"   AS contact_id,
    ct.email,
    ct."firstName"   AS first_name,
    ct."lastName"    AS last_name,
    ct."fullName"    AS full_name,
    ct.title
  FROM public."customerContact" cc
  JOIN public.contact ct ON ct.id = cc."contactId";

GRANT SELECT ON public_api.v1_customer_contacts TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_parts
--
-- Item master subset for Shelf. Returns ALL items — Shelf gates by
-- (active, itemTrackingType, visibleInShelf) on its side so that
-- serial-tracked items can also be evaluated even when visibleInShelf is
-- false (Shelf treats Serial items as always-syncable per the project
-- architecture).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_parts AS
  SELECT
    i.id,
    i."companyId"           AS company_id,
    i."readableId"          AS sku,
    i.name,
    i.description,
    i.type::text            AS type,
    i."itemTrackingType"::text AS tracking_type,
    i."unitOfMeasureCode"   AS unit_of_measure,
    i."thumbnailPath"       AS thumbnail_url,
    i.active,
    i."visibleInShelf"      AS visible_in_shelf,
    ic."standardCost"       AS standard_cost,
    iusp."unitSalePrice"    AS unit_sale_price,
    i."createdAt"           AS created_at,
    i."updatedAt"           AS updated_at
  FROM public.item i
  LEFT JOIN public."itemCost" ic
    ON ic."itemId" = i.id
  LEFT JOIN public."itemUnitSalePrice" iusp
    ON iusp."itemId" = i.id;

GRANT SELECT ON public_api.v1_parts TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_consumable_inventory
--
-- Live quantity-on-hand for consumable items (Inventory or Batch tracking).
-- Aggregated from `itemLedger`. Shelf reads this when displaying booking
-- forms / customer portal "available quantity" labels.
--
-- Only `visibleInShelf = true` items appear, matching v1_parts above.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_consumable_inventory AS
  SELECT
    i.id                    AS carbon_item_id,
    i."companyId"           AS company_id,
    COALESCE(SUM(il.quantity), 0) AS quantity_on_hand,
    i."unitOfMeasureCode"   AS unit_of_measure
  FROM public.item i
  LEFT JOIN public."itemLedger" il
    ON il."itemId" = i.id
  WHERE i."visibleInShelf" = true
    AND i."itemTrackingType" IN ('Inventory', 'Batch')
  GROUP BY i.id;

GRANT SELECT ON public_api.v1_consumable_inventory TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_warehouse_pricing (PLACEHOLDER — table does not exist yet)
--
-- Pallet-slot rates, pick fees, rental day rates. Shelf reads this when
-- computing storage billing events. The Carbon `warehousePrice` table
-- doesn't exist yet — when it does, redefine this view to project the
-- relevant columns. Until then, this view returns no rows so Shelf's
-- billing pipeline can safely JOIN against it and produce zero-charge
-- entries (which it logs and ignores).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_warehouse_pricing AS
  SELECT
    NULL::TEXT       AS id,
    NULL::TEXT       AS company_id,
    NULL::TEXT       AS pricing_kind,         -- e.g. 'slot_day', 'pick_fee', 'rental_day'
    NULL::TEXT       AS location_id,          -- pricing tied to a specific slot, if applicable
    NULL::NUMERIC    AS amount,
    NULL::TEXT       AS currency_code,
    NULL::TIMESTAMPTZ AS effective_from,
    NULL::TIMESTAMPTZ AS effective_to
  WHERE false;       -- zero rows until the underlying table lands

GRANT SELECT ON public_api.v1_warehouse_pricing TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_item_ledger
--
-- Subset of `itemLedger` rows exposing the columns Shelf needs to (a)
-- backfill INSTANCE Assets from existing tracked entities and (b)
-- diagnose webhook delivery gaps. Snake-case column aliases keep the
-- contract Shelf-friendly.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_item_ledger AS
  SELECT
    il.id,
    il."entryNumber"        AS entry_number,
    il."postingDate"        AS posting_date,
    il."entryType"::text    AS entry_type,
    il."documentType"::text AS document_type,
    il."documentId"         AS document_id,
    il."itemId"             AS item_id,
    il."trackedEntityId"    AS tracked_entity_id,
    il."locationId"         AS location_id,
    il.quantity,
    il."companyId"          AS company_id,
    il."createdAt"          AS created_at
  FROM public."itemLedger" il;

GRANT SELECT ON public_api.v1_item_ledger TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_tracked_entities
--
-- One row per physical unit (serial-tracked items) or per batch
-- (batch-tracked items). Shelf reads this in two places:
--   1. Webhook handler for `itemLedger` INSERTs joins through
--      `itemLedger.trackedEntityId` to fetch the serial number string and
--      mint a Shelf INSTANCE Asset titled "<item.name> #<readableId>".
--   2. Backfill: select every tracked entity for serial-tracked items in
--      the Fieldkit company and ensure a Shelf Asset exists.
--
-- `attributes` is the JSONB blob where Shelf writes back its own asset
-- id (key: "Shelf Asset ID") via REST after minting.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_tracked_entities AS
  SELECT
    te.id,
    te."readableId"         AS readable_id,
    te.quantity,
    te.status::text         AS status,
    te."sourceDocument"     AS source_document,
    te."sourceDocumentId"   AS source_document_id,
    te."sourceDocumentReadableId" AS source_document_readable_id,
    te.attributes,
    te."companyId"          AS company_id,
    te."createdAt"          AS created_at
  FROM public."trackedEntity" te;

GRANT SELECT ON public_api.v1_tracked_entities TO shelf_fdw_reader;

-- -----------------------------------------------------------------------------
-- Notes
-- -----------------------------------------------------------------------------
-- Filtering by Fieldkit's company id (`company_id` column) is the
-- responsibility of the consumer (Shelf). The views above expose every
-- company's data — that's correct because the FDW user mapping will be
-- shared across companies if multiple shelves connect. Shelf's queries
-- always include `AND company_id = $FIELDKIT_CARBON_COMPANY_ID`.
-- =============================================================================
