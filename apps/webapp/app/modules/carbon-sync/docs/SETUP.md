# Carbon ↔ shelf.nu deployment guide

End-to-end checklist for getting the Fieldkit customer-tenancy integration
running in production.

## 1. Apply the Carbon migration

Run [`CARBON_MIGRATION.sql`](./CARBON_MIGRATION.sql) against your **Carbon**
Supabase project (Supabase Studio → SQL Editor → New query → paste → Run).

Verify with:

```sql
SELECT name, "table" FROM "webhookTable" ORDER BY name;
```

You should see `Customer`, `Customer Contact`, and `Contact` in the list
(plus the others Carbon ships with).

## 2. Configure Carbon webhooks (Carbon UI → Settings → Webhooks)

Create three webhook subscriptions, all pointing to the same URL with
the same `?token=` value (the value of `CARBON_WEBHOOK_SECRET` on shelf):

| Name                      | Table            | Events                 |
| ------------------------- | ---------------- | ---------------------- |
| `shelf customer sync`     | Customer         | Insert, Update, Delete |
| `shelf contact-link sync` | Customer Contact | Insert, Update, Delete |
| `shelf contact sync`      | Contact          | Update                 |

URL for each:

```
https://<your-shelf-render-url>/api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
```

## 3. Set shelf env vars on Render

| Var                                | What                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `CARBON_SUPABASE_URL`              | Your Carbon Supabase project URL (e.g. `https://abc.supabase.co`)        |
| `CARBON_SUPABASE_SERVICE_ROLE_KEY` | The Carbon project's `service_role` key (from Supabase → Settings → API) |
| `CARBON_WEBHOOK_SECRET`            | Random hex (`openssl rand -hex 32`); must match the `?token=` in step 2  |
| `FIELDKIT_CARBON_COMPANY_ID`       | Your Fieldkit company id in Carbon (e.g. `d742au0gqeb4g2dcj3rg`)         |
| `FIELDKIT_PRIMARY_ORGANIZATION_ID` | Your shelf `Organization.id` that hosts customer tenancy                 |

The carbon-sync worker auto-registers at boot
(`apps/webapp/app/entry.server.tsx`); no extra wiring needed.

## 4. Verify

- Create a new test customer in Carbon → check shelf's `/customers` page
  appears within seconds.
- Add a contact to that customer in Carbon → check the contact appears in
  the shelf customer detail page, and the new User row is created.
- Update the contact's email in Carbon → check the User's email refreshes
  in shelf.
- Delete the customerContact link in Carbon → check the User's
  `fieldkitCustomerId` clears in shelf (run a query against `User` table).

## 5. Initial backfill (one-time)

After webhooks have been live for a few minutes, kick a one-time
reconcile pass to pull anything that pre-dated the webhook subscription.
You can do this from a Render shell or the Supabase SQL editor against
shelf's database:

```sql
-- Enqueue a reconcile job for the carbon-sync worker
INSERT INTO pgboss.job (name, data)
VALUES ('carbon-sync-queue', '{"kind": "reconcile-all"}'::jsonb);
```

The worker picks this up within ~5 minutes (pg-boss polling interval)
and pages through all customers + contacts in the Fieldkit company.

## 6. Recurring reconciliation (optional but recommended)

Configure Render Cron to enqueue a `reconcile-all` job nightly. Use the
same SQL above; schedule it for ~3am local time. This catches any
webhooks missed during deploy windows or transient errors.

## Troubleshooting

- **401 on Carbon webhook deliveries**: token mismatch. Double-check the
  `?token=` value in the Carbon webhook URL matches `CARBON_WEBHOOK_SECRET`
  on Render exactly.
- **200 but nothing happens**: probably a `companyId` mismatch. Check
  shelf logs for `[Carbon Sync] Ignoring webhook for non-Fieldkit company`.
  Re-check `FIELDKIT_CARBON_COMPANY_ID`.
- **`Carbon customer X not found`**: Carbon's webhook fired before the
  Supabase service-role lookup could resolve the row. Usually a one-off;
  the next reconcile pass will heal.
- **No new User created on contact link**: check shelf logs for SMTP
  errors (`Failed to send customer contact invite`) — the User is still
  created even on email failure, but you'll see the warning. Verify
  `SMTP_*` env vars.
