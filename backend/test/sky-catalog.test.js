import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCatalog, loadCatalog, queryCone, queryConeForDate, describeStar, CATALOG_URL,
} from "../../sky/lib/catalog.mjs";
import { angularSeparation, normalizeDeg } from "../../sky/lib/angles.mjs";
import { precessJ2000ToDate } from "../../sky/lib/coords.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = JSON.parse(readFileSync(join(ROOT, "sky", "data", "bsc5-mag6.json"), "utf8"));
const catalog = parseCatalog(raw);

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// 測試內的暴力參考實作。lib 掃的是三維點積（沒有 0/360 接縫、不必每顆算 acos），
// 這支用 angularSeparation 逐顆算角距 —— 兩者結果必須逐顆相同，
// 那是點積那個優化唯一的許可證。
function bruteForce({ raDeg, decDeg, radiusDeg, magnitudeLimit = Infinity }) {
  const hits = [];
  for (let i = 0; i < catalog.count; i += 1) {
    if (catalog.mag[i] > magnitudeLimit) continue;
    const separationDeg = angularSeparation(raDeg, decDeg, catalog.raDeg[i], catalog.decDeg[i]);
    if (separationDeg <= radiusDeg) hits.push({ index: i, separationDeg });
  }
  hits.sort((a, b) => a.separationDeg - b.separationDeg);
  return hits;
}

// ───────────────────────────────── schema ─────────────────────────────────

test("the shipped catalog has the shape the loader expects", () => {
  assert.equal(raw.epoch, "J2000.0");
  assert.equal(raw.magnitudeLimit, 6);
  assert.equal(raw.count, raw.hr.length);
  for (const key of ["raDeg", "decDeg", "mag"]) {
    assert.equal(raw[key].length, raw.count, `${key} 的長度對不上 count`);
  }
  assert.ok(raw.source.url.startsWith("https://"), "來源必須有 https 出處");
  assert.match(raw.source.retrievedAt, /^\d{4}-\d{2}-\d{2}$/, "必須有取得日期");
  assert.ok(raw.source.licence, "必須寫明授權");
  assert.equal(catalog.count, raw.count);
  for (let i = 0; i < catalog.count; i += 1) {
    assert.ok(Number.isFinite(catalog.raDeg[i]) && Number.isFinite(catalog.decDeg[i]) && Number.isFinite(catalog.mag[i]),
      `第 ${i} 筆有 NaN`);
  }
});

// 這幾條與 scripts/build-sky-catalog.mjs 的寫入閘門是同一組。在測試裡再釘一次，
// 是為了讓「重新產生資料時弄壞了」在 CI 當場紅，而不是等畫面上看起來怪怪的
// ——5,080 個數字壞掉時肉眼看不出來。
test("the catalog still satisfies the structural invariants it was gated on", () => {
  assert.ok(catalog.count >= 5000 && catalog.count <= 5200, `筆數 ${catalog.count}`);
  assert.equal(new Set(raw.hr).size, catalog.count, "HR 有重複");

  for (let i = 0; i < catalog.count; i += 1) {
    assert.ok(catalog.raDeg[i] >= 0 && catalog.raDeg[i] < 360, `第 ${i} 筆赤經越界`);
    assert.ok(Math.abs(catalog.decDeg[i]) <= 90, `第 ${i} 筆赤緯越界`);
  }

  let brightest = 0;
  for (let i = 1; i < catalog.count; i += 1) if (catalog.mag[i] < catalog.mag[brightest]) brightest = i;
  const sirius = describeStar(catalog, brightest);
  assert.equal(sirius.label, "Sirius", "最亮的星應該是天狼星");
  assert.ok(Math.abs(sirius.magnitude + 1.46) < 0.05, `實得 ${sirius.magnitude}`);

  const nearPole = queryCone(catalog, { raDeg: 0, decDeg: 90, radiusDeg: 2 })
    .slice().sort((a, b) => a.magnitude - b.magnitude)[0];
  assert.ok(nearPole.separationDeg >= 0.70 && nearPole.separationDeg <= 0.78,
    `北天極 2 度內最亮的星（Polaris）應距極 0.70–0.78 度，實得 ${nearPole.separationDeg}`);

  const expected = { 1: 15, 2: 50, 3: 174, 4: 518, 5: 1630, 6: 5080 };
  for (const [limit, want] of Object.entries(expected)) {
    let got = 0;
    for (let i = 0; i < catalog.count; i += 1) if (catalog.mag[i] <= Number(limit)) got += 1;
    assert.ok(Math.abs(got - want) <= want * 0.02, `Vmag ≤ ${limit} 應約 ${want}，實得 ${got}`);
  }
});

