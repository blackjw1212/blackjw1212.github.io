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
  coverageStart,
  dividendCv,
  isCoreEtf,
  estimateYield,
  isActiveEtf,
  normalizeTpexExrightRows,
  findNearbyEx,
  addDays,
  srcRank,
  MEDIAN_EX_TO_PAY_DAYS,
} from "../../scripts/update-etf-feed.mjs";
import { rocToIso } from "../../scripts/update-market-feed.mjs";
import { selectTargets } from "../../scripts/seed-etf-div-history.mjs";

// ── 補上官方配息來源的覆蓋缺口 ─────────────────────────────────────
// 實測 2026-07-30：TWSE etfDiv 只涵蓋 95 檔上市 ETF，上櫃 116 檔一筆都沒有，
// 且 00888（永豐台灣ESG，2026 年已配息 3 次）這種上市 ETF 竟然也不在內。
// 結果 207 檔有配息紀錄的 ETF 裡，112 檔的事件全部來自手動跑的 Yahoo 回填 ——
// 那些檔的殖利率會凍結在最後一次手動執行，並隨 13 個月窗剪枝逐筆消失。
// 除權除息預告表（掛在 tpex 網域，實際是跨市場）補得到這些檔，取自真實回應：
const EXRIGHT_ROWS = [
  { ExRrightsExDividendDate: "1150727", SecuritiesCompanyCode: "00888", CompanyName: "永豐台灣ESG", ExRrightsExDividend: "除息", CashDividend: "1.75300000", StockDividendRatio: "0.00000000" },
  { ExRrightsExDividendDate: "1150721", SecuritiesCompanyCode: "00719B", CompanyName: "元大美債1-3", ExRrightsExDividend: "除息", CashDividend: "0.27000000", StockDividendRatio: "0.00000000" },
  { ExRrightsExDividendDate: "1150721", SecuritiesCompanyCode: "00981B", CompanyName: "第一金優選非投債", ExRrightsExDividend: "除息", CashDividend: "0.06300000", StockDividendRatio: "0.00000000" },
  // 一般個股：不是 ETF，必須濾掉
  { ExRrightsExDividendDate: "1150720", SecuritiesCompanyCode: "2640", CompanyName: "大車隊", ExRrightsExDividend: "除息", CashDividend: "8.00000000", StockDividendRatio: "0.00000000" },
  // 純除權：沒有現金流
  { ExRrightsExDividendDate: "1150722", SecuritiesCompanyCode: "00939", CompanyName: "只除權", ExRrightsExDividend: "除權", CashDividend: "0.00000000", StockDividendRatio: "0.05000000" },
  // 金額為 0（待公告）→ 不可寫入，否則殖利率會被灌水成 0 元事件
  { ExRrightsExDividendDate: "1150723", SecuritiesCompanyCode: "00940", CompanyName: "待公告", ExRrightsExDividend: "除息", CashDividend: "0.00000000", StockDividendRatio: "0.00000000" },
];

test("normalizeTpexExrightRows fills the gap the official etfDiv leaves", () => {
  const events = normalizeTpexExrightRows(EXRIGHT_ROWS);
  assert.equal(events.length, 3, "只收 ETF 且有現金股利的除息事件");
  assert.deepEqual(events.map((e) => e.code).sort(), ["00719B", "00888", "00981B"]);

  const etf888 = events.find((e) => e.code === "00888");
  // 與 WantGoo 對照過：2026/07/27 除息 1.75 元（1.753 是未四捨五入的真值）
  assert.equal(etf888.ex, "2026-07-27", "民國日期要轉成 ISO");
  assert.equal(etf888.dps, 1.753);
  // 該表沒有發放日欄位 → 用量到的中位間隔推估，並且必須標記出來
  assert.equal(etf888.pay, addDays("2026-07-27", MEDIAN_EX_TO_PAY_DAYS));
  assert.equal(etf888.payEstimated, true);
  assert.equal(etf888.src, "tpex-exright");

  assert.deepEqual(normalizeTpexExrightRows([]), []);
  assert.throws(() => normalizeTpexExrightRows(null), /not an array/);
});

test("dividend accumulation is idempotent and dedupes across sources", () => {
  const events = normalizeTpexExrightRows(EXRIGHT_ROWS);
  const universe = ["00888", "00719B", "00981B"];
  let history = accumulateDivHistory({ stocks: {} }, events, universe, "2026-07-30");
  const count = () => Object.keys(history.stocks["00888"].events).length;
  assert.equal(count(), 1);

  // 同一批再灌一次：不得增加
  history = accumulateDivHistory(history, events, universe, "2026-07-30");
  assert.equal(count(), 1, "以除息日為 key，重跑必須冪等");

  // 相鄰一天的同一筆配息（不同來源常見的 UTC 位移）：不得各存一份
  // 這正是 00917 把 3.5 元灌成 7 元、殖利率爆成 29.66% 的成因
  const shifted = events.filter((e) => e.code === "00888").map((e) => ({ ...e, ex: addDays(e.ex, 1) }));
  history = accumulateDivHistory(history, shifted, universe, "2026-07-30");
  assert.equal(count(), 1, "±7 天內視為同一次配息");

  // 真正的下一次配息（3 個月後）要收
  const next = [{ code: "00888", ex: "2026-10-27", pay: "2026-11-20", dps: 1.2 }];
  history = accumulateDivHistory(history, next, universe, "2026-07-30");
  assert.equal(count(), 2, "季配的下一筆不可被去重誤殺");
});

