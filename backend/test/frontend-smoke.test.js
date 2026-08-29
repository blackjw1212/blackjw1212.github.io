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
    // 時戳必須相對於現在。原本寫死 2026-06-05，隨時間自然腐化成「過期資料」——
    // 加上過期警示後這份「正常 feed」的 fixture 會讓首頁亮 warn 而測試莫名其妙失敗。
    // 要測過期的測試自己用 overrides 傳舊時戳。
    updatedAt: hoursAgo(2),
    eodUpdatedAt: hoursAgo(3),
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
  assert.match(html, /href="\/flight\/"/);
  assert.match(html, /href="\/dash\/"/);
  assert.deepEqual(primaryLinks, [["stocks", "/stocks/"], ["weather", "/weather/"], ["esp32", "/esp32/"], ["forscan", "/forscan/"], ["flight", "/flight/"], ["dash", "/dash/"]]);
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

test("weather page links out to the Windy radar for the located point", async () => {
  const htmlPath = fileURLToPath(new URL("../../weather/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");

  assert.match(html, /www\.windy\.com\/-Weather-radar-radar\?radar,/);
  assert.match(html, /class="current-region-label radar-link"[\s\S]*?rel="noopener noreferrer"/);
  assert.match(html, /aria-label="\$\{esc\(radarHint\)\}"/);
  // 標籤要指向雷達真正對準的點，不是天氣卡的鄉鎮
  assert.match(html, /radarPt\?\.gps \? currentRegionLabel : selectedCoast\.label/);
  // 座標必須來自 GPS 或選單地區，不得寫死
  assert.match(html, /function radarPoint\(weatherInfo, coastCfg\)/);
  assert.doesNotMatch(html, /radar,\d+\.\d+,\d+\.\d+,/);
});

test("weather page picks the sea area from GPS, not a hard-coded default", async () => {
  const htmlPath = fileURLToPath(new URL("../../weather/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const has = (snippet) => assert.ok(html.includes(snippet), `weather page is missing: ${snippet}`);
  const lacks = (snippet) => assert.ok(!html.includes(snippet), `weather page should no longer contain: ${snippet}`);

  has("function autoCoastConfig(configs, weatherInfo)");
  // 三層：同鄉鎮 → 同縣市（內陸市對照）→ 全台最近
  has("const sameTown = pts.find(c => c.county === weatherInfo.county && c.baseTown === weatherInfo.location);");
  has("const county = INLAND_COUNTY_COAST[weatherInfo.county] || weatherInfo.county;");
  has("return nearest(pts);");
  // 原始定位座標必須離開 resolveGpsWeatherForecast，否則挑不了海域
  has("return { ...nearest, gps: true, gpsPos: pos };");
  // 舊的「使用者偏好」key 必須整組移除，否則舊值會把人永遠釘在東石
  for (const dead of ["SELECTED_COAST_KEY", "getStoredCoastName", "saveSelectedCoastName"]) lacks(dead);
  // 手動選取只存記憶體，不得寫進 localStorage（會污染定位失敗時的退路）
  has("manualCoastLabel = e.target.value;");
  assert.doesNotMatch(html, /manualCoastLabel[^\n]{0,80}localStorage/);
  // 只有定位成功且非手動時才回寫
  has("if (weatherInfo.gpsPos && !manualCoastLabel) saveAutoCoastName(selectedCoast.label);");
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
    "scoreTable", "scoreBody", "stockCards", "dataSource",
    "watchAdd", "watchAddBtn", "watchReset", "watchShare",
    "watchCount", "watchShared", "watchNote",
    "headerMarketQuotes", "headerQuoteTaiex", "headerQuoteTaiexValue", "headerQuoteTaiexChange",
    "headerQuoteTaiexStatus", "headerQuoteTpex", "headerQuoteTpexValue", "headerQuoteTpexChange",
    "headerQuoteTpexStatus", "headerQuoteStatus",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `${id} should exist in static HTML`);
  }
  // 頁面已收斂成「頁首指數卡 + 觀察清單」：決策卡、自動檢核表、配置分層區、
  // 狀態列、分層與觀察價全部移除。留著任何一個 id 就代表死碼又長回來了。
  for (const gone of [
    "verdictLight", "verdictTitle", "verdictDesc", "actionNext", "actionAvoid",
    "signalSummary", "conds", "buckets", "watchChips", "refresh", "stamp", "watchTier",
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${gone}["']`), `${gone} should be gone`);
  }
  // 欄位與 /market/ 對齊，且每欄都可點表頭排序
  for (const key of ["code", "name", "close", "dayPct", "pe", "pbRatio",
    "dividendYield", "fromHi", "turnover"]) {
    assert.match(html, new RegExp(`data-sort="${key}"`), `${key} column should be sortable`);
  }
  // 分層與觀察價已整套移除，欄位不得復活（只看可見標記，註解不算）
  const markup = html.slice(html.indexOf("<body>"), html.lastIndexOf("<script>"));
  assert.doesNotMatch(html, /data-sort="tier"|data-sort="pctFromObservation"/);
  assert.doesNotMatch(markup, /距離觀察基準|系統觀察價|預設參考值|分層/);
  assert.doesNotMatch(html, /function suggestObservationPrice|function marketDefenseMode|function tierSelectHtml/);
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
  // 移除鈕不是 .btn，窄螢幕的 44px 觸控目標要另外補
  assert.match(html, /@media \(max-width:760px\)[\s\S]*\.row-del\{min-height:44px\}/);
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
    "stockMetrics",
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
  assert.match(cardHtml, /台積電/);
  // 觀察價那一整套已移除，任何殘留字樣都代表死碼長回來
  assert.doesNotMatch(scoreHtml, /觀察價|預設參考值|個人參考基準|防守模式/);
  assert.doesNotMatch(cardHtml, /觀察價|預設參考值|個人參考基準|防守模式/);
  assert.match(scoreHtml, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.match(cardHtml, /https:\/\/tw\.tradingview\.com\/chart\/\?symbol=TWSE%3A2330/);
  assert.doesNotMatch(scoreHtml, /\/technicals\//);
  assert.match(scoreHtml, /target="_blank"/);
  assert.match(cardHtml, /rel="noopener noreferrer"/);
  assert.match(scoreHtml, /aria-label="在 TradingView 開啟 2330 台積電完整圖表觀察（外部連結）"/);
  // 移除鈕在每一列上；分層選單已整套移除
  assert.match(scoreHtml, /data-watch-del="2330"/);
  assert.match(cardHtml, /data-watch-del="2330"/);
  assert.doesNotMatch(scoreHtml, /data-watch-tier|tier-pick/);
  assert.doesNotMatch(cardHtml, /data-watch-tier|tier-pick/);
  assert.match(document.getElementById("dataSource").textContent, /靜態 stock-risk-feed\.json/);
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

  // 自訂清單：可增、可刪
  h.setMarketRowsForTest({ "2454": { code: "2454", name: "聯發科", close: 3865, pe: 64.57 } });
  const stocks = h.setWatchlistForTest([{ code: "2330" }, { code: "2454" }]);
  assert.deepEqual(Array.from(h.stockCodes()), ["2330", "2454"]);
  const custom = stocks.find((s) => s.code === "2454");
  assert.equal(custom.name, "聯發科", "名稱由 market-feed 補");
  assert.equal(custom.custom, true);
  // 數字一律不寫進 STOCKS：收盤／PE／PB／殖利率全部在 render 時取，
  // 寫死在標的物件上只會過期
  assert.equal(custom.pe, undefined);
  const kept = stocks.find((s) => s.code === "2330");
  assert.equal(kept.pe, undefined);
  assert.equal(kept.base, undefined);
  assert.equal(kept.tier, undefined, "分層已移除");
  assert.match(kept.role, /先進製程/, "內建保留的只有人工那句說明");
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

  // 去重、代碼格式；舊存檔帶的 tier 忽略但代碼要留下
  const out = sanitizeWatchlist([
    { code: "2330", tier: "core" },          // 舊欄位 → 忽略 tier，收代碼
    { code: "2330", tier: "wait" },          // 重複 → 丟掉
    { code: "2454" },
    { code: "00878" },                        // 5 碼 ETF → 不是個股代碼，丟掉
    "3231",                                   // 純字串也接受
  ]);
  assert.deepEqual(Array.from(out).map((e) => e.code), ["2330", "2454", "3231"]);
  assert.equal(out[0].tier, undefined, "舊存檔的分層不得被搬進來");

  // 上限保護
  const many = Array.from({ length: 80 }, (_, i) => ({ code: String(1000 + i) }));
  assert.ok(sanitizeWatchlist(many).length <= 40, "清單要有上限");
});

// 自行加入的標的沒有任何人工欄位，所有數字都得從 market-feed 算出來，
// 否則使用者加了一檔就得到一整列「—」
test("a user-added stock gets every metric from the market feed", async () => {
  const { context } = await loadApp(async () => response(staticFeed()));
  const h = context.window.PortfolioConsoleApp.helpers;
  h.setMarketRowsForTest({ "2454": {
    code: "2454", name: "聯發科", market: "twse", close: 1395, change: 15,
    pe: 18.62, pbRatio: 3.41, dividendYield: 4.73, hi52: 1650, volume: 5_000_000,
  } });
  const stock = h.setWatchlistForTest([{ code: "2454" }])[0];
  const m = h.stockMetrics(stock, { close: 1395 });
  assert.equal(m.market, "上市");
  assert.equal(m.pe, 18.62);
  assert.equal(m.pbRatio, 3.41);
  assert.equal(m.dividendYield, 4.73);
  assert.equal(m.fromHi, -15.5, "(1395-1650)/1650 = -15.45% → -15.5");
  assert.equal(m.turnover, 69.75, "1395 × 5,000,000 / 1e8 = 69.75 億");
});

// PB／殖利率整張表都取自 market-feed，而估值來源比收盤晚一步發佈。
// 這件事以前完全沒被講出來，使用者無從分辨那兩欄是哪一天的股價算的。
test("the source line discloses when market-feed valuation lags the close", async () => {
  const feedWith = (extra) => async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) {
      return response(Object.assign({
        updatedAt: "2026-08-06T01:30:00.000Z",
        tradeDate: "2026-08-05",
        count: 1,
        stocks: [{ code: "2330", name: "台積電", market: "twse", close: 2405, change: 85, pe: 31.19, pbRatio: 10.21, dividendYield: 0.95, hi52: 2535, volume: 1000 }],
        errors: [],
      }, extra));
    }
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  };

  // 上市收盤 08-06、估值 08-05，差一個交易日 → 換算得回來，要說「已換算」並附原始日期。
  // 注意頂層 tradeDate 與 valuationDate 都會是 08-05（各取最小值），
  // 只比那兩個欄位會完全漏報，所以這裡刻意讓它們相等。
  const lag = await loadApp(feedWith({
    valuationDate: "2026-08-05",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-05" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
  }));
  await lag.context.window.PortfolioConsoleApp.init();
  assert.match(lag.document.getElementById("dataSource").textContent,
    /PE／PB／殖利率已換算至本頁收盤/);

  // 落差超過可換算的範圍（close-change 已不是估值那天的收盤）→ 只揭露、不換算。
  // 說成「已換算」會是假的。
  const wide = await loadApp(feedWith({
    valuationDate: "2026-07-20",
    marketDates: { twse: "2026-08-06", tpex: "2026-08-06" },
    valuationDates: { twse: "2026-07-20", tpex: "2026-07-20" },
  }));
  await wide.context.window.PortfolioConsoleApp.init();
  const wideText = wide.document.getElementById("dataSource").textContent;
  assert.match(wideText, /PE／PB／殖利率為 上市 2026-07-20、上櫃 2026-07-20 的估值/);
  assert.doesNotMatch(wideText, /已換算/);
  assert.match(wide.document.getElementById("scoreBody").innerHTML, /<td class="num">31\.19<\/td>/, "不可換算時照原值顯示");

  // 對齊時不加噪音
  const aligned = await loadApp(feedWith({
    valuationDate: "2026-08-05",
    marketDates: { twse: "2026-08-05", tpex: "2026-08-05" },
    valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
  }));
  await aligned.context.window.PortfolioConsoleApp.init();
  assert.doesNotMatch(aligned.document.getElementById("dataSource").textContent, /估值/);

  // 舊 feed（沒有 valuationDates）不得炸掉也不得憑空講落差
  const legacy = await loadApp(feedWith({ marketDates: { twse: "2026-08-05" } }));
  await legacy.context.window.PortfolioConsoleApp.init();
  assert.doesNotMatch(legacy.document.getElementById("dataSource").textContent, /估值|undefined/);
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
  // 自行加入的代碼其價格要留得住——早期版本只認內建代碼，一存檔就被清掉
  assert.equal(saved.today["2454"].close, 3865);
  // 分層與觀察價的預設值已移除，舊存檔帶的這兩個欄位不得被搬進來
  assert.equal(saved.base, undefined);
  assert.equal(saved.watchlist[0].tier, undefined);
});

// PE 以前有兩個來源：stock-risk-feed 的 valuation（只有內建 13 檔）優先、
// market-feed（1,463 檔）墊底，兩邊給不同數字而畫面說不出原因。實際上那不是兩個
// 來源——都出自 BWIBBU_ALL，差別只在抓取時機造成的分母不同。換算到同一個收盤後
// 兩者相等，所以只留涵蓋面大的那一份。
test("PE comes from market-feed alone and is rescaled to the page's close", async () => {
  const mock = async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) {
      return response({
        updatedAt: "2026-08-06T01:30:00.000Z",
        tradeDate: "2026-08-05",
        marketDates: { twse: "2026-08-06", tpex: "2026-08-05" },
        valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
        count: 1,
        // 這一列就是實測值：收盤 2,405、漲跌 +85 → 前一日收盤 2,320，
        // 而 pe 31.19 正是以 2,320 為分母算的。
        stocks: [{ code: "2330", name: "台積電", market: "twse", close: 2405, change: 85,
                   pe: 31.19, pbRatio: 10.21, dividendYield: 0.95, hi52: 2535, volume: 1000 }],
        errors: [],
      });
    }
    if (href.startsWith("/data/stock-risk-feed.json")) {
      // 舊的第二來源即使還在 feed 裡也不得被採用
      return response(staticFeed({ valuation: { "2330": { code: "2330", pe: 25.3 } } }));
    }
    throw new Error(`unavailable: ${href}`);
  };
  const { context, document } = await loadApp(mock);
  await context.window.PortfolioConsoleApp.init();
  const html = document.getElementById("scoreBody").innerHTML;

  // 分子是**畫面正在顯示的收盤**，不是 market-feed 的收盤：本頁優先用 13:30 快照
  // （這裡 staticFeed 給的 2,400.25），比 market-feed 的 2,405 更新一步。
  // 顯示的 PE 必須對應顯示的收盤，否則同一列的兩個數字互相矛盾。
  //   31.19 × 2400.25/2320 = 32.27
  assert.match(html, /<td class="num">32\.27<\/td>/, "PE 要換算到畫面上的收盤");
  assert.doesNotMatch(html, /31\.19/, "不得顯示以前一日收盤為分母的原值");
  assert.doesNotMatch(html, /25\.3/, "stock-risk-feed 的第二份 PE 已移除，不得復活");
  // PB 與股價同向、殖利率反向
  assert.match(html, /<td class="num">10\.56<\/td>/, "10.21 × 2400.25/2320 = 10.56");
  assert.match(html, /<td class="num">0\.92<\/td>/, "0.95 × 2320/2400.25 = 0.92");

  // 完全沒有 market-feed → 顯示破折號，不得退回任何寫死的靜態標籤
  const noFeed = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/stock-risk-feed.json")) return response(staticFeed());
    throw new Error(`unavailable: ${href}`);
  });
  await noFeed.context.window.PortfolioConsoleApp.init();
  const bare = noFeed.document.getElementById("scoreBody").innerHTML;
  assert.doesNotMatch(bare, /~32|~19/, "寫死的靜態 PE 標籤已移除");
  assert.match(bare, /<td class="num">—<\/td>/);
});

