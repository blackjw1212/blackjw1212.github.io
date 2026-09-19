import assert from "node:assert/strict";
import test from "node:test";
import { auditOutput, findBareNumbers, auditFindingsRow, CLASSES, OPEN, CLOSE } from "../../scripts/lib/numeric-audit.mjs";

// 這支的設計取捨是「不在自由散文裡分類數字」——判準改成「數字在不在 FINDINGS 區塊裡」，
// 因為那是可判定的，而「這個數字有沒有金融語義」不是。
// 下面前半驗它真的會咬人，後半驗它不會對日期／版本／序號亂叫——
// 假陽性太多的檢查跟沒有檢查等價，人會學會忽略它。

const wrap = (rows, prose = "") => `${prose}\n${OPEN}\n${rows.join("\n")}\n${CLOSE}\n`;

const OK_ROWS = [
  `MA20 | ${CLASSES.CALCULATED} | 1050.3 | 收盤價算術平均；窗口 2026-08-20..2026-09-19`,
  `證交稅率 | ${CLASSES.RULE} | 0.3% | rule_id=TW_STT_STOCK_REGULAR`,
  `收盤價 | ${CLASSES.RAW} | 1085 | rows[4] as_of=2026-09-19`,
  `最大回撤 | ${CLASSES.UNKNOWN} | — | 需要 歷史權益曲線`,
];

test("完整標註的輸出通過", () => {
  assert.deepEqual(auditOutput(wrap(OK_ROWS)), { ok: true, violations: [] });
});

// ── Test 01：裸數字 ───────────────────────────────────────────────
test("區塊外的裸數字 → BARE_NUMBER", () => {
  const res = auditOutput(wrap(OK_ROWS, "初步看起來勝率 63.4%，值得一試。"));
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.code === "BARE_NUMBER"));
});

test("同一個裸數字只報一次", () => {
  const hits = findBareNumbers("勝率 63.4%");
  assert.equal(hits.length, 1, `重複告警會讓人停止閱讀告警，實得 ${JSON.stringify(hits)}`);
});

test("金額、百分比、倍數、指標值都攔得到", () => {
  assert.deepEqual(
    findBareNumbers("本益比 15.2，總成本 1,250 元，槓桿 2.5 倍，報酬率 8%"),
    ["本益比 15.2", "1,250 元", "2.5 倍", "報酬率 8"],
  );
});

test("日期、時刻、版本、序號、筆數、股票代號不算違規", () => {
  const noise = "第 3 項 v1 schema_version 1 於 2026-09-19 13:30 共 20 筆，代號 2330，trade_id=7，#03";
  assert.deepEqual(findBareNumbers(noise), [], "假陽性太多的檢查跟沒有檢查等價");
  assert.equal(auditOutput(wrap(OK_ROWS, noise)).ok, true);
});

test("缺整個 FINDINGS 區塊 → NO_FINDINGS_BLOCK", () => {
  const res = auditOutput("這檔看起來不錯，可以留意。");
  assert.equal(res.violations[0].code, "NO_FINDINGS_BLOCK");
});

// ── 逐列佐證 ─────────────────────────────────────────────────────
test("計算值沒寫窗口就不算計算值", () => {
  const v = auditFindingsRow(`MA20 | ${CLASSES.CALCULATED} | 1050.3 | 收盤價平均`, 2);
  assert.equal(v[0].code, "MISSING_EVIDENCE");
  assert.ok(v[0].hint.includes("窗口"));
});

test("外部資料必須同時有連結與日期", () => {
  assert.equal(auditFindingsRow(`CPI | ${CLASSES.EXTERNAL} | 2.1% | 主計總處`, 2)[0].hint, "外部資料必須附來源連結");
  assert.equal(
    auditFindingsRow(`CPI | ${CLASSES.EXTERNAL} | 2.1% | https://example.invalid/a`, 2)[0].hint,
    "外部資料必須附發布日期",
  );
});

test("規則常數必須指向 rule_id", () => {
  const v = auditFindingsRow(`證交稅 | ${CLASSES.RULE} | 0.3% | 法規規定`, 2);
  assert.equal(v[0].code, "MISSING_EVIDENCE");
});

test("原始資料必須指出是哪一列", () => {
  assert.equal(auditFindingsRow(`收盤 | ${CLASSES.RAW} | 1085 | 使用者提供`, 2)[0].code, "MISSING_EVIDENCE");
  assert.deepEqual(auditFindingsRow(`收盤 | ${CLASSES.RAW} | 1085 | rows[4]`, 2), []);
});

// ── Test 07：情境被標成事實 ──────────────────────────────────────
test("帶假設語彙卻標成原始資料 → MISCLASSIFIED", () => {
  const v = auditFindingsRow(`跌幅 | ${CLASSES.RAW} | -12% | 假設市場下跌 20% 時`, 2);
  assert.ok(v.some((x) => x.code === "MISCLASSIFIED"),
    "把推演寫成事實是這整套規格最想擋的那一種錯誤");
});

test("同一個數字標成情境就合法", () => {
  assert.deepEqual(auditFindingsRow(`跌幅 | ${CLASSES.SCENARIO} | -12% | 假設市場下跌 20%、beta 取 0.6`, 2), []);
});

// ── 未知是合法狀態 ───────────────────────────────────────────────
test("未知不得帶值，但必須說出還需要什麼", () => {
  assert.equal(auditFindingsRow(`回撤 | ${CLASSES.UNKNOWN} | -18.4% | 需要權益曲線`, 2)[0].hint,
    "未知不得帶值，值欄請留空或寫 —");
  assert.equal(auditFindingsRow(`回撤 | ${CLASSES.UNKNOWN} | — | 還沒算`, 2)[0].hint,
    "未知必須列出還需要什麼資料");
  assert.deepEqual(auditFindingsRow(`回撤 | ${CLASSES.UNKNOWN} | — | 需要 歷史權益曲線`, 2), []);
});

test("不認得的類別 → UNKNOWN_CLASS", () => {
  assert.equal(auditFindingsRow("X | 推測 | 3% | 憑感覺", 2)[0].code, "UNKNOWN_CLASS");
});

test("欄位不足四欄 → MALFORMED_ROW", () => {
  assert.equal(auditFindingsRow(`X | ${CLASSES.RAW} | 3%`, 2)[0].code, "MALFORMED_ROW");
});

test("區塊內的註解行與空行不算違規", () => {
  assert.deepEqual(auditFindingsRow("# 以下為計算值", 2), []);
  assert.deepEqual(auditFindingsRow("   ", 2), []);
});

// 這支擋不到的事，明寫出來而不是假裝有蓋到。
test("已知邊界：中文數字不在偵測範圍", () => {
  assert.deepEqual(findBareNumbers("勝率大約六成"), [],
    "要擋這個得做中文數詞解析；目前判斷不值得，但不可以假裝有蓋到");
});
