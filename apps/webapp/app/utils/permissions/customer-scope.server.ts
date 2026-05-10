/**
 * Customer Scope Helpers (Fieldkit multi-tenancy, FDW edition)
 *
 * The CUSTOMER role gives external customer contacts access to the same shelf
 * UI as staff, but every query they hit must be scoped to the single Carbon
 * customer they're linked to (`User.carbonCustomerId`).
 *
 * Carbon owns customer master data. Shelf only stores the carbon customer id
 * as a text reference (no FK, no local mirror). Cross-app reads against
 * customer fields happen via the `carbon_remote.v1_customers` foreign view.
 *
 * These helpers produce the Prisma `where` fragments that callers AND-merge
 * into their own queries. Centralising the scope construction here means a
 * single place to audit and a single place to extend (e.g., when adding the
 * "rentable inventory" pool for canRentInventory contacts).
 *
 * Usage:
 *
 *   const perm = await requirePermission({ ... });
 *   const where: Prisma.AssetWhereInput = {
 *     organizationId: perm.organizationId,
 *     ...buildCustomerAssetScope(perm),
 *   };
 *
 * @see {@link file://./../roles.server.ts}            requirePermission()
 * @see {@link file://./permission.data.ts}            Role permission map
 * @see {@link file://./../../../packages/database/prisma/schema.prisma} Asset.carbonCustomerId
 */

import type { Prisma } from "@prisma/client";

import type { PermissionContext } from "../roles.server";

/**
 * Options for scoping Asset queries to a CUSTOMER user's visibility.
 */
export type CustomerAssetScopeOptions = {
  /**
   * When true, also include Fieldkit-owned rentable inventory
   * (Asset.carbonCustomerId IS NULL AND Asset.rentable = true) in the result.
   *
   * Pass `true` for routes where the customer is browsing rentable items
   * (e.g., the rental catalogue). Pass `false` (default) for routes that
   * should only show items the customer already owns at Fieldkit.
   *
   * The caller is still responsible for checking
   * `perm.customerContactPermission?.canRentInventory` before showing rental
   * UI; this option only widens the visibility scope for queries.
   */
  includeRentable?: boolean;
};

/**
 * Builds the mandatory Prisma `Asset` scope for a CUSTOMER user.
 *
 * For non-CUSTOMER roles this returns an empty object so the helper is safe
 * to spread unconditionally:
 *
 *   where: { organizationId, ...buildCustomerAssetScope(perm) }
 *
 * For CUSTOMER users it returns either a single-customer filter or, when
 * `includeRentable` is true, an OR of (customer-owned) ∪ (Fieldkit rentable).
 *
 * @param perm - Result of requirePermission() for the current request
 * @param options - See {@link CustomerAssetScopeOptions}
 * @returns A Prisma `AssetWhereInput` fragment to AND-merge into your query
 * @throws Never; missing customer linkage is caught earlier in requirePermission()
 */
export function buildCustomerAssetScope(
  perm: PermissionContext,
  options: CustomerAssetScopeOptions = {}
): Prisma.AssetWhereInput {
  if (!perm.isCustomer || !perm.carbonCustomerId) return {};

  const ownedScope: Prisma.AssetWhereInput = {
    carbonCustomerId: perm.carbonCustomerId,
  };

  if (options.includeRentable) {
    return {
      OR: [
        ownedScope,
        // Fieldkit-owned rental pool. carbonCustomerId IS NULL is intentional:
        // rental items are organisation inventory, not stored on behalf of a
        // customer.
        { carbonCustomerId: null, rentable: true },
      ],
    };
  }

  return ownedScope;
}

/**
 * Builds the mandatory Prisma `Booking` scope for a CUSTOMER user.
 *
 * Customer users only see bookings they created or where they are the
 * custodian. Cross-customer leakage via shared assets is impossible because
 * the asset side already filters by carbonCustomerId.
 *
 * @param perm - Result of requirePermission() for the current request
 * @param userId - The current authenticated user id (acts as creator/custodian)
 * @returns A Prisma `BookingWhereInput` fragment to AND-merge into your query
 */
export function buildCustomerBookingScope(
  perm: PermissionContext,
  userId: string
): Prisma.BookingWhereInput {
  if (!perm.isCustomer) return {};
  return {
    OR: [{ creatorId: userId }, { custodianUserId: userId }],
  };
}

/**
 * Type guard: throws if the permission context represents a CUSTOMER user
 * without a linked Carbon customer. Use at the top of routes that should be
 * unreachable for unlinked customers (defense in depth — `requirePermission`
 * already raises this, but explicit checks at the route boundary make
 * intent clear and protect against permission-context plumbing bugs).
 *
 * @param perm - Result of requirePermission() for the current request
 * @throws {Error} If the user holds CUSTOMER role but has no carbonCustomerId
 */
export function assertCustomerLinkage(
  perm: PermissionContext
): asserts perm is PermissionContext & {
  isCustomer: true;
  carbonCustomerId: string;
} {
  if (perm.isCustomer && !perm.carbonCustomerId) {
    throw new Error(
      "CUSTOMER role user is missing carbonCustomerId — permission context is malformed."
    );
  }
}
