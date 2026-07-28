// 全市場（上市+上櫃主板）每日快照引擎。
// 4 個 bulk 請求即可涵蓋全市場：TWSE/TPEX 收盤 + TWSE/TPEX 估值；
// 動態個股清單由 bulk 回應附送，新上市/下市自動反映。
// 52 週高低採「月 bucket」滾動累積（data/market-52w.json，前端不載入），
// 快照輸出已算好 hi52/lo52/fromHi（data/market-feed.json，minified 控制體積）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { field, parseNumber, roundNumber } from "./update-stock-risk-feed.mjs";

const FEED_FILE = new URL("../data/market-feed.json", import.meta.url);
const ACC_FILE = new URL("../data/market-52w.json", import.meta.url);

const SOURCES = {
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  twseValuation: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  tpexValuation: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json();
}

// TPEX Date 欄位是民國年 (1150717)；TWSE STOCK_DAY_ALL 的 Date 同樣民國年。
export function rocToIso(value) {
  const match = String(value == null ? "" : value).trim().match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  return `${year}-${match[2]}-${match[3]}`;
}

export function normalizeMarketRows(rows, market) {
  if (!Array.isArray(rows)) throw new Error(`${market} EOD payload is not an array`);
  const out = [];
  for (const row of rows) {
    const code = String(field(row, ["Code", "SecuritiesCompanyCode", "code"]) || "").trim();
    // 僅收 4 碼一般個股；排除權證(6碼)、ETF/ETN(00 開頭 5-6 碼)——本頁定位是「個股」篩選
    if (!/^\d{4}$/.test(code) || code.startsWith("00")) continue;
    const close = parseNumber(field(row, ["ClosingPrice", "Close", "close"]));
    // 收盤 0 代表當日無成交，不是有效價格（會讓距離觀察基準、股數計算失真）
    if (close == null || !(close > 0)) continue;
    const entry = {
      code,
      name: String(field(row, ["Name", "CompanyName", "name"]) || "").trim(),
      market,
      close: roundNumber(close, 2),
      change: roundNumber(parseNumber(field(row, ["Change", "change"])), 2),
    };
    const open = parseNumber(field(row, ["OpeningPrice", "Open", "open"]));
    const high = parseNumber(field(row, ["HighestPrice", "High", "high"]));
    const low = parseNumber(field(row, ["LowestPrice", "Low", "low"]));
    const volume = parseNumber(field(row, ["TradeVolume", "TradingShares", "volume"]));
    if (open != null) entry.open = roundNumber(open, 2);
    if (high != null) entry.high = roundNumber(high, 2);
    if (low != null) entry.low = roundNumber(low, 2);
    if (volume != null) entry.volume = Math.round(volume);
    const date = rocToIso(field(row, ["Date", "date"]));
    if (date) entry.date = date;
    out.push(entry);
  }
  return out;
}

export function normalizeMarketValuation(rows) {
  if (!Array.isArray(rows)) throw new Error("Valuation payload is not an array");
  const out = {};
  for (const row of rows) {
    const code = String(field(row, ["Code", "SecuritiesCompanyCode", "code"]) || "").trim();
    if (!/^\d{4,6}$/.test(code) || out[code]) continue;
    const pe = parseNumber(field(row, ["PEratio", "PriceEarningRatio", "PERatio", "PER"]));
    const dividendYield = parseNumber(field(row, ["DividendYield", "YieldRatio"]));
    const pbRatio = parseNumber(field(row, ["PBratio", "PriceBookRatio", "PBRatio"]));
    if (pe == null && dividendYield == null && pbRatio == null) continue;
    const entry = {};
    if (pe != null) entry.pe = roundNumber(pe, 2);
    if (dividendYield != null) entry.dividendYield = roundNumber(dividendYield, 2);
    if (pbRatio != null) entry.pbRatio = roundNumber(pbRatio, 2);
    out[code] = entry;
  }
  return out;
}

// 保留策略：新抓列數 < 前次 50% 視為上游劣化，沿用前次快照列。
export function preserveMarketRows(previousStocks, fetchedRows) {
  const prev = Array.isArray(previousStocks) ? previousStocks : [];
  if (fetchedRows.length >= Math.max(50, prev.length * 0.5)) {
    return { rows: fetchedRows, preserved: false };
  }
  if (!prev.length) return { rows: fetchedRows, preserved: false };
  return { rows: prev, preserved: true };
}

