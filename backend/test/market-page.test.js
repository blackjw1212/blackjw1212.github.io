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

test("the stamp separates real preservation from ordinary missing fields", async () => {
  const { app } = await loadMarket(async () => okResponse(marketFeed()));
  const { feedStamp } = app.helpers;

  // 一切正常
  assert.equal(feedStamp("全市場", 1936, { tradeDate: "2026-07-28", updatedAt: "2026-07-28T14:05:00.000Z", errors: [] }),
    "全市場 1936 檔 · 交易日 2026-07-28 · 更新 07-28 22:05");

  // 真的有列被保留 → 才可以說「前次保留資料」
  const preserved = feedStamp("全市場", 1936, {
    tradeDate: "2026-07-27",
    updatedAt: "2026-07-28T12:13:28.967Z",
    errors: [{ source: "TPEX OpenAPI daily close quotes", message: "terminated" },
             { source: "feed-preservation", message: "kept 853 previous TPEX rows (fetched 0)" }],
  });
  assert.match(preserved, /部分為前次保留資料/);
  assert.match(preserved, /更新 07-28 20:13/, "UTC 需換算成台灣時間，否則看起來像沒跑");

  // 只有估值來源缺料、沒有任何列被保留 → 不得誇大成「上游中斷」
  const partial = feedStamp("全市場", 1936, {
    tradeDate: "2026-07-28", updatedAt: "2026-07-28T14:05:00.000Z",
    errors: [{ source: "TWSE OpenAPI BWIBBU_ALL", message: "terminated" }],
  });
  assert.match(partial, /部分欄位缺料/);
  assert.doesNotMatch(partial, /保留/, "沒有列被保留就不該說保留");

  // 兩市場資料日不同步時要講明白。舊版只印單一 tradeDate，於是 TPEX 已到 07-29、
  // TWSE 還停在 07-28 時整份被標成 07-29——1,083 檔上市股掛著它們沒有的日期，
  // 使用者拿券商帳面一對就發現價差一天。
  const split = feedStamp("全市場", 1958, {
    tradeDate: "2026-07-28", marketDates: { twse: "2026-07-28", tpex: "2026-07-29" },
    updatedAt: "2026-07-29T13:00:00.000Z", errors: [],
  });
  assert.match(split, /交易日 上市 2026-07-28 · 上櫃 2026-07-29/);
  assert.doesNotMatch(split, /交易日 2026-07-29/, "不得只印較新的那一天");

  // 同步時維持單一日期，不要無謂地變囉唆
  assert.match(feedStamp("全市場", 1958, {
    tradeDate: "2026-07-29", marketDates: { twse: "2026-07-29", tpex: "2026-07-29" },
    updatedAt: "2026-07-29T13:00:00.000Z", errors: [],
  }), /交易日 2026-07-29 ·/);

  // 缺欄位時退成破折號，不得印出 undefined
  assert.equal(feedStamp("ETF", 0, {}), "ETF 0 檔 · 交易日 —");
  assert.doesNotMatch(feedStamp("ETF", 0, { updatedAt: "not-a-date" }), /Invalid|NaN|undefined/);
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
  // 完整月份改放名稱列（欄寬 1fr）——塞在 90px 的窄輸入框 placeholder 會被截成「自動 2·5」
  assert.equal(etfMonth.placeholder, "自動", "the narrow field only needs a short label");
  assert.match(etfMonth.title, /2·5·8月/, "full months live in the tooltip");
  assert.match(elements.get("simName0").textContent, /配息 2·5·8月/, "and on the name line, which cannot clip");
  assert.equal(elements.get("simPrice0").textContent, "50.2", "closing price gets its own column");
  const stockMonth = elements.get("simMonth1");
  assert.equal(stockMonth.disabled, false, "stock row stays editable");
  assert.match(stockMonth.placeholder, /預設8/);
  assert.equal(elements.get("simMonth2").disabled, true, "empty row stays disabled");
});

