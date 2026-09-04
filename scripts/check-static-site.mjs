import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = resolve(process.argv[2] || repoRoot);
const failures = [];

function fail(message) {
  failures.push(message);
}

function has(rel) {
  return existsSync(join(siteRoot, rel));
}

function mustExist(rel) {
  if (!has(rel)) fail(`Missing required static file: ${rel}`);
}

function mustNotExist(rel) {
  if (has(rel)) fail(`Legacy file should not be present: ${rel}`);
}

async function read(rel) {
  return readFile(join(siteRoot, rel), "utf8");
}

function assertMatch(rel, text, pattern, label = String(pattern)) {
  if (!pattern.test(text)) fail(`${rel} does not match ${label}`);
}

function assertNoMatch(rel, text, pattern, label = String(pattern)) {
  if (pattern.test(text)) fail(`${rel} still contains forbidden content: ${label}`);
}

// 每一頁的 CSS 自訂屬性都必須在同一頁定義過（各頁的 <style> 是自足的，沒有共用樣式表）。
//
// 實測踩過：market/index.html 用了 var(--panel-2) 與 var(--surface)，
// 但那一頁定義的是 --panel2 與 --panel——變數名是從 index.html 抄過來的，兩頁命名不同。
// 結果 .hero-kpi / .verdict / .fold 的背景整個變成透明，而且跨了好幾個 commit 沒被發現：
// HTML 不會壞、CI 不會紅、瀏覽器只是靜靜忽略那條宣告，既有檢查一條都抓不到。
//
// 使用端要掃**整份檔案**而不只是 <style>：inline style 屬性、JS 樣板字串裡的
// style="color:var(--amber)"、SVG 的 fill="var(--teal)" 都會用到變數。
// 定義端同理不能只看 :root——media query 或其他選擇器裡也可以定義。
function checkCssVariables(rel, html) {
  const defined = new Set(html.match(/--[A-Za-z0-9_-]+(?=\s*:)/g) || []);
  const missing = new Set();
  for (const match of html.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
    // var(--x, 備援值) 缺定義仍會正常顯示，不是錯誤
    if (match[2] === ",") continue;
    if (!defined.has(match[1])) missing.add(match[1]);
  }
  // 同一個變數用十次只報一行，否則一個錯字會洗版
  for (const name of missing) {
    fail(`${rel} uses undefined CSS variable ${name}`);
  }
}

