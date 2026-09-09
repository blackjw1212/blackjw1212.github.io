// 人工執行的來源複查工具（不進 GitHub Actions、不進 .claude/verify.sh）：
// 把 data/floats.json 的每一個來源，反查成「這個來源撐著哪幾列、那幾列宣稱的數值是什麼」，
// 讓人開一頁就知道該在上面找哪幾個數字。加 --fetch 會實際拓頁面、在純文字裡比對那些數字，
// 把要人工讀的量從十四頁縮到幾個可疑點。
//
// 為什麼不進 verify.sh／CI（比照 CLAUDE.md 對 mobile-audit.html 的那段論證）：
//
// 1. 它要打十四個外站。CI 不該把別人的部落格當成自己綠燈的條件——那些站掛一天，
//    這個 repo 的 CI 就紅一天，而那跟本站的程式碼對不對毫無關係。
// 2. 那些站對 GitHub runner IP 的行為跟家用網路不一樣（TWSE 就對 runner 回過 HTML 錯誤頁）。
//    在 CI 量到的「被擋」不代表真的被擋，那是假訊號，會訓練人忽略紅燈。
// 3. 這件事的產出是「人接下來要去看哪幾頁」，不是一個布林值。自動化只能縮小範圍，
//    不能替代閱讀——所以它的正確位置是人手動跑的工具，不是閘門。
//
// 但它的純函式被 backend/test/float-source-audit.test.js 蓋著，那支測試不碰網路，
// 所以邏輯本身仍有 CI 迴歸保護。切法比照 check-static-site.mjs（進 CI）與
// mobile-audit.html（不進）之間的那條線。
//
// **這支工具不會寫任何檔案。** 它不會、也不該把 seenVia 改成 opened：HTTP 200 與
// 字串命中都不等於「有人讀過那一頁並確認那些數字」。改 seenVia 一律人工。
//
// 用法：
//   node scripts/float-source-audit.mjs                  離線清單（無網路也能跑）
//   node scripts/float-source-audit.mjs --fetch           實際拓頁面並比對數值
//   node scripts/float-source-audit.mjs --only tw-neio    只處理一個來源

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const FEED_PATH = fileURLToPath(new URL("../data/floats.json", import.meta.url));

// 旗標解析抽成純函式，形狀比照 scripts/seed-etf-div-history.mjs 的 resolveMode。
export function resolveMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const onlyIndex = args.indexOf("--only");
  return {
    fetch: args.includes("--fetch"),
    only: onlyIndex >= 0 ? args[onlyIndex + 1] || null : null,
  };
}

// 抓 HTML 的重試 helper，抄 scripts/update-risk-free.mjs 的 fetchText：3 次指數退避，
// 4xx 不重試（重試也不會變好）。差別是這裡要把狀態碼帶回去分類，所以失敗時丟的錯
// 帶 status，而不是只有訊息字串。
async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; bjkw-site/1.0)" },
        redirect: "follow",
      });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      }
      return { status: response.status, text: await response.text() };
    } catch (error) {
      lastError = error;
      if (error.status >= 400 && error.status < 500) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError || new Error("fetch failed");
}

// 四種結局，只有 dead 算失敗。把「連結沒了」跟「擋機器人」分開很重要：
// 部落格擋 UA 是常態，人開得起來，那不是資料的問題；404 才是真的失去出處。
export function classifyStatus(status, error) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "dead";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (error || status >= 500 || !status) return "unreachable";
  return "unreachable";
}

// 同一個數字在頁面上可能寫成 0.20 也可能寫成 0.2，兩種都要找。
export function claimNeedles(value) {
  if (!Number.isFinite(value)) return [];
  const needles = new Set();
  const raw = String(value);
  // 裸整數（3、15）在任何頁面上都會命中，拿它當證據等於自欺——只收帶小數點的寫法。
  if (raw.includes(".")) needles.add(raw);
  for (const digits of [1, 2]) {
    const padded = value.toFixed(digits);
    // toFixed 會四捨五入：1.125 → "1.13" 是頁面上不會出現的數字。只收補零後仍相等的
    // （0.2 → "0.20" 可以，1.125 → "1.13" 不行）。
    if (Number(padded) === value) needles.add(padded);
  }
  return [...needles];
}

// 比對前先把標籤拿掉。不去標籤的話 class="g-055" 這種屬性值會被當成內文命中，
// 而那正是這支工具最不該給出的假陽性。
export function stripHtml(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ");
}

export function matchClaims(text, claims) {
  const haystack = stripHtml(text);
  return claims.map((claim) => {
    if (claim.kind !== "number") return { ...claim, hit: null };
    return { ...claim, hit: claimNeedles(claim.value).some((needle) => haystack.includes(needle)) };
  });
}