test("the redundant 試算 / 產生組合 buttons are gone and every input recomputes itself", async () => {
  const { html, app, document } = await loadMarket(dualFeedMock());
  await app.init();
  // 情境按鈕與四個目標按鈕本來就各自觸發重算，這兩顆只是重複入口
  assert.doesNotMatch(html, /id="simRun"/, "試算 按鈕已移除");
  assert.doesNotMatch(html, /id="gRun"/, "產生組合 按鈕已移除");
  assert.match(html, /id="simOptimize"/, "改為提供最佳分配");

  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.setSimAllocations([{ code: "0056", pct: 50, shares: null, month: null }]);

  // 總額輸入是直接 addEventListener，可以用行為驗：改總額要重推股數並即時重算
  const totalNode = document.getElementById("simTotal");
  totalNode.value = "2000000";
  totalNode.fire("input");
  assert.equal(app.getSimAllocations()[0].shares, Math.floor(2000000 * 0.5 / 50.2 + 1e-9), "總額變動要重推股數");
  assert.match(document.getElementById("simSummary").innerHTML, /年配息/, "改總額即重算，不需按鈕");

  // 列內的比例/股數/代碼/月份輸入是用 innerHTML 產生後再掛監聽的，
  // 本測試的 FakeElement 不解析 innerHTML（querySelectorAll 只支援 "th"），
  // 因此改用原始碼檢查：每個列內輸入的 handler 都必須自己呼叫 runSim()。
  const rowHandlers = html.match(/data-sim-(?:code|pct|shares|month)[\s\S]*?updateSimPctSum|input\.addEventListener\("input"[\s\S]{0,320}?\}\);/g) || [];
  const wiring = html.slice(html.indexOf("function renderSimRows"), html.indexOf("function syncSharesFromPct"));
  for (const key of ["codeIdx", "pctIdx", "sharesIdx", "monthIdx"]) {
    const at = wiring.indexOf(key + " != null");
    assert.ok(at >= 0, key + " 的監聽必須存在");
    assert.match(wiring.slice(at, at + 340), /runSim\(\)/, key + " 的 handler 必須自己觸發重算");
  }
  assert.ok(rowHandlers.length >= 1);
  // 刪除列也要重算，否則移除標的後 KPI 會停在舊值
  assert.match(wiring.slice(wiring.indexOf("simDel")), /renderSimRows\(\); runSim\(\)/);
});

test("最佳分配 fills weights that maximise net income for the listed holdings", async () => {
  const { app, document } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.getElementById("simTotal").value = "1500000";
  // 使用者自己填的三檔：這裡只決定各佔多少 %，不替他換標的
  app.setSimAllocations([
    { code: "0056", pct: null, shares: null, month: null },
    { code: "0050", pct: null, shares: null, month: null },
    { code: "006208", pct: null, shares: null, month: null },
  ]);
  const outcome = app.runSimOptimize();
  assert.equal(outcome.ok, true, outcome.reason || "");
  const allocations = app.getSimAllocations();
  const sum = allocations.reduce((acc, row) => acc + (row.pct || 0), 0);
  assert.equal(sum, 100, "權重必須剛好用完投入總額");
  allocations.forEach((row) => {
    assert.ok(row.pct >= 10 && row.pct <= 40, `${row.code} 權重 ${row.pct} 應落在分散區間內`);
    assert.ok(row.shares > 0, `${row.code} 應換算出股數`);
  });
  assert.ok(outcome.evaluated > 10, `應真的窮舉過（實得 ${outcome.evaluated} 組）`);

  // 「最佳」要可驗證：不得輸給平均分配
  const even = app.helpers.simulate({
    total: 1500000, stress: 1, nhi: app.helpers.NHI,
    allocations: ["0056", "0050", "006208"].map((code) => ({
      code, pct: 100 / 3, shares: null, month: null, security: app.helpers.lookupSecurity(code),
    })),
  });
  assert.ok(outcome.net >= even.totalNet, `最佳解 ${outcome.net} 不得低於平均分配 ${even.totalNet}`);
});

test("最佳分配 keeps the weight bounds feasible for any holding count", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { simWeightBounds } = app.helpers;
  for (let count = 1; count <= 20; count += 1) {
    const bounds = simWeightBounds(count);
    assert.ok(bounds, `${count} 檔應有可行邊界`);
    assert.ok(bounds.minW * count <= 100, `${count} 檔：下限總和不得超過 100`);
    assert.ok(bounds.maxW * count >= 100, `${count} 檔：上限總和必須湊得到 100`);
    assert.equal(100 % bounds.step, 0, "步長要能整除 100");
  }
  // 2 檔時 40% 上限湊不到 100，必須自動放寬
  assert.ok(simWeightBounds(2).maxW >= 50);
  // 11 檔時 10% 下限會超過 100，必須自動降低
  assert.equal(simWeightBounds(11).minW, 5);
  assert.equal(simWeightBounds(0), null);
});

