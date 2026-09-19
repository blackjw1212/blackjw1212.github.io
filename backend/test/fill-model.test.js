import assert from "node:assert/strict";
import test from "node:test";
import { FILL, classifyFill, summariseFills } from "../../scripts/lib/fill-model.mjs";

// 這支只有一個主張：日 K 能證明價格條件，證明不了成交。
// 所以下面每一條的重點都是「資料到哪裡為止」，而不是「怎麼算比較準」。

const bar = (over = {}) => ({
  open: 100, high: 105, low: 98, close: 104, volume: 3000,
  limit_up: 110, limit_down: 90, ...over,
});

test("沒碰到停板就是正常成交", () => {
  const r = classifyFill(bar(), "buy");
  assert.equal(r.fill, FILL.FILLED);
  assert.equal(r.price.value, 100);
});

test("全日鎖漲停 → 買不到，這是資料證明得了的", () => {
  const r = classifyFill(bar({ open: 110, high: 110, low: 110, close: 110 }), "buy");
  assert.equal(r.fill, FILL.BLOCKED);
  assert.equal(r.price, null, "買不到就沒有成交價，不可以給一個");
});

test("全日鎖跌停 → 賣不掉（停損那一側對稱）", () => {
  const r = classifyFill(bar({ open: 90, high: 90, low: 90, close: 90 }), "sell");
  assert.equal(r.fill, FILL.BLOCKED);
});

test("鎖漲停不影響賣單", () => {
  assert.equal(classifyFill(bar({ open: 110, high: 110, low: 110, close: 110 }), "sell").fill, FILL.FILLED);
});

// ── 這是整支最重要的一格 ────────────────────────────────────────
test("曾離開漲停 → 價格可達，但成交狀態未知（不可寫成 filled）", () => {
  const r = classifyFill(bar({ open: 110, high: 110, low: 103, close: 106 }), "buy");
  assert.equal(r.fill, FILL.PRICE_REACHABLE);
  assert.equal(r.execution.status, "未知");
  assert.equal(r.price.value, 110, "成交價只能取停板價，不得取盤中任何中間價");
  assert.equal(r.price.class, "計算值");
  assert.ok(!("filled_qty" in r.execution), "沒有委託簿就不得生出任何股數");
});

test("沒有明示假設時，本模組不會憑空生出 filled_qty", () => {
  const r = classifyFill(bar({ open: 110, high: 110, low: 103 }), "buy", { requestedQty: 1000 });
  assert.equal(r.fill, FILL.PRICE_REACHABLE);
  assert.equal(r.execution.filled_qty, undefined,
    "憑空的 filled_qty 正是這整套規格要擋的那種『看起來精準的連續數值』");
});

test("使用者明示參與率假設後才升格，而且整塊標成情境", () => {
  const r = classifyFill(bar({ open: 110, high: 110, low: 103 }), "buy", {
    requestedQty: 1000,
    assumption: { participationRate: 0.1, basis: "價格曾離開漲停，假設可在停板價成交" },
  });
  assert.equal(r.fill, FILL.ASSUMED);
  assert.equal(r.execution.class, "情境");
  assert.equal(r.execution.filled_qty, 300, "min(1000, 3000 × 0.1)");
  assert.match(r.execution.derivation, /min\(1000, volume 3000 × participation_rate 0\.1\) = 300/);
  assert.equal(r.execution.participation_rate.class, "情境", "參與率是假設不是資料");
});

test("參與率不合法時退回未知，不會自己挑一個", () => {
  for (const rate of [0, 1.5, "0.1", null]) {
    const r = classifyFill(bar({ open: 110, high: 110, low: 103 }), "buy", {
      requestedQty: 1000, assumption: { participationRate: rate },
    });
    assert.equal(r.fill, FILL.PRICE_REACHABLE, `participationRate=${rate} 不該被接受`);
  }
});

test("缺停板價 → UNKNOWN，不得推定為正常成交", () => {
  const { limit_up, ...noLimit } = bar();
  const r = classifyFill(noLimit, "buy");
  assert.equal(r.fill, FILL.UNKNOWN, "當成正常成交是樂觀推定，同『不知道就回 null』那條紅線");
});

test("缺 OHLC 任一欄 → UNKNOWN", () => {
  for (const f of ["open", "high", "low", "close"]) {
    const b = bar();
    delete b[f];
    assert.equal(classifyFill(b, "buy").fill, FILL.UNKNOWN, `缺 ${f} 應為 UNKNOWN`);
  }
});

test("整批統計要說出有多少訊號其實不知道成不成交", () => {
  const s = summariseFills([
    { fill: FILL.FILLED }, { fill: FILL.FILLED },
    { fill: FILL.PRICE_REACHABLE }, { fill: FILL.BLOCKED }, { fill: FILL.UNKNOWN },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.undetermined, 2, "PRICE_REACHABLE 與 UNKNOWN 都不算成交");
  assert.equal(s.undeterminedRatio, 0.4,
    "把未知混進 filled 算績效，就是用未知換來的漂亮數字");
});
