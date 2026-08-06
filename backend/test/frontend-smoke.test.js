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
    this.checked = false;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = parseSyntheticChildren(this._innerHTML);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  appendChild(child) {
    this.children.push(child);
    if (child.innerHTML && child.className) {
      this._innerHTML += `<div class="${child.className}">${child.innerHTML}</div>`;
    } else if (child.innerHTML) {
      this._innerHTML += child.innerHTML;
    } else if (child.className) {
      this._innerHTML += `<div class="${child.className}"></div>`;
    } else {
      this._innerHTML += child.textContent || "";
    }
    return child;
  }

  querySelectorAll(selector) {
    const requiredClasses = selector.startsWith(".") ? selector.slice(1).split(".").filter(Boolean) : [];
    const results = [];
    const visit = (node) => {
      const classes = String(node.className || "").split(/\s+/).filter(Boolean);
      if (requiredClasses.length && requiredClasses.every((name) => classes.includes(name))) {
        results.push(node);
      }
      for (const child of node.children || []) visit(child);
    };
    for (const child of this.children) visit(child);
    return results;
  }
}

function parseSyntheticChildren(html) {
  const children = [];
  const elementPattern = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = elementPattern.exec(html))) {
    const child = new FakeElement();
    const attrs = match[2];
    child._innerHTML = match[3];
    child.textContent = match[3].replace(/<[^>]+>/g, "");
    const classMatch = attrs.match(/\bclass="([^"]*)"/i);
    if (classMatch) child.className = classMatch[1];
    const dataMatches = attrs.matchAll(/\bdata-([a-z0-9_-]+)="([^"]*)"/gi);
    for (const dataMatch of dataMatches) {
      child.dataset[dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = dataMatch[2];
    }
    const ariaMatch = attrs.match(/\baria-label="([^"]*)"/i);
    if (ariaMatch) child.ariaLabel = ariaMatch[1];
    children.push(child);
  }
  return children;
}

function createDocument() {
  const elements = new Map();
  const document = {
    readyState: "complete",
    addEventListener() {},
    createElement() {
      return new FakeElement();
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
  };
  return { document, elements };
}

function seedDocumentIds(document, html) {
  const idPattern = /<([a-z0-9-]+)\b([^>]*)\bid="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = idPattern.exec(html))) {
    const attrs = `${match[2]} ${match[4]}`;
    const element = document.getElementById(match[3]);
    element.innerHTML = match[5];
    element.textContent = match[5].replace(/<[^>]+>/g, "").trim();
    const classMatch = attrs.match(/\bclass="([^"]*)"/i);
    if (classMatch) element.className = classMatch[1];
  }
}

function response(data, headers = {}, init = {}) {
  const status = init.status || 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    headers: new Headers(headers),
    json: async () => data,
  };
}

function createLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

async function loadApp(fetchMock, windowOverrides = {}) {
  const htmlFile = windowOverrides.htmlFile || "../../stocks/index.html";
  const htmlPath = fileURLToPath(new URL(htmlFile, import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "inline script should be present");

  const { document, elements } = createDocument();
  const localStorage = windowOverrides.localStorage || createLocalStorage();
  const window = {
    __PORTFOLIO_CONSOLE_SKIP_AUTO_INIT__: true,
    location: { href: "https://local.test/", hostname: "local.test", search: "" },
    localStorage,
    ...windowOverrides,
  };
  if (!window.location.hostname) window.location.hostname = "local.test";
  if (!window.location.search) window.location.search = "";

  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    document,
    fetch: fetchMock,
    Headers,
    Intl,
    localStorage: window.localStorage,
    setTimeout,
    URL,
    URLSearchParams,
    window,
  });

  vm.runInContext(script, context, { filename: "index.html" });
  return { context, document, elements, html };
}

