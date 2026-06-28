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
  "weather/index.html",
  "esp32/index.html",
  "forscan/index.html",
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
  assertMatch("index.html", html, /aria-label="輕量資料狀態"/, "status board label");
  assertMatch("index.html", html, /aria-live="polite"/, "polite status live region");
  assertMatch("index.html", html, /aria-label="主要觀察台"/, "primary nav label");
  assertMatch("index.html", html, /id="stockFeedStatus"/, "stock status id");
  assertMatch("index.html", html, /id="weatherStatus"/, "weather status id");
  assertMatch("index.html", html, /bjkw-weather-proxy\.a0926043323\.workers\.dev\/health/, "root weather health endpoint");
  if (primaryLinks.join("|") !== "stocks:/stocks/|weather:/weather/|esp32:/esp32/|forscan:/forscan/") {
    fail(`index.html primary entries should be exactly stocks:/stocks/, weather:/weather/, esp32:/esp32/ and forscan:/forscan/, got ${primaryLinks.join(", ")}`);
  }
  assertMatch("index.html", html, /開啟股票投資觀察台 \/stocks\//, "visible stocks CTA");
  assertMatch("index.html", html, /開啟天氣觀察台 \/weather\//, "visible weather CTA");
  assertMatch("index.html", html, /開啟 ESP32 觀察台 \/esp32\//, "visible esp32 CTA");
  assertMatch("index.html", html, /開啟 FORScan 觀察台 \/forscan\//, "visible forscan CTA");
  assertNoMatch("index.html", html, /\/ai\/|AI 供應鏈觀察台|開啟 AI 觀察台|AI Feed/);
  assertNoMatch("index.html", html, /year-archive|categories|tags|works|Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|Resume/i);
  assertNoMatch("index.html", html, /保證|可放心|買進|賣出|投資建議|安全資訊/);
}

if (has("stocks/index.html")) {
  const html = await read("stocks/index.html");
  assertMatch("stocks/index.html", html, /<title>股票投資觀察台｜AI 供應鏈<\/title>/, "stocks title");
  assertMatch("stocks/index.html", html, /<h1>股票投資觀察台<\/h1>/, "stocks h1");
  assertMatch("stocks/index.html", html, /STATIC_STOCK_FEED_URL\s*=\s*"\/data\/stock-risk-feed\.json"/, "absolute stock feed path");
  assertNoMatch("stocks/index.html", html, /RetailConsole|個人參考基準|\/filings\b|MOPS/i);
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
}

if (has("bjkw_weather.html")) {
  const html = await read("bjkw_weather.html");
  assertMatch("bjkw_weather.html", html, /url=\/weather\//, "meta redirect");
  assertMatch("bjkw_weather.html", html, /window\.location\.replace\(target\)/, "query-preserving redirect");
}

for (const rel of ["index.html", "stocks/index.html", "weather/index.html", "esp32/index.html", "forscan/index.html", "bjkw_weather.html", "404.html"]) {
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
