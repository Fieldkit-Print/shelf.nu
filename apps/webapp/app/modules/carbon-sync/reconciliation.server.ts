/**
 * Carbon Sync — Reconciliation Cron (FDW edition)
 *
 * Back-stop sync that pages through every Carbon customer-contact link for
 * Fieldkit's company id, ensuring Shelf provisions a User row for any
 * contact whose webhook delivery was missed (deploy windows, transient 5xx,
 * Carbon Edge Function failures).
 *
 * Customer master data is NOT mirrored — Shelf reads it via the
 * `carbon_remote.v1_customers` foreign view at query time. So this pass
 * only covers contact ↔ User provisioning.
 *
 * Errors on individual records are logged and skipped; one bad row should
 * not abort the entire pass.
 *
 * Job payload type: {@link CarbonSyncJob} `{ kind: "reconcile-all", since? }`.
 *
 * @see {@link file://./client.server.ts}    Iterators
 * @see {@link file://./service.server.ts}   Upsert dispatch
 * @see {@link file://./../../utils/scheduler.server.ts} pg-boss setup
 */

import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { iterateCustomerContactsWithContact } from "./client.server";
import { upsertUserFromContact } from "./service.server";
import type { CarbonSyncJob } from "./types";

/**
 * Runs a full reconcile pass over `customerContact` joins.
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

  let contacts = 0;
  let contactErrors = 0;

  Logger.info("[Carbon Sync] Reconciliation starting", { since });

  for await (const link of iterateCustomerContactsWithContact({ since })) {
    try {
      await upsertUserFromContact({
        organizationId: FIELDKIT_PRIMARY_ORGANIZATION_ID,
        carbonCustomerId: link.customerId,
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
    contacts,
    contactErrors,
  });

  return { contacts, contactErrors };
}
