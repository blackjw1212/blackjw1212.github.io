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
// 假的定位服務。記下每次 watchPosition 帶的選項，才驗得到高／低精度的切換。
function fakeGeolocation() {
  const watches = [];
  let nextId = 1;
  return {
    watches,
    get options() { return watches.map((w) => w.options); },
    get activeCount() { return watches.filter((w) => !w.cleared).length; },
    watchPosition(onOk, onErr, options) {
      const id = nextId++;
      watches.push({ id, onOk, onErr, options, cleared: false });
      return id;
    },
    clearWatch(id) {
      const found = watches.find((w) => w.id === id);
      if (found) found.cleared = true;
    },
  };
}

// 可控時鐘。自動停止要等 20 秒、降級要等 2 分鐘，真的等就別測了。
function fakeClock(start = 1_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; return t; };
  return clock;
}

async function loadDash(options = {}) {
  const htmlPath = fileURLToPath(new URL("../../dash/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "dash inline script should be present");
  const { document, elements } = buildDocument(html);
  const clock = options.clock || fakeClock();
  const geolocation = options.geolocation === null ? null : (options.geolocation || fakeGeolocation());
  const window = {
    __DASH_SKIP_AUTO_INIT__: options.autoInit !== true,
    __DASH_NOW__: clock,
    localStorage: options.localStorage || fakeStorage(),
    location: { href: "https://local.test/dash/", search: options.search || "" },
    addEventListener() {},
  };
  const sandbox = { console, document, window };
  if (geolocation) sandbox.navigator = { geolocation };
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context, { filename: "dash/index.html" });
  return { context, document, elements, html, window, clock, geolocation, app: context.window.DashApp };
}

test("dash page ships the HUD contract and states what the numbers are not", async () => {
  const { html, app } = await loadDash();
  assert.match(html, /<title>騎乘儀表板｜BJKW<\/title>/);
  assert.match(html, /rel="canonical" href="\/dash\/"/);
  assert.match(html, /name="theme-color" content="#09090b"/);
  assert.match(html, /騎乘中請勿操作手機/);
  assert.match(html, /非儀器級量測/);
  assert.match(html, /傾角量的是手機姿態，不是車身傾角/);
  // 座標保存的揭露單獨一支測試在管，加了軌跡之後說法已經換掉
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
  const metre = 1 / 111194.93;
  let lat = 25.0330;

  // 室內漂移：精度 8m，每筆跳 2m。餵十筆，儀表必須從頭到尾是 0，
  // 而且自動記錄不可以被這種雜訊觸發。
  for (let i = 0; i < 10; i++) {
    lat += 2 * metre;
    app.applyFix({ kmh: null, accuracy: 8, lat, lon: 121.5654, t: 1000 * (i + 1) });
  }
  const state = app.getState();
  assert.equal(state.gps.kmh, 0, "停著不能有時速");
  assert.equal(state.gps.moving, false);
  assert.equal(state.trip.distanceM, 0, "停著不能長里程");
  assert.equal(state.trip.topSpeed, 0);
  assert.equal(state.trip.running, false, "漂移不可以觸發自動記錄");
  assert.equal(state.trip.startedAt, null, "沒出發過就不該有起算點");
  assert.equal(state.gps.hasFix, true, "有收到定位，只是判定為沒在動");
});

test("real movement takes one confirming fix to show up, then reads through", async () => {
  const { app } = await loadDash();
  app.init();
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
  assert.equal(trip.running, true, "不必按任何東西，確認在動就自己開始記錄");
  assert.ok(trip.startedAt !== null, "起算點要被設定");
  assert.ok(trip.distanceM > 15 && trip.distanceM < 45, `里程應該累加一到兩段 20m，實得 ${trip.distanceM}`);
  assert.ok(trip.topSpeed > 0);
});

test("positioning starts on load, with nothing to press", async () => {
  const { app, geolocation, elements, html } = await loadDash();
  assert.equal(geolocation.activeCount, 0, "init 之前不該先要定位權限");

  app.init();

  assert.equal(geolocation.activeCount, 1, "一進頁面就開始定位");
  assert.equal(geolocation.options[0].enableHighAccuracy, true, "預設走高精度");
  // 手機架好之後不該再去碰它——這頁自己的免責第一句就是「騎乘中請勿操作手機」
  assert.doesNotMatch(html, /id="btnRun"/, "不該還有開始／暫停鍵");
  assert.doesNotMatch(html, /<button[^>]*>(?:開始|暫停)記錄<\/button>/);
  assert.equal(elements.get("btnRun"), undefined);
  // 一載入就定位這件事必須講在畫面上
  assert.match(html, /開啟頁面就會開始定位/);
});

test("recording stops on its own after standing still, and keeps the screen awake", async () => {
  const clock = fakeClock();
  const { app } = await loadDash({ clock });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = () => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: clock() }); };

  roll(); clock.advance(1000); roll(); clock.advance(1000); roll();
  assert.equal(app.getState().trip.running, true);

  // 還沒到門檻：紅燈停一下不該中斷記錄
  clock.advance(app.constants.AUTO_PAUSE_MS - 1000);
  app.tick();
  assert.equal(app.getState().trip.running, true, "沒到 20 秒不能停");

  clock.advance(2000);
  app.tick();
  const { trip, prefs } = app.getState();
  assert.equal(trip.running, false, "超過門檻要自己停下來");
  assert.ok(trip.startedAt !== null, "自動停止不是重設，這一趟還在");
  assert.ok(trip.distanceM > 0, "已經跑掉的里程要留著");
  assert.ok(prefs.bestTopSpeed > 0, "停下來時要把個人最佳寫進去");
});

