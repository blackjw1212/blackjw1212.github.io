import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// data/coupons.json 是這個 repo 裡**唯一一份人工維護的 feed**——其他 data/*.json 都由
// Actions 寫入，壞掉時 schema 測試擋得住上游的變化；這一份壞掉的原因會是人手滑。
// 所以這裡的重點不是「欄位型別對不對」，而是「有沒有人在沒有出處的情況下填了一個數字」。
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STACK_GROUPS = new Set(["platform-coupon", "platform-shipping", "card", "pay"]);
const BENEFIT_TYPES = new Set(["percent", "fixed", "freeship", "rebate"]);
// 折抵型只能掛在平台組、回饋型只能掛在卡／支付組。混掛會讓試算把「事後回饋」
// 當成「當下少付」算進實付金額，畫面上看不出來，但數字是錯的。
const DISCOUNT_TYPES = new Set(["percent", "fixed", "freeship"]);

async function loadFeed() {
  const path = fileURLToPath(new URL("../../data/coupons.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadPage() {
  const path = fileURLToPath(new URL("../../coupon/index.html", import.meta.url));
  return readFile(path, "utf8");
}

test("coupon feed declares when a human last checked it", async () => {
  const feed = await loadFeed();
  assert.match(feed.reviewedAt || "", DATE, "reviewedAt 是這份資料唯一的鮮度宣告，不可缺");
  assert.ok(Array.isArray(feed.platforms) && feed.platforms.length, "platforms 不可為空");
  assert.ok(Array.isArray(feed.offers), "offers 必須是陣列");
  // 核對日不可以是未來——填成未來會讓頁面永遠顯示「今天核對過」。
  // 寬容一天：資料是台灣時間（UTC+8）核對的，CI 跑在 UTC，台灣的今天在 UTC 眼中
  // 有八小時是「明天」。抓的是填錯年月或手滑填成下個月，不是時區差。
  const limit = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.ok(feed.reviewedAt <= limit,
    `reviewedAt ${feed.reviewedAt} 是未來的日期（UTC 今天 +1 天為 ${limit}）`);
});

test("every platform has a unique id and a real homepage", async () => {
  const feed = await loadFeed();
  const seen = new Set();
  for (const platform of feed.platforms) {
    assert.match(platform.id || "", /^[a-z0-9-]+$/, `平台 id 格式異常: ${platform.id}`);
    assert.ok(!seen.has(platform.id), `平台 id 重複: ${platform.id}`);
    seen.add(platform.id);
    assert.ok(platform.name, `${platform.id} 缺 name`);
    assert.ok(platform.category, `${platform.id} 缺 category`);
    assert.match(platform.url || "", /^https:\/\//, `${platform.id} 的 url 必須是 https`);
    if (platform.shippingDefault != null) {
      assert.ok(Number.isFinite(platform.shippingDefault) && platform.shippingDefault >= 0,
        `${platform.id} 的 shippingDefault 異常`);
    }
  }
});

// 這是整份測試的核心：沒有出處的優惠不准進資料檔。
// 「看起來很合理的優惠碼」是這個專案最可能產生的假資料——它不會讓任何程式壞掉，
// 只會讓使用者到櫃檯前才發現碼是假的。
test("every offer cites a source and the date it was verified", async () => {
  const feed = await loadFeed();
  assert.ok(feed.offers.length, "offers 是空的——沒有資料就沒有這一頁存在的理由");
  for (const offer of feed.offers) {
    const at = `offer ${offer.id}`;
    assert.match(offer.sourceUrl || "", /^https:\/\//, `${at} 缺 sourceUrl 或不是 https`);
    assert.match(offer.verifiedAt || "", DATE, `${at} 缺 verifiedAt`);
    assert.ok(offer.title, `${at} 缺 title`);
  }
});

// 頁面明寫「不從任何平台取得推廣報酬」。這條把那句話變成機器判準——
// 只要有人把來源連結換成分潤連結，測試就會紅。
test("source links carry no affiliate tracking", async () => {
  const feed = await loadFeed();
  const tracking = /[?&](utm_[a-z]+|aff(?:iliate)?_?id|ref|tag|partner|clickid)=/i;
  for (const offer of feed.offers) {
    assert.doesNotMatch(offer.sourceUrl, tracking,
      `offer ${offer.id} 的 sourceUrl 夾帶了追蹤參數: ${offer.sourceUrl}`);
  }
  for (const platform of feed.platforms) {
    assert.doesNotMatch(platform.url, tracking,
      `平台 ${platform.id} 的 url 夾帶了追蹤參數`);
  }
});

test("offer ids are unique and point at platforms that exist", async () => {
  const feed = await loadFeed();
  const platformIds = new Set(feed.platforms.map((p) => p.id));
  const seen = new Set();
  for (const offer of feed.offers) {
    assert.match(offer.id || "", /^[a-z0-9-]+$/, `offer id 格式異常: ${offer.id}`);
    assert.ok(!seen.has(offer.id), `offer id 重複: ${offer.id}`);
    seen.add(offer.id);
    const scope = offer.appliesTo;
    if (scope === "*" || scope == null) continue;
    const targets = Array.isArray(scope) ? scope : [scope];
    for (const target of targets) {
      if (target === "*") continue;
      assert.ok(platformIds.has(target),
        `offer ${offer.id} 指向不存在的平台 ${target}`);
    }
  }
});

test("benefit shape matches the stack group it sits in", async () => {
  const feed = await loadFeed();
  for (const offer of feed.offers) {
    const at = `offer ${offer.id}`;
    assert.ok(STACK_GROUPS.has(offer.stackGroup), `${at} 的 stackGroup 不合法: ${offer.stackGroup}`);
    const benefit = offer.benefit || {};
    assert.ok(BENEFIT_TYPES.has(benefit.type), `${at} 的 benefit.type 不合法: ${benefit.type}`);

    const isDiscount = DISCOUNT_TYPES.has(benefit.type);
    const isPlatformGroup = offer.stackGroup.startsWith("platform-");
    assert.equal(isDiscount, isPlatformGroup,
      `${at}: 折抵型優惠只能掛平台組、回饋型只能掛 card/pay 組（現為 ${benefit.type} / ${offer.stackGroup}）`);

    if (benefit.type === "freeship") {
      assert.equal(offer.stackGroup, "platform-shipping", `${at}: 免運要掛在 platform-shipping`);
    }
    if (benefit.type === "percent" || benefit.type === "rebate") {
      assert.ok(Number.isFinite(benefit.value) && benefit.value > 0 && benefit.value <= 100,
        `${at} 的百分比 ${benefit.value} 超出合理範圍`);
    }
    if (benefit.type === "fixed") {
      assert.ok(Number.isFinite(benefit.value) && benefit.value > 0, `${at} 的折抵金額異常`);
    }
    if (benefit.cap != null) {
      assert.ok(Number.isFinite(benefit.cap) && benefit.cap > 0, `${at} 的 cap 異常`);
      // 月上限與單筆上限在試算裡是兩件事：拿月額度當單筆上限，等於假設這個月
      // 一次都還沒刷過。沒有 capPeriod 就分不出來，畫面也講不出這個假設。
      assert.ok(benefit.capPeriod === "month" || benefit.capPeriod === "order",
        `${at} 有 cap 就必須註明 capPeriod（"month" 或 "order"）`);
    }
    if (offer.minSpend != null) {
      assert.ok(Number.isFinite(offer.minSpend) && offer.minSpend >= 0, `${at} 的 minSpend 異常`);
    }
  }
});

test("dates are well formed and validUntil never precedes validFrom", async () => {
  const feed = await loadFeed();
  for (const offer of feed.offers) {
    const at = `offer ${offer.id}`;
    if (offer.validFrom != null) assert.match(offer.validFrom, DATE, `${at} 的 validFrom 格式異常`);
    if (offer.validUntil != null) assert.match(offer.validUntil, DATE, `${at} 的 validUntil 格式異常`);
    if (offer.validFrom && offer.validUntil) {
      assert.ok(offer.validFrom <= offer.validUntil,
        `${at}: validUntil ${offer.validUntil} 早於 validFrom ${offer.validFrom}`);
    }
  }
});

// 回饋基準（折扣前／折扣後）各家條款寫法不同。查不到就填 null，頁面會以折後估算
// 並在畫面上標示「未查證」。填了值就代表有人真的去讀過條款——所以只准填這兩個字串。
test("rebateBase is either a verified basis or an explicit null", async () => {
  const feed = await loadFeed();
  for (const offer of feed.offers) {
    if ((offer.benefit || {}).type !== "rebate") continue;
    assert.ok(Object.prototype.hasOwnProperty.call(offer, "rebateBase"),
      `offer ${offer.id} 是回饋型，必須明寫 rebateBase（查不到就填 null）`);
    assert.ok(offer.rebateBase === null || offer.rebateBase === "subtotal" || offer.rebateBase === "payable",
      `offer ${offer.id} 的 rebateBase 只能是 null / "subtotal" / "payable"`);
  }
});

// 沒有上限的回饋在試算裡會被當成無上限計算，這個方向偏樂觀。所以「真的沒上限」
// 與「查不到上限」必須分得出來——後者要在畫面上標成未查證，不能默默當成前者。
test("a missing rebate cap says whether it was verified", async () => {
  const feed = await loadFeed();
  for (const offer of feed.offers) {
    const benefit = offer.benefit || {};
    if (benefit.type !== "rebate") continue;
    assert.equal(typeof benefit.capVerified, "boolean",
      `offer ${offer.id} 是回饋型，必須明寫 capVerified`);
    if (benefit.cap == null) {
      assert.equal(benefit.capVerified, false,
        `offer ${offer.id} 沒有 cap 卻標 capVerified=true——真的查證過無上限，請在 note 寫明並改用 cap 表達`);
    }
  }
});

// 信用卡與支付加碼要靠使用者勾選「我有這張」才會納入試算，
// 勾選清單顯示的是發卡機構，沒有 issuer 會變成一排認不出來的名字。
test("offers the user must own name their issuer", async () => {
  const feed = await loadFeed();
  for (const offer of feed.offers) {
    if (offer.stackGroup !== "card" && offer.stackGroup !== "pay") continue;
    assert.equal(offer.requiresOwned, true,
      `offer ${offer.id} 在 card/pay 組，必須 requiresOwned=true（否則會被當成人人都有）`);
    assert.ok(offer.issuer, `offer ${offer.id} 缺 issuer`);
  }
});

// 疊加規則是這份資料裡唯一被寫進計算模型的東西（同組互斥、跨組可疊）。
// 它比優惠本身活得久，但也因此更容易變成「沒人記得出處」的都市傳說。
test("每條疊加規則都指得出出處", async () => {
  const feed = await loadFeed();
  assert.ok(Array.isArray(feed.stackingRules), "stackingRules 必須是陣列");
  const platformIds = new Set(feed.platforms.map((p) => p.id));
  for (const rule of feed.stackingRules) {
    assert.ok(rule.rule && rule.rule.length > 10, "規則內容太短，說不清楚");
    assert.match(rule.sourceUrl || "", /^https:\/\//, `規則缺 sourceUrl: ${rule.rule}`);
    assert.match(rule.verifiedAt || "", DATE, `規則缺 verifiedAt: ${rule.rule}`);
    // platformId 為 null 代表跨平台通則，是刻意的；填了值就必須對得上。
    if (rule.platformId != null) {
      assert.ok(platformIds.has(rule.platformId),
        `規則指向不存在的平台 ${rule.platformId}`);
    }
  }
});

// 查不到什麼，跟查到了什麼一樣要留下記錄。空的 dataGaps 代表「這份資料完美無缺」，
// 以這個題目的性質來說，那必然是漏寫而不是事實。
test("資料缺口有被寫下來", async () => {
  const feed = await loadFeed();
  assert.ok(Array.isArray(feed.dataGaps) && feed.dataGaps.length,
    "dataGaps 不可為空——台灣沒有官方優惠券 API，一定有查不到的東西");
  for (const gap of feed.dataGaps) {
    assert.equal(typeof gap, "string");
    assert.ok(gap.length > 15, `缺口描述太短，看不出漏了什麼: ${gap}`);
  }
});

// 頁面的 GROUPS 常數與這份資料檔用到的 stackGroup 是同一組概念，寫在兩個檔案裡。
// 分叉的後果很安靜：資料檔多一個組別，頁面的 candidatesByGroup 會直接忽略那些 offer，
// 使用者看到的只是「這張券沒被採用」，沒有任何錯誤訊息。
test("the page's stack groups match the ones the data uses", async () => {
  const html = await loadPage();
  const declared = [...html.matchAll(/\{\s*id:\s*"([a-z-]+)",\s*label:/g)].map((m) => m[1]);
  assert.deepEqual(new Set(declared), STACK_GROUPS,
    "coupon/index.html 的 GROUPS 與測試裡的 STACK_GROUPS 不一致");

  const feed = await loadFeed();
  const used = new Set(feed.offers.map((offer) => offer.stackGroup));
  for (const group of used) {
    assert.ok(declared.includes(group), `資料用了頁面不認得的組別: ${group}`);
  }
});
