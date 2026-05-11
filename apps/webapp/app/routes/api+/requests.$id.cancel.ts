/**
 * Cancel a BookingRequest. Requester-only — approvers must use reject.
 *
 * @see {@link file://./../../modules/booking-request/service.server.ts}
 */

import { type ActionFunctionArgs, data } from "react-router";
import { z } from "zod";

import { cancelBookingRequestSchema } from "~/modules/booking-request/schema";
import {
  cancelBookingRequest,
  getBookingRequest,
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
    const input = parseData(formData, cancelBookingRequestSchema);

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

    // Ownership check is duplicated in the service, but having it here lets us
    // return a 403 with a friendlier message before reaching the tx layer.
    if (bookingRequest.requesterId !== userId) {
      throw new ShelfError({
        cause: null,
        label: "BookingRequest",
        message:
          "Only the original requester can cancel a request. If you are an approver, use reject instead.",
        additionalData: { id },
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const updated = await cancelBookingRequest({
      requestId: id,
      requesterId: userId,
      input,
    });
    return data(payload({ request: updated }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
