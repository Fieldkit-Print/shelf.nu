/**
 * Carbon Sync — Shared Types (FDW edition)
 *
 * Type definitions for the Fieldkit ↔ Carbon ERP integration.
 *
 * The architecture has shifted: Carbon owns customer + item master data and
 * Shelf reads it via Postgres FDW (`carbon_remote.v1_*`). Webhook events here
 * are limited to:
 *
 * 1. **`contact` UPDATE** — refresh the Shelf User row (email/name change).
 * 2. **`customerContact` INSERT/UPDATE/DELETE** — provision / unlink the
 *    Shelf User that mirrors a Carbon contact (auth identity).
 * 3. **`item` INSERT/UPDATE/DELETE** — when Carbon flips `visibleInShelf` on
 *    a Consumable item, Shelf upserts/archives a CONSUMABLE Asset record.
 *
 * `customer` events are still received (Carbon's webhook UI subscribes to
 * the `customer` table) but Shelf no longer mirrors them — the handler
 * acks with a debug log. Customer master fields are read via the
 * `carbon_remote.v1_customers` foreign view at query time.
 *
 * Carbon's `serialNumber` table is being retired; INSTANCE Asset
 * provisioning will move to a Carbon-calls-Shelf API endpoint
 * (`/api/internal/carbon/asset`) when the warehouse intake flow ships.
 *
 * @see {@link file://./service.server.ts}    Upsert dispatch
 * @see {@link file://./client.server.ts}     Carbon REST client
 * @see {@link file://./webhook.server.ts}    Webhook entry point
 * @see {@link file://./docs/contract-views.md} FDW contracts
 */

/**
 * Carbon's `customer` row (ack-only — Shelf doesn't mirror, just won't crash
 * on the payload).
 */
export type CarbonCustomer = {
  id: string;
  name: string;
  companyId: string;
  customerTypeId: string | null;
  customerStatusId: string | null;
  mergedIntoCustomerId?: string | null;
  createdAt: string;
  updatedAt: string | null;
};

/** Carbon's `contact` row (subset Shelf cares about). */
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

/** Carbon's `customerContact` junction row. */
export type CarbonCustomerContact = {
  id: string;
  customerId: string;
  contactId: string;
  customerLocationId?: string | null;
  companyId: string;
};

/** Carbon's `item.itemTrackingType` enum. */
export type CarbonItemTrackingType =
  | "Serial"
  | "Batch"
  | "Inventory"
  | "Non-Inventory";

/** Carbon's `item.type` enum. */
export type CarbonItemType =
  | "Part"
  | "Material"
  | "Tool"
  | "Service"
  | "Consumable"
  | "Fixture";

/**
 * Carbon's `item` row (subset Shelf needs for provisioning + display).
 *
 * `visibleInShelf` is a Fieldkit-added column (see Carbon migration in
 * `docs/CARBON_MIGRATION.sql`). It defaults to `true` for serial-tracked
 * items and `false` for everything else.
 */
export type CarbonItem = {
  id: string;
  readableId: string;
  name: string;
  description: string | null;
  type: CarbonItemType;
  itemTrackingType: CarbonItemTrackingType;
  unitOfMeasureCode: string | null;
  thumbnailUrl: string | null;
  active: boolean;
  visibleInShelf: boolean;
  companyId: string;
  createdAt: string;
  updatedAt: string | null;
};

/**
 * Discriminated union of Carbon webhook payloads (relayed shape from
 * Carbon's `supabase/functions/webhook/index.ts`):
 *
 *   { type, record, old?, companyId, table }
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
    }
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "item";
      record: CarbonItem;
      old?: CarbonItem;
      companyId: string;
    };

/** Job payloads handled by the carbon-sync pg-boss queue. */
export type CarbonSyncJob =
  | {
      kind: "reconcile-all";
      /** Sync window override; reserved for future incremental support. */
      since?: string;
    }
  | { kind: "upsert-contact"; carbonContactId: string };
