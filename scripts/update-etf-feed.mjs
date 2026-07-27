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
import { rocToIso, monthKey } from "./update-market-feed.mjs";

const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const HISTORY_FILE = new URL("../data/etf-div-history.json", import.meta.url);
const STATIC_FILE = new URL("../data/etf-static.json", import.meta.url);

const SOURCES = {
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  allEtf: "https://mis.twse.com.tw/stock/data/all_etf.txt",
  etfDiv: "https://www.twse.com.tw/rwd/zh/ETF/etfDiv?response=json",
};

export const ETF_CODE_RE = /^00\d{2,4}[A-Z]?$/;
const PREMIUM_SANITY_PP = 0.5;

const BROWSER_HEADERS = {
  Accept: "*/*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Referer: "https://www.twse.com.tw/",
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json", ...BROWSER_HEADERS } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json();
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

// bulk（TWSE STOCK_DAY_ALL / TPEX daily close）→ ETF 價格列
export function normalizeEtfBulkRows(rows, market) {
  if (!Array.isArray(rows)) throw new Error(`${market} bulk payload is not an array`);
  const out = [];
  for (const row of rows) {
    const code = String(field(row, ["Code", "SecuritiesCompanyCode", "code"]) || "").trim().toUpperCase();
    if (!ETF_CODE_RE.test(code)) continue;
    const close = parseNumber(field(row, ["ClosingPrice", "Close", "close"]));
    if (close == null) continue;
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

// 配息歷史累積：events 以除息日為 key（冪等），13 個月窗 + lastSeen 剪枝
export function accumulateDivHistory(history, events, universeCodes, tradeDate) {
  const acc = history && typeof history === "object" ? history : {};
  const store = acc.stocks && typeof acc.stocks === "object" ? acc.stocks : {};
  const cutoff = new Date(tradeDate + "T00:00:00Z");
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
  const minDate = cutoff.toISOString().slice(0, 10);

  let earliest = acc.start || null;
  for (const event of events) {
    const entry = store[event.code] || (store[event.code] = { events: {} });
    entry.events[event.ex] = { pay: event.pay, dps: event.dps };
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

// 名稱規則粗分（etf-static 可覆寫）
export function classifyEtf(code, name) {
  const text = String(name || "");
  if (/[LR]$/.test(code) || /正2|反1|槓桿|反向/.test(text)) return "槓桿反向";
  if (/U$/.test(code) || /期貨/.test(text)) return "期貨型";
  if (/債/.test(text)) return "債券型";
  if (/高股息|高息|優息|股利|存股/.test(text)) return "高股息";
  return "主題型";
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
    try {
      const payload = bulkRaw[key] || await fetchJson(source);
      rows = rows.concat(normalizeEtfBulkRows(payload, key));
    } catch (error) {
      errors.push({ source: label, message: error.message });
    }
  }
  // 價格全失敗 → 沿用前次列（比照 preserveMarketRows 精神）
  if (!rows.length && Object.keys(prevByCode).length) {
    rows = Object.values(prevByCode).map((r) => ({ code: r.code, name: r.name, market: r.market, close: r.close, change: r.change, volume: r.volume }));
    errors.push({ source: "feed-preservation", message: `kept ${rows.length} previous ETF price rows (bulk unavailable)` });
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
  const tradeDate = rows.map((r) => r.date).filter(Boolean).sort().pop() || previousFeed.tradeDate || now.slice(0, 10);
  let events = [];
  try {
    const div = JSON.parse(await fetchText(SOURCES.etfDiv));
    events = normalizeEtfDivRows(div && div.data);
  } catch (error) {
    errors.push({ source: "TWSE rwd etfDiv", message: error.message });
  }
  const historyRaw = await readJsonOr(HISTORY_FILE, {});
  const history = accumulateDivHistory(historyRaw, events, rows.map((r) => r.code), tradeDate);

  // 4) 靜態人工欄
  const staticData = await readJsonOr(STATIC_FILE, {});
  const staticEtfs = (staticData && staticData.etfs) || {};

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
      }
    }
    if (curated.expenseRatio != null) row.expenseRatio = curated.expenseRatio;
    if (Array.isArray(curated.topHoldings) && curated.topHoldings.length) {
      row.topHoldings = curated.topHoldings;
      row.holdingsAsOf = curated.asOf || null;
    }
    if (curated.domicileNote) row.domicileNote = curated.domicileNote;
  }
  if (premiumMismatch) errors.push({ source: "premium-sanity", message: `${premiumMismatch} row(s) premium mismatch >${PREMIUM_SANITY_PP}pp vs MIS official; column suppressed` });
  if (navPreserved) errors.push({ source: "feed-preservation", message: `kept previous nav/premium/aum for ${navPreserved} column value(s)` });

  const feed = { updatedAt: now, tradeDate, count: rows.length, divHistoryStart: history.start, stocks: rows, errors };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(FEED_FILE, JSON.stringify(feed), "utf8");
  await writeFile(HISTORY_FILE, JSON.stringify({ start: history.start, updatedAt: now, stocks: history.stocks }), "utf8");
  console.log(`etf-feed: ${rows.length} rows, tradeDate ${tradeDate}, errors ${errors.length}`);
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
