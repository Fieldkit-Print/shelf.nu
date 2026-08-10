/**
 * Billing — daily storage cron.
 *
 * For each customer-owned asset currently stored at a Shelf location,
 * emit one STORAGE billable event per day. Idempotent — running twice on
 * the same day is a no-op (UNIQUE index on idempotencyKey).
 *
 * Pricing resolves via the three-tier hierarchy (asset → customer → org);
 * see resolver.server.ts.
 *
 * @see {@link file://./events.server.ts}                 Event-emit helpers
 * @see {@link file://./../pricing/resolver.server.ts}    Pricing hierarchy
 * @see {@link file://./queue.server.ts}                  pg-boss worker entry
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { recordRentalUseDay, recordStorageMonth } from "./events.server";
import {
  resolveFlatRateCents,
  resolveStorageMonthCents,
} from "../pricing/resolver.server";

/**
 * Returns the UTC midnight `Date` for the given day. Defaults to "yesterday"
 * (the most recent fully-elapsed day) so cron runs at any time of the day
 * still bill correctly for the day that just ended.
 */
function utcDay(date: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns UTC midnight on the first of the month containing `date`.
 * Defaults to the current month.
 */
function utcMonthStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Runs the storage pass for any month since the last one that produced
 * events, then for the current month.
 *
 * Retries cover a run that failed; they do nothing for a run that never
 * happened. pg-boss fires a cron only if the scheduled instant falls inside a
 * 60-second window and never replays a missed one, so a deploy or outage
 * across 03:00 on the 1st silently skipped an entire month's revenue with no
 * way to notice except reconciling by hand.
 *
 * Finds the newest STORAGE event and sweeps forward from the month after it.
 * Each pass is idempotent (keyed on location + month), so overlapping runs
 * converge instead of double-charging.
 *
 * @param opts.maxMonths - Safety bound on how far back to reach. Twelve means
 *   a year-long outage still terminates rather than sweeping to epoch.
 */
export async function runStorageBillingWithBackfill(opts?: {
  maxMonths?: number;
}) {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot bill storage.",
      label: "Billing",
    });
  }

  const maxMonths = opts?.maxMonths ?? 12;
  const thisMonth = utcMonthStart(new Date());

  const latest = await db.billableEvent.findFirst({
    where: {
      organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
      kind: "STORAGE",
    },
    orderBy: { periodStart: "desc" },
    select: { periodStart: true },
  });

  // No history: bill the current month only. Sweeping backwards on a fresh
  // install would invent charges for months the warehouse wasn't metered.
  const startFrom = latest?.periodStart
    ? new Date(
        Date.UTC(
          latest.periodStart.getUTCFullYear(),
          latest.periodStart.getUTCMonth() + 1,
          1
        )
      )
    : thisMonth;

  const months: Date[] = [];
  for (
    let m = startFrom;
    m <= thisMonth && months.length < maxMonths;
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
  ) {
    months.push(m);
  }

  if (months.length > 1) {
    Logger.warn("[Billing] Backfilling missed storage months", {
      count: months.length,
      from: months[0].toISOString().slice(0, 7),
      to: months[months.length - 1].toISOString().slice(0, 7),
    });
  }

  const results = [];
  for (const month of months) {
    results.push(await runMonthlyStorageBilling({ month }));
  }

  return {
    monthsProcessed: months.map((m) => m.toISOString().slice(0, 7)),
    emitted: results.reduce((sum, r) => sum + r.emitted, 0),
    errors: results.reduce((sum, r) => sum + r.errors, 0),
  };
}

