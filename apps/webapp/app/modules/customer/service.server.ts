/**
 * Customer Admin Service
 *
 * Read + write operations for the customer admin pages (`/customers`,
 * `/customers/$id`). Customer master data is Shelf-native, held in the local
 * `Customer` table. Contacts are CUSTOMER-role `User`s linked via
 * `User.fieldkitCustomerId`.
 *
 * @see {@link file://./../../routes/_layout+/customers._index.tsx} List route
 * @see {@link file://./../../routes/_layout+/customers.$customerId.tsx} Detail route
 */

import { OrganizationRoles } from "@prisma/client";

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

/**
 * Lists customers in an organization, with Shelf-side counters (number of
 * provisioned contact Users, number of stored Assets) merged in.
 *
 * `search` filters case-insensitively against the customer name. Pagination
 * is offset/limit.
 *
 * @param args.organizationId - The org whose customers to list
 * @param args.search - Optional case-insensitive name filter
 * @param args.page - 1-based page number (default 1)
 * @param args.perPage - Page size (default 25)
 * @returns The page of customers plus the total count
 */
export async function listCustomers(args: {
  organizationId: string;
  search?: string;
  page?: number;
  perPage?: number;
}) {
  const { organizationId, search, page = 1, perPage = 25 } = args;

  const where = {
    organizationId,
    ...(search
      ? { name: { contains: search.trim(), mode: "insensitive" as const } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true },
    }),
    db.customer.count({ where }),
  ]);

  const ids = rows.map((c) => c.id);

  // Customer has no relation fields (scalar refs only), so counts are
  // aggregated with groupBy over the scalar customer keys.
  const [contactCounts, assetCounts] = await Promise.all([
    db.user.groupBy({
      by: ["fieldkitCustomerId"],
      where: { fieldkitCustomerId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
    db.asset.groupBy({
      by: ["customerId"],
      where: { organizationId, customerId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const contactCountByCustomer = new Map<string, number>();
  for (const row of contactCounts) {
    if (row.fieldkitCustomerId)
      contactCountByCustomer.set(row.fieldkitCustomerId, row._count._all);
  }
  const assetCountByCustomer = new Map<string, number>();
  for (const row of assetCounts) {
    if (row.customerId)
      assetCountByCustomer.set(row.customerId, row._count._all);
  }

  const customers = rows.map((c) => ({
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
  billingEmail: string | null;
  notes: string | null;
  /** Whether requests from this customer's contacts need internal approval. */
  requiresInternalApproval: boolean;
  shipToName: string | null;
  shipToStreet1: string | null;
  shipToStreet2: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
  shipToCountry: string | null;
  contacts: Array<{
    /** Shelf User id (contacts are always Users in the native model). */
    userId: string;
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
   * detail page responsive). Sorted newest first.
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
 * Fetches a single customer with its contacts (CUSTOMER-role Users) and a
 * sample of its stored assets. Throws 404 if the customer doesn't exist in
 * the org.
 *
 * @param args.organizationId - The caller's organization
 * @param args.customerId - The Customer id
 * @returns The customer detail
 * @throws {ShelfError} 404 when the customer is not found in the org
 */
export async function getCustomerDetail(args: {
  organizationId: string;
  customerId: string;
}): Promise<CustomerDetail> {
  const { organizationId, customerId } = args;

  const customer = await db.customer.findFirst({
    where: { id: customerId, organizationId },
    select: {
      id: true,
      name: true,
      billingEmail: true,
      notes: true,
      requiresInternalApproval: true,
      shipToName: true,
      shipToStreet1: true,
      shipToStreet2: true,
      shipToCity: true,
      shipToState: true,
      shipToPostalCode: true,
      shipToCountry: true,
    },
  });

  if (!customer) {
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

  // Contacts are CUSTOMER-role Users linked by scalar `fieldkitCustomerId`
  // (Customer has no relation fields — see the model comment). Query them
  // directly rather than via an include.
  const [assetCount, assetRows, contactUsers] = await Promise.all([
    db.asset.count({ where: { organizationId, customerId } }),
    db.asset.findMany({
      where: { organizationId, customerId },
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
    db.user.findMany({
      where: { fieldkitCustomerId: customerId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        customerContactPermission: true,
      },
    }),
  ]);

  const contacts: CustomerDetail["contacts"] = contactUsers.map((user) => ({
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    permission: user.customerContactPermission ?? null,
  }));

  return {
    id: customer.id,
    displayName: customer.name,
    billingEmail: customer.billingEmail,
    notes: customer.notes,
    requiresInternalApproval: customer.requiresInternalApproval,
    shipToName: customer.shipToName,
    shipToStreet1: customer.shipToStreet1,
    shipToStreet2: customer.shipToStreet2,
    shipToCity: customer.shipToCity,
    shipToState: customer.shipToState,
    shipToPostalCode: customer.shipToPostalCode,
    shipToCountry: customer.shipToCountry,
    contacts,
    assetCount,
    assets: assetRows,
  };
}

/** Fields settable when creating or editing a customer. */
export type CustomerUpsertPatch = {
  name?: string;
  billingEmail?: string | null;
  notes?: string | null;
  requiresInternalApproval?: boolean;
  shipToName?: string | null;
  shipToStreet1?: string | null;
  shipToStreet2?: string | null;
  shipToCity?: string | null;
  shipToState?: string | null;
  shipToPostalCode?: string | null;
  shipToCountry?: string | null;
};

// Customers are not created in Shelf. Productive is the system of record for
// customer master data, and `modules/productive/sync.server.ts` mirrors it in.
// A `createCustomer` here would let a row exist with no `productiveCompanyId`,
// which the billing push cannot attribute and would silently skip.

/**
 * Updates a customer's editable fields. Scoped to the organization so a
 * caller can't mutate another org's customer.
 *
 * @param args.organizationId - The caller's organization
 * @param args.customerId - The Customer to update
 * @param args.patch - Partial fields to change
 * @returns The updated Customer
 * @throws {ShelfError} 404 when the customer is not found in the org
 */
export async function updateCustomer(args: {
  organizationId: string;
  customerId: string;
  patch: CustomerUpsertPatch;
}) {
  const { organizationId, customerId, patch } = args;

  const existing = await db.customer.findFirst({
    where: { id: customerId, organizationId },
    select: { id: true },
  });
  if (!existing) {
    throw new ShelfError({
      cause: null,
      title: "Customer not found",
      message:
        "Cannot update a customer that does not exist in this workspace.",
      label: "Organization",
      status: 404,
      additionalData: args,
      shouldBeCaptured: false,
    });
  }

  return db.customer.update({
    where: { id: customerId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.billingEmail !== undefined
        ? { billingEmail: patch.billingEmail }
        : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.requiresInternalApproval !== undefined
        ? { requiresInternalApproval: patch.requiresInternalApproval }
        : {}),
      ...(patch.shipToName !== undefined
        ? { shipToName: patch.shipToName }
        : {}),
      ...(patch.shipToStreet1 !== undefined
        ? { shipToStreet1: patch.shipToStreet1 }
        : {}),
      ...(patch.shipToStreet2 !== undefined
        ? { shipToStreet2: patch.shipToStreet2 }
        : {}),
      ...(patch.shipToCity !== undefined
        ? { shipToCity: patch.shipToCity }
        : {}),
      ...(patch.shipToState !== undefined
        ? { shipToState: patch.shipToState }
        : {}),
      ...(patch.shipToPostalCode !== undefined
        ? { shipToPostalCode: patch.shipToPostalCode }
        : {}),
      ...(patch.shipToCountry !== undefined
        ? { shipToCountry: patch.shipToCountry }
        : {}),
    },
  });
}

/**
 * Updates one contact's `CustomerContactPermission` toggles. Caller is
 * responsible for verifying the current admin has rights (we expect
 * `requirePermission({ entity: customer, action: update })` upstream).
 *
 * @param args.organizationId - The caller's organization
 * @param args.customerId - The customer the contact belongs to
 * @param args.contactUserId - The contact User whose permissions to change
 * @param args.patch - Partial permission toggles
 * @returns The upserted CustomerContactPermission
 * @throws {ShelfError} 404 when the contact isn't linked to this customer
 */
export async function updateContactPermissions(args: {
  organizationId: string;
  customerId: string;
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
      fieldkitCustomerId: args.customerId,
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
