import { useCurrentOrganization } from "~/hooks/use-current-organization";

/**
 * Hook to check if barcodes are enabled for the current organization.
 *
 * `barcodesEnabled` is a paid add-on flag. When premium features are off
 * there is no billing and no way to purchase the add-on, so the flag must
 * not gate anything — otherwise the UI hides barcode controls permanently
 * and the server reports "not enabled for this workspace" with no path to
 * enabling it.
 *
 * Kept in step with `organizationHasBarcodesEnabled` on the server; the two
 * previously disagreed, which is why barcode linking failed as a "paid
 * feature" on a deployment that has no paid tier.
 */
export function useBarcodePermissions() {
  const currentOrganization = useCurrentOrganization();

  const premiumEnabled =
    typeof window !== "undefined" &&
    Boolean(window.env?.ENABLE_PREMIUM_FEATURES);

  const enabled = premiumEnabled
    ? currentOrganization?.barcodesEnabled ?? false
    : true;

  return {
    /**
     * Whether barcodes are enabled for the current organization
     */
    barcodesEnabled: enabled,

    /**
     * Whether the user can use barcode features
     * For now this is the same as barcodesEnabled, but can be extended
     * with tier checks, user role checks, etc.
     */
    canUseBarcodes: enabled,
  };
}
