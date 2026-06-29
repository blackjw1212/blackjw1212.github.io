import test from "node:test";
import assert from "node:assert/strict";
import { mergeFeed } from "../../scripts/update-stock-risk-feed.mjs";

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
});
