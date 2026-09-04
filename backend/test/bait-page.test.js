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
  for (const name of ["SPECIES_NAMES", "watersOf", "speciesForWaters"]) {
    assert.ok(app.helpers[name], `缺 helper: ${name}`);
  }
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
  // 加水量與熟成時間現場依狀況調整，寫進固定欄位只會記到一個不準的數字
  assert.doesNotMatch(html, /waterAmount|waterUnit|prepLeadTimeMinutes|熟成／放置（分鐘）/);
  assert.equal(plain(app.helpers.sanitizeRecipe({ title: "x", items: [], waterAmount: 3, prepLeadTimeMinutes: 5 }, null)).waterAmount, undefined);
  // 釣果欄位（評分／現場微調／中魚）已整組移除，結果紀錄靠備註
  assert.doesNotMatch(html, /data-rating|data-insitu|inSituAdjustments|data-caught|caughtTarget|中目標魚/);
  const stripped = plain(app.helpers.sanitizeRecipe({ title: "x", items: [], rating: 3, inSituAdjustments: "x", caughtTarget: true }, null));
  assert.equal(stripped.rating, undefined);
  assert.equal(stripped.caughtTarget, undefined);
  const item = plain(app.helpers.sanitizeItem({
    name: "殘留測試", gramsPerCup: 250, category: "ADDITIVE",
    viscosity: 5, foggingRate: 1, sinkingSpeed: "FAST", recommendedWaterRatio: 0.5,
  }));
  assert.deepEqual(Object.keys(item).sort(), ["flavorProfile", "id", "imageUrl", "name", "notes", "packWeightG", "targetSpecies", "unitPrice", "waterTypes"]);
});

test("每個目標都要有棲息水域，而且只能是淡水或海水", async () => {
  const { app } = await loadPage();
  const species = plain(app.helpers.SPECIES);
  assert.ok(species.length >= 11, "清單太短了");
  for (const row of species) {
    assert.ok(row.name, "有一筆沒有名字");
    assert.ok(Array.isArray(row.waters) && row.waters.length, `${row.name} 沒有棲息水域`);
    for (const water of row.waters) {
      assert.ok(["淡水", "海水"].includes(water), `${row.name} 的水域「${water}」不在詞彙表裡`);
    }
  }
  assert.deepEqual(plain(app.helpers.SPECIES_NAMES), species.map((row) => row.name));
});

// 查證於 2026-09-04。這些是會被誤分的幾個，錯了會讓現場選不到或選到不可能的魚。
test("棲息水域的分類要對得上查到的資料", async () => {
  const { app } = await loadPage();
  const w = (name) => plain(app.helpers.watersOf(name));
  // 廣鹽性／河口：淡海皆有
  assert.deepEqual(w("福壽魚"), ["淡水", "海水"], "吳郭魚廣鹽性，淡水到 35–40ppt 海水都活");
  assert.deepEqual(w("黑鯛"), ["淡水", "海水"], "黑棘鯛廣鹽性，幼魚常在河口半淡鹹水域");
  assert.deepEqual(w("豆仔"), ["淡水", "海水"], "大鱗鮻棲息含河口與淡水");
  // 只在淡水
  for (const name of ["鯽魚", "鯉魚", "泰國蝦"]) {
    assert.deepEqual(w(name), ["淡水"], `${name} 只在淡水`);
  }
  // 只在海水：礁區魚不會在淡水出現
  for (const name of ["黑毛", "白毛", "臭肚", "竹莢魚", "石斑"]) {
    assert.deepEqual(w(name), ["海水"], `${name} 只在海水`);
  }
  assert.deepEqual(w("不存在的魚"), []);
});

