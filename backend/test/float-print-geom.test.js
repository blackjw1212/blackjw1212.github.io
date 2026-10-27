import assert from "node:assert/strict";
import test from "node:test";

import {
  AXES,
  boundingBox,
  edgeAudit,
  firstLayerFootprint,
  formatReport,
  isBinaryStl,
  meshArea,
  meshVolume,
  overhangAngle,
  overhangHistogram,
  parseStl,
  resolveMode,
  splitComponents,
} from "../../scripts/float-print-geom.mjs";

// 這支測試刻意不碰檔案系統：fixture 全部在記憶體裡生。
// scripts/float-print-geom.mjs 本身是人工工具、不進 CI，但純函式在這裡被蓋著
// ——工具不進閘門，不代表它的邏輯可以沒有迴歸保護。
// （所以那支工具必須有 isMain guard，否則上面那行 import 會真的跑一次 main。）

// 單位立方體 [0,1]³，12 個三角形，法向量一律朝外。
function unitCube() {
  const v = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], // z = 0（朝下）
    [4, 5, 6], [4, 6, 7], // z = 1（朝上）
    [0, 1, 5], [0, 5, 4], // y = 0
    [2, 3, 7], [2, 7, 6], // y = 1
    [3, 0, 4], [3, 4, 7], // x = 0
    [1, 2, 6], [1, 6, 5], // x = 1
  ];
  return faces.map(([a, b, c]) => [...v[a], ...v[b], ...v[c]]);
}

const flip = (tris) => tris.map((t) => [...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6)]);

// 球面：把八面體遞迴細分再投影到單位球上。體積應趨近 4π/3。
function sphere(depth) {
  const norm = (p) => {
    const l = Math.hypot(...p);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  const mid = (a, b) => norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  const o = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let faces = [
    [o[0], o[2], o[4]], [o[2], o[1], o[4]], [o[1], o[3], o[4]], [o[3], o[0], o[4]],
    [o[2], o[0], o[5]], [o[1], o[2], o[5]], [o[3], o[1], o[5]], [o[0], o[3], o[5]],
  ];
  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    faces = next;
  }
  return faces.map(([a, b, c]) => [...a, ...b, ...c]);
}

function toAscii(tris) {
  const body = tris
    .map((t) => `facet normal 0 0 0\n outer loop\n  vertex ${t[0]} ${t[1]} ${t[2]}\n  vertex ${t[3]} ${t[4]} ${t[5]}\n  vertex ${t[6]} ${t[7]} ${t[8]}\n endloop\nendfacet`)
    .join("\n");
  return Buffer.from(`solid test\n${body}\nendsolid test\n`, "utf8");
}

function toBinary(tris, header = "solid looks-like-ascii-but-is-not") {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(header.padEnd(80, " ").slice(0, 80), 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    for (let k = 0; k < 9; k += 1) buf.writeFloatLE(t[k], o + 12 + k * 4);
  });
  return buf;
}

test("旗標解析：檔名不會被 --axis 的值吃掉", () => {
  assert.deepEqual(resolveMode(["a.stl"]), { file: "a.stl", axis: null });
  assert.deepEqual(resolveMode(["--axis", "+z", "a.stl"]), { file: "a.stl", axis: "+z" });
  // 大寫的軸向值：小寫化之後不等於原字串，拿字串比對會把 "+Z" 當成檔名。
  assert.deepEqual(resolveMode(["m.stl", "--axis", "+Z"]), { file: "m.stl", axis: "+z" });
  assert.equal(resolveMode(["m.stl", "--axis", "nope"]).axis, null);
});

test("二進位的判法是長度等式，不是開頭的 solid", () => {
  const cube = unitCube();
  const bin = toBinary(cube);
  assert.equal(isBinaryStl(bin), true, "開頭寫 solid 的二進位檔仍必須判成二進位");
  assert.equal(isBinaryStl(toAscii(cube)), false);
  assert.equal(parseStl(bin).format, "binary");
  assert.equal(parseStl(toAscii(cube)).format, "ascii");
});

test("同一顆網格，ASCII 與二進位解出來逐值相等", () => {
  const cube = unitCube();
  const a = parseStl(toAscii(cube)).triangles;
  const b = parseStl(toBinary(cube)).triangles;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < 9; k += 1) assert.ok(Math.abs(a[i][k] - b[i][k]) < 1e-6);
  }
});

