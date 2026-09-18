// data/stock-risk-feed.json 在這支測試之前**沒有任何測試讀過它**，而且
// update-stock-risk-feed.yml 也沒有 commit 前的驗證閘門——
// update-market-feed.yml 的 commit 是吊在 `node --test …/etf-schema.test.js` 後面的
// （註解寫得很清楚：驗證失敗就什麼都不推），這一支卻是直接 git add → commit → push。
// frontend-smoke.test.js 雖然出現這個檔名，餵給頁面的是**合成 fixture**，
// 從來沒讀過真的那一份。
//
// 這支測產出的檔案；解析器的行為由 feed-preservation.test.js 蓋著。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function readFeed() {
  return JSON.parse(await readFile(new URL("../../data/stock-risk-feed.json", import.meta.url), "utf8"));
}

test("every holding has a quote, and every quote is a real price", async () => {
  const feed = await readFeed();
  assert.ok(Array.isArray(feed.holdings) && feed.holdings.length > 0, "持股清單不可以是空的");
  assert.equal(new Set(feed.holdings).size, feed.holdings.length, "持股清單有重複代碼");
  assert.ok(Array.isArray(feed.eod), "eod 必須是陣列");

  const byCode = new Map(feed.eod.map((row) => [row.code, row]));
  for (const code of feed.holdings) {
    assert.ok(byCode.has(code), `${code}: 在持股清單裡卻沒有報價`);
  }
  for (const row of feed.eod) {
    // 0 是「當天沒成交」，不是價格——保留前一份也好過寫一個 0 上去
    assert.ok(typeof row.close === "number" && row.close > 0, `${row.code}: 收盤 ${row.close} 不是正數`);
    assert.match(row.date || "", ISO_DATE, `${row.code}: 資料日格式異常`);
    assert.ok(row.name, `${row.code}: 少了名稱`);
    if (row.change != null) assert.ok(typeof row.change === "number", `${row.code}: 漲跌必須是數字或 null`);
  }
});

// 保留舊列時日期必須被**拖回去**。取最新的那一列會讓整份 feed 看起來是今天的，
// 而其中幾檔其實停在上週——這正是 feed-preservation.test.js
//「mergeFeed dates the feed by its oldest row」釘住的規則，這裡驗它真的落到檔案上。
test("the feed is dated by its oldest row, never its newest", async () => {
  const feed = await readFeed();
  const dates = feed.eod.map((row) => row.date).filter(Boolean).sort();
  if (!dates.length) return;
  assert.equal(feed.eodTradingDate, dates[0],
    `eodTradingDate ${feed.eodTradingDate} 不是最舊的那一列（${dates[0]}）——保留的舊列必須把日期拖回去`);
  assert.ok(feed.eodTradingDate <= new Date().toISOString().slice(0, 10), "資料日在未來");
});

test("valuation and the 10Y yield stay inside believable bands", async () => {
  const feed = await readFeed();
  for (const [code, entry] of Object.entries(feed.valuation || {})) {
    assert.ok(feed.holdings.includes(code), `${code}: 有估值卻不在持股清單裡`);
    assert.equal(entry.code, code, `${code}: 估值的 code 欄與鍵不符`);
    for (const field of ["pe", "pbRatio", "dividendYield"]) {
      const value = entry[field];
      if (value == null) continue;
      assert.ok(typeof value === "number" && value >= 0, `${code}: ${field} ${value} 是負的`);
    }
  }
  const y = feed.yield10y;
  if (y) {
    assert.match(y.date || "", ISO_DATE, "10Y 的資料日格式異常");
    assert.ok(typeof y.value === "number" && y.value > 0 && y.value < 25,
      `10Y ${y.value}% 不在合理區間`);
    assert.ok(y.source, "10Y 必須說得出來源");
  }
});

test("errors are well formed so the page can say what degraded", async () => {
  const feed = await readFeed();
  assert.ok(Array.isArray(feed.errors), "errors 必須存在——畫面靠它說出降級");
  for (const entry of feed.errors) {
    assert.ok(entry && entry.source, "每筆 error 都要說得出是哪個來源");
    assert.ok(entry.message, "每筆 error 都要有訊息");
  }
  assert.match(feed.updatedAt || "", /^\d{4}-\d{2}-\d{2}T/, "updatedAt 必須是 ISO 時間");
});
