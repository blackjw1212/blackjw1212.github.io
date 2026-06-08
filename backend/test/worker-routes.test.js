import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/worker.js";

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function textResponse(text, init = {}) {
  return new Response(text, {
    status: init.status || 200,
    headers: init.headers || {},
  });
}

async function readJson(response) {
  return response.json();
}

test("health returns literal wildcard CORS when public", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/health", {
      headers: { Origin: "https://example.test" },
    }),
    { ALLOWED_ORIGINS: "*" }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(await readJson(response), {
    ok: true,
    service: "taiwan-risk-tracker-proxy",
  });
});

test("restricted CORS rejects disallowed browser origins", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/eod", {
      headers: { Origin: "https://evil.test" },
    }),
    { ALLOWED_ORIGINS: "https://allowed.test" }
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("eod route normalizes TWSE payload and stamps metadata", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse([
    { Code: "2330", Name: "TSMC", ClosingPrice: "1,010.00", Change: "+5.25" },
  ]));

  const response = await handleRequest(new Request("https://worker.test/eod"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
  assert.equal(response.headers.get("X-Data-Source"), "TWSE OpenAPI STOCK_DAY_ALL");
  assert.deepEqual(await readJson(response), [
    { code: "2330", name: "TSMC", close: 1010, change: 5.25 },
  ]);
});

test("quote route rejects invalid code tokens", async () => {
  const response = await handleRequest(new Request("https://worker.test/quote?codes=2330,bad"), {});
  assert.equal(response.status, 400);
  assert.deepEqual(await readJson(response), {
    error: "Query parameter codes contains invalid Taiwan stock codes",
  });
});

test("quote route canonicalizes code order before upstream fetch", async (t) => {
  let requestedUrl = "";
  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      msgArray: [
        { ch: "tse_2308.tw", c: "2308", n: "Delta", z: "390", y: "392", h: "395", l: "388", o: "392", d: "20260605", t: "13:30:00" },
        { ch: "tse_2330.tw", c: "2330", n: "TSMC", z: "1000", y: "995", h: "1005", l: "990", o: "997", d: "20260605", t: "13:30:00" },
      ],
    });
  });

  const response = await handleRequest(new Request("https://worker.test/quote?codes=2330,2308"), {});
  assert.equal(response.status, 200);
  assert.match(decodeURIComponent(requestedUrl), /ex_ch=tse_2308\.tw\|otc_2308\.tw\|tse_2330\.tw\|otc_2330\.tw/);
  const body = await readJson(response);
  assert.deepEqual(body.quotes.map((quote) => quote.code), ["2308", "2330"]);
  assert.deepEqual(body.quotes.map((quote) => quote.low), [388, 990]);
});

test("quote route serves allowlisted market indices without widening stock codes", async (t) => {
  let requestedUrl = "";
  let requestedHeaders = {};
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    requestedUrl = String(url);
    requestedHeaders = init.headers || {};
    return jsonResponse({
      msgArray: [
        { key: "otc_o00.tw_20260608", ch: "o00.tw", c: "o00", n: "櫃買指數", z: "397.81", y: "364.55", ex: "otc", d: "20260608", t: "09:33:00" },
        { key: "tse_t00.tw_20260608", ch: "t00.tw", c: "t00", n: "發行量加權股價指數", z: "42686.84", y: "40299.74", ex: "tse", d: "20260608", t: "09:33:00" },
        { ch: "tse_2330.tw", c: "2330", n: "TSMC", z: "1000", y: "995", d: "20260608", t: "09:33:00" },
      ],
    });
  });

  const response = await handleRequest(new Request("https://worker.test/quote?indices=tpex,taiex"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=30");
  assert.equal(response.headers.get("X-Data-Source"), "TWSE MIS public quote feed");
  assert.match(decodeURIComponent(requestedUrl), /ex_ch=tse_t00\.tw\|otc_o00\.tw/);
  assert.match(requestedUrl, /json=1/);
  assert.match(requestedUrl, /delay=0/);
  assert.equal(requestedHeaders.Referer, "https://mis.twse.com.tw/stock/index.jsp");

  const body = await readJson(response);
  assert.deepEqual(body.quotes, []);
  assert.deepEqual(body.indices.map((index) => index.id), ["taiex", "tpex"]);
  assert.deepEqual(body.indices.map((index) => index.price), [42686.84, 397.81]);
});

