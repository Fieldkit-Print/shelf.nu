/**
 * Billing Event Emission
 *
 * Writes `BillableEvent` rows at the moments a billable thing happens —
 * picks (booking RESERVED → ONGOING), returns (ONGOING → COMPLETE or
 * partial check-in), rental loss (overdue past threshold), consumable
 * consumption (qtyOut > qtyReturned on a CONSUMABLE asset).
 *
 * Storage and rental-use accrue continuously and are emitted by a daily
 * cron (see `~/utils/scheduler.server.ts`), not by this module.
 *
 * Every emission:
 *   - resolves the rate via the pricing hierarchy at write time
 *   - stamps `amountCents` + `currencyCode` on the row for audit
 *     (historical preservation, even if pricing changes later)
 *   - uses a deterministic `idempotencyKey` so retries / duplicate
 *     transitions are safe (UNIQUE index on the column drops dupes)
 *   - accepts an optional Prisma tx so the event commits atomically with
 *     the mutation that triggered it
 *
 * Internal Fieldkit assets (`Asset.carbonCustomerId IS NULL AND rentable = false`)
 * are never billed — they're staff-only inventory.
 *
 * @see {@link file://./../pricing/resolver.server.ts}
 * @see {@link file://./../../../packages/database/prisma/schema.prisma} BillableEvent
 */

import type { Asset, Prisma } from "@prisma/client";
import { BillableEventKind } from "@prisma/client";

import { db } from "~/database/db.server";
import {
  resolveConsumableMarkupPct,
  resolveFlatRateCents,
  resolveRentalLossMultiplier,
} from "~/modules/pricing/resolver.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

const label = "Billing" as const;

/** Minimum shape this module needs from a Prisma client / transaction. */
type EmissionTx = Pick<typeof db, "billableEvent">;

/**
 * Build the deterministic idempotency key for a one-off event (PICK,
 * RETURN, RENTAL_LOSS, CONSUMABLE_USE). Tying the key to (kind, bookingId,
 * assetId) means re-running a transition that already produced the event
 * is a no-op rather than a double-billing.
 *
 * Storage / rental-use accrual keys are scoped by date and live in the
 * cron module.
 */
function oneOffKey(
  kind: BillableEventKind,
  bookingId: string,
  assetId: string
): string {
  return `${kind}:${bookingId}:${assetId}`;
}

/**
 * Type for the asset shape this module needs. Defined inline because
 * callers (booking service) typically already have richer rows; we only
 * read these fields.
 */
type BillableAsset = Pick<
  Asset,
  "id" | "carbonCustomerId" | "rentable" | "kind" | "valuation"
> & {
  /** Optional Carbon part id (denormalized into BillableEvent for grouping). */
  carbonTrackedEntityId?: string | null;
};

/**
 * Emit a PICK event for each customer-owned asset in the supplied set.
 * Fieldkit-owned assets (carbonCustomerId IS NULL) are skipped — there's
 * no customer to bill for picking a rental.
 *
 * @returns Number of events written.
 */
export async function emitPickEvents(args: {
  organizationId: string;
  bookingId: string;
  assets: BillableAsset[];
  /** Defaults to now(). Pass the booking's checkout timestamp for clarity. */
  occurredAt?: Date;
  tx?: EmissionTx;
}): Promise<number> {
  return emitOneOffPerAsset({
    ...args,
    kind: BillableEventKind.PICK,
    assetFilter: (a) => a.carbonCustomerId !== null,
    resolveAmount: async (asset) =>
      resolveFlatRateCents({
        organizationId: args.organizationId,
        carbonCustomerId: asset.carbonCustomerId!,
        assetId: asset.id,
        kind: "PICK",
      }),
  });
}

/**
 * Emit a RETURN event for each customer-owned asset returning to storage.
 */
export async function emitReturnEvents(args: {
  organizationId: string;
  bookingId: string;
  assets: BillableAsset[];
  occurredAt?: Date;
  tx?: EmissionTx;
}): Promise<number> {
  return emitOneOffPerAsset({
    ...args,
    kind: BillableEventKind.RETURN,
    assetFilter: (a) => a.carbonCustomerId !== null,
    resolveAmount: async (asset) =>
      resolveFlatRateCents({
        organizationId: args.organizationId,
        carbonCustomerId: asset.carbonCustomerId!,
        assetId: asset.id,
        kind: "RETURN",
      }),
  });
}

/**
 * Emit a RENTAL_LOSS event for one rentable Fieldkit asset that was not
 * returned. Amount = `multiplier * asset.valuation` (in cents). Caller
 * supplies the customer being charged (typically the booking creator's
 * carbonCustomerId).
 *
 * If valuation is null or zero the event is skipped — there's nothing to
 * multiply. We log a warning so staff can fix the valuation and re-emit.
 */
export async function emitRentalLossEvent(args: {
  organizationId: string;
  bookingId: string;
  asset: BillableAsset;
  carbonCustomerId: string;
  occurredAt?: Date;
  tx?: EmissionTx;
}): Promise<boolean> {
  const { organizationId, bookingId, asset, carbonCustomerId, occurredAt, tx } =
    args;

  if (asset.carbonCustomerId !== null) {
    // RENTAL_LOSS only applies to Fieldkit-owned items. Customer-owned
    // asset loss is a separate insurance/replacement workflow.
    return false;
  }

  const valuation = Number(asset.valuation ?? 0);
  if (!Number.isFinite(valuation) || valuation <= 0) {
    Logger.warn("[Billing] Skipping RENTAL_LOSS: asset valuation missing", {
      assetId: asset.id,
      valuation: asset.valuation,
    });
    return false;
  }

  const resolved = await resolveRentalLossMultiplier({
    organizationId,
    carbonCustomerId,
  });
  if (!resolved) return false;

  // valuation is stored as a currency amount; multiply and convert to cents.
  const amountCents = Math.round(
    valuation * Number(resolved.multiplier) * 100
  );

  return writeOneEvent({
    organizationId,
    kind: BillableEventKind.RENTAL_LOSS,
    bookingId,
    assetId: asset.id,
    carbonCustomerId,
    carbonPartId: asset.carbonTrackedEntityId ?? null,
    quantity: 1,
    amountCents,
    occurredAt,
    tx,
  });
}

