/**
 * Customer Contact Invite
 *
 * Sends the first-time login email when a Carbon contact is synced into shelf
 * as a new User. Reuses Supabase's magic-link OTP via `sendOTP` from the auth
 * module — no new email infra needed, and the existing rate-limit / retry
 * handling applies.
 *
 * The invite is best-effort: failures are logged but never re-thrown, because
 * the carbon-sync upsert path treats failed email delivery as a non-blocking
 * issue (we don't want a transient SMTP error to mark the contact sync as
 * failed and re-trigger on retry, fanning out duplicate emails).
 *
 * @see {@link file://./service.server.ts}                  Caller
 * @see {@link file://./../auth/service.server.ts#sendOTP}  Underlying primitive
 */

import { sendOTP } from "~/modules/auth/service.server";
import { Logger } from "~/utils/logger";

/**
 * Args for {@link sendCustomerContactInvite}.
 */
export type SendCustomerContactInviteArgs = {
  /** shelf User id (already created by the sync service). */
  userId: string;
  /** Email to send the magic-link to. */
  email: string;
  /** Org id the contact will land in (for telemetry / future routing). */
  organizationId: string;
  /**
   * Carbon customer id the contact is linked to (for telemetry / future
   * routing). Text reference into Carbon — Shelf doesn't keep a local
   * Customer mirror in the FDW edition.
   */
  carbonCustomerId: string;
};

/**
 * Sends the magic-link invite. Returns `true` on success, `false` on failure
 * (logged). Never throws.
 */
export async function sendCustomerContactInvite(
  args: SendCustomerContactInviteArgs
): Promise<boolean> {
  try {
    await sendOTP(args.email);
    Logger.info("[Carbon Sync] Customer contact invite sent", args);
    return true;
  } catch (cause) {
    Logger.error({
      message: "[Carbon Sync] Failed to send customer contact invite",
      cause,
      args,
    });
    return false;
  }
}
