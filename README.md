# BJKW 公開主控台

本儲存庫在 GitHub Pages 上發布保留的靜態產品：

- `/stocks/` — 股票投資觀察台
- `/weather/` — BJKW 天氣觀察台
- `/esp32/` — ESP32 韌體觀察台
- `/forscan/` — Focus Mk3.5 FORScan 觀察台

根目錄 `/` 只是這些工具的輕量入口頁。不保留其他對外公開的頁面。

## 網站結構

```text
/
├── index.html              # 觀察台入口頁
├── stocks/index.html       # 股票投資觀察台
├── weather/index.html      # 天氣觀察台
├── esp32/index.html        # ESP32 韌體觀察台
├── forscan/index.html      # Focus Mk3.5 FORScan 觀察台（靜態參考）
├── bjkw_weather.html       # 導向 /weather/ 的舊版轉址
├── assets/images/          # 共用 favicon 與 app 圖示
├── data/stock-risk-feed.json
├── backend/                # 台股市場資料 Worker
└── weather-proxy/          # 中央氣象署（CWA）天氣 Worker 代理
```

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

執行完整的本地測試套件：

```bash
cd backend
npm test
cd ..
node scripts/check-static-site.mjs
```

`scripts/check-static-site.mjs` 強制執行「保留的公開頁面契約」，若舊網站檔案、
根目錄重複的 favicon、舊路由名稱、舊 helper 介面或天氣憑證重新出現，則檢查失敗。

## 部署

GitHub Pages 以靜態產出物部署，不使用任何佈景主題建置流程。

相關工作流程：

- `.github/workflows/site-check.yml`
- `.github/workflows/pages-deploy.yml`
- `.github/workflows/deploy-stock-risk-worker.yml`
- `.github/workflows/deploy-weather-proxy.yml`
- `.github/workflows/update-stock-risk-feed.yml`
