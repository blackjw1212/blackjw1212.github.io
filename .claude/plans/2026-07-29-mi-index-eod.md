# 計畫：上市收盤價落後一天 —— 改用 MI_INDEX 當日來源，並讓交易日逐市場誠實呈現

## 問題（使用者回報 + 實測證據）

使用者帳面 2026-07-29 收盤與 /market/ 顯示不符：

| 代碼 | 帳面（07-29 實際） | 頁面顯示 | 差 |
|---|---|---|---|
| 6669 緯穎 | 5,135.00 | 5,315 | 07-28 的價 |
| 3231 緯創 | 169.50 | 170 | 07-28 的價 |
| 2317 鴻海 | 237.00 | 238 | 07-28 的價 |
| 2382 廣達 | 309.50 | 313.5 | 07-28 的價 |
| 6239 力成 | 233.00 | 251.5 | 07-28 的價 |

**根因（實測 2026-07-29T13:47Z，台灣 21:47）**

1. `openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL` 仍只有 `Date=1150728`，鴻海 238。
   收盤後 8 小時仍未發佈當日資料。
2. TPEX `tpex_mainboard_daily_close_quotes` 已是 `Date=1150729`。
3. `update-market-feed.mjs:251` 的
   `tradeDate = stocks.map(s=>s.date).filter(Boolean).sort().pop()` **取全體最大日期**
   → 整份 feed 被標成「交易日 2026-07-29」，但 1,083 檔上市列其實是 07-28 的價，
   且 `errors: []`，畫面上完全沒有警告。**標籤與內容不符，是實質資料正確性錯誤。**

**關鍵發現**：同一交易所的另一端點 `www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX`
（`type=ALLBUT0999&response=json`）**當日就有資料**，1,373 列，且與 MIS 即時、
使用者帳面三方一致（鴻海 237.00 / 緯創 169.50 / 廣達 309.50 / 緯穎 5,135.00 / 力成 233.00）。

## 端點特性（已實測，非推測）

- 不帶 `date` 參數即回**最新交易日**（`stat:"OK"`, `date:"20260729"`）→ 不需自算交易日曆
- 非交易日回 `stat:"很抱歉，沒有符合條件的資料!"`、`tables:[]` → 好判斷
- 目標表以 `title` 含「每日收盤行情」錨定（`tables[8]`，但**不可用固定索引**）
- `fields`: 證券代號/證券名稱/成交股數/成交筆數/成交金額/開盤價/最高價/最低價/收盤價/
  漲跌(+/-)/漲跌價差/最後揭示買價/買量/賣價/賣量/本益比
- **坑 1**：漲跌方向藏在 HTML 裡 —— `<p style= color:red>+</p>` 漲 319 檔、
  `color:green>-` 跌 961 檔、`<p> </p>` 平/無量 74 檔、`<p>X</p>` 除權息 19 檔。
  `漲跌價差` 一律是**絕對值**，符號必須由此欄推。除權息（X）無法比較 → change 記 null。
- **坑 2**：數字含千分位逗號（`5,135.00`）
- **坑 3**：10 檔收盤是 `--`（無成交）→ 整列丟棄
- 範圍含 ETF（00400A、0061、00625K…）→ ETF 引擎沿用同一份 bulk 也會拿到當日價

## 變更內容

### 1. `scripts/update-market-feed.mjs`
- `SOURCES.twseEodFast = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?type=ALLBUT0999&response=json"`
- 新增 `export function normalizeMiIndex(payload)`：
  回 `{rows, date}`。以 title 正則找表、以 fields 名稱找欄位索引（**不用固定位置**，
  比照既有 `parseHoldings` 的抗改版做法）；`stat` 非 OK 或找不到表 → 回 `{rows:[],date:null}`
- 新增 `export function parseMiChange(signCell, diffCell)`：把顏色/符號 + 絕對值還原成帶號數字，
  除權息回 `null`
- 新增 `async function fetchTwseEod()`：先 MI_INDEX；rows 為 0 或拋錯 → 退回 `STOCK_DAY_ALL`，
  並在 errors 記 `twse-eod-fallback`。**兩者都保留**，因為 MI_INDEX 可能擋 runner IP
  （既有教訓：TWSE OpenAPI 會對 GH runner 回 HTML）
- **`tradeDate` 改為取各市場日期的最小值**（保守：「這份清單至少完整到這一天」），
  並新增 `marketDates:{twse,tpex}`；兩者不一致時 push 一筆 `stale-market` 到 errors

### 2. `scripts/update-etf-feed.mjs`
`--bulk` 落檔格式維持 `{twse, tpex}`，但 twse 內容改為 MI_INDEX 的**已正規化列**。
為避免兩種格式在 `normalizeEtfBulkRows` 裡分岔，改為 market 引擎落檔時就寫正規化後的列，
ETF 端偵測「已正規化」（元素含 `code`/`close` 小寫鍵）則直接採用。

### 3. `market/index.html`
`feedStamp` 在 `marketDates.twse !== marketDates.tpex` 時顯示
`交易日 上市 07-28 · 上櫃 07-29`，而不是含糊的單一日期。

### 4. 測試
- `normalizeMiIndex`：抗改版（表順序變動、fields 換位置仍要解析成功）；
  `stat` 非 OK 回空；`--` 列丟棄；千分位
- `parseMiChange`：紅+ / 綠- / 空白 / X 四種型態
- `tradeDate` 取 min：twse 07-28 + tpex 07-29 → tradeDate 07-28，
  且 errors 含 `stale-market`（**這條直接鎖住本次的 bug**）
- `feedStamp` 雙日期顯示
- 端到端：以錄下的真實 payload 片段跑一次，確認鴻海 = 237

## 驗證方式
1. `cd backend && npm test`（基準 153 全綠 + 新增）
2. `node scripts/check-static-site.mjs` exit 0
3. 實跑 pipeline：鴻海必須 = 237、緯創 169.5、廣達 309.5、緯穎 5135、力成 233，
   `tradeDate` = 2026-07-29
4. 故障注入：MI_INDEX 回 stat 錯誤 → 必須退回 STOCK_DAY_ALL 且不崩
5. 瀏覽器實測 + push + CI 綠

## 已知限制
- MI_INDEX 是 `www.twse.com.tw/rwd/` 路徑（非 openapi 網域），未經 GitHub runner 實測；
  若被擋會自動退回 STOCK_DAY_ALL（慢一天但有資料），且 errors 會標明
- TPEX 端點不變（本來就當日到位）
- 除權息當日的 `change` 記 null（原本會顯示 0，是錯的）

---
審查狀態：**未取得 Codex 跨模型審核**。
原因：codex 帳號用量上限，重置時間 2026-08-12 10:48。
CLI 已由 0.130.0 升至 0.146.0（原本 gpt-5.6-terra 需新版），版本問題已解決，卡在配額。
本計畫所述變更已實作、156/156 測試綠、故障注入通過並上線（commit cdb23baa）。
若要補審：codex 配額恢復後，用本檔重跑 codex-review skill。
