/**
 * Carbon REST API Client
 *
 * Thin fetch wrapper around Carbon ERP's public REST API. Carbon authenticates
 * via the `carbon-key` header (a scoped API key issued in
 * Settings → API Keys with `view: sales` permission for Fieldkit's company).
 *
 * What this module is for:
 *
 * 1. **Webhook follow-ups** — when a `customerContact` INSERT event fires,
 *    the payload only carries the junction row (contactId + customerId).
 *    To mirror the contact to a shelf User we need its email/name, which
 *    {@link fetchContactInCustomer} pulls via Carbon's customer-contacts
 *    endpoint.
 * 2. **Reconciliation cron** — see {@link iterateCustomers} and
 *    {@link iterateCustomerContactsWithContact} which page through Carbon's
 *    customer + customerContact data for Fieldkit's company.
 *
 * Notes on Carbon's REST surface:
 *
 *   - `GET /api/sales/customers` returns `{ data: [{ id, name }], count, error }`.
 *     Just `id` + `name` — no `mergedIntoCustomerId`. Webhook UPDATE events
 *     carry the full row, so backfill is best-effort for merge state.
 *   - `GET /api/sales/customer-contacts/:customerId` returns
 *     `{ data: [{ ..junction.., contact: { ..contact.. }, user: { id, active } }], count, error }`.
 *   - There's no "get customer by id" or "get contact by id" endpoint —
 *     we either filter the list or fetch by parent customer.
 *
 * @see {@link file://./types.ts}            Shapes
 * @see {@link file://./service.server.ts}   Upsert dispatch
 */

import {
  CARBON_API_BASE_URL,
  CARBON_API_KEY,
  FIELDKIT_CARBON_COMPANY_ID,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

import type { CarbonContact } from "./types";

/**
 * Returns Carbon API config or throws when misconfigured. Use at the top of
 * any sync entry point so misconfigured deploys fail loudly instead of
 * silently no-op'ing.
 */
function requireCarbonConfig(): { baseUrl: string; apiKey: string } {
  if (!CARBON_API_BASE_URL || !CARBON_API_KEY) {
    throw new ShelfError({
      cause: null,
      message:
        "Carbon API is not configured. Set CARBON_API_BASE_URL and CARBON_API_KEY.",
      label: "Carbon Sync",
    });
  }
  return { baseUrl: CARBON_API_BASE_URL, apiKey: CARBON_API_KEY };
}

/**
 * Returns Fieldkit's Carbon company id, or throws if unconfigured. Centralised
 * so every helper applies the company filter the same way (Carbon's API
 * already scopes by the API key's company, but we keep the env var for
 * payload-side validation in webhook.server.ts).
 */
function requireCompanyId(): string {
  if (!FIELDKIT_CARBON_COMPANY_ID) {
    throw new ShelfError({
      cause: null,
      message:
        "FIELDKIT_CARBON_COMPANY_ID is not set. Set it to Fieldkit's Carbon company id.",
      label: "Carbon Sync",
    });
  }
  return FIELDKIT_CARBON_COMPANY_ID;
}

/**
 * Performs an authenticated GET against Carbon's REST API.
 *
 * Carbon's standard list-endpoint response wraps payloads in
 * `{ data, count, error }` (PostgREST shape). We unwrap, surfacing
 * Carbon-side errors as ShelfErrors.
 *
 * @throws {ShelfError} On non-2xx HTTP, network failure, or `error` set in body.
 */
async function carbonGet<T>(path: string): Promise<T> {
  const { baseUrl, apiKey } = requireCarbonConfig();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "carbon-key": apiKey,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `Carbon API GET ${path} failed: ${res.status} ${res.statusText}`,
      additionalData: { path, status: res.status },
      label: "Carbon Sync",
    });
  }

  const body = (await res.json()) as {
    data: T;
    count?: number | null;
    error?: { message: string } | null;
  };

  if (body?.error) {
    throw new ShelfError({
      cause: null,
      message: `Carbon API GET ${path}: ${body.error.message}`,
      additionalData: { path },
      label: "Carbon Sync",
    });
  }

  return body.data;
}

/** Subset of Carbon's customer that the list endpoint returns. */
export type CarbonCustomerLite = { id: string; name: string };

/**
 * Junction row shape returned by `GET /api/sales/customer-contacts/:customerId`.
 * Carries the join columns plus the nested `contact` (and a `user` relation
 * we don't currently use).
 */
type CarbonCustomerContactJoinRow = {
  id: string;
  customerId: string;
  contactId: string;
  customerLocationId: string | null;
  contact: CarbonContact;
};

/**
 * Lists every customer in Fieldkit's Carbon company.
 *
 * The REST list endpoint takes no pagination params — it returns all rows at
 * once via Carbon's internal `fetchAllFromTable` helper. For the volumes
 * Fieldkit deals with (hundreds of customers) this is fine.
 *
 * Returns `{ id, name }` — no `mergedIntoCustomerId` etc. Webhook UPDATE
 * events fill in additional columns; this is the backfill path.
 */
export async function listCustomers(): Promise<CarbonCustomerLite[]> {
  // Touch the company id so unconfigured deploys fail at the call site
  // even though Carbon scopes by the API key already.
  requireCompanyId();
  return carbonGet<CarbonCustomerLite[]>("/api/sales/customers");
}

