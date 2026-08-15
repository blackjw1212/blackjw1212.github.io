import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// check-static-site.mjs 是腳本不是模組（用 process.exit 回報），所以以子行程對
// 臨時 fixture 執行，讀 stderr 判斷。
const script = fileURLToPath(new URL("../../scripts/check-static-site.mjs", import.meta.url));

// 跑一次檢查，回傳它印出的失敗訊息（exit 0 時為空字串）。
// fixture 只放一個 index.html，其他契約項目（標題、canonical…）當然會失敗——
// 那不影響本測試，我們只斷言「CSS 變數」那一條有沒有出現。
function runCheck(html) {
  const dir = mkdtempSync(join(tmpdir(), "bjkw-contract-"));
  try {
    writeFileSync(join(dir, "index.html"), html, "utf8");
    try {
      execFileSync(process.execPath, [script, dir], { encoding: "utf8", stdio: "pipe" });
      return "";
    } catch (error) {
      return String(error.stderr || "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const page = (style, body = "") =>
  `<!DOCTYPE html><html lang="zh-Hant"><head><style>${style}</style></head><body>${body}</body></html>`;

// 實測踩過的 bug：market/index.html 用了 var(--panel-2)／var(--surface)，
// 但那一頁定義的是 --panel2／--panel（變數名從 index.html 抄來，兩頁命名不同）。
// 卡片背景整個變透明，跨了好幾個 commit 沒被發現——HTML 不會壞、CI 不會紅、
// 瀏覽器只是靜靜忽略那條宣告。
test("an undefined CSS variable fails the static contract", () => {
  const out = runCheck(page(":root{--panel2:#202b34}\n.card{background:var(--panel-2)}"));
  assert.match(out, /uses undefined CSS variable --panel-2/,
    "少一個字元的變數名必須被抓出來，這正是實際發生過的錯誤");
});

test("a defined variable raises no complaint", () => {
  const out = runCheck(page(":root{--panel2:#202b34}\n.card{background:var(--panel2)}"));
  assert.doesNotMatch(out, /undefined CSS variable/,
    "定義過的變數不可誤報，否則這條檢查會被當成雜訊而被關掉");
});

// 使用端不能只掃 <style>：inline style 屬性、JS 樣板字串、SVG 屬性都會用到變數，
// 而那正是圖表與卡片著色的寫法。
test("variables used outside the style block are checked too", () => {
  const inSvg = runCheck(page(":root{--teal:#42b8a8}", '<svg><circle fill="var(--tael)"/></svg>'));
  assert.match(inSvg, /undefined CSS variable --tael/, "SVG 屬性裡的變數也要檢查");

  const inScript = runCheck(page(":root{--amber:#d9a64c}",
    '<script>document.body.innerHTML = \'<b style="color:var(--ambr)">x</b>\';</script>'));
  assert.match(inScript, /undefined CSS variable --ambr/, "JS 產生的 inline style 也要檢查");
});

// 定義端同理不能只看 :root——media query 或其他選擇器裡也可以定義。
test("a variable defined outside :root still counts as defined", () => {
  const out = runCheck(page("@media (max-width:640px){.wrap{--gap:8px}}\n.wrap{gap:var(--gap)}"));
  assert.doesNotMatch(out, /undefined CSS variable/,
    "media query 裡的定義也算數，否則會逼人把所有變數都塞進 :root");
});

test("a fallback value makes an undefined variable acceptable", () => {
  const out = runCheck(page(":root{--panel2:#202b34}", '<b style="background:var(--nope, #202b34)">x</b>'));
  assert.doesNotMatch(out, /undefined CSS variable/,
    "var(--x, 備援值) 缺定義仍會正常顯示，不是錯誤");
});

test("one typo reported once, not once per usage", () => {
  const out = runCheck(page(
    ":root{--ink:#fff}\n.a{color:var(--nik)}\n.b{color:var(--nik)}\n.c{color:var(--nik)}"));
  const hits = (out.match(/undefined CSS variable --nik/g) || []).length;
  assert.equal(hits, 1, `同一個錯字用三次只該報一行，實得 ${hits} 行——洗版會蓋掉其他失敗訊息`);
});
