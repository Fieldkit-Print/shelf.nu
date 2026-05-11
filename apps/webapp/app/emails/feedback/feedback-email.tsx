import {
  Container,
  Head,
  Html,
  Link,
  render,
  Text,
} from "@react-email/components";
import { SUPPORT_EMAIL } from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { LogoForEmail } from "../logo";
import { sendEmail } from "../mail.server";
import { styles } from "../styles";

interface FeedbackEmailProps {
  userName: string;
  userEmail: string;
  organizationName: string;
  message: string;
}

export const sendFeedbackEmail = async ({
  userName,
  userEmail,
  organizationName,
  message,
}: FeedbackEmailProps) => {
  try {
    const sanitized = message.replace(/[\r\n\t]+/g, " ").trim();
    const subjectPreview =
      sanitized.length > 50 ? `${sanitized.slice(0, 50)}...` : sanitized;
    const subject = `New question from ${userName}: ${subjectPreview}`;

    const html = await feedbackEmailHtml({
      userName,
      userEmail,
      organizationName,
      message,
    });

    const text = feedbackEmailText({
      userName,
      userEmail,
      organizationName,
      message,
    });

    void sendEmail({
      to: SUPPORT_EMAIL,
      subject,
      html,
      text,
      replyTo: userEmail,
    });
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message: "Something went wrong while sending the feedback email",
        additionalData: { userEmail },
        label: "Email",
      })
    );
  }
};

export const feedbackEmailText = ({
  userName,
  userEmail,
  organizationName,
  message,
}: FeedbackEmailProps) =>
  `New question received

From: ${userName} (${userEmail})
Organization: ${organizationName}

Message:
${message}
`;

function FeedbackEmailTemplate({
  userName,
  userEmail,
  organizationName,
  message,
}: FeedbackEmailProps) {
  return (
    <Html>
      <Head>
        <title>New question received</title>
      </Head>

      <Container style={{ padding: "32px 16px", maxWidth: "100%" }}>
        <LogoForEmail />

        <div style={{ paddingTop: "8px" }}>
          <Text style={{ ...styles.h2 }}>New question received</Text>

          <div
            style={{
              backgroundColor: "#F9FAFB",
              border: "1px solid #E5E7EB",
              borderRadius: "8px",
              padding: "16px",
              marginBottom: "16px",
            }}
          >
            <Text
              style={{
                ...styles.p,
                margin: "0 0 4px 0",
                fontSize: "14px",
                color: "#6B7280",
              }}
            >
              <strong>From:</strong>{" "}
              <Link href={`mailto:${userEmail}`} style={{ color: "#2563EB" }}>
                {userName}
              </Link>{" "}
              ({userEmail})
            </Text>
            <Text
              style={{
                ...styles.p,
                margin: "0",
                fontSize: "14px",
                color: "#6B7280",
              }}
            >
              <strong>Organization:</strong> {organizationName}
            </Text>
          </div>

          <Text style={{ ...styles.p, fontWeight: "600" }}>Message:</Text>
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid #E5E7EB",
              borderRadius: "8px",
              padding: "16px",
              marginBottom: "16px",
            }}
          >
            <Text
              style={{
                ...styles.p,
                margin: "0",
                whiteSpace: "pre-wrap",
              }}
            >
              {message}
            </Text>
          </div>
        </div>
      </Container>
    </Html>
  );
}

export const feedbackEmailHtml = (props: FeedbackEmailProps) =>
  render(<FeedbackEmailTemplate {...props} />);
