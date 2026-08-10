/**
 * Productive.io REST client.
 *
 * Thin fetch wrapper over Productive's JSON:API v2 surface. Authentication is
 * two headers — `X-Auth-Token` (an API token from Settings → API integrations)
 * and `X-Organization-Id`.
 *
 * Scope is deliberately narrow. Fieldkit needs exactly three things from
 * Productive:
 *
 *   1. list companies, to mirror customer master data into `Customer`
 *   2. find or create a customer's yearly storage budget
 *   3. create services on that budget, which is how a month's charges land
 *
 * Anything else — invoicing, payments, AR — stays in Productive's UI, where
 * the finance process already lives.
 *
 * @see {@link file://./types.ts}       Resource shapes
 * @see {@link file://./sync.server.ts} Company mirror
 * @see {@link file://./push.server.ts} Charge push
 */

import { PRODUCTIVE_API_TOKEN, PRODUCTIVE_ORGANIZATION_ID } from "~/utils/env";
import { ShelfError } from "~/utils/error";

import {
  PRODUCTIVE_BILLING_TYPE,
  PRODUCTIVE_STAGE_TYPE,
  PRODUCTIVE_UNIT,
  type JsonApiListResponse,
  type JsonApiSingleResponse,
  type ProductiveCompanyAttributes,
  type ProductiveDealAttributes,
  type ProductiveServiceAttributes,
} from "./types";

const label = "Productive" as const;

const API_BASE_URL = "https://api.productive.io/api/v2";

/** Productive caps page size at 200. */
const MAX_PAGE_SIZE = 200;

/**
 * Guard against runaway pagination. At Fieldkit's scale (16 companies) this
 * is never approached; it exists so a malformed `meta` block can't spin
 * forever inside a cron.
 */
const MAX_PAGES = 50;

/**
 * Returns Productive credentials, or throws when unconfigured.
 *
 * Called at the top of every entry point so a misconfigured deploy fails
 * loudly rather than silently syncing nothing — the failure mode that let
 * the Carbon push sit broken without anyone noticing.
 */
function requireConfig(): { token: string; organizationId: string } {
  if (!PRODUCTIVE_API_TOKEN || !PRODUCTIVE_ORGANIZATION_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "Productive is not configured. Set PRODUCTIVE_API_TOKEN and PRODUCTIVE_ORGANIZATION_ID.",
      label,
    });
  }
  return {
    token: PRODUCTIVE_API_TOKEN,
    organizationId: PRODUCTIVE_ORGANIZATION_ID,
  };
}

