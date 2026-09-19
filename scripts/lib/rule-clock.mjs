// 法定費率的時效解析器。
//
// 要防的不是「稅率會變」，而是「法規版本錯了但程式照跑、結果還很漂亮」。
// 所以這支的設計原則只有一條：**查不到適用規則時丟出 UNKNOWN，絕不回退到預設值。**
// 回退到預設值等於用一個過期稅率算完整份回測，而回測不會 crash、也不會變醜。
// 同 CLAUDE.md 對 geomag.mjs 的要求：不可以用 0 代替未知。
//
// 分工：這張表只收**法定**費率（證交稅）。券商手續費、折讓、最低收費是每個帳戶不同的
// 商業條件，不是法規，必須由呼叫端以參數提供——把 0.1425% 寫進這張表就是把
// 「某些人的費率」偽裝成「法律」。

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// 兩個**不同**的問題，刻意用兩個狀態機，不可以混成一個：
//
//   RULE_STATUS  ── 問「這條規則在交易日當天是否有效？」比的是 trade_date vs 施行期間
//   VERIFY_STATUS ── 問「這條資料多久沒有人回去查證？」比的是 today vs verified_at
//
// 混成一個的後果是「180 天沒人查證」會被讀成「法律已失效」，那是完全不同的處置：
// 前者要人去看一眼，後者要停止計算。這個 repo 昨天的版本就是錯的——它拿
// trade_date 去量 verified_at 的新鮮度，於是回測 2020 年的交易永遠「新鮮」、
// 回測 2028 年的交易永遠「過期」。兩個時鐘混用，而兩者一個都沒量對。
export const RULE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  NOT_YET: "NOT_YET",
  UNKNOWN: "UNKNOWN",
});

export const VERIFY_STATUS = Object.freeze({
  FRESH: "FRESH",
  DUE_SOON: "DUE_SOON",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
});

// 相容別名：舊名指向規則有效性（新鮮度從來不屬於它）。
export const STATUS = RULE_STATUS;

// 為什麼是 180 天而不是 90：台股的租稅優惠幾乎都在會期末三讀（12 月底或 5 月底），
// 提前不到一個會期才示警，等於在最後一刻才知道。實例：債券 ETF 停徵在 2026-12-31 落日，
// 而延長案到 2026-09 仍在預告／委員會階段——90 天的門檻會讓這件事直到 10 月才亮燈。
export const EXPIRING_WITHIN_DAYS = 180;

// verified_at 超過這個天數就不算查證過。法規沒變也一樣：沒人回去看過的數字不該被信任。
// 到期不等於失效——它觸發的是 RULE_REVERIFICATION_REQUIRED，不是 RULE_EXPIRED。
export const STALE_VERIFICATION_DAYS = 180;
// 到期前這麼多天開始提醒，讓複查排得進行程而不是突然擋住計算。
export const VERIFY_DUE_SOON_DAYS = 30;

export function parseDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

export function daysBetween(fromISO, toISO) {
  const a = parseDate(fromISO);
  const b = parseDate(toISO);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

// 規則本身的形狀檢查。缺任何一個欄位都回 UNKNOWN 而不是「當作沒有期限」——
// 沒寫 effective_to 與「永久有效」是兩件事，混在一起就是這支工具存在的理由。
export function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== "object") return ["規則不是物件"];
  if (!rule.rule_id) errors.push("缺 rule_id");
  if (!rule.instrument_type) errors.push("缺 instrument_type");
  if (typeof rule.rate !== "number" || !Number.isFinite(rule.rate)) errors.push("rate 不是有限數字");
  if (rule.rate < 0 || rule.rate > 1) errors.push("rate 應為小數比率（0.003 而非 0.3）");
  if (!("effective_from" in rule)) errors.push("缺 effective_from（不確定就寫 null，不要省略）");
  if (!("effective_to" in rule)) errors.push("缺 effective_to（永久有效就寫 null，不要省略）");
  if (rule.effective_from !== null && !parseDate(rule.effective_from)) errors.push("effective_from 日期格式錯誤");
  if (rule.effective_to !== null && !parseDate(rule.effective_to)) errors.push("effective_to 日期格式錯誤");
  if (!parseDate(rule.verified_at)) errors.push("缺 verified_at 或格式錯誤");
  if (!rule.source_url) errors.push("缺 source_url");
  if (!rule.status) errors.push("缺 status");
  const from = parseDate(rule.effective_from);
  const to = parseDate(rule.effective_to);
  if (from !== null && to !== null && to < from) errors.push("effective_to 早於 effective_from");
  return errors;
}

