/**
 * Customer Admin Service (FDW edition)
 *
 * Read + light-write operations for the Fieldkit customer admin pages
 * (`/customers`, `/customers/$id`).
 *
 * **Customer master data lives in Carbon ERP** and is read via Carbon's
 * REST API (`/api/sales/*`). The previous local `Customer` mirror table
 * was dropped — Shelf only stores text references to Carbon ids on the
 * `User` and `Asset` tables.
 *
 * Local writes are limited to:
 *   - `CustomerContactPermission` toggles (Shelf-local granular policy)
 *   - `User.carbonCustomerId` link (when reassigning a contact, rare)
 *
 * Carbon REST endpoint constraints:
 *   - `GET /api/sales/customers` returns `{ id, name }` only — minimal.
 *   - `GET /api/sales/customer-contacts/:customerId` returns the full
 *     junction with nested contact + user objects.
 *
 * @see {@link file://./../carbon-sync/client.server.ts} REST client
 * @see {@link file://./../../routes/_layout+/customers._index.tsx} List route
 * @see {@link file://./../../routes/_layout+/customers.$customerId.tsx} Detail route
 */

import { OrganizationRoles } from "@prisma/client";

import { db } from "~/database/db.server";
import {
  fetchCustomerById,
  listCustomerContacts,
  listCustomers as listCarbonCustomers,
} from "~/modules/carbon-sync/client.server";
import type { CarbonCustomerLite } from "~/modules/carbon-sync/client.server";
import { ShelfError } from "~/utils/error";

/**
 * Lists Carbon customers in the Fieldkit company, with Shelf-side counters
 * (number of provisioned contact Users, number of stored Assets) merged in.
 *
 * `search` filters case-insensitively against the customer name. Pagination
 * is offset/limit; Carbon's list endpoint returns the full set, so we
 * paginate client-side.
 */
