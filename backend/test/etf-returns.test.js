import test from "node:test";
import assert from "node:assert/strict";
import { yahooReturns, hasFullYear, snapSplitRatio } from "../../scripts/update-etf-returns.mjs";

// 造一段日線回應。ratios 是逐日的價格比值，dividendDrag 讓 adjclose 與 raw 分道揚鑣。
function chart(closes, { adj = null, startDays = 365 } = {}) {
  const day = 86400;
  const end = Math.floor(Date.parse("2026-08-06T00:00:00Z") / 1000);
  const timestamp = closes.map((_, i) => end - (closes.length - 1 - i) * Math.round(startDays * day / (closes.length - 1)));
  return {
    chart: {
      result: [{
        timestamp,
        indicators: {
          quote: [{ close: closes }],
          adjclose: adj ? [{ adjclose: adj }] : undefined,
        },
      }],
    },
  };
}

test("snapSplitRatio only accepts ratios close to a clean split", () => {
  // 實測 0052：2025-11-17 單日比值 0.1431，對應 1:7
  assert.equal(snapSplitRatio(0.1431), 1 / 7);
  assert.equal(snapSplitRatio(0.5012), 0.5);
  assert.equal(snapSplitRatio(2.004), 2);
  // 實測 00738U：0.6885 不貼近任何乾淨比例 → 不猜
  assert.equal(snapSplitRatio(0.6885), null);
  assert.equal(snapSplitRatio(0.77), null);
});

test("a plain series gives price and total return, dividends only add", () => {
  const out = yahooReturns(chart([100, 110, 120], { adj: [95, 105, 120] }));
  assert.equal(out.priceReturn1y, 20);      // 100 → 120
  assert.equal(out.totalReturn1y, 26.3);    // 95 → 120
  assert.ok(out.totalReturn1y > out.priceReturn1y, "配息只會加分");
  assert.equal(out.spanDays, 365);
  assert.equal(out.splitsApplied, undefined);
});

// 這是整支腳本存在的理由。Yahoo 的 adjclose 不還原台股 ETF 分割，
// 且 events.splits 是空的（0052 日線月線都查過），直接相除會得到 −73%。
test("a 1:7 split is corrected instead of being read as a 86% crash", () => {
  // 100 → 105 →（1:7 分割）→ 15 → 16。分割以外的每一步都要守住 ±10%，
  // 否則會被當成另一個無法解釋的跳動（寫這條測試時就先踩到一次）。
  const raw = [100, 105, 15, 16];
  const out = yahooReturns(chart(raw, { adj: raw }));
  assert.equal(out.splitsApplied, 1);
  // 校正後起點 100 × (1/7) = 14.2857，終點 16 → +12%
  assert.equal(out.priceReturn1y, 12);
  assert.equal(out.totalReturn1y, 12);
  assert.ok(out.priceReturn1y > 0, "分割不得被讀成崩跌");
});

// 風險側的指標同樣要用校正後的序列。用原始價格的話 0052 的 1:7 分割
// 會變成 −86% 的單日回撤，把整個風險評分毀掉。
test("a split is not counted as a drawdown", () => {
  const raw = [100, 105, 15, 16];
  const out = yahooReturns(chart(raw, { adj: raw }));
  assert.equal(out.splitsApplied, 1);
  // 校正後序列為 14.29 / 15 / 15 / 16，一路向上，只有第一段的微小回落
  assert.ok(out.maxDrawdown1y > -5, `分割被當成回撤了：${out.maxDrawdown1y}%`);
  assert.ok(out.maxDrawdown1y <= 0, "回撤不可能為正");
});

test("drawdown measures peak-to-trough, not first-to-last", () => {
  // 100 → 110（峰）→ 99 → 105：末值高於起點，但中間確實跌過 10%
  const series = [100, 110, 99, 105];
  const out = yahooReturns(chart(series, { adj: series }));
  assert.equal(out.priceReturn1y, 5, "總報酬是首末相除");
  assert.equal(out.maxDrawdown1y, -10, "回撤要抓峰谷，110 → 99 是 −10%");
});

