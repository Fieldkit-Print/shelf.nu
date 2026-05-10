/**
 * Billing — pg-boss worker registration.
 *
 * Single worker on `billingPushQueue`. Two job kinds:
 *
 *   - `drain-pending` — drain PENDING + FAILED-retry events in batches.
 *     Enqueued by a cron schedule (every ~15 min) and after storage cron.
 *   - `push-one` — push a specific event id. Used for synchronous paths
 *     where we want to know the outcome immediately.
 *
 * Concurrency is 1 — Carbon's billing API rate limits will bottleneck
 * before our DB; serial processing keeps idempotency reasoning simple.
 *
 * @see {@link file://./events.server.ts}        Event-emit helpers
 * @see {@link file://./carbon-push.server.ts}   Carbon push
 * @see {@link file://./../../entry.server.tsx}  Boot wiring
 */

import { Logger } from "~/utils/logger";
import { QueueNames, scheduler } from "~/utils/scheduler.server";

import {
  drainPendingBillableEvents,
  pushBillableEvent,
} from "./carbon-push.server";
import type { BillingPushJob } from "./types";

/**
 * Registers the billing push worker. Idempotent; pg-boss tolerates re-subs.
 * Called once at server boot from `app/entry.server.tsx`.
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
    default: {
      const _exhaustive: never = job;
      Logger.warn("[Billing] Unknown job kind", _exhaustive);
    }
  }
}
