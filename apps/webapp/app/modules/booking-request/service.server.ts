/**
 * BookingRequest Service
 *
 * Owns the lifecycle of customer-initiated booking requests: submit, internal
 * approve/reject, Fieldkit approve/reject, cancel. On final Fieldkit approval
 * the underlying Booking row is created inside the same transaction.
 *
 * State machine (see superpowers/plans/2026-05-11-customer-tenancy-and-requests.md):
 *
 *                          requires             requires
 *                          internal?            internal?
 *                             no                   yes
 *   DRAFT ── submit ──► PENDING_FIELDKIT      PENDING_INTERNAL
 *                             │                      │
 *                             │                      ├─ internal reject → REJECTED
 *                             │                      └─ internal approve → PENDING_FIELDKIT
 *                             │
 *                             ├─ FK reject → REJECTED
 *                             └─ FK approve → APPROVED (Booking row created in same tx)
 *
 * Any non-terminal: requester may CANCEL → CANCELLED.
 *
 * @see {@link file://./types.ts}
 * @see {@link file://./schema.ts}
 * @see {@link file://./../../utils/permissions/customer-scope.server.ts}
 */

import type { BookingRequest, Prisma, User } from "@prisma/client";
import { BookingRequestStatus, BookingStatus } from "@prisma/client";

