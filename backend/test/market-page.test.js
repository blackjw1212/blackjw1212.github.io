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

test("codes link out to the shared TradingView layout with the right exchange prefix", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  const { tvSymbol, tvUrl, codeLink } = app.helpers;

  assert.equal(tvSymbol("2330", "twse"), "TWSE:2330");
  assert.equal(tvSymbol("00679B", "tpex"), "TPEX:00679B", "OTC funds must use the TPEX prefix");
  assert.equal(tvSymbol("2330/../../evil", "twse"), "", "path traversal must not reach the URL");
  assert.equal(tvSymbol("", "twse"), "");
  assert.equal(tvSymbol("<script>", "twse"), "");

  const url = new URL(tvUrl("2330", "twse"));
  assert.equal(url.hostname, "tw.tradingview.com");
  assert.equal(url.pathname, "/chart/", "same plain chart URL as /stocks/");
  assert.equal(url.searchParams.get("symbol"), "TWSE:2330");

  const link = codeLink("2330", "twse", "台積電");
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /aria-label="在 TradingView 開啟 2330 台積電 圖表（外部連結）"/);
  // 代碼不合法時只回純文字，不得產生連結
  assert.doesNotMatch(codeLink("bogus!", "twse", "x"), /<a /);

  // 股票表與 ETF 表都要套用
  const stockHtml = elements.get("mktBody").innerHTML;
  assert.match(stockHtml, /chart\/\?symbol=TWSE%3A2330/);
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const etfHtml = elements.get("etfBody").innerHTML;
  assert.match(etfHtml, /chart\/\?symbol=TWSE%3A0050/);
  assert.match(etfHtml, /chart\/\?symbol=TPEX%3A00679B/, "the OTC bond ETF must not be labelled TWSE");
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
      { code: "0050", name: "元大台灣50", market: "twse", type: "市值型", close: 101.7, change: 0.45, nav: 101.27, discountPremium: 0.18, aum: 21982.68, yield: 1.57, frequency: "半年配", payMonths: [2, 8], dps: [{ m: 2, a: 1.6 }, { m: 8, a: 1.7 }], divMonthsCovered: 7, topHoldings: [{ name: "台積電", weight: 57.37 }, { name: "聯發科", weight: 6.11 }], holdingsAsOf: "2026-07-27" },
      { code: "006208", name: "富邦台50", market: "twse", type: "市值型", close: 118, change: 0.5, nav: 117.8, discountPremium: 0.17, aum: 3500, yield: 1.5, frequency: "半年配", payMonths: [1, 7], dps: [{ m: 1, a: 1.2 }, { m: 7, a: 1.3 }], divMonthsCovered: 7, topHoldings: [{ name: "台積電", weight: 57.39 }, { name: "富邦金", weight: 2.2 }], holdingsAsOf: "2026-07-27" },
      { code: "0056", name: "元大高股息", market: "twse", type: "高股息", close: 50.2, change: 0.2, nav: 50.33, discountPremium: -0.66, aum: 7158.2, yield: 8.13, frequency: "季配", payMonths: [2, 5, 8], dps: [{ m: 2, a: 1.07 }, { m: 5, a: 1.2 }, { m: 8, a: 1.35 }], divMonthsCovered: 7, topHoldings: [] },
      { code: "00999", name: "無配息高股息", market: "twse", type: "高股息", close: 20, change: 0, nav: 20.1, discountPremium: -0.5, aum: 50, yield: null, frequency: null, payMonths: [], dps: [], divMonthsCovered: null, topHoldings: [] },
      { code: "00632R", name: "元大台灣50反1", market: "twse", type: "槓桿反向", close: 10.57, change: -0.1, nav: 10.58, discountPremium: -0.4, aum: 249.97, yield: null, frequency: null, payMonths: [], dps: [], topHoldings: [] },
      { code: "00679B", name: "元大美債20年", market: "tpex", type: "債券型", close: 26.89, change: 0.05, nav: 26.843, discountPremium: -0.35, aum: 1726.73, yield: 4.17, frequency: null, payMonths: [], dps: [], domicileNote: "境外債息，補充保費適用規則未查證", topHoldings: [] },
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

