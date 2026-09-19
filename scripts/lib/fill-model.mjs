// 漲跌停下的成交判定。
//
// 這支的存在理由是一句話：**日 K 能證明價格條件，證明不了成交。**
//
// 日 K 有五個欄位。它可以證明「當日價格是否曾離開漲停」，但證明不了
// 委託是什麼時候送出的、送出時是否已進入撮合、排隊順位排不排得到、
// 要的股數是不是全部成交。所以「open == limit_up 且 low < limit_up」
// 這種情況不可以寫成 filled——那會在回測裡多蓋一層精緻的錯覺。
//
// 三層，前兩層由資料判定，第三層必須由使用者明示假設才存在：
//
//   全日鎖死（high == low == 停板）      → 資料證明不可成交
//   曾離開停板（open == 停板，low < 停板）→ 價格可達，成交狀態未知
//   部分成交／排隊順位                    → 日 K 沒有這個資訊，只能是 [情境]
//
// 第三層的 filled_qty 必須帶推導式與參與率，而參與率是假設不是資料。
// 沒有明示假設時本模組**不會**生出任何股數——憑空的 filled_qty 正是
// 這整套規格要擋的那種「看起來精準的連續數值」。

export const FILL = Object.freeze({
  FILLED: "filled",
  BLOCKED: "blocked_limit_locked",
  PRICE_REACHABLE: "price_reachable_but_execution_unknown",
  ASSUMED: "assumed_filled",
  UNKNOWN: "unknown_insufficient_data",
});

const num = (v) => typeof v === "number" && Number.isFinite(v);

// 買進的不利方向是漲停，賣出是跌停。台股停板為前一日收盤 ±10%，
// 但本模組不自己算——由資料帶進來，因為停板價有除權息調整與新股上市等例外，
// 自己算會在那些日子安靜地算錯。
function adverseLimit(bar, side) {
  return side === "buy" ? bar.limit_up : bar.limit_down;
}

export function classifyFill(bar, side, opts = {}) {
  if (!bar || typeof bar !== "object" || (side !== "buy" && side !== "sell")) {
    return { fill: FILL.UNKNOWN, reason: "缺 bar 或 side 不是 buy/sell" };
  }
  for (const f of ["open", "high", "low", "close"]) {
    if (!num(bar[f])) return { fill: FILL.UNKNOWN, reason: `bar 缺 ${f}` };
  }
  const limit = adverseLimit(bar, side);
  if (!num(limit)) {
    // 沒有停板價就不知道有沒有碰到停板。當成「正常成交」是樂觀推定，不允許。
    return { fill: FILL.UNKNOWN, reason: `缺 ${side === "buy" ? "limit_up" : "limit_down"}，無法判斷是否觸及停板` };
  }

  const touched = side === "buy" ? bar.high >= limit : bar.low <= limit;
  if (!touched) {
    return { fill: FILL.FILLED, price: { value: bar.open, class: "原始資料", basis: "當日開盤價，未觸及停板" } };
  }

  const locked = bar.high === bar.low && bar.high === limit;
  if (locked) {
    return {
      fill: FILL.BLOCKED,
      reason: `全日維持${side === "buy" ? "漲" : "跌"}停鎖死（high == low == ${limit}）`,
      price: null,
    };
  }

  // 價格曾離開停板：價格條件可行，成交狀態未知。這是本模組最重要的一格。
  const base = {
    fill: FILL.PRICE_REACHABLE,
    price: {
      value: limit,
      class: "計算值",
      basis: `當日曾離開停板；成交價只能取停板價 ${limit}（當日最不利價），不得取開盤後的任何中間價`,
    },
    execution: {
      status: "未知",
      reason: "僅有日 K，無委託時間、委託簿深度與撮合順位，無法判定是否成交",
    },
  };

  const a = opts.assumption;
  if (!a) return base;

  // 使用者明示選擇情境假設之後，才升格成 assumed_filled。
  // 參與率是假設不是資料，所以整塊帶 class:"情境" 與推導式。
  if (!num(a.participationRate) || a.participationRate <= 0 || a.participationRate > 1) {
    return { ...base, execution: { ...base.execution, reason: "assumption.participationRate 需為 (0,1] 的數字" } };
  }
  if (!num(bar.volume)) {
    return { ...base, execution: { ...base.execution, reason: "bar 缺 volume，參與率假設無從套用" } };
  }
  if (!num(opts.requestedQty)) {
    return { ...base, execution: { ...base.execution, reason: "缺 requestedQty" } };
  }

  const cap = Math.floor(bar.volume * a.participationRate);
  const filled = Math.min(opts.requestedQty, cap);
  return {
    fill: FILL.ASSUMED,
    price: base.price,
    execution: {
      status: "assumed_filled",
      class: "情境",
      assumption: a.basis ?? "價格曾離開停板，假設委託可在停板價成交",
      requested_qty: opts.requestedQty,
      filled_qty: filled,
      derivation: `min(${opts.requestedQty}, volume ${bar.volume} × participation_rate ${a.participationRate}) = ${filled}`,
      participation_rate: { value: a.participationRate, class: "情境", basis: a.rateBasis ?? "無委託簿資料，由使用者指定" },
    },
  };
}

// 整批統計：回測報告必須說出有多少訊號其實不知道成不成交。
// 把 PRICE_REACHABLE 混進 filled 計算績效，就是用未知換來的漂亮數字。
export function summariseFills(results) {
  const counts = Object.fromEntries(Object.values(FILL).map((k) => [k, 0]));
  for (const r of results) counts[r.fill] = (counts[r.fill] ?? 0) + 1;
  const total = results.length;
  const undetermined = counts[FILL.PRICE_REACHABLE] + counts[FILL.UNKNOWN];
  return {
    total,
    counts,
    undetermined,
    undeterminedRatio: total ? undetermined / total : null,
    assumed: counts[FILL.ASSUMED],
  };
}
