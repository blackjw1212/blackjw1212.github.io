import test from "node:test";
/* 刻意用寬鬆版的 assert：helpers 是在 vm context 裡建的物件，
   它的 Object/Array 原型跟這個 realm 不同，deepStrictEqual 會因為
   prototype 不同一而失敗（訊息長得像「same structure but not reference-equal」）。 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PAGE_URL = new URL("../../convert/index.html", import.meta.url);

async function readPage() {
  return await readFile(fileURLToPath(PAGE_URL), "utf8");
}

/* 跟 /subtitle/ 同一套：主 script 是 classic、緊貼 </body>，純函式掛在
   ConvertApp.helpers，__CONVERT_SKIP_AUTO_INIT__ 擋掉自動初始化。
   餵進去的 globals 刻意保持最小——用得到 Blob/canvas 的東西本來就不該是純函式。 */
async function loadHelpers() {
  const html = await readPage();
  const script = html.match(/<script>((?:(?!<\/script>)[\s\S])*)<\/script>\s*<\/body>/)?.[1];
  assert.ok(script, "inline script should sit right before </body>");

  const window = { __CONVERT_SKIP_AUTO_INIT__: true };
  const context = vm.createContext({
    console,
    document: { readyState: "complete", addEventListener() {} },
    window,
    Uint8Array, Math, isFinite, Number, String, Array, Object, JSON, Error, RegExp,
  });
  context.globalThis = context;
  vm.runInContext(script, context);

  assert.ok(window.ConvertApp, "ConvertApp should be exposed");
  return window.ConvertApp.helpers;
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function ascii(text, pad = 0) {
  const out = new Uint8Array(text.length + pad);
  for (let i = 0; i < text.length; i += 1) { out[i] = text.charCodeAt(i); }
  return out;
}

test("sniffKind reads the magic bytes, not the extension", async () => {
  const h = await loadHelpers();

  // 把 HEIC 改名成 .jpg 是很常見的事（相簿匯出、通訊軟體傳檔）。
  const heic = new Uint8Array(16);
  heic.set(ascii("ftyp"), 4);
  heic.set(ascii("heic"), 8);
  assert.deepEqual(h.sniffKind("photo.jpg", heic), { kind: "heic", by: "magic" });

  assert.deepEqual(h.sniffKind("a.txt", ascii("%PDF-1.7")), { kind: "pdf", by: "magic" });
  assert.deepEqual(h.sniffKind("a.png", bytes(0xff, 0xd8, 0xff, 0xe0)), { kind: "jpeg", by: "magic" });
  assert.deepEqual(h.sniffKind("a.jpg", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    { kind: "png", by: "magic" });
  assert.deepEqual(h.sniffKind("a.bin", ascii("GIF89a")), { kind: "gif", by: "magic" });
  assert.deepEqual(h.sniffKind("a.bin", ascii("BM______")), { kind: "bmp", by: "magic" });

  const webp = new Uint8Array(16);
  webp.set(ascii("RIFF"), 0);
  webp.set(ascii("WEBP"), 8);
  assert.deepEqual(h.sniffKind("a.bin", webp), { kind: "webp", by: "magic" });

  const avif = new Uint8Array(16);
  avif.set(ascii("ftyp"), 4);
  avif.set(ascii("avif"), 8);
  assert.deepEqual(h.sniffKind("a.bin", avif), { kind: "avif", by: "magic" });

  // TIFF 的兩種位元組序：little-endian II*\0 與 big-endian MM\0*。
  assert.deepEqual(h.sniffKind("a.bin", bytes(0x49, 0x49, 0x2a, 0x00)), { kind: "tiff", by: "magic" });
  assert.deepEqual(h.sniffKind("a.bin", bytes(0x4d, 0x4d, 0x00, 0x2a)), { kind: "tiff", by: "magic" });
});

test("sniffKind falls back to the extension only for ZIP-family files", async () => {
  const h = await loadHelpers();
  const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0);

  // DOCX / XLSX / PPTX 的檔頭一模一樣，檔頭這一層分不出來。
  assert.deepEqual(h.sniffKind("report.docx", zip), { kind: "docx", by: "ext" });
  assert.deepEqual(h.sniffKind("book.xlsx", zip), { kind: "xlsx", by: "ext" });
  assert.deepEqual(h.sniffKind("deck.pptx", zip), { kind: "unknown", by: "ext" });

  // 沒有檔頭可看時才純靠副檔名。
  assert.deepEqual(h.sniffKind("data.csv", null), { kind: "csv", by: "ext" });
  assert.deepEqual(h.sniffKind("mystery.xyz", null), { kind: "unknown", by: "ext" });
});

test("每一種來源格式都有預設輸出，而且那個預設在自己的清單裡", async () => {
  const h = await loadHelpers();
  const kinds = h.IMAGE_KINDS.concat(["pdf", "docx", "xlsx", "csv"]);
  for (const kind of kinds) {
    const targets = h.targetsFor(kind);
    assert.ok(targets.length > 0, `${kind} should offer at least one target`);
    const preset = h.defaultTargetFor(kind, 1);
    assert.ok(targets.includes(preset), `${kind} 的預設輸出 ${preset} 不在自己的清單裡`);
  }
  assert.equal(h.defaultTargetFor("unknown", 1), "");
  assert.equal(h.targetsFor("unknown").length, 0);
});

test("多份 PDF 一起丟進來，預設改成合併", async () => {
  const h = await loadHelpers();
  assert.equal(h.defaultTargetFor("pdf", 1), "png");
  assert.equal(h.defaultTargetFor("pdf", 3), "pdf-merge");
});

test("每一組會失真的轉檔都必須說出它會失去什麼", async () => {
  const h = await loadHelpers();
  // 這幾組是最容易被誤以為「無損」的，頁面不講清楚就是在騙人。
  const mustWarn = [
    ["docx", "pdf"],
    ["pdf", "docx"],
    ["pdf", "txt"],
    ["png", "jpeg"],
    ["xlsx", "csv"],
    ["csv", "xlsx"],
  ];
  for (const [kind, target] of mustWarn) {
    const notes = h.notesFor(kind, target);
    assert.ok(notes.length > 0, `${kind}→${target} 沒有任何限制說明`);
  }

  const docxPdf = h.notesFor("docx", "pdf").join("\n");
  assert.match(docxPdf, /不可選取/, "DOCX→PDF 必須講明文字不可選取");
  assert.match(docxPdf, /HTML/, "DOCX→PDF 必須指出可選取文字的替代做法");

  const pdfDocx = h.notesFor("pdf", "docx").join("\n");
  assert.match(pdfDocx, /版面/, "PDF→DOCX 必須講明版面不保留");
  assert.match(pdfDocx, /沒有 OCR/, "PDF→DOCX 必須講明沒有 OCR");
});

test("optionsFor 只開該轉檔用得到的選項", async () => {
  const h = await loadHelpers();
  assert.deepEqual(h.optionsFor("png", "jpeg"), ["resize", "quality", "background"]);
  assert.deepEqual(h.optionsFor("jpeg", "png"), ["resize"]);
  assert.deepEqual(h.optionsFor("pdf", "png"), ["dpi", "pages"]);
  assert.deepEqual(h.optionsFor("pdf", "pdf-rotate"), ["pages", "rotate"]);
  assert.deepEqual(h.optionsFor("csv", "xlsx"), ["encoding"]);
  assert.deepEqual(h.optionsFor("docx", "html"), []);
});

test("fitDimensions 只縮不放，並保持長寬比", async () => {
  const h = await loadHelpers();
  assert.deepEqual(h.fitDimensions(4000, 3000, 1000), { width: 1000, height: 750 });
  assert.deepEqual(h.fitDimensions(3000, 4000, 1000), { width: 750, height: 1000 });
  // 比上限小就原樣輸出——不要把小圖放大成糊的。
  assert.deepEqual(h.fitDimensions(800, 600, 1000), { width: 800, height: 600 });
  assert.deepEqual(h.fitDimensions(800, 600, 0), { width: 800, height: 600 });
  // 極端縮放不可以縮成 0 px 的畫布。
  assert.deepEqual(h.fitDimensions(4000, 2, 10), { width: 10, height: 1 });
});

test("clampQuality 同時吃 0-1 與 0-100 兩種寫法", async () => {
  const h = await loadHelpers();
  assert.equal(h.clampQuality(92), 0.92);
  assert.equal(h.clampQuality(0.8), 0.8);
  assert.equal(h.clampQuality(500), 1);
  assert.equal(h.clampQuality(1), 1);
  assert.equal(h.clampQuality(-3), 0.1);
  assert.equal(h.clampQuality("abc"), 0.92);
});

test("parsePageRanges 看不懂就丟錯，不會默默當成全部", async () => {
  const h = await loadHelpers();
  assert.deepEqual(h.parsePageRanges("", 3), [0, 1, 2]);
  assert.deepEqual(h.parsePageRanges("1-3,5", 8), [0, 1, 2, 4]);
  assert.deepEqual(h.parsePageRanges("8-", 9), [7, 8]);
  assert.deepEqual(h.parsePageRanges("-2", 9), [0, 1]);
  // 重複與亂序都要收斂成排序去重。
  assert.deepEqual(h.parsePageRanges("3,1,3,2-3", 5), [0, 1, 2]);

  assert.throws(() => h.parsePageRanges("abc", 5), /看不懂的頁碼/);
  assert.throws(() => h.parsePageRanges("9", 5), /超出/);
  assert.throws(() => h.parsePageRanges("5-2", 9), /不合理/);
});

test("pdfTextToParagraphs 照座標分行分段", async () => {
  const h = await loadHelpers();
  // PDF 座標往上為正：y 越大越靠近頁首。
  const items = [
    { str: "第一段的", x: 72, y: 700, width: 40, height: 12 },
    { str: "第一行", x: 116, y: 700, width: 30, height: 12 },
    { str: "第一段的第二行", x: 72, y: 686, width: 70, height: 12 },
    { str: "第二段", x: 72, y: 640, width: 30, height: 12 },
  ];
  const paragraphs = h.pdfTextToParagraphs(items);
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[0], /第一段的第一行/);
  assert.match(paragraphs[0], /第一段的第二行/);
  assert.equal(paragraphs[1], "第二段");

  // 空白碎片與全空輸入不可以變成空段落。
  assert.deepEqual(h.pdfTextToParagraphs([]), []);
  assert.deepEqual(h.pdfTextToParagraphs([{ str: "   ", x: 0, y: 0, width: 5, height: 12 }]), []);
});

