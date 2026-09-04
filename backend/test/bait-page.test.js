import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 這一頁的主 script 必須是最後一個、且緊貼 </body>，否則這個正則抓不到，整批測試會失效。
// 靜態契約有同一條斷言把關。
async function loadPage() {
  const htmlPath = fileURLToPath(new URL("../../bait/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "bait 頁的行內 script 應該存在且緊貼 </body>");

  const store = new Map();
  const window = { __BAIT_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { getElementById: () => null, addEventListener() {}, createElement: () => ({}) },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    setTimeout,
    URL,
    window,
  });
  vm.runInContext(script, context, { filename: "bait/index.html" });
  return { app: context.window.BaitApp, html };
}

// vm.createContext 有自己的 realm：從腳本裡回來的陣列不是這支測試的 Array，
// deepEqual 會因為 prototype 不同而失敗。比對前一律先攤平。
const plain = (value) => JSON.parse(JSON.stringify(value));

const ITEM_A = {
  id: "a", name: "福壽紅餌", packWeightG: 1000, unitPrice: 200,
  flavorProfile: ["腥"], targetSpecies: ["福壽魚"], waterTypes: ["淡水"],
};
const ITEM_B = {
  id: "b", name: "誘粉",
  flavorProfile: ["香"], targetSpecies: [], waterTypes: [],
};
const byId = { a: ITEM_A, b: ITEM_B };

test("頁面公開的 helper 契約", async () => {
  const { app } = await loadPage();
  for (const name of [
    "labelOf", "stepOf", "todayISO", "formatAmount", "recipeParts",
    "sanitizeItem", "sanitizeRecipe", "sanitizeState", "emptyDraft",
    "exportPayload", "importPayload", "seed",
  ]) {
    assert.equal(typeof app.helpers[name], "function", `缺 helper: ${name}`);
  }
  assert.equal(typeof app.init, "function");
  assert.deepEqual(plain(app.helpers.PURPOSES).map((row) => row.id), ["MAIN_BAIT", "GROUNDBAIT"]);
  assert.equal(app.helpers.CATEGORIES, undefined, "分類不再掛在單品上");
  assert.deepEqual(plain(app.helpers.UNITS).map((row) => row.id), ["包", "杯", "克", "匙"]);
  assert.deepEqual(plain(app.helpers.WATER_TYPES), ["淡水", "海水"]);
});

// 這一頁刻意沒有試算。留著半套（有欄位沒資料）比沒有更糟：畫面會一路掛著
// 「換算不出重量」。釘住免得日後又被加回來。
test("沒有任何試算或審查的殘留", async () => {
  const { app, html } = await loadPage();
  for (const gone of [
    "costPerGram", "toGrams", "recipeRows", "blendProfile", "highCostAdditives",
    "checkFlow", "checkFlavor", "checkWaterRatio", "auditRecipe",
    "sinkScoreOf", "scoreToSinkingSpeed", "SINKING", "FLOW_RATES",
  ]) {
    assert.equal(app.helpers[gone], undefined, `${gone} 不該還在`);
  }
  assert.doesNotMatch(html, /expectedFlowRate|gramsPerCup|foggingRate|viscosity|recommendedWaterRatio|shrimpRatio|shrimpStatus/);
  // 重量與價格是記著用的欄位，但不得長出任何用它們算的東西
  assert.doesNotMatch(html, /costPerGram|每克成本|總成本/);
  const item = plain(app.helpers.sanitizeItem({
    name: "殘留測試", gramsPerCup: 250, category: "ADDITIVE",
    viscosity: 5, foggingRate: 1, sinkingSpeed: "FAST", recommendedWaterRatio: 0.5,
  }));
  assert.deepEqual(Object.keys(item).sort(), ["flavorProfile", "id", "imageUrl", "name", "notes", "packWeightG", "targetSpecies", "unitPrice", "waterTypes"]);
});

test("魚種與水域詞彙表", async () => {
  const { app } = await loadPage();
  const water = plain(app.helpers.SPECIES_WATER);
  // 每個魚種都要有水域歸屬，否則分組時會落到「其他」而沒人發現
  for (const name of plain(app.helpers.SPECIES)) {
    assert.ok(["淡水", "海水"].includes(water[name]), `${name} 沒有水域歸屬`);
  }
  assert.equal(water["福壽魚"], "淡水");
  assert.equal(water["黑鯛"], "海水");
});

test("份量照原樣顯示，不做任何換算", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.formatAmount(2, "包"), "2 包");
  assert.equal(app.helpers.formatAmount(2.0, "包"), "2 包", "多餘的零要去掉");
  assert.equal(app.helpers.formatAmount(0.5, "杯"), "0.5 杯");
  assert.equal(app.helpers.formatAmount(200, "克"), "200 克");
  assert.equal(app.helpers.formatAmount(1, "亂填單位"), "1 包", "認不得的單位退回第一個");
  assert.equal(app.helpers.formatAmount("abc", "包"), "");
});

