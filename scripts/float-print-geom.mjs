// 人工執行的 STL 幾何量測工具（不進 GitHub Actions、不進 .claude/verify.sh）：
// 吃一份從 Fusion 匯出的 STL，回報體積、表面積、外廓尺寸，以及「換一個列印方向，
// 懸空面會變多還是變少」。用途是替自製浮標挑列印方向與判斷哪裡需要支撐。
//
// 為什麼不進 verify.sh／CI（同 scripts/float-source-audit.mjs 的那條線）：
// 它吃的是 repo 外的使用者檔案，CI 上根本沒有那個檔，放進閘門只會變成永遠跳過的空轉。
// 純函式由 backend/test/float-print-geom.test.js 蓋著，所以邏輯仍有迴歸保護
// ——也因此這支工具必須有 isMain guard，否則那行 import 會真的去跑一次 main。
//
// **這支工具不算浮力、不猜質量。** 體積是幾何（它算得出來），質量是材料與切片參數的結果
// （Bambu Studio 自己會給預估、磅秤會給實際值）。把兩者接起來是人的事，不是這支工具的事。
// 同 CLAUDE.md「不要為了 UI 完整性製造不可驗證的連續數值」。
//
// 用法：
//   node scripts/float-print-geom.mjs model.stl            六個方向都比一遍
//   node scripts/float-print-geom.mjs model.stl --axis +z   只看一個方向

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// 六個候選列印方向。索引是軸（0=X 1=Y 2=Z），sign 是「這個軸的哪一端朝上」。
// 蛋形標要比的就是「尖端朝上／尖端朝下／側躺」，這六個涵蓋得到。
export const AXES = [
  { key: "+x", axis: 0, sign: 1 },
  { key: "-x", axis: 0, sign: -1 },
  { key: "+y", axis: 1, sign: 1 },
  { key: "-y", axis: 1, sign: -1 },
  { key: "+z", axis: 2, sign: 1 },
  { key: "-z", axis: 2, sign: -1 },
];

export function resolveMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const axisIndex = args.indexOf("--axis");
  const axisKey = axisIndex >= 0 ? (args[axisIndex + 1] || "").toLowerCase() : null;
  // 用索引排除 --axis 的值，不要拿字串去比——"+Z" 小寫化之後就對不上原字串了。
  // axisIndex 是 −1 時 axisIndex + 1 會變成 0，那會把第一個參數（通常正是檔名）排掉。
  const skip = axisIndex >= 0 ? axisIndex + 1 : -1;
  const file = args.find((a, i) => !a.startsWith("--") && i !== skip) || null;
  return { file, axis: AXES.some((a) => a.key === axisKey) ? axisKey : null };
}

// --- STL 解析 -------------------------------------------------------------

// 二進位的判法**不可以只看開頭是不是 "solid"**：有些工具產出的二進位 STL 開頭
// 也寫著 solid（那 80 bytes 是自由的 header）。唯一可靠的是長度等式。
export function isBinaryStl(buffer) {
  if (buffer.length < 84) return false;
  const count = buffer.readUInt32LE(80);
  return 84 + count * 50 === buffer.length;
}

export function parseStl(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return isBinaryStl(buf) ? parseBinaryStl(buf) : parseAsciiStl(buf.toString("utf8"));
}

function parseBinaryStl(buf) {
  const count = buf.readUInt32LE(80);
  const triangles = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = 84 + i * 50;
    // 前 12 bytes 是檔案自述的法向量。刻意不採用：很多檔案那裡是 0，或與頂點繞向矛盾。
    // 一律由頂點繞向自己算，這樣「法向量翻轉」才會真的反映在體積的正負號上。
    const v = new Array(9);
    for (let k = 0; k < 9; k += 1) v[k] = buf.readFloatLE(o + 12 + k * 4);
    triangles[i] = v;
  }
  return { format: "binary", triangles };
}

