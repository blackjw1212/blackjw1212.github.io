// 股數變動事件（配股、面額變更、減資）對 data/market-52w.json 月桶的還原。
//
// 月桶存的是成交價。股數一變，事件日之前的價格就跟之後不在同一個基準上：
// 實測 2026-10-19，緯穎 6669 於 9/2 除權（約買 1 張配近 2 張），月桶仍保留除權前的
// 7,800，畫面上「距一年高 −75.8%」，還原後約 −34%。現金股利**不還原**（使用者
// 2026-10-19 決定）：「距一年高」維持看實際成交價，只修股數變動造成的假斷崖。
//
// 三個要點，每一條都是實測踩到的：
//   1. **事件當月要用日資料重算**，不能整桶乘比例。月桶把同月除權前後混在一起
//      （6669 的 9 月是 [7800, 2075]），整桶 ×0.335 會把低點壓成 696。
//   2. **回填（seed-market-52w.mjs，2026-07-27）用的 Yahoo 日線已經依股數調整過**
//      （6944 兆聯 6 月原始高點 1,115、存檔 857.69＝×0.769）。回填前的事件不可以再把
//      更早的月份乘一次；但事件當月仍要重算——7780 的 1 月存檔是 192／18.15，那一桶本身就壞了。
//   3. **已套用的事件記在存檔的 adjusted 裡**，重跑不會重複乘；日資料抓不到就整筆不動、
//      下一班再試——只還原一半比不還原更糟。
//
// 這個檔不 import update-market-feed.mjs（那邊會 import 這邊），日期小工具自己帶。

const SOURCE_URLS = {
  twseExRights: (from, to) => `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${ymd(from)}&endDate=${ymd(to)}&response=json`,
  twsePar: (from, to) => `https://www.twse.com.tw/rwd/zh/change/TWTB8U?startDate=${ymd(from)}&endDate=${ymd(to)}&response=json`,
  twseReduction: (from, to) => `https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=${ymd(from)}&endDate=${ymd(to)}&response=json`,
  tpexExRights: (from, to) => `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${slash(from)}&endDate=${slash(to)}&response=json`,
  tpexReduction: (from, to) => `https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?startDate=${slash(from)}&endDate=${slash(to)}&response=json`,
  // 上櫃的面額變更表找不到端點（2026-10-19 試過 parValueChange／parvalchg 都 302）——
  // 這一類目前不涵蓋，揭露句寫明。
  twseDaily: (code, month) => `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month.replace("-", "")}01&stockNo=${code}&response=json`,
  tpexDaily: (code, month) => `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${month.replace("-", "%2F")}%2F01&response=json`,
};

