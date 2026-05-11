/**
 * Carbon Sync — Shared Types (FDW edition)
 *
 * Type definitions for the Fieldkit ↔ Carbon ERP integration.
 *
 * The architecture has shifted: Carbon owns customer + item master data and
 * Shelf reads it via Postgres FDW (`carbon_remote.v1_*`). Webhook events here
 * cover:
 *
 * 1. **`contact` UPDATE** — refresh the Shelf User row (email/name change).
 * 2. **`customerContact` INSERT/UPDATE/DELETE** — provision / unlink the
 *    Shelf User that mirrors a Carbon contact (auth identity).
 * 3. **`item` INSERT/UPDATE/DELETE** — for CONSUMABLE items, upsert/archive
 *    one Shelf Asset per item. For INSTANCE (serial-tracked) items the
 *    handler only refreshes shared display fields on existing Shelf
 *    Assets — it does not mint new ones (see `itemLedger` below).
 * 4. **`itemLedger` INSERT** — for serial-tracked items, the first
 *    positive-quantity ledger row that references a tracked entity is
 *    the "this physical unit exists in inventory now" signal. Shelf
 *    mints one INSTANCE Asset per tracked entity at that point.
 *
 * `customer` events are still received (Carbon's webhook UI subscribes to
 * the `customer` table) but Shelf no longer mirrors them — the handler
 * acks with a debug log. Customer master fields are read via the
 * `carbon_remote.v1_customers` foreign view at query time.
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
 * Carbon's `trackedEntity` row — one physical unit (serial) or one batch
 * (batch-tracked) of a given item. Created by receipt / job-output flows
 * in Carbon. Has no direct `itemId` column; the link to the item is
 * derived via the `itemLedger.trackedEntityId` join (see {@link CarbonItemLedger}).
 *
 * `readableId` is the human-facing serial / batch number (operator-entered
 * in Carbon today).
 */
export type CarbonTrackedEntity = {
  id: string;
  readableId: string | null;
  quantity: number;
  status: string;
  sourceDocument: string;
  sourceDocumentId: string;
  sourceDocumentReadableId: string | null;
  attributes: Record<string, unknown>;
  companyId: string;
  createdAt: string;
};

/**
 * Carbon's `itemLedger` row — inventory movement (receipt, sale, transfer,
 * adjustment, etc.). For serial-tracked items, every movement carries the
 * `trackedEntityId` of the affected physical unit.
 *
 * Shelf uses positive-quantity ledger inserts with a non-null
 * `trackedEntityId` as the "this serial just landed in inventory" signal
 * to mint a Shelf INSTANCE Asset.
 */
export type CarbonItemLedger = {
  id: string;
  entryNumber: number;
  postingDate: string;
  entryType:
    | "Purchase"
    | "Sale"
    | "Positive Adjmt."
    | "Negative Adjmt."
    | "Transfer"
    | "Consumption"
    | "Output"
    | "Assembly Consumption"
    | "Assembly Output";
  documentType: string | null;
  documentId: string | null;
  externalDocumentId: string | null;
  itemId: string;
  itemReadableId: string | null;
  locationId: string | null;
  shelfId: string | null;
  trackedEntityId: string | null;
  quantity: number;
  companyId: string;
  createdAt: string;
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
    }
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "itemLedger";
      record: CarbonItemLedger;
      old?: CarbonItemLedger;
      companyId: string;
    }
  | {
      type: "INSERT" | "UPDATE" | "DELETE";
      table: "trackedEntity";
      record: CarbonTrackedEntity;
      old?: CarbonTrackedEntity;
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