test("a source without a real pay date never overwrites the official one", () => {
  const official = [{ code: "00719B", ex: "2026-07-21", pay: "2026-08-14", dps: 0.27 }];
  let history = accumulateDivHistory({ stocks: {} }, official, ["00719B"], "2026-07-30");
  const estimated = [{ code: "00719B", ex: "2026-07-21", pay: "2026-08-13", dps: 0.27, payEstimated: true, src: "tpex-exright" }];
  history = accumulateDivHistory(history, estimated, ["00719B"], "2026-07-30");
  const kept = history.stocks["00719B"].events["2026-07-21"];
  assert.equal(kept.pay, "2026-08-14", "官方確定的發放日不得被推估值取代");
  assert.equal(kept.payEstimated, undefined);

  // 反向：先有推估，官方到位時要升級
  let h2 = accumulateDivHistory({ stocks: {} }, estimated, ["00719B"], "2026-07-30");
  assert.equal(h2.stocks["00719B"].events["2026-07-21"].payEstimated, true);
  h2 = accumulateDivHistory(h2, official, ["00719B"], "2026-07-30");
  const upgraded = h2.stocks["00719B"].events["2026-07-21"];
  assert.equal(upgraded.pay, "2026-08-14");
  assert.equal(upgraded.payEstimated, undefined, "官方資料到位要覆蓋推估值");
});

test("the exchange's own figure outranks the third-party backfill", () => {
  // Yahoo 的金額實測與官方一致，但交易所自己的數字仍應優先——否則新接的官方來源
  // 會被先到的 Yahoo 事件永久擋在門外（實測：15 筆只有 1 筆進得去）
  assert.ok(srcRank({ src: "yahoo", payEstimated: true }) < srcRank({ src: "tpex-exright", payEstimated: true }));
  assert.ok(srcRank({ src: "tpex-exright", payEstimated: true }) < srcRank({ pay: "2026-08-14" }));

  const yahoo = [{ code: "00888", ex: "2026-07-27", pay: "2026-08-20", dps: 1.753, payEstimated: true, src: "yahoo" }];
  let history = accumulateDivHistory({ stocks: {} }, yahoo, ["00888"], "2026-07-30");
  assert.equal(history.stocks["00888"].events["2026-07-27"].src, "yahoo");

  const exright = normalizeTpexExrightRows(EXRIGHT_ROWS).filter((e) => e.code === "00888");
  history = accumulateDivHistory(history, exright, ["00888"], "2026-07-30");
  const events = history.stocks["00888"].events;
  assert.equal(Object.keys(events).length, 1, "升級不可變成兩筆");
  assert.equal(events["2026-07-27"].src, "tpex-exright", "官方金額要取代 Yahoo");

  // 反向不成立：Yahoo 不得把官方蓋回去
  history = accumulateDivHistory(history, yahoo, ["00888"], "2026-07-30");
  assert.equal(history.stocks["00888"].events["2026-07-27"].src, "tpex-exright");
});

test("findNearbyEx and addDays handle boundaries and junk", () => {
  const events = { "2026-07-21": {}, "2026-10-27": {} };
  assert.equal(findNearbyEx(events, "2026-07-22"), "2026-07-21");
  assert.equal(findNearbyEx(events, "2026-07-28"), "2026-07-21", "恰好 7 天仍算同一筆");
  assert.equal(findNearbyEx(events, "2026-07-29"), null, "第 8 天是新事件");
  assert.equal(findNearbyEx({}, "2026-07-21"), null);
  assert.equal(findNearbyEx(events, "not-a-date"), null);
  assert.equal(addDays("2026-07-27", 24), "2026-08-20");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01", "跨年");
  assert.equal(addDays("junk", 1), null);
});

test("the dividend refresh picks the right targets in each mode", () => {
  const stocks = [{ code: "0056" }, { code: "00888" }, { code: "00999" }];
  const store = {
    "0056": { seeded: true, coverFrom: "2024-10-17", events: {} },
    "00888": { seeded: true, events: {} },   // 缺 coverFrom＝上次回填沒跑完
  };
  // 首次回填只補沒完成的
  assert.deepEqual(selectTargets(stocks, store, false).map((r) => r.code), ["00888", "00999"]);
  // 增量模式要掃全部：新配息可能出現在任何一檔，包含至今從未配息的
  assert.deepEqual(selectTargets(stocks, store, true).map((r) => r.code), ["0056", "00888", "00999"]);
  assert.deepEqual(selectTargets([], store, true), []);
  assert.deepEqual(selectTargets(null, store, false), []);
});

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

test("a zero close is rejected as no-trade, not treated as a price", () => {
  // 實測 00682U 期元大美元指數、00707R 期元大S&P日圓反1 當日無成交回 0。
  // 若當成價格：折溢價會算成 -100%、模擬器股數計算除以零。
  const rows = normalizeEtfBulkRows([
    { Code: "0050", Name: "元大台灣50", ClosingPrice: "101.70", Change: "0.45" },
    { Code: "00682U", Name: "期元大美元指數", ClosingPrice: "0", Change: "0", TradeVolume: "0" },
    { Code: "00707R", Name: "期元大S&P日圓反1", ClosingPrice: "0.00", Change: "0" },
  ], "twse");
  assert.deepEqual(rows.map((row) => row.code), ["0050"], "untraded ETFs must be dropped");
});