test("elapsed is total time since departure and survives a stop", async () => {
  const clock = fakeClock();
  const { app, elements } = await loadDash({ clock });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = () => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: clock() }); };

  roll(); clock.advance(1000); roll(); clock.advance(1000); roll();
  const startedAt = app.getState().trip.startedAt;
  assert.ok(startedAt !== null);

  // 停了很久
  clock.advance(60_000);
  app.tick();
  assert.equal(app.getState().trip.running, false);
  assert.equal(elements.get("elapsed").textContent, "00:01:00", "停等照算，這是總時間不是移動時間");

  // 再出發：起算點不可以被重設，否則總時間會歸零重來
  roll(); clock.advance(1000); roll();
  assert.equal(app.getState().trip.running, true, "再次移動要自己接回來");
  assert.equal(app.getState().trip.startedAt, startedAt, "起算點整趟只設一次");

  // 計時完全靠時戳相減，不靠 tick 累加——背景分頁的 setInterval 會被節流
  clock.advance(3600_000);
  app.tick();
  assert.equal(elements.get("elapsed").textContent, "01:01:01");
});

test("clearing the trip resets the clock and the movement baseline", async () => {
  const clock = fakeClock();
  const { app, elements } = await loadDash({ clock });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = () => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: clock() }); };
  roll(); clock.advance(1000); roll(); clock.advance(1000); roll();
  assert.ok(app.getState().trip.distanceM > 0);

  elements.get("btnReset").fire("click");
  const { trip, gps } = app.getState();
  assert.equal(trip.running, false);
  assert.equal(trip.startedAt, null);
  assert.equal(trip.lastMovingAt, null);
  assert.equal(trip.distanceM, 0);
  assert.equal(trip.topSpeed, 0);
  // 舊的基準點沒清的話，下一筆定位會拿它比對而誤判成移動
  assert.equal(gps.lastFix, null);
  assert.equal(elements.get("elapsed").textContent, "00:00:00");
});

test("positioning drops to low accuracy when parked and climbs back on movement", async () => {
  const clock = fakeClock();
  const { app, geolocation } = await loadDash({ clock });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = () => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: clock() }); };

  roll(); clock.advance(1000); roll(); clock.advance(1000); roll();
  assert.equal(app.getState().gpsMode, "high");

  clock.advance(app.constants.IDLE_DOWNGRADE_MS + 1000);
  app.tick();
  assert.equal(app.getState().gpsMode, "low", "停久了要降級省電");
  assert.equal(geolocation.activeCount, 1, "降級是重開 watch，不是多開一個");
  assert.equal(geolocation.options.at(-1).enableHighAccuracy, false);

  // 低精度下 accuracy 會變差，門檻跟著變嚴——這裡用夠大的位移確保判定得到
  lat += 300 * metre;
  app.applyFix({ kmh: 40, accuracy: 60, lat, lon: 121.5654, t: clock() });
  clock.advance(1000);
  lat += 300 * metre;
  app.applyFix({ kmh: 40, accuracy: 60, lat, lon: 121.5654, t: clock() });
  assert.equal(app.getState().gpsMode, "high", "再動起來要升回高精度");
  assert.equal(geolocation.options.at(-1).enableHighAccuracy, true);
  assert.equal(geolocation.activeCount, 1);
});

