/**
 * sales_window regression — no network, no store config: GraphQL is an injected fake.
 *   node --test test/sales-window.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalesWindow, parseWindow, MAX_PAGES, PAGE_SIZE } from "../src/tools/sales-window.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const WIN = { since: "2026-11-01", until: "2026-11-07" };
const LA = { currencyCode: "USD", ianaTimezone: "America/Los_Angeles" };

const order = (i, createdAt, amount = "10.00", currencyCode = "USD") => ({
  id: `gid://shopify/Order/${i}`,
  createdAt,
  currentTotalPriceSet: { shopMoney: { amount, currencyCode } },
});

/**
 * Fake Admin GraphQL: shop query, scopes query, and cursor-paged orders (cursor "cN" = offset N).
 * `page(offset, defaultConnection)` can rewrite any page to simulate a broken response.
 */
function fakeGql({ shop = LA, orders = [], scopes = ["read_orders"], page } = {}) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (/\bshop\s*\{/.test(query)) return { shop };
    if (/currentAppInstallation/.test(query)) return { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } };
    if (/orders\(/.test(query)) {
      const start = variables.after ? Number(String(variables.after).slice(1)) : 0;
      const nodes = orders.slice(start, start + PAGE_SIZE);
      const more = start + PAGE_SIZE < orders.length;
      const conn = { nodes, pageInfo: { hasNextPage: more, endCursor: nodes.length ? `c${start + nodes.length}` : null } };
      return { orders: page ? page(start, conn) : conn };
    }
    throw new Error(`unexpected query ${query}`);
  };
  gql.calls = calls;
  gql.orderCalls = () => calls.filter((c) => /orders\(/.test(c.query));
  return gql;
}

const run = (gql, win = WIN, now = NOW) => computeSalesWindow({ gql, ...win, now });

test("pages every order and places each on the shop's calendar day across the DST change", async () => {
  // 2026-11-01 is the US DST end: PDT (UTC−7) before 09:00Z, PST (UTC−8) after.
  const orders = [
    order(1, "2026-11-01T06:59:00Z", "1000.00"), // Oct 31 23:59 PDT — before the window
    order(2, "2026-11-01T07:00:00Z", "19.99"), //   Nov 1 00:00 PDT — first instant in
    ...Array.from({ length: 300 }, (_, i) => order(100 + i, "2026-11-04T15:00:00Z", "10.00")),
    order(3, "2026-11-08T07:59:59Z", "0.01"), //    Nov 7 23:59:59 PST — last instant in
    order(4, "2026-11-08T08:00:00Z", "1000.00"), // Nov 8 00:00 PST — after
  ];
  const gql = fakeGql({ orders });
  const r = await run(gql);

  assert.deepEqual(r, {
    revenue: 3020,
    orders: 302,
    currency: "USD",
    timezone: "America/Los_Angeles",
    since: "2026-11-01",
    until: "2026-11-07",
    source: "shopify-mcp",
  });
  assert.notEqual(r.orders, PAGE_SIZE, "not the first page only");
  assert.deepEqual(gql.orderCalls().map((c) => c.variables.after), [null, "c250"], "304 orders → 2 pages, second after the first endCursor");
  assert.equal(
    gql.orderCalls()[0].variables.q,
    "created_at:>=2026-10-30T00:00:00Z created_at:<2026-11-10T00:00:00Z",
    "broad UTC bounds around the window"
  );
  assert.ok(!gql.calls.some((c) => /mutation/i.test(c.query)), "no mutation is ever sent");
  assert.ok(!JSON.stringify(r).includes("gid://"), "no order-level data in the result");
});

test("same instant lands on different days in different shop timezones", async () => {
  const orders = [order(1, "2026-11-08T03:00:00Z", "5.00")]; // Nov 7 19:00 in LA, Nov 8 in Tokyo
  assert.equal((await run(fakeGql({ orders }))).orders, 1);
  const tokyo = await run(fakeGql({ orders, shop: { currencyCode: "USD", ianaTimezone: "Asia/Tokyo" } }));
  assert.deepEqual([tokyo.orders, tokyo.revenue, tokyo.timezone], [0, 0, "Asia/Tokyo"]);
});

