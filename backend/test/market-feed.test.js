import test from "node:test";
import assert from "node:assert/strict";
import {
  rocToIso,
  normalizeMarketRows,
  normalizeMarketValuation,
  preserveMarketRows,
  applyValuation,
  accumulate52w,
  derive52w,
  monthKey,
  retentionFloor,
  MIN_WINDOW_MONTHS,
  normalizeMiIndex,
  parseMiChange,
} from "../../scripts/update-market-feed.mjs";

// 取自 2026-07-29 真實回應。上市收盤原本吃 openapi 的 STOCK_DAY_ALL，該端點在
// 台灣 21:47（收盤後 8 小時）仍只有 07-28，使用者對帳時發現價差一天。
// MI_INDEX 同日就到位，這裡用真實列鎖住解析結果。
const MI_FIELDS = ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差", "最後揭示買價", "最後揭示買量", "最後揭示賣價", "最後揭示賣量", "本益比"];
const DOWN = "<p style= color:green>-</p>";
const UP = "<p style= color:red>+</p>";
const FLAT = "<p> </p>";
const EXDIV = "<p>X</p>";
const miPayload = (rows, overrides = {}) => ({
  stat: "OK",
  date: "20260729",
  tables: [
    { title: "115年07月29日 價格指數(臺灣證券交易所)", fields: ["指數", "收盤指數"], data: [["發行量加權股價指數", "30000"]] },
    { title: "115年07月29日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))", fields: MI_FIELDS, data: rows },
  ],
  ...overrides,
});

test("parseMiChange recovers the sign that MI_INDEX hides in HTML colour", () => {
  // 「漲跌價差」永遠是絕對值；只讀那一欄會讓當天 961 檔下跌股全部變成上漲
  assert.equal(parseMiChange(DOWN, "1.00"), -1);
  assert.equal(parseMiChange(UP, "0.19"), 0.19);
  assert.equal(parseMiChange(FLAT, "0.00"), 0);
  assert.equal(parseMiChange(DOWN, "180.00"), -180, "緯穎當日 -180");
  // 除權息當日與前一日不可比，記 null 而不是 0——0 會被畫成「平盤」
  assert.equal(parseMiChange(EXDIV, "0.00"), null);
  assert.equal(parseMiChange(DOWN, "--"), null);
  assert.equal(parseMiChange(null, null), null);
});

test("normalizeMiIndex parses the real payload shape and survives upstream reshuffles", () => {
  const rows = [
    ["2317", "鴻海", "84,937,463", "71,078", "20,205,542,596", "240.00", "246.50", "231.00", "237.00", DOWN, "1.00", "237.00", "187", "237.50", "839", "16.83"],
    ["6669", "緯穎", "2,854,613", "14,999", "14,856,018,475", "5,430.00", "5,475.00", "4,940.00", "5,135.00", DOWN, "180.00", "5,130.00", "1", "5,135.00", "2", "17.21"],
    ["0061", "元大寶滬深", "254,569", "1", "1", "24.5", "24.8", "24.4", "24.70", UP, "0.19", "", "", "", "", "0.00"],
    ["00625K", "富邦上證+R", "0", "0", "0", "--", "--", "--", "--", FLAT, "0.00", "", "", "", "", "0.00"],
  ];
  const { rows: out, date } = normalizeMiIndex(miPayload(rows));
  assert.equal(date, "2026-07-29");
  assert.equal(out.length, 3, "收盤 '--' 的無成交列必須丟掉，不能當成價格");

  const hon = out.find((r) => r.Code === "2317");
  // 千分位要 strip；帶號漲跌要還原
  assert.equal(hon.ClosingPrice, 237);
  assert.equal(hon.Change, -1);
  assert.equal(hon.TradeVolume, 84937463);
  assert.equal(hon.Date, "1150729", "日期在 payload 層，要轉回民國年塞進列裡供下游沿用");
  assert.equal(out.find((r) => r.Code === "6669").ClosingPrice, 5135);
  assert.equal(out.find((r) => r.Code === "0061").Change, 0.19);

  // 端到端：normalizeMarketRows 要能直接吃這批列（鍵名刻意與 STOCK_DAY_ALL 相同）
  const stocks = normalizeMarketRows(out, "twse");
  assert.equal(stocks.length, 2, "ETF 由個股清單排除");
  assert.deepEqual(stocks.find((s) => s.code === "2317"), {
    code: "2317", name: "鴻海", market: "twse", close: 237, change: -1,
    open: 240, high: 246.5, low: 231, volume: 84937463, date: "2026-07-29",
  });
});

