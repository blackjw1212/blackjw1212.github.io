const ALLOWED_DATASTORE_ENDPOINTS = new Set([
  "O-A0001-001",
  "F-A0021-001",
  "A-B0062-001",
  "F-D0047-001",
  "F-D0047-005",
  "F-D0047-009",
  "F-D0047-013",
  "F-D0047-017",
  "F-D0047-021",
  "F-D0047-025",
  "F-D0047-029",
  "F-D0047-033",
  "F-D0047-037",
  "F-D0047-041",
  "F-D0047-045",
  "F-D0047-049",
  "F-D0047-053",
  "F-D0047-057",
  "F-D0047-061",
  "F-D0047-065",
  "F-D0047-069",
  "F-D0047-073",
  "F-D0047-077",
  "F-D0047-081",
  "F-D0047-085",
]);

const ALLOWED_FILE_ENDPOINTS = new Set([
  "F-D0047-095",
]);

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = env.ALLOWED_ORIGIN || "https://blackjw1212.github.io";
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };

  if (origin === allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(body, status, env, request, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request),
      ...extraHeaders,
    },
  });
}

function getEndpoint(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return "";
  return decodeURIComponent(pathname.slice(prefix.length)).replace(/^\/+|\/+$/g, "");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405, env, request);
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, configured: Boolean(env.CWA_API_KEY) }, 200, env, request);
    }

    const fileEndpoint = getEndpoint(url.pathname, "/file/");
    const apiEndpoint = getEndpoint(url.pathname, "/api/");
    const endpoint = fileEndpoint || apiEndpoint;
    const isFileApi = Boolean(fileEndpoint);
    const allowed = isFileApi ? ALLOWED_FILE_ENDPOINTS : ALLOWED_DATASTORE_ENDPOINTS;
    if (!endpoint || !allowed.has(endpoint)) {
      return jsonResponse({ error: "not_found" }, 404, env, request);
    }

    if (!env.CWA_API_KEY) {
      return jsonResponse({ error: "proxy_not_configured" }, 503, env, request);
    }

    const upstreamBase = isFileApi
      ? env.CWA_FILE_BASE_URL || "https://opendata.cwa.gov.tw/fileapi/v1/opendataapi"
      : env.CWA_BASE_URL || "https://opendata.cwa.gov.tw/api/v1/rest/datastore";
    const upstream = new URL(`${upstreamBase.replace(/\/+$/, "")}/${endpoint}`);

    for (const [key, value] of url.searchParams) {
      if (key.toLowerCase() === "authorization") continue;
      upstream.searchParams.set(key, value);
    }
    upstream.searchParams.set("Authorization", env.CWA_API_KEY);
    upstream.searchParams.set("format", "JSON");

    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = `/__cache/${isFileApi ? "file" : "api"}/${endpoint}`;
    cacheUrl.search = upstream.search;
    cacheUrl.searchParams.delete("Authorization");
    const cacheKey = new Request(cacheUrl.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      for (const [key, value] of Object.entries(corsHeaders(env, request))) {
        headers.set(key, value);
      }
      headers.set("X-BJKW-Weather-Cache", "HIT");
      return new Response(cached.body, {
        status: cached.status,
        headers,
      });
    }

    const upstreamResponse = await fetch(upstream, {
      headers: { "Accept": "application/json" },
    });

    const responseHeaders = {
      "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": upstreamResponse.ok ? "public, max-age=60" : "no-store",
      ...corsHeaders(env, request),
      "X-BJKW-Weather-Cache": "MISS",
    };

    const response = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });

    if (upstreamResponse.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