test("simulate: an ETF ignores any user-supplied pay month", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const result = app.helpers.simulate({
    total: 100000,
    stress: 1,
    nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [{
      code: "0056",
      pct: 100,
      month: 3, // 使用者亂填也不得生效——ETF 一律照 feed 的實際發放月
      security: { code: "0056", name: "元大高股息", kind: "etf", price: 50.2, events: [{ m: 2, a: 1.07 }, { m: 8, a: 1.35 }] },
    }],
  });
  assert.equal(result.monthlyGross[2], 0, "March must stay empty even though month:3 was passed");
  assert.ok(result.monthlyGross[1] > 0 && result.monthlyGross[7] > 0, "cash flow follows the ETF's real pay months");
});

test("simulator month input is auto-filled for ETFs and editable only for stocks", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");                       // 讓 ETF feed 載入，lookupSecurity 才查得到
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.setSimAllocations([
    { code: "0056", pct: 50, month: null },       // ETF → 自動
    { code: "2330", pct: 30, month: null },       // 個股 → 可填
    { code: "", pct: 20, month: null },           // 空白 → 停用
  ]);
  const etfMonth = elements.get("simMonth0");
  assert.equal(etfMonth.disabled, true, "ETF row must not invite input");
  assert.match(etfMonth.placeholder, /自動 2·5·8月/, "shows the real pay months from the feed");
  const stockMonth = elements.get("simMonth1");
  assert.equal(stockMonth.disabled, false, "stock row stays editable");
  assert.match(stockMonth.placeholder, /預設8/);
  assert.equal(elements.get("simMonth2").disabled, true, "empty row stays disabled");
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

test("simulate reports why the NHI fee is zero instead of just showing -0", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const result = app.helpers.simulate({
    total: 100000,
    stress: 1,
    nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [{ code: "0056", pct: 100, security: { code: "0056", name: "元大高股息", kind: "etf", price: 50, events: [{ m: 2, a: 1 }, { m: 8, a: 2 }] } }],
  });
  assert.equal(result.totalFee, 0);
  assert.equal(result.maxSingle, 4000, "2000 shares x 2.0 = the largest single payment");
  assert.equal(result.nhiThreshold, 20000, "threshold echoed so the UI can explain the gap");
  assert.equal(result.monthsWithCash, 2);
  // vm 內建立的陣列與 Node 的 Array 非同一 prototype，展開後再比對
  assert.deepEqual([...result.emptyMonths], [1, 3, 4, 5, 6, 7, 9, 10, 11, 12]);
});

test("effectiveExposure weights holdings by allocation and reports coverage gaps", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 0050 前十大含台積電 57.37%，配置 50% → 實質 28.685%
  const out = app.helpers.effectiveExposure([
    { code: "0050", pct: 50 },
    { code: "006208", pct: 30 },
    { code: "00632R", pct: 20 }, // 無成分股資料 → 計入 uncovered
  ]);
  const tsmc = out.rows.find((row) => row.name === "台積電");
  assert.ok(Math.abs(tsmc.eff - (57.37 * 0.5 + 57.39 * 0.3)) < 0.01, "weighted by each ETF's share of capital");
  assert.equal(out.rows[0].name, "台積電", "largest effective holding first");
  assert.equal(out.coveredPct, 80);
  assert.equal(out.uncoveredPct, 20, "funds without holdings data must be disclosed, not silently ignored");
  assert.equal(Object.keys(tsmc.per).length, 2, "kept per-ETF weights for the table");
});