test("最佳分配 refuses to guess when the inputs are not usable", async () => {
  const { app, document } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));

  document.getElementById("simTotal").value = "";
  app.setSimAllocations([{ code: "0056", pct: null, shares: null, month: null }]);
  assert.equal(app.runSimOptimize().ok, false, "沒有總額不能算");

  document.getElementById("simTotal").value = "1000000";
  app.setSimAllocations([{ code: "不存在", pct: null, shares: null, month: null }]);
  const bad = app.runSimOptimize();
  assert.equal(bad.ok, false, "查不到標的就要說，不可硬填權重");
  assert.match(document.getElementById("simOptimizeNote").textContent, /標的/);
});

// ── 年度所得稅估算 ────────────────────────────────────────────────
// 對居住者，國內 ETF 配息發放時「不扣繳所得稅」，只扣二代健保；真正的稅是隔年 5 月
// 申報的綜所稅。以下數字全部取自財政部 115 年度公告（2025-11-27），並以獨立實作
// 反算過四個級距交界點。

test("progressiveTax reproduces the official 115 quick-calculation table", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { progressiveTax, TAX_FALLBACK } = app.helpers;
  const t = (net) => progressiveTax(net, TAX_FALLBACK.brackets);
  // 每個級距上緣的稅額，必須等於「該級距以下全額課稅」——這是速算公式的定義性檢查
  assert.equal(t(610000), 30500);
  assert.equal(t(1380000), 122900);
  assert.equal(t(2770000), 400900);
  assert.equal(t(5190000), 1126900);
  // 級距內線性
  assert.equal(t(1000000), 77300);
  assert.equal(t(1200000), 101300);
  // 邊界外
  assert.equal(t(0), 0);
  assert.equal(t(-100), 0, "負所得不得算出負稅");
  assert.equal(t(NaN), 0);
  assert.ok(t(6000000) > t(5190000), "最高級距要繼續往上");
});

test("estimateDividendTax runs both regimes and takes the cheaper one", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { estimateDividendTax, TAX_FALLBACK } = app.helpers;
  const P = TAX_FALLBACK;

  // 12% 級距：稅額增量 101,300 − 77,300 = 24,000；抵減 200,000×8.5% = 17,000
  const mid = estimateDividendTax({ taxableDividend: 200000, netIncome: 1000000, params: P });
  assert.equal(mid.combined, 7000, "24,000 − 17,000");
  assert.equal(mid.separate, 56000, "200,000 × 28%");
  assert.equal(mid.credit, 17000);
  assert.equal(mid.tax, 7000);
  assert.equal(mid.regime, "合併計稅");

  // 高級距：分開計稅才划算
  const high = estimateDividendTax({ taxableDividend: 2000000, netIncome: 6000000, params: P });
  assert.equal(high.separate, 560000);
  assert.ok(high.combined > high.separate, "40% 級距下合併計稅應較貴");
  assert.equal(high.tax, high.separate);
  assert.equal(high.regime, "分開計稅");

  // 抵減有 80,000／戶／年 上限，不可隨股利無限放大
  const capped = estimateDividendTax({ taxableDividend: 1200000, netIncome: 1000000, params: P });
  assert.equal(capped.credit, 80000, "1,200,000 × 8.5% = 102,000 必須被 80,000 夾住");

  // 低級距的抵減大於稅額 → 整體為負（可退稅）。夾成 0 會抹掉存股族最重要的效果
  const low = estimateDividendTax({ taxableDividend: 100000, netIncome: 300000, params: P });
  assert.equal(low.combined, -3500);
  assert.equal(low.tax, -3500, "負數代表可退稅，不可夾成 0");
  assert.equal(low.regime, "合併計稅");

  // 沒有所得淨額就不能猜
  assert.equal(estimateDividendTax({ taxableDividend: 200000, netIncome: null, params: P }), null);
  assert.equal(estimateDividendTax({ taxableDividend: 200000, netIncome: NaN, params: P }), null);
  assert.equal(estimateDividendTax({ taxableDividend: 0, netIncome: 1000000, params: P }), null);
});

