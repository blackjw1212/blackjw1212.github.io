# blackjw1212.github.io — 專案事實

> 只寫「這個 repo 特有」的事。語言、四階段工作流、委派、驗證原則等**通用規則在全域
> `~/.claude/CLAUDE.md` 已生效，這裡不重抄**（重抄會分叉：全域改了專案層還留舊版）。

## 這是什麼

GitHub Pages 靜態站 + GitHub Actions ETL。**沒有建置步驟、沒有打包器、沒有 TypeScript。**
頁面是手寫 HTML + 行內 `<script>`，工具是原生 ESM `.mjs`。這是刻意的，不要引入工具鏈。

型別檢查的替代品是 **schema 測試**（`backend/test/etf-schema.test.js` 驗 `data/*.json` 的
結構與衍生欄位一致性）。加欄位就加斷言。

## 完成標準（DoD）

```
sh .claude/verify.sh
```

**`package.json` 只在 `backend/`，repo 根目錄沒有。** claude-verify-kit 的 `verify.py`
偵測 Node 專案時看的是根目錄，所以少了 `.claude/verify.sh` 這個 override，
Stop 閘門會**放行但什麼都沒驗**（實測過）。這個檔不可刪。

它跑三件事，與 CI 對齊：
1. `cd backend && npm test` — `node --test test/*.test.js`
2. `node scripts/check-static-site.mjs` — 靜態契約
3. `data/market-feed.json`、`data/etf-feed.json` 的 JSON 合法性與 `tradeDate` 格式

## 靜態契約 `scripts/check-static-site.mjs`

比一般 lint 嚴格很多，改頁面前先知道它管什麼，否則 CI 會紅：

- **首頁主要入口被釘死**為 `stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/`，
  順序與 href 都要一致。
- **各頁的 `<title>`、`canonical`、`theme-color`、CTA 文案逐字比對**。改標題要同步改這支腳本。
- **禁詞**：首頁與 `/market/` 不得出現 `保證`、`可放心`、`買進(訊號)`、`賣出(訊號)`、
  `投資建議`、`實領淨收益`。**註解也算**——曾因為程式碼註解寫了「保證」而 CI 紅。
- **所有 `/` 開頭的 href/src/srcset/url() 必須指向真實存在的檔案**。
- **天氣頁呼叫的每個 endpoint 都必須在 `weather-proxy/src/index.js` 的白名單裡**，
  且頁面不得出現 CWA API key。

## 部署：`pages-deploy.yml` 的 allowlist

```
cp -R index.html bjkw_weather.html 404.html sw.js esp32 forscan stocks market weather data assets dist/
```

**新增頂層頁面目錄一定要加進這行。** 否則 Site check 會過、Pages deploy 會失敗 ——
兩個 workflow 檢查的東西不同，綠燈不代表上線成功。

## 前端測試的硬性前提

`backend/test/market-page.test.js` / `frontend-smoke.test.js` 是用 `vm` 載入頁面的
**行內 `<script>`** 來測的，抓法是這個正則：

```js
html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)
```

所以 **`market/index.html` 的主 script 必須是最後一個、且緊貼 `</body>`**。
在它後面插任何東西，測試會抓不到 script 而整批失敗。
函式要能被測到就掛進 `MarketApp.helpers`。

## 資料管線：踩過的坑

工具在 `scripts/`，由 `update-market-feed.yml`（每日四班）與 `update-stock-risk-feed.yml` 驅動。

- **上市收盤用 `MI_INDEX`，不要用 `openapi` 的 `STOCK_DAY_ALL`。**
  後者當日不發佈（實測收盤後 8 小時仍是前一日），會讓頁面價比券商帳面舊一天。
  `STOCK_DAY_ALL` 保留為 fallback，因為 TWSE 曾對 GitHub runner IP 回 HTML 錯誤頁。
- **MI_INDEX 的漲跌方向藏在 HTML 顏色裡**（`color:red>+` 漲、`color:green>-` 跌），
  「漲跌價差」欄是**絕對值**——只讀該欄會讓當日近千檔下跌股全變上漲。除權息（`X`）記 `null`。
- **`tradeDate` 不可取「全體列的最大日期」。** 兩市場發佈時間不同步時，會讓一千多檔
  上市股掛著它們沒有的日期。取最小值，並輸出 `marketDates:{twse,tpex}`。
- **TPEX 回 10,000+ 列、耗時近 1 秒，runner 上常被中斷（undici `"terminated"`）。**
  兩個引擎都有 3 次指數退避重試（4xx 不重試）。
- **上游失敗絕不可歸零**：`preserveMarketRows` / `preserveEtfMarketRows` **逐市場**保留，
  `applyValuation` 逐欄保留。保留時要寫進 `errors[]`，讓畫面說得出來。
