/**
 * Customers Admin — Create
 *
 * Form to create a new Shelf-native customer (name, billing email, ship-to
 * address, approval setting). On success, redirects to the customer detail
 * page where contacts and pricing can be configured.
 *
 * Permissions: customer entity, create action (ADMIN/OWNER).
 *
 * @see {@link file://./customers._index.tsx} List
 * @see {@link file://./customers.$customerId.tsx} Detail
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, redirect, useActionData } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";

import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { createCustomer } from "~/modules/customer/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import { error, parseData } from "~/utils/http.server";
import type { DataOrErrorResponse } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const NewCustomerSchema = z.object({
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

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.create,
    });

    const header: HeaderData = { title: "New customer" };
    return { header };
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <Link to="/customers/new">New customer</Link>,
};

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.create,
    });

    const formData = await request.formData();
    const payload = parseData(formData, NewCustomerSchema);

    const customer = await createCustomer({
      organizationId,
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

    return redirect(`/customers/${customer.id}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function NewCustomerPage() {
  const zo = useZorm("NewCustomer", NewCustomerSchema);
  const actionData = useActionData<DataOrErrorResponse>();
  const validationErrors = getValidationErrors<typeof NewCustomerSchema>(
    actionData?.error
  );

  return (
    <div className="relative">
      <Header />
      <div className="my-4 max-w-2xl rounded border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Customer details
          </h3>
        </div>
        <Form ref={zo.ref} method="post" className="space-y-4 p-4 md:px-6">
          <Input
            label="Name"
            name={zo.fields.name()}
            error={validationErrors?.name?.message || zo.errors.name()?.message}
            required
          />
          <Input
            label="Billing email"
            name={zo.fields.billingEmail()}
            type="email"
            placeholder="(optional)"
            error={
              validationErrors?.billingEmail?.message ||
              zo.errors.billingEmail()?.message
            }
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input
              label="Ship-to name"
              name={zo.fields.shipToName()}
              placeholder="(optional)"
            />
            <Input
              label="Street line 1"
              name={zo.fields.shipToStreet1()}
              placeholder="(optional)"
            />
            <Input
              label="Street line 2"
              name={zo.fields.shipToStreet2()}
              placeholder="(optional)"
            />
            <Input label="City" name={zo.fields.shipToCity()} />
            <Input label="State / region" name={zo.fields.shipToState()} />
            <Input label="Postal code" name={zo.fields.shipToPostalCode()} />
            <Input label="Country" name={zo.fields.shipToCountry()} />
          </div>
          <Input
            label="Notes"
            name={zo.fields.notes()}
            placeholder="(optional)"
          />
          <div className="flex items-start gap-2 text-sm text-gray-700">
            <input
              id="requiresInternalApproval"
              type="checkbox"
              name={zo.fields.requiresInternalApproval()}
              value="true"
              className="mt-0.5 rounded border-gray-300"
            />
            <label htmlFor="requiresInternalApproval">
              Require internal approval before staff on this customer's requests
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button to="/customers" variant="secondary">
              Cancel
            </Button>
            <Button type="submit">Create customer</Button>
          </div>
        </Form>
      </div>
    </div>
  );
}