test("the rec lamp is the only place the recording state shows", async () => {
  const clock = fakeClock();
  const { app, elements } = await loadDash({ clock });
  app.init();
  assert.equal(elements.get("lampRec").className, "lamp", "還沒出發時不亮");

  const metre = 1 / 111194.93;
  let lat = 25.0330;
  const roll = () => { lat += 20 * metre; app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: clock() }); };
  roll(); clock.advance(1000); roll(); clock.advance(1000); roll();
  assert.equal(elements.get("lampRec").className, "lamp rec", "記錄中要亮");

  clock.advance(app.constants.AUTO_PAUSE_MS + 1000);
  app.tick();
  assert.equal(elements.get("lampRec").className, "lamp", "自動停止後熄掉");
});

test("a denied location permission says what to do about it", async () => {
  const { app, elements, geolocation } = await loadDash();
  app.init();

  geolocation.watches[0].onErr({ code: 1, message: "User denied Geolocation" });
  assert.equal(elements.get("gpsError").hidden, false, "沒有按鈕可重按了，必須有文字說明");
  assert.match(elements.get("gpsError").textContent, /定位權限被拒/);
  assert.match(elements.get("gpsError").textContent, /設定/, "要告訴使用者去哪裡開");
  assert.equal(elements.get("lampGps").className, "lamp bad");
  assert.equal(app.getState().gps.hasFix, false);
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







test("the scale sits in the same box as the bar so the labels line up", async () => {
  const { html } = await loadDash();

  // 實測踩過：刻度原本是 .bar-head 的兄弟節點，寬度含右側燈號那一段。
  // 直式下速度條只剩 90px 而刻度攤在 343px 上，「110」落在最後一段右邊 245px——
  // 標籤跟段位完全對不上，刻度變成裝飾而不是儀表。
  // 兩者必須在同一個容器裡才會等寬，中間不可以插進別的東西。
  const barAt = html.indexOf('id="revBar"');
  const scaleAt = html.indexOf('id="barScale"');
  assert.ok(barAt > 0 && scaleAt > barAt, "刻度要排在速度條後面");
  const between = html.slice(barAt, scaleAt);
  assert.doesNotMatch(between, /class="lamps"/, "燈號不可以插在條與刻度之間");
  assert.match(html, /<div class="bar-col">/, "條與刻度要包在同一個容器裡");
  const colAt = html.indexOf('<div class="bar-col">');
  assert.ok(colAt > 0 && colAt < barAt, "容器要包住速度條");

  // 燈號一律自己一列，速度條吃滿整個面板寬度。橫放時也一樣——先前只讓窄螢幕這樣排，
  // 結果四顆燈在橫式吃掉 32% 的條寬（實測 567 / 838）。
  const barHead = html.match(/\n\s*\.bar-head\{[^}]*\}/)?.[0] || "";
  assert.match(barHead, /flex-direction:column-reverse/, "燈號要自己一列，不跟速度條搶寬度");
});

test("landscape fills the viewport instead of leaving dead space at the bottom", async () => {
  const { html } = await loadDash();
  const landscape = html.match(/@media \(orientation:landscape\)[^{]*\{[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(landscape, "橫式規則應該存在");

  // 實測踩過：內容到 347 而視窗 393，底部空了 46px。
  // 先前只驗 scrollHeight === innerHeight，但 body 有 min-height:100vh，
  // 那個等式只代表「沒有溢出」，不代表「有填滿」。
  assert.match(landscape, /\.hud\{[^}]*min-height:100dvh/, "要撐滿動態視窗高度");
  assert.match(landscape, /\.hud\{[^}]*min-height:100vh/, "要有 100vh 備援");
  assert.doesNotMatch(landscape, /\.hud\{[^}]*[^-]height:100dvh;/, "要用 min-height，內容變高時不能被裁掉");
  assert.match(landscape, /\.cluster\{[^}]*flex:1 1 auto/, "面板要吃掉剩下的高度");
  assert.match(landscape, /\.hero\{[^}]*flex:1 1 auto/, "多出來的高度要給車速");
});

test("the control row divides evenly however many buttons are showing", async () => {
  const { html } = await loadDash();

  // 實測踩過：欄數寫死 6，但傾角按鈕拿到權限就自我隱藏，只剩 4 顆時
  // 右側空掉 281px（佔整列 33%）。改成有幾顆就均分幾欄。
  for (const [label, block] of [
    ["寬螢幕", html.match(/@media \(min-width:760px\)\{[\s\S]*?\n  \}/)?.[0] || ""],
    ["橫式", html.match(/@media \(orientation:landscape\)[^{]*\{[\s\S]*?\n  \}/)?.[0] || ""],
  ]) {
    assert.ok(block, `${label}規則應該存在`);
    const rule = block.match(/\.controls\{[^}]*\}/)?.[0] || "";
    assert.ok(rule, `${label}的 .controls 規則應該存在`);
    assert.match(rule, /grid-auto-flow:column/, `${label}的控制列要自動均分`);
    assert.doesNotMatch(rule, /grid-template-columns:repeat/, `${label}不可寫死欄數`);
  }
});

test("red is reserved for faults, so the rec lamp uses another colour", async () => {
  const { html } = await loadDash();

  // 紅色在這頁已經是「故障」與「超過紅線」的意思。再拿去表示「正在記錄」的話，
  // 騎車瞄一眼看到紅色會分不出是正常還是出事。
  const recRule = html.match(/\.lamp\.rec\{[^}]*\}/)?.[0] || "";
  assert.ok(recRule, ".lamp.rec 規則應該存在");
  assert.doesNotMatch(recRule, /--red/, "記錄中不可以用紅色");
  const badRule = html.match(/\.lamp\.bad\{[^}]*\}/)?.[0] || "";
  assert.match(badRule, /--red/, "故障才是紅色");
});

test("the waiting state is not two big grey slabs", async () => {
  const { html } = await loadDash();

  // 車速 133px 時兩個連字號就是兩塊大灰磚，看起來像壞掉而不是在等定位
  const idleRule = html.match(/\.speed\.idle\{[^}]*\}/)?.[0] || "";
  assert.ok(idleRule, ".speed.idle 規則應該存在");
  assert.match(idleRule, /font-size/, "等待狀態要縮小");
  // 高度要由 .hero 撐住，第一次定位進來才不會整頁往下跳
  const heroRule = html.match(/\n\s*\.hero\{[^}]*\}/)?.[0] || "";
  assert.match(heroRule, /min-height/, ".hero 要釘死高度避免跳版");
});

test("the page no longer claims it keeps no coordinates, because it does", async () => {
  const { html } = await loadDash();

  // 這頁一度宣稱「不記錄行經路線、不儲存任何座標」。加了軌跡之後座標真的落地，
  // 那句話就不再是事實。程式偷偷存、頁面繼續宣稱沒存，是最該擋下的一種漂移。
  assert.doesNotMatch(html, /不記錄行經路線|不儲存任何座標/, "舊的說法不可以留著");
  assert.match(html, /軌跡會留在這支手機上/, "要講清楚座標留在裝置上");
  assert.match(html, /清除本趟/, "要指名刪除的方式");
  assert.match(html, /不上傳/, "不上傳這件事仍然成立");
});

test("track points are only taken once you have actually moved far enough", async () => {
  const { app } = await loadDash();
  const { shouldAppendPoint } = app.helpers;
  const { TRACK_MIN_M } = app.constants;
  const metre = 1 / 111194.93;
  const at = (n) => ({ lat: 25.033 + n * metre, lon: 121.5654 });

  assert.equal(shouldAppendPoint(null, at(0), TRACK_MIN_M), true, "第一點一定收");
  assert.equal(shouldAppendPoint(at(0), at(5), TRACK_MIN_M), false, "太近只是在存 GPS 抖動");
  assert.equal(shouldAppendPoint(at(0), at(TRACK_MIN_M), TRACK_MIN_M), true, "門檻值本身要收");
  assert.equal(shouldAppendPoint(at(0), at(100), TRACK_MIN_M), true);
  assert.equal(shouldAppendPoint(at(0), { lat: null, lon: null }, TRACK_MIN_M), false);
  assert.equal(shouldAppendPoint(at(0), null, TRACK_MIN_M), false);
});

test("thinning halves the track but keeps both ends", async () => {
  const { app } = await loadDash();
  const { thinTrack } = app.helpers;
  const pts = Array.from({ length: 11 }, (_, i) => ({ lat: 25 + i, lon: 121 }));

  const thin = thinTrack(pts);
  assert.ok(thin.length < pts.length && thin.length >= pts.length / 2);
  assert.equal(thin[0].lat, 25, "起點要留");
  assert.equal(thin[thin.length - 1].lat, 35, "終點要留");
  for (let i = 1; i < thin.length; i++) {
    assert.ok(thin[i].lat > thin[i - 1].lat, "順序不可以亂");
  }
  assert.deepEqual([...thinTrack([])], []);
  assert.equal(thinTrack([{ lat: 25, lon: 121 }]).length, 1, "太短就原樣回傳");
});

test("the track is scaled without distorting its shape", async () => {
  const { app } = await loadDash();
  const { trackPolyline } = app.helpers;

  // 繞一個正方形（經度先除以 cos(lat) 抵銷投影），畫出來必須還是正方形。
  // 不修正經度的話，台灣緯度上會被橫向拉寬約 8%。
  const lat0 = 25, d = 0.01, kx = Math.cos(lat0 * Math.PI / 180);
  const square = [
    { lat: lat0, lon: 121 },
    { lat: lat0 + d, lon: 121 },
    { lat: lat0 + d, lon: 121 + d / kx },
    { lat: lat0, lon: 121 + d / kx },
    { lat: lat0, lon: 121 },
  ];
  const pts = trackPolyline(square, 100, 100, 0).split(" ").map((s) => s.split(",").map(Number));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(w - h) < 1, `正方形不可以畫成長方形，實得 ${w.toFixed(1)}x${h.toFixed(1)}`);

  // 一律落在框內
  assert.ok(xs.every((x) => x >= 0 && x <= 100) && ys.every((y) => y >= 0 && y <= 100));

  // 緯度越大越靠上（SVG 的 y 軸向下）
  const northSouth = trackPolyline([{ lat: 25, lon: 121 }, { lat: 26, lon: 121 }], 100, 100, 0)
    .split(" ").map((s) => s.split(",").map(Number));
  assert.ok(northSouth[1][1] < northSouth[0][1], "北邊的點要畫在上面");

  assert.equal(trackPolyline([], 100, 100, 0), "");
  assert.equal(trackPolyline(null, 100, 100, 0), "");
  assert.equal(trackPolyline([{ lat: 25, lon: 121 }], 100, 100, 0), "50.0,50.0", "單點畫在正中央");
  assert.equal(trackPolyline(square, 0, 100, 0), "", "沒有寬度就畫不出來");
});

