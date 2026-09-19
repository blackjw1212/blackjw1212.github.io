import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  STATUS, EXPIRING_WITHIN_DAYS, ruleStatus, validateRule, resolveTax, commission,
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
  const after = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2027-01-05" });
  assert.equal(after.ok, false);
  assert.equal(after.code, "RULE_EXPIRED", "假設延長＝把提案當成法律，正是這支要擋的事");
});

test("落日前 180 天內回 EXPIRING 而不是安靜的 ACTIVE", () => {
  const rule = { ...base, effective_to: "2026-12-31", verified_at: "2026-09-01" };
  const soon = ruleStatus(rule, "2026-09-19");
  assert.equal(soon.status, STATUS.EXPIRING);
  assert.ok(soon.daysLeft > 0 && soon.daysLeft <= EXPIRING_WITHIN_DAYS);
  const far = ruleStatus({ ...rule, effective_to: "2030-12-31" }, "2026-09-19");
  assert.equal(far.status, STATUS.ACTIVE);
});

test("生效日之前是 NOT_YET，不是可以先拿來用", () => {
  assert.equal(ruleStatus({ ...base, effective_from: "2027-01-01" }, "2026-09-19").status, STATUS.NOT_YET);
});

test("缺欄位一律 UNKNOWN，不得推定為永久有效", () => {
  const { effective_to, ...noEnd } = base;
  assert.equal(ruleStatus(noEnd, "2026-09-19").status, STATUS.UNKNOWN,
    "沒寫 effective_to 與『永久有效』是兩件事——混為一談就是這支存在的理由");
  assert.equal(ruleStatus({ ...base, verified_at: null }, "2026-09-19").status, STATUS.UNKNOWN);
  assert.equal(ruleStatus({ ...base, source_url: "" }, "2026-09-19").status, STATUS.UNKNOWN);
});

test("verified_at 過期會被指名，即使法規本身還在有效期內", () => {
  const stale = ruleStatus({ ...base, verified_at: "2024-01-01" }, "2026-09-19");
  assert.equal(stale.status, STATUS.ACTIVE, "法規仍有效");
  assert.ok(stale.reasons.some((r) => r.includes("重新查證")), "但必須說出沒人回去看過");
});

test("查不到規則時回 code，絕不回退到預設費率", async () => {
  const table = await loadTable();
  const miss = resolveTax(table, { instrumentType: "warrant", tradeDate: "2026-09-19" });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "NO_RULE");
  assert.equal(miss.rate, undefined, "不得帶著一個『差不多的』費率回來");
});

test("涵蓋範圍之外的日期不算適用", async () => {
  const table = await loadTable();
  const old = resolveTax(table, { instrumentType: "stock", tradeDate: "2010-05-05" });
  assert.equal(old.code, "OUT_OF_COVERAGE");
});

test("當沖與一般股票走不同規則，且都解析得到", async () => {
  const table = await loadTable();
  const reg = resolveTax(table, { instrumentType: "stock", tradeDate: "2026-09-19" });
  const day = resolveTax(table, { instrumentType: "stock", tradeDate: "2026-09-19", dayTrade: true });
  assert.equal(reg.rate, 0.003);
  assert.equal(day.rate, 0.0015);
  assert.notEqual(reg.ruleId, day.ruleId);
});

test("債券 ETF 不可套用一般 ETF 的 0.1%", async () => {
  const table = await loadTable();
  const etf = resolveTax(table, { instrumentType: "etf", tradeDate: "2026-09-19" });
  const bond = resolveTax(table, { instrumentType: "bond_etf", tradeDate: "2026-09-19" });
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
