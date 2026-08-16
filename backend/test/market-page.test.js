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

async function loadMarket(fetchMock, options = {}) {
  const htmlPath = fileURLToPath(new URL("../../market/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "market inline script should be present");
  const { document, elements, table } = buildDocument(html);
  // localStorage 是選用的：多數測試不需要，但 loadSimState 的遷移邏輯（舊存檔沒有
  // pctEntered 時要回填）非得有它才測得到——那是最容易靜默吃掉使用者資料的一段。
  const store = options.localStorage || null;
  const window = { __MARKET_SKIP_AUTO_INIT__: true, localStorage: store, location: { href: "https://local.test/market/", hostname: "local.test", search: "" } };
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

  // 格式與時區換算（固定時戳才鎖得住）。這份時戳早就過了過期門檻，
  // 所以後面會多接一段警示——用 startsWith 鎖前段，警示本身另外測。
  assert.ok(
    feedStamp("全市場", 1936, { tradeDate: "2026-07-28", updatedAt: "2026-07-28T14:05:00.000Z", errors: [] })
      .startsWith("全市場 1936 檔 · 交易日 2026-07-28 · 更新 07-28 22:05"),
    "戳記前段的格式與 UTC→台灣時間換算");

  // 一切正常＝新鮮且無錯誤時，不可有任何括號註記、也不可有過期警示。
  // 用相對時戳，否則這條測試會隨時間自然腐化成「過期」而莫名失敗。
  const freshStamp = feedStamp("全市場", 1936, {
    tradeDate: "2026-07-28", updatedAt: new Date(Date.now() - 3600000).toISOString(), errors: [],
  });
  assert.doesNotMatch(freshStamp, /（/, "沒有缺料就不該有括號註記");
  assert.doesNotMatch(freshStamp, /未更新/, "新鮮資料不可亮過期警示，否則警示變常態就失效了");

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

// PE／PB／殖利率的分母是股價，而估值來源（BWIBBU、TPEX 本益比分析）比收盤晚一步
// 發佈：實測 2026-08-06 早上，上市收盤已是 08-06、BWIBBU 仍是 08-05，那三欄等於用
// 前一天的股價算出來的（2330：PE 31.19 對應 2,320，32.33 才對應 2,405，EPS 同為
// 74.38）。這件事以前完全沒被講出來，1,463 檔全部受影響。
test("the stamp discloses when valuation is a different day from the close", async () => {
  const { app } = await loadMarket(async () => okResponse(marketFeed()));
  const { feedStamp } = app.helpers;

  // 上市收盤比估值新一個交易日 → 換算得回來，說「已換算」並附原始日期
  const lagging = feedStamp("全市場", 1955, {
    tradeDate: "2026-08-05",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-05" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
    updatedAt: "2026-08-06T01:30:00.000Z",
    errors: [{ source: "stale-valuation", market: "twse", message: "…" }],
  });
  assert.match(lagging, /PE／PB／殖利率已依當日收盤換算（原始估值 上市 2026-08-05）/);

  // 落差超過可換算範圍 → 只揭露不換算，措辭必須不同（說成已換算就是假的）
  const wide = feedStamp("全市場", 1955, {
    tradeDate: "2026-08-06",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-06" },
    valuationDates: { twse: "2026-07-20", tpex: "2026-07-20" },
    updatedAt: "2026-08-06T14:00:00.000Z", errors: [],
  });
  assert.match(wide, /PE／PB／殖利率為 上市 2026-07-20、上櫃 2026-07-20 的估值/);
  assert.doesNotMatch(wide, /已依當日收盤換算/);

  // 關鍵回歸：只比頂層 valuationDate 與 tradeDate 會漏報這個情境——
  // 兩者都取最小值，這裡都會是 2026-08-05 而看起來「同步」。
  assert.match(
    feedStamp("全市場", 1955, {
      tradeDate: "2026-08-05", valuationDate: "2026-08-05",
      marketDates: { twse: "2026-08-06", tpex: "2026-08-05" },
      valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
      updatedAt: "2026-08-06T01:30:00.000Z", errors: [],
    }),
    /原始估值 上市 2026-08-05/,
    "頂層日期相等時仍必須揭露上市的落差",
  );

  // 混合情形：上市差一個交易日（可換算）、上櫃 08-04→08-06 中間夾著交易日 08-05
  // （close-change 給的是 08-05 而非 08-04 的收盤，不可換算）。兩件事措辭要分開。
  const mixed = feedStamp("全市場", 1955, {
    tradeDate: "2026-08-06",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-06" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-04" },
    updatedAt: "2026-08-06T14:00:00.000Z", errors: [],
  });
  assert.match(mixed, /已依當日收盤換算（原始估值 上市 2026-08-05）/);
  assert.match(mixed, /PE／PB／殖利率為 上櫃 2026-08-04 的估值/);

  // 跨週末仍算「前一個交易日」：2026-08-07 是週五、08-10 是週一，中間只有週末
  assert.match(feedStamp("全市場", 1955, {
    tradeDate: "2026-08-10",
    marketDates: { twse: "2026-08-10", tpex: "2026-08-10" },
    valuationDates: { twse: "2026-08-07", tpex: "2026-08-07" },
    updatedAt: "2026-08-10T14:00:00.000Z", errors: [],
  }), /已依當日收盤換算/);

  // 對齊時不加噪音——每天都掛一句廢話會讓真正有落差時沒人注意
  assert.doesNotMatch(feedStamp("全市場", 1955, {
    tradeDate: "2026-08-05",
    marketDates: { twse: "2026-08-05", tpex: "2026-08-05" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
    updatedAt: "2026-08-05T14:00:00.000Z", errors: [],
  }), /估值/);

  // 舊 feed（還沒有 valuationDates）不得炸掉，也不得憑空講落差
  assert.doesNotMatch(feedStamp("全市場", 1955, {
    tradeDate: "2026-08-05", marketDates: { twse: "2026-08-05" }, updatedAt: "2026-08-05T14:00:00.000Z", errors: [],
  }), /估值|undefined/);

  // 日期不同步是據實揭露，不是缺料。把 stale-* 算進「缺料」等於同一件事講兩次還講錯。
  const disclosedOnly = feedStamp("全市場", 1955, {
    tradeDate: "2026-08-05",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-05" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
    updatedAt: "2026-08-06T01:30:00.000Z",
    errors: [
      { source: "stale-market", message: "TWSE 2026-08-06 vs TPEX 2026-08-05" },
      { source: "stale-valuation", market: "twse", message: "…" },
    ],
  });
  assert.match(disclosedOnly, /原始估值 上市 2026-08-05/);
  assert.doesNotMatch(disclosedOnly, /缺料/, "日期不同步不等於缺料");

  // 真的有來源掛掉時仍要說缺料
  assert.match(feedStamp("全市場", 1955, {
    tradeDate: "2026-08-05", updatedAt: "2026-08-05T14:00:00.000Z",
    errors: [
      { source: "stale-market", message: "…" },
      { source: "TWSE OpenAPI BWIBBU_ALL", message: "terminated" },
    ],
  }), /部分欄位缺料/);
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

test("the etf feed loads once, with cache-busting, and panels toggle", async () => {
  const calls = [];
  const { app, elements } = await loadMarket(dualFeedMock(calls));
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 著陸頁是現金流模擬，它需要 etf-feed 才算得出東西——所以這裡**必須**已經載入。
  // 這條原本斷言「stock 頁不得載入 etf feed」，預設頁籤改掉後那個前提就不成立了；
  // 真正要守住的是「只抓一次」與「有 cache-busting」，那兩件事在下面。
  const etfCall = calls.find((href) => href.startsWith("/data/etf-feed.json"));
  assert.ok(etfCall, "著陸頁需要 etf feed，否則主視覺是空的");
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  // 先算出每個 handler 的起訖，再各自檢查。原本用固定 340 字切片，
  // 在 handler 裡多加幾行註解就會把 runSim() 擠出視窗而假性失敗。
  const starts = [...wiring.matchAll(/(\w+Idx) != null/g)].map((m) => ({ key: m[1], at: m.index }));
  for (const key of ["codeIdx", "pctIdx", "sharesIdx", "monthIdx"]) {
    const idx = starts.findIndex((s) => s.key === key);
    assert.ok(idx >= 0, key + " 的監聽必須存在");
    const end = idx + 1 < starts.length ? starts[idx + 1].at : wiring.length;
    assert.match(wiring.slice(starts[idx].at, end), /runSim\(\)/, key + " 的 handler 必須自己觸發重算");
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

test("estimateNetIncome turns a salary into a usable 綜合所得淨額", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { estimateNetIncome, TAX_FALLBACK } = app.helpers;
  const P = TAX_FALLBACK;
  // 115 年度：免稅額 101,000 + 標準扣除 136,000 + 薪資特扣 227,000 = 464,000
  const single = estimateNetIncome({ salary: 1000000, filing: "single", dependents: 0, params: P });
  assert.equal(single.net, 1000000 - 464000, "單身標準情境＝年薪 −464,000");
  assert.equal(single.breakdown.exemption, 101000);
  assert.equal(single.breakdown.standard, 136000);
  assert.equal(single.breakdown.salaryDeduction, 227000);
  assert.ok(single.note, "必須說明這是標準扣除額情境");

  // 有配偶：免稅額 ×2、標準扣除加倍
  const joint2 = estimateNetIncome({ salary: 2000000, filing: "joint2", dependents: 0, params: P });
  assert.equal(joint2.breakdown.exemption, 202000);
  assert.equal(joint2.breakdown.standard, 272000, "有配偶者標準扣除額加倍");
  assert.equal(joint2.breakdown.salaryDeduction, 454000, "雙薪則薪資特扣兩份");
  assert.equal(joint2.net, 2000000 - 202000 - 272000 - 454000);

  // 單薪家庭只有一份薪資特扣
  const joint1 = estimateNetIncome({ salary: 2000000, filing: "joint1", dependents: 0, params: P });
  assert.equal(joint1.breakdown.salaryDeduction, 227000);
  assert.ok(joint1.net > joint2.net, "少一份薪資特扣，淨額較高");

  // 扶養親屬每人一個免稅額
  const withDeps = estimateNetIncome({ salary: 1000000, filing: "single", dependents: 2, params: P });
  assert.equal(withDeps.breakdown.exemption, 303000);
  assert.equal(withDeps.net, single.net - 202000);

  // 薪資特扣不得超過薪資本身，否則低薪會算出負的扣除額
  const lowPay = estimateNetIncome({ salary: 150000, filing: "single", dependents: 0, params: P });
  assert.equal(lowPay.breakdown.salaryDeduction, 150000, "特扣以薪資封頂");
  assert.equal(lowPay.net, 0, "扣完不得為負");

  // 沒填或填錯就不猜
  assert.equal(estimateNetIncome({ salary: null, params: P }), null);
  assert.equal(estimateNetIncome({ salary: 0, params: P }), null);
  assert.equal(estimateNetIncome({ salary: -5, params: P }), null);
  assert.equal(estimateNetIncome({ salary: "abc", params: P }), null);
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

test("a curated domicile ratio overrides the name heuristic", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { taxableRatio, etfTaxableRatio } = app.helpers;

  // 00712 復華富時不動產：中文譯名的美國 REITs，名稱推定完全看不出來 →
  // 若沒有人工表就會被當成國內全額應稅
  const reit = { kind: "etf", name: "復華富時不動產", type: "主題型" };
  assert.equal(taxableRatio(reit).ratio, 1, "沒建表時名稱推定判為國內（這正是要修的問題）");
  const curated = taxableRatio({ ...reit, domesticRatio: 0, domicileSource: "成分股推定" });
  assert.equal(curated.ratio, 0);
  assert.equal(curated.curated, true, "要標明這是建表值而非名稱推定");
  assert.match(curated.reason, /成分股推定/);

  // 部分比例（00735 臺韓混合）——目前是成分股推定，畫面必須說是「推定」
  const mixed = taxableRatio({ kind: "etf", name: "國泰臺韓科技", type: "主題型", domesticRatio: 0.5, domicileSource: "成分股推定" });
  assert.equal(mixed.ratio, 0.5);
  assert.match(mixed.reason, /成分股推定/);
  assert.match(mixed.reason, /50%/);
  assert.equal(mixed.fromNotice, false);

  // 拿到實際收益分配通知書後，同一個欄位要標成「依收益分配通知書」——
  // 實際數字與推定值不可在畫面上長得一樣
  const notice = taxableRatio({ kind: "etf", name: "國泰臺韓科技", type: "主題型", domesticRatio: 0.3742, domicileSource: "收益分配通知書" });
  assert.equal(notice.ratio, 0.3742);
  assert.match(notice.reason, /依收益分配通知書/);
  assert.doesNotMatch(notice.reason, /推定/);
  assert.equal(notice.fromNotice, true);
  assert.match(notice.reason, /37\.4%/, "非整數比例要看得出來");

  // 人工表也能把「名稱看似海外但其實國內」的標的拉回來
  assert.equal(taxableRatio({ kind: "etf", name: "某全球名稱", type: "主題型", domesticRatio: 1 }).ratio, 1);

  // null / undefined 一律回退到推定，不可當成 0（那等於全部免稅）
  assert.equal(taxableRatio({ ...reit, domesticRatio: null }).ratio, 1);
  assert.equal(etfTaxableRatio({ name: "復華富時不動產", type: "主題型", domesticRatio: null }).ratio, 1);
  assert.equal(etfTaxableRatio({ name: "復華富時不動產", type: "主題型", domesticRatio: 0 }).ratio, 0);
});

test("the name heuristic covers the regions it previously missed", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { taxableRatio } = app.helpers;
  const etf = (name) => taxableRatio({ kind: "etf", name, type: "主題型" }).ratio;
  // 這些原本會被判成國內全額應稅
  assert.equal(etf("國泰北美科技"), 0, "北美");
  assert.equal(etf("國泰臺韓科技"), 0, "韓");
  assert.equal(etf("某某亞太成長"), 0);
  assert.equal(etf("某某東協精選"), 0);
  assert.equal(etf("某某港股高息"), 0);
  // 不可誤傷：這些是真正的國內標的
  assert.equal(etf("元大高股息"), 1);
  assert.equal(etf("中信綠能及電動車"), 1, "前十大 51% 全為台股，確實是國內型");
  assert.equal(etf("中信關鍵半導體"), 1);
  assert.equal(etf("元大臺灣ESG永續"), 1);
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

// 曝險引擎是唯一資料來源。原本三個地方各掃一次持股，同一筆配置會給出對不起來的數字。
async function loadedApp() {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return app;
}

test("overlap and effective exposure are the same engine, not two implementations", async () => {
  const app = await loadedApp();
  const { computeOverlap, effectiveExposure } = app.helpers;
  const picked = app.getEtfs().filter((row) => ["0050", "006208"].includes(row.code));
  const overlap = computeOverlap(picked);
  const eff = effectiveExposure([{ code: "0050", pct: 50 }, { code: "006208", pct: 50 }]);
  // 等權兩檔：台積電 57.37×0.5 + 57.39×0.5 = 57.38
  const a = overlap.find((row) => row.name === "台積電");
  const b = eff.rows.find((row) => row.name === "台積電");
  assert.ok(Math.abs(b.eff - 57.38) < 0.01, `實質曝險應為 57.38，實得 ${b.eff}`);
  assert.equal(a.inAll, true, "兩檔都持有的股票要標成交集");
  assert.deepEqual(Object.keys(a.per).sort(), Object.keys(b.per).sort(), "兩個 view 的逐檔權重必須同源");
});

// 這是最容易講錯的一個數字：可見的前十大本來就是最集中的那一段。
// 若拿 100% 當分母，看不見的那 36% 會被當成 0 曝險，把集中度算得太漂亮。
test("HHI and effective holdings are normalised over the visible slice only", async () => {
  const app = await loadedApp();
  const e = app.helpers.buildPortfolioExposure([{ code: "0050", pct: 100 }], app.getEtfs());
  // 0050 可見前十大只有 57.37 + 6.11 = 63.48%，台積電佔可見部分的 90.4%
  assert.ok(Math.abs(e.visibleTotal - 63.48) < 0.01, `可見曝險應為 63.48%，實得 ${e.visibleTotal}`);
  assert.ok(e.effectiveHoldings < 2,
    `以可見部分為分母，有效持股數應接近 1.2；實得 ${e.effectiveHoldings}。` +
    "若得到 3 左右，代表用 100% 當分母、把看不見的持股當成 0 曝險了");
  assert.equal(e.visibleNames, 2, "只能宣稱看得到的名字數，不可宣稱總持股檔數");
  assert.ok(!("holdingCount" in e), "沒有全持股資料，就不可輸出「總共持有幾檔」");
});

test("fund-level metrics stay exact when holdings data is missing", async () => {
  const app = await loadedApp();
  // 0056 完全沒有成分股資料，但殖利率是精確的，不該被曝險的缺口拖累
  const e = app.helpers.buildPortfolioExposure(
    [{ code: "0050", pct: 60 }, { code: "0056", pct: 40 }], app.getEtfs());
  assert.ok(Math.abs(e.fund.yield - (1.57 * 0.6 + 8.13 * 0.4)) < 0.01,
    `加權殖利率應為 4.19，實得 ${e.fund.yield}`);
  assert.equal(e.uncoveredPct, 40, "沒有成分股資料的比重要說出來");
  assert.ok(e.stocks.length, "有成分股資料的那 60% 仍要算得出曝險");
});

test("removing a fund renormalises the rest instead of shrinking the denominator", async () => {
  const app = await loadedApp();
  const rows = app.helpers.marginalContribution([{ code: "0050", pct: 50 }, { code: "0056", pct: 50 }]);
  const dropHigh = rows.find((row) => row.code === "0056");
  // base 4.85；拿掉 0056 後只剩 0050，重新正規化為 100% → 1.57，差 3.28
  // 若沒有重新正規化（拿 50/100 算），會得到 0.785、差額 4.07 —— 每一檔都會看起來「拿掉就變差」
  assert.ok(Math.abs(dropHigh.dYield - 3.28) < 0.02,
    `0056 對殖利率的邊際貢獻應為 +3.28pp，實得 ${dropHigh.dYield}`);
  assert.equal(rows.length, 2, "每一檔都要有一列");
  assert.equal(app.helpers.marginalContribution([{ code: "0050", pct: 100 }]).length, 0,
    "只有一檔時沒有「移除後」可比，不可輸出空殼列");
});

test("a stock with no industry match is left unclassified, never invented into a sector", async () => {
  const app = await loadedApp();
  // 測試 feed 沒有 holdingIndustry，等於全部比對不到
  const e = app.helpers.buildPortfolioExposure([{ code: "0050", pct: 100 }], app.getEtfs());
  assert.equal(e.sectors.length, 0, "查不到產業就不可硬塞一個產業名");
  assert.ok(Math.abs(e.unclassifiedWeight - 63.5) < 0.1,
    `未分類要保住全部可見權重，實得 ${e.unclassifiedWeight}`);
});

// Sharpe／Sortino。分母是什麼、分子是什麼、載不到利率時怎麼辦，三件事都要釘住。
function riskAdjFeed(riskFree) {
  const base = {
    market: "twse", type: "市值型", nav: null, discountPremium: null, aum: 100,
    frequency: null, payMonths: [], dps: [], topHoldings: [],
  };
  const feed = etfFeed({
    riskFree,
    count: 2,
    stocks: [
      Object.assign({}, base, {
        code: "00AA", name: "有報酬", close: 50, yield: 3,
        totalReturn1y: 12, volatility1y: 20, downsideDeviation1y: 10, maxDrawdown1y: -15,
        cagr5y: 20, totalReturn5y: 148.8, volatility5y: 25, downsideDeviation5y: 12.5, maxDrawdown5y: -30,
        returnFrom: "2021-08-01", returnTo: "2026-08-01", returnSpanDays: 1826,
      }),
      Object.assign({}, base, {
        code: "00BB", name: "跑不贏定存", close: 20, yield: 1,
        totalReturn1y: 1, volatility1y: 10, downsideDeviation1y: 6, maxDrawdown1y: -8,
        returnFrom: "2025-08-01", returnTo: "2026-08-01", returnSpanDays: 365,
      }),
    ],
  });
  return async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) return okResponse(marketFeed());
    if (href.startsWith("/data/etf-feed.json")) return okResponse(feed);
    throw new Error(`unavailable: ${href}`);
  };
}

const RF = { rate: 2, effectiveFrom: "2024-03-22", kind: "重貼現率", source: "中央銀行 央行貼放利率" };

test("Sharpe and Sortino use excess CAGR over the risk-free rate", async () => {
  const { app } = await loadMarket(riskAdjFeed(RF));
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const one = app.helpers.applyPeriod(app.getEtfs(), "1y").find((r) => r.code === "00AA");
  // 1Y 的 CAGR 依定義等於總報酬 12 → (12−2)/20 = 0.5，除以下檔 10 → 1.0
  assert.equal(one.periodSharpe, 0.5);
  assert.equal(one.periodSortino, 1, "Sortino 的分母是下檔標準差，不是總波動");

  const five = app.helpers.applyPeriod(app.getEtfs(), "5y").find((r) => r.code === "00AA");
  // 分子必須是 CAGR 20 而不是 5 年總報酬 148.8。
  // 用總報酬會得到 (148.8−2)/25 = 5.87，那個數字沒有任何意義。
  assert.equal(five.periodSharpe, 0.72, `5Y Sharpe 應為 (20−2)/25=0.72，實得 ${five.periodSharpe}`);
  assert.equal(five.periodSortino, 1.44);
});

// 這是這組功能最危險的失敗模式：利率載不到時退回 0，
// 畫面照樣印出一個好看的數字，而那個數字把超額報酬灌成了全額報酬。
test("a missing risk-free rate suppresses the ratios instead of defaulting to zero", async () => {
  const { app, elements } = await loadMarket(riskAdjFeed(null));
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = app.helpers.applyPeriod(app.getEtfs(), "1y").find((r) => r.code === "00AA");
  assert.equal(row.periodSharpe, null, "沒有無風險利率就沒有超額報酬，不可用 0 代替");
  assert.equal(row.periodSortino, null);
  // 而且要說得出為什麼——使用者看到整欄「—」必須分得出是缺利率還是缺歷史
  assert.match(elements.get("rfNote").innerHTML, /無風險利率載入失敗/);
  assert.match(elements.get("etfBody").innerHTML, /不以 0 代替/);
});

test("underperforming the risk-free rate shows a negative ratio, not a blank", async () => {
  const { app } = await loadMarket(riskAdjFeed(RF));
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = app.helpers.applyPeriod(app.getEtfs(), "1y").find((r) => r.code === "00BB");
  // (1 − 2) / 10 = −0.1。跑不贏定存是結論，不是缺資料，藏起來等於幫它遮醜。
  assert.equal(row.periodSharpe, -0.1);
});

test("the page discloses which rate sits in the denominator", async () => {
  const { app, elements } = await loadMarket(riskAdjFeed(RF));
  await app.init();
  await app.showTab("etf");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const note = elements.get("rfNote").innerHTML;
  assert.match(note, /重貼現率/, "要講明是哪一種利率");
  // fmt 不補零，全站一致（央行表格本身也寫「2」）
  assert.match(note, /重貼現率 2%/, "要講明數值");
  assert.match(note, /2024-03-22/, "要講明從何時起適用");
  assert.match(note, /中央銀行/, "要講明出處");
  // Sharpe 不可加總——組合層級若給一個加權平均值會是錯的，畫面要先擋掉這個誤解
  assert.match(note, /不等於/, "要講明組合的 Sharpe 不是成分的加權平均");
});

// 配息 sparkline。一個 CV 數字說不出形狀，但圖也很容易說謊——
// 這幾條測的是「它不會說謊」，不是「它畫得出來」。
test("the sparkline baseline is zero so a small cut is not drawn as a cliff", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { dividendSparkline } = app.helpers;
  // 1.07 → 0.866 是砍 19%。縱軸從 0 起算時，落差應該只佔可用高度的一小段；
  // 若改用 min-max 縮放，這兩個值會被畫成從最頂到最底（差 16px）。
  const svg = dividendSparkline({ dividendSeries: [
    { d: "2025-01", a: 1.07 }, { d: "2025-04", a: 1.07 },
    { d: "2025-07", a: 0.866 }, { d: "2025-10", a: 0.866 },
  ] });
  const ys = svg.match(/points="([^"]+)"/)[1].split(" ").map((p) => Number(p.split(",")[1]));
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(spread > 0, "有變動就要看得出來");
  assert.ok(spread < 6, `19% 的減配不該畫成 ${spread}px 的斷崖——縱軸沒有從 0 起算`);
  // 最高點必須貼近頂端（PAD=1），證明分母是最大值而不是 min-max 區間
  assert.ok(Math.min(...ys) <= 1.5, "最大值應貼齊頂端");
});

test("too few payouts produce no sparkline at all", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { dividendSparkline } = app.helpers;
  // 兩個點連成一線看起來像趨勢，但那跟 cvGrade 拒絕給等級是同一個理由
  assert.equal(dividendSparkline({ dividendSeries: [{ d: "2026-01", a: 1 }, { d: "2026-04", a: 2 }] }), "",
    "2 筆不足以畫出走勢");
  assert.equal(dividendSparkline({ dividendSeries: null }), "");
  assert.equal(dividendSparkline({}), "");
  // 金額全為 0（理論上不該發生）也不可畫出一條貼底的假線
  assert.equal(dividendSparkline({ dividendSeries: [
    { d: "a", a: 0 }, { d: "b", a: 0 }, { d: "c", a: 0 }, { d: "d", a: 0 }] }), "");
});

test("the sparkline says which period and how many payouts it covers", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const svg = app.helpers.dividendSparkline({ dividendSeries: [
    { d: "2024-10", a: 1.07 }, { d: "2025-01", a: 1.07 },
    { d: "2025-04", a: 0.866 }, { d: "2026-07", a: 1.35 },
  ] });
  assert.match(svg, /近 24 個月 4 次配息/, "要說得出是哪個窗、幾筆");
  assert.match(svg, /2024-10 1\.07 → 2026-07 1\.35/, "首尾要標日期，否則看不出時間軸");
  assert.match(svg, /縱軸從 0 起算/, "縮放方式要講明，否則無從判斷落差的意義");
  assert.match(svg, /<title>/, "游標提示與無障礙標籤都要有");
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

// 「配息最多」不等於「賺最多」。這是整個目標函式改寫的理由：
// 一檔配 12% 卻跌 20% 的標的在舊目標下排第一，但它在賠錢。
const mkFund = (code, opts) => Object.assign({
  code, name: code, type: "主題型", market: "twse", close: 10, aum: 2000,
  discountPremium: 0, payMonths: [3, 9], topHoldings: [],
}, opts);

test("the total-return goal rejects a high yielder that lost money", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const universe = [
    // 配息王，但價差 −20%：舊的「最高配息」目標會選它，總報酬目標必須拒絕
    mkFund("00TRAP", { yield: 12, dps: [{ m: 3, a: 0.6 }, { m: 9, a: 0.6 }],
      totalReturn1y: -8, priceReturn1y: -20 }),
    mkFund("00GOOD", { yield: 4, dps: [{ m: 3, a: 0.2 }, { m: 9, a: 0.2 }],
      totalReturn1y: 30, priceReturn1y: 26 }),
    mkFund("00OK", { yield: 6, dps: [{ m: 3, a: 0.3 }, { m: 9, a: 0.3 }],
      totalReturn1y: 18, priceReturn1y: 12 }),
    mkFund("00MEH", { yield: 5, dps: [{ m: 3, a: 0.25 }, { m: 9, a: 0.25 }],
      totalReturn1y: 12, priceReturn1y: 7 }),
    // 單檔上限 30% ⇒ 至少要 4 檔才湊得到 100%。池裡若只有 4 檔可用，
    // 唯一的 4 檔子集必然含 00TRAP，測不出「拒絕」——要留一檔備位。
    mkFund("00ALT", { yield: 4.5, dps: [{ m: 6, a: 0.45 }],
      totalReturn1y: 15, priceReturn1y: 10.5 }),
  ];
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal", netIncome: 500000 });
  assert.ok(out.picks.length >= 3, out.reason || "should find a combination");
  assert.equal(out.picks.reduce((sum, pick) => sum + pick.pct, 0), 100);
  assert.ok(!out.picks.some((pick) => pick.code === "00TRAP"), "總報酬為負的標的不得入選");
  assert.ok(out.result.afterTaxTotal > 0);

  // 對照：舊的最高配息目標確實會挑中它——這正是要修掉的行為
  const byYield = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netYield" });
  assert.ok(byYield.picks.some((pick) => pick.code === "00TRAP"), "配息目標會選中賠錢的高息標的（對照組）");
});

test("after-tax total return counts capital gains tax-free and dividends taxed", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const universe = [
    mkFund("00A", { yield: 4, dps: [{ m: 3, a: 0.2 }, { m: 9, a: 0.2 }], totalReturn1y: 30, priceReturn1y: 26 }),
    mkFund("00B", { yield: 5, dps: [{ m: 3, a: 0.25 }, { m: 9, a: 0.25 }], totalReturn1y: 22, priceReturn1y: 17 }),
    mkFund("00C", { yield: 6, dps: [{ m: 3, a: 0.3 }, { m: 9, a: 0.3 }], totalReturn1y: 18, priceReturn1y: 12 }),
    // 單檔上限 30% ⇒ 4 檔起跳才湊得到 100%
    mkFund("00D", { yield: 3, dps: [{ m: 6, a: 0.3 }], totalReturn1y: 25, priceReturn1y: 22 }),
  ];
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal", netIncome: 500000 });
  assert.ok(out.result, out.reason || "should find a combination");
  const r = out.result;
  // 稅後總報酬 ＝ 價差（免證所稅）＋ 扣費後配息 − 所得稅
  assert.ok(r.priceGain > 0, "價差要算進來");
  assert.equal(Math.round(r.afterTaxTotal), Math.round(r.priceGain + r.afterTaxNet),
    "稅後總報酬必須等於 價差 + 稅後配息，價差不得被課稅");
  assert.ok(r.afterTaxTotal > r.afterTaxNet, "只看配息會低估實際賺到的錢");
});

test("the total-return goal refuses to guess the tax bracket", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const universe = [
    mkFund("00A", { yield: 4, dps: [{ m: 3, a: 0.2 }], totalReturn1y: 30, priceReturn1y: 26 }),
    mkFund("00B", { yield: 5, dps: [{ m: 3, a: 0.25 }], totalReturn1y: 22, priceReturn1y: 17 }),
    mkFund("00C", { yield: 6, dps: [{ m: 3, a: 0.3 }], totalReturn1y: 18, priceReturn1y: 12 }),
  ];
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal" });
  assert.equal(out.picks.length, 0);
  assert.match(out.reason, /綜合所得淨額/);
});

// 缺報酬資料的標的不能混進來：只有配息的那半套資料會系統性偏袒賠價差的高配息標的
test("funds without return data are excluded from the total-return goal", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const universe = [
    mkFund("00A", { yield: 4, dps: [{ m: 3, a: 0.2 }], totalReturn1y: 30, priceReturn1y: 26 }),
    mkFund("00B", { yield: 5, dps: [{ m: 3, a: 0.25 }], totalReturn1y: 22, priceReturn1y: 17 }),
    mkFund("00C", { yield: 6, dps: [{ m: 3, a: 0.3 }], totalReturn1y: 18, priceReturn1y: 12 }),
    mkFund("00NEW", { yield: 15, dps: [{ m: 3, a: 0.75 }] }),   // 新上市，沒有滿一年報酬
  ];
  const pool = app.helpers.buildCandidatePool(universe, { goal: "netTotal" });
  assert.ok(!pool.some((row) => row.code === "00NEW"), "沒有報酬資料就不進候選池");
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal", netIncome: 500000 });
  assert.ok(!out.picks.some((pick) => pick.code === "00NEW"));
});

// 配息來源的實際金額沒有公開來源，只能給推定。推定與通知書必須在畫面上分得出來，
// 否則使用者會把估的當成官方的。
test("the taxable-ratio column separates an estimate from an actual notice", async () => {
  const { app, html } = await loadMarket(dualFeedMock());
  await app.init();
  const { taxableRatio } = app.helpers;

  // 依標的性質推定
  const guess = taxableRatio({ kind: "etf", name: "元大高股息", type: "高股息" });
  assert.equal(guess.ratio, 1);
  assert.ok(!guess.fromNotice, "名稱推定不得被標成通知書");

  // 人工建表（成分股推定）——仍不是通知書
  const curated = taxableRatio({ kind: "etf", name: "復華富時不動產", type: "主題型",
    domesticRatio: 0.22, domicileSource: "成分股推定" });
  assert.equal(curated.ratio, 0.22);
  assert.ok(!curated.fromNotice, "成分股推定不是通知書");
  assert.match(curated.reason, /成分股推定/);

  // 通知書才是實際數字
  const notice = taxableRatio({ kind: "etf", name: "某ETF", type: "主題型",
    domesticRatio: 0.63, domicileSource: "收益分配通知書" });
  assert.equal(notice.fromNotice, true);
  assert.match(notice.reason, /收益分配通知書/);

  // 畫面必須講明白沒有公開來源，不可留一個看起來權威的數字
  assert.match(html, /沒有任何公開來源/);
  assert.match(html, /應稅比例是推定值/);
});

test("etfScores ranks by percentile within the universe and keeps 'unknown' distinct from 'bad'", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { etfScores } = app.helpers;
  const mk = (code, tr, vol, dd, y) => mkFund(code, {
    totalReturn1y: tr, priceReturn1y: tr - 3, volatility1y: vol, maxDrawdown1y: dd,
    yield: y, dividendCvField: 0.2, volume: 1000000,
  });
  const universe = [mk("A", 100, 30, -30, 2), mk("B", 50, 20, -15, 6), mk("C", 10, 12, -5, 10)];

  const a = etfScores(universe[0], universe);
  const c = etfScores(universe[2], universe);
  assert.equal(a.return, 10, "報酬最高 → 滿分");
  assert.equal(c.return, 0, "報酬最低 → 0 分");
  // 波動與回撤是「越小／越淺越好」，方向不能弄反
  assert.equal(a.volatility, 0, "波動最大 → 最低分");
  assert.equal(c.volatility, 10, "波動最小 → 滿分");
  assert.equal(a.drawdown, 0, "回撤最深 → 最低分");
  assert.equal(c.drawdown, 10, "回撤最淺 → 滿分");
  assert.equal(c.income, 10, "殖利率最高 → 滿分");

  // 缺料回 null 而不是 0。0 是「很差」，null 是「不知道」——
  // 混為一談會讓剛上市、還沒有滿年資料的 ETF 看起來像最爛的標的。
  const newbie = mkFund("NEW", { yield: 5, volume: 1000 });
  const s = etfScores(newbie, universe.concat([newbie]));
  assert.equal(s.return, null);
  assert.equal(s.volatility, null);
  assert.equal(s.drawdown, null);
  assert.ok(s.income != null, "有殖利率就要有配息能力分數");
  // 流動性需要 close × volume × aum；normalizeEtfFeed 曾漏帶 volume，整欄變「—」
  assert.ok(a.liquidity != null && c.liquidity != null, "流動性要算得出來，不得整欄缺料");

  // 沒有「管理費優勢」這一維：etf-static 的 expenseRatio 全 null，無來源
  assert.equal(s.fee, undefined);
  assert.equal(s.expense, undefined);
});

