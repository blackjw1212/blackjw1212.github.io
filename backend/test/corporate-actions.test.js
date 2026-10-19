import test from "node:test";
import assert from "node:assert/strict";
import {
  rocDateToIso,
  parseTwseExRights,
  parseTwseResumption,
  parseTpexExRights,
  parseTpexReduction,
  parseDailyRows,
  neededDaily,
  applyCorporateActions,
} from "../../scripts/corporate-actions.mjs";
import { accumulate52w, derive52w } from "../../scripts/update-market-feed.mjs";

// 月桶的高低點是「成交價」，股數一變（配股、面額變更、減資），事件日之前的價格就跟
// 之後不在同一個基準上。實測 2026-10-19：緯穎 6669 於 9/2 除權（約買 1 張配近 2 張），
// 月桶仍保留除權前的 7,800，畫面上「距一年高 −75.8%」；還原後應約 −34%。
// 下面的 fixture 全部取自 2026-10-19 實抓的回應形狀。

const TWSE_EX_FIELDS = ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價", "權值+息值", "權/息", "漲停價格", "跌停價格", "開盤競價基準", "減除股利參考價", "詳細資料", "最近一次申報資料 季別/日期", "最近一次申報每股 (單位)淨值", "最近一次申報每股 (單位)盈餘"];
const twseExPayload = {
  stat: "OK",
  fields: TWSE_EX_FIELDS,
  data: [
    ["115年09月01日", "00939", "統一台灣高息動能", "23.17", "23.04", "0.125000", "息", "25.34", "20.74", "23.04", "23.04", "00939,20260901", "", "24.99", "N/A"],
    ["115年09月01日", "2889", "國票金", "15.95", "15.31", "0.636293", "權息", "16.80", "13.80", "15.30", "15.31", "2889,20260901", "", "13.11", "0.77"],
    ["115年09月02日", "6669", "緯穎", "7,800.00", "2,614.99", "5,185.002642", "權", "2,875.00", "2,355.00", "2,615.00", "2,614.99", "6669,20260902", "", "734.59", "156.38"],
  ],
};

const RESUME_FIELDS = ["恢復買賣日期", "股票代號", "名稱", "停止買賣前收盤價格", "恢復買賣參考價", "漲停價格", "跌停價格", "開盤競價基準", "詳細資料"];
const twseParPayload = { stat: "OK", fields: RESUME_FIELDS, data: [["115/01/19", "7780", "大研生醫", "185.00", "18.50", "20.35", "16.65", "18.50", "7780,20260109,20260119"]] };
const twseReductionPayload = {
  stat: "OK",
  fields: ["恢復買賣日期", "股票代號", "名稱", "停止買賣前收盤價格", "恢復買賣參考價", "漲停價格", "跌停價格", "開盤競價基準", "除權參考價", "減資原因", "詳細資料"],
  data: [["114/10/07", "2352", "佳世達", "30.15", "34.57", "38.00", "31.15", "34.55", "--", "退還股款", ""]],
};

const TPEX_EX_FIELDS = ["除權息日期", "代號", "名稱", "除權息前收盤價", "除權息參考價", "權值", "息值", "權值+息值", "權/息", "漲停價", "跌停價", "開始交易基準價", "減除股利參考價", "現金股利", "每仟股無償配股", "現金增資股數", "現金增資認購價", "公開承銷股數", "員工認購股數", "原股東認購股數", "按持股比例仟股認購"];
const tpexExPayload = {
  tables: [{
    fields: TPEX_EX_FIELDS,
    data: [
      ["114/10/03", "4123", "晟德              ", "38.50", "35.92", "1.820826", "0.760393", "2.581219", "除權息", "39.50", "32.35", "35.90", "35.92", "0.76039306", "50.69287189", "0", "0.00", "0", "0", "0", "0.00000000"],
      ["114/10/14", "6590", "普鴻              ", "83.80", "72.87", "10.931310", "0.000000", "10.931310", "除權", "80.10", "65.60", "72.90", "72.87", "0.00000000", "150.01380768", "0", "0.00", "0", "0", "0", "0.00000000"],
      ["115/09/01", "00966B", "統一ESG投等債15+", "13.54", "13.47", "0.000000", "0.068000", "0.068000", "除息", "9999.95", "0.01", "13.47", "13.47", "0.06800000", "0.00000000", "0", "0.00", "0", "0", "0", "0.00000000"],
      // 參考價對不起來（例：同時有現金增資）——不猜比例，整筆退回
      ["115/09/03", "9999", "對不起來", "100.00", "70.00", "0", "0", "30", "除權", "0", "0", "0", "70.00", "0.00000000", "100.00000000", "0", "0.00", "0", "0", "0", "0.00000000"],
    ],
  }],
};
const tpexReductionPayload = {
  tables: [{
    fields: ["恢復買賣日期", "股票代號", "名稱", "最後交易日之收盤價格", "減資恢復買賣開始日參考價格", "漲停價格", "跌停價格", "開始交易基準價", "除權參考價", "減資原因", "詳細資料"],
    data: [["1150630", "3152", "璟德", "208.00", "360.24", "396.00", "324.50", "360.00", "0.00", "現金減資", ""]],
  }],
};

