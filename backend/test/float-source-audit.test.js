import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChecklist,
  claimNeedles,
  classifyStatus,
  formatReport,
  matchClaims,
  resolveMode,
  stripHtml,
} from "../../scripts/float-source-audit.mjs";

// 這支測試刻意不碰網路。scripts/float-source-audit.mjs 本身是人工工具、不進 CI，
// 但它的純函式在這裡被蓋著——工具不進閘門，不代表它的邏輯可以沒有迴歸保護。
// （所以那支工具必須有 isMain guard，否則這行 import 就會真的去打十四個外站。）

async function loadFeed() {
  const path = fileURLToPath(new URL("../../data/floats.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

test("旗標解析", () => {
  assert.deepEqual(resolveMode([]), { fetch: false, only: null });
  assert.deepEqual(resolveMode(["node", "x.mjs"]), { fetch: false, only: null });
  assert.deepEqual(resolveMode(["--fetch"]), { fetch: true, only: null });
  assert.deepEqual(resolveMode(["--only", "tw-neio"]), { fetch: false, only: "tw-neio" });
  assert.deepEqual(resolveMode(["--fetch", "--only", "jp-yamawa"]), { fetch: true, only: "jp-yamawa" });
  // --only 放在最後而沒帶值時不可以炸掉，也不可以把 undefined 當成一個來源 id。
  assert.deepEqual(resolveMode(["--only"]), { fetch: false, only: null });
});

test("狀態分類：只有連結真的沒了才算失敗", () => {
  assert.equal(classifyStatus(200), "ok");
  assert.equal(classifyStatus(204), "ok");
  assert.equal(classifyStatus(404), "dead");
  assert.equal(classifyStatus(410), "dead");
  // 部落格擋機器人是常態，人開得起來，那不是資料的問題。
  assert.equal(classifyStatus(403), "blocked");
  assert.equal(classifyStatus(429), "blocked");
  assert.equal(classifyStatus(503), "unreachable");
  assert.equal(classifyStatus(0, new Error("fetch failed")), "unreachable");
});

test("要找的數字寫法：補零收、四捨五入不收、裸整數不收", () => {
  assert.deepEqual(claimNeedles(0.2), ["0.2", "0.20"]);
  assert.deepEqual(claimNeedles(0.07), ["0.07"]);
  // 1.125 的 toFixed(2) 是 1.13，那是頁面上不會出現的數字，收了就是假陽性。
  assert.deepEqual(claimNeedles(1.125), ["1.125"]);
  // 裸整數在任何頁面上都會命中，不可以拿來當證據。
  assert.deepEqual(claimNeedles(3), ["3.0", "3.00"]);
  assert.ok(!claimNeedles(15).includes("15"));
  assert.deepEqual(claimNeedles(Number.NaN), []);
});

test("比對前先去標籤：屬性裡的數字不算命中", () => {
  const html = '<div class="w-0.55" data-g="0.55"><p>B 的重量是 0.75 公克</p></div>';
  const text = stripHtml(html);
  assert.ok(!text.includes("0.55"), "屬性值不該留在純文字裡");
  assert.ok(text.includes("0.75"));

  const [inAttr, inBody] = matchClaims(html, [
    { path: "a", kind: "number", value: 0.55 },
    { path: "b", kind: "number", value: 0.75 },
  ]);
  assert.equal(inAttr.hit, false);
  assert.equal(inBody.hit, true);
});

test("script / style 的內容不算內文", () => {
  const html = "<script>var g=0.31;</script><style>.x{width:0.31px}</style><p>沒有數字</p>";
  assert.equal(matchClaims(html, [{ path: "a", kind: "number", value: 0.31 }])[0].hit, false);
});

test("文字主張不做比對，標成需人工判讀", () => {
  const claims = [{ path: "makerVariance", kind: "text", value: "各廠重量不同" }];
  assert.equal(matchClaims("<p>任何東西</p>", claims)[0].hit, null);
});

test("每個宣告的來源都要撐著至少一項，否則是掛著沒用的來源", async () => {
  const feed = await loadFeed();
  const rows = buildChecklist(feed);

  assert.equal(rows.length, feed.sources.length, "清單要涵蓋每一個來源");
  assert.deepEqual(rows.map((r) => r.id), feed.sources.map((s) => s.id), "順序跟著資料檔");
  for (const row of rows) {
    assert.ok(row.claims.length > 0, `${row.id} 沒有撐著任何一項——要嘛補引用，要嘛從 sources 移除`);
  }
});

test("清單抓得到的宣稱涵蓋四個來源欄位", async () => {
  const feed = await loadFeed();
  const rows = buildChecklist(feed);
  const paths = rows.flatMap((row) => row.claims.map((claim) => claim.path));

  assert.ok(paths.some((p) => p === "shots/3B.grams"), "咬鉛的重量要被列進去");
  assert.ok(paths.some((p) => p === "floats/3B.loadGrams"), "浮標的負荷要被列進去");
  assert.ok(paths.some((p) => p.endsWith(".variants")), "分歧值也要被列進去——那正是最該人工看的");
  assert.ok(paths.includes("residualBuoyancy.rangeGrams"));
  assert.ok(paths.includes("makerVariance"));
  // mainSinker 那段也要進清單，否則它引用的來源會變成「撐 0 項」的孤兒，
  // 而下一條測試正好會因此紅掉——但紅的原因會指向資料，不是指向這裡漏掃。
  assert.ok(paths.includes("mainSinker.thresholdGrams"));
  assert.ok(paths.includes("mainSinker.rule"));

  // 刻意未取值的 7B / 8B 不會產生數值宣稱，但要留一條文字提醒，不可以整列消失。
  const conflicting = rows.flatMap((row) => row.claims).filter((c) => c.path === "shots/7B.grams");
  assert.ok(conflicting.length, "7B 雖然沒取值，仍要提醒人去確認那個來源給的是什麼");
  assert.ok(conflicting.every((c) => c.kind === "text"));
});

test("孤兒來源會在報告裡被指名", () => {
  const feed = {
    reviewedAt: "2026-09-07",
    sources: [{ id: "orphan", title: "沒人用的來源", url: "https://example.com/", kind: "blog", seenVia: "search-summary" }],
    shots: [], floats: [], makerVariance: [],
  };
  const report = formatReport(buildChecklist(feed), feed, { fetch: false });
  assert.match(report, /支撐 0 項/);
});

// 表頭原本是用「總數減 opened」推出 search-summary 的筆數。seenVia 加了第三個值
// （user-supplied）之後那種推法就開始說謊，而且報告看起來完全正常。
test("表頭的 seenVia 統計要逐值計數，不可以用減法推", () => {
  const source = (id, seenVia) => ({ id, title: id, url: `https://example.com/${id}`, kind: "blog", seenVia });
  const feed = {
    reviewedAt: "2026-09-08",
    sources: [source("a", "opened"), source("b", "search-summary"), source("c", "user-supplied"), source("d", "user-supplied")],
    shots: [{ label: "X", grams: 1, sourceIds: ["a", "b", "c", "d"], variants: [] }],
    floats: [], makerVariance: [],
  };
  const report = formatReport(buildChecklist(feed), feed, { fetch: false });
  assert.match(report, /來源 4 筆：/);
  assert.match(report, /user-supplied 2/);
  assert.match(report, /search-summary 1/);
  assert.match(report, /opened 1/);
  // 舊寫法會印成 search-summary 3。
  assert.doesNotMatch(report, /search-summary 3/);
});

// 現場經驗沒有網址。報告印一行空白會讓人以為連結掉了，所以要明講「沒有頁面可核對」。
test("無網址的來源要在報告裡被標出來", async () => {
  const feed = {
    reviewedAt: "2026-09-08",
    sources: [{ id: "field-x", title: "現場經驗", url: null, kind: "field-knowledge", seenVia: "user-supplied" }],
    shots: [{ label: "X", grams: 1, sourceIds: ["field-x"], variants: [] }],
    floats: [], makerVariance: [],
  };
  const report = formatReport(buildChecklist(feed), feed, { fetch: false });
  assert.match(report, /無網址/);
  assert.doesNotMatch(report, /^\s*null\s*$/m, "不可以把 null 直接印出來");
});

test("報告一定要講清楚命中率不是正確率，而且工具不寫檔", async () => {
  const feed = await loadFeed();
  const report = formatReport(buildChecklist(feed), feed, { fetch: false });
  assert.match(report, /命中不等於正確/);
  assert.match(report, /未命中不等於錯/);
  assert.match(report, /不寫任何檔案/);
  // seenVia 的判準必須印在報告上——這是整份資料誠實性的定義。
  assert.match(report, /HTTP 200 不算/);
});
