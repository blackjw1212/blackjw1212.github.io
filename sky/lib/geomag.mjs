// 磁偏角：把地磁北的方位角修正成真北。
//
// Phase 1 只交介面，沒有模型。這是刻意的：
//
//  - 完整的 WMM 係數表約 1,700 個數字，而它要修正的量級（台灣約 4–5 度）
//    仍然小於手機地磁感測器本身的誤差（±2～±10 度）。先把 Phase 2 的融合做好
//    才是準確度的重點。
//  - 這一輪查不到可引用的數值：NOAA 的線上計算器在本專案的網路環境被擋住，
//    而沒有出處的數字不可以寫進資料檔（同 data/coupons.json 的規則：
//    每筆都要有 sourceUrl 與 verifiedAt）。
//
// 所以 lookupDeclination 目前一律回 null，而 applyDeclination 讓 null 傳播下去。
// **不可以用 0 代替未知**：0 會讓畫面自信地指向錯的方向，null 才能讓上層說出
// 「未修正磁偏角」。這與本 repo 對 etf-static.json 的 domesticRatio 是同一條規則。

import { normalizeDeg } from "./angles.mjs";

/**
 * 已查證的磁偏角資料。每筆必須帶 sourceUrl（https）與 verifiedAt（YYYY-MM-DD），
 * 格式為 { latitudeDeg, longitudeDeg, radiusKm, declinationDeg, sourceUrl, verifiedAt }。
 * 目前是空的，理由見檔頭。
 */
export const DECLINATION_TABLE = [];

/**
 * 查某個地點的磁偏角（度，東偏為正）。查不到回 null。
 * 回 null 不是失敗，是「這裡沒有經查證的資料」，呼叫端必須據此降級顯示。
 */
export function lookupDeclination(latitudeDeg, longitudeDeg) {
  if (typeof latitudeDeg !== "number" || !Number.isFinite(latitudeDeg)) return null;
  if (typeof longitudeDeg !== "number" || !Number.isFinite(longitudeDeg)) return null;
  return null;
}

/**
 * 地磁方位角 + 磁偏角 → 真北方位角（東偏為正）。
 * 磁偏角未知時回 null，讓「不知道」一路傳到畫面上，而不是悄悄變成 0。
 */
export function applyDeclination(magneticAzimuthDeg, declinationDeg) {
  if (declinationDeg === null || declinationDeg === undefined) return null;
  if (typeof declinationDeg !== "number" || !Number.isFinite(declinationDeg)) return null;
  if (typeof magneticAzimuthDeg !== "number" || !Number.isFinite(magneticAzimuthDeg)) {
    throw new Error(`magneticAzimuthDeg 必須是有限的數字，實得 ${magneticAzimuthDeg}`);
  }
  return normalizeDeg(magneticAzimuthDeg + declinationDeg);
}
