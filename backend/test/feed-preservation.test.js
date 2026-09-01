import test from "node:test";
import assert from "node:assert/strict";
import { mergeFeed, normalizeEod, parseTradingDate, fetchMisQuotes } from "../../scripts/update-stock-risk-feed.mjs";
import { preserveMarketRows, fetchJson as marketFetchJson } from "../../scripts/update-market-feed.mjs";
import { preserveEtfMarketRows, fetchJson as etfFetchJson } from "../../scripts/update-etf-feed.mjs";

const CODES = ["2330", "2317", "6669", "3017", "3324", "2382", "1519", "2308", "3231", "3661", "2356", "2376", "6239"];
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
  assert.equal(merged.eod.length, 13);
  assert.equal(Object.keys(merged.valuation).length, 13);
  assert.deepEqual(merged.yield10y, { date: "2026-06-26", value: 4.4, source: "prev" });
  assert.equal(merged.eodUpdatedAt, PREV_AT, "stale timestamp retained when nothing fresh");
  assert.equal(merged.preserved.eod, 13);
  assert.equal(merged.preserved.valuation, 13);
  assert.equal(merged.preserved.yield10y, 1);
});

test("partial fetch overlays fresh and preserves the rest", () => {
  const fetched = {
    eod: [{ code: "3324", name: "雙鴻", close: 995, change: 25 }],
    valuation: { "3324": { code: "3324", pe: 28.7 } },
    yield10y: { date: "2026-06-29", value: 4.49, source: "fresh" },
  };
  const merged = mergeFeed(fullPrevious(), fetched, NOW);
  assert.equal(merged.eod.length, 13, "all codes retained");
  assert.equal(merged.eod.find((r) => r.code === "3324").close, 995, "fresh row used");
  assert.equal(merged.eod.find((r) => r.code === "2330").close, 100, "missing code kept from previous");
  assert.equal(merged.valuation["3324"].pe, 28.7);
  assert.deepEqual(merged.yield10y, { date: "2026-06-29", value: 4.49, source: "fresh" });
  assert.equal(merged.eodUpdatedAt, PREV_AT, "not fully fresh → keep previous timestamp");
  assert.equal(merged.preserved.eod, 12);
  assert.equal(merged.preserved.valuation, 12);
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

test("mergeFeed dates the feed by its oldest row, never its newest", () => {
  const fetched = {
    eod: [
      { code: "2330", name: "台積電", close: 2290, change: -180, date: "2026-07-17" },
      { code: "2317", name: "鴻海", close: 234, change: -8.5, date: "2026-07-16" },
    ],
    valuation: {},
    yield10y: null,
  };
  const merged = mergeFeed({}, fetched, NOW);
  // 取最大值會讓 2317 掛著它自己沒有的日期。首頁把這個值印成「07/17 收盤」，
  // 全市場 feed 早就因為同樣的寫法讓上千檔股票掛錯日期而改成取最小值，這裡是同一個坑。
  assert.equal(merged.eodTradingDate, "2026-07-16", "沒有任何一列比這個日期更舊");
});

test("preserved stale rows drag the trading date back, because they really are stale", () => {
  const previous = { ...fullPrevious(), eod: CODES.map((code) => ({ code, name: code, close: 100, change: 1, date: "2026-07-10" })) };
  const merged = mergeFeed(previous, {
    eod: [{ code: "3324", name: "雙鴻", close: 995, change: 25, date: "2026-07-17" }],
    valuation: {},
    yield10y: null,
  }, NOW);
  // 十二列還停在 07-10，只有 3324 是 07-17。標成 07-17 等於宣稱全部都是那天的資料。
  assert.equal(merged.eodTradingDate, "2026-07-10");
  assert.equal(merged.eod.find((r) => r.code === "2330").date, "2026-07-10", "preserved rows keep their own date");
});

// MIS 的 z 在盤中是「當下成交價」，不是收盤價。這支 workflow 的 cron 是
// `*/30 0-10 * * 1-5`（台灣 08:00–18:30 每半小時），橫跨整個交易時段，所以沒有這道閘
// 的話每個交易日都會發生：實測 2026-09-01 10:33 抓到 2308 台達電寫成
// `date 2026-09-01, close 1855`，而當下 MIS 的 y（08/31 收盤）是 1840、z（盤中）是 1845。
// 台股 13:30 收盤，判準用台北牆鐘、不用每列的 t——冷門股最後一筆成交可能停在上午，
// 用 t 當判準會把它們永遠擋在門外。台灣無日光節約，固定 UTC+8。
test("MIS quotes are only a close after the session ends", async () => {
  const payload = { msgArray: [{ c: "2330", n: "台積電", z: "2290.0000", y: "2470.0000", d: "20260717" }] };
  const fakeFetch = async () => ({ ok: true, json: async () => payload });
  const at = (iso) => fetchMisQuotes(["2330"], fakeFetch, new Date(iso));

  assert.equal((await at("2026-07-17T02:33:00Z")).size, 0, "台北 10:33 盤中：z 是即時價，不可寫進 feed");
  assert.equal((await at("2026-07-17T05:29:00Z")).size, 0, "台北 13:29 收盤前一分鐘仍是盤中");
  assert.equal((await at("2026-07-17T05:30:00Z")).size, 1, "台北 13:30 收盤，這一刻起 z 是收盤價");
  assert.equal((await at("2026-07-17T06:00:00Z")).get("2330").close, 2290, "台北 14:00 正常採用");
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
  // 固定在收盤後（台北 14:00）：不釘死時刻的話，這條測試的結果會隨著跑的時間而變。
  const quotes = await fetchMisQuotes(["2330", "2317", "3324"], fakeFetch, new Date("2026-07-17T06:00:00Z"));
  assert.deepEqual(quotes.get("2330"), { code: "2330", name: "台積電", close: 2290, change: -180, date: "2026-07-17" });
  assert.equal(quotes.has("2317"), false, "no-trade quote ('-') is skipped, not written as 0");
  assert.equal(quotes.get("3324").close, 913, "OTC code resolved through the otc_ channel");
});

test("MIS failure is tolerated and never throws into the feed", async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => fetchMisQuotes(["2330"], failing, new Date("2026-07-17T06:00:00Z")),
    /HTTP 403/, "caller decides; main() catches this");
});

