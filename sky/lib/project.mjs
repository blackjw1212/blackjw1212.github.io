// Phase 4：把天球方向投影回相機畫面的像素位置。
//
// 輸入是 Phase 2 濾波後的 (方位角, 仰角, roll) 與相機的水平視野角，
// 輸出是針孔模型下的 (x, y) 像素。
//
// 幾件量測出來的事：
//
// - **(方位角, 仰角, roll) 無損保留了完整姿態。** basisFromPointing 重建出的三軸
//   與旋轉矩陣的真實三軸在 30 萬組隨機姿態下最大差 9e-14 度。所以 Phase 2 可以
//   放心地平滑這三個角，不必改成四元數。
// - **天頂的萬向鎖在實務上不是問題。** 模擬手震 + 感測器雜訊下，畫面「上方」方向
//   的誤差在天頂是 0.62 度、低空是 0.39 度，最大轉速 7.2°/s vs 3.4°/s ——
//   沒有肉眼可見的亂轉。原因是方位角的誤差會被 cos(仰角) 壓掉。
// - **相機的視野角拿不到。** MediaStream 沒有任何標準欄位提供 FOV，
//   所以 DEFAULT_HORIZONTAL_FOV_DEG 只是個起始值，必須讓使用者校正。

import { clamp, normalizeDeg, normalizeHourAngle, toDegrees, toRadians } from "./angles.mjs";

/**
 * 預設水平視野角。**這是待校正的起始值，不是量到的值** ——
 * MediaStream 的 MediaTrackSettings 沒有 FOV 這個欄位（實測 2026-09-08 查無標準），
 * 也沒有任何跨瀏覽器的方法問得到鏡頭焦距。頁面必須提供校正手段。
 */
export const DEFAULT_HORIZONTAL_FOV_DEG = 65;

