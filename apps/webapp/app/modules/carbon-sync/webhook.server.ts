/**
 * Carbon Webhook Handler
 *
 * Receives Carbon ERP webhook deliveries (relayed by Carbon's
 * `supabase/functions/webhook` Edge Function) and dispatches them to the
 * appropriate upsert/archive/link function. Carbon does not authenticate
 * outbound webhooks, so we use:
 *
 *   1. **Query-string token**: the URL registered in Carbon's webhook UI
 *      includes `?token=<CARBON_WEBHOOK_SECRET>`. Compared timing-safely.
 *   2. **Company filter**: every Carbon payload carries `companyId`. We
 *      reject anything not from `FIELDKIT_CARBON_COMPANY_ID` so a misrouted
 *      webhook from another Carbon tenant can't touch our data.
 *
 * Carbon's payload shape (after the Edge Function relay):
 *
 *   {
 *     "type": "INSERT" | "UPDATE" | "DELETE",
 *     "record": { ...new row... },
 *     "old":    { ...prior row... },   // only on UPDATE/DELETE
 *     "companyId": "cmp_...",
 *     "table": "customer" | "customerContact" | "contact"
 *   }
 *
 * @see {@link file://./types.ts}            CarbonWebhookPayload shape
 * @see {@link file://./service.server.ts}   Upsert dispatch
 * @see {@link file://./../../routes/api+/webhooks.carbon.ts} Route entry point
 */

import { timingSafeEqual } from "node:crypto";

import { CARBON_WEBHOOK_SECRET, FIELDKIT_CARBON_COMPANY_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import {
  archiveCustomerFromCarbon,
  removeContactLink,
  updateUserFromContact,
  upsertContactLink,
  upsertCustomerFromCarbon,
} from "./service.server";
import type { CarbonWebhookPayload } from "./types";

/** Query-string param name carrying the shared secret. */
export const CARBON_WEBHOOK_TOKEN_PARAM = "token";

/**
 * Verifies the `?token=` query-string param against `CARBON_WEBHOOK_SECRET`.
 *
 * @throws {ShelfError} 401 on mismatch / 500 on missing config
 */
export function verifyCarbonWebhookToken(requestUrl: string): void {
  if (!CARBON_WEBHOOK_SECRET) {
    throw new ShelfError({
      cause: null,
      message: "CARBON_WEBHOOK_SECRET is not configured",
      label: "Carbon Sync",
      status: 500,
    });
  }
  const url = new URL(requestUrl);
  const provided = url.searchParams.get(CARBON_WEBHOOK_TOKEN_PARAM) ?? "";
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(CARBON_WEBHOOK_SECRET, "utf8");

  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new ShelfError({
      cause: null,
      message: "Invalid Carbon webhook token",
      label: "Carbon Sync",
      status: 401,
      shouldBeCaptured: true,
    });
  }
}

/**
 * Returns true if the payload should be processed (matches Fieldkit's
 * Carbon company). Logs and returns false otherwise so callers can ack
 * with 200 rather than retry.
 */
export function payloadMatchesCompany(payload: { companyId: string }): boolean {
  if (!FIELDKIT_CARBON_COMPANY_ID) {
    throw new ShelfError({
      cause: null,
      message: "FIELDKIT_CARBON_COMPANY_ID is not configured",
      label: "Carbon Sync",
      status: 500,
    });
  }
  if (payload.companyId !== FIELDKIT_CARBON_COMPANY_ID) {
    Logger.warn("[Carbon Sync] Ignoring webhook for non-Fieldkit company", {
      incomingCompanyId: payload.companyId,
    });
    return false;
  }
  return true;
}

/**
 * Dispatches a verified Carbon webhook payload to the correct upsert /
 * archive / link function. Caller is responsible for verifying the token
 * and the company filter first.
 *
 * @returns A short string suitable for telemetry / debugging.
 */
export async function dispatchCarbonEvent(
  payload: CarbonWebhookPayload
): Promise<string> {
  switch (payload.table) {
    case "customer":
      return dispatchCustomer(payload);
    case "customerContact":
      return dispatchCustomerContact(payload);
    case "contact":
      return dispatchContact(payload);
    default: {
      const _exhaustive: never = payload;
      Logger.warn(
        "[Carbon Sync] Unknown table in webhook payload",
        _exhaustive
      );
      return "ignored unknown table";
    }
  }
}

async function dispatchCustomer(
  payload: Extract<CarbonWebhookPayload, { table: "customer" }>
): Promise<string> {
  switch (payload.type) {
    case "INSERT":
    case "UPDATE":
      await upsertCustomerFromCarbon(payload.record);
      return `customer ${payload.record.id} upserted (${payload.type})`;
    case "DELETE":
      await archiveCustomerFromCarbon(payload.record.id);
      return `customer ${payload.record.id} archived`;
    default: {
      const _exhaustive: never = payload.type;
      return `ignored unknown customer event type ${_exhaustive as string}`;
    }
  }
}

async function dispatchCustomerContact(
  payload: Extract<CarbonWebhookPayload, { table: "customerContact" }>
): Promise<string> {
  switch (payload.type) {
    case "INSERT":
    case "UPDATE":
      await upsertContactLink(payload.record);
      return `customerContact link upserted (customer=${payload.record.customerId} contact=${payload.record.contactId})`;
    case "DELETE":
      // For DELETE, Carbon's relay keeps `record` set to the deleted row
      // (per the trigger function in 20250203121216_webhooks.sql:289+).
      await removeContactLink(payload.record);
      return `customerContact link removed (customer=${payload.record.customerId} contact=${payload.record.contactId})`;
    default: {
      const _exhaustive: never = payload.type;
      return `ignored unknown customerContact event type ${
        _exhaustive as string
      }`;
    }
  }
}

async function dispatchContact(
  payload: Extract<CarbonWebhookPayload, { table: "contact" }>
): Promise<string> {
  switch (payload.type) {
    case "UPDATE":
      await updateUserFromContact(payload.record);
      return `contact ${payload.record.id} updated`;
    case "INSERT":
    case "DELETE":
      // Standalone contacts (without a customerContact junction row) aren't
      // meaningful to shelf — provisioning happens on customerContact INSERT
      // and unlinking on customerContact DELETE. Ack and move on.
      return `contact ${payload.type} ignored (handled via customerContact)`;
    default: {
      const _exhaustive: never = payload.type;
      return `ignored unknown contact event type ${_exhaustive as string}`;
    }
  }
}
