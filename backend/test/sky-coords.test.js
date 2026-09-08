import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDeg, normalizeHourAngle, angularSeparation, clamp, toRadians, toDegrees } from "../../sky/lib/angles.mjs";
import {
  horizontalToHourAngle, hourAngleToHorizontal,
  horizontalToEquatorial, equatorialToHorizontal,
  precessJ2000ToDate, precessDateToJ2000,
  refractionDeg, trueAltitudeFromApparentDeg, apparentAltitudeFromTrueDeg,
} from "../../sky/lib/coords.mjs";
import { applyDeclination, lookupDeclination } from "../../sky/lib/geomag.mjs";

// 參考值全部由 pyerfa 2.0.1.5（IAU SOFA 直譯版）產生，不是抄書：
//   erfa.hd2ae(H, dec, lat) -> (方位角(北起算,東為正), 高度角)，純球面幾何、不含時間與曆表。
//   erfa.pmat76(jd, 0.0)    -> IAU1976(Lieske) 歲差矩陣。
// 交叉核對：第一筆同時等於 Meeus Example 13.b 的金星（他印的是「從南起算」的
// 68.0337 度，＝這裡的 248.0337 減 180；高度角 15.1249 相符到 0.1 角秒）。
const HD2AE = [
  { label: "Meeus 13.b Venus (Washington)", hourAngleDeg: 64.352133, decDeg: -6.719891666666666, latDeg: 38.921388888888885, azDeg: 248.033693752, altDeg: 15.124874009 },
  { label: "taipei north-east low", hourAngleDeg: -35, decDeg: 12.5, latDeg: 25.033, azDeg: 104.257196231, altDeg: 54.705737825 },
  { label: "southern hemisphere", hourAngleDeg: 120, decDeg: -45, latDeg: -33.8688, azDeg: 217.987454128, altDeg: 5.768234091 },
  { label: "high latitude circumpolar", hourAngleDeg: -150, decDeg: 78, latDeg: 64.1466, azDeg: 10.016424069, altDeg: 53.295635349 },
  { label: "equator, object on meridian", hourAngleDeg: 0, decDeg: 10, latDeg: 0, azDeg: 0, altDeg: 80 },
];

const PRECESSION = [
  { label: "Betelgeuse-ish", unixMs: 1767225600000, ra2000: 88.792939, dec2000: 7.407064, raDate: 89.144903676, decDate: 7.409668716 },
  { label: "Polaris-ish", unixMs: 1767225600000, ra2000: 37.954561, dec2000: 89.264109, raDate: 46.462244641, decDate: 89.371597826 },
];

const TOL = 1e-8;

// ─────────────────────────────── angles.mjs ───────────────────────────────

test("normalizeDeg lands every input in [0, 360)", () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(360), 0);
  assert.equal(normalizeDeg(-0.5), 359.5);
  assert.equal(normalizeDeg(720.25), 0.25);
  assert.equal(normalizeDeg(-720.25), 359.75);
  for (const x of [-1e6, -360, -1e-13, 0, 1e-13, 359.9999, 360, 1e6]) {
    const n = normalizeDeg(x);
    assert.ok(n >= 0 && n < 360, `normalizeDeg(${x}) = ${n} 跑出 [0,360)`);
  }
});

// 時角與方位角必須用不同的正規化函式。混用不會拋錯，只會安靜地差 360 度。
test("normalizeHourAngle lands every input in (-180, 180]", () => {
  assert.equal(normalizeHourAngle(0), 0);
  assert.equal(normalizeHourAngle(180), 180);
  assert.equal(normalizeHourAngle(-180), 180, "-180 與 +180 等價，回傳值取正的那個");
  assert.equal(normalizeHourAngle(181), -179);
  assert.equal(normalizeHourAngle(-181), 179);
  assert.equal(normalizeHourAngle(540), 180);
  for (const x of [-1e6, -181, -180, 0, 180, 181, 1e6]) {
    const n = normalizeHourAngle(x);
    assert.ok(n > -180 && n <= 180, `normalizeHourAngle(${x}) = ${n} 跑出 (-180,180]`);
  }
});

