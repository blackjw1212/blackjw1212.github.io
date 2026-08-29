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
    this.attributes = new Map();
  }
  // SVG 元素的 className 是 SVGAnimatedString，頁面只能走 setAttribute，假 DOM 要跟上
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
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
    createElementNS(_ns, tag) { const node = new FakeElement(); node.tag = tag; return node; },
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

test("the readout font is self-hosted and never falls back to a monospace face", async () => {
  const { html } = await loadDash();

  // 實機踩過：字型走 Google Fonts，在使用者手機上根本沒載到，iOS 退回 fallback 鏈裡的
  // ui-monospace（SF Mono）。SF Mono 的零帶斜線，放大當車速看起來像缺字符的方塊。
  // 儀表的主要讀數不可以依賴 CDN——隧道裡沒網路一樣要看得懂。
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/, "不可依賴 Google Fonts");
  assert.match(html, /@font-face/, "數字字型要自帶");
  assert.match(html, /url\("\/assets\/fonts\/chakra-petch-600-digits\.woff2"\)/);
  assert.match(html, /url\("\/assets\/fonts\/chakra-petch-700-digits\.woff2"\)/);

  const numStack = html.match(/--num:([^;]+);/)?.[1] || "";
  assert.ok(numStack, "--num 應該有定義");
  assert.match(numStack, /"Dash Num"/, "第一順位是自帶字型");
  assert.doesNotMatch(numStack, /mono/i, "fallback 不可含等寬字型，那正是斜線零的來源");
});

