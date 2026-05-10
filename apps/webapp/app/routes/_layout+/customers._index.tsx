/**
 * Customers Admin — List
 *
 * Lists Carbon-synced customers in the current organization. Read-only view
 * (Carbon owns the master data); admins can drill into a customer detail
 * page to manage per-contact permissions.
 *
 * Permissions: ADMIN/OWNER only — see Role2PermissionMap entry for
 * `PermissionEntity.customer`.
 *
 * @see {@link file://./customers.$customerId.tsx} Detail page
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, data, useLoaderData } from "react-router";

import type { HeaderData } from "~/components/layout/header/types";
import { Badge } from "~/components/shared/badge";
import { listCustomers } from "~/modules/customer/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, getCurrentSearchParams } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.read,
    });

    const params = getCurrentSearchParams(request);
    const search = params.get("search") ?? undefined;
    const includeArchived = params.get("includeArchived") === "true";
    const page = Number(params.get("page") ?? 1);

    const { customers, total, perPage } = await listCustomers({
      organizationId,
      search,
      includeArchived,
      page,
    });

    const header: HeaderData = {
      title: "Customers",
      subHeading:
        "Customers synced from Carbon ERP. Master data is read-only — make edits in Carbon.",
    };

    return {
      header,
      customers,
      total,
      page,
      perPage,
      search: search ?? "",
      includeArchived,
    };
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  breadcrumb: () => <Link to="/customers">Customers</Link>,
};

export default function CustomersIndex() {
  const { customers, search, includeArchived, total, page, perPage } =
    useLoaderData<typeof loader>();

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="rounded border border-gray-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
        <form method="get" className="flex items-center gap-3">
          <input
            name="search"
            type="search"
            placeholder="Search by name, email, or Carbon id"
            className="rounded border border-gray-200 px-3 py-1.5 text-sm"
            defaultValue={search}
          />
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              name="includeArchived"
              value="true"
              defaultChecked={includeArchived}
              className="rounded border-gray-300"
            />
            Include archived
          </label>
          <button
            type="submit"
            className="rounded bg-primary-500 px-3 py-1.5 text-sm font-medium text-white"
          >
            Filter
          </button>
        </form>
        <div className="text-xs text-gray-500">
          {total} customer{total === 1 ? "" : "s"}
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-xs font-medium text-gray-500">
          <tr>
            <th className="px-4 py-2 text-left md:px-6">Customer</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Contacts</th>
            <th className="px-4 py-2 text-right">Stored items</th>
            <th className="px-4 py-2 text-left">Last synced</th>
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-4 py-6 text-center text-sm text-gray-500"
              >
                No customers yet. Sync runs nightly; new customers will appear
                here automatically.
              </td>
            </tr>
          ) : (
            customers.map((c) => (
              <tr
                key={c.id}
                className="border-b border-gray-50 hover:bg-gray-50"
              >
                <td className="px-4 py-3 md:px-6">
                  <Link
                    to={`/customers/${c.id}`}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    {c.displayName}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {c.billingEmail ?? "—"} · Carbon id: {c.carbonCustomerId}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge color={c.status === "ACTIVE" ? "#12B76A" : "#667085"}>
                    {c.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {c._count.contacts}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {c._count.assets}
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {new Date(c.syncedAt).toLocaleString()}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-sm md:px-6">
          <span className="text-gray-600">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                className="rounded border border-gray-200 px-3 py-1.5 text-gray-700"
                to={`?${new URLSearchParams({
                  search,
                  ...(includeArchived ? { includeArchived: "true" } : {}),
                  page: String(page - 1),
                }).toString()}`}
              >
                Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                className="rounded border border-gray-200 px-3 py-1.5 text-gray-700"
                to={`?${new URLSearchParams({
                  search,
                  ...(includeArchived ? { includeArchived: "true" } : {}),
                  page: String(page + 1),
                }).toString()}`}
              >
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
