import assert from "node:assert/strict";
import test from "node:test";
import {
  validateTradeLog, validateFinancialData, validateBacktestResult,
  recomputePnl, totalCosts,
} from "../../scripts/lib/fin-contracts.mjs";

// 這兩份 schema 的價值全在兩道定義性檢查上（形狀檢查擋不住「形狀對但數字錯」）：
//   trade-log      → 損益必須能被重算出來
//   financial-data → 任何一列的 as_of 都不得晚於 analysis_time
// 下面每一條都先確認「壞資料真的會紅」，不會咬人的檢查沒有價值。

const AT = "2026-09-19T13:30:00+08:00";

function trade(over = {}) {
  return {
    trade_id: 1, symbol: "2330", side: "long",
    rule_set: { id: "SMC-DISCIPLINE", version: "3.2" },
    entry: { date: "2026-09-15", price: 1085, qty: 1000 },
    exit: { date: "2026-09-18", price: 1102, qty: 1000 },
    costs: { commission_buy: 20, commission_sell: 20, tax: 3306, borrow: 0, other: 0 },
    pnl_net: 13654,
    ...over,
  };
}
const log = (trades) => ({ schema: "trade-log/v1", schema_version: 1, analysis_time: AT, trades });

test("合法的 trade-log 通過", () => {
  assert.deepEqual(validateTradeLog(log([trade()])), { ok: true, trades: 1 });
});

test("損益對不上就整批 INVALID，不得解釋成手續費差異", () => {
  const res = validateTradeLog(log([trade({ pnl_net: 17000 })]));   // 忘了扣成本
  assert.equal(res.ok, false);
  assert.equal(res.code, "TRADE_LOG_INVALID");
  assert.ok(res.errors.some((e) => e.includes("對不上重算值")));
});

test("pnl_net 留 null 是合法的未知，不是錯誤", () => {
  const res = validateTradeLog(log([trade({ pnl_net: null })]));
  assert.equal(res.ok, true, "不知道就留 null——這正是本 repo 對 domesticRatio 的同一條紅線");
  assert.equal(recomputePnl(trade({ pnl_net: null })).net, 13654);
});

test("空方的損益方向相反", () => {
  const short = trade({ side: "short", pnl_net: null });
  assert.equal(recomputePnl(short).gross, -17000);
  const longer = trade({ pnl_net: null });
  assert.equal(recomputePnl(longer).gross, 17000);
});

test("成本欄位未填視為未知，不是 0", () => {
  assert.equal(totalCosts({ commission_buy: 20, tax: null }), 20, "null 跳過");
  assert.equal(totalCosts({ commission_buy: "20" }), null, "非數字整筆判為不可計算");
});

test("缺 rule_set 會紅——否則 06 會把兩套制度下的交易混在一起", () => {
  const { rule_set, ...noRules } = trade();
  const res = validateTradeLog(log([noRules]));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("rule_set")));
});

test("未平倉（exit 為 null）是合法狀態", () => {
  const open = trade({ exit: null, pnl_net: null });
  assert.equal(validateTradeLog(log([open])).ok, true);
  assert.equal(recomputePnl(open), null);
});

test("交易日期晚於 analysis_time 會被抓出來", () => {
  const future = trade({ exit: { date: "2026-09-25", price: 1102, qty: 1000 }, pnl_net: null });
  const res = validateTradeLog(log([future]));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("晚於 analysis_time")));
});

test("analysis_time 必須帶時區", () => {
  const res = validateTradeLog({ ...log([trade()]), analysis_time: "2026-09-19 13:30" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("analysis_time")));
});

// ── financial-data/v1 ─────────────────────────────────────────────

const row = (over = {}) => ({ symbol: "2330", close: 1085, as_of: "2026-09-19T13:30:00+08:00", ...over });
const feed = (rows) => ({
  schema: "financial-data/v1", schema_version: 1, analysis_time: AT,
  source: { name: "TWSE MI_INDEX" }, rows,
});

test("合法的 financial-data 通過", () => {
  assert.deepEqual(validateFinancialData(feed([row()])), { ok: true, rows: 1 });
});

test("未來資料 → DATA_CONTAMINATION，而且優先於其他錯誤", () => {
  const res = validateFinancialData(feed([row({ as_of: "2026-09-19T14:00:00+08:00" })]));
  assert.equal(res.ok, false);
  assert.equal(res.code, "DATA_CONTAMINATION",
    "這是 look-ahead 唯一能在機器端擋掉的地方——模型自己不知道『現在』是幾點");
});

test("缺 as_of 的列會紅：沒有資料時間就無法判斷是否為未來資料", () => {
  const { as_of, ...noStamp } = row();
  const res = validateFinancialData(feed([noStamp]));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("as_of")));
});

test("as_of 可以是日期（當日收盤），以當日最後一刻判定", () => {
  assert.equal(validateFinancialData(feed([row({ as_of: "2026-09-18" })])).ok, true);
  assert.equal(validateFinancialData(feed([row({ as_of: "2026-09-20" })])).code, "DATA_CONTAMINATION");
});

// ── 回測執行證明 ──────────────────────────────────────────────────

const proof = (over = {}) => ({
  execution: {
    data_source: "TWSE MI_INDEX", period_start: "2020-01-02", period_end: "2026-09-18",
    row_count: 1642, code_sha256: "a".repeat(64), executed_at: "2026-09-19T12:00:00+08:00",
  },
  cost_model_covers: [
    "commission", "minimum_commission", "transaction_tax",
    "slippage", "price_limit_fill", "liquidity_cap",
  ],
  ...over,
});

test("有執行痕跡才算回測結果", () => {
  assert.equal(validateBacktestResult(proof()).ok, true);
});

test("沒有 execution 區塊 → NO_EXECUTION_RESULT", () => {
  const res = validateBacktestResult({ win_rate: 0.583, profit_factor: 1.72 });
  assert.equal(res.ok, false);
  assert.equal(res.code, "NO_EXECUTION_RESULT",
    "一組漂亮又自洽的統計數字沒有執行痕跡，就只是一組漂亮又自洽的統計數字");
});

test("執行痕跡缺任一欄都不算", () => {
  for (const f of ["data_source", "period_start", "period_end", "row_count", "code_sha256", "executed_at"]) {
    const p = proof();
    delete p.execution[f];
    assert.equal(validateBacktestResult(p).ok, false, `缺 ${f} 應該要紅`);
  }
});

test("成本模型沒宣告漲跌停成交與最低手續費就不算完整", () => {
  const noLimit = proof({ cost_model_covers: ["commission", "transaction_tax", "slippage"] });
  const res = validateBacktestResult(noLimit);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("price_limit_fill")), "台股漏了漲跌停會系統性高估突破策略");
  assert.ok(res.errors.some((e) => e.includes("minimum_commission")));
});

test("有空方交易時另外要求借券成本與強制回補", () => {
  const withShort = proof({ has_short_trades: true });
  const res = validateBacktestResult(withShort);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("forced_buyin")), "台股融券在除權息與股東會前會被強制回補");
});
