// 輸出端的數字完整性檢查器。
//
// 設計上的關鍵取捨，寫在最前面因為它決定了整支的形狀：
//
// **不要試圖在自由散文裡分類數字。** 「每個數字都要有標籤」在規格上讀起來很好，
// 做成 checker 就會被 v1、2026-09-19、第 3 項、2330、20 筆 洗出滿screen的假陽性；
// 而把排除清單越寫越長的下場是它開始漏掉真的違規（同 CLAUDE.md 對 PAYOUT_FLAG_RATIO
// 的那句：標太多會讓人學會忽略這個記號）。
//
// 所以改成兩段式，兩段都是可判定的：
//   ① 模型必須把所有「發現」放進一個界定區塊，逐列帶類別與佐證 → 逐列檢查欄位齊不齊。
//   ② 區塊**外面**不得出現任何帶金融單位的數字 → 散文裡的裸數字一律違規。
// 判準因此從「這個數字有沒有金融語義」（不可判定）換成「它在不在區塊裡」（可判定）。
//
// 已知邊界：中文數字（「勝率大約六成」）不在偵測範圍。要擋那個得做中文數詞解析，
// 目前判斷不值得——而且它在真實輸出裡遠比阿拉伯數字少見。這條寫在這裡而不是假裝有蓋到。

export const OPEN = "<<<FINDINGS>>>";
export const CLOSE = "<<<END FINDINGS>>>";

export const CLASSES = Object.freeze({
  RAW: "原始資料",
  CALCULATED: "計算值",
  EXTERNAL: "外部資料",
  RULE: "規則常數",
  SCENARIO: "情境",
  UNKNOWN: "未知",
});
const CLASS_SET = new Set(Object.values(CLASSES));

const URL_RE = /https?:\/\/\S+/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const DATE_RANGE = /\d{4}-\d{2}-\d{2}\s*(\.\.|～|~|至|-{1,2}>)\s*\d{4}-\d{2}-\d{2}/;
const SCENARIO_WORDS = /假設|若.{0,8}下跌|情境|模擬|推演|pro\s*forma/i;

// 帶金融單位的數字。這是區塊外唯一會被攔的東西。
const MONEY_UNIT = /(?:NT\$|US\$|\$|＄)\s*-?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s*(?:元|萬元|億元|億|千元)/g;
const PERCENT = /-?\d[\d,]*(?:\.\d+)?\s*(?:%|％|個百分點|pp\b|bps\b)/g;
const MULTIPLE = /-?\d[\d,]*(?:\.\d+)?\s*倍/g;
// 指標名後面的數字：這些字一出現，後面的數字就是宣稱，不是敘事。
const METRIC = /(勝率|獲利因子|最大回撤|夏普(?:值|比率)?|索提諾|年化報酬|累積報酬|報酬率|殖利率|本益比|PE|PB|Beta|β|相關係數|波動度|標準差|VaR|CVaR|CAGR|交易次數|成交量|市值|均線|MA\s*\d+|RSI|KD|MACD)\s*(?:=|＝|為|是|：|:)?\s*-?\d[\d,]*(?:\.\d+)?/gi;

// 先遮掉這些，再掃上面四條。遮罩用等長空白，行內位置才不會跑掉。
const MASKS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)/g, // ISO 時間戳
  /\d{4}-\d{2}-\d{2}/g,                       // 日期
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,            // 時刻
  /\b[vV]\d+(?:\.\d+)*\b/g,                   // 版本 v1 / v3.2
  /(?:schema_version|version|版本)\s*[:=＝]?\s*\d+(?:\.\d+)*/gi,
  /第\s*\d+\s*[項條筆章節列個步]/g,            // 序數
  /#\s*\d+/g,                                  // 交易編號 #03
  /\b(?:trade_id|rule_id|schema)\b\s*[:=＝]\s*\S+/gi,
];

function maskLine(line) {
  let out = line;
  for (const re of MASKS) out = out.replace(re, (m) => " ".repeat(m.length));
  return out;
}

export function splitFindings(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === OPEN);
  const close = lines.findIndex((l) => l.trim() === CLOSE);
  if (open === -1 || close === -1 || close < open) {
    return { ok: false, findings: [], outside: lines.map((text, i) => ({ line: i + 1, text })) };
  }
  return {
    ok: true,
    findings: lines.slice(open + 1, close).map((text, i) => ({ line: open + 2 + i, text })),
    outside: lines
      .map((text, i) => ({ line: i + 1, text }))
      .filter((_, i) => i < open || i > close),
  };
}