test("estimateYield annualises only when the history can support it", () => {
  const mk = (dps, months, close = 100) => ({ dps, divMonthsCovered: months, close });

  // 實測案例 009802：4 筆／11 月／已實現 2.66% → 年化 2.9%
  const near = estimateYield(mk([{ m: 2, a: 0.1 }, { m: 5, a: 0.1 }, { m: 8, a: 0.1 }, { m: 11, a: 0.188 }], 11));
  assert.ok(Math.abs(near - 0.488 / 100 * 100 * (12 / 11)) < 0.01);

  // 完全無配息紀錄（槓反/期貨/不配息型，實測 142 檔）→ 恆 null，填值等於造假
  assert.equal(estimateYield(mk([], 12)), null);
  assert.equal(estimateYield(mk(null, 12)), null);
  // 僅 1 筆無法判頻率 → null
  assert.equal(estimateYield(mk([{ m: 8, a: 1 }], 10)), null);
  // 覆蓋不足 6 個月 → 外推太遠，拒絕
  assert.equal(estimateYield(mk([{ m: 7, a: 1 }, { m: 8, a: 1 }], 5)), null);
  assert.ok(estimateYield(mk([{ m: 7, a: 1 }, { m: 8, a: 1 }], 6)) != null, "six months is the boundary");
  // 無價格無法算殖利率
  assert.equal(estimateYield({ dps: [{ m: 1, a: 1 }, { m: 2, a: 1 }], divMonthsCovered: 12, close: 0 }), null);
  // 滿 12 個月時不再放大（因子上限為 1）
  assert.equal(estimateYield(mk([{ m: 1, a: 1 }, { m: 7, a: 1 }], 12)), 2);
});

