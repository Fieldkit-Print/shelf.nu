import type {
  CustomerContactPermission,
  CustomerStatus,
  SsoDetails,
} from "@prisma/client";
import { OrganizationRoles, Roles } from "@prisma/client";
import { db } from "~/database/db.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { ShelfError } from "./error";
import type {
  PermissionAction,
  PermissionEntity,
} from "./permissions/permission.data";
import { validatePermission } from "./permissions/permission.validator.server";

export async function requireUserWithPermission(name: Roles, userId: string) {
  try {
    return await db.user.findFirstOrThrow({
      where: { id: userId, roles: { some: { name } } },
      select: { id: true },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "You do not have permission to access this resource",
      additionalData: { userId, name },
      label: "Permission",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

export async function requireAdmin(userId: string) {
  return requireUserWithPermission(Roles["ADMIN"], userId);
}

export async function isAdmin(context: Record<string, any>) {
  const authSession = context.getSession();

  const user = await db.user.findFirst({
    where: {
      id: authSession.userId,
      roles: { some: { name: Roles["ADMIN"] } },
    },
    select: { id: true },
  });

  return !!user;
}

export async function requirePermission({
  userId,
  request,
  entity,
  action,
}: {
  userId: string;
  request: Request;
  entity: PermissionEntity;
  action: PermissionAction;
}) {
  /**
   * This can be very slow and consuming as there are a few queries with a few joins and this running on every loader/action makes it slow
   * We need to find a  strategy to make it more performant. Idea:
   * 1. Have a very light weight query that fetches the lastUpdated in relation to userOrganizationRoles. THis can be done both for roles and organizations
   * 2. Store it in a cookie
   * 3. If they mismatch, make the big query to check the actual data
   */

  const {
    organizationId,
    userOrganizations,
    organizations,
    currentOrganization,
  } = await getSelectedOrganization({ userId, request });

  const roles = userOrganizations.find(
    (o) => o.organization.id === organizationId
  )?.roles;

  await validatePermission({
    roles,
    action,
    entity,
    organizationId,
    userId,
  });

  const role = roles ? roles[0] : OrganizationRoles.BASE;

  const isSelfServiceOrBase =
    role === OrganizationRoles.SELF_SERVICE || role === OrganizationRoles.BASE;

  const isCustomer = role === OrganizationRoles.CUSTOMER;

  /**
   * Customer-tenancy linkage (Fieldkit only).
   *
   * For CUSTOMER role users we MUST resolve the linked `fieldkitCustomerId`
   * here so every downstream query can scope correctly. Without this id the
   * caller would either (a) leak other customers' data or (b) return nothing
   * at all — both worse than failing fast. We also reject sign-in for users
   * whose Customer record is archived.
   *
   * Non-customer roles skip this block entirely (zero extra queries) so the
   * staff path stays as fast as upstream.
   */
  let fieldkitCustomerId: string | null = null;
  let customerContactPermission: CustomerContactPermission | null = null;
  let customerStatus: CustomerStatus | null = null;

  if (isCustomer) {
    const customerUser = await db.user.findUnique({
      where: { id: userId },
      select: {
        fieldkitCustomerId: true,
        customerContactPermission: true,
        fieldkitCustomer: {
          select: { status: true, archivedAt: true },
        },
      },
    });

    if (!customerUser?.fieldkitCustomerId || !customerUser.fieldkitCustomer) {
      throw new ShelfError({
        cause: null,
        title: "Customer account not linked",
        message:
          "Your account is not linked to a customer record. Please contact Fieldkit support.",
        additionalData: { userId, organizationId },
        label: "Permission",
        status: 403,
        shouldBeCaptured: true,
      });
    }

    if (customerUser.fieldkitCustomer.status === "ARCHIVED") {
      throw new ShelfError({
        cause: null,
        title: "Customer account archived",
        message:
          "This customer account has been archived. Please contact Fieldkit support if you believe this is in error.",
        additionalData: {
          userId,
          organizationId,
          fieldkitCustomerId: customerUser.fieldkitCustomerId,
        },
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    fieldkitCustomerId = customerUser.fieldkitCustomerId;
    customerContactPermission = customerUser.customerContactPermission;
    customerStatus = customerUser.fieldkitCustomer.status;
  }

  /**
   * This checks the organization settings permissions overrides for BASE and SELF_SERVICE roles
   * If the user is in a BASE or SELF_SERVICE role, we check if they can see all bookings.
   *
   * CUSTOMER role is *never* allowed to see all bookings — they are hard-scoped
   * to their own creator/custodian bookings via `buildCustomerBookingScope`.
   * We short-circuit here so the `!isSelfServiceOrBase` branch (which would
   * otherwise return true for CUSTOMER) cannot leak data.
   */
  const canSeeAllBookings = isCustomer
    ? false
    : // Admin/Owner always can see all
      !isSelfServiceOrBase ||
      // SELF_SERVICE can see all if org setting allows
      (role === OrganizationRoles.SELF_SERVICE &&
        currentOrganization.selfServiceCanSeeBookings) ||
      // BASE can see all if org setting allows
      (role === OrganizationRoles.BASE &&
        currentOrganization.baseUserCanSeeBookings);

  // Determine if user can see all custody information.
  // Same hard rule for CUSTOMER as canSeeAllBookings above.
  const canSeeAllCustody = isCustomer
    ? false
    : // Admin/Owner always can see all
      !isSelfServiceOrBase ||
      // SELF_SERVICE can see all if org setting allows
      (role === OrganizationRoles.SELF_SERVICE &&
        currentOrganization.selfServiceCanSeeCustody) ||
      // BASE can see all if org setting allows
      (role === OrganizationRoles.BASE &&
        currentOrganization.baseUserCanSeeCustody);

  // Determine if user can use barcodes based on organization settings
  const canUseBarcodes = currentOrganization.barcodesEnabled ?? false;

  // Determine if user can use audits based on organization settings
  const canUseAudits = currentOrganization.auditsEnabled ?? false;

  return {
    organizations,
    organizationId,
    currentOrganization,
    role,
    isSelfServiceOrBase,
    isCustomer,
    fieldkitCustomerId,
    customerContactPermission,
    customerStatus,
    userOrganizations,
    canSeeAllBookings,
    canSeeAllCustody,
    canUseBarcodes,
    canUseAudits,
  };
}

/**
 * Shape of the object returned by {@link requirePermission}.
 *
 * Exported as a type alias so helpers in `~/utils/permissions/*` can accept
 * a strongly-typed permission context without re-listing the fields.
 */
export type PermissionContext = Awaited<ReturnType<typeof requirePermission>>;

/** Gets the role needed for SSO login from the groupID returned by the SSO claims */
export function getRoleFromGroupId(
  ssoDetails: SsoDetails,
  groupIds: string[]
): OrganizationRoles | null {
  // We prioritize the admin group. If for some reason the user is in both groups, they will be an admin
  if (ssoDetails.adminGroupId && groupIds.includes(ssoDetails.adminGroupId)) {
    return OrganizationRoles.ADMIN;
  } else if (
    ssoDetails.selfServiceGroupId &&
    groupIds.includes(ssoDetails.selfServiceGroupId)
  ) {
    return OrganizationRoles.SELF_SERVICE;
  } else if (
    ssoDetails.baseUserGroupId &&
    groupIds.includes(ssoDetails.baseUserGroupId)
  ) {
    return OrganizationRoles.BASE;
  } else {
    return null;
  }
}
