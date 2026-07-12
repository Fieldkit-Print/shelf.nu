/**
 * Customers Admin — List
 *
 * Lists the org's customers with Shelf-side counters (number of contact
 * Users, number of stored Assets).
 *
 * Permissions: ADMIN/OWNER only — see Role2PermissionMap entry for
 * `PermissionEntity.customer`.
 *
 * @see {@link file://./customers.$customerId.tsx} Detail page
 * @see {@link file://./customers.new.tsx} Create page
 * @see {@link file://./../../modules/customer/service.server.ts} Data layer
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";

import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
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
    const page = Number(params.get("page") ?? 1);

    const { customers, total, perPage } = await listCustomers({
      organizationId,
      search,
      page,
    });

    const header: HeaderData = {
      title: "Customers",
      subHeading: "Customers you store or rent inventory for.",
    };

    return {
      header,
      customers,
      total,
      page,
      perPage,
      search: search ?? "",
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
  const { customers, search, total, page, perPage } =
    useLoaderData<typeof loader>();

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="relative">
      <Header />
      <div className="my-4 rounded border border-gray-200 bg-white">
        <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
          <form method="get" className="flex items-center gap-3">
            <input
              name="search"
              type="search"
              placeholder="Search by name"
              className="rounded border border-gray-200 px-3 py-1.5 text-sm"
              defaultValue={search}
            />
            <button
              type="submit"
              className="rounded bg-primary-500 px-3 py-1.5 text-sm font-medium text-white"
            >
              Filter
            </button>
          </form>
          <div className="flex items-center gap-3">
            <div className="text-xs text-gray-500">
              {total} customer{total === 1 ? "" : "s"}
            </div>
            <Link
              to="/customers/new"
              className="rounded bg-primary-500 px-3 py-1.5 text-sm font-medium text-white"
            >
              New customer
            </Link>
          </div>
        </div>

        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left md:px-6">Customer</th>
              <th className="px-4 py-2 text-right">Contacts</th>
              <th className="px-4 py-2 text-right">Stored items</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-6 text-center text-sm text-gray-500"
                >
                  No customers yet.
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
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.contactCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.assetCount}
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
    </div>
  );
}
