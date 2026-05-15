/**
 * Shipstation Custom Store — Shared Types
 *
 * Phase 1 of the Shipstation integration: Shelf is a "Custom Store" that
 * Shipstation polls for orders. One outbound order per approved
 * `BookingRequest`. Returns are generated from the same order inside
 * Shipstation via the built-in "Create Return Label" flow and reported
 * back through the shared shipnotify URL.
 *
 * @see {@link file://./export.server.ts}    Polling export endpoint logic
 * @see {@link file://./shipnotify.server.ts} Shipnotify POST handler
 * @see https://help.shipstation.com/hc/en-us/articles/360025856212-Custom-Store
 */

/**
 * An order as Shelf renders it for Shipstation. Mirrors the subset of
 * Shipstation's Custom Store XML schema we actually populate. Keep
 * snake-cased XML names readable on the TS side.
 */
export type ShipstationOrder = {
  /**
   * Stable identifier — `BR-<bookingRequestId>`. Shipstation uses this as
   * its primary key for the order, so it must never change for a given
   * `BookingRequest`.
   */
  orderNumber: string;
  /** ISO 8601 — when the booking request was created. */
  orderDate: string;
  /** ISO 8601 — when the booking request was last touched. */
  lastModified: string;
  /**
   * One of `awaiting_payment` / `awaiting_shipment` / `shipped` /
   * `cancelled`. For Phase 1 every Shelf-pushed order is either
   * `awaiting_shipment` or `cancelled`; outbound flips to `shipped`
   * after Shipstation's shipnotify fires (we never push that state — it
   * gets reported back to us).
   */
  orderStatus: "awaiting_shipment" | "cancelled" | "shipped";
  /** Free-text shown to the operator in Shipstation; "Standard" is fine. */
  shippingMethod: string;
  /** Notes the customer / requester left at request time. */
  customerNotes: string | null;
  /** Notes Fieldkit staff want to surface to the picker. */
  internalNotes: string | null;
  customer: ShipstationCustomer;
  items: ShipstationItem[];
};

export type ShipstationCustomer = {
  /** Stable id for the customer — we use the Carbon customer id. */
  customerCode: string;
  /**
   * Both BillTo and ShipTo are populated with the same structured address
   * for Phase 1. Shipstation requires BillTo to exist even though we
   * don't use it for invoicing.
   */
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  shipTo: ShipstationAddress;
};

export type ShipstationAddress = {
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
};

export type ShipstationItem = {
  /** Shelf sequential id (e.g. "SAM-0024") or carbonPartId fallback. */
  sku: string;
  /** Display name — "<item.name> #<serial>" for INSTANCE rows. */
  name: string;
  /** Ounces. Null when the asset hasn't been measured yet. */
  weightOz: number | null;
  /** Inches. Null when unknown. */
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  quantity: number;
};

/**
 * Body shape Shipstation POSTs to `/api/shipstation/orders?action=shipnotify`.
 * Shipstation puts most fields in the query string and an XML body; we
 * normalize both into this shape inside the handler.
 *
 * The `isReturn` flag is what distinguishes outbound shipnotifies (label
 * for the outbound order) from return-label notifies (operator clicked
 * "Create Return Label" on the original order — Shipstation still pings
 * the same URL but flags it as a return).
 */
export type ShipstationShipnotify = {
  orderNumber: string;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  isReturn: boolean;
};
