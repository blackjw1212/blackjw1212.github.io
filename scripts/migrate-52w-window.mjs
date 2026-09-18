// 一次性遷移：把 data/market-52w.json 重剪到新的保留界線，再由它重算
// data/market-feed.json 的 hi52／lo52／fromHi／w52Months／hiFrom。
//
// 為什麼需要它：剪枝界線從「回推 13 個月且保留該月」收成「回推 12 個月」之後，
// 已經 commit 上去的存檔還揹著超界的桶，新的 artefact 斷言落地當下就會紅。
// 兩個檔案已經有全部需要的資訊，離線就算得完，不必連上游。
//
// **刻意不進 CI、不進 verify.sh**：它是一次性的，跑第二次是 no-op，但它會改寫
// CI 自己在寫的檔案，排進自動化只會跟排程班次互相覆蓋。理由同 float-source-audit.mjs
// 那條界線——產出是「這一次要把資料修成什麼樣子」，不是布林值。
//
//   node scripts/migrate-52w-window.mjs            預演，只印報告不寫檔
//   node scripts/migrate-52w-window.mjs --write    實際寫回兩個檔案
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { roundNumber } from "./update-stock-risk-feed.mjs";
import { accumulate52w, derive52w, monthKey, retentionFloor, MIN_WINDOW_MONTHS } from "./update-market-feed.mjs";

const FEED_FILE = new URL("../data/market-feed.json", import.meta.url);
const ACC_FILE = new URL("../data/market-52w.json", import.meta.url);

export function migrate(feed, accumulatorRaw) {
  const tradeDate = feed.tradeDate;
  // 空的 rows：只跑剪枝與下市清除那兩趟，不灌任何新資料。
  const accumulator = accumulate52w(accumulatorRaw, [], tradeDate);
  const floorMonth = retentionFloor(tradeDate);
  const startMonth = monthKey(accumulator.start || tradeDate);
  const hiFrom = floorMonth && startMonth && startMonth > floorMonth ? startMonth : floorMonth;

  const changed = [];
  const blanked = [];
  for (const row of feed.stocks) {
    const before = { hi52: row.hi52 ?? null, lo52: row.lo52 ?? null, fromHi: row.fromHi ?? null };
    delete row.hi52;
    delete row.lo52;
    delete row.fromHi;
    delete row.w52Months;
    const w = derive52w(accumulator.stocks[row.code]);
    if (w && w.months >= MIN_WINDOW_MONTHS) {
      row.hi52 = w.hi52;
      row.lo52 = w.lo52;
      if (row.close != null && w.hi52 > 0) row.fromHi = roundNumber((row.close - w.hi52) / w.hi52 * 100, 1);
    } else if (w) {
      row.w52Months = w.months;
    }
    const after = { hi52: row.hi52 ?? null, lo52: row.lo52 ?? null, fromHi: row.fromHi ?? null };
    if (after.hi52 === null && before.hi52 !== null) blanked.push({ code: row.code, name: row.name, months: w ? w.months : 0, before });
    else if (after.hi52 !== before.hi52 || after.lo52 !== before.lo52) changed.push({ code: row.code, name: row.name, before, after });
  }

  feed.hiFrom = hiFrom;
  return { feed, accumulator, hiFrom, changed, blanked };
}

async function main() {
  const write = process.argv.includes("--write");
  const feed = JSON.parse(await readFile(FEED_FILE, "utf8"));
  const accumulatorRaw = JSON.parse(await readFile(ACC_FILE, "utf8"));
  const bucketsBefore = Object.values(accumulatorRaw.stocks || {})
    .reduce((sum, entry) => sum + Object.keys(entry.m || {}).length, 0);

  const { accumulator, hiFrom, changed, blanked } = migrate(feed, accumulatorRaw);
  const bucketsAfter = Object.values(accumulator.stocks)
    .reduce((sum, entry) => sum + Object.keys(entry.m || {}).length, 0);

  // 只統計 fromHi 真的動了的列。把「只有 lo52 變」的列算進去會讓中位數變成 0，
  // 那是個看起來很安心但什麼都沒量到的數字。
  const deltas = changed
    .filter((c) => c.before.fromHi != null && c.after.fromHi != null && c.after.fromHi !== c.before.fromHi)
    .map((c) => Math.abs(c.after.fromHi - c.before.fromHi))
    .sort((a, b) => a - b);

  console.log(`tradeDate ${feed.tradeDate} · 保留界線 ${retentionFloor(feed.tradeDate)} · hiFrom ${hiFrom}`);
  console.log(`月桶 ${bucketsBefore} → ${bucketsAfter}（剪掉 ${bucketsBefore - bucketsAfter}）`);
  console.log(`高低點變動 ${changed.length} 檔，其中 fromHi 真的變動 ${deltas.length} 檔，`
    + `中位 ${deltas.length ? deltas[deltas.length >> 1].toFixed(2) : "0"} pp、最大 ${deltas.length ? deltas[deltas.length - 1].toFixed(2) : "0"} pp`);
  console.log(`覆蓋不足改為累積中 ${blanked.length} 檔`);
  for (const b of blanked.slice(0, 5)) console.log(`  ${b.code} ${b.name} months=${b.months} 原本 fromHi ${b.before.fromHi}`);
  changed.sort((a, b) => Math.abs(b.after.fromHi - b.before.fromHi) - Math.abs(a.after.fromHi - a.before.fromHi));
  for (const c of changed.slice(0, 5)) console.log(`  ${c.code} ${c.name} fromHi ${c.before.fromHi} → ${c.after.fromHi}`);

  if (!write) {
    console.log("\n預演模式，沒有寫檔。加 --write 才會真的寫回。");
    return;
  }
  await writeFile(FEED_FILE, JSON.stringify(feed), "utf8");
  await writeFile(ACC_FILE, JSON.stringify({ start: accumulator.start, updatedAt: accumulatorRaw.updatedAt, stocks: accumulator.stocks }), "utf8");
  console.log("\n已寫回 data/market-feed.json 與 data/market-52w.json。");
}

// isMain guard：沒有它，測試 import 這支就會真的改寫 data/（同 float-source-audit.mjs 那條）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });
