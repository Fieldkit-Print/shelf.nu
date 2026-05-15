/**
 * Billing — daily storage cron.
 *
 * For each customer-owned asset currently stored at a Shelf location,
 * emit one STORAGE billable event per day. Idempotent — running twice on
 * the same day is a no-op (UNIQUE index on idempotencyKey).
 *
 * Pricing resolves via the Shelf-owned three-tier hierarchy (asset →
 * customer → org); see resolver.server.ts. The original design pulled
 * pricing from a Carbon FDW view that never landed.
 *
 * @see {@link file://./events.server.ts}                 Event-emit helpers
 * @see {@link file://./../pricing/resolver.server.ts}    Pricing hierarchy
 * @see {@link file://./queue.server.ts}                  pg-boss worker entry
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { recordRentalUseDay, recordStorageDay } from "./events.server";
import { resolveFlatRateCents } from "../pricing/resolver.server";

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
 * Runs the storage billing pass for one day. Emits one STORAGE
 * BillableEvent per customer-owned asset currently in storage.
 *
 * Storage pricing is intentionally null until Carbon ships the
 * `warehousePrice` table — see `CONTRACT_VIEWS_CARBON.sql`.
 */
export async function runDailyStorageBilling(opts?: { day?: Date }) {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot bill storage.",
      label: "Carbon Sync",
    });
  }

  const day = utcDay(opts?.day);

  // Find every Asset that's customer-owned (carbonCustomerId set). We
  // bill regardless of `status` — a customer's asset sitting in CHECKED_OUT
  // status still occupies a slot until it physically leaves the building,
  // which is captured by location state, not asset status.
  const assets = await db.asset.findMany({
    where: {
      organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
      carbonCustomerId: { not: null },
    },
    select: {
      id: true,
      carbonCustomerId: true,
      carbonPartId: true,
      locationId: true,
    },
  });

  let emitted = 0;
  let errors = 0;

  Logger.info("[Billing] Storage billing pass starting", {
    day: day.toISOString(),
    assetCount: assets.length,
  });

  for (const a of assets) {
    if (!a.carbonCustomerId) continue;
    try {
      // Resolve the storage rate at write time. The asset tier wins,
      // then customer, then org. Null = no rate at any tier → skip.
      const resolved = await resolveFlatRateCents({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        carbonCustomerId: a.carbonCustomerId,
        assetId: a.id,
        kind: "STORAGE",
      });
      if (!resolved) continue;
      await recordStorageDay({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        carbonCustomerId: a.carbonCustomerId,
        assetId: a.id,
        carbonPartId: a.carbonPartId,
        locationId: a.locationId,
        day,
        amountCents: resolved.amountCents,
        currencyCode: resolved.currencyCode,
      });
      emitted += 1;
    } catch (cause) {
      errors += 1;
      Logger.error({
        message: "[Billing] Failed to record storage day",
        cause,
        assetId: a.id,
        day: day.toISOString(),
      });
    }
  }

  Logger.info("[Billing] Storage billing pass complete", {
    day: day.toISOString(),
    emitted,
    errors,
  });

  return { emitted, errors };
}

/**
 * Runs the daily rental-use billing pass for one day. Finds every
 * Fieldkit-owned rentable asset that is on an active booking (status in
 * RESERVED / ONGOING / OVERDUE) overlapping the billing day, and emits
 * one RENTAL_USE BillableEvent per (booking, asset, day).
 *
 * The customer billed is the booking creator's carbonCustomerId. Bookings
 * whose creator has no carbonCustomerId (Fieldkit-internal bookings) are
 * skipped.
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
        some: { carbonCustomerId: null, rentable: true },
      },
    },
    select: {
      id: true,
      creator: { select: { carbonCustomerId: true } },
      assets: {
        where: { carbonCustomerId: null, rentable: true },
        select: { id: true, carbonPartId: true },
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
    const carbonCustomerId = booking.creator?.carbonCustomerId;
    // Internal Fieldkit bookings have no customer to bill — skip.
    if (!carbonCustomerId) continue;

    for (const asset of booking.assets) {
      try {
        const resolved = await resolveFlatRateCents({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          carbonCustomerId,
          assetId: asset.id,
          kind: "RENTAL_USE",
        });
        if (!resolved) continue;
        await recordRentalUseDay({
          organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
          carbonCustomerId,
          assetId: asset.id,
          carbonPartId: asset.carbonPartId,
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
