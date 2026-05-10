/**
 * Carbon Supabase Client
 *
 * Carbon ERP doesn't expose a public REST/GraphQL API for external consumers
 * — its app is built on Remix loaders that authenticate via Supabase. So
 * shelf reads from Carbon's Postgres directly using the service-role key
 * (`CARBON_SUPABASE_SERVICE_ROLE_KEY`). This is a Fieldkit-internal trust
 * relationship: shelf and Carbon are both ours.
 *
 * What this module is for:
 *
 * 1. **Webhook follow-ups** — when a `customerContact` INSERT event fires,
 *    the payload only carries the junction row (contactId + customerId).
 *    To mirror the contact to a shelf User we need its email/name from the
 *    `contact` table. {@link fetchContactById} does that lookup.
 * 2. **Reconciliation cron** — see {@link iterateCustomers} and
 *    {@link iterateCustomerContactsWithContact} which page through Carbon's
 *    customer + customerContact data filtered by Fieldkit's company id.
 *
 * Concurrency: a single, lazily-created Supabase client is reused across
 * calls (cheap; @supabase/supabase-js handles its own connection pooling
 * via the underlying fetch).
 *
 * @see {@link file://./types.ts}            Shapes
 * @see {@link file://./service.server.ts}   Upsert dispatch
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  CARBON_SUPABASE_SERVICE_ROLE_KEY,
  CARBON_SUPABASE_URL,
  FIELDKIT_CARBON_COMPANY_ID,
} from "~/utils/env";
import { ShelfError } from "~/utils/error";

import type { CarbonContact, CarbonCustomer } from "./types";

let cachedClient: SupabaseClient | null = null;

/**
 * Returns a process-wide Supabase service-role client pointed at Carbon's
 * Supabase project. Throws when the relevant env vars are missing — we'd
 * rather fail loudly than silently no-op a sync attempt.
 */
function getCarbonClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  if (!CARBON_SUPABASE_URL || !CARBON_SUPABASE_SERVICE_ROLE_KEY) {
    throw new ShelfError({
      cause: null,
      message:
        "Carbon Supabase is not configured. Set CARBON_SUPABASE_URL and CARBON_SUPABASE_SERVICE_ROLE_KEY.",
      label: "Carbon Sync",
    });
  }

  cachedClient = createClient(
    CARBON_SUPABASE_URL,
    CARBON_SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
  return cachedClient;
}

/**
 * Returns Fieldkit's Carbon company id, or throws if unconfigured. Centralised
 * so every query helper applies the company filter the same way.
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

/** Fetch a single Carbon customer by id (scoped to Fieldkit's company). */
export async function fetchCustomerById(
  carbonCustomerId: string
): Promise<CarbonCustomer | null> {
  const companyId = requireCompanyId();
  const { data, error } = await getCarbonClient()
    .from("customer")
    .select(
      "id, name, companyId, customerTypeId, customerStatusId, mergedIntoCustomerId, createdAt, updatedAt"
    )
    .eq("id", carbonCustomerId)
    .eq("companyId", companyId)
    .maybeSingle();

  if (error) {
    throw new ShelfError({
      cause: error,
      message: `Carbon: failed to fetch customer ${carbonCustomerId}`,
      label: "Carbon Sync",
      additionalData: { carbonCustomerId },
    });
  }
  return data as CarbonContact | null as CarbonCustomer | null;
}

/** Fetch a single Carbon contact by id (scoped to Fieldkit's company). */
export async function fetchContactById(
  carbonContactId: string
): Promise<CarbonContact | null> {
  const companyId = requireCompanyId();
  const { data, error } = await getCarbonClient()
    .from("contact")
    .select(
      "id, companyId, email, firstName, lastName, fullName, title, createdAt, updatedAt"
    )
    .eq("id", carbonContactId)
    .eq("companyId", companyId)
    .maybeSingle();

  if (error) {
    throw new ShelfError({
      cause: error,
      message: `Carbon: failed to fetch contact ${carbonContactId}`,
      label: "Carbon Sync",
      additionalData: { carbonContactId },
    });
  }
  return data as CarbonContact | null;
}

/**
 * Iterates all customers in Fieldkit's Carbon company, optionally filtered
 * by `updatedAt > since`. Yields one row at a time so callers can process
 * with bounded memory.
 *
 * Pagination uses Supabase's `range()` (offset-based). Carbon stores ~hundreds
 * of customers, not millions, so offset paging is fine here.
 */
export async function* iterateCustomers(opts: {
  since?: string;
}): AsyncGenerator<CarbonCustomer> {
  const companyId = requireCompanyId();
  const pageSize = 200;
  let from = 0;

  while (true) {
    let query = getCarbonClient()
      .from("customer")
      .select(
        "id, name, companyId, customerTypeId, customerStatusId, mergedIntoCustomerId, createdAt, updatedAt"
      )
      .eq("companyId", companyId)
      .order("createdAt", { ascending: true })
      .range(from, from + pageSize - 1);

    if (opts.since) query = query.gt("updatedAt", opts.since);

    const { data, error } = await query;
    if (error) {
      throw new ShelfError({
        cause: error,
        message: "Carbon: failed to page customers in reconcile",
        label: "Carbon Sync",
      });
    }
    if (!data || data.length === 0) return;

    for (const row of data) yield row as CarbonCustomer;
    if (data.length < pageSize) return;
    from += pageSize;
  }
}

/**
 * The shape returned per junction row for the reconciliation pass. Combines
 * the `customerContact` link with its parent `contact` so callers can upsert
 * a shelf User in one pass.
 */
export type CustomerContactWithContact = {
  customerId: string;
  contact: CarbonContact;
};

/**
 * Iterates `customerContact` joins with their parent `contact` row for the
 * Fieldkit company. Used during reconciliation to backfill any contact we
 * missed (or that came in before the parent customer).
 */
export async function* iterateCustomerContactsWithContact(opts: {
  since?: string;
}): AsyncGenerator<CustomerContactWithContact> {
  const companyId = requireCompanyId();
  const pageSize = 200;
  let from = 0;

  while (true) {
    // Inner-join contact via Supabase's PostgREST relation syntax.
    // `contact:contactId(...)` resolves the FK and inlines the contact row.
    let query = getCarbonClient()
      .from("customerContact")
      .select(
        `
          customerId,
          contact:contactId (
            id, companyId, email, firstName, lastName, fullName, title, createdAt, updatedAt
          )
        `
      )
      .eq("companyId", companyId)
      .range(from, from + pageSize - 1);

    if (opts.since) query = query.gt("updatedAt", opts.since);

    const { data, error } = await query;
    if (error) {
      throw new ShelfError({
        cause: error,
        message: "Carbon: failed to page customerContact in reconcile",
        label: "Carbon Sync",
      });
    }
    if (!data || data.length === 0) return;

    for (const row of data) {
      // Supabase types relations as arrays; pick the single contact.
      const rawContact = (
        row as unknown as { contact: CarbonContact | CarbonContact[] | null }
      ).contact;
      const contact = Array.isArray(rawContact) ? rawContact[0] : rawContact;
      if (!contact) continue;
      yield {
        customerId: (row as unknown as { customerId: string }).customerId,
        contact,
      };
    }

    if (data.length < pageSize) return;
    from += pageSize;
  }
}
