/**
 * Billing — pg-boss worker registration + cron schedules.
 *
 * Single worker on `billingPushQueue`. Three job kinds:
 *
 *   - `drain-pending` — drain PENDING + FAILED-retry events in batches.
 *     Scheduled every 15 min.
 *   - `push-one` — push a specific event id. Used for synchronous paths.
 *   - `run-storage-billing` — daily storage cron. Emits STORAGE
 *     BillableEvent rows for yesterday. Scheduled daily at 03:00 UTC.
 *
 * Concurrency is 1 — Carbon's billing API rate limits will bottleneck
 * before our DB; serial processing keeps idempotency reasoning simple.
 *
 * Scheduling uses pg-boss's built-in cron (`scheduler.schedule()`), which
 * inserts a job at the configured cron expression. Requires
 * `noScheduling: false` in scheduler init (see scheduler.server.ts).
 *
 * @see {@link file://./events.server.ts}        Event-emit helpers
 * @see {@link file://./carbon-push.server.ts}   Carbon push
 * @see {@link file://./storage-billing.server.ts} Storage cron entrypoint
 * @see {@link file://./../../entry.server.tsx}  Boot wiring
 */

import { Logger } from "~/utils/logger";
import { QueueNames, scheduler } from "~/utils/scheduler.server";

import {
  drainPendingBillableEvents,
  pushBillableEvent,
} from "./carbon-push.server";
import { runDailyStorageBilling } from "./storage-billing.server";
import type { BillingPushJob } from "./types";

/**
 * Registers the billing push worker AND the cron schedules. Idempotent;
 * pg-boss tolerates re-subs and re-schedules. Called once at server boot
 * from `app/entry.server.tsx`.
 */
export async function registerBillingWorker() {
  await scheduler.work<BillingPushJob>(
    QueueNames.billingPushQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  Logger.info("[Billing] Queue worker registered");

  // Cron schedules. pg-boss schedules are idempotent on `name` — calling
  // `schedule()` again replaces the existing cron entry.
  //
  // Storage billing runs daily at 03:00 UTC (after most calendar days
  // have closed). It bills for "yesterday" — see runDailyStorageBilling.
  await scheduler.schedule(
    QueueNames.billingPushQueue,
    "0 3 * * *",
    { kind: "run-storage-billing" } satisfies BillingPushJob,
    { tz: "UTC" }
  );
  Logger.info("[Billing] Daily storage cron scheduled (03:00 UTC)");

  // Push pending events every 15 minutes. Carbon's billing endpoint may
  // be down; failures stay in FAILED status and the next drain retries.
  await scheduler.schedule(
    QueueNames.billingPushQueue,
    "*/15 * * * *",
    { kind: "drain-pending" } satisfies BillingPushJob,
    { tz: "UTC" }
  );
  Logger.info("[Billing] Push-drain cron scheduled (every 15 min)");
}

async function runJob(job: BillingPushJob) {
  switch (job.kind) {
    case "drain-pending": {
      const result = await drainPendingBillableEvents({
        batchSize: job.batchSize,
      });
      Logger.info("[Billing] Drain pass complete", result);
      return;
    }
    case "push-one": {
      await pushBillableEvent(job.billableEventId);
      return;
    }
    case "run-storage-billing": {
      const result = await runDailyStorageBilling();
      Logger.info("[Billing] Storage cron complete", result);
      return;
    }
    default: {
      const _exhaustive: never = job;
      Logger.warn("[Billing] Unknown job kind", _exhaustive);
    }
  }
}
