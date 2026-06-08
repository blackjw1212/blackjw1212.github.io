const HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

export function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value)
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "")
    .replace(/%/g, "")
    .trim();

  if (!text || text === "-" || text === "--" || /^n\/?a$/i.test(text)) {
    return null;
  }

  const match = text.match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function roundNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function pick(row, keys) {
  for (const key of keys) {
    if (row && row[key] != null && row[key] !== "") return row[key];
  }
  return null;
}

export function normalizeTwseEod(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return rows
    .map((row) => {
      const code = String(pick(row, ["Code", "code", "SecuritiesCompanyCode"]) || "").trim();
      const name = String(pick(row, ["Name", "name", "CompanyName"]) || "").trim();
      const close = parseNumber(pick(row, ["ClosingPrice", "close", "Close", "Closing"]));
      const change = parseNumber(pick(row, ["Change", "change", "PriceChange"]));

      if (!/^\d{4,6}$/.test(code) || !name || close == null) return null;

      return {
        code,
        name,
        close: roundNumber(close, 2),
        change: roundNumber(change, 2),
      };
    })
    .filter(Boolean);
}

function codeFromChannel(channel) {
  const match = String(channel || "").match(/_(\d{4,6})\./);
  return match ? match[1] : "";
}

const MIS_INDEXES = {
  "tse_t00.tw": { id: "taiex", name: "加權", exchange: "tse" },
  "otc_o00.tw": { id: "tpex", name: "櫃買", exchange: "otc" },
};

function indexFromChannel(channel) {
  const normalized = String(channel || "").toLowerCase();
  for (const [suffix, index] of Object.entries(MIS_INDEXES)) {
    if (normalized.endsWith(suffix)) return index;
  }
  return null;
}

function normalizeMisDateTime(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  const dateMatch = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!dateMatch || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${time}+08:00`;
}

export function normalizeQuotePayload(payload, requestedCodes = []) {
  const wanted = new Set(requestedCodes.map(String));
  const rows = Array.isArray(payload?.msgArray) ? payload.msgArray : [];
  const byCode = new Map();

  for (const row of rows) {
    const code = String(row.c || codeFromChannel(row.ch)).trim();
    if (!/^\d{4,6}$/.test(code)) continue;
    if (wanted.size && !wanted.has(code)) continue;

    const price = parseNumber(row.z);
    const previousClose = parseNumber(row.y);
    const change = price != null && previousClose != null ? price - previousClose : null;
    const pctChange = change != null && previousClose ? (change / previousClose) * 100 : null;
    const volume = parseNumber(row.v);
    const item = {
      code,
      name: String(row.n || "").trim(),
      price: roundNumber(price, 2),
      previousClose: roundNumber(previousClose, 2),
      change: roundNumber(change, 2),
      pctChange: roundNumber(pctChange, 2),
      volume: volume == null ? null : Math.round(volume),
      exchange: String(row.ex || "").trim() || null,
      time: normalizeMisDateTime(row.d, row.t),
    };

    const existing = byCode.get(code);
    if (!existing || (existing.price == null && item.price != null)) {
      byCode.set(code, item);
    }
  }

  return [...byCode.values()];
}

export function normalizeQuoteIndexPayload(payload, requestedIds = ["taiex", "tpex"]) {
  const wanted = new Set(requestedIds.map(String));
  const rows = Array.isArray(payload?.msgArray) ? payload.msgArray : [];
  const byId = new Map();

  for (const row of rows) {
    const index = indexFromChannel(row.ch);
    if (!index || (wanted.size && !wanted.has(index.id))) continue;

    const price = parseNumber(row.z);
    const previousClose = parseNumber(row.y);
    const change = price != null && previousClose != null ? price - previousClose : null;
    const pctChange = change != null && previousClose ? (change / previousClose) * 100 : null;
    const item = {
      id: index.id,
      name: String(row.n || index.name).trim(),
      price: roundNumber(price, 2),
      previousClose: roundNumber(previousClose, 2),
      change: roundNumber(change, 2),
      pctChange: roundNumber(pctChange, 2),
      exchange: String(row.ex || index.exchange).trim() || index.exchange,
      time: normalizeMisDateTime(row.d, row.t),
    };

    const existing = byId.get(index.id);
    if (!existing || (existing.price == null && item.price != null)) {
      byId.set(index.id, item);
    }
  }

  return requestedIds.map((id) => byId.get(id)).filter(Boolean);
}

export function decodeHtml(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const lowered = entity.toLowerCase();
    try {
      if (lowered.startsWith("#x")) {
        const codePoint = Number.parseInt(lowered.slice(2), 16);
        return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
      }
      if (lowered.startsWith("#")) {
        const codePoint = Number.parseInt(lowered.slice(1), 10);
        return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`;
      }
    } catch {
      return `&${entity};`;
    }
    return HTML_ENTITIES[lowered] ?? `&${entity};`;
  });
}

