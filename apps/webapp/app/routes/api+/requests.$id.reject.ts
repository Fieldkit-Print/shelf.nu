/**
 * Reject a BookingRequest.
 *
 * Works from either PENDING_INTERNAL (customer-side rejection) or
 * PENDING_FIELDKIT (Fieldkit staff rejection). The side is inferred from
 * the request's current status + the caller's role, mirroring the approve
 * endpoint.
 *
 * @see {@link file://./../../modules/booking-request/service.server.ts}
 */

import { BookingRequestStatus } from "@prisma/client";
import { type ActionFunctionArgs, data } from "react-router";
import { z } from "zod";

import { db } from "~/database/db.server";
import { rejectBookingRequestSchema } from "~/modules/booking-request/schema";
import {
  getBookingRequest,
  rejectBookingRequest,
} from "~/modules/booking-request/service.server";
import { ShelfError, makeShelfError } from "~/utils/error";
import {
  assertIsPost,
  error,
  getParams,
  parseData,
  payload,
} from "~/utils/http.server";
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
    const formData = await request.formData();
    const input = parseData(formData, rejectBookingRequestSchema);

    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.update,
    });
    const { isCustomer, carbonCustomerId } = perm;

    const bookingRequest = await getBookingRequest(id);

    // Tenancy: same as approve — CUSTOMER callers must match the request's customer.
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

    if (bookingRequest.status === BookingRequestStatus.PENDING_INTERNAL) {
      if (!isCustomer) {
        throw new ShelfError({
          cause: null,
          label: "BookingRequest",
          message:
            "This request is awaiting customer-internal approval. Fieldkit staff cannot reject it at this stage.",
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
            "You do not have permission to reject booking requests for your organization.",
          additionalData: { id },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const updated = await rejectBookingRequest({
        requestId: id,
        approverId: userId,
        side: "internal",
        input,
      });
      return data(payload({ request: updated }));
    }

    if (bookingRequest.status === BookingRequestStatus.PENDING_FIELDKIT) {
      if (isCustomer) {
        throw new ShelfError({
          cause: null,
          label: "BookingRequest",
          message: "Only Fieldkit staff can reject at the final stage.",
          additionalData: { id },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const updated = await rejectBookingRequest({
        requestId: id,
        approverId: userId,
        side: "fieldkit",
        input,
      });
      return data(payload({ request: updated }));
    }

    throw new ShelfError({
      cause: null,
      label: "BookingRequest",
      message: `Request is in status ${bookingRequest.status} and cannot be rejected.`,
      additionalData: { id, status: bookingRequest.status },
      status: 409,
      shouldBeCaptured: false,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
