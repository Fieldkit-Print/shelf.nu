import type { Prisma } from "@prisma/client";
import { type ActionFunctionArgs, data } from "react-router";
import { sendFeedbackEmail } from "~/emails/feedback/feedback-email";
import { feedbackSchema } from "~/modules/feedback/schema";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { getUserByID } from "~/modules/user/service.server";
import { makeShelfError } from "~/utils/error";
import { assertIsPost, error, parseData, payload } from "~/utils/http.server";

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    const rawFormData = await request.formData();
    const { message } = parseData(rawFormData, feedbackSchema);

    const [user, { currentOrganization }] = await Promise.all([
      getUserByID(userId, {
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          username: true,
          email: true,
        } satisfies Prisma.UserSelect,
      }),
      getSelectedOrganization({ userId, request }),
    ]);

    const userName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.username ||
      "Unknown user";

    const organizationName = currentOrganization?.name || "Unknown";

    await sendFeedbackEmail({
      userName,
      userEmail: user.email,
      organizationName,
      message,
    });

    return data(payload({ success: true }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
