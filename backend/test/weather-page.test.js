import test from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 只為了測位置快取。天氣頁的主體要 DOM 與網路，這裡一律給空殼——
// __WEATHER_SKIP_AUTO_INIT__ 擋掉 loadAll()，所以不會真的去抓資料。
async function loadHelpers(store, nav) {
  const html = await readFile(join(ROOT, "weather", "index.html"), "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "行內主程式必須緊貼 </body>");

  const noop = () => {};
  const el = new Proxy({}, { get: () => noop, set: () => true });
  const window = {
    __WEATHER_SKIP_AUTO_INIT__: true,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => Promise.reject(new Error("no network")),
  };
  const context = vm.createContext({
    console, window, localStorage: window.localStorage,
    document: {
      readyState: "complete", addEventListener: noop, getElementById: () => el,
      querySelector: () => el, querySelectorAll: () => [], createElement: () => el,
      body: el, documentElement: el,
    },
    navigator: nav || { geolocation: null, userAgent: "test" },
    location: { href: "http://localhost/weather/", search: "" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: window.fetch, Math, Date, isFinite, parseFloat, parseInt, Number, String,
    Array, Object, JSON, Error, Promise, Intl, RegExp, Map, Set,
  });
  context.globalThis = context;
  context.self = context;
  vm.runInContext(script, context, { filename: "weather/index.html" });
  assert.ok(window.WeatherApp, "WeatherApp 應該掛在 window 上");
  return window.WeatherApp.helpers;
}

const FIX = { lat: 23.469, lon: 120.455 };

test("a fresh stored fix is reused so the page never re-asks for location", async () => {
  // iOS 的位置權限若是「僅允許一次」，只要再呼叫一次定位就會再問。這一頁改成
  // 有夠新的快取就完全不呼叫，重新整理才不會又跳提示。
  const store = {};
  const h = await loadHelpers(store);
  h.rememberFix(FIX.lat, FIX.lon);
  const got = h.readStoredFix();
  assert.deepEqual({ lat: got.lat, lon: got.lon }, FIX);
  assert.equal(typeof got.at, "number");
});

test("a stale fix is discarded rather than used to pick the wrong station", async () => {
  const store = {
    "bjkw-weather-last-fix": JSON.stringify({ ...FIX, at: Date.now() - 13 * 60 * 60 * 1000 }),
  };
  const h = await loadHelpers(store);
  assert.equal(h.readStoredFix(), null);
});

test("malformed or out-of-range storage is discarded", async () => {
  for (const raw of ["", "not json", "[]", "{}", '{"lat":"x","lon":2,"at":1}',
    '{"lat":91,"lon":2,"at":1}', '{"lat":23,"lon":181,"at":1}',
    '{"lat":null,"lon":null,"at":1}']) {
    const h = await loadHelpers({ "bjkw-weather-last-fix": raw });
    assert.strictEqual(h.readStoredFix(), null, `raw=${raw}`);
  }
});

test("a fix timestamped in the future is discarded", async () => {
  const h = await loadHelpers({
    "bjkw-weather-last-fix": JSON.stringify({ ...FIX, at: Date.now() + 60000 }),
  });
  assert.equal(h.readStoredFix(), null);
});

// ─── 潮況：只用官方滿乾潮時刻，不推估中間潮位 ───────────────────
const at = (hhmm) => new Date(`2026-09-23T${hhmm}:00+08:00`);
const TIDES = [
  { dt: at("01:49"), isHi: false, h: 24 },
  { dt: at("07:52"), isHi: true, h: 125 },
  { dt: at("14:21"), isHi: false, h: -32 },
  { dt: at("21:07"), isHi: true, h: 121 },
];

test("the tide is rising when the next official extreme is a high tide", async () => {
  const h = await loadHelpers({});
  const s = h.tideNowState(TIDES, at("05:30"));
  assert.equal(s.rising, true);
  assert.equal(s.next.h, 125);
  assert.equal(s.minutes, 142);
});

test("the tide is falling when the next official extreme is a low tide", async () => {
  const h = await loadHelpers({});
  const s = h.tideNowState(TIDES, at("09:00"));
  assert.equal(s.rising, false);
  assert.equal(s.next.h, -32);
});

test("after the last listed extreme there is no tide state rather than a guess", async () => {
  const h = await loadHelpers({});
  assert.equal(h.tideNowState(TIDES, at("22:00")), null);
});

test("tidal range is the largest gap between an adjacent high and low", async () => {
  const h = await loadHelpers({});
  // 125 − (−32) = 157 與 121 − (−32) = 153、125 − 24 = 101 之中取最大
  assert.equal(h.maxTideRange(TIDES), 157);
  assert.equal(h.maxTideRange([TIDES[0]]), null);
});

// ─── 官方流速：「-」是缺值，不是 0 ─────────────────────────────
test("ocean current keeps the official value and treats a dash as missing", async () => {
  const h = await loadHelpers({});
  assert.deepEqual(
    h.oceanCurrent({ OceanCurrentSpeed: "0.5" }, { OceanCurrentDirection: "偏南" }),
    { speed: 0.5, dir: "偏南" },
  );
  assert.deepEqual(h.oceanCurrent({ OceanCurrentSpeed: "-" }, { OceanCurrentDirection: "-" }), { speed: null, dir: null });
  assert.deepEqual(h.oceanCurrent(null, null), { speed: null, dir: null });
});

// ─── 測站：陣風只有少數站回報，-99 不可以變成數字 ───────────────
test("station gust and pressure drop the -99 sentinel instead of printing it", async () => {
  const h = await loadHelpers({});
  assert.deepEqual(
    h.stationExtras({ AirPressure: "1014.0", GustInfo: { PeakGustSpeed: "8.8" } }),
    { pressure: 1014, gust: 8.8 },
  );
  assert.deepEqual(
    h.stationExtras({ AirPressure: "-99", GustInfo: { PeakGustSpeed: "-99" } }),
    { pressure: null, gust: null },
  );
});

// ─── 警特報 ───────────────────────────────────────────────────
const COUNTY_WARN = { records: { location: [
  { locationName: "嘉義縣", hazardConditions: { hazards: [{ info: { phenomena: "陸上強風", significance: "特報" } }] } },
  { locationName: "臺北市", hazardConditions: { hazards: [{ info: { phenomena: "大雨", significance: "特報" } }] } },
  { locationName: "嘉義市", hazardConditions: { hazards: [] } },
] } };

test("county warnings are limited to the counties the page is about", async () => {
  const h = await loadHelpers({});
  const list = h.countyHazards(COUNTY_WARN, ["嘉義縣", "嘉義市"]);
  assert.equal(list.length, 1);
  assert.equal(list[0].county, "嘉義縣");
  assert.equal(list[0].text, "陸上強風特報");
  assert.deepEqual(h.countyHazards(null, ["嘉義縣"]), []);
});

test("an expired or lifted typhoon bulletin is not shown as an active warning", async () => {
  const h = await loadHelpers({});
  const now = new Date("2026-09-23T22:00:00+08:00");
  const data = { records: { info: [
    { headline: "解除颱風警報", urgency: "Past", expires: "2026-09-24T01:00:00+08:00" },
    { headline: "海上颱風警報", urgency: "Immediate", expires: "2026-09-23T20:00:00+08:00" },
    { headline: "海上陸上颱風警報", urgency: "Immediate", expires: "2026-09-24T01:00:00+08:00", web: "https://www.cwa.gov.tw/V8/C/P/Warning/FIFOWS.html" },
  ] } };
  const active = h.activeTyphoonAlerts(data, now);
  assert.equal(active.length, 1);
  assert.equal(active[0].headline, "海上陸上颱風警報");
  assert.deepEqual(h.activeTyphoonAlerts(null, now), []);
});

test("warnings lower the fishing verdict but never raise it", async () => {
  const h = await loadHelpers({});
  const ok = { cls: "ok", main: "可岸釣" };
  const MAIN = { caution: "看場況", danger: "先暫緩" };
  const wind = h.warningFloor([{ text: "陸上強風特報", phenomena: "陸上強風" }], []);
  assert.equal(wind, "danger");
  assert.equal(h.warningFloor([{ phenomena: "大雨" }], []), "caution");
  assert.equal(h.warningFloor([], [{ headline: "海上颱風警報" }]), "danger");
  assert.equal(h.warningFloor([], []), null);
  assert.deepEqual(h.applyWarningFloor(ok, "danger", MAIN), { cls: "danger", main: "先暫緩" });
  // 已經是更嚴重的判斷時不得被調鬆
  const danger = { cls: "danger", main: "先暫緩" };
  assert.deepEqual(h.applyWarningFloor(danger, "caution", MAIN), danger);
  // 缺資料時仍要被警報拉到危險——警報本身就是確定的資訊
  assert.deepEqual(h.applyWarningFloor({ cls: "unknown", main: "看資料" }, "danger", MAIN), { cls: "danger", main: "先暫緩" });
});

// ─── 整合：真的跑一次 loadAll()，看畫面有沒有走到警報那條路 ───────
// 純函式測過不等於渲染有用到它（CLAUDE.md「純函式測過不等於畫面走那條路」）。
// 除了警報以外的 feed 一律讓它失敗，頁面本來就要能在那種狀況下降級渲染。
async function renderWith(responses) {
  const html = await readFile(join(ROOT, "weather", "index.html"), "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  const noop = () => {};
  const makeEl = () => {
    const o = {
      style: { setProperty: noop }, options: [], selectedOptions: [],
      appendChild: (c) => { o.options.push(c); }, setAttribute: noop, addEventListener: noop,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      querySelector: () => null, querySelectorAll: () => [],
    };
    return o;
  };
  const els = { content: makeEl(), meta: makeEl(), coastSelect: makeEl() };
  const store = {};
  const fetchStub = async (url) => {
    const id = String(url).match(/\/(?:api|file)\/([^?]+)/)?.[1];
    if (!(id in responses)) throw new Error(`offline: ${id}`);
    return { ok: true, status: 200, json: async () => responses[id] };
  };
  const window = {
    __WEATHER_SKIP_AUTO_INIT__: true,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
  };
  const context = vm.createContext({
    console: { ...console, warn: noop }, window, localStorage: window.localStorage,
    document: {
      readyState: "complete", addEventListener: noop,
      getElementById: (id) => els[id] || makeEl(),
      querySelector: () => null, querySelectorAll: () => [], createElement: makeEl,
      body: makeEl(), documentElement: makeEl(),
    },
    navigator: { geolocation: null, userAgent: "test" },
    location: { href: "http://localhost/weather/", search: "" },
    getComputedStyle: () => ({ font: "", paddingLeft: "0", paddingRight: "0", borderLeftWidth: "0", borderRightWidth: "0" }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
    fetch: fetchStub, Math, Date, isFinite, parseFloat, parseInt, Number, String,
    Array, Object, JSON, Error, Promise, Intl, RegExp, Map, Set,
  });
  context.globalThis = context;
  context.self = context;
  vm.runInContext(script, context, { filename: "weather/index.html" });
  await context.loadAll();
  return els.content.innerHTML;
}

const WIND_WARNING = {
  "W-C0033-001": { records: { location: [
    { locationName: "嘉義縣", hazardConditions: { hazards: [{ info: { phenomena: "陸上強風", significance: "特報" } }] } },
  ] } },
  "W-C0034-001": { records: { info: [] } },
};

test("an active strong-wind warning shows a banner and downgrades both verdicts", async () => {
  const out = await renderWith(WIND_WARNING);
  assert.doesNotMatch(out, /err-box/, "頁面不應該整頁掛掉");
  assert.match(out, /class="alert-banner"/);
  assert.match(out, /嘉義縣陸上強風特報/);
  assert.match(out, /decision-line danger">\s*<div class="decision-label">岸邊釣魚<\/div>\s*<div class="decision-main">先暫緩/);
  assert.match(out, /decision-line danger">\s*<div class="decision-label">出船<\/div>/);
  assert.match(out, /初判已調降/);
});

test("with no active warning there is no banner and the verdict is left alone", async () => {
  const out = await renderWith({
    "W-C0033-001": { records: { location: [{ locationName: "嘉義縣", hazardConditions: { hazards: [] } }] } },
    "W-C0034-001": { records: { info: [] } },
  });
  assert.doesNotMatch(out, /class="alert-banner"/);
  assert.doesNotMatch(out, /初判已調降/);
  // 其餘 feed 都失敗，所以岸釣是「看資料」而不是被警報拉高或放寬
  assert.match(out, /decision-line unknown">\s*<div class="decision-label">岸邊釣魚<\/div>/);
});

test("when the warning feeds fail the page says so instead of implying there are none", async () => {
  const out = await renderWith({});
  assert.doesNotMatch(out, /class="alert-banner"/);
  assert.match(out, /警特報無法取得，初判未納入警報/);
});

// ─── 最近時段：可以跨日，但不可以拿太遠的數字充數 ─────────────
test("the nearest forecast slot can cross midnight but not beyond three hours", async () => {
  const h = await loadHelpers({});
  const sea = { "浪高": { "2026-09-24_0": { WaveHeight: "1.0" }, "2026-09-24_3": { WaveHeight: "1.2" } } };
  // 22:00 → 隔天 00:00 只差 2 小時，舊版只在同一天找，會整列變「—」
  const hit = h.nearestEntry(sea, "浪高", new Date("2026-09-23T22:00:00+08:00"));
  assert.equal(hit.key, "2026-09-24_0");
  // 19:00 → 最近也差 5 小時，不取
  assert.equal(h.nearestEntry(sea, "浪高", new Date("2026-09-23T19:00:00+08:00")), null);
  assert.equal(h.nearestEntry(sea, "浪高", new Date("2026-09-24T02:00:00+08:00")).key, "2026-09-24_3");
  assert.equal(h.nearestEntry({}, "浪高", new Date()), null);
});

// ─── 定位快取政策：權限已允許就每次重新定位；會跳提示時快取只沿用 30 分鐘 ─────
// 2026-10-16 回報：早上在湖內定位，中午回到臺南，頁面仍沿用 12 小時內的舊定位。
function fakeNav(permission, { fails = false } = {}) {
  const calls = { n: 0 };
  return {
    calls,
    nav: {
      userAgent: "test",
      permissions: permission ? { query: async () => ({ state: permission }) } : undefined,
      geolocation: {
        getCurrentPosition(ok, err) {
          calls.n++;
          if (fails) err({ code: 3, message: "timeout" });
          else ok({ coords: { latitude: 22.997, longitude: 120.212 } });
        },
      },
    },
  };
}
const storedAgo = (min) => ({ "bjkw-weather-last-fix": JSON.stringify({ ...FIX, at: Date.now() - min * 60000 }) });

test("with location already allowed the page asks for a fresh fix even when one is stored", async () => {
  const { nav, calls } = fakeNav("granted");
  const h = await loadHelpers(storedAgo(5), nav);
  const pos = await h.getGpsPosition();
  assert.equal(calls.n, 1);
  assert.equal(pos.lat, 22.997);
});

test("when asking would prompt, a fix under 30 minutes old is reused without asking", async () => {
  const { nav, calls } = fakeNav("prompt");
  const h = await loadHelpers(storedAgo(10), nav);
  const pos = await h.getGpsPosition();
  assert.equal(calls.n, 0);
  assert.equal(pos.lat, FIX.lat);
});

test("a fix older than 30 minutes is not reused, even inside the 12-hour fallback window", async () => {
  const { nav, calls } = fakeNav("prompt");
  const h = await loadHelpers(storedAgo(40), nav);
  const pos = await h.getGpsPosition();
  assert.equal(calls.n, 1);
  assert.equal(pos.lat, 22.997);
});

test("if the location request fails, the stored fix is used and keeps its own timestamp", async () => {
  const { nav } = fakeNav("granted", { fails: true });
  const store = storedAgo(180);
  const at = JSON.parse(store["bjkw-weather-last-fix"]).at;
  const h = await loadHelpers(store, nav);
  const pos = await h.getGpsPosition();
  assert.equal(pos.lat, FIX.lat);
  assert.equal(pos.at, at, "畫面要印出的是那筆舊定位的時間，不是現在");
});

// ─── 2026-11-03 資料審查：每一條都是用真實 CWA 資料量到的錯 ───────────────

// 「南區」是「安南區」的子字串；舊版用 includes 比對，臺南市南區拿到的是安南區的預報
test("forecast parsing matches the location name exactly, not as a substring", async () => {
  const h = await loadHelpers({});
  const el = (v) => ({ ElementName: "溫度", Time: [{ DataTime: "2026-11-03T06:00:00+08:00", ElementValue: [{ Temperature: v }] }] });
  const data = { records: { Locations: [{ Location: [
    { LocationName: "南區", WeatherElement: [el("25")] },
    { LocationName: "安南區", WeatherElement: [el("24")] },
  ] }] } };
  assert.equal(h.parseForecast(data, "南區")["溫度"]["2026-11-03_6"].Temperature, "25");
});

// 降雨機率與天氣現象是 3 小時區間；舊版取「起點最近」的區間，每天有三分之一的整點取到下一段
test("interval elements are looked up by containment, not by the nearest start", async () => {
  const h = await loadHelpers({});
  const data = { records: { Locations: [{ Location: [{ LocationName: "中西區", WeatherElement: [{ ElementName: "3小時降雨機率", Time: [
    { StartTime: "2026-11-03T06:00:00+08:00", EndTime: "2026-11-03T09:00:00+08:00", ElementValue: [{ ProbabilityOfPrecipitation: "10" }] },
    { StartTime: "2026-11-03T09:00:00+08:00", EndTime: "2026-11-03T12:00:00+08:00", ElementValue: [{ ProbabilityOfPrecipitation: "70" }] },
  ] }] }] }] } };
  const city = h.parseForecast(data, "中西區");
  const pop = (hhmm) => h.nearestEntry(city, "3小時降雨機率", new Date(`2026-11-03T${hhmm}:00+08:00`))?.value?.ProbabilityOfPrecipitation;
  assert.equal(pop("08:00"), "10", "08:00 屬於 06–09 那一段");
  assert.equal(pop("08:59"), "10");
  assert.equal(pop("09:00"), "70");
  assert.equal(pop("05:00"), undefined, "沒有涵蓋該時刻的區間就不取");
});

// 中央氣象署「蒲福風級表」0–17 級（https://www.cwa.gov.tw/V8/C/K/Encyclopedia/nous/overview-09.txt）。舊版 8 級封頂
test("Beaufort conversion follows the CWA table up to level 17", async () => {
  const h = await loadHelpers({});
  const lower = [0, 0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1];
  lower.forEach((ms, b) => {
    assert.equal(h.bft(ms), b, `${ms} m/s 應為 ${b} 級`);
    if (b > 0) assert.equal(h.bft(+(ms - 0.1).toFixed(1)), b - 1, `${(ms - 0.1).toFixed(1)} m/s 應為 ${b - 1} 級`);
  });
  assert.equal(h.bftLabel(9), "烈風");
  assert.equal(h.bftLabel(12), "颶風");
  assert.equal(h.bftLabel(15), "致災性強風");
});

// fmtTime／floorHour 舊版用裝置時區；裝置不在 UTC+8（或時差不是整點）時潮汐時刻與逐時預報會整批偏移
test("times are shown and floored in Asia/Taipei whatever the device time zone is", async () => {
  const { spawnSync } = await import("node:child_process");
  const probe = `
    const fs = require("fs"), vm = require("vm");
    const html = fs.readFileSync(${JSON.stringify(join(ROOT, "weather", "index.html"))}, "utf8");
    const script = html.match(/<script>((?:(?!<\\/script>)[\\s\\S])*)<\\/script>\\s*<\\/body>/)[1];
    const noop = () => {}; const el = new Proxy({}, { get: () => noop, set: () => true });
    const ls = { getItem: () => null, setItem: noop };
    const ctx = vm.createContext({ console, window: { __WEATHER_SKIP_AUTO_INIT__: true, localStorage: ls, addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) }, localStorage: ls,
      document: { readyState: "complete", addEventListener: noop, getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], createElement: () => el, body: el, documentElement: el },
      navigator: {}, location: { href: "", search: "" }, setTimeout, clearTimeout, URLSearchParams, fetch: async () => { throw 0; },
      Math, Date, isFinite, parseFloat, parseInt, Number, String, Array, Object, JSON, Error, Promise, Intl, RegExp, Map, Set });
    ctx.globalThis = ctx; vm.runInContext(script, ctx);
    const h = ctx.window.WeatherApp.helpers;
    const t = new Date("2026-11-03T13:10:00+08:00");
    process.stdout.write(JSON.stringify({ time: h.fmtTime(t), floored: h.floorHour(t).toISOString() }));`;
  for (const tz of ["UTC", "America/New_York", "Asia/Kolkata"]) {
    const r = spawnSync(process.execPath, ["-e", probe], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.time, "13:10", `TZ=${tz}`);
    assert.equal(out.floored, "2026-11-03T05:00:00.000Z", `TZ=${tz}：應取整到臺灣 13:00`);
  }
});

// 海況列：舊版標的是「現在、+2、+4、+6 小時」，資料卻取最近的 3 小時預報點，
// 兩列常是同一筆資料、標成不同時間（實測 6 種起始時刻全部中招）
function coastFixture(nowMs) {
  const H = 3600000;
  const slot0 = Math.floor((nowMs + 8 * H) / (3 * H)) * 3 * H - 8 * H; // 臺灣時間 3 小時格點
  const iso = (ms) => new Date(ms + 8 * H).toISOString().slice(0, 13) + ":00:00+08:00";
  const slots = Array.from({ length: 12 }, (_, i) => slot0 + (i - 1) * 3 * H);
  const el = (name, f) => ({ ElementName: name, Time: slots.map((ms, i) => ({ DataTime: iso(ms), ElementValue: [f(i)] })) });
  return {
    slots, iso,
    data: { cwaopendata: { Dataset: { Locations: { Location: [{
      LocationName: "東石鄉沿海", Geocode: "10010090", Latitude: "23.46", Longitude: "119.96",
      WeatherElement: [
        el("風速", (i) => ({ WindSpeed: String(i + 1), BeaufortScale: "2" })),
        el("風向", () => ({ WindDirection: "東北風" })),
        el("浪高", (i) => ({ WaveHeight: (0.1 * (i + 1)).toFixed(1) })),
        el("流速", () => ({ OceanCurrentSpeed: "0.3" })),
        el("流向", () => ({ OceanCurrentDirection: "偏南" })),
      ],
    }] } } } },
  };
}

test("marine rows list each forecast slot once, labelled with that slot's own time", async () => {
  const fx = coastFixture(Date.now());
  const out = await renderWith({ "F-D0047-095": fx.data, "W-C0033-001": { records: { location: [] } }, "W-C0034-001": { records: { info: [] } } });
  const card = out.slice(out.indexOf("dash-marine"), out.indexOf("dash-forecast"));
  const rows = [...card.matchAll(/<span class="row-time">(\d\d:\d\d)<\/span>[\s\S]*?浪 ([\d.]+)m/g)].map((m) => [m[1], m[2]]);
  assert.ok(rows.length >= 2 && rows.length <= 4, `列數 ${rows.length}`);
  const times = rows.map(([t]) => t);
  assert.equal(new Set(times).size, times.length, `時間重複：${times.join(",")}`);
  for (const [t, wave] of rows) {
    const i = fx.slots.findIndex((ms) => fx.iso(ms).slice(11, 16) === t);
    assert.ok(i >= 0, `${t} 不是預報時段`);
    assert.equal(wave, (0.1 * (i + 1)).toFixed(1), `${t} 那列的浪高應是該時段自己的值`);
  }
});

// O-A0001-001 的 Now.Precipitation 是「當日降水量」（中央氣象署資料集說明 O-A0001-001.pdf），不是即時雨量
test("station rainfall is labelled as today's accumulation", async () => {
  const html = await readFile(join(ROOT, "weather", "index.html"), "utf8");
  assert.match(html, /今日雨量 \$\{showRain\(rain\)\}/);
});
