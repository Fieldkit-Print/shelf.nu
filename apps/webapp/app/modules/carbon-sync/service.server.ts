/**
 * Carbon Sync — Upsert Service (FDW edition)
 *
 * Three categories of side effects, all triggered by Carbon webhooks:
 *
 * 1. **Contact ↔ User provisioning** — Carbon `customerContact` events drive
 *    creation/removal of Shelf User rows so customer contacts can sign in.
 *    Carbon `contact` UPDATE events refresh email/name on the matching User.
 *
 * 2. **Customer master events** — acked but not mirrored. Customer fields
 *    are read live via the `carbon_remote.v1_customers` foreign view.
 *
 * Asset provisioning is NOT handled here: assets are created natively in
 * Shelf, not imported from Carbon. `item` / `itemLedger` / `trackedEntity`
 * webhooks are ack-only (see {@link file://./webhook.server.ts}).
 *
 * Concurrency: Carbon webhooks can arrive faster than reconciliation runs.
 * Postgres upserts on the unique `User.carbonContactId` key collapse
 * concurrent calls to last-writer-wins, matching Carbon's source-of-truth
 * model for contacts.
 *
 * @see {@link file://./types.ts}              Shapes
 * @see {@link file://./client.server.ts}      Carbon REST client
 * @see {@link file://./invite.server.ts}      First-contact magic-link invite
 * @see {@link file://./reconciliation.server.ts} Nightly cron entrypoint
 */

import { OrganizationRoles } from "@prisma/client";

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";

import { fetchContactInCustomer } from "./client.server";
import { sendCustomerContactInvite } from "./invite.server";
import type { CarbonContact, CarbonCustomerContact } from "./types";

/**
 * Resolves the shelf Organization that hosts customer tenancy. We fail
 * loudly when missing — silently picking some org would risk importing
 * customer data into a staff workspace.
 */
function getPrimaryOrganizationId(): string {
  if (!FIELDKIT_PRIMARY_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_PRIMARY_ORGANIZATION_ID is not set. Set it to the shelf Organization id that hosts customer tenancy.",
      label: "Carbon Sync",
    });
  }
  return FIELDKIT_PRIMARY_ORGANIZATION_ID;
}

// =============================================================================
// Customer ↔ Contact link (junction events)
// =============================================================================

/**
 * Handles a `customerContact` INSERT/UPDATE event. The junction payload
 * carries only ids; we fetch the contact details from Carbon's REST API
 * and ensure a Shelf User exists with the right `carbonCustomerId` link
 * and CUSTOMER role.
 *
 * Side effects:
 *   1. User row upserted with `carbonCustomerId`, `carbonContactId`
 *   2. UserOrganization with role CUSTOMER ensured
 *   3. CustomerContactPermission row with conservative defaults
 *   4. TeamMember row created (booking flows key on TeamMember)
 *   5. Magic-link invite sent if the User is brand-new
 *
 * @returns The shelf `User.id` of the linked contact.
 */
export async function upsertContactLink(payload: CarbonCustomerContact) {
  const organizationId = getPrimaryOrganizationId();

  // Fetch contact details (the junction row only has ids).
  const carbonContact = await fetchContactInCustomer({
    carbonCustomerId: payload.customerId,
    carbonContactId: payload.contactId,
  });
  if (!carbonContact) {
    throw new ShelfError({
      cause: null,
      message: `Carbon contact ${payload.contactId} not found in customer ${payload.customerId}.`,
      additionalData: {
        carbonContactId: payload.contactId,
        carbonCustomerId: payload.customerId,
      },
      label: "Carbon Sync",
    });
  }

  return upsertUserFromContact({
    organizationId,
    carbonCustomerId: payload.customerId,
    carbonContact,
  });
}

/**
 * Handles a `customerContact` DELETE event — clears the user's link to
 * this customer. We retain the User row (they may have non-customer
 * history); only the linkage + role are stripped.
 */
export async function removeContactLink(payload: CarbonCustomerContact) {
  const organizationId = getPrimaryOrganizationId();
  const user = await db.user.findUnique({
    where: { carbonContactId: payload.contactId },
    select: { id: true, carbonCustomerId: true },
  });
  if (!user) return;

  // Cross-check: only unlink if this user is currently linked to the
  // customer the junction row referenced. Prevents a stale junction
  // delete from clobbering a contact who was reassigned to a different
  // customer in the meantime.
  if (user.carbonCustomerId !== payload.customerId) return;

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { carbonCustomerId: null },
    }),
    db.customerContactPermission.deleteMany({ where: { userId: user.id } }),
    db.userOrganization.updateMany({
      where: { userId: user.id, organizationId },
      data: { roles: { set: [] } },
    }),
  ]);
}

