import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this._textContent = "";
    this._innerHTML = "";
    this.value = "";
    this.hidden = false;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  appendChild(child) { this.children.push(child); return child; }
  querySelectorAll(selector) {
    if (selector === "th") return this.children.filter((child) => child.tag === "th");
    return [];
  }
  fire(name) {
    const callback = this.listeners.get(name);
    if (!callback) throw new Error(`no ${name} listener on #${this.id}`);
    callback({ target: this });
  }
}

// 依實際 HTML 的 data-sort 欄位建出表頭，避免測試與頁面脫節
function buildDocument(html) {
  const elements = new Map();
  const table = new FakeElement("mktTable");
  for (const match of html.matchAll(/<th data-sort="([^"]+)">([^<]*)<\/th>/g)) {
    const th = new FakeElement();
    th.tag = "th";
    th.dataset.sort = match[1];
    th.textContent = match[2];
    table.children.push(th);
  }
  elements.set("mktTable", table);
  const document = {
    readyState: "complete",
    addEventListener() {},
    createElement() { return new FakeElement(); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
  };
  return { document, elements, table };
}

function marketFeed(overrides = {}) {
  return {
    updatedAt: "2026-07-27T12:00:00.000Z",
    tradeDate: "2026-07-27",
    hiSince: "2026-07-01",
    count: 6,
    stocks: [
      { code: "2330", name: "台積電", market: "twse", close: 2350, change: -55, pe: 31.59, pbRatio: 10.34, dividendYield: 0.94, hi52: 2535, lo52: 1060, fromHi: -7.3, volume: 24810509 },
      { code: "3231", name: "緯創", market: "twse", close: 179, change: 5.5, pe: 17.95, pbRatio: 2.99, dividendYield: 3.07, hi52: 201, lo52: 109, fromHi: -10.9, volume: 179841065 },
      { code: "2317", name: "鴻海", market: "twse", close: 250, change: -2, pe: 16.62, pbRatio: 1.84, dividendYield: 3.06, hi52: 314, lo52: 158, fromHi: -20.4, volume: 50000000 },
      { code: "3324", name: "雙鴻", market: "tpex", close: 930, change: -13, pe: 27.22, pbRatio: 6.54, dividendYield: 1.26, hi52: 1305, lo52: 621, fromHi: -28.7, volume: 1831325 },
      { code: "8888", name: "虧損公司", market: "tpex", close: 12, change: 0, pbRatio: 0.8, dividendYield: 0, fromHi: -60, volume: 1000 },
      { code: "2357", name: "華碩", market: "twse", close: 657, change: -1, pe: 12.51, pbRatio: 1.81, dividendYield: 6, hi52: 966, lo52: 400, fromHi: -32, volume: 5000000 },
    ],
    errors: [],
    ...overrides,
  };
}