const twseDaily6669 = {
  stat: "OK",
  fields: ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數", "註記"],
  data: [
    ["115/09/01", "2,855,090", "21,640,964,250", "7,115.00", "7,800.00", "7,050.00", "7,800.00", "+705.00", "25,414", ""],
    ["115/09/02", "10,869,612", "29,110,975,090", "2,790.00", "2,875.00", "2,585.00", "2,610.00", "X0.00", "95,427", ""],
    ["115/09/03", "5,153,604", "13,216,685,380", "2,605.00", "2,630.00", "2,475.00", "2,475.00", "-135.00", "82,615", ""],
  ],
};
const tpexDaily3152 = {
  tables: [{
    fields: ["日 期", "成交張數", "成交仟元", "開盤", "最高", "最低", "收盤", "漲跌", "筆數"],
    data: [
      ["115/06/22", "1,334", "272,941", "202.00", "208.50", "200.00", "208.00", "4.00", "1,555"],
      ["115/06/30", "516", "167,852", "327.50", "332.50", "324.50", "324.50", "-35.50", "1,476"],
    ],
  }],
};

const F6669 = 2614.99 / 7800;
const r2 = (v) => Math.round(v * 100) / 100;

test("ROC dates in all four upstream spellings become ISO", () => {
  assert.equal(rocDateToIso("115年09月02日"), "2026-09-02");
  assert.equal(rocDateToIso("114/11/17"), "2025-11-17");
  assert.equal(rocDateToIso("1150630"), "2026-06-30");
  assert.equal(rocDateToIso(" 115/9/1 "), "2026-09-01");
  assert.equal(rocDateToIso("not a date"), null);
});

test("TWSE ex-rights: share events only, factor = reference ÷ previous close", () => {
  const events = parseTwseExRights(twseExPayload);
  assert.deepEqual(events.map((e) => e.code), ["2889", "6669"], "純除息（現金股利）不還原");
  const wiwynn = events.find((e) => e.code === "6669");
  assert.equal(wiwynn.date, "2026-09-02");
  assert.equal(wiwynn.kind, "stock");
  assert.ok(Math.abs(wiwynn.factor - F6669) < 1e-9);
  // 權息同日：證交所只給合計，整筆照參考價還原（使用者 2026-10-19 決定，揭露句寫明）
  assert.ok(Math.abs(events.find((e) => e.code === "2889").factor - 15.31 / 15.95) < 1e-9);
});

test("a busy or failed TWSE response throws instead of returning no events", () => {
  assert.throws(() => parseTwseExRights({ stat: "系統忙碌中，請稍後再試！" }), /系統忙碌/);
});

// 回補預演實測：那個月沒有減資時證交所回這句，不是失敗
test("a TWSE 'no matching data' reply means no events, not an error", () => {
  assert.deepEqual(parseTwseResumption({ stat: "很抱歉，沒有符合條件的資料!" }, "reduction"), []);
});

test("TWSE par-value changes and capital reductions use the resumption reference price", () => {
  const [par] = parseTwseResumption(twseParPayload, "par");
  assert.deepEqual({ code: par.code, date: par.date, kind: par.kind }, { code: "7780", date: "2026-01-19", kind: "par" });
  assert.ok(Math.abs(par.factor - 0.1) < 1e-9);
  const [cut] = parseTwseResumption(twseReductionPayload, "reduction");
  assert.equal(cut.date, "2025-10-07");
  assert.ok(cut.factor > 1, "減資後股價變高，比例大於 1");
  assert.ok(Math.abs(cut.factor - 34.57 / 30.15) < 1e-9);
});

test("TPEX ex-rights: stock part only, gated by the definitional reference-price identity", () => {
  const { events, rejected } = parseTpexExRights(tpexExPayload);
  assert.deepEqual(events.map((e) => e.code), ["4123", "6590"], "除息列不還原、對不起來的列退回");
  // 上櫃有拆開的現金股利與每仟股配股：參考價 ＝ (前收 − 現金) ÷ (1 + 配股率)，比例只取配股那段
  assert.ok(Math.abs(events[0].factor - 1 / 1.05069287189) < 1e-9);
  assert.deepEqual(rejected.map((r) => r.code), ["9999"]);
});

