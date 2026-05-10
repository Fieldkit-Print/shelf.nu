/**
 * Carbon Webhook Handler (FDW edition)
 *
 * Receives Carbon ERP webhook deliveries (relayed by Carbon's
 * `supabase/functions/webhook` Edge Function) and dispatches them to the
 * appropriate provisioning function. Carbon does not authenticate outbound
 * webhooks, so we use:
 *
 *   1. **Query-string token**: the URL registered in Carbon's webhook UI
 *      includes `?token=<CARBON_WEBHOOK_SECRET>`. Compared timing-safely.
 *   2. **Company filter**: every Carbon payload carries `companyId`. We
 *      reject anything not from `FIELDKIT_CARBON_COMPANY_ID`.
 *
 * Carbon's payload shape after the Edge Function relay:
 *
 *   {
 *     "type": "INSERT" | "UPDATE" | "DELETE",
 *     "record": { ...new row... },
 *     "old":    { ...prior row... },        // UPDATE/DELETE only
 *     "companyId": "cmp_...",
 *     "table": "customer" | "customerContact" | "contact" | "item"
 *   }
 *
 * Tables and what we do with them:
 *   - `customer`         → ack-only (Shelf reads via FDW, no mirror).
 *   - `customerContact`  → INSERT/UPDATE provision User; DELETE unlink.
 *   - `contact`          → UPDATE refreshes User email/name; INSERT/DELETE ignored.
 *   - `item`             → INSERT/UPDATE provision/archive CONSUMABLE Asset
 *                          when `visibleInShelf` qualifies; DELETE archive.
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
  archiveItemFromShelf,
  removeContactLink,
  updateUserFromContact,
  upsertContactLink,
  upsertItemForShelf,
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
 * Dispatches a verified Carbon webhook payload to the correct provisioning
 * function. Caller is responsible for verifying the token + company first.
 *
 * @returns A short string suitable for telemetry / debugging.
 */
export async function dispatchCarbonEvent(
  payload: CarbonWebhookPayload
): Promise<string> {
  switch (payload.table) {
    case "customer":
      // FDW edition: Shelf doesn't mirror customer master. Ack only.
      return `customer ${
        payload.record.id
      } ${payload.type.toLowerCase()} (ack-only, no mirror)`;
    case "customerContact":
      return dispatchCustomerContact(payload);
    case "contact":
      return dispatchContact(payload);
    case "item":
      return dispatchItem(payload);
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

async function dispatchCustomerContact(
  payload: Extract<CarbonWebhookPayload, { table: "customerContact" }>
): Promise<string> {
  switch (payload.type) {
    case "INSERT":
    case "UPDATE":
      await upsertContactLink(payload.record);
      return `customerContact link upserted (customer=${payload.record.customerId} contact=${payload.record.contactId})`;
    case "DELETE":
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
      // meaningful to Shelf — provisioning happens via customerContact.
      return `contact ${payload.type} ignored (handled via customerContact)`;
    default: {
      const _exhaustive: never = payload.type;
      return `ignored unknown contact event type ${_exhaustive as string}`;
    }
  }
}

async function dispatchItem(
  payload: Extract<CarbonWebhookPayload, { table: "item" }>
): Promise<string> {
  switch (payload.type) {
    case "INSERT":
    case "UPDATE": {
      const id = await upsertItemForShelf(payload.record);
      return id
        ? `item ${payload.record.id} provisioned/refreshed as Shelf asset ${id}`
        : `item ${payload.record.id} not visible in Shelf (archived if existed)`;
    }
    case "DELETE":
      await archiveItemFromShelf(payload.record.id);
      return `item ${payload.record.id} archived in Shelf`;
    default: {
      const _exhaustive: never = payload.type;
      return `ignored unknown item event type ${_exhaustive as string}`;
    }
  }
}