test("summarizeKinds 認得出混合格式", async () => {
  const h = await loadHelpers();
  const same = h.summarizeKinds([{ kind: "png" }, { kind: "png" }]);
  assert.equal(same.uniform, "png");
  const mixed = h.summarizeKinds([{ kind: "png" }, { kind: "pdf" }]);
  assert.equal(mixed.uniform, "");
  assert.deepEqual(mixed.kinds, ["png", "pdf"]);
});

test("outputName 換副檔名並清掉檔名裡不能用的字元", async () => {
  const h = await loadHelpers();
  assert.equal(h.outputName("報表 2026.docx", "pdf"), "報表 2026.pdf");
  assert.equal(h.outputName("a/b\\c:d.pdf", "png", "-p2"), "c_d-p2.png");
  assert.equal(h.outputName(".hidden", "txt"), ".hidden.txt");
});

test("頁面把限制講在使用者看得到的地方，而不是只寫在程式裡", async () => {
  const html = await readPage();
  assert.match(html, /檔案不會離開這台裝置/);
  assert.match(html, /全部運算都在瀏覽器完成/);
  assert.match(html, /不能輸出 AVIF/, "canvas 編不出 AVIF，頁面要直說");
  assert.match(html, /沒有 OCR/, "掃描檔抽不到字，頁面要直說");
  assert.match(html, /文字不可選取/, "DOCX→PDF 是圖片頁，頁面要直說");
});

test("這一頁不對外連線：沒有任何跨來源網址、也沒有自己發出的請求", async () => {
  const html = await readPage();
  const body = html.slice(html.indexOf("<body"));
  assert.doesNotMatch(body, /https?:\/\//, "頁面主體不該出現任何對外網址");
  // 檔案是使用者的，這一頁沒有任何把它送出去的路。
  assert.doesNotMatch(html, /\bfetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /sendBeacon/);
  assert.doesNotMatch(html, /<form\b/);
});

test("vendor 走同源相對路徑，不是 CDN", async () => {
  const html = await readPage();
  assert.match(html, /var VENDOR = "\/convert\/vendor\/";/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.doesNotMatch(html, /unpkg\.com/);
});