test("taxableRatio infers the taxable share and always says why", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { taxableRatio } = app.helpers;
  const etf = (name, type) => ({ kind: "etf", name, type });

  // 國內股票型 → 54C 國內股利，全額應稅
  for (const row of [etf("元大高股息", "高股息"), etf("元大台灣50", "市值型"), etf("中信關鍵半導體", "主題型")]) {
    const out = taxableRatio(row);
    assert.equal(out.ratio, 1, row.name);
    assert.ok(out.reason, "一定要附推定理由");
  }
  // 債券型／外幣計價 → 境外所得，走最低稅負制，實質免稅
  assert.equal(taxableRatio(etf("元大美債20年", "債券型")).ratio, 0);
  assert.equal(taxableRatio(etf("第一金優選非投債", "債券型")).ratio, 0);
  assert.equal(taxableRatio(etf("富邦上證180+R", "外幣計價")).ratio, 0);
  // 型別是國內但投資海外：只看 type 會判錯，要靠名稱補
  assert.equal(taxableRatio(etf("國泰費城半導體", "主題型")).ratio, 0, "費城半導體是美股");
  assert.equal(taxableRatio(etf("元大S&P500", "主題型")).ratio, 0);
  assert.equal(taxableRatio(etf("富邦NASDAQ", "主題型")).ratio, 0);
  assert.equal(taxableRatio(etf("富邦越南", "主題型")).ratio, 0);
  // 個股與查無標的
  assert.equal(taxableRatio({ kind: "stock", name: "台積電" }).ratio, 1);
  assert.equal(taxableRatio(null).ratio, 0);
});

test("simulate reports tax only when the user supplies their net income", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { simulate, TAX_FALLBACK, NHI } = app.helpers;
  const domestic = { code: "0056", name: "元大高股息", kind: "etf", type: "高股息", price: 50, events: [{ m: 2, a: 2 }, { m: 8, a: 2 }] };
  const bond = { code: "00679B", name: "元大美債20年", kind: "etf", type: "債券型", price: 25, events: [{ m: 2, a: 0.5 }, { m: 8, a: 0.5 }] };
  const run = (security, netIncome) => simulate({
    total: 1000000, stress: 1, nhi: NHI, netIncome, taxParams: TAX_FALLBACK,
    allocations: [{ code: security.code, pct: 100, shares: null, month: null, security }],
  });

  // 未填所得淨額：不估稅，既有欄位不受影響
  const noIncome = run(domestic, null);
  assert.equal(noIncome.tax, null);
  assert.equal(noIncome.afterTaxNet, null);
  assert.ok(noIncome.totalNet > 0, "既有的扣費後估算照常");
  assert.ok(noIncome.taxableDividend > 0, "應稅配息仍要算出來，供畫面提示");

  // 國內高股息：全額應稅
  const taxed = run(domestic, 1000000);
  assert.equal(taxed.taxableDividend, taxed.totalGross);
  assert.ok(taxed.tax !== null);
  assert.equal(taxed.afterTaxNet, taxed.totalNet - taxed.tax);
  assert.equal(taxed.holdings[0].taxableRatio, 1);

  // 債券型：配息屬海外所得，稅基為 0 → 估算稅為 0，且不可變成 null
  const bondRun = run(bond, 1000000);
  assert.equal(bondRun.taxableDividend, 0, "境外債息不計入應稅配息");
  assert.equal(bondRun.holdings[0].taxableRatio, 0);
  assert.ok(bondRun.totalGross > 0, "配息本身照算，只是不課稅");
  assert.equal(bondRun.tax, null, "沒有應稅所得就沒有稅可估");
});

