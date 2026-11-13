// 一次性回補：用除權息「計算結果表」（上市 TWT49U、上櫃 exDailyQ）核對整段配息歷史。
//
// 每日管線只回看 40 天。這支把更早的期間補齊：補上官方有而存檔沒有的配息、
// 拿掉官方沒有的第三方事件，並把「官方已確認的期間」寫進 etf-div-history.json 的 official，
// 之後每一班只要往後延就好（見 update-etf-feed.mjs 的 extendConfirmedWindow）。
//
//   node scripts/migrate-etf-div-official.mjs --from 2025-11-01                 預演
//   node scripts/migrate-etf-div-official.mjs --from 2025-11-01 --write         寫回
//   node scripts/migrate-etf-div-official.mjs --from 2025-11-01 --cache <dir>   回應落檔，可續跑
//
// **刻意不進 CI**，理由同 migrate-52w-*.mjs：它改寫 CI 自己在寫的檔案，而且要對證交所
// 連打十幾個請求——那個網域會限速（連打就回 HTML 錯誤頁），所以每個請求之間隔 50 秒，
// 13 個月跑完約 6 分鐘。寫回之後要重跑 update-etf-feed.mjs，feed 的殖利率才會跟著更新。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  accumulateDivHistory, addDays, dropUnconfirmedThirdParty, extendConfirmedWindow, normalizeEtfSplits, normalizeExRightResults,
} from "./update-etf-feed.mjs";

