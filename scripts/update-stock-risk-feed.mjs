import { mkdir, writeFile } from "node:fs/promises";

const OUT_FILE = new URL("../data/stock-risk-feed.json", import.meta.url);
const STOCK_CODES = new Set(["2330", "2308", "2317", "2454", "2412", "2881", "2891", "2603"]);

const SOURCES = {
  twseFilings: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
  tpexFilings: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
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

function rocDate(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  let year = "";
  let month = "";
  let day = "";
  if (digits.length === 7) {
    year = String(Number(digits.slice(0, 3)) + 1911);
    month = digits.slice(3, 5);
    day = digits.slice(5, 7);
  } else if (digits.length === 8) {
    year = digits.slice(0, 4);
    month = digits.slice(4, 6);
    day = digits.slice(6, 8);
  } else {
    const parts = raw.split(/[\/.-]/).map((part) => part.trim());
    if (parts.length === 3) {
      const parsedYear = Number(parts[0]);
      year = String(parsedYear < 1911 ? parsedYear + 1911 : parsedYear);
      month = parts[1].padStart(2, "0");
      day = parts[2].padStart(2, "0");
    }
  }
  const parsed = new Date(`${year}-${month}-${day}T00:00:00`);
  return year && !Number.isNaN(parsed.getTime()) ? `${year}-${month}-${day}` : "";
}

function rocTime(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const normalized = digits.padStart(6, "0").slice(-6);
  const hour = normalized.slice(0, 2);
  const minute = normalized.slice(2, 4);
  const second = normalized.slice(4, 6);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return "";
  return `${hour}:${minute}:${second}`;
}

function sourceUpdatedAt(date, time) {
  return date ? `${date}T${time || "00:00:00"}+08:00` : "";
}

function normalizeFilings(rows, source) {
  if (!Array.isArray(rows)) throw new Error(`${source} payload is not an array`);
  return rows.map((row) => {
    const code = String(field(row, ["公司代號", "SecuritiesCompanyCode", "CompanyCode"]) || "").trim();
    if (!STOCK_CODES.has(code)) return null;
    const date = rocDate(field(row, ["發言日期", "出表日期", "Date", "AnnouncementDate"]));
    const time = rocTime(field(row, ["發言時間", "Time", "AnnouncementTime"]));
    const title = String(field(row, ["主旨", "Subject", "Title"]) || "").trim();
    if (!title) return null;
    return {
      code,
      name: String(field(row, ["公司名稱", "CompanyName"]) || "").trim(),
      date: date ? `${date}${time ? ` ${time.slice(0, 5)}` : ""}` : "--",
      title,
      description: String(field(row, ["說明", "Description", "Content"]) || "").trim(),
      source,
      url: "",
      sortKey: sourceUpdatedAt(date, time) || date || "",
    };
  }).filter(Boolean);
}

function latestPerStock(rows) {
  const counts = new Map();
  return rows
    .slice()
    .sort((a, b) => String(b.sortKey || b.date || "").localeCompare(String(a.sortKey || a.date || "")))
    .filter((row) => {
      const count = counts.get(row.code) || 0;
      if (count >= 5) return false;
      counts.set(row.code, count + 1);
      return true;
    });
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
  const filings = [];

  for (const source of [
    { name: "證交所上市重大訊息 OpenAPI", url: SOURCES.twseFilings },
    { name: "櫃買中心上櫃重大訊息 OpenAPI", url: SOURCES.tpexFilings },
  ]) {
    try {
      filings.push(...normalizeFilings(await fetchJson(source.url), source.name));
    } catch (error) {
      errors.push({ source: source.name, message: error.message });
    }
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

  const feed = {
    updatedAt: now,
    filingsUpdatedAt: now,
    holdings: [...STOCK_CODES],
    filings: latestPerStock(filings),
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
