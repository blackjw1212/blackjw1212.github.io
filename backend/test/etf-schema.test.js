// 資料層 Schema 驗證：確保 pipeline 產出的 JSON 結構與型別穩定。
// 這取代 TypeScript 介面的角色——本 repo 無 TS 工具鏈，用執行期驗證達成同一目的：
// 擋住壞資料進入前端與最佳化器。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dividendCv, isCoreEtf } from "../../scripts/update-etf-feed.mjs";

const readJson = async (rel) => JSON.parse(await readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const optNum = (v) => v == null || isNum(v);

test("etf-feed.json matches the expected schema", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  assert.match(feed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feed.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(feed.stocks) && feed.stocks.length >= 300, `expected 300+ ETFs, got ${feed.stocks.length}`);
  assert.equal(feed.count, feed.stocks.length);
  assert.ok(Array.isArray(feed.errors));

  const codes = new Set();
  for (const row of feed.stocks) {
    const at = (msg) => `${row.code}: ${msg}`;
    assert.match(row.code, /^00\d{2,4}[A-Z]?$/, at("code shape"));
    assert.ok(!codes.has(row.code), at("duplicate code"));
    codes.add(row.code);
    assert.equal(typeof row.name, "string", at("name"));
    assert.ok(row.market === "twse" || row.market === "tpex", at("market"));
    assert.ok(isNum(row.close) && row.close > 0, at("close must be a positive number"));
    for (const key of ["change", "volume", "nav", "discountPremium", "aum", "yield", "expenseRatio", "divMonthsCovered", "dividendCv"]) {
      assert.ok(optNum(row[key]), at(`${key} must be a number or absent`));
    }
    assert.ok(typeof row.hasHoldingsData === "boolean", at("hasHoldingsData must be a boolean flag"));
    assert.ok(typeof row.isCore === "boolean", at("isCore must be a boolean flag"));
    if (row.dps != null) {
      assert.ok(Array.isArray(row.dps), at("dps array"));
      for (const event of row.dps) {
        assert.ok(isNum(event.m) && event.m >= 1 && event.m <= 12, at("dps month in 1..12"));
        assert.ok(isNum(event.a) && event.a > 0, at("dps amount positive"));
      }
    }
    if (row.payMonths != null) {
      assert.ok(Array.isArray(row.payMonths), at("payMonths array"));
      row.payMonths.forEach((m) => assert.ok(isNum(m) && m >= 1 && m <= 12, at("payMonth in 1..12")));
    }
    if (row.topHoldings != null) {
      assert.ok(Array.isArray(row.topHoldings) && row.topHoldings.length <= 10, at("topHoldings <= 10"));
      let sum = 0;
      for (const holding of row.topHoldings) {
        assert.equal(typeof holding.name, "string", at("holding name"));
        assert.ok(isNum(holding.weight) && holding.weight > 0 && holding.weight <= 100, at("holding weight 0..100"));
        sum += holding.weight;
      }
      assert.ok(sum <= 100.01, at(`top holdings sum ${sum.toFixed(2)} exceeds 100%`));
      assert.match(row.holdingsAsOf || "", /^\d{4}-\d{2}-\d{2}$/, at("holdingsAsOf ISO date"));
      assert.ok(row.holdingsSource, at("holdings must carry a source attribution"));
    }
  }
});

test("derived fields agree with the pipeline's own formulas", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  let checkedCv = 0;
  let checkedCore = 0;
  for (const row of feed.stocks) {
    const expectedCv = dividendCv(row.dps);
    if (expectedCv == null) {
      assert.equal(row.dividendCv, undefined, `${row.code}: cv must be absent when it cannot be computed`);
    } else {
      assert.equal(row.dividendCv, expectedCv, `${row.code}: stored cv drifted from the formula`);
      checkedCv += 1;
    }
    assert.equal(row.isCore, isCoreEtf(row), `${row.code}: stored isCore drifted from the rule`);
    if (row.isCore) checkedCore += 1;
    assert.equal(row.hasHoldingsData, Boolean(row.topHoldings && row.topHoldings.length), `${row.code}: hasHoldingsData drifted`);
  }
  assert.ok(checkedCv > 50, `expected many ETFs with a CV, got ${checkedCv}`);
  assert.ok(checkedCore >= 1, "at least one core ETF must be flagged");
});

test("known ETFs land in the expected quality bands", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  const by = Object.fromEntries(feed.stocks.map((row) => [row.code, row]));

  // 大型市值型必須被標為核心（0050 殖利率最低，純殖利率排序永遠看不到它）
  assert.equal(by["0050"].isCore, true, "0050 must be flagged core");
  assert.equal(by["006208"].isCore, true, "006208 must be flagged core");
  // 長天期債 ETF 不得佔走核心位置
  assert.equal(by["00679B"].isCore, false, "a bond ETF must never be core");

  // 穩定配息者 CV 落在安全區、劇烈者被標出來
  assert.ok(by["0050"].dividendCv < 0.6, `0050 cv ${by["0050"].dividendCv} should be safe`);
  assert.ok(by["006208"].dividendCv < 0.6, `006208 cv ${by["006208"].dividendCv} should be safe`);
  assert.ok(by["00905"].dividendCv > 0.6, `00905 cv ${by["00905"].dividendCv} should be flagged volatile`);
});

test("etf-holdings.json is well formed when present", async () => {
  let holdings;
  try {
    holdings = await readJson("../../data/etf-holdings.json");
  } catch {
    return; // 尚未執行過抓取工具時跳過
  }
  assert.match(holdings.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(holdings.source, "must attribute the scraped source");
  for (const [code, entry] of Object.entries(holdings.etfs || {})) {
    assert.match(code, /^00\d{2,4}[A-Z]?$/, `${code}: code shape`);
    assert.ok(Array.isArray(entry.topHoldings) && entry.topHoldings.length <= 10, `${code}: <= 10 holdings`);
    entry.topHoldings.forEach((h) => {
      assert.equal(typeof h.name, "string", `${code}: holding name`);
      assert.ok(isNum(h.weight) && h.weight > 0 && h.weight <= 100, `${code}: weight range`);
    });
    assert.match(entry.asOf || "", /^\d{4}-\d{2}-\d{2}$/, `${code}: asOf`);
  }
});
