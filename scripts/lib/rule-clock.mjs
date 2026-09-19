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

export const STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  NOT_YET: "NOT_YET",
  UNKNOWN: "UNKNOWN",
});

// 為什麼是 180 天而不是 90：台股的租稅優惠幾乎都在會期末三讀（12 月底或 5 月底），
// 提前不到一個會期才示警，等於在最後一刻才知道。實例：債券 ETF 停徵在 2026-12-31 落日，
// 而延長案到 2026-09 仍在預告／委員會階段——90 天的門檻會讓這件事直到 10 月才亮燈。
export const EXPIRING_WITHIN_DAYS = 180;

// verified_at 超過這個天數就不算查證過。法規沒變也一樣：沒人回去看過的數字不該被信任。
export const STALE_VERIFICATION_DAYS = 180;

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

export function ruleStatus(rule, onDate, opts = {}) {
  const expiringWithin = opts.expiringWithinDays ?? EXPIRING_WITHIN_DAYS;
  const staleAfter = opts.staleAfterDays ?? STALE_VERIFICATION_DAYS;

  const shape = validateRule(rule);
  if (shape.length) return { status: STATUS.UNKNOWN, reasons: shape, ruleId: rule?.rule_id ?? null };

  const on = parseDate(onDate);
  if (on === null) {
    return { status: STATUS.UNKNOWN, reasons: ["查詢日期格式錯誤"], ruleId: rule.rule_id };
  }

  // 只有已生效的法律進得了解析。提案中／預告中的修正案放在表裡是資訊，不是依據——
  // 「假設會延長」正是這整套規格要擋的那種樂觀。
  if (rule.status !== "in_force") {
    return {
      status: STATUS.UNKNOWN,
      reasons: [`rule.status 是 "${rule.status}"，不是 in_force，不可作為計算依據`],
      ruleId: rule.rule_id,
    };
  }

  const reasons = [];
  const verifiedAgeDays = daysBetween(rule.verified_at, onDate);
  const stale = verifiedAgeDays !== null && verifiedAgeDays > staleAfter;
  if (stale) reasons.push(`verified_at 距今 ${verifiedAgeDays} 天，超過 ${staleAfter} 天，需重新查證`);

  const from = parseDate(rule.effective_from);
  const to = parseDate(rule.effective_to);

  if (from !== null && on < from) {
    return {
      status: STATUS.NOT_YET,
      reasons: [...reasons, `生效日 ${rule.effective_from} 晚於查詢日 ${onDate}`],
      ruleId: rule.rule_id,
      verifiedAgeDays,
    };
  }
  if (to !== null && on > to) {
    return {
      status: STATUS.EXPIRED,
      reasons: [...reasons, `施行期間已於 ${rule.effective_to} 屆滿`],
      ruleId: rule.rule_id,
      verifiedAgeDays,
    };
  }

  const daysLeft = to === null ? null : Math.round((to - on) / DAY_MS);
  if (daysLeft !== null && daysLeft <= expiringWithin) {
    return {
      status: STATUS.EXPIRING,
      reasons: [...reasons, `距施行期間屆滿 ${daysLeft} 天（${rule.effective_to}），延長與否尚未確定`],
      ruleId: rule.rule_id,
      verifiedAgeDays,
      daysLeft,
    };
  }

  return { status: STATUS.ACTIVE, reasons, ruleId: rule.rule_id, verifiedAgeDays, daysLeft };
}

// 解析一筆交易適用的法定稅率。
// 回傳 { ok:false, code } 而不是丟一個預設費率——呼叫端必須顯式處理「不知道」。
export function resolveTax(table, query) {
  const { instrumentType, tradeDate, side = "sell", dayTrade = false } = query ?? {};

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

  const evaluated = candidates.map((rule) => ({ rule, ...ruleStatus(rule, tradeDate) }));
  const usable = evaluated.filter((e) => e.status === STATUS.ACTIVE || e.status === STATUS.EXPIRING);

  if (!usable.length) {
    const worst = evaluated[0];
    return {
      ok: false,
      code: worst.status === STATUS.EXPIRED ? "RULE_EXPIRED" : "RULE_UNRESOLVED",
      reasons: evaluated.flatMap((e) => [`${e.ruleId}: ${e.status}`, ...e.reasons]),
    };
  }
  // 同一個查詢命中兩條都有效的規則＝表本身有矛盾。挑一條來用會安靜地選錯，所以拒絕。
  if (usable.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      reasons: [`${usable.map((e) => e.ruleId).join("、")} 在 ${tradeDate} 同時有效，表有重疊`],
    };
  }

  const hit = usable[0];
  return {
    ok: true,
    rate: hit.rule.rate,
    ruleId: hit.ruleId,
    status: hit.status,
    basis: hit.rule.basis ?? null,
    sourceUrl: hit.rule.source_url,
    warnings: hit.reasons,
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