test("normalizeMiIndex is anchored on labels, not positions", () => {
  const rows = [["2317", "鴻海", "1", "1", "1", "240.00", "246.50", "231.00", "237.00", DOWN, "1.00", "", "", "", "", "16.83"]];
  const baseline = normalizeMiIndex(miPayload(rows)).rows;

  // 表順序改變（上游多插一張表）仍要找得到
  const shuffled = miPayload(rows);
  shuffled.tables.unshift({ title: "新增的統計表", fields: ["a"], data: [["x"]] });
  assert.deepEqual(normalizeMiIndex(shuffled).rows, baseline, "表索引位移不得影響解析");

  // 欄位順序改變也要跟著走
  const swapped = miPayload([["鴻海", "2317", "237.00", DOWN, "1.00"]]);
  swapped.tables[1].fields = ["證券名稱", "證券代號", "收盤價", "漲跌(+/-)", "漲跌價差"];
  const out = normalizeMiIndex(swapped).rows;
  assert.equal(out[0].Code, "2317");
  assert.equal(out[0].ClosingPrice, 237);
  assert.equal(out[0].Change, -1);

  // 真的改版（找不到表或關鍵欄位）→ 回空讓呼叫端退回 STOCK_DAY_ALL，而不是解析出垃圾
  assert.deepEqual(normalizeMiIndex({ stat: "很抱歉，沒有符合條件的資料!" }), { rows: [], date: null });
  assert.deepEqual(normalizeMiIndex(miPayload([], { tables: [] })).rows, []);
  const noCode = miPayload(rows);
  noCode.tables[1].fields = MI_FIELDS.map((f) => (f === "證券代號" ? "代號" : f));
  assert.deepEqual(normalizeMiIndex(noCode).rows, [], "關鍵欄位改名要當成失敗，不可猜位置");
  assert.deepEqual(normalizeMiIndex(null), { rows: [], date: null });
});

test("rocToIso converts ROC calendar dates and rejects junk", () => {
  assert.equal(rocToIso("1150717"), "2026-07-17");
  assert.equal(rocToIso("991231"), "2010-12-31");
  assert.equal(rocToIso(""), null);
  assert.equal(rocToIso("2026-07-17"), null);
});

test("normalizeMarketRows handles TWSE and TPEX field shapes and filters non-stocks", () => {
  const twse = normalizeMarketRows([
    { Code: "2330", Name: "台積電", ClosingPrice: "2,350.00", Change: "-55.0000", OpeningPrice: "2355", HighestPrice: "2365", LowestPrice: "2345", TradeVolume: "24810509", Date: "1150727" },
    { Code: "0050", Name: "元大台灣50", ClosingPrice: "200", Change: "1" },      // ETF → 排除
    { Code: "031234", Name: "某權證", ClosingPrice: "5", Change: "0" },          // 權證 → 排除
    { Code: "9999", Name: "無收盤", ClosingPrice: "--", Change: "0" },           // 無收盤 → 排除
  ], "twse");
  assert.equal(twse.length, 1);
  assert.deepEqual(twse[0], {
    code: "2330", name: "台積電", market: "twse", close: 2350, change: -55,
    open: 2355, high: 2365, low: 2345, volume: 24810509, date: "2026-07-27",
  });

  const tpex = normalizeMarketRows([
    { SecuritiesCompanyCode: "3324", CompanyName: "雙鴻", Close: "930.00", Change: "-13.00", Open: "943", High: "943", Low: "890", TradingShares: "1831325", Date: "1150727" },
  ], "tpex");
  assert.equal(tpex[0].market, "tpex");
  assert.equal(tpex[0].close, 930);
  assert.equal(tpex[0].name, "雙鴻");
});

