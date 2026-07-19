import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OUT_FILE = new URL("../data/stock-risk-feed.json", import.meta.url);
const STOCK_CODES = new Set(["2330", "2317", "6669", "3017", "3324", "2382", "1519", "2308", "3231", "3661", "2356", "2376", "6239"]);

const SOURCES = {
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
  misQuote: "https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
  twseValuation: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  tpexValuation: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
  fredCsv: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: "text/csv,text/plain,*/*" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.text();
}

function field(row, names) {
  if (!row || typeof row !== "object") return "";
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (String(key).trim() === name) return row[key];
    }
  }
  return "";
}

function parseNumber(value) {
  if (value == null) return null;
  const match = String(value).replace(/,/g, "").replace(/%/g, "").match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// 交易日欄位在各來源格式不同：TWSE/TPEX OpenAPI 給民國 "1150717"，MIS 給 "20260717"。
// 統一成 ISO "2026-07-17"，讓 feed 能區分「資料屬於哪個交易日」與「何時抓的」。
export function parseTradingDate(value) {
  const raw = String(value ?? "").trim().replace(/[/.]/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim())) return String(value).trim();
  if (/^\d{7}$/.test(raw)) return `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

export function normalizeEod(rows) {
  if (!Array.isArray(rows)) throw new Error("TWSE EOD payload is not an array");
  return rows.map((row) => {
    const code = String(field(row, ["Code", "code", "SecuritiesCompanyCode"]) || "").trim();
    if (!STOCK_CODES.has(code)) return null;
    const close = parseNumber(field(row, ["ClosingPrice", "close", "Close", "Closing"]));
    if (close == null) return null;
    const date = parseTradingDate(field(row, ["Date", "date", "TradeDate"]));
    const entry = {
      code,
      name: String(field(row, ["Name", "name", "CompanyName"]) || "").trim(),
      close: roundNumber(close, 2),
      change: roundNumber(parseNumber(field(row, ["Change", "change", "PriceChange"])), 2),
    };
    if (date) entry.date = date;
    return entry;
  }).filter(Boolean);
}

// 盤後 STOCK_DAY_ALL 可能仍在送前一交易日；MIS 收盤即時報價可補上「當日」。
// 寬容設計：抓不到就靜默略過，只在交易日比較新時才覆寫，絕不讓 feed 變壞。
export async function fetchMisQuotes(codes, fetchImpl = fetch) {
  const found = new Map();
  const ask = async (prefix, list) => {
    if (!list.length) return;
    const channels = list.map((code) => `${prefix}_${code}.tw`).join("|");
    const response = await fetchImpl(`${SOURCES.misQuote}?ex_ch=${channels}&json=1&delay=0`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; bjkw-feed/1.0)",
        Referer: "https://mis.twse.com.tw/stock/fibest.jsp",
      },
    });
    if (!response.ok) throw new Error(`${SOURCES.misQuote} returned HTTP ${response.status}`);
    const payload = await response.json();
    for (const item of Array.isArray(payload && payload.msgArray) ? payload.msgArray : []) {
      const code = String((item && item.c) || "").trim();
      const close = parseNumber(item && item.z);
      const date = parseTradingDate(item && item.d);
      if (!STOCK_CODES.has(code) || close == null || !date || found.has(code)) continue;
      const previousClose = parseNumber(item && item.y);
      found.set(code, {
        code,
        name: String((item && item.n) || "").trim(),
        close: roundNumber(close, 2),
        change: previousClose == null ? null : roundNumber(close - previousClose, 2),
        date,
      });
    }
  };
  await ask("tse", codes);
  await ask("otc", codes.filter((code) => !found.has(code)));
  return found;
}

function normalizeValuation(rows) {
  if (!Array.isArray(rows)) throw new Error("Valuation payload is not an array");
  const out = {};
  for (const row of rows) {
    const code = String(field(row, ["Code", "code", "SecuritiesCompanyCode"]) || "").trim();
    if (!STOCK_CODES.has(code) || out[code]) continue;
    const pe = parseNumber(field(row, ["PEratio", "PriceEarningRatio", "PERatio", "PER"]));
    if (pe == null) continue;
    const entry = { code, pe: roundNumber(pe, 2) };
    const dividendYield = parseNumber(field(row, ["DividendYield", "YieldRatio"]));
    const pbRatio = parseNumber(field(row, ["PBratio", "PriceBookRatio", "PBRatio"]));
    if (dividendYield != null) entry.dividendYield = roundNumber(dividendYield, 2);
    if (pbRatio != null) entry.pbRatio = roundNumber(pbRatio, 2);
    out[code] = entry;
  }
  return out;
}

function parseFredDgs10(csv) {
  const rows = String(csv || "").trim().split(/\r?\n/).slice(1);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const [date, value] = rows[index].split(",");
    const parsed = Number(value);
    if (date && Number.isFinite(parsed)) {
      return {
        date,
        value: parsed,
        updatedAt: `${date}T22:00:00.000Z`,
        source: "FRED DGS10 CSV",
      };
    }
  }
  throw new Error("FRED CSV did not contain a numeric DGS10 observation");
}

function treasuryMonthUrl(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${year}${month}`;
}

