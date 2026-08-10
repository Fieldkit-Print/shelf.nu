/**
 * Workspace settings → Pricing.
 *
 * One form for the org-default tier (OrgPricing). Customer- and asset-
 * level overrides live on the customer detail and asset detail pages.
 *
 * Numbers are entered as decimal dollars in the form; the action layer
 * converts to integer cents before persisting. Multipliers (rental loss,
 * consumable markup) are stored as Decimal and entered as plain numbers
 * (e.g. 1.5 for 150%, 0.25 for 25%).
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";

import { ErrorContent } from "~/components/errors";
import Input from "~/components/forms/input";
import Header from "~/components/layout/header";
import { Button } from "~/components/shared/button";
import { useDisabled } from "~/hooks/use-disabled";
import {
  centsToDollars,
  dollarsToCents,
  moneyDollarsSchema,
} from "~/modules/pricing/format";
import {
  getOrgPricing,
  upsertOrgPricing,
} from "~/modules/pricing/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import { getValidationErrors } from "~/utils/http";
import {
  assertIsPost,
  error,
  parseData,
  payload,
  type DataOrErrorResponse,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * The form schema accepts string inputs and coerces. Empty strings
 * indicate "clear this field" (null in DB). The decimal-valued
 * multipliers go through the same string-or-empty pattern.
 */