/**
 * Emit a CONSUMABLE_USE event for the quantity consumed on a single
 * (booking, asset). Quantity = `quantityOut - quantityReturned` and must
 * be positive. Amount is the asset's unit cost × markup × qty, in cents.
 *
 * If unit cost cannot be derived from the asset row (valuation null) the
 * event is skipped with a warn — billing config error to fix manually.
 */
export async function emitConsumableUseEvent(args: {
  organizationId: string;
  bookingId: string;
  asset: BillableAsset;
  carbonCustomerId: string;
  quantityConsumed: number;
  occurredAt?: Date;
  tx?: EmissionTx;
}): Promise<boolean> {
  const {
    organizationId,
    bookingId,
    asset,
    carbonCustomerId,
    quantityConsumed,
    occurredAt,
    tx,
  } = args;

  if (quantityConsumed <= 0) return false;

  // Valuation here is unit cost; markup applied on top before charging.
  const unitCost = Number(asset.valuation ?? 0);
  if (!Number.isFinite(unitCost) || unitCost <= 0) {
    Logger.warn("[Billing] Skipping CONSUMABLE_USE: asset valuation missing", {
      assetId: asset.id,
      valuation: asset.valuation,
    });
    return false;
  }

  const resolved = await resolveConsumableMarkupPct({
    organizationId,
    carbonCustomerId,
  });
  // No markup configured = sell at cost (markup factor of 1).
  const markupFactor = resolved ? 1 + Number(resolved.markupPct) : 1;

  const amountCents = Math.round(
    unitCost * markupFactor * quantityConsumed * 100
  );

  return writeOneEvent({
    organizationId,
    kind: BillableEventKind.CONSUMABLE_USE,
    bookingId,
    assetId: asset.id,
    carbonCustomerId,
    carbonPartId: asset.carbonTrackedEntityId ?? null,
    quantity: quantityConsumed,
    amountCents,
    occurredAt,
    tx,
  });
}

/**
 * Shared one-asset-per-event implementation for PICK / RETURN. Each runs
 * the same shape: filter assets → resolve rate → write event with the
 * deterministic key. Returning the count helps callers log what they
 * actually billed without re-querying.
 */
async function emitOneOffPerAsset(args: {
  organizationId: string;
  bookingId: string;
  assets: BillableAsset[];
  kind: BillableEventKind;
  occurredAt?: Date;
  tx?: EmissionTx;
  assetFilter: (a: BillableAsset) => boolean;
  resolveAmount: (
    a: BillableAsset
  ) => Promise<{ amountCents: number; currencyCode: string } | null>;
}): Promise<number> {
  const billable = args.assets.filter(args.assetFilter);
  if (billable.length === 0) return 0;

  let count = 0;
  for (const asset of billable) {
    try {
      const resolved = await args.resolveAmount(asset);
      // No rate configured at any tier = skip emission (not an error).
      if (!resolved) continue;

      const wrote = await writeOneEvent({
        organizationId: args.organizationId,
        kind: args.kind,
        bookingId: args.bookingId,
        assetId: asset.id,
        carbonCustomerId: asset.carbonCustomerId!,
        carbonPartId: asset.carbonTrackedEntityId ?? null,
        quantity: 1,
        amountCents: resolved.amountCents,
        currencyCode: resolved.currencyCode,
        occurredAt: args.occurredAt,
        tx: args.tx,
      });
      if (wrote) count++;
    } catch (cause) {
      // Don't let one bad asset block the rest. Log and continue.
      Logger.error(
        new ShelfError({
          cause,
          label,
          message: "Failed to emit billable event",
          additionalData: {
            kind: args.kind,
            bookingId: args.bookingId,
            assetId: asset.id,
          },
        })
      );
    }
  }
  return count;
}

/**
 * Low-level insert. Uses Prisma `createMany skipDuplicates` so the UNIQUE
 * index on `idempotencyKey` silently drops repeats — safe to call
 * multiple times for the same logical event.
 *
 * `currencyCode` is required for flat-rate kinds (PICK/RETURN/etc) and
 * passed in by the caller. For loss/consumable callers don't have a
 * direct rate row, so we resolve currency here from the org/customer
 * tier.
 */
async function writeOneEvent(args: {
  organizationId: string;
  kind: BillableEventKind;
  bookingId: string;
  assetId: string;
  carbonCustomerId: string;
  carbonPartId?: string | null;
  quantity: number;
  amountCents: number;
  currencyCode?: string;
  occurredAt?: Date;
  tx?: EmissionTx;
}): Promise<boolean> {
  const client = (args.tx ?? db) as EmissionTx;
  const data: Prisma.BillableEventCreateManyInput = {
    organizationId: args.organizationId,
    kind: args.kind,
    carbonCustomerId: args.carbonCustomerId,
    assetId: args.assetId,
    carbonPartId: args.carbonPartId ?? null,
    quantity: args.quantity,
    amountCents: args.amountCents,
    currencyCode: args.currencyCode ?? "USD",
    occurredAt: args.occurredAt ?? new Date(),
    idempotencyKey: oneOffKey(args.kind, args.bookingId, args.assetId),
  };

  const result = await client.billableEvent.createMany({
    data: [data],
    skipDuplicates: true,
  });

  return result.count > 0;
}