test("profileToConstraints maps a profile to real constraints and asks nothing it cannot honour", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { profileToConstraints } = app.helpers;

  const longTerm = profileToConstraints({ horizonYears: "15", maxLossPct: "30", maxWeightPct: "30" });
  assert.equal(longTerm.goal, "netTotal");
  assert.equal(longTerm.maxW, 30);
  assert.equal(longTerm.minPicks, 4, "上限 30% ⇒ 至少 4 檔才湊得到 100%");
  assert.equal(longTerm.maxDrawdownPct, 30);

  // 需要現金流 → 目標換成 monthly，不是把總報酬目標硬套上月份條件
  assert.equal(profileToConstraints({ needCashflow: true }).goal, "monthly");

  // 短期且未指定容忍度 → 自動收緊。一年的回撤在三年內很可能重演。
  const short = profileToConstraints({ horizonYears: "2", maxLossPct: "" });
  assert.equal(short.maxDrawdownPct, 15);
  assert.equal(short.maxW, 20, "短期不該押注單一標的");
  assert.equal(short.minPicks, 5);

  // 「不設限」要真的不設限，不可偷偷塞一個預設值
  assert.equal(profileToConstraints({ horizonYears: "15", maxLossPct: "" }).maxDrawdownPct, undefined);

  // 不履行的問題不得產生約束——收集了卻不影響輸出就是裝飾
  const noisy = profileToConstraints({
    horizonYears: "15", age: 42, monthlyAmount: 30000,
    existingAssets: "房地產", rebalanceFrequency: "季", allowLeverage: true,
  });
  for (const key of ["age", "monthlyAmount", "existingAssets", "rebalanceFrequency", "allowLeverage"]) {
    assert.equal(noisy[key], undefined, `${key} 不該變成約束`);
  }
});