// 把每個來源反查成一組「宣稱」。四個地方會引用來源：shots、floats、variants、
// residualBuoyancy 與 makerVariance。被宣告卻沒有任何一列引用的來源會留下空清單——
// 那是資料的異味（掛了一個沒在撐任何數字的來源），報告會把它點出來。
export function buildChecklist(feed) {
  const claimsBySource = new Map();
  const push = (ids, claim) => {
    for (const id of ids || []) {
      if (!claimsBySource.has(id)) claimsBySource.set(id, []);
      claimsBySource.get(id).push(claim);
    }
  };

  for (const shot of feed.shots || []) {
    if (shot.grams !== null) {
      push(shot.sourceIds, { path: `shots/${shot.label}.grams`, kind: "number", value: shot.grams });
    } else {
      push(shot.sourceIds, {
        path: `shots/${shot.label}.grams`,
        kind: "text",
        value: "刻意未取值——確認這個來源到底給的是哪個數字",
      });
    }
    for (const variant of shot.variants || []) {
      // 區間型的 variant 把兩端各列成一項——人在頁面上要找的就是那兩個數字。
      const values = variant.gramsRange ? variant.gramsRange : [variant.grams];
      for (const value of values) {
        push([variant.sourceId], {
          path: `shots/${shot.label}.variants`,
          kind: "number",
          value,
        });
      }
    }
  }

  for (const row of feed.floats || []) {
    if (row.loadGrams === null) continue;
    push(row.sourceIds, { path: `floats/${row.label}.loadGrams`, kind: "number", value: row.loadGrams });
  }

  const main = feed.mainSinker;
  if (main) {
    push(main.sourceIds, {
      path: "mainSinker.thresholdGrams",
      kind: "number",
      value: main.thresholdGrams,
    });
    push(main.sourceIds, {
      path: "mainSinker.rule",
      kind: "text",
      value: `${main.thresholdShot} 以內不掛主鉛，號數以上才用鉛墜當主配重`,
    });
  }

  const depth = feed.depthPolicy;
  if (depth) {
    push(depth.sourceIds, {
      path: "depthPolicy",
      kind: "text",
      value: "沉入深度算不出來的四條阻擋——這是能力邊界，核對時看的是理由站不站得住，不是數字",
    });
  }

  const residual = feed.residualBuoyancy;
  if (residual) {
    for (const value of residual.rangeGrams || []) {
      push(residual.sourceIds, { path: "residualBuoyancy.rangeGrams", kind: "number", value });
    }
    push(residual.sourceIds, {
      path: "residualBuoyancy.defaultShot",
      kind: "text",
      value: `餘浮力預設取 ${residual.defaultShot}`,
    });
  }

  for (const item of feed.makerVariance || []) {
    push(item.sourceIds, { path: "makerVariance", kind: "text", value: item.claim });
  }

  return (feed.sources || []).map((source) => ({
    ...source,
    claims: claimsBySource.get(source.id) || [],
  }));
}

const STATUS_LABEL = {
  ok: "ok",
  "no-url": "無網址",
  dead: "連結已死",
  blocked: "被擋（人開得起來）",
  unreachable: "取不到（可重試）",
};

function formatClaim(claim) {
  // 數值印出所有要找的寫法，人在頁面上按 Ctrl+F 才不必自己想「會不會寫成 0.2」。
  const value = claim.kind === "number" ? claimNeedles(claim.value).join(" 或 ") : claim.value;
  return `${claim.path.padEnd(34)} ${value}`;
}

