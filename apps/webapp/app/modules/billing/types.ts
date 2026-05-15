/**
 * Billing module — shared types.
 *
 * The billing ledger turns physical events in Shelf (storage tick, pick,
 * return, rental, loss, consumable use) into Carbon invoice line items.
 * Carbon owns invoicing; Shelf is the source of "what happened."
 *
 * Lifecycle:
 *
 *   physical event → recordBillableEvent → BillableEvent(PENDING)
 *                                          ↓ (worker)
 *                                          POST Carbon billing API
 *                                          ↓
 *                                          BillableEvent(PUSHED | FAILED)
 *
 * @see {@link file://./events.server.ts}        Event-emit helpers
 * @see {@link file://./carbon-push.server.ts}   Carbon API push
 * @see {@link file://./storage-billing.server.ts} Daily storage cron
 * @see {@link file://./queue.server.ts}         pg-boss worker registration
 */

import type { BillableEventKind } from "@prisma/client";

/** Minimum metadata every recorded event carries. */
export type RecordBillableEventArgs = {
  organizationId: string;
  kind: BillableEventKind;
  /** Carbon customer id this charge bills against. */
  carbonCustomerId: string;
  /** Asset id (Shelf-side) if applicable. */
  assetId?: string;
  /** Carbon item id (denorm from Asset for grouping). */
  carbonPartId?: string | null;
  /** Location at event time (storage events). */
  locationId?: string | null;
  /** Quantity. 1 for instance events; >1 for consumable use. */
  quantity?: number;
  /** Pre-computed price (cents). Null = price resolved at invoice time. */
  amountCents?: number | null;
  currencyCode?: string | null;
  /** Window the event covers. */
  occurredAt?: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** Idempotency key. Caller must supply a deterministic value. */
  idempotencyKey: string;
  notes?: string;
};

/** Job payloads handled by the billing-push pg-boss queue. */
export type BillingPushJob =
  | {
      /** Push every PENDING + FAILED-retry-eligible event up to a batch cap. */
      kind: "drain-pending";
      batchSize?: number;
    }
  | {
      /** Push one specific event by id. Used for synchronous critical paths. */
      kind: "push-one";
      billableEventId: string;
    }
  | {
      /** Run the daily storage-billing pass.
       *
       *  Scheduled by pg-boss cron at ~03:00 UTC. Emits STORAGE
       *  BillableEvent rows for the previous day. Safe to retry: storage
       *  events are keyed on (asset, day) for idempotency. */
      kind: "run-storage-billing";
    }
  | {
      /** Run the daily rental-use billing pass.
       *
       *  Scheduled by pg-boss cron at ~03:15 UTC (offset from storage so
       *  they don't contend on the same DB). Emits RENTAL_USE
       *  BillableEvent rows for each Fieldkit-owned rentable asset
       *  currently on an active booking that overlaps the billing day.
       *  Safe to retry: keyed on (booking, asset, day). */
      kind: "run-rental-use-billing";
    };

/**
 * Shape of the outbound request Shelf POSTs to Carbon's (future) billing
 * API. Documented here as the contract Carbon should expose; the actual
 * client lives in `carbon-push.server.ts`.
 *
 * Endpoint (proposed): `POST /api/billing/line-items`
 *   Auth: `carbon-key` header with `create: invoicing` scope
 *   Body: see below
 *   Response (success): `{ invoiceLineId: string }`
 *   Response (failure): `{ error: string }`, HTTP 4xx/5xx
 */
export type CarbonBillingLineItemPayload = {
  companyId: string;
  carbonCustomerId: string;
  kind: BillableEventKind;
  quantity: number;
  /** Optional; Carbon may compute its own price if unset. */
  amountCents?: number | null;
  currencyCode?: string | null;
  /** Carbon item id this charge ties to (for grouping). */
  carbonPartId?: string | null;
  occurredAt: string; // ISO 8601
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Shelf's idempotency key — Carbon should dedupe on this. */
  idempotencyKey: string;
  /** Free-form notes shown on the invoice. */
  notes?: string;
};
