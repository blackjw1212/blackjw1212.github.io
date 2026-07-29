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

// 上游一個市場中斷就整批消失，是 2026-07-28 實際發生的事故（ETF 348→231、個股上櫃 853→0）。
// 逐市場下限比「總筆數下限」更有意義：總數掉一半才會觸發，掉一個市場往往還在門檻之上。
const assertBothMarkets = (rows, label, floors) => {
  const byMarket = rows.reduce((acc, row) => ({ ...acc, [row.market]: (acc[row.market] || 0) + 1 }), {});
  assert.ok(byMarket.twse >= floors.twse, `${label}: 上市只剩 ${byMarket.twse || 0} 檔（下限 ${floors.twse}）——上游中斷未被保留？`);
  assert.ok(byMarket.tpex >= floors.tpex, `${label}: 上櫃只剩 ${byMarket.tpex || 0} 檔（下限 ${floors.tpex}）——上游中斷未被保留？`);
};

test("market-feed.json matches the expected schema", async () => {
  const feed = await readJson("../../data/market-feed.json");
  assert.match(feed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feed.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(feed.tradeDate <= new Date().toISOString().slice(0, 10), "交易日不得在未來");
  assert.ok(Array.isArray(feed.stocks) && feed.stocks.length >= 1500, `expected 1500+ stocks, got ${feed.stocks.length}`);
  assert.equal(feed.count, feed.stocks.length);
  assert.ok(Array.isArray(feed.errors));
  assertBothMarkets(feed.stocks, "market-feed", { twse: 800, tpex: 500 });

  const codes = new Set();
  for (const row of feed.stocks) {
    const at = (msg) => `${row.code}: ${msg}`;
    assert.match(row.code, /^\d{4}[A-Z]?$/, at("code shape"));
    assert.ok(!codes.has(row.code), at("duplicate code"));
    codes.add(row.code);
    assert.equal(typeof row.name, "string", at("name"));
    assert.ok(row.market === "twse" || row.market === "tpex", at("market"));
    // close = 0 曾被當成價格寫入（9110），會讓漲跌幅與估值除以零
    assert.ok(isNum(row.close) && row.close > 0, at("close must be a positive number"));
    for (const key of ["change", "open", "high", "low", "volume", "pe", "dividendYield", "pbRatio", "hi52", "lo52", "fromHi"]) {
      assert.ok(optNum(row[key]), at(`${key} must be a number or absent`));
    }
    if (isNum(row.hi52) && isNum(row.lo52)) assert.ok(row.hi52 >= row.lo52, at("52w high must not sit below the low"));
  }
});

test("etf-feed.json matches the expected schema", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  assert.match(feed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feed.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(feed.tradeDate <= new Date().toISOString().slice(0, 10), "交易日不得在未來");
  assert.ok(Array.isArray(feed.stocks) && feed.stocks.length >= 300, `expected 300+ ETFs, got ${feed.stocks.length}`);
  assert.equal(feed.count, feed.stocks.length);
  assert.ok(Array.isArray(feed.errors));
  assertBothMarkets(feed.stocks, "etf-feed", { twse: 150, tpex: 80 });

  const codes = new Set();
  for (const row of feed.stocks) {
    const at = (msg) => `${row.code}: ${msg}`;
    assert.match(row.code, /^00\d{2,4}[A-Z]?$/, at("code shape"));
    assert.ok(!codes.has(row.code), at("duplicate code"));
    codes.add(row.code);
    assert.equal(typeof row.name, "string", at("name"));
    assert.ok(row.market === "twse" || row.market === "tpex", at("market"));
    assert.ok(isNum(row.close) && row.close > 0, at("close must be a positive number"));
    for (const key of ["change", "volume", "nav", "discountPremium", "aum", "yield", "expenseRatio", "divMonthsCovered", "dividendCv", "yieldEstimated"]) {
      assert.ok(optNum(row[key]), at(`${key} must be a number or absent`));
    }
    // 推估與實績互斥：有完整年度實績就不該再掛推估值，否則畫面會二選一失準
    if (row.yieldEstimated != null) {
      assert.equal(row.yield, null, at("an estimate must only exist where there is no full-year yield"));
      assert.ok(row.yieldBasis && isNum(row.yieldBasis.events) && isNum(row.yieldBasis.months),
        at("an estimate must carry its basis"));
      assert.ok(row.yieldBasis.events >= 2 && row.yieldBasis.months >= 6, at("estimate basis too thin"));
    }
    assert.ok(typeof row.hasHoldingsData === "boolean", at("hasHoldingsData must be a boolean flag"));
    assert.ok(typeof row.isCore === "boolean", at("isCore must be a boolean flag"));
    assert.ok(typeof row.isActive === "boolean", at("isActive must be a boolean flag"));
    assert.ok(!(row.isActive && row.isCore), at("an actively managed fund must never be flagged core"));
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
      // 成分股是月頻揭露，資料日必為過去；未來日代表來源解析錯誤
      assert.ok(row.holdingsAsOf <= new Date().toISOString().slice(0, 10), at("holdingsAsOf must not be in the future"));
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
  // 槓反／期貨／外幣計價原本只是「剛好沒有配息紀錄」才沒被標成核心；
  // 00631L 規模 2,188億，一次配息就會誤標，必須由規則而非巧合擋住
  assert.equal(by["00631L"].isCore, false, "a leveraged ETF must never be core");
  assert.equal(isCoreEtf({ ...by["00631L"], aum: 2188, yield: 2, isActive: false }), false,
    "even with a qualifying size and yield, 槓桿反向 must stay out of core");
  for (const type of ["期貨型", "外幣計價", "債券型"]) {
    assert.equal(isCoreEtf({ type, aum: 5000, yield: 2, isActive: false, code: "0000", name: "x" }), false, `${type} must never be core`);
  }

  // 穩定配息者 CV 落在安全區、劇烈者被標出來
  // 後綴家族分類（先前 29 檔 A 全被誤歸主題型並已進入產生器候選池）
  assert.equal(by["00403A"].type, "主動型");
  assert.equal(by["00403A"].isActive, true);
  assert.equal(by["00403A"].isCore, false, "a 1,526億 active fund still must not be core");
  assert.equal(by["00981T"].type, "平衡型");
  assert.equal(by["00625K"].type, "外幣計價");
  assert.equal(by["00840B"].type, "債券型", "IG bond fund without 債 in its name");
  assert.equal(by["00981D"].type, "債券型", "active bond fund is typed by its bond nature");
  assert.equal(by["00981D"].isActive, true, "but still flagged as actively managed");

  assert.ok(by["0050"].dividendCv < 0.6, `0050 cv ${by["0050"].dividendCv} should be safe`);
  assert.ok(by["006208"].dividendCv < 0.6, `006208 cv ${by["006208"].dividendCv} should be safe`);
  assert.ok(by["00905"].dividendCv > 0.6, `00905 cv ${by["00905"].dividendCv} should be flagged volatile`);
});

test("holdings parser is anchored on header labels, not CSS classes", async () => {
  const { parseHoldings, parseAsOf } = await import("../../scripts/fetch-etf-holdings.mjs");

  const table = (cls) => `<table id="Repeater1" class="datalist">
    <tr><th>股票名稱</th><th>持股(千股)</th><th>比例</th><th>增減</th></tr>
    <tr><td class="${cls}a">台積電</td><td class="${cls}b">525,977.00</td><td class="${cls}c">57.37</td><td class="${cls}d">-0.91%</td></tr>
    <tr><td class="${cls}a">聯發科</td><td class="${cls}b">60,000.00</td><td class="${cls}c">6.11</td><td class="${cls}d">+0.２%</td></tr>
  </table>`;

  const original = parseHoldings(table("col05"));
  assert.deepEqual(original, [{ name: "台積電", weight: 57.37 }, { name: "聯發科", weight: 6.11 }]);
  // 這是抗改版的核心價值：class 全部改名仍要解析成功
  assert.deepEqual(parseHoldings(table("brandNew")), original, "a CSS class rename must not break the parser");

  // 頁面把持股拆成左右兩張表，兩張都要收
  assert.equal(parseHoldings(table("col05") + table("col05")).length, 4);
  // 取前十大就停
  const many = `<table><tr><th>股票名稱</th><th>比例</th></tr>`
    + Array.from({ length: 30 }, (_, i) => `<tr><td>股${i}</td><td>${(30 - i) / 10}</td></tr>`).join("") + `</table>`;
  assert.equal(parseHoldings(many).length, 10);

  // 表頭不見了＝上游真的改版 → 回空陣列，讓呼叫端記為失敗並保留前次值
  assert.deepEqual(parseHoldings(`<table><tr><th>代號</th><th>數量</th></tr><tr><td>x</td><td>1</td></tr></table>`), []);
  assert.deepEqual(parseHoldings("<div>no table at all</div>"), []);

  // 資料日：頁面標示的持股日期，與抓取日不同（實測相差 11 天）
  assert.equal(parseAsOf('<div>資料日期：2026/07/17</div>'), "2026-07-17");
  assert.equal(parseAsOf('資料日期: 2026/7/1'), "2026-07-01", "single-digit month and day");
  assert.equal(parseAsOf("<div>no date here</div>"), null);
});

test("holdings scrape refuses to overwrite good data when upstream degrades", async () => {
  const { isDegraded, moneydjId, parseHoldings } = await import("../../scripts/fetch-etf-holdings.mjs");

  // 實測正常成功數 202/348（槓反與期貨型結構上沒有成分股頁），
  // 所以護欄必須比「相對前次」而非絕對成功率——否則上游小幅劣化偵測不到。
  assert.equal(isDegraded(202, 202), false, "a normal run must write");
  assert.equal(isDegraded(150, 202), false, "mild variance still writes");
  assert.equal(isDegraded(140, 202), true, "a 30% drop means upstream changed — keep the old file");
  assert.equal(isDegraded(0, 202), true, "total failure must never wipe the file");
  // 首次執行沒有比較基準，用絕對下限擋住近乎空的檔案
  assert.equal(isDegraded(202, 0), false);
  assert.equal(isDegraded(10, 0), true, "first run must not persist a near-empty result");

  assert.equal(moneydjId("0050", "twse"), "0050.TW");
  assert.equal(moneydjId("00679B", "tpex"), "00679B.TWO");
  assert.equal(moneydjId("../evil", "twse"), "", "only validated codes reach the URL");
  // 上游改版（class 名變動）時要回空陣列，讓呼叫端判定失敗並保留前次值
  assert.deepEqual(parseHoldings('<td class="colXX">台積電</td>'), []);
  assert.deepEqual(parseHoldings(""), []);
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
