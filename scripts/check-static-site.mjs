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
  assertMatch("index.html", html, /<title>BJKW 觀察控制台<\/title>/, "root title");
  assertMatch("index.html", html, /<meta name="description" content="BJKW 公開觀察控制台/, "root description");
  assertMatch("index.html", html, /<link rel="canonical" href="\/"/, "root canonical");
  assertMatch("index.html", html, /property="og:title" content="BJKW 觀察控制台"/, "root og title");
  assertMatch("index.html", html, /name="theme-color" content="#101418"/, "root theme color");
  assertMatch("index.html", html, /<main class="shell">/, "root main shell");
  assertMatch("index.html", html, /aria-label="主要觀察台"/, "primary nav label");
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
  if (primaryLinks.join("|") !== "stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/|flight:/flight/|dash:/dash/") {
    fail(`index.html primary entries should be exactly stocks:/stocks/, weather:/weather/, esp32:/esp32/, forscan:/forscan/, flight:/flight/ and dash:/dash/, got ${primaryLinks.join(", ")}`);
  }
  // CTA 改釘不變式，不釘六串字面值。原本六條 assertMatch 各自抄一次文案，
  // 沒有任何一條看得出「可見文字必須是 accessible name 的子字串」這件事——
  // 實測那時 /weather/ 與 /flight/ 兩顆按鈕都違反了 WCAG 2.5.3 Label in Name
  // （可見「開啟機票決策台」，aria-label 卻是「開啟機票總成本決策台」），
  // 六條字面值全綠，因為它們只各自比對自己抄的那一串。
  const ctas = [...html.matchAll(/<a class="entry-button"[^>]*href="([^"]+)"[^>]*aria-label="([^"]+)">([^<]+)<\/a>/g)];
  if (ctas.length !== 6) {
    fail(`index.html should have exactly 6 entry CTAs, got ${ctas.length}`);
  }
  for (const [, href, ariaLabel, visible] of ctas) {
    // 可見文字＝「開啟 <路徑>」。路徑本身就是這一頁的辨識詞（topbar 也是這樣列的），
    // 再複述一次卡片標題只是把同一句話講第二遍。
    if (visible !== `開啟 ${href}`) {
      fail(`index.html CTA for ${href} should read 「開啟 ${href}」, got 「${visible}」`);
    }
    // WCAG 2.5.3：accessible name 必須包含可見文字，否則語音控制使用者
    // 說出畫面上看到的字會叫不動這顆按鈕。
    if (!ariaLabel.startsWith(visible)) {
      fail(`index.html CTA for ${href}: aria-label 「${ariaLabel}」 does not start with the visible 「${visible}」`);
    }
    // 而且要比可見文字多說一點——連結被抽出脈絡列表時，只有路徑不足以說明去處。
    if (ariaLabel.length <= visible.length) {
      fail(`index.html CTA for ${href}: aria-label adds nothing beyond the visible text`);
    }
  }
  assertNoMatch("index.html", html, /\/ai\/|AI 供應鏈觀察台|開啟 AI 觀察台|AI Feed/);
  assertNoMatch("index.html", html, /year-archive|categories|tags|works|Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|Resume/i);
  assertNoMatch("index.html", html, /保證|可放心|買進|賣出|投資建議|安全資訊/);
}

if (has("stocks/index.html")) {
  const html = await read("stocks/index.html");
  assertMatch("stocks/index.html", html, /<title>股票投資觀察台｜AI 供應鏈<\/title>/, "stocks title");
  assertMatch("stocks/index.html", html, /<h1>股票投資觀察台<\/h1>/, "stocks h1");
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
  assertMatch("esp32/index.html", html, /<title>ESP32 韌體觀察台｜BJKW<\/title>/, "esp32 title");
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
  assertMatch("forscan/index.html", html, /<title>Focus Mk3.5 FORScan 觀察台｜BJKW<\/title>/, "forscan title");
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
  assertMatch("flight/index.html", html, /<title>機票總成本決策台<\/title>/, "flight title");
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

if (has("bjkw_weather.html")) {
  const html = await read("bjkw_weather.html");
  assertMatch("bjkw_weather.html", html, /url=\/weather\//, "meta redirect");
  assertMatch("bjkw_weather.html", html, /window\.location\.replace\(target\)/, "query-preserving redirect");
}

for (const rel of ["index.html", "stocks/index.html", "market/index.html", "weather/index.html", "esp32/index.html", "forscan/index.html", "forscan/service/index.html", "forscan/sync3/index.html", "flight/index.html", "dash/index.html", "bjkw_weather.html", "404.html"]) {
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
