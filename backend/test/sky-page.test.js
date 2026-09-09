import test from "node:test";
// 寬鬆版 assert：vm context 的原型與外面不同，strict 版的深層比較會誤判。
// 這與 convert-page.test.js / bait-page.test.js 的理由相同。
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function loadHelpers() {
  const html = await readFile(join(ROOT, "sky", "index.html"), "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "行內主程式必須緊貼 </body>");

  const window = { __SKY_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { readyState: "complete", addEventListener() {} },
    window,
    Math, isFinite, parseFloat, Number, String, Array, Object, JSON, Error,
  });
  context.globalThis = context;
  vm.runInContext(script, context, { filename: "sky/index.html" });

  assert.ok(window.SkyApp, "SkyApp 應該掛在 window 上");
  return window.SkyApp.helpers;
}

const star = (overrides) => Object.assign(
  { xPx: 0, yPx: 0, magnitude: 3, visible: true, hasDesignation: true, label: "x" },
  overrides);

test("the page exposes its pure helpers without running the browser code", async () => {
  const helpers = await loadHelpers();
  for (const name of ["magnitudeToRadiusPx", "selectLabels", "formatAltAz", "describeBlockers", "clampFovDeg", "readOrientationEvent"]) {
    assert.equal(typeof helpers[name], "function", `${name} 應該可以被測到`);
  }
});

test("brighter stars get bigger dots and the scale never inverts", async () => {
  const { magnitudeToRadiusPx } = await loadHelpers();
  const limit = 6;
  let previous = Infinity;
  for (let magnitude = -1.5; magnitude <= 6; magnitude += 0.5) {
    const radius = magnitudeToRadiusPx(magnitude, limit);
    assert.ok(radius <= previous + 1e-12, `星等 ${magnitude} 的點反而變大了`);
    assert.ok(radius > 0, "半徑必須為正");
    previous = radius;
  }
  assert.ok(magnitudeToRadiusPx(-1.46, limit) > magnitudeToRadiusPx(5.9, limit));
});

test("dot size stays inside its range even for magnitudes outside the catalogue", async () => {
  const { magnitudeToRadiusPx } = await loadHelpers();
  const values = [-30, -1.5, 6, 40, NaN, null, undefined].map((m) => magnitudeToRadiusPx(m, 6));
  for (const radius of values) {
    assert.ok(Number.isFinite(radius) && radius >= 1 && radius <= 5, `半徑跑掉了：${radius}`);
  }
});

// 標籤重疊會讓畫面變成一團字。這條釘住「亮的優先、太近的跳過」。
test("labels are picked brightest first and never crowd each other", async () => {
  const { selectLabels } = await loadHelpers();
  const hits = [
    star({ label: "faint-near", magnitude: 5, xPx: 105, yPx: 100 }),
    star({ label: "bright", magnitude: 0, xPx: 100, yPx: 100 }),
    star({ label: "far", magnitude: 4, xPx: 400, yPx: 400 }),
  ];
  const chosen = selectLabels(hits, { maxLabels: 8, minSeparationPx: 50 });
  assert.deepEqual(chosen.map((hit) => hit.label), ["bright", "far"],
    "最亮的先選，距離不足 50 px 的要被跳過");
});

test("labels skip anything invisible or without a designation", async () => {
  const { selectLabels } = await loadHelpers();
  const hits = [
    star({ label: "offscreen", magnitude: 0, visible: false, xPx: 0, yPx: 0 }),
    star({ label: "nameless", magnitude: 1, hasDesignation: false, xPx: 200, yPx: 200 }),
    star({ label: "good", magnitude: 2, xPx: 400, yPx: 400 }),
  ];
  assert.deepEqual(selectLabels(hits, {}).map((hit) => hit.label), ["good"]);
});

test("labels honour the maximum count", async () => {
  const { selectLabels } = await loadHelpers();
  const hits = [];
  for (let i = 0; i < 40; i += 1) hits.push(star({ label: "s" + i, magnitude: i / 10, xPx: i * 200, yPx: 0 }));
  assert.equal(selectLabels(hits, { maxLabels: 3, minSeparationPx: 10 }).length, 3);
});

// 實測過的缺陷：頁面原本只擋 event.alpha === null，但 beta 與 gamma 在沒有
// 加速度計的裝置上同樣會是 null。那時 orientationToPointing 會丟
// 「betaDeg 必須是有限的數字」，而那個例外是在 rAF 回呼裡丟的 ——
// 疊加層無聲凍結、相機還亮著、狀態列卻寫著「就緒」。
test("an orientation event missing any of its three angles is rejected whole", async () => {
  const { readOrientationEvent } = await loadHelpers();
  assert.deepEqual(readOrientationEvent({ alpha: 10, beta: 20, gamma: 30 }),
    { alphaDeg: 10, betaDeg: 20, gammaDeg: 30 });
  for (const missing of [
    { alpha: null, beta: 20, gamma: 30 },
    { alpha: 10, beta: null, gamma: 30 },
    { alpha: 10, beta: 20, gamma: null },
    { alpha: 10, beta: 20, gamma: undefined },
    { alpha: NaN, beta: 20, gamma: 30 },
  ]) {
    assert.strictEqual(readOrientationEvent(missing), null,
      `缺角度的事件必須整筆丟掉：${JSON.stringify(missing)}`);
  }
  assert.strictEqual(readOrientationEvent(null), null);
  // 0 是合法的角度，不可以被當成缺值。
  assert.deepEqual(readOrientationEvent({ alpha: 0, beta: 0, gamma: 0 }),
    { alphaDeg: 0, betaDeg: 0, gammaDeg: 0 });
});

test("the pointing readout names a compass direction and wraps at north", async () => {
  const { formatAltAz } = await loadHelpers();
  assert.ok(formatAltAz(0, 30).includes("北"));
  assert.ok(formatAltAz(90, 30).includes("東"));
  assert.ok(formatAltAz(180, 30).includes("南"));
  assert.ok(formatAltAz(270, 30).includes("西"));
  assert.ok(formatAltAz(45, 30).includes("東北"));
  // 359 度離北比離西北近；用 Math.round 而不處理環繞會掉到索引 8 而讀不到值。
  assert.ok(formatAltAz(359, 30).includes("北"), "接近 360 度時仍然是北");
  assert.equal(formatAltAz(NaN, 30), "—");
  assert.equal(formatAltAz(0, NaN), "—");
});

test("the readout says everything that is still missing, not just the first thing", async () => {
  const { describeBlockers } = await loadHelpers();
  assert.equal(describeBlockers({ camera: true, orientation: true, location: true, catalog: true }), "");
  const message = describeBlockers({ camera: true, orientation: false, location: false, catalog: true });
  assert.ok(message.includes("方位感測器") && message.includes("位置"),
    `兩項都缺就要兩項都講，實得 ${message}`);
});

// 視野角是使用者校正出來的，會被存進 localStorage 再讀回來（讀回來是字串）。
test("the field of view is clamped and parsed back from storage", async () => {
  const { clampFovDeg } = await loadHelpers();
  assert.equal(clampFovDeg("72"), 72, "從 localStorage 讀回來是字串");
  assert.equal(clampFovDeg(10), 35, "太窄要夾住");
  assert.equal(clampFovDeg(500), 100, "太寬要夾住");
  assert.equal(clampFovDeg("abc"), 65, "壞掉的值退回預設");
  assert.equal(clampFovDeg(null), 65);
});
