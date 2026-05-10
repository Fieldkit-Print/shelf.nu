/**
 * Carbon Sync — pg-boss queue worker registration.
 *
 * Subscribes a single worker to {@link QueueNames.carbonSyncQueue} that
 * dispatches each {@link CarbonSyncJob} to the right service function.
 *
 * Concurrency is set to 1 because the upsert flow does multi-row writes
 * per record and Carbon's API rate limits will bottleneck before our DB
 * does — fanning out has no benefit.
 *
 * @see {@link file://./service.server.ts}        Customer / contact upserts
 * @see {@link file://./reconciliation.server.ts} reconcileAll cron
 * @see {@link file://./../../entry.server.tsx}   Boot wiring
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { QueueNames, scheduler } from "~/utils/scheduler.server";

import { fetchContactInCustomer, fetchCustomerById } from "./client.server";
import { reconcileAll } from "./reconciliation.server";
import {
  upsertCustomerFromCarbonLite,
  upsertUserFromContact,
} from "./service.server";
import type { CarbonSyncJob } from "./types";

/**
 * Registers the Carbon sync worker. Idempotent — pg-boss tolerates re-subs.
 * Called once at server boot from `app/entry.server.tsx` after `init()`.
 */
export async function registerCarbonSyncWorker() {
  await scheduler.work<CarbonSyncJob>(
    QueueNames.carbonSyncQueue,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      await runJob(job.data);
    }
  );
  Logger.info("[Carbon Sync] Queue worker registered");
}

async function runJob(job: CarbonSyncJob) {
  switch (job.kind) {
    case "reconcile-all":
      await reconcileAll(job);
      return;

    case "upsert-customer": {
      const carbon = await fetchCustomerById(job.carbonCustomerId);
      if (!carbon) {
        throw new ShelfError({
          cause: null,
          message: `Carbon customer ${job.carbonCustomerId} not found during sync`,
          additionalData: { carbonCustomerId: job.carbonCustomerId },
          label: "Carbon Sync",
        });
      }
      await upsertCustomerFromCarbonLite({
        carbonCustomerId: carbon.id,
        displayName: carbon.name,
      });
      return;
    }

    case "upsert-contact": {
      if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
        throw new ShelfError({
          cause: null,
          message: "FIELDKIT_PRIMARY_ORGANIZATION_ID not set",
          label: "Carbon Sync",
        });
      }
      // We need the parent customer to call Carbon's contact endpoint. If a
      // shelf User already exists with this carbonContactId we can recover
      // the link; otherwise we have nothing to scope by and skip — webhook
      // junction events are the canonical provisioning trigger.
      const user = await db.user.findUnique({
        where: { carbonContactId: job.carbonContactId },
        select: {
          fieldkitCustomerId: true,
          fieldkitCustomer: { select: { carbonCustomerId: true } },
        },
      });
      if (!user?.fieldkitCustomerId || !user.fieldkitCustomer) {
        Logger.warn(
          "[Carbon Sync] upsert-contact: no shelf user yet; skipping",
          { carbonContactId: job.carbonContactId }
        );
        return;
      }
      const carbon = await fetchContactInCustomer({
        carbonCustomerId: user.fieldkitCustomer.carbonCustomerId,
        carbonContactId: job.carbonContactId,
      });
      if (!carbon) {
        throw new ShelfError({
          cause: null,
          message: `Carbon contact ${job.carbonContactId} not found during sync`,
          additionalData: { carbonContactId: job.carbonContactId },
          label: "Carbon Sync",
        });
      }
      await upsertUserFromContact({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        customerId: user.fieldkitCustomerId,
        carbonContact: carbon,
      });
      return;
    }

    default: {
      const _exhaustive: never = job;
      Logger.warn("[Carbon Sync] Unknown job kind", _exhaustive);
    }
  }
}
