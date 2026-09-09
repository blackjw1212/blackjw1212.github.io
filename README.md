# BJKW 公開主控台

本儲存庫在 GitHub Pages 上發布一組靜態工具。根目錄 `/` 是它們的輕量入口頁
（純靜態，不在 runtime 抓任何東西）。

首頁上的 11 個入口：

| 路徑 | 這是什麼 |
|---|---|
| `/stocks/` | 股票觀測——自訂台股清單、收盤與漲跌、距 52 週高 |
| `/weather/` | 天氣與海象——天氣、潮汐、海象與沿岸觀察 |
| `/esp32/` | ESP32 韌體——自製韌體專案的靜態總覽 |
| `/forscan/` | FORScan 設定——Focus Mk3.5 可調項目的參考 |
| `/flight/` | 機票總成本——把票價、行李、機場交通加總成一個數字 |
| `/dash/` | 騎乘儀表板——用手機 GPS 與姿態感測器當儀表 |
| `/coupon/` | 優惠疊加——券、卡、支付加碼疊起來的淨成本試算 |
| `/subtitle/` | 字幕生成——瀏覽器內語音辨識，檔案不離開裝置 |
| `/convert/` | 檔案轉換——圖片、PDF、Word 與試算表互轉 |
| `/bait/` | 餌料配方——釣魚餌料的配方紀錄本 |
| `/float/` | 浮標配鉛——磯釣咬鉛與浮標號數對照與配鉛試算 |

另有三個不從首頁連出、但確實存在的頁面：

- `/market/` — 全市場與 ETF 資料表，從 `/stocks/` 連進去
- `/forscan/service/` — 保養與維修圖解
- `/forscan/sync3/` — SYNC 3 更新指南

## 網站結構

```text
/
├── index.html              # 入口頁（純靜態，無 body 端 script）
├── 404.html
├── sw.js                   # service worker：導覽與 /data/ 走 network-first
├── bjkw_weather.html       # 導向 /weather/ 的舊版轉址
│
├── stocks/  market/        # 股票觀測與全市場資料表
├── weather/                # 天氣與海象
├── esp32/                  # ESP32 韌體
├── forscan/                # FORScan 設定（另含 service/ 與 sync3/ 兩個子頁）
├── flight/                 # 機票總成本
├── dash/                   # 騎乘儀表板
├── coupon/                 # 優惠疊加
├── subtitle/               # 字幕生成（vendor/ 自帶約 37 MB 函式庫）
├── convert/                # 檔案轉換（vendor/ 自帶約 11 MB 函式庫）
├── bait/                   # 餌料配方
├── float/                  # 浮標配鉛
│
├── assets/images/          # 共用 favicon 與 app 圖示
├── data/                   # 前端讀的 JSON feed
├── scripts/                # ETL 工具與靜態契約檢查
├── backend/                # 台股市場資料 Worker ＋ 全部的測試
└── weather-proxy/          # 中央氣象署（CWA）天氣 Worker 代理
```

兩件從樹狀圖看不出來的事：

- **`scripts/` 不在 `pages-deploy.yml` 的 cp allowlist**，所以那些工具不會被部署出去。
  `scripts/mobile-audit.html` 是給人在本機開的量測工具，不是站上的頁面。
- **`data/` 底下有兩份人工維護的 feed**——`coupons.json` 與 `floats.json` 沒有任何
  workflow 會寫它們，改它們就是改 repo 內容。其餘的 `data/*.json` 都由 Actions 自動 commit。

## 股票投資觀察台

股票觀察台是一個靜態 HTML 應用，在「股票投資」公開類別下觀察精選的台灣 AI
供應鏈個股。它顯示自動化的市場狀態、大盤指數報價、收盤資料、10 年期殖利率
脈絡、TradingView 圖表連結，以及保守的系統觀察價。

資料來源順序：

1. 用於 `/quote`、`/eod`、`/yield10y` 的 Cloudflare Worker 代理。
2. 可用時，直接取用 TWSE 公開的收盤（EOD）資料。
3. 同源的 `data/stock-risk-feed.json`。
4. 瀏覽器最後一份可用的快取。

