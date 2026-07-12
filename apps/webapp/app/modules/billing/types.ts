/**
 * Billing module — shared types.
 *
 * The billing ledger records physical events in Shelf (storage tick, pick,
 * return, rental, loss, consumable use) as BillableEvent rows. The ledger
 * is Shelf-native: rows are the source of "what happened" for any invoicing
 * or reporting process that consumes them.
 *
 * Lifecycle:
 *
 *   physical event → recordBillableEvent → BillableEvent(PENDING)
 *
 * @see {@link file://./events.server.ts}          Event-emit helpers
 * @see {@link file://./storage-billing.server.ts} Daily storage cron
 * @see {@link file://./queue.server.ts}           pg-boss worker registration
 */

import type { BillableEventKind } from "@prisma/client";

/** Minimum metadata every recorded event carries. */
export type RecordBillableEventArgs = {
  organizationId: string;
  kind: BillableEventKind;
  /** Customer id this charge bills against. */
  customerId: string;
  /** Asset id (Shelf-side) if applicable. */
  assetId?: string;
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

/** Job payloads handled by the billing pg-boss cron queues. */
export type BillingCronJob =
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