// ── 全市場 / ETF 引擎的逐市場保留 ────────────────────────────────
// 實測 2026-07-28：TPEX 回 10,212 列耗時近 1 秒，runner 上連線被中斷（undici "terminated"），
// 個股 feed 靠 preserveMarketRows 保住 853 檔上櫃，ETF 卻因「全有全無」判斷整個上櫃消失。

const etfRow = (code, market) => ({ code, name: `ETF${code}`, market, close: 20, change: 0.1, volume: 1000, yield: 5, aum: 100 });

test("one market failing never wipes that market's ETF rows", () => {
  const previous = [
    ...Array.from({ length: 231 }, (_, i) => etfRow(`00${100 + i}`, "twse")),
    ...Array.from({ length: 117 }, (_, i) => etfRow(`00${400 + i}`, "tpex")),
  ];
  const freshTwse = Array.from({ length: 231 }, (_, i) => etfRow(`00${100 + i}`, "twse"));

  const twse = preserveEtfMarketRows(previous, freshTwse, "twse");
  assert.equal(twse.preserved, false, "a healthy market must use fresh rows");
  assert.equal(twse.rows.length, 231);

  const tpex = preserveEtfMarketRows(previous, [], "tpex");
  assert.equal(tpex.preserved, true, "the dead market falls back instead of vanishing");
  assert.equal(tpex.rows.length, 117, "上櫃 ETF 不得整批消失（348 → 231 是本次要修的缺陷）");
  assert.equal(tpex.rows.every((r) => r.market === "tpex"), true, "fallback must not leak the other market's rows");
});

test("ETF preservation trims to the price columns only", () => {
  const previous = [{ ...etfRow("0056", "twse"), dps: [{ m: 1, a: 1 }], isCore: true }];
  const { rows } = preserveEtfMarketRows(previous, [], "twse");
  // 保留的是「價格列」；配息 / 分類等衍生欄位由後續流程依前次 feed 逐欄補回，
  // 直接帶進來會讓 preserveEtfColumns 誤判成本次已算出的新值
  assert.deepEqual(Object.keys(rows[0]).sort(), ["change", "close", "code", "market", "name", "volume"]);
});

test("a partial ETF fetch is treated as degradation, a mild dip is not", () => {
  const previous = Array.from({ length: 100 }, (_, i) => etfRow(`00${100 + i}`, "twse"));
  assert.equal(preserveEtfMarketRows(previous, previous.slice(0, 80), "twse").preserved, false, "80% is normal variance");
  assert.equal(preserveEtfMarketRows(previous, previous.slice(0, 40), "twse").preserved, true, "40% means upstream broke");
  // 冷啟動沒有比較基準：不能把空結果當成「保留成功」而永遠寫不出檔案
  assert.equal(preserveEtfMarketRows([], [], "twse").preserved, false);
  assert.equal(preserveEtfMarketRows([], previous, "twse").rows.length, 100);
});

test("the stock engine's guard behaves the same way for its larger universe", () => {
  const previous = Array.from({ length: 853 }, (_, i) => ({ code: String(4000 + i), market: "tpex", close: 10 }));
  assert.equal(preserveMarketRows(previous, []).preserved, true, "853 檔上櫃個股必須保住");
  assert.equal(preserveMarketRows(previous, previous.slice(0, 700)).preserved, false);
});

// ── 暫時性中斷要重試 ─────────────────────────────────────────────
// 兩個引擎原本零重試，一次 "terminated" 就整個市場報銷。

async function withStubbedFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

for (const [label, fetchJson] of [["market", marketFetchJson], ["etf", etfFetchJson]]) {
  test(`${label} engine retries a dropped connection and succeeds`, async () => {
    let calls = 0;
    const result = await withStubbedFetch(async () => {
      calls += 1;
      if (calls < 3) throw new Error("terminated");
      return { ok: true, status: 200, json: async () => [{ Code: "2330" }] };
    }, () => fetchJson("https://example.invalid/x", 1, 3, 0));
    assert.equal(calls, 3, "must retry rather than give up on the first drop");
    assert.deepEqual(result, [{ Code: "2330" }]);
  });

  test(`${label} engine gives up after the retry budget`, async () => {
    let calls = 0;
    await assert.rejects(() => withStubbedFetch(async () => {
      calls += 1;
      throw new Error("terminated");
    }, () => fetchJson("https://example.invalid/x", 1, 3, 0)), /terminated/);
    assert.equal(calls, 3, "bounded retries — a genuinely dead endpoint must not stall the run");
  });

  test(`${label} engine does not retry a 4xx`, async () => {
    let calls = 0;
    await assert.rejects(() => withStubbedFetch(async () => {
      calls += 1;
      return { ok: false, status: 404, json: async () => ({}) };
    }, () => fetchJson("https://example.invalid/x", 1, 3, 0)), /HTTP 404/);
    // 重試 404 只是拖慢執行；5xx 才值得等
    assert.equal(calls, 1, "a 4xx will not improve on retry");
  });
}