test("the cluster is one panel and shows no gear indicator", async () => {
  const { html, app } = await loadDash();

  // 手機只有 GPS 速度，推不出檔位。之前那個「虛擬檔位」是拿速度區間編出來的，
  // 掛在儀表上等於顯示一項不存在的車輛狀態。
  assert.doesNotMatch(html, /GEAR|虛擬檔位|id="gear"/, "不可出現檔位指示");
  assert.equal(app.helpers.virtualGear, undefined, "虛擬檔位的計算也要一併移除");

  // 一整塊面板，不是三張並排的卡片：傾角、車速、G 力不是同等重要，
  // 切成等寬卡片會讓騎車時最需要一眼看到的車速失去主導地位。
  assert.equal((html.match(/class="cluster"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="card[ "]/, "不再有卡片");
  assert.match(html, /class="hero"/, "車速要有自己的主區塊");
  assert.match(html, /id="barScale"/, "速度條要有刻度");
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

test("displacement inside the accuracy radius is noise, not movement", async () => {
  const { app } = await loadDash();
  const { movementBetween } = app.helpers;
  const at = (lat, accuracy) => ({ lat, lon: 121.5654, accuracy, t: 0 });

  // 這就是實機回報的情境：人在家裡沒動，精度回報 8m，定位點每秒跳 2m，
  // 舊邏輯換算成 7.2 km/h 顯示出來。位移小於精度半徑時那是雜訊。
  const twoMetres = 2 / 111194.93;
  const still = movementBetween(at(25.033, 8), at(25.033 + twoMetres, 8));
  assert.equal(still.moving, false, "2m 位移搭配 8m 精度必須判定為沒動");
  assert.ok(Math.abs(still.meters - 2) < 0.1);

  const twentyMetres = 20 / 111194.93;
  const rolling = movementBetween(at(25.033, 8), at(25.033 + twentyMetres, 8));
  assert.equal(rolling.moving, true, "20m 位移遠超過 8m 精度，這是真的在動");
  assert.ok(Math.abs(rolling.meters - 20) < 0.1);

  // 精度爛掉時門檻自動變嚴，因為雜訊本來就更大
  assert.equal(movementBetween(at(25.033, 50), at(25.033 + twentyMetres, 50)).moving, false);
  // 兩筆精度不同時取比較差的那個當雜訊底線
  assert.equal(movementBetween(at(25.033, 4), at(25.033 + twentyMetres, 60)).moving, false);

  assert.deepEqual({ ...movementBetween(null, at(25.033, 8)) }, { moving: false, meters: 0 });
  assert.deepEqual({ ...movementBetween(at(25.033, 8), { lat: null, lon: null }) }, { moving: false, meters: 0 });
});

test("speed needs to clear the threshold, the noise floor and a second confirming fix", async () => {
  const { app } = await loadDash();
  const { stillFilter } = app.helpers;
  const { STILL_KMH, MOVING_STREAK } = app.constants;

  assert.equal(stillFilter(30, true, MOVING_STREAK), 30, "三個條件都過才顯示");
  assert.equal(stillFilter(STILL_KMH, true, MOVING_STREAK), STILL_KMH, "門檻值本身算有在動");
  assert.equal(stillFilter(STILL_KMH - 0.1, true, MOVING_STREAK), 0, "低於步行速度一律當靜止");
  assert.equal(stillFilter(30, false, MOVING_STREAK), 0, "位移在雜訊裡，再快的讀數都不算");
  assert.equal(stillFilter(30, true, MOVING_STREAK - 1), 0, "單筆跳點不讓數字跳出來");
  assert.equal(stillFilter(null, true, MOVING_STREAK), 0);
  assert.equal(stillFilter(30, true, null), 0);
});

test("a stationary phone never accumulates speed or distance", async () => {
  const { app } = await loadDash();
  app.init();
  app.getState().trip.running = true;   // 記錄中才會累加里程，不開的話這條斷言是白過的
  const metre = 1 / 111194.93;
  let lat = 25.0330;

  // 室內漂移：精度 8m，每筆跳 2m。餵十筆，儀表必須從頭到尾是 0。
  for (let i = 0; i < 10; i++) {
    lat += 2 * metre;
    app.applyFix({ kmh: null, accuracy: 8, lat, lon: 121.5654, t: 1000 * (i + 1) });
  }
  const state = app.getState();
  assert.equal(state.gps.kmh, 0, "停著不能有時速");
  assert.equal(state.gps.moving, false);
  assert.equal(state.trip.distanceM, 0, "停著不能長里程");
  assert.equal(state.trip.topSpeed, 0);
  assert.equal(app.getState().gps.hasFix, true, "有收到定位，只是判定為沒在動");
});

test("real movement takes one confirming fix to show up, then reads through", async () => {
  const { app } = await loadDash();
  app.init();
  app.getState().trip.running = true;   // 里程與極速只在記錄中累加
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = (t) => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t }); };

  roll(1000);   // 第一筆只建立基準，沒有前一點可比
  assert.equal(app.getState().gps.kmh, 0);
  roll(2000);   // 有位移了，但只有一筆，還在等確認
  assert.equal(app.getState().gps.kmh, 0, "保守策略：起步後要多一筆才承認");
  roll(3000);
  assert.ok(app.getState().gps.kmh > 0, "連續兩筆都在動就讀得出來");

  const { trip } = app.getState();
  assert.ok(trip.distanceM > 15 && trip.distanceM < 45, `里程應該累加一到兩段 20m，實得 ${trip.distanceM}`);
  assert.ok(trip.topSpeed > 0);
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




test("the speed bar ramps up from left to right", async () => {
  const { app } = await loadDash();
  const { barSegmentHeight } = app.helpers;
  const { LED_COUNT, BAR_MIN_H } = app.constants;

  assert.ok(Math.abs(barSegmentHeight(0, LED_COUNT) - BAR_MIN_H) < 1e-9, "最左邊最矮");
  assert.ok(Math.abs(barSegmentHeight(LED_COUNT - 1, LED_COUNT) - 1) < 1e-9, "最右邊滿高");
  let prev = -1;
  for (let i = 0; i < LED_COUNT; i++) {
    const h = barSegmentHeight(i, LED_COUNT);
    assert.ok(h > prev, `第 ${i} 段要比前一段高`);
    assert.ok(h > 0 && h <= 1, "高度必須落在 0..1");
    prev = h;
  }
  assert.equal(barSegmentHeight(-5, LED_COUNT), BAR_MIN_H, "超出範圍要夾住");
  assert.equal(barSegmentHeight(999, LED_COUNT), 1);
});

test("bar scale labels are round numbers in the current unit", async () => {
  const { app } = await loadDash();
  const { barScaleValues } = app.helpers;
  const { DEFAULT_REDLINE, BAR_SCALE_STEPS } = app.constants;

  const kmh = barScaleValues(DEFAULT_REDLINE, "kmh", BAR_SCALE_STEPS);
  assert.equal(kmh.length, BAR_SCALE_STEPS);
  assert.equal(kmh[0], 0, "從 0 開始");
  assert.equal(kmh[kmh.length - 1], DEFAULT_REDLINE, "最後一格是紅線");
  // 儀表上出現 28、83 這種數字沒有人看得下去
  assert.ok(kmh.every((v) => v % 5 === 0), `刻度要取整到 5，實得 ${kmh.join(",")}`);
  for (let i = 1; i < kmh.length; i++) assert.ok(kmh[i] > kmh[i - 1], "刻度必須遞增");

  const mph = barScaleValues(DEFAULT_REDLINE, "mph", BAR_SCALE_STEPS);
  assert.ok(mph.every((v) => v % 5 === 0));
  assert.ok(mph[mph.length - 1] < kmh[kmh.length - 1], "換成 mph 後上限數字要變小");

  assert.deepEqual([...barScaleValues(0, "kmh", 5)], []);
  assert.deepEqual([...barScaleValues(null, "kmh", 5)], []);
});

test("lean peaks only accumulate once the bike is actually moving", async () => {
  const { app } = await loadDash();
  app.init();
  const state = app.getState();

  // 實測踩過：坐在家裡把手機拿起來看，就被記成「本趟最大傾角 60 度」，
  // 按暫停還會存進永久個人最佳。低速下不可能維持壓車角。
  state.trip.running = true;
  state.gps.kmh = 0;
  app.handleOrientation({ beta: 0, gamma: -55 });
  assert.equal(app.getState().sensor.peakLeft, 0, "靜止時把手機翻過來不算壓車");
  assert.equal(app.getState().sensor.lean, -55, "即時角度照樣要顯示，只是不記峰值");

  state.gps.kmh = app.constants.LEAN_MIN_KMH - 1;
  app.handleOrientation({ beta: 0, gamma: -40 });
  assert.equal(app.getState().sensor.peakLeft, 0, "低於門檻仍不記");

  state.gps.kmh = app.constants.LEAN_MIN_KMH + 10;
  app.handleOrientation({ beta: 0, gamma: -32 });
  assert.equal(Math.round(app.getState().sensor.peakLeft), 32, "騎起來之後才開始記");
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
  const { app, elements, html } = await loadDash();
  app.init();

  assert.equal(elements.get("speed").textContent, "--", "沒有定位時車速留白");
  assert.equal(elements.get("speed").className, "speed idle", "等定位中的 -- 要淡化，看起來才不像壞掉");
  assert.equal(elements.get("speedUnit").textContent, "km/h");
  assert.equal(elements.get("leanNow").textContent, "--°");
  assert.equal(elements.get("elapsed").textContent, "00:00:00");
  assert.equal(elements.get("btnRun").textContent, "開始記錄");
  assert.equal(elements.get("btnUnit").textContent, "切換 mph");
  assert.equal(elements.get("revBar").children.length, app.constants.LED_COUNT);
  assert.ok(elements.get("revBar").children.every((led) => led.className === "led"));
  assert.equal(elements.get("mockFlag").hidden, true);
  assert.equal(elements.get("batteryTile").hidden, true, "沒有 getBattery 的瀏覽器整格不顯示");
  assert.equal(elements.get("btnTilt").hidden, true, "不需要權限的瀏覽器不該出現要權限的按鈕");
  assert.equal(elements.get("lampGps").className, "lamp", "還沒定位時 GPS 燈不能是綠的");

  // 速度條的斜坡是 JS 逐段設進去的，不是 CSS 寫死的——刻度數與段數要能一起改
  const leds = elements.get("revBar").children;
  assert.match(leds[0].style.height, /%$/, "段高要帶單位");
  assert.ok(parseFloat(leds[0].style.height) < parseFloat(leds[leds.length - 1].style.height),
    "由左往右要遞增");
  assert.equal(elements.get("barScale").children.length, app.constants.BAR_SCALE_STEPS);
  assert.equal(elements.get("barScale").children[0].textContent, "0");
  assert.equal(
    elements.get("barScale").children[app.constants.BAR_SCALE_STEPS - 1].textContent,
    String(app.constants.DEFAULT_REDLINE)
  );

  // 儀表要貼著資料走，不留任何補間。實測踩過：對長度類屬性下 transition，
  // render() 每 125~250ms 重設一次就會讓 CSSTransition 永遠跑不完而整個卡住，
  // 屬性寫的是一個值、畫面停在另一個值，兩邊查不出關聯。
  const ledRule = html.match(/\n\s*\.led\{[^}]*\}/)?.[0] || "";
  assert.ok(ledRule, ".led 規則應該存在");
  assert.doesNotMatch(ledRule, /transition/, "速度條不可有 transition");
  const dotRule = html.match(/\.gdot\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(dotRule, /transition/, "G 力點也不可有 transition");
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
  assert.equal(first.elements.get("speedUnit").textContent, "mph");
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