export async function listCustomers(args: {
  organizationId: string;
  search?: string;
  page?: number;
  perPage?: number;
}) {
  const { organizationId, search, page = 1, perPage = 25 } = args;

  const all = await listCarbonCustomers();

  const filtered = search
    ? all.filter((c) =>
        c.name.toLowerCase().includes(search.trim().toLowerCase())
      )
    : all;

  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  const total = sorted.length;
  const slice = sorted.slice((page - 1) * perPage, page * perPage);
  const ids = slice.map((c) => c.id);

  // Batch local counters in two queries (independent of Carbon RTT).
  const [contactCounts, assetCounts] = await Promise.all([
    db.user.groupBy({
      by: ["carbonCustomerId"],
      where: {
        carbonCustomerId: { in: ids },
        userOrganizations: {
          some: {
            organizationId,
            roles: { has: OrganizationRoles.CUSTOMER },
          },
        },
      },
      _count: { _all: true },
    }),
    db.asset.groupBy({
      by: ["carbonCustomerId"],
      where: { organizationId, carbonCustomerId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const contactCountByCustomer = new Map<string, number>();
  for (const row of contactCounts) {
    if (row.carbonCustomerId)
      contactCountByCustomer.set(row.carbonCustomerId, row._count._all);
  }
  const assetCountByCustomer = new Map<string, number>();
  for (const row of assetCounts) {
    if (row.carbonCustomerId)
      assetCountByCustomer.set(row.carbonCustomerId, row._count._all);
  }

  const customers = slice.map((c) => ({
    id: c.id,
    displayName: c.name,
    contactCount: contactCountByCustomer.get(c.id) ?? 0,
    assetCount: assetCountByCustomer.get(c.id) ?? 0,
  }));

  return { customers, total, page, perPage };
}

/**
 * Detail row shape returned by {@link getCustomerDetail}.
 */
export type CustomerDetail = {
  id: string;
  displayName: string;
  /**
   * Shelf-local per-customer settings. `null` when no row has been written
   * yet — treat as all defaults (`requiresInternalApproval = false`).
   */
  setting: {
    requiresInternalApproval: boolean;
  } | null;
  contacts: Array<{
    /** Shelf User id (null when the Carbon contact has no shelf User yet). */
    userId: string | null;
    carbonContactId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    permission: {
      canRequestShipment: boolean;
      canRequestReturn: boolean;
      canRentInventory: boolean;
      canViewBilling: boolean;
      canManageOtherContacts: boolean;
      canApproveBookings: boolean;
    } | null;
  }>;
  assetCount: number;
  /**
   * Assets stored on behalf of this customer (capped at 100 to keep the
   * detail page responsive — pagination can come later if needed).
   * Sorted newest first.
   */
  assets: Array<{
    id: string;
    title: string;
    status: string;
    sequentialId: string | null;
    mainImage: string | null;
    thumbnailImage: string | null;
    kind: string;
    availableToBook: boolean;
  }>;
};

/**
 * Fetches a single Carbon customer + its contacts (joined with their Shelf
 * Users, if provisioned). Throws 404 if Carbon doesn't recognise the id.
 */
export async function getCustomerDetail(args: {
  organizationId: string;
  carbonCustomerId: string;
}): Promise<CustomerDetail> {
  const { organizationId, carbonCustomerId } = args;

  const carbon: CarbonCustomerLite | null =
    await fetchCustomerById(carbonCustomerId);
  if (!carbon) {
    throw new ShelfError({
      cause: null,
      title: "Customer not found",
      message:
        "The customer you're looking for doesn't exist or you don't have permission to view it.",
      label: "Organization",
      status: 404,
      additionalData: args,
      shouldBeCaptured: false,
    });
  }

  const carbonContacts = await listCustomerContacts(carbonCustomerId);

  // Shelf Users for these contacts, with permission rows.
  const shelfUsers = await db.user.findMany({
    where: {
      carbonContactId: { in: carbonContacts.map((c) => c.contactId) },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      carbonContactId: true,
      customerContactPermission: true,
    },
  });
  const userByContactId = new Map(
    shelfUsers
      .filter((u) => u.carbonContactId)
      .map((u) => [u.carbonContactId as string, u])
  );

  const [assetCount, assetRows, setting] = await Promise.all([
    db.asset.count({ where: { organizationId, carbonCustomerId } }),
    db.asset.findMany({
      where: { organizationId, carbonCustomerId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        title: true,
        status: true,
        sequentialId: true,
        mainImage: true,
        thumbnailImage: true,
        kind: true,
        availableToBook: true,
      },
    }),
    db.customerSetting.findUnique({
      where: { carbonCustomerId },
      select: { requiresInternalApproval: true },
    }),
  ]);

  const contacts: CustomerDetail["contacts"] = carbonContacts.map((row) => {
    const user = userByContactId.get(row.contactId);
    return {
      userId: user?.id ?? null,
      carbonContactId: row.contactId,
      email: user?.email ?? row.contact.email,
      firstName: user?.firstName ?? row.contact.firstName,
      lastName: user?.lastName ?? row.contact.lastName,
      permission: user?.customerContactPermission ?? null,
    };
  });

  return {
    id: carbon.id,
    displayName: carbon.name,
    setting,
    contacts,
    assetCount,
    assets: assetRows,
  };
}

/**
 * Upsert the Shelf-local `CustomerSetting` row for a Carbon customer.
 * Creates the row on first write since CustomerSetting is lazy — no row =
 * defaults apply.
 *
 * Caller is responsible for verifying admin rights upstream
 * (`requirePermission({ entity: customer, action: update })`).
 */
export async function upsertCustomerSetting(args: {
  organizationId: string;
  carbonCustomerId: string;
  patch: { requiresInternalApproval?: boolean };
}) {
  return db.customerSetting.upsert({
    where: { carbonCustomerId: args.carbonCustomerId },
    create: {
      carbonCustomerId: args.carbonCustomerId,
      organizationId: args.organizationId,
      requiresInternalApproval: args.patch.requiresInternalApproval ?? false,
    },
    update: {
      requiresInternalApproval: args.patch.requiresInternalApproval,
    },
  });
}

/**
 * Updates one contact's `CustomerContactPermission` toggles. Caller is
 * responsible for verifying the current admin has rights (we expect
 * `requirePermission({ entity: customer, action: update })` upstream).
 */
export async function updateContactPermissions(args: {
  organizationId: string;
  carbonCustomerId: string;
  contactUserId: string;
  patch: {
    canRequestShipment?: boolean;
    canRequestReturn?: boolean;
    canRentInventory?: boolean;
    canViewBilling?: boolean;
    canManageOtherContacts?: boolean;
    canApproveBookings?: boolean;
  };
}) {
  // Cross-check linkage before writing.
  const contact = await db.user.findFirst({
    where: {
      id: args.contactUserId,
      carbonCustomerId: args.carbonCustomerId,
      userOrganizations: {
        some: {
          organizationId: args.organizationId,
          roles: { has: OrganizationRoles.CUSTOMER },
        },
      },
    },
    select: { id: true },
  });
  if (!contact) {
    throw new ShelfError({
      cause: null,
      title: "Contact not found",
      message:
        "Cannot update permissions for a contact that does not belong to this customer.",
      label: "Organization",
      status: 404,
      additionalData: args,
      shouldBeCaptured: true,
    });
  }

  return db.customerContactPermission.upsert({
    where: { userId: args.contactUserId },
    create: {
      userId: args.contactUserId,
      ...args.patch,
    },
    update: args.patch,
  });
}
