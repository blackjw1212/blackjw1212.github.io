import test from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 只為了測位置快取。天氣頁的主體要 DOM 與網路，這裡一律給空殼——
// __WEATHER_SKIP_AUTO_INIT__ 擋掉 loadAll()，所以不會真的去抓資料。
async function loadHelpers(store) {
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
    navigator: { geolocation: null, userAgent: "test" },
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
  assert.deepEqual(h.readStoredFix(), FIX);
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