// 不變量：顯示的 PE 永遠對應顯示的收盤。分母已經等於顯示價時 k=1，不得再乘一次。
test("valuation is left alone when its denominator already equals the shown close", async () => {
  const mock = (feedClose, pageClose, dates) => async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) {
      return response(Object.assign({
        updatedAt: "2026-08-06T14:00:00.000Z", tradeDate: "2026-08-06", count: 1,
        stocks: [{ code: "2330", name: "台積電", market: "twse", close: feedClose, change: 85,
                   pe: 32.33, pbRatio: 10.59, dividendYield: 0.91, hi52: 2535, volume: 1000 }],
        errors: [],
      }, dates));
    }
    if (href.startsWith("/data/stock-risk-feed.json")) {
      return response(staticFeed({ eod: [{ code: "2330", name: "台積電", close: pageClose, change: 85 }] }));
    }
    throw new Error(`unavailable: ${href}`);
  };
  const aligned = { marketDates: { twse: "2026-08-06", tpex: "2026-08-06" },
                    valuationDates: { twse: "2026-08-06", tpex: "2026-08-06" } };

  // 估值日＝feed 收盤日，且本頁收盤就是 feed 收盤 → 分母已對齊，照原值
  const same = await loadApp(mock(2405, 2405, aligned));
  await same.context.window.PortfolioConsoleApp.init();
  assert.match(same.document.getElementById("scoreBody").innerHTML, /<td class="num">32\.33<\/td>/, "分母已對齊就照原值");
  assert.doesNotMatch(same.document.getElementById("dataSource").textContent, /換算|估值/);

  // feed 內部日期一致，但本頁收盤更新一步（13:30 快照）→ 仍要換算，
  // 否則同一列顯示的收盤與 PE 各自對應不同的價格。這正是 3324 的情形：
  // 畫面 1,060、feed 965，只看 feed 內部日期會誤判成「不必換算」。
  const fresher = await loadApp(mock(965, 1060, aligned));
  await fresher.context.window.PortfolioConsoleApp.init();
  const html = fresher.document.getElementById("scoreBody").innerHTML;
  assert.match(html, /<td class="num">35\.51<\/td>/, "32.33 × 1060/965 = 35.51");
  assert.doesNotMatch(html, /32\.33/, "不得留著以 feed 舊收盤為分母的原值");
  assert.match(fresher.document.getElementById("dataSource").textContent, /已換算至本頁收盤/);
});

