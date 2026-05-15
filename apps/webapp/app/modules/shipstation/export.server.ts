/**
 * Shipstation Custom Store — Order export (polling endpoint)
 *
 * Shipstation polls `GET /api/shipstation/orders?action=export&start_date=X&end_date=Y`
 * on a schedule (default every 30 min). We respond with one XML
 * document containing every booking request whose state Shipstation
 * needs to see — created or modified within the window.
 *
 * Status mapping:
 *   - APPROVED                          → `awaiting_shipment`
 *   - CANCELLED  (any time)             → `cancelled`
 *   - Everything else                    → NOT exported (we don't push
 *                                          to Shipstation until the
 *                                          customer + Fieldkit have
 *                                          both approved the request).
 *
 * Once Shipstation has imported an order it tracks it by `OrderNumber`;
 * subsequent polls with the same `OrderNumber` update the existing row.
 * That's how cancellations propagate after the fact.
 *
 * @see {@link file://./types.ts}        Shape definitions
 * @see {@link file://./../../routes/api+/shipstation.orders.ts}
 */

import { db } from "~/database/db.server";
import { Logger } from "~/utils/logger";

import type {
  ShipstationAddress,
  ShipstationItem,
  ShipstationOrder,
} from "./types";

/** Shape pulled from `carbon_remote.v1_customer_locations` via FDW. */
type CustomerLocationRow = {
  customer_id: string;
  name: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
};

/** Shape pulled from `carbon_remote.v1_customers` via FDW. */
type CustomerRow = {
  id: string;
  display_name: string | null;
};

/**
 * Returns every booking request Shipstation should know about, in the
 * shape we render to XML. Window is `[start, end]` inclusive on
 * `updatedAt`; Shipstation passes both bounds in ISO 8601 UTC.
 */
