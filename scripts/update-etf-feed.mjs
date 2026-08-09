// ETF 每日資料引擎（/market/ 二期）。
// 來源：MIS all_etf.txt（淨值/折溢價/流通單位，實測 350 檔含上櫃債券 ETF）
//     + TWSE/TPEX bulk 00* 價格（可經 --bulk <path> 重用 market 引擎落下的 payload）
//     + TWSE rwd etfDiv（配息公告；僅涵蓋上市 ETF，上櫃配息無公開端點→人工補充）。
// 設計要點（經交叉審查 v2）：
// - ETF 代碼含字母後綴（00679B/00631L/00632R/00635U），用獨立正則，不沿用個股的 /^\d{4}$/
// - 折溢價以 (close-nav)/nav 自算，MIS 的 g 欄僅作 sanity check；日期不一致或差 >0.5pp 即不輸出
// - nav/折溢價/配息逐欄保留：單一來源故障只讓該欄沿用前次值，不整批歸零
// - 現金流看「發放月」不是除息月；配息輸出實際每股序列 dps[{m,a}]，不用 yield 回推
// - 配息歷史累積於 data/etf-div-history.json（13 個月窗 + lastSeen 剪枝）；
//   歷史覆蓋 <12 個月時 yield 輸出 null（首跑 etfDiv 只有當年度，實測約 8 個月）
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { field, parseNumber, roundNumber } from "./update-stock-risk-feed.mjs";
import { rocToIso, monthKey, normalizeMiIndex } from "./update-market-feed.mjs";

const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const HISTORY_FILE = new URL("../data/etf-div-history.json", import.meta.url);
const STATIC_FILE = new URL("../data/etf-static.json", import.meta.url);
const HOLDINGS_FILE = new URL("../data/etf-holdings.json", import.meta.url);
// 近一年總報酬（update-etf-returns.mjs 產出）。配置產生器要以「最終賺多少」
// 為目標就需要價差那一半——feed 自己只有配息。
const RETURNS_FILE = new URL("../data/etf-returns.json", import.meta.url);
// 個股 → 產業別（update-industry-map.mjs 產出）。topHoldings 只有名稱與權重，
// 沒有這張表就算不出「看起來分散、實際上全押同一個產業」。
const INDUSTRY_FILE = new URL("../data/industry-map.json", import.meta.url);

const SOURCES = {
  // 上市收盤主來源必須是 MI_INDEX。openapi 的 STOCK_DAY_ALL 當日不發佈——
  // 實測 2026-08-06 台灣 22:15（收盤後 8.75 小時）仍只有 08-05 的資料，
  // 於是 232 檔上市 ETF 顯示昨收、116 檔上櫃顯示今收，價格比券商帳面舊一天
  // （00631L 本站 34.15 vs MIS 今收 33.85）。market-feed 早就改用 MI_INDEX，
  // 這支一直沒跟上。STOCK_DAY_ALL 保留為 fallback：TWSE 曾對 runner IP 回 HTML 錯誤頁。
  twseEodFast: "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?type=ALLBUT0999&response=json",
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  allEtf: "https://mis.twse.com.tw/stock/data/all_etf.txt",
  etfDiv: "https://www.twse.com.tw/rwd/zh/ETF/etfDiv?response=json",
  // etfDiv 只涵蓋 95 檔上市 ETF，上櫃是 0 檔（實測 2026-07-30：feed 內 116 檔上櫃 ETF
  // 在 etfDiv 一筆都查不到）。上櫃的官方配息只能從除權除息預告表拿，該表有現金股利
  // 金額但沒有發放日，需以量到的 ex→pay 中位間隔推估。
  tpexExright: "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost",
};

// 285 筆官方事件實測：ex→pay 中位 24 天（四分位 23–27、全距 17–36）。
// 只在來源沒有發放日時使用，並標記 payEstimated 讓畫面說得出來。
export const MEDIAN_EX_TO_PAY_DAYS = 24;

// 配息歷史保留 25 個月，讓波動度能看兩個完整年度（比 CV 窗多 1 個月當緩衝）。
// 原本是 13 個月，於是季配標的的 CV 只用 4 筆算——實測那會系統性低估波動：
// 89 檔母體中「12 月窗過關但 24 月窗不過」有 6 檔，反向（被短窗誤殺）0 檔，
// 短窗從來不會誤殺，只會藏。例：006208 配息 0.989→3.448→4.75，
// cv12 僅 0.16 而 cv24 是 0.65；00888 從 0.22 漲到 1.753，cv12 0.54 / cv24 0.89。
// 這種水準跳升對「以近 12 月配息推估未來年配息」正是最該被標出來的風險。
export const DIV_RETENTION_MONTHS = 25;
export const CV_WINDOW_MONTHS = 24;

export const ETF_CODE_RE = /^00\d{2,4}[A-Z]?$/;
const PREMIUM_SANITY_PP = 0.5;

const BROWSER_HEADERS = {
  Accept: "*/*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Referer: "https://www.twse.com.tw/",
};