import { db } from "~/database/db.server";
import {
  sendBookingRequestFieldkitApprovedEmail,
  sendBookingRequestInternalApprovedEmail,
  sendBookingRequestRejectedEmail,
  sendBookingRequestSubmittedEmail,
} from "~/emails/booking-request/booking-request-emails";
import { recordEvent } from "~/modules/activity-event/service.server";
import { SUPPORT_EMAIL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { resolveUserDisplayName } from "~/utils/user";

import type {
  CancelBookingRequestInput,
  RejectBookingRequestInput,
  SubmitBookingRequestInput,
} from "./schema";

/**
 * Build the email context payload shared by all four templates. Renders
 * the items list (assets + kits) into a single human-readable string.
 */
function buildEmailContext(
  request: BookingRequest,
  requester: Pick<User, "firstName" | "lastName" | "displayName" | "email">,
  itemCounts: { assetCount: number; kitCount: number }
) {
  const items: string[] = [];
  if (itemCounts.assetCount > 0)
    items.push(
      `${itemCounts.assetCount} asset${itemCounts.assetCount > 1 ? "s" : ""}`
    );
  if (itemCounts.kitCount > 0)
    items.push(
      `${itemCounts.kitCount} kit${itemCounts.kitCount > 1 ? "s" : ""}`
    );
  return {
    requestId: request.id,
    requesterName: resolveUserDisplayName(requester) || requester.email,
    proposedFrom: request.proposedFrom,
    proposedTo: request.proposedTo,
    itemSummary: items.length > 0 ? items.join(", ") : "—",
    notes: request.notes,
  };
}

/**
 * Find users at the same Carbon customer who can act as internal approvers
 * (CustomerContactPermission.canApproveBookings = true). Returns just their
 * emails — the caller doesn't need the full user record.
 */
async function findInternalApproverEmails(
  carbonCustomerId: string
): Promise<string[]> {
  const approvers = await db.user.findMany({
    where: {
      carbonCustomerId,
      customerContactPermission: { canApproveBookings: true },
      deletedAt: null,
    },
    select: { email: true },
  });
  return approvers.map((u) => u.email).filter(Boolean);
}

const label = "BookingRequest" as const;

/**
 * Submit a new BookingRequest. Looks up the customer's `requiresInternalApproval`
 * setting and routes to PENDING_INTERNAL or PENDING_FIELDKIT accordingly.
 *
 * The requester is the currently-authenticated user; tenancy is enforced by
 * the caller (which must have already passed `requirePermission` with the
 * CUSTOMER role and a non-null carbonCustomerId on the perm context).
 *
 * @param args - { organizationId, carbonCustomerId, requesterId, input }
 * @returns The created BookingRequest row
 * @throws {ShelfError} on db failure
 */
export async function submitBookingRequest(args: {
  organizationId: string;
  carbonCustomerId: string;
  requesterId: User["id"];
  input: SubmitBookingRequestInput;
}): Promise<BookingRequest> {
  const { organizationId, carbonCustomerId, requesterId, input } = args;

  try {
    const { request, requester, requiresInternal } = await db.$transaction(
      async (tx) => {
        // Resolve approval routing. Default (no row) is "no internal approval".
        const setting = await tx.customerSetting.findUnique({
          where: { carbonCustomerId },
        });
        const requiresInternal = setting?.requiresInternalApproval ?? false;

        const initialStatus = requiresInternal
          ? BookingRequestStatus.PENDING_INTERNAL
          : BookingRequestStatus.PENDING_FIELDKIT;

        const created = await tx.bookingRequest.create({
          data: {
            organizationId,
            carbonCustomerId,
            requesterId,
            status: initialStatus,
            proposedFrom: input.proposedFrom,
            proposedTo: input.proposedTo,
            shipToName: input.shipToName ?? null,
            shipToPhone: input.shipToPhone ?? null,
            shipToLine1: input.shipToLine1 ?? null,
            shipToLine2: input.shipToLine2 ?? null,
            shipToCity: input.shipToCity ?? null,
            shipToState: input.shipToState ?? null,
            shipToPostal: input.shipToPostal ?? null,
            shipToCountry: input.shipToCountry ?? null,
            notes: input.notes ?? null,
            assets: input.assetIds.length
              ? { connect: input.assetIds.map((id) => ({ id })) }
              : undefined,
            kits: input.kitIds.length
              ? { connect: input.kitIds.map((id) => ({ id })) }
              : undefined,
          },
          include: {
            requester: {
              select: {
                firstName: true,
                lastName: true,
                displayName: true,
                email: true,
              },
            },
          },
        });

        await recordEvent(
          {
            organizationId,
            actorUserId: requesterId,
            action: "BOOKING_REQUEST_SUBMITTED",
            entityType: "BOOKING_REQUEST",
            entityId: created.id,
            meta: {
              initialStatus,
              requiresInternal,
              assetCount: input.assetIds.length,
              kitCount: input.kitIds.length,
            },
          },
          tx
        );

        const { requester, ...request } = created;
        return { request, requester, requiresInternal };
      }
    );

    // Email after tx commits — never inside it, so rollback never sends mail.
    const ctx = buildEmailContext(request, requester, {
      assetCount: input.assetIds.length,
      kitCount: input.kitIds.length,
    });
    if (requiresInternal) {
      const approvers = await findInternalApproverEmails(carbonCustomerId);
      void sendBookingRequestSubmittedEmail({
        to: approvers,
        context: ctx,
        awaitingInternal: true,
      });
    } else {
      void sendBookingRequestSubmittedEmail({
        to: [SUPPORT_EMAIL],
        context: ctx,
        awaitingInternal: false,
      });
    }

    return request;
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Failed to submit booking request.",
      additionalData: { organizationId, carbonCustomerId, requesterId },
    });
  }
}

/**
 * Internal customer-side approval. Transitions PENDING_INTERNAL →
 * PENDING_FIELDKIT. The approver must hold
 * `CustomerContactPermission.canApproveBookings = true` AND be at the same
 * Carbon customer as the request — both checks are the caller's responsibility
 * (route loader / action), this function only enforces state-machine validity.
 *
 * @throws {ShelfError} if the request is not in PENDING_INTERNAL
 */
