-- =============================================================================
-- Fieldkit shelf.nu ↔ Carbon ERP webhook integration
--
-- Apply this migration to your Carbon Supabase project to expose the
-- `customerContact` and `contact` tables to Carbon's existing webhook UI
-- (Settings → Webhooks). After running, both tables become subscribable
-- exactly like `customer` already is.
--
-- This file is idempotent — safe to re-run.
--
-- HOW TO APPLY
--
-- Option A (Supabase Studio): open the SQL Editor for your Carbon project
-- and paste this file in. Run.
--
-- Option B (psql): connect to the Carbon database (the same one Carbon
-- runs against) and pipe this file in.
--
-- Verification: after running, `SELECT * FROM "webhookTable";` should show
-- two new rows whose `name` columns are "Customer Contact" and "Contact".
-- =============================================================================

-- 1) Register the two tables in Carbon's webhook registry so they appear
--    in the Carbon UI's table dropdown when creating a webhook subscription.
INSERT INTO "webhookTable" ("table", "module", "name") VALUES
  ('customerContact', 'Sales', 'Customer Contact')
ON CONFLICT ("table") DO NOTHING;

INSERT INTO "webhookTable" ("table", "module", "name") VALUES
  ('contact', 'Sales', 'Contact')
ON CONFLICT ("table") DO NOTHING;

-- 2) Attach Carbon's existing trigger functions to the customerContact
--    junction table. INSERT signals "this contact is now linked to a
--    customer" (shelf provisions a User on receipt). DELETE signals
--    unlinking. UPDATE is rare on a junction but covers the case where
--    a contact is moved to a different customer or location.
CREATE OR REPLACE TRIGGER "customerContactInsertWebhook"
AFTER INSERT ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_insert();

CREATE OR REPLACE TRIGGER "customerContactUpdateWebhook"
AFTER UPDATE ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_update();

CREATE OR REPLACE TRIGGER "customerContactDeleteWebhook"
AFTER DELETE ON "customerContact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_delete();

-- 3) Attach the same trigger functions to the contact table itself.
--    UPDATE is the important one (someone changes their email or name in
--    Carbon → shelf needs to refresh the mirrored User). INSERT/DELETE
--    are also wired so the system is symmetric, even though shelf doesn't
--    do anything for orphan contacts (contact without customerContact).
CREATE OR REPLACE TRIGGER "contactInsertWebhook"
AFTER INSERT ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_insert();

CREATE OR REPLACE TRIGGER "contactUpdateWebhook"
AFTER UPDATE ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_update();

CREATE OR REPLACE TRIGGER "contactDeleteWebhook"
AFTER DELETE ON "contact"
FOR EACH ROW EXECUTE FUNCTION public.webhook_delete();

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
-- Use the same `?token=...` value across all three. It must match the
-- `CARBON_WEBHOOK_SECRET` env var on the shelf service (Render).
-- =============================================================================