// 與 update-market-feed 相同的重試策略（TPEX 在 runner 上常見連線中斷）
export async function fetchJson(url, attempt = 1, maxAttempt = 3, baseDelayMs = 800) {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", ...BROWSER_HEADERS } });
    if (response.status >= 400 && response.status < 500) {
      throw Object.assign(new Error(`${url} returned HTTP ${response.status}`), { fatal: true });
    }
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.fatal || attempt >= maxAttempt) throw error;
    await new Promise((resolve) => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)));
    return fetchJson(url, attempt + 1, maxAttempt, baseDelayMs);
  }
}

async function fetchText(url) {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.text();
}

// 「115年08月11日」→ "2026-08-11"。獨立於 rocToIso（純數字版被既有測試鎖定，不動）。
export function rocTextToIso(value) {
  const match = String(value == null ? "" : value).trim().match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
}

// 上市收盤有兩種 payload：MI_INDEX 是物件（{stat, tables:[…]}），
// STOCK_DAY_ALL 是陣列。normalizeMiIndex 吐出的列已經是 Code/ClosingPrice 相容形狀，
// 所以在這裡統一成陣列即可，下游不必為來源開特例。
// 原本只認陣列，於是 market-feed --emit-bulk 落下的 MI_INDEX 物件會直接拋
// 「bulk payload is not an array」，CI 靜靜退回自己抓 STOCK_DAY_ALL 的昨收。
export function toBulkRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return normalizeMiIndex(payload).rows;
  return payload;
}

// 前十大成分股的產業分佈。
//
// 誠實揭露是這個欄位的重點，不是附註：
//   coveredWeight  = 前十大權重合計（通常 60~80%，不是 100%）
//   matchedWeight  = 其中比對得到產業別的權重
//   比對不到的（海外持股、帶星號的簡稱、名稱不一致）獨立成「未分類」，
//   **絕不併進其他產業、也絕不當成 0**——那會讓集中度看起來比實際低。
export function deriveSectorMix(topHoldings, byName) {
  const holdings = Array.isArray(topHoldings) ? topHoldings : [];
  if (!holdings.length) return null;
  const map = byName && typeof byName === "object" ? byName : {};
  const acc = {};
  let covered = 0;
  let matched = 0;
  let unclassified = 0;
  for (const h of holdings) {
    const weight = Number(h && h.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    covered += weight;
    // MoneyDJ 的簡稱偶爾帶星號（國巨*）等標記，去掉再比一次
    const raw = String((h && h.name) || "").trim();
    const industry = map[raw] || map[raw.replace(/[*＊\s]/g, "")] || null;
    if (industry) {
      acc[industry] = (acc[industry] || 0) + weight;
      matched += weight;
    } else {
      unclassified += weight;
    }
  }
  if (!(covered > 0)) return null;
  // 取兩位小數：部分 ETF 的成分股權重本來就很小（實測 00728 台積電 0.26%），
  // 只留一位會把它們捨成 0，產生「權重 0 的產業」這種沒有意義的列。
  const round = (v) => Math.round(v * 100) / 100;
  const sectors = Object.keys(acc)
    .map((name) => ({ name, weight: round(acc[name]) }))
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  return {
    sectors,
    coveredWeight: round(covered),
    matchedWeight: round(matched),
    unclassifiedWeight: round(unclassified),
  };
}

// bulk（TWSE MI_INDEX / STOCK_DAY_ALL、TPEX daily close）→ ETF 價格列
export function normalizeEtfBulkRows(rows, market) {
  if (!Array.isArray(rows)) throw new Error(`${market} bulk payload is not an array`);
  const out = [];
  for (const row of rows) {
    const code = String(field(row, ["Code", "SecuritiesCompanyCode", "code"]) || "").trim().toUpperCase();
    if (!ETF_CODE_RE.test(code)) continue;
    const close = parseNumber(field(row, ["ClosingPrice", "Close", "close"]));
    // 收盤 0 代表當日無成交（實測 00682U、00707R 等冷門期貨/反向 ETF），
    // 不是有效價格：會讓折溢價算成 -100%、股數計算除以零，直接排除。
    if (close == null || !(close > 0)) continue;
    const entry = {
      code,
      name: String(field(row, ["Name", "CompanyName", "name"]) || "").trim(),
      market,
      close: roundNumber(close, 2),
      change: roundNumber(parseNumber(field(row, ["Change", "change"])), 2),
    };
    const volume = parseNumber(field(row, ["TradeVolume", "TradingShares", "volume"]));
    if (volume != null) entry.volume = Math.round(volume);
    const date = rocToIso(field(row, ["Date", "date"]));
    if (date) entry.date = date;
    out.push(entry);
  }
  return out;
}

// MIS all_etf.txt → { code: { nav, price, premiumOfficial, units, date } }
export function normalizeAllEtf(payload) {
  const groups = payload && typeof payload === "object" ? Object.values(payload) : [];
  const out = {};
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const block of group) {
      for (const row of (block && block.msgArray) || []) {
        const code = String(row.a || "").trim().toUpperCase();
        if (!ETF_CODE_RE.test(code)) continue;
        const nav = parseNumber(row.f);
        if (nav == null || nav <= 0) continue;
        out[code] = {
          nav: roundNumber(nav, 4),
          price: parseNumber(row.e),
          premiumOfficial: parseNumber(row.g),
          units: parseNumber(row.c),
          date: rocToIsoOrPlain(row.i),
        };
      }
    }
  }
  return out;
}

