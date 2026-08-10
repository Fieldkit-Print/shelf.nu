import type { Organization } from "@prisma/client";
import { ShelfError } from "../error";
import { premiumIsEnabled } from "../stripe.server";

/**
 * Server-side utility to check if barcodes are enabled for an organization.
 *
 * `barcodesEnabled` is a paid add-on flag, so it only means anything when
 * premium features are switched on. On a self-hosted deployment
 * (`ENABLE_PREMIUM_FEATURES` unset) there is no billing and no way to buy the
 * add-on, so the flag must not gate anything — otherwise the feature is
 * permanently unreachable and reports itself as "not enabled for this
 * workspace" with no path to enabling it.
 *
 * This mirrors `canUseBarcodes` in `utils/subscription.server.ts`, which
 * already had the premium check; this validator and the client hook did not,
 * so three of the four gates disagreed.
 */
export function organizationHasBarcodesEnabled(
  organization: Pick<Organization, "barcodesEnabled"> | undefined | null
): boolean {
  if (!premiumIsEnabled) return true;
  if (!organization) return false;
  return organization.barcodesEnabled;
}

/**
 * Server-side utility to validate that an organization has barcodes enabled
 * Throws ShelfError if not enabled
 */
export function validateBarcodeEnabled(
  organization: Pick<Organization, "barcodesEnabled"> | undefined | null,
  additionalData?: Record<string, any>
): void {
  if (!organizationHasBarcodesEnabled(organization)) {
    throw new ShelfError({
      cause: null,
      title: "Barcodes not enabled",
      message: "Barcode functionality is not enabled for this workspace",
      status: 403,
      additionalData,
      label: "Barcode",
      shouldBeCaptured: false,
    });
  }
}