test("sums cents exactly", async () => {
  const orders = Array.from({ length: 10 }, (_, i) => order(i, "2026-11-03T20:00:00Z", "0.10"));
  assert.equal((await run(fakeGql({ orders }))).revenue, 1);
});

test("an empty, complete window is an explicit zero", async () => {
  const gql = fakeGql({ orders: [] });
  const r = await run(gql);
  assert.deepEqual([r.revenue, r.orders, r.currency, r.timezone], [0, 0, "USD", "America/Los_Angeles"]);
  assert.equal(gql.orderCalls().length, 1);
});

test("hasNextPage without an endCursor is refused", async () => {
  const orders = Array.from({ length: 300 }, (_, i) => order(i, "2026-11-04T15:00:00Z"));
  const gql = fakeGql({ orders, page: (_s, conn) => ({ ...conn, pageInfo: { hasNextPage: true, endCursor: null } }) });
  await assert.rejects(run(gql), /without an endCursor/);
});

test("mixed currencies are refused", async () => {
  const orders = [order(1, "2026-11-04T15:00:00Z"), order(2, "2026-11-04T16:00:00Z", "10.00", "CAD")];
  await assert.rejects(run(fakeGql({ orders })), /mixed currencies/);
});

test("a malformed amount is refused, never counted as zero", async () => {
  // Set amount directly: passing undefined to order() would fall back to its "10.00" default.
  const withAmount = (shopMoney) => ({ ...order(2, "2026-11-04T16:00:00Z"), currentTotalPriceSet: { shopMoney } });
  for (const bad of ["n/a", "", null, undefined, "-5.00", "1e3", 10]) {
    const orders = [order(1, "2026-11-04T15:00:00Z"), withAmount({ amount: bad, currencyCode: "USD" })];
    await assert.rejects(run(fakeGql({ orders })), /not a non-negative decimal/, `amount ${JSON.stringify(bad)}`);
  }
  const orders = [order(1, "2026-11-04T15:00:00Z"), withAmount({ currencyCode: "USD" })];
  await assert.rejects(run(fakeGql({ orders })), /not a non-negative decimal/, "amount key absent");
});

test("more than the page limit is refused, after exactly MAX_PAGES reads", async () => {
  let id = 0;
  const gql = fakeGql({
    page: (start) => ({
      nodes: Array.from({ length: PAGE_SIZE }, () => order(++id, "2026-11-04T15:00:00Z")),
      pageInfo: { hasNextPage: true, endCursor: `c${start + PAGE_SIZE}` },
    }),
  });
  await assert.rejects(run(gql), /more than 10000 orders .* refusing a partial total/);
  assert.equal(gql.orderCalls().length, MAX_PAGES);
});

test("inconsistent pages are refused", async () => {
  const two = Array.from({ length: 260 }, (_, i) => order(i, "2026-11-04T15:00:00Z"));
  const cases = [
    ["missing pageInfo", { page: (_s, c) => ({ nodes: c.nodes }) }, /missing nodes or pageInfo/],
    ["missing nodes", { page: (_s, c) => ({ pageInfo: c.pageInfo }) }, /missing nodes or pageInfo/],
    ["no orders connection", { page: () => null }, /missing nodes or pageInfo/],
    ["non-boolean hasNextPage", { page: (_s, c) => ({ ...c, pageInfo: { hasNextPage: "false", endCursor: null } }) }, /missing nodes or pageInfo/],
    ["first page without cursor", { orders: two, page: (s, c) => (s ? c : { ...c, pageInfo: { hasNextPage: true, endCursor: null } }) }, /without an endCursor/],
    [
      "cursor does not advance",
      { orders: [...two, ...two.map((o, i) => ({ ...o, id: `x${i}` }))], page: (s, c) => ({ ...c, pageInfo: { hasNextPage: true, endCursor: "c250" } }) },
      /repeated cursor c250/,
    ],
    ["duplicate order across pages", { orders: two, page: (s, c) => (s ? { ...c, nodes: [two[0]] } : c) }, /appeared twice/],
    ["empty page with more", { page: () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } }) }, /empty but reports another page/],
    ["node without id", { orders: [{ ...order(1, "2026-11-04T15:00:00Z"), id: undefined }] }, /without an id/],
    ["null node", { page: () => ({ nodes: [null], pageInfo: { hasNextPage: false, endCursor: null } }) }, /without an id/],
    ["bad createdAt", { orders: [order(1, "yesterday")] }, /no valid createdAt/],
    ["date-only createdAt", { orders: [order(1, "2026-11-04")] }, /no valid createdAt/],
    ["missing price set", { orders: [{ id: "o1", createdAt: "2026-11-04T15:00:00Z" }] }, /not a non-negative decimal/],
    ["oversized page", { page: () => ({ nodes: Array.from({ length: 251 }, (_, i) => order(i, "2026-11-04T15:00:00Z")), pageInfo: { hasNextPage: false, endCursor: null } }) }, /more than the 250 requested/],
  ];
  for (const [why, opts, re] of cases) await assert.rejects(run(fakeGql(opts)), re, why);
});

