// 資料契約：trade-log/v1（07 產出 → 06 消化）與 financial-data/v1（餵給模型的市場資料）。
//
// 這兩份 schema 的重點不是型別，是**兩道定義性檢查**——形狀對但內容錯的檔案照樣會被
// 當成真的（同 CLAUDE.md 對稅務級距「累進差額在交界處必須相等」與 /float/
// 「loadFromShot 必須等於同名咬鉛」的要求）：
//
//   1. trade-log：損益必須能由 進出場 × 數量 − 成本 重算出來。對不上 = INVALID，
//      整批停止行為分析。不可以解釋成「大概是手續費差異」。
//   2. financial-data：任何一列的 as_of 晚於 analysis_time = DATA_CONTAMINATION。
//      這是 look-ahead 唯一能在機器端擋掉的地方——模型自己驗不了這件事，
//      因為它不知道「現在」是什麼時候。
//
// as_of 與 analysis_time 是兩個不同的東西，刻意分開：
//   analysis_time = 這次分析站在哪個時間點（每份文件一個）
//   as_of         = 這筆資料截至哪個時間點（每一列一個）

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

export const SIDES = new Set(["long", "short"]);

// 損益比對的容差（元）。手續費是逐筆無條件捨去到元，兩邊的捨去時機可能差一塊。
// 刻意訂得很小：容差放寬到百元就等於這道閘門不存在。
export const PNL_TOLERANCE_TWD = 2;

function isTimestamp(v) { return typeof v === "string" && TS.test(v); }
function isDate(v) { return typeof v === "string" && DATE.test(v); }
function num(v) { return typeof v === "number" && Number.isFinite(v); }

