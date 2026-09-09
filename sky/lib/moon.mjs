// Phase 5：月亮的位置。獨立於恆星那條路徑，兩者只共用座標轉換與時間。
//
// 為什麼要有月亮：這一頁最大的誤差來源不是天文計算（殘差 < 0.01 度），是**地磁
// 方位角**，典型偏 2 到 10 度。geomag.mjs 查表一律回 null（NOAA 連不到、找不到可
// 引用的來源），所以畫面上的方位角是磁北的、整片星圖會平移。月亮是天上唯一一個
// 每個人都叫得出名字的東西，讓使用者把標記拖到真正的月亮上，就等於**當場實測**
// 出這條 heading 管線的偏差 —— 比查不到的模型直接。
//
// **月亮不拿來校正視野角。** 視野角是尺度參數，單一個標記只給得出指向偏移。
// 用月亮的視直徑當尺也不行：實算今天的視直徑 32.1 角分，在 65 度視野、375px 寬的
// 畫面上只有 3.1 px，視野角差 10% 也才動 0.3 px，眼睛看不出來；而離軸 15 度的星
// 在同樣條件下會移動約 9 px。差約 30 倍，所以視野角仍然走原本的圖案比對。
//
// **站心（topocentric）修正是必要的，不是可選的。** 月亮的地平視差約 0.98 度
// ——接近它自己直徑的兩倍。拿地心座標直接畫上去，標記最多會偏一整度，那會讓
// 使用者把「月球視差」當成「方位角偏差」校進去，校正結果本身就是錯的。
//
// 演算法是 Meeus《Astronomical Algorithms》第 47 章的截斷 ELP-2000/82
// （週期項 60+60），第 22 章的平黃赤交角，第 40 章的視差修正。
// 係數逐項對 pyerfa 的 erfa.moon98 驗過，數字寫在 backend/test/sky-moon.test.js。

import { normalizeDeg, toDegrees, toRadians } from "./angles.mjs";
import { equatorialToHorizontal } from "./coords.mjs";
import { julianCenturies, julianDay } from "./time.mjs";

/**
 * TT − UTC（秒）。Meeus 的月球式子要的是**力學時 TT**，不是 UTC。
 *
 * 少了這一步的代價是可量到的：月亮每秒走 0.549 角秒，69 秒就是 **38 角秒的系統性
 * 落後**。實測對 erfa.moon98 正是「黃經固定偏 −38.3″、散佈只有 ±5″」，而黃緯
 * 幾乎為零 —— 一眼就看得出是時間偏移而不是係數抄錯（係數錯會兩維一起亂）。
 *
 * 這裡用常數而不是完整的 ΔT 模型：TAI−UTC 現為 37 秒，TT = TAI + 32.184 秒。
 * **下次閏秒之後會差 1 秒 ＝ 0.55 角秒**，相對於這一頁 2–10 度的誤差預算可以忽略，
 * 但要知道它會慢慢過期。只有星曆的時間引數用 TT；恆星時（lstDeg）要的是 UT1，
 * UTC 已經夠近，**不要**把這個偏移套到那裡去。
 */
const TT_MINUS_UTC_SECONDS = 69.184;

/** 星曆用的儒略世紀（TT）。 */
function ephemerisCenturies(unixMs) {
  return julianCenturies(julianDay(unixMs + TT_MINUS_UTC_SECONDS * 1000));
}

const EARTH_RADIUS_KM = 6378.14;
const MOON_RADIUS_KM = 1737.4;
/** 地球扁率（WGS84）。站心修正要用地心緯度，不是地理緯度。 */
const FLATTENING = 1 / 298.257223563;

// Meeus 表 47.A：D, M, M', F 的係數，以及 Σl（1e-6 度）與 Σr（1e-3 km）。
const TERMS_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];

// Meeus 表 47.B：Σb（1e-6 度）。
const TERMS_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794], [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777], [4, 0, -2, 1, 671], [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366], [2, 1, 0, 1, -351], [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315], [2, -2, 0, -1, 302], [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181], [0, 1, 2, 1, -177], [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166], [1, 0, 1, -1, -164], [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

function polynomial(t, coefficients) {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) value = value * t + coefficients[i];
  return value;
}

/**
 * 月亮的地心黃道座標（當日平分點）與地月距離。
 * 回傳 { longitudeDeg, latitudeDeg, distanceKm }。
 */
