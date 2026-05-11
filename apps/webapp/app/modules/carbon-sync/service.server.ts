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

import {
  fetchContactInCustomer,
  setTrackedEntityShelfAssetId,
} from "./client.server";
import { sendCustomerContactInvite } from "./invite.server";
import type {
  CarbonContact,
  CarbonCustomerContact,
  CarbonItem,
  CarbonItemLedger,
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
 * Handles `item` INSERT/UPDATE webhook events.
 *
 * Behaviour split by tracking type:
 *   - **CONSUMABLE** (Inventory / Batch with `visibleInShelf=true`):
 *     upserts exactly one Shelf Asset per item, keyed on `carbonPartId`.
 *   - **INSTANCE** (Serial): does NOT mint new Assets here. INSTANCE
 *     Assets are minted from `itemLedger` receipts via
 *     {@link upsertAssetFromItemLedger}. This handler instead refreshes
 *     shared display fields (title, description, thumbnail) on every
 *     existing Shelf Asset linked to this item, so a name change in
 *     Carbon propagates to all units immediately.
 *
 * If the item no longer qualifies (deactivated, visibleInShelf flipped
 * off, etc.), all linked Assets are flipped to `availableToBook=false`.
 *
 * Idempotent: safe to call repeatedly with the same payload.
 */
export async function upsertItemForShelf(item: CarbonItem) {
  const organizationId = getPrimaryOrganizationId();
  const kind = shelfAssetKindFor(item);

  if (!kind) {
    // Either visibility was turned off, the item was deactivated, or it's
    // Non-Inventory. Archive every Asset row that points at this
    // carbonPartId so they stop appearing in booking forms — applies to
    // both INSTANCE serial units and CONSUMABLE rows.
    await db.asset.updateMany({
      where: { organizationId, carbonPartId: item.id },
      data: { availableToBook: false },
    });
    return null;
  }

  // INSTANCE path: refresh shared fields on every linked Asset (one per
  // serial unit). No new Asset is created here — that's the itemLedger
  // handler's job, since "this physical unit exists" depends on a
  // receipt event, not on the item master row.
  if (kind === "INSTANCE") {
    const updated = await db.asset.updateMany({
      where: { organizationId, carbonPartId: item.id },
      data: {
        description: item.description ?? null,
        thumbnailImage: item.thumbnailUrl ?? null,
        availableToBook: true,
        kind,
      },
    });
    Logger.dev("[Carbon Sync] Refreshed INSTANCE assets for item", {
      carbonPartId: item.id,
      assetsRefreshed: updated.count,
    });
    return null;
  }

  // CONSUMABLE path: one Asset per item, keyed on carbonPartId.
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

  // Find the consumable Asset for this item (regardless of legacy kind
  // state) or create a new one.
  const existing = await db.asset.findFirst({
    where: {
      organizationId,
      carbonPartId: item.id,
      carbonTrackedEntityId: null,
    },
    select: { id: true },
  });

  if (existing) {
    await db.asset.update({
      where: { id: existing.id },
      data: {
        title: item.name,
        description: item.description ?? undefined,
        thumbnailImage: item.thumbnailUrl ?? undefined,
        availableToBook: true,
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

  Logger.info("[Carbon Sync] Provisioned CONSUMABLE Shelf asset", {
    assetId: created.id,
    carbonPartId: item.id,
  });
  return created.id;
}

/**
 * Handles `item` DELETE webhook events. Archives any matching Asset rows
 * (both CONSUMABLE and INSTANCE) — never hard-deletes, since historical
 * bookings/audit events reference them.
 */
export async function archiveItemFromShelf(carbonPartId: string) {
  const organizationId = getPrimaryOrganizationId();
  await db.asset.updateMany({
    where: { organizationId, carbonPartId },
    data: { availableToBook: false },
  });
}

// =============================================================================
// INSTANCE provisioning from itemLedger receipts
// =============================================================================

/**
 * Row shape from `carbon_remote.v1_tracked_entities` (FDW). Snake-case
 * columns reflect the contract view defined in CONTRACT_VIEWS_CARBON.sql.
 */
type TrackedEntityFdwRow = {
  id: string;
  readable_id: string | null;
  status: string;
  attributes: Record<string, unknown> | null;
  company_id: string;
};

/**
 * Row shape from `carbon_remote.v1_parts` (FDW) for the columns Shelf
 * needs to mint an INSTANCE Asset from a ledger event.
 */
type PartFdwRow = {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  tracking_type: "Serial" | "Batch" | "Inventory" | "Non-Inventory";
  thumbnail_url: string | null;
  active: boolean;
  visible_in_shelf: boolean;
  standard_cost: number | null;
};

/**
 * Provisions (or refreshes) a single Shelf INSTANCE Asset for a Carbon
 * `trackedEntity` (one physical serial-tracked unit). Triggered from
 * positive-quantity `itemLedger` INSERT webhooks — the "this serial just
 * landed in inventory" signal.
 *
 * The Asset is keyed on `carbonTrackedEntityId` (one Shelf Asset per
 * physical Carbon unit) and decorated with:
 *   - `title`           — `<item.name> #<serialNumber>`
 *   - `description`     — copied from item
 *   - `thumbnailImage`  — copied from item
 *   - `carbonPartId`    — link to the parent SKU
 *   - `valuation`       — Carbon's `itemCost.standardCost` (Phase 2)
 *
 * On creation, fire-and-forgets a callback that writes the new Shelf
 * sequentialId back into Carbon's `trackedEntity.attributes` so the ID
 * is discoverable from the Carbon side (Phase 3).
 *
 * @returns Created/existing `Asset.id`, or `null` when the item isn't
 *   Serial-tracked (e.g. the ledger row was for a batch-tracked item) or
 *   no longer active.
 */
export async function upsertAssetFromItemLedger(
  ledger: CarbonItemLedger
): Promise<string | null> {
  const organizationId = getPrimaryOrganizationId();
  const trackedEntityId = ledger.trackedEntityId;
  if (!trackedEntityId) return null;

  // FDW reads. Wrapped in arrays because `$queryRaw` returns `unknown`
  // shaped as a row array — we cast and pick the first match.
  const [trackedRows, partRows] = await Promise.all([
    db.$queryRaw<TrackedEntityFdwRow[]>`
      SELECT id, readable_id, status, attributes, company_id
      FROM carbon_remote.v1_tracked_entities
      WHERE id = ${trackedEntityId}
      LIMIT 1
    `,
    db.$queryRaw<PartFdwRow[]>`
      SELECT id, sku, name, description, tracking_type, thumbnail_url,
             active, visible_in_shelf, standard_cost
      FROM carbon_remote.v1_parts
      WHERE id = ${ledger.itemId}
      LIMIT 1
    `,
  ]);

  const trackedEntity = trackedRows[0];
  const item = partRows[0];

  if (!trackedEntity) {
    Logger.warn("[Carbon Sync] itemLedger references unknown trackedEntity", {
      ledgerId: ledger.id,
      trackedEntityId,
    });
    return null;
  }
  if (!item) {
    Logger.warn("[Carbon Sync] itemLedger references unknown item", {
      ledgerId: ledger.id,
      itemId: ledger.itemId,
    });
    return null;
  }

  // Gate: only Serial items mint INSTANCE Assets via this path. Batch /
  // Inventory items take the item-keyed CONSUMABLE path in
  // upsertItemForShelf.
  if (item.tracking_type !== "Serial" || !item.active) {
    return null;
  }

  const owner = await db.organization.findUnique({
    where: { id: organizationId },
    select: { userId: true },
  });
  if (!owner) {
    throw new ShelfError({
      cause: null,
      message: `Primary organization ${organizationId} not found while minting INSTANCE asset.`,
      label: "Carbon Sync",
    });
  }

  const serialDisplay = trackedEntity.readable_id ?? trackedEntity.id;
  const title = `${item.name} #${serialDisplay}`;

  const existing = await db.asset.findUnique({
    where: { carbonTrackedEntityId: trackedEntityId },
    select: { id: true, sequentialId: true },
  });

  if (existing) {
    await db.asset.update({
      where: { id: existing.id },
      data: {
        title,
        description: item.description ?? undefined,
        thumbnailImage: item.thumbnail_url ?? undefined,
        valuation: item.standard_cost,
        kind: "INSTANCE",
        carbonPartId: item.id,
        availableToBook: true,
      },
    });
    // Best-effort sync of the Shelf id back to Carbon, in case the
    // attribute didn't land last time (e.g. earlier Carbon outage).
    if (existing.sequentialId) {
      void setTrackedEntityShelfAssetId({
        carbonTrackedEntityId: trackedEntityId,
        shelfAssetId: existing.sequentialId,
        currentAttributes: trackedEntity.attributes,
      }).catch(() => {
        // Already logged inside the helper. Don't block the upsert.
      });
    }
    return existing.id;
  }

  const created = await db.asset.create({
    data: {
      organizationId,
      userId: owner.userId,
      title,
      description: item.description,
      thumbnailImage: item.thumbnail_url,
      valuation: item.standard_cost,
      kind: "INSTANCE",
      carbonPartId: item.id,
      carbonTrackedEntityId: trackedEntityId,
      availableToBook: true,
    },
    select: { id: true, sequentialId: true },
  });

  Logger.info("[Carbon Sync] Provisioned INSTANCE Shelf asset from ledger", {
    assetId: created.id,
    carbonPartId: item.id,
    carbonTrackedEntityId: trackedEntityId,
    ledgerId: ledger.id,
    serial: serialDisplay,
  });

  // Phase 3: push Shelf's sequentialId back into Carbon's
  // trackedEntity.attributes so staff in Carbon can see (and click
  // through to) the Shelf asset. Best-effort.
  if (created.sequentialId) {
    void setTrackedEntityShelfAssetId({
      carbonTrackedEntityId: trackedEntityId,
      shelfAssetId: created.sequentialId,
      currentAttributes: trackedEntity.attributes,
    }).catch(() => {
      // Already logged inside the helper. Don't block the upsert.
    });
  }

  return created.id;
}
