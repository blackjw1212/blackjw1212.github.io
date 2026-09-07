import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 這一頁的主 script 必須是最後一個、且緊貼 </body>，否則這個正則抓不到，整批測試會失效。
// 靜態契約有同一條斷言把關。
async function loadPage() {
  const htmlPath = fileURLToPath(new URL("../../float/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "float 頁的行內 script 應該存在且緊貼 </body>");

  const window = { __FLOAT_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => { throw new Error("測試不應該打網路"); },
    setTimeout,
    URL,
    window,
  });
  vm.runInContext(script, context, { filename: "float/index.html" });
  return { app: context.window.FloatApp, html };
}

async function loadFeed() {
  const path = fileURLToPath(new URL("../../data/floats.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

// vm.createContext 有自己的 realm：從腳本裡回來的陣列不是這支測試的 Array，
// deepEqual 會因為 prototype 不同而失敗。比對前一律先攤平。
const plain = (value) => JSON.parse(JSON.stringify(value));

function countOf(labels) {
  const counts = {};
  for (const label of labels) counts[label] = (counts[label] || 0) + 1;
  return counts;
}

test("頁面公開的 helper 契約", async () => {
  const { app } = await loadPage();
  for (const name of [
    "shotOf", "shotGrams", "floatOf", "floatLoad", "sumShots",
    "usableShots", "targetGrams", "suggestShots", "balance",
    "round2", "daysBetween", "todayISO",
  ]) {
    assert.equal(typeof app.helpers[name], "function", `缺 helper: ${name}`);
  }
  assert.equal(typeof app.init, "function");
});

test("查表：標記查得到重量，查不到的回 null 而不是 0", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { shotGrams, floatLoad } = app.helpers;

  assert.equal(shotGrams(feed, "3B"), 0.95);
  assert.equal(shotGrams(feed, "G3"), 0.25);
  assert.equal(shotGrams(feed, "1号"), 3.75);
  // 來源分歧、刻意不取值的那兩級必須回 null。回 0 的話它們會被當成「不加重量」
  // 悄悄混進試算。
  assert.equal(shotGrams(feed, "7B"), null);
  assert.equal(shotGrams(feed, "8B"), null);
  assert.equal(shotGrams(feed, "不存在"), null);

  assert.equal(floatLoad(feed, "3B"), 0.95);
  assert.equal(floatLoad(feed, "0"), 0);
  assert.equal(floatLoad(feed, "000"), null, "負浮力標沒有公布克數");
});

test("可用於配鉛的咬鉛不含号数，也不含沒取值的級距", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const labels = plain(app.helpers.usableShots(feed)).map((s) => s.label);

  assert.ok(labels.includes("B") && labels.includes("G5"));
  // 号数是中通鉛／転環鉛，不是打在子線上的咬鉛。
  assert.ok(!labels.some((label) => label.includes("号")), `号数不該出現在配鉛清單: ${labels}`);
  assert.ok(!labels.includes("7B") && !labels.includes("8B"), "沒取值的級距不可進配鉛清單");
});

test("加總會跳過沒取值的咬鉛", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { sumShots } = app.helpers;

  assert.equal(sumShots(feed, {}), 0);
  assert.equal(sumShots(feed, { B: 1 }), 0.55);
  assert.equal(sumShots(feed, { B: 2 }), 1.1);
  assert.equal(sumShots(feed, { B: 1, G3: 1 }), 0.8);
  assert.equal(sumShots(feed, { "7B": 3 }), 0, "沒取值的級距不計入");
  assert.equal(sumShots(feed, { B: 0 }), 0);
});

test("目標鉛重＝浮標號數＋餘浮力", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { targetGrams } = app.helpers;

  // 3B 標（0.95）＋ 餘浮力 G3（0.25）＝ 1.20。整頁的算術就是這一行。
  assert.equal(targetGrams(feed, "3B", "G3"), 1.2);
  assert.equal(targetGrams(feed, "3B", ""), 0.95, "不扣餘浮力時只吃號數");
  assert.equal(targetGrams(feed, "0", "G3"), 0.25, "0 號本身不吃鉛，剩下的只有餘浮力");
  assert.equal(targetGrams(feed, "000", "G3"), null, "沒有公布負荷的標算不出目標");
});

test("平衡判定：不足、剛好、超重", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { balance } = app.helpers;

  const under = balance(feed, "3B", "G3", { B: 1 });
  assert.equal(under.target, 1.2);
  assert.equal(under.current, 0.55);
  assert.equal(under.delta, 0.65);
  assert.equal(under.verdict, "under");

  // 4B 一顆就是 1.20，正好等於 3B 標＋G3 餘浮力。
  const level = balance(feed, "3B", "G3", { "4B": 1 });
  assert.equal(level.delta, 0);
  assert.equal(level.verdict, "balanced");

  const over = balance(feed, "3B", "G3", { "2B": 1, B: 1 });
  assert.equal(over.current, 1.3);
  assert.equal(over.delta, -0.1);
  assert.equal(over.verdict, "over");

  assert.equal(balance(feed, "000", "G3", {}).verdict, "unknown");
});

test("建議組合湊得出差額，而且只用真的存在的咬鉛", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { suggestShots, sumShots } = app.helpers;

  // 3B 標配 G3 餘浮力、手上已有一顆 B，差 0.65 g。G1(0.40)＋G3(0.25) 剛好補平。
  const best = plain(suggestShots(feed, 0.65));
  assert.ok(best, "應該要湊得出來");
  assert.equal(best.diff, 0, `期待剛好補平，得到差 ${best.diff}`);
  assert.equal(sumShots(feed, countOf(best.labels)), 0.65);

  // 已經平了就不該再建議加鉛。
  assert.equal(suggestShots(feed, 0), null);
  assert.equal(suggestShots(feed, -0.3), null);

  // 湊不到剛好是常態（咬鉛是離散級距），但建議裡的每一顆都必須是真的咬鉛。
  const odd = plain(suggestShots(feed, 1.01));
  assert.ok(odd && odd.labels.length, "差額大於容差時一定要給組合");
  const usable = new Set(plain(app.helpers.usableShots(feed)).map((s) => s.label));
  for (const label of odd.labels) {
    assert.ok(usable.has(label), `建議了不可用的咬鉛 ${label}`);
  }
  assert.ok(odd.labels.length <= app.helpers.MAX_PIECES,
    `建議顆數 ${odd.labels.length} 超過上限 ${app.helpers.MAX_PIECES}`);
});

test("2B 不是 B 的兩倍——這條刻度不是線性的", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { shotGrams } = app.helpers;
  assert.notEqual(shotGrams(feed, "2B"), shotGrams(feed, "B") * 2);
  // 資料檔要把這件事說出來，否則使用者會自己乘。
  const note = feed.shots.find((s) => s.label === "2B").note || "";
  assert.ok(note.includes("兩倍"), "2B 那一列要註明它不是 B 的兩倍");
});

test("讀不到資料時不會爆，只是算不出東西", async () => {
  const { app } = await loadPage();
  const { balance, sumShots, targetGrams, usableShots } = app.helpers;
  assert.equal(sumShots(null, { B: 1 }), 0);
  assert.equal(targetGrams(null, "3B", "G3"), null);
  assert.deepEqual(plain(usableShots(null)), []);
  assert.equal(balance(null, "3B", "G3", {}).verdict, "unknown");
});