test("normalizeMarketValuation reads both source shapes and skips empty rows", () => {
  const { entries } = normalizeMarketValuation([
    { Code: "2330", PEratio: "31.59", DividendYield: "0.94", PBratio: "10.34" },
    { SecuritiesCompanyCode: "3324", PriceEarningRatio: "27.22", YieldRatio: "1.26", PriceBookRatio: "6.54" },
    { Code: "1234", PEratio: "--", DividendYield: "--", PBratio: "--" },
  ]);
  assert.deepEqual(entries["2330"], { pe: 31.59, dividendYield: 0.94, pbRatio: 10.34 });
  assert.deepEqual(entries["3324"], { pe: 27.22, dividendYield: 1.26, pbRatio: 6.54 });
  assert.equal(entries["1234"], undefined);
});

test("normalizeMarketValuation keeps a loss-making stock that still reports yield or PB", () => {
  const { entries } = normalizeMarketValuation([{ Code: "2337", PEratio: "--", DividendYield: "1.20", PBratio: "1.80" }]);
  assert.equal(entries["2337"].pe, undefined);
  assert.equal(entries["2337"].pbRatio, 1.8);
});

// 估值來源發佈得比收盤慢：實測 2026-08-05 台灣 23:54 那班抓到的估值仍是 08-04 的，
// 卻和 08-05 的收盤寫進同一列。PE/PB/殖利率的分母是股價，錯一天整排數字就失準
// （2330：PE 31.19 對應 2,320，32.33 才對應當日的 2,405，EPS 同為 74.38）。
// 資料日一定要跟著出來，feed 才說得出「這欄是哪一天的」。
test("normalizeMarketValuation reports the payload's own data date", () => {
  const twse = normalizeMarketValuation([
    { Date: "1150805", Code: "2330", PEratio: "32.33", DividendYield: "0.91", PBratio: "10.59" },
    { Date: "1150805", Code: "2317", PEratio: "17.76", DividendYield: "2.87", PBratio: "1.97" },
  ]);
  assert.equal(twse.date, "2026-08-05");

  const tpex = normalizeMarketValuation([
    { Date: "1150805", SecuritiesCompanyCode: "1240", PriceEarningRatio: "11.80", YieldRatio: "6.35", PriceBookRatio: "1.56" },
  ]);
  assert.equal(tpex.date, "2026-08-05");

  // 沒有 Date 欄位就回 null，不可猜成「今天」——猜錯就是謊報新鮮度
  assert.equal(normalizeMarketValuation([{ Code: "2330", PEratio: "31.59" }]).date, null);

  // 真的混到多個日期時取最舊的，與 tradeDate 同一套保守解讀
  const mixed = normalizeMarketValuation([
    { Date: "1150805", Code: "2330", PEratio: "32.33" },
    { Date: "1150804", Code: "2317", PEratio: "17.76" },
  ]);
  assert.equal(mixed.date, "2026-08-04");

  // 只有估值全空的列也要貢獻日期——否則整份都是虧損股時會取不到日期
  assert.equal(normalizeMarketValuation([{ Date: "1150805", Code: "1101", PEratio: "", DividendYield: "", PBratio: "" }]).date, "2026-08-05");
});

test("preserveMarketRows keeps previous rows when upstream collapses", () => {
  const previous = Array.from({ length: 1000 }, (_, i) => ({ code: String(1000 + i), close: 10 }));
  const collapsed = preserveMarketRows(previous, [{ code: "2330", close: 100 }]);
  assert.equal(collapsed.preserved, true);
  assert.equal(collapsed.rows.length, 1000);

  const healthy = Array.from({ length: 980 }, (_, i) => ({ code: String(1000 + i), close: 11 }));
  const ok = preserveMarketRows(previous, healthy);
  assert.equal(ok.preserved, false);
  assert.equal(ok.rows.length, 980);

  const cold = preserveMarketRows([], [{ code: "2330", close: 100 }]);
  assert.equal(cold.preserved, false, "cold start must not be treated as degradation");
});

