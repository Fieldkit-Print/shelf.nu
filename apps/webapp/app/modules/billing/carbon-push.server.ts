/**
 * Billing — Carbon push.
 *
 * Pushes a single PENDING/FAILED `BillableEvent` row to Carbon's billing
 * API and records the outcome. Carbon's endpoint doesn't exist yet — this
 * client speaks to the proposed contract in
 * {@link CarbonBillingLineItemPayload}. Until Carbon ships it, calls will
 * 404 and events will collect in FAILED state (retryable, no data loss).
 *
 * Once Carbon's endpoint lands, no Shelf-side change is needed beyond
 * setting CARBON_BILLING_ENDPOINT.
 *
 * @see {@link file://./types.ts}              Outbound shape
 * @see {@link file://./events.server.ts}      Event-emit helpers
 */

import type { BillableEvent } from "@prisma/client";

import { db } from "~/database/db.server";
import {
  CARBON_API_BASE_URL,
  CARBON_API_KEY,
  FIELDKIT_CARBON_COMPANY_ID,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import type { CarbonBillingLineItemPayload } from "./types";

/**
 * Endpoint path on Carbon. Implemented at
 * `Carbon/apps/erp/app/routes/api+/integrations.shelf.billable-events.ts`
 * and mirrors the auth + response-envelope shape of the Medusa-integration
 * endpoint.
 */
const BILLING_ENDPOINT = "/api/integrations/shelf/billable-events";

/**
 * Pushes one billable event. Updates the row with success / failure state.
 *
 * @returns true on PUSHED, false on FAILED (still retryable).
 */
export async function pushBillableEvent(eventId: string): Promise<boolean> {
  if (!CARBON_API_BASE_URL || !CARBON_API_KEY) {
    throw new ShelfError({
      cause: null,
      message:
        "Carbon API is not configured. Cannot push billing events without CARBON_API_BASE_URL + CARBON_API_KEY.",
      label: "Carbon Sync",
    });
  }
  if (!FIELDKIT_CARBON_COMPANY_ID) {
    throw new ShelfError({
      cause: null,
      message: "FIELDKIT_CARBON_COMPANY_ID is not set.",
      label: "Carbon Sync",
    });
  }

  const event = await db.billableEvent.findUniqueOrThrow({
    where: { id: eventId },
  });

  if (event.status === "PUSHED" || event.status === "IGNORED") {
    return event.status === "PUSHED";
  }

  const payload = toCarbonPayload(event, FIELDKIT_CARBON_COMPANY_ID);

  try {
    const res = await fetch(`${CARBON_API_BASE_URL}${BILLING_ENDPOINT}`, {
      method: "POST",
      headers: {
        "carbon-key": CARBON_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      await db.billableEvent.update({
        where: { id: event.id },
        data: {
          status: "FAILED",
          lastPushAttemptedAt: new Date(),
          lastPushError: `${res.status} ${res.statusText}: ${errBody.slice(
            0,
            500
          )}`,
        },
      });
      Logger.warn("[Billing] Carbon push failed", {
        eventId,
        status: res.status,
      });
      return false;
    }

    const body = (await res.json()) as {
      data?: { invoiceLineId?: string };
    };
    await db.billableEvent.update({
      where: { id: event.id },
      data: {
        status: "PUSHED",
        carbonInvoiceLineId: body?.data?.invoiceLineId ?? null,
        lastPushAttemptedAt: new Date(),
        lastPushError: null,
      },
    });
    return true;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    await db.billableEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        lastPushAttemptedAt: new Date(),
        lastPushError: msg.slice(0, 500),
      },
    });
    Logger.error({
      message: "[Billing] Carbon push threw",
      cause,
      eventId,
    });
    return false;
  }
}

/**
 * Drains PENDING + retry-eligible FAILED events in batches.
 *
 * @returns counters per outcome.
 */
export async function drainPendingBillableEvents(opts: {
  batchSize?: number;
}): Promise<{ pushed: number; failed: number; skipped: number }> {
  const batchSize = opts.batchSize ?? 50;
  const candidates = await db.billableEvent.findMany({
    where: { status: { in: ["PENDING", "FAILED"] } },
    orderBy: { occurredAt: "asc" },
    take: batchSize,
    select: { id: true },
  });

  let pushed = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      const ok = await pushBillableEvent(c.id);
      if (ok) pushed += 1;
      else failed += 1;
    } catch (cause) {
      failed += 1;
      Logger.error({
        message: "[Billing] drain: pushBillableEvent threw",
        cause,
        eventId: c.id,
      });
    }
  }

  return { pushed, failed, skipped: 0 };
}

function toCarbonPayload(
  event: BillableEvent,
  companyId: string
): CarbonBillingLineItemPayload {
  return {
    companyId,
    carbonCustomerId: event.carbonCustomerId,
    kind: event.kind,
    quantity: event.quantity,
    amountCents: event.amountCents,
    currencyCode: event.currencyCode,
    carbonPartId: event.carbonPartId,
    occurredAt: event.occurredAt.toISOString(),
    periodStart: event.periodStart ? event.periodStart.toISOString() : null,
    periodEnd: event.periodEnd ? event.periodEnd.toISOString() : null,
    idempotencyKey: event.idempotencyKey,
    notes: event.notes ?? undefined,
  };
}
