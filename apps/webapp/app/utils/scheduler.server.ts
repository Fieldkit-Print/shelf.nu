import PgBoss from "pg-boss";
import { DATABASE_URL, NODE_ENV } from "../utils/env";

export enum QueueNames {
  emailQueue = "email-queue",
  bookingQueue = "booking-queue",
  auditQueue = "audit-queue",
  assetsQueue = "assets-queue",
  addonTrialQueue = "addon-trial-queue",
  // Fieldkit Carbon ERP sync (customer + contact upserts, reconciliation cron).
  carbonSyncQueue = "carbon-sync-queue",
  // Fieldkit billing event push to Carbon (drains pending BillableEvent rows
  // and posts each to Carbon's billing API). See ~/modules/billing.
  billingPushQueue = "billing-push-queue",
}

let pgBossInstance!: PgBoss;

declare global {
  // Renamed from `scheduler` to avoid conflict with the built-in
  // Web Scheduling API type added in TypeScript 6 / ES2025.
  var pgBossScheduler: PgBoss;
}

export const init = async () => {
  if (!pgBossInstance) {
    const url = DATABASE_URL.split("?")[0];
    const commonAttributes = {
      connectionString: url,
      newJobCheckIntervalSeconds: 60 * 5,
      // pg-boss scheduling enabled for Fieldkit billing crons (storage
      // billing + Carbon push drain). Cost: ~2 extra DB polls per minute.
      // See ~/modules/billing/queue.server.ts for the schedule entries.
      noScheduling: false,
    };

    if (NODE_ENV === "production") {
      pgBossInstance = new PgBoss({
        max: 4,
        ...commonAttributes,
      });
    } else {
      if (!global.pgBossScheduler) {
        global.pgBossScheduler = new PgBoss({
          max: 1,
          ...commonAttributes,
        });
      }
      pgBossInstance = global.pgBossScheduler;
    }
    await pgBossInstance.start();
  }
  return;
};

export { pgBossInstance as scheduler };
