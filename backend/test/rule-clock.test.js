import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RULE_STATUS, VERIFY_STATUS, EXPIRING_WITHIN_DAYS, STALE_VERIFICATION_DAYS,
  ruleValidity, verificationStatus, ruleStatus, validateRule, resolveTax, commission,
} from "../../scripts/lib/rule-clock.mjs";

// data/tw-trading-costs.json 是這個 repo 第四份**人工維護的 feed**
// （另三份：coupons.json、floats.json、sky/data/star-names-zh.json）。
// 壞掉的原因會是人手滑或法規變了而沒人回來改，不是上游 API 變形——
// 所以這裡驗的是「有沒有人在沒有出處或沒有期限的情況下填了一個費率」。

async function loadTable() {
  return JSON.parse(await readFile(fileURLToPath(new URL("../../data/tw-trading-costs.json", import.meta.url)), "utf8"));
}

const base = {
  rule_id: "T", instrument_type: "stock", rate: 0.003,
  effective_from: "2020-01-01", effective_to: "2030-12-31",
  status: "in_force", verified_at: "2026-09-01",
  source_url: "https://example.invalid/x",
};

test("費率表的每一條都有期限、出處與查證日", async () => {
  const table = await loadTable();
  assert.ok(Array.isArray(table.rules) && table.rules.length, "rules 不可為空");
  assert.match(table.coverage_from ?? "", /^\d{4}-\d{2}-\d{2}$/, "缺 coverage_from：沒查過的年份不該被當成適用");
  for (const rule of table.rules) {
    assert.deepEqual(validateRule(rule), [], `${rule.rule_id} 形狀不合格`);
    assert.ok(rule.basis, `${rule.rule_id} 缺 basis（哪一條法條）`);
    assert.match(rule.source_url, /^https:\/\//, `${rule.rule_id} 的 source_url 必須是 https`);
  }
});

test("提案中的修法不得被解析為依據", async () => {
  const table = await loadTable();
  for (const w of table.watch ?? []) {
    assert.notEqual(w.status, "in_force", `${w.watch_id} 是提案，不可標成 in_force`);
  }
  // 落日之後即使 watch 裡寫著「擬延長十年」，解析仍必須失敗。
  const after = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2027-01-05", today: "2026-12-01" });
  assert.equal(after.ok, false);
  assert.equal(after.code, "RULE_EXPIRED", "假設延長＝把提案當成法律，正是這支要擋的事");
});

test("落日前 180 天內回 EXPIRING 而不是安靜的 ACTIVE", () => {
  const rule = { ...base, effective_to: "2026-12-31" };
  const soon = ruleValidity(rule, "2026-09-19");
  assert.equal(soon.status, RULE_STATUS.EXPIRING);
  assert.ok(soon.daysLeft > 0 && soon.daysLeft <= EXPIRING_WITHIN_DAYS);
  assert.equal(ruleValidity({ ...rule, effective_to: "2030-12-31" }, "2026-09-19").status, RULE_STATUS.ACTIVE);
});

test("生效日之前是 NOT_YET，不是可以先拿來用", () => {
  assert.equal(ruleValidity({ ...base, effective_from: "2027-01-01" }, "2026-09-19").status, RULE_STATUS.NOT_YET);
});

test("缺欄位一律 UNKNOWN，不得推定為永久有效", () => {
  const { effective_to, ...noEnd } = base;
  assert.equal(ruleValidity(noEnd, "2026-09-19").status, RULE_STATUS.UNKNOWN,
    "沒寫 effective_to 與『永久有效』是兩件事——混為一談就是這支存在的理由");
  assert.equal(ruleValidity({ ...base, source_url: "" }, "2026-09-19").status, RULE_STATUS.UNKNOWN);
});

// ── 有效性 vs 新鮮度：兩個時鐘，不可混用 ────────────────────────────
test("新鮮度量的是 today，有效性量的是 trade_date", () => {
  const rule = { ...base, verified_at: "2026-09-19", effective_to: "2030-12-31" };

  // 回測 2020 年的一筆交易：法規那時有效與否是一回事，
  // 「這張表多久沒人看過」跟那筆交易是哪一年完全無關。
  const old = ruleStatus(rule, "2021-03-01", { today: "2027-07-20" });
  assert.equal(old.rule_status, RULE_STATUS.ACTIVE, "2021-03-01 落在施行期間內");
  assert.equal(old.verification_status, VERIFY_STATUS.STALE,
    "舊交易日不得讓過期的查證看起來新鮮——前一版拿 trade_date 量 verified_at，這裡就會錯判成 FRESH");

  // 反向：交易日在未來，不得讓新鮮的查證看起來過期。
  const future = ruleStatus(rule, "2029-06-01", { today: "2026-09-19" });
  assert.equal(future.rule_status, RULE_STATUS.ACTIVE);
  assert.equal(future.verification_status, VERIFY_STATUS.FRESH,
    "交易日在未來不代表這張表沒人查證過");
});

test("沒人查證 ≠ 法律失效，兩者回不同的 code", async () => {
  const table = await loadTable();
  const stale = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2026-09-19", today: "2027-07-20" });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "RULE_REVERIFICATION_REQUIRED", "『去看一眼』不該被讀成『停止計算』");
  assert.equal(stale.rule_status, RULE_STATUS.EXPIRING, "法規本身在那個交易日仍然有效");

  const expired = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2027-01-05", today: "2026-12-01" });
  assert.equal(expired.code, "RULE_EXPIRED", "這一條才是真的失效");
});

test("複查期限算得出來，而且會提前提醒", () => {
  const rule = { ...base, verified_at: "2026-09-19" };
  const fresh = verificationStatus(rule, "2026-10-01");
  assert.equal(fresh.status, VERIFY_STATUS.FRESH);
  assert.equal(fresh.verificationDue, "2027-03-18", `verified_at + ${STALE_VERIFICATION_DAYS} 天`);

  assert.equal(verificationStatus(rule, "2027-03-01").status, VERIFY_STATUS.DUE_SOON, "到期前要先提醒");
  assert.equal(verificationStatus(rule, "2027-03-19").status, VERIFY_STATUS.STALE);
});

test("明示 allowStale 才可以用沒查證過的費率", async () => {
  const table = await loadTable();
  const q = { instrumentType: "stock", tradeDate: "2026-09-19", today: "2027-07-20" };
  assert.equal(resolveTax(table, q).ok, false);
  const forced = resolveTax(table, { ...q, allowStale: true });
  assert.equal(forced.ok, true, "有意識地放行是合法的，安靜地放行不是");
  assert.equal(forced.verification_status, VERIFY_STATUS.STALE, "放行也必須把狀態帶出來");
});

test("缺 verified_at 時新鮮度是 UNKNOWN，不是 FRESH", () => {
  assert.equal(verificationStatus({ ...base, verified_at: null }, "2026-09-19").status, VERIFY_STATUS.UNKNOWN);
});

test("查不到規則時回 code，絕不回退到預設費率", async () => {
  const table = await loadTable();
  const miss = resolveTax(table, { instrumentType: "warrant", tradeDate: "2026-09-19", today: "2026-09-19" });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "NO_RULE");
  assert.equal(miss.rate, undefined, "不得帶著一個『差不多的』費率回來");
});

