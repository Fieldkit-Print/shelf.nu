import { useLoaderData } from "react-router";
import invariant from "tiny-invariant";
import { Image } from "~/components/shared/image";
import ProfilePicture from "~/components/user/profile-picture";
import When from "~/components/when/when";
import type { loader } from "~/routes/_layout+/_layout";
import { tw } from "~/utils/tw";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./sidebar";

/**
 * Fieldkit: read-only org badge in the sidebar.
 *
 * Upstream Shelf renders a dropdown switcher here for users in multiple
 * organizations. Fieldkit is single-tenant — every user belongs to exactly
 * one org (the Fieldkit org, assigned at invite time), so the switcher is
 * just visual noise. This component keeps the org image + name as a brand
 * anchor in the sidebar but removes the chevron, dropdown, and
 * "Manage workspaces" link.
 */
export default function OrganizationSelector() {
  const { open, openMobile } = useSidebar();
  const { organizations, currentOrganizationId } =
    useLoaderData<typeof loader>();

  const currentOrganization = organizations.find(
    (org) => org.id === currentOrganizationId
  );
  invariant(
    typeof currentOrganization !== "undefined",
    "Something went wrong. Current organization is not in the list of organizations."
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem className={tw(openMobile && "px-2")}>
        <SidebarMenuButton
          asChild
          className={tw(
            "size-full truncate !p-1 hover:bg-transparent",
            open || openMobile ? "border" : ""
          )}
        >
          <div>
            {currentOrganization.type === "PERSONAL" ? (
              <ProfilePicture width="w-6" height="h-6" />
            ) : (
              <Image
                imageId={currentOrganization.imageId}
                alt="img"
                className="size-8 rounded-sm border object-cover"
                updatedAt={currentOrganization.updatedAt}
              />
            )}

            <When truthy={open || openMobile}>
              <div
                className="max-w-[calc(100%-36px)] flex-1 text-left text-sm leading-tight"
                title={currentOrganization.name}
              >
                <span className="block max-w-full truncate font-semibold">
                  {currentOrganization.name}
                </span>
              </div>
            </When>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