async function loadHome(fetchMock) {
  const htmlPath = fileURLToPath(new URL("../../index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "root inline script should be present");

  const { document, elements } = createDocument();
  seedDocumentIds(document, html);
  const context = vm.createContext({
    console,
    document,
    fetch: fetchMock,
    Headers,
    Intl,
    URL,
  });

  vm.runInContext(script, context, { filename: "root-index.html" });
  return { context, document, elements, html };
}

function staticFeed(overrides = {}) {
  return {
    updatedAt: "2026-06-05T09:00:00.000Z",
    eodUpdatedAt: "2026-06-05T08:00:00.000Z",
    eod: [
      { code: "2330", name: "台積電", close: "2,400.25", change: "+5.25" },
      { code: "2308", name: "台達電", close: 2250, change: -10 },
    ],
    yield10y: {
      date: "2026-06-05",
      value: 4.44,
      updatedAt: "2026-06-05T22:00:00.000Z",
      source: "US Treasury Daily Treasury Yield Curve",
    },
    ...overrides,
  };
}

function completeMisClosingQuotes() {
  return [
    { code: "2330", name: "TSMC", price: 2295, change: -70, previousClose: 2365, high: 2370, low: 2230, open: 2350, time: "2026-06-08T13:30:00+08:00" },
    { code: "2317", name: "Foxconn", price: 269.5, change: -15, previousClose: 284.5, high: 285, low: 264, open: 280, time: "2026-06-08T13:30:00+08:00" },
    { code: "6669", name: "Wiwynn", price: 5275, change: -385, previousClose: 5660, high: 5660, low: 5150, open: 5600, time: "2026-06-08T13:30:00+08:00" },
    { code: "3017", name: "Asia Vital", price: 2570, change: -30, previousClose: 2600, high: 2650, low: 2450, open: 2600, time: "2026-06-08T13:30:00+08:00" },
    { code: "3324", name: "Auras", price: 1095, change: -15, previousClose: 1110, high: 1130, low: 1050, open: 1105, time: "2026-06-08T13:30:00+08:00" },
    { code: "2382", name: "Quanta", price: 376.5, change: -14, previousClose: 390.5, high: 395, low: 360, open: 390, time: "2026-06-08T13:30:00+08:00" },
    { code: "1519", name: "Fortune", price: 815, change: -36, previousClose: 851, high: 860, low: 780, open: 850, time: "2026-06-08T13:30:00+08:00" },
    { code: "2308", name: "Delta", price: 2255, change: -45, previousClose: 2300, high: 2305, low: 2090, open: 2260, time: "2026-06-08T13:30:00+08:00" },
    { code: "3231", name: "Wistron", price: 156, change: -4, previousClose: 160, high: 162, low: 150, open: 160, time: "2026-06-08T13:30:00+08:00" },
    { code: "3661", name: "Alchip", price: 4105, change: -95, previousClose: 4200, high: 4250, low: 4000, open: 4200, time: "2026-06-08T13:30:00+08:00" },
    { code: "2356", name: "Inventec", price: 64.3, change: 1, previousClose: 63.3, high: 67, low: 63.8, open: 64, time: "2026-06-08T13:30:00+08:00" },
    { code: "2376", name: "Gigabyte", price: 325, change: 5.5, previousClose: 319.5, high: 330, low: 320, open: 320, time: "2026-06-08T13:30:00+08:00" },
    { code: "6239", name: "PTI", price: 288, change: -28.5, previousClose: 316.5, high: 325, low: 286.5, open: 320.5, time: "2026-06-08T13:30:00+08:00" },
  ];
}

const EOD_CACHE_KEY = "bjkw-portfolio-console-v2:eod:2330,2317,2382,3231,6669,3017,3324,3661,2356,2376,6239,1519,2308";
const STATE_KEY = "bjkw-portfolio-console-v2";

test("root index is a status overview entry console", async () => {
  const htmlPath = fileURLToPath(new URL("../../index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const primaryLinks = [...html.matchAll(/<a\b[^>]*data-primary-entry="([^"]+)"[^>]*href="([^"]+)"/g)]
    .map((match) => [match[1], match[2]]);

  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /<meta charset="UTF-8"/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0"/);
  assert.match(html, /<title>BJKW 觀察控制台<\/title>/);
  assert.match(html, /<meta name="description" content="BJKW 公開觀察控制台/);
  assert.match(html, /<link rel="canonical" href="\/"/);
  assert.match(html, /property="og:title" content="BJKW 觀察控制台"/);
  assert.match(html, /name="theme-color" content="#101418"/);
  assert.match(html, /<main class="shell">/);
  assert.match(html, /href="\/stocks\/"/);
  assert.match(html, /href="\/weather\/"/);
  assert.match(html, /href="\/esp32\/"/);
  assert.match(html, /href="\/forscan\/"/);
  assert.deepEqual(primaryLinks, [["stocks", "/stocks/"], ["weather", "/weather/"], ["esp32", "/esp32/"], ["forscan", "/forscan/"]]);
  assert.match(html, /股票投資觀察台/);
  assert.doesNotMatch(html, /href="\/ai\/"|data-primary-entry="ai"|AI Feed/);
  assert.match(html, /BJKW 天氣觀察台/);
  for (const id of ["stockFeedStatus", "stockFeedMeta", "yieldStatus", "yieldMeta", "weatherStatus", "weatherMeta"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be present`);
  }
  // 「Static Site：可進入」是永不改變的常數——上游全掛時它照樣說可進入，
  // 讀得到這頁本身就已經證明靜態站活著。零資訊量，已移除，不要再加回來。
  assert.doesNotMatch(html, /id="deployStatus"|id="deployMeta"/, "the tautological Static Site card must stay gone");
  // 遷移期留下的空洞數字（4 保留工具 / 0 舊站入口 / 1 click）也不要回來
  assert.doesNotMatch(html, /保留工具|舊站入口|1 click/, "migration-era vanity metrics must stay gone");
  // 憑證設定狀態是內部資訊，不對訪客揭露
  assert.doesNotMatch(html, /CWA secret/, "credential state must not be published");
  assert.match(html, /aria-label="輕量資料狀態"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /focus-visible/);
  assert.doesNotMatch(html, /year-archive|categories|tags|works|Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|Resume/);
});

test("root status overview renders mocked feed and weather health", async () => {
  const calls = [];
  const { document } = await loadHome(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href === "/data/stock-risk-feed.json") return response(staticFeed({
      yield10y: {
        date: "2026-06-05",
        value: 4.56,
        source: "Mock Treasury",
      },
    }));
    if (href === "https://bjkw-weather-proxy.a0926043323.workers.dev/health") {
      return response({ ok: true, configured: true });
    }
    throw new Error(`unexpected root fetch: ${href}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(document.getElementById("stockFeedStatus").textContent, "2 檔");
  assert.match(document.getElementById("stockFeedStatus").className, /ok/);
  assert.equal(document.getElementById("yieldStatus").textContent, "4.56%");
  assert.match(document.getElementById("yieldMeta").textContent, /Mock Treasury/);
  assert.equal(document.getElementById("weatherStatus").textContent, "可查詢");
  assert.match(document.getElementById("weatherStatus").className, /ok/);
  assert.equal(document.getElementById("weatherMeta").textContent, "天氣代理服務正常", "面向訪客的說法，不提憑證");
  assert.deepEqual(calls, [
    "/data/stock-risk-feed.json",
    "https://bjkw-weather-proxy.a0926043323.workers.dev/health",
  ]);
});

test("root status overview fails soft while keeping entries usable", async () => {
  const { document, html } = await loadHome(async (url) => {
    throw new Error(`unavailable: ${url}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(document.getElementById("stockFeedStatus").textContent, "待更新");
  assert.equal(document.getElementById("yieldStatus").textContent, "待更新");
  assert.equal(document.getElementById("weatherStatus").textContent, "待更新");
  assert.match(html, /data-primary-entry="stocks" href="\/stocks\/"/);
  assert.match(html, /data-primary-entry="weather" href="\/weather\/"/);
});

test("weather page uses the Worker proxy without exposing CWA credentials", async () => {
  const htmlPath = fileURLToPath(new URL("../../weather/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /WEATHER_PROXY_BASE/);
  assert.match(html, /bjkw-weather-proxy\.a0926043323\.workers\.dev/);
  assert.match(html, /\/api\//);
  assert.match(html, /\/file\//);
  assert.doesNotMatch(html, /CWA-|Authorization:\s*API_KEY|opendata\.cwa\.gov\.tw\/api|opendata\.cwa\.gov\.tw\/fileapi/);
});

test("legacy weather page redirects to the retained weather route", async () => {
  const htmlPath = fileURLToPath(new URL("../../bjkw_weather.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /url=\/weather\//);
  assert.match(html, /window\.location\.replace\(target\)/);
  assert.doesNotMatch(html, /CWA-|中央氣象署 API/);
});

test("legacy weather redirect preserves query string and hash", async () => {
  const htmlPath = fileURLToPath(new URL("../../bjkw_weather.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const redirects = [];

  assert.ok(script, "legacy redirect script should be present");
  vm.runInContext(script, vm.createContext({
    window: {
      location: {
        search: "?from=home",
        hash: "#coast",
        replace(target) {
          redirects.push(target);
        },
      },
    },
  }));

  assert.deepEqual(redirects, ["/weather/?from=home#coast"]);
});

test("index.html keeps required static DOM ids and global helper contract", async () => {
  const { context, html } = await loadApp(async () => response(staticFeed()));
  const requiredIds = [
    "refresh", "stamp", "scoreTable", "scoreBody", "stockCards", "dataSource",
    "watchAdd", "watchTier", "watchAddBtn", "watchReset", "watchShare",
    "watchCount", "watchShared", "watchNote",
    "headerMarketQuotes", "headerQuoteTaiex", "headerQuoteTaiexValue", "headerQuoteTaiexChange",
    "headerQuoteTaiexStatus", "headerQuoteTpex", "headerQuoteTpexValue", "headerQuoteTpexChange",
    "headerQuoteTpexStatus", "headerQuoteStatus",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} should exist in static HTML`);
  }
  // 頁面已收斂成「頁首指數卡 + 觀察清單」：決策卡、自動檢核表、配置分層區
  // 全部移除。留著任何一個 id 就代表死碼又長回來了。
  for (const gone of [
    "verdictLight", "verdictTitle", "verdictDesc", "actionNext", "actionAvoid",
    "signalSummary", "conds", "buckets", "watchChips",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${gone}["']`), `${gone} should be gone`);
  }
  // 欄位與 /market/ 對齊，且每個數值欄都可點表頭排序
  for (const key of ["code", "name", "tier", "close", "dayPct", "pe", "pbRatio",
    "dividendYield", "fromHi", "turnover", "pctFromObservation"]) {
    assert.match(html, new RegExp(`data-sort="${key}"`), `${key} column should be sortable`);
  }
  assert.match(html, /rel="icon" href="\/assets\/images\/favicon\.ico"/);
  assert.match(html, /rel="icon" href="\/assets\/images\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/images\/apple-touch-icon\.png"/);
  assert.match(html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/);
  assert.match(html, /name="theme-color" content="#101418"/);
  assert.match(html, /\.header-shell\{display:flex/);
  assert.match(html, /\.header-markets\{width:min\(360px,100%\)/);
  assert.match(html, /\.market-card\{/);
  assert.match(html, /aria-label="市場指數"/);
  assert.match(html, /@media \(max-width:760px\)[\s\S]*\.header-shell\{flex-direction:column/);
  // 分層與移除鈕不是 .btn，窄螢幕的 44px 觸控目標要另外補
  assert.match(html, /@media \(max-width:760px\)[\s\S]*\.tier-pick,\.row-del\{min-height:44px\}/);
  assert.match(html, /距離觀察基準/);
  // 分層直接改在資料列上，提示要說清楚它會改變觀察價
  assert.match(html, /分層會改變觀察價的算法/);
  assert.doesNotMatch(html, /vs 個人參考基準|個人參考基準/);

  assert.equal(typeof context.window.PortfolioConsoleApp.init, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.refresh, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.getState, "function");
  for (const name of [
    "normalizeClosingQuoteRows",
    "normalizeEodPayload",
    "normalizeMarketIndexPayload",
    "parseNumber",
    "proxyBase",
    "sanitizeState",
    "sanitizeWatchlist",
    "parseWatchParam",
    "watchlistToParam",
    "tradingViewUrl",
    "suggestObservationPrice",
    "roundObservationPrice",
    "marketDefenseMode",
  ]) {
    assert.equal(typeof context.window.PortfolioConsoleApp.helpers[name], "function");
  }
  const tvUrl = new URL(context.window.PortfolioConsoleApp.helpers.tradingViewUrl("2330"));
  assert.equal(tvUrl.protocol, "https:");
  assert.equal(tvUrl.hostname, "tw.tradingview.com");
  assert.equal(tvUrl.pathname, "/chart/");
  assert.equal(tvUrl.searchParams.get("symbol"), "TWSE:2330");
  assert.match(context.window.PortfolioConsoleApp.helpers.tradingViewUrl("2330"), /symbol=TWSE%3A2330/);
  assert.equal(context.window.PortfolioConsoleApp.helpers.tradingViewUrl("2330/../../evil"), "", "unknown codes stay unlinked");
});


// 大盤指數已不顯示，但仍必須抓：它唯一的用途是把弱勢盤的觀察價再壓一段。
// 這條擋住「反正畫面上看不到，順手把 loadMarketIndices 也刪掉」。
test("market indices still drive defense mode even though no card shows them", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { marketDefenseMode } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(marketDefenseMode({
    marketIndexRows: [
      { id: "taiex", label: "加權", price: 42000, pctChange: -2.8 },
      { id: "tpex", label: "櫃買", price: 390, pctChange: -3.2 },
    ],
  }), true);
  assert.equal(marketDefenseMode({
    marketIndexRows: [
      { id: "taiex", label: "加權", price: 42000, pctChange: 0.4 },
      { id: "tpex", label: "櫃買", price: 390, pctChange: 0.2 },
    ],
  }), false);
  assert.equal(marketDefenseMode({ marketIndexRows: [] }), false);
});

test("system observation price helper stays conservative by tier and market risk", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { suggestObservationPrice, roundObservationPrice } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(roundObservationPrice(2296.9), 2295);
  assert.equal(roundObservationPrice(284.9), 284.5);

  const core = suggestObservationPrice(
    { code: "2330", tier: "core", base: 2385 },
    { close: 2365, low: 2230, change: -70 },
    {}
  );
  assert.equal(core.mode, "auto");
  assert.equal(core.label, "系統觀察價");
  assert.equal(core.price, 2295);
  assert.match(core.distanceText, /收盤高出 3\.1%/);

  const satellite = suggestObservationPrice(
    { code: "3017", tier: "sat", base: 2640 },
    { close: 2570, low: 2340, change: -130, previousClose: 2700 },
    {}
  );
  assert.equal(satellite.mode, "auto");
  assert.equal(satellite.price, 2395);
  assert.ok(satellite.price < core.price + 120, "satellite price should stay near the lower range");
  assert.ok(satellite.price < 2570);

  const wait = suggestObservationPrice(
    { code: "2308", tier: "wait", base: 2300 },
    { close: 2255, low: 2090, change: -45 },
    {}
  );
  assert.equal(wait.mode, "auto");
  assert.equal(wait.price, 2110);
  assert.ok(wait.price < 2255);

  const missing = suggestObservationPrice(
    { code: "2330", tier: "core", base: 2385 },
    { change: -20 },
    {}
  );
  assert.equal(missing.mode, "missing");
  assert.equal(missing.label, "觀察價待更新");

  const fallback = suggestObservationPrice(
    { code: "2330", tier: "core", base: 2385 },
    { close: 2365, change: -20 },
    {}
  );
  assert.equal(fallback.mode, "fallback");
  assert.equal(fallback.label, "預設參考值");
  assert.equal(fallback.source, "預設值");

  const defense = suggestObservationPrice(
    { code: "2330", tier: "core", base: 2385 },
    { close: 2365, low: 2230, change: -70 },
    { defense: true }
  );
  assert.equal(defense.defense, true);
  assert.equal(defense.price, 2270);
  assert.match(defense.note, /等待跌勢收斂後再看/);
  assert.ok(defense.price < core.price);
});

test("frontend normalizers round EOD, index, and closing-quote rows", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { normalizeClosingQuoteRows, normalizeEodPayload, normalizeMarketIndexPayload } = context.window.PortfolioConsoleApp.helpers;
  const plain = (value) => JSON.parse(JSON.stringify(value));

  assert.deepEqual(plain(normalizeEodPayload([
    { Code: "2330", Name: "TSMC", ClosingPrice: "1,010.123", Change: "+5.257", HighestPrice: "1,020.25", LowestPrice: "998.75", OpeningPrice: "1,005.50" },
    { Code: "bad", Name: "Bad", ClosingPrice: "1" },
    { Code: "2308", Name: "Delta", ClosingPrice: "--" },
  ])), [
    { code: "2330", name: "TSMC", close: 1010.12, change: 5.26, high: 1020.25, low: 998.75, open: 1005.5 },
  ]);

  assert.deepEqual(plain(normalizeMarketIndexPayload({
    indices: [
      { id: "tpex", name: "櫃買指數", price: "397.81", change: "+33.26", pctChange: "+9.12", time: "2026-06-08T09:33:00+08:00" },
      { id: "taiex", name: "發行量加權股價指數", price: "42,686.84", change: "2387.10", pctChange: "5.92", time: "2026-06-08T09:33:00+08:00" },
      { id: "evil", price: "999" },
    ],
  })), [
    { id: "taiex", label: "加權", price: 42686.84, change: 2387.1, pctChange: 5.92, time: "2026-06-08T09:33:00+08:00" },
    { id: "tpex", label: "櫃買", price: 397.81, change: 33.26, pctChange: 9.12, time: "2026-06-08T09:33:00+08:00" },
  ]);
  assert.deepEqual(plain(normalizeClosingQuoteRows({
    quotes: [
      { code: "2330", name: "TSMC", price: "2,295.00", previousClose: "2,365.00", high: "2,370.00", low: "2,230.00", open: "2,350.00", time: "2026-06-08T13:30:00+08:00" },
      { code: "3324", name: "Auras", price: "1,095.00", change: "-15.00", high: "1,130.00", low: "1,050.00", open: "1,105.00", time: "2026-06-08T13:30:00+08:00" },
      { code: "2317", name: "Foxconn", price: "269.50", change: "-15.00", time: "2026-06-08T10:15:00+08:00" },
      { code: "9999", name: "Ignored", price: "1", change: "0", time: "2026-06-08T13:30:00+08:00" },
    ],
  })), [
    { code: "2330", name: "TSMC", close: 2295, change: -70, time: "2026-06-08T13:30:00+08:00", previousClose: 2365, high: 2370, low: 2230, open: 2350 },
    { code: "3324", name: "Auras", close: 1095, change: -15, time: "2026-06-08T13:30:00+08:00", high: 1130, low: 1050, open: 1105 },
  ]);
});

test("proxy allowlist ignores unapproved query-string proxy", async () => {
  const { context } = await loadApp(async () => response(staticFeed()), {
    location: {
      href: "https://blackjw1212.github.io/?proxy=https%3A%2F%2Fevil.example",
      hostname: "blackjw1212.github.io",
      search: "?proxy=https%3A%2F%2Fevil.example",
    },
  });

  const { proxyBase } = context.window.PortfolioConsoleApp.helpers;
  assert.equal(proxyBase(), "https://taiwan-risk-tracker-proxy.a0926043323.workers.dev");
});

test("page renders the watchlist table, cards, and source labels from static fallback", async () => {
  const calls = [];
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });

  await context.window.PortfolioConsoleApp.init();

  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /2330/);
  assert.match(scoreHtml, /2,400.25/);
  assert.match(scoreHtml, /預設參考值/);
  assert.match(scoreHtml, /預設值/);
  assert.doesNotMatch(scoreHtml, /系統觀察價 \d|· 系統觀察價|個人參考基準/);
  assert.doesNotMatch(scoreHtml, /class="(?:pos|neg)">預設參考值/);
  assert.match(scoreHtml, /今日低點不足，未產生系統觀察價/);
  assert.match(scoreHtml, /市場指數待更新，未判讀防守模式/);
  assert.match(cardHtml, /台積電/);
  assert.match(cardHtml, /距離觀察基準/);
  assert.match(cardHtml, /預設參考值/);
  assert.match(cardHtml, /預設值/);
  assert.doesNotMatch(cardHtml, /class="(?:pos|neg)">預設參考值/);
  assert.match(cardHtml, /今日低點不足，未產生系統觀察價/);
  assert.match(cardHtml, /市場指數待更新，未判讀防守模式/);
  assert.match(scoreHtml, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.match(cardHtml, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.doesNotMatch(scoreHtml, /\/technicals\//);
  assert.match(scoreHtml, /target="_blank"/);
  assert.match(cardHtml, /rel="noopener noreferrer"/);
  assert.match(scoreHtml, /aria-label="在 TradingView 開啟 2330 台積電完整圖表觀察（外部連結）"/);
  // 分層與移除鈕在每一列上，不再是清單外的一排標籤
  assert.match(scoreHtml, /<select class="tier-pick core" data-watch-tier="2330"/);
  assert.match(scoreHtml, /data-watch-del="2330"/);
  assert.match(cardHtml, /data-watch-tier="2330"/);
  assert.match(cardHtml, /data-watch-del="2330"/);
  assert.match(document.getElementById("stamp").textContent, /靜態 stock-risk-feed\.json/);
  assert.match(document.getElementById("watchCount").textContent, /13 檔/);
  assert.ok(calls.includes("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"));
  assert.ok(calls.some((href) => href.startsWith("/data/stock-risk-feed.json")));
});

test("the watchlist is user-definable and defaults to the built-in list", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const h = context.window.PortfolioConsoleApp.helpers;

  // 預設等於內建清單
  const builtIn = h.builtInCodes();
  assert.equal(builtIn.length, 13);
  assert.deepEqual(h.stockCodes(), builtIn, "未自訂時清單＝內建");

  // 自訂清單：可增、可刪、可改分層
  h.setMarketRowsForTest({ "2454": { code: "2454", name: "聯發科", close: 3865, pe: 64.57 } });
  const stocks = h.setWatchlistForTest([
    { code: "2330", tier: "core" },
    { code: "2454", tier: "sat" },
  ]);
  assert.deepEqual(Array.from(h.stockCodes()), ["2330", "2454"]);
  const custom = stocks.find((s) => s.code === "2454");
  assert.equal(custom.name, "聯發科", "名稱由 market-feed 補");
  assert.equal(custom.custom, true);
  // 估值一律不寫進 STOCKS：PE／PB／殖利率全部在 render 時從 market-feed 取，
  // 寫死在標的物件上只會過期
  assert.equal(custom.pe, undefined);
  const kept = stocks.find((s) => s.code === "2330");
  assert.equal(kept.pe, undefined);
  assert.equal(kept.base, 2310, "內建標的保留人工的預設參考值");
  assert.equal(kept.tier, "core");

  // 分層可覆寫內建值
  assert.equal(h.setWatchlistForTest([{ code: "2330", tier: "wait" }])[0].tier, "wait");
});

test("sanitizeWatchlist rejects junk and never silently empties the list", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { sanitizeWatchlist } = context.window.PortfolioConsoleApp.helpers;

  // 非陣列或全部無效 → 回 null，代表「沒自訂」而非「空清單」，
  // 否則使用者存到壞資料就會看到一張空表
  assert.equal(sanitizeWatchlist(null), null);
  assert.equal(sanitizeWatchlist("2330"), null);
  assert.equal(sanitizeWatchlist([]), null);
  assert.equal(sanitizeWatchlist([{ code: "abc" }, { code: "12" }, { code: "" }]), null);

  // 去重、代碼格式、分層合法性
  const out = sanitizeWatchlist([
    { code: "2330", tier: "core" },
    { code: "2330", tier: "wait" },          // 重複 → 丟掉
    { code: "2454", tier: "不存在的層" },      // 非法分層 → 退回預設
    { code: "00878", tier: "sat" },          // 5 碼 ETF → 不是個股代碼，丟掉
    "3231",                                   // 純字串也接受
  ]);
  assert.deepEqual(Array.from(out).map((e) => e.code), ["2330", "2454", "3231"]);
  assert.equal(out[0].tier, "core");
  assert.equal(out[1].tier, "sat", "非法分層退回 sat");
  assert.equal(out[2].tier, "sat", "內建 3231 的分層是 sat");

  // 上限保護
  const many = Array.from({ length: 80 }, (_, i) => ({ code: String(1000 + i) }));
  assert.ok(sanitizeWatchlist(many).length <= 40, "清單要有上限");
});

test("a user-added stock still gets a system observation price from the market feed", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const h = context.window.PortfolioConsoleApp.helpers;
  // market-feed 有 open/high/low，所以自行加入的標的不是只有收盤價——
  // 觀察價一樣算得出來
  h.setMarketRowsForTest({ "2454": { code: "2454", name: "聯發科", close: 3865, pe: 64.57 } });
  const stock = h.setWatchlistForTest([{ code: "2454", tier: "sat" }])[0];
  const observation = h.suggestObservationPrice(stock, {
    code: "2454", close: 3865, high: 3900, low: 3800, hasPrice: true,
  }, { defense: false, fallbackBase: null });
  assert.ok(observation.price > 0, "有高低點就要算得出觀察價");
  assert.equal(observation.mode, "auto");
  assert.ok(observation.price <= 3865, "觀察價不得高於收盤");
});

test("watchlist state survives a save/load round trip", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { sanitizeState } = context.window.PortfolioConsoleApp.helpers;
  const saved = sanitizeState({
    watchlist: [{ code: "2330", tier: "core" }, { code: "2454", tier: "sat" }],
    today: { "2454": { close: 3865, change: 10 } },
    base: { "2454": 3600 },
  });
  assert.deepEqual(Array.from(saved.watchlist).map((e) => e.code), ["2330", "2454"]);
  // 自行加入的代碼其價格與觀察價也要留得住——早期版本只認內建代碼，一存檔就被清掉
  assert.equal(saved.today["2454"].close, 3865);
  assert.equal(saved.base["2454"], 3600);
});

test("scorecard PE prefers feed valuation and falls back to built-in", async () => {
  // (1) feed carries valuation → PE comes from feed, not the built-in static label
  const withVal = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/stock-risk-feed.json")) {
      return response(staticFeed({ valuation: {
        "2330": { code: "2330", pe: 25.3 },
        "2382": { code: "2382", pe: 18.9 },
      } }));
    }
    throw new Error(`unavailable: ${href}`);
  });
  await withVal.context.window.PortfolioConsoleApp.init();
  const valHtml = withVal.document.getElementById("scoreBody").innerHTML;
  assert.match(valHtml, /<td class="num">25\.3<\/td>/);   // 2330 feed pe，格式與 /market/ 同一支 fmt
  assert.match(valHtml, /<td class="num">18\.9<\/td>/);   // 2382 feed pe

  // (2) feed 沒有 valuation → 退回 market-feed 的 pe；沒有 market-feed 就顯示「—」，
  //     不再退回寫死的靜態標籤（那種值只會過期）
  const noVal = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });
  await noVal.context.window.PortfolioConsoleApp.init();
  const baseHtml = noVal.document.getElementById("scoreBody").innerHTML;
  assert.doesNotMatch(baseHtml, /~32|~19/, "寫死的靜態 PE 標籤已移除");
  assert.match(baseHtml, /<td class="num">—<\/td>/);
});

// 原本 PE、觀察距離、分層與人工說明分散在配置分層區；配置區移除後，
// 這些都必須在同一列（或同一張卡）上看得到，否則等於功能被刪掉而不是被合併。
test("each row carries tier, live PE, observation distance, and the manual role note", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/stock-risk-feed.json")) {
      return response(staticFeed({
        eod: [{ code: "2308", name: "台達電", close: 1905, change: -5, high: 1950, low: 1880 }],
        valuation: { "2308": { code: "2308", pe: 66.7 } },
      }));
    }
    throw new Error(`unavailable: ${href}`);
  });
  await context.window.PortfolioConsoleApp.init();
  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /<td class="num">66\.7<\/td>/);               // live feed PE
  assert.match(scoreHtml, /1,905/);                                     // live close
  assert.match(scoreHtml, /<select class="tier-pick wait" data-watch-tier="2308"/);
  assert.match(cardHtml, /電源、散熱/);                                   // manual role text retained
  assert.match(cardHtml, /等待冷卻/);                                     // tier option label
  assert.match(cardHtml, /距離觀察基準/);
});

