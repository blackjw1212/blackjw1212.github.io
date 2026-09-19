import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLASSES, OPEN, CLOSE, auditOutput } from "../../scripts/lib/numeric-audit.mjs";
import { EXECUTION_PROOF_FIELDS } from "../../scripts/lib/fin-contracts.mjs";

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
    assert.match(p.version, /^\d+\.\d+$/);
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

// 兩條刻意的豁免。比照 CLAUDE.md 對觸控目標那三條豁免的處理：可以豁免，但要寫出理由，
// 而且是逐字的白名單而不是放寬正則——放寬正則會連真的違規一起放掉。
//   100% ── 「配置比例合計是否為 100%」是算術定義，不是一個會過期的費率。
//   20%  ── 「市場下跌 20%」是使用者指定的情境參數，本來就是佔位符。
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
