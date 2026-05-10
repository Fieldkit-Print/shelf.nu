/**
 * Customer ↔ Asset assignment helpers.
 *
 * Carbon ERP doesn't currently track which physical assets belong to which
 * customer — that's a Fieldkit-internal mapping done in shelf. These helpers
 * power the admin "assign assets to customer" workflow:
 *
 *   - {@link bulkAssignAssetsToCustomer} — set `Asset.customerId` for a list
 *     of asset ids. Pass `customerId = null` to "release" assets back to
 *     Fieldkit-owned inventory.
 *   - {@link bulkSetAssetsRentable} — flip `Asset.rentable` for Fieldkit-owned
 *     items so they show up in the customer rental browse.
 *
 * Both helpers re-verify org scoping inside the update so a stray asset id
 * from another organisation can't be touched.
 *
 * @see {@link file://./../../routes/api+/customers.assign-assets.ts}
 */

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

/**
 * Sets `Asset.customerId` for a list of assets in one organisation.
 *
 * @returns The number of assets updated.
 */
export async function bulkAssignAssetsToCustomer(args: {
  organizationId: string;
  /** Assets to update. Anything not in this org is silently ignored. */
  assetIds: string[];
  /**
   * - `string` → tag assets as stored on behalf of that customer
   * - `null`   → release assets back to Fieldkit-owned inventory
   */
  customerId: string | null;
}) {
  const { organizationId, assetIds, customerId } = args;

  if (assetIds.length === 0) return 0;

  // When linking, verify the target customer exists & is in the same org.
  if (customerId !== null) {
    const customer = await db.customer.findFirst({
      where: { id: customerId, organizationId },
      select: { id: true },
    });
    if (!customer) {
      throw new ShelfError({
        cause: null,
        title: "Customer not found",
        message: "The selected customer does not exist in this workspace.",
        label: "Organization",
        status: 404,
        additionalData: args,
      });
    }
  }

  const result = await db.asset.updateMany({
    where: { id: { in: assetIds }, organizationId },
    data: { customerId },
  });
  return result.count;
}

/**
 * Marks Fieldkit-owned assets (customerId = null) as rentable / non-rentable.
 *
 * Refuses to flag customer-owned assets as rentable: lending out a customer's
 * stored item to a different customer is a workflow we want to surface
 * deliberately, not via a bulk toggle.
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
