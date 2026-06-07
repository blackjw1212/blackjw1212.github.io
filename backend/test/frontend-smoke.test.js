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

const FILINGS_CACHE_KEY = "bjkw_stock_filings_v1:2330,2308,2317,2454,2412,2881,2891,2603";

function isStaticFeedUrl(href) {
  return href.startsWith("data/stock-risk-feed.json");
}

function staticFeed(filings = []) {
  return {
    updatedAt: "2026-06-05T09:00:00.000Z",
    filingsUpdatedAt: "2026-06-05T09:00:00.000Z",
    filings,
    yield10y: {
      date: "2026-06-05",
      value: 4.55,
      updatedAt: "2026-06-05T22:00:00.000Z",
      source: "US Treasury Daily Treasury Yield Curve",
    },
    errors: [],
  };
}

function twseFilingsRows(title = "台積電重大訊息") {
  return [
    {
      "出表日期": "1150605",
      "發言日期": "1150605",
      "發言時間": "091500",
      "公司代號": "2330",
      "公司名稱": "台積電",
      "主旨 ": title,
      "符合條款": "第51款",
      "事實發生日": "1150605",
      "說明": "測試公告內容",
    },
    {
      "出表日期": "1150605",
      "發言日期": "1150605",
      "發言時間": "101000",
      "公司代號": "9999",
      "公司名稱": "非持股",
      "主旨 ": "不應顯示",
      "符合條款": "第51款",
      "事實發生日": "1150605",
      "說明": "非持股公告",
    },
  ];
}

