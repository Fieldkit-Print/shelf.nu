/**
 * POST /api/customers/assign-assets
 *
 * Admin action endpoint that backs both the customer detail page and the
 * asset list bulk-action menu. Accepts an `intent` of either
 * `assign-customer` (set / clear `Asset.customerId`) or `set-rentable`
 * (toggle `Asset.rentable` on Fieldkit-owned inventory).
 *
 * @see {@link file://./../../modules/customer/asset-assignment.server.ts}
 */

import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";

import {
  bulkAssignAssetsToCustomer,
  bulkSetAssetsRentable,
} from "~/modules/customer/asset-assignment.server";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { error, parseData } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const PayloadSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("assign-customer"),
    assetIds: z.preprocess(
      (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v),
      z.array(z.string()).min(1, "At least one asset is required")
    ),
    /** Empty string clears the link. */
    customerId: z.string().nullable().default(null),
  }),
  z.object({
    intent: z.literal("set-rentable"),
    assetIds: z.preprocess(
      (v) => (typeof v === "string" ? v.split(",").filter(Boolean) : v),
      z.array(z.string()).min(1, "At least one asset is required")
    ),
    rentable: z.coerce.boolean(),
  }),
]);

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.customer,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const payload = parseData(formData, PayloadSchema, {
      additionalData: { userId },
    });

    let count = 0;
    let title = "";
    if (payload.intent === "assign-customer") {
      count = await bulkAssignAssetsToCustomer({
        organizationId,
        assetIds: payload.assetIds,
        customerId: payload.customerId || null,
      });
      title = payload.customerId
        ? "Assets assigned to customer"
        : "Assets released to Fieldkit inventory";
    } else {
      count = await bulkSetAssetsRentable({
        organizationId,
        assetIds: payload.assetIds,
        rentable: payload.rentable,
      });
      title = payload.rentable
        ? "Assets marked as rentable"
        : "Assets removed from rental pool";
    }

    sendNotification({
      title,
      message: `${count} asset${count === 1 ? "" : "s"} updated.`,
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return { ok: true, count } as const;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
