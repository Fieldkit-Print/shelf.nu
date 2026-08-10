/**
 * Customer ↔ Asset assignment helpers.
 *
 * The mapping of which physical assets belong to which customer lives in
 * Shelf as `Asset.customerId` (FK to {@link Customer}). These helpers power
 * the admin "assign assets to customer" workflow:
 *
 *   - {@link bulkAssignAssetsToCustomer} — set `Asset.customerId` for a list
 *     of asset ids. Pass `customerId = null` to release assets back to
 *     org-owned inventory.
 *   - {@link bulkSetAssetsRentable} — flip `Asset.rentable` for org-owned
 *     items so they show up in the customer rental browse.
 *
 * Both helpers re-verify org scoping inside the update so a stray asset id
 * from another organisation can't be touched.
 *
 * @see {@link file://./../../routes/api+/customers.assign-assets.ts}
 */

import { db } from "~/database/db.server";

/**
 * Sets `Asset.customerId` for a list of assets in one organisation.
 *
 * @param args.organizationId - The owning organization (scopes the update)
 * @param args.assetIds - Assets to update; anything not in this org is ignored
 * @param args.customerId - Customer id to tag, or `null` to release to org-owned
 * @returns The number of assets updated.
 */
export async function bulkAssignAssetsToCustomer(args: {
  organizationId: string;
  assetIds: string[];
  customerId: string | null;
}) {
  const { organizationId, assetIds, customerId } = args;

  if (assetIds.length === 0) return 0;

  const result = await db.asset.updateMany({
    where: { id: { in: assetIds }, organizationId },
    data: { customerId },
  });
  return result.count;
}

/**
 * Marks org-owned assets (customerId = null) as rentable / non-rentable.
 * Refuses to flag customer-owned assets as rentable: lending out a customer's
 * stored item to a different customer is a workflow we want to surface
 * deliberately, not via a bulk toggle.
 *
 * @param args.organizationId - The owning organization (scopes the update)
 * @param args.assetIds - Assets to update
 * @param args.rentable - New rentable flag
 * @returns The number of assets updated.
 */
export async function bulkSetAssetsRentable(args: {
  organizationId: string;
  assetIds: string[];
  rentable: boolean;
}) {
  const { organizationId, assetIds, rentable } = args;
  if (assetIds.length === 0) return 0;

  const result = await db.asset.updateMany({
    where: {
      id: { in: assetIds },
      organizationId,
      customerId: null, // refuse to flag customer-owned assets
    },
    data: { rentable },
  });
  return result.count;
}