test("the after-tax goal optimises net-of-tax income and refuses to guess the bracket", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { optimizeAllocation, TAX_FALLBACK } = app.helpers;
  // 同殖利率的兩組：一組國內（全額應稅）、一組債券型（推定海外所得、免稅）。
  // 稅前完全打平，只有把稅算進去才分得出高下——這樣才測得到目標函數真的換了。
  const mk = (code, name, type, months) => ({
    code, name, type, close: 20, aum: 800, yield: 8, discountPremium: 0, dividendCv: 0.1,
    dps: months.map((m) => ({ m, a: 0.8 })), payMonths: months, topHoldings: [],
  });
  const universe = app.helpers.normalizeEtfFeed({ tradeDate: "2026-07-29", stocks: [
    mk("00D1", "國內高息一", "高股息", [1, 7]),
    mk("00D2", "國內高息二", "高股息", [2, 8]),
    mk("00D3", "國內高息三", "高股息", [3, 9]),
    mk("00B1", "元大美債20年", "債券型", [1, 7]),
    mk("00B2", "國泰投資級公司債", "債券型", [2, 8]),
    mk("00B3", "群益ESG投等債", "債券型", [3, 9]),
  ]});
  const opts = { total: 2000000, stress: 1, nhi: app.helpers.NHI, taxParams: TAX_FALLBACK };

  // 沒有綜合所得淨額就不能算——不可偷偷退回稅前排序
  const noIncome = optimizeAllocation(universe, { ...opts, goal: "afterTax" });
  assert.equal(noIncome.picks.length, 0);
  assert.match(noIncome.reason, /綜合所得淨額/);
  assert.equal(optimizeAllocation(universe, { ...opts, goal: "afterTax", netIncome: "" }).picks.length, 0);

  // 稅前目標：兩組等價，結果不保證偏向哪邊
  const pre = optimizeAllocation(universe, { ...opts, goal: "netYield" });
  assert.ok(pre.picks.length >= 3);
  assert.equal(pre.result.tax, null, "其餘目標一律不計稅");
  assert.equal(pre.result.afterTaxNet, null);

  // 稅後目標：債券型免稅 → 應該全部選債券型
  const post = optimizeAllocation(universe, { ...opts, goal: "afterTax", netIncome: 2000000 });
  assert.ok(post.picks.length >= 3, post.reason || "");
  assert.equal(post.picks.every((p) => p.code.startsWith("00B")), true,
    `稅後目標應偏向免稅標的，實得 ${post.picks.map((p) => p.code).join(",")}`);
  assert.equal(post.result.taxableGross, 0, "全為推定海外所得，應稅配息為 0");
  assert.equal(post.result.afterTaxNet, post.result.totalNet, "沒有應稅所得時稅後＝扣費後");
  assert.equal(post.goal, "afterTax");

  // 只有國內標的可選時：稅要真的被扣掉，且與等權基準比的是稅後
  const domesticOnly = universe.filter((row) => row.code.startsWith("00D"));
  const taxed = optimizeAllocation(domesticOnly, { ...opts, goal: "afterTax", netIncome: 2000000 });
  assert.ok(taxed.result.taxableGross > 0);
  assert.ok(taxed.result.tax > 0, "20% 級距下國內股利要課到稅");
  assert.equal(taxed.result.afterTaxNet, taxed.result.totalNet - taxed.result.tax);
  assert.ok(taxed.result.afterTaxNet < taxed.result.totalNet);
  assert.ok(taxed.baselineAfterTaxNet > 0, "等權基準也要用稅後，否則比的是兩個不同的東西");
  assert.ok(taxed.gainVsEqual >= 0, "等權組合本身在搜尋空間內，最佳解不得更差");
});

test("etfTaxableRatio adapts feed rows, which carry no kind field", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { etfTaxableRatio } = app.helpers;
  // feed 的列沒有 kind，直接餵給 taxableRatio 會被當成個股而全額課稅
  assert.equal(etfTaxableRatio({ name: "元大高股息", type: "高股息" }).ratio, 1);
  assert.equal(etfTaxableRatio({ name: "元大美債20年", type: "債券型" }).ratio, 0);
  assert.equal(etfTaxableRatio({ name: "國泰費城半導體", type: "主題型" }).ratio, 0);
  assert.ok(etfTaxableRatio({ name: "x", type: "高股息" }).reason);
});

test("evaluatePortfolio treats an unlabelled fund as fully taxable", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { evaluatePortfolio, TAX_FALLBACK, NHI } = app.helpers;
  const fund = (extra) => Object.assign({ code: "00X", close: 20, dps: [{ m: 3, a: 1 }] }, extra);
  const tax = { netIncome: 2000000, params: TAX_FALLBACK };
  // 缺 taxableRatio 欄位時要保守地全額課稅，不可因為缺料而少算
  const unlabelled = evaluatePortfolio(1000000, [fund({})], [100], 1, NHI, tax);
  assert.equal(unlabelled.taxableGross, unlabelled.totalGross);
  const exempt = evaluatePortfolio(1000000, [fund({ taxableRatio: 0 })], [100], 1, NHI, tax);
  assert.equal(exempt.taxableGross, 0);
  // 不傳 tax 就完全不算，既有四個目標的行為不變
  const noTax = evaluatePortfolio(1000000, [fund({})], [100], 1, NHI);
  assert.equal(noTax.tax, null);
  assert.equal(noTax.afterTaxNet, null);
  assert.equal(noTax.totalNet, unlabelled.totalNet, "加了稅參數不得改動扣費後的數字");
});

