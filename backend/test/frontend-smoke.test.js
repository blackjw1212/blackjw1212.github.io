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
  const htmlPath = fileURLToPath(new URL("../../index.html", import.meta.url));
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

const EOD_CACHE_KEY = "bjkw-portfolio-console-v2:eod:2330,2317,6669,3017,3324,2382,1519,2308";
const STATE_KEY = "bjkw-portfolio-console-v2";

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

  assert.equal(typeof context.window.PortfolioConsoleApp.init, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.refresh, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.getState, "function");
  for (const name of [
    "aggregateVerdict",
    "normalizeEodPayload",
    "normalizeMarketIndexPayload",
    "normalizeYieldPayload",
    "parseNumber",
    "proxyBase",
    "sanitizeState",
    "deriveAutoSignals",
    "condColor",
    "tradingViewUrl",
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

test("retail glance helper contract stays conservative", async () => {
  const { context } = await loadApp(async () => response(staticFeed()), {
    location: {
      href: "https://blackjw1212.github.io/?proxy=https%3A%2F%2Fevil.example",
      hostname: "blackjw1212.github.io",
      search: "?proxy=https%3A%2F%2Fevil.example",
    },
  });
  const retail = context.window.RetailConsole;
  const helpers = retail.helpers;
  assert.equal(typeof helpers.tradingViewUrl, "function");

  assert.equal(helpers.holdingStatus(-12, 10, 30).tone, "r");
  assert.equal(helpers.holdingStatus(35, 10, 30).tone, "a");
  assert.equal(helpers.holdingStatus(5, 10, 30).tone, "g");
  assert.equal(helpers.holdingStatus(null, 10, 30).tone, "n");
  assert.equal(helpers.holdingStatus(-10, 10, 30).tone, "r");
  const unsafeTerms = ["停" + "損", "停" + "利", "減" + "碼", "買" + "進", "賣" + "出", "加" + "碼"];
  const unsafePattern = new RegExp(unsafeTerms.join("|"));
  assert.doesNotMatch(helpers.holdingStatus(-12, 10, 30).label, unsafePattern);
  assert.doesNotMatch(helpers.holdingStatus(35, 10, 30).label, unsafePattern);

  assert.equal(helpers.plPct(2100, 2385), 13.6);
  assert.equal(helpers.plPct(0, 2385), null);
  assert.equal(helpers.plPct(2500, null), null);

  assert.equal(helpers.marketTone(0, NaN, false).tone, "n");
  assert.equal(helpers.marketTone(0.625, 4.4, true).tone, "g");
  assert.equal(helpers.marketTone(0.125, 4.8, true).tone, "r");
  assert.equal(helpers.marketTone(0.5, 4.55, true).tone, "a");
  assert.match(helpers.marketTone(0, NaN, false).reason, /暫不判讀/);

  assert.equal(helpers.bodyStars(["m", "h", "h", "m", "h", "h"]), 4);
  assert.equal(helpers.bodyStars(["l", "l", "h", "h", "mh", "mh"]), 3);
  assert.ok(helpers.bodyStars(["l", "l", "l", "l", "l", "l"]) >= 1);
  assert.equal(helpers.valTag("h").cls, "cheap");
  assert.equal(helpers.valTag("m").cls, "fair");
  assert.equal(helpers.valTag("l").cls, "rich");

  const eod = helpers.normalizeEodRows([{Code: "2330", ClosingPrice: "1,234.5", Change: "+5.0"}]);
  assert.equal(eod["2330"].close, 1234.5);
  assert.equal(eod["2330"].change, 5);
  assert.equal(helpers.normalizeYield({value: "4.55"}), 4.55);
  assert.equal(helpers.normalizeYield({body: {value: "4.6"}}), 4.6);
  assert.equal(helpers.normalizeYield({data: {value: 4.7}}), 4.7);
  assert.equal(helpers.normalizeYield({}), null);

  assert.equal(retail.proxyBase(), "https://taiwan-risk-tracker-proxy.a0926043323.workers.dev");
  const url = new URL(helpers.mopsUrl("2330"));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "mops.twse.com.tw");
  assert.equal(url.searchParams.get("co_id"), "2330");

  const twse = new URL(helpers.tradingViewUrl("2330"));
  assert.equal(twse.protocol, "https:");
  assert.equal(twse.hostname, "tw.tradingview.com");
  assert.equal(twse.pathname, "/chart/");
  assert.equal(twse.searchParams.get("symbol"), "TWSE:2330");
  assert.match(helpers.tradingViewUrl("2330"), /symbol=TWSE%3A2330/);
  const tpex = new URL(helpers.tradingViewUrl("3324"));
  assert.equal(tpex.protocol, "https:");
  assert.equal(tpex.hostname, "tw.tradingview.com");
  assert.equal(tpex.pathname, "/chart/");
  assert.equal(tpex.searchParams.get("symbol"), "TPEX:3324");
  assert.match(helpers.tradingViewUrl("3324"), /symbol=TPEX%3A3324/);
  for (const code of ["9999", "https://evil.example", "2330/../../evil", "2330?next=https://evil.example"]) {
    assert.equal(helpers.tradingViewUrl(code), "");
  }
});

test("verdict aggregation uses automated entry/wait/exit observation language", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { aggregateVerdict } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(aggregateVerdict(["r", "r", "g", "a"]).tone, "r");
  assert.match(aggregateVerdict(["r", "r", "g", "a"]).title, /退場/);
  assert.equal(aggregateVerdict(["r", "a", "a", "a"]).tone, "r");
  assert.equal(aggregateVerdict(["g", "g", "g", "g"]).tone, "g");
  assert.match(aggregateVerdict(["g", "g", "g", "g"]).title, /進場觀察/);
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
      "2330": { close: 2400, change: 5 },
      "2317": { close: 300, change: 3 },
      "6669": { close: 5600, change: 20 },
      "3017": { close: 2650, change: 10 },
      "3324": { close: 1300, change: 5 },
      "2382": { close: 350, change: 2 },
      "1519": { close: 900, change: 5 },
      "2308": { close: 2200, change: 4 },
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

  assert.match(aggregateVerdict(deriveAutoSignals(entryState)).title, /偏進場觀察/);
  assert.match(aggregateVerdict(deriveAutoSignals({ cond: { yield: 4.12 }, today: {} })).title, /等待/);
  assert.match(aggregateVerdict(deriveAutoSignals(exitState)).title, /偏退場降風險/);
});

