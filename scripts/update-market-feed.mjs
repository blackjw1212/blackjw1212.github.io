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
  // 上市收盤主來源。openapi 的 STOCK_DAY_ALL 發佈很慢——實測 2026-07-29 台灣 21:47
  // （收盤後 8 小時）仍只有 07-28 的資料，導致頁面顯示的價比使用者帳面舊一天。
  // 同一交易所的 MI_INDEX 當日就到位，且與 MIS 即時、券商帳面三方一致。
  // 不帶 date 參數即回最新交易日，不必自己維護交易日曆。
  twseEodFast: "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?type=ALLBUT0999&response=json",
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  twseValuation: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  tpexValuation: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
};

// TPEX 回 10,000+ 列、耗時近 1 秒，在 runner 上常見連線被中斷（undici 的 "terminated"）。
// 實測 2026-07-28 兩班都因此丟失全部上櫃資料。4xx 不重試（重試也不會變好），
// 其餘以指數退避重試，比照 fetch-etf-holdings.mjs 的既有做法。
export async function fetchJson(url, attempt = 1, maxAttempt = 3, baseDelayMs = 800) {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
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

// TPEX Date 欄位是民國年 (1150717)；TWSE STOCK_DAY_ALL 的 Date 同樣民國年。
export function rocToIso(value) {
  const match = String(value == null ? "" : value).trim().match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]) + 1911;
  return `${year}-${match[2]}-${match[3]}`;
}

// MI_INDEX 的漲跌方向藏在 HTML 裡（紅 + 漲、綠 - 跌），「漲跌價差」欄一律是絕對值。
// 只讀價差欄會讓 961 檔下跌股全部變成上漲。除權息（X）當日無從比較，記 null 而非 0。
export function parseMiChange(signCell, diffCell) {
  const magnitude = parseNumber(String(diffCell == null ? "" : diffCell).replace(/,/g, ""));
  const sign = String(signCell == null ? "" : signCell);
  if (/>X</.test(sign) || /^\s*X\s*$/.test(sign)) return null;
  if (magnitude == null) return null;
  if (/color:\s*red|\+/.test(sign)) return magnitude;
  if (/color:\s*green|-/.test(sign)) return -magnitude;
  return 0; // 平盤：<p> </p>
}

