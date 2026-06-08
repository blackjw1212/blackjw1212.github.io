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
  if (pattern.test(text)) fail(`${rel} still contains forbidden legacy content: ${label}`);
}

function publicTargetExists(target) {
  if (!target.startsWith("/") || target.startsWith("//")) return true;
  const clean = target.split(/[?#]/)[0].replace(/^\/+/, "");
  const rel = clean.endsWith("/") ? `${clean}index.html` : clean;
  return has(rel);
}

for (const rel of [
  "index.html",
  "ai/index.html",
  "weather/index.html",
  "bjkw_weather.html",
  "404.html",
  "favicon.svg",
  "favicon.png",
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
  "scripts/check_internal_links.rb",
]) {
  mustNotExist(rel);
}

if (has("index.html")) {
  const html = await read("index.html");
  assertMatch("index.html", html, /href="\/ai\/"/, "AI route link");
  assertMatch("index.html", html, /href="\/weather\/"/, "weather route link");
  assertNoMatch("index.html", html, /year-archive|categories|tags|works|Blackjw's Blog|Minimal Mistakes|Jekyll|Hackintosh|HomeSpan|Resume/i);
}

if (has("ai/index.html")) {
  const html = await read("ai/index.html");
  assertMatch("ai/index.html", html, /STATIC_STOCK_FEED_URL\s*=\s*"\/data\/stock-risk-feed\.json"/, "absolute stock feed path");
  assertNoMatch("ai/index.html", html, /RetailConsole|個人參考基準|\/filings\b|MOPS/i);
}

if (has("weather/index.html")) {
  const html = await read("weather/index.html");
  assertMatch("weather/index.html", html, /WEATHER_PROXY_BASE/, "weather proxy base");
  assertMatch("weather/index.html", html, /\/api\//, "weather datastore proxy route");
  assertMatch("weather/index.html", html, /\/file\//, "weather file proxy route");
  assertNoMatch("weather/index.html", html, /CWA-[A-Za-z0-9-]+|Authorization:\s*API_KEY|opendata\.cwa\.gov\.tw\/api|opendata\.cwa\.gov\.tw\/fileapi/);
}

if (has("bjkw_weather.html")) {
  const html = await read("bjkw_weather.html");
  assertMatch("bjkw_weather.html", html, /url=\/weather\//, "meta redirect");
  assertMatch("bjkw_weather.html", html, /window\.location\.replace\(target\)/, "query-preserving redirect");
}

for (const rel of ["index.html", "ai/index.html", "weather/index.html", "bjkw_weather.html", "404.html"]) {
  if (!has(rel)) continue;
  const html = await read(rel);
  for (const match of html.matchAll(/\b(?:href|src)=["'](\/[^"'#]+(?:#[^"']*)?)["']/g)) {
    const target = match[1];
    if (!publicTargetExists(target)) {
      fail(`${rel} links to missing public target: ${target}`);
    }
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