export async function approveInternal(args: {
  requestId: BookingRequest["id"];
  approverId: User["id"];
}) {
  const { requestId, approverId } = args;

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await tx.bookingRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          requester: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              email: true,
            },
          },
          _count: { select: { assets: true, kits: true } },
        },
      });

      if (current.status !== BookingRequestStatus.PENDING_INTERNAL) {
        throw new ShelfError({
          cause: null,
          label,
          message: `Cannot internal-approve request in status ${current.status}.`,
          additionalData: { requestId, status: current.status },
          shouldBeCaptured: false,
        });
      }

      const updated = await tx.bookingRequest.update({
        where: { id: requestId },
        data: {
          status: BookingRequestStatus.PENDING_FIELDKIT,
          internalApproverId: approverId,
          internalApprovedAt: new Date(),
        },
      });

      await recordEvent(
        {
          organizationId: current.organizationId,
          actorUserId: approverId,
          action: "BOOKING_REQUEST_INTERNAL_APPROVED",
          entityType: "BOOKING_REQUEST",
          entityId: requestId,
        },
        tx
      );

      return { updated, current };
    });

    // Email Fieldkit ops — they now own the next approval step.
    const ctx = buildEmailContext(result.updated, result.current.requester, {
      assetCount: result.current._count.assets,
      kitCount: result.current._count.kits,
    });
    void sendBookingRequestInternalApprovedEmail({
      to: [SUPPORT_EMAIL],
      context: ctx,
    });

    return result.updated;
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      label,
      message: "Failed to approve booking request (internal).",
      additionalData: { requestId, approverId },
    });
  }
}

/**
 * Fieldkit staff approval. Transitions PENDING_FIELDKIT → APPROVED and
 * creates the underlying Booking row in the same transaction so callers
 * downstream (sidebar counts, notifications) see a consistent state.
 *
 * Kits in the request are expanded into their constituent assets when the
 * Booking is created (Booking only has an `Asset[]` relation; kits are a
 * pre-approval grouping concept).
 *
 * @throws {ShelfError} if the request is not in PENDING_FIELDKIT
 */
export async function approveFieldkit(args: {
  requestId: BookingRequest["id"];
  approverId: User["id"];
}) {
  const { requestId, approverId } = args;

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await tx.bookingRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          assets: { select: { id: true } },
          kits: { include: { assets: { select: { id: true } } } },
        },
      });

      if (current.status !== BookingRequestStatus.PENDING_FIELDKIT) {
        throw new ShelfError({
          cause: null,
          label,
          message: `Cannot Fieldkit-approve request in status ${current.status}.`,
          additionalData: { requestId, status: current.status },
          shouldBeCaptured: false,
        });
      }

      // Expand kits into asset ids. Dedupe with the direct asset list so a
      // single Booking row never references the same asset twice.
      const allAssetIds = new Set<string>(current.assets.map((a) => a.id));
      for (const kit of current.kits) {
        for (const asset of kit.assets) {
          allAssetIds.add(asset.id);
        }
      }

      const booking = await tx.booking.create({
        data: {
          name: `Customer request ${current.id}`,
          status: BookingStatus.RESERVED,
          organizationId: current.organizationId,
          creatorId: current.requesterId,
          custodianUserId: current.requesterId,
          from: current.proposedFrom,
          to: current.proposedTo,
          description: current.notes ?? undefined,
          assets: allAssetIds.size
            ? { connect: Array.from(allAssetIds).map((id) => ({ id })) }
            : undefined,
        },
      });

      const updated = await tx.bookingRequest.update({
        where: { id: requestId },
        data: {
          status: BookingRequestStatus.APPROVED,
          fieldkitApproverId: approverId,
          fieldkitApprovedAt: new Date(),
          bookingId: booking.id,
        },
      });

      await recordEvent(
        {
          organizationId: current.organizationId,
          actorUserId: approverId,
          action: "BOOKING_REQUEST_FIELDKIT_APPROVED",
          entityType: "BOOKING_REQUEST",
          entityId: requestId,
          bookingId: booking.id,
          meta: { assetCount: allAssetIds.size },
        },
        tx
      );

      // Fetch requester separately for email context (already known at tx start
      // via current.requesterId — pull the email here so we can notify after commit).
      const requester = await tx.user.findUniqueOrThrow({
        where: { id: current.requesterId },
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          email: true,
        },
      });

      return { request: updated, booking, requester, current };
    });

    // Email requester (and any internal approver) — booking is on its way.
    const ctx = buildEmailContext(result.request, result.requester, {
      assetCount: result.current.assets.length,
      kitCount: result.current.kits.length,
    });
    void sendBookingRequestFieldkitApprovedEmail({
      to: [result.requester.email],
      context: ctx,
      bookingId: result.booking.id,
    });

    return { request: result.request, booking: result.booking };
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      label,
      message: "Failed to approve booking request (Fieldkit).",
      additionalData: { requestId, approverId },
    });
  }
}