function parseAsciiStl(text) {
  const triangles = [];
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let coords = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    coords.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (coords.length === 9) {
      triangles.push(coords);
      coords = [];
    }
  }
  if (coords.length) throw new Error(`ASCII STL 的頂點數不是 3 的倍數，剩下 ${coords.length / 3} 個`);
  return { format: "ascii", triangles };
}

// --- 幾何 -----------------------------------------------------------------

function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

// 有號四面體和。閉合且繞向一致時絕對值就是體積；負值代表法向量整體朝內（繞向翻了）。
// **不取絕對值**——翻掉的網格是真的有問題，把它藏起來只會讓人拿著錯模型去印。
export function meshVolume(triangles) {
  let sum = 0;
  for (const t of triangles) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const [nx, ny, nz] = cross(bx, by, bz, cx, cy, cz);
    sum += ax * nx + ay * ny + az * nz;
  }
  return sum / 6;
}

export function meshArea(triangles) {
  let sum = 0;
  for (const t of triangles) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const [nx, ny, nz] = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
    sum += Math.hypot(nx, ny, nz) / 2;
  }
  return sum;
}

export function boundingBox(triangles) {
  if (!triangles.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (let v = 0; v < 3; v += 1) {
      for (let k = 0; k < 3; k += 1) {
        const value = t[v * 3 + k];
        if (value < min[k]) min[k] = value;
        if (value > max[k]) max[k] = value;
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// 每條邊必須剛好被兩個三角形用到。少於二＝破面，多於二＝非流形。
// 頂點用字串量化後當 key：STL 是 float32，同一個點在不同三角形裡的位元不保證相同。
export function edgeAudit(triangles, quantum = 1e-6) {
  const q = (v) => Math.round(v / quantum);
  const counts = new Map();
  for (const t of triangles) {
    const p = [0, 1, 2].map((i) => `${q(t[i * 3])},${q(t[i * 3 + 1])},${q(t[i * 3 + 2])}`);
    for (let i = 0; i < 3; i += 1) {
      const a = p[i];
      const b = p[(i + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of counts.values()) {
    if (n < 2) boundary += 1;
    else if (n > 2) nonManifold += 1;
  }
  return { edges: counts.size, boundaryEdges: boundary, nonManifoldEdges: nonManifold, closed: boundary === 0 && nonManifold === 0 };
}

// 懸空角的定義：u＝列印方向（朝上），n＝面法向量，s＝dot(n,u)。
// s ≥ 0 的面朝上或垂直，不算懸空。s < 0 的面，與「垂直」的夾角是 asin(-s)：
// 垂直牆 0°、45° 倒角 45°、水平天花板 90°。切片器的「支撐門檻 45°」比的就是這個角。
export function overhangAngle(nx, ny, nz, axis, sign) {
  const len = Math.hypot(nx, ny, nz);
  if (!len) return null;
  const s = (sign * [nx, ny, nz][axis]) / len;
  if (s >= 0) return 0;
  return (Math.asin(Math.min(1, -s)) * 180) / Math.PI;
}

export const OVERHANG_BINS = [0, 30, 45, 60, 80, 90];

export function overhangHistogram(triangles, axis, sign) {
  const bins = new Array(OVERHANG_BINS.length - 1).fill(0);
  let upright = 0;
  let total = 0;
  let needsSupport = 0;
  for (const t of triangles) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const [nx, ny, nz] = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
    const area = Math.hypot(nx, ny, nz) / 2;
    if (!area) continue;
    total += area;
    const angle = overhangAngle(nx, ny, nz, axis, sign);
    if (angle === null || angle === 0) {
      upright += area;
      continue;
    }
    for (let i = 0; i < bins.length; i += 1) {
      if (angle > OVERHANG_BINS[i] && angle <= OVERHANG_BINS[i + 1]) {
        bins[i] += area;
        break;
      }
    }
    if (angle > 45) needsSupport += area;
  }
  return { bins, upright, total, needsSupport, supportRatio: total ? needsSupport / total : 0 };
}

// 貼板面積：離床面 band 以內、而且朝下的面，投影到床面上的面積。
// 第一版只認「完全落在最低平面上」的面，實測一顆真的阿波報 0.00——它兩端都是圓角，
// 沒有任何一個面是精確的平面，但第一層高度（0.2 mm）內其實有一圈 17 mm² 的接觸環。
// 0.00 的結論（要 brim）雖然沒錯，量級卻是錯的；所以改量「第一層會壓到的那一圈」。
// band 以 STL 單位計，預設 0.2——那是假設單位是 mm，報告會把這個假設印出來。
// 只算朝下的面：band 夠大時頂面也會落進來，但頂面不會貼床。
export function firstLayerFootprint(triangles, axis, sign, band = 0.2) {
  const box = boundingBox(triangles);
  if (!box) return { area: 0, band };
  const floor = sign > 0 ? box.min[axis] : -box.max[axis];
  let area = 0;
  for (const t of triangles) {
    const h = [0, 1, 2].map((v) => sign * t[v * 3 + axis]);
    if (Math.max(...h) - floor > band) continue;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const n = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
    if (sign * n[axis] >= 0) continue;
    // 叉積長度是面積的兩倍，所以投影到垂直於列印軸的平面上就是該分量的一半。
    area += Math.abs(n[axis]) / 2;
  }
  return { area, band };
}

// 拆成彼此不相連的零件。Fusion 匯出組合件時，所有 body 會擠在同一份 STL 裡
// （實測：標身與中通管兩件），而兩件不會用同一個方向上板——混在一起算方向比較，
// 中通管的面積會把標身的懸空佔比稀釋掉（實測 +z 從 11.8% 被拉成 9.7%）。
// 頂點量化規則與 edgeAudit 相同。
export function splitComponents(triangles, quantum = 1e-6) {
  const q = (v) => Math.round(v / quantum);
  const key = (t, i) => `${q(t[i * 3])},${q(t[i * 3 + 1])},${q(t[i * 3 + 2])}`;
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const t of triangles) {
    const k = [key(t, 0), key(t, 1), key(t, 2)];
    for (const v of k) if (!parent.has(v)) parent.set(v, v);
    for (const [a, b] of [[k[0], k[1]], [k[1], k[2]]]) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map();
  for (const t of triangles) {
    const root = find(key(t, 0));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// --- 報告 -----------------------------------------------------------------

const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const n3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

export function formatReport(parsed, mode) {
  const { triangles, format } = parsed;
  const lines = [];
  lines.push(`STL：${format}，${triangles.length} 個三角形`);

  const audit = edgeAudit(triangles);
  const box = boundingBox(triangles);

  if (!box) return `${lines[0]}\n空網格，沒有東西可以量。`;

  // STL 不自述單位。不猜——同時給兩種讀法，由人對照 Fusion 裡的尺寸確認。
  lines.push("");
  lines.push("外廓（STL 單位，Fusion 匯出通常是 mm）");
  lines.push(`  X ${n2(box.size[0])}   Y ${n2(box.size[1])}   Z ${n2(box.size[2])}`);
  lines.push(`  若單位是 mm → ${n2(box.size[0])} × ${n2(box.size[1])} × ${n2(box.size[2])} mm`);
  lines.push(`  若單位是 cm → ${n2(box.size[0] * 10)} × ${n2(box.size[1] * 10)} × ${n2(box.size[2] * 10)} mm`);

  lines.push("");
  lines.push(`網格健全性：邊 ${audit.edges}，破面邊 ${audit.boundaryEdges}，非流形邊 ${audit.nonManifoldEdges}`);

  if (!audit.closed) {
    lines.push("");
    lines.push("❌ 網格不閉合，**不回報體積**。");
    lines.push("   不閉合的網格算出來的「體積」沒有意義，給一個有自信的錯數字比不給更糟。");
    lines.push("   請在 Fusion 重新匯出（提高網格精度，或先檢查模型有沒有自交／零厚度面）。");
  } else {
    const volume = meshVolume(triangles);
    if (volume < 0) {
      lines.push("");
      lines.push(`❌ 有號體積是負的（${n3(volume)}），代表整份網格的面朝內、繞向翻了。`);
      lines.push("   這種檔案切片器的行為不保證一致，請重新匯出而不是直接拿去印。");
    } else {
      lines.push("");
      lines.push("體積與表面積");
      lines.push(`  體積   ${n3(volume)} 單位³   （mm → ${n3(volume / 1000)} cm³ ／ cm → ${n3(volume)} cm³）`);
      lines.push(`  表面積 ${n2(meshArea(triangles))} 單位²`);
      // 抽殼件最容易被誤讀的一點：STL 圍出來的是殼的材料體積，不是整顆標的排水體積。
      // 兩者差一個中空腔，拿錯一個去算浮力會差好幾倍。
      lines.push("  這是**這份 STL 圍出來的實體體積**。抽殼後的件匯出來＝材料體積（殼本身），");
      lines.push("  **不是排水體積**；要排水體積請另外匯出一份未抽殼的外形。");
      lines.push("  而且體積只是幾何。質量不是——那要看材料密度與切片參數，由 Bambu Studio 預估、磅秤定案。");
    }
  }

  const parts = splitComponents(triangles);
  if (parts.length > 1) {
    lines.push("");
    lines.push(`這份 STL 有 ${parts.length} 個彼此不相連的零件（Fusion 匯出組合件時會擠在一起）。`);
    lines.push("方向比較逐件做——不同零件不會用同一個方向上板，混算會互相稀釋。");
    parts.forEach((part, i) => {
      const b = boundingBox(part);
      const closed = edgeAudit(part).closed;
      const v = closed ? `體積 ${n3(meshVolume(part))} 單位³` : "不閉合，不回報體積";
      lines.push(`  零件 #${i + 1}：${part.length} 個三角形，外廓 ${b.size.map(n2).join(" × ")}，${v}`);
    });
  }

  const axes = mode.axis ? AXES.filter((a) => a.key === mode.axis) : AXES;
  parts.forEach((part, i) => {
    lines.push("");
    const label = parts.length > 1 ? `零件 #${i + 1} ` : "";
    lines.push(`${label}列印方向比較（懸空角＝面與垂直的夾角；> 45° 是一般支撐門檻）`);
    lines.push("  朝上軸   需支撐面積佔比   0–30°    30–45°   45–60°   60–80°   80–90°   貼板面積");
    for (const a of axes) {
      const h = overhangHistogram(part, a.axis, a.sign);
      const f = firstLayerFootprint(part, a.axis, a.sign);
      const pct = (v) => `${((h.total ? v / h.total : 0) * 100).toFixed(1)}%`.padStart(7);
      lines.push(
        `  ${a.key.padEnd(8)} ${`${(h.supportRatio * 100).toFixed(1)}%`.padStart(13)}   ` +
          `${pct(h.bins[0])}  ${pct(h.bins[1])}  ${pct(h.bins[2])}  ${pct(h.bins[3])}  ${pct(h.bins[4])}  ` +
          `${n2(f.area).padStart(8)}`
      );
    }
  });
  lines.push("");
  lines.push("  貼板面積＝離床 0.2 單位以內、朝下的面的投影（假設單位是 mm，即第一層高度）。");
  lines.push("  「需支撐面積佔比」最小的那一列是懸空最少的方向，但不是唯一判準：");
  lines.push("  貼板面積太小會黏不住（要 brim／raft），支撐落在哪一面、接縫落在哪裡要另外看。");

  return lines.join("\n");
}

async function main() {
  const mode = resolveMode(process.argv.slice(2));
  if (!mode.file) {
    console.error("用法：node scripts/float-print-geom.mjs <model.stl> [--axis +z]");
    process.exitCode = 1;
    return;
  }
  const parsed = parseStl(await readFile(mode.file));
  console.log(formatReport(parsed, mode));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
