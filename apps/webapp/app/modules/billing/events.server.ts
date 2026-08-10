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
 */

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "~/database/db.server";

import type { RecordBillableEventArgs } from "./types";

/**
 * Minimum Prisma surface needed to write a billable event. Both the extended
 * top-level client and a transaction client satisfy it, so callers can pass
 * either. Typed structurally for the same reason as
 * {@link RecordEventTxClient} in the activity-event module — the extended
 * client isn't assignable to the generated `Prisma.TransactionClient`.
 */
export type BillableEventTxClient = {
  billableEvent: {
    upsert: (args: {
      where: { idempotencyKey: string };
      create: Prisma.BillableEventUncheckedCreateInput;
      update: Record<string, never>;
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
};

/**
 * Inserts a `BillableEvent` row. Returns the existing event id if an
 * event with the same `idempotencyKey` already exists (no-op retry).
 *
 * The row starts in `status = PENDING`, and is picked up by the monthly
 * push to Productive.
 *
 * @param tx - Pass the surrounding transaction when the event is emitted
 *   alongside a state change. Without it the charge commits even if the
 *   mutation that justified it rolls back.
 */
export async function recordBillableEvent(
  args: RecordBillableEventArgs,
  tx?: BillableEventTxClient
) {
  const client = tx ?? db;
  const result = await client.billableEvent.upsert({
    where: { idempotencyKey: args.idempotencyKey },
    create: {
      organizationId: args.organizationId,
      kind: args.kind,
      customerId: args.customerId,
      assetId: args.assetId,
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
 * Records one month's storage charge for one occupied pallet position.
 *
 * The billable unit is the slot, not the asset — a standard pallet holding
 * fifty items is one charge. `assetId` is therefore normally null, and set
 * only for OVERSIZE floor positions, which the rate card quotes per item and
 * so bill once per asset in the area.
 *
 * Idempotency window: one row per (location, month), or per
 * (location, asset, month) for per-item positions. Re-running the sweep for
 * a month already billed is a no-op.
 */
export async function recordStorageMonth(args: {
  organizationId: string;
  customerId: string;
  locationId: string;
  /** Set only for per-item (OVERSIZE) positions. */
  assetId?: string | null;
  /** First instant of the billing month (UTC midnight on the 1st). */
  month: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  const monthIso = args.month.toISOString().slice(0, 7); // YYYY-MM
  const periodEnd = new Date(
    Date.UTC(
      args.month.getUTCFullYear(),
      args.month.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0
    ) - 1
  );

  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "STORAGE",
    customerId: args.customerId,
    assetId: args.assetId ?? undefined,
    locationId: args.locationId,
    quantity: 1,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.month,
    periodStart: args.month,
    periodEnd,
    idempotencyKey: args.assetId
      ? key(["storage", args.locationId, args.assetId, monthIso])
      : key(["storage", args.locationId, monthIso]),
  });
}

/**
 * Arguments shared by the pick and return handling charges.
 *
 * Both are billed **per pallet, per shipment** — a position holding fifty
 * cartons is one pick, not fifty. `locationId` is therefore the billable
 * unit; `assetId` is only a representative member of that pallet, recorded
 * so the ledger row can be traced back to something concrete.
 */
type HandlingChargeArgs = {
  organizationId: string;
  customerId: string;
  /** The booking this movement belongs to — part of the idempotency key. */
  bookingId: string;
  /** Pallet position being handled. Null when the asset isn't slotted. */
  locationId: string | null;
  /** A representative asset on the pallet. */
  assetId: string;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
};

/**
 * Builds the idempotency key for a handling charge.
 *
 * Keyed on (kind, booking, pallet) — deliberately NOT on a timestamp. The
 * previous formula hashed `occurredAt` down to the millisecond, so every
 * invocation produced a fresh key and the unique index never collapsed
 * anything: a double-clicked "Check in" billed the customer twice. An
 * unslotted asset falls back to its own id so two loose items on one booking
 * still bill separately.
 */
function handlingKey(
  kind: "pick" | "return",
  args: Pick<HandlingChargeArgs, "bookingId" | "locationId" | "assetId">
) {
  return key([
    kind,
    args.bookingId,
    args.locationId ?? `asset:${args.assetId}`,
  ]);
}

/** One billable pallet movement, collapsed from the assets sitting on it. */
export type PalletUnit = {
  customerId: string;
  /** Pallet position. Null for an unslotted asset billed on its own. */
  locationId: string | null;
  /** Representative asset recorded on the ledger row. */
  assetId: string;
  /** How many assets this charge covers — for logging, not pricing. */
  assetCount: number;
};

/**
 * Collapses a booking's assets into the pallet positions they occupy, which
 * is what handling is actually billed on.
 *
 * Fieldkit-owned assets (no `customerId`) are dropped — there is nobody to
 * bill for moving our own rental stock. Assets sharing a position collapse to
 * one unit; unslotted assets each stand alone, since without a position there
 * is no pallet to group them onto.
 *
 * Shared by the pick and return paths so the two cannot drift apart and start
 * billing different units for the same physical movement.
 */
export function groupAssetsIntoPallets(
  assets: Array<{
    id: string;
    customerId: string | null;
    locationId: string | null;
  }>
): PalletUnit[] {
  const byPosition = new Map<string, PalletUnit>();

  for (const asset of assets) {
    if (!asset.customerId) continue;

    // Key on the position, falling back to the asset itself when unslotted.
    // Customer is part of the key so a position somehow holding two
    // customers' goods bills each of them rather than silently merging.
    const groupKey = asset.locationId
      ? `${asset.customerId}:loc:${asset.locationId}`
      : `${asset.customerId}:asset:${asset.id}`;

    const existing = byPosition.get(groupKey);
    if (existing) {
      existing.assetCount += 1;
      continue;
    }

    byPosition.set(groupKey, {
      customerId: asset.customerId,
      locationId: asset.locationId,
      assetId: asset.id,
      assetCount: 1,
    });
  }

  return Array.from(byPosition.values());
}

/**
 * Records a pick — a pallet pulled from storage and shipped out.
 * One charge per (booking, pallet).
 */
export async function recordPick(
  args: HandlingChargeArgs,
  tx?: BillableEventTxClient
) {
  return recordBillableEvent(
    {
      organizationId: args.organizationId,
      kind: "PICK",
      customerId: args.customerId,
      assetId: args.assetId,
      locationId: args.locationId,
      quantity: 1,
      amountCents: args.amountCents ?? null,
      currencyCode: args.currencyCode ?? null,
      occurredAt: args.occurredAt,
      idempotencyKey: handlingKey("pick", args),
    },
    tx
  );
}

/**
 * Records a return — a pallet received back and restocked into storage.
 * One charge per (booking, pallet).
 */
export async function recordReturn(
  args: HandlingChargeArgs,
  tx?: BillableEventTxClient
) {
  return recordBillableEvent(
    {
      organizationId: args.organizationId,
      kind: "RETURN",
      customerId: args.customerId,
      assetId: args.assetId,
      locationId: args.locationId,
      quantity: 1,
      amountCents: args.amountCents ?? null,
      currencyCode: args.currencyCode ?? null,
      occurredAt: args.occurredAt,
      idempotencyKey: handlingKey("return", args),
    },
    tx
  );
}

/**
 * Records one day of rental usage. For multi-day rentals, the caller
 * loops over days and calls this once per day, the same way storage works.
 */
export async function recordRentalUseDay(args: {
  organizationId: string;
  customerId: string;
  assetId: string;
  bookingId: string;
  day: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  const dayIso = args.day.toISOString().slice(0, 10);
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "RENTAL_USE",
    customerId: args.customerId,
    assetId: args.assetId,
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
  customerId: string;
  assetId: string;
  bookingId: string;
  occurredAt: Date;
  amountCents?: number;
  currencyCode?: string;
}) {
  return recordBillableEvent({
    organizationId: args.organizationId,
    kind: "RENTAL_LOSS",
    customerId: args.customerId,
    assetId: args.assetId,
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
  customerId: string;
  assetId: string;
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
    customerId: args.customerId,
    assetId: args.assetId,
    quantity: args.quantityUsed,
    amountCents: args.amountCents ?? null,
    currencyCode: args.currencyCode ?? null,
    occurredAt: args.occurredAt,
    idempotencyKey: key(["consumable-use", args.bookingId, args.assetId]),
    notes: `Booking ${args.bookingId}: ${args.quantityUsed} consumed`,
  });
}