// 原本 PE 與人工說明散在配置分層區；配置區移除後這些要在同一列（或同一張卡）
// 上看得到，否則等於功能被刪掉而不是被合併。
test("each row carries live PE, live close, and the manual role note", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.startsWith("/data/market-feed.json")) {
      return response({
        updatedAt: "2026-08-05T14:00:00.000Z",
        tradeDate: "2026-08-05",
        marketDates: { twse: "2026-08-05", tpex: "2026-08-05" },
        valuationDates: { twse: "2026-08-05", tpex: "2026-08-05" },
        count: 1,
        stocks: [{ code: "2308", name: "台達電", market: "twse", close: 1905, change: -5, pe: 66.7, volume: 1000 }],
        errors: [],
      });
    }
    if (href.startsWith("/data/stock-risk-feed.json")) {
      return response(staticFeed({
        eod: [{ code: "2308", name: "台達電", close: 1905, change: -5, high: 1950, low: 1880 }],
      }));
    }
    throw new Error(`unavailable: ${href}`);
  });
  await context.window.PortfolioConsoleApp.init();
  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /<td class="num">66\.7<\/td>/);               // live feed PE
  assert.match(scoreHtml, /1,905/);                                     // live close
  assert.match(scoreHtml, /data-watch-del="2308"/);
  assert.match(cardHtml, /電源、散熱/);                                   // manual role text retained
});

