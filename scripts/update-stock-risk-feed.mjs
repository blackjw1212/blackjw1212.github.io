import { mkdir, writeFile } from "node:fs/promises";

const OUT_FILE = new URL("../data/stock-risk-feed.json", import.meta.url);
const STOCK_CODES = new Set(["2330", "2317", "6669", "3017", "3324", "2382", "1519", "2308", "3231", "3661"]);

const SOURCES = {
  twseEod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  tpexEod: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
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

function normalizeEod(rows) {
  if (!Array.isArray(rows)) throw new Error("TWSE EOD payload is not an array");
  return rows.map((row) => {
    const code = String(field(row, ["Code", "code", "SecuritiesCompanyCode"]) || "").trim();
    if (!STOCK_CODES.has(code)) return null;
    const close = parseNumber(field(row, ["ClosingPrice", "close", "Close", "Closing"]));
    if (close == null) return null;
    return {
      code,
      name: String(field(row, ["Name", "name", "CompanyName"]) || "").trim(),
      close: roundNumber(close, 2),
      change: roundNumber(parseNumber(field(row, ["Change", "change", "PriceChange"])), 2),
    };
  }).filter(Boolean);
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

async function main() {
  const now = new Date().toISOString();
  const errors = [];
  let eod = [];
  let eodUpdatedAt = null;

  try {
    eod = normalizeEod(await fetchJson(SOURCES.twseEod));
    eodUpdatedAt = now;
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
    if (tpexRows.length && eodUpdatedAt == null) eodUpdatedAt = now;
  } catch (error) {
    errors.push({ source: "TPEX OpenAPI daily close quotes", message: error.message });
  }

  eod.sort((a, b) => a.code.localeCompare(b.code));

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

  const feed = {
    updatedAt: now,
    eodUpdatedAt,
    holdings: [...STOCK_CODES],
    eod,
    yield10y,
    errors,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