觀察價由頁面依市場快照產生，僅為觀察基準，並非目標價，也不是買賣建議。

## 天氣觀察台

天氣頁面改呼叫天氣代理（weather proxy），而非把中央氣象署金鑰暴露在靜態 HTML 中。

預設代理：

```text
https://bjkw-weather-proxy.a0926043323.workers.dev
```

頁面使用：

- `/api/:endpoint` 用於 datastore 請求
- `/file/:endpoint` 用於 file API 請求

## Workers

### 台股市場 Worker

位於 `backend/`。

公開路由：

- `GET /health`
- `GET /quote?codes=2330,2317`
- `GET /quote?indices=taiex,tpex`
- `GET /eod`
- `GET /yield10y`

`FRED_API_KEY` 為選用。若未提供，Worker 會改用美國財政部（US Treasury）的
10 年期殖利率作為後備來源。

### 天氣代理

位於 `weather-proxy/`。

必要 secret：

```bash
npx wrangler secret put CWA_API_KEY
```

Worker 會在伺服器端注入金鑰，且只允許 `/weather/` 所使用的天氣端點。

## 檢查

完成標準就是這一行，`exit 0` 才算過：

```bash
sh .claude/verify.sh
```

它跑三件事，與 CI 對齊：

1. `cd backend && npm test` — `node --test test/*.test.js`（後端邏輯、feed schema、
   以及用 `vm` 載入頁面行內 script 測出來的前端行為）
2. `node scripts/check-static-site.mjs` — 靜態站契約
3. `data/market-feed.json`、`data/etf-feed.json` 的 JSON 合法性與 `tradeDate` 格式
   ——這兩份 feed 是 minified 的，壞掉時肉眼看不出來

**`package.json` 只在 `backend/`，repo 根目錄沒有。** 這就是 `.claude/verify.sh`
必須存在的理由：偵測 Node 專案的工具看的是根目錄，少了這個 override 就會放行而什麼都沒驗。

`scripts/check-static-site.mjs` 比一般 lint 嚴格得多。它逐字比對各頁的 `<title>`、
`canonical` 與 `theme-color`，釘住首頁入口的順序與屬性寫法，要求所有以 `/` 開頭的
`href`／`src` 都指向真實存在的檔案，檢查天氣頁呼叫的每個 endpoint 都在代理的白名單裡、
且頁面不含 CWA 金鑰，並在舊網站檔案或舊路由名稱重新出現時失敗。

## 部署與排程

GitHub Pages 以靜態產出物部署，不使用任何佈景主題建置流程。沒有建置步驟、
沒有打包器——頁面是手寫 HTML 加行內 `<script>`，工具是原生 ESM `.mjs`。

`.github/workflows/` 底下六個：

| workflow | 何時跑 | 做什麼 |
|---|---|---|
| `site-check.yml` | push／PR 到 main | `npm test` ＋ 靜態契約 |
| `pages-deploy.yml` | push 到 main | 用 allowlist 複製檔案成 `dist/`，再對 `dist/` 跑一次靜態契約後部署 |
| `update-market-feed.yml` | 每日四班 | **主力 ETL。** 依序跑 market-feed、etf-holdings、div-history、tax-params、industry-map、etf-returns、risk-free、etf-feed 八支工具，最後驗 ETF 的 schema |
| `update-stock-risk-feed.yml` | 每日兩班 | 個股風險 feed |
| `deploy-stock-risk-worker.yml` | push `backend/**` | 部署台股市場 Worker |
| `deploy-weather-proxy.yml` | push `weather-proxy/**` | 部署天氣代理 Worker |

**新增頂層頁面目錄時，一定要加進 `pages-deploy.yml` 的 cp allowlist**，並同步加進
`sw.js` 的 `PRECACHE`、順手 bump `VERSION`。漏掉的話 Site check 會過、Pages deploy
才失敗——兩個 workflow 檢查的東西不同，前者綠燈不代表上線成功。
