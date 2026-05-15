/**
 * Shipstation Custom Store — Shipnotify handler
 *
 * Shipstation POSTs to `/api/shipstation/orders?action=shipnotify&...`
 * every time a label is printed for one of our orders. The same URL
 * receives notifications for both outbound shipments and return-label
 * generations, distinguished by an `is_return` flag (Shipstation
 * documents this only loosely; we accept several truthy spellings).
 *
 * On outbound shipnotify: stamp `shipstationShippedAt` + tracking on
 * the booking request and bubble the status to the associated Booking
 * (now ONGOING — assets are in transit, not at Fieldkit).
 *
 * On return shipnotify: stamp `shipstationReturnLabelCreatedAt` +
 * return tracking. Booking status is NOT changed here — the return is
 * still in the customer's possession at this point; the actual return
 * receipt is captured by Fieldkit's intake workflow when the package
 * shows up.
 *
 * @see {@link file://./types.ts}        Shipnotify payload shape
 * @see {@link file://./../../routes/api+/shipstation.orders.ts}
 */

import { db } from "~/database/db.server";
import { Logger } from "~/utils/logger";

import type { ShipstationShipnotify } from "./types";

const ORDER_NUMBER_PREFIX = "BR-";

/**
 * Pulls shipnotify fields off the request URL + body. Shipstation puts
 * the essentials in the query string but their docs hint that future
 * versions may move some to the body — we read query first and fall
 * back to the body for missing fields.
 */
export async function parseShipnotify(
  request: Request
): Promise<ShipstationShipnotify> {
  const url = new URL(request.url);
  const qs = url.searchParams;

  let body: Record<string, unknown> = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  } else if (
    request.headers
      .get("content-type")
      ?.includes("application/x-www-form-urlencoded")
  ) {
    const form = await request.formData().catch(() => null);
    if (form) {
      body = Object.fromEntries(form.entries());
    }
  }

  const pick = (key: string): string | null => {
    const fromQs = qs.get(key);
    if (fromQs != null && fromQs !== "") return fromQs;
    const fromBody = body[key];
    if (typeof fromBody === "string" && fromBody !== "") return fromBody;
    return null;
  };

  const isReturnRaw =
    pick("is_return") ?? pick("isReturn") ?? pick("return_label") ?? "false";

  return {
    orderNumber: pick("order_number") ?? pick("orderNumber") ?? "",
    carrier: pick("carrier"),
    service: pick("service"),
    trackingNumber: pick("tracking_number") ?? pick("trackingNumber"),
    shipDate: pick("ship_date") ?? pick("shipDate"),
    isReturn: ["1", "true", "yes", "on"].includes(isReturnRaw.toLowerCase()),
  };
}

/**
 * Applies a parsed shipnotify to the matching BookingRequest. Returns
 * a short summary string suitable for telemetry / debug logs.
 *
 * Idempotent — replaying the same shipnotify just overwrites the
 * already-stamped columns with the same values.
 */
export async function applyShipnotify(
  notify: ShipstationShipnotify
): Promise<string> {
  if (!notify.orderNumber.startsWith(ORDER_NUMBER_PREFIX)) {
    Logger.warn(`[Shipstation] shipnotify with unrecognised order_number`, {
      orderNumber: notify.orderNumber,
    });
    return `ignored: order_number ${notify.orderNumber} not in BR- namespace`;
  }
  const bookingRequestId = notify.orderNumber.slice(ORDER_NUMBER_PREFIX.length);

  const shippedAt = notify.shipDate ? new Date(notify.shipDate) : new Date();

  if (notify.isReturn) {
    const updated = await db.bookingRequest.update({
      where: { id: bookingRequestId },
      data: {
        shipstationReturnLabelCreatedAt: shippedAt,
        shipstationReturnTrackingNumber: notify.trackingNumber,
      },
      select: { id: true },
    });
    Logger.log(`[Shipstation] return label recorded`, {
      bookingRequestId: updated.id,
      trackingNumber: notify.trackingNumber,
    });
    return `return label recorded on booking request ${updated.id}`;
  }

  const updated = await db.bookingRequest.update({
    where: { id: bookingRequestId },
    data: {
      shipstationShippedAt: shippedAt,
      shipstationTrackingNumber: notify.trackingNumber,
      shipstationCarrier: notify.carrier,
    },
    select: { id: true, bookingId: true },
  });

  Logger.log(`[Shipstation] outbound shipment recorded`, {
    bookingRequestId: updated.id,
    bookingId: updated.bookingId,
    trackingNumber: notify.trackingNumber,
  });
  return `outbound shipment recorded on booking request ${updated.id}`;
}
