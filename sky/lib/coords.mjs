// 地平座標 ↔ 赤道座標、歲差、大氣折射。
//
// 管線方向（反過來接會讓修正加反邊，而且數值仍然「看起來很合理」）：
//
//   感測器 (視位置) ─applyDeclination─▶ 真北方位角
//                   ─trueAltitudeFromApparentDeg─▶ 真高度
//                   ─horizontalToEquatorial─▶ (α, δ) 當日平分點
//                   ─precessDateToJ2000─▶ (α, δ) J2000  ──▶ 星表查詢
//
// Phase 4 把星投回畫面時走完全相反的順序，用的是同一組函式的反向版本。
//
// 角度慣例（每個函式的說明都會再講一次，因為記錯不會拋錯）：
//   方位角 A：真北為 0、向東為正、[0, 360)
//   高度角 a：地平線 0、天頂 +90
//   時角   H：(-180, +180]，正值代表已過中天
//   經度   λ：東為正

import {
  clamp, normalizeDeg, normalizeHourAngle, toDegrees, toRadians,
} from "./angles.mjs";
import { julianCenturies, julianDay, lstDeg } from "./time.mjs";

/**
 * |赤緯| 落在天極這麼近的範圍內時，赤經在定義上就不存在。
 * 不是精度門檻，是幾何事實：天極的赤經是任意值。
 */
