/* BJKW Public Console — service worker */
const VERSION = "bjkw-v1";
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
