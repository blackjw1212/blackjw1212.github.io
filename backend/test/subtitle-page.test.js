import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/* /subtitle/ 的主 script 是 classic 而不是 module，就是為了能被這裡抽出來測：
   ESM／模型／簡繁轉換全關在 subtitle/worker.js，這支測試永遠不會建 Worker，
   也就不會下載任何東西。 */
async function loadHelpers() {
  const htmlPath = fileURLToPath(new URL("../../subtitle/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "inline script should sit right before </body>");

  const window = { __SUBTITLE_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { readyState: "complete", addEventListener() {} },
    window,
    Float32Array,
    Math,
    isFinite,
    Number,
    String,
    Array,
    Object,
  });
  context.globalThis = context;
  vm.runInContext(script, context);

  assert.ok(window.SubtitleApp, "SubtitleApp should be exposed");
  return window.SubtitleApp.helpers;
}

test("formatSrtTime writes HH:MM:SS,mmm with a comma", async () => {
  const { formatSrtTime } = await loadHelpers();
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(3661.5), "01:01:01,500");
  assert.equal(formatSrtTime(59.999), "00:00:59,999");
  // 負數與 NaN 是模型偶爾會吐的東西，不能讓它變成 "-1:59:59" 這種播放器讀不懂的字串
  assert.equal(formatSrtTime(-5), "00:00:00,000");
  assert.equal(formatSrtTime(NaN), "00:00:00,000");
  assert.equal(formatSrtTime(undefined), "00:00:00,000");
});

test("normalizeChunks fills in a missing end from the next start", async () => {
  const { normalizeChunks } = await loadHelpers();
  const cues = normalizeChunks(
    [
      { start: 0, end: null, text: "第一句" },
      { start: 4, end: 6, text: "第二句" },
    ],
    30
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 4);
  assert.equal(cues[1].start, 4);
});

test("normalizeChunks falls back to the media duration for a trailing null end", async () => {
  const { normalizeChunks } = await loadHelpers();
  const cues = normalizeChunks([{ start: 2, end: null, text: "最後一句" }], 9.5);
  assert.equal(cues[0].end, 9.5);
});

test("normalizeChunks gives a zero-length cue a minimum duration", async () => {
  const { normalizeChunks, MIN_CUE_SECONDS } = await loadHelpers();
  const cues = normalizeChunks([{ start: 1, end: 1, text: "閃一下就沒了" }], 30);
  assert.equal(cues[0].end, 1 + MIN_CUE_SECONDS);
});

test("normalizeChunks drops empty text and keeps cues monotonic", async () => {
  const { normalizeChunks } = await loadHelpers();
  const cues = normalizeChunks(
    [
      { start: 0, end: 3, text: " 有內容 " },
      { start: 3, end: 5, text: "   " },
      // 模型偶爾會回頭：start 比前一句的 end 還早，直接輸出會讓播放器亂跳
      { start: 1, end: 6, text: "重疊的一句" },
    ],
    30
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "有內容");
  assert.equal(cues[1].start, 3);
  assert.ok(cues[1].end > cues[1].start);
});

test("buildSrt numbers blocks from one and separates them with a blank line", async () => {
  const { buildSrt } = await loadHelpers();
  const srt = buildSrt([
    { start: 0, end: 2.5, text: "第一句" },
    { start: 2.5, end: 4, text: "第二句" },
  ]);
  assert.equal(
    srt,
    "1\n00:00:00,000 --> 00:00:02,500\n第一句\n\n2\n00:00:02,500 --> 00:00:04,000\n第二句\n"
  );
});

test("buildSrt renumbers after skipping cues the user emptied out", async () => {
  const { buildSrt } = await loadHelpers();
  const srt = buildSrt([
    { start: 0, end: 1, text: "留著" },
    { start: 1, end: 2, text: "   " },
    { start: 2, end: 3, text: "也留著" },
  ]);
  const indexes = srt.split("\n\n").map((block) => block.split("\n")[0]);
  assert.deepEqual(indexes, ["1", "2"]);
});

test("buildSrt returns an empty string when there is nothing to export", async () => {
  const { buildSrt } = await loadHelpers();
  assert.equal(buildSrt([]), "");
  assert.equal(buildSrt(null), "");
});

test("srtFilename swaps the extension and survives odd input", async () => {
  const { srtFilename } = await loadHelpers();
  assert.equal(srtFilename("訪談 2026-09-03.mp4"), "訪談 2026-09-03.srt");
  assert.equal(srtFilename("C:\\media\\clip.wav"), "clip.srt");
  assert.equal(srtFilename(""), "subtitle.srt");
  assert.equal(srtFilename(undefined), "subtitle.srt");
});

test("describeElapsed keeps counting past a minute", async () => {
  const { describeElapsed } = await loadHelpers();
  // 只回長度，不帶「已」——同一個函式要同時給計時中的「已 12 秒」與
  // 完成後的「共 12 秒」，前綴寫死在裡面就會變成「共 已 12 秒」（實測踩過）。
  assert.equal(describeElapsed(0), "0 秒");
  assert.equal(describeElapsed(19.8), "19 秒");
  assert.equal(describeElapsed(60), "1 分 00 秒");
  assert.equal(describeElapsed(125), "2 分 05 秒");
  // 計時器每秒跑一次，拿到怪值也不能讓狀態列變成 NaN
  assert.equal(describeElapsed(-1), "0 秒");
  assert.equal(describeElapsed(NaN), "0 秒");
});

test("the first WebGPU run explains the shader compilation instead of going silent", async () => {
  const workerPath = fileURLToPath(new URL("../../subtitle/worker.js", import.meta.url));
  const worker = await readFile(workerPath, "utf8");
  // 冷跑比暖跑多約 20 秒，底層不回報任何進度。少了這句，畫面看起來就是當掉。
  assert.match(worker, /warmedUp/);
  assert.match(worker, /編譯 GPU shader/);
});

test("the page never points at a server that could receive the audio", async () => {
  const htmlPath = fileURLToPath(new URL("../../subtitle/index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  // 「檔案不會離開這台裝置」是這頁唯一的承諾。任何 fetch/XHR/form action 都是它變成
  // 謊話的路徑——靜態契約擋外部網址，這裡擋「連上傳的動作都不該存在」。
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /<form\b/);
  assert.doesNotMatch(html, /navigator\.sendBeacon/);
});

test("the worker keeps the model and the runtime on the origins we expect", async () => {
  const workerPath = fileURLToPath(new URL("../../subtitle/worker.js", import.meta.url));
  const worker = await readFile(workerPath, "utf8");
  // 自帶 36 MB 的意義全在這一行：wasm 指同源。指回 CDN 的話畫面完全一樣，
  // 只有斷網或那個 dev 版號被取消發布時才會發現。
  assert.match(worker, /\/subtitle\/vendor\/ort\/ort-wasm-simd-threaded\.asyncify\.wasm/);
  assert.match(worker, /\/subtitle\/vendor\/ort\/ort-wasm-simd-threaded\.wasm/);
  assert.doesNotMatch(worker, /cdn\.jsdelivr\.net/);
  // 模型是唯一的對外下載，而且必須是釘住的那一個
  assert.match(worker, /onnx-community\/whisper-large-v3-turbo/);
  // Whisper 的中文輸出簡繁混雜，不轉就會出簡體
  assert.match(worker, /from:\s*"cn",\s*to:\s*"twp"/);
});