test("TPEX capital reductions parse the compact ROC date", () => {
  const [event] = parseTpexReduction(tpexReductionPayload);
  assert.deepEqual({ code: event.code, date: event.date, kind: event.kind }, { code: "3152", date: "2026-06-30", kind: "reduction" });
  assert.ok(Math.abs(event.factor - 360.24 / 208) < 1e-9);
});

test("daily rows parse from both markets, by field name not position", () => {
  assert.deepEqual(parseDailyRows(twseDaily6669)[0], { date: "2026-09-01", high: 7800, low: 7050 });
  assert.deepEqual(parseDailyRows(tpexDaily3152).map((r) => r.date), ["2026-06-22", "2026-06-30"]);
  assert.equal(parseDailyRows({ stat: "很抱歉，沒有符合條件的資料!" }).length, 0);
});

function wiwynnArchive(extra = {}) {
  return {
    start: "2025-07-01",
    seededThrough: "2026-07-27",
    stocks: { "6669": { m: { "2026-08": [7360, 5475], "2026-09": [7800, 2075] }, lastSeen: "2026-10-19", seeded: true, ...extra } },
  };
}
const wiwynnEvent = { code: "6669", date: "2026-09-02", kind: "stock", factor: F6669, source: "TWT49U" };
const wiwynnDaily = { "6669@2026-09": parseDailyRows(twseDaily6669) };