function rocToIsoOrPlain(value) {
  const digits = String(value == null ? "" : value).trim();
  if (/^\d{8}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return rocToIso(digits);
}

// etfDiv rows（j.data 陣列列）→ 配息事件 [{code, ex, pay, dps}]
export function normalizeEtfDivRows(data) {
  if (!Array.isArray(data)) throw new Error("etfDiv payload has no data array");
  const out = [];
  for (const row of data) {
    const code = String((row && row[0]) || "").trim().toUpperCase();
    if (!ETF_CODE_RE.test(code)) continue;
    const ex = rocTextToIso(row[2]);
    const pay = rocTextToIso(row[4]);
    const dps = parseNumber(row[5]);
    if (!ex || dps == null || dps <= 0) continue;
    out.push({ code, ex, pay: pay || ex, dps: roundNumber(dps, 4) });
  }
  return out;
}

export function addDays(isoDate, days) {
  const date = new Date(isoDate + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// 上櫃除權除息預告表 → 配息事件。只收「息」（除權沒有現金流）、只收 ETF 代號。
// 該表沒有發放日欄位，以中位間隔推估並標記 payEstimated。
export function normalizeTpexExrightRows(rows) {
  if (!Array.isArray(rows)) throw new Error("tpex exright payload is not an array");
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = String(row.SecuritiesCompanyCode || "").trim().toUpperCase();
    if (!ETF_CODE_RE.test(code)) continue;
    // 「除權」「除權息」也可能出現；只有現金股利部分算配息，除權沒有現金流
    if (!/息/.test(String(row.ExRrightsExDividend || ""))) continue;
    const ex = rocToIsoOrPlain(row.ExRrightsExDividendDate);
    const dps = parseNumber(row.CashDividend);
    if (!ex || dps == null || dps <= 0) continue;
    out.push({
      code,
      ex,
      pay: addDays(ex, MEDIAN_EX_TO_PAY_DAYS) || ex,
      dps: roundNumber(dps, 4),
      payEstimated: true,
      src: "tpex-exright",
    });
  }
  return out;
}

// 同一次配息在不同來源之間可能差 1 天，只比對完全相同的日期會把同一筆算兩次
// （實測 00917 官方 01-19 / Yahoo 01-20，3.5 元灌成 7 元、殖利率爆成 29.66%）。
// 合法 ETF 不可能 7 天內配息兩次，故以 ±7 天視為同一事件。
export const DEDUPE_WINDOW_DAYS = 7;

export function findNearbyEx(events, ex, windowDays = DEDUPE_WINDOW_DAYS) {
  const target = new Date(ex + "T00:00:00Z").getTime();
  if (Number.isNaN(target)) return null;
  for (const existing of Object.keys(events || {})) {
    const diff = Math.abs(new Date(existing + "T00:00:00Z").getTime() - target) / 86400000;
    if (diff <= windowDays) return existing;
  }
  return null;
}

// 來源可信度。低分不得覆蓋高分的既有事件，同分則保留先到者（避免每天互相蓋來蓋去）。
//   3 官方金額 + 官方發放日（TWSE etfDiv）
//   2 官方金額 + 推估發放日（除權除息預告表；該表沒有發放日欄位）
//   1 第三方（Yahoo 回填）—— 金額實測與官方一致，但仍應讓交易所自己的數字優先
export function srcRank(event) {
  if (!event) return 0;
  if (event.src === "yahoo") return 1;
  return event.payEstimated ? 2 : 3;
}

// 配息歷史累積：events 以除息日為 key（冪等），13 個月窗 + lastSeen 剪枝
export function accumulateDivHistory(history, events, universeCodes, tradeDate) {
  const acc = history && typeof history === "object" ? history : {};
  const store = acc.stocks && typeof acc.stocks === "object" ? acc.stocks : {};
  const cutoff = new Date(tradeDate + "T00:00:00Z");
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DIV_RETENTION_MONTHS);
  const minDate = cutoff.toISOString().slice(0, 10);

  let earliest = acc.start || null;
  for (const event of events) {
    const entry = store[event.code] || (store[event.code] = { events: {} });
    const incoming = { pay: event.pay, dps: event.dps };
    if (event.payEstimated) incoming.payEstimated = true;
    if (event.src) incoming.src = event.src;
    // ±7 天內已有同一次配息 → 只有在新來源可信度更高時才取代（並沿用原本的日期 key，
    // 避免同一筆配息以兩個相鄰日期各存一份而被重複計入殖利率）
    const nearby = findNearbyEx(entry.events, event.ex);
    if (nearby) {
      if (srcRank(incoming) > srcRank(entry.events[nearby])) {
        delete entry.events[nearby];
        entry.events[event.ex] = incoming;
      }
    } else {
      entry.events[event.ex] = incoming;
    }
    if (!earliest || event.ex < earliest) earliest = event.ex; // 覆蓋起點取最早事件，不是累積檔建立日
  }
  const universe = new Set(universeCodes);
  for (const code of Object.keys(store)) {
    const entry = store[code];
    for (const ex of Object.keys(entry.events)) if (ex < minDate) delete entry.events[ex];
    if (universe.has(code)) entry.lastSeen = tradeDate;
  }
  const staleCutoff = new Date(tradeDate + "T00:00:00Z");
  staleCutoff.setUTCDate(staleCutoff.getUTCDate() - 60);
  const staleIso = staleCutoff.toISOString().slice(0, 10);
  for (const code of Object.keys(store)) {
    if ((store[code].lastSeen || "") < staleIso) delete store[code];
  }
  return { start: earliest || tradeDate, stocks: store };
}

// 該檔自身的配息歷史可回溯到哪一天。coverFrom 由回填工具寫入（Yahoo 2 年區間的
// 最早事件，即使之後被 13 個月窗剪掉也保留），沒有就退回目前最早的事件日。
// 不可用全域 history.start：那是所有 ETF 的最早事件，會讓新上市 ETF 也宣稱有滿年歷史。
export function coverageStart(entry) {
  if (!entry) return null;
  if (entry.coverFrom) return entry.coverFrom;
  const keys = Object.keys(entry.events || {}).sort();
  return keys.length ? keys[0] : null;
}

// 由歷史推導：dps 事件（近12月，發放月）、頻率、覆蓋月數、近12月合計
export function deriveDividend(entry, historyStart, tradeDate) {
  if (!entry || !entry.events) return null;
  const yearAgo = new Date(tradeDate + "T00:00:00Z");
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const minIso = yearAgo.toISOString().slice(0, 10);
  const events = Object.entries(entry.events)
    .filter(([ex]) => ex >= minIso && ex <= tradeDate)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!events.length) return null;

  const dps = events.map(([, e]) => ({ m: Number(String(e.pay).slice(5, 7)), a: e.dps }));
  const total = roundNumber(events.reduce((sum, [, e]) => sum + e.dps, 0), 4);
  const count = events.length;
  // 頻率用事件「間距」推，不用筆數——歷史窗不足 12 個月時筆數會把季配誤判成半年配
  let frequency = null;
  if (count >= 2) {
    const gaps = [];
    for (let index = 1; index < events.length; index += 1) {
      gaps.push((new Date(events[index][0]) - new Date(events[index - 1][0])) / 86400000);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    frequency = median <= 45 ? "月配" : median <= 135 ? "季配" : median <= 270 ? "半年配" : "年配";
  }

  const startMonth = monthKey(coverageStart(entry) || historyStart || tradeDate);
  const nowMonth = monthKey(tradeDate);
  const covered = Math.min(12, (Number(nowMonth.slice(0, 4)) - Number(startMonth.slice(0, 4))) * 12
    + (Number(nowMonth.slice(5, 7)) - Number(startMonth.slice(5, 7))) + 1);
  return { dps, totalDps: total, count, frequency, divMonthsCovered: Math.max(1, covered) };
}

// 波動度用的事件金額：取近 CV_WINDOW_MONTHS 個月，而不是殖利率用的近 12 月。
// 殖利率必須是滾動 12 月（那是「一年能領多少」的定義），但波動度用 12 月只有 4 筆，
// 看不出水準跳升；兩者刻意用不同窗，欄位標題也分別標明。
export function cvWindowAmounts(entry, tradeDate, months = CV_WINDOW_MONTHS) {
  if (!entry || !entry.events) return [];
  const from = new Date(tradeDate + "T00:00:00Z");
  if (Number.isNaN(from.getTime())) return [];
  from.setUTCMonth(from.getUTCMonth() - months);
  const minIso = from.toISOString().slice(0, 10);
  return Object.entries(entry.events)
    .filter(([ex]) => ex >= minIso && ex <= tradeDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => ({ a: e.dps }));
}

// 配息變異係數 = 標準差 / 平均。少於 2 筆無從判斷，回 null。
// 與 market/index.html 的 dividendCv() 同一套規則，並由測試互驗兩者一致。
export function dividendCv(dps) {
  const values = (Array.isArray(dps) ? dps : [])
    .map((event) => Number(event && event.a))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!(mean > 0)) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return roundNumber(Math.sqrt(variance) / mean, 2);
}

