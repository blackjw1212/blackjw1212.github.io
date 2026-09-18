// 這四份 feed 是 CI 每天寫出來、直接上線的，但在這支測試之前**沒有任何測試讀過它們**。
// 各自同名的 etf-returns.test.js／risk-free.test.js／industry-map.test.js 測的是
// **解析器**，不是產出的檔案——那正是 etf-schema.test.js 對 market/etf feed 做、
// 而這四份沒有的那件事。feed 是 minified 的（market-52w.json 700KB），
// 壞掉時肉眼完全看不出來。
//
// 斷言優先寫「定義性檢查」而不是形狀檢查：形狀對但數字錯的檔案照樣會上線。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retentionFloor, MIN_WINDOW_MONTHS } from "../../scripts/update-market-feed.mjs";
import { MIN_SPAN_DAYS } from "../../scripts/update-etf-returns.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

function isoDaysApart(a, b) {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}

test("market-52w.json holds well-formed buckets inside the retention window", async () => {
  const acc = await readJson("../../data/market-52w.json");
  const feed = await readJson("../../data/market-feed.json");
  const floor = retentionFloor(feed.tradeDate);
  assert.match(floor, MONTH_KEY, "保留界線算不出來的話下面每一條都是空的");

  const codes = Object.keys(acc.stocks);
  assert.ok(codes.length > 1000, `存檔只剩 ${codes.length} 檔，上游大概崩了`);

  const staleFloor = new Date(feed.tradeDate + "T00:00:00Z");
  staleFloor.setUTCDate(staleFloor.getUTCDate() - 60);
  const staleIso = staleFloor.toISOString().slice(0, 10);

  for (const code of codes) {
    const entry = acc.stocks[code];
    const months = Object.keys(entry.m || {});
    assert.ok(months.length > 0, `${code}: 空的月桶不該留在存檔裡`);
    for (const month of months) {
      assert.match(month, MONTH_KEY, `${code}: 月鍵 ${month} 格式異常`);
      // 這一條是「距一年高」會不會拿一年多以前的高點當分母的唯一守門
      assert.ok(month >= floor, `${code}: 月桶 ${month} 超出保留界線 ${floor}`);
      assert.ok(month <= feed.tradeDate.slice(0, 7), `${code}: 月桶 ${month} 在未來`);
      const bucket = entry.m[month];
      assert.ok(Array.isArray(bucket) && bucket.length === 2, `${code} ${month}: 桶必須是 [hi, lo]`);
      const [hi, lo] = bucket;
      assert.ok(typeof hi === "number" && typeof lo === "number", `${code} ${month}: 桶內必須是數字`);
      assert.ok(lo > 0, `${code} ${month}: 低點 ${lo} 不是正數`);
      assert.ok(hi >= lo, `${code} ${month}: 高點 ${hi} 低於低點 ${lo}`);
    }
    assert.match(entry.lastSeen || "", ISO_DATE, `${code}: lastSeen 必須是 ISO 日期`);
    assert.ok(entry.lastSeen >= staleIso, `${code}: lastSeen ${entry.lastSeen} 已超過 60 天，該被下市清除`);
  }
});

// 定義性檢查：hi52／lo52 的意義就是「窗口內所有月桶的極值」。
// 兩張表分叉時肉眼完全看不出來，但畫面上每一個距高百分比都會是錯的。
// 同 tax-params 那條「累進差額在級距交界處必須相等」。
test("market-feed hi52/lo52 are exactly the extremes of that code's buckets", async () => {
  const acc = await readJson("../../data/market-52w.json");
  const feed = await readJson("../../data/market-feed.json");
  let checked = 0;
  for (const row of feed.stocks) {
    const entry = acc.stocks[row.code];
    assert.ok(entry, `${row.code}: feed 有這一列，52 週存檔卻沒有`);
    const buckets = Object.values(entry.m || {});
    const hi = Math.max(...buckets.map((b) => b[0]));
    const lo = Math.min(...buckets.map((b) => b[1]));
    if (row.hi52 == null) continue;
    assert.equal(row.hi52, Math.round(hi * 100) / 100, `${row.code}: hi52 與月桶極值不符`);
    assert.equal(row.lo52, Math.round(lo * 100) / 100, `${row.code}: lo52 與月桶極值不符`);
    if (row.close != null && row.hi52 > 0) {
      const expected = Math.round((row.close - row.hi52) / row.hi52 * 1000) / 10;
      assert.equal(row.fromHi, expected, `${row.code}: fromHi 與 close/hi52 算不出來的值不符`);
    }
    checked += 1;
  }
  assert.ok(checked > 1000, `只驗到 ${checked} 列，這條斷言等於沒跑`);
});