test("dividendCv measures payout volatility and needs at least two events", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { dividendCv } = app.helpers;
  assert.equal(dividendCv([{ m: 2, a: 1 }, { m: 5, a: 1 }, { m: 8, a: 1 }]), 0, "a flat series has zero volatility");
  assert.ok(dividendCv([{ m: 2, a: 0.87 }, { m: 5, a: 1 }, { m: 8, a: 1.35 }]) < 0.3, "mild growth stays low");
  assert.ok(dividendCv([{ m: 2, a: 0.1 }, { m: 5, a: 0.2 }, { m: 8, a: 2.5 }]) > 0.6, "a spike is flagged");
  assert.equal(dividendCv([{ m: 8, a: 1 }]), null, "one event cannot show volatility");
  assert.equal(dividendCv([]), null);
  assert.equal(dividendCv(null), null);
});

test("quality gate drops volatile payers and premium buys but keeps steady growers", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, extra) => Object.assign({
    code, name: code, type: "高股息", close: 10, aum: 500, yield: 8, discountPremium: 0,
    dps: [{ m: 2, a: 1 }, { m: 8, a: 1 }], payMonths: [2, 8], topHoldings: [],
  }, extra);
  const pool = app.helpers.buildCandidatePool([
    mk("00S1"),
    mk("00V1", { dps: [{ m: 2, a: 0.1 }, { m: 5, a: 0.2 }, { m: 8, a: 2.5 }], payMonths: [2, 5, 8] }), // CV 過高
    mk("00P1", { discountPremium: 3.22 }),                                                            // 溢價過高
    // 配息成長但穩定（006208 那類 0.989→3.448→4.75 的政策調整）不得被誤殺
    mk("00G1", { dps: [{ m: 2, a: 0.989 }, { m: 5, a: 3.448 }, { m: 8, a: 4.75 }], payMonths: [2, 5, 8] }),
  ], {});
  const codes = pool.map((row) => row.code);
  assert.ok(codes.includes("00S1"));
  assert.ok(codes.includes("00G1"), "a growing-but-steady payer must survive the gate");
  assert.ok(!codes.includes("00V1"), "spiky payout excluded");
  assert.ok(!codes.includes("00P1"), "buying at a premium excluded");
  assert.equal(pool.rejected.cv, 1);
  assert.equal(pool.rejected.premium, 1);
});

test("isCoreHolding uses size and yield, not the unreliable type field", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { isCoreHolding } = app.helpers;
  // 0050 等級：大規模、低配息
  assert.equal(isCoreHolding({ aum: 21982, yield: 1.57, type: "市值型" }), true);
  // 廣基型被 classifyEtf 誤標主題型，仍要認得出來
  assert.equal(isCoreHolding({ aum: 4279, yield: 3.52, type: "主題型" }), true);
  // 債券 ETF 不得佔走股票型核心的位置（原型驗證時 00679B 4.17% 曾頂替 0050）
  assert.equal(isCoreHolding({ aum: 1726, yield: 4.17, type: "債券型" }), false);
  assert.equal(isCoreHolding({ aum: 500, yield: 2, type: "市值型" }), false, "too small");
  assert.equal(isCoreHolding({ aum: 5384, yield: 9.7, type: "高股息" }), false, "yield too high to be a core");
});

