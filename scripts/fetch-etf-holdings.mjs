// ETF 成分股抓取（每週執行；成分股為月頻變動，不需每日）。
//
// 資料源權衡（2026-07-28 實測）：
// - TWSE OpenAPI：143 個端點，含 holding/成分者 0 個 → 官方無此資料
// - TPEX OpenAPI：同無
// - Yahoo quoteSummary topHoldings：HTTP 401，已封
// - SITCA：ASPX 表單頁，需模擬 POST，脆弱
// - MoneyDJ：實測 5/5 可用（市值型/高股息/主題型/債券型/小型皆可），13–156ms
//   → 唯一可行的機器可讀來源，但是「非官方 HTML 解析」，改版即失效。
//
// 因此本腳本刻意設計為「可以整批失敗而不傷害系統」：
// - 與每日主流程分離，失敗不影響價格/配息更新
// - 逐檔失敗只跳過該檔，保留 data/etf-holdings.json 既有值
// - 成功率低於門檻時直接不覆寫檔案（避免用殘缺結果洗掉好資料）
// - 每檔記錄 source 與 asOf；缺料由 update-etf-feed.mjs 標 hasHoldingsData:false
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const OUT_FILE = new URL("../data/etf-holdings.json", import.meta.url);
const SOURCE = "MoneyDJ Basic0007a";
const DELAY_MS = Number(process.env.HOLDINGS_DELAY_MS || 450);
const MAX_RETRY = 3;
const TOP_N = 10;
// 護欄：拒絕覆寫的條件。
// 不能只看絕對成功率——槓反/期貨型 ETF 結構上就沒有成分股頁，實測正常成功率僅約 58%
// （202/348），若門檻設 50% 只剩 8 個百分點餘裕，上游小幅劣化也偵測不到。
// 改以「相對前次筆數」為主：掉到前次的 70% 以下就視為上游異常。
const MIN_RATIO_VS_PREVIOUS = 0.7;
// 首次執行（無前次檔）時才用絕對下限把關
const MIN_FIRST_RUN_COUNT = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

export function moneydjId(code, market) {
  const cleaned = String(code == null ? "" : code).trim().toUpperCase();
  if (!/^[0-9]{4,6}[A-Z]?$/.test(cleaned)) return "";
  return cleaned + (market === "tpex" ? ".TWO" : ".TW");
}

// <td class="col05">台積電</td><td class="col06">525,977.00</td><td class="col07">57.37</td>
export function parseHoldings(html, topN = TOP_N) {
  const rows = [...String(html || "").matchAll(
    /<td class="col05">([^<]+)<\/td>\s*<td class="col06">[^<]*<\/td>\s*<td class="col07">([\d.]+)<\/td>/g
  )];
  const out = [];
  for (const row of rows) {
    const name = row[1].trim();
    const weight = Number(row[2]);
    if (!name || !Number.isFinite(weight) || weight <= 0 || weight > 100) continue;
    out.push({ name, weight: Math.round(weight * 100) / 100 });
    if (out.length >= topN) break;
  }
  return out;
}

// 指數退避重試：僅對網路/5xx 重試，4xx 直接放棄（重試也不會變好）
async function fetchWithRetry(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (response.status >= 400 && response.status < 500) throw Object.assign(new Error("HTTP " + response.status), { fatal: true });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.text();
  } catch (error) {
    if (error.fatal || attempt >= MAX_RETRY) throw error;
    await sleep(DELAY_MS * Math.pow(2, attempt));   // 450 → 900 → 1800ms
    return fetchWithRetry(url, attempt + 1);
  }
}

// 是否劣化到不該覆寫。有前次資料時比相對筆數，首次執行才看絕對下限。
export function isDegraded(okCount, previousCount) {
  if (previousCount > 0) return okCount < previousCount * MIN_RATIO_VS_PREVIOUS;
  return okCount < MIN_FIRST_RUN_COUNT;
}

async function main() {
  const feed = await readJson(FEED_FILE, null);
  if (!feed || !Array.isArray(feed.stocks) || !feed.stocks.length) {
    throw new Error("data/etf-feed.json is missing or empty — run update-etf-feed.mjs first");
  }
  const previous = await readJson(OUT_FILE, {});
  const previousEtfs = (previous && previous.etfs) || {};
  const today = new Date().toISOString().slice(0, 10);

  const etfs = {};
  let ok = 0;
  let failed = 0;
  const failures = [];

  for (const row of feed.stocks) {
    const id = moneydjId(row.code, row.market);
    if (!id) { failed += 1; continue; }
    try {
      const holdings = parseHoldings(await fetchWithRetry("https://www.moneydj.com/ETF/X/Basic/Basic0007a.xdjhtm?etfid=" + id));
      if (!holdings.length) throw new Error("no holdings rows");
      etfs[row.code] = { topHoldings: holdings, source: SOURCE, asOf: today };
      ok += 1;
    } catch (error) {
      failed += 1;
      failures.push(row.code + ": " + error.message);
      // 抓不到就沿用前次，不讓一次失敗抹掉既有資料
      if (previousEtfs[row.code]) etfs[row.code] = previousEtfs[row.code];
    }
    if ((ok + failed) % 50 === 0) console.log(`  progress ${ok + failed}/${feed.stocks.length} (ok ${ok}, fail ${failed})`);
    await sleep(DELAY_MS);
  }

  const previousCount = Object.keys(previousEtfs).length;
  console.log(`holdings: ok ${ok}, failed ${failed} (${(ok / feed.stocks.length * 100).toFixed(1)}% of universe`
    + (previousCount ? `, ${(ok / previousCount * 100).toFixed(0)}% of previous ${previousCount}` : ", first run") + ")");
  if (failures.length) console.warn("failures (first 10):\n" + failures.slice(0, 10).join("\n"));

  if (isDegraded(ok, previousCount)) {
    console.error(previousCount
      ? `only ${ok} of the previous ${previousCount} succeeded (<${MIN_RATIO_VS_PREVIOUS * 100}%) — keeping the previous file untouched (upstream likely changed)`
      : `first run produced only ${ok} entries (<${MIN_FIRST_RUN_COUNT}) — refusing to write a near-empty file`);
    process.exitCode = 1;
    return;
  }

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: SOURCE,
    note: "非官方來源之 HTML 解析；官方 API 無成分股資料。僅取前十大權重。",
    count: Object.keys(etfs).length,
    etfs,
  }), "utf8");
  console.log(`written data/etf-holdings.json (${Object.keys(etfs).length} etfs)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