/**
 * Reject a request. Works from either PENDING_INTERNAL (internal rejection)
 * or PENDING_FIELDKIT (Fieldkit rejection). Caller passes `side` to control
 * which approver column gets stamped and which activity action is recorded.
 *
 * @throws {ShelfError} if the request is in a state where rejection isn't valid for the given side
 */
export async function rejectBookingRequest(args: {
  requestId: BookingRequest["id"];
  approverId: User["id"];
  side: "internal" | "fieldkit";
  input: RejectBookingRequestInput;
}) {
  const { requestId, approverId, side, input } = args;
  const expected =
    side === "internal"
      ? BookingRequestStatus.PENDING_INTERNAL
      : BookingRequestStatus.PENDING_FIELDKIT;

  try {
    const result = await db.$transaction(async (tx) => {
      const current = await tx.bookingRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          requester: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              email: true,
            },
          },
          internalApprover: { select: { email: true } },
          _count: { select: { assets: true, kits: true } },
        },
      });

      if (current.status !== expected) {
        throw new ShelfError({
          cause: null,
          label,
          message: `Cannot ${side}-reject request in status ${current.status}.`,
          additionalData: { requestId, status: current.status, side },
          shouldBeCaptured: false,
        });
      }

      const updated = await tx.bookingRequest.update({
        where: { id: requestId },
        data: {
          status: BookingRequestStatus.REJECTED,
          rejectionReason: input.reason,
          ...(side === "internal"
            ? {
                internalApproverId: approverId,
                internalApprovedAt: new Date(),
              }
            : {
                fieldkitApproverId: approverId,
                fieldkitApprovedAt: new Date(),
              }),
        },
      });

      await recordEvent(
        {
          organizationId: current.organizationId,
          actorUserId: approverId,
          action:
            side === "internal"
              ? "BOOKING_REQUEST_INTERNAL_REJECTED"
              : "BOOKING_REQUEST_FIELDKIT_REJECTED",
          entityType: "BOOKING_REQUEST",
          entityId: requestId,
          meta: { reason: input.reason },
        },
        tx
      );

      return { updated, current };
    });

    // Email requester. When Fieldkit rejected AFTER internal approval, also
    // CC the internal approver so they know their endorsement got overruled.
    const recipients = new Set<string>([result.current.requester.email]);
    if (side === "fieldkit" && result.current.internalApprover?.email) {
      recipients.add(result.current.internalApprover.email);
    }
    const ctx = buildEmailContext(result.updated, result.current.requester, {
      assetCount: result.current._count.assets,
      kitCount: result.current._count.kits,
    });
    void sendBookingRequestRejectedEmail({
      to: Array.from(recipients),
      context: ctx,
      reason: input.reason,
      rejectedBy: side,
    });

    return result.updated;
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      label,
      message: "Failed to reject booking request.",
      additionalData: { requestId, approverId, side },
    });
  }
}

/**
 * Cancel a request. Allowed only by the requester themselves, from any
 * non-terminal state. Caller enforces ownership (requesterId match).
 *
 * @throws {ShelfError} if the request is in a terminal state
 */