export async function listOrdersForExport(args: {
  start: Date;
  end: Date;
}): Promise<ShipstationOrder[]> {
  const { start, end } = args;

  const requests = await db.bookingRequest.findMany({
    where: {
      status: { in: ["APPROVED", "CANCELLED"] },
      updatedAt: { gte: start, lte: end },
    },
    include: {
      assets: {
        select: {
          id: true,
          title: true,
          sequentialId: true,
          carbonPartId: true,
          weightOz: true,
          lengthIn: true,
          widthIn: true,
          heightIn: true,
        },
      },
      requester: {
        select: { email: true, firstName: true, lastName: true },
      },
    },
    orderBy: { updatedAt: "asc" },
  });

  if (requests.length === 0) return [];

  // FDW-resolve customer name + default ship-to address for every
  // distinct customer in this batch. One query each, JOINed in memory.
  const carbonCustomerIds = Array.from(
    new Set(requests.map((r) => r.carbonCustomerId))
  );

  const [customers, locations] = await Promise.all([
    db.$queryRaw<CustomerRow[]>`
      SELECT id, display_name
      FROM carbon_remote.v1_customers
      WHERE id = ANY(${carbonCustomerIds}::text[])
    `,
    db.$queryRaw<(CustomerLocationRow & { id: string })[]>`
      SELECT id, customer_id, name, address_line_1, address_line_2,
             city, state_province, postal_code, country_code, phone
      FROM carbon_remote.v1_customer_locations
      WHERE customer_id = ANY(${carbonCustomerIds}::text[])
      ORDER BY id ASC
    `,
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  // First location per customer is treated as the default — see the
  // contract-views doc comment for the rationale.
  const defaultLocationByCustomerId = new Map<string, CustomerLocationRow>();
  for (const loc of locations) {
    if (!defaultLocationByCustomerId.has(loc.customer_id)) {
      defaultLocationByCustomerId.set(loc.customer_id, loc);
    }
  }

  return requests.map((req) => {
    const customer = customerById.get(req.carbonCustomerId);
    const defaultLocation = defaultLocationByCustomerId.get(
      req.carbonCustomerId
    );
    const shipTo = resolveShipTo({
      request: req,
      defaultLocation,
      fallbackName: customer?.display_name ?? null,
    });

    const items: ShipstationItem[] = req.assets.map((a) => ({
      sku: a.sequentialId ?? a.carbonPartId ?? a.id,
      name: a.title,
      weightOz: a.weightOz ? Number(a.weightOz) : null,
      lengthIn: a.lengthIn ? Number(a.lengthIn) : null,
      widthIn: a.widthIn ? Number(a.widthIn) : null,
      heightIn: a.heightIn ? Number(a.heightIn) : null,
      quantity: 1,
    }));

    return {
      orderNumber: `BR-${req.id}`,
      orderDate: req.createdAt.toISOString(),
      lastModified: req.updatedAt.toISOString(),
      orderStatus:
        req.status === "CANCELLED" ? "cancelled" : "awaiting_shipment",
      shippingMethod: "Standard",
      customerNotes: req.notes,
      internalNotes: null,
      customer: {
        customerCode: req.carbonCustomerId,
        name: customer?.display_name ?? "Unknown Customer",
        company: customer?.display_name ?? null,
        email: req.requester?.email ?? null,
        phone: shipTo.phone,
        shipTo,
      },
      items,
    } satisfies ShipstationOrder;
  });
}

/**
 * Merges per-request overrides with the Carbon-side default location to
 * produce the structured ship-to address. Any non-null field on the
 * request wins. Missing fields fall back to the default. Empty strings
 * are treated as "not provided" so blank fields in the request form
 * still resolve to the default.
 */
function resolveShipTo(args: {
  request: {
    shipToName: string | null;
    shipToPhone: string | null;
    shipToLine1: string | null;
    shipToLine2: string | null;
    shipToCity: string | null;
    shipToState: string | null;
    shipToPostal: string | null;
    shipToCountry: string | null;
  };
  defaultLocation: CustomerLocationRow | undefined;
  fallbackName: string | null;
}): ShipstationAddress {
  const { request, defaultLocation, fallbackName } = args;
  const pick = (
    override: string | null,
    fallback: string | null | undefined
  ): string => nonEmpty(override) ?? nonEmpty(fallback ?? null) ?? "";

  return {
    name: pick(request.shipToName, fallbackName) || "Unknown",
    company: nonEmpty(fallbackName) ?? null,
    line1: pick(request.shipToLine1, defaultLocation?.address_line_1),
    line2:
      nonEmpty(request.shipToLine2) ??
      nonEmpty(defaultLocation?.address_line_2 ?? null),
    city: pick(request.shipToCity, defaultLocation?.city),
    state: pick(request.shipToState, defaultLocation?.state_province),
    postalCode: pick(request.shipToPostal, defaultLocation?.postal_code),
    country: pick(request.shipToCountry, defaultLocation?.country_code) || "US",
    phone:
      nonEmpty(request.shipToPhone) ?? nonEmpty(defaultLocation?.phone ?? null),
  };
}

function nonEmpty(s: string | null): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// =============================================================================
// XML serialization
// =============================================================================
//
// Shipstation's Custom Store schema is small and stable, so hand-rolling
// is cleaner than pulling in an XML library. The escape pass covers
// every character the spec calls out.

/**
 * Wraps the orders in the top-level `<Orders pages="1">` envelope and
 * returns a complete XML document ready to send as
 * `Content-Type: text/xml`.
 *
 * Pagination is not implemented yet — Custom Store supports `pages > 1`
 * by repeating the request with a `page` parameter. We return everything
 * in one document; for Fieldkit's volume that's fine and avoids a
 * pagination state machine. If volumes grow, switch to chunked
 * responses keyed on `updatedAt`.
 */
export function serializeOrdersXml(orders: ShipstationOrder[]): string {
  const body = orders.map(renderOrder).join("");
  Logger.log(`[Shipstation] export → ${orders.length} orders`);
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<Orders pages="1">${body}</Orders>`;
}

function renderOrder(o: ShipstationOrder): string {
  const items = o.items.map(renderItem).join("");
  return [
    "<Order>",
    el("OrderNumber", o.orderNumber),
    el("OrderDate", toShipstationDate(o.orderDate)),
    el("OrderStatus", o.orderStatus),
    el("LastModified", toShipstationDate(o.lastModified)),
    el("ShippingMethod", o.shippingMethod),
    el("PaymentMethod", "Net 30"),
    el("OrderTotal", "0.00"),
    el("TaxAmount", "0.00"),
    el("ShippingAmount", "0.00"),
    el("CustomerNotes", o.customerNotes ?? ""),
    el("InternalNotes", o.internalNotes ?? ""),
    el("Gift", "false"),
    renderCustomer(o),
    `<Items>${items}</Items>`,
    "</Order>",
  ].join("");
}

function renderCustomer(o: ShipstationOrder): string {
  const { customer } = o;
  return [
    "<Customer>",
    el("CustomerCode", customer.customerCode),
    "<BillTo>",
    el("Name", customer.name),
    el("Company", customer.company ?? ""),
    el("Phone", customer.phone ?? ""),
    el("Email", customer.email ?? ""),
    "</BillTo>",
    "<ShipTo>",
    el("Name", customer.shipTo.name),
    el("Company", customer.shipTo.company ?? ""),
    el("Address1", customer.shipTo.line1),
    el("Address2", customer.shipTo.line2 ?? ""),
    el("City", customer.shipTo.city),
    el("State", customer.shipTo.state),
    el("PostalCode", customer.shipTo.postalCode),
    el("Country", customer.shipTo.country),
    el("Phone", customer.shipTo.phone ?? ""),
    "</ShipTo>",
    "</Customer>",
  ].join("");
}

function renderItem(i: ShipstationItem): string {
  // Shipstation accepts integer or float ounces; we send floats with up
  // to three decimals to match the column precision.
  const weightBlock =
    i.weightOz != null
      ? `${el("Weight", i.weightOz.toString())}${el("WeightUnits", "Ounces")}`
      : "";
  const dimBlock = (() => {
    if (i.lengthIn == null && i.widthIn == null && i.heightIn == null)
      return "";
    return [
      "<Options><Option>",
      el("Name", "Dimensions"),
      el("Value", `${i.lengthIn ?? 0}x${i.widthIn ?? 0}x${i.heightIn ?? 0} in`),
      "</Option></Options>",
    ].join("");
  })();
  return [
    "<Item>",
    el("SKU", i.sku),
    el("Name", i.name),
    el("Quantity", i.quantity.toString()),
    el("UnitPrice", "0.00"),
    weightBlock,
    dimBlock,
    "</Item>",
  ].join("");
}

function el(name: string, value: string): string {
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/**
 * Shipstation expects timestamps in `MM/dd/yyyy HH:mm` (PST/PT). We
 * receive ISO from the caller. The trailing zone abbreviation tells
 * Shipstation how to interpret it.
 */
function toShipstationDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  // Convert to PT — Shipstation servers default to PST when the suffix is omitted.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    fmt.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")}/${get("year")} ${pad(
    Number(get("hour")) % 24
  )}:${get("minute")}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
