# Agent 提示詞 — PWA 整合(冪等,可貼進 Claude Code / Cursor / Copilot Agent)

> 在 repo 根目錄執行。本提示詞為**冪等規格**:已存在的就跳過,缺的才補。
> 若 repo 已是完成態(本專案 main 上 commit `634b210e` + `0d52982f` 之後即是),
> agent 應偵測到全部到位、**不做任何改動**、直接回報 "no changes needed"。

---

## 角色
你是有寫入權限的 coding agent,要在這個靜態網站(GitHub Pages user site,服務於根路徑 `/`)
完成 PWA 整合並推送。**只做下列指定改動,逐項先檢查是否已存在(冪等),不要重做或插出重複標籤。**

## 背景事實(已交叉驗證,不要重複加)
- 三頁 `index.html`、`stocks/index.html`、`weather/index.html` **都已有**:
  - `<link rel="manifest" href="/assets/images/site.webmanifest">`
  - `<link rel="apple-touch-icon" ...>`
  - `<meta name="theme-color" ...>`(index/stocks = `#101418` 深;weather = `#F4F6F8` 淺)
  → 這三樣**已存在,不要再加**。
- manifest 位置是 `assets/images/site.webmanifest`(不是根目錄)。
- 部署由 `.github/workflows/pages-deploy.yml` 處理:用**硬編碼清單** `cp` 檔案進 `dist/`。

## 禁區(一律不准動)
- `backend/`、`weather-proxy/`、`weather-proxy/src/index.js`(Cloudflare Worker / 後端)
- `.github/workflows/` 內**除了** `pages-deploy.yml` 那一行 cp 清單以外的任何 CI
- 任何 `<style>`/CSS、頁面業務邏輯、資料抓取程式、`data/` 內容
- 不改 theme-color、不改既有 manifest 連結、不動 favicon/icon 標籤

---

## 任務 1 — manifest 補欄位
檔案:`assets/images/site.webmanifest`
若 JSON 中**尚無** `start_url`,在 `"short_name"` 之後插入這三欄(已有則跳過):
```json
  "id": "/",
  "start_url": "/",
  "scope": "/",
```
不要改動 `icons` / `theme_color` / `background_color` / `display`。

## 任務 2 — 建立 service worker
檔案:`sw.js`(repo 根目錄)。**若已存在則跳過。** 內容完全照下方(已實測):
```js
/* BJKW Public Console — service worker */
const VERSION = "bjkw-v1";
const CACHE = `bjkw-${VERSION}`;

/* App shell：可導覽頁面 + 必要圖示。刻意保持輕量，不預載 512k 大圖。 */
const PRECACHE = [
  "/",
  "/stocks/",
  "/weather/",
  "/404.html",
  "/assets/images/site.webmanifest",
  "/assets/images/favicon.svg",
  "/assets/images/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 單一資源抓不到時不讓整個安裝失敗。
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 只處理同源請求；字型／CDN 直接走網路。
  if (url.origin !== self.location.origin) return;

  // 導覽（含即時資料的頁面）：network-first，離線時用快取備援。
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/404.html")))
    );
    return;
  }

  // 靜態資產：cache-first，未命中時抓網路並在背景回填快取。
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
```

## 任務 3 — 三頁 head 加 SW 註冊 + iOS standalone meta
**冪等鐵則:每頁先檢查是否已含 `serviceWorker.register`;有就整頁跳過,不要插第二份。**
插入位置:該頁 `<meta name="theme-color" ...>` 之後。

三頁共用的註冊 script(完全相同):
```html
<script>
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
</script>
```

apple meta 依頁面深淺不同(**狀態列樣式不可弄反**):
- `index.html`(深):
  ```html
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="BJKW">
  ```
- `stocks/index.html`(深):
  ```html
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="股票觀察台">
  ```
- `weather/index.html`(淺):
  ```html
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="BJKW 氣象">
  ```

## 任務 4 — 修部署白名單(關鍵,別漏)
檔案:`.github/workflows/pages-deploy.yml`
build 步驟用硬編碼清單 cp 檔案進 `dist/`。**若該 `cp -R ...` 行尚未包含 `sw.js`,把它加進去**
(否則線上 `/sw.js` 會 404、SW 註冊靜默失敗)。例:
```
cp -R index.html bjkw_weather.html 404.html sw.js stocks weather data assets dist/
```
`scripts/check-static-site.mjs` 只掃 href/src/poster 屬性,抓不到 JS 裡的 register,
**不會**因缺 sw.js 而報錯——所以這行漏了不會紅燈,但會部出壞站。務必確認。

---

## 驗證(必須實跑,不可只宣稱完成)
1. `node --check sw.js` → 語法 OK
2. 用 node 解析 manifest 為合法 JSON,且印出 `start_url` / `scope` / `id` 均為 `"/"`
3. 本機起 static server(如 `python -m http.server`),確認下列路由回 **200**:
   `/`、`/stocks/`、`/weather/`、`/sw.js`、`/assets/images/site.webmanifest`、`/404.html`
4. grep 三頁,確認各只有 **1** 份 `serviceWorker.register`,且 status-bar-style 為
   index=`black`、stocks=`black`、weather=`default`
5. 確認 `pages-deploy.yml` 的 cp 行含 `sw.js`

## 推送
- 若有改動:`git add` 上述檔案 → 一個 conventional commit → `git pull --rebase origin main` → `git push origin main`
  - commit message co-author 行:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 若全部已存在(no changes):**不要 commit**,直接回報 "already integrated, no changes"。
- 最後回報:實際做了哪些改動、驗證輸出、以及 **commit hash**(或 "no commit")。
```
```