test("simulate: explicit shares take precedence over the percentage", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const security = { code: "0056", name: "元大高股息", kind: "etf", price: 50, events: [{ m: 2, a: 1 }, { m: 8, a: 2 }] };
  const result = app.helpers.simulate({
    total: 1000000, stress: 1, nhi: { rate: 0.0211, threshold: 20000 },
    // pct 說 10%（= 2000 股），但使用者已持有 7,500 股 —— 應以實際持股為準
    allocations: [{ code: "0056", pct: 10, shares: 7500, security }],
  });
  const holding = result.holdings[0];
  assert.equal(holding.shares, 7500, "the real holding wins over the derived one");
  assert.equal(holding.marketValue, 375000, "7500 x 50");
  assert.equal(holding.leftover, 0, "an existing position has no odd-lot remainder");
  assert.equal(result.totalMarketValue, 375000);
  // 配息以實際股數計：7500 x (1 + 2) = 22,500
  assert.equal(Math.round(result.totalGross), 22500);
  assert.equal(result.overAllocated, false, "share-driven rows must not trip the 100% check");
});

test("simulate: shares and percentage rows coexist and report real weights", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const held = { code: "0056", name: "元大高股息", kind: "etf", price: 50, events: [{ m: 2, a: 1 }] };
  const planned = { code: "0050", name: "元大台灣50", kind: "etf", price: 100, events: [{ m: 8, a: 2 }] };
  const result = app.helpers.simulate({
    total: 1000000, stress: 1, nhi: { rate: 0.0211, threshold: 20000 },
    allocations: [
      { code: "0056", shares: 6000, security: held },     // 已持有 → 市值 300,000
      { code: "0050", pct: 30, security: planned },       // 規劃 30% → 3,000 股 = 300,000
    ],
  });
  assert.equal(result.holdings[0].marketValue, 300000);
  assert.equal(result.holdings[1].shares, 3000);
  assert.equal(result.totalMarketValue, 600000);
  // 實際佔比以市值計，兩檔各半
  assert.equal(result.holdings[0].weight, 50);
  assert.equal(result.holdings[1].weight, 50);
  assert.equal(result.holdings.reduce((sum, h) => sum + h.weight, 0), 100, "weights must total 100%");
  // 兩列都要進月現金流：2 月 6000、8 月 6000
  assert.equal(Math.round(result.monthlyGross[1]), 6000);
  assert.equal(Math.round(result.monthlyGross[7]), 6000);
});

