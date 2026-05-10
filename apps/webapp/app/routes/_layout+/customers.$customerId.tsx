/**
 * Customers Admin — Detail
 *
 * Shows a single Carbon-synced customer with its contact list. Each contact
 * row exposes the granular `CustomerContactPermission` toggles via a small
 * inline form; submitting POSTs back to this same route's action.
 *
 * Permissions: ADMIN/OWNER only. Customer master data (name, billingEmail,
 * archived state) is read-only — Carbon owns it.
 *
 * @see {@link file://./customers._index.tsx} List
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { Form, Link, data, useLoaderData } from "react-router";
import { z } from "zod";

import type { HeaderData } from "~/components/layout/header/types";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import {
  getCustomerDetail,
  updateContactPermissions,
} from "~/modules/customer/service.server";
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

const PermissionPatchSchema = z.object({
  contactUserId: z.string(),
  canRequestShipment: z.coerce.boolean().optional(),
  canRequestReturn: z.coerce.boolean().optional(),
  canRentInventory: z.coerce.boolean().optional(),
  canViewBilling: z.coerce.boolean().optional(),
  canManageOtherContacts: z.coerce.boolean().optional(),
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

    const customer = await getCustomerDetail({ organizationId, customerId });

    const header: HeaderData = {
      title: customer.displayName,
      subHeading: `Carbon id: ${customer.carbonCustomerId}`,
    };

    return { header, customer };
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
      },
    });

    sendNotification({
      title: "Permissions updated",
      message: "Contact permissions saved.",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return { success: true } as const;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, customerId });
    return data(error(reason), { status: reason.status });
  }
}

export default function CustomerDetail() {
  const { customer } = useLoaderData<typeof loader>();
  const { contacts } = customer;

  return (
    <div className="space-y-6">
      <div className="rounded border border-gray-200 bg-white p-4 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-gray-900">
              {customer.displayName}
            </span>
            <Badge color={customer.status === "ACTIVE" ? "#12B76A" : "#667085"}>
              {customer.status}
            </Badge>
          </div>
          <div className="flex flex-col text-xs text-gray-500 md:items-end">
            <span>
              Last synced: {new Date(customer.syncedAt).toLocaleString()}
            </span>
            {customer.archivedAt ? (
              <span>
                Archived at: {new Date(customer.archivedAt).toLocaleString()}
              </span>
            ) : null}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-xs text-gray-500">Billing email</dt>
            <dd className="text-gray-900">{customer.billingEmail ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Carbon id</dt>
            <dd className="font-mono text-xs text-gray-900">
              {customer.carbonCustomerId}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Stored items</dt>
            <dd className="text-gray-900">{customer._count.assets}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Contacts ({contacts.length})
          </h3>
          <p className="text-xs text-gray-500">
            Synced from Carbon. Toggle permissions per contact below.
          </p>
        </div>
        {contacts.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-gray-500 md:px-6">
            No contacts synced yet.
          </p>
        ) : (
          <ul>
            {contacts.map((contact) => (
              <ContactRow key={contact.id} contact={contact} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type ContactRowProps = {
  contact: ReturnType<
    typeof useLoaderData<typeof loader>
  >["customer"]["contacts"][number];
};

function ContactRow({ contact }: ContactRowProps) {
  const fullName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const perm = contact.customerContactPermission;

  return (
    <li className="border-b border-gray-50 p-4 md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="font-medium text-gray-900">
            {fullName || contact.email}
          </div>
          <div className="text-xs text-gray-500">
            {contact.email} · Carbon contact id:{" "}
            {contact.carbonContactId ?? "—"}
          </div>
        </div>
        <Form
          method="post"
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <input type="hidden" name="contactUserId" value={contact.id} />
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
