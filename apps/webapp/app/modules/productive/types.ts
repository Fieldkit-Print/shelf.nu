/**
 * Productive.io — shared types.
 *
 * Only the slice of Productive's model Fieldkit touches is described here:
 * companies (customer master data), deals/budgets and services (where storage
 * charges land). Productive speaks JSON:API, so every resource arrives as
 * `{ id, type, attributes, relationships }` rather than a flat object.
 *
 * @see {@link file://./client.server.ts} REST client
 * @see {@link file://./sync.server.ts}   Companies → Customer mirror
 * @see {@link file://./push.server.ts}   BillableEvent → budget services
 */

/** A JSON:API resource object as Productive returns it. */
export type JsonApiResource<TAttributes> = {
  id: string;
  type: string;
  attributes: TAttributes;
  relationships?: Record<
    string,
    {
      data?: { id: string; type: string } | Array<{ id: string; type: string }>;
    }
  >;
};

/** A JSON:API collection response, including pagination metadata. */
export type JsonApiListResponse<TAttributes> = {
  data: Array<JsonApiResource<TAttributes>>;
  included?: Array<JsonApiResource<Record<string, unknown>>>;
  meta?: {
    current_page?: number;
    total_pages?: number;
    total_count?: number;
    page_size?: number;
  };
};

/** A JSON:API single-resource response. */
export type JsonApiSingleResponse<TAttributes> = {
  data: JsonApiResource<TAttributes>;
  included?: Array<JsonApiResource<Record<string, unknown>>>;
};

/** Company attributes Fieldkit mirrors into `Customer`. */
export type ProductiveCompanyAttributes = {
  name: string;
  /** Short code shown in Productive's UI, e.g. "HOKA". */
  company_code: string | null;
  /** 1 = active, 2 = archived. */
  status: number | null;
  billing_name: string | null;
  /** Free-form default invoice email, when set on the company. */
  email: string | null;
  /** Default ship-to, when the company records one. */
  address: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  country: string | null;
  phone: string | null;
};

/** Deal/budget attributes needed to find or create a storage budget. */
export type ProductiveDealAttributes = {
  name: string;
  /** 1 = sales deal, 2 = production budget. */
  stage_type?: number | null;
  /** 1 = open, 2 = closed. */
  status?: number | null;
  suffix?: string | null;
};

/** Service attributes for a storage or handling charge line. */
export type ProductiveServiceAttributes = {
  name: string;
  /** 1 = Fixed, 2 = Time and materials, 3 = Non billable, 4 = Percentage. */
  billing_type_id?: number | null;
  /** 1 = Hour, 2 = Piece, 3 = Day, 4 = Percentage. */
  unit_id?: number | null;
  quantity?: number | null;
  /** Unit price in minor units (cents). */
  price?: number | null;
  description?: string | null;
};

/**
 * Productive billing-type ids. Storage and handling lines are always Fixed:
 * Shelf has already computed the amount, so Productive shouldn't recompute
 * anything from time or expenses.
 */
export const PRODUCTIVE_BILLING_TYPE = {
  FIXED: 1,
  TIME_AND_MATERIALS: 2,
  NON_BILLABLE: 3,
  PERCENTAGE: 4,
} as const;

/**
 * Productive tracking-unit ids. Everything Fieldkit pushes is billed by the
 * Piece — a pallet-month, a pick, a return — matching how the "Monthly
 * Storage Fees" rate card is written.
 */
export const PRODUCTIVE_UNIT = {
  HOUR: 1,
  PIECE: 2,
  DAY: 3,
  PERCENTAGE: 4,
} as const;

/** Productive deal `stage_type` values. */
export const PRODUCTIVE_STAGE_TYPE = {
  SALES_DEAL: 1,
  BUDGET: 2,
} as const;

/**
 * Maps a `BillableEventKind` to the Productive service type it should be
 * booked against.
 *
 * These ids are Fieldkit-specific and were read from the live organization:
 * Storage (448666) and Rental (448725) are dedicated types, while picks and
 * returns are warehouse labour and belong under Staffing / Install (438951),
 * which is where the rate card already files "Outbound Pull, Prep, and Pack"
 * and "Receiving and Restock".
 *
 * Overridable via `PRODUCTIVE_SERVICE_TYPE_IDS` should the ids ever change,
 * so a Productive reconfiguration doesn't require a deploy.
 */
export const DEFAULT_SERVICE_TYPE_IDS = {
  STORAGE: "448666",
  RENTAL_USE: "448725",
  PICK: "438951",
  RETURN: "438951",
  RENTAL_LOSS: "438951",
  CONSUMABLE_USE: "438950",
} as const;

/** Result of a single sync run, for logging and the admin trigger response. */
export type ProductiveSyncResult = {
  /** Companies seen in Productive. */
  fetched: number;
  /** Customer rows created. */
  created: number;
  /** Customer rows updated in place. */
  updated: number;
  /** Companies skipped (archived, or Fieldkit's own company). */
  skipped: number;
  errors: number;
};

/** Result of a monthly push run. */
export type ProductivePushResult = {
  /** Billing month, `YYYY-MM`. */
  month: string;
  /** Distinct (customer, kind, rate) groups rolled up. */
  groups: number;
  /** Services created in Productive. */
  servicesCreated: number;
  /** Services already present and reused. */
  servicesReused: number;
  /** BillableEvent rows marked PUSHED. */
  eventsPushed: number;
  /** Groups skipped because the customer has no Productive company. */
  skippedUnlinked: number;
  errors: number;
};
