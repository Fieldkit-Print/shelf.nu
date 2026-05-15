/**
 * Shipstation Custom Store endpoint
 *
 *   GET  /api/shipstation/orders?action=export&start_date=...&end_date=...
 *        → XML response of orders modified within the window
 *
 *   POST /api/shipstation/orders?action=shipnotify&order_number=...&...
 *        → Stamps the matching BookingRequest with shipped state
 *
 * Auth is HTTP Basic — credentials configured in Shipstation's UI and
 * matched against `SHIPSTATION_BASIC_AUTH_*` env vars on Shelf. The
 * route is in `publicPaths` so the protect() middleware lets it past.
 *
 * @see {@link file://./../../modules/shipstation/export.server.ts}      list+serialize logic
 * @see {@link file://./../../modules/shipstation/shipnotify.server.ts}  shipnotify handler
 * @see {@link file://./../../modules/shipstation/auth.server.ts}        basic-auth check
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { verifyShipstationBasicAuth } from "~/modules/shipstation/auth.server";
import {
  listOrdersForExport,
  serializeOrdersXml,
} from "~/modules/shipstation/export.server";
import {
  applyShipnotify,
  parseShipnotify,
} from "~/modules/shipstation/shipnotify.server";
import { Logger } from "~/utils/logger";

const BASIC_AUTH_REALM = 'Basic realm="Shipstation"';

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": BASIC_AUTH_REALM },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!verifyShipstationBasicAuth(request)) return unauthorized();

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action !== "export") {
    return new Response(`Unknown action: ${action}`, { status: 400 });
  }

  const start = parseDateParam(
    url.searchParams.get("start_date"),
    /* defaultDaysAgo */ 30
  );
  const end = parseDateParam(url.searchParams.get("end_date"), /* future */ 0);

  try {
    const orders = await listOrdersForExport({ start, end });
    const xml = serializeOrdersXml(orders);
    return new Response(xml, {
      status: 200,
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  } catch (cause) {
    Logger.error({
      message: "[Shipstation] export failed",
      cause: cause as Error,
    });
    return new Response("Internal error", { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (!verifyShipstationBasicAuth(request)) return unauthorized();

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action !== "shipnotify") {
    return new Response(`Unknown action: ${action}`, { status: 400 });
  }

  try {
    const notify = await parseShipnotify(request);
    if (!notify.orderNumber) {
      return new Response("Missing order_number", { status: 400 });
    }
    const summary = await applyShipnotify(notify);
    Logger.log(`[Shipstation] shipnotify ${summary}`);
    return new Response("OK", { status: 200 });
  } catch (cause) {
    Logger.error({
      message: "[Shipstation] shipnotify failed",
      cause: cause as Error,
    });
    return new Response("Internal error", { status: 500 });
  }
}

/**
 * Shipstation sends `MM/dd/yyyy HH:mm` in PT. We accept either that or
 * ISO 8601 (some test integrations send ISO) and default safely to a
 * recent window when missing so we never explode on a malformed poll.
 */
function parseDateParam(raw: string | null, defaultDaysAgo: number): Date {
  if (!raw) {
    const d = new Date();
    if (defaultDaysAgo > 0) {
      d.setUTCDate(d.getUTCDate() - defaultDaysAgo);
    }
    return d;
  }
  const isoTry = new Date(raw);
  if (!Number.isNaN(isoTry.getTime())) return isoTry;
  // Shipstation MM/dd/yyyy HH:mm format
  const match = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/
  );
  if (match) {
    const [, mm, dd, yyyy, hh, mi] = match;
    // Treat as PT (Shipstation's documented default).
    const isoLike = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(
      2,
      "0"
    )}T${hh.padStart(2, "0")}:${mi}:00-08:00`;
    const parsed = new Date(isoLike);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  Logger.warn(`[Shipstation] could not parse date "${raw}", defaulting`);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - defaultDaysAgo);
  return d;
}
