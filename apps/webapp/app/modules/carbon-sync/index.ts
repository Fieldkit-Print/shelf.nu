/**
 * Carbon Sync — module barrel (FDW edition).
 *
 * Public surface area for callers outside the carbon-sync module:
 *
 * - `dispatchCarbonEvent` / `verifyCarbonWebhookToken` — webhook entry points
 * - `upsertContactLink` / `removeContactLink` / `updateUserFromContact` —
 *   contact ↔ User provisioning (manual force-sync hooks)
 * - `upsertItemForShelf` / `archiveItemFromShelf` — CONSUMABLE Asset
 *   provisioning from Carbon item events
 * - `registerCarbonSyncWorker` — call once at server boot
 * - `reconcileAll` — programmatic full sync (contact links only)
 *
 * @see {@link file://./docs/CARBON_MIGRATION.sql} SQL to apply on Carbon
 */

export type {
  CarbonContact,
  CarbonCustomer,
  CarbonCustomerContact,
  CarbonItem,
  CarbonItemTrackingType,
  CarbonItemType,
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
  archiveItemFromShelf,
  removeContactLink,
  updateUserFromContact,
  upsertContactLink,
  upsertItemForShelf,
  upsertUserFromContact,
} from "./service.server";

export { reconcileAll } from "./reconciliation.server";

export { registerCarbonSyncWorker } from "./queue.server";

export { sendCustomerContactInvite } from "./invite.server";
