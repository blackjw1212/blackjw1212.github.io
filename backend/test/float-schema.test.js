import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// data/floats.json 是這個 repo 第二份**人工維護的 feed**（另一份是 data/coupons.json）。
// 其他 data/*.json 都由 Actions 寫入，壞掉的原因是上游變了；這一份壞掉的原因會是人手滑。
// 所以這裡的重點不是型別，而是「有沒有人在沒有出處的情況下填了一個數字」——
// 一個編得很像的咬鉛重量不會讓任何程式壞掉，只會讓人在釣場上配錯鉛。
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIDENCE = new Set(["cross-checked", "single-source", "conflicting"]);
const FAMILIES = new Set(["jintan", "gandama", "go"]);
const DERIVATIONS = new Set(["listed", "nominal", "measured"]);
// 頁面自稱不收推廣報酬，來源連結就不能夾帶聯盟行銷追蹤參數。
const TRACKING = /[?&](utm_[a-z]+|aff(?:iliate)?_?id|ref|tag)=/i;

async function loadFeed() {
  const path = fileURLToPath(new URL("../../data/floats.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadPage() {
  const path = fileURLToPath(new URL("../../float/index.html", import.meta.url));
  return readFile(path, "utf8");
}

const rowsOf = (feed) => [...feed.shots, ...feed.floats];

test("float feed 宣告了核對日與核對方式", async () => {
  const feed = await loadFeed();
  assert.match(feed.reviewedAt || "", DATE, "reviewedAt 是這份資料唯一的鮮度宣告，不可缺");
  assert.ok(feed.scope, "scope 要說明這張表收什麼、不收什麼");
  assert.ok(feed.verificationMethod, "verificationMethod 要說明數值是怎麼來的——這是可信度標記的前提");
  assert.ok(Array.isArray(feed.shots) && feed.shots.length, "shots 不可為空");
  assert.ok(Array.isArray(feed.floats) && feed.floats.length, "floats 不可為空");
  // 核對日不可以是未來——填成未來會讓頁面永遠顯示「今天核對過」。
  // 寬容一天：資料是台灣時間（UTC+8）核對的，CI 跑在 UTC。
  const limit = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.ok(feed.reviewedAt <= limit,
    `reviewedAt ${feed.reviewedAt} 是未來的日期（UTC 今天 +1 天為 ${limit}）`);
});

test("每個來源都有唯一 id、https 網址，且不夾帶推廣參數", async () => {
  const feed = await loadFeed();
  const seen = new Set();
  for (const source of feed.sources) {
    assert.match(source.id || "", /^[a-z0-9-]+$/, `來源 id 格式異常: ${source.id}`);
    assert.ok(!seen.has(source.id), `來源 id 重複: ${source.id}`);
    seen.add(source.id);
    assert.ok(source.title, `${source.id} 缺 title`);
    assert.match(source.url || "", /^https:\/\//, `${source.id} 的 url 必須是 https`);
    assert.doesNotMatch(source.url, TRACKING, `${source.id} 的 url 夾帶了推廣追蹤參數`);
    // seenVia 記的是「這個來源是怎麼被讀到的」。目前全部是搜尋摘要——
    // 之後在能上網的機器上逐頁核對過，就把該列改成 opened。少了這個欄位，
    // 「多來源一致」會被讀成「已經開過那些頁」。
    assert.ok(["search-summary", "opened"].includes(source.seenVia),
      `${source.id} 的 seenVia 必須是 search-summary 或 opened，得到 ${source.seenVia}`);
  }
});

test("沒有出處的數字不准進資料檔", async () => {
  const feed = await loadFeed();
  const ids = new Set(feed.sources.map((s) => s.id));
  for (const row of rowsOf(feed)) {
    assert.ok(Array.isArray(row.sourceIds) && row.sourceIds.length,
      `${row.label} 沒有任何來源`);
    for (const id of row.sourceIds) {
      assert.ok(ids.has(id), `${row.label} 引用了不存在的來源 ${id}`);
    }
    assert.match(row.verifiedAt || "", DATE, `${row.label} 缺 verifiedAt`);
    assert.ok(CONFIDENCE.has(row.confidence),
      `${row.label} 的 confidence 必須是 ${[...CONFIDENCE].join(" / ")}，得到 ${row.confidence}`);
  }
  for (const item of feed.makerVariance) {
    assert.ok(item.claim, "makerVariance 每條都要有 claim");
    assert.ok(item.sourceIds.length, `makerVariance「${item.claim}」沒有出處`);
    for (const id of item.sourceIds) assert.ok(ids.has(id), `makerVariance 引用了不存在的來源 ${id}`);
  }
  for (const id of feed.residualBuoyancy.sourceIds) {
    assert.ok(ids.has(id), `residualBuoyancy 引用了不存在的來源 ${id}`);
  }
});

test("可信度標記說得出它憑什麼", async () => {
  const feed = await loadFeed();
  for (const row of rowsOf(feed)) {
    if (row.confidence === "cross-checked") {
      // 「多來源一致」就得真的有兩個來源，否則這個標記只是好聽。
      assert.ok(row.sourceIds.length >= 2,
        `${row.label} 標成 cross-checked 但只有 ${row.sourceIds.length} 個來源`);
    }
    if (row.confidence === "conflicting") {
      // 來源分歧時不准挑一個當真理：值留 null，把看到的數字記進 variants。
      const value = "grams" in row ? row.grams : row.loadGrams;
      assert.equal(value, null, `${row.label} 標成 conflicting 卻仍寫了一個數值`);
      assert.ok((row.variants || []).length,
        `${row.label} 標成 conflicting 卻沒有記下分歧的數值`);
    }
  }
});

test("咬鉛：系列、換算方式與分歧值都合法", async () => {
  const feed = await loadFeed();
  const ids = new Set(feed.sources.map((s) => s.id));
  const seen = new Set();
  for (const shot of feed.shots) {
    assert.ok(!seen.has(shot.label), `咬鉛標記重複: ${shot.label}`);
    seen.add(shot.label);
    assert.ok(FAMILIES.has(shot.family), `${shot.label} 的 family 異常: ${shot.family}`);
    assert.ok(DERIVATIONS.has(shot.derivation), `${shot.label} 的 derivation 異常: ${shot.derivation}`);
    if (shot.grams !== null) {
      assert.ok(Number.isFinite(shot.grams) && shot.grams > 0, `${shot.label} 的 grams 異常`);
    }
    for (const variant of shot.variants || []) {
      assert.ok(Number.isFinite(variant.grams) && variant.grams > 0,
        `${shot.label} 的 variant 數值異常`);
      assert.ok(ids.has(variant.sourceId),
        `${shot.label} 的 variant 引用了不存在的來源 ${variant.sourceId}`);
      // 記一個跟主值一樣的 variant 只會讓畫面上多一列噪音。
      assert.notEqual(variant.grams, shot.grams,
        `${shot.label} 的 variant 與主值相同，不該記成分歧`);
    }
  }
});

// 這是整份測試的定義性檢查，對應 tax-params 的「累進差額在級距交界處必須相等」。
// 浮標號數的意義就是「吃得下同名咬鉛」；兩張表分叉時肉眼看不出來，
// 但配鉛試算給出的每一個數字都會是錯的。
test("浮標號數的負荷必須等於同名咬鉛的重量", async () => {
  const feed = await loadFeed();
  const byLabel = new Map(feed.shots.map((s) => [s.label, s]));
  const seen = new Set();
  for (const row of feed.floats) {
    assert.ok(!seen.has(row.label), `浮標標記重複: ${row.label}`);
    seen.add(row.label);
    assert.equal(typeof row.sinks, "boolean", `${row.label} 缺 sinks`);
    assert.ok(row.use, `${row.label} 缺 use`);
    if (row.loadFromShot === null) {
      // 只有負浮力標與 0 號可以不對應咬鉛：前者沒有公布克數，後者本身不吃鉛。
      assert.ok(row.loadGrams === null || row.loadGrams === 0,
        `${row.label} 沒有對應咬鉛，負荷只能是 null 或 0，得到 ${row.loadGrams}`);
      continue;
    }
    const shot = byLabel.get(row.loadFromShot);
    assert.ok(shot, `${row.label} 對應到不存在的咬鉛 ${row.loadFromShot}`);
    assert.equal(row.loadGrams, shot.grams,
      `${row.label} 的負荷 ${row.loadGrams} 與同名咬鉛 ${shot.label} 的 ${shot.grams} 不一致`);
  }
});

test("同一系列內的重量必須單調遞增", async () => {
  const feed = await loadFeed();
  const grams = (label) => feed.shots.find((s) => s.label === label)?.grams ?? null;
  const check = (labels, name) => {
    let previous = null;
    for (const label of labels) {
      const value = grams(label);
      if (value === null) continue;
      if (previous !== null) {
        assert.ok(value > previous.value,
          `${name}：${label}(${value}) 應該比 ${previous.label}(${previous.value}) 重`);
      }
      previous = { label, value };
    }
  };
  // G 系號碼越大越輕，所以倒著念才是遞增。
  check(["G10", "G8", "G7", "G6", "G5", "G4", "G3", "G2", "G1"], "ジンタン G");
  check(["B", "2B", "3B", "4B", "5B", "6B", "7B", "8B"], "ガン玉 B");
  check(["0.3号", "0.5号", "0.8号", "1号", "1.5号", "2号", "3号", "4号", "5号"], "号数");
});

test("餘浮力設定指得到一顆真的咬鉛", async () => {
  const feed = await loadFeed();
  const shot = feed.shots.find((s) => s.label === feed.residualBuoyancy.defaultShot);
  assert.ok(shot, `residualBuoyancy.defaultShot ${feed.residualBuoyancy.defaultShot} 不在咬鉛表裡`);
  assert.ok(shot.grams > 0, "餘浮力預設值必須有重量");
  const range = feed.residualBuoyancy.rangeGrams;
  assert.ok(Array.isArray(range) && range.length === 2 && range[0] < range[1],
    "rangeGrams 必須是遞增的兩個數字");
  assert.ok(shot.grams >= range[0] && shot.grams <= range[1],
    `預設的 ${shot.label}(${shot.grams}) 落在宣稱的區間 ${range.join("〜")} 之外`);
});

// 頁面把 family 與 confidence 翻成中文再顯示。資料檔加了新值而頁面沒跟上時，
// 表格會直接印出英文代碼，而所有測試都還是綠的。
test("頁面的對照字典涵蓋資料檔用到的每一個代碼", async () => {
  const feed = await loadFeed();
  const html = await loadPage();
  for (const family of new Set(feed.shots.map((s) => s.family))) {
    assert.ok(html.includes(`  ${family}: "`) || html.includes(`${family}:`),
      `float/index.html 的 FAMILY_LABEL 沒有 ${family}`);
  }
  for (const confidence of new Set(rowsOf(feed).map((r) => r.confidence))) {
    assert.ok(html.includes(`"${confidence}"`) || html.includes(`${confidence}:`),
      `float/index.html 的 CONFIDENCE_LABEL 沒有 ${confidence}`);
  }
});
