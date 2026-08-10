/**
 * Productive — pg-boss worker registration + cron schedules.
 *
 * Two daily/monthly crons, each on its OWN queue. One queue per schedule is
 * required, not stylistic: pg-boss `schedule()` upserts by queue name, so
 * schedules sharing a queue silently clobber each other. See the same note in
 * `~/modules/billing/queue.server.ts`.
 *
 *   - `productive-sync-cron` — nightly at 02:30 UTC. Refreshes the `Customer`
 *     mirror ahead of the billing passes at 03:00, so a customer added in
 *     Productive today is billable tonight.
 *   - `productive-push-cron` — monthly on the 2nd at 05:00 UTC. Deliberately
 *     a day after the storage sweep (1st, 03:00) so the month it bills is
 *     fully swept before anything is sent.
 *
 * Both no-op when Productive credentials are absent, so a deploy without them
 * configured logs and moves on rather than failing nightly.
 *
 * @see {@link file://./sync.server.ts}
 * @see {@link file://./push.server.ts}
 */

import { Logger } from "~/utils/logger";
import { QueueNames, scheduler } from "~/utils/scheduler.server";

import { isProductiveConfigured } from "./client.server";
import { pushMonthlyChargesToProductive } from "./push.server";
import { syncCustomersFromProductive } from "./sync.server";

/** Job payloads handled by the Productive cron queues. */
export type ProductiveCronJob =
  | { kind: "sync-customers" }
  | { kind: "push-monthly-charges" };

/**
 * Registers the Productive cron workers and their schedules. Idempotent;
 * pg-boss tolerates re-subs and re-schedules. Called once at server boot.
 */
export async function registerProductiveWorker() {
  await scheduler.work<ProductiveCronJob>(
    QueueNames.productiveSyncQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  await scheduler.work<ProductiveCronJob>(
    QueueNames.productivePushQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  Logger.info("[Productive] Cron workers registered");

  // Nightly customer mirror refresh, before the billing passes at 03:00.
  await scheduler.schedule(
    QueueNames.productiveSyncQueue,
    "30 2 * * *",
    { kind: "sync-customers" } satisfies ProductiveCronJob,
    { tz: "UTC" }
  );
  Logger.info("[Productive] Nightly customer sync scheduled (02:30 UTC)");

  // Monthly charge push on the 2nd, a day after the storage sweep so the
  // month being billed is complete.
  await scheduler.schedule(
    QueueNames.productivePushQueue,
    "0 5 2 * *",
    { kind: "push-monthly-charges" } satisfies ProductiveCronJob,
    { tz: "UTC" }
  );
  Logger.info("[Productive] Monthly charge push scheduled (2nd, 05:00 UTC)");
}

async function runJob(job: ProductiveCronJob) {
  if (!isProductiveConfigured()) {
    Logger.warn(
      "[Productive] Skipping job — PRODUCTIVE_API_TOKEN / PRODUCTIVE_ORGANIZATION_ID not set",
      { kind: job.kind }
    );
    return;
  }

  switch (job.kind) {
    case "sync-customers": {
      const result = await syncCustomersFromProductive();
      Logger.info("[Productive] Customer sync cron complete", result);
      return;
    }
    case "push-monthly-charges": {
      const result = await pushMonthlyChargesToProductive();
      Logger.info("[Productive] Charge push cron complete", result);
      return;
    }
    default: {
      const _exhaustive: never = job;
      Logger.warn("[Productive] Unknown job kind", _exhaustive);
    }
  }
}