test("步進值：包／杯／匙是 0.5，克是 50", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.stepOf("包"), 0.5);
  assert.equal(app.helpers.stepOf("杯"), 0.5);
  assert.equal(app.helpers.stepOf("匙"), 0.5);
  assert.equal(app.helpers.stepOf("克"), 50);
  assert.equal(app.helpers.stepOf("亂填"), 0.5);
});

test("重量與價格：沒填是 null，不用 0 頂替", async () => {
  const { app } = await loadPage();
  const filled = plain(app.helpers.sanitizeItem({ name: "有填", packWeightG: "1000", unitPrice: "200" }));
  assert.equal(filled.packWeightG, 1000);
  assert.equal(filled.unitPrice, 200);
  // 0 元跟「還沒填」在畫面上是兩件事，兩者都收斂成 null 由畫面說「未填」
  for (const raw of [{}, { packWeightG: "", unitPrice: "" }, { packWeightG: 0, unitPrice: 0 }, { packWeightG: -5, unitPrice: "abc" }]) {
    const item = plain(app.helpers.sanitizeItem(Object.assign({ name: "沒填" }, raw)));
    assert.equal(item.packWeightG, null, JSON.stringify(raw));
    assert.equal(item.unitPrice, null, JSON.stringify(raw));
  }
});

test("用途掛在配方上而不是單品上", async () => {
  const { app } = await loadPage();
  assert.deepEqual(plain(app.helpers.PURPOSES).map((row) => row.label), ["主餌", "A撒（Esa）"]);
  assert.equal(plain(app.helpers.sanitizeRecipe({ title: "x", purpose: "GROUNDBAIT", items: [] }, null)).purpose, "GROUNDBAIT");
  assert.equal(plain(app.helpers.sanitizeRecipe({ title: "x", purpose: "亂填", items: [] }, null)).purpose, "MAIN_BAIT", "認不得的用途退回主餌");
  assert.equal(plain(app.helpers.sanitizeItem({ name: "單品", purpose: "MAIN_BAIT" })).purpose, undefined);
});

test("配方組成攤平；指向已刪除單品的列進 missing 而不是安靜消失", async () => {
  const { app } = await loadPage();
  const parts = plain(app.helpers.recipeParts({
    items: [
      { itemId: "a", amount: 2, unit: "包" },
      { itemId: "ghost", amount: 1, unit: "包" },
      { itemId: "b", amount: 200, unit: "克" },
    ],
  }, byId));
  assert.deepEqual(parts.rows.map((row) => row.text), ["福壽紅餌 2 包", "誘粉 200 克"]);
  assert.deepEqual(parts.missing, ["ghost"]);
  // 紀錄那頁要顯示整包重量、價格與單品備註，所以攤平時就得帶出來
  assert.equal(parts.rows[0].packWeightG, 1000);
  assert.equal(parts.rows[0].unitPrice, 200);
  assert.equal(parts.rows[1].packWeightG, null, "沒填的維持 null，畫面才說得出「未填」");
  assert.ok("notes" in parts.rows[0]);
  const empty = plain(app.helpers.recipeParts(null, byId));
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.missing, []);
});

test("sanitizeItem：名稱必填，列舉值對不上就退回預設，圖片只收 data:image/", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.sanitizeItem({ name: "   " }), null);
  assert.equal(app.helpers.sanitizeItem(null), null);

  const item = plain(app.helpers.sanitizeItem({
    id: "x", name: " 新料 ",
    flavorProfile: ["腥", "腥", "不存在的味型"],
    targetSpecies: ["福壽魚", "外星魚"],
    waterTypes: "不是陣列",
    imageUrl: "javascript:alert(1)",
  }));
  assert.equal(item.name, "新料");
  assert.deepEqual(item.flavorProfile, ["腥"]);
  assert.deepEqual(item.targetSpecies, ["福壽魚"]);
  assert.deepEqual(item.waterTypes, []);
  assert.equal(item.imageUrl, "");
  assert.equal(plain(app.helpers.sanitizeItem({ name: "有圖", imageUrl: "data:image/webp;base64,AAA" })).imageUrl, "data:image/webp;base64,AAA");
});