const PricingFormSchema = z.object({
  /**
   * Monthly rate per occupied pallet position, one per slot tier. Storage is
   * sold by the position per month — there is no daily rate on the rate card.
   * OVERSIZE is absent by design: it is quoted per slot on the location
   * itself, since custom footprints have no standard price.
   */
  storageHalfPalletDollars: moneyDollarsSchema,
  storageStandardPalletDollars: moneyDollarsSchema,
  storageTallPalletDollars: moneyDollarsSchema,
  pickDollars: moneyDollarsSchema,
  returnDollars: moneyDollarsSchema,
  rentalPerDayDollars: moneyDollarsSchema,
  rentalLossMultiplier: z.string().optional(),
  consumableMarkupPct: z.string().optional(),
  currencyCode: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .transform((s) => s.toUpperCase())
    .default("USD"),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      // generalSettings is the closest existing entity that ADMIN/OWNER have
      // and BASE/SELF_SERVICE/CUSTOMER do not. Tightens to staff only.
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });

    const orgPricing = await getOrgPricing(organizationId);

    return data(
      payload({
        header: { title: "Pricing" },
        pricing: orgPricing,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta = ({ data }: { data: { header: { title: string } } }) => [
  { title: appendToMetaTitle(data?.header?.title ?? "Pricing") },
];

export const handle = {
  breadcrumb: () => "Pricing",
};

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  try {
    assertIsPost(request);

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.update,
    });

    const formData = await request.formData();
    const parsed = parseData(formData, PricingFormSchema);

    // Decimal columns: send raw string to Prisma (it accepts string for Decimal);
    // empty string → null.
    const decimalOrNull = (v: string | undefined) => {
      const trimmed = v?.trim();
      if (!trimmed) return null;
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return null;
      return trimmed;
    };

    await upsertOrgPricing({
      organizationId,
      patch: {
        storageHalfPalletCents: dollarsToCents(parsed.storageHalfPalletDollars),
        storageStandardPalletCents: dollarsToCents(
          parsed.storageStandardPalletDollars
        ),
        storageTallPalletCents: dollarsToCents(parsed.storageTallPalletDollars),
        pickCents: dollarsToCents(parsed.pickDollars),
        returnCents: dollarsToCents(parsed.returnDollars),
        rentalPerDayCents: dollarsToCents(parsed.rentalPerDayDollars),
        rentalLossMultiplier: decimalOrNull(parsed.rentalLossMultiplier),
        consumableMarkupPct: decimalOrNull(parsed.consumableMarkupPct),
        currencyCode: parsed.currencyCode,
      },
    });

    sendNotification({
      title: "Pricing updated",
      message: "Default rates saved.",
      icon: { name: "success", variant: "success" },
      senderId: userId,
    });

    return data(payload({ success: true }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export default function PricingSettings() {
  const { pricing } = useLoaderData<typeof loader>();
  const actionData = useActionData<DataOrErrorResponse>();
  const disabled = useDisabled();

  /** This handles server side errors in case client side validation fails */
  const validationErrors = getValidationErrors<typeof PricingFormSchema>(
    actionData?.error
  );

  // Render the action's error message at the top of the form when present.
  const generalError = actionData?.error?.message;

  return (
    <>
      <Header />
      <Form method="POST" className="max-w-3xl space-y-6">
        {generalError ? (
          <div className="rounded-lg border border-error-300 bg-error-50 px-4 py-3 text-sm text-error-700">
            {generalError}
          </div>
        ) : null}

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-semibold text-gray-900">
            Default rates
          </h2>
          <p className="mb-4 text-xs text-gray-500">
            These rates apply when no customer- or asset-level override is set.
            Leave a field blank to express "no charge of this kind" — the
            emitter will skip writing billable events for that kind.
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Input
                label="Storage / month — half pallet"
                name="storageHalfPalletDollars"
                defaultValue={centsToDollars(pricing?.storageHalfPalletCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                error={validationErrors?.storageHalfPalletDollars?.message}
              />
              <p className="mt-1 text-xs text-gray-500">
                48&times;40 footprint, under 2 ft tall. Per occupied position,
                per month.
              </p>
            </div>
            <div>
              <Input
                label="Storage / month — standard pallet"
                name="storageStandardPalletDollars"
                defaultValue={centsToDollars(
                  pricing?.storageStandardPalletCents
                )}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                error={validationErrors?.storageStandardPalletDollars?.message}
              />
              <p className="mt-1 text-xs text-gray-500">
                48&times;40 footprint, up to 4 ft tall.
              </p>
            </div>
            <div>
              <Input
                label="Storage / month — tall pallet"
                name="storageTallPalletDollars"
                defaultValue={centsToDollars(pricing?.storageTallPalletCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                error={validationErrors?.storageTallPalletDollars?.message}
              />
              <p className="mt-1 text-xs text-gray-500">
                48&times;40 footprint, over 4 ft tall. Oversize and custom
                footprints are priced per slot on the location itself.
              </p>
            </div>
            <div>
              <Input
                label="Rental / day"
                name="rentalPerDayDollars"
                defaultValue={centsToDollars(pricing?.rentalPerDayCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
              />
              <p className="mt-1 text-xs text-gray-500">
                Per Fieldkit-owned rentable asset, per day on an active booking.
              </p>
            </div>
            <div>
              <Input
                label="Pick"
                name="pickDollars"
                defaultValue={centsToDollars(pricing?.pickCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
              />
              <p className="mt-1 text-xs text-gray-500">
                Flat charge when a customer-owned asset is shipped out.
              </p>
            </div>
            <div>
              <Input
                label="Return"
                name="returnDollars"
                defaultValue={centsToDollars(pricing?.returnCents)}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
              />
              <p className="mt-1 text-xs text-gray-500">
                Flat charge when a customer-owned asset comes back.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-semibold text-gray-900">
            Multipliers
          </h2>
          <p className="mb-4 text-xs text-gray-500">
            Decimal values. 1.5 means 150%, 0.25 means 25%.
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Input
                label="Rental-loss multiplier"
                name="rentalLossMultiplier"
                defaultValue={pricing?.rentalLossMultiplier?.toString() ?? ""}
                type="number"
                step="0.0001"
                min="0"
                placeholder="1.5"
              />
              <p className="mt-1 text-xs text-gray-500">
                Applied to Asset.valuation when a rental is declared lost.
              </p>
            </div>
            <div>
              <Input
                label="Consumable markup"
                name="consumableMarkupPct"
                defaultValue={pricing?.consumableMarkupPct?.toString() ?? ""}
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.25"
              />
              <p className="mt-1 text-xs text-gray-500">
                Applied to a consumable item's unit cost on consumption.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-semibold text-gray-900">Currency</h2>
          <p className="mb-4 text-xs text-gray-500">
            ISO-4217 three-letter code. All cents fields above are interpreted
            in this currency.
          </p>
          <Input
            label="Currency code"
            name="currencyCode"
            defaultValue={pricing?.currencyCode ?? "USD"}
            maxLength={3}
            placeholder="USD"
            className="md:w-32"
          />
        </section>

        <div className="flex items-center justify-end">
          <Button type="submit" disabled={disabled}>
            {disabled ? "Saving…" : "Save pricing"}
          </Button>
        </div>
      </Form>
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