// 問卷不是裝飾：收緊「可接受虧損」必須真的把高回撤標的排掉，
// 且兩份不同的問卷要產出不同的組合。
test("a tighter loss tolerance actually removes deep-drawdown funds", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const mk = (code, dd, tr) => mkFund(code, {
    totalReturn1y: tr, priceReturn1y: tr - 3, volatility1y: Math.abs(dd),
    maxDrawdown1y: dd, yield: 5, dps: [{ m: 3, a: 0.25 }, { m: 9, a: 0.25 }],
  });
  const universe = [
    mk("00WILD", -45, 120), mk("00WILD2", -40, 110),
    mk("00CALM", -8, 25), mk("00CALM2", -9, 22), mk("00CALM3", -10, 20), mk("00CALM4", -7, 18),
  ];
  const loose = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal", netIncome: 500000 });
  assert.ok(loose.picks.some((p) => p.code.startsWith("00WILD")), "不設限時高報酬的高回撤標的會入選");

  const tight = app.helpers.optimizeAllocation(universe,
    Object.assign({ total: 2000000, netIncome: 500000 }, app.helpers.profileToConstraints({ horizonYears: "15", maxLossPct: "15", maxWeightPct: "30" })));
  assert.ok(tight.picks.length >= 3, tight.reason || "should still find something");
  assert.ok(!tight.picks.some((p) => p.code.startsWith("00WILD")), "收緊容忍度後高回撤標的必須被排掉");
  assert.ok(tight.rejected.drawdown >= 2, "被回撤閘門擋掉的檔數要記錄下來供 UI 揭露");
  // 兩份問卷給出不同答案——若一樣就代表問卷沒作用
  assert.notDeepEqual(loose.picks.map((p) => p.code).sort(), tight.picks.map((p) => p.code).sort());
});

