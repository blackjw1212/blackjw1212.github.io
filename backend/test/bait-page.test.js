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
  assert.equal(app.helpers.CATEGORIES, undefined, "分類不再掛在品項上");
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
  assert.deepEqual(Object.keys(item).sort(), ["flavorProfile", "id", "imageUrl", "ingredients", "kind", "name", "notes", "packWeightG", "targetSpecies", "unitPrice", "waterTypes"]);
  // 舊的 category 是用途（已移到配方層），不可以借屍還魂成品項分類
  assert.equal(item.kind, "bait");
});

test("品項分類：餌料／添加劑，品項庫分兩區", async () => {
  const { app, html } = await loadPage();
  const h = app.helpers;
  assert.equal(plain(h.sanitizeItem({ name: "x" })).kind, "bait", "沒填是餌料");
  assert.equal(plain(h.sanitizeItem({ name: "x", kind: "additive" })).kind, "additive");
  assert.equal(plain(h.sanitizeItem({ name: "x", kind: "ADDITIVE" })).kind, "bait", "對不上就退回預設");
  // 預設資料裡的添加劑是若亞方舟那四樣，加上黑格胺基酸液用的甘胺酸與 L-丙胺酸
  const seed = plain(h.seed());
  const additives = seed.items.filter((i) => plain(h.sanitizeItem(i)).kind === "additive").map((i) => i.id).sort();
  assert.equal(additives.join(","), "item-alanine-noah,item-citric-noah,item-cysteine-noah,item-glycine-noah,item-sorbitol-noah,item-tryptophan-noah");
  // 舊裝置：那四樣是在分類欄位出現前補進去的，讀回來是餌料；開一次要更正成添加劑
  const FIRST_FOUR = ["item-citric-noah", "item-cysteine-noah", "item-sorbitol-noah", "item-tryptophan-noah"];
  const old = plain(h.sanitizeState(seed));
  for (const i of old.items) if (FIRST_FOUR.includes(i.id)) i.kind = "bait";
  old.appliedFixes = old.appliedFixes.filter((id) => !id.endsWith(":kind:1"));
  h.mergeSeed(old, seed);
  assert.equal(old.items.filter((i) => i.kind === "additive").length, 6);
  // 分類要撐過存檔再讀回
  assert.equal(plain(h.sanitizeState(old)).items.filter((i) => i.kind === "additive").length, 6);
  // 表單不給選分類（使用者要求移除）；品項庫用切換鈕一次顯示一類（左右並排太擠，使用者退回）
  assert.doesNotMatch(html, /id="itemKind"|name="itemKind"/);
  assert.match(html, /<div id="itemRows"><\/div>/);
  assert.match(html, /data-kind="' \+ kind\.id \+ '" aria-pressed="/);
  assert.doesNotMatch(html, /kind-cols/);
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

test("用途掛在配方上而不是品項上", async () => {
  const { app } = await loadPage();
  assert.deepEqual(plain(app.helpers.PURPOSES).map((row) => row.label), ["主餌", "A撒（Esa）"]);
  assert.equal(plain(app.helpers.sanitizeRecipe({ title: "x", purpose: "GROUNDBAIT", items: [] }, null)).purpose, "GROUNDBAIT");
  assert.equal(plain(app.helpers.sanitizeRecipe({ title: "x", purpose: "亂填", items: [] }, null)).purpose, "MAIN_BAIT", "認不得的用途退回主餌");
  assert.equal(plain(app.helpers.sanitizeItem({ name: "品項", purpose: "MAIN_BAIT" })).purpose, undefined);
});

test("配方組成攤平；指向已刪除品項的列進 missing 而不是安靜消失", async () => {
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
  // 紀錄那頁要顯示整包重量、價格與品項備註，所以攤平時就得帶出來
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

test("sanitizeRecipe：丟掉指向不存在品項的列與非正數用量", async () => {
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

test("sanitizeState：品項去重、配方跟著已知品項收斂", async () => {
  const { app } = await loadPage();
  const state = plain(app.helpers.sanitizeState({
    items: [ITEM_A, ITEM_A, { name: "" }],
    recipes: [{ title: "留下", items: [{ itemId: "a", amount: 1, unit: "包" }, { itemId: "b", amount: 1, unit: "包" }] }],
    draft: { items: [{ itemId: "b", amount: 1, unit: "包" }] },
  }));
  assert.equal(state.items.length, 1);
  assert.equal(state.recipes.length, 1);
  assert.deepEqual(state.recipes[0].items.map((row) => row.itemId), ["a"], "b 不在品項庫裡就不該留下");
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

  assert.equal(state.items.length, seed.items.length, "有品項在 sanitize 時被丟掉");
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
  // 品項備註不再印在組成列上（列高被撐爆過），改進彈出卡
  assert.match(html, /id="sheetNote"/, "品項備註要在彈出卡裡");
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
    ["缺價格或包裝重量", "「杯」換不成克", "品項已刪除"]);

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

// 種子裡的主餌是驗收基準：376 + 70 + 75 + 460 + 1800 + 20 + 200 = 3001 g，
// $68 + 30 + 17 + 50 + 150 + 30 + 39 = $384
test("預設配方的總重與成本要算得出來且全部有價格", async () => {
  const { app } = await loadPage();
  const seed = plain(app.helpers.seed());
  const byId = {};
  for (const item of seed.items) byId[item.id] = item;
  const main = seed.recipes.find((row) => row.id === "recipe-main-allpowder");
  assert.ok(main, "應該有「主餌 全乾粉版」");
  const cost = plain(app.helpers.recipeCost(main, byId));
  assert.equal(cost.totalGrams, 3001);
  assert.ok(Math.abs(cost.total - 384) < 1e-9, `總價得到 ${cost.total}`);
  assert.equal(cost.pricedGrams, cost.totalGrams, "每一項都要有價格，否則每 100g 的分母會小於總重");
  assert.equal(Math.round(cost.per100 * 10) / 10, 12.8);
  assert.deepEqual(cost.unknown, []);
  // 每一份預設配方都必須算得出完整成本——種子帶進來的東西不該一開就掛警示
  for (const recipe of seed.recipes) {
    const each = plain(app.helpers.recipeCost(recipe, byId));
    assert.deepEqual(each.unknown, [], `「${recipe.title}」有算不出來的列`);
  }
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
  assert.match(html, /request\.onerror = function \(\) \{ done\(null\); \}/, "IndexedDB 開失敗要放行");
  assert.match(html, /request\.onblocked/, "onblocked 也要放行");
  // 實測過：別的分頁還開著連線、或有 deleteDatabase 卡在佇列裡時，open 會三個回呼
  // 都不觸發就無限排隊——load() 永遠不 resolve，畫面一片空白且主控台沒有訊息。
  assert.match(html, /var DB_OPEN_TIMEOUT_MS = \d+;/, "open 一定要有逾時");
  assert.match(html, /setTimeout\(function \(\) \{ done\(null\); \}, DB_OPEN_TIMEOUT_MS\)/, "逾時要退回沒有 IndexedDB");
});

test("開餌列要看得到包裝重量與換算後的克數", async () => {
  const { html } = await loadPage();
  assert.match(html, /row-conv/, "開餌列要顯示換算後的克數");
  // 決定加幾包時要看得到這包多重、單價多少，否則只能憑印象
  assert.equal((html.match(/整包 " \+ (?:item|part)\.packWeightG/g) || []).length, 3,
    "開餌列、紀錄列、彈出卡三處都要顯示整包重量");
});

// 使用者實際回報的問題：加了新品項就得按「重新載入預設資料」，而那會把自己存的
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

  // 其餘預設品項與配方都補進來
  assert.equal(report.addedItems.length, seed.items.length - 1);
  assert.equal(report.addedRecipes.length, seed.recipes.length);
  assert.ok(report.filledItems.includes("我改過的名字"));

  // 再跑一次應該完全沒有動作——自動補齊每次開啟都會跑，不能每次都改東西
  const again = plain(app.helpers.mergeSeed(target, seed));
  assert.deepEqual(again, { addedItems: [], addedRecipes: [], filledItems: [], fixedItems: [], fixedRecipes: [] });
});

// 使用者回報：刪掉預設配方之後按「補齊預設資料」，它們又回來了。
// 原因是那顆按鈕會先清掉 dismissedSeedIds（我當初的設計是「按這顆就是把預設的
// 都給我」）——結果就是刪不掉。刪除是使用者的決定，補齊不該推翻它。
test("補齊按鈕不會清掉刪除紀錄，刪掉的預設項按了也不會復活", async () => {
  const { html } = await loadPage();
  const handler = html.slice(html.indexOf('$("reseed").addEventListener'), html.indexOf('$("undoImport").addEventListener'));
  assert.doesNotMatch(handler, /dismissedSeedIds\s*=\s*\[\]/, "補齊按鈕不該清空刪除紀錄");
  // 快照仍然要含它，按「復原」才還原得回去
  assert.match(handler, /dismissedSeedIds: state\.dismissedSeedIds/);
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

  // 配方也一樣——使用者回報的就是配方被找回來
  const droppedRecipe = seed.recipes[0].id;
  const withRecipeDropped = plain(app.helpers.sanitizeState({
    items: seed.items,
    recipes: seed.recipes.filter((row) => row.id !== droppedRecipe),
    dismissedSeedIds: [droppedRecipe],
  }));
  app.helpers.mergeSeed(withRecipeDropped, seed);
  assert.equal(withRecipeDropped.recipes.some((row) => row.id === droppedRecipe), false, "刪掉的預設配方不該復活");

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

// 成分表照包裝抄，跟備註分開；既有品項的成分表一律是空的，所以自動補齊會把它填上——
// 這是讓已存過的人拿到成分表的唯一管道（notes 已經有字，不會被動到）。
test("成分表：獨立欄位，上限 300，空的會被預設資料補上", async () => {
  const { app, html } = await loadPage();
  assert.equal(plain(app.helpers.sanitizeItem({ name: "x" })).ingredients, "", "沒填是空字串");
  assert.equal(plain(app.helpers.sanitizeItem({ name: "x", ingredients: "a".repeat(400) })).ingredients.length, 300);
  assert.match(html, /id="itemIngredients"/, "表單要有成分表欄位");
  // 品項層的 prose 不印在紀錄列與品項卡上——列高被文字撐爆過。完整內容走彈出卡。
  assert.match(html, /id="sheetIngr"/, "成分要在彈出卡裡");
  assert.match(html, /function openSheet\(/);
  assert.doesNotMatch(html, /class="ingr"|row-note|data-toggle|bindToggles/, "原地展開那套不該殘留");
  // backdrop 是 flex，帶 class 的 display 會蓋掉 hidden 屬性——/sky/ 踩過
  assert.match(html, /\[hidden\]\{display:none !important\}/);
  // 讓人知道能點：紀錄列右緣 ›、品項卡右上角小 i。用字元不用 SVG（xmlns 帶 http:// 會撞契約）
  assert.match(html, /\.log-parts \.row::after\{content:"\\203A"/);
  assert.match(html, /\.item-card \.shot-wrap::after\{content:"i"/);
  assert.doesNotMatch(html, /\\2139/, "那顆 teal 的 ⓘ 已經被退貨，不該再出現");

  const seed = plain(app.helpers.seed());
  const red = seed.items.find((row) => row.id === "item-fushou-red");
  const kd2 = seed.items.find((row) => row.id === "item-kuangdian-2");
  assert.match(red.ingredients, /南極蝦粉末/, "紅餌成分表要照包裝");
  assert.match(red.ingredients, /香虎/, "紅餌內容物含香虎——先前說品項裡沒有香虎，錯了");
  assert.match(kd2.ingredients, /^肝肉粉/, "狂電 2 號主原料第一項是肝肉粉——先前說它不是實體肝，錯了");

  // 舊資料：同 id、notes 有字、ingredients 空 → 只補 ingredients，notes 不動
  const target = plain(app.helpers.sanitizeState({
    items: [Object.assign({}, red, { ingredients: "", notes: "我自己寫的備註" })],
    recipes: [],
  }));
  const report = plain(app.helpers.mergeSeed(target, seed));
  const after = target.items.find((row) => row.id === red.id);
  assert.equal(after.ingredients, red.ingredients, "空的成分表要被補上");
  assert.equal(after.notes, "我自己寫的備註", "填過的備註不准動");
  assert.ok(report.filledItems.includes(red.name));
});

test("頁面結構的硬性前提", async () => {
  const { html } = await loadPage();
  assert.match(html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "主 script 必須緊貼 </body>");
  assert.doesNotMatch(html.split("<body")[1], /https?:\/\//, "body 之後不得出現外部網址");
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/, "這一頁不打網路");
  // 分頁鈕的 class 是 mobile-audit.html 走訪非預設分頁的依據，改名等於那兩個分頁量不到
  assert.match(html, /<div class="tabbar"/);
  assert.equal((html.match(/class="tab(?: on)?"/g) || []).length, 5);
  assert.match(html, /id="tabAdd"/);
  assert.match(html, /id="addPanel"/);
  assert.match(html, /id="tabFish"/);
  assert.match(html, /id="fishPanel"/);
  assert.match(html, /id="mixWaterTypes"/);
  assert.match(html, /id="itemWaterTypes"/);
  assert.match(html, /id="recipePurpose"/);
  assert.match(html, /id="itemPack"/);
  assert.match(html, /id="itemPrice"/);
  assert.doesNotMatch(html, /id="itemCategory"/, "分類選單不該還在品項表單裡");
});

test("魚種對照：每格都有來源、來源都存在、魚種都在 SPECIES 裡、網址不進頁面", async () => {
  const { app, html } = await loadPage();
  const ref = app.helpers.FISH_REF;
  assert.ok(Array.isArray(ref) && ref.length >= 5);
  // 陣列來自 vm 的另一個 realm，deepEqual 會因原型不同而紅，比字串
  assert.equal(ref.map((f) => f.species).join("、"), "福壽魚、黑鯛、黑毛、白毛、臭肚");
  const SEEN = ["opened", "search-summary", "user-supplied"];
  for (const fish of ref) {
    assert.ok(app.helpers.SPECIES_NAMES.includes(fish.species), fish.species + " 不在 SPECIES 裡，水域標籤會是空的");
    assert.ok(fish.diet, fish.species + " 缺食性");
    const ids = new Set(fish.sources.map((s) => s.id));
    assert.equal(ids.size, fish.sources.length, fish.species + " 來源編號重複");
    for (const src of fish.sources) {
      assert.ok(src.title, fish.species + " " + src.id + " 缺篇名");
      assert.ok(SEEN.includes(src.seenVia), fish.species + " " + src.id + " seenVia 不合法：" + src.seenVia);
    }
    assert.ok(fish.baits.length >= 3, fish.species + " 餌料類別太少");
    for (const bait of fish.baits) {
      assert.ok(bait.group && bait.role && bait.note, fish.species + " 餌料列缺欄位");
      assert.ok(bait.sources.length >= 1, fish.species + "／" + bait.group + " 沒有來源——沒出處的格子不准進表");
      for (const id of bait.sources) assert.ok(ids.has(id), fish.species + "／" + bait.group + " 引用了不存在的來源 " + id);
    }
    assert.deepEqual(Object.keys(fish.seasons).sort(), ["autumn", "spring", "summer", "winter"]);
    for (const [key, season] of Object.entries(fish.seasons)) {
      // 有字就要有來源；沒來源就留空、畫面印「來源沒講」，不補想像
      assert.equal(Boolean(season.text), season.sources.length > 0, fish.species + " " + key + " 文字與來源要同時有或同時沒有");
      for (const id of season.sources) assert.ok(ids.has(id), fish.species + " " + key + " 引用了不存在的來源 " + id);
    }
  }
  // 白毛的夏季沒有任何來源講，必須留空（黑鯛的夏季在補來源後有尬馬劉撐著）
  assert.equal(ref.find((f) => f.species === "白毛").seasons.summer.text, "");
  assert.doesNotMatch(JSON.stringify(ref), /http/, "網址不進頁面，放 bait/SOURCES.md");
  assert.match(html, /來源數是共識強度，不是釣獲率/);
  assert.match(html, /不是本站的建議/);
  assert.match(html, /function renderFish\(/);
  assert.match(html, /來源沒講/);
  // 來源清單收進 details，收合時那一行要說清楚幾筆是真的開過
  assert.match(html, /<details class="src-fold"><summary>/);
  assert.equal(app.helpers.sourceSummary([{ seenVia: "opened" }, { seenVia: "opened" }, { seenVia: "search-summary" }]), "來源 3 筆（開過 2、搜尋摘要 1）");
  // 每個魚種至少三個「開過」的來源，否則那張卡撐不起來
  for (const fish of ref) {
    const opened = fish.sources.filter((s) => s.seenVia === "opened").length;
    assert.ok(opened >= 3, fish.species + " 只有 " + opened + " 個開過的來源");
  }
});

test("預設值更正：只換還是舊預設值的欄位、每筆只做一次、新裝置不套用", async () => {
  const { app } = await loadPage();
  const h = app.helpers;
  const seed = plain(h.seed());
  const fixes = plain(h.SEED_FIXES);
  const seedById = {};
  for (const item of seed.items) seedById[item.id] = item;
  assert.ok(fixes.length >= 3);
  for (const fix of fixes) {
    if (fix.recipeId) {
      const recipe = seed.recipes.find((r) => r.id === fix.recipeId);
      assert.ok(recipe, fix.id + " 指向不存在的預設配方");
      assert.ok(!fix.from.some((old) => JSON.stringify(old) === JSON.stringify(recipe[fix.field])), fix.id + " 的 from 含有現在的預設值");
      continue;
    }
    assert.ok(seedById[fix.itemId], fix.id + " 指向不存在的預設品項");
    // from 若等於現在的預設值，這筆更正等於「把正確值換成正確值」，而且會把使用者刻意填的值當成舊值
    assert.ok(!fix.from.includes(seedById[fix.itemId][fix.field]), fix.id + " 的 from 含有現在的預設值");
  }

  // 舊裝置：紅餌價格還是 35（舊預設）、南極蝦粉末價格被使用者改成 40
  const old = plain(h.sanitizeState(seed));
  old.appliedFixes = [];
  old.items.find((i) => i.id === "item-fushou-red").unitPrice = 35;
  old.items.find((i) => i.id === "item-krill-laobaiwang").unitPrice = 40;
  const nile = old.items.find((i) => i.id === "item-fushou-nile-1");
  nile.packWeightG = 30000;
  nile.unitPrice = 920;
  const report = plain(h.mergeSeed(old, seed));
  assert.equal(old.items.find((i) => i.id === "item-fushou-red").unitPrice, 34, "還是舊預設值就要換");
  assert.equal(old.items.find((i) => i.id === "item-krill-laobaiwang").unitPrice, 40, "使用者改過的不能動");
  assert.equal(nile.packWeightG, 16000);
  assert.equal(nile.unitPrice, 490);
  assert.ok(report.fixedItems.includes("老百王 福壽紅餌"));
  assert.ok(!report.fixedItems.includes("老百王 南極蝦粉末"));
  assert.equal(old.appliedFixes.length, fixes.length, "每一筆都要記成已檢查");
  assert.match(h.mergeSummary(report), /更正 \d+ 個品項的預設值/);

  // 之後使用者自己把價格改回 35（例如漲價），再開一次不可以被改回 34
  old.items.find((i) => i.id === "item-fushou-red").unitPrice = 35;
  const again = plain(h.mergeSeed(old, seed));
  assert.equal(old.items.find((i) => i.id === "item-fushou-red").unitPrice, 35);
  assert.equal(again.fixedItems.length, 0);

  // appliedFixes 要撐過 sanitizeState（存檔再讀回），且認不得的 id 丟掉
  const round = plain(h.sanitizeState({ ...old, appliedFixes: [...old.appliedFixes, "bogus"] }));
  assert.equal(round.appliedFixes.length, fixes.length);

  // 被刪掉的預設品項不因更正而復活或被改
  const gone = plain(h.sanitizeState(seed));
  gone.appliedFixes = [];
  gone.items = gone.items.filter((i) => i.id !== "item-fushou-nile-1");
  gone.recipes = [];
  gone.dismissedSeedIds = ["item-fushou-nile-1"];
  h.mergeSeed(gone, seed);
  assert.ok(!gone.items.some((i) => i.id === "item-fushou-nile-1"));
});

// 預設配方存進裝置之後，mergeSeed 只補缺的配方、不動已存在的；改了預設配方就得靠 SEED_FIXES 送過去。
test("預設配方更正：黑格 A 撒加玉米碎送得到已存過的裝置，改過或刪掉的不動", async () => {
  const { app } = await loadPage();
  const h = app.helpers;
  const seed = plain(h.seed());
  const fixes = plain(h.SEED_FIXES).filter((f) => f.recipeId === "recipe-blackbream-groundbait");
  assert.deepEqual(fixes.map((f) => f.field).sort(), ["items", "notes"]);
  const oldItems = fixes.find((f) => f.field === "items").from[0];
  const oldNotes = fixes.find((f) => f.field === "notes").from[0];
  const ESA = "recipe-blackbream-groundbait";
  const esaOf = (state) => state.recipes.find((r) => r.id === ESA);

  // 舊裝置：還是上一版的預設（沒有玉米碎、那時也還沒有玉米碎這個品項）
  const makeOld = () => {
    const s = plain(h.sanitizeState(seed));
    s.appliedFixes = s.appliedFixes.filter((id) => !id.startsWith(ESA));
    s.items = s.items.filter((i) => i.id !== "item-corn-cracked");
    esaOf(s).items = plain(oldItems);
    esaOf(s).notes = oldNotes;
    return s;
  };
  const old = makeOld();
  const report = plain(h.mergeSeed(old, seed));
  assert.deepEqual(plain(esaOf(old).items), esaOf(seed).items, "還是舊預設就換成新的組成");
  assert.equal(esaOf(old).notes, esaOf(seed).notes);
  assert.ok(old.items.some((i) => i.id === "item-corn-cracked"), "玉米碎要先補進品項庫");
  assert.deepEqual(report.fixedRecipes, ["黑格 A 撒"]);
  assert.match(h.mergeSummary(report), /更正 1 份配方的預設值（黑格 A 撒/);
  const byId = {};
  for (const item of old.items) byId[item.id] = item;
  assert.deepEqual(plain(h.recipeCost(esaOf(old), byId)).unknown, [], "換過去的每一列都算得出價格");
  // 存檔再讀回，組成不能被 sanitize 丟掉
  assert.deepEqual(plain(h.sanitizeState(old)).recipes.find((r) => r.id === ESA).items, esaOf(seed).items);

  // 使用者改過份量：組成不動（備註沒改過，照樣更正）
  const edited = makeOld();
  esaOf(edited).items[3].amount = 700;
  h.mergeSeed(edited, seed);
  assert.equal(esaOf(edited).items.length, 4, "改過的組成不可以被換掉");
  assert.equal(esaOf(edited).items[3].amount, 700);

  // 使用者刪掉玉米碎這個品項：換過去會缺一列，所以組成不換
  const noCorn = makeOld();
  noCorn.dismissedSeedIds = ["item-corn-cracked"];
  h.mergeSeed(noCorn, seed);
  assert.deepEqual(plain(esaOf(noCorn).items), oldItems);

  // 黑格 練餌從蝦磚改成南極蝦粉末：已存的舊預設一樣要換過去
  const PASTE = "recipe-blackbream-paste";
  const pasteFixes = plain(h.SEED_FIXES).filter((f) => f.recipeId === PASTE);
  assert.deepEqual(pasteFixes.map((f) => f.field).sort(), ["items", "notes"]);
  const oldPaste = plain(h.sanitizeState(seed));
  oldPaste.appliedFixes = [];
  const pasteOf = (state) => state.recipes.find((r) => r.id === PASTE);
  pasteOf(oldPaste).items = plain(pasteFixes.find((f) => f.field === "items").from[0]);
  pasteOf(oldPaste).notes = pasteFixes.find((f) => f.field === "notes").from[0];
  const pasteReport = plain(h.mergeSeed(oldPaste, seed));
  assert.deepEqual(plain(pasteOf(oldPaste).items), seed.recipes.find((r) => r.id === PASTE).items);
  assert.ok(pasteReport.fixedRecipes.includes("黑格 練餌"));

  // 刪掉的預設配方不因更正而復活
  const gone = makeOld();
  gone.recipes = gone.recipes.filter((r) => r.id !== ESA);
  gone.dismissedSeedIds = [ESA];
  h.mergeSeed(gone, seed);
  assert.ok(!gone.recipes.some((r) => r.id === ESA));
});

test("添加劑：配方資料自洽、換算正確、兩處修正不得退回", async () => {
  const { app, html } = await loadPage();
  const h = app.helpers;
  const plans = plain(h.ADDITIVES);
  assert.equal(plans.map((p) => p.species).join("、"), "福壽魚、黑鯛");
  const GRADES = Object.keys(plain(h.GRADE_LABEL));
  for (const plan of plans) {
    assert.ok(h.SPECIES_NAMES.includes(plan.species), plan.species + " 不在 SPECIES 裡");
    const stocks = new Map(plan.stocks.map((st) => [st.id, st]));
    const groups = new Set(plan.groups.map((g) => g.id));
    const srcs = new Set(plan.sources.map((x) => x.id));
    assert.equal(groups.size, plan.groups.length, plan.species + " 組別編號重複");
    // 每組都要寫明它動的是哪一個變數，另一個人讀矩陣時才不會把劑量、酸種類、複方混成同一題
    for (const g of plan.groups) assert.ok(g.variable, g.id + " 沒寫變數");
    // 第一組一定是什麼都不加的空白基準；空白組不跟誰比，其餘每一組都要說清楚跟誰比
    assert.equal(plan.groups[0].doses.length, 0);
    const byId = new Map(plan.groups.map((g) => [g.id, g]));
    const stageIds = (plan.stages || []).map((st) => st.id);
    for (const st of stageIds) {
      const blanks = plan.groups.filter((g) => g.stage === st && g.doses.length === 0);
      assert.equal(blanks.length, 1, plan.species + " 的 " + st + " 段要剛好一個空白組");
    }
    for (const g of plan.groups) {
      if (stageIds.length) assert.ok(stageIds.includes(g.stage), g.id + " 沒標是哪一段");
      if (!g.doses.length) { assert.equal(g.compare.length, 0); continue; }
      assert.ok(g.compare.length >= 1, g.id + " 沒有比較對象");
      for (const c of g.compare) {
        assert.ok(groups.has(c), g.id + " 比較對象 " + c + " 不存在");
        // 兩段各自只動一層：比較對象不可以跨段，否則比到的是兩層一起變
        assert.equal(byId.get(c).stage, g.stage, g.id + " 跨段比較 " + c);
      }
      for (const [id, amount] of g.doses) {
        assert.ok(stocks.has(id), g.id + " 用了不存在的濃縮液 " + id);
        assert.ok(amount > 0);
      }
    }
    for (const e of plan.evidence) {
      assert.ok(GRADES.includes(e.grade), e.claim + " 等級不合法");
      if (e.grade !== "test") assert.ok(e.sources.length >= 1, e.claim + " 沒有來源");
      for (const id of e.sources) assert.ok(srcs.has(id), e.claim + " 引用了不存在的來源 " + id);
    }
    for (const x of plan.sources) assert.ok(["opened", "search-summary", "user-supplied"].includes(x.seenVia));
    for (const sop of plan.sop) assert.ok(stocks.has(sop.stock));
  }
  assert.doesNotMatch(JSON.stringify(plans), /http/, "網址不進頁面，放 bait/SOURCES.md");

  // 換算：每 200 g 基礎餌加 0.5 ml 的 100 mg/ml 液 ＝ 每公斤 2.5 ml ＝ 0.25 g 有效成分
  const tilapia = plans[0];
  const stock = (plan, id) => plan.stocks.find((st) => st.id === id);
  let d = plain(h.doseFor(stock(tilapia, "CIT"), 0.5, 200));
  assert.equal(d.amountPerKg, 2.5);
  assert.ok(Math.abs(d.activeGPerKg - 0.25) < 1e-12);
  d = plain(h.doseFor(stock(tilapia, "CIT"), 2.0, 200));
  assert.ok(Math.abs(d.activeGPerKg - 1.0) < 1e-12);
  d = plain(h.doseFor(stock(tilapia, "SWT"), 0.2, 200));
  assert.ok(Math.abs(d.activeGPerKg - 0.09) < 1e-12, "奶甜 0.2 ml 應該是 0.09 g/kg");
  d = plain(h.doseFor(stock(tilapia, "FRU"), 0.5, 200));
  assert.equal(d.activeGPerKg, null, "香精只知道體積，不能印出有效成分公克數");
  // 稀釋液 0.5 ml／200 g ＝ 2.5 ml/kg，但純香精只有 2.5 × 15/200 ＝ 0.1875 ml/kg——
  // 也就是原報告 A2 夾帶的量（0.5 × 15/200 ＝ 0.0375 ml／200 g）。印稀釋液體積曾被照抄成 10 倍錯誤。
  assert.ok(Math.abs(d.pureMlPerKg - 0.1875) < 1e-12);
  assert.ok(Math.abs(d.pureMlPerKg / 5 - 0.0375) < 1e-12);
  d = plain(h.doseFor(stock(plans[1], "KRL"), 5, 200));
  assert.equal(d.activeGPerKg, 25, "粉末 5 g／200 g ＝ 25 g/kg");
  assert.equal(d.pureMlPerKg, null, "粉末沒有香精；少了這個欄位畫面會印出「純香精 NaN」");
  // 兩段式：第一段是底餌（嗅覺），第二段是主餌（味覺）
  assert.equal(tilapia.stages.map((st) => st.id).join(","), "attract,bite");
  // 主餌以每次釣用的乾粉 300 g 為基準、底餌 200 g；每公斤的比例不因換基準而變
  const baseOf = (stageId) => tilapia.stages.find((st) => st.id === stageId).baseGrams;
  assert.equal(baseOf("bite"), 300);
  assert.equal(baseOf("attract"), 1500, "底餌以每次釣用的 1.5 kg 為準");
  // 紅蟲萃取只留作備註（使用者不購買冷凍紅蟲）：不可以回到實驗組或濃縮液，但第一段要說出這件事
  assert.ok(!tilapia.stocks.some((x) => x.id === "BLW"));
  assert.ok(!tilapia.groups.some((g) => g.id === "G2"));
  assert.match(tilapia.stages.find((st) => st.id === "attract").base, /紅蟲萃取液只留作備註/);
  // 換了基準，每公斤比例不能變：南極蝦粉仍 25 g/kg
  const perKg = (groupId, stockId) => {
    const g = tilapia.groups.find((x) => x.id === groupId);
    const amount = g.doses.find(([id]) => id === stockId)[1];
    return plain(h.doseFor(stock(tilapia, stockId), amount, baseOf(g.stage))).activeGPerKg;
  };
  assert.equal(perKg("G3", "KRL"), 25);
  // 色胺酸照 GIFT 吳郭魚飼料試驗的 1.8 g/kg——300 g 主餌乾粉 0.54 g
  assert.ok(Math.abs(perKg("T11", "TRP") - 1.8) < 1e-12);
  assert.ok(Math.abs(perKg("T2", "CIT") - 0.25) < 1e-12, "檸檬酸低劑量仍是 0.25 g/kg");
  assert.ok(Math.abs(perKg("T6", "CIT") - 1.0) < 1e-12, "檸檬酸高劑量仍是 1 g/kg");
  assert.ok(Math.abs(perKg("T12", "SOR") - 0.25) < 1e-12);
  // 半胱胺酸是若亞方舟買得到的紅蟲替代，在第一段；紅蟲不做了，只跟空白比
  const g5 = tilapia.groups.find((g) => g.id === "G5");
  assert.equal(g5.stage, "attract");
  assert.equal(g5.compare.join(","), "G1");
  assert.ok(Math.abs(perKg("G5", "CYS") - 0.25) < 1e-12);
  // 雞肝漿同樣只留作備註（使用者不自己蒸）：T13 與 LIV 不得回來，第二段要說出這件事
  assert.ok(!tilapia.stocks.some((x) => x.id === "LIV"));
  assert.ok(!tilapia.groups.some((g) => g.id === "T13"));
  assert.match(tilapia.stages.find((st) => st.id === "bite").base, /蒸熟雞肝漿只留作備註/);
  // DMPT、甜菜鹼在吳郭魚飼料試驗裡沒有增加攝食量，不可以出現在福壽魚的配方裡
  assert.doesNotMatch(JSON.stringify(tilapia.stocks), /DMPT|甜菜鹼/);

  // 修正一：主酸液不得再夾帶香精——夾帶的話 T2、T6 又會變回「酸＋香」，分不開
  assert.doesNotMatch(stock(tilapia, "CIT").made, /香/);
  assert.doesNotMatch(stock(tilapia, "MAL").made, /香/);
  // 修正二：同酸濃度的檸檬酸與蘋果酸各有一組、而且都跟 T2 比，才是只差酸種類的單一變因
  const t7 = tilapia.groups.find((g) => g.id === "T7");
  assert.deepEqual(t7.compare, ["T2"]);
  assert.equal(stock(tilapia, "CIT").mgPerMl, stock(tilapia, "MAL").mgPerMl);
  // 原報告的配方要留著比，不是被刪掉
  assert.ok(tilapia.groups.some((g) => g.doses.some(([id]) => id === "ORIG")));

  assert.match(html, /待驗證的實驗假說，不是本站的建議/);
  // 實測紀錄已依使用者要求移除（2026-09-25）
  assert.doesNotMatch(html, /trialHeading|sanitizeTrial|state\.trials/);
  // 以前的「第 3 欄至少 220px」規則把手機上的其他欄擠成一格一個字、整張表撐出螢幕。
  // 魚種對照與添加劑的表都改走 stackTable（手機上排成「欄名：內容」），那條規則不得回來。
  const renderAdd = html.slice(html.indexOf("function renderAdditives("), html.indexOf("function renderLog("));
  assert.doesNotMatch(html, /fish-table|min-width:220px/);
  const renderFishBody = html.slice(html.indexOf("function renderFish("), html.indexOf("function renderLog("));
  assert.match(renderFishBody, /stackTable\(\["餌料類別"/);
  // 實驗組與證據等級收合，收合列要看得出幾組、各等級幾條
  assert.match(renderAdd, /<details class="src-fold"><summary>' \+ esc\(stage\.title\)/, "每一段的實驗組各自收合");
  assert.match(renderAdd, /title: "實驗組", baseGrams: 200, baseLabel: "基礎餌"/, "沒分段的魚種仍是一個實驗組收合，基準 200 g");
  assert.match(renderAdd, /evidenceSummary\(plan\.evidence\)/);
  assert.match(html, /\.add-table td::before\{content:attr\(data-label\)/, "手機上要改排成「欄名：內容」");
  // 0.01 M 是 L-半胱胺酸失效的濃度，不可以再被寫成檸檬酸的閾值
  assert.doesNotMatch(JSON.stringify(plans), /檸檬酸[^。]*閾值約/);
  // 「沒有研究」只能寫成「這次檢索沒找到」
  assert.doesNotMatch(JSON.stringify(plans) + html, /黑鯛本身沒有同類研究|黑鯛沒有同類研究/);
});

// 黑格比照福壽魚分兩段：A 撒（誘過來）與練餌（讓牠開口），各自只動一層。
test("黑格：A 撒與練餌兩段、編號不撞來源、每公斤換算、預設配方的總重與總價", async () => {
  const { app } = await loadPage();
  const h = app.helpers;
  const bream = plain(h.ADDITIVES).find((p) => p.species === "黑鯛");
  assert.equal(bream.stages.map((st) => st.id).join(","), "attract,bite");
  const baseOf = (stageId) => bream.stages.find((st) => st.id === stageId).baseGrams;
  assert.equal(baseOf("attract"), 3000, "A 撒以每次 3 kg 為準");
  assert.equal(baseOf("bite"), 300, "練餌以每次 300 g 為準");
  const byId = new Map(bream.groups.map((g) => [g.id, g]));
  for (const st of ["attract", "bite"]) {
    assert.equal(bream.groups.filter((g) => g.stage === st && g.doses.length === 0).length, 1, st + " 段要剛好一個空白組");
  }
  for (const g of bream.groups) {
    for (const c of g.compare) assert.equal(byId.get(c).stage, g.stage, g.id + " 跨段比較 " + c);
  }
  // 實驗組以前用 B1–B7，跟魚種對照的來源 B1–B11 撞名；組別不可以再跟任何來源編號重疊
  const fish = plain(h.FISH_REF).find((f) => f.species === "黑鯛");
  const sourceIds = new Set([...fish.sources, ...bream.sources].map((s) => s.id));
  for (const g of bream.groups) assert.ok(!sourceIds.has(g.id), g.id + " 跟來源編號撞名");
  assert.ok(bream.groups.filter((g) => g.stage === "attract").every((g) => /^M\d+$/.test(g.id)), "A 撒是 M 組");
  assert.ok(bream.groups.filter((g) => g.stage === "bite").every((g) => /^K\d+$/.test(g.id)), "練餌是 K 組");
  // 每公斤換算：換了基準（200 g → 300 g、加上 3 kg 的 A 撒），比例不能變
  const stock = (id) => bream.stocks.find((st) => st.id === id);
  const perKg = (groupId, stockId) => {
    const g = byId.get(groupId);
    const amount = g.doses.find(([id]) => id === stockId)[1];
    return plain(h.doseFor(stock(stockId), amount, baseOf(g.stage))).activeGPerKg;
  };
  assert.equal(perKg("M2", "KRL"), 25, "A 撒 3 kg 取 75 g 南極蝦粉＝每公斤 25 g");
  assert.equal(perKg("K6", "KRL"), 25, "練餌 300 g 取 7.5 g＝每公斤 25 g，跟改基準前的 5 g／200 g 相同");
  assert.equal(perKg("M3", "KRL"), 50);
  assert.ok(Math.abs(perKg("M4", "AA") - 0.25) < 1e-12, "A 撒的胺基酸 7.5 ml＝0.25 g/kg");
  assert.ok(Math.abs(perKg("K2", "AA") - 0.25) < 1e-12, "練餌的胺基酸低劑量仍是 0.25 g/kg");
  assert.ok(Math.abs(perKg("K5", "AA") - 1.0) < 1e-12, "練餌的胺基酸高劑量仍是 1 g/kg");
  assert.ok(Math.abs(perKg("K3", "BET") - 0.25) < 1e-12);

  // 兩份預設配方：總重就是使用者給的每次份量，每一列都算得出價格
  const seed = plain(h.seed());
  const itemsById = {};
  for (const item of seed.items) itemsById[item.id] = item;
  const recipe = (id) => seed.recipes.find((r) => r.id === id);
  const esa = recipe("recipe-blackbream-groundbait");
  const paste = recipe("recipe-blackbream-paste");
  assert.equal(esa.title, "黑格 A 撒");
  assert.equal(esa.purpose, "GROUNDBAIT");
  assert.equal(paste.title, "黑格 練餌");
  assert.equal(paste.purpose, "MAIN_BAIT");
  for (const r of [esa, paste]) assert.deepEqual(r.targetSpecies, ["黑鯛"]);
  // 驗收基準：蝦磚 1 包 1500 g $135 ＋ 燕麥片 400 g $50.4 ＋ 尼羅魚一號 500 g $15.3125
  //         ＋ 幼雞飼料 450 g $14.175 ＋ 玉米碎 150 g $10.5
  let cost = plain(h.recipeCost(esa, itemsById));
  assert.equal(cost.totalGrams, 3000);
  assert.ok(Math.abs(cost.total - 225.3875) < 1e-9, "A 撒總價得到 " + cost.total);
  assert.deepEqual(cost.unknown, []);
  // 全乾粉：高筋麵粉 185 g $13.32 ＋ 老百王南極蝦粉末 75 g $17 ＋ 小麥蛋白 20 g $3.9 ＋ 赤尾青 20 g $30×20/70
  cost = plain(h.recipeCost(paste, itemsById));
  assert.equal(cost.totalGrams, 300);
  assert.ok(Math.abs(cost.total - (13.32 + 17 + 3.9 + 30 * 20 / 70)) < 1e-9, "練餌總價得到 " + cost.total);
  assert.deepEqual(cost.unknown, []);
  assert.ok(!paste.items.some((row) => row.itemId === "item-krill-block"), "練餌改用南極蝦粉末，不用蝦磚");

  // 備註有字數上限（品項 200、配方 500），超過會在 sanitize 時被安靜截掉
  const clean = plain(h.sanitizeState(seed));
  for (const id of ["item-krill-block", "item-flour-bread", "item-oats-noah", "item-corn-cracked", "item-glycine-noah", "item-alanine-noah"]) {
    assert.equal(clean.items.find((i) => i.id === id).notes, itemsById[id].notes, id + " 的備註被截掉");
  }
  for (const r of [esa, paste]) assert.equal(clean.recipes.find((x) => x.id === r.id).notes, r.notes, r.title + " 的備註被截掉");
  // 使用者提供的價格要說出來，不可以寫得像在頁面上看到的
  assert.match(itemsById["item-krill-block"].notes, /使用者提供/);
  assert.match(itemsById["item-flour-bread"].notes, /使用者提供/);
});
