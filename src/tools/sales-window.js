import { z } from "zod";
import { shopifyGraphQL } from "../stores/client.js";
import { requireStore } from "../stores/registry.js";

/**
 * Order revenue for an exact window of calendar days in the shop's own timezone.
 *
 * The outcome contracts compare this against Meta / Google account spend for
 * the same calendar dates, so a total is only returned when it is complete:
 * every page is read (no silent first-250 truncation), the shop reports its
 * currency and IANA timezone, and every order is placed on its local calendar
 * day. Anything malformed, ambiguous or over the page bound is an error — never
 * a partial or guessed total.
 *
 * Only the aggregate leaves this module; no order-level data (and so no
 * customer PII) is returned.
 *
 * SCOPE: `read_orders`. Without `read_all_orders`, Shopify silently limits the
 * `orders` connection to the last 60 days, so an older window would read as
 * zero. Windows reaching past that horizon check the installed scopes first and
 * refuse rather than undercount.
 */

export const PAGE_SIZE = 250;
export const MAX_PAGES = 40; // 40 × 250 = 10,000 orders per read
export const MAX_DAYS = 92;
const DAY_MS = 864e5;
/** Orders older than this need read_all_orders (Shopify's limit is 60 days; one day of headroom). */
const RECENT_ORDER_HORIZON_MS = 59 * DAY_MS;
/** Micro-units: exact integer sums for any currency precision Shopify uses (0–3 decimals). */
const SCALE = 1_000_000n;

const SHOP_QUERY = `{ shop { currencyCode ianaTimezone } }`;
const SCOPES_QUERY = `{ currentAppInstallation { accessScopes { handle } } }`;
const ORDERS_QUERY = `
  query SalesWindowOrders($q: String!, $after: String) {
    orders(first: ${PAGE_SIZE}, after: $after, query: $q, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const AMOUNT = /^\d+(\.\d{1,6})?$/;

class SalesWindowError extends Error {}
const fail = (msg) => {
  throw new SalesWindowError(`sales_window: ${msg}`);
};

/** A real calendar date in strict YYYY-MM-DD form (rejects 2026-02-30). */
function isCalendarDate(s) {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Validated since..until (both inclusive) and its length in days. */
export function parseWindow(since, until) {
  if (!isCalendarDate(since) || !isCalendarDate(until)) fail("since and until must be calendar dates as YYYY-MM-DD");
  if (since > until) fail(`since ${since} is after until ${until}`);
  const days = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS + 1;
  if (days > MAX_DAYS) fail(`window is ${days} days; at most ${MAX_DAYS} per read`);
  return { since, until, days };
}

/** Formatter for the shop's calendar day; throws on anything Intl does not accept as an IANA zone. */
function localDayFormatter(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) fail("shop timezone not reported — the window cannot be placed");
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return fail(`shop timezone "${timezone}" is not a valid IANA timezone`);
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on in the formatter's timezone. */
export function localDay(fmt, instant) {
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  if (!YMD.test(ymd)) fail(`could not place ${instant.toISOString()} on a calendar day`);
  return ymd;
}

function toMicros(amount) {
  if (typeof amount !== "string" || !AMOUNT.test(amount)) fail(`order amount ${JSON.stringify(amount)} is not a non-negative decimal`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(6, "0"));
}

const utc = (ymd, dayOffset) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + dayOffset * DAY_MS).toISOString().replace(".000Z", "Z");

/**
 * Compute the window total. `gql(query, variables)` returns the GraphQL `data`
 * object (and throws on transport / GraphQL errors) — injected so the paging
 * and placement logic is testable without a live shop.
 *
 * @returns {Promise<{revenue:number,orders:number,currency:string,timezone:string,since:string,until:string,source:'shopify-mcp'}>}
 */
export async function computeSalesWindow({ gql, since, until, now = Date.now() }) {
  const win = parseWindow(since, until);

  const shop = (await gql(SHOP_QUERY, {}))?.shop;
  const currency = shop?.currencyCode;
  const timezone = shop?.ianaTimezone;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) fail("shop currency not reported — the total cannot be labelled");
  const fmt = localDayFormatter(timezone);

  // The last requested day must have ended in the shop's timezone, or its total is still moving.
  const today = localDay(fmt, new Date(now));
  if (win.until >= today) fail(`until ${win.until} has not ended yet in ${timezone} (today is ${today})`);

  // UTC bounds wide enough for every offset (UTC−12 … UTC+14); each order is then placed on its local day.
  const lower = utc(win.since, -2);
  const upper = utc(win.until, 3);

  if (now - Date.parse(lower) > RECENT_ORDER_HORIZON_MS) {
    const scopes = (await gql(SCOPES_QUERY, {}))?.currentAppInstallation?.accessScopes;
    if (!Array.isArray(scopes)) fail("could not read the app's access scopes to confirm read_all_orders");
    if (!scopes.some((s) => s?.handle === "read_all_orders")) {
      fail(
        `window reaches past Shopify's 60-day order horizon and the app lacks read_all_orders — ` +
          `older orders would be silently missing, so no total is returned`
      );
    }
  }

  const q = `created_at:>=${lower} created_at:<${upper}`;
  const seenCursors = new Set();
  const seenIds = new Set();
  let after = null;
  let total = 0n;
  let count = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const conn = (await gql(ORDERS_QUERY, { q, after }))?.orders;
    const nodes = conn?.nodes;
    const info = conn?.pageInfo;
    if (!Array.isArray(nodes) || !info || typeof info.hasNextPage !== "boolean") {
      fail(`orders page ${page + 1} is missing nodes or pageInfo — the total would be incomplete`);
    }
    if (nodes.length > PAGE_SIZE) fail(`orders page ${page + 1} has ${nodes.length} nodes, more than the ${PAGE_SIZE} requested`);

    for (const node of nodes) {
      if (!node || typeof node.id !== "string" || !node.id) fail(`orders page ${page + 1} has an order without an id`);
      if (seenIds.has(node.id)) fail(`order ${node.id} appeared twice across pages — paging is not consistent`);
      seenIds.add(node.id);

      const createdAt = node.createdAt;
      const t = typeof createdAt === "string" && ISO_INSTANT.test(createdAt) ? Date.parse(createdAt) : NaN;
      if (!Number.isFinite(t)) fail(`order ${node.id} has no valid createdAt`);

      const money = node.currentTotalPriceSet?.shopMoney;
      const micros = toMicros(money?.amount);
      if (money?.currencyCode !== currency) {
        fail(`mixed currencies: order ${node.id} is in ${money?.currencyCode ?? "an unreported currency"}, shop currency is ${currency}`);
      }

      const day = localDay(fmt, new Date(t));
      if (day >= win.since && day <= win.until) {
        total += micros;
        count++;
      }
    }

    if (!info.hasNextPage) {
      return {
        revenue: Number(total) / Number(SCALE),
        orders: count,
        currency,
        timezone,
        since: win.since,
        until: win.until,
        source: "shopify-mcp",
      };
    }
    if (!nodes.length) fail(`orders page ${page + 1} is empty but reports another page`);
    const cursor = info.endCursor;
    if (typeof cursor !== "string" || !cursor) fail(`orders page ${page + 1} has hasNextPage without an endCursor`);
    if (seenCursors.has(cursor) || cursor === after) fail(`orders page ${page + 1} repeated cursor ${cursor} — paging is not advancing`);
    seenCursors.add(cursor);
    after = cursor;
  }

  return fail(`more than ${MAX_PAGES * PAGE_SIZE} orders around this window — refusing a partial total; use a shorter window`);
}