function ymd(iso) { return iso.replace(/-/g, ""); }
function slash(iso) { return iso.replace(/-/g, "%2F"); }
function monthOf(iso) { return String(iso || "").slice(0, 7); }
function round2(value) { return Math.round(value * 100) / 100; }
function num(value) {
  const n = Number(String(value == null ? "" : value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
function key(event) { return `${event.code}@${event.date}`; }
// 日資料去哪個市場抓，由事件的來源決定，不看 feed 的 market 欄位：實測 8908 欣雄在 feed
// 標成上市，日資料卻只在櫃買；3085 新零售不在 feed 裡，查不到市場就一直待補
const SOURCE_MARKET = { TWT49U: "twse", TWTB8U: "twse", TWTAUU: "twse", exDailyQ: "tpex", revivt: "tpex" };

// 上游四種寫法：「115年09月02日」「114/11/17」「115/9/1」「1150630」
export function rocDateToIso(value) {
  const text = String(value == null ? "" : value).trim();
  let match = text.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/) || text.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) {
    const compact = text.match(/^(\d{3})(\d{2})(\d{2})$/);
    if (!compact) return null;
    match = compact;
  }
  const [, y, m, d] = match;
  return `${Number(y) + 1911}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// 比例要像一次真的股數變動：太接近 1 是雜訊，超出 0.01–100 是解析壞掉
export function validFactor(factor) {
  return Number.isFinite(factor) && factor > 0.01 && factor < 100 && Math.abs(factor - 1) >= 0.001;
}

// TWSE 的 rwd 端點忙碌時回 200 ＋ stat 文字，不是 HTTP 錯誤。
// 把它當成「沒有事件」會讓那一班靜靜地漏掉，所以要丟出來。
function twseTable(payload) {
  // 「很抱歉，沒有符合條件的資料!」是那段期間沒有事件，不是失敗——回補預演時把它當錯誤，
  // 13 個月裡有 5 個月的減資表因此被報成錯誤，CI 每班都會多出假紅字
  if (payload && /沒有符合條件/.test(String(payload.stat || ""))) return { fields: [], rows: [] };
  if (!payload || payload.stat !== "OK") throw new Error(`TWSE: ${(payload && payload.stat) || "empty response"}`);
  const fields = (payload.fields || []).map((f) => String(f).replace(/\s+/g, ""));
  return { fields, rows: payload.data || [] };
}
function tpexTable(payload) {
  const table = payload && Array.isArray(payload.tables) ? payload.tables[0] : null;
  if (!table) throw new Error("TPEX: no table in response");
  return { fields: (table.fields || []).map((f) => String(f).replace(/\s+/g, "")), rows: table.data || [] };
}
function pick(fields, row, name) {
  const index = fields.indexOf(name);
  return index < 0 ? null : row[index];
}

// 上市除權結果表：只取含「權」的列（純「息」是現金股利，不還原）。
// 「權息」同日證交所只給合計，整筆照參考價還原（會順帶還原那一小段現金，揭露句寫明）。
export function parseTwseExRights(payload) {
  const { fields, rows } = twseTable(payload);
  const out = [];
  for (const row of rows) {
    const type = String(pick(fields, row, "權/息") || "");
    if (!type.includes("權")) continue;
    const before = num(pick(fields, row, "除權息前收盤價"));
    const ref = num(pick(fields, row, "除權息參考價"));
    const date = rocDateToIso(pick(fields, row, "資料日期"));
    if (!(before > 0) || !(ref > 0) || !date) continue;
    out.push({ code: String(pick(fields, row, "股票代號")).trim(), date, kind: "stock", factor: ref / before, source: "TWT49U" });
  }
  return out;
}

// 上市面額變更（TWTB8U）與減資（TWTAUU）：停止買賣前收盤 → 恢復買賣參考價
export function parseTwseResumption(payload, kind) {
  const { fields, rows } = twseTable(payload);
  const out = [];
  for (const row of rows) {
    const before = num(pick(fields, row, "停止買賣前收盤價格"));
    const ref = num(pick(fields, row, "恢復買賣參考價"));
    const date = rocDateToIso(pick(fields, row, "恢復買賣日期"));
    if (!(before > 0) || !(ref > 0) || !date) continue;
    out.push({ code: String(pick(fields, row, "股票代號")).trim(), date, kind, factor: ref / before, source: kind === "par" ? "TWTB8U" : "TWTAUU" });
  }
  return out;
}

// 上櫃除權結果表有拆開的現金股利與每仟股配股，所以比例只取配股那段：1 ÷ (1 + 配股率)。
// 寫入前用定義檢查把關：參考價 ＝ (前收 − 現金) ÷ (1 + 配股率)。對不起來（例：同時有
// 現金增資）就整筆退回，不猜比例——同稅務那邊「累進差額在級距交界處必須相等」的做法。
export const TPEX_IDENTITY_TOLERANCE = 0.005;
export function parseTpexExRights(payload) {
  const { fields, rows } = tpexTable(payload);
  const events = [];
  const rejected = [];
  for (const row of rows) {
    const type = String(pick(fields, row, "權/息") || "");
    if (!type.includes("權")) continue;
    const code = String(pick(fields, row, "代號")).trim();
    const date = rocDateToIso(pick(fields, row, "除權息日期"));
    const before = num(pick(fields, row, "除權息前收盤價"));
    const ref = num(pick(fields, row, "除權息參考價"));
    const cash = num(pick(fields, row, "現金股利")) || 0;
    const perThousand = num(pick(fields, row, "每仟股無償配股")) || 0;
    if (!date || !(before > 0) || !(ref > 0) || !(perThousand > 0)) continue;
    const ratio = perThousand / 1000;
    const predicted = (before - cash) / (1 + ratio);
    if (Math.abs(predicted - ref) / ref > TPEX_IDENTITY_TOLERANCE) {
      rejected.push({ code, date, reason: `參考價 ${ref} 與 (前收 ${before} − 現金 ${cash}) ÷ (1 + ${ratio}) = ${predicted.toFixed(2)} 對不起來` });
      continue;
    }
    events.push({ code, date, kind: "stock", factor: 1 / (1 + ratio), source: "exDailyQ" });
  }
  return { events, rejected };
}

// 上櫃減資（revivt）：日期是 1150630 這種緊湊民國日
export function parseTpexReduction(payload) {
  const { fields, rows } = tpexTable(payload);
  const out = [];
  for (const row of rows) {
    const before = num(pick(fields, row, "最後交易日之收盤價格"));
    const ref = num(pick(fields, row, "減資恢復買賣開始日參考價格"));
    const date = rocDateToIso(pick(fields, row, "恢復買賣日期"));
    if (!(before > 0) || !(ref > 0) || !date) continue;
    out.push({ code: String(pick(fields, row, "股票代號")).trim(), date, kind: "reduction", factor: ref / before, source: "revivt" });
  }
  return out;
}

// 個股日資料（兩個市場）。查無資料時兩邊都回非 OK／空表，這裡回空陣列——
// 呼叫端看到空的就把事件留到下一班，不會套一半。
export function parseDailyRows(payload) {
  let table;
  try {
    table = payload && Array.isArray(payload.tables) ? tpexTable(payload) : twseTable(payload);
  } catch {
    return [];
  }
  const { fields, rows } = table;
  // 上櫃的欄位是「日 期」，twseTable／tpexTable 已經去掉空白，兩邊都是「日期」
  const dateField = "日期";
  const hiField = fields.includes("最高價") ? "最高價" : "最高";
  const loField = fields.includes("最低價") ? "最低價" : "最低";
  const out = [];
  for (const row of rows) {
    const date = rocDateToIso(pick(fields, row, dateField));
    const high = num(pick(fields, row, hiField));
    const low = num(pick(fields, row, loField));
    // 0 是「當天沒成交」不是價格（同 accumulate52w 的規則）
    if (!date || !(high > 0) || !(low > 0)) continue;
    out.push({ date, high, low });
  }
  return out;
}

function eligible(event, store, tradeDate) {
  return event && validFactor(event.factor) && event.date && event.date <= tradeDate;
}

// 還沒套用、而且事件當月在窗口內有月桶的事件，要先抓那一個月的日資料
export function neededDaily(accumulator, events, { floorMonth, tradeDate }) {
  const store = (accumulator && accumulator.stocks) || {};
  const done = (accumulator && accumulator.adjusted) || {};
  const seen = new Set();
  const out = [];
  for (const event of events || []) {
    if (!eligible(event, store, tradeDate) || done[key(event)]) continue;
    const entry = store[event.code];
    const month = monthOf(event.date);
    if (!entry || !entry.m || !entry.m[month] || month < floorMonth) continue;
    const id = `${event.code}@${month}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ code: event.code, month, market: SOURCE_MARKET[event.source] || null });
  }
  return out;
}

