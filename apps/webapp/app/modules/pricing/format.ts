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
