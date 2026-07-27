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

// 依實際 HTML 的 data-sort / data-etf-sort 欄位分表建出表頭，避免測試與頁面脫節
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
  const etfTable = new FakeElement("etfTable");
  for (const match of html.matchAll(/<th data-etf-sort="([^"]+)">([^<]*)<\/th>/g)) {
    const th = new FakeElement();
    th.tag = "th";
    th.dataset.etfSort = match[1];
    th.textContent = match[2];
    etfTable.children.push(th);
  }
  elements.set("etfTable", etfTable);
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
    count: 7,
    stocks: [
      { code: "2330", name: "台積電", market: "twse", close: 2350, change: -55, pe: 31.59, pbRatio: 10.34, dividendYield: 0.94, hi52: 2535, lo52: 1060, fromHi: -7.3, volume: 24810509 },
      { code: "3231", name: "緯創", market: "twse", close: 179, change: 5.5, pe: 17.95, pbRatio: 2.99, dividendYield: 3.07, hi52: 201, lo52: 109, fromHi: -10.9, volume: 179841065 },
      { code: "2317", name: "鴻海", market: "twse", close: 250, change: -2, pe: 16.62, pbRatio: 1.84, dividendYield: 3.06, hi52: 314, lo52: 158, fromHi: -20.4, volume: 50000000 },
      { code: "3324", name: "雙鴻", market: "tpex", close: 930, change: -13, pe: 27.22, pbRatio: 6.54, dividendYield: 1.26, hi52: 1305, lo52: 621, fromHi: -28.7, volume: 1831325 },
      { code: "8888", name: "虧損公司", market: "tpex", close: 12, change: 0, pbRatio: 0.8, dividendYield: 0, fromHi: -60, volume: 1000 },
      { code: "2357", name: "華碩", market: "twse", close: 657, change: -1, pe: 12.51, pbRatio: 1.81, dividendYield: 6, hi52: 966, lo52: 400, fromHi: -32, volume: 5000000 },
      // 估值極低但幾乎不能成交：低基期預設必須靠流動性門檻把它擋掉
      { code: "4523", name: "永彰", market: "twse", close: 24.8, change: 1, pe: 1.01, pbRatio: 0.72, dividendYield: 11.08, hi52: 40, lo52: 20, fromHi: -38.2, volume: 120000 },
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
  assert.equal(app.getAll().length, 7);
  assert.match(elements.get("stamp").textContent, /全市場 7 檔/);
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
  assert.equal(app.getRows().length, 7);
});

test("low-base preset keeps only PE<=25, PB<=6 and liquid names", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  elements.get("pLow").fire("click");
  const codes = app.getRows().map((r) => r.code);
  assert.deepEqual(codes, ["2357", "2317", "3231"], "sorted by PE ascending");
  assert.ok(!codes.includes("2330"), "PE 31.59 must be filtered out");
  assert.ok(!codes.includes("3324"), "PB 6.54 must be filtered out");
  assert.ok(!codes.includes("8888"), "row without PE must not pass a PE threshold");
  assert.ok(!codes.includes("4523"), "PE 1.01 but only 0.03e8 turnover — illiquid value trap must be excluded");
  assert.equal(elements.get("fPe").value, 25, "preset should reflect into the numeric input");
  assert.equal(elements.get("fTo").value, 0.5, "liquidity floor should reflect into the input");
});

test("turnover is derived in 億 and filters independently", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  const wistron = app.getAll().find((r) => r.code === "3231");
  assert.equal(wistron.turnover, 321.92, "179 x 179,841,065 ≈ 321.92億");
  const tiny = app.getAll().find((r) => r.code === "4523");
  assert.equal(tiny.turnover, 0.03);

  const input = elements.get("fTo");
  input.value = "100";
  input.fire("input");
  // 2330 583億 / 2317 125億 / 3231 321.92億 過關；2357 32.85億、3324 17.03億 被擋
  assert.deepEqual(app.getRows().map((r) => r.code).sort(), ["2317", "2330", "3231"], "only names above 100億 survive");
});

test("yield and deep-drawdown presets apply their own thresholds", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed()));
  await app.init();
  elements.get("pYield").fire("click");
  assert.deepEqual(app.getRows().map((r) => r.code), ["4523", "2357"], "highest yield first, no liquidity floor here");

  elements.get("reset").fire("click");
  assert.equal(app.getRows().length, 7);
  assert.equal(elements.get("fTo").value, "", "reset must clear the liquidity floor too");

  elements.get("pDeep").fire("click");
  assert.deepEqual(app.getRows().map((r) => r.code), ["8888", "4523", "2357", "3324"], "most negative first");
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
  assert.equal(app.getRows()[0].code, "4523");
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

