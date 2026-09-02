import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 這一頁的主 script 必須是最後一個、且緊貼 </body>，否則這個正則抓不到，整批測試會失效。
// 靜態契約有同一條斷言把關。
async function loadPage() {
  const htmlPath = fileURLToPath(new URL("../../coupon/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "coupon 頁的行內 script 應該存在且緊貼 </body>");

  const store = new Map();
  const window = { __COUPON_CONSOLE_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { getElementById: () => null, addEventListener() {} },
    fetch: async () => { throw new Error("測試不應該打網路"); },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    setTimeout,
    URL,
    window,
  });
  vm.runInContext(script, context, { filename: "coupon/index.html" });
  return { app: context.window.CouponApp, html };
}

async function loadFeed() {
  const path = fileURLToPath(new URL("../../data/coupons.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

function ctx(patch = {}) {
  return {
    platformId: "shopee",
    subtotal: 1000,
    shipping: 60,
    newUser: false,
    owned: {},
    today: "2026-09-03",
    ...patch,
  };
}

// vm.createContext 有自己的 realm：從腳本裡回來的陣列不是這支測試的 Array，
// deepEqual 會因為 prototype 不同而失敗。比對前一律先攤平。
const plain = (value) => JSON.parse(JSON.stringify(value));

const offer = (patch) => ({
  id: "x", appliesTo: "*", stackGroup: "platform-coupon",
  title: "測試券", benefit: { type: "fixed", value: 100 }, ...patch,
});

test("頁面公開的 helper 契約", async () => {
  const { app } = await loadPage();
  for (const name of [
    "isActive", "appliesToPlatform", "blockReason", "discountOf", "rebateOf",
    "evaluate", "bestCombo", "candidatesByGroup", "sanitizeState", "expiryLabel",
    "benefitText", "daysBetween", "todayISO",
  ]) {
    assert.equal(typeof app.helpers[name], "function", `缺 helper: ${name}`);
  }
  assert.equal(typeof app.init, "function");
  assert.deepEqual(plain(app.helpers.GROUPS).map((g) => g.id),
    ["platform-coupon", "platform-shipping", "card", "pay"],
    "組別順序就是結算順序，改動要連同計算一起想過");
});

test("過期與尚未開始的優惠都不算有效", async () => {
  const { app } = await loadPage();
  const { isActive } = app.helpers;
  const today = "2026-09-03";

  assert.equal(isActive(offer({ validUntil: "2026-09-02" }), today), false, "昨天到期");
  assert.equal(isActive(offer({ validUntil: "2026-09-03" }), today), true, "今天到期仍可用");
  assert.equal(isActive(offer({ validFrom: "2026-09-04" }), today), false, "明天才開始");
  assert.equal(isActive(offer({ validFrom: "2026-09-03" }), today), true, "今天開始");
  // 沒有截止日不等於永久有效，但也不該被當成過期而消失
  assert.equal(isActive(offer({ validFrom: null, validUntil: null }), today), true);
});

test("不能用的理由要講得出是哪一條", async () => {
  const { app } = await loadPage();
  const { blockReason } = app.helpers;

  assert.equal(blockReason(offer({}), ctx()), null, "沒有限制就是可用");
  assert.match(blockReason(offer({ minSpend: 1500 }), ctx({ subtotal: 1000 })), /差 NT\$500 到門檻/);
  assert.equal(blockReason(offer({ minSpend: 1000 }), ctx({ subtotal: 1000 })), null, "剛好到門檻算過");
  assert.equal(blockReason(offer({ audience: "new" }), ctx({ newUser: false })), "限新戶");
  assert.equal(blockReason(offer({ audience: "new" }), ctx({ newUser: true })), null);
  assert.equal(blockReason(offer({ appliesTo: ["momo"] }), ctx()), "不適用這個平台");
  assert.equal(blockReason(offer({ validUntil: "2026-01-01" }), ctx()), "已過期");
  // 信用卡與支付加碼要勾了「我有」才算數，否則等於假設人人都持有每一張卡
  assert.equal(blockReason(offer({ requiresOwned: true, id: "c1" }), ctx()), "你沒有勾選持有");
  assert.equal(blockReason(offer({ requiresOwned: true, id: "c1" }), ctx({ owned: { c1: true } })), null);
});

test("折抵金額吃上限，回饋金額也吃上限", async () => {
  const { app } = await loadPage();
  const { discountOf, rebateOf } = app.helpers;

  assert.equal(discountOf(offer({ benefit: { type: "fixed", value: 100 } }), ctx()), 100);
  assert.equal(discountOf(offer({ benefit: { type: "percent", value: 30, cap: null } }), ctx()), 300);
  assert.equal(discountOf(offer({ benefit: { type: "percent", value: 30, cap: 120 } }), ctx()), 120,
    "30% of 1000 = 300，但上限 120");
  assert.equal(discountOf(offer({ benefit: { type: "freeship" } }), ctx()), 0, "免運不是折抵");

  const rebate = offer({ benefit: { type: "rebate", value: 10, cap: 50 }, rebateBase: null });
  assert.equal(rebateOf(rebate, ctx(), 800), 50, "10% of 800 = 80，但上限 50");
});

// 這是整個試算最容易錯、也最容易被誤解的一條：回饋是以折扣前還是折扣後的金額算。
// 來源沒寫明時一律以折後估算——方向偏保守，估低不估高。
test("回饋基準：查不到就用折後金額，估低不估高", async () => {
  const { app } = await loadPage();
  const { rebateOf } = app.helpers;
  const scenario = ctx({ subtotal: 1000, shipping: 60 });
  const payable = 660; // 折抵 400 之後 + 運費 60

  const unknown = offer({ benefit: { type: "rebate", value: 10, cap: null }, rebateBase: null });
  assert.equal(rebateOf(unknown, scenario, payable), 66, "未查證 → 以折後 660 計算");

  const before = offer({ benefit: { type: "rebate", value: 10, cap: null }, rebateBase: "subtotal" });
  assert.equal(rebateOf(before, scenario, payable), 106, "折扣前基準 → (1000+60) × 10%");

  const after = offer({ benefit: { type: "rebate", value: 10, cap: null }, rebateBase: "payable" });
  assert.equal(rebateOf(after, scenario, payable), 66);
});

test("折抵不會把商品金額壓成負的，運費照付", async () => {
  const { app } = await loadPage();
  const { evaluate } = app.helpers;
  const scenario = ctx({ subtotal: 500, shipping: 60 });

  const huge = offer({ benefit: { type: "fixed", value: 9999 } });
  const result = evaluate([huge], scenario);
  assert.equal(result.discount, 500, "折抵最多折到商品金額歸零");
  assert.equal(result.payable, 60, "折價券只折商品，運費還是要付");
  assert.equal(result.net, 60);
});

test("免運讓運費歸零，且可以跟折扣券一起用", async () => {
  const { app } = await loadPage();
  const { evaluate } = app.helpers;
  const scenario = ctx({ subtotal: 1000, shipping: 60 });

  const freeship = offer({ id: "s", stackGroup: "platform-shipping", benefit: { type: "freeship" } });
  const coupon = offer({ id: "c", stackGroup: "platform-coupon", benefit: { type: "fixed", value: 150 } });

  const both = evaluate([freeship, coupon], scenario);
  assert.equal(both.shipping, 0);
  assert.equal(both.payable, 850, "1000 - 150 + 0");
  assert.equal(both.net, 850, "沒有回饋型優惠時淨成本等於實付");
});

test("回饋是事後給的，不會減少當下實付", async () => {
  const { app } = await loadPage();
  const { evaluate } = app.helpers;
  const card = offer({
    id: "k", stackGroup: "card", requiresOwned: true,
    benefit: { type: "rebate", value: 5, cap: null }, rebateBase: null,
  });
  const result = evaluate([card], ctx({ subtotal: 1000, shipping: 0 }));

  assert.equal(result.payable, 1000, "刷卡當下還是付全額");
  assert.equal(result.rebate, 50);
  assert.equal(result.net, 950, "淨成本才把回饋扣掉");
});

// 畫面上明細與總計是同一組數字。各自捨入的話，17.5 與 52.5 會顯示成 18 + 53，
// 總計卻是 70——使用者只會覺得這頁在亂算。逐筆先進位再加總才對得起來。
test("明細加總等於總計，不會差一元", async () => {
  const { app } = await loadPage();
  const { evaluate, rebateOf } = app.helpers;
  const scenario = ctx({ subtotal: 500, shipping: 0, owned: { a: true, b: true } });

  const cards = [
    offer({ id: "a", stackGroup: "card", requiresOwned: true, rebateBase: null,
      benefit: { type: "rebate", value: 3.5, cap: null } }),
    offer({ id: "b", stackGroup: "pay", requiresOwned: true, rebateBase: null,
      benefit: { type: "rebate", value: 10.5, cap: null } }),
  ];

  const result = evaluate(cards, scenario);
  // 各項在畫面上顯示的是四捨五入後的值
  const shown = cards.map((card) => Math.round(rebateOf(card, scenario, result.payable)));
  assert.deepEqual(shown, [18, 53], "17.5 與 52.5 各自進位");
  assert.equal(result.rebate, 71, "總計必須等於明細之和，不是未捨入的 70");
  assert.equal(result.net, 429);
});

test("同組互斥、跨組可疊，且挑的是淨成本最低的組合", async () => {
  const { app } = await loadPage();
  const { bestCombo } = app.helpers;
  const scenario = ctx({ subtotal: 1000, shipping: 60, owned: { card: true } });

  const offers = [
    offer({ id: "small", stackGroup: "platform-coupon", benefit: { type: "fixed", value: 100 } }),
    offer({ id: "big", stackGroup: "platform-coupon", benefit: { type: "percent", value: 30, cap: null } }),
    offer({ id: "ship", stackGroup: "platform-shipping", benefit: { type: "freeship" } }),
    offer({
      id: "card", stackGroup: "card", requiresOwned: true,
      benefit: { type: "rebate", value: 5, cap: null }, rebateBase: null,
    }),
  ];

  const best = bestCombo(offers, scenario);
  const picked = plain(best.combo).map((o) => o.id).sort();
  assert.deepEqual(picked, ["big", "card", "ship"], "平台券只挑一張（較大的），運費與信用卡各自疊上");
  assert.ok(!picked.includes("small"), "同組的另一張不得同時被選");
  assert.equal(best.payable, 700, "1000 - 300 + 0");
  assert.equal(best.rebate, 35, "700 × 5%");
  assert.equal(best.net, 665);
});

// 同一組裡「哪張比較省」會隨金額翻轉：定額券在小額時贏，比例券在大額時贏。
// 這條擋的是「照面額大小排一次就好」這種看起來很合理的簡化。
test("同組內誰最省要看金額，不是看面額", async () => {
  const { app } = await loadPage();
  const { bestCombo } = app.helpers;
  const offers = [
    offer({ id: "flat", stackGroup: "platform-coupon", benefit: { type: "fixed", value: 200 } }),
    offer({ id: "pct", stackGroup: "platform-coupon", benefit: { type: "percent", value: 30, cap: null } }),
  ];

  const small = bestCombo(offers, ctx({ subtotal: 500, shipping: 0 }));
  assert.equal(small.combo[0].id, "flat", "500 元時：定額折 200 > 三成折 150");
  assert.equal(small.net, 300);

  const large = bestCombo(offers, ctx({ subtotal: 1000, shipping: 0 }));
  assert.equal(large.combo[0].id, "pct", "1000 元時：三成折 300 > 定額折 200");
  assert.equal(large.net, 700);

  // 沒有任何可用優惠時要回一個空組合，而不是炸掉
  const none = bestCombo([], ctx({ subtotal: 1000, shipping: 0 }));
  assert.deepEqual(plain(none.combo), []);
  assert.equal(none.net, 1000);
});

test("每組候選數有上限，一份大資料檔不會讓瀏覽器卡死", async () => {
  const { app } = await loadPage();
  const { candidatesByGroup, MAX_PER_GROUP } = app.helpers;
  const many = Array.from({ length: MAX_PER_GROUP + 20 }, (_, i) => offer({
    id: `c${i}`, stackGroup: "platform-coupon", benefit: { type: "fixed", value: i + 1 },
  }));

  const buckets = candidatesByGroup(many, ctx());
  const list = buckets.get("platform-coupon");
  assert.equal(list.length, MAX_PER_GROUP);
  // 截斷前要先排序，留下的必須是效益最高的那幾張——被丟掉的必然更差
  assert.equal(list[0].benefit.value, MAX_PER_GROUP + 20);
});

test("到期標示會算剩幾天，沒有截止日就說沒有", async () => {
  const { app } = await loadPage();
  const { expiryLabel, daysBetween } = app.helpers;

  assert.equal(daysBetween("2026-09-03", "2026-09-11"), 8);
  assert.match(expiryLabel({ validUntil: "2026-09-11" }, "2026-09-03"), /剩 8 天/);
  assert.match(expiryLabel({ validUntil: "2026-09-03" }, "2026-09-03"), /今天最後一天/);
  assert.equal(expiryLabel({ validUntil: null }, "2026-09-03"), "未公告截止日");
});

test("壞掉的存檔不會把試算帶進奇怪的狀態", async () => {
  const { app } = await loadPage();
  const { sanitizeState } = app.helpers;

  assert.equal(sanitizeState(null), null);
  assert.equal(sanitizeState("nope"), null);

  const cleaned = sanitizeState({
    platformId: 42, subtotal: -500, shipping: "abc", newUser: "yes",
    owned: { real: true, fake: "true", off: false },
  });
  assert.equal(cleaned.platformId, "", "非字串的平台 id 不採用");
  assert.equal(cleaned.subtotal, 0, "負數金額夾到 0");
  assert.equal(cleaned.shipping, 0, "非數字運費退回 0");
  assert.equal(cleaned.newUser, false, "只有布林 true 才算新戶");
  assert.deepEqual(plain(cleaned.owned), { real: true }, "只保留明確為 true 的勾選");
});

// 真實資料檔要能被這個計算模型吃下去。schema 測試管欄位、這條管「算得出東西」。
test("真實 coupons.json 餵進計算模型算得出結果", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { bestCombo, blockReason } = app.helpers;

  for (const platform of feed.platforms) {
    const scenario = ctx({ platformId: platform.id, subtotal: 1200, shipping: 60, today: feed.reviewedAt });
    const usable = feed.offers.filter((o) => !blockReason(o, scenario));
    const result = bestCombo(feed.offers, scenario);

    assert.ok(Number.isFinite(result.net), `${platform.id} 的淨成本不是數字`);
    assert.ok(result.net <= 1260, `${platform.id} 的淨成本不該高於原價`);
    assert.ok(result.payable >= 0, `${platform.id} 的實付不可為負`);
    // 沒勾選任何持有的卡／支付時，card 與 pay 組不該被選進來
    for (const picked of result.combo) {
      assert.ok(!picked.requiresOwned, `${platform.id} 選了沒勾選持有的 ${picked.id}`);
      assert.ok(usable.some((o) => o.id === picked.id), `${platform.id} 選了不該可用的 ${picked.id}`);
    }
  }
});

test("勾選持有的卡之後，回饋才會被算進去", async () => {
  const { app } = await loadPage();
  const feed = await loadFeed();
  const { bestCombo } = app.helpers;

  const cards = feed.offers.filter((o) => o.stackGroup === "card" || o.stackGroup === "pay");
  assert.ok(cards.length, "資料檔裡應該要有信用卡或支付加碼，否則這個試算沒東西可疊");

  for (const card of cards) {
    const targets = card.appliesTo === "*" || card.appliesTo == null
      ? feed.platforms.map((p) => p.id)
      : (Array.isArray(card.appliesTo) ? card.appliesTo : [card.appliesTo]);
    const scenario = ctx({
      platformId: targets[0], subtotal: 2000, shipping: 0,
      owned: { [card.id]: true }, today: feed.reviewedAt,
    });
    const result = bestCombo(feed.offers, scenario);
    assert.ok(result.rebate > 0, `勾了 ${card.id} 之後應該要算得出回饋`);
  }
});
