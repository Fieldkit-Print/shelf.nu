import { OrganizationRoles } from "@prisma/client";

const ROLE_RANK: Record<OrganizationRoles, number> = {
  [OrganizationRoles.OWNER]: 3,
  [OrganizationRoles.ADMIN]: 2,
  [OrganizationRoles.SELF_SERVICE]: 1,
  [OrganizationRoles.BASE]: 1,
  // CUSTOMER ranks below BASE: external customer contact, never used as a
  // promotion target. Demotion checks treat any non-CUSTOMER → CUSTOMER as a
  // demotion (rank drops to 0).
  [OrganizationRoles.CUSTOMER]: 0,
};

/**
 * Determines whether changing from `current` to `next` is a demotion.
 * A demotion means the new role has a lower rank than the current role.
 */
export function isDemotion(
  current: OrganizationRoles,
  next: OrganizationRoles
): boolean {
  return ROLE_RANK[current] > ROLE_RANK[next];
}
