#!/usr/bin/env node
// 產生 sky/data/bsc5-mag6.json：/sky/ 用的精簡亮星表（Yale BSC5，Vmag ≤ 6.0）。
//
// 這是**離線一次性工具**，照 seed-market-52w.mjs 的先例不進 Actions ——
// 星表是一次產生、之後永不變的靜態資產，沒有每日更新的理由。
// scripts/ 不在 pages-deploy 的 cp allowlist，所以這支檔案不會上線。
//
// 來源：brettonw/YaleBrightStarCatalog 的 bsc5-all.json。
//
//   為什麼是鏡像而不是權威來源：CDS/VizieR、HEASARC、Harvard TDC、IAU 官方星名表
//   在本專案的網路環境全部連不到（實測 2026-09-08，連線被拒或 403），
//   唯一可達的是 raw.githubusercontent.com。
//
//   為什麼授權沒問題：底層 BSC5 是公有領域（Harvard TDC / NASA ADC），
//   鏡像 repo 的 MIT 只蓋它自己的轉換腳本。刻意不用 HYG-Database ——
//   它是 CC BY-SA 4.0，會讓這個 repo 出現第一份帶分享相同條款的資料。
//
//   為什麼用 bsc5-all.json 而不是 bsc5-short.json：前者有數值化的 RA/Dec 分量
//   （RAh/RAm/RAs、DEd/DEm/DEs、DE-），不必解析 "00h 05m 09.9s" 這種字串，
//   少一整類失敗模式。座標是 J2000，與 sky/lib/coords.mjs 的管線相符。
//
// 用法：
//   node scripts/build-sky-catalog.mjs                  產生資料檔
//   node scripts/build-sky-catalog.mjs --cross-check-hyg  另外跑一次獨立交叉驗證

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "sky", "data", "bsc5-mag6.json");

const SOURCE_URL = "https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-all.json";
// 只當驗證用的獨立編纂表。CC BY-SA 4.0 —— 它的任何一個位元組都不進 repo。
const HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";

const MAGNITUDE_LIMIT = 6.0;
const D2R = Math.PI / 180;

