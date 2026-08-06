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

// 漲跌幅限制 10%，兩側各留緩衝（除息日、興櫃轉上市首日等會略超）
const STEP_LO = 0.85;
const STEP_HI = 1.18;
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
export function yahooReturns(payload) {
  const result = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  if (!result || !Array.isArray(result.timestamp) || result.timestamp.length < 2) return { skip: "no price points" };

  const quote = (result.indicators && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null) || {};
  const adjHolder = result.indicators && Array.isArray(result.indicators.adjclose) ? result.indicators.adjclose[0] : null;
  const rawSeries = Array.isArray(quote.close) ? quote.close : [];
  const adjSeries = adjHolder && Array.isArray(adjHolder.adjclose) ? adjHolder.adjclose : [];

  const points = [];
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
  const factors = new Array(points.length).fill(1);
  let cumulative = 1;
  let splitsApplied = 0;
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const step = points[i].raw / points[i - 1].raw;
    if (step < STEP_LO || step > STEP_HI) {
      const snapped = snapSplitRatio(step);
      // 跳動超出漲跌幅限制、又不貼近任何乾淨的分割比例 → 不猜，整檔不發布
      if (snapped == null) return { skip: `unexplained ${step.toFixed(4)}x jump on ${points[i].date}` };
      cumulative *= snapped;
      splitsApplied += 1;
    }
    factors[i - 1] = cumulative;
  }

  const pct = (from, to) => Math.round((to / from - 1) * 1000) / 10;
  const first = points[0];
  const last = points[points.length - 1];
  const out = {
    from: first.date,
    to: last.date,
    spanDays: Math.round((Date.parse(last.date) - Date.parse(first.date)) / 86400000),
    priceReturn1y: pct(first.raw * factors[0], last.raw),
  };
  if (splitsApplied) out.splitsApplied = splitsApplied;

  // 波動度與最大回撤：務必用**校正後**的價格。用原始序列的話，0052 的 1:7 分割
  // 會被算成 −86% 的單日回撤，風險分數整個毀掉——那正是這支腳本存在的理由，
  // 不要在新指標上重犯同一個錯。
  const adjusted = points.map((p, i) => p.raw * factors[i]);
  const daily = [];
  for (let i = 1; i < adjusted.length; i += 1) daily.push(adjusted[i] / adjusted[i - 1] - 1);
  if (daily.length >= 20) {
    const mean = daily.reduce((sum, r) => sum + r, 0) / daily.length;
    const variance = daily.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (daily.length - 1);
    out.volatility1y = Math.round(Math.sqrt(variance) * Math.sqrt(252) * 1000) / 10;
  }
  let peak = adjusted[0];
  let worst = 0;
  for (const price of adjusted) {
    if (price > peak) peak = price;
    const drop = price / peak - 1;
    if (drop < worst) worst = drop;
  }
  out.maxDrawdown1y = Math.round(worst * 1000) / 10;

  const adjPoints = points.map((p, i) => ({ adj: p.adj, factor: factors[i] })).filter((p) => p.adj != null);
  if (adjPoints.length >= 2) {
    const a = adjPoints[0];
    const b = adjPoints[adjPoints.length - 1];
    out.totalReturn1y = pct(a.adj * a.factor, b.adj * b.factor);
  }
  return out;
}

export function hasFullYear(entry) {
  return Boolean(entry && !entry.skip && entry.spanDays >= MIN_SPAN_DAYS);
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
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`,
        { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } },
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const entry = yahooReturns(await response.json());
      if (entry.skip) { skipped[row.code] = entry.skip; continue; }
      if (!hasFullYear(entry)) { skipped[row.code] = `only ${entry.spanDays} days of history`; continue; }
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
