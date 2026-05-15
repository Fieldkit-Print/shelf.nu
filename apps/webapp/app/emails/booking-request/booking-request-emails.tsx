/**
 * Booking-request transactional emails.
 *
 * Four templates wired into BookingRequest state transitions:
 *   - submitted          → internal approvers (or Fieldkit ops if no internal approval required)
 *   - internal-approved  → Fieldkit ops
 *   - fieldkit-approved  → requester
 *   - rejected           → requester (+ internal approver when rejected by Fieldkit after internal approval)
 *
 * Templates kept minimal — single React component per email, plain-text
 * counterpart inline. Reuses the shared `LogoForEmail`, `styles`, and
 * `sendEmail` infrastructure to stay merge-friendly with upstream Shelf.
 */

import {
  Container,
  Head,
  Html,
  Link,
  render,
  Text,
} from "@react-email/components";

import { SERVER_URL, SUPPORT_EMAIL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import { LogoForEmail } from "../logo";
import { sendEmail } from "../mail.server";
import { styles } from "../styles";

interface RequestEmailContext {
  requestId: string;
  requesterName: string;
  proposedFrom: Date;
  proposedTo: Date;
  itemSummary: string;
  notes?: string | null;
}

const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);

function commonBody(ctx: RequestEmailContext, title: string, body: string) {
  return (
    <Html>
      <Head>
        <title>{title}</title>
      </Head>
      <Container style={{ padding: "32px 16px", maxWidth: "600px" }}>
        <LogoForEmail />
        <Text style={{ ...styles.h2, marginTop: "16px" }}>{title}</Text>
        <Text style={{ ...styles.p }}>{body}</Text>
        <Text style={{ ...styles.p, fontSize: "14px", color: "#475467" }}>
          <strong>Requester:</strong> {ctx.requesterName}
          <br />
          <strong>Window:</strong> {fmtDate(ctx.proposedFrom)} –{" "}
          {fmtDate(ctx.proposedTo)}
          <br />
          <strong>Items:</strong> {ctx.itemSummary}
          {ctx.notes ? (
            <>
              <br />
              <strong>Notes:</strong> {ctx.notes}
            </>
          ) : null}
        </Text>
        <Text style={{ ...styles.p }}>
          <Link href={`${SERVER_URL}/requests/${ctx.requestId}`}>
            Open request
          </Link>
        </Text>
        <Text style={{ ...styles.p, fontSize: "13px", color: "#667085" }}>
          The Fieldkit team
        </Text>
      </Container>
    </Html>
  );
}

function commonText(ctx: RequestEmailContext, title: string, body: string) {
  return `${title}

${body}

Requester: ${ctx.requesterName}
Window:    ${fmtDate(ctx.proposedFrom)} - ${fmtDate(ctx.proposedTo)}
Items:     ${ctx.itemSummary}
${ctx.notes ? `Notes:     ${ctx.notes}\n` : ""}
Open: ${SERVER_URL}/requests/${ctx.requestId}

— The Fieldkit team
`;
}

/** "Submitted" — sent to internal approvers (or Fieldkit ops when no internal approval). */
export const sendBookingRequestSubmittedEmail = async (args: {
  to: string[];
  context: RequestEmailContext;
  awaitingInternal: boolean;
}) => {
  if (args.to.length === 0) return;
  try {
    const title = args.awaitingInternal
      ? "New booking request awaiting your approval"
      : "New customer booking request";
    const body = args.awaitingInternal
      ? "A team member at your organization has submitted a booking request. Review and approve or reject it to forward it to Fieldkit."
      : "A customer has submitted a new booking request. Review it and approve or reject when convenient.";
    const html = await render(commonBody(args.context, title, body));
    const text = commonText(args.context, title, body);
    void sendEmail({
      to: args.to.join(","),
      subject: `Booking request ${args.context.requestId.slice(-8)}: ${
        args.awaitingInternal ? "awaiting your approval" : "from customer"
      }`,
      html,
      text,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        label: "BookingRequest",
        message: "Failed to send booking-request submitted email — see logs.",
        additionalData: { requestId: args.context.requestId },
      })
    );
  }
};

/** Internal approver said yes — Fieldkit ops needs to do the final approval. */
export const sendBookingRequestInternalApprovedEmail = async (args: {
  to: string[];
  context: RequestEmailContext;
}) => {
  if (args.to.length === 0) return;
  try {
    const title = "Customer approved a booking request — your call next";
    const body =
      "An internal customer approver has signed off on this request. It is now in your queue for final approval.";
    const html = await render(commonBody(args.context, title, body));
    const text = commonText(args.context, title, body);
    void sendEmail({
      to: args.to.join(","),
      subject: `Booking request ${args.context.requestId.slice(
        -8
      )}: internally approved`,
      html,
      text,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        label: "BookingRequest",
        message:
          "Failed to send booking-request internal-approved email — see logs.",
        additionalData: { requestId: args.context.requestId },
      })
    );
  }
};

/** Fieldkit said yes — tell the requester their booking is on its way. */
export const sendBookingRequestFieldkitApprovedEmail = async (args: {
  to: string[];
  context: RequestEmailContext;
  bookingId: string;
}) => {
  if (args.to.length === 0) return;
  try {
    const title = "Your booking request was approved";
    const body =
      "Fieldkit has approved your booking request. A booking has been created and the team will be in touch with shipping details.";
    const html = await render(commonBody(args.context, title, body));
    const text = commonText(args.context, title, body);
    void sendEmail({
      to: args.to.join(","),
      subject: `Booking request ${args.context.requestId.slice(-8)}: approved`,
      html,
      text,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        label: "BookingRequest",
        message:
          "Failed to send booking-request fieldkit-approved email — see logs.",
        additionalData: { requestId: args.context.requestId },
      })
    );
  }
};

/** Either side rejected — tell the requester (and internal approver if applicable). */
export const sendBookingRequestRejectedEmail = async (args: {
  to: string[];
  context: RequestEmailContext;
  reason: string;
  rejectedBy: "internal" | "fieldkit";
}) => {
  if (args.to.length === 0) return;
  try {
    const title =
      args.rejectedBy === "internal"
        ? "Your booking request was declined internally"
        : "Your booking request was declined by Fieldkit";
    const body = `The request was declined with the following reason: "${args.reason}". If you believe this was a mistake, reply to this email or contact support at ${SUPPORT_EMAIL}.`;
    const html = await render(commonBody(args.context, title, body));
    const text = commonText(args.context, title, body);
    void sendEmail({
      to: args.to.join(","),
      subject: `Booking request ${args.context.requestId.slice(-8)}: declined`,
      html,
      text,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        label: "BookingRequest",
        message: "Failed to send booking-request rejected email — see logs.",
        additionalData: { requestId: args.context.requestId },
      })
    );
  }
};