test("sanitizeRecipe：丟掉指向不存在單品的列與非正數用量", async () => {
  const { app } = await loadPage();
  const recipe = plain(app.helpers.sanitizeRecipe({
    title: "  ", createdAt: "壞日期", rating: 99, caughtTarget: "yes",
    targetWaterTypes: ["淡水", "亂填"], waterAmount: -5, waterUnit: "亂填",
    items: [
      { itemId: "a", amount: 2, unit: "包" },
      { itemId: "ghost", amount: 1, unit: "包" },
      { itemId: "b", amount: 0, unit: "克" },
      { itemId: "b", amount: 200, unit: "亂填" },
    ],
  }, { a: true, b: true }));
  assert.equal(recipe.title, "未命名配方");
  assert.match(recipe.createdAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(recipe.rating, 5);
  assert.equal(recipe.caughtTarget, false, "只有布林 true 才算中魚");
  assert.deepEqual(recipe.targetWaterTypes, ["淡水"]);
  assert.equal(recipe.waterAmount, 0);
  assert.equal(recipe.waterUnit, "包");
  assert.deepEqual(recipe.items.map((row) => row.itemId), ["a", "b"]);
  assert.equal(recipe.items[1].unit, "包", "認不得的單位退回第一個");
});

test("sanitizeState：單品去重、配方跟著已知單品收斂", async () => {
  const { app } = await loadPage();
  const state = plain(app.helpers.sanitizeState({
    items: [ITEM_A, ITEM_A, { name: "" }],
    recipes: [{ title: "留下", items: [{ itemId: "a", amount: 1, unit: "包" }, { itemId: "b", amount: 1, unit: "包" }] }],
    draft: { items: [{ itemId: "b", amount: 1, unit: "包" }] },
  }));
  assert.equal(state.items.length, 1);
  assert.equal(state.recipes.length, 1);
  assert.deepEqual(state.recipes[0].items.map((row) => row.itemId), ["a"], "b 不在單品庫裡就不該留下");
  assert.deepEqual(state.draft.items, []);
  assert.equal(state.version, 4);
  assert.equal(app.helpers.sanitizeState(null), null);
});

test("匯出／匯入：不是本頁的檔案一律拒絕，並說得出理由", async () => {
  const { app } = await loadPage();
  const state = app.helpers.sanitizeState({
    items: [ITEM_A, ITEM_B],
    recipes: [{ title: "測試", items: [{ itemId: "a", amount: 2, unit: "包" }] }],
  });
  const payload = plain(app.helpers.exportPayload(state));
  assert.equal(payload.kind, "bjkw-bait");
  assert.equal(payload.version, 4);

  const roundTrip = app.helpers.importPayload(JSON.stringify(payload));
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.state.items.length, 2);
  assert.equal(roundTrip.state.recipes.length, 1);

  assert.match(app.helpers.importPayload("{ 壞掉的 json").reason, /JSON/);
  assert.match(app.helpers.importPayload(JSON.stringify({ items: [] })).reason, /kind/);
  const oldVersion = app.helpers.importPayload(JSON.stringify({ kind: "bjkw-bait", version: 3 }));
  assert.equal(oldVersion.ok, false);
  assert.match(oldVersion.reason, /沒有自動轉換/);
});