// 逐檔 fallback：任一估值來源失敗時（例：TWSE 成功但 TPEX 失敗），
// 只有缺料的那些個股沿用前次值，不會整批歸零也不會誤傷另一個市場。
export function applyValuation(stocks, valuation, previousByCode) {
  const fresh = valuation && typeof valuation === "object" ? valuation : {};
  const previous = previousByCode && typeof previousByCode === "object" ? previousByCode : {};
  let preserved = 0;
  for (const row of stocks) {
    let entry = fresh[row.code];
    if (!entry && previous[row.code]) {
      entry = previous[row.code];
      preserved += 1;
    }
    if (!entry) continue;
    if (entry.pe != null) row.pe = entry.pe;
    if (entry.dividendYield != null) row.dividendYield = entry.dividendYield;
    if (entry.pbRatio != null) row.pbRatio = entry.pbRatio;
  }
  return { preserved };
}

export function monthKey(isoDate) {
  return String(isoDate || "").slice(0, 7);
}

// 月 bucket 滾動累積：只動當月，>13 個月剪枝；lastSeen 記 ISO 日，>60 天未見剪整檔（下市）。
export function accumulate52w(accumulator, stocks, tradeDate) {
  const acc = accumulator && typeof accumulator === "object" ? accumulator : {};
  const store = acc.stocks && typeof acc.stocks === "object" ? acc.stocks : {};
  if (!monthKey(tradeDate)) return { start: acc.start || tradeDate, stocks: store };
  const cutoff = new Date(tradeDate + "T00:00:00Z");
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
  const minMonth = cutoff.toISOString().slice(0, 7);

  for (const row of stocks) {
    const hi = row.high != null ? row.high : row.close;
    const lo = row.low != null ? row.low : row.close;
    if (hi == null || lo == null) continue;
    // 按行內自己的資料日歸桶（TWSE 常落後 TPEX 一日）；max/min 冪等，重複灌同一天無害
    const rowDate = row.date || tradeDate;
    const month = monthKey(rowDate);
    if (!month) continue;
    const entry = store[row.code] || (store[row.code] = { m: {} });
    const bucket = entry.m[month];
    if (!bucket) entry.m[month] = [hi, lo];
    else {
      if (hi > bucket[0]) bucket[0] = hi;
      if (lo < bucket[1]) bucket[1] = lo;
    }
    if (!entry.lastSeen || rowDate > entry.lastSeen) entry.lastSeen = rowDate;
    for (const key of Object.keys(entry.m)) if (key < minMonth) delete entry.m[key];
  }

  const staleCutoff = new Date(tradeDate + "T00:00:00Z");
  staleCutoff.setUTCDate(staleCutoff.getUTCDate() - 60);
  const staleIso = staleCutoff.toISOString().slice(0, 10);
  for (const code of Object.keys(store)) {
    if ((store[code].lastSeen || "") < staleIso) delete store[code];
  }
  return { start: acc.start || tradeDate, stocks: store };
}

