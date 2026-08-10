/**
 * Productive.io integration — module barrel.
 *
 * Productive is the system of record for customers and the destination for
 * billing. Two one-way flows, deliberately kept separate:
 *
 *   - **Inbound**: {@link syncCustomersFromProductive} mirrors companies into
 *     the local `Customer` table. Nothing in Shelf authors customers.
 *   - **Outbound**: {@link pushMonthlyChargesToProductive} rolls the
 *     `BillableEvent` ledger into budget services once a month. Invoicing
 *     itself stays in Productive.
 *
 * @see {@link file://./client.server.ts}
 * @see {@link file://./sync.server.ts}
 * @see {@link file://./push.server.ts}
 */

export type { ProductivePushResult, ProductiveSyncResult } from "./types";

export { isProductiveConfigured } from "./client.server";
export { syncCustomersFromProductive } from "./sync.server";
export {
  groupEventsForPush,
  pushMonthlyChargesToProductive,
  storageBudgetName,
} from "./push.server";