function tpexFilingsRows(title = "台達電上櫃格式測試") {
  return [
    {
      Date: "1150605",
      Time: "111500",
      SecuritiesCompanyCode: "2308",
      CompanyName: "台達電",
      Subject: title,
      Description: "上櫃英文字段格式測試",
    },
  ];
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
    if (href === "https://openapi.twse.com.tw/v1/opendata/t187ap04_L") {
      return response(twseFilingsRows());
    }
    if (href === "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") {
      return response(tpexFilingsRows());
    }
    if (href.includes("/filings?code=")) {
      throw new Error(`Backend filings should not be used before direct OpenAPI: ${href}`);
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
    if (href === "https://openapi.twse.com.tw/v1/opendata/t187ap04_L") {
      return response(twseFilingsRows("無代理重大訊息"));
    }
    if (href === "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") {
      return response(tpexFilingsRows("無代理上櫃格式"));
    }
    if (isStaticFeedUrl(href)) {
      return response(staticFeed());
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

function createFilingsFailureFetchMock() {
  return async function fetchMock(url) {
    const href = String(url);
    if (href === "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL") {
      return response([
        { Code: "2330", Name: "TSMC", ClosingPrice: "1,000.00", Change: "+5.00" },
      ]);
    }
    if (href === "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" ||
        href === "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") {
      throw new Error("direct filings unavailable");
    }
    if (isStaticFeedUrl(href)) {
      return response(staticFeed([
        {
          code: "2330",
          name: "台積電",
          date: "2026-06-05 09:00",
          title: "同源靜態重大訊息",
          source: "GitHub Pages 同源重大訊息備援",
          sortKey: "2026-06-05T09:00:00+08:00",
        },
      ]));
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

function createPartialFilingsFetchMock() {
  return async function fetchMock(url) {
    const href = String(url);
    if (href === "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL") {
      return response([
        { Code: "2330", Name: "TSMC", ClosingPrice: "1,000.00", Change: "+5.00" },
      ]);
    }
    if (href === "https://openapi.twse.com.tw/v1/opendata/t187ap04_L") {
      return response(twseFilingsRows("部分來源重大訊息"));
    }
    if (href === "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") {
      throw new Error("tpex unavailable");
    }
    if (isStaticFeedUrl(href)) {
      return response(staticFeed());
    }
    throw new Error(`Unexpected fetch URL: ${href}`);
  };
}

function createProxyFallbackFetchMock(calls) {
  return async function fetchMock(url) {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/eod")) {
      return response([
        { code: "2330", name: "TSMC", close: 1000, change: 5 },
      ]);
    }
    if (href.endsWith("/yield10y")) {
      return response({ date: "2026-06-05", value: 4.123, updatedAt: "2026-06-05T08:00:00.000Z" });
    }
    if (href === "https://openapi.twse.com.tw/v1/opendata/t187ap04_L" ||
        href === "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") {
      throw new Error("direct filings unavailable");
    }
    if (href.includes("/filings?code=")) {
      const code = new URL(href).searchParams.get("code");
      return response([
        { date: "2026-06-05", title: `代理備援重大訊息 ${code}`, url: "https://mops.twse.com.tw/mops/web/t05st01" },
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
  const localStorage = windowOverrides.localStorage || createLocalStorage();
  const window = {
    __TW_RISK_SKIP_AUTO_INIT__: true,
    location: { href: "https://blackjw1212.github.io/", search: "" },
    localStorage,
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
    localStorage: window.localStorage,
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
  assert.match(document.getElementById("filingsFeed").innerHTML, /台積電重大訊息/);
  assert.match(document.getElementById("filingsFeed").innerHTML, /台達電上櫃格式測試/);
  assert.doesNotMatch(document.getElementById("filingsFeed").innerHTML, /不應顯示/);
  assert.equal(document.getElementById("macroStatus").textContent, "已載入");
  assert.equal(document.getElementById("macroStatus").className, "chip ok");
  assert.equal(document.getElementById("eodStatus").textContent, "已載入");
  assert.equal(document.getElementById("eodStatus").className, "chip ok");
  assert.equal(document.getElementById("proxyBadge").textContent, "盤中/殖利率代理已設定");
  assert.equal(document.getElementById("proxyBadge").className, "chip ok");
  assert.equal(document.getElementById("filingsStatus").className, "chip ok");

  document.getElementById("quoteToggle").checked = true;
  await context.window.RiskTrackerApp.refreshAll();
  assert.equal(context.window.RiskTrackerApp.getState().quoteFresh, true);
  assert.equal(document.getElementById("quoteStatus").className, "chip ok");
  assert.match(document.getElementById("stockRows").innerHTML, /1,100.00/);

  document.getElementById("quoteToggle").checked = false;
  await context.window.RiskTrackerApp.refreshAll();
  assert.equal(context.window.RiskTrackerApp.getState().quoteFresh, false);
  assert.equal(context.window.RiskTrackerApp.getState().quotes.size, 0);
  assert.equal(document.getElementById("quoteStatus").className, "chip");
  assert.doesNotMatch(document.getElementById("stockRows").innerHTML, /1,100.00/);
});

test("index.html supports no-backend direct EOD fallback", async () => {
  const { document } = await loadApp(createDirectEodFetchMock());

  assert.equal(document.getElementById("proxyBadge").textContent, "靜態資料模式");
  assert.equal(document.getElementById("proxyBadge").className, "chip warn");
  assert.equal(document.getElementById("eodStatus").textContent, "已載入");
  assert.equal(document.getElementById("eodStatus").className, "chip ok");
  assert.match(document.getElementById("stockRows").innerHTML, /2330/);
  assert.match(document.getElementById("stockRows").innerHTML, /1,000.00/);
  assert.match(document.getElementById("tableSource").textContent, /證交所 OpenAPI 直連/);
  assert.equal(document.getElementById("macroStatus").textContent, "靜態備援");
  assert.equal(document.getElementById("macroStatus").className, "chip warn");
  assert.equal(document.getElementById("filingsStatus").textContent, "已載入");
  assert.equal(document.getElementById("filingsStatus").className, "chip ok");
  assert.match(document.getElementById("filingsFeed").innerHTML, /無代理重大訊息/);
  assert.match(document.getElementById("filingsFeed").innerHTML, /無代理上櫃格式/);
});

test("index.html shows cached filings when direct filings fail", async () => {
  const storage = createLocalStorage({
    [FILINGS_CACHE_KEY]: JSON.stringify({
      savedAt: new Date().toISOString(),
      source: "測試重大訊息快取",
      delay: "測試暫存資料",
      sourceUpdatedAt: "2026-06-04T10:00:00+08:00",
      items: [
        {
          code: "2330",
          name: "台積電",
          date: "2026-06-04 10:00",
          title: "暫存重大訊息",
          source: "測試重大訊息快取",
          sortKey: "2026-06-04T10:00:00+08:00",
        },
      ],
    }),
  });

  const { document } = await loadApp(createFilingsFailureFetchMock(), { localStorage: storage });

  assert.equal(document.getElementById("filingsStatus").textContent, "顯示暫存");
  assert.equal(document.getElementById("filingsStatus").className, "chip warn");
  assert.match(document.getElementById("filingsFeed").innerHTML, /暫存重大訊息/);
  assert.match(document.getElementById("filingsFeed").innerHTML, /官方來源暫不可用/);
});

test("index.html uses same-origin static filings when direct filings fail without proxy", async () => {
  const { document } = await loadApp(createFilingsFailureFetchMock());

  assert.equal(document.getElementById("filingsStatus").textContent, "靜態備援");
  assert.equal(document.getElementById("filingsStatus").className, "chip warn");
  assert.match(document.getElementById("filingsFeed").innerHTML, /同源靜態重大訊息/);
  assert.match(document.getElementById("filingsSource").textContent, /GitHub Pages 同源重大訊息備援/);
});

test("index.html keeps EOD data when intraday quotes need proxy", async () => {
  const { context, document } = await loadApp(createDirectEodFetchMock());

  document.getElementById("quoteToggle").checked = true;
  await context.window.RiskTrackerApp.refreshAll();

  assert.equal(document.getElementById("quoteStatus").textContent, "需代理");
  assert.equal(document.getElementById("quoteStatus").className, "chip warn");
  assert.equal(context.window.RiskTrackerApp.getState().quoteFresh, false);
  assert.match(document.getElementById("stockRows").innerHTML, /1,000.00/);
});

test("index.html marks partial filings when one OpenAPI source fails", async () => {
  const { document } = await loadApp(createPartialFilingsFetchMock());

  assert.equal(document.getElementById("filingsStatus").textContent, "部分載入");
  assert.equal(document.getElementById("filingsStatus").className, "chip warn");
  assert.match(document.getElementById("filingsFeed").innerHTML, /部分來源重大訊息/);
  assert.match(document.getElementById("filingsFeed").innerHTML, /部分來源暫不可用/);
});

test("index.html uses backend filings only after direct failure without cache", async () => {
  const calls = [];
  const { document } = await loadApp(createProxyFallbackFetchMock(calls), {
    PROXY_BASE: "https://proxy.test",
  });

  assert.equal(document.getElementById("filingsStatus").textContent, "代理備援");
  assert.equal(document.getElementById("filingsStatus").className, "chip warn");
  assert.match(document.getElementById("filingsFeed").innerHTML, /代理備援重大訊息 2330/);
  assert.ok(calls.some((href) => href.includes("/filings?code=2330")));
});