/**
 * Runs the storage billing pass for one month.
 *
 * Storage is sold per occupied pallet position per month, so this sweeps
 * *locations*, not assets. Every location carrying a `storageSlotTier` is a
 * billable position; organizational locations (warehouses, zones, staging)
 * leave the tier null and are skipped.
 *
 * Two counting rules, both driven by the tier:
 *
 *   - The three pallet tiers bill **once per position**, however many assets
 *     sit on the pallet. Capacity-1 slots make that a single asset in
 *     practice, but a pallet holding fifty cartons is still one charge.
 *   - OVERSIZE bills **once per asset**, because the rate card quotes custom
 *     footprints per item.
 *
 * A position occupied by an asset that is currently checked out still bills:
 * the slot remains allocated to that customer and cannot be resold, which is
 * why checkout deliberately leaves `Asset.locationId` in place.
 *
 * Idempotent — running twice for the same month is a no-op (unique index on
 * `BillableEvent.idempotencyKey`), so a retry after a partial failure
 * resumes rather than double-charging.
 *
 * @param opts.month - Any date within the month to bill. Defaults to the
 *   current month, so the cron can run on the 1st for the month just begun
 *   or be invoked manually to backfill an earlier one.
 */
export async function runMonthlyStorageBilling(opts?: { month?: Date }) {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot bill storage.",
      label: "Billing",
    });
  }

  const month = utcMonthStart(opts?.month);

  // Every billable position, with the customer-owned assets occupying it.
  // Assets with no customer (Fieldkit-owned stock) never generate a storage
  // charge — there is nobody to bill.
  const slots = await db.location.findMany({
    where: {
      organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
      storageSlotTier: { not: null },
    },
    select: {
      id: true,
      name: true,
      storageSlotTier: true,
      storageMonthlyCentsOverride: true,
      assets: {
        where: { customerId: { not: null } },
        select: { id: true, customerId: true },
      },
    },
  });

  let emitted = 0;
  let errors = 0;
  let skippedUnoccupied = 0;
  let skippedNoRate = 0;

  Logger.info("[Billing] Monthly storage pass starting", {
    month: month.toISOString().slice(0, 7),
    slotCount: slots.length,
  });

  for (const slot of slots) {
    const tier = slot.storageSlotTier;
    if (!tier) continue;

    if (slot.assets.length === 0) {
      // Empty position. We bill occupancy, not allocation, so nothing to do.
      skippedUnoccupied += 1;
      continue;
    }

    // Per-item positions bill each asset; pallet positions bill the slot once.
    const chargeTargets =
      tier === "OVERSIZE"
        ? slot.assets.map((a) => ({ assetId: a.id, customerId: a.customerId }))
        : [{ assetId: null, customerId: slot.assets[0].customerId }];

    // A pallet position should only ever hold one customer's goods — the
    // capacity-1 constraint is what guarantees it. If that has been bypassed
    // (a slot created without a capacity, say), the charge is unattributable,
    // so refuse to guess.
    if (tier !== "OVERSIZE") {
      const distinctCustomers = new Set(
        slot.assets.map((a) => a.customerId).filter(Boolean)
      );
      if (distinctCustomers.size > 1) {
        errors += 1;
        Logger.error({
          message:
            "[Billing] Pallet position holds assets from multiple customers; storage not billed. Give the location a capacity of 1 and separate the goods.",
          locationId: slot.id,
          locationName: slot.name,
          customerIds: Array.from(distinctCustomers),
          month: month.toISOString().slice(0, 7),
        });
        continue;
      }
    }

    for (const target of chargeTargets) {
      if (!target.customerId) continue;
      try {
        const resolved = await resolveStorageMonthCents({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          customerId: target.customerId,
          tier,
          locationOverrideCents: slot.storageMonthlyCentsOverride,
        });

        if (!resolved) {
          // No rate anywhere. For OVERSIZE this means the per-slot override
          // was never set, which is a configuration gap worth surfacing
          // rather than silently billing nothing.
          skippedNoRate += 1;
          Logger.warn("[Billing] No storage rate resolved; position skipped", {
            locationId: slot.id,
            locationName: slot.name,
            tier,
            month: month.toISOString().slice(0, 7),
          });
          continue;
        }

        await recordStorageMonth({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          customerId: target.customerId,
          locationId: slot.id,
          assetId: target.assetId,
          month,
          amountCents: resolved.amountCents,
          currencyCode: resolved.currencyCode,
        });
        emitted += 1;
      } catch (cause) {
        errors += 1;
        Logger.error({
          message: "[Billing] Failed to record storage month",
          cause,
          locationId: slot.id,
          assetId: target.assetId,
          month: month.toISOString().slice(0, 7),
        });
      }
    }
  }

  Logger.info("[Billing] Monthly storage pass complete", {
    month: month.toISOString().slice(0, 7),
    emitted,
    errors,
    skippedUnoccupied,
    skippedNoRate,
  });

  return { emitted, errors, skippedUnoccupied, skippedNoRate };
}

