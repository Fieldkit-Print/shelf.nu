/**
 * Shipstation Custom Store — Basic auth
 *
 * Shipstation authenticates outbound requests to our `/api/shipstation/orders`
 * endpoint with basic auth using credentials configured in their UI under
 * Settings → Stores → Custom Store. We match the provided creds against
 * the `SHIPSTATION_BASIC_AUTH_*` env vars in constant time.
 *
 * @see {@link file://./../../routes/api+/shipstation.orders.ts}
 */

import { timingSafeEqual } from "node:crypto";

import {
  SHIPSTATION_BASIC_AUTH_PASSWORD,
  SHIPSTATION_BASIC_AUTH_USERNAME,
} from "~/utils/env";

/**
 * Returns true when the request's basic-auth header matches the
 * configured Shipstation credentials, false otherwise. Throws if the
 * server isn't configured at all so misconfigured deploys fail loudly
 * instead of silently rejecting every poll.
 */
export function verifyShipstationBasicAuth(request: Request): boolean {
  if (!SHIPSTATION_BASIC_AUTH_USERNAME || !SHIPSTATION_BASIC_AUTH_PASSWORD) {
    throw new Error(
      "Shipstation basic-auth credentials are not configured. Set " +
        "SHIPSTATION_BASIC_AUTH_USERNAME and SHIPSTATION_BASIC_AUTH_PASSWORD."
    );
  }

  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("basic ")) {
    return false;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }

  const sep = decoded.indexOf(":");
  if (sep === -1) return false;

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  return (
    timingSafeBufferEqual(username, SHIPSTATION_BASIC_AUTH_USERNAME) &&
    timingSafeBufferEqual(password, SHIPSTATION_BASIC_AUTH_PASSWORD)
  );
}

/**
 * Length-tolerant constant-time comparison. `timingSafeEqual` itself
 * throws on length mismatch, so we pad-and-compare via Buffer length
 * checks first.
 */
function timingSafeBufferEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