test("standing still does not grow a track", async () => {
  const store = fakeStorage();
  const { app } = await loadDash({ localStorage: store });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;

  // 沿用漂移案例：位移 2m、精度 8m，餵十筆
  for (let i = 0; i < 10; i++) {
    lat += 2 * metre;
    app.applyFix({ kmh: null, accuracy: 8, lat, lon: 121.5654, t: 1000 * (i + 1) });
  }
  assert.equal(app.getState().track.length, 0, "停著不可以在原地堆出一團雜訊");
  assert.equal(store.getItem(app.constants.TRACK_KEY), null, "也不該寫進 localStorage");
});

test("a real ride draws a track, and clearing the trip deletes the stored coordinates", async () => {
  const store = fakeStorage();
  const { app, elements } = await loadDash({ localStorage: store });
  app.init();
  const metre = 1 / 111194.93;
  let lat = 25.0330;
  for (let i = 0; i < 12; i++) {
    lat += 40 * metre;
    app.applyFix({ kmh: 72, accuracy: 8, lat, lon: 121.5654, t: 1000 * (i + 1) });
  }
  assert.ok(app.getState().track.length >= 3, `應該收到點，實得 ${app.getState().track.length}`);
  assert.ok(store.getItem(app.constants.TRACK_KEY), "座標要落地");

  // 座標必須放在自己的 key，不可以混進偏好設定那一份
  assert.doesNotMatch(store.getItem("bjkw-dash:v1") || "", /lat|lon|25\.03/, "偏好設定裡不可以有座標");

  elements.get("btnReset").fire("click");
  assert.equal(app.getState().track.length, 0);
  assert.equal(store.getItem(app.constants.TRACK_KEY), null, "清除本趟要真的把落地的座標刪掉");
});