function tsValue(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// trade-log/v1 的 costs 只有這五欄。把「總成本」定義成固定欄位的加總，
// 就必須同時拒絕欄位外的東西——否則多寫一個 slippage_est: 500 會被靜默吞掉，
// 總成本一毛都不變，而 pnl_net 留 null 時沒有任何人會發現那 500 不見了。
// 實測 2026-09-20 就是這樣：{...,slippage_est:500} 與不帶它算出同一個 3346。
export const COST_FIELDS = Object.freeze(["commission_buy", "commission_sell", "tax", "borrow", "other"]);

export function totalCosts(costs) {
  if (!costs || typeof costs !== "object") return null;
  for (const k of Object.keys(costs)) {
    if (!COST_FIELDS.includes(k)) return null;     // 認不得的成本欄位 → 整筆不可計算
  }
  let sum = 0;
  for (const k of COST_FIELDS) {
    const v = costs[k];
    if (v === undefined || v === null) continue;   // 未填 = 未知，不是 0
    if (!num(v)) return null;
    sum += v;
  }
  return sum;
}

// 定義性檢查 ①：由進出場重算損益。
// exit 為 null（未平倉）時回 null——那不是錯誤，是「還沒有損益可言」。
export function recomputePnl(trade) {
  if (!trade || !trade.entry || !trade.exit) return null;
  const { entry, exit, side } = trade;
  if (!num(entry.price) || !num(exit.price) || !num(entry.qty)) return null;
  if (!SIDES.has(side)) return null;
  const qty = Math.min(entry.qty, num(exit.qty) ? exit.qty : entry.qty);
  const gross = side === "long"
    ? (exit.price - entry.price) * qty
    : (entry.price - exit.price) * qty;
  const costs = totalCosts(trade.costs);
  if (costs === null) return { gross, costs: null, net: null };
  return { gross, costs, net: gross - costs };
}

function validateTrade(trade, index, opts) {
  const errs = [];
  const at = (m) => `trades[${index}] ${m}`;

  if (!num(trade.trade_id)) errs.push(at("缺 trade_id"));
  if (!trade.symbol) errs.push(at("缺 symbol"));
  if (!SIDES.has(trade.side)) errs.push(at(`side 必須是 long 或 short，收到 ${JSON.stringify(trade.side)}`));
  if (!trade.rule_set || !trade.rule_set.id || !trade.rule_set.version) {
    // 沒有規則版本，06 就會把兩套不同制度下的交易混在一起分析，而那會安靜地污染結論。
    errs.push(at("缺 rule_set{id,version}——不知道當時照哪一版規則交易，行為分析無效"));
  }
  for (const leg of ["entry", "exit"]) {
    const L = trade[leg];
    if (L === null && leg === "exit") continue;      // 未平倉是合法狀態
    if (!L || typeof L !== "object") { errs.push(at(`缺 ${leg}`)); continue; }
    if (!isDate(L.date)) errs.push(at(`${leg}.date 需為 YYYY-MM-DD`));
    if (!num(L.price)) errs.push(at(`${leg}.price 需為數字`));
    if (leg === "entry" && !num(L.qty)) errs.push(at("entry.qty 需為數字"));
  }
  if (trade.entry && trade.exit && isDate(trade.entry.date) && isDate(trade.exit.date)) {
    if (trade.exit.date < trade.entry.date) errs.push(at("exit.date 早於 entry.date"));
  }
  if (!trade.costs || typeof trade.costs !== "object") {
    errs.push(at("缺 costs——沒有成本的損益不是損益"));
  } else if (totalCosts(trade.costs) === null) {
    const unknown = Object.keys(trade.costs).filter((k) => !COST_FIELDS.includes(k));
    errs.push(at(unknown.length
      ? `costs 含 trade-log/v1 沒有的欄位：${unknown.join("、")}（合法欄位：${COST_FIELDS.join("、")}）`
      : "costs 含非數字欄位"));
  }

  // 定義性檢查：使用者填的 pnl_net 必須等於重算值。
  // pnl_net 為 null 不是錯誤（= 未知，由本模組算出來）；填了而對不上才是。
  const re = recomputePnl(trade);
  if (re && re.net !== null && trade.pnl_net !== null && trade.pnl_net !== undefined) {
    if (!num(trade.pnl_net)) {
      errs.push(at("pnl_net 不是數字"));
    } else if (Math.abs(trade.pnl_net - re.net) > (opts?.pnlTolerance ?? PNL_TOLERANCE_TWD)) {
      errs.push(at(
        `pnl_net 對不上重算值：填 ${trade.pnl_net}，由 entry/exit/qty/costs 重算為 ${re.net}` +
        `（差 ${Math.round((trade.pnl_net - re.net) * 100) / 100}）`,
      ));
    }
  }
  return errs;
}

export function validateTradeLog(doc, opts = {}) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, code: "TRADE_LOG_INVALID", errors: ["文件不是物件"] };
  }
  if (doc.schema !== "trade-log/v1") errors.push(`schema 必須是 "trade-log/v1"，收到 ${JSON.stringify(doc.schema)}`);
  if (doc.schema_version !== 1) errors.push("schema_version 必須是 1");
  if (!isTimestamp(doc.analysis_time)) errors.push("analysis_time 需為含時區的 ISO 8601");
  if (!Array.isArray(doc.trades)) {
    errors.push("缺 trades 陣列");
    return { ok: false, code: "TRADE_LOG_INVALID", errors };
  }
  doc.trades.forEach((t, i) => errors.push(...validateTrade(t, i, opts)));

  // 交易日期不得晚於分析時間點：同一個 look-ahead 問題的日誌版本。
  const at = tsValue(doc.analysis_time);
  if (at !== null) {
    doc.trades.forEach((t, i) => {
      for (const leg of ["entry", "exit"]) {
        const d = t?.[leg]?.date;
        if (isDate(d) && Date.parse(`${d}T00:00:00Z`) > at) {
          errors.push(`trades[${i}].${leg}.date (${d}) 晚於 analysis_time`);
        }
      }
    });
  }
  return errors.length
    ? { ok: false, code: "TRADE_LOG_INVALID", errors }
    : { ok: true, trades: doc.trades.length };
}

