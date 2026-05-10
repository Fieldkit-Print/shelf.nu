/**
 * Carbon Sync — Upsert Service
 *
 * Idempotent handlers that translate Carbon's webhook events into shelf's
 * local mirror (`Customer` table + `User` rows tagged with
 * `fieldkitCustomerId`). Safe to call repeatedly with the same payload.
 *
 * Carbon emits events on three tables:
 *
 *   - `customer`         → master record. We mirror to `Customer`.
 *   - `customerContact`  → junction linking a contact to a customer. INSERT
 *                          provisions a shelf User; DELETE clears the link.
 *   - `contact`          → contact master (email/name). UPDATE refreshes
 *                          the matching shelf User.
 *
 * Concurrency: Carbon webhooks can arrive faster than reconciliation runs.
 * We use Postgres upserts on unique keys
 * (`(organizationId, carbonCustomerId)` and `User.carbonContactId`) so
 * concurrent calls collapse to last-writer-wins, which matches Carbon's
 * source-of-truth model.
 *
 * @see {@link file://./types.ts}              Shapes
 * @see {@link file://./client.server.ts}      Carbon Supabase client
 * @see {@link file://./invite.server.ts}      First-contact magic-link invite
 * @see {@link file://./reconciliation.server.ts} Nightly cron entrypoint
 * @see {@link file://./webhook.server.ts}     Webhook entry point
 */

import { OrganizationRoles } from "@prisma/client";