// 頁面把 label 與 constellation 插進 innerHTML（那是本 repo 的既有慣例，
// /market/ 用了 38 次）。資料是從網路重新產生的，所以這條同時釘在
// scripts/build-sky-catalog.mjs 的寫入閘門與這裡。
test("no catalogue string can break out of the markup it gets interpolated into", () => {
  const dangerous = /[<>&"']/;
  for (const [index, designation] of Object.entries(raw.designations)) {
    for (const [key, value] of Object.entries(designation)) {
      assert.ok(!dangerous.test(value),
        `第 ${index} 筆的 ${key} 含 HTML 特殊字元：${JSON.stringify(value)}`);
    }
  }
  for (let i = 0; i < catalog.count; i += 1) {
    const star = describeStar(catalog, i);
    assert.ok(!dangerous.test(star.label), `第 ${i} 筆的標籤含 HTML 特殊字元：${star.label}`);
  }
});

// ─────────────────────────────── 查詢正確性 ───────────────────────────────

test("the dot product scan agrees with a brute force angular search everywhere", () => {
  const rand = seeded(20260908);
  for (let trial = 0; trial < 200; trial += 1) {
    const raDeg = rand() * 360;
    const decDeg = (Math.asin(rand() * 2 - 1) * 180) / Math.PI;   // 球面均勻取樣
    const radiusDeg = 1 + rand() * 25;
    const mine = queryCone(catalog, { raDeg, decDeg, radiusDeg });
    const reference = bruteForce({ raDeg, decDeg, radiusDeg });
    assert.equal(mine.length, reference.length,
      `(${raDeg.toFixed(2)}, ${decDeg.toFixed(2)}) r=${radiusDeg.toFixed(2)}: 命中數 ${mine.length} vs ${reference.length}`);
    for (let i = 0; i < mine.length; i += 1) {
      assert.equal(mine[i].index, reference[i].index, "順序或內容不一致");
      assert.ok(Math.abs(mine[i].separationDeg - reference[i].separationDeg) < 1e-9);
    }
  }
});

// 用減法比較赤經會在這裡壞掉：359.9 與 0.1 差 0.2 度不是 359.8 度。
// 掃描比的是三維點積，接縫在向量空間裡根本不存在 —— 這條把那件事釘住。
test("a query centred on the right ascension seam picks up stars from both sides", () => {
  const hits = queryCone(catalog, { raDeg: 0, decDeg: 0, radiusDeg: 15 });
  assert.ok(hits.length > 0);
  const east = hits.filter((hit) => catalog.raDeg[hit.index] < 15);
  const west = hits.filter((hit) => catalog.raDeg[hit.index] > 345);
  assert.ok(east.length > 0 && west.length > 0,
    `接縫兩側都要撈到，實得 東 ${east.length} 顆、西 ${west.length} 顆`);
  assert.deepEqual(hits.map((h) => h.index), bruteForce({ raDeg: 0, decDeg: 0, radiusDeg: 15 }).map((h) => h.index));
});

test("a query centred on the pole neither duplicates nor drops anything", () => {
  for (const decDeg of [90, -90]) {
    const hits = queryCone(catalog, { raDeg: 137, decDeg, radiusDeg: 20 });
    assert.equal(new Set(hits.map((h) => h.index)).size, hits.length, "有重複");
    assert.deepEqual(hits.map((h) => h.index).sort((a, b) => a - b),
      bruteForce({ raDeg: 137, decDeg, radiusDeg: 20 }).map((h) => h.index).sort((a, b) => a - b));
  }
});

test("results come back nearest first", () => {
  const hits = queryCone(catalog, { raDeg: 101.3, decDeg: -16.7, radiusDeg: 20 });
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i].separationDeg >= hits[i - 1].separationDeg, "沒有依角距升冪排序");
  }
});

