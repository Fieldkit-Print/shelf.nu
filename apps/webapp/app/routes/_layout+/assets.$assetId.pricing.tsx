/**
 * Asset detail → Pricing tab.
 *
 * Per-asset override for storage and rental rates. Most-specific tier in the
 * org → customer → asset hierarchy; blank fields fall through to the
 * customer or org tier.
 *
 * Pick / return / rental-loss multiplier / consumable markup are not
 * settable per-asset — those are customer- or org-wide policies, not
 * item-level economics.
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import { z } from "zod";

import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import { centsToDollars, dollarsToCents } from "~/modules/pricing/format";
import {
  getAssetPricing,
  upsertAssetPricing,
} from "~/modules/pricing/service.server";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import {
  assertIsPost,
  error,
  getParams,
  parseData,
  payload,
  type DataOrErrorResponse,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const ParamSchema = z.object({ assetId: z.string() });

const PricingFormSchema = z.object({
  storagePerDayDollars: z.string().optional(),
  rentalPerDayDollars: z.string().optional(),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId } = getParams(params, ParamSchema, {
    additionalData: { userId },
  });

  try {
    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    const pricing = await getAssetPricing(assetId);
    return data(payload({ pricing }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [{ title: "Asset pricing" }];

export const handle = {
  breadcrumb: () => "Pricing",
};

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId } = getParams(params, ParamSchema, {
    additionalData: { userId },
  });

  try {
    assertIsPost(request);

    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const parsed = parseData(formData, PricingFormSchema, {
      additionalData: { assetId },
    });

    await upsertAssetPricing({
      assetId,
      patch: {
        storagePerDayCents: dollarsToCents(parsed.storagePerDayDollars),
        rentalPerDayCents: dollarsToCents(parsed.rentalPerDayDollars),
      },
    });

    sendNotification({
      title: "Pricing updated",
      message: "Asset pricing overrides saved.",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return data(payload({ success: true }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, assetId });
    return data(error(reason), { status: reason.status });
  }
}

export default function AssetPricingTab() {
  const { pricing } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const disabled = useDisabled();
  const generalError = actionData?.error?.message;

  return (
    <div className="my-4 max-w-2xl">
      {generalError ? (
        <div className="mb-4 rounded-lg border border-error-300 bg-error-50 px-4 py-3 text-sm text-error-700">
          {generalError}
        </div>
      ) : null}

      <Form
        method="POST"
        className="rounded-lg border border-gray-200 bg-white"
      >
        <div className="border-b border-gray-100 px-4 py-3 md:px-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Asset pricing overrides
          </h3>
          <p className="text-xs text-gray-500">
            Most-specific tier. Blank fields fall through to the customer or org
            default (set at the{" "}
            <Link
              to="/settings/pricing"
              className="text-primary-700 hover:underline"
            >
              workspace level
            </Link>
            ). Pick, return, and the multipliers are not settable per asset.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 md:px-6">
          <Input
            label="Storage / day ($)"
            name="storagePerDayDollars"
            defaultValue={centsToDollars(pricing?.storagePerDayCents)}
            type="number"
            step="0.01"
            min="0"
            placeholder="(use default)"
          />
          <Input
            label="Rental / day ($)"
            name="rentalPerDayDollars"
            defaultValue={centsToDollars(pricing?.rentalPerDayCents)}
            type="number"
            step="0.01"
            min="0"
            placeholder="(use default)"
          />
        </div>

        <div className="flex justify-end border-t border-gray-100 px-4 py-3 md:px-6">
          <Button type="submit" size="sm" disabled={disabled}>
            {disabled ? "Saving…" : "Save pricing"}
          </Button>
        </div>
      </Form>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