test("balanced goal anchors a real core and caps the high-yield sleeve", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, aum, yieldPct, type) => ({
    code, name: code, type, close: 10, aum, yield: yieldPct, discountPremium: 0,
    dps: [{ m: 3, a: yieldPct / 10 }, { m: 9, a: yieldPct / 10 }], payMonths: [3, 9], topHoldings: [],
  });
  const pool = [
    mk("0050X", 21982, 1.6, "市值型"),   // 核心
    mk("00B1", 1726, 4.1, "債券型"),     // 大且低配息，但是債券 → 不算核心
    mk("00H1", 5384, 9.7, "高股息"),     // 高息 >9%
    mk("00H2", 1131, 9.5, "主題型"),     // 高息 >9%
    mk("00M1", 581, 8.8, "主題型"),
  ];
  const out = app.helpers.optimizeAllocation(pool, { total: 2000000, goal: "balanced" });
  assert.ok(out.picks.length >= 3);
  assert.equal(out.picks.reduce((sum, pick) => sum + pick.pct, 0), 100);
  assert.ok(out.picks.some((pick) => pick.core), "must hold at least one core");
  assert.ok(out.coreWeight >= 30, `core weight ${out.coreWeight} below the 30% floor`);
  out.picks.forEach((pick) => assert.ok(pick.pct <= 30, "balanced caps every fund at 30%"));
  const highYield = out.picks.reduce((sum, pick) => sum + (pick.etf.yield > 9 ? pick.pct : 0), 0);
  assert.ok(highYield <= 40, `high-yield sleeve ${highYield}% exceeds the 40% cap`);
  const bondAsCore = out.picks.some((pick) => pick.core && pick.etf.type === "債券型");
  assert.equal(bondAsCore, false, "a bond ETF must never satisfy the core requirement");
});

test("balanced pool reaches the core that yield ranking structurally excludes", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  // 重現真實情況：合格檔數超過 poolCap(9) 時，純殖利率排序會把
  // 0050 這種 1.57% 的核心擠到最後（實測 91 檔中排名 #91），永遠進不了搜尋空間
  const highYielders = Array.from({ length: 12 }, (_, i) => ({
    code: "00Y" + i, name: "高息" + i, type: "高股息", close: 10, aum: 500, yield: 9 - i * 0.1, discountPremium: 0,
    dps: [{ m: 3, a: 0.45 }, { m: 9, a: 0.45 }], payMonths: [3, 9], topHoldings: [],
  }));
  const core = {
    code: "0050X", name: "大型核心", type: "市值型", close: 100, aum: 21982, yield: 1.57, discountPremium: 0,
    dps: [{ m: 2, a: 0.8 }, { m: 8, a: 0.8 }], payMonths: [2, 8], topHoldings: [],
  };
  const universe = highYielders.concat([core]);

  const yieldPool = app.helpers.buildCandidatePool(universe, { goal: "netYield" });
  assert.equal(yieldPool.length, 9, "cap binds once there are more candidates than slots");
  assert.equal(yieldPool.filter(app.helpers.isCoreHolding).length, 0, "yield ranking leaves the core out entirely");

  const balancedPool = app.helpers.buildCandidatePool(universe, { goal: "balanced" });
  assert.ok(balancedPool.some(app.helpers.isCoreHolding), "balanced pool seeds the core regardless of its yield rank");
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "balanced" });
  assert.ok(out.picks.some((pick) => pick.code === "0050X"), "and the optimiser can actually pick it");
});

test("optimizer output: weights sum 100 within bounds, junk excluded, fail-closed", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const out = app.helpers.optimizeAllocation(app.getEtfs(), { total: 1000000, goal: "netYield" });
  assert.ok(out.picks.length >= 3, "at least 3 funds");
  assert.equal(out.picks.reduce((sum, pick) => sum + pick.pct, 0), 100, "weights must sum to exactly 100%");
  out.picks.forEach((pick) => {
    assert.ok(pick.pct >= 10 && pick.pct <= 40, `${pick.code} weight ${pick.pct} out of [10,40]`);
    assert.equal(pick.pct % 5, 0, "weights snap to the 5% step");
  });
  const codes = out.picks.map((pick) => pick.code);
  assert.ok(!codes.includes("00632R"), "leveraged/inverse excluded");
  assert.ok(!codes.includes("00999"), "a fund with no dividend record cannot be picked");
  assert.ok(out.evaluated > 0, "must actually search, not template");
  assert.ok(out.gainVsEqual >= 0, "equal weights live inside the search space, so the optimum can never lose to them");

  const empty = app.helpers.optimizeAllocation([], { total: 1000000, goal: "netYield" });
  assert.equal(empty.picks.length, 0);
  assert.ok(empty.reason);
  const noTotal = app.helpers.optimizeAllocation(app.getEtfs(), { goal: "netYield" });
  assert.equal(noTotal.picks.length, 0, "no capital → fail closed");
  assert.ok(noTotal.reason);
});

