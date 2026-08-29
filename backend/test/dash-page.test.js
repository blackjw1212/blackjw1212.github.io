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
    this.className = "";
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); if (value === "") this.children.length = 0; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  appendChild(child) { this.children.push(child); return child; }
  fire(name) {
    const callback = this.listeners.get(name);
    if (!callback) throw new Error(`no ${name} listener on #${this.id}`);
    callback({ target: this });
  }
}

// 依實際 HTML 把帶 hidden 屬性的元素建成隱藏狀態，避免測試與頁面脫節：
// batteryTile / btnTilt / mockFlag 的預設隱藏是頁面自己宣告的，不是 JS 設的。
function buildDocument(html) {
  const elements = new Map();
  for (const match of String(html || "").matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    const node = new FakeElement(id);
    node.hidden = /\shidden(?=[\s/>])/.test(tag);
    elements.set(id, node);
  }
  const document = {
    readyState: "complete",
    hidden: false,
    addEventListener() {},
    createElement() { return new FakeElement(); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
  };
  return { document, elements };
}

function fakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    _map: map,
  };
}

// 這一頁沒有 navigator / screen / DeviceOrientationEvent 也必須載得起來：
// 頁面裡每個裝置 API 都是 typeof 守衛過的，沙箱不給就是在測那條降級路徑。
async function loadDash(options = {}) {
  const htmlPath = fileURLToPath(new URL("../../dash/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "dash inline script should be present");
  const { document, elements } = buildDocument(html);
  const window = {
    __DASH_SKIP_AUTO_INIT__: options.autoInit !== true,
    localStorage: options.localStorage || fakeStorage(),
    location: { href: "https://local.test/dash/", search: options.search || "" },
    addEventListener() {},
  };
  const context = vm.createContext({ console, document, window });
  vm.runInContext(script, context, { filename: "dash/index.html" });
  return { context, document, elements, html, window, app: context.window.DashApp };
}

test("dash page ships the HUD contract and states what the numbers are not", async () => {
  const { html, app } = await loadDash();
  assert.match(html, /<title>騎乘儀表板｜BJKW<\/title>/);
  assert.match(html, /rel="canonical" href="\/dash\/"/);
  assert.match(html, /name="theme-color" content="#09090b"/);
  assert.match(html, /騎乘中請勿操作手機/);
  assert.match(html, /非儀器級量測/);
  assert.match(html, /傾角量的是手機姿態，不是車身傾角/);
  assert.match(html, /不記錄行經路線/);
  assert.doesNotMatch(html, /window\.storage/);
  assert.ok(app && typeof app.init === "function", "DashApp should be exposed for tests");
});

test("device fields that come back null stay unknown instead of becoming zero", async () => {
  const { app } = await loadDash();
  const { numOrNaN, msToKmh } = app.helpers;

  // Number(null) 是 0。若讓它過關，coords.speed 為 null 的裝置會永遠顯示 0 km/h
  // 而且不會退回 Haversine 推算——畫面看起來完全正常。
  assert.ok(Number.isNaN(numOrNaN(null)));
  assert.ok(Number.isNaN(numOrNaN(undefined)));
  assert.ok(Number.isNaN(numOrNaN("")));
  assert.equal(numOrNaN(0), 0);
  assert.equal(numOrNaN("12.5"), 12.5);

  assert.equal(msToKmh(null), null);
  assert.equal(msToKmh(undefined), null);
  assert.equal(msToKmh(-1), null, "負速度是無效讀數，不是倒退");
  assert.equal(msToKmh(0), 0);
  assert.ok(Math.abs(msToKmh(10) - 36) < 1e-9);
});

test("speed smoothing seeds from the first sample and clamps alpha", async () => {
  const { app } = await loadDash();
  const { emaSmooth } = app.helpers;

  assert.equal(emaSmooth(null, 50, 0.3), 50, "第一筆沒有前值，直接採用");
  assert.equal(emaSmooth(0, 100, 0.5), 50);
  assert.equal(emaSmooth(80, null, 0.5), 80, "壞讀數不能把平滑值拉走");
  assert.equal(emaSmooth(80, 0, 1), 0, "alpha=1 等於不平滑");
  assert.equal(emaSmooth(80, 0, 5), 0, "alpha 超過 1 要夾住，不能算出負數速度");
  assert.equal(emaSmooth(80, 200, -2), 80, "alpha 小於 0 要夾住");
});

test("haversine matches a known distance and rejects incomplete points", async () => {
  const { app } = await loadDash();
  const { haversineMeters } = app.helpers;

  // 緯度 1 度 = R × π/180，用 IUGG 平均半徑 6371008.8 m 算出 111194.93 m
  const oneDegree = haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(oneDegree - 111194.93) < 1, `expected ~111194.93, got ${oneDegree}`);
  assert.equal(haversineMeters({ lat: 25, lon: 121 }, { lat: 25, lon: 121 }), 0);
  assert.equal(haversineMeters(null, { lat: 1, lon: 1 }), null);
  assert.equal(haversineMeters({ lat: 1 }, { lat: 2, lon: 2 }), null, "缺經度不能當 0 度用");
  assert.equal(haversineMeters({ lat: 1, lon: null }, { lat: 2, lon: 2 }), null);
});

test("fallback speed refuses to divide by a non-positive time delta", async () => {
  const { app } = await loadDash();
  const { speedFromFixes } = app.helpers;

  const a = { lat: 25.0, lon: 121.0, t: 1000 };
  const b = { lat: 25.001, lon: 121.0, t: 2000 };
  const kmh = speedFromFixes(a, b);
  // 0.001 度緯度 ≈ 111.19 m，一秒走完 ≈ 400 km/h（只驗算式，不是合理車速）
  assert.ok(Math.abs(kmh - 400.3) < 1, `expected ~400.3 km/h, got ${kmh}`);

  assert.equal(speedFromFixes(a, { ...b, t: 1000 }), null, "dt = 0 會把距離除爆");
  assert.equal(speedFromFixes(a, { ...b, t: 500 }), null, "時戳倒退不能算出負速度");
  assert.equal(speedFromFixes(null, b), null);
  assert.equal(speedFromFixes(a, { ...b, lat: null }), null);
});

test("standing still reads as zero so the odometer does not grow at a red light", async () => {
  const { app } = await loadDash();
  const { stillFilter } = app.helpers;
  const { STILL_KMH, BAD_ACCURACY_M } = app.constants;

  assert.equal(stillFilter(1.8, 5), 0, "GPS 靜止時會漂出 1~3 km/h");
  assert.equal(stillFilter(STILL_KMH, 5), STILL_KMH, "門檻值本身算有在動");
  assert.equal(stillFilter(30, 5), 30);
  assert.equal(stillFilter(null, 5), 0);
  // 精度爛掉時，門檻放寬到兩倍
  assert.equal(stillFilter(4, BAD_ACCURACY_M + 10), 0);
  assert.equal(stillFilter(4, 5), 4);
  assert.equal(stillFilter(30, BAD_ACCURACY_M + 10), 30, "精度差不代表高速讀數是假的");
});

test("unit switching converts both the number and the label", async () => {
  const { app } = await loadDash();
  const { kmhToMph, formatSpeed } = app.helpers;

  assert.ok(Math.abs(kmhToMph(100) - 62.1371) < 1e-4);
  assert.equal(kmhToMph(null), null);
  assert.equal(formatSpeed(100, "kmh"), "100");
  assert.equal(formatSpeed(100, "mph"), "62");
  assert.equal(formatSpeed(0, "kmh"), "0");
  assert.equal(formatSpeed(null, "kmh"), "--", "沒有定位時不能顯示 0");
  assert.equal(formatSpeed(undefined, "mph"), "--");
});

test("virtual gear puts every band boundary in the higher gear", async () => {
  const { app } = await loadDash();
  const { virtualGear } = app.helpers;
  const bands = app.constants.GEAR_BANDS;   // [0, 25, 45, 70, 95, 125]

  assert.equal(virtualGear(0, bands), 0, "0 = N");
  assert.equal(virtualGear(null, bands), 0);
  assert.equal(virtualGear(0.5, bands), 1);
  assert.equal(virtualGear(24.9, bands), 1);
  assert.equal(virtualGear(25, bands), 2, "邊界值屬於較高的一檔");
  assert.equal(virtualGear(44.9, bands), 2);
  assert.equal(virtualGear(45, bands), 3);
  assert.equal(virtualGear(70, bands), 4);
  assert.equal(virtualGear(95, bands), 5);
  assert.equal(virtualGear(125, bands), 6);
  assert.equal(virtualGear(300, bands), 6, "超過頂檔不能算出第七檔");
});

test("rev ratio stays inside 0..1 no matter what the speed is", async () => {
  const { app } = await loadDash();
  const { revRatio } = app.helpers;

  assert.equal(revRatio(0, 110), 0);
  assert.equal(revRatio(55, 110), 0.5);
  assert.equal(revRatio(110, 110), 1);
  assert.equal(revRatio(400, 110), 1, "超過紅線不能讓燈條算出超出範圍的比例");
  assert.equal(revRatio(-5, 110), 0);
  assert.equal(revRatio(50, 0), 0, "紅線為 0 會除以零");
  assert.equal(revRatio(null, 110), 0);
});

test("led bar lights up from green through amber to red", async () => {
  const { app } = await loadDash();
  const { ledStates } = app.helpers;
  const { LED_COUNT } = app.constants;

  const dark = ledStates(0, LED_COUNT);
  assert.equal(dark.length, LED_COUNT);
  assert.ok(dark.every((state) => state === "off"));

  const full = ledStates(1, LED_COUNT);
  assert.equal(full.length, LED_COUNT);
  assert.ok(full.every((state) => state !== "off"));
  assert.equal(full[0], "green");
  assert.equal(full[LED_COUNT - 1], "red");
  assert.ok(full.includes("amber"));

  const half = ledStates(0.5, LED_COUNT);
  assert.equal(half.filter((state) => state !== "off").length, LED_COUNT / 2);
  assert.ok(half.filter((state) => state !== "off").every((state) => state === "green"));

  assert.equal(ledStates(null, LED_COUNT).filter((s) => s !== "off").length, 0);
  assert.equal(ledStates(1, 0).length, LED_COUNT, "燈數無效時退回預設");
});

test("lean angle picks the right axis for each screen rotation", async () => {
  const { app } = await loadDash();
  const { normalizeLean } = app.helpers;
  const { LEAN_LIMIT } = app.constants;
  const reading = { beta: 20, gamma: 5 };

  assert.equal(normalizeLean(reading, 0, 0), 5, "直立時左右傾是 gamma");
  assert.equal(normalizeLean(reading, 90, 0), -20, "橫放時改看 beta");
  assert.equal(normalizeLean(reading, 270, 0), 20, "另一邊橫放正負相反");
  assert.equal(normalizeLean(reading, 180, 0), -5);
  assert.equal(normalizeLean(reading, -90, 0), 20, "負角度要正規化成 270");

  assert.equal(normalizeLean({ beta: 0, gamma: 30 }, 0, 10), 20, "扣掉出發前的歸零校正量");
  assert.equal(normalizeLean({ beta: 0, gamma: 85 }, 0, 0), LEAN_LIMIT, "拿起來看手機不該記成 85 度壓車");
  assert.equal(normalizeLean({ beta: 0, gamma: -85 }, 0, 0), -LEAN_LIMIT);

  assert.equal(normalizeLean(null, 0, 0), null);
  assert.equal(normalizeLean({}, 0, 0), null);
  assert.equal(normalizeLean({ beta: null, gamma: null }, 0, 0), null, "沒有讀數不能變成 0 度");
});

test("peak lean keeps the two sides apart", async () => {
  const { app } = await loadDash();
  const { updatePeakLean } = app.helpers;

  // vm 裡建出來的物件屬於另一個 realm，prototype 不同，要展開回本 realm 才比得動
  let peak = updatePeakLean(null, -30);
  assert.deepEqual({ ...peak }, { left: 30, right: 0 }, "負 = 左傾，記絕對值");
  peak = updatePeakLean(peak, 42);
  assert.deepEqual({ ...peak }, { left: 30, right: 42 });
  peak = updatePeakLean(peak, -12);
  assert.deepEqual({ ...peak }, { left: 30, right: 42 }, "比較小的值不能把峰值蓋掉");
  peak = updatePeakLean(peak, null);
  assert.deepEqual({ ...peak }, { left: 30, right: 42 });
  assert.deepEqual({ ...updatePeakLean({ left: "壞掉", right: undefined }, 5) }, { left: 0, right: 5 });
});

test("g-force divides by standard gravity and survives a null accelerometer", async () => {
  const { app } = await loadDash();
  const { gForce } = app.helpers;

  const g = gForce({ x: 9.80665, y: -9.80665 });
  assert.ok(Math.abs(g.lat - 1) < 1e-9);
  assert.ok(Math.abs(g.long + 1) < 1e-9);
  assert.deepEqual({ ...gForce(null) }, { long: 0, lat: 0 });
  assert.deepEqual({ ...gForce({ x: null, y: null }) }, { long: 0, lat: 0 });
});

test("elapsed time formats as hh:mm:ss and never goes negative", async () => {
  const { app } = await loadDash();
  const { formatElapsed } = app.helpers;

  assert.equal(formatElapsed(0), "00:00:00");
  assert.equal(formatElapsed(1000), "00:00:01");
  assert.equal(formatElapsed(3661000), "01:01:01");
  assert.equal(formatElapsed(-5000), "00:00:00");
  assert.equal(formatElapsed(null), "00:00:00");
  assert.equal(formatElapsed(360000000), "100:00:00");
});

test("personal bests only ever go up and tolerate a corrupt save", async () => {
  const { app } = await loadDash();
  const { mergePersonalBest } = app.helpers;

  assert.deepEqual(
    { ...mergePersonalBest({ bestTopSpeed: 120, bestLeanLeft: 30, bestLeanRight: 28 },
      { topSpeed: 90, peakLeft: 41, peakRight: 10 }) },
    { bestTopSpeed: 120, bestLeanLeft: 41, bestLeanRight: 28 }
  );
  assert.deepEqual(
    { ...mergePersonalBest(null, { topSpeed: 88, peakLeft: 12, peakRight: 15 }) },
    { bestTopSpeed: 88, bestLeanLeft: 12, bestLeanRight: 15 }
  );
  assert.deepEqual(
    { ...mergePersonalBest({ bestTopSpeed: "壞掉", bestLeanLeft: null, bestLeanRight: -9 }, {}) },
    { bestTopSpeed: 0, bestLeanLeft: 0, bestLeanRight: 0 },
    "壞掉的存檔當 0 處理，不能讓頁面炸掉"
  );
});

test("init renders a full dashboard without any device API present", async () => {
  const { app, elements } = await loadDash();
  app.init();

  assert.equal(elements.get("speed").textContent, "--", "沒有定位時車速留白");
  assert.equal(elements.get("gear").textContent, "N");
  assert.equal(elements.get("leanNow").textContent, "--°");
  assert.equal(elements.get("elapsed").textContent, "00:00:00");
  assert.equal(elements.get("revPct").textContent, "0%");
  assert.equal(elements.get("btnRun").textContent, "開始記錄");
  assert.equal(elements.get("btnUnit").textContent, "切換 mph");
  assert.equal(elements.get("revBar").children.length, app.constants.LED_COUNT);
  assert.ok(elements.get("revBar").children.every((led) => led.className === "led"));
  assert.equal(elements.get("mockFlag").hidden, true);
  assert.equal(elements.get("batteryTile").hidden, true, "沒有 getBattery 的瀏覽器整格不顯示");
  assert.equal(elements.get("btnTilt").hidden, true, "不需要權限的瀏覽器不該出現要權限的按鈕");
  assert.equal(elements.get("lampGps").className, "lamp", "還沒定位時 GPS 燈不能是綠的");
});

test("the mock switch is opt-in and announces itself", async () => {
  const plain = await loadDash();
  plain.app.init();
  assert.equal(plain.elements.get("mockFlag").hidden, true);

  const mocked = await loadDash({ search: "?mock=1" });
  mocked.app.init();
  assert.equal(mocked.elements.get("mockFlag").hidden, false, "模擬數據一定要在畫面上說出來");
});

test("unit preference round-trips through localStorage", async () => {
  const store = fakeStorage();
  const first = await loadDash({ localStorage: store });
  first.app.init();
  first.elements.get("btnUnit").fire("click");
  assert.equal(first.elements.get("speedUnit").textContent, "M P H");
  assert.equal(first.app.getState().prefs.unit, "mph");

  const second = await loadDash({ localStorage: store });
  second.app.init();
  assert.equal(second.app.getState().prefs.unit, "mph", "重開頁面要記得單位");
  assert.equal(second.elements.get("btnUnit").textContent, "切換 km/h");
});

test("a corrupt localStorage entry falls back to defaults instead of throwing", async () => {
  const store = fakeStorage({ "bjkw-dash:v1": "{not json" });
  const { app } = await loadDash({ localStorage: store });
  app.init();
  const { prefs } = app.getState();
  assert.equal(prefs.unit, "kmh");
  assert.equal(prefs.bestTopSpeed, 0);
  assert.equal(prefs.redlineKmh, app.constants.DEFAULT_REDLINE);
});

test("clearing personal bests wipes the stored record", async () => {
  const store = fakeStorage({
    "bjkw-dash:v1": JSON.stringify({ unit: "kmh", bestTopSpeed: 143, bestLeanLeft: 33, bestLeanRight: 29 }),
  });
  const { app, elements } = await loadDash({ localStorage: store });
  app.init();
  assert.equal(app.getState().prefs.bestTopSpeed, 143);
  assert.match(elements.get("bestSpeed").innerHTML, /143/);
  assert.match(elements.get("bestLeft").textContent, /33/);

  elements.get("btnClearBest").fire("click");
  assert.equal(app.getState().prefs.bestTopSpeed, 0);
  assert.equal(JSON.parse(store.getItem("bjkw-dash:v1")).bestLeanLeft, 0);
});