// 正向槓桿（L）改為可選：報酬不差——00631L 近一年 +208.9%、是 0050 的 2.04 倍——
// 原本被 type 一刀切掉。真正該把關的是回撤，而問卷的可接受虧損閘門已在做那件事。
// 反向（R）維持恆排除：方向性放空，不能靠「反正它報酬會輸」來擋。
test("leveraged long funds are opt-in; inverse funds are never eligible", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const lev = (code, dd, tr) => mkFund(code, {
    type: "槓桿反向", aum: 2690, totalReturn1y: tr, priceReturn1y: tr - 1,
    volatility1y: 56, maxDrawdown1y: dd, yield: 1,
    dps: [{ m: 3, a: 0.05 }], payMonths: [3],
  });
  const plain = (code, dd, tr) => mkFund(code, {
    totalReturn1y: tr, priceReturn1y: tr - 3, volatility1y: 20, maxDrawdown1y: dd,
    yield: 5, dps: [{ m: 3, a: 0.25 }, { m: 9, a: 0.25 }],
  });
  const universe = [
    lev("00631L", -31.3, 208.9), lev("00632R", -53.1, -49.8),
    plain("00A", -9, 30), plain("00B", -8, 25), plain("00C", -10, 22), plain("00D", -7, 18),
  ];

  // 預設：正向槓桿不進池，且要記錄下來供 UI 揭露；反向永遠不進
  const off = app.helpers.buildCandidatePool(universe, { goal: "netTotal" });
  assert.ok(!off.some((r) => r.code === "00631L"), "沒勾選就不納入正向槓桿");
  assert.ok(!off.some((r) => r.code === "00632R"), "反向永遠不納入");
  assert.equal(off.rejected.leveraged, 1, "被槓桿規則擋掉的檔數要記錄（只算 L，R 不算）");

  // 勾選後正向槓桿進得來，反向仍然不行
  const on = app.helpers.buildCandidatePool(universe, { goal: "netTotal", includeLeveraged: true });
  assert.ok(on.some((r) => r.code === "00631L"), "勾選後正向槓桿要進得來");
  assert.ok(!on.some((r) => r.code === "00632R"), "勾選也不得讓反向進來");

  // 關鍵：回撤閘門優先於勾選。00631L 回撤 −31.3%，忍受度 30% 仍該被排除，
  // 否則問卷的「可接受虧損」就是騙人的。
  const gated = app.helpers.buildCandidatePool(universe,
    { goal: "netTotal", includeLeveraged: true, maxDrawdownPct: 30 });
  assert.ok(!gated.some((r) => r.code === "00631L"), "回撤超過忍受度時，勾選也不能讓它進來");

  // 不設限 + 勾選 → 端到端真的選得到，且它會是最大權重（去年報酬最高）
  const picked = app.helpers.optimizeAllocation(universe,
    Object.assign({ total: 2000000, netIncome: 500000 },
      app.helpers.profileToConstraints({ horizonYears: "15", maxLossPct: "", maxWeightPct: "30", includeLeveraged: true })));
  assert.ok(picked.picks.some((p) => p.code === "00631L"), picked.reason || "不設限＋勾選時應選得到");
});

// 候選池必須依報酬排序。依殖利率截斷會讓 0050（殖利率 91 檔中倒數第一、
// 近一年總報酬 +106.7%）永遠進不了搜尋空間——這正是「核心保送」原本想解決
// 卻解錯的問題：真正該保送的判準是報酬，不是規模。
test("the total-return pool ranks by return, not by yield", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const highYielders = Array.from({ length: 12 }, (_, i) => mkFund("00Y" + i, {
    type: "高股息", aum: 500, yield: 9 - i * 0.1,
    dps: [{ m: 3, a: 0.45 }, { m: 9, a: 0.45 }],
    totalReturn1y: 5 - i * 0.2, priceReturn1y: -3 - i * 0.2,
  }));
  const winner = mkFund("0050X", {
    name: "大型核心", type: "市值型", close: 100, aum: 21982, yield: 1.57,
    dps: [{ m: 2, a: 0.8 }, { m: 8, a: 0.8 }], payMonths: [2, 8],
    totalReturn1y: 106.7, priceReturn1y: 102.5,
  });
  const universe = highYielders.concat([winner]);

  const pool = app.helpers.buildCandidatePool(universe, { goal: "netTotal" });
  assert.equal(pool[0].code, "0050X", "報酬最高的必須排在池首，即使它殖利率墊底");
  const out = app.helpers.optimizeAllocation(universe, { total: 2000000, goal: "netTotal", netIncome: 500000 });
  assert.ok(out.picks.some((pick) => pick.code === "0050X"), "而且最佳化真的選得到它");
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

test("active funds are opt-in; leveraged and FX share classes are always out", async () => {
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

// ── 多年期：累積型（不配息）vs 配息再投資 ──────────────────────
// 反事實孿生：同一組配置，比較「配息並再投資」與「總報酬完全相同但不配息」的
// 假想版本。差額 100% 歸因於稅務與手續費摩擦——所以零摩擦時兩者必須完全相等，
// 那條測試不過的話，後面所有差額都不可信。

// 造一檔殖利率 y、股價 p 的 ETF。events 拆成 n 筆，用來測二代健保的單筆門檻。
function fundSec(code, price, yieldPct, payouts = 2, extra = {}) {
  const annual = price * yieldPct / 100;
  const events = Array.from({ length: payouts }, (_, i) => ({ m: i * 3 + 2, a: annual / payouts }));
  return Object.assign({ code, name: code, kind: "etf", price, events, type: "高股息" }, extra);
}
const alloc = (security, pct) => ({ code: security.code, pct, security });

async function projector() {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  return app.helpers.projectMultiYear;
}

// 這是整組功能的地基。價格成長若寫成 R − y 而不是 (1+R)/(1+y) − 1，
// 零摩擦下兩邊會差一個 y(R−y) 的二階項（R=8%、y=5% 時十年約 1.5%），
// 那個差額與稅費無關卻會被讀成摩擦成本。
test("with zero friction the two models must land on exactly the same number", async () => {
  const project = await projector();
  for (const years of [5, 10]) {
    const out = project({
      total: 1000000, years, rTotal: 8, stress: 1,
      allocations: [alloc(fundSec("00AA", 50, 5), 60), alloc(fundSec("00BB", 20, 9), 40)],
      netIncome: null,                                  // 無所得 → 不課綜所稅
      nhi: { rate: 0, threshold: 20000, cap: null },     // 健保歸零
      feeRate: 0, sellTaxRate: 0,                        // 手續費與證交稅歸零
    });
    const gap = Math.abs(out.accEnd - out.distEnd);
    assert.ok(gap < out.accEnd * 1e-9,
      `${years} 年零摩擦下兩模型必須相等，實差 ${gap.toFixed(2)}（占 ${(gap / out.accEnd * 100).toFixed(4)}%）` +
      "——價格成長可能誤用了 R − y 而不是 (1+R)/(1+y) − 1");
    // 而且要等於單純複利，證明迴圈本身沒有多算或少算一期
    assert.ok(Math.abs(out.accEnd - 1000000 * Math.pow(1.08, years)) < 1e-6, "累積型必須就是 (1+R)^Y");
  }
});

test("friction shows up as a deficit that reconciles item by item", async () => {
  const project = await projector();
  const out = project({
    total: 5000000, years: 10, rTotal: 8, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 6), 100)],
    netIncome: 2000000,                     // 高所得 → 稅為正
    taxParams: null, nhi: undefined,
    feeRate: 0.001425, sellTaxRate: 0.001,
  });
  assert.ok(out.taxTotal > 0, `高所得應課到稅，實得 ${out.taxTotal}`);
  assert.ok(out.nhiTotal > 0, "單筆過門檻應扣二代健保");
  assert.ok(out.accEnd > out.distEnd, "有稅時累積型必勝");
  // 只比大小不夠——差額必須真的來自那三項的複利，不是別處的計算漏洞。
  // 摩擦金額在中途被抽走，之後不再複利，所以終值差額必然大於摩擦本身的面額。
  assert.ok(out.delta > out.frictionSaved,
    `差額 ${Math.round(out.delta)} 應大於摩擦面額 ${Math.round(out.frictionSaved)}（被抽走的錢少賺了後續複利）`);
  // 上界：全部摩擦若都發生在第 1 年，最多長成 (1+R)^10 倍
  assert.ok(out.delta < out.frictionSaved * Math.pow(1.08, 10),
    "差額不該超過「摩擦全發生在第一年」的極限，超過代表重複計算");
});

// 使用者原本的驗收標準寫「累積型必須 ≥ 配息型」。低所得時會反過來：
// 合併計稅的 8.5% 股利抵減（上限 8 萬）可能大於應納稅額而退稅。
// 這條鎖住那個反直覺但正確的行為——它是這個功能最有價值的輸出。
test("a dividend tax refund can flip the result in favour of distributing", async () => {
  const project = await projector();
  const out = project({
    total: 1000000, years: 10, rTotal: 6, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 6), 100)],
    netIncome: 100000,                       // 低所得 → 8.5% 抵減大於應納稅額
    nhi: { rate: 0, threshold: 20000, cap: null },
    feeRate: 0, sellTaxRate: 0,
  });
  assert.ok(out.refundYears > 0, `低所得應出現退稅年度，實得 ${out.refundYears}`);
  assert.ok(out.taxTotal < 0, `累計稅應為負（退稅），實得 ${out.taxTotal}`);
  assert.ok(out.distEnd > out.accEnd,
    "退稅情境下配息型應勝出——「累積型永遠比較好」是錯的，這是本功能最該講出來的結論");
});

// 二代健保是「單筆」≥ 2 萬。多年模型才看得出來的動態：
// 第 1 年單筆不到門檻，隨再投資複利在某一年跨過去，從那年起才開始扣。
test("the NHI threshold is crossed partway through, not from year one", async () => {
  const project = await projector();
  // 單筆 = 100 萬 × 4% ÷ 1 次 = 40,000 → 一開始就過門檻
  const over = project({
    total: 1000000, years: 5, rTotal: 8, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 4, 1), 100)],
    netIncome: null, feeRate: 0, sellTaxRate: 0,
  });
  assert.equal(over.nhiFirstYear, 1, "一開始就超過門檻的應從第 1 年扣");

  // 單筆 = 30 萬 × 4% ÷ 1 次 = 12,000 → 要複利幾年才會跨過 20,000
  const later = project({
    total: 300000, years: 15, rTotal: 8, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 4, 1), 100)],
    netIncome: null, feeRate: 0, sellTaxRate: 0,
  });
  assert.ok(later.nhiFirstYear > 1 && later.nhiFirstYear <= 15,
    `門檻應在中途跨過，實得第 ${later.nhiFirstYear} 年`);
  const before = later.rows[later.nhiFirstYear - 2];
  const after = later.rows[later.nhiFirstYear - 1];
  assert.equal(before.nhi, 0, "跨過門檻之前不該扣費");
  assert.ok(after.nhi > 0, "跨過門檻那年起才開始扣費");
});

test("the exit cost is charged to both sides, never only one", async () => {
  const project = await projector();
  const base = { total: 1000000, years: 10, rTotal: 8, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 5), 100)], netIncome: 1000000, feeRate: 0.001425 };
  const withTax = project(Object.assign({}, base, { sellTaxRate: 0.001 }));
  const noTax = project(Object.assign({}, base, { sellTaxRate: 0 }));
  assert.ok(noTax.accEnd > withTax.accEnd, "取消證交稅應抬高累積型");
  assert.ok(noTax.distEnd > withTax.distEnd, "也必須同時抬高配息型——只抬一邊就是偏袒");
  assert.ok(withTax.accExit > withTax.distExit,
    "累積型資產較大，出場成本的絕對金額必然較高");
});

test("dividends per unit grow with price so the yield does not silently decay", async () => {
  const project = await projector();
  const out = project({
    total: 1000000, years: 10, rTotal: 10, stress: 1,
    allocations: [alloc(fundSec("00AA", 50, 5), 100)],
    netIncome: null, nhi: { rate: 0, threshold: 20000, cap: null }, feeRate: 0, sellTaxRate: 0,
  });
  // 若每單位配息釘死在第 0 年，第 10 年的配息總額會遠低於資產成長幅度，
  // 稅基被系統性低估、摩擦成本被算得太小
  const first = out.rows[0].gross;
  const last = out.rows[9].gross;
  assert.ok(last > first * 2,
    `第 10 年配息 ${Math.round(last)} 應隨資產成長（第 1 年 ${Math.round(first)}），` +
    "否則殖利率會機械式衰減、摩擦被低估");
});

test("the page says out loud when distributing wins, instead of burying it", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("sim");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  set("simTotal", "600000");
  set("simNetIncome", "150000");     // 低所得 → 8.5% 抵減 > 應納稅額
  app.setSimAllocations([{ code: "0056", pct: 100, shares: null, month: null }]);
  set("pmReturn", "8");
  const detail = elements.get("pmDetail").innerHTML;
  assert.match(detail, /配息型反而勝出/, "翻轉時必須明講，否則使用者會照著「累積型比較好」做決定");
  assert.match(detail, /8\.5% 股利抵減/, "要說得出原因是股利抵減，不能只說結果");
});