// 只問有效性：trade_date 落在施行期間裡嗎？完全不看 verified_at。
export function ruleValidity(rule, tradeDate, opts = {}) {
  const expiringWithin = opts.expiringWithinDays ?? EXPIRING_WITHIN_DAYS;

  const shape = validateRule(rule);
  if (shape.length) return { status: RULE_STATUS.UNKNOWN, reasons: shape, ruleId: rule?.rule_id ?? null };

  const on = parseDate(tradeDate);
  if (on === null) return { status: RULE_STATUS.UNKNOWN, reasons: ["交易日期格式錯誤"], ruleId: rule.rule_id };

  // 只有已生效的法律進得了解析。提案中／預告中的修正案放在表裡是資訊，不是依據——
  // 「假設會延長」正是這整套規格要擋的那種樂觀。
  if (rule.status !== "in_force") {
    return {
      status: RULE_STATUS.UNKNOWN,
      reasons: [`rule.status 是 "${rule.status}"，不是 in_force，不可作為計算依據`],
      ruleId: rule.rule_id,
    };
  }

  const from = parseDate(rule.effective_from);
  const to = parseDate(rule.effective_to);

  if (from !== null && on < from) {
    return {
      status: RULE_STATUS.NOT_YET,
      reasons: [`生效日 ${rule.effective_from} 晚於交易日 ${tradeDate}`],
      ruleId: rule.rule_id,
    };
  }
  if (to !== null && on > to) {
    return {
      status: RULE_STATUS.EXPIRED,
      reasons: [`施行期間已於 ${rule.effective_to} 屆滿`],
      ruleId: rule.rule_id,
    };
  }
  const daysLeft = to === null ? null : Math.round((to - on) / DAY_MS);
  if (daysLeft !== null && daysLeft <= expiringWithin) {
    return {
      status: RULE_STATUS.EXPIRING,
      reasons: [`距施行期間屆滿 ${daysLeft} 天（${rule.effective_to}），延長與否尚未確定`],
      ruleId: rule.rule_id,
      daysLeft,
    };
  }
  return { status: RULE_STATUS.ACTIVE, reasons: [], ruleId: rule.rule_id, daysLeft };
}

// 只問新鮮度：距今多久沒人回去看過？完全不看 trade_date。
// today 必須顯式傳入才有決定性；省略時取系統當日（正式流程應該一律傳）。
export function verificationStatus(rule, today, opts = {}) {
  const staleAfter = opts.staleAfterDays ?? STALE_VERIFICATION_DAYS;
  const dueSoon = opts.dueSoonDays ?? VERIFY_DUE_SOON_DAYS;
  const now = today ?? new Date().toISOString().slice(0, 10);

  const verifiedAt = parseDate(rule?.verified_at);
  if (verifiedAt === null || parseDate(now) === null) {
    return { status: VERIFY_STATUS.UNKNOWN, reasons: ["缺 verified_at 或查詢日格式錯誤"], verifiedAt: rule?.verified_at ?? null };
  }
  const ageDays = daysBetween(rule.verified_at, now);
  const dueDate = new Date(verifiedAt + staleAfter * DAY_MS).toISOString().slice(0, 10);

  if (ageDays > staleAfter) {
    return {
      status: VERIFY_STATUS.STALE,
      reasons: [`verified_at ${rule.verified_at} 距今 ${ageDays} 天，超過 ${staleAfter} 天，需重新人工查證`],
      verifiedAt: rule.verified_at, verificationDue: dueDate, ageDays,
    };
  }
  if (ageDays > staleAfter - dueSoon) {
    return {
      status: VERIFY_STATUS.DUE_SOON,
      reasons: [`複查期限 ${dueDate}，還剩 ${staleAfter - ageDays} 天`],
      verifiedAt: rule.verified_at, verificationDue: dueDate, ageDays,
    };
  }
  return { status: VERIFY_STATUS.FRESH, reasons: [], verifiedAt: rule.verified_at, verificationDue: dueDate, ageDays };
}

// 兩者合併回報。刻意回兩個欄位而不是一個綜合狀態——呼叫端要能分別處置。
export function ruleStatus(rule, tradeDate, opts = {}) {
  const validity = ruleValidity(rule, tradeDate, opts);
  const verify = verificationStatus(rule, opts.today, opts);
  return {
    rule_status: validity.status,
    verification_status: verify.status,
    ruleId: validity.ruleId,
    verified_at: verify.verifiedAt,
    verification_due: verify.verificationDue ?? null,
    daysLeft: validity.daysLeft ?? null,
    reasons: [...validity.reasons, ...verify.reasons],
  };
}