test("page shows observation price pending when closing data is unavailable", async () => {
  const { context, document } = await loadApp(async (url) => {
    throw new Error(`unavailable: ${url}`);
  });

  await context.window.PortfolioConsoleApp.init();

  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /觀察價待更新/);
  assert.match(cardHtml, /觀察價待更新/);
  assert.doesNotMatch(scoreHtml, /系統觀察價 \d|· 系統觀察價|預設參考值|個人參考基準/);
  assert.doesNotMatch(cardHtml, /系統觀察價 ·|· 系統觀察價|預設參考值|個人參考基準/);
});

test("page uses Worker EOD and market indices on GitHub Pages default proxy", async () => {
  const calls = [];
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/eod")) {
      return response([
        { code: "2330", name: "台積電", close: 2410, change: 10 },
      ], {
        "X-Data-Source": "Worker mock EOD",
        "X-Data-Delay": "mock EOD",
        "X-Data-Updated-At": "2026-06-05T08:00:00.000Z",
      });
    }
    if (href.includes("/quote?indices=taiex,tpex")) {
      return response({
        indices: [
          { id: "taiex", name: "發行量加權股價指數", price: 42686.84, change: 2387.1, pctChange: 5.92, time: "2026-06-08T09:33:00+08:00" },
          { id: "tpex", name: "櫃買指數", price: 397.81, change: -3.26, pctChange: -0.81, time: "2026-06-08T09:33:00+08:00" },
        ],
      }, {
        "X-Data-Source": "TWSE MIS public quote feed",
        "X-Data-Delay": "mock intraday",
        "X-Data-Updated-At": "2026-06-08T09:33:05.000Z",
      });
    }
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    location: {
      href: "https://blackjw1212.github.io/",
      hostname: "blackjw1212.github.io",
      search: "",
    },
  });

  await context.window.PortfolioConsoleApp.init();

  assert.ok(calls.includes("https://taiwan-risk-tracker-proxy.a0926043323.workers.dev/eod"));
  assert.ok(calls.includes("https://taiwan-risk-tracker-proxy.a0926043323.workers.dev/quote?indices=taiex,tpex"));
  // 10Y 已從這頁移除：既不再打 Worker，也不再留在 state 裡
  assert.ok(!calls.some((href) => href.endsWith("/yield10y")));
  assert.match(document.getElementById("scoreBody").innerHTML, /2,410/);
  assert.equal(context.window.PortfolioConsoleApp.getState().cond, undefined);
  assert.match(document.getElementById("stamp").textContent, /市場指數：加權 42,686\.84/);
});

