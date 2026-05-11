/**
 * Customers Admin — Detail (FDW edition)
 *
 * Shows a single Carbon customer (read live from Carbon's REST API) with
 * its contact list (joined with provisioned Shelf Users). Each contact row
 * exposes the granular `CustomerContactPermission` toggles via an inline
 * form that POSTs back to this route.
 *
 * Permissions: ADMIN/OWNER only. Customer master data (name) is read-only —
 * Carbon owns it.
 *
 * @see {@link file://./customers._index.tsx} List
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, useLoaderData } from "react-router";
import { z } from "zod";

import { AssetImage } from "~/components/assets/asset-image/component";
import { AssetStatusBadge } from "~/components/assets/asset-status-badge";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import type { CustomerDetail } from "~/modules/customer/service.server";
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
  // URL param is the Carbon customer id (text, the canonical reference).
  const { customerId: carbonCustomerId } = getParams(params, ParamSchema, {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.read,
    });

    const customer = await getCustomerDetail({
      organizationId,
      carbonCustomerId,
    });

    const header: HeaderData = {
      title: customer.displayName,
      subHeading: `Carbon id: ${customer.id}`,
    };

    return { header, customer };
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, carbonCustomerId });
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
  const { customerId: carbonCustomerId } = getParams(params, ParamSchema, {
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
      additionalData: { carbonCustomerId },
    });

    await updateContactPermissions({
      organizationId,
      carbonCustomerId,
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
    const reason = makeShelfError(cause, { userId, carbonCustomerId });
    return data(error(reason), { status: reason.status });
  }
}

export default function CustomerDetailPage() {
  const { customer } = useLoaderData<typeof loader>();
  const { contacts, assets } = customer;

  return (
    <div className="relative">
      <Header />
      <div className="my-4 space-y-6">
        <div className="rounded border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 md:px-6">
            <h3 className="text-sm font-semibold text-gray-900">
              Stored assets ({customer.assetCount})
            </h3>
            <p className="text-xs text-gray-500">
              Assets stored at Fieldkit on behalf of this customer.
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
              No contacts in Carbon for this customer yet.
            </p>
          ) : (
            <ul>
              {contacts.map((contact) => (
                <ContactRow key={contact.carbonContactId} contact={contact} />
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
  const canEditPermissions = Boolean(contact.userId);

  return (
    <li className="border-b border-gray-50 p-4 md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="font-medium text-gray-900">
            {fullName || contact.email}
          </div>
          <div className="text-xs text-gray-500">
            {contact.email} · Carbon contact id: {contact.carbonContactId}
            {!canEditPermissions ? (
              <span className="ml-2 italic text-amber-600">
                no shelf user yet
              </span>
            ) : null}
          </div>
        </div>
        {canEditPermissions ? (
          <Form
            method="post"
            className="flex flex-wrap items-center gap-3 text-sm"
          >
            <input
              type="hidden"
              name="contactUserId"
              value={contact.userId ?? ""}
            />
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
        ) : null}
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