// 解析一筆交易適用的法定稅率。
// 回傳 { ok:false, code } 而不是丟一個預設費率——呼叫端必須顯式處理「不知道」。
export function resolveTax(table, query) {
  const {
    instrumentType, tradeDate, side = "sell", dayTrade = false,
    today = null, allowStale = false,
  } = query ?? {};

  if (!table || !Array.isArray(table.rules)) {
    return { ok: false, code: "TABLE_INVALID", reasons: ["費率表缺 rules 陣列"] };
  }
  if (!parseDate(tradeDate)) {
    return { ok: false, code: "BAD_QUERY", reasons: ["tradeDate 格式錯誤"] };
  }
  // 這張表只查證過某個區間。更早的交易不是「適用同一費率」，是「本表沒查過」。
  if (table.coverage_from && parseDate(tradeDate) < parseDate(table.coverage_from)) {
    return {
      ok: false,
      code: "OUT_OF_COVERAGE",
      reasons: [`本表只查證 ${table.coverage_from} 之後；${tradeDate} 不在涵蓋範圍`],
    };
  }

  const kind = dayTrade ? "day_trade" : "regular";
  const candidates = table.rules.filter(
    (r) =>
      r.instrument_type === instrumentType &&
      (r.side ?? "sell") === side &&
      (r.trade_kind ?? "regular") === kind,
  );

  if (!candidates.length) {
    return {
      ok: false,
      code: "NO_RULE",
      reasons: [`表中沒有 ${instrumentType}／${kind}／${side} 的規則`],
    };
  }

  const evaluated = candidates.map((rule) => ({ rule, validity: ruleValidity(rule, tradeDate) }));
  const usable = evaluated.filter(
    (e) => e.validity.status === RULE_STATUS.ACTIVE || e.validity.status === RULE_STATUS.EXPIRING,
  );

  if (!usable.length) {
    const expired = evaluated.some((e) => e.validity.status === RULE_STATUS.EXPIRED);
    return {
      ok: false,
      code: expired ? "RULE_EXPIRED" : "RULE_UNRESOLVED",
      reasons: evaluated.flatMap((e) => [`${e.validity.ruleId}: ${e.validity.status}`, ...e.validity.reasons]),
    };
  }
  // 同一個查詢命中兩條都有效的規則＝表本身有矛盾。挑一條來用會安靜地選錯，所以拒絕。
  if (usable.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      reasons: [`${usable.map((e) => e.validity.ruleId).join("、")} 在 ${tradeDate} 同時有效，表有重疊`],
    };
  }

  const hit = usable[0];
  // 新鮮度是獨立的一關，對的是 today 不是 tradeDate。
  // 沒人查證過的費率不該被安靜地用掉——但那是「去看一眼」，不是「法律失效」，
  // 所以回的是 RULE_REVERIFICATION_REQUIRED 而不是 RULE_EXPIRED。
  const verify = verificationStatus(hit.rule, today);
  if (verify.status === VERIFY_STATUS.STALE && !allowStale) {
    return {
      ok: false,
      code: "RULE_REVERIFICATION_REQUIRED",
      rule_status: hit.validity.status,
      verification_status: verify.status,
      verification_due: verify.verificationDue,
      reasons: [...verify.reasons, `（法規本身在 ${tradeDate} 仍為 ${hit.validity.status}，這不是失效）`],
    };
  }

  return {
    ok: true,
    rate: hit.rule.rate,
    ruleId: hit.validity.ruleId,
    rule_status: hit.validity.status,
    verification_status: verify.status,
    verified_at: verify.verifiedAt,
    verification_due: verify.verificationDue ?? null,
    basis: hit.rule.basis ?? null,
    sourceUrl: hit.rule.source_url,
    warnings: [...hit.validity.reasons, ...verify.reasons],
  };
}

// 手續費：法定的只有「超過 0.1425% 要事前通知」這個上限概念，實收由券商自訂、可折讓、
// 且有最低收費。所以這裡不查表，全部由呼叫端給——但最低收費的觸發要被記錄下來，
// 因為小額交易的實質費率會被它整個改寫（1 萬元 6 折名目 8.55 元 → 實收 20 元 ＝ 0.2%）。
export function commission(tradeValue, params) {
  const { rate, discount = 1, minimum = 0, round = Math.floor } = params ?? {};
  if (typeof tradeValue !== "number" || !Number.isFinite(tradeValue) || tradeValue < 0) {
    return { ok: false, code: "BAD_QUERY", reasons: ["tradeValue 不是非負有限數字"] };
  }
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return { ok: false, code: "BAD_QUERY", reasons: ["缺手續費率（這是券商條件，不可由本模組預設）"] };
  }
  const nominal = round(tradeValue * rate * discount);
  const charged = Math.max(nominal, minimum);
  return {
    ok: true,
    nominal,
    charged,
    minimumApplied: charged > nominal,
    extraFromMinimum: charged - nominal,
    effectiveRate: tradeValue > 0 ? charged / tradeValue : null,
  };
}
