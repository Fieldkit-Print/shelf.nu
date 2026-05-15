/**
 * Pricing Service
 *
 * CRUD helpers for the three pricing tiers (OrgPricing, CustomerPricing,
 * AssetPricing). Upserts are lazy — services accept patch objects with
 * optional fields and create the row on first write if it doesn't exist.
 *
 * Cents fields are exchanged with callers as raw integers. The route
 * layer handles dollar↔cents UI conversion (see {@link dollarsToCents}).
 *
 * @see {@link file://./resolver.server.ts}
 */

import type { Prisma } from "@prisma/client";

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

const label = "Pricing" as const;

/**
 * Convert a user-entered dollar string (e.g. "12.50") to integer cents.
 * Empty/null/whitespace input returns null, signalling "no rate at this
 * tier" (which is distinct from zero, which is a valid charge).
 */
export function dollarsToCents(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Inverse of dollarsToCents — formats cents as a fixed-2 decimal string
 * for prefilling inputs. Null input returns empty string so the input
 * renders as "blank" rather than "0.00".
 */
export function centsToDollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

/** Get the OrgPricing row, or null if none exists yet. */
export async function getOrgPricing(organizationId: string) {
  return db.orgPricing.findUnique({ where: { organizationId } });
}

/** Get the CustomerPricing row for a carbon customer, or null. */
export async function getCustomerPricing(carbonCustomerId: string) {
  return db.customerPricing.findUnique({ where: { carbonCustomerId } });
}

/** Get the AssetPricing row for an asset, or null. */
export async function getAssetPricing(assetId: string) {
  return db.assetPricing.findUnique({ where: { assetId } });
}

/**
 * Upsert OrgPricing. Caller passes raw cents and decimal multipliers;
 * fields explicitly set to null clear that tier's value (i.e. fall
 * through to nothing — useful if you want to express "no charge of
 * this kind ever, even by default"). Fields omitted from the patch
 * keep their existing values via Prisma's partial update semantics.
 */
export async function upsertOrgPricing(args: {
  organizationId: string;
  patch: {
    storagePerDayCents?: number | null;
    pickCents?: number | null;
    returnCents?: number | null;
    rentalPerDayCents?: number | null;
    rentalLossMultiplier?: Prisma.Decimal | string | null;
    consumableMarkupPct?: Prisma.Decimal | string | null;
    currencyCode?: string;
  };
}) {
  try {
    return await db.orgPricing.upsert({
      where: { organizationId: args.organizationId },
      create: {
        organizationId: args.organizationId,
        ...args.patch,
        currencyCode: args.patch.currencyCode ?? "USD",
      },
      update: args.patch,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Failed to save organization pricing.",
      additionalData: args,
    });
  }
}

/**
 * Upsert CustomerPricing. Same semantics as upsertOrgPricing —
 * undefined-leave-alone, null-clear, number/string-set. The
 * organization id is required on first create so we can scope the row;
 * subsequent updates use the carbonCustomerId PK alone.
 */
export async function upsertCustomerPricing(args: {
  organizationId: string;
  carbonCustomerId: string;
  patch: {
    storagePerDayCents?: number | null;
    pickCents?: number | null;
    returnCents?: number | null;
    rentalPerDayCents?: number | null;
    rentalLossMultiplier?: Prisma.Decimal | string | null;
    consumableMarkupPct?: Prisma.Decimal | string | null;
    currencyCode?: string | null;
  };
}) {
  try {
    return await db.customerPricing.upsert({
      where: { carbonCustomerId: args.carbonCustomerId },
      create: {
        carbonCustomerId: args.carbonCustomerId,
        organizationId: args.organizationId,
        ...args.patch,
      },
      update: args.patch,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Failed to save customer pricing.",
      additionalData: args,
    });
  }
}

/**
 * Upsert AssetPricing. Only storage + rental rates exist at the asset
 * tier — pick/return/loss/consumable are customer- or org-wide concepts.
 */
export async function upsertAssetPricing(args: {
  assetId: string;
  patch: {
    storagePerDayCents?: number | null;
    rentalPerDayCents?: number | null;
  };
}) {
  try {
    return await db.assetPricing.upsert({
      where: { assetId: args.assetId },
      create: {
        assetId: args.assetId,
        ...args.patch,
      },
      update: args.patch,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Failed to save asset pricing.",
      additionalData: args,
    });
  }
}
