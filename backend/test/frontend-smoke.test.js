import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.className = "";
    this.listeners = new Map();
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(" ");
      },
    };
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }
}

function createDocument() {
  const elements = new Map();
  return {
    readyState: "complete",
    addEventListener() {},
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

function createFetchMock() {
  return async function fetchMock(url) {
    const href = String(url);
    if (href.endsWith("/eod")) {
      return response([
        { code: "2330", name: "TSMC", close: 1000, change: 5 },
        { code: "2308", name: "Delta", close: 390, change: -2 },
      ], {
        "X-Data-Source": "mock eod",
        "X-Data-Delay": "mock delay",
        "X-Data-Updated-At": "2026-06-05T08:00:00.000Z",
      });
    }
    if (href.endsWith("/yield10y")) {
      return response({ date: "2026-06-05", value: 4.123, updatedAt: "2026-06-05T08:00:00.000Z" });
    }
    if (href.includes("/quote?codes=")) {
      return response({
        quotes: [
          { code: "2330", name: "TSMC", price: "1100", change: "10" },
        ],
        delay: "mock intraday delay",
        updatedAt: "2026-06-05T08:01:00.000Z",
      });
    }
    if (href.includes("/filings?code=")) {
      const code = new URL(href).searchParams.get("code");
      return response([
        { date: "2026-06-05", title: `Material update ${code}`, url: `https://example.test/${code}` },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

function createDirectEodFetchMock() {
  return async function fetchMock(url) {
    const href = String(url);
    if (href === "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL") {
      return response([
        { Code: "2330", Name: "TSMC", ClosingPrice: "1,000.00", Change: "+5.00" },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

async function loadApp(fetchMock, windowOverrides = {}) {
  const htmlPath = fileURLToPath(new URL("../../index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "inline script should be present");

  const document = createDocument();
  const window = {
    __TW_RISK_SKIP_AUTO_INIT__: true,
    location: { search: "" },
    ...windowOverrides,
  };

  const context = vm.createContext({
    AbortController,
    clearInterval,
    clearTimeout,
    console,
    document,
    fetch: fetchMock,
    Headers,
    Intl,
    setInterval: () => 1,
    setTimeout,
    URL,
    URLSearchParams,
    window,
  });

  vm.runInContext(script, context, { filename: "index.html" });
  await context.window.RiskTrackerApp.init();
  return { context, document };
}

test("index.html initializes and renders with mocked fetch", async () => {
  const { context, document } = await loadApp(createFetchMock(), {
    PROXY_BASE: "https://proxy.test",
  });

  assert.match(document.getElementById("stockRows").innerHTML, /2330/);
  assert.match(document.getElementById("filingsFeed").innerHTML, /Material update/);
  assert.equal(document.getElementById("macroStatus").textContent, "Loaded");
  assert.equal(document.getElementById("eodStatus").textContent, "Loaded");
  assert.equal(document.getElementById("proxyBadge").textContent, "Backend set");

  document.getElementById("quoteToggle").checked = true;
  await context.window.RiskTrackerApp.refreshAll();
  assert.equal(context.window.RiskTrackerApp.getState().quoteFresh, true);
  assert.match(document.getElementById("stockRows").innerHTML, /1,100.00/);

  document.getElementById("quoteToggle").checked = false;
  await context.window.RiskTrackerApp.refreshAll();
  assert.equal(context.window.RiskTrackerApp.getState().quoteFresh, false);
  assert.doesNotMatch(document.getElementById("stockRows").innerHTML, /1,100.00/);
});

test("index.html supports no-backend direct EOD fallback", async () => {
  const { document } = await loadApp(createDirectEodFetchMock());

  assert.equal(document.getElementById("proxyBadge").textContent, "Backend unset");
  assert.equal(document.getElementById("eodStatus").textContent, "Loaded");
  assert.match(document.getElementById("tableSource").textContent, /TWSE OpenAPI direct/);
  assert.equal(document.getElementById("macroStatus").textContent, "Backend required");
  assert.equal(document.getElementById("filingsStatus").textContent, "Backend required");
  assert.match(document.getElementById("filingsFeed").innerHTML, /Backend required for MOPS filings/);
});