test("the shop must report a valid currency and IANA timezone", async () => {
  for (const [shop, re] of [
    [{ ianaTimezone: "America/Los_Angeles" }, /currency not reported/],
    [{ currencyCode: "usd", ianaTimezone: "America/Los_Angeles" }, /currency not reported/],
    [{ currencyCode: "USD" }, /timezone not reported/],
    [{ currencyCode: "USD", ianaTimezone: "" }, /timezone not reported/],
    [{ currencyCode: "USD", ianaTimezone: "Pacific/Nowhere" }, /not a valid IANA timezone/],
    [null, /currency not reported/],
  ]) {
    const gql = fakeGql({ shop, orders: [order(1, "2026-11-04T15:00:00Z")] });
    await assert.rejects(run(gql), re, JSON.stringify(shop));
    assert.equal(gql.orderCalls().length, 0, "no orders read without currency and timezone");
  }
});

test("dates are strict, ordered, bounded and already ended", async () => {
  for (const [win, re] of [
    [{ since: "2026-11-7", until: "2026-11-07" }, /YYYY-MM-DD/],
    [{ since: "2026-02-30", until: "2026-03-01" }, /YYYY-MM-DD/],
    [{ since: "2026-11-01T00:00", until: "2026-11-07" }, /YYYY-MM-DD/],
    [{ since: undefined, until: "2026-11-07" }, /YYYY-MM-DD/],
    [{ since: "2026-11-07", until: "2026-11-01" }, /is after until/],
    [{ since: "2026-01-01", until: "2026-11-07" }, /at most 92/],
    [{ since: "2026-11-10", until: "2026-11-16" }, /has not ended yet/], // today in LA
    [{ since: "2026-11-20", until: "2026-11-21" }, /has not ended yet/],
  ]) {
    const gql = fakeGql();
    await assert.rejects(run(gql, win), re, JSON.stringify(win));
    assert.equal(gql.orderCalls().length, 0);
  }
  assert.deepEqual(parseWindow("2026-11-01", "2026-11-07"), { ...WIN, days: 7 });
  assert.equal((await run(fakeGql(), { since: "2026-11-15", until: "2026-11-15" })).orders, 0, "yesterday in LA has ended");
});

test("windows past the 60-day order horizon need read_all_orders", async () => {
  const old = { since: "2026-08-01", until: "2026-08-07" };
  const without = fakeGql({ orders: [order(1, "2026-08-03T18:00:00Z")] });
  await assert.rejects(run(without, old), /lacks read_all_orders/);
  assert.equal(without.orderCalls().length, 0, "no undercounted read");

  const withAll = fakeGql({ orders: [order(1, "2026-08-03T18:00:00Z")], scopes: ["read_orders", "read_all_orders"] });
  assert.equal((await run(withAll, old)).orders, 1);

  const recent = fakeGql();
  await run(recent);
  assert.ok(!recent.calls.some((c) => /currentAppInstallation/.test(c.query)), "recent windows skip the scope check");
});

test("GraphQL errors propagate instead of becoming a total", async () => {
  const gql = async (query) => {
    if (/\bshop\s*\{/.test(query)) return { shop: LA };
    throw new Error("ACCESS_DENIED: Access denied for orders field");
  };
  await assert.rejects(run(gql), /ACCESS_DENIED/);
});