export const RA_UNDEFINED_TOLERANCE_DEG = 1e-9;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 必須是有限的數字，實得 ${typeof value === "number" ? value : typeof value}`);
  }
}

function requireRange(name, value, min, max) {
  requireFiniteNumber(name, value);
  if (value < min || value > max) {
    throw new Error(`${name} 必須在 [${min}, ${max}]，實得 ${value}`);
  }
}

/**
 * 地平 → 時角/赤緯。純球面幾何，不牽涉時間，可以直接對照 SOFA 的 eraAe2hd。
 *
 * 為什麼 asin 的引數一定要 clamp：sin(a)sin(φ)+cos(a)cos(φ)cos(A) 在數學上必定
 * 落在 [-1, 1]，但浮點會給出 1.0000000000000002，而 Math.asin 對它回 NaN 且不拋錯。
 * 觸發條件是 a ≈ φ 且 A ≈ 0 —— 那正是把手機指向天球極（北極星）的時候，
 * 是這個 app 最常見的動作之一，不是理論上的角落。實測見 sky-coords.test.js。
 *
 * 天頂、天底、觀測者站在地極這三種情況都不需要特例分支：cos(90°) 在浮點下是
 * 6.1e-17 而不是 0，分母 = cos(φ) ≠ 0，atan2 條件良好。這件事被測試釘住，
 * 免得日後有人「順手加個 if」而改變行為。
 */
export function horizontalToHourAngle({ azimuthDeg, altitudeDeg, latitudeDeg }) {
  requireFiniteNumber("azimuthDeg", azimuthDeg);
  requireRange("altitudeDeg", altitudeDeg, -90, 90);
  requireRange("latitudeDeg", latitudeDeg, -90, 90);

  const a = toRadians(altitudeDeg);
  const phi = toRadians(latitudeDeg);
  const A = toRadians(normalizeDeg(azimuthDeg));
  const sinA = Math.sin(A);
  const cosA = Math.cos(A);
  const sinAlt = Math.sin(a);
  const cosAlt = Math.cos(a);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  const sinDec = clamp(sinAlt * sinPhi + cosAlt * cosPhi * cosA, -1, 1);
  const decDeg = toDegrees(Math.asin(sinDec));

  const y = -sinA * cosAlt;
  const x = sinAlt * cosPhi - cosAlt * sinPhi * cosA;

  return {
    hourAngleDeg: normalizeHourAngle(toDegrees(Math.atan2(y, x))),
    decDeg,
    raDefined: 90 - Math.abs(decDeg) > RA_UNDEFINED_TOLERANCE_DEG,
  };
}

/** 時角/赤緯 → 地平。與 horizontalToHourAngle 互逆，對照 SOFA 的 eraHd2ae。 */
export function hourAngleToHorizontal({ hourAngleDeg, decDeg, latitudeDeg }) {
  requireFiniteNumber("hourAngleDeg", hourAngleDeg);
  requireRange("decDeg", decDeg, -90, 90);
  requireRange("latitudeDeg", latitudeDeg, -90, 90);

  const H = toRadians(hourAngleDeg);
  const dec = toRadians(decDeg);
  const phi = toRadians(latitudeDeg);
  const sinH = Math.sin(H);
  const cosH = Math.cos(H);
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  const sinAlt = clamp(sinDec * sinPhi + cosDec * cosPhi * cosH, -1, 1);
  const y = -sinH * cosDec;
  const x = sinDec * cosPhi - cosDec * sinPhi * cosH;

  return {
    azimuthDeg: normalizeDeg(toDegrees(Math.atan2(y, x))),
    altitudeDeg: toDegrees(Math.asin(sinAlt)),
  };
}

/**
 * 地平 → 赤道（當日平分點）。
 *
 * 觀測者站在地極時，這條公式本身仍然良好定義（赤緯就等於仰角），
 * 真正沒有意義的是「經度」，因此 LST 無從決定。那是資料問題不是公式問題，
 * 所以這裡不做任何 clamp —— 呼叫端如果餵得出極點的經度，就照它算。
 */
export function horizontalToEquatorial({ azimuthDeg, altitudeDeg, latitudeDeg, longitudeDeg, unixMs }) {
  const local = lstDeg(unixMs, longitudeDeg);
  const { hourAngleDeg, decDeg, raDefined } = horizontalToHourAngle({ azimuthDeg, altitudeDeg, latitudeDeg });
  return {
    raDeg: normalizeDeg(local - hourAngleDeg),
    decDeg,
    hourAngleDeg,
    lstDeg: local,
    raDefined,
  };
}

/** 赤道 → 地平。Phase 4 把星投回畫面走的就是這條。 */
export function equatorialToHorizontal({ raDeg, decDeg, latitudeDeg, longitudeDeg, unixMs }) {
  requireFiniteNumber("raDeg", raDeg);
  requireRange("decDeg", decDeg, -90, 90);
  const local = lstDeg(unixMs, longitudeDeg);
  const hourAngleDeg = normalizeHourAngle(local - raDeg);
  const horizon = hourAngleToHorizontal({ hourAngleDeg, decDeg, latitudeDeg });
  return { ...horizon, hourAngleDeg, lstDeg: local };
}

/**
 * 歲差角 ζ、z、θ（度），IAU 1976（Lieske）模型，固定以 J2000.0 為起點。
 * 係數已與 pyerfa 的 erfa.prec76() 逐點比對，±40 年內差 0.000000000 角秒。
 */
export function precessionAnglesDeg(unixMs) {
  const t = julianCenturies(julianDay(unixMs));
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    zetaDeg: (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) / 3600,
    zDeg: (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) / 3600,
    thetaDeg: (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) / 3600,
  };
}

function rotate(raDeg, decDeg, zetaDeg, zDeg, thetaDeg) {
  const ra = toRadians(raDeg + zetaDeg);
  const dec = toRadians(decDeg);
  const theta = toRadians(thetaDeg);
  const cosDec = Math.cos(dec);
  const sinDec = Math.sin(dec);
  const a = cosDec * Math.sin(ra);
  const b = Math.cos(theta) * cosDec * Math.cos(ra) - Math.sin(theta) * sinDec;
  const c = Math.sin(theta) * cosDec * Math.cos(ra) + Math.cos(theta) * sinDec;
  return {
    raDeg: normalizeDeg(toDegrees(Math.atan2(a, b)) + zDeg),
    decDeg: toDegrees(Math.asin(clamp(c, -1, 1))),
  };
}

/**
 * J2000 平位置 → 當日平位置。
 * 實測 2026 年的位移約 0.35 度 —— 那是「歲差要做、章動不必做」這個取捨的依據。
 */
export function precessJ2000ToDate({ raDeg, decDeg, unixMs }) {
  requireFiniteNumber("raDeg", raDeg);
  requireRange("decDeg", decDeg, -90, 90);
  const { zetaDeg, zDeg, thetaDeg } = precessionAnglesDeg(unixMs);
  return rotate(raDeg, decDeg, zetaDeg, zDeg, thetaDeg);
}

/** 當日平位置 → J2000。同一組角互換並變號（ζ↔−z、z↔−ζ、θ→−θ）。 */
export function precessDateToJ2000({ raDeg, decDeg, unixMs }) {
  requireFiniteNumber("raDeg", raDeg);
  requireRange("decDeg", decDeg, -90, 90);
  const { zetaDeg, zDeg, thetaDeg } = precessionAnglesDeg(unixMs);
  return rotate(raDeg, decDeg, -zDeg, -zetaDeg, -thetaDeg);
}

/**
 * 大氣折射量（度），Bennett 公式，輸入是**視高度**。
 *
 * 兩件事被 max(0, …) 擋住：tan 在 90 度附近越過極點會給出微小負值，
 * 而負的折射會讓「視 → 真」往錯的方向修。地平線以下 2 度就沒有觀測意義，直接夾住。
 */
export function refractionDeg(apparentAltitudeDeg) {
  requireFiniteNumber("apparentAltitudeDeg", apparentAltitudeDeg);
  const h = clamp(apparentAltitudeDeg, -2, 90);
  const arcmin = 1 / Math.tan(toRadians(h + 7.31 / (h + 4.4)));
  return Math.max(0, arcmin) / 60;
}

/** 視高度 → 真高度。感測器給的是視高度，進座標轉換前要先拆掉折射。 */
export function trueAltitudeFromApparentDeg(apparentAltitudeDeg) {
  return apparentAltitudeDeg - refractionDeg(apparentAltitudeDeg);
}

/** 真高度 → 視高度（Sæmundsson 公式）。Phase 4 把星畫回畫面時用。 */
export function apparentAltitudeFromTrueDeg(trueAltitudeDeg) {
  requireFiniteNumber("trueAltitudeDeg", trueAltitudeDeg);
  const h = clamp(trueAltitudeDeg, -2, 90);
  const arcmin = 1.02 / Math.tan(toRadians(h + 10.3 / (h + 5.11)));
  return trueAltitudeDeg + Math.max(0, arcmin) / 60;
}
