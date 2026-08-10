/**
 * Billing — pg-boss worker registration + cron schedules.
 *
 * Two cron jobs, each on its OWN queue:
 *
 *   - `billing-storage-cron` — monthly, on the 1st at 03:00 UTC. Storage is
 *     sold per pallet position per month, so this emits one STORAGE event per
 *     occupied position and backfills any month the cron missed.
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
  runStorageBillingWithBackfill,
} from "./storage-billing.server";
import type { BillingCronJob } from "./types";

/**
 * Queues removed by the Carbon extraction whose pg-boss schedule rows may
 * still exist in the database. Without cleanup, those crons keep inserting
 * jobs into queues that no longer have workers.
 */
const LEGACY_SCHEDULED_QUEUES = ["billing-push-queue", "carbon-sync-queue"];

/**
 * Retry policy for the billing crons.
 *
 * pg-boss defaults `retryLimit` to 0, so a transient failure — a pooler blip,
 * a Productive timeout — dropped the run entirely. Combined with cron never
 * replaying a missed window, that silently lost a whole billing period with
 * only a log line to show for it.
 *
 * Retries are safe because every emitter is keyed on a deterministic
 * idempotency key: a partially-completed pass resumes rather than
 * double-charging. Backoff spaces attempts out so a database still recovering
 * isn't hammered.
 */
const CRON_RETRY = {
  retryLimit: 3,
  retryDelay: 300, // seconds
  retryBackoff: true,
} as const;

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

  // Storage is sold per pallet position per month, so the pass runs once a
  // month rather than nightly. Firing on the 1st at 03:00 UTC bills the month
  // that is beginning: a position occupied on the 1st is charged for the whole
  // month, matching the rate card, which carries no daily rate.
  //
  // Re-running is safe (keyed on location + month), so a manual invocation to
  // pick up a position added later in the month only adds the missing rows.
  await scheduler.schedule(
    QueueNames.billingStorageCronQueue,
    "0 3 1 * *",
    { kind: "run-storage-billing" } satisfies BillingCronJob,
    { tz: "UTC", ...CRON_RETRY }
  );
  Logger.info("[Billing] Monthly storage cron scheduled (1st, 03:00 UTC)");

  // Rental-use billing runs daily at 03:15 UTC.
  await scheduler.schedule(
    QueueNames.billingRentalCronQueue,
    "15 3 * * *",
    { kind: "run-rental-use-billing" } satisfies BillingCronJob,
    { tz: "UTC", ...CRON_RETRY }
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
      // Backfill-aware: sweeps any month the cron missed, then the current
      // one. A skipped window is otherwise unrecoverable without hand-written
      // SQL.
      const result = await runStorageBillingWithBackfill();
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
