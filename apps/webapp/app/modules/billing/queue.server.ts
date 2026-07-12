/**
 * Billing — pg-boss worker registration + cron schedules.
 *
 * Two daily cron jobs, each on its OWN queue:
 *
 *   - `billing-storage-cron` — daily storage pass at 03:00 UTC. Emits
 *     STORAGE BillableEvent rows for yesterday.
 *   - `billing-rental-cron` — daily rental-use pass at 03:15 UTC (offset
 *     from storage so the two passes don't contend on the same DB).
 *
 * One queue per cron is REQUIRED, not stylistic: pg-boss `schedule()`
 * upserts by queue name, so multiple `schedule()` calls on one queue
 * silently replace each other. The previous single-queue design meant
 * only the last-registered cron (the Carbon push drain) ever fired and
 * the storage/rental passes never ran.
 *
 * Scheduling uses pg-boss's built-in cron (`scheduler.schedule()`), which
 * requires `noScheduling: false` in scheduler init (see scheduler.server.ts).
 *
 * @see {@link file://./events.server.ts}          Event-emit helpers
 * @see {@link file://./storage-billing.server.ts} Cron entrypoints
 * @see {@link file://./../../entry.server.tsx}    Boot wiring
 */

import { Logger } from "~/utils/logger";
import { QueueNames, scheduler } from "~/utils/scheduler.server";

import {
  runDailyRentalUseBilling,
  runDailyStorageBilling,
} from "./storage-billing.server";
import type { BillingCronJob } from "./types";

/**
 * Queues removed by the Carbon extraction whose pg-boss schedule rows may
 * still exist in the database. Without cleanup, those crons keep inserting
 * jobs into queues that no longer have workers.
 */
const LEGACY_SCHEDULED_QUEUES = ["billing-push-queue", "carbon-sync-queue"];

/**
 * Registers the billing cron workers AND their schedules. Idempotent;
 * pg-boss tolerates re-subs and re-schedules. Called once at server boot
 * from `app/entry.server.tsx`.
 */
export async function registerBillingWorker() {
  await scheduler.work<BillingCronJob>(
    QueueNames.billingStorageCronQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  await scheduler.work<BillingCronJob>(
    QueueNames.billingRentalCronQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  Logger.info("[Billing] Cron workers registered");

  // Storage billing runs daily at 03:00 UTC (after most calendar days
  // have closed). It bills for "yesterday" — see runDailyStorageBilling.
  await scheduler.schedule(
    QueueNames.billingStorageCronQueue,
    "0 3 * * *",
    { kind: "run-storage-billing" } satisfies BillingCronJob,
    { tz: "UTC" }
  );
  Logger.info("[Billing] Daily storage cron scheduled (03:00 UTC)");

  // Rental-use billing runs daily at 03:15 UTC.
  await scheduler.schedule(
    QueueNames.billingRentalCronQueue,
    "15 3 * * *",
    { kind: "run-rental-use-billing" } satisfies BillingCronJob,
    { tz: "UTC" }
  );
  Logger.info("[Billing] Daily rental-use cron scheduled (03:15 UTC)");

  // Remove schedule rows left behind by queues that no longer exist.
  for (const legacyQueue of LEGACY_SCHEDULED_QUEUES) {
    try {
      await scheduler.unschedule(legacyQueue);
    } catch {
      // Nothing scheduled under that name — fine.
    }
  }
}

async function runJob(job: BillingCronJob) {
  switch (job.kind) {
    case "run-storage-billing": {
      const result = await runDailyStorageBilling();
      Logger.info("[Billing] Storage cron complete", result);
      return;
    }
    case "run-rental-use-billing": {
      const result = await runDailyRentalUseBilling();
      Logger.info("[Billing] Rental-use cron complete", result);
      return;
    }
    default: {
      const _exhaustive: never = job;
      Logger.warn("[Billing] Unknown job kind", _exhaustive);
    }
  }
}