test("涵蓋範圍之外的日期不算適用", async () => {
  const table = await loadTable();
  const old = resolveTax(table, { instrumentType: "stock", tradeDate: "2010-05-05", today: "2026-09-19" });
  assert.equal(old.code, "OUT_OF_COVERAGE");
});

test("當沖與一般股票走不同規則，且都解析得到", async () => {
  const table = await loadTable();
  const reg = resolveTax(table, { instrumentType: "stock", tradeDate: "2026-09-19", today: "2026-09-19" });
  const day = resolveTax(table, { instrumentType: "stock", tradeDate: "2026-09-19", today: "2026-09-19", dayTrade: true });
  assert.equal(reg.rate, 0.003);
  assert.equal(day.rate, 0.0015);
  assert.notEqual(reg.ruleId, day.ruleId);
});

test("債券 ETF 不可套用一般 ETF 的 0.1%", async () => {
  const table = await loadTable();
  const etf = resolveTax(table, { instrumentType: "etf", tradeDate: "2026-09-19", today: "2026-09-19" });
  const bond = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2026-09-19", today: "2026-09-19" });
  assert.equal(etf.rate, 0.001);
  assert.equal(bond.rate, 0);
});

test("最低手續費會改寫小額交易的實質費率，而且必須被標出來", () => {
  const params = { rate: 0.001425, discount: 0.6, minimum: 20 };
  const small = commission(10000, params);
  assert.equal(small.nominal, 8);           // 10000 × 0.001425 × 0.6 = 8.55 → 捨去 8
  assert.equal(small.charged, 20);
  assert.equal(small.minimumApplied, true);
  assert.ok(small.effectiveRate > 0.0019, `小額實質費率應遠高於名目，實得 ${small.effectiveRate}`);

  const big = commission(1000000, params);
  assert.equal(big.minimumApplied, false);
  assert.ok(big.effectiveRate < 0.001);
});

test("手續費率必須由呼叫端提供，本模組不得預設 0.1425%", () => {
  const res = commission(10000, { discount: 0.6, minimum: 20 });
  assert.equal(res.ok, false, "券商條件不是法規，不可以有預設值");
});