test("a missing net income is disclosed rather than silently treated as tax-free", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("sim");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  set("simTotal", "5000000");
  set("simNetIncome", "");            // 沒填
  app.setSimAllocations([{ code: "0056", pct: 100, shares: null, month: null }]);
  set("pmReturn", "8");
  assert.match(elements.get("pmDetail").innerHTML, /沒有計入所得稅/,
    "沒填所得就不能讓人以為免稅——摩擦會被低估");
});

// ── 新手介面：結論卡的方向不可寫死 ──────────────────────────────
// 新手看不出「累積型是假想商品」，也看不出自己的所得級距會讓結論翻轉。
// 這幾條鎖住的是「不會把人帶往錯的方向」，不是「畫得好不好看」。
async function beginnerPanel(overrides = {}) {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("sim");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  set("simTotal", overrides.total == null ? "5000000" : overrides.total);
  if (overrides.salary != null) set("simSalary", overrides.salary);
  set("simNetIncome", overrides.netIncome == null ? "2500000" : overrides.netIncome);
  app.setSimAllocations([{ code: "0056", pct: 100, shares: null, month: null }]);
  set("pmReturn", overrides.rTotal == null ? "8" : overrides.rTotal);
  return { app, elements, set };
}

test("the verdict names whichever side actually wins, in both directions", async () => {
  const high = await beginnerPanel({ netIncome: "2500000" });
  const highText = high.elements.get("pmVerdict").innerHTML;
  assert.match(highText, /不配息的版本多留住/, "高所得：不配息勝出");
  assert.doesNotMatch(highText, /反而退稅/);

  const low = await beginnerPanel({ total: "600000", netIncome: "150000" });
  const lowText = low.elements.get("pmVerdict").innerHTML;
  assert.match(lowText, /領股息反而退稅/,
    "低所得：領股息反而退稅。寫死方向會把這個族群帶往錯的決定，而新手看不出來");
  assert.match(lowText, /有配息的版本多留住/, "要明說是哪一邊比較多");
});

test("the verdict never tells the beginner to buy something that does not exist", async () => {
  const { elements } = await beginnerPanel();
  const verdict = elements.get("pmVerdict").innerHTML;
  assert.doesNotMatch(verdict, /推薦|建議選|該選/, "非投顧：不下指令");
  assert.match(verdict, /台灣沒有這種商品/, "必須點明不配息版本在台灣買不到");
  assert.match(verdict, /影響你要不要偏好高股息/, "要導向真的可執行的那件事");
});

test("the months-of-salary comparison only appears when a salary was entered", async () => {
  const without = await beginnerPanel();
  assert.doesNotMatch(without.elements.get("pmVerdict").innerHTML, /個月/,
    "沒填年薪就不可換算月薪——不用臆測的數字說話");
  const withSalary = await beginnerPanel({ salary: "1200000" });
  const text = withSalary.elements.get("pmVerdict").innerHTML;
  assert.match(text, /個月/);
  assert.match(text, /家庭薪水/, "simSalary 是家庭合計，換算後要標明");
});

test("an empty field is named out loud instead of leaving the panel blank", async () => {
  const noMoney = await beginnerPanel({ total: "" });
  assert.match(noMoney.elements.get("pmNeed").innerHTML, /投入總額/, "要指名是哪一格");
  const noIncome = await beginnerPanel({ netIncome: "" });
  const need = noIncome.elements.get("pmNeed").innerHTML;
  assert.match(need, /年薪/, "新手不知道「綜合所得淨額」，要引導他填年薪");
  assert.match(need, /算不出所得稅/, "要說出不填的後果，否則他會直接略過");
  const filled = await beginnerPanel({ salary: "1200000" });
  assert.equal(filled.elements.get("pmNeed").innerHTML, "", "都填好了就不該再提示");
});

// 摺疊只能是視覺上的。若把進階輸入停用，使用者改了卻沒反應會以為壞掉。
test("collapsing the advanced box does not stop its inputs from feeding the model", async () => {
  const { elements, set } = await beginnerPanel({ rTotal: "8" });
  const before = elements.get("pmVerdict").innerHTML;
  set("pmReturn", "15");
  const after = elements.get("pmVerdict").innerHTML;
  assert.notEqual(before, after, "改了年化報酬，結論必須跟著變");
});

test("the shaded band flips colour and wording with the direction", async () => {
  const high = await beginnerPanel({ netIncome: "2500000" });
  const highChart = high.elements.get("pmChart").innerHTML;
  assert.match(highChart, /data-gap="friction"/);
  assert.match(highChart, /被稅與手續費摩擦掉的錢/);

  const low = await beginnerPanel({ total: "600000", netIncome: "150000" });
  const lowChart = low.elements.get("pmChart").innerHTML;
  assert.match(lowChart, /data-gap="refund"/, "翻轉時陰影的語意也翻轉");
  assert.match(lowChart, /多拿到的退稅/, "不可固定寫「被摩擦掉的錢」");
  assert.doesNotMatch(lowChart, /被稅與手續費摩擦掉的錢/);
});

// ── 主視覺：結論先講 ──────────────────────────────────────────
// 這一組守的是「簡化沒有簡化掉誠實」，不是「排版好不好看」。
// 自備一份帶多窗報酬的 feed：共用 fixture 沒有報酬欄位，而其他測試靠「沒有」來驗「—」，
// 直接加欄位會動到它們的期望。
function heroFeedMock() {
  const base = { market: "twse", type: "市值型", nav: null, discountPremium: null, aum: 5000,
    frequency: "半年配", payMonths: [2, 8], dps: [{ m: 2, a: 1.6 }, { m: 8, a: 1.7 }] };
  const feed = etfFeed({ count: 4, stocks: [
    // 價差必須跟著給：adaptiveReturnWindow 要求總報酬與價差**都有**才計入該檔，
    // 否則「價差＋配息」會與總報酬用不同分母而加不回去
    Object.assign({}, base, { code: "0050", name: "元大台灣50", close: 100, yield: 3.3,
      totalReturn1y: 20, priceReturn1y: 16, maxDrawdown1y: -15,
      totalReturn3y: 60, priceReturn3y: 48, maxDrawdown3y: -25,
      totalReturn5y: 120, priceReturn5y: 95, maxDrawdown5y: -36, cagr5y: 17,
      topHoldings: [{ name: "台積電", weight: 57.37 }, { name: "聯發科", weight: 6.11 }], holdingsAsOf: "2026-07-27" }),
    // 只有 1Y 的新上市標的：用來驗選窗會不會被「唯一有長歷史的那檔」綁架
    Object.assign({}, base, { code: "00NEW", name: "新上市高息", close: 20, yield: 8,
      totalReturn1y: 30, priceReturn1y: 22, maxDrawdown1y: -10, topHoldings: [], returnSpanDays: 400 }),
    // 不配息的槓桿型：配息 0、價差就是全部的總報酬
    Object.assign({}, base, { code: "00LEV", name: "槓桿正2", close: 50, yield: null,
      dps: [], payMonths: [], frequency: null,
      totalReturn1y: 90, priceReturn1y: 90, maxDrawdown1y: -40, topHoldings: [] }),
    // 只有價差、沒有總報酬（缺 adjclose）：不可被任何一邊計入
    Object.assign({}, base, { code: "00NOADJ", name: "缺還原價", close: 30, yield: 5,
      priceReturn1y: 10, maxDrawdown1y: -12, topHoldings: [] }),
  ] });
  return async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) return okResponse(marketFeed());
    if (href.startsWith("/data/etf-feed.json")) return okResponse(feed);
    throw new Error("unavailable: " + href);
  };
}

async function heroPanel(allocations, overrides = {}) {
  const { app, elements, html } = await loadMarket(heroFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  // 先設標的再設總額：setSimAllocations 只 renderSimRows()、不重算，
  // 靠後面 simTotal 的 input 事件觸發 runSim() 才會更新主視覺
  if (allocations) app.setSimAllocations(allocations);
  set("simTotal", overrides.total == null ? "1000000" : overrides.total);
  return { app, elements, set, html, hero: () => elements.get("simHero").innerHTML };
}

// ── 階段三：資訊層級化 ────────────────────────────────────────
// 收合起來的區塊只剩一個標題，使用者無從判斷值不值得展開。副標改成帶當次結果的
// 摘要，但**必須由計算結果寫入**——寫死一個數字比留白更糟，它會在組合換了之後說謊。
test("collapsed folds carry the result in their title, computed not hardcoded", async () => {
  const { elements } = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }],
    { total: "1000000" });
  const perf = elements.get("simPerfSummary").textContent;
  const exposure = elements.get("simExpSummary").textContent;
  assert.match(perf, /月均 [\d,]+ 元/, "詳細績效收合時要看得到月均現金流");
  assert.match(exposure, /最重 .+ [\d.]+%/, "成分股收合時要看得到最重的那一檔");

  // 換一個總額，摘要必須跟著變——不變就是寫死的
  const doubled = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }],
    { total: "2000000" });
  assert.notEqual(doubled.elements.get("simPerfSummary").textContent, perf,
    "總額加倍後月均沒變，代表副標是寫死的而不是算出來的");
});

test("a fold with nothing to report falls back to its static subtitle", async () => {
  const { app, elements, set, html } = await heroPanel(
    [{ code: "0050", pct: 100, shares: null, month: null }], { total: "1000000" });
  // fake DOM 不解析靜態文字，span 一開始是空的；照瀏覽器的實情把 HTML 裡的副標填回去，
  // 否則測到的是「空字串還原成空字串」，等於什麼都沒驗
  const staticSub = html.match(/<span id="simPerfSummary">([^<]*)<\/span>/)[1];
  assert.ok(staticSub.trim().length > 0, "HTML 裡本來就該有一個靜態副標");

  const node = elements.get("simPerfSummary");
  node.textContent = staticSub;
  node.dataset.foldFallback = null;
  set("simTotal", "1000000");
  assert.match(node.textContent, /月均/, "有結果時要換成結果摘要");

  set("simTotal", "");
  assert.equal(node.textContent, staticSub,
    "清掉總額後副標必須回到原本的說明，留白會讓收合區變成一個沒有說明的標題");
  assert.doesNotMatch(node.textContent, /月均/, "沒有結果就不該留著上一次的月均");
});

// 移進折疊區的資訊仍然要在 DOM 裡。用 textContent 而非 innerText：
// 收合的 <details> 其 innerText 是空字串，用它做斷言會全部假通過。
test("hierarchy changes moved information, they did not delete it", async () => {
  const { html } = await loadMarket(dualFeedMock());
  for (const kept of [
    "證券交易稅條例第 2 條第 2 款", "第 2-1 條第 2 項只到 2026-12-31",
    "0.1425% 為券商公告標準費率",
    "滾動 12 個月已除息配息", "保送規模前 3 大的合格標的入池", "不判斷配息可持續性",
    "刻意不問的事", "再平衡頻率",
  ]) {
    assert.ok(html.includes(kept), `「${kept}」在層級化過程中被刪掉了——只能移位，不能移除`);
  }
});

test("the projection's annual table sits behind a disclosure, its warnings do not", async () => {
  const { html } = await loadMarket(dualFeedMock());
  assert.match(html, /▸ 查看年度明細與費用依據/, "逐年 10 列是佐證，不該擋在結論前面");
  // 警語不可跟著被收進去：它們是「這個數字有多可信」，收起來等於沒講
  const notes = html.slice(html.indexOf("function projectionNotes"));
  const detailsAt = notes.indexOf("▸ 查看年度明細");
  for (const warn of ["沒有計入所得稅", "配息型反而勝出"]) {
    assert.ok(notes.indexOf(warn) < detailsAt && notes.indexOf(warn) > -1,
      `「${warn}」被收進折疊區了——警語必須常駐`);
  }
});

test("the exposure block does not repeat its own fold title as a heading", async () => {
  const { html } = await loadMarket(dualFeedMock());
  assert.doesNotMatch(html, /<h2 style="margin-top:26px">實質曝險/,
    "fold 內再放一個 h2 等於把 summary 講第二次，層級也錯（h2 排在 h3 之後）");
  assert.match(html, /<summary>成分股與重疊：實質曝險/,
    "標題只能併進 summary，不能整個消失");
});

test("the landing tab is the simulator, not the 1,958-row stock table", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.getActiveTab(), "sim", "新手一進來該看到結論，不是千列表格");
  assert.equal(elements.get("simPanel").hidden, false);
  assert.equal(elements.get("stockPanel").hidden, true);
});

