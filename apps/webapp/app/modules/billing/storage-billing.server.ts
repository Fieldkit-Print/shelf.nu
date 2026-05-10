/**
 * Billing — daily storage cron.
 *
 * For each customer-owned asset currently stored at a Shelf location,
 * emit one STORAGE billable event per day. Idempotent — running twice on
 * the same day is a no-op.
 *
 * Pricing input: `carbon_remote.v1_warehouse_pricing` (FDW view). Until
 * Carbon ships the warehouse pricing table, the view returns no rows and
 * each emitted event has `amountCents = null` (Carbon resolves price at
 * invoice generation).
 *
 * @see {@link file://./events.server.ts}      Event-emit helpers
 * @see {@link file://./queue.server.ts}       pg-boss worker that calls this
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { recordStorageDay } from "./events.server";

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
      await recordStorageDay({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        carbonCustomerId: a.carbonCustomerId,
        assetId: a.id,
        carbonPartId: a.carbonPartId,
        locationId: a.locationId,
        day,
        // amountCents intentionally omitted — Carbon resolves at invoice
        // generation by looking up the warehouse pricing for the location.
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
