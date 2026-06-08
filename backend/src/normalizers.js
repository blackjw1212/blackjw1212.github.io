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

function channelMatches(value, suffix) {
  const normalized = String(value || "").toLowerCase();
  if (!normalized) return false;
  if (normalized === suffix) return true;
  if (normalized.startsWith(`${suffix}_`)) return true;
  return normalized.endsWith(`_${suffix}`) || normalized.endsWith(`|${suffix}`);
}

function indexFromRow(row) {
  if (channelMatches(row?.key, "tse_t00.tw")) return MIS_INDEXES["tse_t00.tw"];
  if (channelMatches(row?.key, "otc_o00.tw")) return MIS_INDEXES["otc_o00.tw"];

  const ch = String(row?.ch || row?.["@"] || "").toLowerCase();
  const code = String(row?.c || "").toLowerCase();
  const exchange = String(row?.ex || "").toLowerCase();
  if (exchange === "tse" && (ch === "t00.tw" || code === "t00")) return MIS_INDEXES["tse_t00.tw"];
  if (exchange === "otc" && (ch === "o00.tw" || code === "o00")) return MIS_INDEXES["otc_o00.tw"];

  for (const [suffix, index] of Object.entries(MIS_INDEXES)) {
    if (channelMatches(row?.ch, suffix) || channelMatches(row?.["@"], suffix)) return index;
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
    const high = parseNumber(row.h);
    const low = parseNumber(row.l);
    const open = parseNumber(row.o);
    const change = price != null && previousClose != null ? price - previousClose : null;
    const pctChange = change != null && previousClose ? (change / previousClose) * 100 : null;
    const volume = parseNumber(row.v);
    const item = {
      code,
      name: String(row.n || "").trim(),
      price: roundNumber(price, 2),
      close: roundNumber(price, 2),
      previousClose: roundNumber(previousClose, 2),
      high: roundNumber(high, 2),
      low: roundNumber(low, 2),
      open: roundNumber(open, 2),
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
    const index = indexFromRow(row);
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