test("optimizer never projects cash flow from an incomplete dividend history", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const accumulating = app.getEtfs().map((row) => Object.assign({}, row, { yield: null }));
  const out = app.helpers.optimizeAllocation(accumulating, { total: 1000000, goal: "netYield" });
  assert.equal(out.picks.length, 0, "funds without a full year of history must not be picked");
  assert.ok(out.reason);
  const ok = app.helpers.optimizeAllocation(app.getEtfs(), { total: 1000000, goal: "netYield" });
  ok.picks.forEach((pick) => assert.notEqual(pick.etf.yield, null, `${pick.code} must have a published yield`));
});

test("optimizer respects the AUM floor", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // fixture 合格檔僅 0050(21982)/006208(3500)/0056(7158)：
  // floor 3000 → 三檔皆入選；floor 5000 → 006208 被排除、剩 2 檔湊不滿最少 3 檔 → fail closed
  const loose = app.helpers.optimizeAllocation(app.getEtfs(), { total: 1000000, goal: "netYield", minAum: 3000 });
  assert.equal(loose.picks.length, 3);
  loose.picks.forEach((pick) => assert.ok(pick.etf.aum >= 3000, `${pick.code} below the AUM floor`));
  const strict = app.helpers.optimizeAllocation(app.getEtfs(), { total: 1000000, goal: "netYield", minAum: 5000 });
  assert.equal(strict.picks.length, 0, "floor excludes 006208, leaving too few funds — must fail closed, not relax the floor");
  assert.ok(strict.reason);
});

// 「經過計算」的核心價值：權重會繞開／權衡二代健保單筆門檻。
// A/B 各 10% 殖利率、C 5%；50 萬時等權(40/30/30)讓 A 單筆恰達 2 萬被課費，
// 最佳解 40/40/20 的扣費後總額更高——這是等權重排版算不出來的。
test("optimizer weighs the NHI threshold and beats the equal-weight baseline", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, aum, monthA) => ({ code, name: code, type: "高股息", close: 10, aum, yield: monthA.a * 100 / 10, dps: [monthA], payMonths: [monthA.m], divMonthsCovered: 12, topHoldings: [] });
  const pool = [
    mk("00A1", 100, { m: 6, a: 1 }),
    mk("00A2", 90, { m: 12, a: 1 }),
    mk("00A3", 80, { m: 3, a: 0.5 }),
  ];
  const out = app.helpers.optimizeAllocation(pool, { total: 500000, goal: "netYield" });
  // 手算：40/40/20 → A、B 各 gross 20,000（各課 422）、C 5,000 → net 44,156
  assert.ok(Math.abs(out.result.totalNet - 44156) < 1, `expected 44156, got ${out.result.totalNet}`);
  // 等權基準 40/30/30 → 19,578 + 15,000 + 7,500 = 42,078
  assert.ok(Math.abs(out.baselineNet - 42078) < 1, `expected baseline 42078, got ${out.baselineNet}`);
  assert.ok(out.gainVsEqual > 2000, "the computed weights must visibly beat equal weights here");
});

