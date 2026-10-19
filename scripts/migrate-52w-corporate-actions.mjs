// 一次性回補：把窗口內（約 13 個月）的股數事件——配股、面額變更、減資——套進
// data/market-52w.json，再由它重算 data/market-feed.json 的 hi52／lo52／fromHi。
//
// 為什麼需要它：每日管線只回看 40 天（update-market-feed.mjs），上線前就發生的事件
// 不會被它看到。實測 2026-10-19：6669 緯穎 9/2 除權、6949 沛爾生醫 9/7 面額變更、
// 4806 桂田文創 10/2 減資，都還揹著事件前的原始價。
//
// **seededThrough 寫死成 2026-07-27**：那天 seed-market-52w.mjs 用 Yahoo 日線回填了整份存檔
// （git：97ab47dc 新增 data/market-52w.json），Yahoo 的高低價已依股數調整過
// （實測 6944 兆聯 6 月原始高點 1,115、存檔 857.69＝×0.769）。回填前的事件只重算事件當月。
//
// 刻意不進 CI、不進 verify.sh，理由同 migrate-52w-window.mjs：一次性、會改寫 CI 自己在寫的檔案。
// 跑第二次是 no-op（已套用的記在 adjusted 裡）。要打幾百次上游、每次間隔 2.5 秒，約十幾分鐘。
//
//   node scripts/migrate-52w-corporate-actions.mjs            預演，只印報告不寫檔
//   node scripts/migrate-52w-corporate-actions.mjs --write    實際寫回兩個檔案
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchJson, retentionFloor } from "./update-market-feed.mjs";
import { fetchCorporateActionEvents, syncCorporateActions } from "./corporate-actions.mjs";
import { migrate } from "./migrate-52w-window.mjs";

const FEED_FILE = new URL("../data/market-feed.json", import.meta.url);
const ACC_FILE = new URL("../data/market-52w.json", import.meta.url);
export const SEEDED_THROUGH = "2026-07-27";

function monthWindows(floorMonth, tradeDate) {
  const out = [];
  const cursor = new Date(floorMonth + "-01T00:00:00Z");
  const end = new Date(tradeDate + "T00:00:00Z");
  while (cursor <= end) {
    const from = cursor.toISOString().slice(0, 10);
    const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const to = (last < end ? last : end).toISOString().slice(0, 10);
    out.push([from, to]);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

async function main() {
  const write = process.argv.includes("--write");
  const feed = JSON.parse(await readFile(FEED_FILE, "utf8"));
  const accRaw = JSON.parse(await readFile(ACC_FILE, "utf8"));
  if (!accRaw.seededThrough) accRaw.seededThrough = SEEDED_THROUGH;
  const tradeDate = feed.tradeDate;
  const floorMonth = retentionFloor(tradeDate);
  const marketByCode = {};
  for (const s of feed.stocks) marketByCode[s.code] = s.market;

  // 一個月一個請求：一次要一年的話上游會不會截斷沒驗證過，逐月拿比較保險
  const all = { events: [], rejected: [], errors: [] };
  for (const [from, to] of monthWindows(floorMonth, tradeDate)) {
    const got = await fetchCorporateActionEvents(from, to, { fetchJson });
    all.events.push(...got.events);
    all.rejected.push(...got.rejected);
    all.errors.push(...got.errors);
    console.log(`${from}~${to}: ${got.events.length} events${got.errors.length ? `, ${got.errors.length} errors` : ""}`);
  }

  const before = {};
  for (const row of feed.stocks) before[row.code] = row.fromHi ?? null;
  const sync = await syncCorporateActions(accRaw, {
    tradeDate, floorMonth, marketOf: (code) => marketByCode[code], fetchJson, prefetched: all,
  });
  const { feed: nextFeed, accumulator } = migrate(feed, sync.accumulator);
  // migrate() 回傳的 accumulator 經過 accumulate52w，adjusted／seededThrough 會一起帶出來
  const moved = nextFeed.stocks
    .filter((row) => before[row.code] != null && row.fromHi != null && row.fromHi !== before[row.code])
    .map((row) => ({ code: row.code, name: row.name, from: before[row.code], to: row.fromHi }))
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

  console.log(`事件 ${sync.events.length} 筆 · 套用 ${sync.applied.length} · 待補 ${sync.pending.length} · 退回 ${sync.rejected.length} · 錯誤 ${sync.errors.length}`);
  for (const e of sync.errors.slice(0, 10)) console.log(`  ! ${e.message}`);
  console.log(`距一年高有變動 ${moved.length} 檔：`);
  for (const m of moved.slice(0, 20)) console.log(`  ${m.code} ${m.name} ${m.from} → ${m.to}`);

  if (!write) { console.log("（預演，未寫檔；加 --write 寫回）"); return; }
  await writeFile(FEED_FILE, JSON.stringify(nextFeed), "utf8");
  await writeFile(ACC_FILE, JSON.stringify({ start: accumulator.start, updatedAt: accRaw.updatedAt,
    seededThrough: accumulator.seededThrough, adjusted: accumulator.adjusted || {}, stocks: accumulator.stocks }), "utf8");
  console.log("已寫回 data/market-feed.json 與 data/market-52w.json");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
