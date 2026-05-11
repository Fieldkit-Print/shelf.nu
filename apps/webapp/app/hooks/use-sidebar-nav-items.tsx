import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  AlarmClockIcon,
  BoxesIcon,
  CalendarRangeIcon,
  ChartLineIcon,
  ClipboardCheckIcon,
  FileBarChartIcon,
  HomeIcon,
  InboxIcon,
  MapPinIcon,
  MessageCircleIcon,
  Package,
  PackageOpenIcon,
  ScanBarcodeIcon,
  SettingsIcon,
  TagsIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useLoaderData } from "react-router";
import { UpgradeMessage } from "~/components/marketing/upgrade-message";
import When from "~/components/when/when";
import type { loader } from "~/routes/_layout+/_layout";
import { isPersonalOrg } from "~/utils/organization";
import { useCurrentOrganization } from "./use-current-organization";
import { useUserRoleHelper } from "./user-user-role-helper";

type BaseNavItem = {
  title: string;
  hidden?: boolean;
  Icon: LucideIcon;
  disabled?: boolean | { reason: ReactNode };
  badge?: {
    show: boolean;
    variant?: "unread";
  };
};

export type ChildNavItem = BaseNavItem & {
  type: "child";
  to: string;
  target?: string;
};

export type ParentNavItem = BaseNavItem & {
  type: "parent";
  children: Omit<ChildNavItem, "type" | "Icon">[];
};

type LabelNavItem = Omit<BaseNavItem, "Icon"> & {
  type: "label";
};

type ButtonNavItem = BaseNavItem & {
  type: "button";
  onClick: () => void;
};

export type NavItem =
  | ChildNavItem
  | ParentNavItem
  | LabelNavItem
  | ButtonNavItem;

export function useSidebarNavItems() {
  const { isAdmin, canUseBookings, subscription } =
    useLoaderData<typeof loader>();
  const { isCustomer, isRestrictedRole } = useUserRoleHelper();
  const currentOrganization = useCurrentOrganization();
  const isPersonalOrganization = isPersonalOrg(currentOrganization);

  const bookingDisabled = useMemo(() => {
    if (canUseBookings) {
      return false;
    }

    return {
      reason: (
        <div>
          <h5>Disabled</h5>
          <p>
            Booking is a premium feature only available for Team workspaces.
          </p>

          <When truthy={!!subscription} fallback={<UpgradeMessage />}>
            <p>Please switch to your team workspace to access this feature.</p>
          </When>
        </div>
      ),
    };
  }, [canUseBookings, subscription]);

  const topMenuItems: NavItem[] = [
    {
      type: "child",
      title: "Admin Dashboard",
      to: "/admin-dashboard/users",
      Icon: ChartLineIcon,
      hidden: !isAdmin,
    },
    {
      type: "label",
      title: "Asset management",
    },
    {
      type: "child",
      title: "Home",
      to: "/home",
      Icon: HomeIcon,
      hidden: isRestrictedRole,
    },
    {
      type: "child",
      title: "Assets",
      to: "/assets",
      Icon: PackageOpenIcon,
    },
    {
      type: "child",
      title: "Kits",
      to: "/kits",
      Icon: Package,
    },
    {
      type: "child",
      title: "Categories",
      to: "/categories",
      Icon: BoxesIcon,
      hidden: isRestrictedRole,
    },

    {
      type: "child",
      title: "Tags",
      to: "/tags",
      Icon: TagsIcon,
      hidden: isRestrictedRole,
    },
    {
      type: "child",
      title: "Locations",
      to: "/locations",
      Icon: MapPinIcon,
      hidden: isRestrictedRole,
    },
    {
      type: "child",
      title: "Audits",
      to: "/audits",
      Icon: ClipboardCheckIcon,
      hidden: isCustomer, // CUSTOMER role has no audit permissions
    },
    {
      type: "parent",
      title: "Bookings",
      Icon: CalendarRangeIcon,
      disabled: bookingDisabled,
      children: [
        {
          title: "View Bookings",
          to: "/bookings",
          disabled: bookingDisabled,
        },
        {
          title: "Calendar",
          to: "/calendar",
          disabled: bookingDisabled,
        },
      ],
    },
    {
      // Fieldkit customer-portal request/approval flow. CUSTOMER users see
      // their submitted requests; Fieldkit staff see the org-wide queue.
      type: "child",
      title: isCustomer ? "Requests" : "Booking requests",
      to: "/requests",
      Icon: InboxIcon,
    },
    {
      type: "child",
      title: "Reminders",
      Icon: AlarmClockIcon,
      hidden: isRestrictedRole,
      to: "/reminders",
    },
    {
      type: "child",
      title: "Reports",
      Icon: FileBarChartIcon,
      hidden: isRestrictedRole,
      to: "/reports",
    },
    {
      type: "child",
      title: "Customers",
      Icon: UsersRoundIcon,
      // Fieldkit-only admin surface (PR5). Staff manage Carbon-synced
      // customers + their contacts here. Hidden from base/self-service/customer.
      hidden: isRestrictedRole,
      to: "/customers",
    },
    {
      type: "label",
      title: "Organization",
      hidden: isRestrictedRole,
    },
    {
      type: "parent",
      title: "Team",
      Icon: UsersRoundIcon,
      hidden: isRestrictedRole,
      children: [
        {
          title: "Users",
          to: "/settings/team/users",
          hidden: isPersonalOrganization,
        },
        {
          title: "Pending invites",
          to: "/settings/team/invites",
          hidden: isPersonalOrganization,
        },
        {
          title: "Non-registered members",
          to: "/settings/team/nrm",
        },
      ],
    },
    {
      type: "parent",
      title: "Workspace settings",
      Icon: SettingsIcon,
      hidden: isRestrictedRole,
      children: [
        {
          title: "General",
          to: "/settings/general",
        },
        {
          title: "Bookings",
          to: "/settings/bookings",
          hidden: isPersonalOrganization,
        },
        {
          title: "Custom fields",
          to: "/settings/custom-fields",
        },
      ],
    },
  ];

  const bottomMenuItems: NavItem[] = [
    {
      type: "child",
      title: "QR Scanner",
      to: "/scanner",
      Icon: ScanBarcodeIcon,
    },
    {
      type: "button",
      title: "Ask a question",
      Icon: MessageCircleIcon,
      onClick: () => {
        // Handled by FeedbackNavItem in sidebar-nav.tsx
      },
    },
  ];

  return {
    topMenuItems: removeHiddenNavItems(topMenuItems),
    bottomMenuItems: removeHiddenNavItems(bottomMenuItems),
  };
}

function removeHiddenNavItems(navItems: NavItem[]) {
  return navItems
    .filter((item) => !item.hidden)
    .map((item) => {
      if (item.type === "parent") {
        return {
          ...item,
          children: item.children.filter((child) => !child.hidden),
        };
      }

      return item;
    });
}