function etfFeed(overrides = {}) {
  return {
    updatedAt: "2026-07-27T12:00:00.000Z",
    tradeDate: "2026-07-27",
    divHistoryStart: "2026-01-06",
    count: 6,
    stocks: [
      { code: "0050", name: "元大台灣50", market: "twse", type: "市值型", close: 101.7, change: 0.45, nav: 101.27, discountPremium: 0.18, aum: 21982.68, yield: null, frequency: "半年配", payMonths: [2, 8], dps: [{ m: 2, a: 1.6 }, { m: 8, a: 1.7 }], divMonthsCovered: 7, topHoldings: [{ name: "台積電", weight: 57.37 }, { name: "聯發科", weight: 6.11 }], holdingsAsOf: "2026-07-27" },
      { code: "006208", name: "富邦台50", market: "twse", type: "市值型", close: 118, change: 0.5, nav: 117.8, discountPremium: 0.17, aum: 3500, yield: null, frequency: "半年配", payMonths: [1, 7], dps: [{ m: 1, a: 1.2 }, { m: 7, a: 1.3 }], divMonthsCovered: 7, topHoldings: [{ name: "台積電", weight: 57.39 }, { name: "富邦金", weight: 2.2 }], holdingsAsOf: "2026-07-27" },
      { code: "0056", name: "元大高股息", market: "twse", type: "高股息", close: 50.2, change: 0.2, nav: 50.33, discountPremium: -0.66, aum: 7158.2, yield: null, frequency: "季配", payMonths: [2, 5, 8], dps: [{ m: 2, a: 1.07 }, { m: 5, a: 1.2 }, { m: 8, a: 1.35 }], divMonthsCovered: 7, topHoldings: [] },
      { code: "00999", name: "無配息高股息", market: "twse", type: "高股息", close: 20, change: 0, nav: 20.1, discountPremium: -0.5, aum: 50, yield: null, frequency: null, payMonths: [], dps: [], divMonthsCovered: null, topHoldings: [] },
      { code: "00632R", name: "元大台灣50反1", market: "twse", type: "槓桿反向", close: 10.57, change: -0.1, nav: 10.58, discountPremium: -0.4, aum: 249.97, yield: null, frequency: null, payMonths: [], dps: [], topHoldings: [] },
      { code: "00679B", name: "元大美債20年", market: "tpex", type: "債券型", close: 26.89, change: 0.05, nav: 26.843, discountPremium: -0.35, aum: 1726.73, yield: null, frequency: null, payMonths: [], dps: [], domicileNote: "境外債息，補充保費適用規則未查證", topHoldings: [] },
    ],
    errors: [],
    ...overrides,
  };
}

function dualFeedMock(calls) {
  return async (url) => {
    const href = String(url);
    if (calls) calls.push(href);
    if (href.startsWith("/data/market-feed.json")) return okResponse(marketFeed());
    if (href.startsWith("/data/etf-feed.json")) return okResponse(etfFeed());
    throw new Error(`unavailable: ${href}`);
  };
}

test("etf tab lazy-loads the etf feed with cache-busting and toggles panels", async () => {
  const calls = [];
  const { app, elements } = await loadMarket(dualFeedMock(calls));
  await app.init();
  assert.ok(!calls.some((href) => href.startsWith("/data/etf-feed.json")), "etf feed must NOT load on stock tab");
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const etfCall = calls.find((href) => href.startsWith("/data/etf-feed.json"));
  assert.ok(etfCall, "switching tab loads the etf feed");
  assert.match(etfCall, /\?v=\d{4}-\d{2}-\d{2}/, "cache-busting version param required (sw.js is cache-first)");
  assert.equal(app.getActiveTab(), "etf");
  assert.equal(elements.get("stockPanel").hidden, true);
  assert.equal(elements.get("etfPanel").hidden, false);
  assert.equal(app.getEtfs().length, 6);
  assert.match(elements.get("etfStamp").textContent, /ETF 6 檔/);
  assert.match(elements.get("etfBody").innerHTML, /元大台灣50/);
  // 再切一次不得重複抓
  await app.showTab("stock");
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((href) => href.startsWith("/data/etf-feed.json")).length, 1, "etf feed fetched once");
});

test("etf presets: discount preset enforces AUM floor and excludes leveraged funds", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  elements.get("pEDisc").fire("click");
  const codes = app.getEtfRows().map((row) => row.code);
  // 折價由深到淺：0056(−0.66) → 00999(−0.5) → 00679B(−0.35)；反1(−0.4) 被類型排除
  assert.deepEqual(codes, ["0056", "00999", "00679B"], "most discounted first, AUM>=10億, leveraged excluded");
  assert.ok(!codes.includes("00632R"), "槓桿反向 must be excluded even when discounted");
});