async function loadMarket(fetchMock) {
  const htmlPath = fileURLToPath(new URL("../../market/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "market inline script should be present");
  const { document, elements, table } = buildDocument(html);
  const window = { __MARKET_SKIP_AUTO_INIT__: true, location: { href: "https://local.test/market/", hostname: "local.test", search: "" } };
  const context = vm.createContext({ console, document, fetch: fetchMock, Headers, Intl, setTimeout, clearTimeout, URL, URLSearchParams, window });
  vm.runInContext(script, context, { filename: "market/index.html" });
  return { context, document, elements, table, html, app: context.window.MarketApp };
}

const okResponse = (data) => ({ ok: true, status: 200, headers: new Headers({}), json: async () => data });

test("market page ships the screener contract and stays non-advisory", async () => {
  const { html, app } = await loadMarket(async () => okResponse(marketFeed()));
  assert.match(html, /<title>全市場個股清單｜BJKW<\/title>/);
  assert.match(html, /MARKET_FEED_URL\s*=\s*"\/data\/market-feed\.json"/);
  assert.match(html, /不是投資建議/);
  assert.doesNotMatch(html, /買進訊號|賣出訊號|保證/);
  assert.ok(app && typeof app.init === "function", "MarketApp should be exposed for tests");
});

test("loading the feed populates rows, stamp and 52w footnote", async () => {
  const calls = [];
  const { app, elements } = await loadMarket(async (url) => { calls.push(String(url)); return okResponse(marketFeed()); });
  await app.init();
  assert.ok(calls.some((href) => href.startsWith("/data/market-feed.json")), "should fetch the absolute feed path");
  assert.equal(app.getAll().length, 6);
  assert.match(elements.get("stamp").textContent, /全市場 6 檔/);
  assert.match(elements.get("stamp").textContent, /2026-07-27/);
  assert.equal(elements.get("hiSince").textContent, "2026-07-01");
  const body = elements.get("mktBody").innerHTML;
  assert.match(body, /台積電/);
  assert.match(body, /觀察台/, "watchlist codes should be badged");
});

test("search filters by code and by name", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  const q = elements.get("q");
  q.value = "2330";
  q.fire("input");
  assert.deepEqual(app.getRows().map((r) => r.code), ["2330"]);
  q.value = "台積";
  q.fire("input");
  assert.deepEqual(app.getRows().map((r) => r.code), ["2330"]);
  q.value = "";
  q.fire("input");
  assert.equal(app.getRows().length, 6);
});

test("low-base preset keeps only PE<=25 and PB<=6 and excludes rows without PE", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  elements.get("pLow").fire("click");
  const codes = app.getRows().map((r) => r.code);
  assert.deepEqual(codes, ["2357", "2317", "3231"], "sorted by PE ascending");
  assert.ok(!codes.includes("2330"), "PE 31.59 must be filtered out");
  assert.ok(!codes.includes("3324"), "PB 6.54 must be filtered out");
  assert.ok(!codes.includes("8888"), "row without PE must not pass a PE threshold");
  assert.equal(elements.get("fPe").value, 25, "preset should reflect into the numeric input");
});

test("yield and deep-drawdown presets apply their own thresholds", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  elements.get("pYield").fire("click");
  assert.deepEqual(app.getRows().map((r) => r.code), ["2357"]);

  elements.get("reset").fire("click");
  assert.equal(app.getRows().length, 6);

  elements.get("pDeep").fire("click");
  assert.deepEqual(app.getRows().map((r) => r.code), ["8888", "2357", "3324"], "most negative first");
});

test("market selector narrows to a single board", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  const mk = elements.get("mk");
  mk.value = "tpex";
  mk.fire("change");
  assert.deepEqual(app.getRows().map((r) => r.code).sort(), ["3324", "8888"]);
});

test("sorting toggles direction and always sinks missing values", async () => {
  const { app } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  app.setSort("pe");                                  // 數值欄預設降冪
  assert.equal(app.getRows()[0].code, "2330");
  assert.equal(app.getRows()[app.getRows().length - 1].code, "8888", "null PE sinks on desc");
  app.setSort("pe");                                  // 再點一次轉升冪
  assert.equal(app.getRows()[0].code, "2357");
  assert.equal(app.getRows()[app.getRows().length - 1].code, "8888", "null PE still sinks on asc");
});

test("pagination renders a first page and grows on demand", async () => {
  const many = Array.from({ length: 260 }, (_, i) => ({
    code: String(1000 + i), name: "股" + i, market: "twse", close: 10 + i, change: 1, pe: 10, pbRatio: 1, dividendYield: 1, fromHi: -5, volume: 1000,
  }));
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed({ stocks: many, count: many.length })));
  await app.init();
  assert.equal(app.getShown(), 100, "first page caps at 100 rows");
  assert.equal(elements.get("more").hidden, false);
  assert.equal(app.showMore(), 200);
  assert.equal(app.showMore(), 260);
  assert.equal(elements.get("more").hidden, true, "button hides once everything is shown");
});

test("empty result set shows guidance instead of a blank table", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  app.setFilters({ pe: 1 });
  assert.equal(app.getRows().length, 0);
  assert.match(elements.get("emptyBox").innerHTML, /沒有符合條件/);
});

test("feed failure surfaces an error stamp without throwing", async () => {
  const { app, elements } = await loadMarket(async () => { throw new Error("offline"); });
  await app.init();
  assert.match(elements.get("stamp").textContent, /清單載入失敗/);
  assert.equal(app.getAll().length, 0);
});

test("preserved upstream data is disclosed in the stamp", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed({
    errors: [{ source: "feed-preservation", message: "kept 1900 previous TWSE rows" }],
  })));
  await app.init();
  assert.match(elements.get("stamp").textContent, /前次保留資料/);
});
