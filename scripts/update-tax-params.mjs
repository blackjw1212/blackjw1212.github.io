// 稅參數更新：課稅級距自動抓取，其餘人工。
//
// 級距為什麼可以自動：台北國稅局的「適用稅率」頁是**真正的 HTML 表格**，
// 逐年列出「級距／綜合所得淨額／稅率／累進差額」，年度標籤就在表格前
// （形如「► 115年度累進稅率：」）。這比解析財政部公告的 PDF 附件穩健得多。
//
// 但抓到不等於可信。累進差額只要抄錯一位，肉眼看不出來、稅卻全錯，所以寫入前
// 必須通過**定義性驗證**：在每個級距交界處，兩個級距的速算式必須算出同一個數
//   quickDeduction[i] === quickDeduction[i-1] + upTo[i-1] × (rate[i] − rate[i-1])
// 解析錯位幾乎不可能通過這條檢查。驗證不過就拒絕寫入、大聲失敗。
//
// 仍然人工的部分：股利抵減率與上限、分開計稅率、免稅額／扣除額、二代健保、
// 最低稅負。這些不在該表格裡，且變動時機與級距不同，各自附出處人工維護。
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PARAMS_FILE = new URL("../data/tax-params.json", import.meta.url);
// 財政部賦稅署新聞列表；公告標題形如「公告115年度綜合所得稅及所得基本稅額相關…」
const MOF_NEWS_URL = "https://www.mof.gov.tw/singlehtml/384fb3077bb349ea973e7fc6f13b6974?cntId=34b463dc8f1b49f29d440d92a6fd5139";
// 台北國稅局「適用稅率」：逐年度的累進稅率表（HTML table，非附件）
const NTBT_RATE_URL = "https://www.ntbt.gov.tw/multiplehtml/1b82b380e1a34de9afd204d39b007db2";

