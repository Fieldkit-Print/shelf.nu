import { OrganizationRoles } from "@prisma/client";
import { ShelfError } from "./error";

interface ValidateBookingOwnershipParams {
  booking: {
    creatorId: string | null;
    custodianUserId: string | null;
  };
  userId: string;
  role: OrganizationRoles;
  action: string;
  /**
   * When true, only checks custodianUserId (not creatorId).
   * Used for operations like PDF/calendar download where only the custodian should have access.
   * @default false
   */
  checkCustodianOnly?: boolean;
  /**
   * When true, BASE users are blocked entirely (used for destructive actions like extend/delete).
   * When false, BASE users are checked for ownership like SELF_SERVICE (used for read operations).
   * @default false
   */
  blockBaseEntirely?: boolean;
}

/**
 * Roles restricted to bookings they own.
 *
 * CUSTOMER is in this set and its absence was a live privilege escalation:
 * the check below used to name only SELF_SERVICE and BASE, so a customer
 * portal user fell straight through to the "implicitly allowed" branch and
 * was treated like an ADMIN at every call site — booking delete, PDF export,
 * calendar export, and the service layer.
 *
 * Anything not listed here is staff (ADMIN / OWNER) and may act on any
 * booking in the organization. Adding a new non-staff role means adding it
 * here too; {@link isStaffRole} is the inverse and should be used instead of
 * hand-rolled `!isSelfServiceOrBase` checks, which silently misclassify
 * every role invented after they were written.
 */
const OWNERSHIP_RESTRICTED_ROLES: OrganizationRoles[] = [
  OrganizationRoles.SELF_SERVICE,
  OrganizationRoles.BASE,
  OrganizationRoles.CUSTOMER,
];

/**
 * True when the role is Fieldkit staff — allowed to act across the whole
 * organization.
 *
 * Prefer this over negating a narrower flag. `!isSelfServiceOrBase` reads as
 * "is staff" but returns true for CUSTOMER, which is how customers ended up
 * bypassing booking time-limit validation and receiving the org's admin
 * roster in loader payloads.
 */
export function isStaffRole(role: OrganizationRoles): boolean {
  return !OWNERSHIP_RESTRICTED_ROLES.includes(role);
}

/**
 * Validates that a user has permission to perform an action on a booking based on their role and ownership.
 *
 * Authorization rules:
 * - BASE users: Blocked for write operations, ownership-checked for read operations
 * - SELF_SERVICE users: Only allowed on bookings they own (creator OR custodian)
 * - CUSTOMER users: Only allowed on bookings they own, same as SELF_SERVICE.
 *   Customer *tenancy* (seeing only their own company's assets) is enforced
 *   separately by the query scopes in `permissions/customer-scope.server.ts`;
 *   this is the per-booking ownership layer on top of it.
 * - ADMIN/OWNER users: Allowed on all bookings
 *
 * @throws {ShelfError} 403 if user is not authorized
 */
export function validateBookingOwnership({
  booking,
  userId,
  role,
  action,
  checkCustodianOnly = false,
  blockBaseEntirely = false,
}: ValidateBookingOwnershipParams): void {
  if (role === OrganizationRoles.BASE && blockBaseEntirely) {
    throw new ShelfError({
      cause: null,
      label: "Booking",
      message: `You are not authorized to ${action} this booking.`,
      status: 403,
      shouldBeCaptured: false,
    });
  }

  if (OWNERSHIP_RESTRICTED_ROLES.includes(role)) {
    const isBookingOwner = checkCustodianOnly
      ? booking.custodianUserId === userId
      : booking.creatorId === userId || booking.custodianUserId === userId;

    if (!isBookingOwner) {
      throw new ShelfError({
        cause: null,
        label: "Booking",
        message: `You are not authorized to ${action} this booking.`,
        status: 403,
        shouldBeCaptured: false,
      });
    }
  }

  // ADMIN and OWNER roles are implicitly allowed - no check needed
}
