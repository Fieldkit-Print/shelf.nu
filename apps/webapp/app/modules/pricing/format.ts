/**
 * Pricing — pure formatters (client-safe).
 *
 * Splitting these out of `service.server.ts` so React components in route
 * files can import them without pulling the server bundle into the client.
 * The `.server` suffix elsewhere in the module is load-bearing — Vite +
 * React Router won't ship `service.server.ts` to the browser.
 *
 * No DB, no env, no Prisma — just string↔number arithmetic with a
 * specific contract for "blank" vs "zero" (blank = null, no rate at this
 * tier; zero = explicit "free of charge" rate).
 */

import { z } from "zod";

/**
 * Zod schema for a money amount typed into a pricing form, in dollars.
 *
 * Blank is legitimate — it means "no rate at this tier" — but anything
 * non-numeric must be rejected rather than accepted. {@link dollarsToCents}
 * maps unparseable input to null, which is indistinguishable from blank, so
 * without this refinement a typo like "$12.50" or "12,50" silently *clears*
 * the rate and the form still reports success. The storage sweep then skips
 * those positions and the revenue quietly disappears.
 *
 * Negatives are rejected here too: `min="0"` on the input is a browser hint
 * and does nothing to a crafted POST.
 */
export const moneyDollarsSchema = z
  .string()
  .optional()
  .refine(
    (value) => {
      const trimmed = value?.trim();
      if (!trimmed) return true; // blank = no rate at this tier
      const num = Number(trimmed);
      return Number.isFinite(num) && num >= 0;
    },
    {
      message:
        "Enter an amount like 12.50, or leave blank for no rate at this level",
    }
  );

/**
 * Convert a user-entered dollar string (e.g. "12.50") to integer cents.
 * Empty/null/whitespace input returns null, signalling "no rate at this
 * tier" (which is distinct from zero, which is a valid charge).
 */
export function dollarsToCents(
  input: string | null | undefined
): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Inverse of dollarsToCents — formats cents as a fixed-2 decimal string
 * for prefilling inputs. Null input returns empty string so the input
 * renders as "blank" rather than "0.00".
 */
export function centsToDollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}
