import {
  normalizeFredDgs10,
  normalizeMopsFilings,
  normalizeQuotePayload,
  normalizeTwseEod,
} from "./normalizers.js";

const ENDPOINTS = {
  eod: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
  fred: "https://api.stlouisfed.org/fred/series/observations",
  mops: "https://mops.twse.com.tw/mops/web/ajax_t05st01",
  quote: "https://mis.twse.com.tw/stock/api/getStockInfo.jsp",
};

const CACHE_TTL = {
  eod: 60,
  filings: 60,
  quote: 30,
  yield10y: 60,
};

const BODY_LIMITS = {
  json: 2_000_000,
  mopsHtml: 1_000_000,
};

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    if (!isOriginAllowed(request, env)) {
      return new Response(null, { status: 403, headers: securityHeaders() });
    }
    return withCors(new Response(null, { status: 204 }), request, env);
  }

  if (request.method !== "GET") {
    return jsonError("Method not allowed", 405, request, env);
  }

  if (!isOriginAllowed(request, env)) {
    return jsonError("Origin not allowed", 403, request, env);
  }

  try {
    if (url.pathname === "/health") {
      return json({ ok: true, service: "taiwan-risk-tracker-proxy" }, 200, request, env);
    }
    if (url.pathname === "/eod") {
      return await cachedJson(request, env, ctx, "eod", CACHE_TTL.eod, () => loadEod());
    }
    if (url.pathname === "/quote") {
      const codes = parseCodes(url.searchParams.get("codes"));
      if (codes.error) return jsonError(codes.error, 400, request, env);
      if (!codes.values.length) return jsonError("Query parameter codes is required", 400, request, env);
      return await cachedJson(request, env, ctx, `quote:${codes.values.join(",")}`, CACHE_TTL.quote, () => loadQuotes(codes.values));
    }
    if (url.pathname === "/filings") {
      const code = parseSingleCode(url.searchParams.get("code"));
      if (!code) return jsonError("Query parameter code must be a Taiwan stock code", 400, request, env);
      return await cachedJson(request, env, ctx, `filings:${code}`, CACHE_TTL.filings, () => loadFilings(code));
    }
    if (url.pathname === "/yield10y") {
      return await cachedJson(request, env, ctx, "yield10y", CACHE_TTL.yield10y, () => loadYield10y(env));
    }
    return jsonError("Not found", 404, request, env);
  } catch (error) {
    const status = error.status === 504 || error.name === "AbortError" ? 504 : error.status || 502;
    const message = error.publicMessage || (status === 504 ? "Upstream timed out" : "Upstream unavailable");
    return jsonError(message, status, request, env);
  }
}

function configuredOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "*").trim();
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function isPublicCors(env) {
  return configuredOrigins(env).includes("*");
}

function isOriginAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || isPublicCors(env)) return true;
  return configuredOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const origins = configuredOrigins(env);
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Data-Delay, X-Data-Source, X-Data-Updated-At",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };

  if (isPublicCors(env)) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = origins[0] || "";
  } else if (origins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status, request, env, meta = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": meta.cacheControl || "no-store",
    ...securityHeaders(),
  });
  if (meta.source) headers.set("X-Data-Source", meta.source);
  if (meta.delay) headers.set("X-Data-Delay", meta.delay);
  if (meta.updatedAt) headers.set("X-Data-Updated-At", meta.updatedAt);
  return withCors(new Response(JSON.stringify(data), { status, headers }), request, env);
}

function jsonError(message, status, request, env) {
  return json({ error: message }, status, request, env);
}

async function cachedJson(request, env, ctx, key, ttl, loader) {
  const cacheKey = new Request(`https://cache.local/${encodeURIComponent(key)}`);
  const cache = globalThis.caches?.default;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, request, env);
  }

  const loaded = await loader();
  const response = json(loaded.body, 200, request, env, {
    ...loaded.meta,
    cacheControl: `public, max-age=${ttl}`,
  });

  if (cache) {
    ctx.waitUntil?.(cache.put(cacheKey, response.clone()));
  }

  return response;
}

function parseSingleCode(value) {
  const code = String(value || "").trim();
  return /^\d{4,6}$/.test(code) ? code : "";
}