- **成分股是解析 MoneyDJ 的 HTML**（官方無此資料），每週一跑。成功率約 202/347，
  失敗大多是債券型（結構上沒有股票成分股頁），不是解析壞掉。
  `isDegraded()` 會在成功數掉到前次 70% 以下時**拒絕覆寫**。
- **配息來源要三條併用，因為沒有一條涵蓋全市場**（實測 2026-07-30）：
  `etfDiv` 只有 95 檔上市、上櫃 0 檔，連 00888 這種有配息的上市 ETF 都不在內；
  **除權除息預告表**（掛 tpex 網域但實際跨市場）補得到那些孤兒，但沒有發放日欄位；
  剩下的靠 `seed-etf-div-history.mjs --incremental`（Yahoo）。
  三條之間以 **±7 天去重 + 可信度分級**（官方金額+官方發放日 3 ＞ 官方金額+推估 2 ＞
  第三方 1）。**沒有分級時新接的官方來源會被先到的 Yahoo 事件永久擋住**（15 筆只進 1 筆）。
- **Yahoo 增量刷新必須留在 workflow 裡**（每日 22:00 那班，排在 ETF feed 之前）。
  它曾經只是手動工具，導致 112 檔 ETF 的配息凍結在最後一次手動執行、
  並隨 13 個月窗剪枝逐筆消失 —— 畫面上就是「殖利率沒更新」。
  增量模式用 `range=6mo`（3mo 對季配標的會剛好落空），且**不可標記 `seeded`**，
  否則新上市 ETF 會以 6 個月歷史被判定已回填而永遠拿不到完整兩年。
- **殖利率是「滾動 12 個月 ÷ 當日收盤」，他站多為「年度配息 ÷ 年均價」。**
  年中對照時本站必然偏高（實測 00888 13.47% vs 11.80%，差距 100% 來自時間窗、
  分母只差 0.1pp）。**兩處表頭都要寫「近12月」** —— 曾因配置產生器結果表只寫
  「殖利率%」而被誤判為算錯。
- **驗資料正確性用 TWSE MIS**（`mis.twse.com.tw/stock/api/getStockInfo.jsp`，
  `z`=今收、`y`=昨收）當獨立來源，它與券商帳面一致。**盤前 `z` 是 `-`，要改讀 `y`。**

## 稅務估算：只偵測過期，不自動抓數字

`data/tax-params.json` 的稅率**一律人工填寫並附出處**（財政部公告連結）。
`scripts/update-tax-params.mjs` 只做兩件事：比對年度、讀公告**標題**看有沒有新年度，
偵測到過期就 exit 1。**它永遠不會改寫稅率數字。**
理由：實際數字在政府 CMS 的 PDF 附件裡，解析它比解析 MoneyDJ 更脆弱，
而稅率算錯的後果比配息資料錯嚴重得多——寧可大聲失敗，不要靜靜地猜。

頁面內建 `TAX_FALLBACK` 備援（載不到 JSON 仍要能算）。
**兩份各改一邊就會給出不同稅額**，測試逐欄位鎖住一致，分叉會當場失敗。

其他要記得的事：
- **對居住者，國內 ETF 配息發放時不扣繳所得稅**，只扣二代健保；真正的稅是隔年 5 月
  申報的綜所稅。這兩件事不能混為一談。
- **ETF 配息組成（54C 國內股利／5A 國內利息／71 海外／76W 平準金）沒有任何可自動
  取得的來源**：TWSE `etfDiv` 與 TPEX 除權息預告表都只有金額，SITCA 公告頁是
  postback-only ASP.NET（有 `__VIEWSTATE`、初始載入 0 個 `<tr>`）。
  因此應稅比例只能**依標的性質推定**，每列都要標明理由。
- **二代健保改革（年度結算制）已暫緩、尚未上路**（查證於 2026-07-30），
  現行仍是單筆 ≥ 2 萬 × 2.11%。
- 累進差額最容易抄錯且肉眼看不出來 → schema 測試用「在每個級距交界處兩式必須相等」
  的定義性檢查擋住。

## data/ 是 CI 寫的

`data/*.json` 由 Actions 自動 commit。本機重跑工具後要 push 之前先 `git pull --rebase`，
CI 的 commit 只動 `data/`，通常不衝突。feed 是 minified（`market-52w.json` 640KB），
壞掉時肉眼看不出來——靠 schema 測試擋。

## Cloudflare Workers

`weather-proxy/`（天氣）與 `backend/`（stock-risk）各是一個 Worker，
由 `deploy-weather-proxy.yml` / `deploy-stock-risk-worker.yml` 部署。
**API key 走 Worker secret，永遠不進頁面、不進 repo。** 靜態契約會檢查這件事。

## 計劃審查閘門

`.claude/plan.md` 一存在就會觸發 `plan-review.py`，要求 Codex 跨模型審核通過才放行。
不需要審查時**刪掉該檔**解除，不要偽造 marker。