function isValidCodePoint(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function htmlToText(value) {
  return decodeHtml(
    String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractHref(value) {
  const match = String(value || "").match(/\shref\s*=\s*(["'])([\s\S]*?)\1/i);
  return match ? decodeHtml(match[2]).trim() : "";
}

function extractCells(rowHtml) {
  return [...String(rowHtml || "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => ({
      html: match[1],
      text: htmlToText(match[1]),
      href: extractHref(match[1]),
    }));
}

export function normalizeMopsDate(value) {
  const text = htmlToText(value);
  let match = text.match(/^(\d{3})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (match) {
    return `${Number(match[1]) + 1911}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }

  match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }

  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  match = text.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (match) {
    return `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`;
  }

  return null;
}

function mopsSearchUrl(code) {
  const params = new URLSearchParams({
    encodeURIComponent: "1",
    step: "1",
    firstin: "1",
    off: "1",
    queryName: "co_id",
    inpuType: "co_id",
    TYPEK: "all",
    co_id: code,
  });
  return `https://mops.twse.com.tw/mops/web/t05st01?${params.toString()}`;
}

function mopsDetailUrlFromJavascript(href, fallbackCode) {
  const args = [...String(href || "").matchAll(/'([^']*)'|"([^"]*)"/g)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean);
  const params = new URLSearchParams({
    step: "2",
    off: "1",
    firstin: "1",
  });

  for (let index = 0; index < args.length - 1; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "co_id" && /^\d{4,6}$/.test(value)) {
      params.set(key, value);
      index += 1;
    } else if (key === "spoke_date" && /^\d{7,8}$/.test(value)) {
      params.set(key, value);
      index += 1;
    } else if (key === "spoke_time" && /^\d{6}$/.test(value)) {
      params.set(key, value);
      index += 1;
    } else if (key === "seq_no" && /^\d+$/.test(value)) {
      params.set(key, value);
      index += 1;
    }
  }

  if (!params.has("co_id")) params.set("co_id", fallbackCode);
  if (!params.has("spoke_date")) return "";

  return `https://mops.twse.com.tw/mops/web/t05st01?${params.toString()}`;
}

function normalizeMopsUrl(href, code) {
  if (!href) return "";
  if (/^javascript:/i.test(href)) {
    return mopsDetailUrlFromJavascript(href, code);
  }
  try {
    const url = new URL(href, "https://mops.twse.com.tw/mops/web/");
    if (url.protocol !== "https:" || url.hostname !== "mops.twse.com.tw") return "";
    if (!url.pathname.startsWith("/mops/web/t05st01")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function chooseFilingTitle(texts, code, dateText) {
  const ignored = new Set([code, dateText]);
  const candidates = texts.filter((text) => {
    if (!text || ignored.has(text)) return false;
    if (normalizeMopsDate(text)) return false;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return false;
    if (/^\d+$/.test(text)) return false;
    return text.length > 2;
  });

  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

export function normalizeMopsFilings(html, code) {
  const rows = [...String(html || "").matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const filings = [];
  const seen = new Set();

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 2) continue;

    const texts = cells.map((cell) => cell.text).filter(Boolean);
    const dateText = texts.find((text) => normalizeMopsDate(text));
    const date = normalizeMopsDate(dateText);
    if (!date) continue;

    const title = chooseFilingTitle(texts, code, dateText).slice(0, 240);
    if (!title) continue;

    const href = cells.map((cell) => cell.href).find(Boolean) || extractHref(row);
    const url = normalizeMopsUrl(href, code) || mopsSearchUrl(code);
    const key = `${date}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    filings.push({ date, title, url });
  }

  return filings.slice(0, 20);
}

export function normalizeFredDgs10(payload) {
  const observations = Array.isArray(payload?.observations) ? payload.observations : [];
  for (const observation of observations) {
    const value = parseNumber(observation.value);
    if (value != null) {
      return {
        date: String(observation.date || ""),
        value: roundNumber(value, 3),
        units: "percent",
      };
    }
  }
  throw new Error("No numeric DGS10 observation found");
}