test("volatility needs enough samples and rises with choppiness", () => {
  const steady = Array.from({ length: 60 }, (_, i) => 100 * (1.001 ** i));
  const choppy = Array.from({ length: 60 }, (_, i) => 100 * (1.001 ** i) * (i % 2 ? 1.05 : 0.95));
  const a = yahooReturns(chart(steady, { adj: steady }));
  const b = yahooReturns(chart(choppy, { adj: choppy }));
  assert.ok(a.volatility1y >= 0);
  assert.ok(b.volatility1y > a.volatility1y * 5, "波動大的序列要算出明顯較高的波動度");
  // 樣本太少就不發布，不要用 3 個點硬算年化波動
  const tiny = yahooReturns(chart([100, 101, 102], { adj: [100, 101, 102] }));
  assert.equal(tiny.volatility1y, undefined);
  assert.ok(tiny.maxDrawdown1y != null, "回撤只要有兩點就算得出來，不受樣本數門檻限制");
});

test("an unexplained jump is skipped rather than guessed", () => {
  // 0.6885 不是乾淨的分割比例——用觀測值當係數會把當天最多 10% 的真實漲跌
  // 一起吃進去，讓整段歷史偏移，所以整檔不發布
  const out = yahooReturns(chart([100, 100, 68.85, 70]));
  assert.ok(out.skip, "應該跳過");
  assert.match(out.skip, /unexplained/);
});

// 同一組資料、兩種門檻，判定必須不同。這是整個 bug 的核心：
// 2026-07-31 台股 0050 漲停 +10.00%，四檔正2 同步 +18.2~18.8%——對一般 ETF
// 那是不可能的行情（必為分割），對 2x 槓桿卻是設計行為。舊版只有一組門檻，
// 把規模 2,690 億的 00631L 整檔丟掉。
test("an 18.75% day is a split for a normal ETF but normal action for a 2x fund", () => {
  const series = [100, 100, 118.75, 120];   // 實測 00631L 28.38 → 33.70 的比值
  const asNormal = yahooReturns(chart(series, { adj: series }));
  assert.ok(asNormal.skip, "一般 ETF：超出 ±10% 漲跌幅，必須當成分割處理");
  assert.match(asNormal.skip, /unexplained/);

  const asLeveraged = yahooReturns(chart(series, { adj: series }), { leveraged: true });
  assert.ok(!asLeveraged.skip, "2x 槓桿：+18.75% 是追蹤指數 +9.4% 的兩倍，正常行情");
  assert.equal(asLeveraged.splitsApplied, undefined, "不得誤套用分割校正");
  assert.equal(asLeveraged.priceReturn1y, 20);
});

// 放寬門檻不得讓槓桿標的漏掉真正的分割
test("the wider leveraged band still catches a real split", () => {
  const series = [100, 105, 52.5, 55];   // 1:2 分割
  const out = yahooReturns(chart(series, { adj: series }), { leveraged: true });
  assert.equal(out.splitsApplied, 1);
  assert.ok(out.priceReturn1y > 0, "分割不得被讀成腰斬");
});

test("normal daily moves inside the 10% limit are never treated as splits", () => {
  // 台股漲跌幅 ±10%：連續跌停也不該觸發分割偵測
  const out = yahooReturns(chart([100, 90, 81, 72.9]));
  assert.equal(out.splitsApplied, undefined);
  assert.equal(out.priceReturn1y, -27.1);
});

test("adjclose gaps fall back to price return instead of faking a total return", () => {
  const out = yahooReturns(chart([100, 110, 120], { adj: null }));
  assert.equal(out.priceReturn1y, 20);
  assert.equal(out.totalReturn1y, undefined, "沒有 adjclose 就不得拿 raw 假裝成總報酬");
});

test("a short history is not publishable as a one-year return", () => {
  assert.equal(hasFullYear(yahooReturns(chart([100, 108], { startDays: 200 }))), false);
  assert.equal(hasFullYear(yahooReturns(chart([100, 108], { startDays: 365 }))), true);
  assert.equal(hasFullYear({ skip: "whatever" }), false);
  assert.equal(hasFullYear(null), false);
});
