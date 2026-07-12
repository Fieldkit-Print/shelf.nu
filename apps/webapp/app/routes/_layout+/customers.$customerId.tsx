/**
 * Customers Admin — Detail
 *
 * Shows a single customer (Shelf-native) with its contact list (CUSTOMER-role
 * Users). Each contact row exposes the granular `CustomerContactPermission`
 * toggles via an inline form that POSTs back to this route. Admins can also
 * edit the customer's details, approval setting, and pricing overrides here.
 *
 * Permissions: ADMIN/OWNER only.
 *
 * @see {@link file://./customers._index.tsx} List
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import { OrganizationRoles } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { z } from "zod";

import { AssetImage } from "~/components/assets/asset-image/component";
import { AssetStatusBadge } from "~/components/assets/asset-status-badge";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import type { CustomerDetail } from "~/modules/customer/service.server";
import {
  getCustomerDetail,
  updateContactPermissions,
  updateCustomer,
} from "~/modules/customer/service.server";

import { createInvite } from "~/modules/invite/service.server";
import { centsToDollars, dollarsToCents } from "~/modules/pricing/format";
import {
  getCustomerPricing,
  upsertCustomerPricing,
} from "~/modules/pricing/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { error, getParams, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const ParamSchema = z.object({ customerId: z.string() });

const IntentSchema = z.enum([
  "contact-permission",
  "customer-details",
  "customer-pricing",
  "invite-contact",
]);

const InviteContactSchema = z.object({
  intent: z.literal("invite-contact"),
  email: z.string().trim().email("A valid email is required"),
});

const PermissionPatchSchema = z.object({
  intent: z.literal("contact-permission"),
  contactUserId: z.string(),
  canRequestShipment: z.coerce.boolean().optional(),
  canRequestReturn: z.coerce.boolean().optional(),
  canRentInventory: z.coerce.boolean().optional(),
  canViewBilling: z.coerce.boolean().optional(),
  canManageOtherContacts: z.coerce.boolean().optional(),
  canApproveBookings: z.coerce.boolean().optional(),
});

const CustomerDetailsPatchSchema = z.object({
  intent: z.literal("customer-details"),
  name: z.string().trim().min(1, "Name is required"),
  billingEmail: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  requiresInternalApproval: z.coerce.boolean().optional(),
  shipToName: z.string().trim().optional(),
  shipToStreet1: z.string().trim().optional(),
  shipToStreet2: z.string().trim().optional(),
  shipToCity: z.string().trim().optional(),
  shipToState: z.string().trim().optional(),
  shipToPostalCode: z.string().trim().optional(),
  shipToCountry: z.string().trim().optional(),
});

/**
 * Customer-pricing patch schema. Dollar inputs and decimal multipliers as
 * strings; we coerce in the action. Empty string → null (clears the
 * customer override → fall through to org default).
 */
