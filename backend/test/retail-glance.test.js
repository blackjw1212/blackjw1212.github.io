import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadRetailConsole() {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "inline script must be present");

  const context = vm.createContext({
    console,
    Intl,
    localStorage: {
      _: {},
      getItem(key) { return this._[key] || null; },
      setItem(key, value) { this._[key] = String(value); },
    },
    location: {
      search: "?proxy=https://evil.example",
      hostname: "blackjw1212.github.io",
    },
    URL,
    URLSearchParams,
  });
  vm.runInContext(script, context, { filename: "index.html" });
  assert.ok(context.RetailConsole, "RetailConsole should be exported without document");
  return context.RetailConsole;
}

test("retail glance holdingStatus rules stay conservative", () => {
  const { helpers } = loadRetailConsole();

  assert.equal(helpers.holdingStatus(-12, 10, 30).tone, "r");
  assert.equal(helpers.holdingStatus(35, 10, 30).tone, "a");
  assert.equal(helpers.holdingStatus(5, 10, 30).tone, "g");
  assert.equal(helpers.holdingStatus(null, 10, 30).tone, "n");
  assert.equal(helpers.holdingStatus(-10, 10, 30).tone, "r");
  const unsafeTerms = ["停" + "損", "停" + "利", "減" + "碼", "買" + "進", "賣" + "出", "加" + "碼"];
  const unsafePattern = new RegExp(unsafeTerms.join("|"));
  assert.doesNotMatch(helpers.holdingStatus(-12, 10, 30).label, unsafePattern);
  assert.doesNotMatch(helpers.holdingStatus(35, 10, 30).label, unsafePattern);
});

test("retail glance plPct computes and guards", () => {
  const { helpers } = loadRetailConsole();

  assert.equal(helpers.plPct(2100, 2385), 13.6);
  assert.equal(helpers.plPct(0, 2385), null);
  assert.equal(helpers.plPct(2500, null), null);
});

test("retail glance marketTone is conservative", () => {
  const { helpers } = loadRetailConsole();

  assert.equal(helpers.marketTone(0, Number.NaN, false).tone, "n");
  assert.equal(helpers.marketTone(0.625, 4.4, true).tone, "g");
  assert.equal(helpers.marketTone(0.125, 4.8, true).tone, "r");
  assert.equal(helpers.marketTone(0.5, 4.55, true).tone, "a");
});

test("retail glance bodyStars maps six-dimension scores", () => {
  const { helpers } = loadRetailConsole();

  assert.equal(helpers.bodyStars(["m", "h", "h", "m", "h", "h"]), 4);
  assert.equal(helpers.bodyStars(["l", "l", "h", "h", "mh", "mh"]), 3);
  assert.ok(helpers.bodyStars(["l", "l", "l", "l", "l", "l"]) >= 1);
});

test("retail glance valTag maps valuation score", () => {
  const { helpers } = loadRetailConsole();

  assert.equal(helpers.valTag("h").cls, "cheap");
  assert.equal(helpers.valTag("m").cls, "fair");
  assert.equal(helpers.valTag("l").cls, "rich");
});

test("retail glance normalizers handle EOD and yield shapes", () => {
  const { helpers } = loadRetailConsole();
  const out = helpers.normalizeEodRows([{ Code: "2330", ClosingPrice: "1,234.5", Change: "+5.0" }]);

  assert.equal(out["2330"].close, 1234.5);
  assert.equal(out["2330"].change, 5);
  assert.equal(helpers.normalizeYield({ value: "4.55" }), 4.55);
  assert.equal(helpers.normalizeYield({ body: { value: "4.6" } }), 4.6);
  assert.equal(helpers.normalizeYield({ data: { value: 4.7 } }), 4.7);
  assert.equal(helpers.normalizeYield({}), null);
});

test("retail glance proxyBase ignores unapproved query proxy", () => {
  const retail = loadRetailConsole();

  assert.equal(retail.proxyBase(), "https://taiwan-risk-tracker-proxy.a0926043323.workers.dev");
});

test("retail glance mopsUrl points only to official MOPS over https", () => {
  const { helpers } = loadRetailConsole();
  const url = new URL(helpers.mopsUrl("2330"));

  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "mops.twse.com.tw");
  assert.equal(url.searchParams.get("co_id"), "2330");
});

test("retail glance tradingViewUrl points only to allowlisted symbols", () => {
  const { helpers } = loadRetailConsole();
  const twse = new URL(helpers.tradingViewUrl("2330"));
  const tpex = new URL(helpers.tradingViewUrl("3324"));

  assert.equal(twse.protocol, "https:");
  assert.equal(twse.hostname, "tw.tradingview.com");
  assert.equal(twse.pathname, "/chart/");
  assert.equal(twse.searchParams.get("symbol"), "TWSE:2330");
  assert.match(helpers.tradingViewUrl("2330"), /symbol=TWSE%3A2330/);
  assert.equal(tpex.protocol, "https:");
  assert.equal(tpex.hostname, "tw.tradingview.com");
  assert.equal(tpex.pathname, "/chart/");
  assert.equal(tpex.searchParams.get("symbol"), "TPEX:3324");
  assert.match(helpers.tradingViewUrl("3324"), /symbol=TPEX%3A3324/);
  for (const code of ["9999", "https://evil.example", "2330/../../evil", "2330?next=https://evil.example"]) {
    assert.equal(helpers.tradingViewUrl(code), "");
  }
});
