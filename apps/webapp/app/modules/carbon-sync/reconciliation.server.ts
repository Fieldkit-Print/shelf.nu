/**
 * Carbon Sync — Reconciliation Cron
 *
 * Back-stop sync that pages through every Carbon customer + customerContact
 * (with the joined contact row) for Fieldkit's company id, ensuring shelf
 * catches up on anything webhooks missed (deploy windows, transient 5xx,
 * Carbon Edge Function failures).
 *
 * Errors on individual records are logged and skipped; one bad row should
 * not abort the entire pass. The function returns counters so the queue
 * worker can record observability data.
 *
 * Job payload type: {@link CarbonSyncJob} `{ kind: "reconcile-all", since? }`.
 *
 * @see {@link file://./client.server.ts}    Iterators
 * @see {@link file://./service.server.ts}   Upsert dispatch
 * @see {@link file://./../../utils/scheduler.server.ts} pg-boss setup
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import {
  iterateCustomerContactsWithContact,
  iterateCustomers,
} from "./client.server";
import {
  upsertCustomerFromCarbonLite,
  upsertUserFromContact,
} from "./service.server";
import type { CarbonSyncJob } from "./types";

/**
 * Runs a full reconcile pass. Customers go first so each customerContact
 * has a parent Customer row in shelf when its turn comes.
 */
export async function reconcileAll(
  opts: Extract<CarbonSyncJob, { kind: "reconcile-all" }>
) {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message: "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot reconcile.",
      label: "Carbon Sync",
    });
  }

  const since = opts.since;

  let customers = 0;
  let contacts = 0;
  let customerErrors = 0;
  let contactErrors = 0;

  Logger.info("[Carbon Sync] Reconciliation starting", { since });

  for await (const customer of iterateCustomers({ since })) {
    try {
      await upsertCustomerFromCarbonLite({
        carbonCustomerId: customer.id,
        displayName: customer.name,
      });
      customers += 1;
    } catch (cause) {
      customerErrors += 1;
      Logger.error({
        message: "[Carbon Sync] Failed to upsert customer in reconcile",
        cause,
        carbonCustomerId: customer.id,
      });
    }
  }

  // For contacts we iterate the customerContact junction joined to contact;
  // that's the canonical "this contact belongs to this customer" set. Loose
  // contacts not attached to any customer are not meaningful to shelf.
  for await (const link of iterateCustomerContactsWithContact({ since })) {
    try {
      // Resolve the shelf customer id once per iteration (cheap due to
      // unique index on (organizationId, carbonCustomerId)).
      const shelfCustomer = await db.customer.findUnique({
        where: {
          organizationId_carbonCustomerId: {
            organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
            carbonCustomerId: link.customerId,
          },
        },
        select: { id: true },
      });
      if (!shelfCustomer) {
        // Customer didn't sync (yet) — skip for now; next reconcile pass
        // will catch this once the customer is upserted.
        continue;
      }
      await upsertUserFromContact({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        customerId: shelfCustomer.id,
        carbonContact: link.contact,
      });
      contacts += 1;
    } catch (cause) {
      contactErrors += 1;
      Logger.error({
        message: "[Carbon Sync] Failed to upsert contact in reconcile",
        cause,
        carbonContactId: link.contact.id,
        carbonCustomerId: link.customerId,
      });
    }
  }

  Logger.info("[Carbon Sync] Reconciliation complete", {
    customers,
    contacts,
    customerErrors,
    contactErrors,
  });

  return { customers, contacts, customerErrors, contactErrors };
}