// dailyByKey：{ "代碼@YYYY-MM": [{date, high, low}] }
// 回傳的 accumulator 是新物件（不改傳入的那份），applied／pending 是事件鍵。
export function applyCorporateActions(accumulator, events, dailyByKey, { floorMonth, tradeDate }) {
  const src = accumulator && typeof accumulator === "object" ? accumulator : {};
  const acc = JSON.parse(JSON.stringify(src));
  const store = acc.stocks || (acc.stocks = {});
  const adjusted = acc.adjusted || (acc.adjusted = {});
  const seededThrough = acc.seededThrough || "";
  const daily = dailyByKey || {};
  const applied = [];
  const pending = [];

  // 同一檔的全部有效事件（含本班之前已套用、已不在本班視窗裡的）——重算事件當月時，
  // 每一天要乘上「在它之後發生的事件」的比例
  const valid = (events || []).filter((e) => eligible(e, store, tradeDate))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.code.localeCompare(b.code)));

  for (const event of valid) {
    const id = key(event);
    if (adjusted[id]) continue;
    const entry = store[event.code];
    const month = monthOf(event.date);
    const record = { f: event.factor, k: event.kind };
    if (!entry || !entry.m) { adjusted[id] = record; applied.push(id); continue; }

    const needsDaily = Boolean(entry.m[month]) && month >= floorMonth;
    const days = daily[`${event.code}@${month}`];
    if (needsDaily && !(Array.isArray(days) && days.length)) { pending.push(id); continue; }

    // 回填已經依股數調整過的事件：更早的月份不動
    const absorbedBySeed = Boolean(entry.seeded) && seededThrough && event.date <= seededThrough;
    if (!absorbedBySeed) {
      for (const m of Object.keys(entry.m)) {
        if (m >= month) continue;
        const [hi, lo] = entry.m[m];
        entry.m[m] = [round2(hi * event.factor), round2(lo * event.factor)];
      }
    }
    adjusted[id] = record;
    applied.push(id);

    if (needsDaily) {
      // 這一天之後發生的事件：已套用的、本筆，以及（回填過的股票）回填前的事件——
      // 最後那一類 Yahoo 已經算進更早的月份裡，但這裡的日資料是原始價，要自己乘
      const later = [];
      for (const [k, v] of Object.entries(adjusted)) {
        const [code, date] = k.split("@");
        if (code === event.code) later.push({ date, f: v.f });
      }
      if (entry.seeded && seededThrough) {
        for (const e of valid) {
          if (e.code === event.code && e.date <= seededThrough && !adjusted[key(e)]) later.push({ date: e.date, f: e.factor });
        }
      }
      let hi = null;
      let lo = null;
      for (const day of days) {
        const mult = later.reduce((product, e) => (e.date > day.date ? product * e.f : product), 1);
        const h = day.high * mult;
        const l = day.low * mult;
        if (hi == null || h > hi) hi = h;
        if (lo == null || l < lo) lo = l;
      }
      entry.m[month] = [round2(hi), round2(lo)];
    }
  }

  pruneAdjusted(acc, floorMonth);
  return { accumulator: acc, applied, pending };
}

