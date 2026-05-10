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
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS "customerAssetEvent";

ALTER TABLE "item" DROP COLUMN IF EXISTS "customerId";

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
