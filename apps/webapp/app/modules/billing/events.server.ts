/**
 * Billing — event-emit helpers.
 *
 * Public surface for code in other modules (booking service, custody
 * service, storage cron, etc.) to record a billable event. Each helper
 * is a thin wrapper around `recordBillableEvent` with a fixed `kind` and
 * deterministic `idempotencyKey` formula.
 *
 * Idempotency keys are critical: storage cron runs nightly and may retry
 * after failures; the unique index on `BillableEvent.idempotencyKey`
 * collapses duplicates so a customer is never double-charged for the same
 * physical event.
 *
 * @see {@link file://./types.ts}              Argument shapes
 * @see {@link file://./carbon-push.server.ts} Carbon push contract
 */

import { createHash } from "node:crypto";

import { db } from "~/database/db.server";

import type { RecordBillableEventArgs } from "./types";

/**
 * Inserts a `BillableEvent` row. Returns the existing event id if an
 * event with the same `idempotencyKey` already exists (no-op retry).
 *
 * The row starts in `status = PENDING`. The pg-boss worker drains it
 * asynchronously (see `queue.server.ts`).
 */
export async function recordBillableEvent(args: RecordBillableEventArgs) {
  const result = await db.billableEvent.upsert({
    where: { idempotencyKey: args.idempotencyKey },
    create: {
      organizationId: args.organizationId,
      kind: args.kind,
      carbonCustomerId: args.carbonCustomerId,
      assetId: args.assetId,
      carbonPartId: args.carbonPartId ?? null,
      locationId: args.locationId ?? null,
      quantity: args.quantity ?? 1,
      amountCents: args.amountCents ?? null,
      currencyCode: args.currencyCode ?? null,
      occurredAt: args.occurredAt ?? new Date(),
      periodStart: args.periodStart ?? null,
      periodEnd: args.periodEnd ?? null,
      idempotencyKey: args.idempotencyKey,
      notes: args.notes,
    },
    // Idempotency: no-op on conflict; the existing row's status governs
    // whether the worker still has work to do.
    update: {},
    select: { id: true },
  });
  return result.id;
}

/** Stable hash of inputs → idempotency key. */
function key(parts: Array<string | number | null | undefined>): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(p ?? ""));
    h.update("|");
  }
  return h.digest("hex").slice(0, 32);
}

// ----------------------------------------------------------------------------
// Per-kind helpers
//
// These are the canonical surfaces other modules import. Each computes the
// idempotency key from the inputs so callers don't have to think about it.
// ----------------------------------------------------------------------------

/**
 * Records a single day's storage charge for one customer-owned asset.
 * Idempotency window: 1 row per (asset, billing day).
 */
export async function recordStorageDay(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  locationId: string | null;
  /** Billing day (UTC midnight). */
  day: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  const dayIso = args.day.toISOString().slice(0, 10);
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "STORAGE",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    locationId: args.locationId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.day,
    periodStart: args.day,
    periodEnd: new Date(args.day.getTime() + 24 * 60 * 60 * 1000 - 1),
    idempotencyKey: key(["storage", args.assetId, dayIso]),
  });
}

/** Records a pick (asset checked out of storage). */
export async function recordPick(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  locationId: string | null;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "PICK",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    locationId: args.locationId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.occurredAt,
    idempotencyKey: key(["pick", args.assetId, args.occurredAt.toISOString()]),
  });
}

/** Records a return (asset checked back into storage). */
export async function recordReturn(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  locationId: string | null;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "RETURN",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    locationId: args.locationId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.occurredAt,
    idempotencyKey: key([
      "return",
      args.assetId,
      args.occurredAt.toISOString(),
    ]),
  });
}

/**
 * Records one day of rental usage. For multi-day rentals, the caller
 * loops over days and calls this once per day, the same way storage works.
 */
export async function recordRentalUseDay(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  bookingId: string;
  day: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  const dayIso = args.day.toISOString().slice(0, 10);
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "RENTAL_USE",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.day,
    periodStart: args.day,
    periodEnd: new Date(args.day.getTime() + 24 * 60 * 60 * 1000 - 1),
    idempotencyKey: key(["rental-use", args.bookingId, args.assetId, dayIso]),
    notes: `Booking ${args.bookingId}`,
  });
}

/**
 * Records that a rental was not returned by its deadline. One row per
 * (booking, asset).
 */
export async function recordRentalLoss(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  bookingId: string;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "RENTAL_LOSS",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.occurredAt,
    idempotencyKey: key(["rental-loss", args.bookingId, args.assetId]),
    notes: `Booking ${args.bookingId}`,
  });
}

/**
 * Records consumable use. Called when a booking's
 * `BookingAssetMeta.quantityReturned` is recorded at check-in and is less
 * than `quantityOut`. One row per (booking, asset).
 */
export async function recordConsumableUse(args: {
  organizationId: string;
  carbonCustomerId: string;
  assetId: string;
  carbonPartId: string | null;
  bookingId: string;
  quantityUsed: number;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  if (args.quantityUsed <= 0) return null;
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "CONSUMABLE_USE",
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId,
    quantity: args.quantityUsed,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.occurredAt,
    idempotencyKey: key(["consumable-use", args.bookingId, args.assetId]),
    notes: `Booking ${args.bookingId}: ${args.quantityUsed} consumed`,
  });
}
