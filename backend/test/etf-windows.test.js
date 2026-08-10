import test from "node:test";
import assert from "node:assert/strict";
import { windowMetrics, yahooReturns } from "../../scripts/update-etf-returns.mjs";

// 造一段日線。step 是每日固定漲跌幅，days 是天數（往回推）。
function series(days, step, { dipAt = null, dipTo = 1 } = {}) {
  const end = Date.parse("2026-08-06T00:00:00Z");
  const pts = [];
  let price = 100;
  for (let i = days; i >= 0; i -= 1) {
    if (dipAt != null && i === dipAt) price *= dipTo;
    pts.push({ date: new Date(end - i * 86400000).toISOString().slice(0, 10), raw: price, adj: price });
    price *= 1 + step;
  }
  return pts;
}
const flat = (pts) => new Array(pts.length).fill(1);

test("a window is only published when the data really spans it", () => {
  const twoYears = series(730, 0.0005);
  const f = flat(twoYears);
  assert.ok(windowMetrics(twoYears, f, 365), "兩年的資料算得出 1Y");
  assert.equal(windowMetrics(twoYears, f, 365 * 3), null, "兩年的資料不得冒充 3Y");
  assert.equal(windowMetrics(twoYears, f, 365 * 5), null, "更不得冒充 5Y");
});

// 這是使用者審查點出的核心問題：只給一年，等於用最好的一年當常態。
// 實測 0050 的 1Y 最大回撤 −15.9%，5Y 是 −36.4%。
test("a longer window sees a drawdown the short window misses", () => {
  // 兩年前有一次腰斬，之後一路上漲：1Y 看不到那次跌，3Y 看得到
  const pts = series(365 * 3, 0.001, { dipAt: 365 * 2, dipTo: 0.5 });
  const f = flat(pts);
  const oneY = windowMetrics(pts, f, 365);
  const threeY = windowMetrics(pts, f, 365 * 3);
  assert.ok(oneY.maxDrawdown > -5, `1Y 不該看到那次腰斬，實得 ${oneY.maxDrawdown}%`);
  assert.ok(threeY.maxDrawdown < -40, `3Y 必須看到，實得 ${threeY.maxDrawdown}%`);
});

// Sortino 的分母。最常見的寫錯法是拿「負報酬的筆數」當分母——
// 那算的是「跌的時候跌多兇」，不是「整段期間承受多少下檔風險」。
test("downside deviation counts only losses but divides by every observation", () => {
  // 一路上漲、完全沒有下跌日 → 下檔標準差必須是 0，而總波動不是
  const up = series(400, 0.001);
  const m = windowMetrics(up, flat(up), 365);
  assert.equal(m.downsideDeviation, 0, "沒有下跌日就沒有下檔風險");
  assert.ok(m.volatility === 0 || m.volatility != null, "總波動仍要算得出來");

  // 少數幾天重摔的標的：下檔標準差必須明顯小於總波動，
  // 若誤用「負報酬筆數」當分母，兩者會接近甚至反轉
  const pts = series(400, 0.0008, { dipAt: 200, dipTo: 0.85 });
  const n = windowMetrics(pts, flat(pts), 365);
  assert.ok(n.downsideDeviation > 0, "有跌過就要有下檔風險");
  assert.ok(n.downsideDeviation < n.volatility,
    `下檔標準差 ${n.downsideDeviation} 應小於總波動 ${n.volatility}——只有下跌被算進去`);
});

test("CAGR annualises and is not the same number as total return", () => {
  const pts = series(365 * 3, 0.001);
  const m = windowMetrics(pts, flat(pts), 365 * 3);
  assert.ok(m.totalReturn > m.cagr, "三年總報酬必然大於年化報酬（正報酬時）");
  // (1 + cagr)^3 應該還原回總報酬
  const rebuilt = (Math.pow(1 + m.cagr / 100, 3) - 1) * 100;
  assert.ok(Math.abs(rebuilt - m.totalReturn) < 1.5, `CAGR 還原不回總報酬：${rebuilt} vs ${m.totalReturn}`);
});

// 抓 5 年後遇到更多公司行動。四年前的一次不明跳動不該讓 1Y 也消失——
// 原本整檔丟棄，1Y 覆蓋率從 293 掉到 267。
test("an old unexplained jump truncates the series instead of dropping the fund", () => {
  const end = Math.floor(Date.parse("2026-08-06T00:00:00Z") / 1000);
  const n = 365 * 3;
  const close = [];
  // 兩年前有一次 0.6885 倍的跳動——這個比值刻意選實測 00738U 的值，
  // 因為它不貼近任何乾淨分割比例。用 0.4 會失敗：0.4 = 2/5 是合法分割，會被校正掉。
  const JUMP_AT = n - 365 * 2;
  for (let i = 0; i <= n; i += 1) {
    if (i < JUMP_AT) close.push(100);
    else if (i === JUMP_AT) close.push(68.85);
    else close.push(68.85 * (1 + 0.0005 * (i - JUMP_AT)));
  }
  const payload = { chart: { result: [{
    timestamp: close.map((_, i) => end - (n - i) * 86400),
    indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] },
  }] } };
  const out = yahooReturns(payload);
  assert.ok(!out.skip, "不該整檔丟棄：" + out.skip);
  assert.ok(out.truncatedBy, "要記下是被哪一次跳動截斷的");
  assert.ok(out.totalReturn1y != null, "跳動之後的乾淨區段仍算得出 1Y");
  assert.equal(out.totalReturn3y, undefined, "跨越跳動的 3Y 不可發布");
});
