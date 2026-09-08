// Phase 2：把手機的姿態感測器讀數變成「相機在看天空的哪裡」，並把抖動與飄移壓下來。
//
// 兩件事在這一層決定，錯了後面都白做：
//
// 1. **後鏡頭的光軸恆為裝置的 −z**，所以相機的方位角與仰角**與
//    `screen.orientation.angle` 無關**。螢幕角度只影響 roll（世界的上方落在畫面的
//    哪個方向），那是 Phase 4 畫標籤時的事。把螢幕角度加進方位角是常見的錯誤。
// 2. **α 是繞天頂逆時針量的，方位角是順時針**。直立時 az = 360 − α。
//    直接把 alpha 當方位角用，畫面會左右相反。
//
// 座標系：世界用 ENU（x 東、y 北、z 天頂）；裝置用 W3C 的 x 右、y 上、z 出螢幕。
// 旋轉是內旋 Z-X'-Y''，R = Rz(α)·Rx(β)·Ry(γ)，把裝置座標轉成世界座標。

import { clamp, normalizeDeg, normalizeHourAngle, toDegrees, toRadians } from "./angles.mjs";

/**
 * 互補濾波的時間常數（秒）。
 *
 * **這是起始值，不是調校過的值** —— 調它需要真手機。取捨是：太小則地磁雜訊
 * （典型 ±1～2 度）直接透到畫面上，太大則轉頭時畫面跟不上。0.35 秒的依據是
 * 穩態飄移誤差 ≈ 陀螺儀零偏 × 時間常數，以 1°/s 的零偏估算約 0.35 度，
 * 仍遠小於地磁方位角本身的 ±2～10 度。
 */
export const DEFAULT_TIME_CONSTANT_SECONDS = 0.35;

/** 超過這個間隔就重新初始化，不拿舊速率去積分。分頁切走再切回來就是這個情況。 */
export const MAX_GAP_SECONDS = 1;

