// 無風險利率。Sharpe／Sortino 的分子是「超過無風險利率的那一段」，
// 沒有它就不能宣稱是風險調整後報酬。
//
// 來源選擇：中央銀行「央行貼放利率」的重貼現率。
//   - 那是**真正的 HTML 表格**（每格帶 data-th，可用欄名取值不靠欄序），
//     不是 PDF、不是 postback-only ASP.NET。
//   - 台銀牌告利率（rate.bot.com.tw）擋機器人：實測回 1,913 bytes 的
//     Challenge Validation 頁，runner 上不可能穩定，不採用。
//   - TPEX openapi 225 個 endpoint 裡沒有公債殖利率曲線（實測掃過）。
//
// 要知道的限制：重貼現率是**政策利率**，不是散戶真的存得到的利率
// （一年期定存約低 0.3~0.4pp）。用它會讓 Sharpe 略微保守——
// 分子被多扣一點。保守方向的誤差比樂觀方向安全，但畫面上必須標明是哪一種利率，
// 否則使用者無從判斷分母裡放的是什麼。
import { writeFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OUT_FILE = new URL("../data/risk-free.json", import.meta.url);
const SOURCE_URL = "https://www.cbc.gov.tw/tw/lp-640-1-1-20.html";
const SOURCE_NAME = "中央銀行 央行貼放利率";

// 央行從未把重貼現率訂在這個範圍外（歷史最高 1981 年 11.75%）。
// 這條擋的是解析錯位——抓到「短期融通利率」或把日期當成數字。
const SANE = { lo: 0, hi: 12 };

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; bjkw-site/1.0)" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      // 4xx 是我們的問題，重試沒有意義
      if (/HTTP 4\d\d/.test(String(error.message))) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError || new Error("fetch failed");
}

// 用 data-th 的欄名取值，不靠欄序——央行若加一欄，靠索引的寫法會靜默抓錯數字。
export function parseDiscountRows(html) {
  const table = (String(html || "").match(/<table[\s\S]*?<\/table>/) || [""])[0];
  const rows = table.match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    const cells = {};
    const re = /<td[^>]*data-th="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = re.exec(row))) {
      cells[m[1].trim()] = m[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    }
    const dateRaw = cells["調整日期"];
    const rateRaw = cells["重貼現率"];
    if (!dateRaw || !rateRaw) continue;
    const dm = dateRaw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const rate = Number(rateRaw);
    if (!dm || !Number.isFinite(rate)) continue;
    out.push({
      effectiveFrom: `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`,
      rate,
    });
  }
  return out;
}

// 取「生效日最晚」的那一列，不假設表格是由新到舊排序的。
// 央行若哪天改成由舊到新，靠 rows[0] 的寫法會抓到 1980 年代的利率而毫無警訊。
export function latestRate(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = null;
  for (const r of rows) {
    if (!(r.rate > SANE.lo) || !(r.rate < SANE.hi)) continue;
    const t = Date.parse(r.effectiveFrom + "T00:00:00Z");
    if (!Number.isFinite(t)) continue;
    if (t > Date.now()) continue;               // 尚未生效的調整不可拿來算今天的報酬
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

async function readJson(fileUrl, fallback) {
  try {
    return JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const previous = await readJson(OUT_FILE, null);
  const errors = [];
  let latest = null;
  try {
    latest = latestRate(parseDiscountRows(await fetchText(SOURCE_URL)));
    if (!latest) throw new Error("no usable 重貼現率 row after validation");
  } catch (error) {
    errors.push({ source: SOURCE_NAME, message: String(error.message) });
  }

  // 上游失敗絕不歸零：沿用前次並把原因寫進 errors[]，讓畫面說得出來。
  // 利率算得出來卻用 0，等於把 Sharpe 的分子灌大，比沒有數字更危險。
  if (!latest) {
    if (!previous || !(previous.rate > 0)) {
      throw new Error("risk-free rate unavailable and no previous value to preserve");
    }
    const kept = Object.assign({}, previous, { updatedAt: new Date().toISOString(), errors, preserved: 1 });
    await writeFile(OUT_FILE, JSON.stringify(kept), "utf8");
    console.log(`risk-free: preserved ${previous.rate}% (${previous.effectiveFrom}); ${errors.length} error(s)`);
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    rate: latest.rate,
    effectiveFrom: latest.effectiveFrom,
    kind: "重貼現率",
    source: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    errors,
  };
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");
  console.log(`risk-free: ${payload.rate}% since ${payload.effectiveFrom} (${SOURCE_NAME})`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