test("單位立方體：體積 1、表面積 6、外廓 1×1×1、閉合", () => {
  const cube = unitCube();
  assert.ok(Math.abs(meshVolume(cube) - 1) < 1e-12);
  assert.ok(Math.abs(meshArea(cube) - 6) < 1e-12);
  assert.deepEqual(boundingBox(cube).size, [1, 1, 1]);
  const audit = edgeAudit(cube);
  assert.equal(audit.closed, true);
  assert.equal(audit.boundaryEdges, 0);
  assert.equal(audit.nonManifoldEdges, 0);
});

test("球面細分：體積趨近 4π/3，且誤差以二階收斂", () => {
  // 內接多面體一定小於球，所以誤差是單邊的；驗「有沒有變小」太鬆，
  // 真正該釘的是收斂階數——每細分一層邊長減半，誤差應該掉成約 1/4。
  // 公式若把叉積的係數寫錯，體積仍會隨細分變大、但收斂階數就對不上了。
  const exact = (4 / 3) * Math.PI;
  const errors = [2, 3, 4, 5].map((d) => Math.abs(meshVolume(sphere(d)) - exact));
  for (let i = 1; i < errors.length; i += 1) {
    const ratio = errors[i - 1] / errors[i];
    assert.ok(ratio > 3 && ratio < 5, `收斂比應接近 4，實得 ${ratio.toFixed(2)}`);
  }
  // 實測值：細分 5 層（8,192 面）是 0.147%。門檻放在 0.2% 貼著實測，不是拍的。
  assert.ok(errors.at(-1) / exact < 0.002, "細分到第五層誤差應在 0.2% 以內");
  assert.ok(meshVolume(sphere(5)) < exact, "內接多面體必須小於球");
});

test("繞向翻掉：體積是負的，不可以靜靜取絕對值", () => {
  const flipped = flip(unitCube());
  assert.ok(Math.abs(meshVolume(flipped) + 1) < 1e-12, "翻轉後體積必須是 −1");
  assert.equal(edgeAudit(flipped).closed, true, "翻轉不影響閉合性，所以只能靠正負號發現");
  const report = formatReport({ format: "ascii", triangles: flipped }, { axis: "+z" });
  assert.match(report, /繞向翻了/);
  assert.doesNotMatch(report, /^\s*體積\s+1\.000/m, "翻轉的網格不可以報成正常體積");
});

test("破面：不閉合就不回報體積", () => {
  const broken = unitCube().slice(0, 11);
  const audit = edgeAudit(broken);
  assert.equal(audit.closed, false);
  assert.ok(audit.boundaryEdges > 0);
  const report = formatReport({ format: "ascii", triangles: broken }, { axis: "+z" });
  assert.match(report, /網格不閉合/);
  assert.doesNotMatch(report, /體積與表面積/, "破面時整個體積區塊都不該出現");
});

test("懸空角：垂直牆 0°、45° 倒角 45°、水平天花板 90°", () => {
  // axis=2（Z）、sign=+1，也就是 +Z 朝上。
  assert.equal(overhangAngle(1, 0, 0, 2, 1), 0, "法向量水平＝垂直牆");
  assert.equal(overhangAngle(0, 0, 1, 2, 1), 0, "朝上的面不是懸空");
  assert.ok(Math.abs(overhangAngle(0, 0, -1, 2, 1) - 90) < 1e-9, "朝正下方＝水平天花板");
  assert.ok(Math.abs(overhangAngle(1, 0, -1, 2, 1) - 45) < 1e-9, "45° 倒角的下表面");
  assert.ok(Math.abs(overhangAngle(0, 0, 1, 2, -1) - 90) < 1e-9, "翻成 −Z 朝上，原本朝上的面變天花板");
});

test("立方體的懸空分佈與貼板面積", () => {
  const cube = unitCube();
  const h = overhangHistogram(cube, 2, 1);
  assert.ok(Math.abs(h.total - 6) < 1e-9);
  // 四面牆垂直（面積 4）、頂面朝上（1）都不算懸空；只有底面 1 是 90° 天花板。
  assert.ok(Math.abs(h.upright - 5) < 1e-9);
  assert.ok(Math.abs(h.bins[4] - 1) < 1e-9, "80–90° 那一箱應該剛好是底面");
  assert.ok(Math.abs(h.needsSupport - 1) < 1e-9);
  assert.ok(Math.abs(h.supportRatio - 1 / 6) < 1e-9);
  // 貼板面積：z=0 的那一面，投影面積 1。
  assert.ok(Math.abs(firstLayerFootprint(cube, 2, 1).area - 1) < 1e-9);
});

