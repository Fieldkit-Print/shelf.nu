/**
 * Pricing Resolver
 *
 * Walks the three-tier rate hierarchy (asset → customer → org) and returns
 * the most specific non-null rate for a given pricing kind. Callers
 * (event-emission services) use the returned amount to populate the
 * BillableEvent row at emit time so the historical rate is preserved even
 * if pricing changes later.
 *
 * Currency resolution is slightly different: AssetPricing has no currency
 * column (per-asset prices are interpreted in the customer/org currency).
 * Customer currency overrides org currency; org currency is the floor.
 *
 * Flat-rate kinds (storage/pick/return/rental-use) resolve via
 * `resolveFlatRateCents`. Multiplier-based kinds (rental-loss against
 * asset.valuation; consumable-markup against unit cost) have dedicated
 * helpers because the final amount also needs a runtime input.
 *
 * @see {@link file://./../../../packages/database/prisma/schema.prisma} OrgPricing, CustomerPricing, AssetPricing
 */

import type { Prisma } from "@prisma/client";

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

const label = "Pricing" as const;

/**
 * Pricing kinds that resolve to a flat cents amount. These map 1:1 to the
 * eponymous `BillableEventKind` values.
 */
export type FlatRateKind = "STORAGE" | "PICK" | "RETURN" | "RENTAL_USE";

/**
 * Result of a flat-rate resolution. `source` identifies which tier won
 * — useful for logs and for surfacing "this rate is inherited from X"
 * in admin UI later.
 */
export type ResolvedRate = {
  amountCents: number;
  currencyCode: string;
  source: "asset" | "customer" | "org";
};

/**
 * Maps a flat-rate kind to the column name on a *Pricing row that stores it.
 * Keeps the resolver code DRY while staying type-safe.
 */
const KIND_TO_COLUMN: Record<
  FlatRateKind,
  "storagePerDayCents" | "pickCents" | "returnCents" | "rentalPerDayCents"
> = {
  STORAGE: "storagePerDayCents",
  PICK: "pickCents",
  RETURN: "returnCents",
  RENTAL_USE: "rentalPerDayCents",
};

/**
 * Resolves a flat-rate pricing kind by walking asset → customer → org.
 *
 * Asset tier only applies to STORAGE and RENTAL_USE (the others aren't
 * per-asset concepts). When `assetId` is omitted the resolver starts at
 * the customer tier.
 *
 * Returns `null` when no tier sets a non-null rate for this kind — caller
 * should treat that as "no charge" and skip writing a BillableEvent.
 *
 * @throws {ShelfError} if no OrgPricing row exists at all — the org owner
 *   must seed at least default rates (which can be zero) before billing
 *   events can be emitted. Surfaces a configuration error rather than
 *   silently dropping events.
 */
export async function resolveFlatRateCents(args: {
  organizationId: string;
  carbonCustomerId?: string | null;
  assetId?: string | null;
  kind: FlatRateKind;
}): Promise<ResolvedRate | null> {
  const { organizationId, carbonCustomerId, assetId, kind } = args;
  const column = KIND_TO_COLUMN[kind];

  // Asset tier only carries storage + rental rates.
  const assetTierApplicable =
    assetId && (kind === "STORAGE" || kind === "RENTAL_USE");

  const [assetPricing, customerPricing, orgPricing] = await Promise.all([
    assetTierApplicable
      ? db.assetPricing.findUnique({ where: { assetId } })
      : Promise.resolve(null),
    carbonCustomerId
      ? db.customerPricing.findUnique({ where: { carbonCustomerId } })
      : Promise.resolve(null),
    db.orgPricing.findUnique({ where: { organizationId } }),
  ]);

  if (!orgPricing) {
    throw new ShelfError({
      cause: null,
      label,
      message:
        "Organization has no default pricing configured. Visit /settings/pricing to set default rates before emitting billing events.",
      additionalData: { organizationId, kind },
      shouldBeCaptured: true,
    });
  }

  // Currency cascades the opposite direction from rates: customer > org.
  // (Asset pricing has no currency column — it inherits.)
  const currencyCode = customerPricing?.currencyCode ?? orgPricing.currencyCode;

  // Walk most-specific to least.
  if (assetPricing) {
    const value =
      assetPricing[column as "storagePerDayCents" | "rentalPerDayCents"];
    if (value !== null && value !== undefined) {
      return { amountCents: value, currencyCode, source: "asset" };
    }
  }
  if (customerPricing) {
    const value = customerPricing[column];
    if (value !== null && value !== undefined) {
      return { amountCents: value, currencyCode, source: "customer" };
    }
  }
  {
    const value = orgPricing[column];
    if (value !== null && value !== undefined) {
      return { amountCents: value, currencyCode, source: "org" };
    }
  }

  return null;
}

