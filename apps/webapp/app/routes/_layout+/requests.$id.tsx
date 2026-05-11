/**
 * Booking request — detail view.
 *
 * Shows the request payload (dates, items, notes, shipping address) and the
 * status. Surfaces conditional actions:
 *   - Cancel button — only when viewer is the requester AND status is non-terminal
 *   - Approve / Reject buttons — only when viewer can act on the current
 *     stage (internal approver for PENDING_INTERNAL, Fieldkit staff for
 *     PENDING_FIELDKIT)
 *
 * All transitions hit the dedicated API endpoints at /api/requests/$id/*.
 */

import { BookingRequestStatus } from "@prisma/client";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useFetcher, useLoaderData } from "react-router";
import { z } from "zod";

import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import { Badge } from "~/components/shared/badge";
import { Button } from "~/components/shared/button";
import { DateS } from "~/components/shared/date";
import { db } from "~/database/db.server";
import { useDisabled } from "~/hooks/use-disabled";
import { getBookingRequest } from "~/modules/booking-request/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

function statusColor(status: BookingRequestStatus) {
  switch (status) {
    case "APPROVED":
      return "green" as const;
    case "REJECTED":
    case "CANCELLED":
      return "gray" as const;
    case "PENDING_FIELDKIT":
      return "blue" as const;
    case "PENDING_INTERNAL":
      return "yellow" as const;
    case "DRAFT":
      return "gray" as const;
  }
}

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { id } = getParams(params, z.object({ id: z.string() }));

    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });
    const { isCustomer, carbonCustomerId } = perm;

    const bookingRequest = await getBookingRequest(id, {
      include: {
        requester: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            displayName: true,
            email: true,
          },
        },
        internalApprover: {
          select: { firstName: true, lastName: true, displayName: true },
        },
        fieldkitApprover: {
          select: { firstName: true, lastName: true, displayName: true },
        },
        assets: { select: { id: true, title: true } },
        kits: { select: { id: true, name: true } },
        booking: { select: { id: true, name: true } },
      },
    });

    // Tenancy: CUSTOMER callers must match the request's customer.
    if (isCustomer && bookingRequest.carbonCustomerId !== carbonCustomerId) {
      throw new ShelfError({
        cause: null,
        label: "BookingRequest",
        title: "Booking request not found",
        message:
          "The booking request you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { id },
        status: 404,
        shouldBeCaptured: false,
      });
    }

    // Determine the viewer's capabilities so we can render the right buttons.
    const isRequester = bookingRequest.requesterId === userId;
    const canCancel =
      isRequester &&
      !(
        [
          BookingRequestStatus.APPROVED,
          BookingRequestStatus.REJECTED,
          BookingRequestStatus.CANCELLED,
        ] as BookingRequestStatus[]
      ).includes(bookingRequest.status);

    let canApproveOrReject = false;
    if (bookingRequest.status === BookingRequestStatus.PENDING_INTERNAL) {
      if (isCustomer) {
        const contactPerm = await db.customerContactPermission.findUnique({
          where: { userId },
          select: { canApproveBookings: true },
        });
        canApproveOrReject = !!contactPerm?.canApproveBookings;
      }
    } else if (bookingRequest.status === BookingRequestStatus.PENDING_FIELDKIT) {
      // Any non-CUSTOMER staff member with booking.update can act here.
      canApproveOrReject = !isCustomer;
    }

    return data(
      payload({
        header: { title: `Request ${bookingRequest.id.slice(-8)}` },
        request: bookingRequest,
        canCancel,
        canApproveOrReject,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => "Detail",
};

export default function RequestDetail() {
  const { request, canCancel, canApproveOrReject } =
    useLoaderData<typeof loader>();
  const approveFetcher = useFetcher();
  const rejectFetcher = useFetcher();
  const cancelFetcher = useFetcher();
  const approveDisabled = useDisabled(approveFetcher);
  const rejectDisabled = useDisabled(rejectFetcher);
  const cancelDisabled = useDisabled(cancelFetcher);

  return (
    <>
      <Header />
      <div className="grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          <section className="rounded-lg border border-gray-200 bg-white p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Status</h2>
              <Badge color={statusColor(request.status)}>
                {request.status.replace("_", " ")}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-y-3 text-sm">
              <dt className="text-gray-500">Requester</dt>
              <dd className="text-gray-900">
                {"requester" in request && request.requester
                  ? resolveUserDisplayName(request.requester) ||
                    request.requester.email
                  : "—"}
              </dd>
              <dt className="text-gray-500">Submitted</dt>
              <dd className="text-gray-900">
                <DateS date={request.createdAt} includeTime />
              </dd>
              <dt className="text-gray-500">Window</dt>
              <dd className="text-gray-900">
                <DateS date={request.proposedFrom} includeTime /> –{" "}
                <DateS date={request.proposedTo} includeTime />
              </dd>
              {request.internalApprover ? (
                <>
                  <dt className="text-gray-500">Internal approver</dt>
                  <dd className="text-gray-900">
                    {resolveUserDisplayName(request.internalApprover) || "—"}{" "}
                    {request.internalApprovedAt ? (
                      <span className="text-xs text-gray-500">
                        (<DateS date={request.internalApprovedAt} includeTime />
                        )
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
              {request.fieldkitApprover ? (
                <>
                  <dt className="text-gray-500">Fieldkit approver</dt>
                  <dd className="text-gray-900">
                    {resolveUserDisplayName(request.fieldkitApprover) || "—"}{" "}
                    {request.fieldkitApprovedAt ? (
                      <span className="text-xs text-gray-500">
                        (<DateS date={request.fieldkitApprovedAt} includeTime />
                        )
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
              {request.rejectionReason ? (
                <>
                  <dt className="text-gray-500">Reason</dt>
                  <dd className="text-gray-900">{request.rejectionReason}</dd>
                </>
              ) : null}
              {request.booking ? (
                <>
                  <dt className="text-gray-500">Booking</dt>
                  <dd className="text-gray-900">
                    <Link
                      to={`/bookings/${request.booking.id}`}
                      className="text-primary-700 hover:underline"
                    >
                      {request.booking.name}
                    </Link>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-6">
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Items</h2>
            {request.assets.length === 0 && request.kits.length === 0 ? (
              <p className="text-sm text-gray-500">No items.</p>
            ) : (
              <ul className="space-y-1 text-sm text-gray-900">
                {request.assets.map((a) => (
                  <li key={a.id}>📦 {a.title}</li>
                ))}
                {request.kits.map((k) => (
                  <li key={k.id}>🧰 {k.name}</li>
                ))}
              </ul>
            )}
          </section>

          {request.notes ? (
            <section className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-900">
                Notes
              </h2>
              <p className="whitespace-pre-wrap text-sm text-gray-700">
                {request.notes}
              </p>
            </section>
          ) : null}

          {request.shippingAddress ? (
            <section className="rounded-lg border border-gray-200 bg-white p-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-900">
                Shipping address
              </h2>
              <p className="whitespace-pre-wrap text-sm text-gray-700">
                {request.shippingAddress}
              </p>
            </section>
          ) : null}
        </div>

        <aside className="space-y-4">
          {canApproveOrReject ? (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-3 text-sm font-semibold text-gray-900">
                Take action
              </h3>
              <approveFetcher.Form
                method="POST"
                action={`/api/requests/${request.id}/approve`}
              >
                <Button
                  type="submit"
                  disabled={approveDisabled}
                  className="w-full"
                >
                  {approveDisabled ? "Approving…" : "Approve"}
                </Button>
              </approveFetcher.Form>

              <rejectFetcher.Form
                method="POST"
                action={`/api/requests/${request.id}/reject`}
                className="mt-3 space-y-2"
              >
                <Input
                  inputType="textarea"
                  label="Rejection reason"
                  name="reason"
                  rows={3}
                  required
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={rejectDisabled}
                  className="w-full"
                >
                  {rejectDisabled ? "Rejecting…" : "Reject"}
                </Button>
              </rejectFetcher.Form>
            </section>
          ) : null}

          {canCancel ? (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-3 text-sm font-semibold text-gray-900">
                Cancel
              </h3>
              <cancelFetcher.Form
                method="POST"
                action={`/api/requests/${request.id}/cancel`}
                className="space-y-2"
              >
                <Input
                  inputType="textarea"
                  label="Reason (optional)"
                  name="reason"
                  rows={3}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={cancelDisabled}
                  className="w-full"
                >
                  {cancelDisabled ? "Cancelling…" : "Cancel request"}
                </Button>
              </cancelFetcher.Form>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
