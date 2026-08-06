import test from "node:test";
import assert from "node:assert/strict";
import { parseIsinRows, isDegraded } from "../../scripts/update-industry-map.mjs";
import { deriveSectorMix } from "../../scripts/update-etf-feed.mjs";

// ISIN 回的是 Big5 HTML；這裡只測解析，解碼在 main() 裡用 TextDecoder("big5")。
// 第一欄是「代碼　全形空白　簡稱」，產業別在第 5 欄。
const row = (cells) => "<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>";
const page = (...rows) => "<table>" + rows.join("") + "</table>";

test("parseIsinRows pulls code, name and the Chinese industry", () => {
  const html = page(
    row(["2330　台積電", "TW0002330008", "1994/09/05", "上市", "半導體業", "ESVUFR", ""]),
    row(["1101　台泥", "TW0001101004", "1962/02/09", "上市", "水泥工業", "ESVUFR", ""]),
  );
  const out = parseIsinRows(html);
  assert.deepEqual(out, [
    { code: "2330", name: "台積電", industry: "半導體業" },
    { code: "1101", name: "台泥", industry: "水泥工業" },
  ]);
});

test("parseIsinRows skips non-stock rows and market-heading rows", () => {
  const html = page(
    row(["　　　　　上市認購(售)權證", "", "", "", "", "", ""]),          // 標題列
    row(["0050　元大台灣50", "TW0000050004", "2003/06/25", "上市", "", "", ""]), // ETF：無產業別
    row(["030001　權證", "X", "Y", "上市", "認購權證", "", ""]),           // 6 碼，不是個股
    row(["2330　台積電", "TW0002330008", "1994/09/05", "上市", "半導體業", "", ""]),
  );
  assert.deepEqual(parseIsinRows(html).map((r) => r.code), ["2330"]);
});

test("isDegraded refuses to overwrite when the upstream collapses", () => {
  assert.equal(isDegraded(1998, 1990), false);
  assert.equal(isDegraded(1200, 1990), true, "掉到 60% 要拒絕覆寫");
  assert.equal(isDegraded(5, 0), false, "沒有前次資料時不阻擋首次寫入");
});

// 這是整個功能最重要的性質。00712 復華富時不動產前十大 78.6% 全是美國 REITs，
// 中文譯名比對不到任何台股產業。若把未分類吞掉或攤進其他產業，
// 它會顯示成「完全沒有產業集中度」——那是最危險的誤導。
test("unclassified weight is reported separately, never absorbed", () => {
  const byName = { 台積電: "半導體業", 鴻海: "其他電子業" };
  const mix = deriveSectorMix(
    [{ name: "台積電", weight: 50 }, { name: "安納利資本管理公司", weight: 20 }, { name: "鴻海", weight: 10 }],
    byName,
  );
  assert.equal(mix.coveredWeight, 80);
  assert.equal(mix.matchedWeight, 60);
  assert.equal(mix.unclassifiedWeight, 20, "比對不到的要獨立計數");
  const sectorTotal = mix.sectors.reduce((s, x) => s + x.weight, 0);
  assert.equal(sectorTotal, 60, "未分類不得被攤進任何產業");
  // 只擋「未分類」本身；「其他電子業」「其他業」是 TWSE 真正的產業名稱，不可一併排除
  assert.ok(!mix.sectors.some((s) => s.name === "未分類"), "未分類不是一個產業，不可混進 sectors");
  assert.equal(mix.matchedWeight + mix.unclassifiedWeight, mix.coveredWeight);
});

test("sector weights never exceed the covered top-ten weight", () => {
  const mix = deriveSectorMix([{ name: "台積電", weight: 67.6 }, { name: "聯發科", weight: 8.3 }],
    { 台積電: "半導體業", 聯發科: "半導體業" });
  assert.equal(mix.sectors.length, 1, "同產業要合併");
  assert.equal(mix.sectors[0].weight, 75.9);
  assert.ok(mix.matchedWeight <= mix.coveredWeight);
  assert.ok(mix.coveredWeight < 100, "前十大不等於全部持股");
});

test("a starred short name still matches", () => {
  // MoneyDJ 的簡稱偶爾帶星號（國巨*）
  const mix = deriveSectorMix([{ name: "國巨*", weight: 10 }], { 國巨: "電子零組件業" });
  assert.equal(mix.matchedWeight, 10);
  assert.equal(mix.sectors[0].name, "電子零組件業");
});

test("no holdings means no sectorMix at all, not an empty one", () => {
  assert.equal(deriveSectorMix([], {}), null, "空的 sectorMix 會讓畫面顯示 0% 集中度");
  assert.equal(deriveSectorMix(null, {}), null);
  assert.equal(deriveSectorMix([{ name: "x", weight: 0 }], {}), null, "權重全為 0 等同沒有資料");
});
