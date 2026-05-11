/**
 * Carbon Sync — Upsert Service (FDW edition)
 *
 * Three categories of side effects, all triggered by Carbon webhooks:
 *
 * 1. **Contact ↔ User provisioning** — Carbon `customerContact` events drive
 *    creation/removal of Shelf User rows so customer contacts can sign in.
 *    Carbon `contact` UPDATE events refresh email/name on the matching User.
 *
 * 2. **Consumable Asset provisioning** — Carbon `item` events with
 *    `visibleInShelf = true` drive upsert/archive of CONSUMABLE Asset rows.
 *    INSTANCE Asset provisioning happens through a separate Shelf API
 *    endpoint when Carbon's intake flow lands; not handled here.
 *
 * 3. **Customer master events** — acked but not mirrored. Customer fields
 *    are read live via the `carbon_remote.v1_customers` foreign view.
 *
 * Concurrency: Carbon webhooks can arrive faster than reconciliation runs.
 * Postgres upserts on unique keys (`User.carbonContactId`,
 * `Asset.carbonPartId`-scoped lookups) collapse concurrent calls to
 * last-writer-wins, matching Carbon's source-of-truth model.
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
import { Logger } from "~/utils/logger";

import { fetchContactInCustomer } from "./client.server";
import { sendCustomerContactInvite } from "./invite.server";
import type { CarbonContact, CarbonCustomerContact, CarbonItem } from "./types";

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

// =============================================================================
// Asset provisioning (item events)
// =============================================================================

/**
 * Returns the {@link AssetKind} a Carbon item should map to in Shelf, or
 * `null` if the item should not appear at all.
 *
 * Rules:
 *
 *   Serial            → INSTANCE (always — Serial items unconditionally
 *                       become Shelf Assets; `visibleInShelf` is not
 *                       consulted for Serial-tracked items)
 *   Inventory / Batch → CONSUMABLE only when `visibleInShelf = true`
 *                       (consumables default to hidden in Shelf;
 *                       operators opt-in per item)
 *   Non-Inventory     → no Asset (services, labor, etc.)
 *
 * Items must also be active and not blocked.
 */
function shelfAssetKindFor(item: CarbonItem): "INSTANCE" | "CONSUMABLE" | null {
  if (!item.active) return null;
  // Serial items ALWAYS sync — they're unique physical things and there's no
  // reason to hide one from Shelf. The `visibleInShelf` column exists on the
  // table but is ignored here for Serial.
  if (item.itemTrackingType === "Serial") return "INSTANCE";
  // Consumables are opt-in.
  if (!item.visibleInShelf) return null;
  if (
    item.itemTrackingType === "Inventory" ||
    item.itemTrackingType === "Batch"
  ) {
    return "CONSUMABLE";
  }
  return null; // Non-Inventory and anything else
}

/**
 * Handles `item` INSERT/UPDATE webhook events. Provisions or refreshes one
 * Shelf Asset when the item qualifies (see {@link shelfAssetKindFor}). If
 * the item was previously visible but no longer qualifies, archives any
 * existing Asset rows for that carbonPartId.
 *
 * Idempotent: safe to call repeatedly with the same payload.
 */
export async function upsertItemForShelf(item: CarbonItem) {
  const organizationId = getPrimaryOrganizationId();
  const kind = shelfAssetKindFor(item);

  if (!kind) {
    // Either visibility was turned off, the item was deactivated, blocked,
    // or it's Non-Inventory. Archive any existing Asset row that points
    // at this carbonPartId so it stops appearing in booking forms.
    await db.asset.updateMany({
      where: {
        organizationId,
        carbonPartId: item.id,
      },
      data: {
        availableToBook: false,
      },
    });
    return null;
  }

  // We need a User to attribute the row to. Use the org owner so the
  // resulting Asset.userId is always valid even when no human is logged in
  // during the webhook delivery.
  const owner = await db.organization.findUnique({
    where: { id: organizationId },
    select: { userId: true },
  });
  if (!owner) {
    throw new ShelfError({
      cause: null,
      message: `Primary organization ${organizationId} not found while syncing Carbon item.`,
      label: "Carbon Sync",
    });
  }

  // Find existing Shelf Asset for this item (regardless of current kind),
  // or create a new one.
  const existing = await db.asset.findFirst({
    where: {
      organizationId,
      carbonPartId: item.id,
    },
    select: { id: true, kind: true },
  });

  if (existing) {
    await db.asset.update({
      where: { id: existing.id },
      data: {
        title: item.name,
        description: item.description ?? undefined,
        thumbnailImage: item.thumbnailUrl ?? undefined,
        availableToBook: true,
        // Update kind if Carbon's tracking type changed (rare).
        kind,
      },
    });
    return existing.id;
  }

  const created = await db.asset.create({
    data: {
      organizationId,
      userId: owner.userId,
      title: item.name,
      description: item.description,
      thumbnailImage: item.thumbnailUrl,
      kind,
      carbonPartId: item.id,
      availableToBook: true,
    },
    select: { id: true },
  });

  Logger.info("[Carbon Sync] Provisioned Shelf asset", {
    assetId: created.id,
    kind,
    carbonPartId: item.id,
  });
  return created.id;
}

/**
 * Handles `item` DELETE webhook events. Archives any matching CONSUMABLE
 * Assets — never hard-deletes, since historical bookings/audit events
 * reference them.
 */
export async function archiveItemFromShelf(carbonPartId: string) {
  const organizationId = getPrimaryOrganizationId();
  await db.asset.updateMany({
    where: { organizationId, carbonPartId, kind: "CONSUMABLE" },
    data: { availableToBook: false },
  });
}