function checkEvidence(cls, value, evidence) {
  switch (cls) {
    case CLASSES.RAW:
      return /rows?\s*\[\s*\d+\s*\]|as_of\s*[=:]/.test(evidence)
        ? null : "原始資料必須指出是哪一列（rows[N]）或帶 as_of";
    case CLASSES.CALCULATED:
      if (!/[=＝+\-*/×÷]|平均|加總|中位|標準差/.test(evidence)) return "計算值必須寫出算法";
      if (!DATE_RANGE.test(evidence) && !/窗口|期間|近\s*\d+\s*(?:日|筆|月)/.test(evidence)) {
        return "計算值必須寫出資料窗口";
      }
      return null;
    case CLASSES.EXTERNAL:
      if (!URL_RE.test(evidence)) return "外部資料必須附來源連結";
      if (!ISO_DATE.test(evidence)) return "外部資料必須附發布日期";
      return null;
    case CLASSES.RULE:
      return /rule_id\s*[=:]/.test(evidence) ? null : "規則常數必須指向 rule_id";
    case CLASSES.SCENARIO:
      return SCENARIO_WORDS.test(evidence) ? null : "情境必須寫出所假設的前提";
    case CLASSES.UNKNOWN:
      if (!/^(—|--|-|n\/a|null)?$/i.test(value.trim())) return "未知不得帶值，值欄請留空或寫 —";
      return /需要|缺|required/i.test(evidence) ? null : "未知必須列出還需要什麼資料";
    default:
      return null;
  }
}

export function auditFindingsRow(raw, lineNo) {
  const violations = [];
  const text = raw.trim();
  if (!text || text.startsWith("#")) return violations;      // 空行與註解行略過

  const cells = text.split("|").map((c) => c.trim());
  if (cells.length < 4) {
    violations.push({ code: "MALFORMED_ROW", line: lineNo, excerpt: text,
      hint: "格式為 名稱 | 類別 | 值 | 佐證（四欄，以 | 分隔）" });
    return violations;
  }
  const [name, cls, value, ...rest] = cells;
  const evidence = rest.join(" | ");

  if (!CLASS_SET.has(cls)) {
    violations.push({ code: "UNKNOWN_CLASS", line: lineNo, excerpt: text,
      hint: `類別必須是 ${[...CLASS_SET].join("／")}，收到「${cls}」` });
    return violations;
  }
  const missing = checkEvidence(cls, value, evidence);
  if (missing) violations.push({ code: "MISSING_EVIDENCE", line: lineNo, excerpt: text, hint: missing });

  // 假設推演被標成事實，是這整套規格最想擋的那一種錯誤。
  if ((cls === CLASSES.RAW || cls === CLASSES.CALCULATED) && SCENARIO_WORDS.test(`${name} ${evidence}`)) {
    violations.push({ code: "MISCLASSIFIED", line: lineNo, excerpt: text,
      hint: `帶假設語彙卻標成「${cls}」，應為「${CLASSES.SCENARIO}」` });
  }
  return violations;
}

export function findBareNumbers(line) {
  const masked = maskLine(line);
  const spans = [];
  for (const re of [MONEY_UNIT, PERCENT, MULTIPLE, METRIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) spans.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() });
  }
  // 「勝率 63.4」與「63.4%」會同時命中同一段文字。重疊時留最長的那個，
  // 否則同一個裸數字會被報兩次——重複的告警跟漏報一樣會讓人停止閱讀告警。
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const s of spans) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start).map((s) => s.text);
}

export function auditOutput(text, opts = {}) {
  const violations = [];
  const { ok, findings, outside } = splitFindings(text);

  if (!ok) {
    violations.push({ code: "NO_FINDINGS_BLOCK", line: 1, excerpt: "",
      hint: `輸出必須包含 ${OPEN} … ${CLOSE} 區塊；所有帶數字的發現都要放在裡面` });
  } else {
    for (const row of findings) violations.push(...auditFindingsRow(row.text, row.line));
  }

  if (!opts.skipProseScan) {
    for (const { line, text: lineText } of outside) {
      const bare = findBareNumbers(lineText);
      for (const hit of bare) {
        violations.push({ code: "BARE_NUMBER", line, excerpt: hit,
          hint: "帶金融單位的數字只能出現在 FINDINGS 區塊內，並附類別與佐證" });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
