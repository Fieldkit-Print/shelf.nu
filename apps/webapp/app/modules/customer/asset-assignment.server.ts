/**
 * Customer ↔ Asset assignment helpers (FDW edition).
 *
 * Carbon ERP doesn't track which physical assets belong to which customer
 * at the instance level — that mapping lives in Shelf as
 * `Asset.carbonCustomerId` (text reference into Carbon). These helpers
 * power the admin "assign assets to customer" workflow:
 *
 *   - {@link bulkAssignAssetsToCustomer} — set `Asset.carbonCustomerId` for
 *     a list of asset ids. Pass `carbonCustomerId = null` to release
 *     assets back to Fieldkit-owned inventory.
 *   - {@link bulkSetAssetsRentable} — flip `Asset.rentable` for Fieldkit-owned
 *     items so they show up in the customer rental browse.
 *
 * Both helpers re-verify org scoping inside the update so a stray asset id
 * from another organisation can't be touched. The target Carbon customer is
 * NOT verified against Carbon REST at write time — assigning to an unknown
 * id is recoverable (Carbon webhook will eventually correct it) and adding
 * an RTT to every assignment isn't worth the cost.
 *
 * @see {@link file://./../../routes/api+/customers.assign-assets.ts}
 */

import { db } from "~/database/db.server";

/**
 * Sets `Asset.carbonCustomerId` for a list of assets in one organisation.
 *
 * @returns The number of assets updated.
 */
export async function bulkAssignAssetsToCustomer(args: {
  organizationId: string;
  /** Assets to update. Anything not in this org is silently ignored. */
  assetIds: string[];
  /**
   * - `string` → tag assets as stored on behalf of that Carbon customer
   * - `null`   → release assets back to Fieldkit-owned inventory
   */
  carbonCustomerId: string | null;
}) {
  const { organizationId, assetIds, carbonCustomerId } = args;

  if (assetIds.length === 0) return 0;

  const result = await db.asset.updateMany({
    where: { id: { in: assetIds }, organizationId },
    data: { carbonCustomerId },
  });
  return result.count;
}

/**
 * Marks Fieldkit-owned assets (carbonCustomerId = null) as rentable /
 * non-rentable. Refuses to flag customer-owned assets as rentable: lending
 * out a customer's stored item to a different customer is a workflow we
 * want to surface deliberately, not via a bulk toggle.
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
      carbonCustomerId: null, // refuse to flag customer-owned assets
    },
    data: { rentable },
  });
  return result.count;
}
