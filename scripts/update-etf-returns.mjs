// ETF 近一年總報酬（回測，非預測）。
//
// 為什麼需要這支：配置產生器原本的目標是「最大化配息」，但配息不等於賺到錢——
// 一檔配 10% 而淨值跌 12% 的 ETF 帳面在賠錢，卻會被排到第一名。要以「最終賺多少」
// 為目標就得有價差那一半，而 etf-feed 只有配息（close/nav/aum/dps/殖利率），
// 沒有任何歷史價格；market-52w.json 也只累積個股（1,974 檔裡 0 檔是 ETF）。
//
// Yahoo 的 adjclose 是還原配息後的價格序列，首末相除即總報酬；raw close 相除
// 是純價差，兩者相減就是配息貢獻。實測 0056：總報酬 +53.6%／價差 +39.4%。
//
// **但 adjclose 不還原台股 ETF 的分割。** 實測 0052 富邦科技在 2025-11-17 分割，
// raw 由 229 掉到 36、adjclose 由 223.5 掉到 35.1，兩者同樣斷裂，而 Yahoo 的
// events.splits 是空的（日線月線都查過）。直接相除會得到 −73% 這種完全錯誤的數字。
// 因此改抓日線自行偵測：台股有 ±10% 漲跌幅限制，單日比值落在 [0.85, 1.18] 之外
// 在數學上不可能是行情，只可能是分割／合併。取樣 45 檔實測命中 1 檔（2.2%）。
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FEED_FILE = new URL("../data/etf-feed.json", import.meta.url);
const RETURNS_FILE = new URL("../data/etf-returns.json", import.meta.url);
const DELAY_MS = 120;

// 合法的單日變動區間。原本只有一組 [0.85, 1.18]，理由是「台股 ±10% 漲跌幅限制」——
// **那個前提對槓桿 ETF 不成立**：2x 追蹤指數當日報酬的兩倍，單日合法區間是 ±20%。
// 實測 2026-07-31：0050 漲停 +10.00%、2330 +9.98%，四檔台股正2 同步 +18.2~18.8%，
// 全部被舊門檻判成「無法解釋的跳動」而整檔丟棄——含規模 2,690 億的 00631L。
// 放寬後 0052 的 1:7 分割（0.1431）與 00738U 的 0.6885 仍照樣擋得住。
const STEP_BANDS = {
  normal: { lo: 0.85, hi: 1.18 },
  leveraged: { lo: 0.75, hi: 1.28 },
};
// 區間必須真的接近一年，否則「近一年報酬」其實是近七個月，會系統性低估波動大的標的
const MIN_SPAN_DAYS = 330;

// 台股分割／合併都是乾淨比例。只有在觀測到的比值貼近其中之一時才校正，
// 否則寧可不發布——用觀測比值本身當校正係數會把當天最多 10% 的真實漲跌
// 一起吃進係數裡，讓整段歷史偏移最多 10%。
const SPLIT_RATIOS = (() => {
  const out = [];
  for (let n = 2; n <= 20; n += 1) { out.push(1 / n); out.push(n); }
  for (const [a, b] of [[2,3],[3,2],[3,4],[4,3],[4,5],[5,4],[5,2],[2,5]]) out.push(a / b);
  return out;
})();
const SNAP_TOLERANCE = 0.02;

export function snapSplitRatio(ratio) {
  let best = null;
  for (const candidate of SPLIT_RATIOS) {
    const err = Math.abs(ratio / candidate - 1);
    if (err <= SNAP_TOLERANCE && (best === null || err < best.err)) best = { candidate, err };
  }
  return best ? best.candidate : null;
}

// 三個觀察窗。tolerance 是允許的缺口：交易日不是每天都有，5 年約 1,215 個交易日，
// 用日曆天算會永遠差一截，所以各留一段寬容。
const WINDOWS = [
  { key: "1y", days: 365, tolerance: 35 },
  { key: "3y", days: 365 * 3, tolerance: 60 },
  { key: "5y", days: 365 * 5, tolerance: 90 },
];

