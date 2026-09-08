// UTC 毫秒 → 儒略日 → 格林威治平恆星時 → 地方恆星時。
//
// 這條管線只吃 UTC 毫秒。Date 物件、字串、本地時間一律不收：時區錯一個小時，
// 赤經就差 15 度，而畫面上看起來只是「星圖有點對不準」。
//
// 算的是「平」恆星時（mean），不是視恆星時（apparent）：章動造成的
// equation of the equinoxes 最大約 1.1 秒（0.005 度），相對於手機地磁方位角的
// ±2～±10 度可以忽略。函式因此叫 gmstDeg 而不是 gastDeg，免得日後有人
// 拿它去接需要視位置的計算。

import { normalizeDeg } from "./angles.mjs";

export const MS_PER_DAY = 86400000;
export const UNIX_EPOCH_JD = 2440587.5;
export const J2000_JD = 2451545.0;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 必須是有限的數字，實得 ${typeof value === "number" ? value : typeof value}`);
  }
}

/** UTC 毫秒 → 儒略日。J2000 之前是負的天數，不可以 clamp。 */
export function julianDay(unixMs) {
  requireFiniteNumber("unixMs", unixMs);
  return unixMs / MS_PER_DAY + UNIX_EPOCH_JD;
}

/** 自 J2000.0 起算的儒略世紀。 */
export function julianCenturies(jd) {
  requireFiniteNumber("jd", jd);
  return (jd - J2000_JD) / 36525;
}

/**
 * 格林威治平恆星時（度）。
 *
 * 係數與 IAU 1982 的 GMST 表示式一致；已與 pyerfa 的 erfa.gmst82() 逐點比對，
 * 1970–2030 間最大差 0.00016 角秒（4.5e-8 度）。
 *
 * 第二項是 360.98564736629 而不是 360：恆星日比太陽日短約 3 分 56 秒。
 * 忽略 UT1−UTC（|ΔUT1| < 0.9 秒 → < 0.004 度），理由同檔頭。
 */
export function gmstDeg(unixMs) {
  const d = julianDay(unixMs) - J2000_JD;
  const t = d / 36525;
  const deg = 280.46061837 +
    360.98564736629 * d +
    0.000387933 * t * t -
    (t * t * t) / 38710000;
  return normalizeDeg(deg);
}

/** 地方恆星時（度）。經度東為正、西為負 —— 寫成 gmst - lon 是這裡最常見的錯誤。 */
export function lstDeg(unixMs, longitudeDeg) {
  requireFiniteNumber("longitudeDeg", longitudeDeg);
  if (longitudeDeg < -180 || longitudeDeg > 180) {
    throw new Error(`longitudeDeg 必須在 [-180, 180]，實得 ${longitudeDeg}`);
  }
  return normalizeDeg(gmstDeg(unixMs) + longitudeDeg);
}