test("a saved track comes back when the page reopens", async () => {
  const store = fakeStorage({
    "bjkw-dash-track:v1": JSON.stringify([[25.0330, 121.5654], [25.0335, 121.5658], [25.0340, 121.5661]]),
  });
  const { app, elements } = await loadDash({ localStorage: store });
  app.init();

  assert.equal(app.getState().track.length, 3, "重開頁面要看得到上一趟");
  assert.equal(elements.get("track").hidden, false, "有兩點以上才畫得出線");
  assert.ok(elements.get("trackLine").getAttribute("points").split(" ").length === 3);
  // 壞掉的存檔不可以讓整頁掛掉
  const broken = await loadDash({ localStorage: fakeStorage({ "bjkw-dash-track:v1": "{not json" }) });
  broken.app.init();
  assert.equal(broken.app.getState().track.length, 0);
});

test("colour bands sit on real speeds, not on a fraction of the bar", async () => {
  const { app } = await loadDash();
  const { speedColor } = app.helpers;
  const { AMBER_AT_KMH, RED_AT_KMH } = app.constants;

  // 分界釘在真實車速上，改主尺上限時不會跟著跑掉——市區永遠是綠的
  assert.equal(speedColor(0), "green");
  assert.equal(speedColor(50), "green", "市區");
  assert.equal(speedColor(AMBER_AT_KMH - 0.1), "green");
  assert.equal(speedColor(AMBER_AT_KMH), "amber", "分界值算進較高的一段");
  assert.equal(speedColor(110), "amber", "國道正常速度不該是紅的");
  assert.equal(speedColor(RED_AT_KMH), "red");
  assert.equal(speedColor(200), "red");
  assert.equal(speedColor(null), "green");
});