const HISTORY_FILE = new URL("../data/etf-div-history.json", import.meta.url);
const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const SOURCES = {
  twse: (from, to) => `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${from.replace(/-/g, "")}&endDate=${to.replace(/-/g, "")}&response=json`,
  tpex: (from, to) => `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${from.replace(/-/g, "%2F")}&endDate=${to.replace(/-/g, "%2F")}&response=json`,
};
// ETF 分割／反分割的恢復買賣參考價表：整段期間一個請求就拿得完（實測 25 個月 11 筆）
const SPLIT_SOURCES = [
  ["twse", "TWTCAU", (from, to) => `https://www.twse.com.tw/rwd/zh/split/TWTCAU?startDate=${from.replace(/-/g, "")}&endDate=${to.replace(/-/g, "")}&response=json`],
  ["tpex", "etfSplitRslt", (from, to) => `https://www.tpex.org.tw/www/zh-tw/bulletin/etfSplitRslt?startDate=${from.replace(/-/g, "%2F")}&endDate=${to.replace(/-/g, "%2F")}&response=json`],
  ["tpex", "etfRvsRslt", (from, to) => `https://www.tpex.org.tw/www/zh-tw/bulletin/etfRvsRslt?startDate=${from.replace(/-/g, "%2F")}&endDate=${to.replace(/-/g, "%2F")}&response=json`],
];
const PACE_MS = { twse: 50_000, tpex: 3_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// [from, to] 切成不重疊、首尾相接的兩個月一段
export function splitWindows(from, to) {
  const out = [];
  let start = from;
  while (start <= to) {
    const d = new Date(start + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 2);
    const end = addDays(d.toISOString().slice(0, 10), -1);
    out.push([start, end < to ? end : to]);
    start = addDays(out[out.length - 1][1], 1);
  }
  return out;
}

async function loadTable(market, from, to, cacheDir, source = null) {
  const file = cacheDir ? `${cacheDir}/${source ? `${source[0]}_split` : market}_${from}_${to}.json` : null;
  if (file) {
    try { return { payload: JSON.parse(await readFile(file, "utf8")), cached: true }; } catch { /* 沒有快取就抓 */ }
  }
  const url = source ? source[1](from, to) : SOURCES[market](from, to);
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = JSON.parse(await response.text()); // 被限速時回的是 HTML，這裡會丟例外
  if (file) await writeFile(file, JSON.stringify(payload), "utf8");
  return { payload, cached: false };
}

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
  const from = arg("--from");
  const cacheDir = arg("--cache");
  const write = process.argv.includes("--write");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from))) throw new Error("--from YYYY-MM-DD 必填");
  if (cacheDir) await mkdir(cacheDir, { recursive: true });

  const history = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  const feed = JSON.parse(await readFile(FEED_FILE, "utf8"));
  // 確認到 feed 的收盤日為止，跟每日管線同一個口徑：那一天的結果表開盤前就公布了，
  // 而「今天」的表在盤前跑這支時可能還沒出來——確認到一張還不存在的表等於把那天的事件當成假的
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(feed.tradeDate || "")) ? feed.tradeDate : new Date().toISOString().slice(0, 10);
  const marketOf = {};
  for (const row of feed.stocks) marketOf[row.code] = row.market;

  const events = [];
  const official = {};
  for (const market of ["twse", "tpex"]) {
    let complete = true;
    for (const [a, b] of splitWindows(from, to)) {
      try {
        const { payload, cached } = await loadTable(market, a, b, cacheDir);
        const found = normalizeExRightResults(payload, market);
        events.push(...found);
        console.log(`${market} ${a}~${b}: ${found.length} 筆 ETF 除息${cached ? "（快取）" : ""}`);
        if (!cached) await sleep(PACE_MS[market]);
      } catch (error) {
        complete = false;
        console.log(`${market} ${a}~${b}: 失敗（${error.message}）`);
        // 失敗之後也要等：被限速時緊接著再打只會讓限速升級（2026-11-13 實測三個窗口連續 307 之後，
        // 連 mis 子網域都跟著被擋）
        await sleep(PACE_MS[market]);
      }
    }
    // 有任何一段沒抓到，整個市場就不標成已確認——中間缺一段的窗口不能拿來刪東西
    if (complete) official[market] = { from, to };
    else console.log(`${market}: 有窗口沒抓到，這個市場這次不寫 official（重跑即可，--cache 會續跑）`);
  }

  // 分割要跟配息一起回補：官方金額是當時每單位的金額，沒有分割紀錄就沒辦法換算到現在的單位。
  // 有一張分割表沒抓到就整個不做——少一次分割，那一檔分割前的配息會以舊單位寫進存檔。
  const splits = [];
  for (const [market, name, url] of SPLIT_SOURCES) {
    try {
      const { payload, cached } = await loadTable(market, from, to, cacheDir, [name, url]);
      const found = normalizeEtfSplits(payload, market, name);
      splits.push(...found);
      console.log(`${name} ${from}~${to}: ${found.length} 筆分割／反分割${cached ? "（快取）" : ""}`);
      if (!cached) await sleep(PACE_MS[market]);
    } catch (error) {
      throw new Error(`${name} 沒抓到（${error.message}）——分割表不齊不回補，重跑即可`);
    }
  }

  const before = JSON.stringify(history.stocks);
  const merged = accumulateDivHistory(history, events, feed.stocks.map((row) => row.code), feed.tradeDate, splits);
  for (const s of merged.splitsRecorded || []) console.log(`分割：${s.code} ×${s.ratio}（${s.date} 恢復買賣）→ 之前的官方配息換算到現在的單位`);
  const dropped = dropUnconfirmedThirdParty(merged.stocks, official, (code) => marketOf[code]);
  const previous = JSON.parse(before);
  const added = [];
  const upgraded = [];
  for (const [code, entry] of Object.entries(merged.stocks)) {
    for (const [ex, event] of Object.entries(entry.events || {})) {
      const old = previous[code] && previous[code].events && previous[code].events[ex];
      if (!old) added.push(`${code}@${ex} ${event.dps}`);
      else if (old.src !== event.src) upgraded.push(`${code}@${ex}`);
    }
  }
  console.log(`\n官方事件 ${events.length} 筆；確認期間 ${JSON.stringify(official)}`);
  console.log(`補上（存檔原本沒有，或日期被官方校正）：${added.length} 筆 ${added.slice(0, 20).join("、")}`);
  console.log(`來源升級為官方：${upgraded.length} 筆`);
  console.log(`拿掉（官方沒有的第三方事件）：${dropped.length} 筆 ${dropped.slice(0, 20).map((d) => `${d.code}@${d.ex} ${d.dps}`).join("、")}`);
  for (const c of merged.conflicts || []) {
    const verdict = { official: "更早的配息兩邊對得上，判定第三方抄錯，改用官方值", split: "有分割紀錄解釋，收官方值並換算到現在的單位", kept: "比例像分割、沒有更早的可比，維持存檔金額並記下 officialDps" }[c.verdict];
    console.log(`金額對不上：${c.code}@${c.ex} 官方 ${c.official}、存檔（第三方）${c.stored} → ${verdict}`);
  }
  for (const r of dropped.refused || []) {
    delete official[r.market];
    console.log(`!! ${r.market}：要刪 ${r.count}／${r.of} 筆，超過保險門檻，這個市場不刪也不寫 official——多半是表沒讀對`);
  }

  if (!write) {
    console.log("\n預演結束，沒有寫入。加 --write 才會改檔。");
    return;
  }
  // 跟存檔原本的期間接得上就取聯集（分兩次跑、兩個市場各補一段時不會互相蓋掉）
  const merge = { ...(history.official || {}) };
  for (const market of Object.keys(official)) merge[market] = extendConfirmedWindow(merge[market], official[market]);
  // 三張分割表都讀到了才會走到這裡（讀不到在上面就丟例外了），所以兩個市場都確認到 [from, to]
  const checked = { ...(history.splitsChecked || {}) };
  for (const market of ["twse", "tpex"]) checked[market] = extendConfirmedWindow(checked[market], { from, to });
  await writeFile(HISTORY_FILE, JSON.stringify({ start: merged.start, updatedAt: new Date().toISOString(), official: merge, splitsChecked: checked, stocks: merged.stocks }), "utf8");
  console.log("\n已寫回 data/etf-div-history.json。接著跑 update-etf-feed.mjs 讓 feed 的殖利率跟上。");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