// 全部來源都失敗時要老實說「待更新」，不能拿舊值或 0 充數
test("rows fall back to 待更新 when no closing data is available", async () => {
  const { context, document } = await loadApp(async (url) => {
    throw new Error(`unavailable: ${url}`);
  });

  await context.window.PortfolioConsoleApp.init();

  const scoreHtml = document.getElementById("scoreBody").innerHTML;
  const cardHtml = document.getElementById("stockCards").innerHTML;
  assert.match(scoreHtml, /<span class="stale">待更新<\/span>/);
  assert.match(scoreHtml, /<td class="num flat">—<\/td>/, "漲跌%無資料要顯示破折號而不是 0");
  assert.match(cardHtml, /待更新/);
  assert.doesNotMatch(scoreHtml, /NaN|undefined|>0<\/td>/);
  assert.match(document.getElementById("dataSource").textContent, /收盤資料待更新|收盤來源/);
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
  // 指數卡才是指數的去處；狀態列已移除
  assert.equal(document.getElementById("headerQuoteTaiexValue").textContent, "42,686.84");
  assert.equal(document.getElementById("headerQuoteTaiexChange").textContent, "+2,387.10 / +5.92%");
  assert.match(document.getElementById("headerQuoteTaiexChange").className, /pos/);
  assert.equal(document.getElementById("headerQuoteTpexValue").textContent, "397.81");
  assert.match(document.getElementById("headerQuoteTpexChange").className, /neg/);
  assert.match(document.getElementById("headerQuoteTaiexStatus").textContent, /TWSE MIS/);
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
  assert.ok(calls.some((href) => href.includes("/quote?codes=")));
  assert.doesNotMatch(scoreHtml, /2,365/, "OpenAPI 那份較舊的收盤不得出現");
  assert.match(scoreHtml, /2,295/);
  assert.match(scoreHtml, /1,095/);
  // 收盤來源對整張表都一樣，改成放一次；不可因為「看起來重複」就整個拿掉
  assert.match(document.getElementById("dataSource").textContent, /收盤來源：.*TWSE MIS closing quote/);
});

