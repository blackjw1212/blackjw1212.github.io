import test from "node:test";
import assert from "node:assert/strict";
import { buildNameToHip, compareRow, summarise, toTraditional } from "../../scripts/sky-name-audit.mjs";

// 這支測試**不碰網路**。sky-name-audit.mjs 有 isMain guard，所以上面那行 import
// 不會觸發 main()；少了 guard 的話 npm test 會真的去打外站
// （scripts/float-source-audit.mjs 記過同一個坑）。

test("importing the audit tool does not perform any network call", () => {
  // guard 若失效，import 期間就會發出請求並多半讓這支測試逾時或噴錯。
  // 這條主要是把「必須有 guard」這個要求寫成可執行的形式。
  assert.equal(typeof compareRow, "function");
});

test("the simplified-to-traditional map covers the shapes the oracle actually uses", () => {
  assert.equal(toTraditional("娄宿三"), "婁宿三");
  assert.equal(toTraditional("毕宿五"), "畢宿五");
  assert.equal(toTraditional("轩辕十四"), "軒轅十四");
  assert.equal(toTraditional("鹤一"), "鶴一");
  assert.equal(toTraditional("天狼"), "天狼", "本來就是繁體的不該被動到");
});

test("the IAU name index is case-insensitive and keeps every alias", () => {
  const map = buildNameToHip({
    "HIP 1": [{ english: "Alkaid" }, { english: "Benetnasch" }],
    "HIP 2": [{ english: "Vega" }],
  });
  assert.equal(map.get("alkaid"), "HIP 1");
  assert.equal(map.get("benetnasch"), "HIP 1", "別名也要進索引，否則會誤報成對方沒有");
  assert.equal(map.get("vega"), "HIP 2");
});

test("a row agrees once the oracle's simplified form is normalised", () => {
  assert.equal(compareRow({ ours: "婁宿三", theirs: ["娄宿三"] }).status, "agree");
});

test("a genuine disagreement is reported as such, not smoothed over", () => {
  const verdict = compareRow({ ours: "尾宿七", theirs: ["尾宿六"] });
  assert.equal(verdict.status, "differ");
  assert.deepEqual(verdict.theirs, ["尾宿六"], "對方的說法要留著讓人判");
});

test("a row we deliberately left null is not counted as agreement", () => {
  // 留 null 是「判不出來」，不是「一致」。混進 agree 會讓報告看起來比實際乾淨。
  assert.equal(compareRow({ ours: null, theirs: ["候"] }).status, "ours-null");
});

test("a star the oracle does not carry is distinguished from a disagreement", () => {
  assert.equal(compareRow({ ours: "天樞", theirs: null }).status, "no-oracle");
  assert.equal(compareRow({ ours: "天樞", theirs: [] }).status, "no-oracle");
});

test("the tally adds up to the number of rows", () => {
  const rows = [
    compareRow({ ours: "天狼", theirs: ["天狼"] }),
    compareRow({ ours: "尾宿七", theirs: ["尾宿六"] }),
    compareRow({ ours: null, theirs: ["候"] }),
    compareRow({ ours: "天樞", theirs: null }),
  ];
  assert.deepEqual(summarise(rows), { agree: 1, differ: 1, "ours-null": 1, "no-oracle": 1 });
});
