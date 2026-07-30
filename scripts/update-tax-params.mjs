// 稅參數的「自動更新」＝自動偵測過期，而不是自動猜數字。
//
// 為什麼不自動抓：財政部每年 11 月底公告下一年度的免稅額／扣除額／課稅級距，
// 實際數字放在公告頁的 PDF/ODS 附件裡。解析政府 CMS 的附件比解析 MoneyDJ 更脆弱，
// 而稅率算錯的後果又比配息資料錯更嚴重——寧可讓它大聲失敗，也不要靜靜地猜。
//
// 所以這支工具只做兩件事：
//   1. 比對 data/tax-params.json 的 rocYear 與「現在應適用的所得年度」
//   2. 讀財政部公告列表的標題，看有沒有更新的年度已經公告（只讀標題，不碰附件）
// 兩者任一顯示過期就 exit 1，讓 workflow 標記出來，由人去填新數字。
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PARAMS_FILE = new URL("../data/tax-params.json", import.meta.url);
// 財政部賦稅署新聞列表；公告標題形如「公告115年度綜合所得稅及所得基本稅額相關…」
const MOF_NEWS_URL = "https://www.mof.gov.tw/singlehtml/384fb3077bb349ea973e7fc6f13b6974?cntId=34b463dc8f1b49f29d440d92a6fd5139";

// 民國年的所得年度：1-12 月都屬當年度，隔年 5 月才申報。
// 例：2026-07-30 → 所得年度 115（2026-1911），會在 116 年 5 月申報。
export function incomeRocYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() - 1911;
}

// 從公告標題文字裡取出所有已公告的年度，回傳最大者
export function latestAnnouncedYear(html) {
  const years = [...String(html || "").matchAll(/公告\s*(\d{3})\s*年度綜合所得稅/g)]
    .map((match) => Number(match[1]))
    .filter((year) => Number.isFinite(year));
  return years.length ? Math.max(...years) : null;
}

// 純函式：給定現況，判斷是否過期並說明原因（測試不需打網路）
export function assessFreshness(params, now, announcedYear) {
  const stored = Number(params && params.rocYear);
  const needed = incomeRocYear(now);
  const reasons = [];
  if (!Number.isFinite(stored)) {
    reasons.push("tax-params.json 缺少 rocYear");
  } else {
    if (Number.isFinite(needed) && stored < needed) {
      reasons.push(`參數為 ${stored} 年度，但目前所得年度已是 ${needed} 年度`);
    }
    if (Number.isFinite(announcedYear) && announcedYear > stored) {
      reasons.push(`財政部已公告 ${announcedYear} 年度，本站仍停在 ${stored} 年度`);
    }
  }
  return { stale: reasons.length > 0, reasons, storedYear: stored, neededYear: needed, announcedYear: announcedYear ?? null };
}

async function main() {
  const raw = JSON.parse(await readFile(PARAMS_FILE, "utf8"));
  let announcedYear = null;
  let probeError = null;
  try {
    const response = await fetch(MOF_NEWS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    announcedYear = latestAnnouncedYear(await response.text());
  } catch (error) {
    probeError = error.message;
  }

  const verdict = assessFreshness(raw, new Date(), announcedYear);
  // 只寫入稽核欄位；稅率數字一律不動
  raw.checkedAt = new Date().toISOString();
  raw.latestAnnouncedYear = verdict.announcedYear;
  raw.stale = verdict.stale;
  await writeFile(PARAMS_FILE, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  console.log(`tax-params: 儲存 ${verdict.storedYear} 年度 / 應適用 ${verdict.neededYear} 年度 / 財政部最新公告 ${verdict.announcedYear ?? "未取得"}`);
  if (probeError) console.warn(`公告頁探測失敗（不影響年度比對）：${probeError}`);
  if (verdict.stale) {
    for (const reason of verdict.reasons) console.error(`過期：${reason}`);
    console.error(`請依 ${MOF_NEWS_URL} 的公告附件人工更新 data/tax-params.json，勿由程式猜測。`);
    process.exitCode = 1;
    return;
  }
  console.log("tax-params: 未過期");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