// 大盤重挫時指數卡要照實顯示紅字，不得因為「看起來不好看」而被吞掉
test("falling market indices render as negative on the header cards", async () => {
  const { context, document } = await loadApp(async (url) => {
    const href = String(url);
    if (href.includes("/quote?codes=")) return response({ quotes: completeMisClosingQuotes() });
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

  assert.equal(document.getElementById("headerQuoteTaiexValue").textContent, "42,100");
  assert.equal(document.getElementById("headerQuoteTaiexChange").textContent, "-1,200.00 / -2.80%");
  assert.match(document.getElementById("headerQuoteTaiexChange").className, /neg/);
  assert.match(document.getElementById("headerQuoteTpexChange").className, /neg/);
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

  // 指數掛掉不得連坐清單：收盤照顯示，指數卡自己講「暫無法更新」
  assert.match(document.getElementById("scoreBody").innerHTML, /2,410/);
  assert.equal(document.getElementById("headerQuoteTaiexValue").textContent, "待更新");
  assert.match(document.getElementById("headerQuoteTaiexStatus").textContent, /暫無法更新/);
  assert.match(document.getElementById("headerQuoteTaiexStatus").className, /error/);
  assert.doesNotMatch(document.getElementById("dataSource").textContent, /NaN|undefined/);
});

// 舊存檔還留著已移除的 10Y／條件／觀察價欄位；sanitizeState 要把它們丟掉
// 而不是原樣搬進來，否則死欄位會一直跟著存檔複製下去。
test("legacy 10Y, checklist, and observation fields are dropped from stored state", async () => {
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
        watchlist: [{ code: "2330", tier: "core" }, { code: "2454", tier: "wait" }],
      }),
    }),
  });

  await context.window.PortfolioConsoleApp.init();

  const state = context.window.PortfolioConsoleApp.getState();
  for (const gone of ["cond", "condSource", "yieldManual", "yieldMeta", "base"]) {
    assert.equal(state[gone], undefined, `${gone} 應該被丟掉`);
  }
  // 清單本身要活下來，只是分層被丟掉
  assert.deepEqual(Array.from(state.watchlist).map((e) => e.code), ["2330", "2454"]);
  assert.equal(state.watchlist[0].tier, undefined);
  assert.equal(state.today["2330"].close, 2410, "還在用的欄位不能被一起清掉");
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
  assert.match(document.getElementById("dataSource").textContent, /本機快取/);
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