test("limit keeps the nearest N, not an arbitrary N", () => {
  const query = { raDeg: 88.8, decDeg: 7.4, radiusDeg: 25 };
  const all = queryCone(catalog, query);
  const limited = queryCone(catalog, { ...query, limit: 5 });
  assert.equal(limited.length, 5);
  assert.deepEqual(limited.map((h) => h.index), all.slice(0, 5).map((h) => h.index));
});

test("magnitudeLimit filters on brightness, not on distance", () => {
  const query = { raDeg: 88.8, decDeg: 7.4, radiusDeg: 25 };
  const bright = queryCone(catalog, { ...query, magnitudeLimit: 3 });
  assert.ok(bright.length > 0 && bright.length < queryCone(catalog, query).length);
  for (const hit of bright) assert.ok(hit.magnitude <= 3, `漏掉一顆 ${hit.magnitude} 等的星`);
  assert.deepEqual(bright.map((h) => h.index), bruteForce({ ...query, magnitudeLimit: 3 }).map((h) => h.index));
});

test("an empty patch of sky returns an empty array rather than throwing", () => {
  const hits = queryCone(catalog, { raDeg: 0, decDeg: 0, radiusDeg: 0.0001 });
  assert.ok(Array.isArray(hits));
});

test("bad query parameters are rejected", () => {
  assert.throws(() => queryCone(catalog, { raDeg: NaN, decDeg: 0, radiusDeg: 5 }), /raDeg/);
  assert.throws(() => queryCone(catalog, { raDeg: 0, decDeg: 91, radiusDeg: 5 }), /decDeg/);
  assert.throws(() => queryCone(catalog, { raDeg: 0, decDeg: 0, radiusDeg: -1 }), /radiusDeg/);
  assert.throws(() => queryCone(catalog, { raDeg: 0, decDeg: 0, radiusDeg: 181 }), /radiusDeg/);
});

// ─────────────────────────────── 名稱 ───────────────────────────────

test("every star has a label and unnamed ones fall back to their HR number", () => {
  let fallbacks = 0;
  for (let i = 0; i < catalog.count; i += 1) {
    const star = describeStar(catalog, i);
    assert.ok(star.label && star.label.length > 0, `第 ${i} 筆沒有標籤`);
    assert.equal(star.hr, raw.hr[i]);
    if (!star.hasDesignation) {
      assert.equal(star.label, `HR ${star.hr}`);
      fallbacks += 1;
    }
  }
  // 使用者已裁定全收 5,080 顆；約 46% 沒有任何稱號，那些是星座形狀需要的暗星。
  assert.ok(fallbacks > 2000 && fallbacks < 2600, `回退成 HR 編號的有 ${fallbacks} 顆`);
});

test("well known stars keep their proper names and constellations", () => {
  const find = (label) => {
    for (let i = 0; i < catalog.count; i += 1) if (describeStar(catalog, i).label === label) return describeStar(catalog, i);
    return null;
  };
  const sirius = find("Sirius");
  assert.ok(sirius, "找不到 Sirius");
  assert.equal(sirius.constellation, "CMa");
  assert.equal(sirius.bayer, "α");
  const vega = find("Vega");
  assert.ok(vega && vega.constellation === "Lyr", "Vega 應在天琴座");
});

// ─────────────────────────── 與歲差管線串接 ───────────────────────────

// 星表是 J2000，相機指向是當日座標。要 precess 的是**那一個查詢方向**，
// 不是 5,080 顆星 —— 旋轉保角，所以錐體半徑不必動。
test("a pointing given in coordinates of date finds the right J2000 star", () => {
  const unixMs = 1788825600000;
  for (const index of [0, 500, 2491, 4000, catalog.count - 1]) {
    const ofDate = precessJ2000ToDate({
      raDeg: catalog.raDeg[index], decDeg: catalog.decDeg[index], unixMs,
    });
    const hits = queryConeForDate(catalog, {
      raDeg: ofDate.raDeg, decDeg: ofDate.decDeg, unixMs, radiusDeg: 0.02,
    });
    assert.ok(hits.length >= 1, `第 ${index} 筆沒被找回來`);
    assert.equal(hits[0].index, index, "最近的一顆應該就是原本那顆");
    assert.ok(hits[0].separationDeg < 1e-6, `殘差 ${hits[0].separationDeg} 度`);
  }
});

