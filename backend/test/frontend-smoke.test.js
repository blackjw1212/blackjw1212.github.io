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
  const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1];
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
  const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1];
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
  ];
}

const EOD_CACHE_KEY = "bjkw-portfolio-console-v2:eod:2330,2317,2382,3231,6669,3017,3324,3661,1519,2308";
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
  assert.deepEqual(primaryLinks, [["stocks", "/stocks/"], ["weather", "/weather/"]]);
  assert.match(html, /股票投資觀察台/);
  assert.doesNotMatch(html, /href="\/ai\/"|data-primary-entry="ai"|AI Feed/);
  assert.match(html, /BJKW 天氣觀察台/);
  for (const id of ["stockFeedStatus", "stockFeedMeta", "yieldStatus", "yieldMeta", "weatherStatus", "weatherMeta", "deployStatus", "deployMeta"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be present`);
  }
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
  assert.equal(document.getElementById("deployStatus").textContent, "可進入");
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
  assert.equal(document.getElementById("deployStatus").textContent, "可進入");
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
    "verdictLight", "verdictTitle", "verdictDesc", "actionNext", "actionAvoid",
    "signalSummary", "refresh", "conds", "stamp", "buckets", "scoreTable", "scoreBody", "stockCards",
    "headerMarketQuotes", "headerQuoteTaiex", "headerQuoteTaiexValue", "headerQuoteTaiexChange",
    "headerQuoteTaiexStatus", "headerQuoteTpex", "headerQuoteTpexValue", "headerQuoteTpexChange",
    "headerQuoteTpexStatus", "headerQuoteStatus",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} should exist in static HTML`);
  }
  assert.match(html, /rel="icon" href="\/assets\/images\/favicon\.ico"/);
  assert.match(html, /rel="icon" href="\/assets\/images\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/images\/apple-touch-icon\.png"/);
  assert.match(html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/);
  assert.match(html, /name="theme-color" content="#101418"/);
  assert.match(html, /\.header-shell\{display:flex/);
  assert.match(html, /\.header-markets\{width:min\(360px,100%\)/);
  assert.match(html, /\.market-card\{/);
  assert.match(html, /@media \(max-width:760px\)[\s\S]*\.header-shell\{flex-direction:column/);
  assert.match(html, /aria-label="市場指數"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /距離觀察基準/);
  assert.doesNotMatch(html, /vs 個人參考基準|個人參考基準/);

  assert.equal(typeof context.window.PortfolioConsoleApp.init, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.refresh, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.getState, "function");
  for (const name of [
    "aggregateVerdict",
    "normalizeClosingQuoteRows",
    "normalizeEodPayload",
    "normalizeMarketIndexPayload",
    "normalizeYieldPayload",
    "parseNumber",
    "proxyBase",
    "sanitizeState",
    "deriveAutoSignals",
    "condColor",
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
  assert.equal(context.window.PortfolioConsoleApp.helpers.tradingViewUrl("2330/../../evil"), "");
});


test("verdict aggregation uses automated observation and risk language", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { aggregateVerdict } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(aggregateVerdict(["r", "r", "g", "a"]).tone, "r");
  assert.match(aggregateVerdict(["r", "r", "g", "a"]).title, /風險升高觀察/);
  assert.equal(aggregateVerdict(["r", "a", "a", "a"]).tone, "r");
  assert.equal(aggregateVerdict(["g", "g", "g", "g"]).tone, "g");
  assert.match(aggregateVerdict(["g", "g", "g", "g"]).title, /條件接近觀察/);
  assert.equal(aggregateVerdict(["g", "a", "r", "a"]).tone, "a");
});

test("auto signal helper gates entry, waiting, and exit observation states", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { deriveAutoSignals, aggregateVerdict } = context.window.PortfolioConsoleApp.helpers;
  const fresh = new Date().toISOString();
  const entryState = {
    cond: { yield: 4.12 },
    condSource: {},
    base: {},
    today: {
      "2330": { close: 2400, change: 5, high: 2420, low: 2350 },
      "2317": { close: 300, change: 3, high: 305, low: 292 },
      "6669": { close: 5600, change: 20, high: 5660, low: 5450 },
      "3017": { close: 2650, change: 10, high: 2700, low: 2580 },
      "3324": { close: 1300, change: 5, high: 1325, low: 1240 },
      "2382": { close: 350, change: 2, high: 355, low: 342 },
      "1519": { close: 900, change: 5, high: 918, low: 872 },
      "2308": { close: 2200, change: 4, high: 2230, low: 2140 },
    },
    eodMeta: { source: "Worker mock EOD", updatedAt: fresh },
    yieldMeta: { source: "mock 10Y", updatedAt: fresh },
  };
  const exitState = {
    ...entryState,
    cond: { yield: 4.85 },
    today: {
      "2330": { close: 2300, change: -50 },
      "2317": { close: 270, change: -8 },
      "6669": { close: 6600, change: -150 },
      "3017": { close: 3100, change: -70 },
      "3324": { close: 1500, change: -60 },
      "2382": { close: 410, change: -10 },
      "1519": { close: 1050, change: -20 },
      "2308": { close: 2600, change: -50 },
    },
  };
  const fallbackOnlyState = {
    ...entryState,
    today: Object.fromEntries(Object.entries(entryState.today).map(([code, row]) => [code, { close: row.close, change: row.change }])),
  };

  assert.match(aggregateVerdict(deriveAutoSignals(entryState)).title, /條件接近觀察/);
  assert.equal(deriveAutoSignals(fallbackOnlyState).find((signal) => signal.id === "data").tone, "a");
  assert.match(aggregateVerdict(deriveAutoSignals(fallbackOnlyState)).title, /等待/);
  assert.match(aggregateVerdict(deriveAutoSignals({ cond: { yield: 4.12 }, today: {} })).title, /等待/);
  assert.match(aggregateVerdict(deriveAutoSignals(exitState)).title, /風險升高觀察/);
});

test("weak market defense blocks automated entry observation", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { deriveAutoSignals, aggregateVerdict, marketDefenseMode } = context.window.PortfolioConsoleApp.helpers;
  const fresh = new Date().toISOString();
  const weakMarketState = {
    cond: { yield: 4.12 },
    condSource: {},
    today: {
      "2330": { close: 2400, change: 5, high: 2420, low: 2350 },
      "2317": { close: 300, change: 3, high: 305, low: 292 },
      "6669": { close: 5600, change: 20, high: 5660, low: 5450 },
      "3017": { close: 2650, change: 10, high: 2700, low: 2580 },
      "3324": { close: 1300, change: 5, high: 1325, low: 1240 },
      "2382": { close: 350, change: 2, high: 355, low: 342 },
      "1519": { close: 900, change: 5, high: 918, low: 872 },
      "2308": { close: 2200, change: 4, high: 2230, low: 2140 },
    },
    eodMeta: { source: "Worker mock EOD", updatedAt: fresh },
    yieldMeta: { source: "mock 10Y", updatedAt: fresh },
    marketIndexRows: [
      { id: "taiex", label: "加權", price: 42000, pctChange: -2.8 },
      { id: "tpex", label: "櫃買", price: 390, pctChange: -3.2 },
    ],
  };

  const signals = deriveAutoSignals(weakMarketState);
  assert.equal(marketDefenseMode(weakMarketState), true);
  assert.equal(signals.find((signal) => signal.id === "market").tone, "r");
  assert.match(signals.find((signal) => signal.id === "market").detail, /等待跌勢收斂/);
  assert.doesNotMatch(aggregateVerdict(signals).title, /條件接近觀察/);
  assert.match(aggregateVerdict(signals).title, /等待/);
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

test("frontend normalizers round EOD rows and support yield payload shapes", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { normalizeClosingQuoteRows, normalizeEodPayload, normalizeMarketIndexPayload, normalizeYieldPayload } = context.window.PortfolioConsoleApp.helpers;
  const plain = (value) => JSON.parse(JSON.stringify(value));

  assert.deepEqual(plain(normalizeEodPayload([
    { Code: "2330", Name: "TSMC", ClosingPrice: "1,010.123", Change: "+5.257", HighestPrice: "1,020.25", LowestPrice: "998.75", OpeningPrice: "1,005.50" },
    { Code: "bad", Name: "Bad", ClosingPrice: "1" },
    { Code: "2308", Name: "Delta", ClosingPrice: "--" },
  ])), [
    { code: "2330", name: "TSMC", close: 1010.12, change: 5.26, high: 1020.25, low: 998.75, open: 1005.5 },
  ]);

  assert.equal(normalizeYieldPayload({ value: "4.1234" }).value, 4.123);
  assert.equal(normalizeYieldPayload({ body: { value: "4.5555" } }).value, 4.556);
  assert.equal(normalizeYieldPayload({ data: { value: "4.7777" } }).value, 4.778);
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

test("page renders automated checklist, cards, and source labels from static fallback", async () => {
  const calls = [];
  const { context, document, elements } = await loadApp(async (url) => {
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
  assert.match(document.getElementById("conds").innerHTML, /自動/);
  assert.match(document.getElementById("signalSummary").innerHTML, /資料可用性/);
  assert.match(document.getElementById("stamp").textContent, /靜態 feed/);
  assert.match(document.getElementById("verdictTitle").textContent, /等待|風險升高|條件接近/);
  assert.match(document.getElementById("actionAvoid").textContent, /不要/);
  for (const id of ["c_data", "c_yield", "c_breadth", "c_core", "c_satellite", "cd_data", "src_yield"]) {
    assert.ok(elements.has(id), `${id} should be created during init`);
  }
  assert.ok(calls.includes("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"));
  assert.ok(calls.some((href) => href.startsWith("/data/stock-risk-feed.json")));
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

test("page uses Worker EOD and yield on GitHub Pages default proxy", async () => {
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
    if (href.endsWith("/yield10y")) {
      return response({ body: { value: 4.12, date: "2026-06-05" } });
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
  assert.ok(calls.includes("https://taiwan-risk-tracker-proxy.a0926043323.workers.dev/yield10y"));
  assert.ok(calls.includes("https://taiwan-risk-tracker-proxy.a0926043323.workers.dev/quote?indices=taiex,tpex"));
  assert.match(document.getElementById("scoreBody").innerHTML, /2,410/);
  assert.equal(document.getElementById("headerQuoteTaiexValue").textContent, "42,686.84");
  assert.equal(document.getElementById("headerQuoteTaiexChange").textContent, "+2,387.10 / +5.92%");
  assert.match(document.getElementById("headerQuoteTaiexChange").className, /pos/);
  assert.equal(document.getElementById("headerQuoteTpexValue").textContent, "397.81");
  assert.match(document.getElementById("headerQuoteTpexChange").className, /neg/);
  assert.match(document.getElementById("headerQuoteTaiexStatus").textContent, /TWSE MIS/);
  assert.equal(context.window.PortfolioConsoleApp.getState().cond.yield, 4.12);
  assert.match(document.getElementById("src_yield").textContent, /10Y.*2026/);
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
  assert.match(scoreHtml, /TWSE MIS closing quote/);
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
  assert.match(document.getElementById("signalSummary").innerHTML, /市場防守模式[\s\S]*等待跌勢收斂/);
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
  assert.equal(document.getElementById("headerQuoteTaiexValue").textContent, "待更新");
  assert.match(document.getElementById("headerQuoteTaiexStatus").textContent, /暫無法更新/);
  assert.match(document.getElementById("headerQuoteTaiexStatus").className, /error/);
  assert.doesNotMatch(document.getElementById("headerQuoteTaiexValue").textContent, /NaN|undefined/);
  assert.doesNotMatch(document.getElementById("stamp").textContent, /NaN|undefined/);
});

test("legacy manual 10Y override no longer blocks automated refresh", async () => {
  const calls = [];
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/eod")) return response([{ code: "2330", name: "台積電", close: 2410 }]);
    if (href.endsWith("/yield10y")) return response({ value: 4.12 });
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unexpected: ${href}`);
  }, {
    PROXY_BASE: "https://taiwan-risk-tracker-proxy.a0926043323.workers.dev",
    localStorage: createLocalStorage({
      "bjkw-portfolio-console-v2": JSON.stringify({
        cond: { yield: 5.12 },
        yieldManual: true,
      }),
    }),
  });

  await context.window.PortfolioConsoleApp.init();

  assert.equal(context.window.PortfolioConsoleApp.getState().cond.yield, 4.12);
  assert.match(document.getElementById("src_yield").textContent, /10Y/);
  assert.ok(calls.some((href) => href.endsWith("/yield10y")));
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
