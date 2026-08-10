/**
 * Productive → Shelf customer sync.
 *
 * Productive is the system of record for customer master data. Shelf keeps a
 * local `Customer` mirror because tenancy filters and asset scoping need a
 * row to join against on every request — calling Productive per request
 * isn't viable.
 *
 * The mirror is one-way and idempotent: nothing in Shelf creates or edits a
 * customer, and re-running the sync converges rather than duplicating.
 * Matching is on `Customer.productiveCompanyId`, which is unique.
 *
 * Deliberately does NOT delete. A company archived in Productive leaves its
 * Shelf row in place, because assets, booking requests and billing history
 * still reference it — dropping the row would orphan all of them and, since
 * these are scalar references with no foreign key, the database wouldn't
 * stop it.
 *
 * @see {@link file://./client.server.ts} REST client
 * @see {@link file://./push.server.ts}   The other direction
 */

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { listCompanies } from "./client.server";
import type { ProductiveSyncResult } from "./types";

const label = "Productive" as const;

/**
 * Composes the ship-to street from Productive's single `address` line.
 *
 * Productive stores one free-form address line where Shelf has street1 and
 * street2. Rather than guess at a split, the whole line goes into street1 and
 * street2 stays null — a wrong split produces labels that look right and
 * deliver wrong, which is worse than one long line.
 */
function toShipTo(attributes: {
  name: string;
  billing_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  country: string | null;
  phone: string | null;
}) {
  return {
    shipToName: attributes.billing_name?.trim() || attributes.name,
    shipToPhone: attributes.phone?.trim() || null,
    shipToStreet1: attributes.address?.trim() || null,
    shipToStreet2: null,
    shipToCity: attributes.city?.trim() || null,
    shipToState: attributes.state?.trim() || null,
    shipToPostalCode: attributes.zipcode?.trim() || null,
    shipToCountry: attributes.country?.trim() || null,
  };
}

/**
 * Pulls every active Productive company into the local `Customer` mirror.
 *
 * @param opts.excludeCompanyId - Productive company id representing Fieldkit
 *   itself. Productive lists the organization's own company alongside
 *   clients; it is not a customer and must not become one. Defaults to
 *   `PRODUCTIVE_OWN_COMPANY_ID` when set.
 * @returns Counts for logging and the admin trigger's response.
 * @throws {ShelfError} When `FIELDKIT_PRIMARY_ORGANIZATION_ID` is unset, or
 *   Productive is unreachable.
 */
export async function syncCustomersFromProductive(opts?: {
  excludeCompanyId?: string | null;
}): Promise<ProductiveSyncResult> {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set; cannot sync customers.",
      label,
    });
  }

  const organizationId = FIELDKIT_PRIMARY_ORGANIZATION_ID;
  const companies = await listCompanies();

  const result: ProductiveSyncResult = {
    fetched: companies.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  Logger.info("[Productive] Customer sync starting", {
    fetched: companies.length,
  });

  for (const company of companies) {
    const attributes = company.attributes;

    // Fieldkit's own company is not a customer.
    if (opts?.excludeCompanyId && company.id === opts.excludeCompanyId) {
      result.skipped += 1;
      continue;
    }

    if (!attributes.name?.trim()) {
      result.skipped += 1;
      Logger.warn("[Productive] Company has no name; skipped", {
        productiveCompanyId: company.id,
      });
      continue;
    }

    try {
      const existing = await db.customer.findUnique({
        where: { productiveCompanyId: company.id },
        select: { id: true },
      });

      const shipTo = toShipTo(attributes);

      if (existing) {
        await db.customer.update({
          where: { id: existing.id },
          data: {
            name: attributes.name.trim(),
            billingEmail: attributes.email?.trim() || null,
            ...shipTo,
          },
        });
        result.updated += 1;
        continue;
      }

      await db.customer.create({
        data: {
          organizationId,
          productiveCompanyId: company.id,
          name: attributes.name.trim(),
          billingEmail: attributes.email?.trim() || null,
          ...shipTo,
        },
      });
      result.created += 1;
    } catch (cause) {
      result.errors += 1;
      Logger.error({
        message: "[Productive] Failed to sync company",
        cause,
        productiveCompanyId: company.id,
        companyName: attributes.name,
      });
    }
  }

  Logger.info("[Productive] Customer sync complete", { ...result });

  return result;
}