// =============================================================================
// Contact field updates (email/name changed in Carbon)
// =============================================================================

/**
 * Handles a `contact` UPDATE event. If a shelf User is linked to this
 * Carbon contact, its email/name fields are refreshed.
 */
export async function updateUserFromContact(carbon: CarbonContact) {
  const user = await db.user.findUnique({
    where: { carbonContactId: carbon.id },
    select: { id: true },
  });
  if (!user) return;

  await db.user.update({
    where: { id: user.id },
    data: {
      email: carbon.email,
      firstName: carbon.firstName,
      lastName: carbon.lastName,
    },
  });
}

// =============================================================================
// Internal: User row provisioning shared by webhook + reconciliation
// =============================================================================

/**
 * Internal helper that mirrors a single Carbon contact into a shelf User
 * linked (by text reference) to a Carbon customer id. Used by both the
 * webhook path ({@link upsertContactLink}) and the reconciliation path.
 *
 * Idempotent. Returns the shelf `User.id`.
 */
export async function upsertUserFromContact(args: {
  organizationId: string;
  carbonCustomerId: string;
  carbonContact: CarbonContact;
}) {
  const { organizationId, carbonCustomerId, carbonContact } = args;

  // Step 1: locate the User by carbonContactId, then by email as fallback.
  const existingByContactId = await db.user.findUnique({
    where: { carbonContactId: carbonContact.id },
    select: { id: true, carbonCustomerId: true, email: true },
  });

  let user = existingByContactId;
  let isNewUser = false;

  if (!user) {
    const existingByEmail = await db.user.findUnique({
      where: { email: carbonContact.email.toLowerCase() },
      select: { id: true, carbonCustomerId: true, carbonContactId: true },
    });

    if (existingByEmail) {
      if (
        existingByEmail.carbonContactId &&
        existingByEmail.carbonContactId !== carbonContact.id
      ) {
        throw new ShelfError({
          cause: null,
          message: `Email ${carbonContact.email} is already linked to a different Carbon contact.`,
          additionalData: {
            existingCarbonContactId: existingByEmail.carbonContactId,
            incomingCarbonContactId: carbonContact.id,
          },
          label: "Carbon Sync",
        });
      }
      user = await db.user.update({
        where: { id: existingByEmail.id },
        data: {
          carbonContactId: carbonContact.id,
          firstName: carbonContact.firstName,
          lastName: carbonContact.lastName,
          carbonCustomerId,
        },
        select: { id: true, carbonCustomerId: true, email: true },
      });
    } else {
      isNewUser = true;
      user = await db.user.create({
        data: {
          email: carbonContact.email.toLowerCase(),
          firstName: carbonContact.firstName,
          lastName: carbonContact.lastName,
          carbonContactId: carbonContact.id,
          carbonCustomerId,
          createdWithInvite: true,
        },
        select: { id: true, carbonCustomerId: true, email: true },
      });
    }
  } else if (user.carbonCustomerId !== carbonCustomerId) {
    user = await db.user.update({
      where: { id: user.id },
      data: { carbonCustomerId },
      select: { id: true, carbonCustomerId: true, email: true },
    });
  }

  // Step 2: ensure UserOrganization with CUSTOMER role.
  const membership = await db.userOrganization.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId,
      },
    },
    create: {
      userId: user.id,
      organizationId,
      roles: [OrganizationRoles.CUSTOMER],
    },
    update: {},
    select: { id: true, roles: true },
  });
  if (!membership.roles.includes(OrganizationRoles.CUSTOMER)) {
    await db.userOrganization.update({
      where: { id: membership.id },
      data: { roles: [...membership.roles, OrganizationRoles.CUSTOMER] },
    });
  }

  // Step 3: ensure CustomerContactPermission row with default toggles.
  await db.customerContactPermission.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });

  // Step 4: ensure a TeamMember row (booking flows key on this).
  const existingTeamMember = await db.teamMember.findFirst({
    where: { userId: user.id, organizationId },
    select: { id: true },
  });
  if (!existingTeamMember) {
    const fullName = [carbonContact.firstName, carbonContact.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    await db.teamMember.create({
      data: {
        organizationId,
        userId: user.id,
        name: fullName || carbonContact.email,
      },
    });
  }

  // Step 5: send magic-link invite for net-new users. Fire-and-forget; we
  // log on failure but never throw, because sync correctness is more
  // important than email deliverability.
  if (isNewUser) {
    void sendCustomerContactInvite({
      userId: user.id,
      email: user.email,
      organizationId,
      carbonCustomerId,
    }).catch(() => {
      // Logged inside sendCustomerContactInvite; intentionally swallowed.
    });
  }

  return user.id;
}