const CustomerPricingPatchSchema = z.object({
  intent: z.literal("customer-pricing"),
  storagePerDayDollars: z.string().optional(),
  pickDollars: z.string().optional(),
  returnDollars: z.string().optional(),
  rentalPerDayDollars: z.string().optional(),
  rentalLossMultiplier: z.string().optional(),
  consumableMarkupPct: z.string().optional(),
  currencyCode: z
    .string()
    .trim()
    .max(3)
    .transform((s) => (s ? s.toUpperCase() : ""))
    .optional(),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { customerId } = getParams(params, ParamSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.read,
    });

    const [customer, pricing] = await Promise.all([
      getCustomerDetail({ organizationId, customerId }),
      getCustomerPricing(customerId),
    ]);

    const header: HeaderData = {
      title: customer.displayName,
    };

    return { header, customer, pricing };
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, customerId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <Link to="..">Customer</Link>,
};

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { customerId } = getParams(params, ParamSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const { intent } = parseData(formData, z.object({ intent: IntentSchema }), {
      additionalData: { customerId },
    });

    if (intent === "contact-permission") {
      const payload = parseData(formData, PermissionPatchSchema, {
        additionalData: { customerId },
      });

      await updateContactPermissions({
        organizationId,
        customerId,
        contactUserId: payload.contactUserId,
        patch: {
          canRequestShipment: payload.canRequestShipment ?? false,
          canRequestReturn: payload.canRequestReturn ?? false,
          canRentInventory: payload.canRentInventory ?? false,
          canViewBilling: payload.canViewBilling ?? false,
          canManageOtherContacts: payload.canManageOtherContacts ?? false,
          canApproveBookings: payload.canApproveBookings ?? false,
        },
      });

      sendNotification({
        title: "Permissions updated",
        message: "Contact permissions saved.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    } else if (intent === "customer-details") {
      const payload = parseData(formData, CustomerDetailsPatchSchema, {
        additionalData: { customerId },
      });

      await updateCustomer({
        organizationId,
        customerId,
        patch: {
          name: payload.name,
          billingEmail: payload.billingEmail || null,
          notes: payload.notes || null,
          requiresInternalApproval: payload.requiresInternalApproval ?? false,
          shipToName: payload.shipToName || null,
          shipToStreet1: payload.shipToStreet1 || null,
          shipToStreet2: payload.shipToStreet2 || null,
          shipToCity: payload.shipToCity || null,
          shipToState: payload.shipToState || null,
          shipToPostalCode: payload.shipToPostalCode || null,
          shipToCountry: payload.shipToCountry || null,
        },
      });

      sendNotification({
        title: "Customer updated",
        message: "Customer details saved.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    } else if (intent === "customer-pricing") {
      const payload = parseData(formData, CustomerPricingPatchSchema, {
        additionalData: { customerId },
      });

      // Empty string for a decimal field means "clear the override" (null in DB);
      // a non-empty parsable number becomes the new value. dollarsToCents
      // already follows the same convention for cents fields.
      const decimalOrNull = (v: string | undefined) => {
        const trimmed = v?.trim();
        if (!trimmed) return null;
        const num = Number(trimmed);
        if (!Number.isFinite(num)) return null;
        return trimmed;
      };

      await upsertCustomerPricing({
        organizationId,
        customerId,
        patch: {
          storagePerDayCents: dollarsToCents(payload.storagePerDayDollars),
          pickCents: dollarsToCents(payload.pickDollars),
          returnCents: dollarsToCents(payload.returnDollars),
          rentalPerDayCents: dollarsToCents(payload.rentalPerDayDollars),
          rentalLossMultiplier: decimalOrNull(payload.rentalLossMultiplier),
          consumableMarkupPct: decimalOrNull(payload.consumableMarkupPct),
          currencyCode: payload.currencyCode || null,
        },
      });

      sendNotification({
        title: "Pricing updated",
        message: "Customer pricing overrides saved.",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    } else if (intent === "invite-contact") {
      const payload = parseData(formData, InviteContactSchema, {
        additionalData: { customerId },
      });

      // Provision a CUSTOMER-role contact linked to this customer. The team
      // member name defaults to the email local-part; accepting the invite
      // sets User.fieldkitCustomerId (see createInvite / updateInviteStatus).
      await createInvite({
        organizationId,
        inviteeEmail: payload.email,
        inviterId: userId,
        userId,
        roles: [OrganizationRoles.CUSTOMER],
        teamMemberName: payload.email.split("@")[0],
        customerId,
      });

      sendNotification({
        title: "Invite sent",
        message: `An invite was sent to ${payload.email}.`,
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
    }

    return { success: true } as const;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, customerId });
    return data(error(reason), { status: reason.status });
  }
}

export default function CustomerDetailPage() {
  const { customer, pricing } = useLoaderData<typeof loader>();
  const { contacts, assets } = customer;

  return (
    <div className="relative">
      <Header />
      <div className="my-4 space-y-6">
        {/* Customer details + approval flow toggle */}
        <div className="rounded border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3 md:px-6">
            <h3 className="text-sm font-semibold text-gray-900">
              Customer details
            </h3>
            <p className="text-xs text-gray-500">
              Name, billing email, ship-to address, and approval flow.
            </p>
          </div>
          <Form method="post" className="space-y-4 p-4 md:px-6">
            <input type="hidden" name="intent" value="customer-details" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                label="Name"
                name="name"
                defaultValue={customer.displayName}
                required
              />
              <Input
                label="Billing email"
                name="billingEmail"
                type="email"
                defaultValue={customer.billingEmail ?? ""}
                placeholder="(optional)"
              />
              <Input
                label="Ship-to name"
                name="shipToName"
                defaultValue={customer.shipToName ?? ""}
                placeholder="(optional)"
              />
              <Input
                label="Ship-to phone"
                name="shipToStreet1"
                defaultValue={customer.shipToStreet1 ?? ""}
                placeholder="Street line 1"
              />
              <Input
                label="Ship-to street 2"
                name="shipToStreet2"
                defaultValue={customer.shipToStreet2 ?? ""}
                placeholder="(optional)"
              />
              <Input
                label="City"
                name="shipToCity"
                defaultValue={customer.shipToCity ?? ""}
              />
              <Input
                label="State / region"
                name="shipToState"
                defaultValue={customer.shipToState ?? ""}
              />
              <Input
                label="Postal code"
                name="shipToPostalCode"
                defaultValue={customer.shipToPostalCode ?? ""}
              />
              <Input
                label="Country"
                name="shipToCountry"
                defaultValue={customer.shipToCountry ?? ""}
              />
            </div>
            <Input
              label="Notes"
              name="notes"
              defaultValue={customer.notes ?? ""}
              placeholder="(optional)"
            />
            <div className="flex max-w-lg items-start gap-2 text-sm text-gray-700">
              <input
                id="requiresInternalApproval"
                type="checkbox"
                name="requiresInternalApproval"
                value="true"
                defaultChecked={customer.requiresInternalApproval}
                className="mt-0.5 rounded border-gray-300"
              />
              <label htmlFor="requiresInternalApproval">
                <span className="font-medium text-gray-900">
                  Require internal approval before staff
                </span>
                <span className="block text-xs text-gray-500">
                  When enabled, requests submitted by any contact at this
                  customer must first be approved by a contact with{" "}
                  <em>Approve bookings</em> permission below.
                </span>
              </label>
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" variant="secondary">
                Save details
              </Button>
            </div>
          </Form>
        </div>

        {/* Customer-level pricing overrides. Any blank field falls through
            to the org-default tier; any filled field overrides it. */}
        <div className="rounded border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3 md:px-6">
            <h3 className="text-sm font-semibold text-gray-900">
              Pricing overrides
            </h3>
            <p className="text-xs text-gray-500">
              Leave a field blank to use the org default from{" "}
              <Link
                to="/settings/pricing"
                className="text-primary-700 hover:underline"
              >
                /settings/pricing
              </Link>
              . Filled values override the default for this customer only.
            </p>
          </div>
          <Form method="post" className="space-y-4 p-4 md:px-6">
            <input type="hidden" name="intent" value="customer-pricing" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                label="Storage / day ($)"
                name="storagePerDayDollars"
                defaultValue={centsToDollars(pricing?.storagePerDayCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Rental / day ($)"
                name="rentalPerDayDollars"
                defaultValue={centsToDollars(pricing?.rentalPerDayCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Pick ($)"
                name="pickDollars"
                defaultValue={centsToDollars(pricing?.pickCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Return ($)"
                name="returnDollars"
                defaultValue={centsToDollars(pricing?.returnCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Rental-loss multiplier"
                name="rentalLossMultiplier"
                defaultValue={pricing?.rentalLossMultiplier?.toString() ?? ""}
                type="number"
                step="0.0001"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Consumable markup"
                name="consumableMarkupPct"
                defaultValue={pricing?.consumableMarkupPct?.toString() ?? ""}
                type="number"
                step="0.0001"
                min="0"
                placeholder="(use default)"
              />
              <Input
                label="Currency code"
                name="currencyCode"
                defaultValue={pricing?.currencyCode ?? ""}
                maxLength={3}
                placeholder="(use org default)"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm" variant="secondary">
                Save pricing
              </Button>
            </div>
          </Form>
        </div>

        <div className="rounded border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
            <h3 className="text-sm font-semibold text-gray-900">
              Stored assets ({customer.assetCount})
            </h3>
            <p className="text-xs text-gray-500">
              Assets stored on behalf of this customer.
            </p>
          </div>
          {assets.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500 md:px-6">
              No assets are currently stored for this customer.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50 text-xs font-medium text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left md:px-6">Asset</th>
                  <th className="px-4 py-2 text-left">Kind</th>
                  <th className="px-4 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-gray-50 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 md:px-6">
                      <Link
                        to={`/assets/${a.id}`}
                        className="flex items-center gap-3 font-medium text-gray-900 hover:underline"
                      >
                        <AssetImage
                          asset={{
                            id: a.id,
                            mainImage: a.mainImage,
                            thumbnailImage: a.thumbnailImage,
                            mainImageExpiration: null,
                          }}
                          alt={a.title}
                          className="size-9 rounded border object-cover"
                        />
                        <div className="flex flex-col">
                          <span>{a.title}</span>
                          {a.sequentialId ? (
                            <span className="font-mono text-xs text-gray-500">
                              {a.sequentialId}
                            </span>
                          ) : null}
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{a.kind}</td>
                    <td className="px-4 py-3">
                      <AssetStatusBadge
                        id={a.id}
                        status={a.status as never}
                        availableToBook={a.availableToBook}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {customer.assetCount > assets.length ? (
            <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 md:px-6">
              Showing first {assets.length} of {customer.assetCount} assets.
            </p>
          ) : null}
        </div>

        <div className="rounded border border-gray-200 bg-white">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                Contacts ({contacts.length})
              </h3>
              <p className="text-xs text-gray-500">
                Invite a contact and toggle their permissions below.
              </p>
            </div>
            <Form
              method="post"
              className="flex items-center gap-2"
              key={contacts.length}
            >
              <input type="hidden" name="intent" value="invite-contact" />
              <input
                type="email"
                name="email"
                required
                placeholder="contact@company.com"
                className="rounded border border-gray-200 px-3 py-1.5 text-sm"
              />
              <Button type="submit" size="sm" variant="secondary">
                Invite contact
              </Button>
            </Form>
          </div>
          {contacts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500 md:px-6">
              No contacts for this customer yet.
            </p>
          ) : (
            <ul>
              {contacts.map((contact) => (
                <ContactRow key={contact.userId} contact={contact} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

type ContactRowProps = { contact: CustomerDetail["contacts"][number] };

function ContactRow({ contact }: ContactRowProps) {
  const fullName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const perm = contact.permission;

  return (
    <li className="border-b border-gray-50 p-4 md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="font-medium text-gray-900">
            {fullName || contact.email}
          </div>
          <div className="text-xs text-gray-500">{contact.email}</div>
        </div>
        <Form
          method="post"
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <input type="hidden" name="intent" value="contact-permission" />
          <input type="hidden" name="contactUserId" value={contact.userId} />
          <PermToggle
            name="canRequestShipment"
            label="Request shipment"
            checked={perm?.canRequestShipment ?? false}
          />
          <PermToggle
            name="canRequestReturn"
            label="Request return"
            checked={perm?.canRequestReturn ?? false}
          />
          <PermToggle
            name="canRentInventory"
            label="Rent inventory"
            checked={perm?.canRentInventory ?? false}
          />
          <PermToggle
            name="canViewBilling"
            label="View billing"
            checked={perm?.canViewBilling ?? false}
          />
          <PermToggle
            name="canManageOtherContacts"
            label="Manage contacts"
            checked={perm?.canManageOtherContacts ?? false}
          />
          <PermToggle
            name="canApproveBookings"
            label="Approve bookings"
            checked={perm?.canApproveBookings ?? false}
          />
          <Button type="submit" size="sm" variant="secondary">
            Save
          </Button>
        </Form>
      </div>
    </li>
  );
}

function PermToggle({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 whitespace-nowrap text-gray-700">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        value="true"
        className="rounded border-gray-300"
      />
      {label}
    </label>
  );
}
