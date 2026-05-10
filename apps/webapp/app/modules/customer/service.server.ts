/**
 * Customer Admin Service
 *
 * Read + light-write operations for the Fieldkit customer admin pages
 * (`/customers`, `/customers/$id`). Customer master data is *read-only* in
 * shelf — Carbon is the source of truth and any edits there flow back via
 * the carbon-sync webhook. The only writes performed here are on
 * `CustomerContactPermission` toggles, which are shelf-local.
 *
 * @see {@link file://./../carbon-sync/service.server.ts} Customer mirror writes
 * @see {@link file://./../../routes/_layout+/customers._index.tsx} List route
 * @see {@link file://./../../routes/_layout+/customers.$customerId.tsx} Detail route
 */

import type { CustomerContactPermission, Prisma } from "@prisma/client";

import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

/**
 * Lists Carbon-synced customers in an organization, optionally filtered by
 * status / search. Sorts archived to the bottom by default.
 */
export async function listCustomers(args: {
  organizationId: string;
  search?: string;
  includeArchived?: boolean;
  page?: number;
  perPage?: number;
}) {
  const {
    organizationId,
    search,
    includeArchived = false,
    page = 1,
    perPage = 25,
  } = args;

  const where: Prisma.CustomerWhereInput = {
    organizationId,
    ...(includeArchived ? {} : { status: "ACTIVE" }),
    ...(search
      ? {
          OR: [
            { displayName: { contains: search, mode: "insensitive" } },
            { billingEmail: { contains: search, mode: "insensitive" } },
            { carbonCustomerId: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [customers, total] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: [
        { status: "asc" }, // ACTIVE before ARCHIVED alphabetically
        { displayName: "asc" },
      ],
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        displayName: true,
        billingEmail: true,
        status: true,
        carbonCustomerId: true,
        syncedAt: true,
        archivedAt: true,
        _count: {
          select: { contacts: true, assets: true },
        },
      },
    }),
    db.customer.count({ where }),
  ]);

  return { customers, total, page, perPage };
}

/**
 * Fetches a single customer with its contact list and a small slice of asset
 * stats. Throws 404 if the customer doesn't exist in this org.
 */
export async function getCustomerDetail(args: {
  organizationId: string;
  customerId: string;
}) {
  const customer = await db.customer.findFirst({
    where: { id: args.customerId, organizationId: args.organizationId },
    include: {
      contacts: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          carbonContactId: true,
          customerContactPermission: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { assets: true } },
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

  return customer;
}

/**
 * Updates one contact's `CustomerContactPermission` toggles. Caller is
 * responsible for verifying the current admin has rights (we expect
 * `requirePermission({ entity: customer, action: update })` upstream).
 *
 * The contact must belong to a customer in the given organization — we
 * cross-check to prevent any URL-id swapping from updating a stranger's
 * permissions.
 */
export async function updateContactPermissions(args: {
  organizationId: string;
  customerId: string;
  contactUserId: string;
  patch: Partial<
    Pick<
      CustomerContactPermission,
      | "canRequestShipment"
      | "canRequestReturn"
      | "canRentInventory"
      | "canViewBilling"
      | "canManageOtherContacts"
    >
  >;
}) {
  // Cross-check linkage. One query, fails closed.
  const contact = await db.user.findFirst({
    where: {
      id: args.contactUserId,
      fieldkitCustomerId: args.customerId,
      fieldkitCustomer: { organizationId: args.organizationId },
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