test("shares and percentage stay in sync without floor drift", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  elements.get("simTotal").value = 2000000;
  // 刻意選「不整除」的組合：0050 @101.7、5,000 股、總額 200 萬 → 比例 25.425%。
  // 若在內部四捨五入成 25.4% 再換算回去會掉到 4,995 股。整除的組合測不出這個 bug
  // （線上實測 00888 @29.96、20,000 股就多出 26 股）。
  app.setSimAllocations([{ code: "0050", pct: null, shares: 5000, month: null }]);
  app.syncPctFromShares(0);
  const derivedPct = app.getSimAllocations()[0].pct;
  assert.ok(derivedPct > 0, "shares produce a percentage");
  assert.notEqual(derivedPct, Math.round(derivedPct * 10) / 10, "the fixture must actually exercise sub-0.1% precision");
  app.syncSharesFromPct(0);
  assert.equal(app.getSimAllocations()[0].shares, 5000, "round-tripping must not inflate or shrink the position");

  // 顯示欄位仍取到小數 2 位，不把全精度倒進畫面
  const shown = Number(elements.get("simTotal").value) > 0
    ? String(Math.round(derivedPct * 100) / 100)
    : "";
  assert.ok(/^\d+(\.\d{1,2})?$/.test(shown), "the visible percentage stays readable");
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
  // 波動度由資料層以近 24 個月的窗算好寫進 dividendCv，前端不再由 dps 就地重算
  // （dps 只有近 12 月，硬算會給出另一個窗的數字混在同一欄）。
  const mk = (code, extra) => Object.assign({
    code, name: code, type: "高股息", close: 10, aum: 500, yield: 8, discountPremium: 0,
    dps: [{ m: 2, a: 1 }, { m: 8, a: 1 }], payMonths: [2, 8], dividendCv: 0.05, topHoldings: [],
  }, extra);
  // 走真正的 normalizeEtfFeed，順便涵蓋 dividendCv → dividendCvField 的欄位映射
  const universe = app.helpers.normalizeEtfFeed({
    tradeDate: "2026-07-29",
    stocks: [
      mk("00S1"),
      mk("00V1", { dividendCv: 1.04 }),          // 配息忽高忽低
      mk("00P1", { discountPremium: 3.22 }),     // 溢價過高
      // 溫和成長仍要過關：實測 00713（0.26）、00918（0.29）、00919（0.19）都在安全區
      mk("00G1", { dividendCv: 0.29 }),
      // 但大幅水準跳升會被標出來——006208 由 0.989 漲到 4.75，24 月窗算出 0.65。
      // 這是本輪刻意的行為改變（12 月窗只算 0.16，把跳升藏起來了）。
      mk("00J1", { dividendCv: 0.65 }),
      // 資料層沒給就是無從判斷 → 放行，不可猜
      mk("00N1", { dividendCv: undefined }),
    ],
  });
  const pool = app.helpers.buildCandidatePool(universe, {});
  const codes = pool.map((row) => row.code);
  assert.ok(codes.includes("00S1"));
  assert.ok(codes.includes("00G1"), "溫和成長不得被誤殺");
  assert.ok(codes.includes("00N1"), "無波動度資料時放行，而非當成不合格");
  assert.ok(!codes.includes("00V1"), "spiky payout excluded");
  assert.ok(!codes.includes("00J1"), "大幅水準跳升要被門檻擋下");
  assert.ok(!codes.includes("00P1"), "buying at a premium excluded");
  assert.equal(pool.rejected.cv, 2);
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
  // cap 仍是 9，規模保送額外再加 1 檔（不佔用殖利率名額）
  assert.equal(yieldPool.length, 10, "cap binds, then the size seed adds the largest fund on top");
  assert.ok(yieldPool.some((row) => row.code === "0050X"), "純殖利率排序也不得把最大檔關在門外");

  const balancedPool = app.helpers.buildCandidatePool(universe, { goal: "balanced" });
  assert.ok(balancedPool.some(app.helpers.isCoreHolding), "balanced pool seeds the core regardless of its yield rank");
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "balanced" });
  assert.ok(out.picks.some((pick) => pick.code === "0050X"), "and the optimiser can actually pick it");
});

test("the three largest qualifying funds are seeded into every goal's pool", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  // 實測情境：0056（6,716億、CV 0.19）每一關都過，但依殖利率排序排第 10 名，
  // 池只取 9 檔就進不來——使用者因此看不到它跟小型高息標的被比較過。
  // yield 只決定池的排序，目標函數用的是 dps 現金流——兩者必須一致，
  // 否則測到的是自己造的假資料而不是程式行為
  const mk = (code, name, close, aum, pct, months) => {
    const per = Math.round(close * pct / 100 / months.length * 1000) / 1000;
    return { code, name, type: "高股息", close, aum, yield: pct, discountPremium: 0,
      dps: months.map((m) => ({ m, a: per })), payMonths: months, topHoldings: [] };
  };
  const small = Array.from({ length: 12 }, (_, i) => mk("00S" + i, "小型高息" + i, 10, 200, 13 - i * 0.1, [3, 9]));
  const big = [
    mk("0056X", "大型高息", 50, 6716, 8.47, [2, 8]),
    mk("00878X", "大型永續", 31, 5701, 5.97, [3, 9]),
    mk("00919X", "大型精選", 28, 5198, 9.9, [1, 7]),
  ];
  const universe = small.concat(big);

  for (const goal of ["balanced", "netYield", "monthly", "diverse"]) {
    const pool = app.helpers.buildCandidatePool(universe, { goal });
    for (const row of big) {
      assert.ok(pool.some((p) => p.code === row.code), `${goal}: ${row.code}（規模 ${row.aum}億）必須入池`);
    }
    assert.ok(pool.length <= 14, `${goal}: 保送不得讓搜尋空間失控（實得 ${pool.length}）`);
  }

  // 保送是「入池」不是「保底入選」——目標函數仍自由決定。這裡驗證它確實有被評估到：
  // 純配息目標下小型高息殖利率壓倒性領先，大型檔入池但選不上，這是誠實的結果。
  const yieldOut = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netYield" });
  assert.ok(yieldOut.picks.length > 0, "純配息目標仍要產出配置");

  // 反面：若最大檔同時也是殖利率最高，它必須被選中
  const rigged = Array.from({ length: 12 }, (_, i) => mk("00S" + i, "小型" + i, 10, 200, 3, [3, 9]))
    .concat([mk("0056X", "大型高息", 50, 6716, 12, [2, 8])]);
  const out = app.helpers.optimizeAllocation(rigged, { total: 2000000, goal: "netYield" });
  assert.ok(out.picks.some((pick) => pick.code === "0056X"), "又大又高息時必須勝出");
});

