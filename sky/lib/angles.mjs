// 角度基本運算。沒有天文語意，所以這裡的每個函式都應該是一眼可驗的。
//
// 這一層唯一的重點是「三種正規化不可互相代用」：
//   normalizeDeg        [0, 360)    方位角、赤經、恆星時
//   normalizeHourAngle  (-180, 180] 時角
//   角距                 走 angularSeparation()，不可以用減法
// 混用不會拋錯，只會安靜地差 360 度或在 0/360 接縫上漏抓天體。

export const RAD_PER_DEG = Math.PI / 180;
export const DEG_PER_RAD = 180 / Math.PI;

/** 度轉弧度。寫成先乘後除是為了讓 toRadians(180) 剛好等於 Math.PI。 */
export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/** 弧度轉度。 */
export function toDegrees(rad) {
  return (rad * 180) / Math.PI;
}

/** 夾在 [min, max]。asin/acos 的引數一律先過這裡，理由見 coords.mjs。 */
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 正規化到 [0, 360)。 */
export function normalizeDeg(deg) {
  const rest = deg % 360;
  if (rest < 0) {
    // 極小的負數加上 360 之後會因為捨入剛好等於 360，那會跑出 [0,360)。
    const shifted = rest + 360;
    return shifted < 360 ? shifted : 0;
  }
  return rest;
}

/**
 * 正規化到 (-180, 180]。正值代表天體已經過中天（往西）。
 * -180 與 +180 指的是同一個方向，統一回傳正的那個，讓輸出有唯一的形式。
 */
export function normalizeHourAngle(deg) {
  const wrapped = normalizeDeg(deg);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * 天球上兩點的角距離（度）。
 *
 * 用 haversine 而不是 acos(sin·sin + cos·cos·cos)：後者在小角度時引數趨近 1，
 * 而 acos 在 1 附近的相對誤差會炸開。Phase 3 的星表比對全部都是小角度
 * （視野內 10 度以下），所以這個選擇是那件事的前提，不是風格偏好。
 */
export function angularSeparation(ra1Deg, dec1Deg, ra2Deg, dec2Deg) {
  const dDec = toRadians(dec2Deg - dec1Deg);
  const dRa = toRadians(ra2Deg - ra1Deg);
  const sinDec = Math.sin(dDec / 2);
  const sinRa = Math.sin(dRa / 2);
  const h = sinDec * sinDec +
    Math.cos(toRadians(dec1Deg)) * Math.cos(toRadians(dec2Deg)) * sinRa * sinRa;
  return toDegrees(2 * Math.asin(Math.sqrt(clamp(h, 0, 1))));
}