// 這是 0/360 接縫。用減法會得到 359.8，星表查詢會把 0h 附近的星整批漏掉。
test("angular separation crosses the 0/360 seam", () => {
  assert.ok(Math.abs(angularSeparation(359.9, 0, 0.1, 0) - 0.2) < 1e-12,
    "359.9 與 0.1 相距 0.2 度，不是 359.8 度");
  assert.ok(Math.abs(angularSeparation(0, 0, 1, 0) - 1) < 1e-12);
  assert.ok(Math.abs(angularSeparation(0, 89, 180, 89) - 2) < 1e-12, "跨過天極的兩點");
  assert.ok(Math.abs(angularSeparation(12.3, -45.6, 12.3, -45.6)) < 1e-12, "同一點距離為 0");
  const a = angularSeparation(10, 20, 200, -30);
  const b = angularSeparation(200, -30, 10, 20);
  assert.ok(Math.abs(a - b) < 1e-12, "必須對稱");
});

// 用 haversine 而不是 acos 的理由：小角度時 acos 的引數趨近 1，精度整個垮掉。
// Phase 3 的星表比對全都是小角度，這條是那件事的前提。
test("angular separation keeps precision at the small angles star matching actually uses", () => {
  const d = angularSeparation(0, 0, 1e-6, 0);
  assert.ok(Math.abs(d - 1e-6) / 1e-6 < 1e-6, `1 微度的相對誤差 ${Math.abs(d - 1e-6) / 1e-6}`);
});

test("clamp and the degree/radian pair are self-consistent", () => {
  assert.equal(clamp(1.5, -1, 1), 1);
  assert.equal(clamp(-1.5, -1, 1), -1);
  assert.equal(clamp(0.5, -1, 1), 0.5);
  assert.ok(Math.abs(toDegrees(toRadians(123.456)) - 123.456) < 1e-12);
  assert.equal(toRadians(180), Math.PI);
});

// ─────────────────────────── 赤道 ↔ 地平（純幾何） ───────────────────────────

test("hour angle to horizontal matches SOFA hd2ae on every vector", () => {
  for (const v of HD2AE) {
    const got = hourAngleToHorizontal({ hourAngleDeg: v.hourAngleDeg, decDeg: v.decDeg, latitudeDeg: v.latDeg });
    assert.ok(Math.abs(normalizeDeg(got.azimuthDeg - v.azDeg)) < TOL ||
              Math.abs(normalizeDeg(got.azimuthDeg - v.azDeg) - 360) < TOL,
      `${v.label}: 方位角 ${got.azimuthDeg} vs SOFA ${v.azDeg}`);
    assert.ok(Math.abs(got.altitudeDeg - v.altDeg) < TOL,
      `${v.label}: 高度角 ${got.altitudeDeg} vs SOFA ${v.altDeg}`);
  }
});

test("horizontal to hour angle inverts every SOFA vector", () => {
  for (const v of HD2AE) {
    const got = horizontalToHourAngle({ azimuthDeg: v.azDeg, altitudeDeg: v.altDeg, latitudeDeg: v.latDeg });
    assert.ok(Math.abs(normalizeHourAngle(got.hourAngleDeg - v.hourAngleDeg)) < TOL,
      `${v.label}: 時角 ${got.hourAngleDeg} vs ${v.hourAngleDeg}`);
    assert.ok(Math.abs(got.decDeg - v.decDeg) < TOL,
      `${v.label}: 赤緯 ${got.decDeg} vs ${v.decDeg}`);
  }
});

test("horizontal and equatorial are exact inverses over 2000 random samples", () => {
  let worst = 0, worstAt = null;
  let seed = 20260908;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2000; i += 1) {
    const azimuthDeg = rand() * 360;
    const altitudeDeg = rand() * 176 - 88;      // 極點與天頂另有專屬測試，這裡避開
    const latitudeDeg = rand() * 176 - 88;
    const fwd = horizontalToHourAngle({ azimuthDeg, altitudeDeg, latitudeDeg });
    const back = hourAngleToHorizontal({ hourAngleDeg: fwd.hourAngleDeg, decDeg: fwd.decDeg, latitudeDeg });
    const err = Math.abs(normalizeHourAngle(back.azimuthDeg - azimuthDeg)) + Math.abs(back.altitudeDeg - altitudeDeg);
    if (err > worst) { worst = err; worstAt = { azimuthDeg, altitudeDeg, latitudeDeg }; }
  }
  assert.ok(worst < 1e-9, `來回誤差 ${worst} 度，最差發生在 ${JSON.stringify(worstAt)}`);
});