// 上市未滿一年不得宣稱一年高低。沒有這條，新上市股會用 1 個月的資料
// 印出「距一年高 −30.7%」，而畫面上沒有任何地方說得出那是 1 個月。
test("no row publishes a one-year high on less than a year of buckets", async () => {
  const acc = await readJson("../../data/market-52w.json");
  const feed = await readJson("../../data/market-feed.json");
  const offenders = [];
  let thin = 0;
  for (const row of feed.stocks) {
    const months = Object.keys((acc.stocks[row.code] || { m: {} }).m).length;
    if (months < MIN_WINDOW_MONTHS) {
      thin += 1;
      if (row.hi52 != null) offenders.push(`${row.code} ${row.name}（${months} 個月卻有 hi52）`);
      assert.equal(row.w52Months, months, `${row.code}: 覆蓋不足時必須帶 w52Months 讓畫面說得出累到幾個月`);
    } else {
      assert.equal(row.w52Months, undefined, `${row.code}: 滿 ${months} 個月就不該帶 w52Months`);
    }
  }
  assert.deepEqual(offenders, [], `覆蓋不足卻發布了一年高低：\n  ${offenders.join("\n  ")}`);
  assert.ok(thin > 0, "沒有任何一列覆蓋不足——這條斷言可能沒有真的在跑（新上市股一直都有）");
});

test("etf-returns.json is internally consistent and never publishes a guessed return", async () => {
  const data = await readJson("../../data/etf-returns.json");
  assert.match(data.asOf, ISO_DATE);
  assert.ok(data.asOf <= new Date().toISOString().slice(0, 10), `asOf ${data.asOf} 在未來`);
  assert.ok(typeof data.basis === "string" && data.basis.length > 10, "basis 必須說得出這些數字是怎麼來的");

  const codes = Object.keys(data.stocks);
  const skipped = Object.keys(data.skipped);
  assert.equal(data.count, codes.length, "count 與 stocks 筆數不符");
  assert.equal(data.skippedCount, skipped.length, "skippedCount 與 skipped 筆數不符");
  assert.ok(codes.length > 100, `只剩 ${codes.length} 檔有報酬，上游大概崩了`);

  const both = codes.filter((code) => code in data.skipped);
  assert.deepEqual(both, [], "同一檔不可以同時出現在 stocks 與 skipped");

  for (const [code, entry] of Object.entries(data.skipped)) {
    assert.ok(entry.reason, `${code}: 跳過的標的一定要說出原因`);
  }

  for (const [code, entry] of Object.entries(data.stocks)) {
    assert.match(entry.from, ISO_DATE, `${code}: from 格式異常`);
    assert.match(entry.to, ISO_DATE, `${code}: to 格式異常`);
    assert.ok(entry.from < entry.to, `${code}: from 不早於 to`);
    for (const window of ["1y", "3y", "5y"]) {
      const dd = entry[`maxDrawdown${window}`];
      const vol = entry[`volatility${window}`];
      const total = entry[`totalReturn${window}`];
      if (dd != null) assert.ok(dd <= 0 && dd >= -100, `${code}: maxDrawdown${window} ${dd} 不在 [−100, 0]`);
      if (vol != null) assert.ok(vol >= 0, `${code}: volatility${window} ${vol} 是負的`);
      // 全額歸零是 −100%，再低就是算錯而不是跌得更慘
      if (total != null) assert.ok(total >= -100, `${code}: totalReturn${window} ${total} 低於 −100%`);
    }
    // 滿一年才可以發布一年報酬——deriveDividend 那條 coverage 規則的報酬版。
    // 門檻用 update-etf-returns.mjs 自己的 MIN_SPAN_DAYS，不要在這裡另外編一個數字：
    // 交易日不是每天都有，寫死 365 會擋掉合法的標的（實測 009809 是 349 天）。
    if (entry.totalReturn1y != null) {
      assert.ok(isoDaysApart(entry.to, entry.from) >= MIN_SPAN_DAYS,
        `${code}: 只有 ${isoDaysApart(entry.to, entry.from)} 天的歷史卻發布了一年報酬`);
    }
  }
});

test("industry-map.json maps every code to a listed industry", async () => {
  const data = await readJson("../../data/industry-map.json");
  const codes = Object.keys(data.byCode);
  assert.equal(data.count, codes.length, "count 與 byCode 筆數不符");
  assert.ok(codes.length > 1000, `只剩 ${codes.length} 檔，isDegraded 應該要擋下這種覆寫`);
  const industries = new Set(data.industries);
  assert.ok(industries.size >= 20, `產業別只剩 ${industries.size} 種`);
  for (const [code, industry] of Object.entries(data.byCode)) {
    assert.ok(industries.has(industry), `${code}: 產業別「${industry}」不在 industries 清單裡`);
  }
  for (const [name, industry] of Object.entries(data.byName)) {
    assert.ok(industries.has(industry), `${name}: 產業別「${industry}」不在 industries 清單裡`);
  }
  assert.ok(Array.isArray(data.errors), "errors 必須存在，畫面靠它說出降級");
});

test("risk-free.json stays inside the band the writer enforces", async () => {
  const data = await readJson("../../data/risk-free.json");
  assert.ok(typeof data.rate === "number", "利率必須是數字——載不到時前端會說「不以 0 代替」，這裡不該出現 null");
  // update-risk-free.mjs 自己的 out-of-band 檢查：央行重貼現率的合理區間
  assert.ok(data.rate > 0 && data.rate < 10, `利率 ${data.rate}% 不在合理區間`);
  assert.match(data.effectiveFrom, ISO_DATE);
  assert.ok(data.effectiveFrom <= new Date().toISOString().slice(0, 10),
    `生效日 ${data.effectiveFrom} 在未來——尚未生效的調整不可以拿來算今天的報酬`);
  assert.ok(data.kind && data.source, "利率種類與來源都要說得出來");
  assert.match(data.sourceUrl || "", /^https:\/\//, "來源連結必須是 https");
});