test("the main bar only covers the range you actually ride in", async () => {
  const { app } = await loadDash();
  const { ledStates, speedColor } = app.helpers;
  const { BAR_SEGMENTS, BAR_MAX_KMH } = app.constants;

  const dark = ledStates(0);
  assert.equal(dark.length, BAR_SEGMENTS);
  assert.ok(dark.every((s) => s === "off"));

  // 整條 0~220 線性的話，50 km/h 只點得亮四格，解析度等於丟掉
  const city = ledStates(50).filter((s) => s !== "off").length;
  assert.ok(city >= 6 && city <= 8, `50 km/h 應該亮 6~8 格，實得 ${city}`);

  const full = ledStates(BAR_MAX_KMH);
  assert.equal(full.filter((s) => s !== "off").length, BAR_SEGMENTS, "到上限就滿格");
  assert.equal(full[BAR_SEGMENTS - 1], "red", "最後一格代表上限，是紅的");
  assert.equal(full[0], "green");
  assert.ok(full.includes("amber"));

  // 每一格的顏色固定在它代表的速度上，黃區永遠在同一個實體位置
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    if (full[i] === "off") continue;
    assert.equal(full[i], speedColor((i + 1) * BAR_MAX_KMH / BAR_SEGMENTS), `第 ${i + 1} 格`);
  }
  assert.equal(ledStates(400).filter((s) => s !== "off").length, BAR_SEGMENTS, "超過上限主尺就是滿格，不會多算");
  assert.equal(ledStates(null).filter((s) => s !== "off").length, 0);
});

test("the over-range block stays dark until you pass the main scale", async () => {
  const { app } = await loadDash();
  const { overStates } = app.helpers;
  const { OVER_SEGMENTS, BAR_MAX_KMH, OVER_MAX_KMH } = app.constants;

  const lit = (kmh) => overStates(kmh).filter((s) => s !== "off").length;
  assert.equal(overStates(0).length, OVER_SEGMENTS);
  assert.equal(lit(50), 0, "日常騎乘完全不該碰到超速段");
  assert.equal(lit(110), 0, "國道正常速度也不該碰到");
  assert.equal(lit(BAR_MAX_KMH), 0, "剛好在上限還不算超過");
  assert.equal(lit(BAR_MAX_KMH + 1), 1, "一超過就亮第一格");
  assert.equal(lit(OVER_MAX_KMH), OVER_SEGMENTS, "到頂全亮");
  assert.equal(lit(400), OVER_SEGMENTS, "再快也不會多算");
  assert.equal(lit(null), 0);
  assert.ok(overStates(200).filter((s) => s !== "off").every((s) => s === "red"), "超速段一律紅色");
});