// 以 title 與 fields 名稱錨定，不用固定的 tables 索引與欄位位置——
// 比照 fetch-etf-holdings 的 parseHoldings，讓上游改版時是「解析不到」而非「解析錯」。
export function normalizeMiIndex(payload) {
  const empty = { rows: [], date: null };
  if (!payload || typeof payload !== "object") return empty;
  if (payload.stat && payload.stat !== "OK") return empty;
  const table = (Array.isArray(payload.tables) ? payload.tables : [])
    .find((t) => /每日收盤行情/.test(String(t && t.title || "")) && Array.isArray(t.data) && t.data.length);
  if (!table) return empty;
  const fields = Array.isArray(table.fields) ? table.fields.map((f) => String(f).trim()) : [];
  const at = (label) => fields.indexOf(label);
  const iCode = at("證券代號");
  const iClose = at("收盤價");
  if (iCode < 0 || iClose < 0) return empty;
  const idx = {
    name: at("證券名稱"), open: at("開盤價"), high: at("最高價"), low: at("最低價"),
    volume: at("成交股數"), sign: at("漲跌(+/-)"), diff: at("漲跌價差"),
  };
  const num = (cell) => parseNumber(String(cell == null ? "" : cell).replace(/,/g, ""));
  // 日期在 payload 層（20260729），不在每一列。轉回民國年塞進列裡，
  // 下游 normalizeMarketRows 就能沿用既有的 Date 解析，不必為這個來源開特例。
  const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(String(payload.date || "").trim());
  const rocDate = ymd ? `${Number(ymd[1]) - 1911}${ymd[2]}${ymd[3]}` : null;
  const rows = [];
  for (const row of table.data) {
    if (!Array.isArray(row)) continue;
    // 無成交的列收盤是 "--"，不能當成價格
    const close = num(row[iClose]);
    if (close == null || !(close > 0)) continue;
    const entry = {
      Code: String(row[iCode] == null ? "" : row[iCode]).trim(),
      Name: idx.name >= 0 ? String(row[idx.name] == null ? "" : row[idx.name]).trim() : "",
      ClosingPrice: close,
    };
    if (rocDate) entry.Date = rocDate;
    const change = idx.sign >= 0 ? parseMiChange(row[idx.sign], row[idx.diff]) : null;
    if (change != null) entry.Change = change;
    for (const [key, label] of [["OpeningPrice", "open"], ["HighestPrice", "high"], ["LowestPrice", "low"], ["TradeVolume", "volume"]]) {
      if (idx[label] < 0) continue;
      const value = num(row[idx[label]]);
      if (value != null) entry[key] = value;
    }
    rows.push(entry);
  }
  // 標題形如「115年07月29日 每日收盤行情(...)」；payload.date 是 20260729
  const iso = /^(\d{4})(\d{2})(\d{2})$/.exec(String(payload.date || "").trim());
  return { rows, date: iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null };
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

// 估值來源自己帶資料日（BWIBBU_ALL 與 TPEX 本益比分析都有 Date，民國年、全檔同一值），
// 而且它**發佈得比收盤慢**：實測 2026-08-05 台灣 23:54 那班抓到的仍是 08-04 的估值，
// 卻和當天 08-05 的收盤寫在同一列。PE/PB/殖利率的分母是股價，錯一天就整排數字失準
// （2330：PE 31.19 對應 2,320，32.33 才對應當日的 2,405，EPS 同為 74.38）。
// 因此把資料日一起帶出來，讓 feed 說得出「這欄是哪一天的」。
export function normalizeMarketValuation(rows) {
  if (!Array.isArray(rows)) throw new Error("Valuation payload is not an array");
  const entries = {};
  const dates = new Set();
  for (const row of rows) {
    const code = String(field(row, ["Code", "SecuritiesCompanyCode", "code"]) || "").trim();
    if (!/^\d{4,6}$/.test(code) || entries[code]) continue;
    const pe = parseNumber(field(row, ["PEratio", "PriceEarningRatio", "PERatio", "PER"]));
    const dividendYield = parseNumber(field(row, ["DividendYield", "YieldRatio"]));
    const pbRatio = parseNumber(field(row, ["PBratio", "PriceBookRatio", "PBRatio"]));
    const date = rocToIso(field(row, ["Date", "date"]));
    if (date) dates.add(date);
    if (pe == null && dividendYield == null && pbRatio == null) continue;
    const entry = {};
    if (pe != null) entry.pe = roundNumber(pe, 2);
    if (dividendYield != null) entry.dividendYield = roundNumber(dividendYield, 2);
    if (pbRatio != null) entry.pbRatio = roundNumber(pbRatio, 2);
    entries[code] = entry;
  }
  // 同一份 payload 理論上只有一個日期；真的混了就取最舊的，
  // 與 tradeDate 一樣採「這份資料至少完整到這一天」的保守解讀。
  const date = [...dates].sort()[0] || null;
  return { entries, date };
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

  // 上市收盤：先取當日就到位的 MI_INDEX，抓不到才退回慢一天的 STOCK_DAY_ALL。
  // 兩條都留著——MI_INDEX 走 www.twse.com.tw，未經 runner 實測；既有教訓是
  // TWSE 會對 GitHub runner IP 回 HTML 錯誤頁，退路必須存在。
  let twseRows = [];
  try {
    const mi = normalizeMiIndex(await fetchJson(SOURCES.twseEodFast));
    if (!mi.rows.length) throw new Error("MI_INDEX returned no closing rows");
    bulkRaw.twse = mi.rows;
    twseRows = normalizeMarketRows(mi.rows, "twse");
  } catch (miError) {
    errors.push({ source: "TWSE MI_INDEX", message: miError.message });
    try {
      bulkRaw.twse = await fetchJson(SOURCES.twseEod);
      twseRows = normalizeMarketRows(bulkRaw.twse, "twse");
      errors.push({ source: "twse-eod-fallback", message: "fell back to STOCK_DAY_ALL (may lag one trading day)" });
    } catch (error) {
      errors.push({ source: "TWSE OpenAPI STOCK_DAY_ALL", message: error.message });
    }
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
  const valuationDates = {};
  const prevValuationDates = (previousFeed.valuationDates && typeof previousFeed.valuationDates === "object") ? previousFeed.valuationDates : {};
  try {
    const twseVal = normalizeMarketValuation(await fetchJson(SOURCES.twseValuation));
    valuation = twseVal.entries;
    if (twseVal.date) valuationDates.twse = twseVal.date;
  } catch (error) {
    errors.push({ source: "TWSE OpenAPI BWIBBU_ALL", message: error.message });
  }
  try {
    const tpexVal = normalizeMarketValuation(await fetchJson(SOURCES.tpexValuation));
    for (const [code, entry] of Object.entries(tpexVal.entries)) if (!valuation[code]) valuation[code] = entry;
    if (tpexVal.date) valuationDates.tpex = tpexVal.date;
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI peratio analysis", message: error.message });
  }
  // 某個來源整個掛掉時，那個市場的估值會沿用前次值（applyValuation 逐檔保留），
  // 日期也必須跟著沿用——標成本次日期等於謊報新鮮度。
  for (const market of ["twse", "tpex"]) {
    if (!valuationDates[market] && prevValuationDates[market]) {
      valuationDates[market] = prevValuationDates[market];
      errors.push({ source: "feed-preservation", message: `kept previous ${market} valuationDate ${prevValuationDates[market]} (this run fetched none)` });
    }
  }
  const stocks = [...twse.rows, ...tpex.rows].sort((a, b) => a.code.localeCompare(b.code));
  const prevValByCode = {};
  for (const s of previousStocks) {
    if (s.pe != null || s.pbRatio != null || s.dividendYield != null) {
      prevValByCode[s.code] = { pe: s.pe, dividendYield: s.dividendYield, pbRatio: s.pbRatio };
    }
  }

  // 交易日必須逐市場算。原本取「全體最大日期」，於是 TPEX 已到 07-29、TWSE 還停在
  // 07-28 時，整份 feed 被標成 07-29——1,083 檔上市股標著它們沒有的日期，
  // 而 errors 是空的。改為取兩市場的最小值（「這份清單至少完整到這一天」），
  // 並把各市場日期一起輸出，讓畫面能誠實說明落差。
  const marketDate = (rows) => rows.map((s) => s.date).filter(Boolean).sort().pop() || null;
  const marketDates = {};
  const twseDate = marketDate(twse.rows);
  const tpexDate = marketDate(tpex.rows);
  if (twseDate) marketDates.twse = twseDate;
  if (tpexDate) marketDates.tpex = tpexDate;
  const known = [twseDate, tpexDate].filter(Boolean).sort();
  const tradeDate = known[0] || previousFeed.tradeDate || now.slice(0, 10);
  if (twseDate && tpexDate && twseDate !== tpexDate) {
    errors.push({ source: "stale-market", message: `TWSE ${twseDate} vs TPEX ${tpexDate} — feed dated to the older one` });
  }

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

  // 估值日與收盤日不同步是常態（估值來源發佈得慢）。頂層取兩市場較舊者，
  // 與 tradeDate 同一套保守解讀。
  const knownValuationDates = [valuationDates.twse, valuationDates.tpex].filter(Boolean).sort();
  const valuationDate = knownValuationDates[0] || null;
  // 但落差必須**逐市場**判斷。只比 valuationDate 與 tradeDate 會漏報：
  // 實測 2026-08-06 早上，TWSE 收盤已是 08-06、TPEX 還停在 08-05，tradeDate 取最小值
  // 也是 08-05，於是「估值日＝tradeDate」成立、報不出任何問題——但那 1,083 檔上市股
  // 的收盤是 08-06、估值是 08-05，落差真實存在。這正是 tradeDate 取最小值時
  // 各市場日期要一起輸出的同一個理由。
  for (const market of ["twse", "tpex"]) {
    const closeDate = marketDates[market];
    const valDate = valuationDates[market];
    if (!closeDate || !valDate || closeDate === valDate) continue;
    errors.push({
      source: "stale-valuation",
      market,
      message: `${market} valuation dated ${valDate} but close is ${closeDate} — PE/PB/yield use the ${valDate < closeDate ? "older" : "newer"} close as denominator`,
    });
  }

  const feed = { updatedAt: now, tradeDate, marketDates, valuationDate, valuationDates, hiSince: accumulator.start, count: stocks.length, stocks, errors };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  // minified：全市場 ~2,200 列，縮排會讓體積翻倍
  await writeFile(FEED_FILE, JSON.stringify(feed), "utf8");
  await writeFile(ACC_FILE, JSON.stringify({ start: accumulator.start, updatedAt: now, stocks: accumulator.stocks }), "utf8");
  console.log(`market-feed: ${stocks.length} rows, tradeDate ${tradeDate}, valuationDate ${valuationDate || "未取得"}, errors ${errors.length}`);
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