test("page prefers MIS 13:30 closing quotes when EOD OpenAPI lags", async () => {
  const calls = [];
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/quote?codes=")) {
      return response({ quotes: completeMisClosingQuotes() });
    }
    if (href.endsWith("/yield10y")) return response({ value: 4.55 });
    if (href.includes("/quote?indices=taiex,tpex")) return response({ indices: [] }, {}, { status: 502 });
    if (href.endsWith("/eod")) return response([{ code: "2330", name: "TSMC", close: 2365, change: -20 }]);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    location: {
      href: "https://blackjw1212.github.io/",
      hostname: "blackjw1212.github.io",
      search: "",
    },
  });

  await context.window.PortfolioConsoleApp.init();

  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.ok(calls.some((href) => href.includes("/quote?codes=")));
  assert.doesNotMatch(scoreHtml, /2,365/);
  assert.match(scoreHtml, /2,295/);
  assert.match(scoreHtml, /1,095/);
  assert.match(scoreHtml, /系統觀察價/);
  assert.match(scoreHtml, /2330[\s\S]*?系統觀察價 2,295 \/ 收盤貼近 0%[\s\S]*?低於觀察基準 · 系統觀察價 · 市場指數待更新，未判讀防守模式 · 低點站回確認[\s\S]*?2317/);
  assert.match(cardHtml, /2330[\s\S]*?系統觀察價 2,295 \/ 收盤貼近 0%[\s\S]*?低於觀察基準 · 系統觀察價 · 市場指數待更新，未判讀防守模式 · 低點站回確認[\s\S]*?2317/);
  assert.doesNotMatch(scoreHtml, /預設參考值/);
  // 收盤來源對整張表都一樣，改成放一次；不可因為「看起來重複」就整個拿掉
  assert.match(document.getElementById("dataSource").textContent, /收盤來源：.*TWSE MIS closing quote/);
});

