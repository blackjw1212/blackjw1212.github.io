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
import OpenCC from "./vendor/opencc-full.js";

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

// Whisper 的中文輸出是簡繁混雜的（openai/whisper #277、#987 等多處回報），
// 不是「設定語言為繁體」就會出繁體——一定要事後轉。twp 連詞彙一起換成台灣用語。
const toTraditional = OpenCC.Converter({ from: "cn", to: "twp" });

let transcriber = null;
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

/* 官方文件的範例值是英文全名（'french'、'en'），沒有示範過兩字母的 'zh'。
   先送 'zh'，被拒再退 'chinese'——猜錯的代價只是多跑一次，猜死才是問題。 */
async function transcribeWithLanguage(model, audio) {
  const options = {
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  try {
    return await model(audio, { ...options, language: "zh" });
  } catch (error) {
    if (!/language/i.test(String(error && error.message))) throw error;
    return await model(audio, { ...options, language: "chinese" });
  }
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};

  try {
    if (data.type === "load") {
      await ensureTranscriber();
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

      const output = await transcribeWithLanguage(model, data.audio);
      warmedUp = true;
      const rawChunks = Array.isArray(output && output.chunks) ? output.chunks : [];

      // return_timestamps 理論上一定給 chunks，但拿不到時仍要有東西可匯出，
      // 不能整段吞掉——沒有時間軸的一整句，總比一片空白誠實。
      const chunks = rawChunks.length
        ? rawChunks.map((chunk) => ({
            start: Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : null,
            end: Array.isArray(chunk.timestamp) ? chunk.timestamp[1] : null,
            text: toTraditional(String(chunk.text == null ? "" : chunk.text)),
          }))
        : [{ start: 0, end: null, text: toTraditional(String((output && output.text) || "")) }];

      post({ type: "done", chunks, device: activeDevice });
      return;
    }
  } catch (error) {
    post({ type: "error", message: String((error && error.message) || error) });
  }
});