// ── 取檔（照 repo 慣例：3 次指數退避，4xx 不重試）──────────────────────────

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "*/*" } });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`${url} 回 ${response.status}，不重試`);
      }
      if (!response.ok) throw new Error(`${url} 回 ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (String(error.message).includes("不重試")) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw lastError;
}

// ── 解析 ────────────────────────────────────────────────────────────────

const num = (value) => (value === undefined || value === null || value === "" ? NaN : parseFloat(value));

function toRows(catalog) {
  const rows = [];
  for (const record of catalog) {
    const magnitude = num(record.Vmag);
    if (!(magnitude <= MAGNITUDE_LIMIT)) continue;

    const raDeg = (num(record.RAh) + num(record.RAm) / 60 + num(record.RAs) / 3600) * 15;
    const sign = record["DE-"] === "-" ? -1 : 1;
    const decDeg = sign * (num(record.DEd) + num(record.DEm) / 60 + num(record.DEs) / 3600);
    const hr = parseInt(record.HR, 10);
    if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || !Number.isFinite(hr)) {
      throw new Error(`HR ${record.HR} 的座標解析失敗`);
    }

    rows.push({
      hr,
      raDeg: Number(raDeg.toFixed(4)),     // 0.36 角秒，遠優於原始資料的 1–1.5 角秒
      decDeg: Number(decDeg.toFixed(4)),
      magnitude: Number(magnitude.toFixed(2)),
      common: record.Common || null,
      bayer: record.Bayer || null,
      flamsteed: record.Flamsteed || null,
      constellation: record.Constellation || null,
      bayerFull: record.BayerF || null,
      flamsteedFull: record.FlamsteedF || null,
    });
  }
  return rows;
}

// ── 驗證閘門：不過就 exit 1 且不寫檔 ──────────────────────────────────────
//
// 星表壞掉時肉眼看不出來（5,080 個數字），所以這組檢查是自動寫入的唯一許可證。
// 刻意不比對「記得的座標」，只比對幾何與統計上必然成立的事實。

const angularSeparationDeg = (ra1, dec1, ra2, dec2) => {
  const a = dec1 * D2R;
  const b = dec2 * D2R;
  const d = (ra1 - ra2) * D2R;
  const cos = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / D2R;
};

const EXPECTED_CUMULATIVE = { 1: 15, 2: 50, 3: 174, 4: 518, 5: 1630, 6: 5080 };

function validate(rows) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (rows.length < 5000 || rows.length > 5200) fail(`筆數 ${rows.length} 不在 5000–5200`);

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.hr)) fail(`HR ${row.hr} 重複`);
    seen.add(row.hr);
    if (!(row.raDeg >= 0 && row.raDeg < 360)) fail(`HR ${row.hr} 的赤經 ${row.raDeg} 越界`);
    if (!(Math.abs(row.decDeg) <= 90)) fail(`HR ${row.hr} 的赤緯 ${row.decDeg} 越界`);
    if (!Number.isFinite(row.magnitude)) fail(`HR ${row.hr} 的星等不是數字`);
  }

  const brightest = rows.slice().sort((a, b) => a.magnitude - b.magnitude)[0];
  if (brightest.common !== "Sirius") fail(`最亮的星應該是 Sirius，實得 ${brightest.common}`);
  if (Math.abs(brightest.magnitude + 1.46) > 0.05) fail(`Sirius 的星等應約 -1.46，實得 ${brightest.magnitude}`);

  const nearPole = rows
    .filter((row) => angularSeparationDeg(row.raDeg, row.decDeg, 0, 90) < 2)
    .sort((a, b) => a.magnitude - b.magnitude)[0];
  const poleDistance = nearPole ? angularSeparationDeg(nearPole.raDeg, nearPole.decDeg, 0, 90) : NaN;
  if (!(poleDistance >= 0.70 && poleDistance <= 0.78)) {
    fail(`北天極 2 度內最亮的星應距極 0.70–0.78 度（Polaris），實得 ${poleDistance}`);
  }

  for (const [limit, expected] of Object.entries(EXPECTED_CUMULATIVE)) {
    const actual = rows.filter((row) => row.magnitude <= Number(limit)).length;
    if (Math.abs(actual - expected) > expected * 0.02) {
      fail(`Vmag ≤ ${limit} 應約 ${expected} 顆，實得 ${actual}`);
    }
  }

  // 這些字串會被頁面插進 innerHTML（sky/index.html 的 renderNearby），
  // 而這份資料是從網路重新產生的。目前 BSC5 的名稱只有希臘字母與上標，
  // 但那是這批資料碰巧的性質，不是來源給的保證。
  const unsafe = rows.filter((row) => [row.common, row.bayer, row.flamsteed, row.constellation]
    .some((value) => typeof value === "string" && /[<>&"']/.test(value)));
  if (unsafe.length) {
    fail(`${unsafe.length} 顆星的名稱含 HTML 特殊字元，例如 HR ${unsafe[0].hr}`);
  }

  const unlabelled = rows.filter((row) => !labelOf(row)).length;
  if (unlabelled > 0) fail(`${unlabelled} 顆星組不出標籤`);

  return failures;
}

function labelOf(row) {
  if (row.common) return row.common;
  if (row.bayer && row.constellation) return `${row.bayer} ${row.constellation}`;
  if (row.bayerFull) return row.bayerFull;
  if (row.flamsteed && row.constellation) return `${row.flamsteed} ${row.constellation}`;
  if (row.flamsteedFull) return row.flamsteedFull;
  return `HR ${row.hr}`;
}

// ── 交叉驗證（選用）────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { out.push(current); current = ""; }
    else current += char;
  }
  out.push(current);
  return out;
}

async function crossCheckHyg(rows) {
  process.stderr.write("→ 下載 HYG（僅供比對，不寫入任何位元組）…\n");
  const csv = await fetchText(HYG_URL);
  const byHr = new Map(rows.map((row) => [row.hr, row]));
  const lines = csv.split("\n");
  const header = parseCsvLine(lines[0]);
  const separations = [];
  const magnitudeDiffs = [];
  const nameDiffs = [];

  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const fields = parseCsvLine(lines[i]);
    const record = {};
    header.forEach((key, index) => { record[key] = fields[index]; });
    const hr = parseInt(record.hr, 10);
    const mine = byHr.get(hr);
    if (!mine) continue;
    const raDeg = parseFloat(record.ra) * 15;
    const decDeg = parseFloat(record.dec);
    if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) continue;
    separations.push(angularSeparationDeg(raDeg, decDeg, mine.raDeg, mine.decDeg) * 3600);
    const magnitude = parseFloat(record.mag);
    if (Number.isFinite(magnitude)) magnitudeDiffs.push(Math.abs(magnitude - mine.magnitude));
    const proper = (record.proper || "").trim();
    if (mine.common && proper && proper !== mine.common) {
      nameDiffs.push(`HR${hr}: BSC "${mine.common}" vs HYG "${proper}"`);
    }
  }

  separations.sort((a, b) => a - b);
  magnitudeDiffs.sort((a, b) => a - b);
  const at = (list, p) => list[Math.floor(list.length * p)];
  console.log(`  對上 ${separations.length} / ${rows.length} 顆`);
  console.log(`  位置差(角秒) 中位 ${at(separations, 0.5).toFixed(2)}  99% ${at(separations, 0.99).toFixed(2)}  最大 ${separations[separations.length - 1].toFixed(1)}`);
  console.log(`  超過 60 角秒的: ${separations.filter((s) => s > 60).length}`);
  console.log(`  星等差 中位 ${at(magnitudeDiffs, 0.5).toFixed(3)}  最大 ${magnitudeDiffs[magnitudeDiffs.length - 1].toFixed(2)}  超過 0.5 的 ${magnitudeDiffs.filter((d) => d > 0.5).length} 顆（多為變星）`);
  console.log(`  俗名不一致 ${nameDiffs.length} 個（BSC5 是舊稱，HYG 追 IAU 現行名）`);
  for (const diff of nameDiffs.slice(0, 10)) console.log(`    ${diff}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write("→ 下載 bsc5-all.json…\n");
  const rows = toRows(JSON.parse(await fetchText(SOURCE_URL)));
  console.log(`  Vmag ≤ ${MAGNITUDE_LIMIT} 共 ${rows.length} 顆`);

  const failures = validate(rows);
  if (failures.length) {
    console.error("\n❌ 驗證未通過，不寫入檔案：");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("  驗證閘門全數通過");

  if (process.argv.includes("--cross-check-hyg")) await crossCheckHyg(rows);

  const designations = {};
  rows.forEach((row, index) => {
    const entry = {};
    if (row.common) entry.n = row.common;
    if (row.bayer) entry.b = row.bayer;
    if (row.flamsteed) entry.f = row.flamsteed;
    if (row.constellation) entry.c = row.constellation;
    if (Object.keys(entry).length) designations[index] = entry;
  });

  const payload = {
    epoch: "J2000.0",
    magnitudeLimit: MAGNITUDE_LIMIT,
    count: rows.length,
    source: {
      catalog: "Yale Bright Star Catalogue, 5th Revised Edition (BSC5)",
      url: SOURCE_URL,
      retrievedAt: new Date().toISOString().slice(0, 10),
      licence: "底層 BSC5 為公有領域（Harvard TDC / NASA ADC）；鏡像的轉換腳本為 MIT。",
      note: "座標為 J2000.0 平位置。使用前請先把查詢方向 precess 回 J2000，不要 precess 整份星表。",
    },
    hr: rows.map((row) => row.hr),
    raDeg: rows.map((row) => row.raDeg),
    decDeg: rows.map((row) => row.decDeg),
    mag: rows.map((row) => row.magnitude),
    designations,
  };

  writeFileSync(OUT, JSON.stringify(payload));
  const bytes = JSON.stringify(payload).length;
  console.log(`✅ 已寫入 ${OUT}（${(bytes / 1024).toFixed(0)} KB，${Object.keys(designations).length} 顆有名稱）`);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