test("quote route rejects unsupported index requests", async () => {
  for (const path of [
    "/quote?indices=foo",
    "/quote?indices=",
    "/quote?codes=2330&indices=taiex",
    "/quote?codes=t00",
    "/quote?codes=TAIEX",
    "/quote?codes=2330%7Cotc_o00.tw",
  ]) {
    const response = await handleRequest(new Request(`https://worker.test${path}`), {});
    assert.equal(response.status, 400, path);
  }
});

test("filings route is removed from the public Worker surface", async () => {
  const response = await handleRequest(new Request("https://worker.test/filings?code=2330"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await readJson(response), { error: "Not found" });
});

const TREASURY_XML = `
  <feed>
    <entry>
      <content type="application/xml">
        <m:properties>
          <d:NEW_DATE m:type="Edm.DateTime">2026-06-04T00:00:00</d:NEW_DATE>
          <d:BC_10YEAR m:type="Edm.Double">4.52</d:BC_10YEAR>
        </m:properties>
      </content>
    </entry>
    <entry>
      <content type="application/xml">
        <m:properties>
          <d:NEW_DATE m:type="Edm.DateTime">2026-06-05T00:00:00</d:NEW_DATE>
          <d:BC_10YEAR m:type="Edm.Double">4.55</d:BC_10YEAR>
        </m:properties>
      </content>
    </entry>
  </feed>
`;

test("yield10y route uses Treasury fallback when FRED secret is missing", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /daily_treasury_yield_curve/);
    return textResponse(TREASURY_XML);
  });

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Data-Source"), "US Treasury Daily Treasury Yield Curve");
  assert.deepEqual(await readJson(response), {
    date: "2026-06-05",
    value: 4.55,
    units: "percent",
    source: "US Treasury Daily Treasury Yield Curve",
    updatedAt: response.headers.get("X-Data-Updated-At"),
  });
});

test("yield10y route prefers FRED when configured", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /api\.stlouisfed\.org/);
    return jsonResponse({
      observations: [
        { date: "2026-06-05", value: "4.123" },
      ],
    });
  });

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {
    FRED_API_KEY: "test-key",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Data-Source"), "FRED DGS10");
  const body = await readJson(response);
  assert.equal(body.value, 4.123);
  assert.equal(body.source, "FRED DGS10");
});

test("yield10y route falls back to Treasury when FRED fails", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    if (String(url).includes("api.stlouisfed.org")) {
      return textResponse("unavailable", { status: 504 });
    }
    return textResponse(TREASURY_XML);
  });

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {
    FRED_API_KEY: "test-key",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Data-Source"), "US Treasury Daily Treasury Yield Curve");
  assert.ok(urls.some((url) => url.includes("api.stlouisfed.org")));
  assert.ok(urls.some((url) => url.includes("daily_treasury_yield_curve")));
});

test("yield10y route does not treat missing Treasury value as zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse(`
    <feed>
      <entry>
        <content><m:properties>
          <d:NEW_DATE m:type="Edm.DateTime">2026-06-05T00:00:00</d:NEW_DATE>
        </m:properties></content>
      </entry>
    </feed>
  `));

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {});
  assert.equal(response.status, 502);
  assert.deepEqual(await readJson(response), {
    error: "Upstream unavailable",
  });
});

test("yield10y route tries previous Treasury month when current month has no value", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return textResponse("<feed></feed>");
    }
    return textResponse(TREASURY_XML);
  });

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {});
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).value, 4.55);
  assert.equal(urls.length, 2);
});

test("yield10y route returns safe error when Treasury fallback fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse("unavailable", { status: 503 }));

  const response = await handleRequest(new Request("https://worker.test/yield10y"), {});
  assert.equal(response.status, 502);
  assert.deepEqual(await readJson(response), {
    error: "Upstream unavailable",
  });
});