test("frontend normalizers round EOD rows and support yield payload shapes", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { normalizeEodPayload, normalizeMarketIndexPayload, normalizeYieldPayload } = context.window.PortfolioConsoleApp.helpers;
  const plain = (value) => JSON.parse(JSON.stringify(value));

  assert.deepEqual(plain(normalizeEodPayload([
    { Code: "2330", Name: "TSMC", ClosingPrice: "1,010.123", Change: "+5.257" },
    { Code: "bad", Name: "Bad", ClosingPrice: "1" },
    { Code: "2308", Name: "Delta", ClosingPrice: "--" },
  ])), [
    { code: "2330", name: "TSMC", close: 1010.12, change: 5.26 },
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
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });

  await context.window.PortfolioConsoleApp.init();

  assert.match(document.getElementById("scoreBody").innerHTML, /2330/);
  assert.match(document.getElementById("scoreBody").innerHTML, /2,400.25/);
  assert.match(document.getElementById("stockCards").innerHTML, /台積電/);
  assert.match(document.getElementById("scoreBody").innerHTML, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.match(document.getElementById("stockCards").innerHTML, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.doesNotMatch(document.getElementById("scoreBody").innerHTML, /\/technicals\//);
  assert.match(document.getElementById("scoreBody").innerHTML, /target="_blank"/);
  assert.match(document.getElementById("stockCards").innerHTML, /rel="noopener noreferrer"/);
  assert.match(document.getElementById("scoreBody").innerHTML, /aria-label="在 TradingView 開啟 2330 台積電完整圖表觀察（外部連結）"/);
  assert.match(document.getElementById("conds").innerHTML, /自動/);
  assert.match(document.getElementById("signalSummary").innerHTML, /資料可用性/);
  assert.match(document.getElementById("stamp").textContent, /靜態 feed/);
  assert.match(document.getElementById("verdictTitle").textContent, /等待|退場|進場/);
  assert.match(document.getElementById("actionAvoid").textContent, /不要/);
  for (const id of ["c_data", "c_yield", "c_breadth", "c_core", "c_satellite", "cd_data", "src_yield"]) {
    assert.ok(elements.has(id), `${id} should be created during init`);
  }
  assert.ok(calls.includes("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"));
  assert.ok(calls.some((href) => href.startsWith("data/stock-risk-feed.json")));
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
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
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
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
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
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
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
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed({ eod: [] }));
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
