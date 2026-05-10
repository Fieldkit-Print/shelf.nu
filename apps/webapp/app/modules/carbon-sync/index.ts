/**
 * Carbon Sync — module barrel.
 *
 * Public surface area for callers outside the carbon-sync module:
 *
 * - `dispatchCarbonEvent` / `verifyCarbonWebhookToken` — webhook entry points
 * - `upsertCustomerFromCarbon` / `upsertContactLink` / `updateUserFromContact`
 *   — manual upserts (e.g., from the internal admin "force resync" button)
 * - `registerCarbonSyncWorker` — call once at server boot
 * - `reconcileAll` — programmatic full sync
 *
 * @see {@link file://./docs/CARBON_MIGRATION.sql} SQL to apply on Carbon
 */

export type {
  CarbonContact,
  CarbonCustomer,
  CarbonCustomerContact,
  CarbonSyncJob,
  CarbonWebhookPayload,
} from "./types";

export {
  dispatchCarbonEvent,
  payloadMatchesCompany,
  verifyCarbonWebhookToken,
  CARBON_WEBHOOK_TOKEN_PARAM,
} from "./webhook.server";

export {
  archiveCustomerFromCarbon,
  removeContactLink,
  updateUserFromContact,
  upsertContactLink,
  upsertCustomerFromCarbon,
  upsertUserFromContact,
} from "./service.server";

export { reconcileAll } from "./reconciliation.server";

export { registerCarbonSyncWorker } from "./queue.server";

export { sendCustomerContactInvite } from "./invite.server";
