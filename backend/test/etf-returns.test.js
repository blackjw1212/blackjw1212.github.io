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

test("an unexplained jump is skipped rather than guessed", () => {
  // 0.6885 不是乾淨的分割比例——用觀測值當係數會把當天最多 10% 的真實漲跌
  // 一起吃進去，讓整段歷史偏移，所以整檔不發布
  const out = yahooReturns(chart([100, 100, 68.85, 70]));
  assert.ok(out.skip, "應該跳過");
  assert.match(out.skip, /unexplained/);
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