export function formatReport(rows, feed, mode) {
  const lines = [];
  const sources = feed.sources || [];
  // 逐值計數，不要用「總數減 opened」推——seenVia 加了第三個值之後那種推法就是錯的
  // （實測：兩筆 user-supplied 被算進了 search-summary）。
  const bySeenVia = new Map();
  for (const source of sources) {
    bySeenVia.set(source.seenVia, (bySeenVia.get(source.seenVia) || 0) + 1);
  }
  const breakdown = [...bySeenVia].map(([key, count]) => `${key} ${count}`).join(" ／ ");
  lines.push(`BJKW /float/ 來源複查｜${mode.fetch ? "實際拓頁面" : "離線清單"}`);
  lines.push(`資料檔 data/floats.json　核對日 ${feed.reviewedAt}`);
  lines.push(`來源 ${sources.length} 筆：${breakdown}`);
  lines.push("");

  let index = 0;
  const tally = { ok: 0, dead: 0, blocked: 0, unreachable: 0, "no-url": 0 };
  let hit = 0;
  let miss = 0;
  let textOnly = 0;

  for (const row of rows) {
    index += 1;
    lines.push("─".repeat(74));
    lines.push(`[${String(index).padStart(2)}/${String(rows.length).padStart(2)}] ${row.id}  (${row.kind})  seenVia=${row.seenVia}`);
    lines.push(`        ${row.title}`);
    // url 為 null 的是現場經驗，沒有頁面可以開。印一行空白會讓人以為連結掉了。
    lines.push(`        ${row.url || "（無網址：使用者現場經驗，沒有頁面可核對）"}`);
    if (!row.claims.length) {
      lines.push("        支撐 0 項——沒有任何一列引用它。要嘛補上引用，要嘛從 sources 移除。");
    } else {
      lines.push(`        支撐 ${row.claims.length} 項：`);
      for (const claim of row.claims) lines.push(`          ${formatClaim(claim)}`);
    }
    if (row.result) {
      tally[row.result.status] += 1;
      if (row.result.status === "ok") {
        const checked = row.result.claims.filter((c) => c.hit !== null);
        const hits = checked.filter((c) => c.hit);
        hit += hits.length;
        miss += checked.length - hits.length;
        textOnly += row.result.claims.length - checked.length;
        lines.push(`        HTTP ${row.result.httpStatus} ok｜命中 ${hits.length} ／ 未命中 ${checked.length - hits.length}`);
        for (const claim of checked.filter((c) => !c.hit)) {
          lines.push(`          未命中  ${formatClaim(claim)}`);
        }
      } else {
        textOnly += row.claims.filter((c) => c.kind !== "number").length;
        lines.push(`        ${STATUS_LABEL[row.result.status]}：${row.result.detail}`);
      }
    }
    lines.push("");
  }

  lines.push("─".repeat(74));
  if (mode.fetch) {
    lines.push(`合計　ok ${tally.ok}｜被擋 ${tally.blocked}｜取不到 ${tally.unreachable}｜連結已死 ${tally.dead}｜無網址 ${tally["no-url"]}`);
    lines.push(`數值　命中 ${hit} ／ 未命中 ${miss}（文字主張 ${textOnly} 項不列入比對）`);
    lines.push("");
  }
  lines.push("讀這份報告的三件事：");
  lines.push("  1. 命中不等於正確。頁面上出現 0.55 不代表那是 B 的重量——還是要看它落在表格哪一格。");
  lines.push("  2. 未命中不等於錯。釣具部落格的重量表很多是圖片，或由 JS 撐出來，純文字裡本來就沒有數字。");
  lines.push("  3. 這支工具不寫任何檔案。確認過的來源請自己把 data/floats.json 的 seenVia 改成 \"opened\"");
  lines.push("     ——判準是「你開過那頁、在上面看到那些數字」，HTTP 200 不算。");
  return lines.join("\n");
}

async function main() {
  const mode = resolveMode(process.argv);
  const feed = JSON.parse(await readFile(FEED_PATH, "utf8"));
  let rows = buildChecklist(feed);

  if (mode.only) {
    rows = rows.filter((row) => row.id === mode.only);
    if (!rows.length) {
      console.error(`找不到來源 ${mode.only}`);
      process.exitCode = 1;
      return;
    }
  }

  if (mode.fetch) {
    for (const row of rows) {
      // 對 null 發請求會直接丟例外，而且現場經驗本來就沒有頁面可拓。
      if (!row.url) {
        row.result = {
          status: "no-url",
          httpStatus: 0,
          detail: "現場經驗，沒有頁面可核對——要確認只能問提供的人。",
          claims: row.claims.map((claim) => ({ ...claim, hit: null })),
        };
        continue;
      }
      try {
        const { status, text } = await fetchText(row.url);
        row.result = {
          status: classifyStatus(status, null),
          httpStatus: status,
          detail: "",
          claims: matchClaims(text, row.claims),
        };
      } catch (error) {
        row.result = {
          status: classifyStatus(error.status || 0, error),
          httpStatus: error.status || 0,
          detail: String(error.message || error),
          claims: row.claims.map((claim) => ({ ...claim, hit: null })),
        };
      }
    }
  }

  console.log(formatReport(rows, feed, mode));

  // 只有「連結真的沒了」才算失敗——那一列從此沒有出處，是必須處理的事實。
  // 被擋與取不到都不是資料的問題，安靜地報告就好，否則這支工具會變成狼來了。
  if (rows.some((row) => row.result && row.result.status === "dead")) {
    console.error("\n有來源連結已死，那幾列目前沒有出處。請找替代來源或把該列降級。");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
