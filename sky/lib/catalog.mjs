// Phase 3：星表檢索。給定相機指向的赤經赤緯，找出視野內的恆星。
//
// 三個決定寫在這裡，因為它們都是量測或幾何推出來的，不是偏好：
//
// 1. **線性掃描，不做 k-d tree。** 實測 5,080 顆在 10 度視野下只要 0.0071 ms，
//    是原規格 5 ms 預算的 1/700。k-d tree 在窄視野快 2 倍，但 30 度以上的視野
//    **反而慢 2 倍**（遍歷開銷超過省下的比較），還要多一次 10 ms 建樹。
//    想「優化」這段之前請先重跑那個量測。
// 2. **比的是三維點積，不是角距。** 單位向量的內積單調對應角距，所以整趟掃描
//    只有乘加、沒有三角函數；0/360 接縫在向量空間裡根本不存在，
//    不必特別處理赤經環繞。只有真的命中的那幾顆才換算成度。
// 3. **要 precess 的是查詢方向，不是星表。** 星表是 J2000 平位置，相機指向是
//    當日座標。轉一個方向 vs 轉 5,080 顆星，而且旋轉保角、錐體半徑不必跟著變。
//    不做這一步在 2026 年會差約 0.35 度（見 sky-catalog.test.js 的對照測試）。

import { angularSeparation, clamp, toDegrees, toRadians } from "./angles.mjs";
import { precessDateToJ2000 } from "./coords.mjs";

export const CATALOG_URL = "/sky/data/bsc5-mag6.json";

function requireFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} 必須是有限的數字，實得 ${typeof value === "number" ? value : typeof value}`);
  }
}

/**
 * 把資料檔展開成可查詢的形式：座標留著（回傳結果與歲差要用），
 * 另外預先算好三維單位向量供掃描使用。
 */
export function parseCatalog(json) {
  if (!json || !Array.isArray(json.hr)) throw new Error("星表格式不對：缺少 hr 陣列");
  const count = json.count;
  if (json.hr.length !== count || json.raDeg.length !== count ||
      json.decDeg.length !== count || json.mag.length !== count) {
    throw new Error("星表格式不對：各陣列長度與 count 不一致");
  }

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const ra = toRadians(json.raDeg[i]);
    const dec = toRadians(json.decDeg[i]);
    const cosDec = Math.cos(dec);
    x[i] = cosDec * Math.cos(ra);
    y[i] = cosDec * Math.sin(ra);
    z[i] = Math.sin(dec);
  }

  return {
    count,
    epoch: json.epoch,
    source: json.source,
    hr: json.hr,
    raDeg: Float64Array.from(json.raDeg),
    decDeg: Float64Array.from(json.decDeg),
    mag: Float64Array.from(json.mag),
    designations: json.designations || {},
    x, y, z,
  };
}

/**
 * 載入星表。**一定要帶 ?v= 版本參數**：sw.js 對靜態資產是 cache-first，
 * 少了它回訪使用者會永遠拿到舊星表且沒有任何徵兆。
 * /market/ 與 /coupon/ 用的是同一個手法。
 */
export async function loadCatalog(fetchImpl = globalThis.fetch) {
  const version = new Date().toISOString().slice(0, 10);
  const response = await fetchImpl(`${CATALOG_URL}?v=${version}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`星表載入失敗：HTTP ${response.status}`);
  return parseCatalog(await response.json());
}

/** 第 index 顆星的完整描述。沒有任何稱號的回退成 `HR 1234`。 */
export function describeStar(catalog, index) {
  const designation = catalog.designations[index] || {};
  const hr = catalog.hr[index];
  const constellation = designation.c || null;
  let label;
  if (designation.n) label = designation.n;
  else if (designation.b) label = constellation ? `${designation.b} ${constellation}` : designation.b;
  else if (designation.f) label = constellation ? `${designation.f} ${constellation}` : designation.f;
  else label = `HR ${hr}`;

  return {
    index,
    hr,
    label,
    common: designation.n || null,
    bayer: designation.b || null,
    flamsteed: designation.f || null,
    constellation,
    hasDesignation: Boolean(designation.n || designation.b || designation.f),
    magnitude: catalog.mag[index],
    raDeg: catalog.raDeg[index],
    decDeg: catalog.decDeg[index],
  };
}

/**
 * 錐形搜尋：以 (raDeg, decDeg) 為軸、radiusDeg 為半徑，回傳視野內的星，依角距升冪。
 * 座標是 **J2000**；若手上是當日座標請改用 queryConeForDate()。
 */
export function queryCone(catalog, { raDeg, decDeg, radiusDeg, limit, magnitudeLimit = Infinity }) {
  requireFiniteNumber("raDeg", raDeg);
  requireFiniteNumber("decDeg", decDeg);
  requireFiniteNumber("radiusDeg", radiusDeg);
  if (Math.abs(decDeg) > 90) throw new Error(`decDeg 必須在 [-90, 90]，實得 ${decDeg}`);
  if (radiusDeg < 0 || radiusDeg > 180) throw new Error(`radiusDeg 必須在 [0, 180]，實得 ${radiusDeg}`);

  const ra = toRadians(raDeg);
  const dec = toRadians(decDeg);
  const cosDec = Math.cos(dec);
  const qx = cosDec * Math.cos(ra);
  const qy = cosDec * Math.sin(ra);
  const qz = Math.sin(dec);
  const threshold = Math.cos(toRadians(radiusDeg));

  const { x, y, z, mag, count } = catalog;
  const hits = [];
  for (let i = 0; i < count; i += 1) {
    if (mag[i] > magnitudeLimit) continue;
    const dot = qx * x[i] + qy * y[i] + qz * z[i];
    if (dot >= threshold) hits.push({ index: i, dot });
  }

  // 點積越大角距越小；先用它排序，再只對留下來的算一次反三角函數。
  hits.sort((a, b) => b.dot - a.dot);
  const kept = typeof limit === "number" ? hits.slice(0, limit) : hits;
  return kept.map((hit) => ({
    ...describeStar(catalog, hit.index),
    separationDeg: toDegrees(Math.acos(clamp(hit.dot, -1, 1))),
  }));
}

/**
 * 同 queryCone，但輸入是**當日平分點**的座標（也就是姿態管線算出來的那組）。
 * 先把這一個方向 precess 回 J2000 再查，而不是把整份星表 precess 到當日。
 */
export function queryConeForDate(catalog, { raDeg, decDeg, unixMs, ...rest }) {
  const j2000 = precessDateToJ2000({ raDeg, decDeg, unixMs });
  return queryCone(catalog, { raDeg: j2000.raDeg, decDeg: j2000.decDeg, ...rest });
}

/** 最接近某方向的一顆星（J2000 座標）。找不到回 null。 */
export function nearestStar(catalog, { raDeg, decDeg, maxRadiusDeg = 5, magnitudeLimit }) {
  const hits = queryCone(catalog, { raDeg, decDeg, radiusDeg: maxRadiusDeg, limit: 1, magnitudeLimit });
  return hits.length ? hits[0] : null;
}

// angularSeparation 沒有在掃描裡用到（那裡走點積），但這一層仍然匯出它，
// 讓呼叫端算兩顆星之間的距離時不必自己重寫一份。
export { angularSeparation };