/** Performs an authenticated JSON:API request against Productive. */
async function request<TResponse>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<TResponse> {
  const { token, organizationId } = requireConfig();
  const method = init?.method ?? "GET";
  const url = `${API_BASE_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-Auth-Token": token,
        "X-Organization-Id": organizationId,
        "Content-Type": "application/vnd.api+json",
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: `Could not reach Productive (${method} ${path}).`,
      label,
      additionalData: { path, method },
    });
  }

  if (!response.ok) {
    // Productive returns JSON:API error objects; surface the detail when we
    // can, since "422 Unprocessable" alone is useless in a cron log.
    let detail = "";
    try {
      const body = (await response.json()) as {
        errors?: Array<{ detail?: string; title?: string }>;
      };
      detail =
        body.errors
          ?.map((e) => e.detail ?? e.title)
          .filter(Boolean)
          .join("; ") ?? "";
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }

    throw new ShelfError({
      cause: null,
      message: `Productive returned ${response.status} for ${method} ${path}.${
        detail ? ` ${detail}` : ""
      }`,
      label,
      additionalData: { path, method, status: response.status },
    });
  }

  // 204 on some writes.
  if (response.status === 204) return undefined as TResponse;

  return (await response.json()) as TResponse;
}

/**
 * Walks every page of a JSON:API collection, returning the flattened list.
 *
 * `filters` are passed as Productive's `filter[key]=value` query params.
 */
async function listAll<TAttributes>(
  resource: string,
  filters: Record<string, string> = {}
): Promise<Array<JsonApiListResponse<TAttributes>["data"][number]>> {
  const collected: Array<JsonApiListResponse<TAttributes>["data"][number]> = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "page[number]": String(page),
      "page[size]": String(MAX_PAGE_SIZE),
    });
    for (const [key, value] of Object.entries(filters)) {
      params.set(`filter[${key}]`, value);
    }

    const body = await request<JsonApiListResponse<TAttributes>>(
      `/${resource}?${params.toString()}`
    );

    collected.push(...body.data);

    const totalPages = body.meta?.total_pages ?? 1;
    if (page >= totalPages || body.data.length === 0) break;
  }

  return collected;
}

/**
 * Lists active client companies.
 *
 * Productive's own organization appears in this list and must be excluded by
 * the caller — it is Fieldkit itself, not a customer.
 */
export async function listCompanies() {
  return listAll<ProductiveCompanyAttributes>("companies", { status: "1" });
}

/**
 * Finds a production budget by exact name for a company.
 *
 * Used to resolve the yearly storage budget before creating one, so repeated
 * pushes reuse the same budget rather than spawning duplicates.
 */
export async function findBudgetByName(args: {
  companyId: string;
  name: string;
}): Promise<{ id: string; name: string } | null> {
  const deals = await listAll<ProductiveDealAttributes>("deals", {
    company_id: args.companyId,
    stage_type: String(PRODUCTIVE_STAGE_TYPE.BUDGET),
  });

  const match = deals.find((d) => d.attributes.name === args.name);
  return match ? { id: match.id, name: match.attributes.name } : null;
}

/**
 * Creates a production budget for a company.
 *
 * @param args.name - Budget name. The push uses `{Company} — Storage {YYYY}`
 *   so each year gets its own book and the name is derivable rather than
 *   stored.
 */
export async function createBudget(args: {
  companyId: string;
  name: string;
}): Promise<{ id: string; name: string }> {
  const body = await request<JsonApiSingleResponse<ProductiveDealAttributes>>(
    "/deals",
    {
      method: "POST",
      body: {
        data: {
          type: "deals",
          attributes: {
            name: args.name,
            // A production budget, not a sales deal — only budgets can be
            // invoiced.
            stage_type: PRODUCTIVE_STAGE_TYPE.BUDGET,
          },
          relationships: {
            company: { data: { type: "companies", id: args.companyId } },
          },
        },
      },
    }
  );

  return { id: body.data.id, name: body.data.attributes.name };
}

/** Lists the services already on a budget. */
export async function listBudgetServices(budgetId: string) {
  return listAll<ProductiveServiceAttributes>("services", {
    deal_id: budgetId,
  });
}

/**
 * Creates a Fixed / Piece service on a budget.
 *
 * Fixed with unit Piece means revenue is `quantity × price`, computed by
 * Productive from the values Shelf supplies — the same shape as every other
 * line Fieldkit already bills (1,500 race bibs at $0.962, and so on).
 *
 * Deliberately NOT an expense: expenses in this organization represent money
 * actually spent with a vendor, carry a markup, and feed cost reporting.
 * Storage revenue has no cost behind it.
 *
 * @param args.priceCents - Unit price in minor units. Productive accepts
 *   fractional cents here, which matters for low per-unit rates.
 */
export async function createBudgetService(args: {
  budgetId: string;
  serviceTypeId: string;
  name: string;
  quantity: number;
  priceCents: number;
  description?: string;
}): Promise<{ id: string; name: string }> {
  const body = await request<
    JsonApiSingleResponse<ProductiveServiceAttributes>
  >("/services", {
    method: "POST",
    body: {
      data: {
        type: "services",
        attributes: {
          name: args.name,
          billing_type_id: PRODUCTIVE_BILLING_TYPE.FIXED,
          unit_id: PRODUCTIVE_UNIT.PIECE,
          quantity: args.quantity,
          price: args.priceCents,
          ...(args.description ? { description: args.description } : {}),
        },
        relationships: {
          deal: { data: { type: "deals", id: args.budgetId } },
          service_type: {
            data: { type: "service_types", id: args.serviceTypeId },
          },
        },
      },
    },
  });

  return { id: body.data.id, name: body.data.attributes.name };
}

/**
 * Updates quantity and price on an existing service.
 *
 * Used when a month is re-pushed after a correction — adjusting in place
 * keeps one line per month rather than accumulating duplicates, and
 * Productive recomputes revenue from the new values.
 */
export async function updateBudgetService(args: {
  serviceId: string;
  quantity: number;
  priceCents: number;
  description?: string;
}): Promise<void> {
  await request(`/services/${args.serviceId}`, {
    method: "PATCH",
    body: {
      data: {
        id: args.serviceId,
        type: "services",
        attributes: {
          quantity: args.quantity,
          price: args.priceCents,
          ...(args.description ? { description: args.description } : {}),
        },
      },
    },
  });
}

/** True when Productive credentials are present. */
export function isProductiveConfigured(): boolean {
  return Boolean(PRODUCTIVE_API_TOKEN && PRODUCTIVE_ORGANIZATION_ID);
}
