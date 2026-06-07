import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this._textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  appendChild(child) {
    if (child.innerHTML) {
      this.innerHTML += child.innerHTML;
    } else if (child.className) {
      this.innerHTML += `<div class="${child.className}"></div>`;
    } else {
      this.innerHTML += child.textContent || "";
    }
    return child;
  }

  querySelectorAll() {
    return [];
  }
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

function response(data, headers = {}) {
  return {
    ok: true,
    status: 200,
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

test("index.html keeps required static DOM ids and global helper contract", async () => {
  const { context, html } = await loadApp(async () => response(staticFeed()));
  const requiredIds = [
    "verdictLight", "verdictTitle", "verdictDesc", "actionNext", "actionAvoid",
    "refresh", "conds", "stamp", "buckets", "scoreTable", "scoreBody", "stockCards",
    "planN", "doneN", "prog", "tDate", "tStep", "tTarget", "tPrice", "tNote", "addT", "tLog",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} should exist in static HTML`);
  }

  assert.equal(typeof context.window.PortfolioConsoleApp.init, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.refresh, "function");
  assert.equal(typeof context.window.PortfolioConsoleApp.getState, "function");
  for (const name of [
    "aggregateVerdict",
    "normalizeEodPayload",
    "normalizeYieldPayload",
    "parseNumber",
    "proxyBase",
    "sanitizeState",
  ]) {
    assert.equal(typeof context.window.PortfolioConsoleApp.helpers[name], "function");
  }
});

test("verdict aggregation uses observation-threshold language", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { aggregateVerdict } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(aggregateVerdict(["r", "r", "g", "a"]).tone, "r");
  assert.match(aggregateVerdict(["r", "r", "g", "a"]).title, /暫停/);
  assert.equal(aggregateVerdict(["r", "a", "a", "a"]).tone, "r");
  assert.equal(aggregateVerdict(["g", "g", "g", "g"]).tone, "g");
  assert.match(aggregateVerdict(["g", "g", "g", "g"]).title, /觀察門檻/);
  assert.equal(aggregateVerdict(["g", "a", "r", "a"]).tone, "a");
});

test("frontend normalizers round EOD rows and support yield payload shapes", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { normalizeEodPayload, normalizeYieldPayload } = context.window.PortfolioConsoleApp.helpers;
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

test("page renders checklist, cards, and source labels from static fallback", async () => {
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
  assert.match(document.getElementById("conds").innerHTML, /手動/);
  assert.match(document.getElementById("stamp").textContent, /靜態 feed/);
  assert.match(document.getElementById("verdictTitle").textContent, /暫停|觀察/);
  assert.match(document.getElementById("actionAvoid").textContent, /不要/);
  for (const id of ["c_sox", "c_margin", "c_yield", "c_fed", "cd_sox", "src_yield"]) {
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
  assert.match(document.getElementById("scoreBody").innerHTML, /2,410/);
  assert.equal(context.window.PortfolioConsoleApp.getState().cond.yield, 4.12);
  assert.match(document.getElementById("src_yield").textContent, /2026-06-05/);
});

test("manual 10Y override is not overwritten by refresh", async () => {
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

  assert.equal(context.window.PortfolioConsoleApp.getState().cond.yield, 5.12);
  assert.match(document.getElementById("src_yield").textContent, /手動覆寫/);
  assert.ok(!calls.some((href) => href.endsWith("/yield10y")));
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

test("tranche observation form persists a local-only observation row", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });

  await context.window.PortfolioConsoleApp.init();

  document.getElementById("tDate").value = "2026-06-07";
  document.getElementById("tStep").value = "第 1 筆";
  document.getElementById("tTarget").value = "2330 核心";
  document.getElementById("tPrice").value = "觀察 2400";
  document.getElementById("tNote").value = "燈號仍需確認";
  document.getElementById("addT").listeners.get("click")();

  assert.equal(context.window.PortfolioConsoleApp.getState().tranches.length, 1);
  assert.equal(document.getElementById("doneN").textContent, "1");
  assert.match(document.getElementById("tLog").innerHTML, /2330 核心/);
  assert.match(document.getElementById("prog").innerHTML, /pill done/);
});

test("malformed localStorage state does not break tranche rendering", async () => {
  const { context, document } = await loadApp(async () => response(staticFeed()), {
    localStorage: createLocalStorage({
      "bjkw-portfolio-console-v2": "{bad json",
    }),
  });

  await context.window.PortfolioConsoleApp.init();

  assert.equal(context.window.PortfolioConsoleApp.getState().tranches.length, 0);
  assert.equal(document.getElementById("doneN").textContent, "0");
});