const cell = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const num = (text) => {
  const n = Number(String(text).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// 解析頁面上所有年度的級距表 → [{years:[115], brackets:[...]}, …]
export function parseRateTables(html) {
  const source = String(html || "");
  const out = [];
  for (const match of source.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    // 年度標籤在表格之前，形如「115年度累進稅率」或「113至114年度累進稅率」
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    const label = [...before.matchAll(/(\d{3})\s*(?:至\s*(\d{3}))?\s*年度[^<]{0,12}(?:累進稅率|速算公式)/g)].pop();
    if (!label) continue;
    const from = Number(label[1]);
    const to = label[2] ? Number(label[2]) : from;
    const years = [];
    for (let y = Math.min(from, to); y <= Math.max(from, to); y += 1) years.push(y);

    const brackets = [];
    for (const row of match[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cell(c[1]));
      const range = cells.find((c) => /^\d[\d,]*\s*[~～]|以上/.test(c));
      const rateCell = cells.find((c) => /^\d+(\.\d+)?%$/.test(c));
      if (!range || !rateCell) continue;
      const rate = Number(rateCell.replace("%", "")) / 100;
      // 累進差額：取「稅率之後」的第一個純數字欄
      const rateAt = cells.indexOf(rateCell);
      const qd = cells.slice(rateAt + 1).map(num).find((v) => v != null);
      if (qd == null) continue;
      const upper = /以上/.test(range) ? null : num(range.split(/[~～]/)[1]);
      brackets.push({ upTo: upper, rate, quickDeduction: qd });
    }
    if (brackets.length >= 3) out.push({ years, brackets });
  }
  return out;
}

// 定義性驗證：抄錯一位就過不了。這是自動寫入的唯一許可證。
export function validateBrackets(brackets) {
  const reasons = [];
  if (!Array.isArray(brackets) || brackets.length < 3) return { ok: false, reasons: ["級距數不足"] };
  if (brackets[0].quickDeduction !== 0) reasons.push("第一級距的累進差額必須是 0");
  if (brackets[brackets.length - 1].upTo !== null) reasons.push("最高級距不得有上限");
  for (let i = 1; i < brackets.length; i += 1) {
    const prev = brackets[i - 1];
    const cur = brackets[i];
    if (!(cur.rate > prev.rate)) reasons.push(`第 ${i + 1} 級距稅率未遞增`);
    if (prev.upTo == null) { reasons.push(`第 ${i} 級距缺上限`); continue; }
    if (cur.upTo != null && !(cur.upTo > prev.upTo)) reasons.push(`第 ${i + 1} 級距上限未遞增`);
    const expected = prev.quickDeduction + prev.upTo * (cur.rate - prev.rate);
    if (Math.abs(expected - cur.quickDeduction) > 1) {
      reasons.push(`第 ${i + 1} 級距累進差額應為 ${Math.round(expected)}，解析到 ${cur.quickDeduction}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function sameBrackets(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => x.upTo === b[i].upTo && x.rate === b[i].rate && x.quickDeduction === b[i].quickDeduction);
}

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
  const needed = incomeRocYear(new Date());
  const notes = [];

  let announcedYear = null;
  try {
    const response = await fetch(MOF_NEWS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    announcedYear = latestAnnouncedYear(await response.text());
  } catch (error) {
    notes.push(`財政部公告頁探測失敗：${error.message}`);
  }

  // 存檔本身先體檢。壞掉的存檔要被修好，不是被保護——
  // 早期版本在「解析結果 ≠ 存檔」時一律不寫入，結果存檔被改壞也默默放行。
  const storedCheck = validateBrackets(raw.brackets);
  if (!storedCheck.ok) notes.push(`現存級距未通過驗證：${storedCheck.reasons.join("；")}`);

  let fetched = null;
  try {
    const response = await fetch(NTBT_RATE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tables = parseRateTables(await response.text());
    console.log(`稅率表：解析到 ${tables.length} 組年度（${tables.map((t) => t.years.join("/")).join("、")}）`);
    fetched = tables.find((t) => t.years.includes(needed)) || null;
    if (!fetched) notes.push(`稅率表尚無 ${needed} 年度`);
  } catch (error) {
    notes.push(`稅率表抓取失敗：${error.message}`);
  }

  let updated = false;
  let conflict = false;
  if (fetched) {
    const check = validateBrackets(fetched.brackets);
    if (!check.ok) {
      notes.push(`解析到的級距未通過驗證，拒絕寫入：${check.reasons.join("；")}`);
    } else if (sameBrackets(fetched.brackets, raw.brackets) && Number(raw.rocYear) === needed) {
      // 一致就什麼都不做，避免每天產生無意義的 diff
    } else if (storedCheck.ok && Number(raw.rocYear) === needed) {
      // 兩份都通過驗證卻不一致 → 無從判斷誰對，不猜，交給人
      conflict = true;
      notes.push(`同為 ${needed} 年度但級距不一致，且兩份都通過驗證——不自動覆蓋，請人工確認`);
      notes.push(`  現存：${raw.brackets.map((b) => `${b.rate * 100}%−${b.quickDeduction}`).join(" ")}`);
      notes.push(`  線上：${fetched.brackets.map((b) => `${b.rate * 100}%−${b.quickDeduction}`).join(" ")}`);
    } else {
      const before = raw.brackets.map((b) => `${b.rate * 100}%−${b.quickDeduction}`).join(" ");
      raw.rocYear = needed;
      raw.brackets = fetched.brackets;
      raw.bracketsSource = { url: NTBT_RATE_URL, label: "財政部臺北國稅局：適用稅率（累進稅率表）", fetchedAt: new Date().toISOString() };
      updated = true;
      console.log(`級距已自動更新至 ${needed} 年度${storedCheck.ok ? "" : "（修正未通過驗證的現存值）"}`);
      console.log(`  舊：${before}`);
      console.log(`  新：${fetched.brackets.map((b) => `${b.rate * 100}%−${b.quickDeduction}`).join(" ")}`);
      notes.push(`級距已自動更新；抵減率、免稅額／扣除額、二代健保、最低稅負仍需人工核對 ${MOF_NEWS_URL}`);
    }
  }
  // 壞資料沒被修好就必須大聲失敗，不可 exit 0 放行
  const brokenAfter = !validateBrackets(raw.brackets).ok;

  const verdict = assessFreshness(raw, new Date(), announcedYear);
  raw.checkedAt = new Date().toISOString();
  raw.latestAnnouncedYear = verdict.announcedYear;
  raw.stale = verdict.stale;
  await writeFile(PARAMS_FILE, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  console.log(`tax-params: 儲存 ${verdict.storedYear} 年度 / 應適用 ${verdict.neededYear} 年度 / 財政部最新公告 ${verdict.announcedYear ?? "未取得"}${updated ? " / 本次已自動更新級距" : ""}`);
  for (const note of notes) console.warn(`注意：${note}`);
  if (verdict.stale || brokenAfter || conflict) {
    for (const reason of verdict.reasons) console.error(`過期：${reason}`);
    if (brokenAfter) console.error("級距仍未通過定義性驗證——稅額會算錯，請立即人工修正。");
    if (conflict) console.error("線上與現存級距衝突，需人工裁決後再更新。");
    console.error(`人工核對來源：${MOF_NEWS_URL} ／ ${NTBT_RATE_URL}`);
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