export async function cancelBookingRequest(args: {
  requestId: BookingRequest["id"];
  requesterId: User["id"];
  input: CancelBookingRequestInput;
}) {
  const { requestId, requesterId, input } = args;

  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.bookingRequest.findUniqueOrThrow({
        where: { id: requestId },
      });

      const terminalStatuses: BookingRequestStatus[] = [
        BookingRequestStatus.APPROVED,
        BookingRequestStatus.REJECTED,
        BookingRequestStatus.CANCELLED,
      ];
      const isTerminal = terminalStatuses.includes(current.status);

      if (isTerminal) {
        throw new ShelfError({
          cause: null,
          label,
          message: `Cannot cancel request in terminal status ${current.status}.`,
          additionalData: { requestId, status: current.status },
          shouldBeCaptured: false,
        });
      }

      if (current.requesterId !== requesterId) {
        throw new ShelfError({
          cause: null,
          label,
          message:
            "Only the requester may cancel a booking request. Use reject if you are an approver.",
          additionalData: { requestId, requesterId },
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const updated = await tx.bookingRequest.update({
        where: { id: requestId },
        data: {
          status: BookingRequestStatus.CANCELLED,
          rejectionReason: input.reason ?? null,
        },
      });

      await recordEvent(
        {
          organizationId: current.organizationId,
          actorUserId: requesterId,
          action: "BOOKING_REQUEST_CANCELLED",
          entityType: "BOOKING_REQUEST",
          entityId: requestId,
          meta: { reason: input.reason ?? null },
        },
        tx
      );

      return updated;
    });
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      label,
      message: "Failed to cancel booking request.",
      additionalData: { requestId, requesterId },
    });
  }
}

/**
 * Fetch a single BookingRequest. Caller is responsible for tenancy
 * enforcement (compare `request.carbonCustomerId` to `perm.carbonCustomerId`
 * for CUSTOMER role users) — this function only loads the row.
 *
 * Generic over the include parameter so the return type narrows to the
 * shape the caller asked for (`requester`, `assets`, etc. are then typed).
 */
export async function getBookingRequest<
  TInclude extends Prisma.BookingRequestInclude | undefined,
>(
  id: BookingRequest["id"],
  options?: { include?: TInclude }
): Promise<Prisma.BookingRequestGetPayload<{ include: TInclude }>> {
  try {
    return (await db.bookingRequest.findUniqueOrThrow({
      where: { id },
      include: options?.include,
    })) as unknown as Prisma.BookingRequestGetPayload<{ include: TInclude }>;
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      title: "Booking request not found",
      message:
        "The booking request you are trying to access does not exist or you do not have permission to access it.",
      additionalData: { id },
      status: 404,
      shouldBeCaptured: false,
    });
  }
}

/**
 * List booking requests for either:
 *   - a CUSTOMER user (pass `carbonCustomerId`, optionally restrict to their
 *     own requests via `requesterId`) — they see their customer's requests
 *   - Fieldkit staff (omit `carbonCustomerId`) — they see all PENDING_FIELDKIT
 *     org-wide, plus historical APPROVED/REJECTED when `statuses` is widened
 */
export async function listBookingRequests<
  TInclude extends Prisma.BookingRequestInclude | undefined,
>(args: {
  organizationId: string;
  carbonCustomerId?: string;
  requesterId?: User["id"];
  statuses?: BookingRequestStatus[];
  page?: number;
  perPage?: number;
  include?: TInclude;
}): Promise<{
  requests: Prisma.BookingRequestGetPayload<{ include: TInclude }>[];
  total: number;
  page: number;
  perPage: number;
}> {
  const {
    organizationId,
    carbonCustomerId,
    requesterId,
    statuses,
    page = 1,
    perPage = 25,
    include,
  } = args;

  const where: Prisma.BookingRequestWhereInput = {
    organizationId,
    ...(carbonCustomerId ? { carbonCustomerId } : {}),
    ...(requesterId ? { requesterId } : {}),
    ...(statuses?.length ? { status: { in: statuses } } : {}),
  };

  try {
    const [requests, total] = await Promise.all([
      db.bookingRequest.findMany({
        where,
        include,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: "desc" },
      }),
      db.bookingRequest.count({ where }),
    ]);
    return {
      requests: requests as unknown as Prisma.BookingRequestGetPayload<{
        include: TInclude;
      }>[],
      total,
      page,
      perPage,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Failed to list booking requests.",
      additionalData: args,
    });
  }
}
