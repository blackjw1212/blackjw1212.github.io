import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const names = read("../../sky/data/star-names-zh.json");
const catalog = read("../../sky/data/bsc5-mag6.json");

// HR -> 星表裡那一顆的資料
const byHr = new Map();
for (const [i, d] of Object.entries(catalog.designations)) {
  byHr.set(catalog.hr[+i], { designation: d, mag: catalog.mag[+i] });
}

const entries = Object.entries(names.stars);

// ── 定義性檢查 ──────────────────────────────────────────────────────
// 對應 floats 的 loadFromShot === shots[].grams、稅務的累進差額：
// 這張表本身沒有內部矛盾可言，它的正確性完全建立在「鍵指到對的那顆星」上。
// 鍵抄錯了，畫面就會把某顆星標成另一顆星的名字，而且肉眼完全看不出來。

test("every HR in the table exists in the catalogue", () => {
  for (const [hr] of entries) {
    assert.ok(byHr.has(Number(hr)), `HR ${hr} 不在星表裡——鍵抄錯了`);
  }
});

test("every HR in the table is a star the catalogue already names", () => {
  // 中文名是「取代西方專名」，不是「幫沒名字的星取名」。指到一顆沒有專名的星，
  // 幾乎一定是 HR 抄錯（星表裡 5,080 顆，只有 334 顆有專名）。
  for (const [hr, row] of entries) {
    const { designation } = byHr.get(Number(hr));
    assert.ok(designation.n, `HR ${hr}（${row.zh || row.en}）在星表裡沒有西方專名`);
  }
});

test("the en/bayer copies match the catalogue verbatim", () => {
  // 這兩欄是為了讓人讀得懂這張表才抄過來的，抄了就會漂。這條把它釘死。
  for (const [hr, row] of entries) {
    const { designation } = byHr.get(Number(hr));
    assert.equal(row.en, designation.n, `HR ${hr} 的 en 與星表不符`);
    const bayer = [designation.b, designation.c].filter(Boolean).join(" ") || null;
    assert.equal(row.bayer, bayer, `HR ${hr} 的 bayer 與星表不符`);
  }
});

test("the table covers exactly the stars it claims to cover", () => {
  // scope 說的是「Vmag ≤ 2.5 且有專名」。少一顆代表漏建，多一顆代表範圍偷偷擴張了。
  const expected = [...byHr.entries()]
    .filter(([, v]) => v.designation.n && v.mag <= 2.5)
    .map(([hr]) => String(hr))
    .sort();
  assert.deepEqual(entries.map(([hr]) => hr).sort(), expected);
});

// ── 誠實性 ─────────────────────────────────────────────────────────

test("every name carries sources that actually resolve", () => {
  const ids = new Set(names.sources.map((s) => s.id));
  for (const [hr, row] of entries) {
    assert.ok(row.sourceIds?.length, `HR ${hr} 沒有 sourceIds`);
    for (const id of row.sourceIds) assert.ok(ids.has(id), `HR ${hr} 指到不存在的來源 ${id}`);
    assert.match(row.asOf, /^\d{4}-\d{2}-\d{2}$/, `HR ${hr} 的 asOf 格式不對`);
  }
});

test("a conflicting entry ships no value, only variants", () => {
  // 同 floats 的 confidence：來源分歧就把值留 null、把看到的寫進 variants。
  // 反過來也要成立——標成 conflicting 卻照樣出貨一個值，是最糟的組合。
  for (const [hr, row] of entries) {
    if (row.confidence === "conflicting") {
      assert.equal(row.zh, null, `HR ${hr} 標成 conflicting 卻仍然出貨了一個值`);
      assert.ok(row.variants?.length >= 2, `HR ${hr} 是 conflicting 卻沒記下分歧的寫法`);
      assert.ok(row.note, `HR ${hr} 是 conflicting 卻沒說明為什麼判不出來`);
    }
    if (row.zh === null) {
      assert.equal(row.confidence, "conflicting", `HR ${hr} 沒有值卻不是 conflicting`);
    }
  }
});

test("the declared shipped count matches what is actually shipped", () => {
  assert.equal(names.shipped, entries.filter(([, r]) => r.zh).length);
});

// ── 字串安全與繁體 ──────────────────────────────────────────────────

test("no name can break out into the nearby-stars table", () => {
  // sky/index.html 的 renderNearby 用 innerHTML 組表格。星表那邊的同款檢查在
  // build-sky-catalog.mjs 裡，但這張表是手寫的、不經過那支腳本，所以要自己擋。
  for (const [hr, row] of entries) {
    for (const value of [row.zh, row.en, row.bayer, row.note]) {
      if (typeof value === "string") {
        assert.doesNotMatch(value, /[<>&"']/, `HR ${hr} 的字串含 HTML 特殊字元：${value}`);
      }
    }
  }
});

test("names are Traditional Chinese, not Simplified", () => {
  // 唯一的對照來源（stellarium-cn）整份是簡體，所以「核對時不小心把它的字串貼回來」
  // 是這張表唯一實際存在的汙染途徑。這裡不是通用的繁簡驗證器（那需要字典），
  // 而是**照著那條汙染途徑列的黑名單**：下面每一個字都是那份 oracle 的星名裡真的
  // 出現過、而且與繁體不同形的字，逐字掃出來的（共 52 個）。
  //
  // 反向測試要拿這張表裡的字（例如「娄」「毕」）去試，不要隨手挑一個別的簡體字
  // ——第一版就是拿「简」去試，它不在汙染途徑上，測試當然不會紅，害我以為這條有效。
  const SIMPLIFIED = /[垒阵鸟厩仓传阁陈军门华内将娄极毕卫车参关厕孙厨轩辕师记枢势阳从玑马权库楼进东开摇贯郑钩书韩赵织农齐败鹤云]/;
  for (const [hr, row] of entries) {
    if (!row.zh) continue;
    const hit = row.zh.match(SIMPLIFIED);
    assert.equal(hit, null, `HR ${hr} 的「${row.zh}」含簡體字「${hit?.[0]}」`);
  }
});

test("no two stars share a Chinese name", () => {
  // 星官名是逐顆唯一的（天樞只有一顆）。撞名一定是複製貼上錯了。
  const seen = new Map();
  for (const [hr, row] of entries) {
    if (!row.zh) continue;
    assert.ok(!seen.has(row.zh), `「${row.zh}」同時給了 HR ${seen.get(row.zh)} 與 HR ${hr}`);
    seen.set(row.zh, hr);
  }
});
