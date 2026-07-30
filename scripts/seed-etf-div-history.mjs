// 用 Yahoo 配息事件補 data/etf-div-history.json，讓「近 12 月殖利率」不必等官方源累積。
//
// 三種模式：
//   （無旗標）  首次回填：只處理尚未 seeded 的檔，range=2y 抓滿兩年歷史。
//   --incremental  每日增量：所有檔都用短窗重抓最近事件（進 workflow 排程）。
//   --refill       全部重抓 2 年：保留窗改長後要用它把被剪掉的舊事件取回。
//
// 為什麼增量模式必須存在（實測 2026-07-30）：官方來源涵蓋不全 ——
// TWSE etfDiv 只有 95 檔（且 00888 這種有配息的上市 ETF 竟不在內），
// TPEX 的除權除息預告表只涵蓋 21 筆上櫃 ETF。
// 結果是 207 檔有配息紀錄的 ETF 裡，112 檔的事件全部來自 Yahoo。
// 這支工具原本只能手動跑，等於那 112 檔的配息資料凍結在最後一次手動執行的時間點，
// 且會隨 13 個月窗剪枝逐筆消失 —— 畫面上就是「殖利率沒有及時更新」。
//
// 交叉驗證結論（2026-07-27 實測 0056/00878/0050/00919 共 9 筆重疊事件）：
// - Yahoo 的日期是「除息日」，與官方 etfDiv 的除息日 100% 吻合，金額亦完全一致
// - Yahoo 沒有發放日 → 依官方資料量到的 ex→pay 間隔推算（285 筆官方事件：
//   中位 24 天、四分位 23–27、全距 17–36）。有官方紀錄的檔用「該檔中位間隔」，
//   其餘用全體中位數 24 天，並標記 payEstimated=true 供 UI 揭露。
// - 官方事件一律優先：Yahoo 僅填補官方沒有的除息日，絕不覆蓋官方金額或發放日。
import { readFile, writeFile } from "node:fs/promises";

const HISTORY_FILE = new URL("../data/etf-div-history.json", import.meta.url);
const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const DELAY_MS = Number(process.env.SEED_DELAY_MS || 120);
const DEFAULT_LAG_DAYS = 24;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

export function medianLagDays(events) {
  const lags = [];
  for (const [ex, event] of Object.entries(events || {})) {
    if (!event || !event.pay || event.payEstimated) continue;
    const days = Math.round((new Date(event.pay) - new Date(ex)) / 86400000);
    if (days >= 0 && days < 120) lags.push(days);
  }
  if (!lags.length) return null;
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)];
}

export function addDays(isoDate, days) {
  const date = new Date(isoDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function yahooDividends(payload) {
  const result = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  const dividends = (result && result.events && result.events.dividends) || {};
  return Object.values(dividends)
    .map((item) => ({ ex: new Date(item.date * 1000).toISOString().slice(0, 10), dps: Number(item.amount) }))
    .filter((item) => item.ex && Number.isFinite(item.dps) && item.dps > 0)
    .sort((a, b) => a.ex.localeCompare(b.ex));
}

// 同一次配息在 Yahoo 與官方之間可能差 1 天（Yahoo 時間戳為 UTC，台灣 UTC+8），
// 只比對完全相同的日期會把同一筆算兩次（實測 00917 官方 01-19 / Yahoo 01-20，
// 3.5 元被灌成 7 元、殖利率從 ~14.8% 爆成 29.66%）。
// 合法 ETF 不可能 7 天內配息兩次，故以 ±7 天為同一事件。
const DEDUPE_WINDOW_DAYS = 7;

export function hasNearbyEvent(events, ex, windowDays = DEDUPE_WINDOW_DAYS) {
  const target = new Date(ex + "T00:00:00Z").getTime();
  for (const existing of Object.keys(events || {})) {
    const diff = Math.abs(new Date(existing + "T00:00:00Z").getTime() - target) / 86400000;
    if (diff <= windowDays) return existing;
  }
  return null;
}

// 首次回填只挑沒 seeded 過的（缺 coverFrom 的舊資料視為未完成，自動重抓）；
// 增量模式要處理全部，因為新配息可能發生在任何一檔——包含至今從未配息的新 ETF。
export function selectTargets(feedStocks, store, incremental) {
  const rows = Array.isArray(feedStocks) ? feedStocks : [];
  if (incremental) return rows.slice();
  return rows.filter((row) => !(store[row.code] && store[row.code].seeded && store[row.code].coverFrom));
}

// --refill 與 --incremental 都要掃全部，差別只在抓多長的區間
export function resolveMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes("--refill")) return { all: true, range: "2y", markSeeded: true, label: "refill" };
  if (args.includes("--incremental")) return { all: true, range: "6mo", markSeeded: false, label: "incremental refresh" };
  return { all: false, range: "2y", markSeeded: true, label: "seeding" };
}

