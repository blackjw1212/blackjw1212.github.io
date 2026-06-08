import assert from "node:assert/strict";
import test from "node:test";

import weatherWorker from "../../weather-proxy/src/index.js";

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function installCache(t, cachedResponse = null) {
  const puts = [];
  globalThis.caches = {
    default: {
      async match() {
        return cachedResponse;
      },
      async put(key, response) {
        puts.push({ key, response });
      },
    },
  };
  t.after(() => {
    delete globalThis.caches;
  });
  return { puts };
}

function createCtx() {
  const waits = [];
  return {
    waits,
    waitUntil(promise) {
      waits.push(Promise.resolve(promise));
    },
  };
}

test("weather health reports whether the proxy secret is configured", async () => {
  const response = await weatherWorker.fetch(
    new Request("https://weather.test/health"),
    { CWA_API_KEY: "secret" },
    createCtx()
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true });
});

test("weather api proxy strips caller authorization and injects the Worker secret", async (t) => {
  const cache = installCache(t);
  const ctx = createCtx();
  let requestedUrl = "";

  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ ok: true });
  });

  const response = await weatherWorker.fetch(
    new Request("https://weather.test/api/F-D0047-057?Authorization=caller-key&LocationName=Taipei", {
      headers: { Origin: "https://blackjw1212.github.io" },
    }),
    { CWA_API_KEY: "worker-secret" },
    ctx
  );
  await Promise.all(ctx.waits);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://blackjw1212.github.io");
  assert.equal(response.headers.get("X-BJKW-Weather-Cache"), "MISS");
  assert.match(requestedUrl, /^https:\/\/opendata\.cwa\.gov\.tw\/api\/v1\/rest\/datastore\/F-D0047-057\?/);
  assert.match(requestedUrl, /LocationName=Taipei/);
  assert.match(requestedUrl, /Authorization=worker-secret/);
  assert.doesNotMatch(requestedUrl, /caller-key/);
  assert.equal(cache.puts.length, 1);
  assert.doesNotMatch(cache.puts[0].key.url, /worker-secret|caller-key/);
});

test("weather file proxy uses the file upstream allowlist", async (t) => {
  installCache(t);
  const ctx = createCtx();
  let requestedUrl = "";

  t.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ ok: true });
  });

  const response = await weatherWorker.fetch(
    new Request("https://weather.test/file/F-D0047-095?format=XML"),
    {
      CWA_API_KEY: "worker-secret",
      CWA_FILE_BASE_URL: "https://file.example.test/root",
    },
    ctx
  );

  assert.equal(response.status, 200);
  assert.match(requestedUrl, /^https:\/\/file\.example\.test\/root\/F-D0047-095\?/);
  assert.match(requestedUrl, /Authorization=worker-secret/);
  assert.match(requestedUrl, /format=JSON/);
});

test("weather proxy rejects endpoints outside the retained page contract", async () => {
  const response = await weatherWorker.fetch(
    new Request("https://weather.test/api/F-D0047-999"),
    { CWA_API_KEY: "secret" },
    createCtx()
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("weather proxy fails closed when the secret is missing", async () => {
  const response = await weatherWorker.fetch(
    new Request("https://weather.test/api/F-D0047-057"),
    {},
    createCtx()
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "proxy_not_configured" });
});
