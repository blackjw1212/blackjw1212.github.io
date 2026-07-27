// 一次性本機工具（不進 GitHub Actions）：用 Yahoo 1y 日線回填 data/market-52w.json 的月 bucket，
// 讓「距 52 週高」上線第一天就有完整窗，不必等一年自然累積。
// 支援續傳：中斷後重跑會跳過已回填的個股。
import { readFile, writeFile } from "node:fs/promises";

const FEED_FILE = new URL("../data/market-feed.json", import.meta.url);
const ACC_FILE = new URL("../data/market-52w.json", import.meta.url);
const DELAY_MS = Number(process.env.SEED_DELAY_MS || 120);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

function yahooSymbol(row) {
  return row.code + (row.market === "tpex" ? ".TWO" : ".TW");
}

// 把 Yahoo 日線壓成 {"YYYY-MM":[hi,lo]} 月 bucket
export function bucketsFromChart(payload) {
  const result = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  if (!result || !Array.isArray(result.timestamp)) return null;
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const highs = quote.high || [];
  const lows = quote.low || [];
  const buckets = {};
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const hi = highs[index];
    const lo = lows[index];
    if (hi == null || lo == null) continue;
    const month = new Date(result.timestamp[index] * 1000).toISOString().slice(0, 7);
    const bucket = buckets[month];
    if (!bucket) buckets[month] = [hi, lo];
    else {
      if (hi > bucket[0]) bucket[0] = hi;
      if (lo < bucket[1]) bucket[1] = lo;
    }
  }
  for (const key of Object.keys(buckets)) {
    buckets[key] = [Math.round(buckets[key][0] * 100) / 100, Math.round(buckets[key][1] * 100) / 100];
  }
  return Object.keys(buckets).length ? buckets : null;
}

async function main() {
  const feed = await readJson(FEED_FILE, null);
  if (!feed || !Array.isArray(feed.stocks) || !feed.stocks.length) {
    throw new Error("data/market-feed.json is missing or empty — run update-market-feed.mjs first");
  }
  const acc = await readJson(ACC_FILE, {});
  const store = acc.stocks && typeof acc.stocks === "object" ? acc.stocks : {};
  const tradeDate = feed.tradeDate || new Date().toISOString().slice(0, 10);

  // 續傳：已標記 seeded 的略過
  const pending = feed.stocks.filter((row) => !(store[row.code] && store[row.code].seeded));
  console.log(`seeding ${pending.length} / ${feed.stocks.length} stocks (delay ${DELAY_MS}ms)`);

  let done = 0;
  let failed = 0;
  const failures = [];
  for (const row of pending) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(row)}?range=1y&interval=1d`;
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const buckets = bucketsFromChart(await response.json());
      if (!buckets) throw new Error("no usable candles");
      const entry = store[row.code] || (store[row.code] = { m: {} });
      // 合併：Yahoo 歷史為底，已累積的當月值取極值疊上
      for (const [month, value] of Object.entries(buckets)) {
        const existing = entry.m[month];
        if (!existing) entry.m[month] = value;
        else entry.m[month] = [Math.max(existing[0], value[0]), Math.min(existing[1], value[1])];
      }
      entry.seeded = true;
      if (!entry.lastSeen) entry.lastSeen = tradeDate;
      done += 1;
    } catch (error) {
      failed += 1;
      failures.push(`${row.code} ${row.name}: ${error.message}`);
    }
    if ((done + failed) % 200 === 0) {
      await writeFile(ACC_FILE, JSON.stringify({ start: acc.start || tradeDate, updatedAt: new Date().toISOString(), stocks: store }), "utf8");
      console.log(`  progress ${done + failed}/${pending.length} (ok ${done}, fail ${failed})`);
    }
    await sleep(DELAY_MS);
  }

  // 回填後窗口實際回溯約一年，start 必須反映最早的 bucket，
  // 否則前端footnote 會低報「52 週高低」的資料起算日。
  let earliest = null;
  for (const entry of Object.values(store)) {
    for (const month of Object.keys(entry.m || {})) {
      if (!earliest || month < earliest) earliest = month;
    }
  }
  const start = earliest ? `${earliest}-01` : (acc.start || tradeDate);
  await writeFile(ACC_FILE, JSON.stringify({ start, updatedAt: new Date().toISOString(), stocks: store, seededAt: new Date().toISOString() }), "utf8");
  console.log(`seed complete: ok ${done}, failed ${failed}, window starts ${start}`);
  if (failures.length) console.log("failures (first 20):\n" + failures.slice(0, 20).join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