// 從校正後的序列切出一個時間窗並算出該窗的指標。
// 所有計算都用 raw * factor（分割校正後）——0052 的 1:7 分割若沒校正，
// 會被算成 −86% 的單日回撤，整個風險側就毀了。
export function windowMetrics(points, factors, days) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const endMs = Date.parse(points[points.length - 1].date + "T00:00:00Z");
  const startMs = endMs - days * 86400000;
  const w = WINDOWS.find((x) => x.days === days);
  const tolerance = (w ? w.tolerance : 35) * 86400000;

  let firstIndex = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (Date.parse(points[i].date + "T00:00:00Z") >= startMs) { firstIndex = i; break; }
  }
  if (firstIndex < 0) return null;
  // 起點必須真的接近窗的起始日。序列只有兩年時，5y 窗會從第一筆開始，
  // 那樣算出來的「5 年報酬」其實是兩年——那是假的，不可發布。
  if (Date.parse(points[firstIndex].date + "T00:00:00Z") - startMs > tolerance) return null;

  const slice = points.slice(firstIndex);
  // 報酬與回撤兩個點就算得出來；只有波動度需要足夠樣本，那個門檻放在下面。
  // 把 20 點的要求套在整組上，會讓資料稀疏的標的連報酬都消失。
  if (slice.length < 2) return null;
  const adj = slice.map((p, i) => p.raw * factors[firstIndex + i]);
  const pct = (from, to) => Math.round((to / from - 1) * 1000) / 10;

  const daily = [];
  for (let i = 1; i < adj.length; i += 1) daily.push(adj[i] / adj[i - 1] - 1);

  let peak = adj[0];
  let worst = 0;
  for (const p of adj) { if (p > peak) peak = p; const d = p / peak - 1; if (d < worst) worst = d; }

  let volatility = null;
  let downside = null;
  if (daily.length >= 20) {
    const mean = daily.reduce((s, r) => s + r, 0) / daily.length;
    const variance = daily.reduce((s, r) => s + (r - mean) ** 2, 0) / (daily.length - 1);
    volatility = Math.round(Math.sqrt(variance) * Math.sqrt(252) * 1000) / 10;
    // 下檔標準差（Sortino 的分母）：只累計負報酬，但**分母仍用全部樣本數**。
    // 改用「負報酬的筆數」當分母是常見的寫錯法——那算的是「跌的時候跌多兇」，
    // 不是「整段期間承受多少下檔風險」，會讓很少跌但一跌就重摔的標的看起來更好。
    const sq = daily.reduce((s, r) => s + (r < 0 ? r * r : 0), 0) / daily.length;
    downside = Math.round(Math.sqrt(sq) * Math.sqrt(252) * 1000) / 10;
  }
  const out = {
    priceReturn: pct(adj[0], adj[adj.length - 1]),
    maxDrawdown: Math.round(worst * 1000) / 10,
    volatility: volatility,
    // 與 volatility 同一組日報酬（分割校正後的價格序列）。
    // 實測改用還原息的序列只差 0.0~0.8pp（0056 最大：22.1 vs 21.6），
    // 不值得為此多開一組欄位、也不值得讓兩個波動數字在畫面上並存。
    downsideDeviation: downside,
  };

  // 總報酬走 adjclose（已還原配息）；缺 adjclose 就不發總報酬，
  // 不拿 raw 假裝——那會把配息貢獻整個吃掉
  const adjPts = slice.map((p, i) => ({ v: p.adj, f: factors[firstIndex + i] })).filter((p) => p.v != null);
  if (adjPts.length >= 2) {
    const a = adjPts[0], b = adjPts[adjPts.length - 1];
    out.totalReturn = pct(a.v * a.f, b.v * b.f);
    const years = days / 365;
    const growth = (b.v * b.f) / (a.v * a.f);
    if (growth > 0) out.cagr = Math.round((Math.pow(growth, 1 / years) - 1) * 1000) / 10;
  }
  // 缺 adjclose 只代表算不出總報酬，價格報酬與回撤仍然成立——
  // 整組丟掉會讓那些標的連價差都消失。
  return out;
}

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