function publicTargetExists(target) {
  if (!target.startsWith("/") || target.startsWith("//")) return true;
  const clean = target.split(/[?#]/)[0].replace(/^\/+/, "");
  const rel = clean.endsWith("/") ? `${clean}index.html` : clean;
  return has(rel);
}

function checkPublicTarget(rel, target) {
  if (!publicTargetExists(target)) {
    fail(`${rel} links to missing public target: ${target}`);
  }
}

function publicTargetsFromSrcset(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter((target) => target.startsWith("/"));
}

for (const rel of [
  "index.html",
  "stocks/index.html",
  "market/index.html",
  "data/market-feed.json",
  "data/etf-feed.json",
  "data/etf-static.json",
  "data/tax-params.json",
  "weather/index.html",
  "esp32/index.html",
  "forscan/index.html",
  "forscan/service/index.html",
  "forscan/sync3/index.html",
  "flight/index.html",
  "dash/index.html",
  "coupon/index.html",
  "data/coupons.json",
  "subtitle/index.html",
  // 這一頁的辨識引擎住在獨立的 module worker 裡，而 Worker 的 URL 寫在 JS 字串中，
  // 下面那圈只掃 href/src 的迴圈看不到它。漏掉不會有任何錯誤訊息，只會在使用者按下
  // 按鈕時安靜地什麼都不發生，所以在這裡點名。
  "subtitle/worker.js",
  // 自帶的 transformers.js 與 ONNX Runtime。transformers.js 預設把 wasm 指到
  // onnxruntime-web 的一個 dev 版號（1.26.0-dev.20260416-b7804b056c），釘在那種版本上
  // 等於把整頁的存亡交給別人的 npm tag，而且斷網就沒了。改指同源副本後，這幾個檔
  // 就是這一頁的必要零件——沒被 pages-deploy 複製到就得當場失敗。
  "subtitle/vendor/transformers.min.js",
  "subtitle/vendor/opencc-full.js",
  "subtitle/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs",
  "subtitle/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm",
  "subtitle/vendor/ort/ort-wasm-simd-threaded.mjs",
  "subtitle/vendor/ort/ort-wasm-simd-threaded.wasm",
  "convert/index.html",
  // /convert/ 的函式庫全部自帶且**只在按下轉檔時才動態載入**——所以下面那圈掃
  // href/src 的迴圈一個都看不到（它們的路徑是 JS 字串），漏掉不會有任何錯誤訊息，
  // 只會在使用者選了某種格式時才安靜地失敗。在這裡逐檔點名。
  "convert/vendor/pdf.min.mjs",
  "convert/vendor/pdf.worker.min.mjs",
  "convert/vendor/pdf-lib.min.js",
  "convert/vendor/jszip.min.js",
  "convert/vendor/docx-preview.min.js",
  "convert/vendor/mammoth.browser.min.js",
  "convert/vendor/docx.mjs",
  "convert/vendor/xlsx.full.min.js",
  "convert/vendor/heic-to.min.js",
  "convert/vendor/html2canvas-pro.min.js",
  "convert/vendor/pako.min.js",
  "convert/vendor/UTIF.js",
  // pdf.js 沒有內嵌字型時要靠這兩包才畫得出字。少了 cmaps，用預定義 CMap 的中文 PDF
  // 會整頁空白——而且 pdf.js 只在 console 抱怨，畫面上就是「轉出來是白的」。
  "convert/vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap",
  "convert/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
  "bait/index.html",
  "bjkw_weather.html",
  "404.html",
  "data/stock-risk-feed.json",
  "assets/images/favicon.ico",
  "assets/images/favicon.svg",
  "assets/images/favicon-32x32.png",
  "assets/images/favicon-16x16.png",
  "assets/images/apple-touch-icon.png",
  "assets/images/site.webmanifest",
  "assets/images/android-chrome-192x192.png",
  "assets/images/android-chrome-512x512.png",
  // 儀表的數字字型。走自帶而不是 Google Fonts：實機上 CDN 字型沒載到時，iOS 會退到
  // ui-monospace（SF Mono），它的零帶斜線，放大當車速看起來像缺字符的方塊。
  "assets/fonts/chakra-petch-600-digits.woff2",
  "assets/fonts/chakra-petch-700-digits.woff2",
]) {
  mustExist(rel);
}

for (const rel of [
  "_config.yml",
  "_data",
  "_includes",
  "_layouts",
  "_posts",
  "_sass",
  "assets/css/main.scss",
  "assets/js",
  "categories.md",
  "tags.md",
  "works.md",
  "year-archive.md",
  "Gemfile",
  "Gemfile.lock",
  "profile-README.md",
  "favicon.svg",
  "favicon.png",
  "ai",
  "ai/index.html",
  "scripts/check_internal_links.rb",
]) {
  mustNotExist(rel);
}

if (has("index.html")) {
  const html = await read("index.html");
  const primaryLinks = [...html.matchAll(/<a\b[^>]*data-primary-entry="([^"]+)"[^>]*href="([^"]+)"/g)]
    .map((match) => `${match[1]}:${match[2]}`);
  assertMatch("index.html", html, /<html lang="zh-Hant">/, "zh-Hant document language");
  assertMatch("index.html", html, /<meta charset="UTF-8"/, "UTF-8 charset");
  assertMatch("index.html", html, /<meta name="viewport" content="width=device-width, initial-scale=1.0"/, "responsive viewport");
  assertMatch("index.html", html, /<title>BJKW Console<\/title>/, "root title");
  assertMatch("index.html", html, /<meta name="description" content="BJKW Console，/, "root description");
  assertMatch("index.html", html, /<link rel="canonical" href="\/"/, "root canonical");
  assertMatch("index.html", html, /property="og:title" content="BJKW Console"/, "root og title");
  assertMatch("index.html", html, /name="theme-color" content="#101418"/, "root theme color");
  assertMatch("index.html", html, /<main class="shell">/, "root main shell");
  assertMatch("index.html", html, /aria-label="全部工具"/, "primary nav label");
  // 三張狀態卡（持股監控 / 美國 10Y 公債 / Weather Proxy）已整組移除。那三個數字
  // 在各自的內頁都講得更完整：檔數與收盤日在 /stocks/、天氣代理能不能用進
  // /weather/ 就知道，而 10Y 沒有任何頁面拿它算東西。首頁是入口，不是儀表板。
  assertNoMatch("index.html", html, /id="(stockFeed|yield|weather)(Status|Meta)"/, "status card ids");
  assertNoMatch("index.html", html, /class="status-(board|card|value|meta)"/, "status board markup");
  assertNoMatch("index.html", html, /aria-live="polite"|aria-label="輕量資料狀態"/, "status live region");
  // 卡片沒了就不該再有 runtime 抓取。<head> 的 service worker 註冊不算——
  // 這條擋的是「首頁又長出一個會打網路的區塊」。
  assertNoMatch("index.html", html, /stock-risk-feed\.json|bjkw-weather-proxy[^"]*\/health/, "root runtime fetches");
  assertNoMatch("index.html", html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "root body script");
  if (primaryLinks.join("|") !== "stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/|flight:/flight/|dash:/dash/|coupon:/coupon/|subtitle:/subtitle/|convert:/convert/|bait:/bait/") {
    fail(`index.html primary entries should be exactly stocks:/stocks/, weather:/weather/, esp32:/esp32/, forscan:/forscan/, flight:/flight/, dash:/dash/, coupon:/coupon/, subtitle:/subtitle/, convert:/convert/ and bait:/bait/, got ${primaryLinks.join(", ")}`);
  }
  // 整張卡片就是連結，沒有獨立的 CTA 按鈕了——右上那排路徑列與每張卡右下的
  //「開啟 /xxx/」講的都是同一件事，兩者一起移除，可點範圍改成整張卡。
  // 屬性順序（class → data-primary-entry → href → aria-label）是這裡與上面
  // primaryLinks 那條正則共同依賴的，改版面時不要順手調換。
  const cards = [...html.matchAll(/<a class="entry[^"]*" data-primary-entry="[^"]+" href="([^"]+)"[^>]*aria-label="([^"]+)">[\s\S]*?<h2>([^<]+)<\/h2>/g)];
  // 數量對著 primaryLinks 比，不要再寫死一個數字。兩者標的是同一批元素，
  // 各自釘一個常數就是兩個事實來源——實測分叉過一次：加第 8 顆入口時條件改成了 8、
  // 錯誤訊息還留在 7，訊息會反過來誤導下一個人。
  if (cards.length !== primaryLinks.length) {
    fail(`index.html has ${cards.length} entry cards but ${primaryLinks.length} data-primary-entry links; every card is its own link`);
  }
  for (const [, href, ariaLabel, title] of cards) {
    // WCAG 2.5.3 Label in Name：卡片上看得見的標籤就是 <h2>，accessible name
    // 必須以它開頭，否則語音控制使用者說出畫面上看到的標題會叫不動這張卡。
    // 實測踩過的是舊版按鈕：可見「開啟機票決策台」、aria-label 卻是
    //「開啟機票總成本決策台」，而當時六條字面值斷言全綠。
    if (!ariaLabel.startsWith(title)) {
      fail(`index.html card for ${href}: aria-label 「${ariaLabel}」 does not start with the visible 「${title}」`);
    }
    // 而且要比標題多說一點——連結被抽出脈絡列成一串時，光有標題不足以說明去處。
    if (!ariaLabel.includes(href)) {
      fail(`index.html card for ${href}: aria-label 「${ariaLabel}」 should also name the destination path`);
    }
  }
  // 這兩樣是這次拿掉的東西，釘住不許回來：右上重複一次的路徑列，
  // 以及每張卡右下那顆「開啟 /xxx/」按鈕（它一度是卡片裡唯一可點的地方）。
  assertNoMatch("index.html", html, /class="topnav"/, "the duplicated top-right path nav");
  // 只擋按鈕的樣式與它的**可見文字**（>開啟 /…）。卡片連結的 aria-label 仍然
  // 要說得出「開啟 /stocks/」，所以不能連 aria-label 裡的那句一起擋掉。
  assertNoMatch("index.html", html, /class="entry-button"|>開啟 \//, "per-card CTA buttons");
  assertNoMatch("index.html", html, /\/ai\/|AI 供應鏈觀察台|開啟 AI 觀察台|AI Feed/);
  assertNoMatch("index.html", html, /year-archive|categories|tags|works|Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|Resume/i);
  assertNoMatch("index.html", html, /保證|可放心|買進|賣出|投資建議|安全資訊/);
}

if (has("stocks/index.html")) {
  const html = await read("stocks/index.html");
  assertMatch("stocks/index.html", html, /<title>股票觀測｜AI 供應鏈<\/title>/, "stocks title");
  assertMatch("stocks/index.html", html, /<h1>股票觀測<\/h1>/, "stocks h1");
  assertMatch("stocks/index.html", html, /STATIC_STOCK_FEED_URL\s*=\s*"\/data\/stock-risk-feed\.json"/, "absolute stock feed path");
  assertMatch("stocks/index.html", html, /new URL\("https:\/\/tw\.tradingview\.com\/chart\/"\)/, "plain TradingView chart URL");
  assertNoMatch("stocks/index.html", html, /RetailConsole|個人參考基準|\/filings\b|MOPS/i);
}

if (has("market/index.html")) {
  const html = await read("market/index.html");
  assertMatch("market/index.html", html, /<html lang="zh-Hant">/, "market document language");
  assertMatch("market/index.html", html, /<title>全市場個股清單｜BJKW<\/title>/, "market title");
  assertMatch("market/index.html", html, /rel="canonical" href="\/market\/"/, "market canonical");
  assertMatch("market/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "market manifest");
  assertMatch("market/index.html", html, /name="theme-color" content="#101418"/, "market theme color");
  assertMatch("market/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "market service worker registration");
  assertMatch("market/index.html", html, /MARKET_FEED_URL\s*=\s*"\/data\/market-feed\.json"/, "absolute market feed path");
  assertMatch("market/index.html", html, /不是投資建議/, "market non-advice disclaimer");
  assertMatch("market/index.html", html, /ETF_FEED_URL\s*=\s*"\/data\/etf-feed\.json"/, "absolute etf feed path");
  assertMatch("market/index.html", html, /id="tabStock"/, "stock tab");
  assertMatch("market/index.html", html, /id="tabEtf"/, "etf tab");
  assertMatch("market/index.html", html, /id="tabSim"/, "simulator tab");
  assertMatch("market/index.html", html, /new URL\("https:\/\/tw\.tradingview\.com\/chart\/"\)/, "plain TradingView chart URL");
  assertMatch("market/index.html", html, /保守上限/, "simulator must frame NHI deduction as a conservative upper bound");
  assertMatch("market/index.html", html, /未查證/, "simulator must disclose the unverified NHI basis");
  // 稅務估算的三件必要揭露：發放時不扣繳、應稅比例是推定的、這不是稅務建議
  assertMatch("market/index.html", html, /發放時不扣繳所得稅/, "must distinguish withholding from the annual return");
  assertMatch("market/index.html", html, /應稅比例是推定的/, "must disclose the composition is inferred");
  assertMatch("market/index.html", html, /不是稅務建議/, "tax estimate must carry a non-advice disclaimer");
  assertNoMatch("market/index.html", html, /保證|可放心|買進訊號|賣出訊號|實領淨收益/);
}

if (has("weather/index.html")) {
  const html = await read("weather/index.html");
  assertMatch("weather/index.html", html, /rel="icon" href="\/assets\/images\/favicon\.ico"/, "asset favicon ico");
  assertMatch("weather/index.html", html, /rel="icon" href="\/assets\/images\/favicon\.svg" type="image\/svg\+xml"/, "asset favicon svg");
  assertMatch("weather/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "asset manifest");
  assertMatch("weather/index.html", html, /WEATHER_PROXY_BASE/, "weather proxy base");
  assertMatch("weather/index.html", html, /bjkw-weather-proxy\.a0926043323\.workers\.dev/, "weather proxy host");
  assertMatch("weather/index.html", html, /\/api\//, "weather datastore proxy route");
  assertMatch("weather/index.html", html, /\/file\//, "weather file proxy route");
  assertNoMatch("weather/index.html", html, /CWA-[A-Za-z0-9-]+|Authorization:\s*API_KEY|opendata\.cwa\.gov\.tw\/api|opendata\.cwa\.gov\.tw\/fileapi/);
}

if (has("esp32/index.html")) {
  const html = await read("esp32/index.html");
  assertMatch("esp32/index.html", html, /<html lang="zh-Hant">/, "esp32 document language");
  assertMatch("esp32/index.html", html, /<title>ESP32 韌體｜BJKW<\/title>/, "esp32 title");
  assertMatch("esp32/index.html", html, /rel="canonical" href="\/esp32\/"/, "esp32 canonical");
  assertMatch("esp32/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "esp32 manifest");
  assertMatch("esp32/index.html", html, /name="theme-color" content="#101418"/, "esp32 dark theme color");
  assertMatch("esp32/index.html", html, /apple-mobile-web-app-status-bar-style" content="black"/, "esp32 ios status bar");
  assertMatch("esp32/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "esp32 service worker registration");
  assertMatch("esp32/index.html", html, /<h2>智慧家庭配件<\/h2>/, "esp32 home group");
  assertMatch("esp32/index.html", html, /<h2>車輛電子<\/h2>/, "esp32 vehicle group");
  assertMatch("esp32/index.html", html, /控制 · 顯示 · 介面/, "esp32 interface group");
  assertMatch("esp32/index.html", html, /部署細節與位置不公開/, "esp32 de-identification notice");
  assertMatch("esp32/index.html", html, /不讀取即時裝置狀態/, "esp32 static-only notice");
}

if (has("forscan/index.html")) {
  const html = await read("forscan/index.html");
  assertMatch("forscan/index.html", html, /<html lang="zh-Hant">/, "forscan document language");
  assertMatch("forscan/index.html", html, /<title>FORScan 設定｜Focus Mk3.5<\/title>/, "forscan title");
  assertMatch("forscan/index.html", html, /rel="canonical" href="\/forscan\/"/, "forscan canonical");
  assertMatch("forscan/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "forscan manifest");
  assertMatch("forscan/index.html", html, /name="theme-color" content="#101418"/, "forscan dark theme color");
  assertMatch("forscan/index.html", html, /apple-mobile-web-app-status-bar-style" content="black"/, "forscan ios status bar");
  assertMatch("forscan/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "forscan service worker registration");
  assertMatch("forscan/index.html", html, /<h2>便利 · 舒適<\/h2>/, "forscan comfort group");
  assertMatch("forscan/index.html", html, /<h2>保養 · 服務功能<\/h2>/, "forscan service group");
  assertMatch("forscan/index.html", html, /操作前務必先看/, "forscan safety notice");
  assertMatch("forscan/index.html", html, /逐車不同/, "forscan per-car disclaimer");
  assertMatch("forscan/index.html", html, /href="\/forscan\/service\/"/, "forscan links to service sub-page");
  assertMatch("forscan/index.html", html, /href="\/forscan\/sync3\/"/, "forscan links to sync3 sub-page");
}

if (has("forscan/sync3/index.html")) {
  const html = await read("forscan/sync3/index.html");
  assertMatch("forscan/sync3/index.html", html, /<html lang="zh-Hant">/, "sync3 document language");
  assertMatch("forscan/sync3/index.html", html, /rel="canonical" href="\/forscan\/sync3\/"/, "sync3 canonical");
  assertMatch("forscan/sync3/index.html", html, /name="theme-color" content="#101418"/, "sync3 theme color");
  assertMatch("forscan/sync3/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "sync3 service worker registration");
  assertMatch("forscan/sync3/index.html", html, /Syn3Updater/, "sync3 tool name");
  assertMatch("forscan/sync3/index.html", html, /無法再退回 3\.0/, "sync3 irreversible warning");
  assertMatch("forscan/sync3/index.html", html, /exFAT/, "sync3 usb format");
  assertMatch("forscan/sync3/index.html", html, /AutoInstall/, "sync3 install modes");
}

if (has("forscan/service/index.html")) {
  const html = await read("forscan/service/index.html");
  assertMatch("forscan/service/index.html", html, /<html lang="zh-Hant">/, "service document language");
  assertMatch("forscan/service/index.html", html, /rel="canonical" href="\/forscan\/service\/"/, "service canonical");
  assertMatch("forscan/service/index.html", html, /name="theme-color" content="#101418"/, "service theme color");
  assertMatch("forscan/service/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "service worker registration");
  assertMatch("forscan/service/index.html", html, /保養套餐 · 更換件料號/, "service parts group");
  assertMatch("forscan/service/index.html", html, /維修圖解 · 機油更換/, "service oil-change guide");
  assertMatch("forscan/service/index.html", html, /27 Nm/, "service drain torque");
  assertMatch("forscan/service/index.html", html, /14 Nm/, "service filter torque");
}

if (has("flight/index.html")) {
  const html = await read("flight/index.html");
  assertMatch("flight/index.html", html, /<html lang="zh-Hant">/, "flight document language");
  assertMatch("flight/index.html", html, /<title>機票總成本<\/title>/, "flight title");
  assertMatch("flight/index.html", html, /rel="canonical" href="\/flight\/"/, "flight canonical");
  assertMatch("flight/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "flight manifest");
  // 這一頁刻意用 #0E1621 而不是其他深色頁的 #101418——整套 panel/line 色階是配著它調的，
  // 只改這個 meta 會讓 iOS 狀態列與頁面背景對不上。要統一得連 CSS 變數一起改。
  assertMatch("flight/index.html", html, /name="theme-color" content="#0E1621"/, "flight theme color");
  assertMatch("flight/index.html", html, /apple-mobile-web-app-status-bar-style" content="black"/, "flight ios status bar");
  assertMatch("flight/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "flight service worker registration");
  // 純前端試算：資料只進 localStorage，不打任何後端。畫布專屬的 window.storage 在網站上不存在，
  // 殘留的話重新整理就會掉資料，而且不會有任何錯誤訊息。
  assertMatch("flight/index.html", html, /localStorage/, "flight local storage");
  assertNoMatch("flight/index.html", html, /window\.storage/);
}

if (has("dash/index.html")) {
  const html = await read("dash/index.html");
  assertMatch("dash/index.html", html, /<html lang="zh-Hant">/, "dash document language");
  assertMatch("dash/index.html", html, /<title>騎乘儀表板｜BJKW<\/title>/, "dash title");
  assertMatch("dash/index.html", html, /rel="canonical" href="\/dash\/"/, "dash canonical");
  assertMatch("dash/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "dash manifest");
  // 這一頁刻意用 #09090b 而不是其他深色頁的 #101418——HUD 的 panel/line 色階與 LED 螢光色
  // 是配著純黑調的，只改這個 meta 會讓 iOS 狀態列與頁面背景對不上。
  assertMatch("dash/index.html", html, /name="theme-color" content="#09090b"/, "dash theme color");
  assertMatch("dash/index.html", html, /apple-mobile-web-app-status-bar-style" content="black"/, "dash ios status bar");
  assertMatch("dash/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "dash service worker registration");
  // 純前端：感測資料只進 localStorage，不打任何後端、不記錄座標。
  assertMatch("dash/index.html", html, /localStorage/, "dash local storage");
  // 這頁一度宣稱「不記錄行經路線、不儲存任何座標」，後來加了軌跡繪製、座標真的存進
  // localStorage，那句話就不再是事實。改成鎖住新的揭露，並且明文禁止舊說法回來——
  // 程式偷偷存、頁面繼續宣稱沒存，是這份契約最該擋下的一種漂移。
  assertMatch("dash/index.html", html, /軌跡會留在這支手機上/, "dash must disclose the track is kept on the device");
  assertNoMatch("dash/index.html", html, /不記錄行經路線|不儲存任何座標/);
  // OBD 是唯讀的。這頁絕不對車輛寫入、不清除故障碼、不讀車身號碼——
  // 揭露要寫在頁面上，才不會有人日後「順手」加一顆清碼按鈕。
  assertMatch("dash/index.html", html, /只讀取，不會對車輛寫入任何指令/, "dash must disclose OBD access is read-only");
  assertNoMatch("dash/index.html", html, /window\.storage/);
  // 三條必要揭露。手機量到的是自身姿態而非車身傾角，少了這句整頁就是在誤導。
  assertMatch("dash/index.html", html, /騎乘中請勿操作手機/, "dash must tell riders not to operate the phone");
  assertMatch("dash/index.html", html, /非儀器級量測/, "dash must disclose the readings are not instrument grade");
  assertMatch("dash/index.html", html, /傾角量的是手機姿態，不是車身傾角/, "dash must distinguish phone attitude from lean angle");
  // 沒有「開始記錄」按鈕了，載入頁面本身就會開始定位。這件事一定要講在前面。
  assertMatch("dash/index.html", html, /開啟頁面就會開始定位/, "dash must disclose that opening the page starts positioning");
}

if (has("coupon/index.html")) {
  const html = await read("coupon/index.html");
  assertMatch("coupon/index.html", html, /<html lang="zh-Hant">/, "coupon document language");
  assertMatch("coupon/index.html", html, /<title>優惠疊加｜BJKW<\/title>/, "coupon title");
  assertMatch("coupon/index.html", html, /rel="canonical" href="\/coupon\/"/, "coupon canonical");
  assertMatch("coupon/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "coupon manifest");
  assertMatch("coupon/index.html", html, /name="theme-color" content="#101418"/, "coupon theme color");
  assertMatch("coupon/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "coupon service worker registration");
  assertMatch("coupon/index.html", html, /FEED_URL\s*=\s*"\/data\/coupons\.json"/, "absolute coupon feed path");
  // 這一頁最容易變成謊話的三件事，各釘一條揭露。優惠資料人工維護、鮮度隨時間腐化，
  // 少了任何一句，畫面上那個「淨成本」看起來就會像即時查到的真實報價。
  assertMatch("coupon/index.html", html, /人工核對的快照/, "coupon must disclose the data is a manual snapshot");
  assertMatch("coupon/index.html", html, /事後給付/, "coupon must distinguish rebates from an immediate discount");
  assertMatch("coupon/index.html", html, /不是消費建議/, "coupon must carry a non-advice disclaimer");
  // 頁面自稱不收推廣報酬，那就不能夾帶聯盟行銷追蹤參數——這條擋的是日後
  // 「順手」把來源連結換成分潤連結。資料檔那一側由 coupon-schema.test.js 把關。
  assertNoMatch("coupon/index.html", html, /[?&](utm_[a-z]+|aff(?:iliate)?_?id|ref|tag)=/i, "affiliate tracking parameters");
  // 前端測試靠「最後一個 <script> 緊貼 </body>」抓主程式，插東西進去會讓整批測試失效
  assertMatch("coupon/index.html", html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "coupon main script must sit right before </body>");
}

if (has("subtitle/index.html")) {
  const html = await read("subtitle/index.html");
  assertMatch("subtitle/index.html", html, /<html lang="zh-Hant">/, "subtitle document language");
  assertMatch("subtitle/index.html", html, /<title>字幕生成｜BJKW<\/title>/, "subtitle title");
  assertMatch("subtitle/index.html", html, /rel="canonical" href="\/subtitle\/"/, "subtitle canonical");
  assertMatch("subtitle/index.html", html, /rel="manifest" href="\/assets\/images\/site\.webmanifest"/, "subtitle manifest");
  assertMatch("subtitle/index.html", html, /name="theme-color" content="#101418"/, "subtitle theme color");
  assertMatch("subtitle/index.html", html, /apple-mobile-web-app-status-bar-style" content="black"/, "subtitle ios status bar");
  assertMatch("subtitle/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "subtitle service worker registration");
  // 這一頁的整個賣點就是「檔案不會離開這台裝置」。這句話一旦從畫面上消失，
  // 使用者就無從判斷自己丟進去的東西去了哪裡——比照 /dash/ 的做法把揭露釘死。
  assertMatch("subtitle/index.html", html, /檔案不會離開這台裝置/, "subtitle must disclose the file never leaves the device");
  // 只講離線不講「首次要下載幾百 MB」是半個事實。用行動網路的人有權先知道。
  assertMatch("subtitle/index.html", html, /首次使用需要下載模型/, "subtitle must disclose the first-run model download");
  // 沒有 WebGPU 的機器會退到單執行緒 WASM。GitHub Pages 送不出 COOP/COEP，
  // 多執行緒開不起來（ORT 官方：只有 crossOriginIsolated 才會啟用），這件事會慢到
  // 使用者以為當掉，所以要先說。
  assertMatch("subtitle/index.html", html, /WASM/, "subtitle must mention the wasm fallback");
  // 機器辨識一定有錯字。不寫這句，這頁就是在宣稱自己產出可直接使用的字幕。
  assertMatch("subtitle/index.html", html, /機器辨識一定有錯字/, "subtitle must carry an accuracy disclaimer");
  // 辨識與翻譯是兩個模型、兩段路。實測對日文音檔硬指定中文，Whisper 會逐音硬套出
  // 讀不通的句子，而它自己的 task:'translate' 只翻成英文（實測連英文都沒給）。
  // 頁面標題一度寫「生成繁體中文字幕」，那句話對任何非中文音檔都是假的——
  // 釘住「辨識本身不會翻譯」，別讓那個宣稱漂回去。
  assertMatch("subtitle/index.html", html, /辨識本身不會翻譯/, "subtitle must separate transcription from translation");
  assertNoMatch("subtitle/index.html", html, /生成繁體中文字幕/, "subtitle unconditional Traditional Chinese claim");
  // 語言選單本身就是那句揭露的配套：說了「選錯不會翻譯」，就得讓人選得到。
  assertMatch("subtitle/index.html", html, /<select id="langSelect">/, "subtitle language picker");
  assertMatch("subtitle/index.html", html, /<option value="zh" selected>中文<\/option>/, "subtitle defaults to Chinese");
  // 翻譯要再抓 850 MB 並把辨識模型換掉，預設必須是關的，而且成本要寫在畫面上
  assertMatch("subtitle/index.html", html, /<option value="off" selected>原文字幕<\/option>/, "subtitle translation is opt-in");
  assertMatch("subtitle/index.html", html, /約 850 MB/, "subtitle must disclose the translation model download");
  // 全站唯一允許對外連線的目的地是 Hugging Face 的模型下載。任何其他外部端點都代表
  // 音訊或逐字稿有機會離開這台裝置——那正是上面那句揭露會變成謊話的方式。
  assertNoMatch("subtitle/index.html", html, /https?:\/\/(?!huggingface\.co)[^"'\s)]+/, "subtitle external endpoints");
  // 前端測試靠「最後一個 <script> 緊貼 </body>」抓主程式，插東西進去會讓整批測試失效
  assertMatch("subtitle/index.html", html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "subtitle main script must sit right before </body>");
}

if (has("subtitle/worker.js")) {
  const worker = await read("subtitle/worker.js");
  // wasmPaths 沒被改成同源路徑的話，這頁會靜靜地回去打 jsdelivr 上那個 dev 版號，
  // 自帶的 36 MB 就白帶了——而且畫面上完全看不出差別，只有斷網時才會爆。
  assertMatch("subtitle/worker.js", worker, /wasmPaths\s*=/, "worker must pin ORT wasm to the vendored copy");
  assertNoMatch("subtitle/worker.js", worker, /cdn\.jsdelivr\.net/, "worker must not fall back to a CDN");
  assertMatch("subtitle/worker.js", worker, /from\s+"\.\/vendor\/transformers\.min\.js"/, "worker loads the vendored transformers.js");
  // 預設不指定語言。硬塞 language:'zh' 正是「日文影片吐出讀不通的中文」那個 bug 的來源。
  assertNoMatch("subtitle/worker.js", worker, /language:\s*["']zh["']/, "hard-coded Chinese language token");
}

if (has("convert/index.html")) {
  const html = await read("convert/index.html");
  assertMatch("convert/index.html", html, /<html lang="zh-Hant">/, "convert document language");
  assertMatch("convert/index.html", html, /<title>檔案轉換｜BJKW<\/title>/, "convert title");
  assertMatch("convert/index.html", html, /<link rel="canonical" href="\/convert\/"/, "convert canonical");
  assertMatch("convert/index.html", html, /<link rel="manifest" href="\/assets\/images\/site\.webmanifest">/, "convert manifest");
  assertMatch("convert/index.html", html, /name="theme-color" content="#101418"/, "convert theme color");
  assertMatch("convert/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "convert service worker registration");

  // 這一頁的整個賣點是「檔案不會離開這台裝置」。下面三條把那句話變成可驗證的東西：
  // 沒有跨來源網址、沒有自己發出的請求、沒有表單。少任何一條，那句話就可能是假的。
  assertMatch("convert/index.html", html, /檔案不會離開這台裝置/, "convert privacy disclosure");
  assertMatch("convert/index.html", html, /全部運算都在瀏覽器完成/, "convert local-only disclosure");
  assertNoMatch("convert/index.html", html.slice(html.indexOf("<body")), /https?:\/\//, "convert external endpoints");
  assertNoMatch("convert/index.html", html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|<form\b/, "convert outbound request paths");

  // 保真度的三條紅線。這幾件事使用者在按下按鈕之前就必須知道，事後發現等於白轉一次：
  // DOCX→PDF 出來的是圖片頁、PDF 沒有文字圖層時抽不到字、canvas 編不出 AVIF。
  assertMatch("convert/index.html", html, /文字不可選取/, "convert must disclose the rasterised DOCX→PDF output");
  assertMatch("convert/index.html", html, /沒有 OCR/, "convert must disclose that scanned PDFs yield no text");
  assertMatch("convert/index.html", html, /不能輸出 AVIF/, "convert must disclose the AVIF encode limitation");

  // vendor 走同源。指回 CDN 的話，自帶的那 11 MB 就白帶了，而且畫面上看不出差別。
  assertMatch("convert/index.html", html, /var VENDOR = "\/convert\/vendor\/";/, "convert vendor path must be same-origin");
  // 前端測試靠「最後一個 <script> 緊貼 </body>」抓主程式，插東西進去會讓整批測試失效
  assertMatch("convert/index.html", html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "convert main script must sit right before </body>");
}

if (has("bait/index.html")) {
  const html = await read("bait/index.html");
  assertMatch("bait/index.html", html, /<html lang="zh-Hant">/, "bait document language");
  assertMatch("bait/index.html", html, /<title>餌料配方｜BJKW<\/title>/, "bait title");
  assertMatch("bait/index.html", html, /<link rel="canonical" href="\/bait\/"/, "bait canonical");
  assertMatch("bait/index.html", html, /<link rel="manifest" href="\/assets\/images\/site\.webmanifest">/, "bait manifest");
  assertMatch("bait/index.html", html, /name="theme-color" content="#101418"/, "bait theme color");
  assertMatch("bait/index.html", html, /navigator\.serviceWorker\.register\("\/sw\.js"\)/, "bait service worker registration");

  // 這一頁沒有後端也沒有帳號，資料只存在使用者自己的瀏覽器裡。下面三條把那句話
  // 變成可驗證的東西：沒有跨來源網址、沒有自己發出的請求。
  assertMatch("bait/index.html", html, /整頁在瀏覽器裡運算，不上傳任何東西/, "bait local-only disclosure");
  assertNoMatch("bait/index.html", html.slice(html.indexOf("<body")), /https?:\/\//, "bait external endpoints");
  assertNoMatch("bait/index.html", html, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/, "bait outbound request paths");

  // 這頁不給開餌建議，唯一會算的是錢。而錢只算得出用「克」或「包」記的那幾列——
  // 杯與匙沒有可靠的換算（同一個量杯裝紅餌與裝魔粒差很多），把那些當 0 加進去
  // 等於謊報一個偏低的總價。所以「算不出來要說出來」是契約的一部分。
  assertMatch("bait/index.html", html, /不給任何開餌建議/, "bait must not advise, only record");
  assertMatch("bait/index.html", html, /杯與匙沒有可靠的換算/, "bait must disclose which units cannot be costed");
  assertMatch("bait/index.html", html, /那幾列不列入總價/, "bait must disclose that uncostable rows are excluded");
  // 分頁鈕的 class 是 scripts/mobile-audit.html 走訪非預設分頁的依據。改名的話
  // 「單品庫」與「紀錄」兩個分頁的觸控目標整批量不到，而報告仍然是綠的。
  assertMatch("bait/index.html", html, /<div class="tabbar"/, "bait tab bar class drives the mobile audit walker");
  // 前端測試靠「最後一個 <script> 緊貼 </body>」抓主程式，插東西進去會讓整批測試失效
  assertMatch("bait/index.html", html, /<script>(?:(?!<\/script>)[\s\S])*<\/script>\s*<\/body>/, "bait main script must sit right before </body>");
}

if (has("bjkw_weather.html")) {
  const html = await read("bjkw_weather.html");
  assertMatch("bjkw_weather.html", html, /url=\/weather\//, "meta redirect");
  assertMatch("bjkw_weather.html", html, /window\.location\.replace\(target\)/, "query-preserving redirect");
}

for (const rel of ["index.html", "stocks/index.html", "market/index.html", "weather/index.html", "esp32/index.html", "forscan/index.html", "forscan/service/index.html", "forscan/sync3/index.html", "flight/index.html", "dash/index.html", "coupon/index.html", "subtitle/index.html", "convert/index.html", "bait/index.html", "bjkw_weather.html", "404.html"]) {
  if (!has(rel)) continue;
  const html = await read(rel);
  for (const match of html.matchAll(/\b(?:href|src|poster)=["'](\/[^"'#]+(?:#[^"']*)?)["']/g)) {
    checkPublicTarget(rel, match[1]);
  }
  for (const match of html.matchAll(/\bsrcset=["']([^"']+)["']/g)) {
    for (const target of publicTargetsFromSrcset(match[1])) checkPublicTarget(rel, target);
  }
  for (const match of html.matchAll(/url\(\s*["']?(\/[^"')?#]+(?:#[^"')]+)?)["']?\s*\)/g)) {
    checkPublicTarget(rel, match[1]);
  }
  checkCssVariables(rel, html);
}

if (has("assets/images/site.webmanifest")) {
  try {
    const manifest = JSON.parse(await read("assets/images/site.webmanifest"));
    for (const icon of Array.isArray(manifest.icons) ? manifest.icons : []) {
      if (icon && typeof icon.src === "string") checkPublicTarget("assets/images/site.webmanifest", icon.src);
    }
  } catch (error) {
    fail(`assets/images/site.webmanifest is not valid JSON: ${error.message}`);
  }
}

if (has("weather/index.html") && has("weather-proxy/src/index.js")) {
  const weatherHtml = await read("weather/index.html");
  const proxySource = await read("weather-proxy/src/index.js");
  const apiEndpoints = new Set([
    ...[...weatherHtml.matchAll(/\bendpoint:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...weatherHtml.matchAll(/\btryFetch\(\s*"([^"]+)"/g)].map((match) => match[1]),
  ]);
  const fileEndpoints = new Set([
    ...[...weatherHtml.matchAll(/\bCOAST_DATA_ID\s*=\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...weatherHtml.matchAll(/\btryFileFetch\(\s*"([^"]+)"/g)].map((match) => match[1]),
  ]);

  for (const endpoint of apiEndpoints) {
    if (!proxySource.includes(`"${endpoint}"`)) {
      fail(`weather proxy allowlist is missing datastore endpoint: ${endpoint}`);
    }
  }
  for (const endpoint of fileEndpoints) {
    if (!proxySource.includes(`"${endpoint}"`)) {
      fail(`weather proxy allowlist is missing file endpoint: ${endpoint}`);
    }
  }
}

for (const rel of ["README.md", "CHANGES.md", "weather-proxy/README.md"]) {
  if (!has(rel)) continue;
  const stat = statSync(join(siteRoot, rel));
  if (!stat.isFile()) continue;
  const text = await read(rel);
  assertNoMatch(rel, text, /Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|RetailConsole|MOPS|\/filings\b/i);
}

if (failures.length) {
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Static site contract OK: ${siteRoot}`);
