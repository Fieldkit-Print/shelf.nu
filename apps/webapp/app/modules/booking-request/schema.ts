/**
 * Zod schemas for BookingRequest action payloads.
 *
 * Kept in a plain `.ts` file (no `.server`) so they can be reused on the
 * client side for `useZorm` form validation.
 */

import { z } from "zod";

/**
 * Schema for submitting a brand-new request. Booking dates must be in the
 * future and start must precede end. At least one asset or kit is required
 * (the request makes no sense without something to ship).
 */
export const submitBookingRequestSchema = z
  .object({
    proposedFrom: z.coerce
      .date()
      .min(new Date(), "Start date must be in the future"),
    proposedTo: z.coerce.date(),
    assetIds: z.array(z.string()).default([]),
    kitIds: z.array(z.string()).default([]),
    shippingAddress: z.string().trim().max(1000).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .refine((data) => data.proposedTo > data.proposedFrom, {
    message: "End date must be after start date",
    path: ["proposedTo"],
  })
  .refine((data) => data.assetIds.length > 0 || data.kitIds.length > 0, {
    message: "Select at least one asset or kit",
    path: ["assetIds"],
  });

/**
 * Schema for an approval action (either internal or fieldkit-side). No body
 * required — the approver identity comes from the auth session and the
 * which-side comes from the route.
 */
export const approveBookingRequestSchema = z.object({});

/**
 * Schema for a rejection action. Reason is required and shown to the
 * requester in the rejection email.
 */
export const rejectBookingRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "Please provide a reason (5+ characters)")
    .max(1000, "Reason is too long"),
});

/**
 * Schema for cancellation by the requester. Reason is optional —
 * cancellation is the requester's prerogative and doesn't need justification.
 */
export const cancelBookingRequestSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export type SubmitBookingRequestInput = z.infer<
  typeof submitBookingRequestSchema
>;
export type ApproveBookingRequestInput = z.infer<
  typeof approveBookingRequestSchema
>;
export type RejectBookingRequestInput = z.infer<
  typeof rejectBookingRequestSchema
>;
export type CancelBookingRequestInput = z.infer<
  typeof cancelBookingRequestSchema
>;