// ─────────────────────────────── 邊界條件 ───────────────────────────────

// 實測：把手機指向天球極（仰角＝緯度、方位角＝正北）時，
// sin(a)sin(φ)+cos(a)cos(φ)cos(A) 會算出 1.0000000000000002，Math.asin 對它回 NaN
// 而且不拋錯。這不是理論上的角落，是這個 app 最常見的動作之一。
test("asin argument overflow at the celestial pole must not produce NaN", () => {
  const latitudeDeg = -89;
  const altitudeDeg = latitudeDeg - 5e-10;
  const naive = Math.sin(toRadians(altitudeDeg)) * Math.sin(toRadians(latitudeDeg)) +
                Math.cos(toRadians(altitudeDeg)) * Math.cos(toRadians(latitudeDeg)) * Math.cos(0);
  assert.ok(naive > 1, `這組輸入應該要溢位才有測試價值，實得 ${naive}`);
  assert.ok(Number.isNaN(Math.asin(naive)), "未 clamp 的話 asin 確實回 NaN");

  const got = horizontalToHourAngle({ azimuthDeg: 0, altitudeDeg, latitudeDeg });
  assert.ok(Number.isFinite(got.decDeg), `clamp 後赤緯必須是有限值，實得 ${got.decDeg}`);
  assert.ok(Math.abs(got.decDeg - 90) < 1e-6, `指向天球極時赤緯應為 90，實得 ${got.decDeg}`);
  assert.equal(got.raDefined, false, "正好在天極上時赤經沒有意義");
});

// 實測結論（與初版設計文件的猜測相反）：cos(90°) 在浮點下是 6.1e-17 而不是 0，
// 所以分母 = cos(緯度) ≠ 0，atan2 條件良好，不需要特例分支。這條測試把這件事釘住，
// 免得日後有人「順手加個 if」而改變行為。
test("zenith needs no special case: dec equals latitude and hour angle is zero", () => {
  for (const latitudeDeg of [-60, -25.033, 0, 25.033, 60]) {
    for (const azimuthDeg of [0, 90, 180, 270]) {
      const got = horizontalToHourAngle({ azimuthDeg, altitudeDeg: 90, latitudeDeg });
      assert.ok(Math.abs(got.decDeg - latitudeDeg) < 1e-12,
        `lat=${latitudeDeg} az=${azimuthDeg}: 天頂的赤緯應等於緯度，實得 ${got.decDeg}`);
      assert.ok(Math.abs(got.hourAngleDeg) < 1e-9,
        `lat=${latitudeDeg} az=${azimuthDeg}: 天頂的時角應為 0，實得 ${got.hourAngleDeg}`);
      assert.equal(got.raDefined, true);
    }
  }
});

test("nadir gives the mirrored declination and a canonical 180 degree hour angle", () => {
  for (const latitudeDeg of [-60, 0, 25.033, 60]) {
    for (const azimuthDeg of [0, 90, 180, 270]) {
      const got = horizontalToHourAngle({ azimuthDeg, altitudeDeg: -90, latitudeDeg });
      assert.ok(Math.abs(got.decDeg + latitudeDeg) < 1e-12, `天底赤緯應為 -緯度，實得 ${got.decDeg}`);
      assert.equal(got.hourAngleDeg, 180,
        `天底時角必須正規化成 +180 而不是 -180（實得 ${got.hourAngleDeg}）`);
    }
  }
});

// 觀測者站在地極：公式本身良好定義（赤緯就等於仰角），真正沒有意義的是「經度」，
// 因此 LST 無從決定。那是資料問題，不是這條公式的問題，所以旗標掛在 equatorial 那層。
test("observer at the geographic pole still has a well defined declination", () => {
  for (const azimuthDeg of [0, 90, 180, 270]) {
    const north = horizontalToHourAngle({ azimuthDeg, altitudeDeg: 45, latitudeDeg: 90 });
    assert.ok(Math.abs(north.decDeg - 45) < 1e-9, `北極觀測者的赤緯應等於仰角，實得 ${north.decDeg}`);
    const south = horizontalToHourAngle({ azimuthDeg, altitudeDeg: 45, latitudeDeg: -90 });
    assert.ok(Math.abs(south.decDeg + 45) < 1e-9, `南極觀測者的赤緯應等於負仰角，實得 ${south.decDeg}`);
  }
});

