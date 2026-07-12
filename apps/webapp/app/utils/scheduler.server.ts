import PgBoss from "pg-boss";
import { DATABASE_URL, NODE_ENV } from "../utils/env";
import { ShelfError } from "../utils/error";
import { Logger } from "../utils/logger";

export enum QueueNames {
  emailQueue = "email-queue",
  bookingQueue = "booking-queue",
  auditQueue = "audit-queue",
  assetsQueue = "assets-queue",
  addonTrialQueue = "addon-trial-queue",
  // Fieldkit billing crons. One queue PER cron — pg-boss `schedule()`
  // upserts by queue name, so schedules sharing a queue clobber each
  // other. See ~/modules/billing/queue.server.ts.
  billingStorageCronQueue = "billing-storage-cron",
  billingRentalCronQueue = "billing-rental-cron",
}

let pgBossInstance!: PgBoss;

/**
 * Constructs a PgBoss instance with the mandatory `error` listener attached.
 *
 * pg-boss extends EventEmitter and re-emits errors from its internal pg
 * connection pool — e.g. the Supabase transaction pooler recycling an idle
 * connection ("Connection terminated unexpectedly"). An EventEmitter `error`
 * event with no listener is fatal in Node and crashes the whole server
 * (this took the production deploy down on 2026-07-10). pg-boss replaces
 * dead pool connections on its own, so the correct handling is to log the
 * error and keep the process alive.
 */
function createPgBoss(options: PgBoss.ConstructorOptions): PgBoss {
  const boss = new PgBoss(options);
  boss.on("error", (cause) => {
    Logger.error(
      new ShelfError({
        cause,
        message:
          "pg-boss connection error. The job queue pool lost a connection; pg-boss will reconnect on its own.",
        label: "Scheduler",
      })
    );
  });
  return boss;
}

declare global {
  // Renamed from `scheduler` to avoid conflict with the built-in
  // Web Scheduling API type added in TypeScript 6 / ES2025.
  var pgBossScheduler: PgBoss;
}

/**
 * Prepares DATABASE_URL for pg-boss / node-postgres consumption.
 *
 * The env URL is written for Prisma and may carry Prisma-only params
 * (`pgbouncer`, `connection_limit`, `pool_timeout`, `schema`) that pg
 * doesn't understand. The previous approach — `DATABASE_URL.split("?")[0]`
 * — threw away the ENTIRE query string, silently dropping params pg DOES
 * honor (most importantly `sslmode`; the 2026-07-10 crash log showed
 * pg-boss connecting with `ssl: false`). Strip only the Prisma-specific
 * params and keep the rest.
 */
function pgBossConnectionString(databaseUrl: string): string {
  const [base, query] = databaseUrl.split("?");
  if (!query) return base;
  const prismaOnlyParams = new Set([
    "pgbouncer",
    "connection_limit",
    "pool_timeout",
    "schema",
  ]);
  const kept = query
    .split("&")
    .filter((pair) => pair && !prismaOnlyParams.has(pair.split("=")[0]));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

export const init = async () => {
  if (!pgBossInstance) {
    const url = pgBossConnectionString(DATABASE_URL);
    const commonAttributes = {
      connectionString: url,
      newJobCheckIntervalSeconds: 60 * 5,
      // pg-boss scheduling enabled for Fieldkit billing crons (storage
      // billing crons). Cost: ~2 extra DB polls per minute.
      // See ~/modules/billing/queue.server.ts for the schedule entries.
      noScheduling: false,
    };

    if (NODE_ENV === "production") {
      pgBossInstance = createPgBoss({
        max: 4,
        ...commonAttributes,
      });
    } else {
      if (!global.pgBossScheduler) {
        global.pgBossScheduler = createPgBoss({
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