function parseTreasury10Year(xml) {
  const entries = [...String(xml || "").matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const body = entries[index][1];
    const dateMatch = body.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/);
    const valueMatch = body.match(/<d:BC_10YEAR[^>]*>([^<]+)<\/d:BC_10YEAR>/);
    const value = Number(valueMatch && valueMatch[1]);
    if (dateMatch && Number.isFinite(value)) {
      const date = dateMatch[1].slice(0, 10);
      return {
        date,
        value,
        updatedAt: `${date}T22:00:00.000Z`,
        source: "US Treasury Daily Treasury Yield Curve",
      };
    }
  }
  throw new Error("Treasury XML did not contain a numeric 10-year yield");
}

async function fetchTreasury10Year() {
  const now = new Date();
  const months = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  ];
  let lastError = null;
  for (const month of months) {
    try {
      return parseTreasury10Year(await fetchText(treasuryMonthUrl(month)));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Treasury XML unavailable");
}

// 根因修復：上游短暫故障（TWSE OpenAPI 對 runner 回傳 HTML）時，不可用空資料覆蓋
// 上一份好資料。逐 code 合併（previous 疊上本次成功抓到的），讓 eod/valuation 永不歸零。
export function mergeFeed(previous, fetched, now) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const fetchedEod = Array.isArray(fetched.eod) ? fetched.eod : [];
  const fetchedValuation = fetched.valuation && typeof fetched.valuation === "object" ? fetched.valuation : {};
  const fetchedYield = fetched.yield10y || null;

  const eodMap = {};
  for (const row of Array.isArray(prev.eod) ? prev.eod : []) {
    const code = String((row && row.code) || "");
    if (STOCK_CODES.has(code)) eodMap[code] = row;
  }
  const fetchedCodes = new Set();
  for (const row of fetchedEod) {
    const code = String((row && row.code) || "");
    if (STOCK_CODES.has(code)) { eodMap[code] = row; fetchedCodes.add(code); }
  }
  const eod = Object.values(eodMap).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const fullyFresh = [...STOCK_CODES].every((code) => fetchedCodes.has(code));
  const eodUpdatedAt = fullyFresh ? now : (prev.eodUpdatedAt || (fetchedCodes.size ? now : null));
  // 資料所屬的最新交易日（與 eodUpdatedAt 的「抓取時刻」分開），供前端標示與陳舊度判斷。
  const eodTradingDate = eod.reduce((latest, row) => {
    const date = row && typeof row.date === "string" ? row.date : null;
    return date && (!latest || date > latest) ? date : latest;
  }, null);

  const prevValuation = prev.valuation && typeof prev.valuation === "object" ? prev.valuation : {};
  const valuation = { ...prevValuation, ...fetchedValuation };

  const yield10y = fetchedYield || prev.yield10y || null;

  return {
    eod,
    eodUpdatedAt,
    eodTradingDate,
    valuation,
    yield10y,
    preserved: {
      eod: eod.length - fetchedCodes.size,
      valuation: Object.keys(valuation).length - Object.keys(fetchedValuation).length,
      yield10y: !fetchedYield && prev.yield10y ? 1 : 0,
    },
  };
}