test("weak market defense labels observation prices in table and mobile cards", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.includes("/quote?codes=")) return response({ quotes: completeMisClosingQuotes() });
    if (href.endsWith("/yield10y")) return response({ value: 4.55 });
    if (href.includes("/quote?indices=taiex,tpex")) {
      return response({
        indices: [
          { id: "taiex", name: "發行量加權股價指數", price: 42100, change: -1200, pctChange: -2.8, time: "2026-06-08T13:30:00+08:00" },
          { id: "tpex", name: "櫃買指數", price: 381, change: -13, pctChange: -3.2, time: "2026-06-08T13:30:00+08:00" },
        ],
      });
    }
    if (href.endsWith("/eod")) return response([{ code: "2330", name: "TSMC", close: 2365, change: -20 }]);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    location: {
      href: "https://blackjw1212.github.io/",
      hostname: "blackjw1212.github.io",
      search: "",
    },
  });

  await context.window.PortfolioConsoleApp.init();

  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /2330[\s\S]*?系統觀察價 2,270 \/ 收盤高出 1\.1%[\s\S]*?貼近觀察基準 · 系統觀察價 · 防守模式 · 等待跌勢收斂後再看[\s\S]*?2317/);
  assert.match(cardHtml, /2330[\s\S]*?系統觀察價 2,270 \/ 收盤高出 1\.1%[\s\S]*?貼近觀察基準 · 系統觀察價 · 防守模式 · 等待跌勢收斂後再看[\s\S]*?2317/);
});