// 這是本次最重要的一條。截圖那組配置五檔只有一檔有五年資料，
// 固定 5 年會讓那一檔（正2）的 +497.6% 代表整個組合。
test("the headline return window adapts instead of letting one fund speak for the portfolio", async () => {
  // 0050 有 1/3/5Y，00NEW 只有 1Y。各半配置時 5Y 只涵蓋 50%、3Y 也只有 50%，
  // 都低於 80% 門檻 → 必須退回 1Y。若固定 5Y，畫面會印出 0050 一檔的 +120%
  // 當成整個組合的五年報酬——那正是實測那組配置會發生的事（+497.6% 來自一檔正2）。
  const half = await heroPanel([
    { code: "0050", pct: 50, shares: null, month: null },
    { code: "00NEW", pct: 50, shares: null, month: null },
  ]);
  const html = half.hero();
  assert.match(html, /投資總報酬/, "總報酬要有自己的一組標題");
  assert.match(html, /近 1 年/, "涵蓋率不足的長窗必須被跳過");
  assert.doesNotMatch(html, /近 5 年/);
  assert.doesNotMatch(html, /120/, "不可拿唯一有五年資料的那檔代表整個組合");
  assert.match(html, /涵蓋組合的 100%/);

  // 全押有完整歷史的那檔 → 5Y 涵蓋 100%，就該用最長窗
  const full = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  assert.match(full.hero(), /近 5 年/, "涵蓋率夠就要用最長窗，短窗會低估風險");

  assert.equal(half.app.helpers.WINDOW_MIN_COVERAGE, 80,
    "門檻改動會直接改變主視覺顯示的年數，必須是刻意的");
});
test("the headline states which window it used and how much of the portfolio it covers", async () => {
  const { hero } = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const html = hero();
  assert.match(html, /近 \d 年/, "要講明是幾年，不可含糊寫「總報酬」");
  assert.match(html, /涵蓋組合的 \d+%/, "涵蓋率必須攤開，門檻本身是判斷");
  assert.match(html, /回測，不是預測/);
});

test("concentration reuses the shipped thresholds and keeps the visible-only caveat", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  const { concentrationGrade } = app.helpers;
  assert.equal(concentrationGrade(4).label, "高");
  assert.equal(concentrationGrade(7).label, "中等");
  assert.equal(concentrationGrade(12).label, "低");
  assert.equal(concentrationGrade(null), null, "沒有成分股資料就不給等級");
  const { hero } = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  assert.match(hero(), /只算看得到的前十大成分股/,
    "簡化不可把「只看得到前十大」這個誠實邊界一起簡化掉");
});

test("an empty portfolio gets a pointer, not a blank hero", async () => {
  const { hero } = await heroPanel(null, { total: "" });
  const html = hero();
  assert.ok(html.length > 0, "留白會讓新手以為壞了");
  assert.match(html, /投入總額/, "要指名是哪一格");
  assert.match(html, /加入標的/, "要講出下一步按哪顆");
});

test("the plain-language disclaimer stays outside the folds", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const firstFold = html.indexOf('<details');
  const plain = html.indexOf("這是<b>試算不是預測</b>");
  assert.ok(plain > 0 && plain < firstFold,
    "白話免責必須看得到；完整說明才收進折疊");
  // 契約釘住的完整揭露仍須存在（收在折疊裡也算）
  for (const pin of ["不是投資建議", "不是稅務建議", "應稅比例是推定的", "發放時不扣繳所得稅"]) {
    assert.ok(html.includes(pin), `契約揭露 ${pin} 不可因為簡化而消失`);
  }
});

test("collapsing does not disable the inputs inside", async () => {
  const { elements, set, hero } = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const before = hero();
  set("simTotal", "3000000");
  assert.notEqual(hero(), before, "折疊只是視覺收合，改了輸入主視覺仍要跟著變");
  assert.match(hero(), /3,000,000/);
});

// ── 三條主線：現金流／投資總報酬／風險 ──────────────────────────
// 起因：原本六格裡有三格給現金流，等於在版面上暗示不配息的標的不重要。
// 實測那組配置近三年 84% 的總報酬來自價差、只有 16% 來自配息。

// 這是本輪最重要的一條。價差必須與總報酬用**同一組標的**累加。
// 注意不能用「價差＋配息 == 總報酬」當判準——dividendPart 是由總報酬減價差得來的，
// 那個等式是定義式恆成立，測了等於沒測（第一版就是這樣寫，mutation 完全咬不住）。
// 會露出馬腳的是**價差的值本身**。
test("the price-return leg is accumulated over the same funds as the total return", async () => {
  // 00NOADJ 只有 1Y 價差、沒有總報酬（缺 adjclose）。主持股用只有 1Y 的 00NEW，
  // 才會落在 1Y 窗上——那正是 00NOADJ 有價差資料、可能被誤算進去的那個窗。
  // 這樣才驗得到「它有沒有被偷偷算進價差那一邊」。
  const panel = await heroPanel([
    { code: "00NEW", pct: 90, shares: null, month: null },
    { code: "00NOADJ", pct: 10, shares: null, month: null },
  ]);
  const win = panel.app.helpers.adaptiveReturnWindow([
    { code: "00NEW", pct: 90, shares: null, month: null },
    { code: "00NOADJ", pct: 10, shares: null, month: null },
  ]);
  assert.ok(win, "涵蓋 90% ≥ 80%，窗應該成立");
  assert.equal(win.coverage, 90, "00NOADJ 不可計入涵蓋率");
  // 只有 00NEW 該被算到：總報酬 30、價差 22、配息 8pp
  assert.equal(win.years, 1, "00NEW 只有一年歷史，長窗涵蓋率為 0 會被跳過");
  assert.equal(win.totalReturn, 30);
  assert.equal(win.priceReturn, 22,
    "價差若把 00NOADJ 也算進去會變成 23.1——那代表兩邊用了不同分母");
  assert.equal(win.dividendPart, 8);
});
// 缺 adjclose 的標的只有價差、沒有總報酬。若價差那一邊把它算進去，
// 分母就不一樣了，拆解會悄悄對不起來。
test("a fund with price data but no total return is excluded from both sides", async () => {
  const panel = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const { adaptiveReturnWindow } = panel.app.helpers;
  const clean = adaptiveReturnWindow([{ code: "0050", pct: 100, shares: null, month: null }]);
  const mixed = adaptiveReturnWindow([
    { code: "0050", pct: 50, shares: null, month: null },
    { code: "00NOADJ", pct: 50, shares: null, month: null },
  ]);
  // 00NOADJ 佔一半且不可計入 → 涵蓋率必須掉到 50%，低於 80% 門檻 → 整個窗不成立
  assert.ok(clean, "全押有完整資料的標的算得出來");
  assert.equal(mixed, null,
    "只有價差沒有總報酬的標的必須兩邊都不算，且涵蓋率要反映這件事");
});

test("the hero puts cash flow and total return on equal footing", async () => {
  const { hero } = await heroPanel([
    { code: "0050", pct: 50, shares: null, month: null },
    { code: "00LEV", pct: 50, shares: null, month: null },
  ]);
  const html = hero();
  for (const label of ["現金流", "投資總報酬", "風險"]) {
    assert.ok(html.includes(label), `三條主線都要有標題，缺 ${label}`);
  }
  // 版面權重：現金流不可再佔比總報酬多的格數
  const groups = html.split('class="hero-group"');
  const cardsIn = (i) => (groups[i].match(/class="hero-kpi"/g) || []).length;
  assert.equal(cardsIn(1), cardsIn(2),
    "現金流與總報酬的卡片數必須相同，否則版面又在暗示哪一邊比較重要");
  assert.match(html, /價差和配息一起算/, "要講明總報酬的組成");
  assert.match(html, /% 價差/, "拆解要給實際數字，不是靜態標語");
  assert.match(html, /配息貢獻/);
});

test("the non-paying holdings note appears only when there actually are any", async () => {
  const withLev = await heroPanel([
    { code: "0050", pct: 50, shares: null, month: null },
    { code: "00LEV", pct: 50, shares: null, month: null },
  ]);
  const html = withLev.hero();
  assert.match(html, /1 檔是不配息的/, "有不配息標的就要講，否則新手會問「買它幹嘛」");
  assert.match(html, /00LEV/, "要點名是哪一檔");
  assert.match(html, /價差照樣算進上面的總報酬/);
  assert.match(html, /資本增值/, "要說出它的角色");

  const allPayers = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  assert.doesNotMatch(allPayers.hero(), /不配息的/,
    "全部都配息時不該多這一句——不相干的說明也是雜訊");
});

// ── 迴歸：投影的預設報酬率不可只對「有資料的檔」取平均 ────────────
// 實測 bug：五檔配置裡只有 00631L 有 cagr5y，舊版 defaultProjectionReturn
// 直接跳過沒資料的檔、對剩下那一檔取平均，回傳 43.2%，
// 等於拿 20% 資產的報酬率套到 100% 的組合——投影十年把 150 萬變成 5,347 萬。
// 主視覺早就修好了（涵蓋率門檻），這支函式寫在更早、沒跟著補。
test("the projection default rate goes through the same coverage gate as the hero", async () => {
  const panel = await heroPanel([
    { code: "00NEW", pct: 80, shares: null, month: null },   // 只有 1Y
    { code: "0050", pct: 20, shares: null, month: null },    // 有 1/3/5Y
  ]);
  const { defaultProjectionReturn, adaptiveReturnWindow } = panel.app.helpers;
  const win = adaptiveReturnWindow([
    { code: "00NEW", pct: 80, shares: null, month: null },
    { code: "0050", pct: 20, shares: null, month: null },
  ]);
  // 5Y 只有 0050（20%）→ 涵蓋率不足；必須退回 1Y（兩檔都有 → 100%）
  assert.equal(win.years, 1, "長窗涵蓋率不足要退回短窗");
  assert.equal(win.coverage, 100);
  const rate = defaultProjectionReturn();
  // 1Y 加權總報酬 = 30×0.8 + 20×0.2 = 28；一年期的年化就是它本身
  assert.ok(Math.abs(rate - 28) < 0.2,
    `預設報酬率應為 28%（1Y 加權），實得 ${rate}——` +
    "若只對有 cagr5y 的檔取平均會得到 0050 一檔的 17%，那是 20% 資產代表 100% 組合");
});

test("the projection default is annualised from the window, not a raw total return", async () => {
  const panel = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const rate = panel.app.helpers.defaultProjectionReturn();
  // 5Y 總報酬 120% → 年化 = 1.2^(1/5) 之於 2.2 開五次方 − 1 = 17.1%
  const expected = (Math.pow(2.2, 1 / 5) - 1) * 100;
  assert.ok(Math.abs(rate - expected) < 0.2,
    `五年總報酬 120% 的年化應為 ${expected.toFixed(1)}%，實得 ${rate}——` +
    "直接把總報酬當年化會讓十年投影暴衝");
  assert.ok(rate < 20, "年化值必須遠小於五年總報酬 120%");
});

test("the assumption warning is visible, not buried in a collapsed box", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const noteAt = html.indexOf('id="pmAssumeNote"');
  assert.ok(noteAt > 0);
  // 數一數這個節點被包在幾層 details 裡：整段投影都建立在那個報酬率上，
  // 而它是回測外推。原本埋在兩層 details（配息分析 → 進階設定）裡，等於沒寫。
  const before = html.slice(0, noteAt);
  const opens = (before.match(/<details/g) || []).length;
  const closes = (before.match(/<\/details>/g) || []).length;
  assert.equal(opens - closes, 1,
    `假設說明只能在「配息分析」那一層，實際被包了 ${opens - closes} 層——` +
    "再往裡收使用者就看不到「這是回測外推」了");
});

test("switching mode visibly changes the chart, not just one hidden label", async () => {
  const panel = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const chart = () => panel.elements.get("pmChart").innerHTML;
  const before = chart();
  panel.elements.get("pmAcc").listeners.get("click")();
  const after = chart();
  assert.notEqual(before, after, "切換模式圖表必須有反應");
  // 選中的線要粗、沒選中的要淡，否則使用者按了看不出差別
  assert.match(after, /stroke="var\(--teal\)" stroke-width="3"/, "選中不配息時該線要加粗");
  assert.match(after, /stroke-opacity="0\.35"/, "沒選中的線要壓淡");
  assert.match(after, /你目前看的是<b>不配息<\/b>/, "圖說要講明你在看哪一條");
});

test("the thin friction band carries its value as a number", async () => {
  const panel = await heroPanel([{ code: "0050", pct: 100, shares: null, month: null }]);
  const chart = panel.elements.get("pmChart").innerHTML;
  // 差距通常只有總資產的 1~2%，在零基準軸上就是幾個像素（實測 4.35px）。
  // 不縮放縱軸去放大它，改成把金額標在旁邊。
  assert.match(chart, /差 [\d,]+ 元/, "細到看不見的色帶要有數字說明它是多少錢");
  assert.match(chart, /縱軸從 0 起算、沒有縮放/, "要解釋它為什麼看起來這麼薄");
});

// ── 控制項要在它所改的數字上方 ──────────────────────────────────
// 起因：上一版把壓力測試與年薪收進折疊，實測它們落在主視覺下方 469~885px，
// 按下去受影響的數字已經捲出畫面。用 DOM 順序斷言，不靠像素（像素會隨字型變）。
test("controls that change the headline sit above it in the document", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const heroAt = html.indexOf('id="simHero"');
  assert.ok(heroAt > 0);
  for (const id of ["simTotal", "simAdd", "s100", "s80", "s60",
                    "simSalary", "simFiling", "simDependents", "simNetIncome",
                    "simOptimize"]) {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > 0, `${id} 應該存在`);
    assert.ok(at < heroAt,
      `${id} 會改變主視覺的數字，必須排在 simHero 之前——` +
      "放在下方等於按了看不到效果");
  }
});

