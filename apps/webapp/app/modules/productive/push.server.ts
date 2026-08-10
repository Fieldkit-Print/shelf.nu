/**
 * Shelf → Productive monthly charge push.
 *
 * Turns the `BillableEvent` ledger into billable lines on each customer's
 * storage budget. This is the consumer the ledger has never had: before this,
 * events accumulated in `PENDING` forever and no invoice was ever produced.
 *
 * Shape of a run:
 *
 *   1. Collect `PENDING` events for the billing month.
 *   2. Roll them up by (customer, kind, unit rate) — one Productive line per
 *      group, not per event. Grouping by rate as well as kind keeps
 *      `quantity × price` exact when a customer has positions at different
 *      tiers.
 *   3. Resolve (or create) that customer's budget for the year.
 *   4. Create the service, or update it in place if the month was pushed
 *      before.
 *   5. Stamp `productiveServiceId` and `status = PUSHED` onto the events.
 *
 * Step 5 is the double-bill guard: events carrying a service id are excluded
 * from step 1, so a re-run after a partial failure resumes rather than
 * charging twice.
 *
 * Charges land as **services**, not expenses. In this Productive organization
 * expenses are money actually spent with a vendor and carry a markup; storage
 * revenue has no cost behind it, and booking it as an expense would corrupt
 * cost and margin reporting.
 *
 * @see {@link file://./client.server.ts} REST client
 * @see {@link file://./sync.server.ts}   The other direction
 */

import type { BillableEventKind } from "@prisma/client";

import { db } from "~/database/db.server";
import { centsToDollars } from "~/modules/pricing/format";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import {
  createBudget,
  createBudgetService,
  findBudgetByName,
  listBudgetServices,
  updateBudgetService,
} from "./client.server";
import { DEFAULT_SERVICE_TYPE_IDS, type ProductivePushResult } from "./types";

const label = "Productive" as const;

/** Human labels used in Productive service names and invoice lines. */
const KIND_LABEL: Record<BillableEventKind, string> = {
  STORAGE: "Storage",
  PICK: "Outbound pull, prep and pack",
  RETURN: "Receiving and restock",
  RENTAL_USE: "Rental",
  RENTAL_LOSS: "Rental replacement",
  CONSUMABLE_USE: "Consumables",
};