// 唯一真正的 0/0：站在地極、又剛好指著天頂。此時看的就是天球極本身，
// 它的赤經在定義上就不存在，所以「時角是任意值」是正確答案，不是 bug。
test("pole observer looking at the zenith is the one genuinely undefined case", () => {
  for (const azimuthDeg of [0, 90, 180]) {
    const got = horizontalToHourAngle({ azimuthDeg, altitudeDeg: 90, latitudeDeg: 90 });
    assert.ok(Math.abs(got.decDeg - 90) < 1e-9);
    assert.equal(got.raDefined, false, "指著天球極時必須說出赤經無定義，不可回一個看起來正常的數字");
    assert.ok(Number.isFinite(got.hourAngleDeg), "即使無定義也不可以是 NaN");
  }
});

test("equatorial output stays in [0,360) across the right ascension seam", () => {
  const unixMs = 1788825600000;
  for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 7) {
    const got = horizontalToEquatorial({ azimuthDeg, altitudeDeg: 33, latitudeDeg: 25.033, longitudeDeg: 121.5654, unixMs });
    assert.ok(got.raDeg >= 0 && got.raDeg < 360, `az=${azimuthDeg} 給出 ra=${got.raDeg}`);
    assert.ok(got.decDeg >= -90 && got.decDeg <= 90);
  }
});

test("equatorial round trip returns the original pointing", () => {
  const unixMs = 1788825600000;
  const site = { latitudeDeg: 25.033, longitudeDeg: 121.5654, unixMs };
  for (const azimuthDeg of [0, 47, 133, 265, 359.5]) {
    for (const altitudeDeg of [-30, 0, 12.5, 75]) {
      const eq = horizontalToEquatorial({ azimuthDeg, altitudeDeg, ...site });
      const back = equatorialToHorizontal({ raDeg: eq.raDeg, decDeg: eq.decDeg, ...site });
      assert.ok(Math.abs(normalizeHourAngle(back.azimuthDeg - azimuthDeg)) < 1e-9,
        `方位角來回 ${back.azimuthDeg} vs ${azimuthDeg}`);
      assert.ok(Math.abs(back.altitudeDeg - altitudeDeg) < 1e-9);
    }
  }
});

test("bad input is rejected instead of flowing through as NaN", () => {
  assert.throws(() => horizontalToHourAngle({ azimuthDeg: NaN, altitudeDeg: 0, latitudeDeg: 0 }), /azimuthDeg/);
  assert.throws(() => horizontalToHourAngle({ azimuthDeg: 0, altitudeDeg: 91, latitudeDeg: 0 }), /altitudeDeg/);
  assert.throws(() => horizontalToHourAngle({ azimuthDeg: 0, altitudeDeg: 0, latitudeDeg: 91 }), /latitudeDeg/);
  assert.throws(() => equatorialToHorizontal({ raDeg: 0, decDeg: 91, latitudeDeg: 0, longitudeDeg: 0, unixMs: 0 }), /decDeg/);
});

// ─────────────────────────────── 歲差 ───────────────────────────────

test("precession from J2000 matches the SOFA IAU1976 rotation", () => {
  for (const v of PRECESSION) {
    const got = precessJ2000ToDate({ raDeg: v.ra2000, decDeg: v.dec2000, unixMs: v.unixMs });
    assert.ok(Math.abs(normalizeHourAngle(got.raDeg - v.raDate)) < 1e-6,
      `${v.label}: 赤經 ${got.raDeg} vs SOFA ${v.raDate}`);
    assert.ok(Math.abs(got.decDeg - v.decDate) < 1e-6,
      `${v.label}: 赤緯 ${got.decDeg} vs SOFA ${v.decDate}`);
  }
});

// 誤差預算表宣稱「忽略歲差在 2026 年會差約 0.36 度」。這條把那個數字釘住 ——
// 它是「歲差值得做、章動不值得做」這個取捨的唯一依據。
test("ignoring precession would cost about a third of a degree in 2026", () => {
  const v = PRECESSION[0];
  const got = precessJ2000ToDate({ raDeg: v.ra2000, decDeg: v.dec2000, unixMs: v.unixMs });
  const moved = angularSeparation(v.ra2000, v.dec2000, got.raDeg, got.decDeg);
  assert.ok(moved > 0.3 && moved < 0.4, `J2000→2026 的位移應在 0.3–0.4 度之間，實得 ${moved}`);
});

