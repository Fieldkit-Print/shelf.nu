/**
 * Billing — module barrel.
 *
 * Public surface for the billing event ledger:
 *
 *   - Recording physical events: {@link recordBillableEvent} and per-kind
 *     wrappers (`recordStorageMonth`, `recordPick`, `recordReturn`,
 *     `recordRentalUseDay`, `recordRentalLoss`, `recordConsumableUse`).
 *   - Monthly storage pass: {@link runStorageBillingWithBackfill}.
 *   - Worker registration: {@link registerBillingWorker}.
 */

export type { BillingCronJob, RecordBillableEventArgs } from "./types";

export {
  recordBillableEvent,
  recordConsumableUse,
  recordPick,
  recordRentalLoss,
  recordRentalUseDay,
  recordReturn,
  recordStorageMonth,
} from "./events.server";

export {
  runMonthlyStorageBilling,
  runStorageBillingWithBackfill,
} from "./storage-billing.server";

export { registerBillingWorker } from "./queue.server";