// ── 手順：控制項要跟它的輸出擺在一起 ────────────────────────────
// 上面那條規則只顧到「控制項 → 主視覺」，漏掉 simAdd／simOptimize 的**主要輸出
// 其實是 #simRows**。實測（375px、5 檔）它們離自己的清單 1,538px／1,261px，
// 按「＋ 加入標的」時新列落在畫面外 2,028px 處、頁面不捲動——按了看不到任何事發生。
test("the add and rebalance buttons sit with the list they act on", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const at = (id) => html.indexOf('id="' + id + '"');
  const rows = at("simRows");
  assert.ok(rows > 0);

  // 清單夾在兩顆按鈕之間：加入在上、重算在下
  assert.ok(at("simAdd") < rows, "「＋ 加入標的」要排在它產生的清單之前");
  assert.ok(at("simOptimize") > rows, "「重算比例」改寫的是清單裡的比例，要緊跟在清單之後");

  // 中間不得再夾進別的區塊——夾了就等於又被推開
  const between = html.slice(at("simAdd"), at("simOptimize"));
  for (const intruder of ["s100", "s80", "s60", "simSalary", "simFiling",
                          "simDependents", "simNetIncome", "simHero"]) {
    assert.ok(!between.includes('id="' + intruder + '"'),
      `${intruder} 夾在「加入標的」與「重算比例」之間，會把它們跟清單推開`);
  }
  // 清單本身仍要在主視覺之前，否則第一條規則會被破壞
  assert.ok(rows < at("simHero"), "清單要在主視覺之前，控制項才不會被迫離開它");
});

// 舊版滿 10 檔時 handler 直接 return：列數不變、按鈕外觀不變、一句話都沒有。
test("hitting the holdings cap says so instead of doing nothing", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cap = app.AUTO_ALLOCATE_MAX_FUNDS;
  const add = elements.get("simAdd");

  app.setSimAllocations(Array.from({ length: cap - 1 },
    () => ({ code: "0050", pct: null, shares: null, month: null })));
  assert.equal(add.disabled, false, "還沒到上限就不該擋");
  assert.match(add.textContent, /加入標的/, "沒到上限時按鈕維持原本的邀請語");

  app.setSimAllocations(Array.from({ length: cap },
    () => ({ code: "0050", pct: null, shares: null, month: null })));
  assert.equal(add.disabled, true, "到上限了還讓人按，按了又沒反應");
  assert.match(add.textContent, new RegExp("上限 " + cap + " 檔"),
    `按鈕要自己講出上限是 ${cap} 檔——訊息不能放 simOptimizeNote，autoAllocate 每次都會覆寫它`);
  assert.match(add.title, /移除一檔/, "要講得出怎麼解除，否則使用者卡在這裡");

  // 移除後要能恢復，否則使用者永遠加不回來
  app.setSimAllocations([{ code: "0050", pct: null, shares: null, month: null }]);
  assert.equal(add.disabled, false, "降到上限以下必須解除 disabled");
  assert.match(add.textContent, /加入標的/, "文字也要換回來");
});

// init() 的順序是 loadSimState() → bind() → await load() → showTab() 才 renderSimRows()。
// 也就是說**按鈕在 feed 載入完成前就已經可以按，但還沒同步過上限狀態**。
// 回訪使用者存了滿額持股又在這個空窗按下去，就會回到「按了沒反應」。
// handler 自己也要能修好狀態，不能只依賴 renderSimRows。
test("the add button heals its own state if it is clicked before the first render", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cap = app.AUTO_ALLOCATE_MAX_FUNDS;
  const add = elements.get("simAdd");

  app.setSimAllocations(Array.from({ length: cap },
    () => ({ code: "0050", pct: null, shares: null, month: null })));
  // 手動把按鈕打回「尚未同步」的樣子，重現那個空窗
  add.disabled = false;
  add.textContent = "＋ 加入標的";

  add.fire("click");
  assert.equal(app.getSimAllocations().length, cap, "上限本身不可被繞過");
  assert.equal(add.disabled, true,
    "handler 在擋掉這次點擊的同時要把按鈕狀態修好，否則使用者會一直按一顆沒反應的按鈕");
  assert.match(add.textContent, new RegExp("上限 " + cap + " 檔"));
});

// 反過來也要守：輸出就在旁邊的控制項不可被「一律搬到最上面」而離開它的結果。
test("controls whose output is adjacent stay next to that output", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const pairs = [
    ["pmAcc", "pmChart"], ["pmDist", "pmChart"], ["pm5", "pmChart"], ["pm10", "pmChart"],
    ["pmReturn", "pmChart"], ["pmFee", "pmChart"],
    ["gNetTotal", "suggestResult"],
  ];
  const heroAt = html.indexOf('id="simHero"');
  for (const [control, output] of pairs) {
    const c = html.indexOf('id="' + control + '"');
    const o = html.indexOf('id="' + output + '"');
    assert.ok(c > 0 && o > 0, `${control}／${output} 應該存在`);
    assert.ok(c < o, `${control} 應該在它的輸出 ${output} 之前`);
    assert.ok(c > heroAt,
      `${control} 的輸出就在自己旁邊，不該被搬到主視覺上方——那會讓它離開結果`);
  }
});

test("moving the controls out of the folds did not drop any of them", async () => {
  const { html, app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 折疊整個移除、內容全部上移——一項都不能少。
  // simUseHoldings 是刻意刪掉的：手填股數已會自動綁定總額，而它加總所有有股數的列
  // （含優化器算出來的），在自動配置後按下去會把總額削掉零股殘值。
  for (const id of ["s100", "s80", "s60", "simSalary", "simFiling", "simDependents",
                    "simNetIncome", "simNetIncomeHint", "simOptimize",
                    "simOptimizeNote"]) {
    assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1,
      `${id} 必須剛好出現一次——搬移時漏刪舊的會產生兩個同 id 的元素`);
  }
  // 提示用的 span 要等程式查詢過才會在假 DOM 裡建立節點，
  // 所以只對 bind() 真的會綁事件的控制項斷言「抓得到」
  for (const id of ["s100", "s80", "s60", "simSalary", "simFiling", "simDependents",
                    "simNetIncome", "simOptimize"]) {
    assert.ok(elements.get(id), `${id} 必須抓得到，否則事件綁不上去`);
  }
  assert.doesNotMatch(html, /<summary>風險分析/, "風險分析折疊的外殼應該移除，內容已上移");
  assert.doesNotMatch(html, /<summary>進階設定</, "進階設定折疊的外殼應該移除，內容已上移");
});

// 這條原本只比對一個寫死的字串，結果 5dd083e6 把稅務區拆出折疊、標籤改成「稅務設定」後，
// 測試反而把**已經過時的文案固定住**：畫面叫使用者「展開」一個不再收合的區塊，
// 名字也對不上。改成結構性斷言——指路提到的名稱必須真的出現在頁面上，
// 而且不得叫人展開沒有收合的東西。這樣下次版面再動，測試會抓到而不是幫忙掩蓋。
test("the pointer to the salary field names something that actually exists on the page", async () => {
  const { app, elements, html } = await loadMarket(dualFeedMock());
  await app.init();
  await app.showTab("sim");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  set("simTotal", "5000000");
  set("simNetIncome", "");
  app.setSimAllocations([{ code: "0056", pct: 100, shares: null, month: null }]);
  set("pmReturn", "8");
  const need = elements.get("pmNeed").innerHTML;
  assert.match(need, /算不出所得稅/);

  // 指路裡用「」框起來的每個名稱，都必須是頁面上找得到的標籤
  const named = [...need.matchAll(/「<b>([^<]+)<\/b>」/g)].map((m) => m[1]);
  assert.ok(named.length > 0, "指路必須指名一個具體的控制項，不能只說「上面」");
  for (const label of named) {
    assert.ok(html.includes(">" + label + "<") || html.includes(label + " <input"),
      `指路提到「${label}」，但頁面上沒有這個標籤——指了也找不到`);
  }
  assert.ok(named.includes("稅務設定"),
    "年薪欄位目前在「稅務設定」這一組底下，指路要講得出是哪一組");

  // 稅務欄位在 5dd083e6 之後是平鋪的，不可再叫人「展開」
  assert.doesNotMatch(need, /展開/,
    "稅務欄位已平鋪展開，叫使用者去展開它會讓人在畫面上找不到那個動作");
  assert.ok(!/id="simAdvanced"/.test(html),
    "simAdvanced 已移除；若它回來了，上面那條「不可寫展開」的判斷就要重新檢討");
});

// ── 配置方式：不給選項，由輸入行為推斷 ────────────────────────
// optimizeSimAllocations() 是破壞性覆寫，所以「什麼時候該讓它跑」必須有明確判準。
// 判準不是使用者按了哪顆（模式切換器已移除），而是他有沒有自己填過。
async function simPanel() {
  const { app, elements, html } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 400));   // autoAllocate debounce 200ms
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  const click = (id) => { const l = elements.get(id).listeners.get("click"); if (l) l(); };
  const note = () => elements.get("simOptimizeNote").textContent;
  const pcts = () => app.getSimAllocations().map((a) => a.pct);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  return { app, elements, html, set, click, note, pcts, settle };
}

test("no allocation mode selector is shown at all", async () => {
  const { html } = await loadMarket(dualFeedMock());
  assert.doesNotMatch(html, /id="simModeManual"/, "不該再有模式切換器");
  assert.doesNotMatch(html, /id="simModeAuto"/);
  // 回到自動的唯一路徑必須留著，否則手填過就再也回不去
  assert.match(html, /id="simOptimize"[^>]*>重算比例</, "「重算比例」是回到自動的唯一入口");
});

test("leaving the weights blank lets the optimiser fill them in", async () => {
  const p = await simPanel();
  p.set("simTotal", "1000000");
  p.app.setSimAllocations([
    { code: "0056", pct: null, shares: null, month: null },
    { code: "0050", pct: null, shares: null, month: null },
  ]);
  p.set("simTotal", "1000000");   // 觸發重算
  await p.settle();
  const filled = p.pcts();
  assert.ok(filled.every((v) => v > 0), `比例留白時應自動填滿，實得 ${JSON.stringify([...filled])}`);
  assert.equal([...filled].reduce((a, b) => a + b, 0), 100, "自動配置要湊滿 100%");
});

// 這是上一輪整個模式切換器要解決的問題。拿掉 UI 之後不能把問題放回來。
test("hand-typed weights are never silently overwritten", async () => {
  const p = await simPanel();
  p.set("simTotal", "1000000");
  p.app.setSimAllocations([
    { code: "0056", pct: null, shares: null, month: null },
    { code: "0050", pct: null, shares: null, month: null },
  ]);
  // 模擬人親手填比例（走 input handler，才會設 pctEntered）
  const rows = p.elements.get("simRows");
  assert.ok(rows, "simRows 必須存在");
  p.app.getSimAllocations()[0].pct = 30;
  p.app.getSimAllocations()[0].pctEntered = true;
  p.app.getSimAllocations()[1].pct = 20;
  p.app.getSimAllocations()[1].pctEntered = true;
  assert.equal(p.app.hasManualInput(), true, "填過就要被認出來");
  // 加一檔標的（會呼叫 autoAllocate）
  p.click("simAdd");
  await p.settle();
  const after = p.app.getSimAllocations();
  assert.equal(after[0].pct, 30, "手填的 30% 不可被覆寫");
  assert.equal(after[1].pct, 20, "手填的 20% 不可被覆寫");
});

test("typing share counts binds the total and stands the optimiser down", async () => {
  const p = await simPanel();
  p.set("simTotal", "1500000");
  p.app.setSimAllocations([{ code: "0056", pct: null, shares: 5000, month: null, sharesEntered: true }]);
  assert.equal(p.app.hasManualInput(), true, "填了股數就是手動");
  p.set("simTotal", "1500000");
  await p.settle();
  // 優化器不可介入
  assert.equal(p.app.getSimAllocations()[0].shares, 5000, "手填的股數不可被覆寫");
});

test("legacy saved state is not eaten by the optimiser on load", async () => {
  // 舊存檔沒有 pctEntered。以 falsy 判定的話，回訪使用者手調過的比例
  // 會在載入當下被優化器靜默覆寫——這是這次改動最容易吃掉使用者資料的一段。
  const legacy = JSON.stringify({
    total: "1000000",
    rows: [{ code: "0056", pct: 70, shares: null, month: null },
           { code: "0050", pct: 30, shares: null, month: null }],
    stress: 1,
  });
  const backing = new Map([["bjkw-market-sim-v1", legacy]]);
  const store = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const { app } = await loadMarket(dualFeedMock(), { localStorage: store });
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const pcts = app.getSimAllocations().map((a) => a.pct);
  assert.deepEqual([...pcts], [70, 30],
    "舊存檔的手調比例必須保住——遷移時要以 pct != null 回填 pctEntered");
  assert.equal(app.hasManualInput(), true, "回填後要被認定為手動");
});

test("the reset button hands control back to the optimiser", async () => {
  const p = await simPanel();
  p.set("simTotal", "1000000");
  p.app.setSimAllocations([
    { code: "0056", pct: 30, shares: null, month: null, pctEntered: true },
    { code: "0050", pct: 20, shares: null, month: null, pctEntered: true },
  ]);
  assert.equal(p.app.hasManualInput(), true);
  p.app.resetToAuto();
  await p.settle();
  assert.equal(p.app.hasManualInput(), false, "旗標要被清掉");
  const pcts = p.pcts();
  assert.equal([...pcts].reduce((a, b) => a + b, 0), 100, "交還自動後要重新湊滿 100%");
});