export function moonEclipticOfDate(unixMs) {
  const t = ephemerisCenturies(unixMs);

  const lPrime = polynomial(t, [218.3164477, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000]);
  const d = polynomial(t, [297.8501921, 445267.1114034, -0.0018819, 1 / 545868, -1 / 113065000]);
  const m = polynomial(t, [357.5291092, 35999.0502909, -0.0001536, 1 / 24490000]);
  const mPrime = polynomial(t, [134.9633964, 477198.8675055, 0.0087414, 1 / 69699, -1 / 14712000]);
  const f = polynomial(t, [93.2720950, 483202.0175233, -0.0036539, -1 / 3526000, 1 / 863310000]);

  const a1 = 119.75 + 131.849 * t;
  const a2 = 53.09 + 479264.290 * t;
  const a3 = 313.45 + 481266.484 * t;
  // 太陽軌道離心率隨時間變化；含 M 的項要乘 E，含 2M 的乘 E²。
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;

  const dRad = toRadians(d);
  const mRad = toRadians(m);
  const mPrimeRad = toRadians(mPrime);
  const fRad = toRadians(f);

  let sumL = 0;
  let sumR = 0;
  for (const [cd, cm, cmp, cf, cl, cr] of TERMS_LR) {
    const argument = cd * dRad + cm * mRad + cmp * mPrimeRad + cf * fRad;
    const damping = cm === 0 ? 1 : (Math.abs(cm) === 1 ? e : e * e);
    sumL += cl * damping * Math.sin(argument);
    sumR += cr * damping * Math.cos(argument);
  }

  let sumB = 0;
  for (const [cd, cm, cmp, cf, cb] of TERMS_B) {
    const argument = cd * dRad + cm * mRad + cmp * mPrimeRad + cf * fRad;
    const damping = cm === 0 ? 1 : (Math.abs(cm) === 1 ? e : e * e);
    sumB += cb * damping * Math.sin(argument);
  }

  // 金星與木星的攝動，以及地球扁率的加項（Meeus 47）。
  sumL += 3958 * Math.sin(toRadians(a1))
    + 1962 * Math.sin(toRadians(lPrime - f))
    + 318 * Math.sin(toRadians(a2));
  sumB += -2235 * Math.sin(toRadians(lPrime))
    + 382 * Math.sin(toRadians(a3))
    + 175 * Math.sin(toRadians(a1 - f))
    + 175 * Math.sin(toRadians(a1 + f))
    + 127 * Math.sin(toRadians(lPrime - mPrime))
    - 115 * Math.sin(toRadians(lPrime + mPrime));

  return {
    longitudeDeg: normalizeDeg(lPrime + sumL / 1000000),
    latitudeDeg: sumB / 1000000,
    distanceKm: 385000.56 + sumR / 1000,
  };
}

/** 平黃赤交角（度），Meeus 22.2。 */
export function meanObliquityDeg(unixMs) {
  const t = ephemerisCenturies(unixMs);
  const arcseconds = polynomial(t, [84381.448, -46.8150, -0.00059, 0.001813]);
  return arcseconds / 3600;
}

/** 月亮的**地心**赤道座標（當日平分點）。 */
export function moonEquatorialOfDate(unixMs) {
  const { longitudeDeg, latitudeDeg, distanceKm } = moonEclipticOfDate(unixMs);
  const lambda = toRadians(longitudeDeg);
  const beta = toRadians(latitudeDeg);
  const epsilon = toRadians(meanObliquityDeg(unixMs));

  const raDeg = normalizeDeg(toDegrees(Math.atan2(
    Math.sin(lambda) * Math.cos(epsilon) - Math.tan(beta) * Math.sin(epsilon),
    Math.cos(lambda))));
  const decDeg = toDegrees(Math.asin(
    Math.sin(beta) * Math.cos(epsilon) + Math.cos(beta) * Math.sin(epsilon) * Math.sin(lambda)));

  return { raDeg, decDeg, distanceKm };
}

/**
 * 地心 → 站心的赤道座標修正（Meeus 40）。
 *
 * **這一步不能省。** 月亮的地平視差約 0.98 度，接近它自己直徑的兩倍；省掉它，
 * 使用者會把月球視差當成方位角偏差校進去。
 */
