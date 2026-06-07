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
    this.innerHTML += child.innerHTML || child.textContent || "";
    return child;
  }

  querySelectorAll() {
    return [];
  }
}

function createDocument() {
  const elements = new Map();
  return {
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

  const document = createDocument();
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
  return { context, document };
}

function staticFeed() {
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
  };
}

test("verdict aggregation matches conservative rule", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const { aggregateVerdict } = context.window.PortfolioConsoleApp.helpers;

  assert.equal(aggregateVerdict(["r", "r", "g", "a"]).tone, "r");
  assert.equal(aggregateVerdict(["r", "a", "a", "a"]).tone, "r");
  assert.equal(aggregateVerdict(["g", "g", "g", "g"]).tone, "g");
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

test("page renders from static feed when backend and direct EOD are unavailable", async () => {
  const calls = [];
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });

  await context.window.PortfolioConsoleApp.init();

  assert.match(document.getElementById("scoreBody").innerHTML, /2330/);
  assert.match(document.getElementById("scoreBody").innerHTML, /2,400.25/);
  assert.match(document.getElementById("stamp").textContent, /靜態 feed/);
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
      return response({ body: { value: 4.12 } });
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
