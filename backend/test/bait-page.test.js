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

const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} 不等於 ${expected}`);
};

// 兩個單品：A 是快沉的黏 A 撒、B 是漂浮的爆霧添加劑，兩者的每項特性剛好相反，
// 加權平均算錯方向會立刻看得出來。
const ITEM_A = {
  id: "a", name: "底料", category: "GROUNDBAIT",
  unitPrice: 200, packWeightG: 1000, gramsPerCup: 250,
  viscosity: 5, foggingRate: 1, sinkingSpeed: "VERY_FAST",
  flavorProfile: ["腥"], targetSpecies: ["黑鯛"], waterTypes: ["海水"],
  recommendedWaterRatio: 0.5,
};
const ITEM_B = {
  id: "b", name: "誘餌粉", category: "ADDITIVE",
  unitPrice: 600, packWeightG: 600, gramsPerCup: 100,
  viscosity: 1, foggingRate: 5, sinkingSpeed: "FLOATING",
  flavorProfile: ["香"], targetSpecies: [], waterTypes: [],
};

const byId = { a: ITEM_A, b: ITEM_B };

// A 300g（$60）＋ B 兩杯 200g（$200）＝ 500g、$260，佔比 0.6 / 0.4
const RECIPE = {
  items: [
    { itemId: "a", inputMode: "WEIGHT_G", amount: 300 },
    { itemId: "b", inputMode: "VOLUME_CUP", amount: 2 },
  ],
  targetSpecies: [],
  waterAmountRatio: 0,
};

test("頁面公開的 helper 契約", async () => {
  const { app } = await loadPage();
  for (const name of [
    "costPerGram", "toGrams", "recipeRows", "blendProfile", "highCostAdditives",
    "checkFlavor", "checkWaterRatio", "auditRecipe", "sinkScoreOf",
    "sanitizeItem", "sanitizeRecipe", "sanitizeState", "emptyDraft",
    "exportPayload", "importPayload", "todayISO", "sinkScoreOf", "scoreToSinkingSpeed",
  ]) {
    assert.equal(typeof app.helpers[name], "function", `缺 helper: ${name}`);
  }
  assert.equal(typeof app.init, "function");
  assert.deepEqual(plain(app.helpers.WATER_TYPES), ["淡水", "海水"]);
  assert.deepEqual(plain(app.helpers.CATEGORIES).map((row) => row.id), ["MAIN_BAIT", "GROUNDBAIT", "ADDITIVE"]);
  assert.deepEqual(plain(app.helpers.SINKING).map((row) => row.id), ["VERY_FAST", "FAST", "MEDIUM", "SLOW", "FLOATING"]);
  assert.equal(app.helpers.HIGH_COST_SHARE, 0.4);
});

// pickList 對認不得的字是安靜丟掉的，所以詞彙表少一個字，匯入會「成功」但那一欄
// 整個消失。淡水那組是後來補的，釘住免得被當成海水頁的雜訊刪掉。
test("魚種與水域詞彙表", async () => {
  const { app } = await loadPage();
  for (const name of ["黑鯛", "臭肚", "福壽魚"]) {
    assert.ok(plain(app.helpers.SPECIES).includes(name), `SPECIES 缺 ${name}`);
  }
  // 每個魚種都要有水域歸屬，否則分組時會落到「其他」而沒人發現
  const water = plain(app.helpers.SPECIES_WATER);
  for (const name of plain(app.helpers.SPECIES)) {
    assert.ok(["淡水", "海水"].includes(water[name]), `${name} 沒有水域歸屬`);
  }
  assert.equal(water["福壽魚"], "淡水");
  assert.equal(water["黑鯛"], "海水");
  const item = plain(app.helpers.sanitizeItem({ name: "測試", targetSpecies: ["福壽魚"], waterTypes: ["淡水", "亂填"] }));
  assert.deepEqual(item.targetSpecies, ["福壽魚"]);
  assert.deepEqual(item.waterTypes, ["淡水"]);
});

test("每克成本：包裝重量沒填或是 0 一律回 null，不讓成本變成 Infinity", async () => {
  const { app } = await loadPage();
  near(app.helpers.costPerGram(ITEM_A), 0.2, "A 每克成本");
  near(app.helpers.costPerGram(ITEM_B), 1, "B 每克成本");
  assert.equal(app.helpers.costPerGram({ unitPrice: 100, packWeightG: 0 }), null);
  assert.equal(app.helpers.costPerGram({ unitPrice: 100 }), null);
  assert.equal(app.helpers.costPerGram({ unitPrice: -5, packWeightG: 100 }), null);
  assert.equal(app.helpers.costPerGram(null), null);
});

test("量杯換克需要 gramsPerCup，缺了就回 null 而不是猜一個密度", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.toGrams({ inputMode: "WEIGHT_G", amount: 300 }, ITEM_A), 300);
  assert.equal(app.helpers.toGrams({ inputMode: "VOLUME_CUP", amount: 2 }, ITEM_B), 200);
  assert.equal(app.helpers.toGrams({ inputMode: "VOLUME_CUP", amount: 2 }, { name: "沒填每杯克數" }), null);
  assert.equal(app.helpers.toGrams({ inputMode: "VOLUME_CUP", amount: 2 }, { gramsPerCup: 0 }), null);
  assert.equal(app.helpers.toGrams({ inputMode: "WEIGHT_G", amount: -1 }, ITEM_A), null);
  assert.equal(app.helpers.toGrams({ inputMode: "OTHER", amount: 1 }, ITEM_A), null);
});

test("配方展開：重量、成本、佔比", async () => {
  const { app } = await loadPage();
  const summary = app.helpers.recipeRows(RECIPE, byId);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.totalWeightG, 500);
  near(summary.totalCostTWD, 260, "總成本");
  near(summary.rows[0].share, 0.6, "A 佔比");
  near(summary.rows[1].share, 0.4, "B 佔比");
  assert.equal(summary.rows[1].convertedWeightG, 200);
  assert.deepEqual(plain(summary.unresolved), []);
  assert.deepEqual(plain(summary.costUnknown), []);
});

test("換算不出來的列不進總量，改列進 unresolved；缺價格的列只讓成本低估", async () => {
  const { app } = await loadPage();
  const summary = app.helpers.recipeRows({
    items: [
      { itemId: "a", inputMode: "WEIGHT_G", amount: 300 },
      { itemId: "ghost", inputMode: "WEIGHT_G", amount: 100 },
      { itemId: "c", inputMode: "VOLUME_CUP", amount: 1 },
      { itemId: "d", inputMode: "WEIGHT_G", amount: 200 },
    ],
  }, {
    a: ITEM_A,
    c: { id: "c", name: "沒填每杯克數", category: "GROUNDBAIT", viscosity: 3, foggingRate: 3, sinkingSpeed: "MEDIUM" },
    d: { id: "d", name: "沒填價格", category: "GROUNDBAIT", viscosity: 3, foggingRate: 3, sinkingSpeed: "MEDIUM" },
  });
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.totalWeightG, 500);
  near(summary.totalCostTWD, 60, "只有 A 算得出成本");
  assert.deepEqual(plain(summary.unresolved), ["ghost", "c"]);
  assert.deepEqual(plain(summary.costUnknown), ["d"]);
});

test("綜合特性是按重量佔比加權，沉速先轉分數再 round 回級距", async () => {
  const { app } = await loadPage();
  const summary = app.helpers.recipeRows(RECIPE, byId);
  const profile = app.helpers.blendProfile(summary.rows, byId);
  near(profile.viscosity, 3.4, "綜合黏性");
  near(profile.foggingRate, 2.6, "綜合霧化");
  near(profile.sinkScore, 3.4, "綜合比重分數");
  assert.equal(profile.sinkingSpeed, "MEDIUM");
  assert.equal(app.helpers.blendProfile([], byId), null);
});

test("沉速分數映射兩個方向都對得起來", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.sinkScoreOf("VERY_FAST"), 5);
  assert.equal(app.helpers.sinkScoreOf("FLOATING"), 1);
  assert.equal(app.helpers.sinkScoreOf("不存在的值"), 3);
  assert.equal(app.helpers.scoreToSinkingSpeed(4.6), "VERY_FAST");
  assert.equal(app.helpers.scoreToSinkingSpeed(2.4), "SLOW");
  assert.equal(app.helpers.scoreToSinkingSpeed(99), "VERY_FAST");
  assert.equal(app.helpers.scoreToSinkingSpeed(-3), "FLOATING");
  assert.equal(app.helpers.scoreToSinkingSpeed("x"), "MEDIUM");
});

test("高成本提示是逐項判定，只看添加劑", async () => {
  const { app } = await loadPage();
  const summary = app.helpers.recipeRows(RECIPE, byId);
  const hits = plain(app.helpers.highCostAdditives(summary.rows, byId, summary.totalCostTWD));
  assert.deepEqual(hits.map((row) => row.itemId), ["b"]);
  near(hits[0].share, 200 / 260, "B 的成本佔比");

  // 同樣的金額結構，但把 B 改成 A 撒就不該報——規格要抓的是添加劑吃掉預算。
  const asGroundbait = { a: ITEM_A, b: { ...ITEM_B, category: "GROUNDBAIT" } };
  assert.deepEqual(plain(app.helpers.highCostAdditives(summary.rows, asGroundbait, summary.totalCostTWD)), []);
  assert.deepEqual(plain(app.helpers.highCostAdditives(summary.rows, byId, 0)), []);
});

test("流速已移除：頁面不再有 checkFlow 或 expectedFlowRate", async () => {
  const { app, html } = await loadPage();
  assert.equal(app.helpers.checkFlow, undefined);
  assert.equal(app.helpers.FLOW_RATES, undefined);
  assert.doesNotMatch(html, /expectedFlowRate|FLOW_RATES|flow-vs-sink|預期流速/);
  const recipe = plain(app.helpers.sanitizeRecipe({ title: "x", expectedFlowRate: "FAST", items: [] }, null));
  assert.equal(recipe.expectedFlowRate, undefined, "流速不該再被存下來");
  assert.deepEqual(recipe.targetWaterTypes, []);
});

test("味型 vs 魚種：臭肚缺藻類或發酵味才提示", async () => {
  const { app } = await loadPage();
  const rows = [{ itemId: "a", share: 1 }];
  assert.equal(app.helpers.checkFlavor(rows, byId, []), null);
  assert.equal(app.helpers.checkFlavor(rows, byId, ["黑鯛"]), null);

  const hit = app.helpers.checkFlavor(rows, byId, ["臭肚"]);
  assert.equal(hit.code, "flavor-vs-species");
  assert.equal(hit.level, "info");

  const algae = { a: { ...ITEM_A, flavorProfile: ["藻/青苔"] } };
  assert.equal(app.helpers.checkFlavor(rows, algae, ["臭肚"]), null);
  const fermented = { a: { ...ITEM_A, flavorProfile: ["酸/發酵"] } };
  assert.equal(app.helpers.checkFlavor(rows, fermented, ["臭肚"]), null);
});

test("水比驗證：只拿有填建議值的單品加權，並在該子集內重新正規化", async () => {
  const { app } = await loadPage();
  const summary = app.helpers.recipeRows(RECIPE, byId);
  // 只有 A 填了 0.5，B 沒填 → 建議值就是 0.5，而不是被 B 的佔比稀釋成 0.3
  assert.equal(app.helpers.checkWaterRatio(summary.rows, byId, 0.6), null, "剛好在 1.2 倍容差上不該警告");
  const hit = app.helpers.checkWaterRatio(summary.rows, byId, 0.7);
  assert.equal(hit.code, "water-too-high");
  near(hit.suggested, 0.5, "建議水比");
  assert.match(hit.message, /脫鉤/);

  // 沒有任何單品填建議值 → 無從比較，不要憑空報警
  const noHint = { a: { ...ITEM_A, recommendedWaterRatio: null }, b: ITEM_B };
  assert.equal(app.helpers.checkWaterRatio(summary.rows, noHint, 3), null);
  assert.equal(app.helpers.checkWaterRatio(summary.rows, byId, 0), null);
});

test("auditRecipe 把三類意見彙總起來", async () => {
  const { app } = await loadPage();
  const result = app.helpers.auditRecipe({
    ...RECIPE,
    targetSpecies: ["臭肚"],
    waterAmountRatio: 1.5,
  }, byId);
  const codes = plain(result.notes).map((note) => note.code);
  assert.deepEqual(codes, ["high-cost-additive", "flavor-vs-species", "water-too-high"]);
  assert.equal(result.summary.totalWeightG, 500);

  const clean = app.helpers.auditRecipe(RECIPE, { a: ITEM_A, b: { ...ITEM_B, unitPrice: 20 } });
  assert.deepEqual(plain(clean.notes), []);
});

test("空配方不會爆，也不會生出意見", async () => {
  const { app } = await loadPage();
  const result = app.helpers.auditRecipe({ items: [] }, {});
  assert.equal(result.summary.totalWeightG, 0);
  assert.equal(result.profile, null);
  assert.deepEqual(plain(result.notes), []);
  assert.deepEqual(plain(app.helpers.auditRecipe(null, {}).notes), []);
});

test("sanitizeItem：名稱必填，數值夾在合法範圍，列舉值對不上就退回預設", async () => {
  const { app } = await loadPage();
  assert.equal(app.helpers.sanitizeItem({ name: "   " }), null);
  assert.equal(app.helpers.sanitizeItem(null), null);

  const item = plain(app.helpers.sanitizeItem({
    id: "x", name: " 新料 ", category: "亂填", sinkingSpeed: "亂填",
    unitPrice: -10, packWeightG: 0, gramsPerCup: -1,
    viscosity: 99, foggingRate: 0, recommendedWaterRatio: 0,
    flavorProfile: ["腥", "腥", "不存在的味型"],
    targetSpecies: ["黑鯛", "外星魚"], waterTypes: "不是陣列",
    imageUrl: "javascript:alert(1)",
  }));
  assert.equal(item.name, "新料");
  assert.equal(item.category, "GROUNDBAIT");
  assert.equal(item.sinkingSpeed, "MEDIUM");
  assert.equal(item.unitPrice, 0);
  assert.equal(item.packWeightG, null);
  assert.equal(item.gramsPerCup, null);
  assert.equal(item.recommendedWaterRatio, null);
  assert.equal(item.viscosity, 5);
  assert.equal(item.foggingRate, 1);
  assert.deepEqual(item.flavorProfile, ["腥"]);
  assert.deepEqual(item.targetSpecies, ["黑鯛"]);
  assert.deepEqual(item.waterTypes, []);
  assert.equal(item.imageUrl, "", "只接受 data:image/ 開頭的縮圖");
});

test("sanitizeRecipe：丟掉指向不存在單品的列與非正數用量", async () => {
  const { app } = await loadPage();
  const recipe = plain(app.helpers.sanitizeRecipe({
    title: "  ", createdAt: "壞日期", rating: 99, caughtTarget: "yes",
    targetWaterTypes: ["淡水", "亂填"], shrimpStatus: "亂填",
    items: [
      { itemId: "a", inputMode: "WEIGHT_G", amount: 300 },
      { itemId: "ghost", inputMode: "WEIGHT_G", amount: 100 },
      { itemId: "b", inputMode: "亂填", amount: 0 },
      { itemId: "b", inputMode: "亂填", amount: 2 },
    ],
  }, { a: true, b: true }));
  assert.equal(recipe.title, "未命名配方");
  assert.match(recipe.createdAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(recipe.rating, 5);
  assert.equal(recipe.caughtTarget, false, "只有布林 true 才算中魚");
  assert.deepEqual(recipe.targetWaterTypes, ["淡水"]);
  assert.equal(recipe.shrimpStatus, "");
  assert.deepEqual(recipe.items.map((row) => row.itemId), ["a", "b"]);
  assert.equal(recipe.items[1].inputMode, "VOLUME_CUP", "認不得的輸入模式退回量杯");
});

test("sanitizeState：單品去重、配方跟著已知單品收斂", async () => {
  const { app } = await loadPage();
  const state = plain(app.helpers.sanitizeState({
    items: [ITEM_A, ITEM_A, { name: "" }],
    recipes: [{ title: "留下", items: [{ itemId: "a", inputMode: "WEIGHT_G", amount: 100 }, { itemId: "b", inputMode: "WEIGHT_G", amount: 100 }] }],
    draft: { items: [{ itemId: "b", inputMode: "WEIGHT_G", amount: 100 }] },
  }));
  assert.equal(state.items.length, 1);
  assert.equal(state.recipes.length, 1);
  assert.deepEqual(state.recipes[0].items.map((row) => row.itemId), ["a"], "b 不在單品庫裡就不該留下");
  assert.deepEqual(state.draft.items, []);
  assert.equal(state.version, 2);
  assert.equal(app.helpers.sanitizeState(null), null);
});

test("匯出／匯入：不是本頁的檔案一律拒絕，並說得出理由", async () => {
  const { app } = await loadPage();
  const state = app.helpers.sanitizeState({ items: [ITEM_A, ITEM_B], recipes: [RECIPE] });
  const payload = plain(app.helpers.exportPayload(state));
  assert.equal(payload.kind, "bjkw-bait");
  assert.equal(payload.version, 2);
  assert.equal(payload.items.length, 2);

  const roundTrip = app.helpers.importPayload(JSON.stringify(payload));
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.state.items.length, 2);
  assert.equal(roundTrip.state.recipes.length, 1);

  assert.equal(app.helpers.importPayload("{ 壞掉的 json").ok, false);
  assert.match(app.helpers.importPayload("{ 壞掉的 json").reason, /JSON/);
  assert.equal(app.helpers.importPayload(JSON.stringify({ items: [] })).ok, false);
  assert.match(app.helpers.importPayload(JSON.stringify({ items: [] })).reason, /kind/);
  const wrongVersion = app.helpers.importPayload(JSON.stringify({ kind: "bjkw-bait", version: 1 }));
  assert.equal(wrongVersion.ok, false);
  assert.match(wrongVersion.reason, /沒有自動轉換/);
});

test("頁面結構的硬性前提", async () => {
  const { html } = await loadPage();
  assert.match(html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "主 script 必須緊貼 </body>");
  assert.doesNotMatch(html.split("<body")[1], /https?:\/\//, "body 之後不得出現外部網址");
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/, "這一頁不打網路");
  // 分頁鈕的 class 是 mobile-audit.html 走訪非預設分頁的依據，改名等於那兩個分頁量不到
  assert.match(html, /<div class="tabbar"[^>]*>/);
  assert.equal((html.match(/class="tab(?: on)?"/g) || []).length, 3);
  assert.match(html, /id="mixWaterTypes"/);
  assert.match(html, /id="itemWaterTypes"/);
});
