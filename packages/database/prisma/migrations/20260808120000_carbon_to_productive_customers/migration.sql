-- =============================================================================
-- Carbon ERP removal → Productive-sourced customers
--
-- Brings the database in line with the schema rewritten in 3ad08813a, which
-- shipped without a migration. Nine tables are affected.
--
-- WHY THIS IS HAND-WRITTEN
-- Prisma's migration engine diffs by column name and cannot infer a rename, so
-- `migrate dev` would emit DROP + ADD for every `carbonCustomerId` →
-- `customerId` change. That silently discards customer linkage on six tables.
-- Every rename below is therefore an explicit ALTER ... RENAME.
--
-- WHY THE STATEMENTS ARE GUARDED
-- The exact production state was not verifiable when this was authored, and a
-- half-applied migration is expensive to unpick. Every statement is written to
-- be re-runnable: renames are wrapped in existence checks, drops and creates
-- use IF EXISTS / IF NOT EXISTS. Running this twice is a no-op.
--
-- QUOTING
-- DO blocks use the '...' string form rather than $$...$$, per
-- apps/docs/database-triggers.md — dollar-quoted bodies can be mis-split by
-- the migration engine. Single quotes inside a block are doubled ('').
--
-- DATA IMPACT
-- Expected to be nil for customer linkage — no Customer records exist in Shelf
-- and customer master data now lives in Productive. Renames preserve whatever
-- values are present regardless. The genuinely destructive steps are the
-- column drops in section 3 and the CustomerSetting drop in section 4; both
-- concern Carbon-only data with no Shelf-side consumer.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Rename customer-linkage columns.
--    RENAME (not drop+add) so any existing values survive.
-- -----------------------------------------------------------------------------

DO '
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''Asset''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "Asset" RENAME COLUMN "carbonCustomerId" TO "customerId";
  END IF;

  -- User keeps the fieldkitCustomerId name to avoid colliding with the
  -- upstream Stripe User.customerId column, which is unrelated.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''User''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "User" RENAME COLUMN "carbonCustomerId" TO "fieldkitCustomerId";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''Kit''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "Kit" RENAME COLUMN "carbonCustomerId" TO "customerId";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''BookingRequest''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "BookingRequest" RENAME COLUMN "carbonCustomerId" TO "customerId";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''BillableEvent''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "BillableEvent" RENAME COLUMN "carbonCustomerId" TO "customerId";
  END IF;

  -- CustomerPricing primary key column. The constraint keeps its name
  -- (CustomerPricing_pkey), which is what Prisma expects.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = ''public'' AND table_name = ''CustomerPricing''
               AND column_name = ''carbonCustomerId'') THEN
    ALTER TABLE "CustomerPricing" RENAME COLUMN "carbonCustomerId" TO "customerId";
  END IF;
END ';


-- -----------------------------------------------------------------------------
-- 2. Rename the indexes that carried the old column names.
--    A column rename leaves the index in place under its original name;
--    Prisma compares index names, so these must follow.
-- -----------------------------------------------------------------------------

DO '
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ''Asset_organizationId_carbonCustomerId_idx'') THEN
    ALTER INDEX "Asset_organizationId_carbonCustomerId_idx"
      RENAME TO "Asset_organizationId_customerId_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ''Kit_organizationId_carbonCustomerId_idx'') THEN
    ALTER INDEX "Kit_organizationId_carbonCustomerId_idx"
      RENAME TO "Kit_organizationId_customerId_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ''User_carbonCustomerId_idx'') THEN
    ALTER INDEX "User_carbonCustomerId_idx"
      RENAME TO "User_fieldkitCustomerId_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ''BookingRequest_carbonCustomerId_status_idx'') THEN
    ALTER INDEX "BookingRequest_carbonCustomerId_status_idx"
      RENAME TO "BookingRequest_customerId_status_idx";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = ''BillableEvent_carbonCustomerId_occurredAt_idx'') THEN
    ALTER INDEX "BillableEvent_carbonCustomerId_occurredAt_idx"
      RENAME TO "BillableEvent_customerId_occurredAt_idx";
  END IF;
END ';


-- -----------------------------------------------------------------------------
-- 3. Drop Carbon-only columns.
--    Destructive but inert: no Shelf code reads any of these, and the systems
--    that wrote them are gone. Dropping a column drops its indexes with it,
--    so Asset_carbonPartId_idx, Asset_carbonTrackedEntityId_key,
--    User_carbonContactId_key and User_carbonContactId_idx need no explicit
--    DROP INDEX.
-- -----------------------------------------------------------------------------

ALTER TABLE "Asset"
  DROP COLUMN IF EXISTS "carbonPartId",
  DROP COLUMN IF EXISTS "carbonTrackedEntityId";

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "carbonContactId";