export function derive52w(accEntry) {
  if (!accEntry || !accEntry.m) return null;
  let hi = null;
  let lo = null;
  for (const bucket of Object.values(accEntry.m)) {
    if (!Array.isArray(bucket)) continue;
    if (bucket[0] != null && (hi == null || bucket[0] > hi)) hi = bucket[0];
    if (bucket[1] != null && (lo == null || bucket[1] < lo)) lo = bucket[1];
  }
  if (hi == null || lo == null) return null;
  return { hi52: roundNumber(hi, 2), lo52: roundNumber(lo, 2) };
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
  const previousStocks = Array.isArray(previousFeed.stocks) ? previousFeed.stocks : [];
  const prevByMarket = { twse: previousStocks.filter((s) => s.market === "twse"), tpex: previousStocks.filter((s) => s.market === "tpex") };

  // --emit-bulk <path>：把原始 bulk payload 落檔給 etf 引擎重用，
  // 避免同一班 workflow 對 TWSE/TPEX 重複請求把失敗率疊上去。
  const emitIndex = process.argv.indexOf("--emit-bulk");
  const emitPath = emitIndex >= 0 ? process.argv[emitIndex + 1] : null;
  const bulkRaw = { twse: null, tpex: null, fetchedAt: now };

  let twseRows = [];
  try {
    bulkRaw.twse = await fetchJson(SOURCES.twseEod);
    twseRows = normalizeMarketRows(bulkRaw.twse, "twse");
  } catch (error) {
    errors.push({ source: "TWSE OpenAPI STOCK_DAY_ALL", message: error.message });
  }
  let tpexRows = [];
  try {
    bulkRaw.tpex = await fetchJson(SOURCES.tpexEod);
    tpexRows = normalizeMarketRows(bulkRaw.tpex, "tpex");
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI daily close quotes", message: error.message });
  }
  if (emitPath) {
    try {
      await writeFile(emitPath, JSON.stringify(bulkRaw), "utf8");
    } catch (error) {
      errors.push({ source: "emit-bulk", message: error.message });
    }
  }

  const twse = preserveMarketRows(prevByMarket.twse, twseRows);
  const tpex = preserveMarketRows(prevByMarket.tpex, tpexRows);
  if (twse.preserved) errors.push({ source: "feed-preservation", message: `kept ${twse.rows.length} previous TWSE rows (fetched ${twseRows.length})` });
  if (tpex.preserved) errors.push({ source: "feed-preservation", message: `kept ${tpex.rows.length} previous TPEX rows (fetched ${tpexRows.length})` });

  let valuation = {};
  try {
    valuation = normalizeMarketValuation(await fetchJson(SOURCES.twseValuation));
  } catch (error) {
    errors.push({ source: "TWSE OpenAPI BWIBBU_ALL", message: error.message });
  }
  try {
    const tpexVal = normalizeMarketValuation(await fetchJson(SOURCES.tpexValuation));
    for (const [code, entry] of Object.entries(tpexVal)) if (!valuation[code]) valuation[code] = entry;
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI peratio analysis", message: error.message });
  }
  const stocks = [...twse.rows, ...tpex.rows].sort((a, b) => a.code.localeCompare(b.code));
  const prevValByCode = {};
  for (const s of previousStocks) {
    if (s.pe != null || s.pbRatio != null || s.dividendYield != null) {
      prevValByCode[s.code] = { pe: s.pe, dividendYield: s.dividendYield, pbRatio: s.pbRatio };
    }
  }

  // 兩個市場都退回保留資料時，行內已無 date：沿用前次 tradeDate，
  // 不可把今天當成交易日，否則畫面會宣稱舊資料是今天的。
  const tradeDate = stocks.map((s) => s.date).filter(Boolean).sort().pop()
    || previousFeed.tradeDate
    || now.slice(0, 10);

  // 52 週累積：只有在本次抓到「新鮮」資料時才累積（保留模式下不重複灌同一天）。
  const accumulatorRaw = await readJsonOr(ACC_FILE, {});
  const freshRows = [...(twse.preserved ? [] : twse.rows), ...(tpex.preserved ? [] : tpex.rows)];
  const accumulator = freshRows.length
    ? accumulate52w(accumulatorRaw, freshRows, tradeDate)
    : { start: accumulatorRaw.start || tradeDate, stocks: accumulatorRaw.stocks || {} };

  const { preserved: valuationPreserved } = applyValuation(stocks, valuation, prevValByCode);
  for (const row of stocks) {
    const w = derive52w(accumulator.stocks[row.code]);
    if (w) {
      row.hi52 = w.hi52;
      row.lo52 = w.lo52;
      if (row.close != null && w.hi52 > 0) row.fromHi = roundNumber((row.close - w.hi52) / w.hi52 * 100, 1);
    }
    delete row.date; // tradeDate 已提升到頂層，行內不重複
  }
  if (valuationPreserved) {
    errors.push({ source: "feed-preservation", message: `kept previous valuation for ${valuationPreserved} row(s) missing from this run` });
  }

  const feed = { updatedAt: now, tradeDate, hiSince: accumulator.start, count: stocks.length, stocks, errors };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  // minified：全市場 ~2,200 列，縮排會讓體積翻倍
  await writeFile(FEED_FILE, JSON.stringify(feed), "utf8");
  await writeFile(ACC_FILE, JSON.stringify({ start: accumulator.start, updatedAt: now, stocks: accumulator.stocks }), "utf8");
  console.log(`market-feed: ${stocks.length} rows, tradeDate ${tradeDate}, errors ${errors.length}`);
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