// 回傳 {from,to,spanDays,priceReturn1y,totalReturn1y?,splitsApplied} 或
// {skip:"原因"}。校正方式：偵測到分割後，把該點之前的所有價格乘上分割比例，
// 讓整段序列回到同一個股數基準；raw 與 adj 套用同一組係數。
// options.leveraged 由呼叫端依 feed 的 type 決定，不在這裡重新猜——
// 猜錯的代價是整檔資料消失，而呼叫端本來就拿得到正確的型別。
export function yahooReturns(payload, options) {
  const band = (options && options.leveraged) ? STEP_BANDS.leveraged : STEP_BANDS.normal;
  const result = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  if (!result || !Array.isArray(result.timestamp) || result.timestamp.length < 2) return { skip: "no price points" };

  const quote = (result.indicators && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null) || {};
  const adjHolder = result.indicators && Array.isArray(result.indicators.adjclose) ? result.indicators.adjclose[0] : null;
  const rawSeries = Array.isArray(quote.close) ? quote.close : [];
  const adjSeries = adjHolder && Array.isArray(adjHolder.adjclose) ? adjHolder.adjclose : [];

  let points = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const raw = Number(rawSeries[i]);
    const adj = Number(adjSeries[i]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    points.push({
      date: new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10),
      raw,
      adj: Number.isFinite(adj) && adj > 0 ? adj : null,
    });
  }
  if (points.length < 2) return { skip: "fewer than 2 usable closes" };

  // 分割偵測與校正：由後往前累乘，讓「較早的價格」換算到目前的股數基準
  let factors = new Array(points.length).fill(1);
  let cumulative = 1;
  let splitsApplied = 0;
  let unexplainedAt = -1;      // 最晚一次無法解釋的跳動：它之前的資料一律不可信
  let unexplainedNote = null;
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const step = points[i].raw / points[i - 1].raw;
    if (step < band.lo || step > band.hi) {
      const snapped = snapSplitRatio(step);
      if (snapped == null) {
        // 跳動超出漲跌幅限制、又不貼近任何乾淨的分割比例 → 不猜。
        // 但**只有跨越它的窗才不能算**：四年前的一次不明跳動不該讓 1Y 也消失。
        // 原本整檔丟棄，改抓 5 年資料後 1Y 覆蓋率從 293 掉到 267 就是這個原因。
        unexplainedAt = i;
        unexplainedNote = `unexplained ${step.toFixed(4)}x jump on ${points[i].date}`;
        break;   // 更早的資料一律不可信，不必再往前掃
      }
      cumulative *= snapped;
      splitsApplied += 1;
    }
    factors[i - 1] = cumulative;
  }

  // 把序列截到不明跳動之後。整檔丟棄太粗暴——乾淨的那一段仍然算得出來，
  // 而跨越跳動的長窗會被 windowMetrics 的起點容差自然擋掉。
  if (unexplainedAt > 0) {
    points = points.slice(unexplainedAt);
    factors = factors.slice(unexplainedAt);
    if (points.length < 20) return { skip: unexplainedNote };
  }

  const last = points[points.length - 1];
  const out = {
    from: points[0].date,
    to: last.date,
    spanDays: Math.round((Date.parse(last.date) - Date.parse(points[0].date)) / 86400000),
  };
  if (splitsApplied) out.splitsApplied = splitsApplied;
  if (unexplainedNote) out.truncatedBy = unexplainedNote;

  // **只給一年的數字會誤導。** 這份資料裡大盤一年翻倍，0050 的 +106.7% 是牛市產物；
  // 同一檔 5 年總報酬 243.3%、CAGR 約 28%，那才是可以拿來比較的量級。
  // 一次 5y 抓取切出三個窗，不必多打 API。
  for (const w of WINDOWS) {
    const m = windowMetrics(points, factors, w.days);
    if (!m) continue;                       // 歷史不足這個窗就整組不發，不用短區間冒充
    out["totalReturn" + w.key] = m.totalReturn;
    out["priceReturn" + w.key] = m.priceReturn;
    out["maxDrawdown" + w.key] = m.maxDrawdown;
    if (m.volatility != null) out["volatility" + w.key] = m.volatility;
    if (m.downsideDeviation != null) out["downsideDeviation" + w.key] = m.downsideDeviation;
    // 1Y 的 CAGR 依定義等於總報酬，重複輸出只會讓人以為是兩個不同的數字
    if (w.key !== "1y" && m.cagr != null) out["cagr" + w.key] = m.cagr;
  }
  return out;
}

