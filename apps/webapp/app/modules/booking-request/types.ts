/**
 * BookingRequest — module-level type aliases.
 *
 * Kept separate from `service.server.ts` so loaders and route components can
 * import these types without pulling in server-only Prisma imports.
 *
 * @see {@link file://./service.server.ts}
 */

import type { BookingRequest, BookingRequestStatus } from "@prisma/client";

/**
 * Lifecycle states that allow approver action. Anything else is either a
 * draft (requester not yet submitted) or terminal (APPROVED, REJECTED,
 * CANCELLED).
 */
export const APPROVABLE_STATUSES: readonly BookingRequestStatus[] = [
  "PENDING_INTERNAL",
  "PENDING_FIELDKIT",
];

/**
 * States the requester may cancel from. Once approved or rejected the request
 * is terminal — cancellation no longer makes sense.
 */
export const CANCELLABLE_STATUSES: readonly BookingRequestStatus[] = [
  "DRAFT",
  "PENDING_INTERNAL",
  "PENDING_FIELDKIT",
];

/** Terminal states — the request cannot transition out of these. */
export const TERMINAL_STATUSES: readonly BookingRequestStatus[] = [
  "APPROVED",
  "REJECTED",
  "CANCELLED",
];

/**
 * Narrow union for which "side" of the approval flow a transition is on.
 * Used internally to pick the right approver column to update.
 */
export type ApprovalSide = "internal" | "fieldkit";

export type BookingRequestSummary = Pick<
  BookingRequest,
  | "id"
  | "status"
  | "proposedFrom"
  | "proposedTo"
  | "carbonCustomerId"
  | "requesterId"
  | "createdAt"
  | "updatedAt"
>;