test("the event month is rebuilt day by day and earlier months are scaled", () => {
  const { accumulator, applied, pending } = applyCorporateActions(wiwynnArchive(), [wiwynnEvent], wiwynnDaily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(applied, ["6669@2026-09-02"]);
  assert.deepEqual(pending, []);
  const m = accumulator.stocks["6669"].m;
  assert.deepEqual(m["2026-08"], [r2(7360 * F6669), r2(5475 * F6669)], "事件月之前整桶乘比例");
  // 9/1（除權前）乘比例，9/2 起照原價：高點是 9/2 的 2,875，不是 7,800
  assert.deepEqual(m["2026-09"], [2875, r2(7050 * F6669)]);
  const w = derive52w(accumulator.stocks["6669"]);
  assert.equal(w.hi52, 2875);
  assert.ok((1885 - w.hi52) / w.hi52 > -0.4, "距一年高不再是 −75%");
  assert.ok(accumulator.adjusted["6669@2026-09-02"], "套用過要記下來");
});

test("applying the same event again is a no-op", () => {
  const once = applyCorporateActions(wiwynnArchive(), [wiwynnEvent], wiwynnDaily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  const snapshot = JSON.stringify(once.accumulator.stocks);
  const twice = applyCorporateActions(once.accumulator, [wiwynnEvent], wiwynnDaily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(twice.applied, []);
  assert.equal(JSON.stringify(twice.accumulator.stocks), snapshot, "第二次不可以再乘一次");
});

test("without the event month's daily rows nothing is touched and the event waits", () => {
  const before = JSON.stringify(wiwynnArchive().stocks);
  const { accumulator, applied, pending } = applyCorporateActions(wiwynnArchive(), [wiwynnEvent], {}, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(applied, []);
  assert.deepEqual(pending, ["6669@2026-09-02"]);
  assert.equal(JSON.stringify(accumulator.stocks), before, "只還原一半比不還原更糟");
  // 市場由事件來源決定（TWT49U＝上市），不看 feed：實測 8908 在 feed 標成上市、日資料卻只在櫃買
  assert.deepEqual(neededDaily(wiwynnArchive(), [wiwynnEvent], { floorMonth: "2025-10", tradeDate: "2026-10-19" }), [{ code: "6669", month: "2026-09", market: "twse" }]);
  assert.equal(neededDaily(wiwynnArchive(), [{ ...wiwynnEvent, source: "revivt" }], { floorMonth: "2025-10", tradeDate: "2026-10-19" })[0].market, "tpex");
});

// 回填（seed-market-52w.mjs，2026-07-27）用的是 Yahoo 日線，它已經依股數調整過：
// 實測 6944 兆聯 6 月原始高點 1,115、存檔 857.69（×0.769）。回填前的事件
// 只重算事件當月（那一桶回填時就可能有瑕疵：7780 1 月存檔是 192／18.15），更早的月份不可再乘。
test("an event the Yahoo seed already absorbed only rebuilds its own month", () => {
  const archive = {
    start: "2025-07-01",
    seededThrough: "2026-07-27",
    stocks: { "7780": { m: { "2025-12": [19.3, 16], "2026-01": [192, 18.15] }, lastSeen: "2026-10-19", seeded: true } },
  };
  const event = { code: "7780", date: "2026-01-19", kind: "par", factor: 0.1, source: "TWTB8U" };
  const daily = { "7780@2026-01": [{ date: "2026-01-02", high: 192, low: 180 }, { date: "2026-01-19", high: 20.35, low: 18.15 }] };
  const { accumulator } = applyCorporateActions(archive, [event], daily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(accumulator.stocks["7780"].m["2025-12"], [19.3, 16], "回填已經調整過的月份不動");
  assert.deepEqual(accumulator.stocks["7780"].m["2026-01"], [20.35, 18]);
});

test("an event recorded before it happens is ignored until its date", () => {
  const future = { ...wiwynnEvent, date: "2026-10-25" };
  const { applied, pending } = applyCorporateActions(wiwynnArchive(), [future], {}, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(applied, []);
  assert.deepEqual(pending, [], "還沒發生不是「待補」");
});

test("events applied across runs in either order land on the same buckets", () => {
  const archive = () => ({
    start: "2025-07-01",
    seededThrough: "2026-07-27",
    stocks: { "1234": { m: { "2026-08": [100, 90], "2026-09": [100, 45], "2026-10": [60, 25] }, lastSeen: "2026-10-19", seeded: true } },
  });
  const a = { code: "1234", date: "2026-09-10", kind: "stock", factor: 0.5, source: "TWT49U" };
  const b = { code: "1234", date: "2026-10-08", kind: "stock", factor: 0.5, source: "TWT49U" };
  const daily = {
    "1234@2026-09": [{ date: "2026-09-01", high: 100, low: 95 }, { date: "2026-09-10", high: 50, low: 45 }],
    "1234@2026-10": [{ date: "2026-10-01", high: 60, low: 50 }, { date: "2026-10-08", high: 30, low: 25 }],
  };
  const opts = { floorMonth: "2025-10", tradeDate: "2026-10-19" };
  const together = applyCorporateActions(archive(), [a, b], daily, opts).accumulator.stocks["1234"].m;
  // 第一班只拿得到 10 月的日資料，b 先套；第二班才補上 a
  const first = applyCorporateActions(archive(), [a, b], { "1234@2026-10": daily["1234@2026-10"] }, opts).accumulator;
  const later = applyCorporateActions(first, [a, b], daily, opts).accumulator.stocks["1234"].m;
  assert.deepEqual(later, together);
  assert.deepEqual(together["2026-08"], [25, 22.5], "兩次各 ×0.5");
  assert.deepEqual(together["2026-09"], [25, 22.5]);
  assert.deepEqual(together["2026-10"], [30, 25]);
});

test("a code missing from the archive is marked done without error", () => {
  const { applied, pending } = applyCorporateActions(wiwynnArchive(), [{ ...wiwynnEvent, code: "0000" }], {}, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  assert.deepEqual(applied, ["0000@2026-09-02"]);
  assert.deepEqual(pending, []);
});

test("a factor that is not a real share change is never applied", () => {
  for (const factor of [1, 1.0004, NaN, 0, -0.5, 500]) {
    const { applied, accumulator } = applyCorporateActions(wiwynnArchive(), [{ ...wiwynnEvent, factor }], wiwynnDaily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
    assert.deepEqual(applied, [], `factor ${factor} 不該被套用`);
    assert.deepEqual(accumulator.stocks["6669"].m["2026-08"], [7360, 5475]);
  }
});

test("the adjustment log survives daily accumulation and is pruned with the window", () => {
  const { accumulator } = applyCorporateActions(wiwynnArchive(), [wiwynnEvent], wiwynnDaily, { floorMonth: "2025-10", tradeDate: "2026-10-19" });
  accumulator.adjusted["0001@2025-01-05"] = { f: 0.5, k: "stock" };
  const next = accumulate52w(accumulator, [{ code: "6669", high: 1900, low: 1850, date: "2026-10-20" }], "2026-10-20");
  assert.ok(next.adjusted["6669@2026-09-02"], "累積當天行情不可以把套用紀錄弄丟——弄丟了下一班會再乘一次");
  assert.equal(next.adjusted["0001@2025-01-05"], undefined, "窗口外的紀錄跟著剪");
  assert.equal(next.seededThrough, "2026-07-27");
});