// 這是實質揭露不是計算過程，自動路徑隱藏「已計算 N 組」時必須保留它。
// 用行為驗，不要用原始碼 grep——原始碼裡的註解本身就寫著「已計算 N 組」，
// 會把自己匹配到而假性失敗（第一版就是這樣寫的）。
test("the automatic path hides the progress text but keeps the quality warning", async () => {
  const p = await simPanel();
  p.set("simTotal", "1000000");
  p.app.setSimAllocations([
    { code: "0056", pct: null, shares: null, month: null },
    { code: "0050", pct: null, shares: null, month: null },
  ]);
  p.set("simTotal", "1000000");
  await p.settle();
  assert.doesNotMatch(p.note(), /已計算/, "自動路徑不可印出計算過程");

  // 同一組配置手動觸發時，計算過程要回來——證明只是自動路徑不印，不是功能被拿掉
  p.click("simOptimize");
  await p.settle();
  const { html } = await loadMarket(dualFeedMock());
  assert.match(html, /function qualityWarning\(\)/,
    "品質警語要由單一函式決定，手動與自動共用，不能各寫一份而分叉");
});

// 第 11 檔起 simWeightBounds 把權重下限從 10% 降到 5%，
// 窮舉空間由 1,251 組跳到 92,257 組，每組還要跑一次完整 simulate()。
test("auto allocation steps aside when the search space explodes", async () => {
  const p = await simPanel();
  p.set("simTotal", "1000000");
  assert.equal(p.app.AUTO_ALLOCATE_MAX_FUNDS, 10,
    "門檻改動會直接影響瀏覽器會不會卡住，必須是刻意的");
  const codes = ["0056", "0050", "006208", "00632R", "00679B", "00999",
                 "0056", "0050", "006208", "0056", "0050"];
  p.app.setSimAllocations(codes.map((code) => ({ code, pct: null, shares: null, month: null })));
  p.set("simTotal", "1000000");
  await p.settle();
  assert.match(p.note(), /超過自動計算上限/, "不硬跑，要講清楚為什麼");
  assert.match(p.note(), /重算比例/, "並指出可以手動觸發哪一顆");
});

// ── 使用者回報的兩個 bug ────────────────────────────────────────
// 「比例我有留白了還是沒有自動算，而且還會有負的數據出現」

// bug 1：pct: 0 的存檔會讓自動配置永久停手。
// 遷移寫成 `a.pct != null` 時，0 != null 是 true → 被判成「使用者填過 0%」
// → hasManualInput() 為真 → 優化器停手 → 畫面永遠卡在一年 0 元。
test("a saved state full of zero weights still gets auto-allocated", async () => {
  const zeroState = JSON.stringify({
    total: "1500000",
    rows: [{ code: "0056", pct: 0, shares: 0, month: null },
           { code: "0050", pct: 0, shares: 0, month: null }],
    stress: 1,
  });
  const backing = new Map([["bjkw-market-sim-v1", zeroState]]);
  const store = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const { app } = await loadMarket(dualFeedMock(), { localStorage: store });
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(app.hasManualInput(), false,
    "0% 不是刻意的配置，不可被當成「使用者填過」");
  const pcts = app.getSimAllocations().map((a) => a.pct);
  assert.equal([...pcts].reduce((a, b) => a + b, 0), 100,
    `全 0 的存檔要被自動配置救回來，實得 ${JSON.stringify([...pcts])}`);
});

// 已經寫進 localStorage 的 pctEntered:true 也要救得到——
// 所以條件放在 hasManualInput() 而不是只修遷移。
test("a persisted entered-flag on a zero weight does not wedge the optimiser", async () => {
  const { app } = await loadMarket(dualFeedMock());
  await app.init();
  app.setSimAllocations([
    { code: "0056", pct: 0, shares: 0, month: null, pctEntered: true },
    { code: "0050", pct: 0, shares: 0, month: null, pctEntered: true },
  ]);
  assert.equal(app.hasManualInput(), false,
    "旗標為真但值是 0 時仍不算手動，否則舊資料會永久卡住");
});

// bug 2：比例欄有 step="5" 卻沒有 min，從 0 按一下向下鍵就是 −5。
// 實測輸入 −20 會算出股數 −9,069、市值 −300,003、年配息 −34,580。
test("a negative weight can neither be entered nor propagate", async () => {
  const { html, app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(html, /data-sim-pct="' \+ index \+ '" placeholder="[^"]*" min="0"/,
    "比例欄要有 min=0，否則上下鍵會轉出負數");
  app.setSimAllocations([{ code: "0056", pct: 30, shares: 100, month: null, pctEntered: true }]);
  // 直接走 handler 邏輯：負值必須被當成「沒填」，而不是存成 -20
  const rows = elements.get("simRows");
  assert.ok(rows);
  const src = html.slice(html.indexOf("if (pctIdx != null)"), html.indexOf("if (sharesIdx != null)"));
  assert.match(src, /raw <= 0\) \? null : raw/, "≤0 一律當成沒填");
  assert.match(src, /if \(clean == null\) simAllocations\[pctIdx\]\.shares = null;/,
    "清掉比例時股數也要清，否則 syncSharesFromPct 提早 return 會留下舊的負股數");
  assert.match(src, /autoAllocate\(\);/, "清空後要把控制權交還自動，否則欄位就空在那裡");
});

// ── 一個版面 ＋ 按鈕命名釐清 ────────────────────────────────────
test("every top control lives in one flat panel, nothing folded away", async () => {
  const { html } = await loadMarket(dualFeedMock());
  assert.doesNotMatch(html, /id="simAdvanced"/, "稅務折疊已合併進同一個版面");
  const heroAt = html.indexOf('id="simHero"');
  // 主視覺之前不可再有任何 details——那代表控制項又被收起來了
  const before = html.slice(0, heroAt);
  assert.equal((before.match(/<details/g) || []).length, 0,
    "主視覺上方的控制項一律平鋪，不再有折疊");
  for (const id of ["simTotal", "simAdd", "s100", "s80", "s60", "simOptimize",
                    "simSalary", "simFiling", "simDependents", "simNetIncome"]) {
    assert.ok(before.includes('id="' + id + '"'), `${id} 必須在同一個版面內、且在主視覺之前`);
  }
});

// 兩個都叫「自動配置」時，使用者分不出哪個會換掉他的標的。
test("the two allocation actions are named apart and say what they change", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const topBtn = (html.match(/id="simOptimize"[^>]*>([^<]+)</) || [])[1];
  const lowerTitle = (html.match(/id="suggestHeading">([^<]+)</) || [])[1];
  assert.equal(topBtn, "重算比例");
  assert.equal(lowerTitle, "幫我挑標的");
  assert.notEqual(topBtn, lowerTitle, "兩個動作不可同名——一個換標的、一個不換");
  // 上方要講明「不換標的」
  const topRow = html.slice(html.indexOf('id="simOptimize"'), html.indexOf('id="simOptimizeNote"'));
  assert.match(topRow, /不會換掉你的標的/, "上方要講明它只動比例");
  // 下方要講明「會換標的」——原本寫「窮舉出配息最高的權重組合」，沒提會換掉清單
  const lowerRow = html.slice(html.indexOf('id="suggestHeading"'), html.indexOf('id="suggestHeading"') + 200);
  assert.match(lowerRow, /換掉你上面的清單/, "下方要講明套用後會換掉標的");
});

// 它加總所有有股數的列（含優化器算出來的），在自動配置後按下去會把總額
// 削掉零股殘值：1,500,000 → 1,499,744。手填股數已由 scheduleHoldingsBind 處理。
test("the redundant hold-value button is gone, markup and handler alike", async () => {
  const { html } = await loadMarket(dualFeedMock());
  assert.doesNotMatch(html, /simUseHoldings/,
    "按鈕與它的 handler 都要移除，留著 handler 會是死碼");
  assert.match(html, /scheduleHoldingsBind/, "手填股數自動綁定總額的路徑要留著");
});

test("the total keeps its value through repeated auto-allocation", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const set = (id, value) => {
    const node = elements.get(id);
    node.value = value;
    if (node.listeners.get("input")) node.listeners.get("input")();
  };
  app.setSimAllocations([
    { code: "0056", pct: null, shares: null, month: null },
    { code: "0050", pct: null, shares: null, month: null },
  ]);
  set("simTotal", "1500000");
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let i = 0; i < 3; i += 1) {
    app.resetToAuto();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.equal(elements.get("simTotal").value, "1500000",
    "反覆自動配置不可把總額削成 1,499,744 這種「原值減零股殘值」");
});

// ── 「幫我挑標的」：一條主路徑，衝突要講出來 ──────────────────
// 這一區原本有兩條做同一件事的入口（問卷、5 顆目標按鈕），實測會互相破壞。

// 實測：勾下方 gActive 後，上方 pfActive 仍顯示未勾，但設定其實已生效——
// 只有「按下依我的情況計算」時 pf→g 單向同步，反向從來沒有。
test("one setting has exactly one control", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const boxes = [...html.matchAll(/<input type="checkbox" id="(\w+)"/g)].map((m) => m[1]);
  const active = boxes.filter((id) => /Active$/.test(id));
  assert.deepEqual(active, ["gActive"],
    `「納入主動型」只能有一個勾選框，實得 ${active.join("／")}——` +
    "兩個同義控制項只單向同步，畫面會顯示與實際相反的狀態");
  assert.ok(!html.includes('$("pfActive")'), "讀取端也要一起收斂，否則兩邊各讀各的");
});

// 問卷自己就寫著「下面的目標與約束會自動設定」，它是主路徑；
// 目標按鈕是第二條入口且會蓋掉問卷，降為進階。
test("the questionnaire is the visible path and the goal buttons are one level down", async () => {
  const { html } = await loadMarket(dualFeedMock());
  const suggestAt = html.indexOf('id="suggestHeading"');
  const resultAt = html.indexOf('id="suggestResult"');
  const region = html.slice(suggestAt, resultAt);

  assert.ok(region.indexOf('id="pfRun"') > -1, "問卷的按鈕要留在明面上");
  assert.match(region, /▸ 自己選目標/, "目標按鈕要收在一層折疊底下");

  // 目標按鈕必須落在那個折疊之後——落在前面等於根本沒收起來
  const foldAt = region.indexOf("▸ 自己選目標");
  for (const id of ["gNetTotal", "gYield", "gMonthly", "gLowOverlap", "gAfterTax"]) {
    const at = region.indexOf('id="' + id + '"');
    assert.ok(at > -1, `${id} 不可消失`);
    assert.ok(at > foldAt, `${id} 仍在折疊之外，等於沒有降級`);
  }
  // 既有規則不可回歸：控制項仍要排在自己的輸出之前
  assert.ok(html.indexOf('id="gNetTotal"') < resultAt, "gNetTotal 仍須排在 suggestResult 之前");

  // 五顆按鈕都寫「（計算）」＝沒有資訊量。只看按鈕文字，不掃整段 HTML——
  // 那會連解釋這件事的註解一起命中。
  for (const id of ["gNetTotal", "gYield", "gMonthly", "gLowOverlap", "gAfterTax"]) {
    const label = (region.match(new RegExp('id="' + id + '"[^>]*>([^<]+)<')) || [])[1];
    assert.ok(label, `${id} 應該有文字`);
    assert.doesNotMatch(label, /（計算）/, `「${label}」——每顆都會計算，這三個字不區分任何東西`);
  }
});

// 最關鍵的一條：按目標按鈕會讓問卷的約束全部失效，但問卷六個欄位仍顯示舊值。
// 舊版把 pfNote 清成空白——畫面於是寫著「最多能忍受跌 10%」而它根本沒在套用。
test("discarding the questionnaire's constraints is stated, not silent", async () => {
  const { app, elements, document } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // fake DOM 只在頁面程式呼叫過 getElementById 時才建節點；pfLoss 要到
  // pfRun 的 handler 裡才會被讀到，所以這裡得自己把它取出來（取用即建立）
  document.getElementById("pfLoss").value = "10";
  elements.get("pfRun").fire("click");
  const applied = elements.get("pfNote").innerHTML;
  assert.match(applied, /已套用/, "先確認問卷真的套用了，否則後面測的是空狀態");
  assert.match(applied, /回撤/, "套用時要講出它加了什麼條件");

  elements.get("gMonthly").fire("click");
  const after = elements.get("pfNote").innerHTML;
  assert.notEqual(after.trim(), "",
    "清成空白＝靜默作廢；問卷欄位還顯示著那些條件，使用者不會知道它們已失效");
  assert.match(after, /不再套用/, "要明講上面的條件已經不算數");
  assert.match(after, /補滿 12 個月/, "要講出現在改用的是哪個目標");
  assert.match(after, /依我的情況計算/, "要講得出怎麼把自己的條件要回來");
});

test("the discard notice does not appear for someone who never used the questionnaire", async () => {
  const { app, elements } = await loadMarket(dualFeedMock());
  await app.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  elements.get("gYield").fire("click");
  assert.equal(elements.get("pfNote").innerHTML.trim(), "",
    "沒填過問卷卻說「你的條件不再套用」，是憑空捏造一個使用者沒做過的動作");
});
