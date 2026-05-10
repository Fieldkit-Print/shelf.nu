/**
 * Billing — module barrel.
 *
 * Public surface for the billing event ledger:
 *
 *   - Recording physical events: {@link recordBillableEvent} and per-kind
 *     wrappers (`recordStorageDay`, `recordPick`, `recordReturn`,
 *     `recordRentalUseDay`, `recordRentalLoss`, `recordConsumableUse`).
 *   - Pushing events to Carbon: {@link pushBillableEvent} (one) and
 *     {@link drainPendingBillableEvents} (batch).
 *   - Daily storage pass: {@link runDailyStorageBilling}.
 *   - Worker registration: {@link registerBillingWorker}.
 */

export type {
  BillingPushJob,
  CarbonBillingLineItemPayload,
  RecordBillableEventArgs,
} from "./types";

export {
  recordBillableEvent,
  recordConsumableUse,
  recordPick,
  recordRentalLoss,
  recordRentalUseDay,
  recordReturn,
  recordStorageDay,
} from "./events.server";

export {
  drainPendingBillableEvents,
  pushBillableEvent,
} from "./carbon-push.server";

export { runDailyStorageBilling } from "./storage-billing.server";

export { registerBillingWorker } from "./queue.server";