test("the speed bar ramps up from left to right", async () => {
  const { app } = await loadDash();
  const { barSegmentHeight } = app.helpers;
  const { BAR_SEGMENTS, BAR_MIN_H } = app.constants;

  assert.ok(Math.abs(barSegmentHeight(0, BAR_SEGMENTS) - BAR_MIN_H) < 1e-9, "最左邊最矮");
  assert.ok(Math.abs(barSegmentHeight(BAR_SEGMENTS - 1, BAR_SEGMENTS) - 1) < 1e-9, "最右邊滿高");
  let prev = -1;
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    const h = barSegmentHeight(i, BAR_SEGMENTS);
    assert.ok(h > prev, `第 ${i} 段要比前一段高`);
    assert.ok(h > 0 && h <= 1, "高度必須落在 0..1");
    prev = h;
  }
  assert.equal(barSegmentHeight(-5, BAR_SEGMENTS), BAR_MIN_H, "超出範圍要夾住");
  assert.equal(barSegmentHeight(999, BAR_SEGMENTS), 1);
});

test("bar scale labels are round numbers in the current unit", async () => {
  const { app } = await loadDash();
  const { barScaleValues } = app.helpers;
  const { BAR_MAX_KMH, BAR_SCALE_STEPS } = app.constants;

  const kmh = barScaleValues(BAR_MAX_KMH, "kmh", BAR_SCALE_STEPS);
  assert.equal(kmh.length, BAR_SCALE_STEPS);
  assert.equal(kmh[0], 0, "從 0 開始");
  assert.equal(kmh[kmh.length - 1], BAR_MAX_KMH, "最後一格是主尺上限");
  // 儀表上出現 28、83 這種數字沒有人看得下去
  assert.ok(kmh.every((v) => v % 5 === 0), `刻度要取整到 5，實得 ${kmh.join(",")}`);
  for (let i = 1; i < kmh.length; i++) assert.ok(kmh[i] > kmh[i - 1], "刻度必須遞增");

  const mph = barScaleValues(BAR_MAX_KMH, "mph", BAR_SCALE_STEPS);
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
  assert.equal(elements.get("btnUnit").textContent, "切換 mph");
  assert.equal(elements.get("lampRec").className, "lamp", "還沒出發時 REC 不亮");
  assert.equal(elements.get("gpsError").hidden, true, "沒有錯誤時不顯示");
  assert.equal(elements.get("revBar").children.length, app.constants.BAR_SEGMENTS);
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
    String(app.constants.BAR_MAX_KMH)
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
  assert.equal(prefs.redlineKmh, undefined, "刻度上限是常數，不該進 prefs");
});

test("a stale redline in an old save cannot override the constant", async () => {
  // 實測踩過：savePrefs 把整包 prefs 序列化，redlineKmh 也被寫進去。
  // 使用者裝置上存著舊的 110，之後改常數改不動——舊存檔會把新值蓋回去。
  // 紅線沒有任何 UI 可以調，是常數不是偏好設定，不該落地。
  const store = fakeStorage({
    "bjkw-dash:v1": JSON.stringify({ unit: "kmh", redlineKmh: 110, bestTopSpeed: 88 }),
  });
  const { app, elements } = await loadDash({ localStorage: store });
  app.init();

  assert.equal(app.getState().prefs.redlineKmh, undefined, "舊存檔的 redlineKmh 不可以被讀進來");
  assert.equal(
    elements.get("barScale").children[app.constants.BAR_SCALE_STEPS - 1].textContent,
    String(app.constants.BAR_MAX_KMH),
    "刻度上限要跟著常數走"
  );
  assert.equal(app.getState().prefs.bestTopSpeed, 88, "個人最佳還是要讀回來");

  // 之後寫回去時也不可以再把常數存進存檔
  elements.get("btnUnit").fire("click");
  assert.equal(JSON.parse(store.getItem("bjkw-dash:v1")).redlineKmh, undefined, "常數不該落地");
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