test("六個候選方向都量得出來，而且對立方體是對稱的", () => {
  const cube = unitCube();
  assert.equal(AXES.length, 6);
  for (const a of AXES) {
    const h = overhangHistogram(cube, a.axis, a.sign);
    assert.ok(Math.abs(h.supportRatio - 1 / 6) < 1e-9, `${a.key} 應與其他方向相同`);
    assert.ok(Math.abs(firstLayerFootprint(cube, a.axis, a.sign).area - 1) < 1e-9);
  }
});

test("報告：單位不猜，兩種讀法都印；而且不產生任何質量數字", () => {
  const report = formatReport({ format: "binary", triangles: unitCube() }, { axis: null });
  assert.match(report, /若單位是 mm/);
  assert.match(report, /若單位是 cm/);
  assert.match(report, /列印方向比較/);
  // 抽殼件的 STL 圍出來的是材料體積，不是排水體積——拿錯一個去算浮力會差好幾倍，
  // 所以報告必須每次都把這個區別講出來。
  assert.match(report, /不是排水體積/);
  // 這支工具刻意不算質量／浮力——同 CLAUDE.md 不得製造不可驗證數值那條。
  assert.doesNotMatch(report, /\d\s*(?:g|公克|克)\b/);
  assert.doesNotMatch(report, /浮力|餘浮力|配鉛/);
});

const shift = (tris, dx) => tris.map((t) => t.map((v, k) => (k % 3 === 0 ? v + dx : v)));

test("組合件：拆成不相連的零件，各自體積正確", () => {
  // Fusion 匯出組合件時所有 body 擠在同一份 STL（實測：標身＋中通管）。
  const two = [...unitCube(), ...shift(unitCube(), 5)];
  const parts = splitComponents(two);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.equal(part.length, 12);
    assert.ok(Math.abs(meshVolume(part) - 1) < 1e-12);
  }
  assert.equal(splitComponents(unitCube()).length, 1);
});

test("組合件：報告逐件列出，方向比較也逐件做", () => {
  const two = [...unitCube(), ...shift(unitCube(), 5)];
  const report = formatReport({ format: "binary", triangles: two }, { axis: "+z" });
  assert.match(report, /2 個彼此不相連的零件/);
  assert.match(report, /零件 #1 列印方向比較/);
  assert.match(report, /零件 #2 列印方向比較/);
  // 單件時不印零件編號，避免多一層無意義的標籤。
  assert.doesNotMatch(formatReport({ format: "binary", triangles: unitCube() }, { axis: "+z" }), /零件 #/);
});

test("貼板面積只算朝下的面：band 大到涵蓋頂面時，頂面仍不算", () => {
  // 第一版只認精確落在最低平面上的面，對兩端都是圓角的真實阿波報 0.00。
  // 改成 band 之後要確認：band 再大，朝上的頂面也不會被當成貼床。
  const cube = unitCube();
  assert.ok(Math.abs(firstLayerFootprint(cube, 2, 1, 0.2).area - 1) < 1e-9);
  assert.ok(Math.abs(firstLayerFootprint(cube, 2, 1, 5).area - 1) < 1e-9, "頂面朝上，不可以算進貼板面積");
});

test("貼板面積：圓角底部在第一層高度內仍量得到接觸環", () => {
  // 球的最低點附近沒有任何精確平面，舊版會報 0；band 版必須量得到東西，
  // 而且量級要對：半徑 1 的球，離底 h 以內的球冠投影面積 = π(2h − h²)。
  const ball = sphere(5);
  const h = 0.2;
  const expected = Math.PI * (2 * h - h * h);
  const got = firstLayerFootprint(ball, 2, 1, h).area;
  assert.ok(got > 0, "圓底在第一層高度內一定有接觸面積");
  assert.ok(Math.abs(got - expected) / expected < 0.2, `應接近 ${expected.toFixed(3)}，實得 ${got.toFixed(3)}`);
});

test("空網格不會爆，也不會假裝量得到東西", () => {
  assert.equal(boundingBox([]), null);
  assert.match(formatReport({ format: "ascii", triangles: [] }, { axis: null }), /空網格/);
});
