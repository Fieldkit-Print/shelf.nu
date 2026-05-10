/**
 * Carbon Sync — Shared Types
 *
 * Type definitions for the Fieldkit ↔ Carbon ERP integration. Carbon owns
 * the master data for customers + customer contacts; shelf maintains a thin
 * mirror via webhooks (real-time) and a nightly reconciliation cron
 * (catch-up) using the Carbon Supabase service-role key.
 *
 * The `CarbonCustomer` / `CarbonContact` shapes here mirror the actual
 * Postgres column names exposed by Carbon's webhook payloads (which are
 * `row_to_json(NEW)` from the trigger function in
 * `Carbon/packages/database/supabase/migrations/20250203121216_webhooks.sql`).
 *
 * If Carbon adds new columns we want, extend these types — Carbon's payload
 * already carries everything in `record`, so it's a TS-only change.
 *
 * @see {@link file://./service.server.ts}    Upsert dispatch
 * @see {@link file://./client.server.ts}     Carbon Supabase client
 * @see {@link file://./webhook.server.ts}    Webhook handler
 */

/**
 * Carbon's `customer` row shape (subset of fields shelf uses).
 *
 * Notes:
 * - There is no `archived` boolean. Carbon soft-deletes via
 *   `mergedIntoCustomerId` (set when the customer is merged into another).
 *   We mirror that as `Customer.status = ARCHIVED` in shelf.
 * - There is no `billingEmail` on the customer row. Email lives on related
 *   contact rows joined via `customerContact`. Shelf's `Customer.billingEmail`
 *   is best-effort populated from the first synced contact's email.
 */
export type CarbonCustomer = {
  id: string;
  name: string;
  companyId: string;
  customerTypeId: string | null;
  customerStatusId: string | null;
  /** Set when this customer has been merged into another. Acts as soft-archive. */
  mergedIntoCustomerId?: string | null;
  createdAt: string;
  updatedAt: string | null;
};

/**
 * Carbon's `contact` row shape (subset). Carbon stores these normalized in
 * a dedicated table; the link to a customer is via the `customerContact`
 * junction.
 */
export type CarbonContact = {
  id: string;
  companyId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string | null;
};

/**
 * Carbon's `customerContact` junction row shape. INSERT means
 * "this contact is now attached to this customer" (shelf provisions a User);
 * DELETE means unlinking (shelf clears the link); UPDATE moves the
 * relationship (rare).
 */
export type CarbonCustomerContact = {
  id: string;
  customerId: string;
  contactId: string;
  customerLocationId?: string | null;
  companyId: string;
};

/**
 * Discriminated union of Carbon webhook payloads (the bytes shelf actually
 * receives). Matches the relay shape produced by Carbon's
 * `supabase/functions/webhook/index.ts`:
 *
 *   { type, record, old?, companyId, table }
 *
 * INSERT carries no `old`; DELETE carries `old` instead of changes (the
 * `record` is still set to the deleted row by the relay).
 */
export type CarbonWebhookPayload =
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "customer";
      record: CarbonCustomer;
      old?: CarbonCustomer;
      companyId: string;
    }
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "customerContact";
      record: CarbonCustomerContact;
      old?: CarbonCustomerContact;
      companyId: string;
    }
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "contact";
      record: CarbonContact;
      old?: CarbonContact;
      companyId: string;
    };

/** Job payloads handled by the carbon-sync pg-boss queue. */
export type CarbonSyncJob =
  | {
      kind: "reconcile-all";
      /** Sync window override; defaults to "anything updated since last run". */
      since?: string;
    }
  | { kind: "upsert-customer"; carbonCustomerId: string }
  | { kind: "upsert-contact"; carbonContactId: string };