export function validateFinancialData(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, code: "DATA_INVALID", errors: ["文件不是物件"] };
  }
  if (doc.schema !== "financial-data/v1") errors.push(`schema 必須是 "financial-data/v1"`);
  if (doc.schema_version !== 1) errors.push("schema_version 必須是 1");
  if (!isTimestamp(doc.analysis_time)) errors.push("analysis_time 需為含時區的 ISO 8601");
  if (!doc.source || !doc.source.name) errors.push("缺 source.name");
  if (!Array.isArray(doc.rows)) {
    errors.push("缺 rows 陣列");
    return { ok: false, code: "DATA_INVALID", errors };
  }

  const at = tsValue(doc.analysis_time);
  const contaminated = [];
  doc.rows.forEach((row, i) => {
    if (!row || typeof row !== "object") { errors.push(`rows[${i}] 不是物件`); return; }
    const stamp = row.as_of;
    if (!isTimestamp(stamp) && !isDate(stamp)) {
      errors.push(`rows[${i}] 缺 as_of——沒有資料時間就無法判斷是否為未來資料`);
      return;
    }
    if (at === null) return;
    const rowAt = isDate(stamp) ? Date.parse(`${stamp}T23:59:59Z`) : tsValue(stamp);
    if (rowAt !== null && rowAt > at) contaminated.push(`rows[${i}] as_of=${stamp}`);
  });

  // 污染優先於其他錯誤回報：這一類不該被「順便修一下」，整份必須退回。
  if (contaminated.length) {
    return {
      ok: false,
      code: "DATA_CONTAMINATION",
      errors: [
        `${contaminated.length} 列的 as_of 晚於 analysis_time (${doc.analysis_time})`,
        ...contaminated.slice(0, 10),
      ],
    };
  }
  return errors.length ? { ok: false, code: "DATA_INVALID", errors } : { ok: true, rows: doc.rows.length };
}

// 回測結果的執行證明。
// 「沒有執行就不得聲稱回測結果」要能被機器判定，就得要求結果自帶執行痕跡：
// 資料來源、期間、列數、程式雜湊、執行時間。缺任一項 → NO_EXECUTION_RESULT。
// 這擋不了刻意偽造，但擋得住「模型順手把一組漂亮數字寫成回測結果」——那才是實際會發生的事。
// 與 scripts/lib/fill-model.mjs 的 FILL 常數對應。這兩個狀態代表「日 K 證明不了成交」，
// 它們永遠不可以進 filled_qty、成交筆數、已實現損益、勝率或獲利因子。
export const MUST_EXCLUDE_FROM_REALIZED = Object.freeze([
  "price_reachable_but_execution_unknown",
  "unknown_insufficient_data",
]);

export const EXECUTION_PROOF_FIELDS = ["data_source", "period_start", "period_end", "row_count", "code_sha256", "executed_at"];

export function validateBacktestResult(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, code: "NO_EXECUTION_RESULT", errors: ["文件不是物件"] };
  }
  const proof = doc.execution;
  if (!proof || typeof proof !== "object") {
    return { ok: false, code: "NO_EXECUTION_RESULT", errors: ["缺 execution 區塊——沒有執行痕跡的績效數字不是回測結果"] };
  }
  for (const f of EXECUTION_PROOF_FIELDS) {
    if (proof[f] === undefined || proof[f] === null || proof[f] === "") errors.push(`execution 缺 ${f}`);
  }
  if (num(proof.row_count) && proof.row_count <= 0) errors.push("execution.row_count 必須大於 0");

  // 成本模型必須明確宣告它處理了什麼。沒宣告的項目一律視為「沒處理」，
  // 而台股的前三項（漲跌停、最低手續費、強制回補）漏掉就會系統性高估績效。
  const declared = new Set(Array.isArray(doc.cost_model_covers) ? doc.cost_model_covers : []);
  const required = ["commission", "minimum_commission", "transaction_tax", "slippage", "price_limit_fill", "liquidity_cap"];
  if (doc.has_short_trades) required.push("borrow_cost", "forced_buyin");
  const missing = required.filter((k) => !declared.has(k));
  if (missing.length) errors.push(`cost_model_covers 未宣告：${missing.join("、")}`);

  // 成交狀態未定的訊號不得混進已實現績效。這件事只靠提示詞講會被忽略，
  // 所以要求結果自己宣告排除了哪些 fill 狀態——沒宣告就當作沒排除。
  const excluded = new Set(doc.fill_accounting?.excluded_from_realized ?? []);
  for (const state of MUST_EXCLUDE_FROM_REALIZED) {
    if (!excluded.has(state)) {
      errors.push(`fill_accounting.excluded_from_realized 未排除 ${state}——把成交未定的訊號算進勝率與損益，就是用未知換來的漂亮數字`);
    }
  }

  if (errors.length) return { ok: false, code: "NO_EXECUTION_RESULT", errors };
  return { ok: true, executedAt: proof.executed_at };
}