test("etf high-dividend preset keeps only paying funds", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  elements.get("pEYield").fire("click");
  const codes = app.getEtfRows().map((row) => row.code);
  assert.ok(codes.includes("0056"));
  assert.ok(!codes.includes("00999"), "高股息 without any dps events must be excluded");
  assert.ok(!codes.includes("0050"), "type filter applies");
});

test("computeOverlap sums weights and marks full intersection", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const curated = app.getEtfs().filter((row) => row.topHoldings.length);
  const rows = app.helpers.computeOverlap(curated);
  assert.equal(rows[0].name, "台積電", "largest combined exposure first");
  assert.equal(rows[0].total, 114.76, "57.37 + 57.39");
  assert.equal(rows[0].inAll, true);
  const mediatek = rows.find((row) => row.name === "聯發科");
  assert.equal(mediatek.inAll, false, "only in 0050");
});

test("simulate: odd-lot floor, cash pool earns nothing, pay-month allocation", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const result = app.helpers.simulate({
    total: 1000000,
    stress: 1,
    nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [
      { code: "0050", pct: 60, security: { code: "0050", name: "元大台灣50", kind: "etf", price: 101.7, events: [{ m: 2, a: 1.6 }, { m: 8, a: 1.7 }] } },
      { code: "2330", pct: 20, security: { code: "2330", name: "台積電", kind: "stock", price: 2350, annualDps: 22.6 }, month: 10 },
    ],
  });
  const holding = result.holdings[0];
  assert.equal(holding.shares, Math.floor(600000 / 101.7));      // 5899
  assert.ok(holding.leftover > 0 && holding.leftover < 101.7, "sub-share remainder goes to cash pool");
  // 未配置的 20% 也進現金池
  assert.ok(Math.abs(result.cashPool - (holding.leftover + result.holdings[1].leftover + 200000)) < 0.01);
  // 發放月分攤：2 月與 8 月（0050）、10 月（個股自訂）
  assert.ok(result.monthlyGross[1] > 0 && result.monthlyGross[7] > 0 && result.monthlyGross[9] > 0);
  assert.equal(result.monthlyGross[0], 0);
  // 年合計 = 各月合計（現金池不產生配息）
  const monthSum = result.monthlyGross.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(monthSum - result.totalGross) < 0.01);
});

test("simulate: NHI threshold boundary and stress-before-threshold ordering", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const base = (stress, perShare) => app.helpers.simulate({
    total: 20000,
    stress,
    nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [{ code: "X", pct: 100, security: { code: "X", name: "測試", kind: "etf", price: 1, events: [{ m: 6, a: perShare }] } }],
  });
  // 20,000 股 × 1 元 = 單筆 20,000 → 課 2.11%
  assert.ok(Math.abs(base(1, 1).totalFee - 20000 * 0.0211) < 0.01);
  // 單筆 19,999.99…（每股 0.99995）→ 不課。用 0.9999 保守驗證
  assert.equal(base(1, 0.9999).totalFee, 0);
  // 壓力先套用再判門檻：25,000 × 0.8 = 20,000 → 課；× 0.6 = 15,000 → 不課
  assert.ok(base(0.8, 1.25).totalFee > 0, "25000*0.8 hits the threshold");
  assert.equal(base(0.6, 1.25).totalFee, 0, "25000*0.6 stays below");
});

test("simulate: stock without yield contributes zero, never NaN; over-allocation flagged", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const result = app.helpers.simulate({
    total: 100000,
    stress: 1,
    nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [
      { code: "9999", pct: 60, security: { code: "9999", name: "無配息股", kind: "stock", price: 50, annualDps: 0 } },
      { code: "0050", pct: 50, security: { code: "0050", name: "元大台灣50", kind: "etf", price: 101.7, events: [{ m: 2, a: 1.6 }] } },
    ],
  });
  assert.equal(result.holdings[0].annualGross, 0);
  assert.ok(Number.isFinite(result.totalGross) && Number.isFinite(result.totalNet), "no NaN leakage");
  assert.equal(result.overAllocated, true, "60+50 > 100 must be flagged");
});

test("preserved upstream data is disclosed in the stamp", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed({
    errors: [{ source: "feed-preservation", message: "kept 1900 previous TWSE rows" }],
  })));
  await app.init();
  assert.match(elements.get("stamp").textContent, /前次保留資料/);
});
