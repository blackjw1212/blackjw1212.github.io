/* /subtitle/ 的辨識引擎。
 *
 * 為什麼 ML 全關在 worker 裡：
 * 1. 主執行緒跑推論會凍結整個分頁。transformers.js 自己的註解就寫著使用者可能想
 *    proxy WASM 後端「to prevent the UI from freezing」——官方所有瀏覽器端 Whisper
 *    範例（whisper-web、transformers.js-examples）都是這樣切的。
 * 2. 這頁的行內 script 必須是 classic 才抽得進 backend/test 的 vm（module script
 *    那條正則抓不到）。ESM import 全部收在這支檔案，主執行緒就能維持 classic。
 */

import { pipeline, env } from "./vendor/transformers.min.js";

// 模型從 Hugging Face 抓，本機沒有可載的副本。
env.allowLocalModels = false;

// transformers.js 預設把 ORT 的 wasm 指到 jsDelivr 上的
// onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/
// ——釘死在一個 dev 版號，那種版本有被取消發布的風險，而且斷網就沒了。
// （這裡刻意不寫出那個 CDN 網域的完整字串：靜態契約用它當「有沒有回退 CDN」的判準。）
// 改指同源的自帶副本：service worker 快取得到，離線也還在。
// 分支條件照抄 transformers.js 自己的判斷：Safari 走非 asyncify 版。
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent || "");
env.backends.onnx.wasm.wasmPaths = IS_SAFARI
  ? {
      mjs: "/subtitle/vendor/ort/ort-wasm-simd-threaded.mjs",
      wasm: "/subtitle/vendor/ort/ort-wasm-simd-threaded.wasm",
    }
  : {
      mjs: "/subtitle/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "/subtitle/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm",
    };

const MODEL = "onnx-community/whisper-large-v3-turbo";

// 翻譯模型。挑 NLLB 是因為它的目標語言清單裡有 zho_Hant——直接產繁體，
// 不必先出簡體再轉。Xenova/opus-mt-ja-zh 不存在，繞道 opus-mt 要轉兩手。
const TRANSLATION_MODEL = "Xenova/nllb-200-distilled-600M";
const TARGET_LANGUAGE = "zho_Hant";

let transcriber = null;
let translator = null;
let activeDevice = null;
// 第一次推論會先編譯 WebGPU shader，實測比之後每一次多花約 20 秒，而且這段期間
// transformers.js 不會回呼任何進度。做不出百分比，至少要讓畫面說得出「現在在幹嘛」。
let warmedUp = false;

function post(message) {
  self.postMessage(message);
}

/* transformers.js 的 device 檢查只看 `'gpu' in navigator`，不呼叫 requestAdapter()。
   有 navigator.gpu 但拿不到 adapter 的機器（Linux 驅動、虛擬機、停用 GPU）會一路
   通過檢查，等到建 session 才爆掉，錯誤訊息還看不出原因。這裡先問到 adapter 為止。 */
async function pickDevice() {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch (error) {
      // 拿不到就當作沒有，理由寫進狀態訊息即可
    }
  }
  return "wasm";
}

async function ensureTranscriber() {
  if (transcriber) return transcriber;

  // 對稱於 ensureTranslator 的釋放：翻譯過之後再辨識下一個檔案，兩個模型又會
  // 同時在記憶體裡。少了這段，第二次辨識就會 std::bad_alloc。
  if (translator) {
    await translator.dispose();
    translator = null;
  }

  activeDevice = await pickDevice();
  post({ type: "device", device: activeDevice });
  post({
    type: "status",
    stage: "loading",
    message:
      activeDevice === "webgpu"
        ? "正在下載模型（首次約數百 MB，之後由瀏覽器快取）"
        : "這台裝置沒有可用的 WebGPU，改用 WASM。GitHub Pages 送不出 COOP/COEP header，WASM 只能單執行緒，會非常慢",
  });

  transcriber = await pipeline("automatic-speech-recognition", MODEL, {
    device: activeDevice,
    // turbo 的 fp32 encoder 走 external data、將近 3 GB，不是瀏覽器該扛的東西。
    // decoder 的 fp16 在 whisper-web 的 webgpu 分支被註記為 broken，不要碰。
    dtype: { encoder_model: "q4", decoder_model_merged: "q4" },
    progress_callback: (progress) => post({ type: "progress", progress }),
  });

  post({ type: "status", stage: "ready", message: "模型就緒" });
  return transcriber;
}