export function registerSalesWindowTools(server) {
  server.registerTool(
    "sales_window",
    {
      title: "Sales Window (exact calendar days, shop timezone)",
      description:
        "Total order revenue and order count for orders created on calendar days since..until " +
        "(YYYY-MM-DD, both inclusive) in the shop's own IANA timezone, in the shop currency. " +
        "Counts every order regardless of financial, fulfillment or cancellation status, using " +
        "currentTotalPriceSet (current order totals after edits/refunds). Every page is read; a " +
        "malformed, inconsistent or over-limit read returns an error, never a partial total. " +
        `At most ${MAX_DAYS} days per call; the last day must already have ended in the shop timezone. ` +
        "Returns only aggregates: {revenue, orders, currency, timezone, since, until, source}. Read-only.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
        since: z.string().regex(YMD, "YYYY-MM-DD").describe("First calendar day, YYYY-MM-DD (inclusive)"),
        until: z.string().regex(YMD, "YYYY-MM-DD").describe("Last calendar day, YYYY-MM-DD (inclusive)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ store, since, until }) => {
      requireStore(store);
      try {
        const result = await computeSalesWindow({
          gql: (query, variables) => shopifyGraphQL(store, query, variables),
          since,
          until,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const scopeHint = /ACCESS_DENIED|403|forbidden/i.test(error.message)
          ? `\n\nsales_window needs the read_orders access scope (and read_all_orders for windows older than 60 days).`
          : "";
        return { content: [{ type: "text", text: `${error.message}${scopeHint}` }], isError: true };
      }
    }
  );
}
