/**
 * Booking requests — list view.
 *
 * Audience-aware:
 *   - CUSTOMER users see all requests under their `carbonCustomerId` (their
 *     own + their colleagues' if they have any).
 *   - Fieldkit staff (non-CUSTOMER) see all requests in the org. The most
 *     useful queue is PENDING_FIELDKIT; we surface it via a status tab.
 *
 * Detail view at `/requests/$id` handles approve/reject/cancel via the API
 * endpoints under `/api/requests/$id/*`.
 *
 * @see {@link file://./../api+/requests.$id.approve.ts}
 * @see {@link file://./../../modules/booking-request/service.server.ts}
 */

import { BookingRequestStatus } from "@prisma/client";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";

import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { Badge } from "~/components/shared/badge";
import { DateS } from "~/components/shared/date";
import { useSearchParams } from "~/hooks/search-params";
import { listBookingRequests } from "~/modules/booking-request/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

const STATUS_TABS = [
  { value: "ACTIVE", label: "Active", description: "Awaiting approval" },
  { value: BookingRequestStatus.APPROVED, label: "Approved" },
  { value: BookingRequestStatus.REJECTED, label: "Rejected" },
  { value: BookingRequestStatus.CANCELLED, label: "Cancelled" },
  { value: "ALL", label: "All" },
] as const;

type StatusTabValue = (typeof STATUS_TABS)[number]["value"];

const ACTIVE_STATUSES: BookingRequestStatus[] = [
  BookingRequestStatus.PENDING_INTERNAL,
  BookingRequestStatus.PENDING_FIELDKIT,
];

function parseStatusTab(value: string | null): StatusTabValue {
  if (!value) return "ACTIVE";
  const valid = STATUS_TABS.some((t) => t.value === value);
  return valid ? (value as StatusTabValue) : "ACTIVE";
}

function statusesForTab(tab: StatusTabValue): BookingRequestStatus[] | undefined {
  if (tab === "ALL") return undefined;
  if (tab === "ACTIVE") return ACTIVE_STATUSES;
  return [tab];
}

function statusBadgeVariant(status: BookingRequestStatus) {
  switch (status) {
    case "APPROVED":
      return "green" as const;
    case "REJECTED":
    case "CANCELLED":
      return "gray" as const;
    case "PENDING_FIELDKIT":
      return "blue" as const;
    case "PENDING_INTERNAL":
      return "yellow" as const;
    case "DRAFT":
      return "gray" as const;
  }
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });
    const { organizationId, isCustomer, carbonCustomerId } = perm;

    const url = new URL(request.url);
    const tab = parseStatusTab(url.searchParams.get("status"));

    const result = await listBookingRequests({
      organizationId,
      // CUSTOMER: scope to their carbonCustomerId. Fieldkit staff: org-wide.
      ...(isCustomer && carbonCustomerId
        ? { carbonCustomerId }
        : {}),
      statuses: statusesForTab(tab),
      include: {
        requester: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            displayName: true,
            email: true,
          },
        },
        _count: { select: { assets: true, kits: true } },
      },
      perPage: 50,
    });

    const header: HeaderData = {
      title: "Booking requests",
      subHeading: isCustomer
        ? "Submit a request to ship or rent assets. Track approval status here."
        : "Review and approve customer requests.",
    };

    return data(
      payload({
        header,
        requests: result.requests,
        total: result.total,
        tab,
        isCustomer,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <Link to="/requests">Booking requests</Link>,
};

export default function RequestsIndex() {
  const { requests, tab, isCustomer } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const setTab = (value: StatusTabValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === "ACTIVE") {
      next.delete("status");
    } else {
      next.set("status", value);
    }
    setSearchParams(next);
  };

  return (
    <>
      <Header
        slots={{
          "right-of-title": isCustomer ? (
            <Link
              to="new"
              className="rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-600"
            >
              New request
            </Link>
          ) : null,
        }}
      />

      <div className="mb-4 flex gap-2 border-b border-gray-200">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={[
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.value
                ? "border-primary-500 text-primary-700"
                : "border-transparent text-gray-500 hover:text-gray-700",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {requests.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          No booking requests
          {tab !== "ALL" ? ` in "${tab}"` : ""}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requester</th>
                <th className="px-4 py-3">Items</th>
                <th className="px-4 py-3">Dates</th>
                <th className="px-4 py-3">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {requests.map((req) => (
                <tr
                  key={req.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => {
                    window.location.href = `/requests/${req.id}`;
                  }}
                >
                  <td className="px-4 py-3">
                    <Badge color={statusBadgeVariant(req.status)}>
                      {req.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {"requester" in req && req.requester
                      ? resolveUserDisplayName(req.requester) ||
                        req.requester.email
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {"_count" in req && req._count
                      ? `${req._count.assets} assets, ${req._count.kits} kits`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    <DateS date={req.proposedFrom} /> –{" "}
                    <DateS date={req.proposedTo} />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    <DateS date={req.createdAt} includeTime />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