/** Returns UTC midnight on the first of the month containing `date`. */
function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** `2026-08-01` → `August 2026`. */
function monthLabel(month: Date): string {
  return month.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Budget name for a customer-year, e.g. `Hoka — Storage 2026`.
 *
 * Derived rather than stored: a recurring budget would mint a new id every
 * period, so caching one on `Customer` would go stale each January. Deriving
 * it means the push finds the right book on its own and creates it the first
 * time a customer is billed in a new year.
 */
export function storageBudgetName(companyName: string, year: number): string {
  return `${companyName} — Storage ${year}`;
}

/** One rolled-up charge line destined for Productive. */
type ChargeGroup = {
  customerId: string;
  kind: BillableEventKind;
  /** Unit price in cents. Part of the grouping key. */
  amountCents: number;
  currencyCode: string | null;
  /** Total units — pallet-months, picks, rental-days. */
  quantity: number;
  eventIds: string[];
};

/**
 * Rolls a month's pending events into one group per (customer, kind, rate).
 *
 * Events with no resolved amount are excluded: a null `amountCents` means no
 * rate was configured when the event was written, and inventing a price at
 * push time would bill a number nobody agreed to. They stay `PENDING` and
 * surface in the result's `errors` count instead.
 */
export function groupEventsForPush(
  events: Array<{
    id: string;
    customerId: string;
    kind: BillableEventKind;
    amountCents: number | null;
    currencyCode: string | null;
    quantity: number;
  }>
): { groups: ChargeGroup[]; unpriced: number } {
  const byKey = new Map<string, ChargeGroup>();
  let unpriced = 0;

  for (const event of events) {
    if (event.amountCents === null) {
      unpriced += 1;
      continue;
    }

    const key = `${event.customerId}|${event.kind}|${event.amountCents}`;
    const existing = byKey.get(key);

    if (existing) {
      existing.quantity += event.quantity;
      existing.eventIds.push(event.id);
      continue;
    }

    byKey.set(key, {
      customerId: event.customerId,
      kind: event.kind,
      amountCents: event.amountCents,
      currencyCode: event.currencyCode,
      quantity: event.quantity,
      eventIds: [event.id],
    });
  }

  return { groups: Array.from(byKey.values()), unpriced };
}

/**
 * Names the Productive service for a charge group.
 *
 * The unit price is appended only when a customer has more than one rate for
 * the same kind in the month — two positions at different pallet tiers, say.
 * Without it those groups would collide on name and the second would
 * overwrite the first.
 */
function serviceNameFor(
  group: ChargeGroup,
  month: Date,
  rateCountForKind: number
): string {
  const base = `${KIND_LABEL[group.kind]} — ${monthLabel(month)}`;
  return rateCountForKind > 1
    ? `${base} @ $${centsToDollars(group.amountCents)}`
    : base;
}

/**
 * Pushes one month of pending charges to Productive.
 *
 * @param opts.month - Any date inside the month to bill. Defaults to the
 *   previous month, so a run on the 1st bills the month that just closed.
 * @param opts.dryRun - Compute and log the groups without writing anything
 *   to Productive or mutating the ledger. Use for the first few cycles.
 * @throws {ShelfError} When the primary organization is unset.
 */
export async function pushMonthlyChargesToProductive(opts?: {
  month?: Date;
  dryRun?: boolean;
}): Promise<ProductivePushResult> {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot push charges.",
      label,
    });
  }
  const organizationId = FIELDKIT_PRIMARY_ORGANIZATION_ID;

  // Default to last month: the cron runs on the 1st, by which point the month
  // just ended is complete and every storage position has been swept.
  const reference =
    opts?.month ??
    new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)
    );
  const month = utcMonthStart(reference);
  const monthEnd = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 1
  );
  const monthIso = month.toISOString().slice(0, 7);

  const result: ProductivePushResult = {
    month: monthIso,
    groups: 0,
    servicesCreated: 0,
    servicesReused: 0,
    eventsPushed: 0,
    skippedUnlinked: 0,
    errors: 0,
  };

  // Events already carrying a service id were pushed on an earlier run —
  // excluding them is what makes a retry safe.
  const events = await db.billableEvent.findMany({
    where: {
      organizationId,
      status: "PENDING",
      productiveServiceId: null,
      occurredAt: { gte: month, lte: monthEnd },
    },
    select: {
      id: true,
      customerId: true,
      kind: true,
      amountCents: true,
      currencyCode: true,
      quantity: true,
    },
  });

  const { groups, unpriced } = groupEventsForPush(events);
  result.groups = groups.length;
  result.errors += unpriced;

  if (unpriced > 0) {
    Logger.warn("[Productive] Events skipped with no resolved rate", {
      month: monthIso,
      count: unpriced,
    });
  }

  Logger.info("[Productive] Monthly push starting", {
    month: monthIso,
    events: events.length,
    groups: groups.length,
    dryRun: Boolean(opts?.dryRun),
  });

  // How many distinct rates each (customer, kind) pair has — decides whether
  // the price needs to appear in the service name.
  const rateCounts = new Map<string, number>();
  for (const group of groups) {
    const key = `${group.customerId}|${group.kind}`;
    rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
  }

  // Budgets resolved this run, so a customer with several kinds only costs
  // one lookup.
  const budgetCache = new Map<string, string>();

  for (const group of groups) {
    try {
      const customer = await db.customer.findUnique({
        where: { id: group.customerId },
        select: { id: true, name: true, productiveCompanyId: true },
      });

      if (!customer?.productiveCompanyId) {
        // Not linked to Productive — usually a customer created before the
        // sync ran. Leave the events PENDING so they push once linked.
        result.skippedUnlinked += 1;
        Logger.warn(
          "[Productive] Customer has no Productive company; skipped",
          {
            customerId: group.customerId,
            customerName: customer?.name,
            month: monthIso,
          }
        );
        continue;
      }

      const budgetName = storageBudgetName(
        customer.name,
        month.getUTCFullYear()
      );
      const serviceName = serviceNameFor(
        group,
        month,
        rateCounts.get(`${group.customerId}|${group.kind}`) ?? 1
      );
      const description = `${group.quantity} × $${centsToDollars(
        group.amountCents
      )} — generated from ${group.eventIds.length} Shelf billing event${
        group.eventIds.length === 1 ? "" : "s"
      }.`;

      if (opts?.dryRun) {
        Logger.info("[Productive] (dry run) would push", {
          budget: budgetName,
          service: serviceName,
          quantity: group.quantity,
          unitPriceCents: group.amountCents,
          events: group.eventIds.length,
        });
        continue;
      }

      // Resolve or create the customer's budget for this year.
      let budgetId = budgetCache.get(customer.productiveCompanyId);
      if (!budgetId) {
        const existing = await findBudgetByName({
          companyId: customer.productiveCompanyId,
          name: budgetName,
        });
        const budget =
          existing ??
          (await createBudget({
            companyId: customer.productiveCompanyId,
            name: budgetName,
          }));
        budgetId = budget.id;
        budgetCache.set(customer.productiveCompanyId, budgetId);

        if (!existing) {
          Logger.info("[Productive] Created storage budget", {
            budgetId,
            budgetName,
          });
        }
      }

      // Reuse the month's service if it already exists — a correction should
      // adjust the line, not add a second one.
      const services = await listBudgetServices(budgetId);
      const existingService = services.find(
        (s) => s.attributes.name === serviceName
      );

      let serviceId: string;
      if (existingService) {
        await updateBudgetService({
          serviceId: existingService.id,
          quantity: group.quantity,
          priceCents: group.amountCents,
          description,
        });
        serviceId = existingService.id;
        result.servicesReused += 1;
      } else {
        const created = await createBudgetService({
          budgetId,
          serviceTypeId: DEFAULT_SERVICE_TYPE_IDS[group.kind],
          name: serviceName,
          quantity: group.quantity,
          priceCents: group.amountCents,
          description,
        });
        serviceId = created.id;
        result.servicesCreated += 1;
      }

      // Stamp the ledger only after Productive has accepted the line.
      const updated = await db.billableEvent.updateMany({
        where: { id: { in: group.eventIds } },
        data: {
          status: "PUSHED",
          productiveServiceId: serviceId,
          lastPushAttemptedAt: new Date(),
          lastPushError: null,
        },
      });
      result.eventsPushed += updated.count;
    } catch (cause) {
      result.errors += 1;
      Logger.error({
        message: "[Productive] Failed to push charge group",
        cause,
        customerId: group.customerId,
        kind: group.kind,
        month: monthIso,
      });

      // Record the failure on the events so a human can see why they are
      // still pending, without blocking the rest of the run.
      await db.billableEvent
        .updateMany({
          where: { id: { in: group.eventIds } },
          data: {
            lastPushAttemptedAt: new Date(),
            lastPushError:
              cause instanceof Error ? cause.message.slice(0, 500) : "Unknown",
          },
        })
        .catch(() => {
          // Best effort — the original error is already logged.
        });
    }
  }

  Logger.info("[Productive] Monthly push complete", { ...result });

  return result;
}