// 年化推估：給「有配息但歷史未滿一年」的標的一個可揭露的參考值。
// 嚴格條件避免亂外推：需 ≥2 筆（頻率可判）且覆蓋 ≥6 個月。
// 完全無配息紀錄者（槓反/期貨/不配息型，實測 142 檔）恆回 null——填值等於造假。
// 這個值只供畫面揭露，最佳化器與現金流試算一律只吃嚴格的 yield。
export function estimateYield(row) {
  if (!row || !Array.isArray(row.dps) || row.dps.length < 2) return null;
  const months = Number(row.divMonthsCovered);
  if (!Number.isFinite(months) || months < 6) return null;
  if (!(row.close > 0)) return null;
  const realised = row.dps.reduce((sum, event) => sum + (Number(event.a) || 0), 0);
  if (!(realised > 0)) return null;
  return roundNumber(realised / row.close * 100 * (12 / Math.min(12, months)), 2);
}

// 核心＝大型、低配息、非債券的股票型 ETF。刻意不看 type：全 350 檔僅 2 檔被標
// 「市值型」（classifyEtf 預設回主題型），改用客觀的規模與殖利率判定；
// 排除債券型是必要的，否則長天期債 ETF 會頂替掉 0050 這類真正的核心。
export function isCoreEtf(row) {
  // 主動型永不擔任核心：即使規模與殖利率都符合（00403A 1,526億、00981A 2,485億
  // 都夠大），經理人風險與較高費用率不適合當作被動核心部位
  if (isActiveEtf(row)) return false;
  // 槓反（每日重設的路徑依賴）、期貨（轉倉成本）、外幣計價（流動性低）同樣不能當核心。
  // 原本只排除債券型，這三類是靠「沒有配息紀錄所以 yield 為 null」意外被擋住的——
  // 00631L 規模 2,188億，只要哪天配一次息就會被標成核心。
  const NON_CORE = new Set(["債券型", "槓桿反向", "期貨型", "外幣計價"]);
  return Boolean(row && row.aum >= 1000 && row.yield != null && row.yield <= 4.5 && !NON_CORE.has(row.type));
}

