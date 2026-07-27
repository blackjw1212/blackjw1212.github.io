import test from "node:test";
import assert from "node:assert/strict";
import {
  rocToIso,
  normalizeMarketRows,
  normalizeMarketValuation,
  preserveMarketRows,
  applyValuation,
  accumulate52w,
  derive52w,
  monthKey,
} from "../../scripts/update-market-feed.mjs";

test("rocToIso converts ROC calendar dates and rejects junk", () => {
  assert.equal(rocToIso("1150717"), "2026-07-17");
  assert.equal(rocToIso("991231"), "2010-12-31");
  assert.equal(rocToIso(""), null);
  assert.equal(rocToIso("2026-07-17"), null);
});

test("normalizeMarketRows handles TWSE and TPEX field shapes and filters non-stocks", () => {
  const twse = normalizeMarketRows([
    { Code: "2330", Name: "台積電", ClosingPrice: "2,350.00", Change: "-55.0000", OpeningPrice: "2355", HighestPrice: "2365", LowestPrice: "2345", TradeVolume: "24810509", Date: "1150727" },
    { Code: "0050", Name: "元大台灣50", ClosingPrice: "200", Change: "1" },      // ETF → 排除
    { Code: "031234", Name: "某權證", ClosingPrice: "5", Change: "0" },          // 權證 → 排除
    { Code: "9999", Name: "無收盤", ClosingPrice: "--", Change: "0" },           // 無收盤 → 排除
  ], "twse");
  assert.equal(twse.length, 1);
  assert.deepEqual(twse[0], {
    code: "2330", name: "台積電", market: "twse", close: 2350, change: -55,
    open: 2355, high: 2365, low: 2345, volume: 24810509, date: "2026-07-27",
  });

  const tpex = normalizeMarketRows([
    { SecuritiesCompanyCode: "3324", CompanyName: "雙鴻", Close: "930.00", Change: "-13.00", Open: "943", High: "943", Low: "890", TradingShares: "1831325", Date: "1150727" },
  ], "tpex");
  assert.equal(tpex[0].market, "tpex");
  assert.equal(tpex[0].close, 930);
  assert.equal(tpex[0].name, "雙鴻");
});

test("normalizeMarketValuation reads both source shapes and skips empty rows", () => {
  const out = normalizeMarketValuation([
    { Code: "2330", PEratio: "31.59", DividendYield: "0.94", PBratio: "10.34" },
    { SecuritiesCompanyCode: "3324", PriceEarningRatio: "27.22", YieldRatio: "1.26", PriceBookRatio: "6.54" },
    { Code: "1234", PEratio: "--", DividendYield: "--", PBratio: "--" },
  ]);
  assert.deepEqual(out["2330"], { pe: 31.59, dividendYield: 0.94, pbRatio: 10.34 });
  assert.deepEqual(out["3324"], { pe: 27.22, dividendYield: 1.26, pbRatio: 6.54 });
  assert.equal(out["1234"], undefined);
});

test("normalizeMarketValuation keeps a loss-making stock that still reports yield or PB", () => {
  const out = normalizeMarketValuation([{ Code: "2337", PEratio: "--", DividendYield: "1.20", PBratio: "1.80" }]);
  assert.equal(out["2337"].pe, undefined);
  assert.equal(out["2337"].pbRatio, 1.8);
});

test("preserveMarketRows keeps previous rows when upstream collapses", () => {
  const previous = Array.from({ length: 1000 }, (_, i) => ({ code: String(1000 + i), close: 10 }));
  const collapsed = preserveMarketRows(previous, [{ code: "2330", close: 100 }]);
  assert.equal(collapsed.preserved, true);
  assert.equal(collapsed.rows.length, 1000);

  const healthy = Array.from({ length: 980 }, (_, i) => ({ code: String(1000 + i), close: 11 }));
  const ok = preserveMarketRows(previous, healthy);
  assert.equal(ok.preserved, false);
  assert.equal(ok.rows.length, 980);

  const cold = preserveMarketRows([], [{ code: "2330", close: 100 }]);
  assert.equal(cold.preserved, false, "cold start must not be treated as degradation");
});