// ── 資料過期警示 ────────────────────────────────────────────────
// 起因：feed workflow 用 GITHUB_TOKEN 推的 commit 不會觸發 on:push 的 pages-deploy，
// 資料進得了 repo 卻上不了線。實測 2026-08-10 線上停在 08-07、repo 已是當日，
// 3 天沒人發現。這幾條測的是「下次會被看見」。

// 用相對於現在的時間造樣本，就不必去 mock 時鐘
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// 三頁各有一份 helper（本站無打包器，isPreviousTradingDay 本來就是這樣重複的）。
// 這條擋的是日後只改其中一份造成的分叉——比照 dividendCv() 在資料層與前端互驗的做法。
async function stalenessHelpers() {
  const home = await loadHome(async () => response(staticFeed()));
  const stocks = await loadApp(async () => response(staticFeed()));
  const marketPath = fileURLToPath(new URL("../../market/index.html", import.meta.url));
  const marketHtml = await readFile(marketPath, "utf8");
  const marketScript = marketHtml.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(marketScript, "market inline script should be present");
  const marketWindow = { __MARKET_SKIP_AUTO_INIT__: true, location: { href: "https://local.test/", search: "" } };
  const marketCtx = vm.createContext({
    console, document: createDocument().document, fetch: async () => response({}),
    Headers, Intl, URL, URLSearchParams, setTimeout, clearTimeout, window: marketWindow,
  });
  vm.runInContext(marketScript, marketCtx, { filename: "market-index.html" });
  return {
    "index.html": home.context.stalenessNote,
    "stocks/index.html": stocks.context.window.PortfolioConsoleApp.helpers.stalenessNote,
    "market/index.html": marketWindow.MarketApp.helpers.stalenessNote,
  };
}

