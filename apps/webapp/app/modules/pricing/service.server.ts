/**
 * Pricing Service
 *
 * CRUD helpers for the three pricing tiers (OrgPricing, CustomerPricing,
 * AssetPricing). Upserts are lazy — services accept patch objects with
 * optional fields and create the row on first write if it doesn't exist.
 *
 * Cents fields are exchanged with callers as raw integers. The dollar↔cents
 * formatters live in {@link ./format.ts} (no `.server` suffix) so React
 * route components can import them without dragging the server bundle
 * into the client build.
 *
 * @see {@link file://./resolver.server.ts}
 * @see {@link file://./format.ts}
 */

import type { Prisma } from "@prisma/client";

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

const label = "Pricing" as const;

/**
 * Throws unless the asset belongs to the organization.
 *
 * `AssetPricing` is keyed solely on `assetId` and carries no organization of
 * its own, so a route that trusts a URL param has nothing downstream to catch
 * a foreign id. Since every user is OWNER of their personal workspace and
 * therefore holds `asset:update` somewhere, the permission check alone does
 * not establish ownership of *this* asset.
 *
 * @throws {ShelfError} 404 when the asset is not in the organization.
 */
export async function assertAssetBelongsToOrg(args: {
  assetId: string;
  organizationId: string;
}) {
  const asset = await db.asset.findFirst({
    where: { id: args.assetId, organizationId: args.organizationId },
    select: { id: true },
  });

  if (!asset) {
    throw new ShelfError({
      cause: null,
      title: "Asset not found",
      message: "This asset doesn't exist in your workspace.",
      label,
      status: 404,
      additionalData: args,
      shouldBeCaptured: true,
    });
  }
}

/**
 * Throws unless the customer belongs to the organization.
 *
 * `upsertCustomerPricing` matches on `customerId` alone, so its update branch
 * will happily overwrite another organization's negotiated rates if the id is
 * supplied directly.
 *
 * @throws {ShelfError} 404 when the customer is not in the organization.
 */
export async function assertCustomerBelongsToOrg(args: {
  customerId: string;
  organizationId: string;
}) {
  const customer = await db.customer.findFirst({
    where: { id: args.customerId, organizationId: args.organizationId },
    select: { id: true },
  });

  if (!customer) {
    throw new ShelfError({
      cause: null,
      title: "Customer not found",
      message: "This customer doesn't exist in your workspace.",
      label,
      status: 404,
      additionalData: args,
      shouldBeCaptured: true,
    });
  }
}

/** Get the OrgPricing row, or null if none exists yet. */
export async function getOrgPricing(organizationId: string) {
  return db.orgPricing.findUnique({ where: { organizationId } });
}

/** Get the CustomerPricing row for a customer, or null. */
export async function getCustomerPricing(customerId: string) {
  return db.customerPricing.findUnique({ where: { customerId } });
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
    storageHalfPalletCents?: number | null;
    storageStandardPalletCents?: number | null;
    storageTallPalletCents?: number | null;
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
 * subsequent updates use the customerId PK alone.
 */
export async function upsertCustomerPricing(args: {
  organizationId: string;
  customerId: string;
  patch: {
    storageHalfPalletCents?: number | null;
    storageStandardPalletCents?: number | null;
    storageTallPalletCents?: number | null;
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
      where: { customerId: args.customerId },
      create: {
        customerId: args.customerId,
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
