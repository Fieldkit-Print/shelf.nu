/**
 * Approve a BookingRequest.
 *
 * Two flows behind one endpoint, distinguished by the request's current
 * status and the caller's identity:
 *   - PENDING_INTERNAL + caller has `CustomerContactPermission.canApproveBookings`
 *     at the same Carbon customer → internal approval (request advances to
 *     PENDING_FIELDKIT).
 *   - PENDING_FIELDKIT + caller is Fieldkit staff (non-CUSTOMER role) →
 *     final approval (Booking row created, request → APPROVED).
 *
 * The route picks the right service function based on the current state +
 * caller side rather than asking the client to specify the side, which
 * removes a class of client-side spoofing bugs.
 *
 * @see {@link file://./../../modules/booking-request/service.server.ts}
 */

import { BookingRequestStatus } from "@prisma/client";
import { type ActionFunctionArgs, data } from "react-router";
import { z } from "zod";

import { db } from "~/database/db.server";
import {
  approveFieldkit,
  approveInternal,
  getBookingRequest,
} from "~/modules/booking-request/service.server";
import { makeShelfError } from "~/utils/error";
import { ShelfError } from "~/utils/error";
import { assertIsPost, error, getParams, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    const { id } = getParams(params, z.object({ id: z.string() }));

    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.update,
    });
    const { isCustomer, carbonCustomerId } = perm;

    const bookingRequest = await getBookingRequest(id);

    // Tenancy: CUSTOMER callers must belong to the request's customer.
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

    // Side resolution. INTERNAL side requires CUSTOMER role with the
    // canApproveBookings permission. FIELDKIT side requires non-CUSTOMER
    // role (i.e. Fieldkit staff).
    if (bookingRequest.status === BookingRequestStatus.PENDING_INTERNAL) {
      if (!isCustomer) {
        throw new ShelfError({
          cause: null,
          label: "BookingRequest",
          message:
            "This request is awaiting customer-internal approval. Fieldkit staff cannot approve it at this stage.",
          additionalData: { id },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const contactPerm = await db.customerContactPermission.findUnique({
        where: { userId },
      });
      if (!contactPerm?.canApproveBookings) {
        throw new ShelfError({
          cause: null,
          label: "BookingRequest",
          message:
            "You do not have permission to approve booking requests for your organization.",
          additionalData: { id },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const updated = await approveInternal({
        requestId: id,
        approverId: userId,
      });
      return data(payload({ request: updated }));
    }

    if (bookingRequest.status === BookingRequestStatus.PENDING_FIELDKIT) {
      if (isCustomer) {
        throw new ShelfError({
          cause: null,
          label: "BookingRequest",
          message: "Only Fieldkit staff can give final approval.",
          additionalData: { id },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const result = await approveFieldkit({
        requestId: id,
        approverId: userId,
      });
      return data(payload({ request: result.request, booking: result.booking }));
    }

    throw new ShelfError({
      cause: null,
      label: "BookingRequest",
      message: `Request is in status ${bookingRequest.status} and cannot be approved.`,
      additionalData: { id, status: bookingRequest.status },
      status: 409,
      shouldBeCaptured: false,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
