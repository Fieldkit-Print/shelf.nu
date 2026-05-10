-- =============================================================================
-- Shelf-side contract views (consumed by Carbon via FDW)
--
-- Apply against the Shelf Supabase project AFTER your Prisma migrations
-- (so the underlying tables exist). Idempotent; safe to re-run.
--
-- This file:
--   1. Creates the `public_api` schema.
--   2. Creates a least-privilege role `carbon_fdw_reader` that Carbon's
--      FDW user mapping authenticates as.
--   3. Defines `public_api.v1_*` views Carbon imports as foreign tables
--      under `shelf_remote` on its own database.
--
-- These views are the contract from Shelf's side. Underlying tables can
-- evolve; the v1_ surface stays put.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS public_api;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'carbon_fdw_reader') THEN
    CREATE ROLE carbon_fdw_reader WITH LOGIN PASSWORD 'REPLACE_ME_AT_DEPLOY';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public_api TO carbon_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_assets
--
-- One row per physical asset in Shelf. References Carbon ids as text
-- (no FK across systems). Carbon JOINs this to its own customer/item
-- tables when it needs to know "which physical units belong to this
-- sales order line" etc.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_assets AS
  SELECT
    a.id,
    a."organizationId"     AS organization_id,
    a."carbonPartId"       AS carbon_part_id,
    a."carbonCustomerId"   AS carbon_customer_id,
    a.kind,                                       -- INSTANCE | CONSUMABLE
    a.title,
    a.description,
    a.status,                                     -- AVAILABLE | IN_CUSTODY | CHECKED_OUT
    a."sequentialId"       AS sequential_id,
    a.rentable,
    a."availableToBook"    AS available_to_book,
    a."locationId"         AS location_id,
    a."kitId"              AS kit_id,
    a."createdAt"          AS created_at,
    a."updatedAt"          AS updated_at
  FROM public."Asset" a;

GRANT SELECT ON public_api.v1_assets TO carbon_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_locations
--
-- Shelf-owned location tree. Carbon migrates away from its own location/
-- shelf tables and reads from this view; `parent_id` exposes the nesting.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_locations AS
  SELECT
    l.id,
    l."organizationId"  AS organization_id,
    l.name,
    l.description,
    l.address,
    l.latitude,
    l.longitude,
    l."parentId"        AS parent_id,
    l."createdAt"       AS created_at,
    l."updatedAt"       AS updated_at
  FROM public."Location" l;

GRANT SELECT ON public_api.v1_locations TO carbon_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_custody
--
-- Current custody of each asset. One-to-one with Asset; absent means no
-- current custodian. Historical custody is read from v1_activity_events.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_custody AS
  SELECT
    c.id,
    c."assetId"           AS asset_id,
    c."teamMemberId"      AS team_member_id,
    tm.name               AS custodian_name,
    tm."userId"           AS custodian_user_id,
    c."createdAt"         AS created_at,
    c."updatedAt"         AS updated_at
  FROM public."Custody" c
  LEFT JOIN public."TeamMember" tm ON tm.id = c."teamMemberId";

GRANT SELECT ON public_api.v1_custody TO carbon_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_activity_events
--
-- Shelf's mutation event log. Carbon reads this when building reports
-- that need "what physically happened to this customer's items in the
-- last 30 days."
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_activity_events AS
  SELECT
    ae.id,
    ae."organizationId"  AS organization_id,
    ae."occurredAt"      AS occurred_at,
    ae."actorUserId"     AS actor_user_id,
    ae.action,
    ae."entityType"      AS entity_type,
    ae."entityId"        AS entity_id,
    ae."assetId"         AS asset_id,
    ae."bookingId"       AS booking_id,
    ae."locationId"      AS location_id,
    ae.field,
    ae."fromValue"       AS from_value,
    ae."toValue"         AS to_value,
    ae.meta
  FROM public."ActivityEvent" ae;

GRANT SELECT ON public_api.v1_activity_events TO carbon_fdw_reader;

-- -----------------------------------------------------------------------------
-- v1_booking_asset_metas
--
-- Per-(booking, asset) quantity tracking for CONSUMABLE assets in bookings.
-- Carbon reads this to know "how many of this consumable were shipped on
-- a given event, and how many came back" — the input to consumable-use
-- billing events.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_api.v1_booking_asset_metas AS
  SELECT
    m.id,
    m."bookingId"        AS booking_id,
    m."assetId"          AS asset_id,
    m."quantityOut"      AS quantity_out,
    m."quantityReturned" AS quantity_returned,
    m."createdAt"        AS created_at,
    m."updatedAt"        AS updated_at
  FROM public."BookingAssetMeta" m;

GRANT SELECT ON public_api.v1_booking_asset_metas TO carbon_fdw_reader;

-- =============================================================================
-- Notes
-- =============================================================================
-- All views are read-only for `carbon_fdw_reader`. Cross-app writes happen
-- through API endpoints (Carbon → Shelf via `/api/internal/carbon/...`,
-- Shelf → Carbon via `/api/sales/*` and similar), never through FDW.
-- =============================================================================
