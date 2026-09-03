/* BJKW Public Console — service worker */
const VERSION = "bjkw-v8";
const CACHE = `bjkw-${VERSION}`;

/* App shell：可導覽頁面 + 必要圖示。刻意保持輕量，不預載 512k 大圖。 */
const PRECACHE = [
  "/",
  "/stocks/",
  "/weather/",
  "/esp32/",
  "/forscan/",
  "/forscan/service/",
  "/forscan/sync3/",
  "/flight/",
  "/dash/",
  // sw.js 建於 2026-06-21、market/ 建於 2026-07-27，之後一直沒補進來（git log -p 確認
  // 歷史上一次都沒出現過）。它是從 /stocks/ 連進去的真實頁面，漏掉的後果是離線首訪
  // 直接落到 /404.html。原始 246KB 但 gzip 後 81KB，收進 app shell 是划算的；
  // 上面那句「不預載 512k 大圖」講的是圖片，不是頁面。
  "/market/",
  "/coupon/",
  // 只收頁面本身，不收 subtitle/vendor/ 底下那 36 MB。把 ONNX Runtime 的 wasm 塞進
  // app shell，等於讓每一個只想看 /stocks/ 的訪客先下載 36 MB。vendor 走既有的
  // cache-first 靜態資產分支，第一次真的開這頁時才進快取，之後照樣能離線用。
  "/subtitle/",
  // 同上：只收頁面本身，不收 convert/vendor/ 底下那 10 MB。那些函式庫在頁面裡是
  // 按需 import 的，走 cache-first 靜態資產分支，真的選到那種轉檔時才進快取。
  "/convert/",
  // 這一頁沒有 vendor，整份就是那一個 HTML；離線在船上或堤防上開得起來才有意義。
  "/bait/",
  "/404.html",
  "/assets/images/site.webmanifest",
  "/assets/images/favicon.svg",
  "/assets/images/apple-touch-icon.png",
  // 儀表的數字字型：各約 1.9KB，預載才能保證在隧道裡也是對的字
  "/assets/fonts/chakra-petch-600-digits.woff2",
  "/assets/fonts/chakra-petch-700-digits.woff2",
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

  // 每日 feed：network-first。這些檔一天更新多班（收盤後與盤後補抓），
  // 而頁面的 ?v=YYYY-MM-DD 只換一次；走 cache-first 會讓同一天稍後的更新
  // 到隔天才看得到。離線時仍以快取備援。
  if (url.pathname.startsWith("/data/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
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