// 名稱規則粗分（etf-static 可覆寫）
// 主動型：代碼 A/D 結尾或名稱以「主動」起首。獨立於 type 判斷，因為部分
// 主動式債券 ETF（如 00981D 主動中信非投等債）會被歸為債券型，
// 但仍需標記為主動管理——經理人風險與費用率差異必須可辨識。
export function isActiveEtf(row) {
  if (!row) return false;
  const code = String(row.code || "").toUpperCase();
  const name = String(row.name || "");
  return /[AD]$/.test(code) || /^主動/.test(name);
}

// 分類順序由具體到一般。三個關鍵順序：
// 1. 外幣計價最先——它是同一標的的外幣交易版，規模與流動性和本國版天差地遠
// 2. 債券型排在主動型之前——00981D 主動中信非投等債同時符合兩者，
//    其配息行為由債券性質主導，歸債券型較貼近實際
// 3. 高股息排在主題型之前（現行行為，不動）
export function classifyEtf(code, name) {
  const text = String(name || "");
  const id = String(code || "").toUpperCase();
  if (/[KC]$/.test(id) || /\+R|\+U|\+櫃/.test(text)) return "外幣計價";
  if (/[LR]$/.test(id) || /正2|反1|槓桿|反向/.test(text)) return "槓桿反向";
  if (/U$/.test(id) || /期貨/.test(text)) return "期貨型";
  if (/T$/.test(id) || /^平衡/.test(text)) return "平衡型";
  if (/債/.test(text) || /IG|投等|非投等|公司債|金融債/.test(text)) return "債券型";
  if (/[AD]$/.test(id) || /^主動/.test(text)) return "主動型";
  if (/高股息|高息|優息|股利|存股/.test(text)) return "高股息";
  return "主題型";
}

// 逐市場保留：原本只在「兩市場都一列沒抓到」時才回退，導致 TWSE 成功而 TPEX 中斷時
// 上櫃 ETF 整批消失（實測 2026-07-28 由 348 檔掉到 231 檔）。改為各市場獨立判斷，
// 比照個股引擎的 preserveMarketRows；ETF 母數小（上櫃約百檔），絕對下限取 5。
export function preserveEtfMarketRows(previousStocks, fetchedRows, market) {
  const prev = (Array.isArray(previousStocks) ? previousStocks : [])
    .filter((row) => row && row.market === market)
    .map((row) => ({ code: row.code, name: row.name, market: row.market, close: row.close, change: row.change, volume: row.volume }));
  const fetched = Array.isArray(fetchedRows) ? fetchedRows : [];
  if (fetched.length >= Math.max(5, prev.length * 0.5)) return { rows: fetched, preserved: false };
  if (!prev.length) return { rows: fetched, preserved: false };
  return { rows: prev, preserved: true };
}