test("applyValuation falls back per row so one failed source cannot blank a whole board", () => {
  // TWSE 估值成功、TPEX 估值失敗：上櫃股必須沿用前次值，不是靜默清空
  const stocks = [
    { code: "2330", close: 2350 },
    { code: "3324", close: 930 },
    { code: "9001", close: 50 },
  ];
  const result = applyValuation(
    stocks,
    { "2330": { pe: 31.59, dividendYield: 0.94, pbRatio: 10.34 } },
    { "3324": { pe: 27.22, dividendYield: 1.26, pbRatio: 6.54 } },
  );
  assert.equal(result.preserved, 1);
  assert.equal(stocks[0].pe, 31.59, "fresh value wins");
  assert.equal(stocks[1].pe, 27.22, "missing board falls back to previous");
  assert.equal(stocks[2].pe, undefined, "no data anywhere stays undefined");
});

test("applyValuation prefers fresh data over stale previous values", () => {
  const stocks = [{ code: "2330", close: 2350 }];
  const result = applyValuation(stocks, { "2330": { pe: 31.59 } }, { "2330": { pe: 99 } });
  assert.equal(stocks[0].pe, 31.59);
  assert.equal(result.preserved, 0);
});

test("accumulate52w buckets by row date, is idempotent, and prunes old months", () => {
  let acc = accumulate52w({}, [{ code: "2330", high: 100, low: 90, close: 95, date: "2026-07-27" }], "2026-07-27");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [100, 90]);

  // 同日重跑不放大區間
  acc = accumulate52w(acc, [{ code: "2330", high: 100, low: 90, close: 95, date: "2026-07-27" }], "2026-07-27");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [100, 90]);

  // 同月更高/更低取極值
  acc = accumulate52w(acc, [{ code: "2330", high: 120, low: 80, close: 110, date: "2026-07-28" }], "2026-07-28");
  assert.deepEqual(acc.stocks["2330"].m["2026-07"], [120, 80]);

  // TWSE 落後一日時仍歸到自己的月份
  acc = accumulate52w(acc, [{ code: "2330", high: 130, low: 125, close: 128, date: "2026-08-03" }], "2026-08-03");
  assert.deepEqual(acc.stocks["2330"].m["2026-08"], [130, 125]);

  // 超出保留界線的 bucket 被剪枝
  acc.stocks["2330"].m["2024-01"] = [999, 1];
  acc = accumulate52w(acc, [{ code: "2330", high: 130, low: 125, close: 128, date: "2026-08-04" }], "2026-08-04");
  assert.equal(acc.stocks["2330"].m["2024-01"], undefined);
  assert.equal(derive52w(acc.stocks["2330"]).hi52, 130, "pruned month must not leak into the one-year high");
});

// 界線本身是這個 feed 最容易錯、錯了又最看不出來的一個數字：多留一個整月，
// 畫面上的「距一年高」就會拿一年多以前的高點當分母。實測過的迴歸——
// 舊版回推 13 個月且保留該月，結果留下 14 個整桶。
test("the retained window is 12 whole months plus the current one, not 13", () => {
  assert.equal(retentionFloor("2026-09-15"), "2025-09");
  assert.equal(retentionFloor("2026-01-05"), "2025-01");
  assert.equal(retentionFloor("junk"), "");

  let acc = { start: "2025-01-01", stocks: {} };
  const months = [];
  for (let i = 0; i < 20; i += 1) {
    const d = new Date(Date.UTC(2025, 1 + i, 10));
    months.push(d.toISOString().slice(0, 10));
  }
  for (const day of months) {
    acc = accumulate52w(acc, [{ code: "2330", high: 100, low: 90, close: 95, date: day }], day);
  }
  const kept = Object.keys(acc.stocks["2330"].m).sort();
  assert.equal(kept.length, 13, `保留 12 個完整月 ＋ 當月 = 13，實得 ${kept.length}：${kept.join(",")}`);
  const last = months[months.length - 1];
  assert.equal(kept[0], retentionFloor(last), "最舊的桶必須剛好落在保留界線上");
});