test("incomplete MIS closing quotes fall through instead of mixing old rows", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.includes("/quote?codes=")) {
      return response({
        quotes: [
          { code: "2330", name: "TSMC", price: 2295, change: -70, time: "2026-06-08T13:30:00+08:00" },
          { code: "3324", name: "Auras", price: 1095, change: -15, time: "2026-06-08T13:30:00+08:00" },
        ],
      });
    }
    if (href.endsWith("/eod")) return response([{ code: "2330", name: "TSMC", close: 2365, change: -20 }]);
    if (href.endsWith("/yield10y")) return response({ value: 4.55 });
    if (href.includes("/quote?indices=taiex,tpex")) return response({ indices: [] }, {}, { status: 502 });
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    location: {
      href: "https://blackjw1212.github.io/",
      hostname: "blackjw1212.github.io",
      search: "",
    },
  });

  await context.window.PortfolioConsoleApp.init();

  assert.match(document.getElementById("scoreBody").innerHTML, /2,365/);
  assert.doesNotMatch(document.getElementById("scoreBody").innerHTML, /2,295/);
});

test("market index quote failure does not block dashboard refresh", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.endsWith("/eod")) {
      return response([{ code: "2330", name: "TSMC", close: 2410, change: 10 }]);
    }
    if (href.endsWith("/yield10y")) {
      return response({ value: 4.12 });
    }
    if (href.includes("/quote?indices=taiex,tpex")) {
      return response({ error: "upstream unavailable" }, {}, { status: 502 });
    }
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    location: {
      href: "https://blackjw1212.github.io/",
      hostname: "blackjw1212.github.io",
      search: "",
    },
  });

  await context.window.PortfolioConsoleApp.init();

  assert.match(document.getElementById("scoreBody").innerHTML, /2,410/);
  assert.match(document.getElementById("stamp").textContent, /市場指數：暫無法更新/);
  assert.doesNotMatch(document.getElementById("stamp").textContent, /NaN|undefined/);
});