// 收益分配通知書的所得類別 → 應稅（國內來源）佔比。
// 只有 54C 國內股利與 5A 國內利息課綜所稅；71 海外所得走最低稅負制、
// 76W 財產交易所得與收益平準金免稅。金額用「每受益權單位」或總額都可以，
// 因為算的是比例。任一期都填同一份 composition 即可——組成逐期會變，
// 所以 asOf 一定要記，讓人知道這份數字是哪一次配息的。
const TAXABLE_CATEGORIES = ["54C", "5A"];
export function domesticRatioFromComposition(composition) {
  if (!composition || typeof composition !== "object") return null;
  const entries = Object.entries(composition)
    .filter(([key, value]) => key !== "asOf" && key !== "note" && Number.isFinite(Number(value)));
  if (!entries.length) return null;
  let taxable = 0;
  let total = 0;
  for (const [key, value] of entries) {
    const amount = Number(value);
    if (amount < 0) return null;                       // 負數＝填錯，寧可不用也不要算出假比例
    total += amount;
    if (TAXABLE_CATEGORIES.includes(key.toUpperCase())) taxable += amount;
  }
  if (!(total > 0)) return null;
  const ratio = Math.round(taxable / total * 10000) / 10000;
  const parts = entries.map(([key, value]) => `${key} ${value}`).join("、");
  // 0.1+0.2 那類浮點殘留會讓依據文字出現 1.2000000000000002，看起來像資料髒掉
  const tidy = (value) => Math.round(value * 10000) / 10000;
  return {
    ratio,
    basis: `依收益分配通知書：${parts}；應稅（54C＋5A）${tidy(taxable)} ÷ 合計 ${tidy(total)} = ${(ratio * 100).toFixed(2)}%`
      + (composition.asOf ? `。配息期別 ${composition.asOf}。` : "。"),
  };
}

// 逐欄保留：本次缺料的欄位沿用前次值（回傳保留計數）
export function preserveEtfColumns(row, previous) {
  if (!previous) return 0;
  let preserved = 0;
  for (const key of ["nav", "discountPremium", "aum"]) {
    if (row[key] == null && previous[key] != null) {
      row[key] = previous[key];
      preserved += 1;
    }
  }
  return preserved;
}