test("all three pages agree on when data counts as stale", async () => {
  const helpers = await stalenessHelpers();
  const names = Object.keys(helpers);
  assert.equal(names.length, 3);
  for (const name of names) {
    assert.equal(typeof helpers[name], "function", `${name} 缺少 stalenessNote`);
  }
  // 逐個時點比對三份輸出必須逐字相同，任何一頁被改動都會當場失敗
  for (const h of [1, 24, 59, 71, 73, 100, 200]) {
    const at = hoursAgo(h);
    const outputs = names.map((n) => helpers[n](at));
    assert.equal(new Set(outputs).size, 1,
      `${h} 小時前的判定三頁不一致：${JSON.stringify(Object.fromEntries(names.map((n, i) => [n, outputs[i]])))}`);
  }
});

test("a normal weekend gap does not raise a false alarm", async () => {
  const helpers = await stalenessHelpers();
  for (const [name, fn] of Object.entries(helpers)) {
    // 最長的正常間隔：週五 22:00 → 週一 09:00 台北 ＝ 59 小時
    assert.equal(fn(hoursAgo(59)), "", `${name}: 正常週末不可誤報，否則每週一都在喊狼來了`);
    assert.equal(fn(hoursAgo(71)), "", `${name}: 門檻 72 小時之內都不該亮`);
  }
});

test("a genuinely broken pipeline is called out with how old the data is", async () => {
  const helpers = await stalenessHelpers();
  for (const [name, fn] of Object.entries(helpers)) {
    const note = fn(hoursAgo(80));
    assert.match(note, /3 天未更新/, `${name}: 要說得出過期幾天，只說「過期」使用者無從判斷嚴重性`);
    // 連假期間資料確實就是那麼舊，警示是誠實的——但要讓人分得出兩種可能
    assert.match(note, /連假/, `${name}: 要說明也可能是連假，否則使用者以為系統壞了`);
    assert.match(note, /中斷/, `${name}: 也要說明可能是更新流程中斷`);
  }
});

test("a missing or unparsable timestamp stays silent instead of guessing", async () => {
  const helpers = await stalenessHelpers();
  for (const [name, fn] of Object.entries(helpers)) {
    assert.equal(fn(""), "", `${name}: 沒有時戳就無從判斷，不可猜`);
    assert.equal(fn(null), "", `${name}: null 不可當成很舊`);
    assert.equal(fn("not a date"), "", `${name}: 解析不了不可當成很舊`);
  }
});

test("the home page replaces the reassuring date stamp when data is stale", async () => {
  // 「08/07 收盤」在今天是 08/10 時看起來一切正常——那正是 3 天沒被發現的原因
  const stale = staticFeed({ eodUpdatedAt: hoursAgo(80), updatedAt: hoursAgo(80) });
  const { document } = await loadHome(async () => response(stale));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const meta = document.getElementById("stockFeedMeta").textContent;
  assert.match(meta, /資料已 3 天未更新/, "過期時必須蓋掉平常的日期標示");
  assert.doesNotMatch(meta, /收盤$/, "不可還顯示成正常的收盤標示");
});

test("the home page shows the ordinary stamp when data is fresh", async () => {
  const fresh = staticFeed({ eodUpdatedAt: hoursAgo(2), updatedAt: hoursAgo(2) });
  const { document } = await loadHome(async () => response(fresh));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const meta = document.getElementById("stockFeedMeta").textContent;
  assert.doesNotMatch(meta, /未更新/, "新鮮資料不可亮警示，否則警示會被當成常態而失效");
});