// 舊存檔還留著已移除的 10Y／條件欄位；sanitizeState 要把它們丟掉而不是原樣搬進來，
// 否則死欄位會一直跟著存檔複製下去。
test("legacy 10Y and checklist fields are dropped from stored state", async () => {
  const { context } = await loadApp(async (url) => {
    const href = String(url);
    if (href.endsWith("/eod")) return response([{ code: "2330", name: "台積電", close: 2410 }]);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    PROXY_BASE: "https://taiwan-risk-tracker-proxy.a0926043323.workers.dev",
    localStorage: createLocalStorage({
      "bjkw-portfolio-console-v2": JSON.stringify({
        cond: { yield: 5.12 },
        condSource: { yield: "手動" },
        yieldManual: true,
        yieldMeta: { source: "手動" },
        base: { "2330": 2310 },
      }),
    }),
  });

  await context.window.PortfolioConsoleApp.init();

  const state = context.window.PortfolioConsoleApp.getState();
  assert.equal(state.cond, undefined);
  assert.equal(state.condSource, undefined);
  assert.equal(state.yieldManual, undefined);
  assert.equal(state.yieldMeta, undefined);
  assert.equal(state.base["2330"], 2310, "還在用的欄位不能被一起清掉");
});

test("empty static EOD can fall through to localStorage cache", async () => {
  const storage = createLocalStorage({
    [EOD_CACHE_KEY]: JSON.stringify({
      savedAt: "2026-06-05T08:00:00.000Z",
      source: "cache mock",
      delay: "cache delay",
      updatedAt: "2026-06-05T08:00:00.000Z",
      rows: [{ code: "2330", name: "台積電", close: 2399 }],
    }),
  });
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed({ eod: [] }));
    throw new Error(`unavailable: ${href}`);
  }, { localStorage: storage });

  await context.window.PortfolioConsoleApp.init();

  assert.match(document.getElementById("scoreBody").innerHTML, /2,399/);
  assert.match(document.getElementById("stamp").textContent, /本機快取/);
});