// 沒有 precess 就查會差多少 —— 這個數字是誤差預算表裡「歲差要做」的依據。
test("skipping the precession step would miss by about a third of a degree", () => {
  const unixMs = 1788825600000;
  const index = 2491;
  const ofDate = precessJ2000ToDate({ raDeg: catalog.raDeg[index], decDeg: catalog.decDeg[index], unixMs });
  const naive = queryCone(catalog, { raDeg: ofDate.raDeg, decDeg: ofDate.decDeg, radiusDeg: 1 });
  const self = naive.find((hit) => hit.index === index);
  assert.ok(self && self.separationDeg > 0.3 && self.separationDeg < 0.4,
    `不做歲差會差 0.3–0.4 度，實得 ${self && self.separationDeg}`);
});

// ─────────────────────────── 載入與效能 ───────────────────────────

// 這條原本反過來要求「必須帶 ?v=YYYY-MM-DD」，抄的是 /market/ 與 /coupon/ 的慣例。
// 那個慣例對「一天更新好幾班的 feed」是對的，對星表是錯的：星表是 J2000 平位置，
// 只有 build-sky-catalog.mjs 重跑時才會變。而星表在 /sky/data/ 底下、不是 /data/，
// 走的是 sw.js 的 cache-first 靜態資產分支，所以每天換一個 cache key ＝ 隔天必定
// miss ＝ 沒訊號時整頁不能用，而觀星正好發生在沒訊號的地方。
//
// 實測（2026-09-09，清空快取、關掉伺服器後用 CDP 量）：
//   同一天、沒訊號 -> ok count=5080ㄧ隔一天、沒訊號 -> FAIL: Failed to fetch
//
// 同 CLAUDE.md 給 /float/ 的那條。星表重新產生時改用 bump sw.js 的 VERSION。
test("loadCatalog uses a stable URL so the catalogue survives offline", async () => {
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    return { ok: true, json: async () => raw };
  };
  const loaded = await loadCatalog(fakeFetch);
  assert.ok(requested.includes(CATALOG_URL), `星表網址必須逐字等於 ${CATALOG_URL}，實得 ${requested.join(", ")}`);
  for (const url of requested) {
    assert.doesNotMatch(url, /\?/, `不得帶任何查詢參數，否則 cache key 會漂掉：${url}`);
  }
  assert.equal(loaded.count, catalog.count);
});

// 中文星名表是加分項，載不到必須回退成英文標籤而不是讓整頁掛掉。
test("a missing Chinese-name table degrades to English labels, not a dead page", async () => {
  const fakeFetch = async (url) => {
    if (url === CATALOG_URL) return { ok: true, json: async () => raw };
    throw new Error("network down");
  };
  const loaded = await loadCatalog(fakeFetch);
  assert.equal(loaded.count, catalog.count, "星表本身仍要載得起來");
  assert.deepEqual(loaded.namesZh, {}, "名稱表回退成空表");
});

test("a failed fetch reports the status instead of throwing something opaque", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => loadCatalog(fakeFetch), /404/);
});

// 原規格要求「搜尋時間小於 5ms」。實測線性掃描是 0.0071 ms，所以這條護欄取
// 平均 < 1 ms —— 仍有 140 倍餘裕，不會在慢的 CI runner 上抖動。
// k-d tree 在這個規模不划算：窄視野快 2 倍，但 30 度以上的視野反而慢 2 倍。
test("a cone query stays far inside the 5ms budget", () => {
  const rand = seeded(4242);
  const queries = Array.from({ length: 200 }, () => ({
    raDeg: rand() * 360,
    decDeg: (Math.asin(rand() * 2 - 1) * 180) / Math.PI,
    radiusDeg: 10,
  }));
  const started = process.hrtime.bigint();
  for (const query of queries) queryCone(catalog, query);
  const msPerQuery = Number(process.hrtime.bigint() - started) / 1e6 / queries.length;
  assert.ok(msPerQuery < 1, `每次查詢 ${msPerQuery.toFixed(4)} ms`);
});