import { db } from "~/database/db.server";
import { FIELDKIT_PRIMARY_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";

import { fetchContactById, fetchCustomerById } from "./client.server";
import { sendCustomerContactInvite } from "./invite.server";
import type {
  CarbonContact,
  CarbonCustomer,
  CarbonCustomerContact,
} from "./types";

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
// Customer master upserts
// =============================================================================

/**
 * Upserts a customer record from Carbon into shelf's mirror.
 *
 * Carbon doesn't have an `archived` boolean — it uses `mergedIntoCustomerId`
 * as a soft-archive signal. We mirror that to `Customer.status = ARCHIVED`.
 * Hard `DELETE` events go through {@link archiveCustomerFromCarbon} instead.
 *
 * `Customer.billingEmail` is left untouched here; it gets populated lazily
 * the first time a contact for this customer syncs (see
 * {@link upsertContactLink}).
 *
 * @returns The resulting shelf `Customer.id`.
 */
export async function upsertCustomerFromCarbon(carbon: CarbonCustomer) {
  const organizationId = getPrimaryOrganizationId();

  const isMerged = Boolean(carbon.mergedIntoCustomerId);
  const status = isMerged ? "ARCHIVED" : "ACTIVE";
  const archivedAt = isMerged ? new Date() : null;

  const customer = await db.customer.upsert({
    where: {
      organizationId_carbonCustomerId: {
        organizationId,
        carbonCustomerId: carbon.id,
      },
    },
    create: {
      organizationId,
      carbonCustomerId: carbon.id,
      displayName: carbon.name,
      status,
      archivedAt,
      syncedAt: new Date(),
    },
    update: {
      displayName: carbon.name,
      status,
      // Only stamp archivedAt the first time the customer is archived; clear
      // it if Carbon un-archives. Avoids "archive timestamp keeps moving".
      archivedAt,
      syncedAt: new Date(),
    },
    select: { id: true },
  });

  return customer.id;
}

/**
 * Marks a customer as archived in shelf. Used for Carbon `customer` DELETE
 * events. Hard-delete is intentionally avoided — historical billing data
 * must remain resolvable.
 */
export async function archiveCustomerFromCarbon(carbonCustomerId: string) {
  const organizationId = getPrimaryOrganizationId();
  await db.customer.updateMany({
    where: { organizationId, carbonCustomerId },
    data: {
      status: "ARCHIVED",
      archivedAt: new Date(),
      syncedAt: new Date(),
    },
  });
}

// =============================================================================
// Customer ↔ Contact link (junction events)
// =============================================================================

/**
 * Handles a `customerContact` INSERT/UPDATE event. The junction payload
 * carries only ids; we fetch the parent customer + the contact details
 * from Carbon, ensure both mirror rows exist, and link them.
 *
 * Side effects:
 *   1. Customer row upserted (if not already present)
 *   2. User row upserted with `fieldkitCustomerId = customer.id`
 *   3. UserOrganization upserted with role CUSTOMER
 *   4. CustomerContactPermission upserted with conservative defaults
 *   5. TeamMember row created (so booking flows that key on TeamMember work)
 *   6. Magic-link invite sent if the User is brand-new
 *
 * @returns The shelf `User.id` of the linked contact.
 */
export async function upsertContactLink(payload: CarbonCustomerContact) {
  const organizationId = getPrimaryOrganizationId();

  // Step 1: ensure the parent Customer exists. The junction event can
  // arrive before the customer event (rare but observed in practice).
  let customer = await db.customer.findUnique({
    where: {
      organizationId_carbonCustomerId: {
        organizationId,
        carbonCustomerId: payload.customerId,
      },
    },
    select: { id: true, status: true },
  });

  if (!customer) {
    const carbonCustomer = await fetchCustomerById(payload.customerId);
    if (!carbonCustomer) {
      throw new ShelfError({
        cause: null,
        message: `Carbon customer ${payload.customerId} not found while syncing contact link.`,
        additionalData: { carbonCustomerId: payload.customerId },
        label: "Carbon Sync",
      });
    }
    const upsertedId = await upsertCustomerFromCarbon(carbonCustomer);
    customer = { id: upsertedId, status: "ACTIVE" };
  }

  // Step 2: fetch contact details (the junction row only has the id).
  const carbonContact = await fetchContactById(payload.contactId);
  if (!carbonContact) {
    throw new ShelfError({
      cause: null,
      message: `Carbon contact ${payload.contactId} not found while syncing link.`,
      additionalData: { carbonContactId: payload.contactId },
      label: "Carbon Sync",
    });
  }

  return upsertUserFromContact({
    organizationId,
    customerId: customer.id,
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
    select: { id: true, fieldkitCustomerId: true },
  });
  if (!user) return;

  // Cross-check: only unlink if this user is currently linked to the
  // customer the junction row referenced. Prevents a stale junction
  // delete from clobbering a contact who was reassigned to a different
  // customer in the meantime.
  const targetCustomer = await db.customer.findUnique({
    where: {
      organizationId_carbonCustomerId: {
        organizationId,
        carbonCustomerId: payload.customerId,
      },
    },
    select: { id: true },
  });
  if (!targetCustomer || user.fieldkitCustomerId !== targetCustomer.id) return;

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { fieldkitCustomerId: null },
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
 * Carbon contact, its email/name fields are refreshed. INSERT/DELETE on
 * the `contact` table by itself doesn't matter to shelf — the `customerContact`
 * junction is the trigger for provisioning.
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
      // Don't lower-case the new email here — `User.email` is unique and
      // a stored email mismatch with Carbon would create drift on every
      // subsequent sync. Carbon already lowercases; if not, this drifts
      // once and then stabilises.
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
 * linked to a shelf Customer. Used by both the webhook path
 * ({@link upsertContactLink}) and the reconciliation path.
 *
 * Idempotent. Returns the shelf `User.id`.
 */
export async function upsertUserFromContact(args: {
  organizationId: string;
  customerId: string;
  carbonContact: CarbonContact;
}) {
  const { organizationId, customerId, carbonContact } = args;

  // Step 1: locate the User by carbonContactId, then by email as fallback
  // (covers the case where a former staff/SSO user becomes a customer
  // contact and we want to reuse their existing account).
  const existingByContactId = await db.user.findUnique({
    where: { carbonContactId: carbonContact.id },
    select: { id: true, fieldkitCustomerId: true, email: true },
  });

  let user = existingByContactId;
  let isNewUser = false;

  if (!user) {
    const existingByEmail = await db.user.findUnique({
      where: { email: carbonContact.email.toLowerCase() },
      select: { id: true, fieldkitCustomerId: true, carbonContactId: true },
    });

    if (existingByEmail) {
      // Refuse to overwrite an existing carbonContactId — that would mean
      // the same email already maps to a different Carbon contact. Bail
      // loudly so an admin can investigate.
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
          fieldkitCustomerId: customerId,
        },
        select: { id: true, fieldkitCustomerId: true, email: true },
      });
    } else {
      isNewUser = true;
      user = await db.user.create({
        data: {
          email: carbonContact.email.toLowerCase(),
          firstName: carbonContact.firstName,
          lastName: carbonContact.lastName,
          carbonContactId: carbonContact.id,
          fieldkitCustomerId: customerId,
          // Bypasses paid-tier checks; we don't run those for customer
          // contacts anyway.
          createdWithInvite: true,
        },
        select: { id: true, fieldkitCustomerId: true, email: true },
      });
    }
  } else if (user.fieldkitCustomerId !== customerId) {
    // Contact moved to a different customer.
    user = await db.user.update({
      where: { id: user.id },
      data: { fieldkitCustomerId: customerId },
      select: { id: true, fieldkitCustomerId: true, email: true },
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

  // Step 5: lazily backfill Customer.billingEmail if it isn't set yet.
  // Carbon doesn't have a "primary contact" flag, so we use first-wins.
  await db.customer.updateMany({
    where: { id: customerId, billingEmail: null },
    data: { billingEmail: carbonContact.email.toLowerCase() },
  });

  // Step 6: send magic-link invite for net-new users. Fire-and-forget; we
  // log on failure but never throw, because sync correctness is more
  // important than email deliverability.
  if (isNewUser) {
    void sendCustomerContactInvite({
      userId: user.id,
      email: user.email,
      organizationId,
      customerId,
    }).catch(() => {
      // Logged inside sendCustomerContactInvite; intentionally swallowed.
    });
  }

  return user.id;
}
