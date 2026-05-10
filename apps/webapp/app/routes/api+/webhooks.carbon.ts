/**
 * Carbon ERP Webhook Endpoint
 *
 * POST /api/webhooks/carbon?token=<CARBON_WEBHOOK_SECRET>
 *
 * Receives Carbon ERP webhook deliveries (relayed by Carbon's
 * `supabase/functions/webhook` Edge Function). Subscribed in Carbon UI:
 *
 *   - `customer`         → INSERT, UPDATE, DELETE
 *   - `customerContact`  → INSERT, UPDATE, DELETE
 *   - `contact`          → UPDATE  (INSERT / DELETE are no-ops here)
 *
 * Auth is via the query-string `?token=` (Carbon doesn't send any auth
 * header) compared timing-safely to `CARBON_WEBHOOK_SECRET`. Payloads are
 * additionally filtered by `companyId === FIELDKIT_CARBON_COMPANY_ID`.
 *
 * Status codes:
 *   - 200 on success or company-mismatch (so Carbon doesn't retry).
 *   - 400 on malformed JSON.
 *   - 401 on bad token.
 *   - 500 on dispatch failure (Carbon will retry).
 *
 * @see {@link file://./../../modules/carbon-sync/webhook.server.ts}
 * @see {@link file://./../../modules/carbon-sync/types.ts}
 */

import type { ActionFunctionArgs } from "react-router";

import type { CarbonWebhookPayload } from "~/modules/carbon-sync/types";
import {
  dispatchCarbonEvent,
  payloadMatchesCompany,
  verifyCarbonWebhookToken,
} from "~/modules/carbon-sync/webhook.server";
import { makeShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  try {
    verifyCarbonWebhookToken(request.url);
  } catch (cause) {
    const reason = makeShelfError(cause);
    return new Response(null, { status: reason.status });
  }

  let payload: CarbonWebhookPayload;
  try {
    payload = (await request.json()) as CarbonWebhookPayload;
  } catch {
    Logger.warn("[Carbon Sync] Webhook body was not valid JSON");
    return new Response(null, { status: 400 });
  }

  // Reject (with 200) anything from a different Carbon tenant.
  if (!payloadMatchesCompany(payload)) {
    return new Response(null, { status: 200 });
  }

  try {
    const summary = await dispatchCarbonEvent(payload);
    Logger.info("[Carbon Sync] Webhook dispatched", { summary });
    return new Response(null, { status: 200 });
  } catch (cause) {
    const reason = makeShelfError(cause);
    Logger.error({
      message: "[Carbon Sync] Webhook dispatch failed",
      cause: reason,
      payload,
    });
    return new Response(null, { status: reason.status });
  }
}