/**
 * Lists all `customerContact` joins (with nested `contact`) for one customer.
 */
export async function listCustomerContacts(
  carbonCustomerId: string
): Promise<CarbonCustomerContactJoinRow[]> {
  requireCompanyId();
  return carbonGet<CarbonCustomerContactJoinRow[]>(
    `/api/sales/customer-contacts/${encodeURIComponent(carbonCustomerId)}`
  );
}

/**
 * Looks up a single contact by id, scoped to the parent customer (which the
 * caller knows from the customerContact webhook payload). Returns null if
 * the contact isn't found in that customer's contact list — typically means
 * the contact was already removed from the customer at Carbon.
 */
export async function fetchContactInCustomer(args: {
  carbonCustomerId: string;
  carbonContactId: string;
}): Promise<CarbonContact | null> {
  const rows = await listCustomerContacts(args.carbonCustomerId);
  const match = rows.find((row) => row.contactId === args.carbonContactId);
  return match?.contact ?? null;
}

/**
 * Looks up a single customer (lite) by id. Filters the full list since
 * Carbon doesn't expose a single-customer endpoint. Cheap because the list
 * is just `{ id, name }` per row.
 */
export async function fetchCustomerById(
  carbonCustomerId: string
): Promise<CarbonCustomerLite | null> {
  const all = await listCustomers();
  return all.find((c) => c.id === carbonCustomerId) ?? null;
}

/**
 * Async generator over all customers (yields one at a time). Mirrors the
 * `for await ... of` API the reconciliation loop expects.
 */
export async function* iterateCustomers(opts: {
  /** Reserved for future use; Carbon's list endpoint takes no `since` param. */
  since?: string;
}): AsyncGenerator<CarbonCustomerLite> {
  // Suppress unused-arg warning while preserving the API for later when
  // Carbon adds incremental support.
  void opts.since;
  const customers = await listCustomers();
  for (const customer of customers) yield customer;
}

/**
 * The shape returned per junction row for the reconciliation pass — combines
 * the `customerContact` link with its parent `contact`.
 */
export type CustomerContactWithContact = {
  customerId: string;
  contact: CarbonContact;
};

/**
 * Iterates all customer-contact links for the Fieldkit company. Implemented
 * by listing customers then fetching contacts for each (Carbon has no
 * "list all customer contacts across customers" endpoint).
 *
 * For ~hundreds of customers this is a few seconds of HTTP time per
 * reconcile pass — acceptable given it runs nightly.
 */
export async function* iterateCustomerContactsWithContact(opts: {
  /** Reserved for future use; Carbon's endpoints take no `since` param. */
  since?: string;
}): AsyncGenerator<CustomerContactWithContact> {
  void opts.since;
  for await (const customer of iterateCustomers({})) {
    const rows = await listCustomerContacts(customer.id);
    for (const row of rows) {
      yield {
        customerId: customer.id,
        contact: row.contact,
      };
    }
  }
}

// =============================================================================
// Writes (Shelf → Carbon)
// =============================================================================

/**
 * Performs an authenticated PATCH against Carbon's REST API with a JSON
 * body. Same auth/error semantics as `carbonGet`.
 */
async function carbonPatch<T>(path: string, body: unknown): Promise<T> {
  const { baseUrl, apiKey } = requireCarbonConfig();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "carbon-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `Carbon API PATCH ${path} failed: ${res.status} ${res.statusText}`,
      additionalData: { path, status: res.status },
      label: "Carbon Sync",
    });
  }

  const responseBody = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message: string } | null;
  };

  if (responseBody?.error) {
    throw new ShelfError({
      cause: null,
      message: `Carbon API PATCH ${path}: ${responseBody.error.message}`,
      additionalData: { path },
      label: "Carbon Sync",
    });
  }

  return (responseBody.data ?? ({} as T)) as T;
}

/**
 * Pushes Shelf's `Asset.sequentialId` back into the corresponding Carbon
 * `trackedEntity.attributes` JSONB under the `"Shelf Asset ID"` key. This
 * is the Phase-3 backlink so staff in Carbon can see (and click through
 * to) the Shelf asset for any tracked unit.
 *
 * Best-effort: callers should `void`-await this and never let a failure
 * block the primary Shelf mint. We log on failure but don't throw.
 *
 * @param currentAttributes The attributes JSONB pulled from the FDW
 *   (or `null` if unavailable). We merge into it so we don't clobber
 *   other keys Carbon set (e.g. "Receipt Line Index").
 */
export async function setTrackedEntityShelfAssetId(args: {
  carbonTrackedEntityId: string;
  shelfAssetId: string;
  currentAttributes: Record<string, unknown> | null;
}): Promise<void> {
  const { carbonTrackedEntityId, shelfAssetId, currentAttributes } = args;
  const mergedAttributes: Record<string, unknown> = {
    ...(currentAttributes ?? {}),
    "Shelf Asset ID": shelfAssetId,
  };

  try {
    await carbonPatch(
      `/api/inventory/tracked-entities/${encodeURIComponent(
        carbonTrackedEntityId
      )}`,
      { attributes: mergedAttributes }
    );
  } catch (cause) {
    Logger.warn("[Carbon Sync] Failed to push Shelf id to trackedEntity", {
      carbonTrackedEntityId,
      shelfAssetId,
      cause: (cause as Error)?.message,
    });
  }
}