export function hasFullYear(entry) {
  // 至少要有 1Y 才發布。3Y／5Y 各自由 windowMetrics 決定有沒有，缺就不出現該欄。
  // 至少要有 1Y 窗算得出東西（缺 adjclose 時只有價格報酬，仍可發布）。
  // 3Y／5Y 各自由 windowMetrics 決定有沒有，缺就不出現該欄。
  return Boolean(entry && !entry.skip && entry.spanDays >= MIN_SPAN_DAYS && entry.priceReturn1y != null);
}

async function main() {
  const feed = await readJson(FEED_FILE, null);
  if (!feed || !Array.isArray(feed.stocks) || !feed.stocks.length) {
    throw new Error("data/etf-feed.json is missing or empty — run update-etf-feed.mjs first");
  }
  const previous = await readJson(RETURNS_FILE, {});
  const prevStocks = previous.stocks && typeof previous.stocks === "object" ? previous.stocks : {};
  const today = feed.tradeDate || new Date().toISOString().slice(0, 10);

  const stocks = {};
  const skipped = {};
  let ok = 0;
  let failed = 0;
  let preserved = 0;
  let splitFixed = 0;
  const failures = [];

  for (const row of feed.stocks) {
    const symbol = row.code + (row.market === "tpex" ? ".TWO" : ".TW");
    try {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=1d`,
        { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } },
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const entry = yahooReturns(await response.json(), { leveraged: row.type === "槓桿反向" });
      if (entry.skip) { skipped[row.code] = { reason: "unparsable", detail: entry.skip }; continue; }
      if (!hasFullYear(entry)) {
        // 記下實際天數：畫面上的「—」要說得出是「成立未滿一年」還是「抓不到」，
        // 使用者才不會以為是 API 壞了或還沒算完。
        skipped[row.code] = { reason: "history", days: entry.spanDays || 0, from: entry.from || null };
        continue;
      }
      if (entry.splitsApplied) splitFixed += 1;
      stocks[row.code] = entry;
      ok += 1;
    } catch (error) {
      // 上游單檔失敗不得讓該檔歸零——沿用前次值並標記，與 feed 的保留策略一致
      if (prevStocks[row.code]) {
        stocks[row.code] = Object.assign({}, prevStocks[row.code], { preserved: true });
        preserved += 1;
      }
      failed += 1;
      if (failures.length < 20) failures.push(`${row.code}: ${error.message}`);
    }
    if (DELAY_MS) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  // 成功數大幅下滑時拒絕覆寫，比照 fetch-etf-holdings 的 isDegraded 守則
  const prevCount = Object.keys(prevStocks).length;
  if (prevCount && ok < prevCount * 0.7) {
    console.error(`refusing to overwrite: only ${ok} ok vs ${prevCount} previously (< 70%)`);
    for (const line of failures) console.error("  " + line);
    process.exitCode = 1;
    return;
  }

  await writeFile(RETURNS_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    asOf: today,
    basis: "Yahoo Finance adjclose（已還原配息）近一年；分割自行校正。回測數字，非預測。",
    count: Object.keys(stocks).length,
    skippedCount: Object.keys(skipped).length,
    stocks,
    skipped,
  }), "utf8");

  console.log(`etf-returns: ${ok} ok (${splitFixed} split-corrected), ${Object.keys(skipped).length} skipped, ${failed} failed, ${preserved} preserved`);
  if (failures.length) console.warn(failures.join("\n"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