export function topocentricEquatorial({
  raDeg, decDeg, distanceKm, latitudeDeg, longitudeDeg, unixMs, elevationM = 0,
}) {
  const parallax = Math.asin(EARTH_RADIUS_KM / distanceKm);

  // 觀測者相對地心的位置（Meeus 11）。用地心緯度而不是地理緯度，兩者最多差 11 角分。
  const geodetic = toRadians(latitudeDeg);
  const u = Math.atan((1 - FLATTENING) * Math.tan(geodetic));
  const elevationRatio = elevationM / (EARTH_RADIUS_KM * 1000);
  const rhoSinPhi = (1 - FLATTENING) * Math.sin(u) + elevationRatio * Math.sin(geodetic);
  const rhoCosPhi = Math.cos(u) + elevationRatio * Math.cos(geodetic);

  const { hourAngleDeg } = equatorialToHorizontal({
    raDeg, decDeg, latitudeDeg, longitudeDeg, unixMs,
  });
  const h = toRadians(hourAngleDeg);
  const dec = toRadians(decDeg);

  const deltaRa = Math.atan2(
    -rhoCosPhi * Math.sin(parallax) * Math.sin(h),
    Math.cos(dec) - rhoCosPhi * Math.sin(parallax) * Math.cos(h));
  const topoDec = Math.atan2(
    (Math.sin(dec) - rhoSinPhi * Math.sin(parallax)) * Math.cos(deltaRa),
    Math.cos(dec) - rhoCosPhi * Math.sin(parallax) * Math.cos(h));

  return {
    raDeg: normalizeDeg(raDeg + toDegrees(deltaRa)),
    decDeg: toDegrees(topoDec),
    parallaxDeg: toDegrees(parallax),
  };
}

/**
 * 觀測者當下看到的月亮：站心赤道座標 → 地平座標，外加視半徑與相位。
 *
 * 回傳的 altitudeDeg 是**幾何**高度，與恆星那條路徑一致（頁面在畫之前才套折射），
 * 所以呼叫端不要重複套。
 */
export function moonPosition({ latitudeDeg, longitudeDeg, unixMs, elevationM = 0 }) {
  const geocentric = moonEquatorialOfDate(unixMs);
  const topocentric = topocentricEquatorial({
    ...geocentric, latitudeDeg, longitudeDeg, unixMs, elevationM,
  });
  const horizon = equatorialToHorizontal({
    raDeg: topocentric.raDeg,
    decDeg: topocentric.decDeg,
    latitudeDeg, longitudeDeg, unixMs,
  });
  return {
    azimuthDeg: horizon.azimuthDeg,
    altitudeDeg: horizon.altitudeDeg,
    raDeg: topocentric.raDeg,
    decDeg: topocentric.decDeg,
    distanceKm: geocentric.distanceKm,
    parallaxDeg: topocentric.parallaxDeg,
    semiDiameterDeg: toDegrees(Math.asin(MOON_RADIUS_KM / geocentric.distanceKm)),
    illuminatedFraction: illuminatedFraction(unixMs),
  };
}

/**
 * 被照亮的比例 0–1（Meeus 48 的低精度式）。
 * 用途只有一個：**新月前後不要叫使用者拿它校正**，因為那時看不到，
 * 而弦月時肉眼也判不準「月面中心」在哪裡（亮的是邊緣，中心在暗面裡）。
 */
export function illuminatedFraction(unixMs) {
  const t = ephemerisCenturies(unixMs);
  const d = polynomial(t, [297.8501921, 445267.1114034, -0.0018819, 1 / 545868]);
  const m = polynomial(t, [357.5291092, 35999.0502909, -0.0001536]);
  const mPrime = polynomial(t, [134.9633964, 477198.8675055, 0.0087414, 1 / 69699]);
  const dRad = toRadians(d);
  const iDeg = 180 - d
    - 6.289 * Math.sin(toRadians(mPrime))
    + 2.100 * Math.sin(toRadians(m))
    - 1.274 * Math.sin(2 * dRad - toRadians(mPrime))
    - 0.658 * Math.sin(2 * dRad)
    - 0.214 * Math.sin(2 * toRadians(mPrime))
    - 0.110 * Math.sin(dRad);
  return (1 + Math.cos(toRadians(iDeg))) / 2;
}