test("monthly goal is lexicographic: full coverage first, then the weakest month", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const monthlyFund = { code: "00M1", name: "月配", type: "高股息", close: 10, aum: 100, yield: 12,
    dps: Array.from({ length: 12 }, (_, i) => ({ m: i + 1, a: 0.1 })), payMonths: Array.from({ length: 12 }, (_, i) => i + 1), topHoldings: [] };
  const juneFund = { code: "00J1", name: "六月", type: "高股息", close: 10, aum: 90, yield: 20, dps: [{ m: 6, a: 2 }], payMonths: [6], topHoldings: [] };
  const decFund = { code: "00D1", name: "十二月", type: "高股息", close: 10, aum: 80, yield: 20, dps: [{ m: 12, a: 2 }], payMonths: [12], topHoldings: [] };
  const pool = [monthlyFund, juneFund, decFund];

  const monthly = app.helpers.optimizeAllocation(pool, { total: 100000, goal: "monthly" });
  assert.equal(monthly.result.monthsWithCash, 12, "must reach 12/12 when achievable");
  const monthlyPct = monthly.picks.find((pick) => pick.code === "00M1").pct;
  assert.equal(monthlyPct, 40, "then maximises the weakest month by pushing the monthly payer to its cap");

  const net = app.helpers.optimizeAllocation(pool, { total: 100000, goal: "netYield" });
  const netPct = net.picks.find((pick) => pick.code === "00M1").pct;
  assert.ok(netPct < monthlyPct, "netYield goal instead minimises the low-yield monthly payer — the objectives genuinely differ");

  // 等權組合也在搜尋空間內 → 字典序最佳解的最弱月不可能輸給等權
  assert.ok(monthly.result.minMonth >= monthly.baselineMinMonth,
    "the optimised weakest month can never be thinner than equal weights");
});

test("diverse goal spans at least three types under a tighter cap", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, type, aum, yieldPct) => ({ code, name: code, type, close: 10, aum, yield: yieldPct,
    dps: [{ m: 3, a: yieldPct / 10 }], payMonths: [3], topHoldings: [] });
  const pool = [mk("00T1", "高股息", 100, 8), mk("00T2", "高股息", 95, 7), mk("00T3", "市值型", 90, 3), mk("00T4", "債券型", 85, 4)];
  const out = app.helpers.optimizeAllocation(pool, { total: 1000000, goal: "diverse" });
  assert.ok(out.picks.length >= 3);
  const types = new Set(out.picks.map((pick) => pick.etf.type));
  assert.ok(types.size >= 3, "must span at least three types");
  out.picks.forEach((pick) => assert.ok(pick.pct <= 30, "diverse goal caps every fund at 30%"));
  assert.equal(out.picks.reduce((sum, pick) => sum + pick.pct, 0), 100);
});

test("optimizer is deterministic and its evaluator agrees with simulate()", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const a = app.helpers.optimizeAllocation(app.getEtfs(), { total: 2000000, goal: "netYield" });
  const b = app.helpers.optimizeAllocation(app.getEtfs(), { total: 2000000, goal: "netYield" });
  assert.equal(JSON.stringify(a.picks.map((p) => [p.code, p.pct])), JSON.stringify(b.picks.map((p) => [p.code, p.pct])), "same input, same output");

  // 評估器與 simulate() 是同一套規則：同組合兩邊 totalNet/totalFee 必須一致
  const etfs = app.getEtfs();
  const picks = [etfs.find((row) => row.code === "0056"), etfs.find((row) => row.code === "0050")];
  const weights = [60, 40];
  const fast = app.helpers.evaluatePortfolio(2000000, picks, weights, 1, app.helpers.NHI);
  const slow = app.helpers.simulate({
    total: 2000000, stress: 1, nhi: app.helpers.NHI,
    allocations: picks.map((etf, index) => ({ code: etf.code, pct: weights[index],
      security: { code: etf.code, name: etf.name, kind: "etf", price: etf.close, events: etf.dps } })),
  });
  assert.ok(Math.abs(fast.totalNet - slow.totalNet) < 1e-6, "evaluator must agree with simulate on net");
  assert.ok(Math.abs(fast.totalFee - slow.totalFee) < 1e-6, "and on fees");
});

test("preserved upstream data is disclosed in the stamp", async () => {
  const { app, elements } = await loadMarket(async () => okResponse(marketFeed({
    errors: [{ source: "feed-preservation", message: "kept 1900 previous TWSE rows" }],
  })));
  await app.init();
  assert.match(elements.get("stamp").textContent, /前次保留資料/);
});
