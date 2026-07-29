#!/bin/sh
# 本專案的完成標準（Definition of Done）。exit 0 才算完成。
#
# 為什麼需要這個檔：verify.py 的 Node 偵測看的是 repo 根目錄的 package.json，
# 而本 repo 的 package.json 在 backend/ ——內建檢查會整段跳過，閘門形同空轉。
# 另外 check-static-site.mjs 是本站特有的靜態契約檢查，內建規則不可能知道。
#
# 這兩項與 CI 對齊：.github/workflows/site-check.yml 跑的就是這兩件事。
set -eu

cd "$(dirname "$0")/.."

fail() { echo "❌ $1"; exit 1; }

# 1) 後端 + 前端測試（node --test，含 feed schema 與頁面行為）
echo "→ backend npm test"
( cd backend && npm test ) || fail "backend npm test 失敗"

# 2) 靜態站契約（首頁入口、禁詞、必要檔案存在）
echo "→ check-static-site"
node scripts/check-static-site.mjs || fail "靜態站契約檢查失敗"

# 3) 資料 feed 必須是合法 JSON 且非空——被 minify 過，壞掉時肉眼看不出來
echo "→ data feeds"
node -e '
const fs=require("fs");
const files=["data/market-feed.json","data/etf-feed.json"];
for (const f of files) {
  const j=JSON.parse(fs.readFileSync(f,"utf8"));
  if (!Array.isArray(j.stocks) || !j.stocks.length) throw new Error(f+" 沒有 stocks");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.tradeDate||"")) throw new Error(f+" tradeDate 格式異常: "+j.tradeDate);
}
console.log("  feeds ok");
' || fail "資料 feed 檢查失敗"

echo "✅ DoD 全數通過"
