import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLASSES, OPEN, CLOSE, auditOutput } from "../../scripts/lib/numeric-audit.mjs";
import { EXECUTION_PROOF_FIELDS, MUST_EXCLUDE_FROM_REALIZED } from "../../scripts/lib/fin-contracts.mjs";
import { findBareNumbers } from "../../scripts/lib/numeric-audit.mjs";

// data/prompts.json 是七條提示詞的**唯一權威版本**。它的風險跟 /float/ 那份一樣：
// 一條寫歪的提示詞不會讓任何程式壞掉，只會讓模型安靜地照舊版行為跑。
// 所以這裡驗的不是形狀，是「提示詞有沒有跟它宣稱綁定的 validator 分叉」。

const KNOWN_INPUTS = new Set(["financial-data/v1", "trade-log/v1", "none"]);
const KNOWN_OUTPUTS = new Set(["findings/v1", "backtest-result/v1", "trade-log/v1"]);

async function loadLibrary() {
  return JSON.parse(await readFile(fileURLToPath(new URL("../../data/prompts.json", import.meta.url)), "utf8"));
}
const bodyText = (p) => p.body.join("\n");

test("提示詞庫宣告了版本與核對日", async () => {
  const lib = await loadLibrary();
  assert.equal(lib.schema, "prompt-library/v1");
  assert.match(lib.version, /^\d+\.\d+\.\d+$/, "語意化版號讓 trade-log 的 rule_set.version 對得上");
  assert.match(lib.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(lib.prompts.length, 7);
});

// ── 這一條是整支最重要的：擋住提示詞與 validator 分叉 ──────────────
test("numeric_classes 必須與 numeric-audit.mjs 的實作逐字一致", async () => {
  const lib = await loadLibrary();
  const implemented = Object.values(CLASSES);
  assert.deepEqual(lib.numeric_classes, implemented,
    "提示詞叫模型用的類別，跟檢查器認得的類別分叉時，輸出會全部被判違規而沒人知道為什麼");
  for (const p of lib.prompts) {
    for (const cls of p.numeric_classes ?? []) {
      assert.ok(implemented.includes(cls), `${p.id} 用了檢查器不認得的類別「${cls}」`);
    }
  }
});

test("FINDINGS 的開關標記必須與檢查器一致", async () => {
  const lib = await loadLibrary();
  assert.equal(lib.output_format.open, OPEN);
  assert.equal(lib.output_format.close, CLOSE);
});

test("輸出 findings/v1 的提示詞，本文必須真的教模型用那個區塊", async () => {
  const lib = await loadLibrary();
  for (const p of lib.prompts.filter((x) => x.output_contract === "findings/v1")) {
    const text = bodyText(p);
    assert.ok(text.includes(OPEN), `${p.id} 沒告訴模型要開 FINDINGS 區塊`);
    assert.ok(text.includes(CLOSE), `${p.id} 沒告訴模型要關 FINDINGS 區塊`);
  }
});

test("output_format 的佐證規則涵蓋每一個類別", async () => {
  const lib = await loadLibrary();
  for (const cls of Object.values(CLASSES)) {
    assert.ok(lib.output_format.evidence_rules[cls], `缺「${cls}」的佐證規則`);
  }
});

test("契約名稱必須是已知的 schema", async () => {
  const lib = await loadLibrary();
  for (const p of lib.prompts) {
    assert.ok(KNOWN_INPUTS.has(p.input_contract), `${p.id} 的 input_contract 未知：${p.input_contract}`);
    assert.ok(KNOWN_OUTPUTS.has(p.output_contract), `${p.id} 的 output_contract 未知：${p.output_contract}`);
  }
});

test("requires_rules 指到的全域規則都存在，且每條規則至少被一條提示詞引用", async () => {
  const lib = await loadLibrary();
  const ids = new Set(lib.global_rules.map((r) => r.id));
  const used = new Set();
  for (const p of lib.prompts) {
    assert.ok(Array.isArray(p.requires_rules) && p.requires_rules.length, `${p.id} 沒引用任何全域規則`);
    for (const r of p.requires_rules) {
      assert.ok(ids.has(r), `${p.id} 引用了不存在的規則 ${r}`);
      used.add(r);
    }
  }
  for (const id of ids) {
    assert.ok(used.has(id), `${id} 沒有被任何提示詞引用——不會咬人的規則沒有價值`);
  }
});

test("每條都有 id、版本、用途與限制，且 id 不重複", async () => {
  const lib = await loadLibrary();
  const seen = new Set();
  for (const p of lib.prompts) {
    assert.match(p.id, /^[a-z0-9-]+$/, `${p.id} 的 id 應為 kebab-case`);
    assert.ok(!seen.has(p.id), `id 重複：${p.id}`);
    seen.add(p.id);
    assert.match(p.version, /^\d+\.\d+(\.\d+)?$/);
    assert.equal(p.status, "active");
    assert.ok(p.purpose && p.purpose.length >= 12, `${p.id} 缺 purpose`);
    assert.ok(Array.isArray(p.limitations) && p.limitations.length,
      `${p.id} 缺 limitations——說不出自己做不到什麼的提示詞，就是在暗示它什麼都做得到`);
  }
});

// ── 回測那條要跟 validateBacktestResult 對齊 ──────────────────────
test("回測提示詞必須點名成本模型的每一項必填", async () => {
  const lib = await loadLibrary();
  const bt = lib.prompts.find((p) => p.id === "backtest-code-generator");
  const text = bodyText(bt);
  for (const k of ["minimum_commission", "transaction_tax", "slippage", "price_limit_fill", "liquidity_cap", "borrow_cost", "forced_buyin"]) {
    assert.ok(text.includes(k), `回測提示詞沒提到 ${k}，但 validateBacktestResult 會要求宣告它`);
  }
  for (const f of EXECUTION_PROOF_FIELDS) {
    assert.ok(text.includes(f), `回測提示詞沒提到執行證明欄位 ${f}`);
  }
});

test("回測提示詞不得把成交寫成日K可判定", async () => {
  const lib = await loadLibrary();
  const text = bodyText(lib.prompts.find((p) => p.id === "backtest-code-generator"));
  assert.ok(text.includes("成交狀態未知"), "曾離開停板只證明價格可達，不證明成交");
  assert.doesNotMatch(text, /部分成交.{0,20}可以(由|用)日\s*K/, "日 K 做不出部分成交");
});

test("稅率不得被寫死在提示詞裡", async () => {
  const lib = await loadLibrary();
  for (const p of lib.prompts) {
    const text = bodyText(p);
    assert.doesNotMatch(text, /0\.3\s*%|千分之三|0\.1425/,
      `${p.id} 寫死了費率。費率有施行期間，必須指向 data/tw-trading-costs.json 的 rule_id`);
  }
  const bt = bodyText(lib.prompts.find((p) => p.id === "backtest-code-generator"));
  assert.ok(bt.includes("rule_id"), "回測提示詞必須把稅率導向 rule_id");
});

test("日誌提示詞與流程提示詞的欄位必須對得上（06 ↔ 07 閉環）", async () => {
  const lib = await loadLibrary();
  const journal = lib.prompts.find((p) => p.id === "trade-journal-analyzer");
  const checklist = lib.prompts.find((p) => p.id === "daily-discipline-checklist");
  assert.equal(journal.input_contract, "trade-log/v1");
  assert.equal(checklist.output_contract, "trade-log/v1", "07 的產出就是 06 的輸入");
  for (const field of ["rule_set", "pnl_net", "costs"]) {
    assert.ok(bodyText(checklist).includes(field), `流程清單沒要求記錄 ${field}`);
    assert.ok(bodyText(journal).includes(field), `日誌分析沒用到 ${field}`);
  }
});

// 兩條刻意的豁免，理由由 G1 的排除清單撐著（不是臨時加的例外）：兩者都是
// 「結構控制值」——配置比例合計 100% 是算術定義，市場下跌 20% 是情境參數的佔位。
// 逐字白名單而不是放寬正則：放寬正則會連真的違規一起放掉。這份清單不得再長。
const BARE_NUMBER_EXEMPT = new Set(["100%", "20%"]);

test("提示詞本文自己不得帶裸數字（它是給人看的規格，同一把尺量自己）", async () => {
  const lib = await loadLibrary();
  for (const p of lib.prompts) {
    // 本文沒有 FINDINGS 區塊，所以只掃散文那一半。
    const bare = auditOutput(bodyText(p)).violations
      .filter((v) => v.code === "BARE_NUMBER" && !BARE_NUMBER_EXEMPT.has(v.excerpt));
    assert.deepEqual(bare.map((v) => `${p.id}: ${v.excerpt}`), [],
      "提示詞裡出現帶單位的裸數字，通常代表某個費率或門檻又被寫死了一次");
  }
});

// ── G1 的散文與 checker 的實作必須講同一件事 ──────────────────────
test("G1 的排除清單與 numeric-audit 實際不攔的東西一致", async () => {
  const lib = await loadLibrary();
  const g1 = lib.global_rules.find((r) => r.id === "G1-LABELLING").text;

  // G1 必須把範圍收在「金融／交易／資料／統計語義」，不可以再寫成「每個數字」。
  assert.match(g1, /金融、交易、資料或統計語義/, "G1 必須明示數值範圍");
  assert.doesNotMatch(g1, /每個數字必須/, "「每個數字」與 checker 的實際判定不一致，不得復活");

  // G1 點名為結構控制值的東西，checker 一個都不該攔——散文與實作分叉時這條會紅。
  const controlValues = [
    "最多 3 條", "突破 60 日最高價", "成交量 > 20 日均量 × 1.5",
    "v3.0.1", "09:00–13:30", "第 3 項", "共 20 筆",
  ];
  for (const v of controlValues) {
    assert.deepEqual(findBareNumbers(v), [], `G1 說「${v}」不必標籤，checker 卻攔了它`);
  }
  for (const word of ["輸出數量上限", "計算窗口長度", "版本號", "序號"]) {
    assert.ok(g1.includes(word), `G1 的排除清單缺「${word}」`);
  }
});

test("回測提示詞必須寫出成交未定不得進績效", async () => {
  const lib = await loadLibrary();
  const text = bodyText(lib.prompts.find((p) => p.id === "backtest-code-generator"));
  for (const state of MUST_EXCLUDE_FROM_REALIZED) {
    assert.ok(text.includes(state), `提示詞沒點名 ${state}，但 validateBacktestResult 會要求排除它`);
  }
  assert.ok(text.includes("fill_accounting.excluded_from_realized"), "提示詞必須點名那個宣告欄位");
  assert.ok(text.includes("forced_buyin 不是常數"), "強制回補的條件必須由規則或交易資料判定");
});

test("提示詞不得內嵌市場交易時間", async () => {
  const lib = await loadLibrary();
  for (const p of lib.prompts) {
    assert.doesNotMatch(bodyText(p), /\d{1,2}:\d{2}\s*[–~-]\s*\d{1,2}:\d{2}/,
      `${p.id} 寫死了交易時段。交易制度會改，寫在提示詞裡會安靜地過期——同費率那條。`);
  }
});

// ── 這份內容遲早要進 /prompts/，禁詞現在就先擋住 ──────────────────
test("提示詞庫不得含首頁與 /market/ 那兩份禁詞", async () => {
  const raw = await readFile(fileURLToPath(new URL("../../data/prompts.json", import.meta.url)), "utf8");
  // 不替「否定句」開例外：靜態契約掃的是字面值，開了例外它就不會咬人了。
  for (const word of ["保證", "可放心", "買進", "賣出", "投資建議", "安全資訊", "實領淨收益"]) {
    assert.ok(!raw.includes(word), `含禁詞「${word}」——進 /prompts/ 時靜態契約會紅`);
  }
});
