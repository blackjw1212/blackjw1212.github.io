// update-market-feed.yml 的每一步都要有 timeout-minutes，而且 job 的上限不可以小於各步上限的總和。
//
// 2026-11-10 21:29 那班 ISIN 上市頁抓了 9 分 37 秒，產業對照那一步沒有上限，整條管線停在那裡等，
// 當班行情晚 13 分鐘上線；job 也沒有上限，真的卡死會等到 GitHub 預設的 6 小時。
// 這條測試讀的是 workflow 原文（註解剔除），新增一步忘了加上限就會紅。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function jobSteps(file, jobName) {
  const yml = await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
  const lines = yml.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.ok(jobStart >= 0, `${file} 找不到 job ${jobName}`);
  const stepsAt = lines.findIndex((line, i) => i > jobStart && line === "    steps:");
  const header = lines.slice(jobStart, stepsAt).join("\n");
  const jobMinutes = Number((header.match(/^    timeout-minutes:\s*(\d+)\s*$/m) || [])[1]);
  // 每一步從「      - 」開始，到下一個同層的「      - 」或 job 結束為止
  const steps = [];
  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {0,5}\S/.test(line)) break; // 回到更外層（下一個 job 或頂層鍵）
    if (/^      - /.test(line)) steps.push([line]);
    else if (steps.length) steps[steps.length - 1].push(line);
  }
  return {
    jobMinutes,
    steps: steps.map((block) => {
      const text = block.join("\n");
      const label = (text.match(/^      - (?:name|uses):\s*(.+)$/m) || [])[1] || block[0].trim();
      const minutes = Number((text.match(/^        timeout-minutes:\s*(\d+)\s*$/m) || [])[1]);
      return { label, minutes, text };
    }),
  };
}

test("every step of update-market-feed has its own time limit", async () => {
  const { steps } = await jobSteps("update-market-feed.yml", "update-market-feed");
  assert.ok(steps.length >= 10, `只解析到 ${steps.length} 步，解析壞了`);
  for (const step of steps) {
    assert.ok(step.minutes > 0, `「${step.label}」沒有 timeout-minutes：卡住時會一路等到 job 的上限`);
  }
  // 抓外站的每日步驟都是 continue-on-error：逾時只是那份參考資料沿用舊檔，不可以擋住行情 commit
  for (const step of steps.filter((s) => /node scripts\/(fetch-etf-holdings|seed-etf-div-history|update-tax-params|update-industry-map|update-etf-returns|update-risk-free)\.mjs/.test(s.text))) {
    assert.match(step.text, /continue-on-error:\s*true/, `「${step.label}」逾時不可以讓整班失敗`);
  }
});

test("the job limit is never smaller than the sum of its step limits", async () => {
  const { jobMinutes, steps } = await jobSteps("update-market-feed.yml", "update-market-feed");
  assert.ok(jobMinutes > 0, "job 要有 timeout-minutes，否則預設是 6 小時");
  const total = steps.reduce((sum, step) => sum + (step.minutes || 0), 0);
  // 反過來的話，每一步都還在自己的上限內，job 卻先被砍——commit 那一步根本輪不到
  assert.ok(jobMinutes >= total, `job ${jobMinutes} 分鐘 < 各步上限總和 ${total} 分鐘`);
  assert.ok(jobMinutes <= 120, `job 上限 ${jobMinutes} 分鐘太寬，等於沒設`);
});

// GitHub 的排程實測晚 4.5～10 小時（2026-10-12～11-11 每一班都是）。「0 1」那班原本只排
// 週二到週六，延遲之下它其實是當天下午的第一班——於是週一沒有當天的班，週一收盤的資料
// 要到週二 00:40 才上線。
test("the early cron also runs on Mondays", async () => {
  const yml = await readFile(new URL("../../.github/workflows/update-market-feed.yml", import.meta.url), "utf8");
  const crons = [...yml.matchAll(/^\s*- cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
  const early = crons.find((c) => /^0 1 \* \* /.test(c));
  assert.ok(early, `找不到 01:00Z 那一班：${crons.join(" | ")}`);
  const [lo, hi] = early.split(" ")[4].split("-").map(Number);
  assert.ok(lo <= 1 && hi >= 5, `「${early}」要涵蓋週一到週五`);
  // 每日步驟綁的那一班還在
  assert.ok(crons.includes("0 14 * * 1-5"), "每日步驟以字面值比對這一班，改了要一起改");
});

// 成分股是整條管線最慢、對來源最不客氣的一步（358 頁、約 5 分鐘）。原本只判斷「今天是不是週一」，
// 週一的每一班都跑一次。
test("the weekly holdings scrape is tied to a single cron", async () => {
  const { steps } = await jobSteps("update-market-feed.yml", "update-market-feed");
  const step = steps.find((s) => /fetch-etf-holdings\.mjs/.test(s.text));
  assert.ok(step, "找不到成分股那一步");
  assert.match(step.text, /github\.event\.schedule \}\}" = "15 10 \* \* 1-5"/, "要綁定單一 cron，不能只看星期");
  // 星期要從「原訂時段」推（現在往回 10 小時 15 分），不是開跑當下：排程實測晚 6～10.5 小時，
  // 直接看 UTC 星期的話再晚一點就跨日、那一週整個跳過
  assert.match(step.text, /date -u -d '615 minutes ago' \+%u\)" = "1"/, "而且只認週一 10:15Z 那個時段");
});
