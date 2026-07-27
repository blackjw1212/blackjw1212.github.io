import test from "node:test";
import assert from "node:assert/strict";
import {
  ETF_CODE_RE,
  rocTextToIso,
  normalizeEtfBulkRows,
  normalizeAllEtf,
  normalizeEtfDivRows,
  accumulateDivHistory,
  deriveDividend,
  classifyEtf,
  preserveEtfColumns,
} from "../../scripts/update-etf-feed.mjs";
import { rocToIso } from "../../scripts/update-market-feed.mjs";

test("ETF code regex accepts letter suffixes and rejects stocks/warrants", () => {
  for (const ok of ["0050", "0056", "00878", "006208", "00679B", "00631L", "00632R", "00635U"]) {
    assert.ok(ETF_CODE_RE.test(ok), ok + " should match");
  }
  for (const bad of ["2330", "1519", "031234", "0050A1", "00", "00679BB"]) {
    assert.ok(!ETF_CODE_RE.test(bad), bad + " should not match");
  }
});

test("rocTextToIso parses Chinese ROC dates and leaves rocToIso untouched", () => {
  assert.equal(rocTextToIso("115年08月11日"), "2026-08-11");
  assert.equal(rocTextToIso("115年7月2日"), "2026-07-02");
  assert.equal(rocTextToIso("1150811"), null, "digit form belongs to rocToIso");
  assert.equal(rocTextToIso(""), null);
  // 既有函式語意不得被本期改動（C19）
  assert.equal(rocToIso("1150811"), "2026-08-11");
  assert.equal(rocToIso("115年08月11日"), null);
});

test("normalizeEtfBulkRows keeps only ETF codes from both boards", () => {
  const twse = normalizeEtfBulkRows([
    { Code: "0050", Name: "元大台灣50", ClosingPrice: "101.70", Change: "0.45", TradeVolume: "12345678", Date: "1150725" },
    { Code: "2330", Name: "台積電", ClosingPrice: "2350", Change: "-55" },   // 個股 → 排除
  ], "twse");
  assert.equal(twse.length, 1);
  assert.equal(twse[0].code, "0050");
  assert.equal(twse[0].date, "2026-07-25");

  const tpex = normalizeEtfBulkRows([
    { SecuritiesCompanyCode: "00679B", CompanyName: "元大美債20年", Close: "26.89", Change: "0.05", TradingShares: "18546552", Date: "1150727" },
    { SecuritiesCompanyCode: "735123", CompanyName: "某權證", Close: "0.5", Change: "0" },  // 權證 → 排除
  ], "tpex");
  assert.equal(tpex.length, 1);
  assert.equal(tpex[0].code, "00679B");
  assert.equal(tpex[0].market, "tpex");
});

test("normalizeAllEtf decodes the MIS field letters", () => {
  const out = normalizeAllEtf({ a1: [{ msgArray: [
    { a: "0056", b: "元大高股息", c: 14223000000, e: 50, f: 50.33, g: -0.66, i: "20260727", j: "17:01:15" },
    { a: "9999", b: "非ETF", c: 1, e: 1, f: 1, g: 0 },
  ] }] });
  assert.deepEqual(Object.keys(out), ["0056"]);
  assert.equal(out["0056"].nav, 50.33);
  assert.equal(out["0056"].price, 50);
  assert.equal(out["0056"].premiumOfficial, -0.66);
  assert.equal(out["0056"].date, "2026-07-27");
});