/** 相機軸的水平分量小於這個值時，方位角在幾何上沒有意義（正對天頂或天底）。 */
export const AZIMUTH_UNDEFINED_TOLERANCE = 1e-9;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 必須是有限的數字，實得 ${typeof value === "number" ? value : typeof value}`);
  }
}

/**
 * 姿態角 → 旋轉矩陣（列優先的 9 個元素），把裝置座標轉成世界 ENU。
 * 這是 Rz(α)·Rx(β)·Ry(γ) 展開後的封閉形式；測試會拿三個基本矩陣連乘來對。
 */
export function orientationToMatrix({ alphaDeg, betaDeg, gammaDeg }) {
  requireFiniteNumber("alphaDeg", alphaDeg);
  requireFiniteNumber("betaDeg", betaDeg);
  requireFiniteNumber("gammaDeg", gammaDeg);
  const a = toRadians(alphaDeg);
  const b = toRadians(betaDeg);
  const g = toRadians(gammaDeg);
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG,
  ];
}

/** 後鏡頭的光軸（世界 ENU 的單位向量）＝ −R·(0,0,1)，也就是第三行取負。 */
export function cameraAxisFromMatrix(m) {
  return { east: -m[2], north: -m[5], up: -m[8] };
}

/**
 * 旋轉矩陣 → 相機指向。
 *
 * roll 量的是世界的上方在畫面座標中的方位：0 表示世界上方就是畫面上方，
 * 正值表示世界上方偏向畫面右側。畫面的右是裝置 x、上是裝置 y，所以
 * 取世界天頂 (0,0,1) 在這兩軸上的分量，也就是矩陣的 m[6] 與 m[7]。
 */
export function pointingFromMatrix(m) {
  const axis = cameraAxisFromMatrix(m);
  const horizontal = Math.hypot(axis.east, axis.north);
  return {
    azimuthDeg: normalizeDeg(toDegrees(Math.atan2(axis.east, axis.north))),
    altitudeDeg: toDegrees(Math.asin(clamp(axis.up, -1, 1))),
    rollDeg: normalizeHourAngle(toDegrees(Math.atan2(m[6], m[7]))),
    azimuthDefined: horizontal > AZIMUTH_UNDEFINED_TOLERANCE,
  };
}

/** 姿態角 → 相機指向。方位角以真北為 0、向東為正，與 coords.mjs 的慣例一致。 */
export function orientationToPointing({ alphaDeg, betaDeg, gammaDeg }) {
  return pointingFromMatrix(orientationToMatrix({ alphaDeg, betaDeg, gammaDeg }));
}

/**
 * `DeviceMotionEvent.rotationRate` → 繞裝置三軸的角速度。
 *
 * 那個介面的欄位沿用 alpha/beta/gamma 這三個名字，但它們是繞 **z / x / y** 的
 * 角速度，與 `deviceorientation` 的三個角**同名不同軸**。照名字對接會把三軸接錯，
 * 而且畫面看起來只是「轉起來怪怪的」，不會有任何錯誤訊息。
 *
 * 沒有陀螺儀時（欄位為 null）回 0：那代表「沒有速率資訊」，濾波會退化成純低通。
 */
export function rotationRateFromEvent(rotationRate) {
  const pick = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    rateXDegPerSec: pick(rotationRate && rotationRate.beta),
    rateYDegPerSec: pick(rotationRate && rotationRate.gamma),
    rateZDegPerSec: pick(rotationRate && rotationRate.alpha),
  };
}

/**
 * 陀螺儀角速度 → 方位角與仰角的變化率（度/秒）。
 *
 * 推導：世界座標下的角速度 ω_world = R·ω_device，相機軸的變化率 v̇ = ω_world × v。
 * 由此
 *   d(仰角)/dt = v̇_up / cos(仰角)
 *   d(方位)/dt = (v_north·v̇_east − v_east·v̇_north) / (v_east² + v_north²)
 * 已用數值微分獨立驗證（中央差分，相對誤差 3e-6，殘差主要來自差分本身）。
 *
 * 正對天頂或天底時方位角沒有意義，回 `null` 而不是一個看起來正常的數字；
 * 仰角在那裡是極值，一階導數為 0。
 */
export function rotationRateToPointingRates({
  alphaDeg, betaDeg, gammaDeg,
  rateXDegPerSec, rateYDegPerSec, rateZDegPerSec,
}) {
  requireFiniteNumber("rateXDegPerSec", rateXDegPerSec);
  requireFiniteNumber("rateYDegPerSec", rateYDegPerSec);
  requireFiniteNumber("rateZDegPerSec", rateZDegPerSec);
  const m = orientationToMatrix({ alphaDeg, betaDeg, gammaDeg });

  const wx = toRadians(rateXDegPerSec);
  const wy = toRadians(rateYDegPerSec);
  const wz = toRadians(rateZDegPerSec);
  const worldX = m[0] * wx + m[1] * wy + m[2] * wz;
  const worldY = m[3] * wx + m[4] * wy + m[5] * wz;
  const worldZ = m[6] * wx + m[7] * wy + m[8] * wz;

  const axis = cameraAxisFromMatrix(m);
  const dEast = worldY * axis.up - worldZ * axis.north;
  const dNorth = worldZ * axis.east - worldX * axis.up;
  const dUp = worldX * axis.north - worldY * axis.east;

  const horizontalSq = axis.east * axis.east + axis.north * axis.north;
  const cosAltitude = Math.sqrt(Math.max(0, 1 - axis.up * axis.up));

  return {
    azimuthRateDegPerSec: horizontalSq > AZIMUTH_UNDEFINED_TOLERANCE
      ? toDegrees((axis.north * dEast - axis.east * dNorth) / horizontalSq)
      : null,
    altitudeRateDegPerSec: cosAltitude > AZIMUTH_UNDEFINED_TOLERANCE
      ? toDegrees(dUp / cosAltitude)
      : 0,
  };
}

/**
 * 互補濾波的一步：用陀螺儀預測、再往量測值拉回一部分。
 *
 * 兩個容易寫錯的地方：
 *
 * 1. **權重是 exp(−dt/τ) 而不是一個常數。** 感測器回呼的間隔本來就不規則
 *    （掉幀、背景分頁），寫死 0.98 會讓平滑程度隨幀率漂移。用指數形式之後，
 *    把一段時間切成幾份都得到同一個答案 —— 測試釘住了這條性質。
 * 2. **循環角要走最短路徑。** 359 度與 1 度的中點是 0 度不是 180 度；
 *    直接寫 w·a + (1−w)·b 會讓使用者面向北方時畫面瞬間甩到南方。
 *    這裡用 normalizeHourAngle 取兩者的最短差。
 *
 * `rateDegPerSec` 給 null 或 0 就退化成純低通（沒有陀螺儀的裝置），
 * 代價是轉頭時會有約「速率 × τ」的落後。
 */
export function fuseAngleDeg({
  previousDeg, measuredDeg, rateDegPerSec = 0, dtSeconds,
  timeConstantSeconds = DEFAULT_TIME_CONSTANT_SECONDS, cyclic = true,
}) {
  requireFiniteNumber("measuredDeg", measuredDeg);
  if (previousDeg === null || previousDeg === undefined) {
    return cyclic ? measuredDeg : clamp(measuredDeg, -90, 90);
  }
  requireFiniteNumber("previousDeg", previousDeg);
  requireFiniteNumber("dtSeconds", dtSeconds);
  if (dtSeconds <= 0) throw new Error(`dtSeconds 必須大於 0，實得 ${dtSeconds}`);
  requireFiniteNumber("timeConstantSeconds", timeConstantSeconds);
  if (timeConstantSeconds <= 0) throw new Error(`timeConstantSeconds 必須大於 0，實得 ${timeConstantSeconds}`);

  const rate = typeof rateDegPerSec === "number" && Number.isFinite(rateDegPerSec) ? rateDegPerSec : 0;
  const predicted = previousDeg + rate * dtSeconds;
  const keepPrediction = Math.exp(-dtSeconds / timeConstantSeconds);
  const correction = cyclic
    ? normalizeHourAngle(measuredDeg - predicted)
    : measuredDeg - predicted;
  const fused = predicted + (1 - keepPrediction) * correction;
  return cyclic ? normalizeDeg(fused) : clamp(fused, -90, 90);
}

/**
 * 把上面那一步包成有狀態的濾波器，替呼叫端管住三件實際會發生的事：
 *
 *  - 第一筆沒有前值可混，直接採用；
 *  - 時間戳重複或倒退（同一幀送兩次、事件亂序）不可以改變狀態；
 *  - 間隔超過 MAX_GAP_SECONDS（分頁切走再切回來）要重新初始化，
 *    否則會拿幾秒前的速率去積分，畫面直接甩掉。
 */
export function createPointingFilter({ timeConstantSeconds = DEFAULT_TIME_CONSTANT_SECONDS } = {}) {
  let state = null;

  function reset() {
    state = null;
  }

  function update({
    azimuthDeg, altitudeDeg, rollDeg,
    azimuthRateDegPerSec = 0, altitudeRateDegPerSec = 0,
    timestampMs,
  }) {
    requireFiniteNumber("timestampMs", timestampMs);
    const dtSeconds = state ? (timestampMs - state.timestampMs) / 1000 : null;

    if (state && dtSeconds <= 0) {
      return { ...state.pointing, dtSeconds: null, reset: false };
    }

    if (!state || dtSeconds > MAX_GAP_SECONDS) {
      const pointing = {
        azimuthDeg: normalizeDeg(azimuthDeg),
        altitudeDeg: clamp(altitudeDeg, -90, 90),
        rollDeg: normalizeHourAngle(rollDeg),
      };
      state = { pointing, timestampMs };
      return { ...pointing, dtSeconds: null, reset: true };
    }

    const pointing = {
      azimuthDeg: fuseAngleDeg({
        previousDeg: state.pointing.azimuthDeg, measuredDeg: azimuthDeg,
        rateDegPerSec: azimuthRateDegPerSec, dtSeconds, timeConstantSeconds,
      }),
      altitudeDeg: fuseAngleDeg({
        previousDeg: state.pointing.altitudeDeg, measuredDeg: altitudeDeg,
        rateDegPerSec: altitudeRateDegPerSec, dtSeconds, timeConstantSeconds, cyclic: false,
      }),
      // roll 沒有對應的速率來源，走純低通就夠了：它只用來旋轉畫面上的標籤。
      rollDeg: normalizeHourAngle(fuseAngleDeg({
        previousDeg: state.pointing.rollDeg, measuredDeg: rollDeg,
        rateDegPerSec: 0, dtSeconds, timeConstantSeconds,
      })),
    };
    state = { pointing, timestampMs };
    return { ...pointing, dtSeconds, reset: false };
  }

  return { update, reset };
}