// 預設資料走跟匯入完全同一條 sanitizeState，所以它不是特權資料。這條同時擋住
// 「種子寫了一個不存在的魚種／單位」這種只會在畫面上安靜消失的錯。
test("內建的預設資料經得起 sanitize，沒有一項被丟掉", async () => {
  const { app } = await loadPage();
  const seed = plain(app.helpers.seed());
  assert.ok(seed, "應該有內建預設資料");
  const state = plain(app.helpers.sanitizeState(seed));

  assert.equal(state.items.length, seed.items.length, "有單品在 sanitize 時被丟掉");
  assert.equal(state.recipes.length, seed.recipes.length, "有配方在 sanitize 時被丟掉");
  for (let i = 0; i < seed.recipes.length; i += 1) {
    assert.equal(state.recipes[i].items.length, seed.recipes[i].items.length,
      `配方「${seed.recipes[i].title}」有組成列被丟掉，多半是 itemId 對不上`);
    assert.deepEqual(state.recipes[i].targetSpecies, seed.recipes[i].targetSpecies,
      `配方「${seed.recipes[i].title}」的魚種被 pickList 丟掉`);
  }
  // 每張圖都必須是 data: URI——這一頁不得出現外部網址，靜態契約也釘著同一件事
  for (const item of state.items) {
    if (item.imageUrl) assert.match(item.imageUrl, /^data:image\//);
  }
  assert.ok(state.items.some((item) => item.imageUrl), "預設資料應該帶著商品縮圖");
  for (const recipe of state.recipes) {
    assert.ok(["MAIN_BAIT", "GROUNDBAIT"].includes(recipe.purpose), `配方「${recipe.title}」的用途不對`);
  }
});

// 之前三種失敗都印同一句「照片太多」。最常見的那種（整個網域被站上其他頁吃滿）
// 根本不是照片的問題，照著訊息刪圖也不會好。
test("存檔失敗要說得出真正的原因", async () => {
  const { html } = await loadPage();
  assert.match(html, /function saveError\(/, "應該有一個把失敗原因翻成人話的函式");
  for (const reason of ["no-storage", "serialize", "too-big", "quota"]) {
    assert.ok(html.includes(`"${reason}"`), `save 應該分辨得出 ${reason}`);
  }
  assert.doesNotMatch(html, /存不進瀏覽器：資料量超過上限（多半是照片太多）/, "那句話對三種失敗都印，是錯的");
  assert.match(html, /整個網域的儲存空間滿了/, "quota 要講網域共用，不要怪照片");
});

test("預設資料補上包裝重量之後，要有辦法送到已經存過的人手上", async () => {
  const { app, html } = await loadPage();
  // 種子只在第一次開啟時帶入，所以改了種子對已存過的人不生效——那顆按鈕是唯一出口
  assert.match(html, /id="reseed"/);
  const seed = plain(app.helpers.seed());
  const withWeight = seed.items.filter((item) => item.packWeightG !== null);
  assert.ok(withWeight.length >= 6, `預設資料應該帶著包裝重量，目前只有 ${withWeight.length} 筆`);
  for (const item of withWeight) {
    assert.ok(item.packWeightG > 0, `${item.name} 的重量應該是正數`);
  }
});

// 桌機一列只放一項會浪費一大半橫向空間；備註被 textarea 截在框裡則是看不到內容。
test("紀錄的組成在寬螢幕要能一列放多項，備註要完整顯示", async () => {
  const { html } = await loadPage();
  assert.match(html, /\.log-parts\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(260px,1fr\)\)/,
    "組成清單要用 auto-fill 決定欄數，不是固定單欄");
  assert.match(html, /function autoGrow\(/, "配方備註要撐到 scrollHeight，不要留在固定高度捲動");
  assert.match(html, /\.log-body textarea\{overflow:hidden/, "撐高之後不該再出現捲軸");
  assert.match(html, /row-spec/, "組成列要顯示整包重量與價格");
  assert.match(html, /row-note/, "組成列要顯示單品備註");
});

test("頁面結構的硬性前提", async () => {
  const { html } = await loadPage();
  assert.match(html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "主 script 必須緊貼 </body>");
  assert.doesNotMatch(html.split("<body")[1], /https?:\/\//, "body 之後不得出現外部網址");
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/, "這一頁不打網路");
  // 分頁鈕的 class 是 mobile-audit.html 走訪非預設分頁的依據，改名等於那兩個分頁量不到
  assert.match(html, /<div class="tabbar"/);
  assert.equal((html.match(/class="tab(?: on)?"/g) || []).length, 3);
  assert.match(html, /id="mixWaterTypes"/);
  assert.match(html, /id="itemWaterTypes"/);
  assert.match(html, /id="recipePurpose"/);
  assert.match(html, /id="itemPack"/);
  assert.match(html, /id="itemPrice"/);
  assert.doesNotMatch(html, /id="itemCategory"/, "分類選單不該還在單品表單裡");
});