test("normalizeEtfDivRows extracts pay dates and skips malformed rows", () => {
  const rows = normalizeEtfDivRows([
    ["0056", "元大高股息", "115年07月21日", "115年07月27日", "115年08月10日", "1.35", "說明", "115"],
    ["0050", "元大台灣50", "無日期", "-", "-", "3", "說明", "115"],
    ["2330", "台積電", "115年06月16日", "115年06月20日", "115年07月10日", "5", "非ETF", "115"],
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { code: "0056", ex: "2026-07-21", pay: "2026-08-10", dps: 1.35 });
});

test("accumulateDivHistory is idempotent, tracks earliest start, and prunes", () => {
  let acc = accumulateDivHistory({}, [
    { code: "0056", ex: "2026-01-20", pay: "2026-02-10", dps: 1.07 },
    { code: "0056", ex: "2026-04-21", pay: "2026-05-12", dps: 1.2 },
  ], ["0056"], "2026-07-27");
  assert.equal(acc.start, "2026-01-20", "start reflects earliest event, not run date");
  assert.equal(Object.keys(acc.stocks["0056"].events).length, 2);

  // 重複灌同一事件不增筆數
  acc = accumulateDivHistory(acc, [{ code: "0056", ex: "2026-04-21", pay: "2026-05-12", dps: 1.2 }], ["0056"], "2026-07-28");
  assert.equal(Object.keys(acc.stocks["0056"].events).length, 2);

  // 超過 13 個月的事件被剪掉
  acc.stocks["0056"].events["2024-01-01"] = { pay: "2024-02-01", dps: 9 };
  acc = accumulateDivHistory(acc, [], ["0056"], "2026-07-29");
  assert.equal(acc.stocks["0056"].events["2024-01-01"], undefined);

  // 60 天未見於 universe 的代碼整檔剪掉
  acc.stocks["9999X"] = { events: { "2026-06-01": { pay: "2026-07-01", dps: 1 } }, lastSeen: "2026-05-01" };
  acc = accumulateDivHistory(acc, [], ["0056"], "2026-07-30");
  assert.equal(acc.stocks["9999X"], undefined);
});

test("deriveDividend infers frequency from spacing, not event count", () => {
  // 部分窗只有 2 筆、間距 ~3 個月的季配（00878 情境）不得誤判半年配
  const quarterly = deriveDividend({ events: {
    "2026-02-17": { pay: "2026-03-11", dps: 0.4 },
    "2026-05-18": { pay: "2026-06-10", dps: 0.4 },
  } }, "2026-01-06", "2026-07-27");
  assert.equal(quarterly.frequency, "季配");
  assert.equal(quarterly.divMonthsCovered, 7);
  assert.deepEqual(quarterly.dps, [{ m: 3, a: 0.4 }, { m: 6, a: 0.4 }]);

  const monthly = deriveDividend({ events: {
    "2026-04-16": { pay: "2026-05-08", dps: 0.1 },
    "2026-05-16": { pay: "2026-06-08", dps: 0.1 },
    "2026-06-16": { pay: "2026-07-08", dps: 0.1 },
  } }, "2026-01-06", "2026-07-27");
  assert.equal(monthly.frequency, "月配");

  const single = deriveDividend({ events: { "2026-07-01": { pay: "2026-07-20", dps: 2 } } }, "2026-01-06", "2026-07-27");
  assert.equal(single.frequency, null, "single event cannot determine frequency");

  assert.equal(deriveDividend(null, "2026-01-06", "2026-07-27"), null);
});

test("deriveDividend keeps only the trailing 12 months of events", () => {
  const out = deriveDividend({ events: {
    "2025-06-01": { pay: "2025-06-20", dps: 9 },  // 超過一年 → 排除
    "2026-05-18": { pay: "2026-06-10", dps: 0.4 },
  } }, "2025-06-01", "2026-07-27");
  assert.equal(out.count, 1);
  assert.equal(out.totalDps, 0.4);
  assert.equal(out.divMonthsCovered, 12, "coverage caps at 12");
});

test("classifyEtf uses code suffix and name keywords", () => {
  assert.equal(classifyEtf("00631L", "元大台灣50正2"), "槓桿反向");
  assert.equal(classifyEtf("00632R", "元大台灣50反1"), "槓桿反向");
  assert.equal(classifyEtf("00635U", "期街口布蘭特正2"), "槓桿反向", "L/R suffix takes priority; U with 正2 name still leveraged");
  assert.equal(classifyEtf("00693U", "街口S&P黃豆期貨"), "期貨型");
  assert.equal(classifyEtf("00679B", "元大美債20年"), "債券型");
  assert.equal(classifyEtf("0056", "元大高股息"), "高股息");
  assert.equal(classifyEtf("0052", "富邦科技"), "主題型");
});

test("etf-static.json is well formed so the overlap calculator cannot silently lie", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../../data/etf-static.json", import.meta.url));
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.ok(data.etfs && typeof data.etfs === "object", "etfs map required");
  for (const [code, entry] of Object.entries(data.etfs)) {
    assert.ok(ETF_CODE_RE.test(code), `${code} must be a valid ETF code`);
    assert.ok(Array.isArray(entry.topHoldings), `${code} topHoldings must be an array`);
    let sum = 0;
    for (const holding of entry.topHoldings) {
      assert.equal(typeof holding.name, "string", `${code} holding name must be string`);
      assert.equal(typeof holding.weight, "number", `${code} weight must be a number, not "7.5%"`);
      assert.ok(holding.weight > 0 && holding.weight <= 100, `${code} weight out of range`);
      sum += holding.weight;
    }
    assert.ok(sum <= 100.01, `${code} top holdings sum ${sum} exceeds 100%`);
    if (entry.topHoldings.length) {
      assert.match(entry.asOf || "", /^\d{4}-\d{2}-\d{2}$/, `${code} needs an ISO asOf date`);
      assert.ok(entry.source, `${code} needs a source attribution`);
    }
    assert.ok(entry.expenseRatio === null || typeof entry.expenseRatio === "number", `${code} expenseRatio must be number or null`);
  }
});

test("preserveEtfColumns fills only missing columns from previous row", () => {
  const row = { code: "0050", nav: null, discountPremium: null, aum: 21982 };
  const preserved = preserveEtfColumns(row, { nav: 101.27, discountPremium: 0.18, aum: 21000 });
  assert.equal(preserved, 2);
  assert.equal(row.nav, 101.27);
  assert.equal(row.discountPremium, 0.18);
  assert.equal(row.aum, 21982, "fresh value must not be overwritten");
  assert.equal(preserveEtfColumns({ nav: 1 }, null), 0);
});