// 窗口外的紀錄可以丟：事件只影響它之前的日子，事件月早於保留界線就不會再碰到任何月桶
export function pruneAdjusted(accumulator, floorMonth) {
  if (!accumulator || !accumulator.adjusted || !floorMonth) return;
  for (const k of Object.keys(accumulator.adjusted)) {
    if (monthOf(k.split("@")[1]) < floorMonth) delete accumulator.adjusted[k];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 抓事件 → 抓需要的日資料 → 套用。任何一步失敗都只記進 errors，不丟出去：
// 還原是加分項，不可以讓整份 feed 因為除權表抓不到而停更。
// marketOf(code) 回 "twse"／"tpex"；fetchJson 由呼叫端注入（沿用 feed 那支的重試）。
export async function fetchCorporateActionEvents(fromDate, toDate, { fetchJson, delayMs = 2500 }) {
  const errors = [];
  const events = [];
  const rejected = [];
  const sources = [
    ["TWT49U", () => fetchJson(SOURCE_URLS.twseExRights(fromDate, toDate)).then(parseTwseExRights)],
    ["TWTB8U", () => fetchJson(SOURCE_URLS.twsePar(fromDate, toDate)).then((p) => parseTwseResumption(p, "par"))],
    ["TWTAUU", () => fetchJson(SOURCE_URLS.twseReduction(fromDate, toDate)).then((p) => parseTwseResumption(p, "reduction"))],
    ["exDailyQ", () => fetchJson(SOURCE_URLS.tpexExRights(fromDate, toDate)).then((p) => {
      const parsed = parseTpexExRights(p);
      rejected.push(...parsed.rejected);
      return parsed.events;
    })],
    ["revivt", () => fetchJson(SOURCE_URLS.tpexReduction(fromDate, toDate)).then(parseTpexReduction)],
  ];
  for (const [name, run] of sources) {
    try {
      events.push(...await run());
    } catch (error) {
      errors.push({ source: "corporate-actions", message: `${name} ${fromDate}~${toDate}: ${error.message}` });
    }
    await sleep(delayMs);
  }
  return { events, rejected, errors };
}

export async function syncCorporateActions(accumulator, { fromDate, tradeDate, floorMonth, marketOf, fetchJson, delayMs = 2500, prefetched = null }) {
  const fetched = prefetched || await fetchCorporateActionEvents(fromDate, tradeDate, { fetchJson, delayMs });
  const errors = [...fetched.errors];
  const events = fetched.events;
  const rejected = fetched.rejected;

  const dailyByKey = {};
  for (const need of neededDaily(accumulator, events, { floorMonth, tradeDate })) {
    const market = need.market || (marketOf ? marketOf(need.code) : null);
    if (market !== "twse" && market !== "tpex") continue;
    const url = market === "twse" ? SOURCE_URLS.twseDaily(need.code, need.month) : SOURCE_URLS.tpexDaily(need.code, need.month);
    try {
      dailyByKey[`${need.code}@${need.month}`] = parseDailyRows(await fetchJson(url));
    } catch (error) {
      errors.push({ source: "corporate-actions", message: `daily ${need.code} ${need.month}: ${error.message}` });
    }
    await sleep(delayMs);
  }

  const result = applyCorporateActions(accumulator, events, dailyByKey, { floorMonth, tradeDate });
  if (result.pending.length) {
    errors.push({ source: "corporate-actions", message: `${result.pending.length} share event(s) waiting for daily data: ${result.pending.slice(0, 8).join(", ")}` });
  }
  for (const r of rejected.slice(0, 5)) errors.push({ source: "corporate-actions", message: `rejected ${r.code} ${r.date}: ${r.reason}` });
  return { ...result, events, rejected, errors };
}