/**
 * Runs the daily rental-use billing pass for one day. Finds every
 * Fieldkit-owned rentable asset that is on an active booking (status in
 * RESERVED / ONGOING / OVERDUE) overlapping the billing day, and emits
 * one RENTAL_USE BillableEvent per (booking, asset, day).
 *
 * The customer billed is the booking creator's linked customer. Bookings
 * whose creator has no linked customer (internal bookings) are skipped.
 *
 * Idempotency key: `("rental-use", bookingId, assetId, dayIso)` — running
 * twice on the same day or across overlapping cron triggers is safe.
 */
export async function runDailyRentalUseBilling(opts?: { day?: Date }) {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot bill rental usage.",
      label: "Billing",
    });
  }

  const day = utcDay(opts?.day);
  const dayStart = day;
  const dayEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);

  // Find every Fieldkit-owned rentable asset on a booking whose window
  // overlaps the billing day. Active = booking in RESERVED/ONGOING/OVERDUE.
  // Overlap test: booking.from <= dayEnd AND booking.to >= dayStart.
  const bookings = await db.booking.findMany({
    where: {
      organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
      status: { in: ["RESERVED", "ONGOING", "OVERDUE"] },
      from: { lte: dayEnd },
      to: { gte: dayStart },
      assets: {
        some: { customerId: null, rentable: true },
      },
    },
    select: {
      id: true,
      // The booking records who it is for. This used to read
      // `creator.fieldkitCustomerId`, which only resolves when the booking
      // came from the customer portal — so anything staff booked on a
      // customer's behalf billed nobody. `creator` is kept as a fallback for
      // portal bookings predating the column.
      customerId: true,
      creator: { select: { fieldkitCustomerId: true } },
      assets: {
        where: { customerId: null, rentable: true },
        select: { id: true },
      },
    },
  });

  let emitted = 0;
  let errors = 0;

  Logger.info("[Billing] Rental-use billing pass starting", {
    day: day.toISOString(),
    bookingCount: bookings.length,
  });

  for (const booking of bookings) {
    const customerId =
      booking.customerId ?? booking.creator?.fieldkitCustomerId ?? null;

    // Genuinely internal bookings have nobody to bill. A staff-created
    // booking for a customer that reaches here without a customerId is a
    // data gap, not an internal booking, so it is logged rather than
    // silently dropped — that silence is what hid the original bug.
    if (!customerId) {
      Logger.warn(
        "[Billing] Rentable assets on a booking with no customer; not billed",
        {
          bookingId: booking.id,
          assetCount: booking.assets.length,
          day: day.toISOString(),
        }
      );
      continue;
    }

    for (const asset of booking.assets) {
      try {
        const resolved = await resolveFlatRateCents({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          customerId,
          assetId: asset.id,
          kind: "RENTAL_USE",
        });
        if (!resolved) continue;
        await recordRentalUseDay({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          customerId,
          assetId: asset.id,
          bookingId: booking.id,
          day,
          amountCents: resolved.amountCents,
          currencyCode: resolved.currencyCode,
        });
        emitted += 1;
      } catch (cause) {
        errors += 1;
        Logger.error({
          message: "[Billing] Failed to record rental-use day",
          cause,
          bookingId: booking.id,
          assetId: asset.id,
          day: day.toISOString(),
        });
      }
    }
  }

  Logger.info("[Billing] Rental-use billing pass complete", {
    day: day.toISOString(),
    emitted,
    errors,
  });

  return { emitted, errors };
}