test("dividendCv and isCoreEtf match the front-end rules", () => {
  // 與 market/index.html 的同名函式必須同規則，否則資料層與畫面會漂移
  assert.equal(dividendCv([{ m: 2, a: 1 }, { m: 8, a: 1 }]), 0);
  assert.ok(dividendCv([{ m: 2, a: 0.1 }, { m: 8, a: 2.5 }]) > 0.6);
  assert.equal(dividendCv([{ m: 8, a: 1 }]), null, "one event cannot show volatility");
  assert.equal(dividendCv(null), null);

  assert.equal(isCoreEtf({ aum: 21982, yield: 1.57, type: "市值型" }), true);
  assert.equal(isCoreEtf({ aum: 4279, yield: 3.52, type: "主題型" }), true, "broad funds mislabelled 主題型 still count");
  assert.equal(isCoreEtf({ aum: 1726, yield: 4.17, type: "債券型" }), false, "a bond ETF is never core");
  assert.equal(isCoreEtf({ aum: 500, yield: 2, type: "市值型" }), false, "too small");
  assert.equal(isCoreEtf({ aum: 5384, yield: 9.7, type: "高股息" }), false, "yield too high");
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
  // 覆蓋月數依「該檔自身最早事件」(2026-02) 算到 2026-07 = 6 個月，
  // 不是全域 history.start(2026-01) 的 7 個月
  assert.equal(quarterly.divMonthsCovered, 6);
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

test("coverage is per-ETF so a newly listed fund cannot claim a full year", () => {
  // 回歸測試：先前用全域 history.start 算 covered，導致 205 檔全部得到 12，
  // 其中 112 檔自身歷史不足一年仍發布殖利率（例：00916 僅 1 筆事件卻顯示 7.49%）。
  const rookie = { coverFrom: "2026-06-16", events: { "2026-06-16": { pay: "2026-07-11", dps: 1.2 } } };
  const veteran = { coverFrom: "2024-09-20", events: { "2026-01-22": { pay: "2026-02-11", dps: 1 }, "2026-07-21": { pay: "2026-08-10", dps: 0.6 } } };

  // 全域起點很早也不得讓新 ETF 蒙混過關
  const rookieOut = deriveDividend(rookie, "2024-08-01", "2026-07-27");
  assert.equal(rookieOut.divMonthsCovered, 2, "only its own two months count");

  const veteranOut = deriveDividend(veteran, "2024-08-01", "2026-07-27");
  assert.equal(veteranOut.divMonthsCovered, 12, "an established fund still reaches full coverage");

  // coverFrom 缺漏時退回目前最早事件，仍不得回退成全域起點
  const legacy = { events: { "2026-05-19": { pay: "2026-06-12", dps: 0.66 } } };
  assert.equal(deriveDividend(legacy, "2024-08-01", "2026-07-27").divMonthsCovered, 3);
});

test("coverageStart prefers coverFrom then earliest event", () => {
  assert.equal(coverageStart({ coverFrom: "2024-09-20", events: { "2026-01-01": {} } }), "2024-09-20");
  assert.equal(coverageStart({ events: { "2026-03-01": {}, "2026-01-01": {} } }), "2026-01-01");
  assert.equal(coverageStart({ events: {} }), null);
  assert.equal(coverageStart(null), null);
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

test("classifyEtf recognises the A/D/T/K/C suffix families", () => {
  // 主動型：先前 29 檔 A 後綴全被誤歸主題型，已在污染產生器候選池
  assert.equal(classifyEtf("00403A", "主動統一升級50"), "主動型");
  assert.equal(classifyEtf("00992A", "主動群益科技創新"), "主動型");
  // 平衡型（股債混合）
  assert.equal(classifyEtf("00981T", "平衡凱基雙核收息"), "平衡型");
  // 外幣計價版：同標的的外幣交易版，規模僅 0～0.19 億
  assert.equal(classifyEtf("00625K", "富邦上証+R"), "外幣計價");
  assert.equal(classifyEtf("00687C", "國泰20年美債+櫃U"), "外幣計價");
  // 名稱無「債」字的債券 ETF（原本漏網歸主題型）
  assert.equal(classifyEtf("00840B", "凱基IG精選15+"), "債券型");
  // 順序鎖定：主動式債券同時符合兩者，須歸債券型（配息行為由債券性質主導）
  assert.equal(classifyEtf("00981D", "主動中信非投等債"), "債券型");
  // 既有判定不得回歸
  assert.equal(classifyEtf("00631L", "元大台灣50正2"), "槓桿反向");
  assert.equal(classifyEtf("00632R", "元大台灣50反1"), "槓桿反向");
  assert.equal(classifyEtf("00693U", "街口S&P黃豆期貨"), "期貨型");
  assert.equal(classifyEtf("0056", "元大高股息"), "高股息");
  assert.equal(classifyEtf("0052", "富邦科技"), "主題型");
});

test("isActiveEtf flags managed funds even when typed as bonds", () => {
  assert.equal(isActiveEtf({ code: "00403A", name: "主動統一升級50" }), true);
  // 主動式債券被歸債券型，但仍須標記為主動管理
  assert.equal(isActiveEtf({ code: "00981D", name: "主動中信非投等債" }), true);
  assert.equal(isActiveEtf({ code: "0050", name: "元大台灣50" }), false);
  assert.equal(isActiveEtf({ code: "00679B", name: "元大美債20年" }), false);
  assert.equal(isActiveEtf(null), false);

  // 規模與殖利率都夠格也不得成為核心——00403A 1,526億、00981A 2,485億
  assert.equal(isCoreEtf({ code: "00403A", name: "主動統一升級50", aum: 1526, yield: 3, type: "主動型" }), false,
    "an actively managed fund must never be treated as a passive core");
  assert.equal(isCoreEtf({ code: "006208", name: "富邦台50", aum: 4279, yield: 3.52, type: "市值型" }), true);
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

test("yahoo backfill never double-counts a distribution recorded a day apart", async () => {
  const { mergeYahooEvents, hasNearbyEvent, medianLagDays, addDays, yahooDividends } =
    await import("../../scripts/seed-etf-div-history.mjs");

  // 實測案例：00917 官方 ex=2026-01-19 dps=3.5，Yahoo 回報 ex=2026-01-20 同額。
  // 只比對相同日期會把 3.5 灌成 7.0（殖利率 14.83% → 29.66%）。
  const entry = { events: { "2026-01-19": { pay: "2026-02-23", dps: 3.5 } } };
  const added = mergeYahooEvents(entry, [{ ex: "2026-01-20", dps: 3.5 }], 25);
  assert.equal(added, 0, "same distribution one day apart must not be added again");
  assert.equal(Object.keys(entry.events).length, 1);
  assert.equal(entry.events["2026-01-19"].dps, 3.5, "official record stays untouched");

  // 真正的新事件仍要補進來，且標記為推估發放日
  const added2 = mergeYahooEvents(entry, [{ ex: "2025-10-16", dps: 3.2 }], 25);
  assert.equal(added2, 1);
  assert.equal(entry.events["2025-10-16"].pay, "2025-11-10", "pay = ex + lag");
  assert.equal(entry.events["2025-10-16"].payEstimated, true);
  assert.equal(entry.events["2025-10-16"].src, "yahoo");

  assert.equal(hasNearbyEvent(entry.events, "2026-01-22"), "2026-01-19", "within 7 days counts as the same event");
  assert.equal(hasNearbyEvent(entry.events, "2026-02-19"), null, "a month later is a distinct event");
  assert.equal(addDays("2026-01-19", 25), "2026-02-13");
});

test("medianLagDays ignores estimated pay dates so lag never drifts", async () => {
  const { medianLagDays } = await import("../../scripts/seed-etf-div-history.mjs");
  assert.equal(medianLagDays({
    "2026-01-22": { pay: "2026-02-11", dps: 1 },   // 20 天（官方）
    "2026-04-23": { pay: "2026-05-14", dps: 1 },   // 21 天（官方）
    "2026-07-21": { pay: "2026-08-15", dps: 1, payEstimated: true }, // 推估 → 不列入
  }), 21);
  assert.equal(medianLagDays({}), null);
  assert.equal(medianLagDays({ "2026-01-01": { pay: "2026-01-01", dps: 1, payEstimated: true } }), null);
});

test("yahooDividends parses the chart events payload and drops junk", async () => {
  const { yahooDividends } = await import("../../scripts/seed-etf-div-history.mjs");
  const rows = yahooDividends({ chart: { result: [{ events: { dividends: {
    "1769000000": { amount: 1.35, date: 1769000000 },
    "1737000000": { amount: 0, date: 1737000000 },
  } } }] } });
  assert.equal(rows.length, 1, "zero-amount events dropped");
  assert.equal(rows[0].dps, 1.35);
  assert.deepEqual(yahooDividends({}), []);
});

test("domesticRatioFromComposition derives the taxable share from a real notice", async () => {
  const { domesticRatioFromComposition } = await import("../../scripts/update-etf-feed.mjs");
  // 收益分配通知書的格式：每受益權單位的各類所得金額。
  // 只有 54C 國內股利與 5A 國內利息課綜所稅；71 海外走最低稅負、76W 與平準金免稅。
  const out = domesticRatioFromComposition({ "54C": 1.2, "5A": 0.3, "71": 1.0, "76W": 0.5, asOf: "2026-07-16" });
  assert.equal(out.ratio, 0.5, "(1.2+0.3) / 3.0");
  assert.match(out.basis, /依收益分配通知書/);
  assert.match(out.basis, /54C 1\.2/);
  assert.match(out.basis, /50\.00%/);
  assert.match(out.basis, /2026-07-16/, "組成逐期會變，期別一定要記");

  // 全海外 → 0；全國內股利 → 1
  assert.equal(domesticRatioFromComposition({ "71": 4 }).ratio, 0);
  assert.equal(domesticRatioFromComposition({ "54C": 4 }).ratio, 1);
  // 收益平準金是資本返還，不是所得 → 拉低應稅比例
  assert.equal(domesticRatioFromComposition({ "54C": 1, "76W": 3 }).ratio, 0.25);
  // 大小寫不敏感
  assert.equal(domesticRatioFromComposition({ "54c": 1, "71": 1 }).ratio, 0.5);

  // 填錯寧可不用，也不要算出假比例
  assert.equal(domesticRatioFromComposition(null), null);
  assert.equal(domesticRatioFromComposition({}), null);
  assert.equal(domesticRatioFromComposition({ asOf: "2026-07-16" }), null, "只有 asOf 沒有金額不算數");
  assert.equal(domesticRatioFromComposition({ "54C": 0, "71": 0 }), null, "全 0 無從計算");
  assert.equal(domesticRatioFromComposition({ "54C": -1, "71": 2 }), null, "負數必是填錯");
  assert.equal(domesticRatioFromComposition({ "54C": "abc" }), null);

  // 浮點殘留不得漏進依據文字（1.12+0.08 在二進位下是 1.2000000000000002）
  const float = domesticRatioFromComposition({ "54C": 1.12, "5A": 0.08, "71": 1.95, "76W": 0.85 });
  assert.equal(float.ratio, 0.3);
  assert.doesNotMatch(float.basis, /0000000/, "依據文字看起來不能像資料髒掉");
  assert.match(float.basis, /1\.2 ÷ 合計 4 /);
});

test("etf-static.json is well formed so the overlap calculator cannot silently lie", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../../data/etf-static.json", import.meta.url));
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.ok(data.etfs && typeof data.etfs === "object", "etfs map required");
  for (const [code, entry] of Object.entries(data.etfs)) {
    assert.ok(ETF_CODE_RE.test(code), `${code} must be a valid ETF code`);
    // 這個檔現在也放「只人工判定配息來源地」的條目（domesticRatio），
    // 那種條目沒有成分股要維護——不要逼它掛一個空陣列充數，那只會引來複製貼上的錯誤
    if (entry.topHoldings === undefined && typeof entry.domesticRatio === "number") continue;
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

// ── 2026-11-12 全站資料審查 ───────────────────────────────────────────────
const audit = await import("../../scripts/update-etf-feed.mjs");
const seedAudit = await import("../../scripts/seed-etf-div-history.mjs");

// 人工清單與自動抓取是同一個來源（MoneyDJ）。原本人工清單無條件優先，於是 0050／0056／00878
// 等 8 檔一直顯示 2026-07-27 的成分股，而 repo 裡早就有 10-30 的版本（00929 前十大換掉 7 檔）。
test("pickHoldings takes whichever list is newer, not whichever is hand-made", () => {
  const { pickHoldings } = audit;
  const curated = { topHoldings: [{ name: "聯電", weight: 10.49 }], asOf: "2026-07-27", source: "MoneyDJ Basic0007a" };
  const scraped = { topHoldings: [{ name: "華碩", weight: 3.97 }], asOf: "2026-10-30", source: "MoneyDJ Basic0007a" };
  assert.equal(pickHoldings(curated, scraped).holdingsAsOf, "2026-10-30", "00929：7 月的名單不可以蓋過 10 月的");
  assert.equal(pickHoldings(curated, scraped).topHoldings[0].name, "華碩");
  // 人工清單比較新（剛手動更新過）時才優先；同一天也讓人工清單優先
  assert.equal(pickHoldings({ ...curated, asOf: "2026-11-05" }, scraped).holdingsAsOf, "2026-11-05");
  assert.equal(pickHoldings({ ...curated, asOf: "2026-10-30" }, scraped).topHoldings[0].name, "聯電");
  // 沒有資料日的人工清單輸給有資料日的
  assert.equal(pickHoldings({ topHoldings: curated.topHoldings }, scraped).holdingsAsOf, "2026-10-30");
  // 只有一邊有資料
  assert.equal(pickHoldings(curated, null).holdingsAsOf, "2026-07-27");
  assert.equal(pickHoldings({ type: "債券型" }, scraped).holdingsAsOf, "2026-10-30");
  assert.equal(pickHoldings({ type: "債券型", topHoldings: [] }, undefined), null);
});

// MIS 的 all_etf 一開盤就是當天的，收盤價（尤其上櫃）要到晚上才換日。實測 2026-11-06：
// 006201 是 11-05 的收盤 35.58 配 11-06 的淨值 31.54，折溢價寫 +1.55%（那一列自己算是 +12.81%）。
test("NAV and premium are only taken from a snapshot of the row's own close date", () => {
  const { navForRow } = audit;
  const snapshot = { nav: 31.54, price: 32.03, premiumOfficial: 1.55, units: 27446000, date: "2026-11-06" };
  assert.equal(navForRow(snapshot, "2026-11-05"), null, "快照是 11-06、收盤是 11-05：不採用");
  assert.equal(navForRow(snapshot, "2026-11-06"), snapshot);
  assert.equal(navForRow({ ...snapshot, date: null }, "2026-11-05").nav, 31.54, "來源沒給日期時無從判斷，照舊採用");
  assert.equal(navForRow(null, "2026-11-05"), null);

  // 沿用前一班：淨值與折溢價只在同一天的收盤才沿用；規模變動慢，跨日也沿用
  const previous = { date: "2026-11-05", nav: 35.4, discountPremium: 0.51, aum: 9.7 };
  const sameDay = { date: "2026-11-05" };
  assert.equal(preserveEtfColumns(sameDay, previous), 3);
  assert.deepEqual(sameDay, { date: "2026-11-05", nav: 35.4, discountPremium: 0.51, aum: 9.7 });
  const nextDay = { date: "2026-11-06" };
  assert.equal(preserveEtfColumns(nextDay, previous), 1, "換日之後只沿用規模");
  assert.deepEqual(nextDay, { date: "2026-11-06", aum: 9.7 });
});

// 除權息計算結果表：兩個市場的 ETF 除息都在裡面。fixture 取自 2026-11-12 實抓的列。
const TWT49U_FIELDS = ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價", "權值+息值", "權/息", "漲停價格", "跌停價格", "開盤競價基準", "減除股利參考價", "詳細資料"];
const twseResult = (data) => ({ stat: "OK", fields: TWT49U_FIELDS, data });
const EXDAILYQ_FIELDS = ["除權息日期", "代號", "名稱", "除權息前收盤價", "除權息參考價", "權值", "息值", "權值+息值", "權/息", "漲停價", "跌停價", "開始交易基準價", "減除股利參考價", "現金股利", "每仟股無償配股"];
const tpexResult = (data) => ({ tables: [{ fields: EXDAILYQ_FIELDS, data }] });

test("normalizeExRightResults reads ETF cash dividends from both exchanges' result tables", () => {
  const { normalizeExRightResults } = audit;
  const twse = normalizeExRightResults(twseResult([
    ["115年09月16日", "00915", "凱基優選高股息30", "32.89", "32.29", "0.600000", "息", "", "", "", "", ""],
    ["115年09月16日", "00972", "野村日本動能高息", "22.15", "21.93", "0.220000", "息", "", "", "", "", ""],
    ["115年09月02日", "6669", "緯穎", "7,800.00", "2,614.99", "5,185.002642", "權", "", "", "", "", ""],   // 個股：不是 ETF
    ["115年09月16日", "00999", "假想權息", "10.00", "9.00", "1.000000", "權息", "", "", "", "", ""],          // 混著權值：不收
  ]), "twse");
  assert.deepEqual(twse.map((e) => [e.code, e.ex, e.dps]), [["00915", "2026-09-16", 0.6], ["00972", "2026-09-16", 0.22]]);
  assert.equal(twse[0].payEstimated, true, "這張表沒有發放日");
  assert.equal(srcRank(twse[0]), 2, "官方金額＋推估發放日：贏過 Yahoo（1），輸給 etfDiv（3）");

  const tpex = normalizeExRightResults(tpexResult([
    ["115/07/02", "00950B", "凱基A級公司債         ", "14.26", "14.20", "0.000000", "0.063000", "0.063000", "除息", "", "", "", "", "0.06300000", "0.00000000"],
    ["115/07/15", "3081", "聯亞              ", "1925.00", "1747.27", "174.727261", "3.000000", "177.727261", "除權息", "", "", "", "", "3.00000000", "99.99999243"],
  ]), "tpex");
  assert.deepEqual(tpex.map((e) => [e.code, e.ex, e.dps]), [["00950B", "2026-07-02", 0.063]], "上櫃的日期是 115/07/02 這種寫法");

  // 那段期間真的沒有事件 → 空陣列（不是失敗）
  assert.deepEqual(normalizeExRightResults({ stat: "很抱歉，沒有符合條件的資料!" }, "twse"), []);
  assert.deepEqual(normalizeExRightResults(tpexResult([]), "tpex"), []);
});

// 第一版的預演就是栽在這裡：上櫃的日期解析不到 → 回空陣列 → 428 筆正確的配息被當成假的要刪。
test("an unreadable result table is a failure, never an empty result", () => {
  const { normalizeExRightResults } = audit;
  assert.throws(() => normalizeExRightResults(tpexResult([["2026-07-02", "00950B", "x", "1", "1", "0", "0", "0", "除息", "", "", "", "", "0.063", "0"]]), "tpex"), /no readable date/);
  assert.throws(() => normalizeExRightResults({ stat: "OK", fields: ["代號"], data: [] }, "twse"), /lost its/);
  assert.throws(() => normalizeExRightResults("<html>因為安全性考量</html>", "twse"), /TWT49U/);
  assert.throws(() => normalizeExRightResults({ tables: [] }, "tpex"), /no table/);
});

test("the confirmed window only grows when the new window touches the stored one", () => {
  const { extendConfirmedWindow } = audit;
  const stored = { from: "2025-11-01", to: "2026-11-12" };
  assert.deepEqual(extendConfirmedWindow(stored, { from: "2026-10-04", to: "2026-11-13" }), { from: "2025-11-01", to: "2026-11-13" });
  assert.deepEqual(extendConfirmedWindow(stored, { from: "2026-11-13", to: "2026-12-20" }), { from: "2025-11-01", to: "2026-12-20" }, "首尾相接也算接得上");
  // 中間斷了一段：那一段有沒有假事件無從得知，不可以宣稱確認過
  assert.deepEqual(extendConfirmedWindow(stored, { from: "2026-12-25", to: "2027-02-03" }), stored);
  assert.deepEqual(extendConfirmedWindow(null, { from: "2026-10-04", to: "2026-11-13" }), { from: "2026-10-04", to: "2026-11-13" });
  assert.deepEqual(extendConfirmedWindow(stored, null), stored, "這一班沒抓到：維持原狀");
  assert.equal(extendConfirmedWindow(null, null), null);
});

// 實測：Yahoo 給 00915 一筆 2026-08-18 的 0.32 元，官方只有每季一筆（12/16、3/17、6/16、9/16）。
// 它離真正的 09-16 有 29 天，落在 ±7 天去重窗之外，殖利率因此是 6.59% 而不是 5.59%。
test("third-party dividends the official tables do not have are dropped inside the confirmed window", () => {
  const { dropUnconfirmedThirdParty } = audit;
  const store = () => ({
    "00915": { events: {
      "2026-06-16": { pay: "2026-07-10", dps: 0.45 },
      "2026-08-18": { pay: "2026-09-15", dps: 0.32, payEstimated: true, src: "yahoo" },
      "2026-09-16": { pay: "2026-10-15", dps: 0.6 },
      "2025-06-17": { pay: "2025-07-15", dps: 0.21, payEstimated: true, src: "yahoo" },   // 確認期間之前：留著
    } },
    "00679B": { events: { "2026-08-19": { pay: "2026-09-12", dps: 0.28, payEstimated: true, src: "exright-result" } } },
  });
  const marketOf = (code) => (code === "00679B" ? "tpex" : "twse");
  const window = { from: "2025-11-01", to: "2026-11-12" };

  const a = store();
  const removed = dropUnconfirmedThirdParty(a, { twse: window, tpex: window }, marketOf);
  assert.deepEqual(removed.map((r) => `${r.code}@${r.ex}`), ["00915@2026-08-18"]);
  assert.deepEqual(Object.keys(a["00915"].events).sort(), ["2025-06-17", "2026-06-16", "2026-09-16"]);
  assert.ok(a["00679B"].events["2026-08-19"], "官方來源的事件永遠不動");

  // 那個市場沒有確認期間（這一班沒抓到表）→ 什麼都不刪
  const b = store();
  assert.equal(dropUnconfirmedThirdParty(b, { tpex: window }, marketOf).length, 0);
  assert.ok(b["00915"].events["2026-08-18"]);
});

test("a mass deletion is refused: it means the table was misread, not that the data is wrong", () => {
  const { dropUnconfirmedThirdParty, THIRD_PARTY_DROP_RATIO } = audit;
  assert.ok(THIRD_PARTY_DROP_RATIO <= 0.05);
  const store = {};
  for (let i = 0; i < 40; i += 1) store[`0090${String(i).padStart(2, "0")}`] = { events: { "2026-07-16": { pay: "2026-08-10", dps: 0.1, payEstimated: true, src: "yahoo" } } };
  const window = { from: "2025-11-01", to: "2026-11-12" };
  const removed = dropUnconfirmedThirdParty(store, { twse: window }, () => "twse");
  assert.equal(removed.length, 0, "40 筆裡要刪 40 筆：拒絕");
  assert.deepEqual(removed.refused, [{ market: "twse", count: 40, of: 40 }]);
  assert.equal(Object.keys(store).filter((c) => store[c].events["2026-07-16"]).length, 40, "一筆都不可以少");
});

// 每日的 Yahoo 增量刷新會把同一筆假事件再灌回來——確認期間內的第三方事件一開始就不收
test("the Yahoo refresh does not re-add events inside the officially confirmed window", () => {
  const { outsideConfirmedWindow } = seedAudit;
  const events = [{ ex: "2025-06-17", dps: 0.21 }, { ex: "2026-08-18", dps: 0.32 }, { ex: "2026-11-20", dps: 0.5 }];
  assert.deepEqual(outsideConfirmedWindow(events, { from: "2025-11-01", to: "2026-11-12" }).map((e) => e.ex), ["2025-06-17", "2026-11-20"]);
  assert.equal(outsideConfirmedWindow(events, undefined).length, 3, "還沒有確認期間：照舊全收");
});

// 端到端：官方結果表進來之後，Yahoo 的同一筆被取代（不重複計入），假事件被拿掉，殖利率回到正確值
test("00915: official result tables replace Yahoo rows and remove the phantom dividend", () => {
  const { normalizeExRightResults, dropUnconfirmedThirdParty } = audit;
  const history = { start: "2024-09-19", stocks: { "00915": { events: {
    "2025-12-16": { pay: "2026-01-13", dps: 0.35, payEstimated: true, src: "yahoo" },
    "2026-03-17": { pay: "2026-04-14", dps: 0.38 },
    "2026-06-16": { pay: "2026-07-10", dps: 0.45 },
    "2026-08-18": { pay: "2026-09-15", dps: 0.32, payEstimated: true, src: "yahoo" },
    "2026-09-16": { pay: "2026-10-15", dps: 0.6 },
  }, lastSeen: "2026-11-11" } } };
  const official = normalizeExRightResults(twseResult([
    ["114年12月16日", "00915", "凱基優選高股息30", "22.59", "22.24", "0.350000", "息", "", "", "", "", ""],
    ["115年03月17日", "00915", "凱基優選高股息30", "23.66", "23.28", "0.380000", "息", "", "", "", "", ""],
    ["115年06月16日", "00915", "凱基優選高股息30", "31.46", "31.01", "0.450000", "息", "", "", "", "", ""],
    ["115年09月16日", "00915", "凱基優選高股息30", "32.89", "32.29", "0.600000", "息", "", "", "", "", ""],
  ]), "twse");
  const merged = accumulateDivHistory(history, official, ["00915"], "2026-11-11");
  const events = merged.stocks["00915"].events;
  assert.equal(events["2025-12-16"].src, "exright-result", "Yahoo 那筆換成官方的（同一天、同金額）");
  assert.equal(events["2026-09-16"].payEstimated, undefined, "有官方發放日的 etfDiv 不會被結果表蓋掉");
  dropUnconfirmedThirdParty(merged.stocks, { twse: { from: "2025-11-01", to: "2026-11-12" } }, () => "twse");
  assert.deepEqual(Object.keys(events).sort(), ["2025-12-16", "2026-03-17", "2026-06-16", "2026-09-16"]);
  const dividend = deriveDividend(merged.stocks["00915"], merged.start, "2026-11-11");
  const sum = dividend.dps.reduce((total, e) => total + e.a, 0);
  assert.equal(Math.round(sum / 31.86 * 10000) / 100, 5.59, "收盤 31.86：5.59%，不是含假事件的 6.59%");
});

// 回補工具把期間切成兩個月一段去抓。段與段之間漏一天，那一天就沒人核對過，
// 卻會被寫進「官方已確認」的期間裡——所以首尾相接、不重疊、剛好蓋滿是正確性，不是整潔。
test("the back-fill windows tile the range with no gap and no overlap", async () => {
  const { splitWindows } = await import("../../scripts/migrate-etf-div-official.mjs");
  for (const [from, to] of [["2024-11-01", "2026-11-12"], ["2025-12-31", "2026-03-01"], ["2026-02-27", "2026-02-27"], ["2024-12-30", "2025-03-02"]]) {
    const windows = splitWindows(from, to);
    assert.equal(windows[0][0], from);
    assert.equal(windows[windows.length - 1][1], to);
    for (let i = 0; i < windows.length; i += 1) {
      assert.ok(windows[i][0] <= windows[i][1], `${windows[i]} 倒過來了`);
      if (i) assert.equal(windows[i][0], addDays(windows[i - 1][1], 1), `第 ${i} 段沒有接在前一段的隔天`);
    }
  }
  assert.deepEqual(splitWindows("2026-11-13", "2026-11-12"), [], "起點晚於終點就沒有窗口");
});

// ── 官方金額與第三方金額對不上時 ─────────────────────────────────────────
// 官方表印的是當時每單位的金額；ETF 分割之後第三方會把更早的配息換算到現在的單位。
// 判法用分割的定義：分割會把**更早的每一筆**等比例縮放。
const exr = (code, ex, dps) => ({ code, ex, pay: addDays(ex, 24), dps, payEstimated: true, src: "exright-result" });
const yh = (dps) => ({ pay: "2026-01-01", dps, payEstimated: true, src: "yahoo" });

test("an amount conflict after earlier agreement is a third-party error: the official amount wins", async () => {
  const { accumulateDivHistory: acc } = await import("../../scripts/update-etf-feed.mjs");
  // 00932 的實例：前三筆兩邊對得上，2025-08-18 官方 0.18、第三方 0.06（比例剛好是 3）
  const store = { stocks: { "00932": { lastSeen: "2026-11-12", events: {
    "2025-02-18": yh(0.1), "2025-05-19": yh(0.1), "2025-08-18": yh(0.06), "2025-11-18": yh(0.2),
  } } } };
  const out = acc(store, [
    exr("00932", "2025-08-18", 0.18), exr("00932", "2025-02-18", 0.1), exr("00932", "2025-05-19", 0.1), exr("00932", "2025-11-18", 0.2),
  ], ["00932"], "2026-11-12");
  assert.equal(out.stocks["00932"].events["2025-08-18"].dps, 0.18);
  assert.equal(out.stocks["00932"].events["2025-08-18"].src, "exright-result");
  assert.deepEqual(out.conflicts.map((c) => [c.code, c.ex, c.verdict]), [["00932", "2025-08-18", "official"]]);
});

test("a clean split ratio with nothing earlier to compare is left alone, with the official figure recorded", async () => {
  const mod = await import("../../scripts/update-etf-feed.mjs");
  // 0050 的實例：2025 年 1 拆 4，2025-01-17 官方 2.7、第三方 0.675；之後那筆兩邊都是 0.36
  const store = { stocks: { "0050": { lastSeen: "2026-11-12", events: { "2025-01-17": yh(0.675), "2025-07-21": yh(0.36) } } } };
  const events = [exr("0050", "2025-01-17", 2.7), exr("0050", "2025-07-21", 0.36)];
  const out = mod.accumulateDivHistory(store, events, ["0050"], "2026-11-12");
  const kept = out.stocks["0050"].events["2025-01-17"];
  assert.equal(kept.dps, 0.675, "換成 2.7 會讓配息穩定度把分割當成配息暴跌");
  assert.equal(kept.officialDps, 2.7);
  assert.equal(kept.src, "yahoo");
  assert.equal(out.stocks["0050"].events["2025-07-21"].src, "exright-result", "對得上的那筆照常升級");
  assert.deepEqual(out.conflicts.map((c) => c.verdict), ["kept"]);
  // 之後那筆對得上，不能拿來否定「更早那筆之後有分割」
  // 官方確認過這一筆存在，所以清第三方事件時不可以把它當成假的刪掉
  const dropped = mod.dropUnconfirmedThirdParty(out.stocks, { twse: { from: "2024-11-01", to: "2026-11-12" } }, () => "twse");
  assert.equal(dropped.length, 0);
  assert.ok(out.stocks["0050"].events["2025-01-17"]);
  // 冪等：再跑一次結果相同
  const again = mod.accumulateDivHistory({ stocks: JSON.parse(JSON.stringify(out.stocks)) }, events, ["0050"], "2026-11-12");
  assert.deepEqual(again.stocks, out.stocks);
});

test("a ratio that is not a split ratio cannot be a unit difference: the official amount wins", async () => {
  const mod = await import("../../scripts/update-etf-feed.mjs");
  const store = { stocks: { "00999": { lastSeen: "2026-11-12", events: { "2026-03-17": yh(0.13) } } } };
  const out = mod.accumulateDivHistory(store, [exr("00999", "2026-03-17", 0.18)], ["00999"], "2026-11-12");
  assert.equal(out.stocks["00999"].events["2026-03-17"].dps, 0.18);
  assert.equal(out.conflicts[0].verdict, "official");
  assert.equal(mod.splitLikeRatio(0.18, 0.13), null);
  assert.equal(mod.splitLikeRatio(2.7, 0.675), 4);
  assert.equal(mod.splitLikeRatio(3.23, 0.4614), 7);
  assert.equal(mod.splitLikeRatio(0.1, 0.4), 0.25, "反分割也是乾淨比例");
  assert.ok(mod.sameDividendAmount(0.4614, 3.23 / 7), "四位小數的捨入不算對不上");
  assert.ok(!mod.sameDividendAmount(0.675, 0.68));
});
