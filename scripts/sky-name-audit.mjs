#!/usr/bin/env node
// 中文星名的來源複查。把 sky/data/star-names-zh.json 的每一列拿去跟一份獨立的
// 彙編對照，報告一致／不一致／對方沒有。
//
// **這支刻意不進 verify.sh 與 CI**，理由同 scripts/float-source-audit.mjs：
//   1. 它要打外站。CI 不該把別人的 repo 當成自己綠燈的條件。
//   2. runner 的 IP 在外站眼中跟家用網路不同，量到的「被擋」是假訊號。
//   3. 產出是「人接下來要去看哪幾列」，不是布林值。
//
// **授權**：對照用的 Stellarium chinese skyculture 是 CC BY-SA 4.0。這支工具只在
// 本機把它抓進記憶體比對，**不寫任何檔案**，一個位元組都不進這個 repo——同 pyerfa
// 與 HYG 那個既有模式。要採用它的資料是另一回事，那會讓這個 repo 出現第一份帶
// 分享相同條款的資料，當初否決 HYG 就是為了這個。
//
//   node scripts/sky-name-audit.mjs            全部
//   node scripts/sky-name-audit.mjs --only 4301  只看一顆
//   node scripts/sky-name-audit.mjs --offline  只印本地表，不連網

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MODERN_URL = "https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json";
const CHINESE_URL = "https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/chinese/index.json";

// 對照用的簡→繁對映。只涵蓋那份來源的星名裡真的出現過、且與繁體不同形的字，
// 逐字掃出來的（52 個）。這是為了讓比對不會被字形差異淹沒，不是通用轉換器。
const SIMPLIFIED_TO_TRADITIONAL = {
  "垒": "壘", "阵": "陣", "鸟": "鳥", "厩": "廄", "仓": "倉", "传": "傳", "阁": "閣",
  "陈": "陳", "军": "軍", "门": "門", "华": "華", "内": "內", "将": "將", "娄": "婁",
  "极": "極", "毕": "畢", "卫": "衛", "车": "車", "参": "參", "关": "關", "厕": "廁",
  "孙": "孫", "厨": "廚", "轩": "軒", "辕": "轅", "师": "師", "记": "記", "枢": "樞",
  "势": "勢", "阳": "陽", "从": "從", "玑": "璣", "马": "馬", "权": "權", "库": "庫",
  "楼": "樓", "进": "進", "东": "東", "开": "開", "摇": "搖", "贯": "貫", "郑": "鄭",
  "钩": "鉤", "书": "書", "韩": "韓", "赵": "趙", "织": "織", "农": "農", "齐": "齊",
  "败": "敗", "鹤": "鶴", "云": "雲",
};

export function toTraditional(text) {
  return [...String(text)].map((ch) => SIMPLIFIED_TO_TRADITIONAL[ch] || ch).join("");
}

/** IAU 專名（小寫）→ HIP。我們的星表沒有 HIP 欄位，這是唯一的接橋。 */
export function buildNameToHip(modernCommonNames) {
  const map = new Map();
  for (const [hip, entries] of Object.entries(modernCommonNames || {})) {
    for (const entry of entries || []) {
      if (entry && entry.english) map.set(entry.english.toLowerCase(), hip);
    }
  }
  return map;
}

/** 一列的判定。回傳 status 與雙方的值，不做任何輸出。 */
export function compareRow({ ours, theirs }) {
  if (!theirs || !theirs.length) return { status: "no-oracle", ours, theirs: null };
  const converted = theirs.map(toTraditional);
  if (ours === null) return { status: "ours-null", ours, theirs: converted };
  return { status: converted.includes(ours) ? "agree" : "differ", ours, theirs: converted };
}

export function summarise(results) {
  const tally = { agree: 0, differ: 0, "no-oracle": 0, "ours-null": 0 };
  for (const r of results) tally[r.status] += 1;
  return tally;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  const offline = args.includes("--offline");

  const names = JSON.parse(await readFile(join(repoRoot, "sky/data/star-names-zh.json"), "utf8"));
  const catalog = JSON.parse(await readFile(join(repoRoot, "sky/data/bsc5-mag6.json"), "utf8"));

  let entries = Object.entries(names.stars);
  if (only) entries = entries.filter(([hr]) => hr === only);

  console.log(`本地表：${entries.length} 列（出貨 ${entries.filter(([, r]) => r.zh).length}、留 null ${entries.filter(([, r]) => !r.zh).length}）`);
  if (offline) {
    for (const [hr, row] of entries) console.log(`  HR ${hr.padEnd(5)} ${(row.zh || "(null)").padEnd(10)} ${row.en}`);
    return 0;
  }

  console.log("抓對照來源（CC BY-SA 4.0，只在記憶體裡比對，不寫檔）…");
  const [modern, chinese] = await Promise.all([
    fetch(MODERN_URL).then((r) => r.json()),
    fetch(CHINESE_URL).then((r) => r.json()),
  ]);
  const nameToHip = buildNameToHip(modern.common_names);
  const cn = chinese.common_names || {};

  const results = [];
  for (const [hr, row] of entries) {
    const hip = nameToHip.get(String(row.en).toLowerCase());
    const theirs = hip && cn[hip] ? cn[hip].map((e) => e.native) : null;
    const verdict = compareRow({ ours: row.zh, theirs });
    results.push(verdict);
    if (verdict.status === "agree") continue;
    const mark = { differ: "✘ 不一致", "no-oracle": "· 對方沒有", "ours-null": "○ 我方留 null" }[verdict.status];
    console.log(`  ${mark}  HR ${hr.padEnd(5)} ${String(row.en).padEnd(16)} 我:${String(row.zh)} / 對方:${verdict.theirs ? verdict.theirs.join("、") : "—"}`);
  }

  const tally = summarise(results);
  console.log(`\n一致 ${tally.agree}｜不一致 ${tally.differ}｜對方沒有 ${tally["no-oracle"]}｜我方留 null ${tally["ours-null"]}`);
  console.log("不一致的列要人去判，這支工具不會改任何檔案。");
  // 不一致不算失敗：兩份彙編本來就可能分歧，那正是要人來讀的理由。
  return 0;
}

// isMain guard —— 少了它，backend/test 那行 import 會真的去打外站。
// scripts/float-source-audit.mjs 記過同一個坑。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`複查失敗：${error.message}`);
    process.exit(1);
  });
}