test("local observation log UI is removed from the static page", async () => {
  const { html } = await loadApp(async () => response(staticFeed()));
  const removedIds = [
    "trancheHeading",
    "planN",
    "doneN",
    "prog",
    "trancheStatus",
    "tDate",
    "tStep",
    "tTarget",
    "tPrice",
    "tNote",
    "addT",
    "tLog",
  ];

  for (const id of removedIds) {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`), id + " should be removed from static HTML");
  }
  assert.doesNotMatch(html, /LOCAL LOG|trancheHeading|trancheStatus|delete-tranche/);
});

test("malformed or legacy localStorage state does not break app initialization", async () => {
  const { context, document } = await loadApp(async () => response(staticFeed()), {
    localStorage: createLocalStorage({
      [STATE_KEY]: JSON.stringify({
        planN: 5,
        tranches: [{ target: "legacy row", note: "legacy note" }],
      }),
    }),
  });

  await context.window.PortfolioConsoleApp.init();

  assert.equal(context.window.PortfolioConsoleApp.getState().tranches, undefined);
  assert.equal(context.window.PortfolioConsoleApp.getState().planN, undefined);
  assert.match(document.getElementById("scoreBody").innerHTML, /2330/);
  assert.equal(document.getElementById("tLog").innerHTML, "");
});
