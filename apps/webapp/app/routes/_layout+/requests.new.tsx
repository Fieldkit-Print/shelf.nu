/**
 * Booking request — composer.
 *
 * Customer-only route. Lists the assets + kits the requester can pick from
 * (their carbonCustomerId-owned assets/kits + Fieldkit-owned rentable pool
 * when the requester has `canRentInventory`), a date range, an optional
 * shipping address override, and freeform notes.
 *
 * On submit, the BookingRequest is created with status PENDING_INTERNAL or
 * PENDING_FIELDKIT depending on the customer's
 * `CustomerSetting.requiresInternalApproval`. The user is redirected to the
 * detail page so they can see the status and (optionally) cancel.
 */

import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { data, Form, redirect, useActionData, useLoaderData } from "react-router";
import { useZorm } from "react-zorm";

import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import { getAssets } from "~/modules/asset/service.server";
import { submitBookingRequestSchema } from "~/modules/booking-request/schema";
import { submitBookingRequest } from "~/modules/booking-request/service.server";
import { getPaginatedAndFilterableKits } from "~/modules/kit/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import {
  assertIsPost,
  error,
  parseData,
  payload,
  type DataOrErrorResponse,
} from "~/utils/http.server";
import {
  buildCustomerAssetScope,
  buildCustomerKitScope,
} from "~/utils/permissions/customer-scope.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.create,
    });

    if (!perm.isCustomer || !perm.carbonCustomerId) {
      throw new ShelfError({
        cause: null,
        label: "BookingRequest",
        message:
          "Only customer contacts can create booking requests. Fieldkit staff should create bookings directly.",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    // Fetch the requester's `canRentInventory` flag — without it they can't
    // include rentable Fieldkit-pool items in their request.
    const contactPerm = await db.customerContactPermission.findUnique({
      where: { userId },
      select: { canRentInventory: true },
    });
    const canRentInventory = contactPerm?.canRentInventory ?? false;

    const [assetsResult, kitsResult] = await Promise.all([
      getAssets({
        organizationId: perm.organizationId,
        page: 1,
        perPage: 100,
        orderBy: "title",
        orderDirection: "asc",
        customerScope: buildCustomerAssetScope(perm, {
          includeRentable: canRentInventory,
        }),
      }),
      getPaginatedAndFilterableKits({
        request,
        organizationId: perm.organizationId,
        customerScope: buildCustomerKitScope(perm),
      }),
    ]);

    return data(
      payload({
        header: { title: "New booking request" },
        assets: assetsResult.assets.map((a) => ({
          id: a.id,
          title: a.title,
          rentable: a.rentable,
          carbonCustomerId: a.carbonCustomerId,
        })),
        kits: kitsResult.kits.map((k) => ({
          id: k.id,
          name: k.name,
          rentable: k.rentable,
          carbonCustomerId: k.carbonCustomerId,
        })),
        canRentInventory,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.create,
    });

    if (!perm.isCustomer || !perm.carbonCustomerId) {
      throw new ShelfError({
        cause: null,
        label: "BookingRequest",
        message: "Only customer contacts can submit booking requests.",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const formData = await request.formData();
    // `react-zorm` posts arrays as repeated keys; use getAll() to gather them.
    const input = parseData(formData, submitBookingRequestSchema, {
      additionalData: { userId },
    });
    // parseData drops getAll-style array fields when they aren't in the schema
    // as an array. Pull asset/kit IDs explicitly to be safe.
    const assetIds = formData.getAll("assetIds").map(String).filter(Boolean);
    const kitIds = formData.getAll("kitIds").map(String).filter(Boolean);

    const created = await submitBookingRequest({
      organizationId: perm.organizationId,
      carbonCustomerId: perm.carbonCustomerId,
      requesterId: userId,
      input: {
        ...input,
        assetIds,
        kitIds,
      },
    });

    return redirect(`/requests/${created.id}`);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta = ({ data }: { data: { header: { title: string } } }) => [
  { title: appendToMetaTitle(data?.header?.title ?? "New request") },
];

export const handle = {
  breadcrumb: () => "New request",
};

export default function NewRequest() {
  const { assets, kits, canRentInventory } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const validationErrors = getValidationErrors<typeof submitBookingRequestSchema>(
    actionData?.error
  );
  const zo = useZorm("NewBookingRequest", submitBookingRequestSchema);
  const disabled = useDisabled();

  return (
    <>
      <Header />
      <Form method="POST" ref={zo.ref} className="max-w-2xl space-y-6">
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">
            When do you need it?
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              type="datetime-local"
              label="Start"
              name={zo.fields.proposedFrom()}
              required
              error={
                validationErrors?.proposedFrom?.message ||
                zo.errors.proposedFrom()?.message
              }
            />
            <Input
              type="datetime-local"
              label="End"
              name={zo.fields.proposedTo()}
              required
              error={
                validationErrors?.proposedTo?.message ||
                zo.errors.proposedTo()?.message
              }
            />
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-semibold text-gray-900">
            What do you need?
          </h2>
          <p className="mb-4 text-xs text-gray-500">
            Select at least one asset or kit. Items marked{" "}
            <span className="font-medium text-primary-700">(rentable)</span>{" "}
            come from Fieldkit's shared inventory pool.
          </p>

          {assets.length > 0 ? (
            <fieldset className="mb-4">
              <legend className="mb-2 text-sm font-medium text-gray-700">
                Assets
              </legend>
              <div className="max-h-64 space-y-1 overflow-auto rounded border border-gray-200 p-2">
                {assets.map((asset) => (
                  <label
                    key={asset.id}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      name="assetIds"
                      value={asset.id}
                      className="size-4 rounded border-gray-300"
                    />
                    <span className="flex-1">{asset.title}</span>
                    {asset.carbonCustomerId === null && asset.rentable ? (
                      <span className="text-xs font-medium text-primary-700">
                        rentable
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
              {validationErrors?.assetIds?.message ? (
                <p className="mt-1 text-sm text-error-600">
                  {validationErrors.assetIds.message}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {kits.length > 0 ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-gray-700">
                Kits
              </legend>
              <div className="max-h-64 space-y-1 overflow-auto rounded border border-gray-200 p-2">
                {kits.map((kit) => (
                  <label
                    key={kit.id}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      name="kitIds"
                      value={kit.id}
                      className="size-4 rounded border-gray-300"
                    />
                    <span className="flex-1">{kit.name}</span>
                    {kit.carbonCustomerId === null && kit.rentable ? (
                      <span className="text-xs font-medium text-primary-700">
                        rentable
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {!canRentInventory && assets.length === 0 && kits.length === 0 ? (
            <p className="text-sm text-gray-500">
              No assets or kits are currently visible to you. Contact your
              Fieldkit account manager if this is unexpected.
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">
            Shipping &amp; notes (optional)
          </h2>
          <Input
            label="Shipping address override"
            name={zo.fields.shippingAddress()}
            placeholder="Leave blank to use the default address on file"
            error={
              validationErrors?.shippingAddress?.message ||
              zo.errors.shippingAddress()?.message
            }
          />
          <div className="mt-4">
            <Input
              inputType="textarea"
              label="Notes for Fieldkit"
              name={zo.fields.notes()}
              placeholder="Handling instructions, urgency, contact info, etc."
              rows={4}
              error={
                validationErrors?.notes?.message ||
                zo.errors.notes()?.message
              }
            />
          </div>
        </section>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" to="/requests">
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            {disabled ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </Form>
    </>
  );
}
