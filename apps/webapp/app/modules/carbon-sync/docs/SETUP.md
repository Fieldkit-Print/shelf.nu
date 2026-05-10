# Carbon ↔ shelf.nu deployment guide (FDW edition)

End-to-end checklist for the FDW architecture. SQL artifacts in this
folder; apply each manually in the relevant Supabase Studio SQL Editor.

## What's in this folder

| File                        | Where to run    | What it does                                                                                                                        |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CARBON_MIGRATION.sql`      | Carbon Supabase | webhook subscriptions for customerContact + contact, adds `item.visibleInShelf`, drops the early `customer-asset-storage` machinery |
| `CONTRACT_VIEWS_CARBON.sql` | Carbon Supabase | creates `public_api.v1_*` views Shelf reads via FDW                                                                                 |
| `CONTRACT_VIEWS_SHELF.sql`  | Shelf Supabase  | creates `public_api.v1_*` views Carbon reads via FDW                                                                                |
| `FDW_SETUP_CARBON.sql`      | Carbon Supabase | wires Carbon to read Shelf via `shelf_remote` foreign tables                                                                        |
| `FDW_SETUP_SHELF.sql`       | Shelf Supabase  | wires Shelf to read Carbon via `carbon_remote` foreign tables                                                                       |

## Order of operations

The Carbon side has to ship first, since Shelf imports Carbon's contract
views via FDW. Sequence:

1. **Carbon Supabase** — run `CARBON_MIGRATION.sql`. Verify with:
   ```sql
   SELECT name, "table" FROM "webhookTable" ORDER BY name;
   --   includes Customer, Customer Contact, Contact
   SELECT column_name FROM information_schema.columns
     WHERE table_name = 'item' AND column_name = 'visibleInShelf';
   --   one row
   SELECT count(*) FROM information_schema.tables
     WHERE table_name = 'customerAssetEvent';
   --   zero rows
   ```
2. **Carbon Supabase** — run `CONTRACT_VIEWS_CARBON.sql`. Replace
   `REPLACE_ME_AT_DEPLOY` in the `CREATE ROLE shelf_fdw_reader` line
   with a strong password; stash it in Carbon's Supabase Vault.
3. **Shelf Supabase** — run your Prisma migrations
   (`pnpm db:deploy-migration` against the Shelf DB) so the
   `BookingAssetMeta`, `Asset.kind`, etc. exist.
4. **Shelf Supabase** — run `CONTRACT_VIEWS_SHELF.sql`. Replace
   `REPLACE_ME_AT_DEPLOY` in `CREATE ROLE carbon_fdw_reader` with a
   strong password; stash in Shelf's Supabase Vault.
5. **Carbon Supabase** — run `FDW_SETUP_CARBON.sql`. Edit the file
   beforehand to substitute the Shelf project ref and the
   `carbon_fdw_reader` password from step 4.
6. **Shelf Supabase** — run `FDW_SETUP_SHELF.sql`. Substitute the Carbon
   project ref and the `shelf_fdw_reader` password from step 2.
7. **Sanity check** — run the queries at the bottom of each FDW file.

## Configure Carbon webhooks (Carbon UI → Settings → Webhooks)

Four subscriptions, all pointing at the same URL with the same `?token=`
value (matches `CARBON_WEBHOOK_SECRET` on Shelf):

| Name                      | Table            | Events                 |
| ------------------------- | ---------------- | ---------------------- |
| `shelf customer sync`     | Customer         | Insert, Update, Delete |
| `shelf contact-link sync` | Customer Contact | Insert, Update, Delete |
| `shelf contact sync`      | Contact          | Update                 |
| `shelf item sync`         | Item             | Insert, Update, Delete |

URL for each:

```
https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
```

## Issue a Carbon API key

Settings → API Keys → New:

- Permission scope: `view: sales` (scoped to the Fieldkit company)
- Name: e.g. `shelf customer sync`
- Save and copy the key — you'll only see it once.

## Shelf env vars on Render

| Var                                | What                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `CARBON_API_BASE_URL`              | Carbon ERP app URL, no trailing slash (`https://erp.fieldkit.cc`) |
| `CARBON_API_KEY`                   | The `carbon-key` value from the API key step                      |
| `CARBON_WEBHOOK_SECRET`            | Random hex (`openssl rand -hex 32`); matches the `?token=`        |
| `FIELDKIT_CARBON_COMPANY_ID`       | Fieldkit's Carbon company id (e.g. `d742au0gqeb4g2dcj3rg`)        |
| `FIELDKIT_PRIMARY_ORGANIZATION_ID` | Shelf `Organization.id` that hosts customer tenancy               |

The carbon-sync worker auto-registers at boot
(`apps/webapp/app/entry.server.tsx`).

## Verify

- Create a test customer in Carbon → check `/customers` in Shelf appears.
- Add a contact in Carbon → confirm new User row + magic-link email.
- Toggle a Consumable item's `visibleInShelf` to true → confirm a
  CONSUMABLE Asset appears in Shelf.
- Create a serial item and add a serialNumber in Carbon → (after the
  intake-flow lands) an INSTANCE Asset should appear in Shelf.
- Update a contact's email in Carbon → User email refreshes in Shelf.
- Delete a customerContact link in Carbon → User's `carbonCustomerId`
  clears in Shelf (query `User` table).

## Initial backfill (one-time)

After webhooks have been live a few minutes, kick a one-time reconcile
pass to pull anything that pre-dated the webhook subscription:

```sql
-- Against shelf's database
INSERT INTO pgboss.job (name, data)
VALUES ('carbon-sync-queue', '{"kind": "reconcile-all"}'::jsonb);
```

The worker picks this up within ~5 minutes (pg-boss polling interval)
and pages all customerContact links in the Fieldkit company.

## Troubleshooting

- **401 on Carbon webhook deliveries** — token mismatch. Re-check
  `CARBON_WEBHOOK_SECRET` vs the `?token=` query param.
- **200 but nothing happens** — `companyId` mismatch. Shelf logs
  `[Carbon Sync] Ignoring webhook for non-Fieldkit company`. Re-check
  `FIELDKIT_CARBON_COMPANY_ID`.
- **`Carbon customer X not found`** — webhook arrived before the customer
  finished propagating in Carbon, or REST cache lag. Usually recovers on
  the next reconcile pass.
- **FDW query hangs or errors** — Carbon Supabase down, wrong port (must
  be 5432 / direct, not 6543 / pgbouncer), or stale password. Re-import
  the foreign schema after rotating: drop+create `carbon_remote` schema.
- **`schema "shelf_remote" already exists`** — re-running setup; the
  `DROP SCHEMA ... CASCADE` line handles that. If you see it during a
  fresh run, drop manually and re-import.
- **No CONSUMABLE Asset appears after toggling visibleInShelf** — the
  Carbon webhook payload must include `visibleInShelf: true` in `record`.
  Confirm the column exists (verification SQL in CARBON_MIGRATION.sql).