/**
 * Resolves the multiplier applied to `Asset.valuation` when a rental is
 * declared lost. Customer tier overrides org tier; asset tier doesn't
 * carry this field (multipliers are a policy concept, not a per-item one).
 *
 * Returns null when neither tier sets a multiplier — caller should skip.
 *
 * @returns {{ multiplier: Prisma.Decimal, source: "customer" | "org" } | null}
 */
export async function resolveRentalLossMultiplier(args: {
  organizationId: string;
  carbonCustomerId: string;
}): Promise<{ multiplier: Prisma.Decimal; source: "customer" | "org" } | null> {
  const [customer, org] = await Promise.all([
    db.customerPricing.findUnique({
      where: { carbonCustomerId: args.carbonCustomerId },
    }),
    db.orgPricing.findUnique({
      where: { organizationId: args.organizationId },
    }),
  ]);

  if (
    customer?.rentalLossMultiplier !== undefined &&
    customer?.rentalLossMultiplier !== null
  ) {
    return { multiplier: customer.rentalLossMultiplier, source: "customer" };
  }
  if (
    org?.rentalLossMultiplier !== undefined &&
    org?.rentalLossMultiplier !== null
  ) {
    return { multiplier: org.rentalLossMultiplier, source: "org" };
  }
  return null;
}

/**
 * Resolves the markup percentage applied to a consumable item's unit cost
 * on consumption. Same precedence as rental-loss multiplier.
 */
export async function resolveConsumableMarkupPct(args: {
  organizationId: string;
  carbonCustomerId: string;
}): Promise<{ markupPct: Prisma.Decimal; source: "customer" | "org" } | null> {
  const [customer, org] = await Promise.all([
    db.customerPricing.findUnique({
      where: { carbonCustomerId: args.carbonCustomerId },
    }),
    db.orgPricing.findUnique({
      where: { organizationId: args.organizationId },
    }),
  ]);

  if (
    customer?.consumableMarkupPct !== undefined &&
    customer?.consumableMarkupPct !== null
  ) {
    return { markupPct: customer.consumableMarkupPct, source: "customer" };
  }
  if (
    org?.consumableMarkupPct !== undefined &&
    org?.consumableMarkupPct !== null
  ) {
    return { markupPct: org.consumableMarkupPct, source: "org" };
  }
  return null;
}

/**
 * Resolves the currency code for a given customer in a given org. Customer
 * tier overrides org tier; asset tier has no currency. Throws if no org
 * pricing row exists at all (same reasoning as resolveFlatRateCents).
 */
export async function resolveCurrencyCode(args: {
  organizationId: string;
  carbonCustomerId?: string | null;
}): Promise<string> {
  const [customer, org] = await Promise.all([
    args.carbonCustomerId
      ? db.customerPricing.findUnique({
          where: { carbonCustomerId: args.carbonCustomerId },
        })
      : Promise.resolve(null),
    db.orgPricing.findUnique({
      where: { organizationId: args.organizationId },
    }),
  ]);

  if (!org) {
    throw new ShelfError({
      cause: null,
      label,
      message:
        "Organization has no default pricing configured. Set default rates and currency at /settings/pricing.",
      additionalData: { organizationId: args.organizationId },
      shouldBeCaptured: true,
    });
  }

  return customer?.currencyCode ?? org.currencyCode;
}
