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
        { ch: "tse_2308.tw", c: "2308", n: "Delta", z: "390", y: "392", d: "20260605", t: "13:30:00" },
        { ch: "tse_2330.tw", c: "2330", n: "TSMC", z: "1000", y: "995", d: "20260605", t: "13:30:00" },
      ],
    });
  });

  const response = await handleRequest(new Request("https://worker.test/quote?codes=2330,2308"), {});
  assert.equal(response.status, 200);
  assert.match(decodeURIComponent(requestedUrl), /ex_ch=tse_2308\.tw\|otc_2308\.tw\|tse_2330\.tw\|otc_2330\.tw/);
  const body = await readJson(response);
  assert.deepEqual(body.quotes.map((quote) => quote.code), ["2308", "2330"]);
});

test("filings route normalizes MOPS HTML", async (t) => {
  t.mock.method(globalThis, "fetch", async () => textResponse(`
    <table>
      <tr>
        <td>115/06/05</td>
        <td>18:21:10</td>
        <td>2330</td>
        <td><a href="javascript:openWindow('co_id','2330','spoke_date','20260605','spoke_time','182110','seq_no','1')">Board update</a></td>
      </tr>
    </table>
  `));

  const response = await handleRequest(new Request("https://worker.test/filings?code=2330"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), [
    {
      date: "2026-06-05",
      title: "Board update",
      url: "https://mops.twse.com.tw/mops/web/t05st01?step=2&off=1&firstin=1&co_id=2330&spoke_date=20260605&spoke_time=182110&seq_no=1",
    },
  ]);
});

test("yield10y route reports missing secret without exposing internals", async () => {
  const response = await handleRequest(new Request("https://worker.test/yield10y"), {});
  assert.equal(response.status, 500);
  assert.deepEqual(await readJson(response), {
    error: "Yield source is not configured",
  });
});
