-- =============================================================================
-- Pallet-slot storage model
--
-- Storage is sold per pallet position per month (see the "Monthly Storage Fees"
-- rate card in Productive), not per asset per day as the original pricing
-- hierarchy assumed. This migration introduces the slot as the billable unit.
--
--   Location.storageSlotTier   -> what a position costs and how it is counted
--   Location.capacity          -> how many assets may occupy it
--   OrgPricing / CustomerPricing tier rates -> the monthly price per tier
--
-- `storagePerDayCents` is deliberately left in place. The storage cron and
-- pricing UI still read it; it is dropped in a follow-up migration once they
-- are moved onto the tier rates, so this migration is non-breaking on its own.
--
-- QUOTING
-- Procedural bodies use the '...' string form rather than $$...$$, per
-- apps/docs/database-triggers.md. Single quotes inside a body are doubled ('').
--
-- Idempotent throughout, matching 20260808120000.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Slot classification.
-- -----------------------------------------------------------------------------

DO '
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = ''StorageSlotTier'') THEN
    CREATE TYPE "StorageSlotTier" AS ENUM (
      ''HALF_PALLET'',
      ''STANDARD_PALLET'',
      ''TALL_PALLET'',
      ''OVERSIZE''
    );
  END IF;
END ';

-- Non-null tier marks a location as billable storage. Null (the default for
-- every existing row) means organizational — warehouse, zone, staging — and
-- never bills. Existing locations are therefore unaffected until classified.
ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "storageSlotTier" "StorageSlotTier",
  ADD COLUMN IF NOT EXISTS "capacity" INTEGER,
  ADD COLUMN IF NOT EXISTS "storageMonthlyCentsOverride" INTEGER;

-- Billing sweeps read (organizationId, storageSlotTier) to find billable
-- positions; the partial index keeps that scan off the organizational rows,
-- which are the overwhelming majority.
CREATE INDEX IF NOT EXISTS "Location_organizationId_storageSlotTier_idx"
  ON "Location"("organizationId", "storageSlotTier")
  WHERE "storageSlotTier" IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. Tier rates on the pricing hierarchy.
-- -----------------------------------------------------------------------------

ALTER TABLE "OrgPricing"
  ADD COLUMN IF NOT EXISTS "storageHalfPalletCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "storageStandardPalletCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "storageTallPalletCents" INTEGER;

ALTER TABLE "CustomerPricing"
  ADD COLUMN IF NOT EXISTS "storageHalfPalletCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "storageStandardPalletCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "storageTallPalletCents" INTEGER;


-- -----------------------------------------------------------------------------
-- 3. Capacity enforcement.
--
-- A pallet position must not accidentally accept a second pallet. Assets are
-- placed into locations from roughly ten code paths — asset create, asset
-- update, bulk move, CSV import, kit location propagation, the two mobile
-- endpoints, the location scanner and the manage-assets drawer — so this is
-- enforced in the database rather than at each call site, following the
-- precedent set by trigger_create_user_contact
-- (see apps/docs/database-triggers.md).
--
-- Locations with a null capacity (floor areas, warehouses, zones) are
-- unconstrained. The check runs only when an asset actually arrives at a
-- capacity-bounded location, so ordinary updates pay nothing for it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_location_capacity()
RETURNS TRIGGER AS '
DECLARE
    max_capacity INTEGER;
    current_count INTEGER;
    location_name TEXT;
BEGIN
    -- Only interested in an asset arriving at a location.
    IF NEW."locationId" IS NULL THEN
        RETURN NEW;
    END IF;

    -- On UPDATE, skip when the asset was already in this location: it is not
    -- newly consuming a position, and re-checking would fail against itself.
    IF TG_OP = ''UPDATE'' AND OLD."locationId" IS NOT DISTINCT FROM NEW."locationId" THEN
        RETURN NEW;
    END IF;

    SELECT "capacity", "name" INTO max_capacity, location_name
    FROM "Location"
    WHERE id = NEW."locationId";

    -- Unlimited, or the location vanished (the foreign key handles that).
    IF max_capacity IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO current_count
    FROM "Asset"
    WHERE "locationId" = NEW."locationId"
      AND id <> NEW.id;

    IF current_count >= max_capacity THEN
        RAISE EXCEPTION
            ''Location "%" is full (capacity %, already holds %). Move the existing asset out before placing another here.'',
            location_name, max_capacity, current_count
            USING ERRCODE = ''check_violation'';
    END IF;

    RETURN NEW;
END;
' LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_enforce_location_capacity ON "Asset";

CREATE TRIGGER trigger_enforce_location_capacity
    BEFORE INSERT OR UPDATE OF "locationId" ON "Asset"
    FOR EACH ROW
    EXECUTE FUNCTION enforce_location_capacity();