test("precession is invertible", () => {
  const unixMs = 1788825600000;
  for (const [raDeg, decDeg] of [[88.79, 7.41], [37.95, 89.26], [0.05, -0.02], [359.98, -75]]) {
    const fwd = precessJ2000ToDate({ raDeg, decDeg, unixMs });
    const back = precessDateToJ2000({ raDeg: fwd.raDeg, decDeg: fwd.decDeg, unixMs });
    assert.ok(Math.abs(normalizeHourAngle(back.raDeg - raDeg)) < 1e-9, `赤經來回 ${back.raDeg} vs ${raDeg}`);
    assert.ok(Math.abs(back.decDeg - decDeg) < 1e-9, `赤緯來回 ${back.decDeg} vs ${decDeg}`);
  }
});

test("precession is a no-op exactly at J2000", () => {
  const j2000Ms = 946728000000;
  const got = precessJ2000ToDate({ raDeg: 123.456, decDeg: -12.345, unixMs: j2000Ms });
  assert.ok(Math.abs(got.raDeg - 123.456) < 1e-12);
  assert.ok(Math.abs(got.decDeg + 12.345) < 1e-12);
});

// ─────────────────────────────── 折射 ───────────────────────────────

test("refraction has the textbook magnitudes at the horizon and at 30 degrees", () => {
  const horizon = refractionDeg(0) * 60;
  assert.ok(Math.abs(horizon - 34.5) < 0.5, `地平線折射應約 34.5 角分，實得 ${horizon}`);
  const thirty = refractionDeg(30) * 60;
  assert.ok(Math.abs(thirty - 1.7) < 0.1, `30 度仰角折射應約 1.7 角分，實得 ${thirty}`);
});

// Bennett 公式在 90 度附近 tan 越過極點會給出微小負值。折射不可能是負的，
// 那會讓「視高度 → 真高度」往錯的方向修。
test("refraction is never negative and never increases with altitude", () => {
  assert.equal(refractionDeg(90), 0, "天頂沒有折射");
  let prev = Infinity;
  for (let alt = 0; alt <= 90; alt += 0.5) {
    const r = refractionDeg(alt);
    assert.ok(r >= 0, `alt=${alt} 給出負折射 ${r}`);
    assert.ok(r <= prev + 1e-12, `alt=${alt} 的折射 ${r} 比 ${alt - 0.5} 度的 ${prev} 還大`);
    prev = r;
  }
});

// 管線方向：感測器給的是視高度，要先拆掉折射才能進座標轉換。裝反了天體會整批偏高。
test("removing refraction lowers the altitude and the two directions invert", () => {
  for (const apparent of [0, 1, 5, 20, 45, 80]) {
    const trueAlt = trueAltitudeFromApparentDeg(apparent);
    assert.ok(trueAlt <= apparent, `真高度必須低於視高度：${trueAlt} vs ${apparent}`);
    const roundTrip = apparentAltitudeFromTrueDeg(trueAlt);
    assert.ok(Math.abs(roundTrip - apparent) < 0.002,
      `視↔真來回誤差 ${Math.abs(roundTrip - apparent)} 度（apparent=${apparent}）`);
  }
});

// ─────────────────────────────── 磁偏角介面 ───────────────────────────────

// Phase 1 只交介面。查不到就回 null，讓上層說「未修正磁偏角」——
// 填 0 會讓畫面自信地指錯方向，那比沒有值危險。
test("declination is applied east-positive and normalized", () => {
  assert.ok(Math.abs(applyDeclination(10, -4.5) - 5.5) < 1e-12);
  assert.ok(Math.abs(applyDeclination(358, 5) - 3) < 1e-12, "必須繞過 360 度接縫");
  assert.ok(Math.abs(applyDeclination(2, -5) - 357) < 1e-12);
});

test("an unknown declination propagates as null rather than as zero", () => {
  assert.equal(applyDeclination(123, null), null);
  assert.equal(applyDeclination(123, undefined), null);
  assert.equal(lookupDeclination(25.033, 121.5654), null,
    "Phase 1 還沒有任何經查證的磁偏角資料，必須誠實回 null");
});