-- carbonInvoiceLineId recorded which Carbon invoice line an event was billed
-- on. Its replacement is BillableEvent.productiveServiceId, added in section 7.
-- Nothing was ever successfully pushed to Carbon (the endpoint was never
-- built), so no billing provenance is lost here.
ALTER TABLE "BillableEvent"
  DROP COLUMN IF EXISTS "carbonPartId",
  DROP COLUMN IF EXISTS "carbonInvoiceLineId";


-- -----------------------------------------------------------------------------
-- 4. Drop CustomerSetting.
--    Its only field, requiresInternalApproval, moves to Customer (section 5).
--    Carried forward below in case any rows exist; the copy runs before the
--    drop and is a no-op on an empty table.
-- -----------------------------------------------------------------------------

-- Columns are declared explicitly rather than via CREATE TABLE AS SELECT: the
-- latter names "CustomerSetting" in its own definition, so it would fail
-- outright on a re-run after the table has already been dropped — defeating
-- the point of making this migration re-runnable.
CREATE TEMP TABLE IF NOT EXISTS _customer_setting_carryover (
    "carbonCustomerId" TEXT NOT NULL,
    "requiresInternalApproval" BOOLEAN NOT NULL DEFAULT false
);

DO '
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = ''public'' AND table_name = ''CustomerSetting'') THEN
    INSERT INTO _customer_setting_carryover ("carbonCustomerId", "requiresInternalApproval")
    SELECT "carbonCustomerId", "requiresInternalApproval" FROM "CustomerSetting";
  END IF;
END ';

DROP TABLE IF EXISTS "CustomerSetting";


-- -----------------------------------------------------------------------------
-- 5. Create Customer.
--    A local mirror of Productive companies, not a master record. Rows are
--    written by the Productive sync; nothing in the app creates them.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    -- Productive company id. Nullable so a row can exist briefly before it is
    -- matched, unique so the sync can upsert on it.
    "productiveCompanyId" TEXT,

    "name" TEXT NOT NULL,
    "billingEmail" TEXT,
    "notes" TEXT,
    "requiresInternalApproval" BOOLEAN NOT NULL DEFAULT false,

    "shipToName" TEXT,
    "shipToPhone" TEXT,
    "shipToStreet1" TEXT,
    "shipToStreet2" TEXT,
    "shipToCity" TEXT,
    "shipToState" TEXT,
    "shipToPostalCode" TEXT,
    "shipToCountry" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_productiveCompanyId_key"
  ON "Customer"("productiveCompanyId");

CREATE INDEX IF NOT EXISTS "Customer_organizationId_idx"
  ON "Customer"("organizationId");


-- -----------------------------------------------------------------------------
-- 6. Restore carried-over approval settings, if any.
--    Only applies where a Customer row already shares the old key. On a fresh
--    database (the expected case) this does nothing.
-- -----------------------------------------------------------------------------

DO '
BEGIN
  IF EXISTS (SELECT 1 FROM _customer_setting_carryover) THEN
    UPDATE "Customer" c
       SET "requiresInternalApproval" = s."requiresInternalApproval"
      FROM _customer_setting_carryover s
     WHERE s."carbonCustomerId" = c."id";
  END IF;
END ';

DROP TABLE IF EXISTS _customer_setting_carryover;


-- -----------------------------------------------------------------------------
-- 7. Columns the schema declares but no migration ever created.
-- -----------------------------------------------------------------------------

-- Links a pending invite to the customer the accepting user becomes a contact
-- of. Read by the accept-invite transaction to set User.fieldkitCustomerId.
ALTER TABLE "Invite"
  ADD COLUMN IF NOT EXISTS "customerId" TEXT;

CREATE INDEX IF NOT EXISTS "Invite_customerId_idx"
  ON "Invite"("customerId");

-- Records the Productive service (budget line) a billable event was rolled
-- into. The monthly push skips events that already carry one, so a re-run
-- after a partial failure resumes instead of double-charging.
ALTER TABLE "BillableEvent"
  ADD COLUMN IF NOT EXISTS "productiveServiceId" TEXT;

-- Ship-to phone. Absent from the original Customer design; carriers reject
-- consignee-phone-less freight and most international labels.
--
-- Also present in the CREATE TABLE above. The duplication is deliberate: if
-- Customer already exists from a partial run, CREATE TABLE IF NOT EXISTS is
-- skipped and this is what adds the column.
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "shipToPhone" TEXT;


-- -----------------------------------------------------------------------------
-- 8. Row Level Security.
--    Matches the convention every other Fieldkit table follows on Supabase.
-- -----------------------------------------------------------------------------

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
