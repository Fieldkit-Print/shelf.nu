-- =============================================================================
-- Booking.customerId + retire per-day storage pricing
--
-- Two related billing corrections:
--
-- 1. Rental usage inferred its customer from `creator.fieldkitCustomerId`,
--    which only resolves for bookings created in the customer portal.
--    Anything staff booked on a customer's behalf billed nobody. Bookings now
--    carry the customer explicitly.
--
-- 2. `storagePerDayCents` is dead. Storage is sold per pallet position per
--    month (see 20260809090000), and the cron, resolver and pricing UI have
--    all moved onto the tier rates.
--
-- Idempotent, matching the preceding two migrations.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Booking.customerId
--    Scalar reference to Customer.id with no FK, mirroring Asset.customerId —
--    Customer is deliberately kept out of Prisma's include graph.
-- -----------------------------------------------------------------------------

ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "customerId" TEXT;

CREATE INDEX IF NOT EXISTS "Booking_organizationId_customerId_idx"
  ON "Booking"("organizationId", "customerId");

-- Backfill from the existing (weaker) signal so historical portal bookings
-- keep their attribution. Staff-created bookings stay null, which is
-- accurate — they never had a customer recorded to recover.
UPDATE "Booking" b
   SET "customerId" = u."fieldkitCustomerId"
  FROM "User" u
 WHERE u.id = b."creatorId"
   AND u."fieldkitCustomerId" IS NOT NULL
   AND b."customerId" IS NULL;


-- -----------------------------------------------------------------------------
-- 2. Drop per-day storage pricing.
--    Safe: the tier columns added in 20260809090000 are what the resolver and
--    UI now read, and this column was never populated in production.
-- -----------------------------------------------------------------------------

ALTER TABLE "OrgPricing"      DROP COLUMN IF EXISTS "storagePerDayCents";
ALTER TABLE "CustomerPricing" DROP COLUMN IF EXISTS "storagePerDayCents";
ALTER TABLE "AssetPricing"    DROP COLUMN IF EXISTS "storagePerDayCents";