async function readPreviousFeed() {
  try {
    return JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const now = new Date().toISOString();
  const errors = [];
  let eod = [];

  try {
    eod = normalizeEod(await fetchJson(SOURCES.twseEod));
  } catch (error) {
    errors.push({ source: "TWSE OpenAPI STOCK_DAY_ALL", message: error.message });
  }

  // TWSE STOCK_DAY_ALL only covers listed (上市) stocks; OTC (上櫃) tracked codes
  // such as 3324 雙鴻 come from the TPEX daily close OpenAPI instead.
  try {
    const have = new Set(eod.map((row) => row.code));
    const tpexRows = normalizeEod(await fetchJson(SOURCES.tpexEod));
    for (const row of tpexRows) {
      if (!have.has(row.code)) {
        eod.push(row);
        have.add(row.code);
      }
    }
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI daily close quotes", message: error.message });
  }

  // OpenAPI 盤後仍可能停在前一交易日；用 MIS 收盤報價把落後的列升級到當日。
  try {
    const quotes = await fetchMisQuotes([...STOCK_CODES]);
    let upgraded = 0;
    for (const row of eod) {
      const quote = quotes.get(row.code);
      if (quote && (!row.date || quote.date > row.date)) {
        Object.assign(row, quote);
        upgraded += 1;
      }
    }
    const have = new Set(eod.map((row) => row.code));
    for (const [code, quote] of quotes) {
      if (!have.has(code)) {
        eod.push(quote);
        upgraded += 1;
      }
    }
    if (upgraded) {
      console.log(`MIS same-day quotes upgraded ${upgraded} row(s)`);
    }
  } catch (error) {
    errors.push({ source: "TWSE MIS same-day quotes", message: error.message });
  }

  eod.sort((a, b) => a.code.localeCompare(b.code));

  // PE / 殖利率 / 股價淨值比 — 上市走 TWSE BWIBBU_ALL，上櫃(雙鴻 3324)走 TPEX peratio。
  let valuation = {};
  try {
    valuation = normalizeValuation(await fetchJson(SOURCES.twseValuation));
  } catch (error) {
    errors.push({ source: "TWSE OpenAPI BWIBBU_ALL", message: error.message });
  }
  try {
    const tpexValuation = normalizeValuation(await fetchJson(SOURCES.tpexValuation));
    for (const [code, entry] of Object.entries(tpexValuation)) {
      if (!valuation[code]) valuation[code] = entry;
    }
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI peratio analysis", message: error.message });
  }

  let yield10y = null;
  try {
    yield10y = parseFredDgs10(await fetchText(SOURCES.fredCsv));
  } catch (error) {
    errors.push({ source: "FRED DGS10 CSV", message: error.message });
    try {
      yield10y = await fetchTreasury10Year();
    } catch (treasuryError) {
      errors.push({ source: "US Treasury Daily Treasury Yield Curve", message: treasuryError.message });
    }
  }

  const previous = await readPreviousFeed();
  const merged = mergeFeed(previous, { eod, valuation, yield10y }, now);
  if (merged.preserved.eod || merged.preserved.valuation || merged.preserved.yield10y) {
    errors.push({
      source: "feed-preservation",
      message: `kept ${merged.preserved.eod} eod row(s), ${merged.preserved.valuation} valuation entr(ies)`
        + `${merged.preserved.yield10y ? ", 1 yield10y" : ""} from previous feed due to upstream gaps`,
    });
  }

  const feed = {
    updatedAt: now,
    eodUpdatedAt: merged.eodUpdatedAt,
    eodTradingDate: merged.eodTradingDate,
    holdings: [...STOCK_CODES],
    eod: merged.eod,
    valuation: merged.valuation,
    yield10y: merged.yield10y,
    errors,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