async function readJsonOr(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const now = new Date().toISOString();
  const errors = [];
  const previousFeed = await readJsonOr(FEED_FILE, {});
  const prevByCode = {};
  for (const row of Array.isArray(previousFeed.stocks) ? previousFeed.stocks : []) prevByCode[row.code] = row;

  // 1) bulk 價格（優先吃 --bulk 落檔，缺哪個補抓哪個）
  const bulkIndex = process.argv.indexOf("--bulk");
  const bulkPath = bulkIndex >= 0 ? process.argv[bulkIndex + 1] : null;
  let bulkRaw = { twse: null, tpex: null };
  if (bulkPath) {
    const cached = await readJsonOr(pathToFileURL(bulkPath), null);
    if (cached) bulkRaw = cached;
  }
  let rows = [];
  for (const [key, source, label] of [["twse", SOURCES.twseEod, "TWSE OpenAPI STOCK_DAY_ALL"], ["tpex", SOURCES.tpexEod, "TPEX OpenAPI daily close quotes"]]) {
    let fetched = [];
    try {
      let payload = bulkRaw[key] ? toBulkRows(bulkRaw[key]) : null;
      // 上市沒有 bulk 就自己抓：先 MI_INDEX（當日就有），失敗才退回 STOCK_DAY_ALL（可能舊一天）
      if (!payload && key === "twse") {
        try {
          payload = toBulkRows(await fetchJson(SOURCES.twseEodFast));
          if (!Array.isArray(payload) || !payload.length) throw new Error("MI_INDEX returned no usable rows");
        } catch (fastError) {
          errors.push({ source: "twse-eod-fallback", message: `${fastError.message}; fell back to STOCK_DAY_ALL (may lag one trading day)` });
          payload = null;
        }
      }
      if (!payload) payload = toBulkRows(await fetchJson(source));
      fetched = normalizeEtfBulkRows(payload, key);
    } catch (error) {
      errors.push({ source: label, message: error.message });
    }
    const kept = preserveEtfMarketRows(Object.values(prevByCode), fetched, key);
    if (kept.preserved) {
      errors.push({ source: "feed-preservation", message: `kept ${kept.rows.length} previous ${key.toUpperCase()} ETF rows (fetched ${fetched.length})` });
    }
    rows = rows.concat(kept.rows);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  // 2) all_etf 淨值
  let navMap = {};
  try {
    navMap = normalizeAllEtf(JSON.parse(await fetchText(SOURCES.allEtf)));
  } catch (error) {
    errors.push({ source: "MIS all_etf.txt", message: error.message });
  }

  // 3) 配息公告 → 歷史累積
  // 交易日必須逐市場算並取**最小值**。原本取全體最大：上市 232 檔停在 08-05、
  // 上櫃 116 檔已是 08-06 時，整份被標成 08-06，讓那 232 檔掛著它們沒有的日期。
  // 這與 market-feed 當初的修法同一套（那裡的註解記著同一個教訓）。
  const marketDate = (m) => rows.filter((r) => r.market === m).map((r) => r.date).filter(Boolean).sort().pop() || null;
  const marketDates = {};
  const twseDate = marketDate("twse");
  const tpexDate = marketDate("tpex");
  if (twseDate) marketDates.twse = twseDate;
  if (tpexDate) marketDates.tpex = tpexDate;
  const knownDates = [twseDate, tpexDate].filter(Boolean).sort();
  const tradeDate = knownDates[0] || previousFeed.tradeDate || now.slice(0, 10);
  if (twseDate && tpexDate && twseDate !== tpexDate) {
    errors.push({ source: "stale-market", message: `TWSE ${twseDate} vs TPEX ${tpexDate} — feed dated to the older one` });
  }
  let events = [];
  try {
    const div = JSON.parse(await fetchText(SOURCES.etfDiv));
    events = normalizeEtfDivRows(div && div.data);
  } catch (error) {
    errors.push({ source: "TWSE rwd etfDiv", message: error.message });
  }
  // 上櫃 ETF 在 etfDiv 一筆都沒有，官方覆蓋率為 0；補上櫃的除權除息預告表。
  // 兩來源之間以 ±7 天去重，且有確定發放日的 etfDiv 優先（見 accumulateDivHistory）。
  let tpexDivCount = 0;
  try {
    const exright = await fetchJson(SOURCES.tpexExright);
    const tpexEvents = normalizeTpexExrightRows(exright);
    tpexDivCount = tpexEvents.length;
    events = events.concat(tpexEvents);
  } catch (error) {
    errors.push({ source: "TPEX exright prepost", message: error.message });
  }
  const historyRaw = await readJsonOr(HISTORY_FILE, {});
  const history = accumulateDivHistory(historyRaw, events, rows.map((r) => r.code), tradeDate);

  // 4) 靜態人工欄 + 自動抓取的成分股（人工清單優先，因為它經過查核）
  const staticData = await readJsonOr(STATIC_FILE, {});
  const staticEtfs = (staticData && staticData.etfs) || {};
  const holdingsData = await readJsonOr(HOLDINGS_FILE, {});
  const holdingsEtfs = (holdingsData && holdingsData.etfs) || {};
  const returnsData = await readJsonOr(RETURNS_FILE, {});
  const returnsByCode = (returnsData && returnsData.stocks) || {};
  const industryData = await readJsonOr(INDUSTRY_FILE, {});
  const industryByName = (industryData && industryData.byName) || {};
  if (!Object.keys(industryByName).length) {
    errors.push({ source: "industry-map", message: "data/industry-map.json 缺漏或為空——sectorMix 不會產生" });
  }

  // 5) 合成
  let premiumMismatch = 0;
  let navPreserved = 0;
  for (const row of rows) {
    const curated = staticEtfs[row.code] || {};
    row.type = curated.type || classifyEtf(row.code, row.name);
    const nav = navMap[row.code];
    if (nav) {
      row.nav = nav.nav;
      if (nav.units != null && nav.nav != null) row.aum = roundNumber(nav.units * nav.nav / 1e8, 2); // 億
      // 折溢價用 MIS 同一快照的市價/淨值對（天生同時刻）；bulk close 常落後一日不可混用。
      // MIS 官方 g 欄作 sanity check，差 >0.5pp 視為資料異常、不輸出該欄。
      if (nav.price != null && nav.price > 0) {
        const computed = roundNumber((nav.price - nav.nav) / nav.nav * 100, 2);
        const officialOk = nav.premiumOfficial == null || Math.abs(computed - nav.premiumOfficial) <= PREMIUM_SANITY_PP;
        if (officialOk) row.discountPremium = computed;
        else premiumMismatch += 1;
      }
    }
    navPreserved += preserveEtfColumns(row, prevByCode[row.code]);

    const dividend = deriveDividend(history.stocks[row.code], history.start, tradeDate);
    if (dividend) {
      row.dps = dividend.dps;
      row.frequency = dividend.frequency;
      row.divMonthsCovered = dividend.divMonthsCovered;
      row.payMonths = [...new Set(dividend.dps.map((d) => d.m))].sort((a, b) => a - b);
      if (dividend.divMonthsCovered >= 12 && row.close > 0) {
        row.yield = roundNumber(dividend.totalDps / row.close * 100, 2);
      } else {
        row.yield = null; // 歷史累積中，避免上線初期輸出系統性偏低的殖利率
        // 但別讓資訊完全消失：符合條件者給獨立的年化推估欄位供畫面揭露
        const estimated = estimateYield(row);
        if (estimated != null) {
          row.yieldEstimated = estimated;
          row.yieldBasis = { events: row.dps.length, months: dividend.divMonthsCovered };
        }
      }
    }
    if (curated.expenseRatio != null) row.expenseRatio = curated.expenseRatio;
    // 成分股：人工查核過的清單優先，其次用自動抓取的
    const scraped = holdingsEtfs[row.code];
    if (Array.isArray(curated.topHoldings) && curated.topHoldings.length) {
      row.topHoldings = curated.topHoldings;
      row.holdingsAsOf = curated.asOf || null;
      row.holdingsSource = curated.source || null;
    } else if (scraped && Array.isArray(scraped.topHoldings) && scraped.topHoldings.length) {
      row.topHoldings = scraped.topHoldings;
      row.holdingsAsOf = scraped.asOf || null;
      row.holdingsSource = scraped.source || null;
    }
    // 明確旗標：前端據此判斷「實質曝險算不算得出來」，不要用 length 猜
    row.hasHoldingsData = Boolean(row.topHoldings && row.topHoldings.length);
    const mix = deriveSectorMix(row.topHoldings, industryByName);
    if (mix) row.sectorMix = mix;
    // 品質與分類指標寫入資料層（原本只在前端算，消費原始 JSON 者拿不到）
    // 波動度看近 24 個月（殖利率仍是近 12 個月）——用同一個 12 月窗只有 4 筆，
    // 看不出 006208 那種 0.989→4.75 的水準跳升
    const cvWindow = cvWindowAmounts(history.stocks[row.code], tradeDate);
    const cv = dividendCv(cvWindow);
    if (cv != null) row.dividendCv = cv;
    // 樣本數要跟著出來：實測 00400A 只有 2 次配息、金額相同 → CV 0，
    // 畫面把它標成「極穩」。2 個樣本的變異係數沒有統計意義，
    // 前端要據此拒絕給出高等級。
    if (Array.isArray(cvWindow) && cvWindow.length) row.dividendCvSamples = cvWindow.length;
    row.isActive = isActiveEtf(row);
    row.isCore = isCoreEtf(row);
    // 近一年總報酬／價格報酬（回測）。抓不到就整組不寫，讓前端以「無資料」處理——
    // 缺一半的報酬比沒有報酬更危險：只有配息會讓賠價差的高配息標的看起來最好。
    const ret = returnsByCode[row.code];
    if (ret && ret.totalReturn1y != null && ret.priceReturn1y != null) {
      row.returnFrom = ret.from;
      row.returnTo = ret.to;
      row.returnSpanDays = ret.spanDays;
      // 三個觀察窗。只給一年會誤導：實測 0050 的 1Y 最大回撤 −15.9%，
      // 但 5Y 是 −36.4%；00631L 1Y −31.3%、3Y −55.1%。
      for (const key of ["1y", "3y", "5y"]) {
        for (const metric of ["totalReturn", "priceReturn", "maxDrawdown", "volatility", "cagr"]) {
          const field = metric + key;
          if (ret[field] != null) row[field] = ret[field];
        }
      }
    } else if (returnsData.skipped && returnsData.skipped[row.code]) {
      // 為什麼沒有報酬資料：畫面上的「—」要說得出是「成立未滿一年」還是「抓不到」，
      // 否則使用者會以為是 API 壞了或還沒算完。
      const s = returnsData.skipped[row.code];
      row.returnUnavailable = (s && typeof s === "object")
        ? { reason: s.reason, days: s.days == null ? null : s.days }
        : { reason: "unparsable" };
    }
    if (curated.domicileNote) row.domicileNote = curated.domicileNote;
    // 配息的國內來源佔比（稅務估算用）。名稱推定看不出投資地區時只能人工判定——
    // 例：00712 復華富時不動產前十大全是美國 REITs，但中文譯名完全看不出來。
    // 沒建表的標的不寫這個欄位，前端會回退到名稱推定。
    //
    // 兩種來源，收益分配通知書優先：
    //   composition（實際通知書的各類所得金額）→ 算出來的比例，最準
    //   domesticRatio（依成分股推定）          → 退而求其次
    const fromNotice = domesticRatioFromComposition(curated.composition);
    if (fromNotice) {
      row.domesticRatio = fromNotice.ratio;
      row.domicileBasis = fromNotice.basis;
      row.domicileSource = "收益分配通知書";
    } else if (typeof curated.domesticRatio === "number" && curated.domesticRatio >= 0 && curated.domesticRatio <= 1) {
      row.domesticRatio = curated.domesticRatio;
      if (curated.domicileBasis) row.domicileBasis = curated.domicileBasis;
      row.domicileSource = "成分股推定";
    }
  }
  if (premiumMismatch) errors.push({ source: "premium-sanity", message: `${premiumMismatch} row(s) premium mismatch >${PREMIUM_SANITY_PP}pp vs MIS official; column suppressed` });
  if (navPreserved) errors.push({ source: "feed-preservation", message: `kept previous nav/premium/aum for ${navPreserved} column value(s)` });

  // 前端的曝險引擎要逐檔查「成分股 → 產業」。整份 industry-map（1,998 檔）
  // 對頁面太大，而實際出現在 topHoldings 裡的名字只有一小部分——只帶那些。
  const holdingIndustry = {};
  for (const row of rows) {
    for (const h of (row.topHoldings || [])) {
      const raw = String((h && h.name) || "").trim();
      if (!raw || holdingIndustry[raw] !== undefined) continue;
      const ind = industryByName[raw] || industryByName[raw.replace(/[*＊\s]/g, "")] || null;
      if (ind) holdingIndustry[raw] = ind;
    }
  }

  const feed = { updatedAt: now, tradeDate, marketDates, count: rows.length, divHistoryStart: history.start, holdingIndustry, stocks: rows, errors };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(FEED_FILE, JSON.stringify(feed), "utf8");
  await writeFile(HISTORY_FILE, JSON.stringify({ start: history.start, updatedAt: now, stocks: history.stocks }), "utf8");
  console.log(`etf-feed: ${rows.length} rows, tradeDate ${tradeDate}, div events ${events.length} (tpex-exright ${tpexDivCount}), errors ${errors.length}`);
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