test("active funds are opt-in and structurally barred from being core", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, name, extra) => Object.assign({
    code, name, type: "高股息", close: 20, aum: 5000, yield: 8, discountPremium: 0,
    dps: [{ m: 3, a: 0.8 }, { m: 9, a: 0.8 }], payMonths: [3, 9], topHoldings: [],
  }, extra || {});
  const universe = [
    mk("00403A", "主動統一升級50", { isActive: true, type: "主動型", aum: 1526, yield: 3 }),
    mk("00P1", "被動一", { isActive: false }),
    mk("00P2", "被動二", { isActive: false, yield: 7 }),
    mk("00P3", "被動三", { isActive: false, yield: 6 }),
    mk("00L1", "槓桿一", { isActive: false, type: "槓桿反向" }),
    mk("00X1", "外幣版", { isActive: false, type: "外幣計價" }),
  ];

  // 預設：主動型不進候選池，且排除數要被記錄下來供 UI 揭露
  const off = app.helpers.buildCandidatePool(universe, {});
  assert.ok(!off.some((row) => row.code === "00403A"), "active funds excluded by default");
  assert.equal(off.rejected.active, 1);
  // 槓反與外幣計價恆排除，不受開關影響
  assert.ok(!off.some((row) => row.type === "槓桿反向"), "leveraged always excluded");
  assert.ok(!off.some((row) => row.type === "外幣計價"), "foreign-currency share classes always excluded");

  // 開關打開才納入
  const on = app.helpers.buildCandidatePool(universe, { includeActive: true });
  assert.ok(on.some((row) => row.code === "00403A"), "opt-in brings them back");
  assert.ok(!on.some((row) => row.type === "槓桿反向"), "but never the leveraged ones");

  // 即使納入，主動型仍不得被判為核心（規模與殖利率都符合也一樣）
  assert.equal(app.helpers.isCoreHolding({ code: "00403A", isActive: true, aum: 1526, yield: 3, type: "主動型" }), false);

  // 端到端：optimizeAllocation 透傳 includeActive
  const defaultRun = app.helpers.optimizeAllocation(universe, { total: 1000000, goal: "netYield" });
  assert.ok(!defaultRun.picks.some((pick) => pick.code === "00403A"));
  const optIn = app.helpers.optimizeAllocation(universe, { total: 1000000, goal: "netYield", includeActive: true });
  assert.ok(optIn.poolSize > defaultRun.poolSize, "opt-in widens the pool");
});

test("an estimated yield is displayed but never feeds the optimiser", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  // 只有年化推估、沒有完整年度實績的標的：現金流試算必須建立在已實現配息上，
  // 因此候選池一律只讀嚴格的 yield
  const estimatedOnly = {
    code: "00E1", name: "推估標的", type: "高股息", close: 20, aum: 5000,
    yield: null, yieldEstimated: 8.6, yieldBasis: { events: 8, months: 8 },
    discountPremium: 0, dps: [{ m: 3, a: 0.86 }, { m: 9, a: 0.86 }], payMonths: [3, 9], topHoldings: [],
  };
  const realised = (code, yieldPct) => ({
    code, name: code, type: "高股息", close: 20, aum: 5000, yield: yieldPct, discountPremium: 0,
    dps: [{ m: 3, a: yieldPct / 10 }, { m: 9, a: yieldPct / 10 }], payMonths: [3, 9], topHoldings: [],
  });
  const universe = [estimatedOnly, realised("00R1", 6), realised("00R2", 5.5), realised("00R3", 5)];

  const pool = app.helpers.buildCandidatePool(universe, {});
  assert.ok(!pool.some((row) => row.code === "00E1"), "estimate-only funds must stay out of the candidate pool");

  const out = app.helpers.optimizeAllocation(universe, { total: 1000000, goal: "netYield" });
  assert.ok(out.picks.length >= 3);
  assert.ok(!out.picks.some((pick) => pick.code === "00E1"), "and can never be picked, despite the highest headline number");
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