test("選了水域之後，魚種清單只留那個水域釣得到的", async () => {
  const { app } = await loadPage();
  const names = (waters, chosen) => plain(app.helpers.speciesForWaters(waters, chosen)).map((row) => row.name);

  const fresh = names(["淡水"], []);
  assert.ok(fresh.includes("鯽魚") && fresh.includes("福壽魚"), "淡水應該有鯽魚與福壽魚");
  for (const name of ["黑毛", "白毛", "臭肚", "竹莢魚", "石斑"]) {
    assert.ok(!fresh.includes(name), `${name} 不該出現在淡水的選單裡`);
  }
  const sea = names(["海水"], []);
  assert.ok(sea.includes("黑毛") && sea.includes("黑鯛"));
  for (const name of ["鯽魚", "鯉魚", "泰國蝦"]) {
    assert.ok(!sea.includes(name), `${name} 不該出現在海水的選單裡`);
  }
  // 沒選水域就全給
  assert.equal(names([], []).length, plain(app.helpers.SPECIES).length);
  assert.equal(names(["淡水", "海水"], []).length, plain(app.helpers.SPECIES).length);
  // 已經勾起來的一律保留，否則它會從畫面消失卻還留在資料裡，連取消都取消不掉
  assert.ok(names(["淡水"], ["臭肚"]).includes("臭肚"), "已勾選的要留著才取消得掉");
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
    title: "  ", createdAt: "壞日期",
    targetWaterTypes: ["淡水", "亂填"],
    items: [
      { itemId: "a", amount: 2, unit: "包" },
      { itemId: "ghost", amount: 1, unit: "包" },
      { itemId: "b", amount: 0, unit: "克" },
      { itemId: "b", amount: 200, unit: "亂填" },
    ],
  }, { a: true, b: true }));
  assert.equal(recipe.title, "未命名配方");
  assert.match(recipe.createdAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(recipe.targetWaterTypes, ["淡水"]);
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
  assert.equal(state.version, 7);
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
  assert.equal(payload.version, 7);

  const roundTrip = app.helpers.importPayload(JSON.stringify(payload));
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.state.items.length, 2);
  assert.equal(roundTrip.state.recipes.length, 1);

  assert.match(app.helpers.importPayload("{ 壞掉的 json").reason, /JSON/);
  assert.match(app.helpers.importPayload(JSON.stringify({ items: [] })).reason, /kind/);
  // 舊版的匯出檔要收得下——拒收只會讓使用者手上那份備份變成廢紙
  const oldVersion = app.helpers.importPayload(JSON.stringify({ kind: "bjkw-bait", version: 6, items: [], recipes: [] }));
  assert.equal(oldVersion.ok, true);
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
  // 重量放 packWeightG，不要放進名稱：卡片下面那行已經寫了整包幾克，名稱再寫一次
  // 是重複，而且換包裝規格時兩處會對不上。
  for (const item of state.items) {
    assert.doesNotMatch(item.name, /\d+\s*(?:kg|KG|g|G)/, `「${item.name}」的名稱裡有重量`);
  }
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
  assert.match(html, /那個空間是整個網域共用的/, "quota 要講網域共用，不要怪照片");
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
  // 開餌那頁的備註也一樣，不能只有紀錄那邊會撐
  assert.match(html, /\$\("recipeNotes"\)\.addEventListener\("input"/, "開餌的備註要跟著輸入撐高");
  assert.match(html, /autoGrow\(\$\("recipeNotes"\)\)/, "開餌的備註在載入既有內容時就要撐開");
  assert.match(html, /\.log-body textarea\{overflow:hidden/, "撐高之後不該再出現捲軸");
  assert.match(html, /row-spec/, "組成列要顯示整包重量與價格");
  assert.match(html, /每 100g \$/, "組成列要顯示每 100 克單價");
  // 總重、總價、每 100g 三個數字併在卡片右上與標題同列，不另起一行
  assert.match(html, /function costSummary\(/);
  assert.match(html, /lc-main/, "總價是右上那組的主角");
  assert.match(html, /lc-sub/, "總重與每 100g 是註腳");
  assert.doesNotMatch(html, /mix-total/, "不該再有獨立的合計列");
  assert.match(html, /cost-note/, "少算了哪幾列要說出來");
  assert.match(html, /row-note/, "組成列要顯示單品備註");
});

test("每 100 克單價：兩欄都填了才算得出來", async () => {
  const { app } = await loadPage();
  const per = (item) => app.helpers.pricePer100g(item);
  assert.equal(per({ unitPrice: 35, packWeightG: 188 }).toFixed(2), "18.62");
  assert.equal(per({ unitPrice: 150, packWeightG: 1800 }).toFixed(2), "8.33");
  assert.equal(per({ unitPrice: 30, packWeightG: 20 }), 150);
  // 缺一邊就回 null，不要用 0 頂替——那會讓總價看起來很便宜
  assert.equal(per({ unitPrice: 35, packWeightG: null }), null);
  assert.equal(per({ unitPrice: null, packWeightG: 188 }), null);
  assert.equal(per({ unitPrice: 0, packWeightG: 188 }), null);
  assert.equal(per(null), null);
});

test("用量換克：只有克與包算得出來，杯與匙不猜", async () => {
  const { app } = await loadPage();
  const item = { packWeightG: 188 };
  assert.equal(app.helpers.usedGrams({ unit: "克", amount: 200 }, item), 200);
  assert.equal(app.helpers.usedGrams({ unit: "包", amount: 2 }, item), 376);
  assert.equal(app.helpers.usedGrams({ unit: "包", amount: 2 }, { packWeightG: null }), null, "沒有包裝重量就換不了");
  assert.equal(app.helpers.usedGrams({ unit: "杯", amount: 1 }, item), null, "同一個量杯裝不同料差很多");
  assert.equal(app.helpers.usedGrams({ unit: "匙", amount: 1 }, item), null);
  assert.equal(app.helpers.usedGrams({ unit: "克", amount: 0 }, item), null);
});

// 把算不出來的當 0 加進去，會得到一個偏低而看起來完整的總價——那比不算更糟。
test("配方總價只加算得出來的，並逐列說明少算了什麼", async () => {
  const { app } = await loadPage();
  const items = {
    a: { id: "a", name: "紅餌", packWeightG: 188, unitPrice: 35 },
    b: { id: "b", name: "魔粒", packWeightG: 1800, unitPrice: 150 },
    c: { id: "c", name: "小麥蛋白", packWeightG: null, unitPrice: null },
  };
  const cost = plain(app.helpers.recipeCost({
    items: [
      { itemId: "a", amount: 2, unit: "包" },   // 376 g × 35/188 = 70
      { itemId: "b", amount: 900, unit: "克" }, // 900 g × 150/1800 = 75
      { itemId: "c", amount: 200, unit: "克" }, // 沒價格
      { itemId: "a", amount: 1, unit: "杯" },   // 杯換不成克
      { itemId: "ghost", amount: 1, unit: "包" },
    ],
  }, items));
  assert.ok(Math.abs(cost.total - 145) < 1e-9, `總價應該是 145，得到 ${cost.total}`);
  assert.equal(cost.counted, 2);
  assert.deepEqual(cost.unknown.map((row) => row.reason),
    ["缺價格或包裝重量", "「杯」換不成克", "單品已刪除"]);

  // 一列都算不出來時回 null 而不是 0
  const none = plain(app.helpers.recipeCost({ items: [{ itemId: "c", amount: 1, unit: "克" }] }, items));
  assert.equal(none.total, null);
  assert.equal(plain(app.helpers.recipeCost({ items: [] }, items)).total, null);
});

// 整鍋的每 100 克成本用「算得出價格的重量」當分母。拿總重去除會被那些有重量
// 卻沒價格的料稀釋，得到一個偏低而看起來合理的單價。
test("整鍋總重與每 100 克成本：分母是算得出價格的那幾列，不是總重", async () => {
  const { app } = await loadPage();
  const items = {
    a: { id: "a", name: "紅餌", packWeightG: 188, unitPrice: 35 },
    b: { id: "b", name: "魔粒", packWeightG: 1800, unitPrice: 150 },
    c: { id: "c", name: "小麥蛋白", packWeightG: null, unitPrice: null },
  };
  // a 2 包 = 376 g / $70；b 900 克 = 900 g / $75；c 200 克有重量但沒價格
  const cost = plain(app.helpers.recipeCost({
    items: [
      { itemId: "a", amount: 2, unit: "包" },
      { itemId: "b", amount: 900, unit: "克" },
      { itemId: "c", amount: 200, unit: "克" },
    ],
  }, items));
  assert.equal(cost.totalGrams, 1476, "總重要含沒價格的那 200 g");
  assert.equal(cost.pricedGrams, 1276, "有價格的只有 376 + 900");
  assert.ok(Math.abs(cost.total - 145) < 1e-9);
  // 145 / 1276 * 100 = 11.36；若誤用總重 1476 會變 9.82
  assert.ok(Math.abs(cost.per100 - 145 / 1276 * 100) < 1e-9, `per100 得到 ${cost.per100}`);
  assert.ok(cost.per100 > 145 / cost.totalGrams * 100, "分母用總重會低報");

  // c 沒有價格，所以它是 unknown，但重量仍然算進 totalGrams
  assert.deepEqual(cost.unknown.map((row) => row.name), ["小麥蛋白"]);
});

test("一列都換不成克時，總重與每 100g 都是 null 而不是 0", async () => {
  const { app } = await loadPage();
  const items = { a: { id: "a", name: "紅餌", packWeightG: 188, unitPrice: 35 } };
  const cost = plain(app.helpers.recipeCost({
    items: [{ itemId: "a", amount: 1, unit: "杯" }, { itemId: "a", amount: 2, unit: "匙" }],
  }, items));
  assert.equal(cost.totalGrams, null);
  assert.equal(cost.pricedGrams, null);
  assert.equal(cost.total, null);
  assert.equal(cost.per100, null);
  assert.deepEqual(cost.unknown.map((row) => row.reason), ["「杯」換不成克", "「匙」換不成克"]);
});

// 種子那份配方是驗收基準：376 + 70 + 20 + 200 + 1800 = 2466 g，$319
test("預設配方的總重與成本要算得出來且全部有價格", async () => {
  const { app } = await loadPage();
  const seed = plain(app.helpers.seed());
  const byId = {};
  for (const item of seed.items) byId[item.id] = item;
  const base = seed.recipes.find((row) => row.items.length === 5);
  assert.ok(base, "應該有一份五項組成的基礎配方");
  const cost = plain(app.helpers.recipeCost(base, byId));
  assert.equal(cost.totalGrams, 2466);
  assert.equal(Math.round(cost.total), 319);
  assert.equal(cost.pricedGrams, cost.totalGrams, "每一項都要有價格，否則每 100g 的分母會小於總重");
  assert.equal(Math.round(cost.per100 * 10) / 10, 12.9);
  assert.deepEqual(cost.unknown, []);
});

// localStorage 每個網域硬上限 5MB，而那 5MB 是站上所有頁共用的。實測這一頁只有
// 63 KB 也寫不進去，因為別頁已經把配額吃滿——所以主存放不能是 localStorage。
test("主存放是 IndexedDB，localStorage 只當備援", async () => {
  const { html } = await loadPage();
  assert.match(html, /window\.indexedDB/, "要用 IndexedDB");
  assert.match(html, /function saveToLocalStorage\(/, "IndexedDB 不可用時要有備援");
  // 舊版存在 localStorage 的資料要搬過去，並把原本那份刪掉還空間給網域
  assert.match(html, /store\.removeItem\(STORE_KEY\)/, "搬完要把舊的 localStorage 那份刪掉");
  // 開不起來時要當成沒有而不是卡住，否則整頁不會初始化
  assert.match(html, /request\.onerror = function \(\) \{ resolve\(null\); \}/, "IndexedDB 開失敗要 resolve(null)");
  assert.match(html, /request\.onblocked/, "onblocked 也要放行");
});

test("開餌列要看得到包裝重量與換算後的克數", async () => {
  const { html } = await loadPage();
  assert.match(html, /row-conv/, "開餌列要顯示換算後的克數");
  // 決定加幾包時要看得到這包多重、單價多少，否則只能憑印象
  assert.equal((html.match(/整包 " \+ (?:item|part)\.packWeightG/g) || []).length, 2,
    "開餌與紀錄兩處都要顯示整包重量");
});

// 使用者實際回報的問題：加了新單品就得按「重新載入預設資料」，而那會把自己存的
// 配方一起洗掉——「拿到新資料」與「留住自己的東西」變成二選一。
test("補齊預設資料只補缺的、只填空的，不動使用者的東西", async () => {
  const { app } = await loadPage();
  const seed = plain(app.helpers.seed());
  const first = seed.items[0];

  const target = plain(app.helpers.sanitizeState({
    items: [
      // 同一個預設 id，但使用者把價格改過、名稱也改過
      Object.assign({}, first, { name: "我改過的名字", unitPrice: 999, packWeightG: null, notes: "" }),
      { id: "mine-1", name: "我自己建的料", packWeightG: 500, unitPrice: 20 },
    ],
    recipes: [{ id: "mine-r", title: "我自己的配方", items: [{ itemId: "mine-1", amount: 1, unit: "包" }] }],
  }));

  const report = plain(app.helpers.mergeSeed(target, seed));

  // 使用者自己的東西原封不動
  const mine = target.items.find((row) => row.id === "mine-1");
  assert.equal(mine.name, "我自己建的料");
  assert.equal(target.recipes.some((row) => row.id === "mine-r"), true, "使用者的配方不能被洗掉");

  // 改過的值不覆蓋，空的才補
  const touched = target.items.find((row) => row.id === first.id);
  assert.equal(touched.name, "我改過的名字", "填過的欄位不准覆蓋");
  assert.equal(touched.unitPrice, 999, "填過的價格不准覆蓋");
  assert.equal(touched.packWeightG, first.packWeightG, "空的欄位要補上");
  assert.equal(touched.notes, first.notes, "空的備註要補上");

  // 其餘預設單品與配方都補進來
  assert.equal(report.addedItems.length, seed.items.length - 1);
  assert.equal(report.addedRecipes.length, seed.recipes.length);
  assert.ok(report.filledItems.includes("我改過的名字"));

  // 再跑一次應該完全沒有動作——自動補齊每次開啟都會跑，不能每次都改東西
  const again = plain(app.helpers.mergeSeed(target, seed));
  assert.deepEqual(again, { addedItems: [], addedRecipes: [], filledItems: [] });
});

test("刪掉的預設項不會被自動補齊復活", async () => {
  const { app } = await loadPage();
  const seed = plain(app.helpers.seed());
  const dropped = seed.items[0].id;

  const target = plain(app.helpers.sanitizeState({
    items: seed.items.filter((row) => row.id !== dropped),
    recipes: [],
    dismissedSeedIds: [dropped],
  }));
  assert.deepEqual(target.dismissedSeedIds, [dropped], "刪過的預設 id 要留在狀態裡");

  app.helpers.mergeSeed(target, seed);
  assert.equal(target.items.some((row) => row.id === dropped), false, "刪掉的預設項不該復活");

  // 不是預設 id 的不留，免得這份清單無限長大
  const noise = plain(app.helpers.sanitizeState({ items: [], recipes: [], dismissedSeedIds: ["mine-1", dropped] }));
  assert.deepEqual(noise.dismissedSeedIds, [dropped]);
});

// 之前 DB_KEY 是 "v" + STATE_VERSION，於是每次 schema 一改，舊資料就變成沒人讀得到
// 的孤兒——使用者的感受就是「一改版東西就不見了」。
test("儲存鍵固定，舊的版本鍵要能回溯", async () => {
  const { html } = await loadPage();
  assert.match(html, /var DB_KEY = "state";/, "儲存鍵不該把版本號寫進去");
  assert.match(html, /var LEGACY_DB_KEYS = \["v7"/, "要能回頭撈舊的版本鍵");
  assert.match(html, /function idbDelete\(/, "搬過來之後要把舊鍵刪掉");
});

test("匯入放寬到同版或更舊，比本頁新的才拒絕", async () => {
  const { app } = await loadPage();
  const payload = plain(app.helpers.exportPayload(app.helpers.sanitizeState({ items: [ITEM_A], recipes: [] })));
  // 舊版備份不能變廢紙
  for (const version of [1, 2, 3, 6, payload.version]) {
    const result = app.helpers.importPayload(JSON.stringify(Object.assign({}, payload, { version })));
    assert.equal(result.ok, true, `version ${version} 應該收得下`);
  }
  const newer = app.helpers.importPayload(JSON.stringify(Object.assign({}, payload, { version: payload.version + 1 })));
  assert.equal(newer.ok, false, "比本頁新的要拒絕，收下來會安靜地丟掉看不懂的欄位");
  assert.match(newer.reason, /比本頁的/);
  assert.equal(app.helpers.importPayload(JSON.stringify({ kind: "bjkw-bait" })).ok, false);
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