test("applyValuation falls back per row so one failed source cannot blank a whole board", () => {
  // TWSE 估值成功、TPEX 估值失敗：上櫃股必須沿用前次值，不是靜默清空
  const stocks = [
    { code: "2330", close: 2350 },
    { code: "3324", close: 930 },
    { code: "9001", close: 50 },
  ];
  const result = applyValuation(
    stocks,
    { "2330": { pe: 31.59, dividendYield: 0.94, pbRatio: 10.34 } },
    { "3324": { pe: 27.22, dividendYield: 1.26, pbRatio: 6.54 } },
  );
  assert.equal(result.preserved, 1);
  assert.equal(stocks[0].pe, 31.59, "fresh value wins");
  assert.equal(stocks[1].pe, 27.22, "missing board falls back to previous");
  assert.equal(stocks[2].pe, undefined, "no data anywhere stays undefined");
});

test("applyValuation prefers fresh data over stale previous values", () => {
  const stocks = [{ code: "2330", close: 2350 }];
  const result = applyValuation(stocks, { "2330": { pe: 31.59 } }, { "2330": { pe: 99 } });
  assert.equal(stocks[0].pe, 31.59);
  assert.equal(result.preserved, 0);
});

test("accumulate52w buckets by row date, is idempotent, and prunes old months", () => {
  let acc = accumulate52w({}, [{ code: "2330", high: 100, low: 90, close: 95, date: "2026-07-27" }], "2026-07-27");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [100, 90]);

  // 同日重跑不放大區間
  acc = accumulate52w(acc, [{ code: "2330", high: 100, low: 90, close: 95, date: "2026-07-27" }], "2026-07-27");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [100, 90]);

  // 同月更高/更低取極值
  acc = accumulate52w(acc, [{ code: "2330", high: 120, low: 80, close: 110, date: "2026-07-28" }], "2026-07-28");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [120, 80]);

  // TWSE 落後一日時仍歸到自己的月份
  acc = accumulate52w(acc, [{ code: "2330", high: 130, low: 125, close: 128, date: "2026-08-03" }], "2026-08-03");
  assert.deepEqual(acc.stocks["2330"].m["2026-08"], [130, 125]);

  // 超過 13 個月的 bucket 被剪枝
  acc.stocks["2330"].m["2024-01"] = [999, 1];
  acc = accumulate52w(acc, [{ code: "2330", high: 130, low: 125, close: 128, date: "2026-08-04" }], "2026-08-04");
  assert.equal(acc.stocks["2330"].m["2024-01"], undefined);
  assert.equal(derive52w(acc.stocks["2330"]).hi52, 130, "pruned month must not leak into the 52w high");
});

test("accumulate52w drops stocks unseen for 60 days (delisted)", () => {
  let acc = accumulate52w({}, [
    { code: "2330", high: 100, low: 90, close: 95, date: "2026-01-05" },
    { code: "9999", high: 10, low: 9, close: 9.5, date: "2026-01-05" },
  ], "2026-01-05");
  assert.ok(acc.stocks["9999"]);
  acc = accumulate52w(acc, [{ code: "2330", high: 105, low: 95, close: 100, date: "2026-05-05" }], "2026-05-05");
  assert.equal(acc.stocks["9999"], undefined, "delisted code should be pruned");
  assert.ok(acc.stocks["2330"]);
});

test("derive52w spans months and returns null without data", () => {
  assert.equal(derive52w(null), null);
  assert.equal(derive52w({ m: {} }), null);
  assert.deepEqual(derive52w({ m: { "2026-06": [200, 150], "2026-07": [180, 120] } }), { hi52: 200, lo52: 120 });
});

test("monthKey extracts YYYY-MM", () => {
  assert.equal(monthKey("2026-07-27"), "2026-07");
  assert.equal(monthKey(""), "");
});
