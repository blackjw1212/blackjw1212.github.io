import test from "node:test";
import assert from "node:assert/strict";
import { mergeFeed, normalizeEod, parseTradingDate, fetchMisQuotes } from "../../scripts/update-stock-risk-feed.mjs";

const CODES = ["2330", "2317", "6669", "3017", "3324", "2382", "1519", "2308", "3231", "3661", "2356", "2376"];
const NOW = "2026-06-29T13:30:00.000Z";
const PREV_AT = "2026-06-26T08:00:00.000Z";

function fullPrevious() {
  return {
    updatedAt: PREV_AT,
    eodUpdatedAt: PREV_AT,
    eod: CODES.map((code) => ({ code, name: code, close: 100, change: 1 })),
    valuation: Object.fromEntries(CODES.map((code) => [code, { code, pe: 20 }])),
    yield10y: { date: "2026-06-26", value: 4.4, source: "prev" },
  };
}

test("total upstream failure keeps all previous eod/valuation/yield", () => {
  const merged = mergeFeed(fullPrevious(), { eod: [], valuation: {}, yield10y: null }, NOW);
  assert.equal(merged.eod.length, 12);
  assert.equal(Object.keys(merged.valuation).length, 12);
  assert.deepEqual(merged.yield10y, { date: "2026-06-26", value: 4.4, source: "prev" });
  assert.equal(merged.eodUpdatedAt, PREV_AT, "stale timestamp retained when nothing fresh");
  assert.equal(merged.preserved.eod, 12);
  assert.equal(merged.preserved.valuation, 12);
  assert.equal(merged.preserved.yield10y, 1);
});

test("partial fetch overlays fresh and preserves the rest", () => {
  const fetched = {
    eod: [{ code: "3324", name: "雙鴻", close: 995, change: 25 }],
    valuation: { "3324": { code: "3324", pe: 28.7 } },
    yield10y: { date: "2026-06-29", value: 4.49, source: "fresh" },
  };
  const merged = mergeFeed(fullPrevious(), fetched, NOW);
  assert.equal(merged.eod.length, 12, "all codes retained");
  assert.equal(merged.eod.find((r) => r.code === "3324").close, 995, "fresh row used");
  assert.equal(merged.eod.find((r) => r.code === "2330").close, 100, "missing code kept from previous");
  assert.equal(merged.valuation["3324"].pe, 28.7);
  assert.deepEqual(merged.yield10y, { date: "2026-06-29", value: 4.49, source: "fresh" });
  assert.equal(merged.eodUpdatedAt, PREV_AT, "not fully fresh → keep previous timestamp");
  assert.equal(merged.preserved.eod, 11);
  assert.equal(merged.preserved.valuation, 11);
  assert.equal(merged.preserved.yield10y, 0);
});

test("full fresh fetch stamps now and preserves nothing", () => {
  const fetched = {
    eod: CODES.map((code) => ({ code, name: code, close: 200, change: -2 })),
    valuation: Object.fromEntries(CODES.map((code) => [code, { code, pe: 18 }])),
    yield10y: { date: "2026-06-29", value: 4.49, source: "fresh" },
  };
  const merged = mergeFeed(fullPrevious(), fetched, NOW);
  assert.equal(merged.eodUpdatedAt, NOW);
  assert.equal(merged.eod[0].close, 200);
  assert.equal(merged.preserved.eod, 0);
  assert.equal(merged.preserved.valuation, 0);
});

test("cold start with empty fetch yields empty feed and null timestamp", () => {
  const merged = mergeFeed({}, { eod: [], valuation: {}, yield10y: null }, NOW);
  assert.equal(merged.eod.length, 0);
  assert.deepEqual(merged.valuation, {});
  assert.equal(merged.yield10y, null);
  assert.equal(merged.eodUpdatedAt, null);
  assert.equal(merged.eodTradingDate, null);
});

test("trading date parses ROC, MIS and ISO shapes", () => {
  assert.equal(parseTradingDate("1150717"), "2026-07-17", "TWSE/TPEX 民國日期");
  assert.equal(parseTradingDate("20260717"), "2026-07-17", "MIS 西元日期");
  assert.equal(parseTradingDate("2026-07-17"), "2026-07-17", "already ISO");
  assert.equal(parseTradingDate(""), null);
  assert.equal(parseTradingDate("not-a-date"), null);
});

test("normalizeEod keeps the upstream trading date", () => {
  const rows = normalizeEod([
    { Date: "1150717", Code: "2330", Name: "台積電", ClosingPrice: "2290.00", Change: "-180.0000" },
    { Code: "2317", Name: "鴻海", ClosingPrice: "234.00", Change: "-8.5" },
  ]);
  assert.equal(rows.find((r) => r.code === "2330").date, "2026-07-17");
  assert.equal("date" in rows.find((r) => r.code === "2317"), false, "no date when upstream omits it");
});

test("mergeFeed reports the latest trading date across rows", () => {
  const fetched = {
    eod: [
      { code: "2330", name: "台積電", close: 2290, change: -180, date: "2026-07-17" },
      { code: "2317", name: "鴻海", close: 234, change: -8.5, date: "2026-07-16" },
    ],
    valuation: {},
    yield10y: null,
  };
  const merged = mergeFeed({}, fetched, NOW);
  assert.equal(merged.eodTradingDate, "2026-07-17", "takes the newest row date, not the oldest");
});

test("stale rows do not drag the trading date backwards", () => {
  const previous = { ...fullPrevious(), eod: CODES.map((code) => ({ code, name: code, close: 100, change: 1, date: "2026-07-10" })) };
  const merged = mergeFeed(previous, {
    eod: [{ code: "3324", name: "雙鴻", close: 995, change: 25, date: "2026-07-17" }],
    valuation: {},
    yield10y: null,
  }, NOW);
  assert.equal(merged.eodTradingDate, "2026-07-17");
  assert.equal(merged.eod.find((r) => r.code === "2330").date, "2026-07-10", "preserved rows keep their own date");
});

test("MIS quotes normalize close, computed change and date; blank quotes skipped", async () => {
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes("tse_")
      ? { msgArray: [
          { c: "2330", n: "台積電", z: "2290.0000", y: "2470.0000", d: "20260717" },
          { c: "2317", n: "鴻海", z: "-", y: "242.5000", d: "20260717" },
        ] }
      : { msgArray: [{ c: "3324", n: "雙鴻", z: "913.0000", y: "900.0000", d: "20260717" }] }),
  });
  const quotes = await fetchMisQuotes(["2330", "2317", "3324"], fakeFetch);
  assert.deepEqual(quotes.get("2330"), { code: "2330", name: "台積電", close: 2290, change: -180, date: "2026-07-17" });
  assert.equal(quotes.has("2317"), false, "no-trade quote ('-') is skipped, not written as 0");
  assert.equal(quotes.get("3324").close, 913, "OTC code resolved through the otc_ channel");
});

test("MIS failure is tolerated and never throws into the feed", async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => fetchMisQuotes(["2330"], failing), /HTTP 403/, "caller decides; main() catches this");
});