function parseCodes(value) {
  const tokens = String(value || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  const invalid = tokens.filter((code) => !/^\d{4,6}$/.test(code));
  if (invalid.length) {
    return { values: [], error: "Query parameter codes contains invalid Taiwan stock codes" };
  }
  return {
    values: [...new Set(tokens)].sort().slice(0, 40),
    error: "",
  };
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs || 6500;
  const retries = options.retries ?? 1;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.status >= 500 && attempt < retries) {
        response.body?.cancel?.();
        lastError = new Error(`Upstream returned HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Upstream request failed");
}

async function loadJson(url, init, label) {
  const response = await fetchWithRetry(url, init, { timeoutMs: 6500, retries: 1 });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const text = await readBodyText(response, label, BODY_LIMITS.json, 5000);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.status = 504;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyText(response, label, maxBytes, timeoutMs) {
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`${label} response is too large`);
  }

  return withTimeout(readBodyTextUnbounded(response, maxBytes, label), timeoutMs, `${label} body read timed out`);
}

async function readBodyTextUnbounded(response, maxBytes, label) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const size = new TextEncoder().encode(text).byteLength;
    if (size > maxBytes) throw new Error(`${label} response is too large`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response is too large`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock?.();
  }

  return chunks.join("");
}

async function loadEod() {
  const payload = await loadJson(
    ENDPOINTS.eod,
    { headers: { Accept: "application/json" } },
    "TWSE EOD"
  );
  const data = normalizeTwseEod(payload);
  const updatedAt = new Date().toISOString();
  return {
    body: data,
    meta: {
      source: "TWSE OpenAPI STOCK_DAY_ALL",
      delay: "End-of-day close data",
      updatedAt,
    },
  };
}

function quoteChannels(codes) {
  return codes.flatMap((code) => [`tse_${code}.tw`, `otc_${code}.tw`]).join("|");
}

async function loadQuotes(codes) {
  const url = new URL(ENDPOINTS.quote);
  url.searchParams.set("ex_ch", quoteChannels(codes));
  url.searchParams.set("json", "1");
  url.searchParams.set("delay", "0");
  url.searchParams.set("_", String(Date.now()));

  const payload = await loadJson(
    url.href,
    {
      headers: {
        Accept: "application/json",
        Referer: "https://mis.twse.com.tw/stock/index.jsp",
      },
    },
    "TWSE MIS quote"
  );
  const updatedAt = new Date().toISOString();
  return {
    body: {
      quotes: normalizeQuotePayload(payload, codes),
      source: "TWSE MIS public quote feed",
      delay: "Intraday public feed; delivery and delay depend on TWSE MIS availability and policy",
      updatedAt,
    },
    meta: {
      source: "TWSE MIS public quote feed",
      delay: "Intraday public feed; delivery and delay depend on TWSE MIS availability and policy",
      updatedAt,
    },
  };
}

async function loadFilings(code) {
  const form = new URLSearchParams({
    encodeURIComponent: "1",
    step: "1",
    firstin: "1",
    off: "1",
    keyword4: "",
    code1: "",
    TYPEK2: "",
    checkbtn: "",
    queryName: "co_id",
    inpuType: "co_id",
    TYPEK: "all",
    co_id: code,
  });

  const response = await fetchWithRetry(ENDPOINTS.mops, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: "https://mops.twse.com.tw",
      Referer: "https://mops.twse.com.tw/mops/web/t05st01",
      "User-Agent": "taiwan-risk-tracker-worker",
    },
    body: form.toString(),
  }, { timeoutMs: 7500, retries: 1 });

  if (!response.ok) throw new Error(`MOPS filings returned HTTP ${response.status}`);
  const html = await readBodyText(response, "MOPS filings", BODY_LIMITS.mopsHtml, 5000);
  const updatedAt = new Date().toISOString();
  return {
    body: normalizeMopsFilings(html, code),
    meta: {
      source: "MOPS t05st01 material information",
      delay: "Latest available MOPS disclosure data",
      updatedAt,
    },
  };
}

async function loadYield10y(env) {
  if (!env.FRED_API_KEY) {
    const error = new Error("FRED_API_KEY is not configured");
    error.status = 500;
    error.publicMessage = "Yield source is not configured";
    throw error;
  }

  const url = new URL(ENDPOINTS.fred);
  url.searchParams.set("series_id", "DGS10");
  url.searchParams.set("api_key", env.FRED_API_KEY);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "10");

  const payload = await loadJson(url.href, { headers: { Accept: "application/json" } }, "FRED DGS10");
  const updatedAt = new Date().toISOString();
  return {
    body: {
      ...normalizeFredDgs10(payload),
      source: "FRED DGS10",
      updatedAt,
    },
    meta: {
      source: "FRED DGS10",
      delay: "Daily FRED publication cadence",
      updatedAt,
    },
  };
}
