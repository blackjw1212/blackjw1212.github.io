import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFredDgs10,
  normalizeMopsDate,
  normalizeMopsFilings,
  normalizeQuoteIndexPayload,
  normalizeQuotePayload,
  normalizeTwseEod,
  parseNumber,
} from "../src/normalizers.js";

test("parseNumber handles commas, signs, percents, and blanks", () => {
  assert.equal(parseNumber("1,234.56"), 1234.56);
  assert.equal(parseNumber("+0.45%"), 0.45);
  assert.equal(parseNumber("--"), null);
  assert.equal(parseNumber("N/A"), null);
});

test("normalizeTwseEod returns compact closing-price rows", () => {
  const rows = normalizeTwseEod([
    { Code: "2330", Name: "TSMC", ClosingPrice: "1,010.00", Change: "+5.25" },
    { Code: "ABCD", Name: "Bad", ClosingPrice: "1.00", Change: "0" },
    { Code: "2308", Name: "Delta", ClosingPrice: "--", Change: "--" },
  ]);

  assert.deepEqual(rows, [
    { code: "2330", name: "TSMC", close: 1010, change: 5.25 },
  ]);
});

test("normalizeQuotePayload computes change and percent change from MIS payload", () => {
  const quotes = normalizeQuotePayload({
    msgArray: [
      {
        ch: "tse_2330.tw",
        c: "2330",
        n: "TSMC",
        z: "1005.00",
        y: "1000.00",
        h: "1010.50",
        l: "995.00",
        o: "1001.00",
        v: "12345",
        ex: "tse",
        d: "20260605",
        t: "13:30:00",
      },
    ],
  }, ["2330"]);

  assert.deepEqual(quotes, [
    {
      code: "2330",
      name: "TSMC",
      price: 1005,
      close: 1005,
      previousClose: 1000,
      high: 1010.5,
      low: 995,
      open: 1001,
      change: 5,
      pctChange: 0.5,
      volume: 12345,
      exchange: "tse",
      time: "2026-06-05T13:30:00+08:00",
    },
  ]);
});

test("normalizeQuoteIndexPayload normalizes allowlisted TWSE and TPEX index channels", () => {
  const indices = normalizeQuoteIndexPayload({
    msgArray: [
      {
        "@": "t00.tw",
        key: "tse_t00.tw_20260608",
        ch: "t00.tw",
        c: "t00",
        n: "發行量加權股價指數",
        z: "42686.84",
        y: "40299.74",
        ex: "tse",
        d: "20260608",
        t: "09:33:00",
      },
      {
        "@": "o00.tw",
        key: "otc_o00.tw_20260608",
        ch: "o00.tw",
        c: "o00",
        n: "櫃買指數",
        z: "397.81",
        y: "364.55",
        ex: "otc",
        d: "20260608",
        t: "09:33:00",
      },
      {
        ch: "tse_bad.tw",
        n: "ignored",
        z: "999",
      },
    ],
  }, ["taiex", "tpex"]);

  assert.deepEqual(indices, [
    {
      id: "taiex",
      name: "發行量加權股價指數",
      price: 42686.84,
      previousClose: 40299.74,
      change: 2387.1,
      pctChange: 5.92,
      exchange: "tse",
      time: "2026-06-08T09:33:00+08:00",
    },
    {
      id: "tpex",
      name: "櫃買指數",
      price: 397.81,
      previousClose: 364.55,
      change: 33.26,
      pctChange: 9.12,
      exchange: "otc",
      time: "2026-06-08T09:33:00+08:00",
    },
  ]);
});

test("normalizeQuoteIndexPayload preserves requested order and avoids NaN values", () => {
  const indices = normalizeQuoteIndexPayload({
    msgArray: [
      { ch: "tse_t00.tw", n: "發行量加權股價指數", z: "-", y: "0", d: "20260608", t: "09:33:00" },
      { ch: "otc_o00.tw", n: "櫃買指數", z: "397.81", y: "364.55", d: "20260608", t: "09:33:00" },
    ],
  }, ["tpex"]);

  assert.deepEqual(indices.map((index) => index.id), ["tpex"]);
  assert.equal(indices[0].price, 397.81);
  assert.equal(indices[0].change, 33.26);
  assert.equal(indices[0].pctChange, 9.12);

  const missing = normalizeQuoteIndexPayload({
    msgArray: [
      { ch: "tse_t00.tw", n: "發行量加權股價指數", z: "-", y: "0", d: "20260608", t: "09:33:00" },
    ],
  }, ["taiex"]);
  assert.equal(missing[0].price, null);
  assert.equal(missing[0].change, null);
  assert.equal(missing[0].pctChange, null);
});

test("normalizeMopsDate converts ROC and Gregorian dates", () => {
  assert.equal(normalizeMopsDate("115/06/05"), "2026-06-05");
  assert.equal(normalizeMopsDate("2026/06/05"), "2026-06-05");
  assert.equal(normalizeMopsDate("1150605"), "2026-06-05");
});

test("normalizeMopsFilings extracts date, title, and detail URL", () => {
  const html = `
    <table>
      <tr><th>Date</th><th>Time</th><th>Code</th><th>Title</th></tr>
      <tr>
        <td>115/06/05</td>
        <td>18:21:10</td>
        <td>2330</td>
        <td><a href="javascript:openWindow('co_id','2330','spoke_date','20260605','spoke_time','182110','seq_no','1')">Board approves capital budget</a></td>
      </tr>
    </table>
  `;

  const filings = normalizeMopsFilings(html, "2330");
  assert.equal(filings.length, 1);
  assert.equal(filings[0].date, "2026-06-05");
  assert.equal(filings[0].title, "Board approves capital budget");
  assert.match(filings[0].url, /co_id=2330/);
  assert.match(filings[0].url, /spoke_date=20260605/);
});

test("normalizeMopsFilings rejects off-site links and survives malformed entities", () => {
  const html = `
    <table>
      <tr>
        <td>115/06/05</td>
        <td>2330</td>
        <td><a href="https://evil.example/phish">Dividend update &#99999999;</a></td>
      </tr>
    </table>
  `;

  const filings = normalizeMopsFilings(html, "2330");
  assert.equal(filings.length, 1);
  assert.equal(filings[0].title, "Dividend update &#99999999;");
  assert.match(filings[0].url, /^https:\/\/mops\.twse\.com\.tw\/mops\/web\/t05st01\?/);
});

test("normalizeFredDgs10 skips missing observations", () => {
  const result = normalizeFredDgs10({
    observations: [
      { date: "2026-06-06", value: "." },
      { date: "2026-06-05", value: "4.1234" },
    ],
  });

  assert.deepEqual(result, {
    date: "2026-06-05",
    value: 4.123,
    units: "percent",
  });
});
