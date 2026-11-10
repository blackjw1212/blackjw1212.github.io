// 個股 → 產業別對照表。
//
// 為什麼需要：ETF 的 topHoldings 只有 {name, weight}，全 feed 沒有任何產業欄位，
// 所以「看起來分散、實際上全押同一個產業」這件事目前算不出來。
//
// 為什麼用 ISIN 而不是 openapi：
//   openapi t187ap03_L 的「產業別」是數字代碼（台積電 = 24），而找不到機器可讀的
//   代碼→中文對照。硬寫一張 33 類的表等於憑記憶編資料。
//   ISIN 服務（C_public.jsp）每一列同時有代碼、名稱、**中文**產業別，
//   實測上市 1,122 檔、32 類，2330 → 半導體業。順便解掉 topHoldings 只有名稱的
//   比對問題——同一份資料就能建 name→產業。
//
// 回應是 Big5，不是 UTF-8：用 fetch().text() 會整份變亂碼，必須自己解碼。
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OUT_FILE = new URL("../data/industry-map.json", import.meta.url);
const SOURCES = [
  { market: "twse", label: "上市", url: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2" },
  { market: "tpex", label: "上櫃", url: "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4" },
];

// 這些不是產業，是市場別標題列或非個股商品，不可進對照表
const NOT_INDUSTRY = /^(上市|上櫃|興櫃|其他|未分類|)$/;

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

// 一列長這樣（欄位以 <td> 分隔）：
//   ["2330　台積電", "TW0002330008", "1994/09/05", "上市", "半導體業", "ESVUFR", ""]
// 第一欄是「代碼　全形空白　簡稱」。
export function parseIsinRows(html) {
  const out = [];
  for (const tr of String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (cells.length < 5) continue;
    const head = cells[0].split(/[\s　]+/);
    const code = String(head[0] || "").trim().toUpperCase();
    const name = String(head.slice(1).join("") || "").trim();
    const industry = String(cells[4] || "").trim();
    // 只收 4 碼（含 4 碼+英文尾）的個股代碼；ETF、權證、債券不需要產業別
    if (!/^\d{4}[A-Z]?$/.test(code) || !name) continue;
    if (NOT_INDUSTRY.test(industry)) continue;
    out.push({ code, name, industry });
  }
  return out;
}

// 每一頁的上限。ISIN 那兩頁平常各十幾秒（2026-11-09 整步 47 秒），但 2026-11-10 21:29 那班
// 上市頁抓了 9 分 37 秒、上櫃頁 2 分 56 秒——沒有逾時，整條 update-market-feed 就停在這一步
// 等它，當班的行情與估值晚了 13 分鐘才上線，而那時這張表根本不需要更新（產業別月頻變動）。
// 這張表是參考資料，昨天的版本完全可用：慢就放棄、留著舊表，不可以拖住整條管線。
// 上限涵蓋 headers 與 body：signal 會一路作用到 arrayBuffer() 讀完為止，
// 慢慢滴進來的回應也會在時間到時中斷（undici 預設的 bodyTimeout 是「兩個區塊之間」，攔不住）。
export const PAGE_TIMEOUT_MS = 120_000;

// 用自己的 setTimeout 而不是 AbortSignal.timeout()：後者的計時器是 unref 的，不會撐住
// event loop——卡在沒有 socket 的地方（測試裡的假 fetch 就是）時，程序會在逾時前直接結束。
export async function fetchIsinPage(url, { fetchImpl = fetch, timeoutMs = PAGE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return new TextDecoder("big5").decode(await response.arrayBuffer());
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 上游改版或被擋時，寧可留著昨天的好資料。比照 fetch-etf-holdings 的守則。
export function isDegraded(fetchedCount, previousCount, floor = 0.7) {
  if (!previousCount) return false;
  return fetchedCount < previousCount * floor;
}

async function main() {
  const previous = await readJson(OUT_FILE, {});
  const prevCount = Number(previous.count) || 0;
  const errors = [];
  const byCode = {};
  const byName = {};
  let parsed = 0;

  // 兩頁同時抓：最壞情況從「兩個上限相加」縮成一個上限。處理仍照 SOURCES 的順序，
  // 名稱撞車時「先到先得」的結果才不會隨網路快慢而變。
  const pages = await Promise.allSettled(SOURCES.map((source) => fetchIsinPage(source.url)));
  for (const [index, source] of SOURCES.entries()) {
    try {
      const page = pages[index];
      if (page.status === "rejected") throw page.reason;
      const html = page.value;
      const rows = parseIsinRows(html);
      if (!rows.length) throw new Error("no usable rows parsed");
      for (const row of rows) {
        byCode[row.code] = row.industry;
        // 同名不同檔幾乎不存在，但真的撞名時先到先得並記下來，不要靜靜覆蓋
        if (byName[row.name] && byName[row.name] !== row.industry) {
          errors.push({ source: "name-collision", message: `${row.name}: ${byName[row.name]} vs ${row.industry}` });
          continue;
        }
        byName[row.name] = row.industry;
      }
      parsed += rows.length;
      console.log(`${source.label}: ${rows.length} 檔`);
    } catch (error) {
      errors.push({ source: source.label, message: error.message });
    }
  }

  if (isDegraded(parsed, prevCount)) {
    console.error(`refusing to overwrite: parsed ${parsed} vs ${prevCount} previously (< 70%)`);
    for (const e of errors) console.error(`  ${e.source}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!parsed) {
    console.error("no rows parsed from any source; keeping the previous map");
    process.exitCode = 1;
    return;
  }

  await writeFile(OUT_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: "TWSE ISIN C_public.jsp（strMode=2 上市 / 4 上櫃），產業別為中文原文",
    count: parsed,
    industries: [...new Set(Object.values(byCode))].sort(),
    byCode,
    byName,
    errors,
  }), "utf8");

  console.log(`industry-map: ${parsed} 檔、${new Set(Object.values(byCode)).size} 類產業、errors ${errors.length}`);
  if (errors.length) console.warn(JSON.stringify(errors.slice(0, 10), null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