// 剪枝原本寫在逐列迴圈裡，於是**當班沒抓到的個股永遠不會被剪**。
// 實測 2026-09-15 有 3 檔停牌股還揹著 15 個月的桶，只要在 60 天下市清除之前
// 復牌就會用那個窗口上畫面。
test("a code missing from this run is still pruned, not frozen with a stale window", () => {
  let acc = accumulate52w({}, [
    { code: "2330", high: 100, low: 90, close: 95, date: "2025-06-10" },
    { code: "9999", high: 500, low: 400, close: 450, date: "2025-06-10" },
  ], "2025-06-10");
  assert.deepEqual(acc.stocks["9999"].m["2025-06"], [500, 400]);

  // 9999 從此缺席，但還在 60 天內：2025-07 與 2025-08 各出現一次讓它活著
  for (const day of ["2025-07-10", "2025-08-08"]) {
    acc = accumulate52w(acc, [
      { code: "2330", high: 100, low: 90, close: 95, date: day },
      { code: "9999", high: 500, low: 400, close: 450, date: day },
    ], day);
  }
  // 之後只有 2330 有資料，一路推到 2026-08——9999 的 2025-06 桶已超界
  for (let i = 0; i < 12; i += 1) {
    const day = new Date(Date.UTC(2025, 8 + i, 8)).toISOString().slice(0, 10);
    acc = accumulate52w(acc, [{ code: "2330", high: 100, low: 90, close: 95, date: day }], day);
    if (acc.stocks["9999"]) acc.stocks["9999"].lastSeen = day; // 假裝它還有被看到，隔開 60 天那條規則
  }
  assert.ok(acc.stocks["9999"], "這條測的是剪枝，不是下市清除——9999 必須還在");
  assert.equal(acc.stocks["9999"].m["2025-06"], undefined, "缺席的個股一樣要被剪枝");
});

test("accumulate52w drops stocks unseen for 60 days (delisted)", () => {
  let acc = accumulate52w({}, [
    { code: "2330", high: 100, low: 90, close: 95, date: "2026-01-05" },
    { code: "9999", high: 10, low: 9, close: 9.5, date: "2026-01-05" },
  ], "2026-01-05");
  assert.ok(acc.stocks["9999"]);
  acc = accumulate52w(acc, [{ code: "2330", high: 105, low: 95, close: 100, date: "2026-05-05" }], "2026-05-05");
  assert.equal(acc.stocks["9999"], undefined, "delisted code should be pruned");
  assert.ok(acc.stocks["2330"]);
});

test("derive52w spans months, counts them, and returns null without data", () => {
  assert.equal(derive52w(null), null);
  assert.equal(derive52w({ m: {} }), null);
  assert.deepEqual(derive52w({ m: { "2026-06": [200, 150], "2026-07": [180, 120] } }),
    { hi52: 200, lo52: 120, months: 2 });
});

// 上市未滿一年的個股不得宣稱一年高低——ETF 那一側早就有同一條規則
// （deriveDividend 的 coverage 閘門）。實測 2026-09-15 有 43 檔不足 12 個月，
// 其中兩檔只有 1 個月，畫面照樣印著距高 −30%。
test("a stock listed under a year cannot claim a one-year high", () => {
  const thin = { m: {} };
  for (let i = 0; i < 3; i += 1) thin.m[`2026-0${i + 1}`] = [100 + i, 50 - i];
  const thinWindow = derive52w(thin);
  assert.equal(thinWindow.months, 3);
  assert.ok(thinWindow.months < MIN_WINDOW_MONTHS, "3 個月必須落在閘門之下");

  const full = { m: {} };
  for (let i = 0; i < MIN_WINDOW_MONTHS; i += 1) {
    full.m[`2026-${String(i + 1).padStart(2, "0")}`] = [100, 50];
  }
  assert.equal(derive52w(full).months, MIN_WINDOW_MONTHS);
  assert.ok(derive52w(full).months >= MIN_WINDOW_MONTHS, "剛好 12 個月就可以發布");
});

test("monthKey extracts YYYY-MM", () => {
  assert.equal(monthKey("2026-07-27"), "2026-07");
  assert.equal(monthKey(""), "");
});
