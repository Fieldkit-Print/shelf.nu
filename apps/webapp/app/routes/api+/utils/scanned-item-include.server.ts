/**
 * Sanitizers for the client-supplied "extra include" params on the scanned-item
 * lookup endpoints (`get-scanned-item.$qrId`, `get-scanned-barcode.$value`).
 *
 * Those endpoints let the scanner drawer request a couple of extra relations on
 * the resolved asset/kit. The values arrive as JSON in the query string, so
 * they MUST NOT be spread straight into a Prisma `include` — doing so lets any
 * authenticated caller pull arbitrary related records (e.g. custodian PII) or
 * force deeply-nested, expensive queries.
 *
 * Instead we allowlist a fixed set of relation keys and map each to a
 * server-defined `select` shape. Anything the client sends that isn't on the
 * allowlist is dropped, and the client never controls the shape of what's
 * returned for the keys that are allowed.
 *
 * @see {@link file://../get-scanned-item.$qrId.ts}
 * @see {@link file://../get-scanned-barcode.$value.ts}
 */

import type { Prisma } from "@prisma/client";

/**
 * Fixed, safe include shapes for the relations the scanner drawer is allowed to
 * request on an asset. Keyed by the relation name the client passes.
 */
const ALLOWED_ASSET_EXTRA_INCLUDE: Record<string, Prisma.AssetInclude> = {
  location: { location: { select: { id: true, name: true } } },
  kit: { kit: { select: { id: true, name: true } } },
};

/**
 * Fixed, safe include shapes for the relations allowed on a kit. None are
 * currently requested by the client, but the map keeps the two endpoints
 * symmetric and makes future additions explicit.
 */
const ALLOWED_KIT_EXTRA_INCLUDE: Record<string, Prisma.KitInclude> = {};

/**
 * Builds a safe `Prisma.AssetInclude` from the raw, client-supplied value by
 * keeping only allowlisted relation keys and substituting server-defined
 * shapes for them.
 *
 * @param raw - The parsed (untrusted) `assetExtraInclude` value.
 * @returns A sanitized include, or `undefined` when nothing allowlisted was
 *   requested.
 */
export function sanitizeAssetExtraInclude(
  raw: unknown
): Prisma.AssetInclude | undefined {
  return pickAllowed(raw, ALLOWED_ASSET_EXTRA_INCLUDE);
}

/**
 * Builds a safe `Prisma.KitInclude` from the raw, client-supplied value by
 * keeping only allowlisted relation keys and substituting server-defined
 * shapes for them.
 *
 * @param raw - The parsed (untrusted) `kitExtraInclude` value.
 * @returns A sanitized include, or `undefined` when nothing allowlisted was
 *   requested.
 */
export function sanitizeKitExtraInclude(
  raw: unknown
): Prisma.KitInclude | undefined {
  return pickAllowed(raw, ALLOWED_KIT_EXTRA_INCLUDE);
}

/**
 * Returns the union of the server-defined shapes for whichever allowlisted keys
 * are present (and truthy) on `raw`. The client only decides *whether* a
 * relation is included — never its shape.
 */
function pickAllowed<T extends Record<string, unknown>>(
  raw: unknown,
  allowed: Record<string, T>
): T | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  let result: T | undefined;
  for (const [key, shape] of Object.entries(allowed)) {
    if ((raw as Record<string, unknown>)[key]) {
      result = { ...(result ?? ({} as T)), ...shape };
    }
  }
  return result;
}