/** 相機軸與天頂夾角小於這個值時，「世界的上方」投影到畫面上會退化，改用正北當參考。 */
const ROLL_REFERENCE_TOLERANCE = 1e-8;

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 必須是有限的數字，實得 ${typeof value === "number" ? value : typeof value}`);
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** 地平座標 → 世界 ENU 的單位向量（x 東、y 北、z 天頂）。 */
export function directionFromHorizontal({ azimuthDeg, altitudeDeg }) {
  requireFiniteNumber("azimuthDeg", azimuthDeg);
  requireFiniteNumber("altitudeDeg", altitudeDeg);
  const a = toRadians(azimuthDeg);
  const h = toRadians(altitudeDeg);
  const cosAlt = Math.cos(h);
  return [Math.sin(a) * cosAlt, Math.cos(a) * cosAlt, Math.sin(h)];
}

/** 世界 ENU 單位向量 → 地平座標。 */
export function horizontalFromDirection(v) {
  return {
    azimuthDeg: normalizeDeg(toDegrees(Math.atan2(v[0], v[1]))),
    altitudeDeg: toDegrees(Math.asin(clamp(v[2], -1, 1))),
  };
}

/**
 * 由指向重建相機的三軸（世界 ENU）：
 *   forward 光軸、right 畫面向右、up 畫面向上。
 *
 * 先取「世界天頂投影到畫面平面」當作 roll = 0 的參考方向，再繞光軸轉 roll。
 * 正對天頂或天底時那個投影會退化（世界天頂與光軸平行），改用正北當參考並回報
 * `rollReferenceDegenerate` —— 那時畫面的旋轉完全由 roll 決定，本來就沒有
 * 「世界上方」可以對齊。
 */
export function basisFromPointing({ azimuthDeg, altitudeDeg, rollDeg = 0 }) {
  requireFiniteNumber("rollDeg", rollDeg);
  const forward = directionFromHorizontal({ azimuthDeg, altitudeDeg });

  const zenith = [0, 0, 1];
  let projected = [
    zenith[0] - dot(zenith, forward) * forward[0],
    zenith[1] - dot(zenith, forward) * forward[1],
    zenith[2] - dot(zenith, forward) * forward[2],
  ];
  let rollReferenceDegenerate = false;
  if (Math.hypot(projected[0], projected[1], projected[2]) < ROLL_REFERENCE_TOLERANCE) {
    const north = [0, 1, 0];
    projected = [
      north[0] - dot(north, forward) * forward[0],
      north[1] - dot(north, forward) * forward[1],
      north[2] - dot(north, forward) * forward[2],
    ];
    rollReferenceDegenerate = true;
  }

  const referenceUp = normalize(projected);
  const referenceRight = cross(forward, referenceUp);
  const c = Math.cos(toRadians(rollDeg));
  const s = Math.sin(toRadians(rollDeg));

  return {
    forward,
    right: [
      c * referenceRight[0] + s * referenceUp[0],
      c * referenceRight[1] + s * referenceUp[1],
      c * referenceRight[2] + s * referenceUp[2],
    ],
    up: [
      -s * referenceRight[0] + c * referenceUp[0],
      -s * referenceRight[1] + c * referenceUp[1],
      -s * referenceRight[2] + c * referenceUp[2],
    ],
    rollReferenceDegenerate,
  };
}

/**
 * 建立一個投影器。針孔模型、正方形像素，所以垂直視野角由畫面高度推出來，
 * 不是另一個獨立參數。
 *
 * `coneRadiusDeg` 是畫面四角落到光軸的夾角 —— 拿它當星表查詢的錐體半徑，
 * 就不會漏掉角落的星，也不會多撈整片天空。
 */
export function createProjector({
  azimuthDeg, altitudeDeg, rollDeg = 0,
  horizontalFovDeg = DEFAULT_HORIZONTAL_FOV_DEG,
  widthPx, heightPx,
}) {
  requireFiniteNumber("widthPx", widthPx);
  requireFiniteNumber("heightPx", heightPx);
  requireFiniteNumber("horizontalFovDeg", horizontalFovDeg);
  if (widthPx <= 0 || heightPx <= 0) throw new Error(`畫面尺寸必須為正，實得 ${widthPx}×${heightPx}`);
  if (horizontalFovDeg <= 0 || horizontalFovDeg >= 180) {
    throw new Error(`horizontalFovDeg 必須在 (0, 180)，實得 ${horizontalFovDeg}`);
  }

  const basis = basisFromPointing({ azimuthDeg, altitudeDeg, rollDeg });
  const focalLengthPx = (widthPx / 2) / Math.tan(toRadians(horizontalFovDeg) / 2);
  const centreX = widthPx / 2;
  const centreY = heightPx / 2;

  function projectDirection(direction) {
    const alongAxis = dot(direction, basis.forward);
    // 光軸後方的東西沒有像素位置。除以負數會得到一個看起來很正常的座標，
    // 把背後的星畫到畫面上 —— 這是針孔模型最常見的錯誤。
    if (alongAxis <= 0) {
      return { xPx: NaN, yPx: NaN, visible: false, behindCamera: true, offAxisDeg: NaN };
    }
    const xPx = centreX + focalLengthPx * (dot(direction, basis.right) / alongAxis);
    const yPx = centreY - focalLengthPx * (dot(direction, basis.up) / alongAxis);
    return {
      xPx,
      yPx,
      visible: xPx >= 0 && xPx <= widthPx && yPx >= 0 && yPx <= heightPx,
      behindCamera: false,
      offAxisDeg: toDegrees(Math.acos(clamp(alongAxis, -1, 1))),
    };
  }

  return {
    basis,
    focalLengthPx,
    horizontalFovDeg,
    verticalFovDeg: toDegrees(2 * Math.atan((heightPx / 2) / focalLengthPx)),
    coneRadiusDeg: toDegrees(Math.atan(Math.hypot(widthPx / 2, heightPx / 2) / focalLengthPx)),

    /** 天體的地平座標（視位置）→ 畫面像素。 */
    project({ azimuthDeg: starAzimuthDeg, altitudeDeg: starAltitudeDeg }) {
      return projectDirection(directionFromHorizontal({
        azimuthDeg: starAzimuthDeg, altitudeDeg: starAltitudeDeg,
      }));
    },

    projectDirection,

    /** 畫面像素 → 地平座標。使用者點畫面上某一點想知道那是什麼星時用。 */
    unproject(xPx, yPx) {
      requireFiniteNumber("xPx", xPx);
      requireFiniteNumber("yPx", yPx);
      const u = (xPx - centreX) / focalLengthPx;
      const v = -(yPx - centreY) / focalLengthPx;
      const direction = normalize([
        basis.forward[0] + u * basis.right[0] + v * basis.up[0],
        basis.forward[1] + u * basis.right[1] + v * basis.up[1],
        basis.forward[2] + u * basis.right[2] + v * basis.up[2],
      ]);
      return horizontalFromDirection(direction);
    },
  };
}

export { normalizeHourAngle };
