/**
 * POST /api/productive/admin
 *
 * Staff-only manual triggers for the Productive integration. The crons run on
 * their own schedule; this exists so an operator can pull a newly-created
 * company straight away, or preview a month's charges before they are sent.
 *
 * Intents:
 *   - `sync-customers`  — refresh the local `Customer` mirror from Productive
 *   - `preview-charges` — dry-run the monthly push; computes and logs the
 *     charge lines without writing anything to Productive or the ledger
 *   - `push-charges`    — run the monthly push for real
 *
 * `push-charges` creates real billable lines on a customer's budget, so it is
 * gated behind the same permission as workspace settings rather than plain
 * asset access.
 *
 * @see {@link file://./../../modules/productive/sync.server.ts}
 * @see {@link file://./../../modules/productive/push.server.ts}
 */

import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";

import {
  isProductiveConfigured,
  pushMonthlyChargesToProductive,
  syncCustomersFromProductive,
} from "~/modules/productive";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { assertIsPost, error, parseData, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const PayloadSchema = z.object({
  intent: z.enum(["sync-customers", "preview-charges", "push-charges"]),
  /**
   * Billing month as `YYYY-MM`. Optional — the push defaults to the month
   * that just closed. Supplied when backfilling an earlier month.
   */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Month must be in YYYY-MM format")
    .optional(),
});

/** `2026-08` → UTC midnight on 2026-08-01. */
function parseMonth(month: string | undefined): Date | undefined {
  if (!month) return undefined;
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    assertIsPost(request);

    // generalSettings:update is staff-only — BASE, SELF_SERVICE and CUSTOMER
    // all hold an empty action list for it.
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });

    if (!isProductiveConfigured()) {
      throw new ShelfError({
        cause: null,
        title: "Productive is not configured",
        message:
          "Set PRODUCTIVE_API_TOKEN and PRODUCTIVE_ORGANIZATION_ID before running a sync or push.",
        label: "Productive",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const { intent, month } = parseData(
      await request.formData(),
      PayloadSchema,
      { additionalData: { userId } }
    );

    switch (intent) {
      case "sync-customers": {
        const result = await syncCustomersFromProductive();
        sendNotification({
          title: "Customers synced",
          message: `${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });
        return data(payload({ intent, result }));
      }

      case "preview-charges": {
        const result = await pushMonthlyChargesToProductive({
          month: parseMonth(month),
          dryRun: true,
        });
        sendNotification({
          title: "Preview complete",
          message: `${result.groups} charge lines would be created for ${result.month}. Nothing was sent.`,
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });
        return data(payload({ intent, result }));
      }

      case "push-charges": {
        const result = await pushMonthlyChargesToProductive({
          month: parseMonth(month),
        });
        sendNotification({
          title: "Charges pushed",
          message: `${result.servicesCreated} created, ${result.servicesReused} updated, ${result.eventsPushed} events billed for ${result.month}.`,
          icon: { name: "success", variant: "success" },
          senderId: userId,
        });
        return data(payload({ intent, result }));
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
