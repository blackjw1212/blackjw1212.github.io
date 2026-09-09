import test from "node:test";
import assert from "node:assert/strict";
import { julianDay, julianCenturies, gmstDeg, lstDeg, UNIX_EPOCH_JD, J2000_JD } from "../../sky/lib/time.mjs";
import { normalizeDeg } from "../../sky/lib/angles.mjs";

// 參考值的來源：pyerfa 2.0.1.5（IAU SOFA 的直譯版）的 erfa.gmst82()，
// 也就是這條多項式背後的那個標準模型本身，不是從書上抄來的。
// 重新產生的方法：
//   python -c "import erfa,math; print((erfa.gmst82(JD,0.0)*180/math.pi)%360)"
// 交叉核對：JD 2446895.5 那筆同時等於 Meeus《Astronomical Algorithms》Example 12.a
// 印出的 13h10m46.3668s（實測差 0.0004 角秒，就是印刷位數的捨入）。
const GMST_VECTORS = [
  { label: "J2000.0 epoch", unixMs: 946728000000, jd: 2451545.0, gmstDeg: 280.460618375 },
  { label: "Meeus 12.a cross-check", unixMs: 545011200000, jd: 2446895.5, gmstDeg: 197.693195113 },
  { label: "2026-09-08T00:00:00Z", unixMs: 1788825600000, jd: 2461291.5, gmstDeg: 347.072701507 },
  { label: "unix epoch", unixMs: 0, jd: 2440587.5, gmstDeg: 100.229637207 },
];

// 這條多項式與 SOFA gmst82 在 1970–2030 間最大差 0.00016 角秒（4.5e-8 度）。
// 容差取 1e-6 度＝0.0036 角秒，比實測殘差寬 80 倍、比感測器誤差嚴格五個數量級。
const GMST_TOLERANCE_DEG = 1e-6;

test("julian day anchors on the two epochs the rest of the pipeline is defined against", () => {
  assert.equal(julianDay(0), UNIX_EPOCH_JD);
  assert.equal(julianDay(0), 2440587.5);
  assert.equal(julianDay(946728000000), J2000_JD);
  assert.equal(julianDay(946728000000), 2451545.0);
});

test("julian day is linear in milliseconds", () => {
  const oneDay = 86400000;
  assert.equal(julianDay(oneDay) - julianDay(0), 1);
  assert.equal(julianDay(-oneDay) - julianDay(0), -1, "J2000 之前的時間必須是負的天數，不可 clamp");
});

test("julian centuries is zero at J2000 and one per 36525 days", () => {
  assert.equal(julianCenturies(J2000_JD), 0);
  assert.equal(julianCenturies(J2000_JD + 36525), 1);
});

test("GMST matches SOFA gmst82 on every reference epoch", () => {
  for (const v of GMST_VECTORS) {
    assert.equal(julianDay(v.unixMs), v.jd, `${v.label}: JD 對不上`);
    const got = gmstDeg(v.unixMs);
    const diff = Math.abs(((got - v.gmstDeg + 180) % 360) - 180);
    assert.ok(diff < GMST_TOLERANCE_DEG,
      `${v.label}: GMST 差 ${(diff * 3600).toFixed(6)} 角秒（${got} vs SOFA ${v.gmstDeg}）`);
  }
});

test("GMST is in [0, 360) even for times long before the unix epoch", () => {
  for (const unixMs of [0, -1, -1e12, -2.2e12, 1.8e12]) {
    const g = gmstDeg(unixMs);
    assert.ok(g >= 0 && g < 360, `unixMs=${unixMs} 給出 ${g}，跑出 [0,360)`);
  }
});

// 恆星日比太陽日短約 3 分 56 秒，所以一個太陽日 GMST 前進 360.9856 度而不是 360。
// 這條抓的是「把 360.98564736629 誤寫成 360」這類看起來很合理的錯誤。
test("GMST advances by one sidereal turn per solar day, not one full turn", () => {
  const t0 = 1788825600000;
  const advance = normalizeDeg(gmstDeg(t0 + 86400000) - gmstDeg(t0));
  assert.ok(Math.abs(advance - 0.98564736629) < 1e-6,
    `一個太陽日 GMST 應多走 0.9856 度，實得 ${advance}`);
});

test("LST is GMST plus east-positive longitude", () => {
  const t = 1788825600000;
  const taipeiLon = 121.5654;
  assert.ok(Math.abs(lstDeg(t, 0) - gmstDeg(t)) < 1e-12, "本初子午線的 LST 就是 GMST");
  const expected = normalizeDeg(gmstDeg(t) + taipeiLon);
  assert.ok(Math.abs(lstDeg(t, taipeiLon) - expected) < 1e-12);
  // 符號慣例：西經為負。寫成 `gmst - lon` 是這條公式最常見的錯誤。
  const west = lstDeg(t, -77.0656);
  const east = lstDeg(t, 77.0656);
  assert.ok(Math.abs(normalizeDeg(east - west) - 154.1312) < 1e-9,
    "東西經應該對稱地分居 GMST 兩側");
});

test("LST stays in [0, 360) across the wrap", () => {
  const t = 1788825600000;
  for (const lon of [-180, -121.5, 0, 121.5, 180]) {
    const l = lstDeg(t, lon);
    assert.ok(l >= 0 && l < 360, `lon=${lon} 給出 ${l}`);
  }
});

// 這條管線只吃 UTC 毫秒。餵進 Date、字串或 NaN 都是呼叫端的 bug，
// 要當場說清楚，不要靜默回 NaN 讓錯誤傳播到畫面上才發現星星不見了。
test("non-finite time is rejected loudly instead of silently producing NaN", () => {
  for (const bad of [NaN, Infinity, -Infinity, null, undefined, "0", new Date(0)]) {
    assert.throws(() => julianDay(bad), /unixMs/, `${String(bad)} 應該被擋下`);
    assert.throws(() => gmstDeg(bad), /unixMs/);
  }
  assert.throws(() => lstDeg(0, NaN), /longitudeDeg/);
  assert.throws(() => lstDeg(0, 181), /longitudeDeg/);
});
