import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import HorizontalTabs from "~/components/layout/horizontal-tabs";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const handle = {
  breadcrumb: () => <Link to="/account-details">Account Details</Link>,
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.userData,
      action: PermissionAction.read,
    });

    const title = "Account Details";
    const subHeading = "Manage your preferences here.";
    const header = {
      title,
      subHeading,
    };

    return payload({ header });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const shouldRevalidate = () => false;

export default function AccountDetailsPage() {
  // Fieldkit: Subscription + Workspaces tabs removed — no Stripe billing,
  // single-tenant deployment. The workspace edit routes are still reachable
  // directly (e.g. via /account-details/workspace/$workspaceId/edit) so
  // admins can still update the Fieldkit org's name, image, email footer.
  const items = [{ to: "general", content: "General" }];

  return (
    <>
      <Header hidePageDescription />
      <HorizontalTabs items={items} />
      <div>
        <Outlet />
      </div>
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