// 只補官方沒有的除息日；回傳新增筆數
export function mergeYahooEvents(entry, yahooEvents, lagDays) {
  let added = 0;
  for (const event of yahooEvents) {
    if (hasNearbyEvent(entry.events, event.ex)) continue; // 官方（或先前回填）已有同一次配息 → 不重複計入
    entry.events[event.ex] = {
      pay: addDays(event.ex, lagDays),
      dps: Math.round(event.dps * 10000) / 10000,
      payEstimated: true,
      src: "yahoo",
    };
    added += 1;
  }
  return added;
}

async function main() {
  const feed = await readJson(FEED_FILE, null);
  if (!feed || !Array.isArray(feed.stocks) || !feed.stocks.length) {
    throw new Error("data/etf-feed.json is missing or empty — run update-etf-feed.mjs first");
  }
  const history = await readJson(HISTORY_FILE, {});
  const store = history.stocks && typeof history.stocks === "object" ? history.stocks : {};
  const tradeDate = feed.tradeDate || new Date().toISOString().slice(0, 10);

  // 全體中位間隔（僅取官方、非推估的事件）
  const allLags = [];
  for (const entry of Object.values(store)) {
    const lag = medianLagDays(entry.events);
    if (lag != null) allLags.push(lag);
  }
  allLags.sort((a, b) => a - b);
  const globalLag = allLags.length ? allLags[Math.floor(allLags.length / 2)] : DEFAULT_LAG_DAYS;
  console.log(`global median ex→pay lag: ${globalLag} days (from ${allLags.length} etfs)`);

  // 增量用 6mo 而非 3mo：季配標的若上次除息在 3.5 個月前，3mo 窗會剛好落空；
  // 同一個請求拿 6 個月不多花成本，也讓排程斷幾天仍補得回來。
  const mode = resolveMode(process.argv);
  const incremental = !mode.markSeeded;
  const pending = selectTargets(feed.stocks, store, mode.all);
  const range = mode.range;
  console.log(`${mode.label} ${pending.length} / ${feed.stocks.length} etfs (range ${range}, delay ${DELAY_MS}ms)`);

  let ok = 0;
  let failed = 0;
  let addedTotal = 0;
  const failures = [];
  for (const row of pending) {
    const symbol = row.code + (row.market === "tpex" ? ".TWO" : ".TW");
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d&events=div`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const events = yahooDividends(await response.json());
      const entry = store[row.code] || (store[row.code] = { events: {} });
      const lag = medianLagDays(entry.events) ?? globalLag;
      addedTotal += mergeYahooEvents(entry, events, lag);
      // 記錄該檔配息歷史可回溯到哪：取 Yahoo 2 年區間的最早事件，
      // 即使之後被 13 個月窗剪掉也保留，供 divMonthsCovered 判斷是否已有滿年歷史。
      if (events.length) {
        const earliestEx = events[0].ex;
        if (!entry.coverFrom || earliestEx < entry.coverFrom) entry.coverFrom = earliestEx;
      } else if (!entry.coverFrom && !incremental) {
        entry.coverFrom = tradeDate; // 完全無配息紀錄：視為零覆蓋，殖利率不發布
      }
      // 只有跑滿 2 年的完整回填才算 seeded。增量模式若在此標記，新上市 ETF 會以
      // 僅 6 個月的歷史被判定「已回填」，之後永遠拿不到完整兩年區間。
      if (!incremental) entry.seeded = true;
      ok += 1;
    } catch (error) {
      failed += 1;
      failures.push(`${row.code}: ${error.message}`);
    }
    if ((ok + failed) % 100 === 0) {
      await writeFile(HISTORY_FILE, JSON.stringify({ start: history.start, updatedAt: new Date().toISOString(), stocks: store }), "utf8");
      console.log(`  progress ${ok + failed}/${pending.length} (ok ${ok}, fail ${failed}, +${addedTotal} events)`);
    }
    await sleep(DELAY_MS);
  }

  // start 反映最早事件，讓 divMonthsCovered 正確
  let earliest = null;
  for (const entry of Object.values(store)) {
    for (const ex of Object.keys(entry.events || {})) if (!earliest || ex < earliest) earliest = ex;
  }
  await writeFile(HISTORY_FILE, JSON.stringify({
    start: earliest || history.start,
    updatedAt: new Date().toISOString(),
    seededAt: new Date().toISOString(),
    stocks: store,
  }), "utf8");
  console.log(`seed complete: ok ${ok}, failed ${failed}, +${addedTotal} events, window starts ${earliest}`);
  if (failures.length) console.log("failures (first 10):\n" + failures.slice(0, 10).join("\n"));
}

const isMain = process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