/* 這裡只做聽寫，不做翻譯。
 *
 * 實測（2026-09-03，同一段 7 秒日文音檔、turbo）：
 *   指定中文     → 「森永的美味牛乳是濃烈青色的牛乳瓶 和尚在一切的泡河」
 *   指定日文     → 「森永のおいしい牛乳は濃い青色に…」（正確）
 *   translate 任務 → 仍是日文，連 Whisper 官方說的「只翻成英文」都沒發生
 *
 * （這段刻意不寫出中文語言代碼的字面形式：靜態契約用它當「有沒有又把語言寫死」的判準。）
 *
 * 也就是說對非該語言的音檔硬指定語言，Whisper 會逐音硬套成目標語言的字，
 * 產出後半段那種無意義的東西；長音檔（尤其唱歌）還會漂回原語言。
 * 所以預設不指定語言、讓它自己判斷，要覆寫由使用者從畫面上選。
 */
async function transcribe(model, audio, language) {
  const options = {
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (!language) return model(audio, options);
  try {
    return await model(audio, { ...options, language });
  } catch (error) {
    // 語言代碼不被接受時退回自動偵測，總比整批失敗好
    if (!/language/i.test(String(error && error.message))) throw error;
    return model(audio, options);
  }
}

/* 兩個模型加起來約 1.6 GB 的權重，同時常駐會爆——實測在同一個分頁裡先後建立
   Whisper 與 NLLB 的推論工作階段，直接 `std::bad_alloc`。所以翻譯前先把辨識器釋放掉，
   代價是下一次辨識要重新載入模型（權重仍在快取，但工作階段要重建）。 */
async function ensureTranslator() {
  if (translator) return translator;

  if (transcriber) {
    post({ type: "status", stage: "translating", message: "釋放辨識模型，準備載入翻譯模型" });
    await transcriber.dispose();
    transcriber = null;
  }

  post({ type: "status", stage: "translating", message: "正在下載翻譯模型（首次約 850 MB）" });
  translator = await pipeline("translation", TRANSLATION_MODEL, {
    device: activeDevice === "webgpu" ? "webgpu" : "wasm",
    dtype: "q8",
    progress_callback: (progress) => post({ type: "progress", progress }),
  });
  return translator;
}

/* 逐句翻，不是整段翻。實測把一整句長句丟給這個模型會掉半句
   （"Mr. Quilter is the apostle of the middle classes, and we are glad to welcome
   his gospel." 只回「我們很高興迎接他的福音」，放寬 max_new_tokens 也一樣），
   而 Whisper 切出來的字幕句本來就短，逐句翻反而完整。 */
async function translateChunks(chunks) {
  const model = await ensureTranslator();
  const output = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const source = chunk && chunk.source;
    if (!source) {
      output.push(chunk);
      continue;
    }
    post({ type: "translating", done: i, total: chunks.length });
    const result = await model(chunk.text, {
      src_lang: source,
      tgt_lang: TARGET_LANGUAGE,
      max_length: 512,
    });
    const text = result && result[0] && result[0].translation_text;
    output.push({ start: chunk.start, end: chunk.end, text: text || chunk.text });
  }

  post({ type: "translating", done: chunks.length, total: chunks.length });
  return output;
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};

  try {
    if (data.type === "load") {
      await ensureTranscriber();
      return;
    }

    if (data.type === "translate") {
      const translated = await translateChunks(Array.isArray(data.chunks) ? data.chunks : []);
      post({ type: "translated", chunks: translated });
      return;
    }

    if (data.type === "transcribe") {
      const model = await ensureTranscriber();
      post({
        type: "status",
        stage: "running",
        message:
          !warmedUp && activeDevice === "webgpu"
            ? "第一次辨識要先編譯 GPU shader，這段時間不會有進度"
            : "辨識中",
      });

      const output = await transcribe(model, data.audio, data.language);
      warmedUp = true;
      const rawChunks = Array.isArray(output && output.chunks) ? output.chunks : [];

      // return_timestamps 理論上一定給 chunks，但拿不到時仍要有東西可匯出，
      // 不能整段吞掉——沒有時間軸的一整句，總比一片空白誠實。
      const chunks = rawChunks.length
        ? rawChunks.map((chunk) => ({
            start: Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : null,
            end: Array.isArray(chunk.timestamp) ? chunk.timestamp[1] : null,
            text: String(chunk.text == null ? "" : chunk.text),
          }))
        : [{ start: 0, end: null, text: String((output && output.text) || "") }];

      post({ type: "done", chunks, device: activeDevice });
      return;
    }
  } catch (error) {
    post({ type: "error", message: String((error && error.message) || error) });
  }
});
