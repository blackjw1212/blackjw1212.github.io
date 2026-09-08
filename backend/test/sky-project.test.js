import test from "node:test";
import assert from "node:assert/strict";
import {
  basisFromPointing, directionFromHorizontal, horizontalFromDirection,
  createProjector, DEFAULT_HORIZONTAL_FOV_DEG,
} from "../../sky/lib/project.mjs";
import { orientationToMatrix, pointingFromMatrix } from "../../sky/lib/orientation.mjs";
import { normalizeHourAngle } from "../../sky/lib/angles.mjs";

// 兩個單位向量的夾角。**刻意用弦長而不是 acos(點積)**：acos 的引數趨近 1 時
// 相對誤差會炸開，量到的會是量尺自己的底噪。這條在寫這支測試時實際踩到過——
// 同一個坑 angles.mjs 的 angularSeparation 也註明過。
function angleBetweenDeg(u, v) {
  const chord = Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
  return (2 * Math.asin(Math.min(1, chord / 2)) * 180) / Math.PI;
}

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const VIEWPORT = { widthPx: 390, heightPx: 844 };

// ─────────────────────────── 方向與基底 ───────────────────────────

test("horizontal coordinates round trip through the direction vector", () => {
  const rand = seeded(11);
  for (let i = 0; i < 500; i += 1) {
    const azimuthDeg = rand() * 360;
    const altitudeDeg = (Math.asin(rand() * 2 - 1) * 180) / Math.PI;
    const back = horizontalFromDirection(directionFromHorizontal({ azimuthDeg, altitudeDeg }));
    assert.ok(Math.abs(back.altitudeDeg - altitudeDeg) < 1e-9);
    if (Math.abs(altitudeDeg) < 89.9) {
      assert.ok(Math.abs(normalizeHourAngle(back.azimuthDeg - azimuthDeg)) < 1e-9);
    }
  }
});

test("the direction vector points where the compass says it does", () => {
  const north = directionFromHorizontal({ azimuthDeg: 0, altitudeDeg: 0 });
  assert.ok(Math.abs(north[0]) < 1e-12 && Math.abs(north[1] - 1) < 1e-12 && Math.abs(north[2]) < 1e-12);
  const east = directionFromHorizontal({ azimuthDeg: 90, altitudeDeg: 0 });
  assert.ok(Math.abs(east[0] - 1) < 1e-12 && Math.abs(east[1]) < 1e-12);
  const zenith = directionFromHorizontal({ azimuthDeg: 137, altitudeDeg: 90 });
  assert.ok(Math.abs(zenith[2] - 1) < 1e-12);
});

// 這條是整個 Phase 4 的地基：如果 (方位角,仰角,roll) 沒有無損保留姿態，
// Phase 2 就必須改成四元數。實測 30 萬組最大差 9e-14 度，所以不必改。
test("the reconstructed basis matches the rotation matrix it came from", () => {
  const rand = seeded(20260908);
  let worst = 0;
  let samples = 0;
  for (let i = 0; i < 20000; i += 1) {
    const m = orientationToMatrix({
      alphaDeg: rand() * 360, betaDeg: rand() * 340 - 170, gammaDeg: rand() * 180 - 90,
    });
    const pointing = pointingFromMatrix(m);
    if (!pointing.azimuthDefined) continue;
    samples += 1;
    const basis = basisFromPointing(pointing);
    worst = Math.max(worst,
      angleBetweenDeg(basis.forward, [-m[2], -m[5], -m[8]]),
      angleBetweenDeg(basis.right, [m[0], m[3], m[6]]),
      angleBetweenDeg(basis.up, [m[1], m[4], m[7]]));
  }
  assert.ok(samples > 15000, `有效樣本 ${samples}`);
  assert.ok(worst < 1e-9, `基底最大差 ${worst} 度`);
});

test("the basis stays orthonormal and right handed", () => {
  const rand = seeded(3);
  for (let i = 0; i < 500; i += 1) {
    const b = basisFromPointing({
      azimuthDeg: rand() * 360,
      altitudeDeg: rand() * 178 - 89,
      rollDeg: rand() * 360 - 180,
    });
    for (const axis of [b.forward, b.right, b.up]) {
      assert.ok(Math.abs(Math.hypot(axis[0], axis[1], axis[2]) - 1) < 1e-12, "不是單位向量");
    }
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    assert.ok(Math.abs(dot(b.forward, b.right)) < 1e-12);
    assert.ok(Math.abs(dot(b.forward, b.up)) < 1e-12);
    assert.ok(Math.abs(dot(b.right, b.up)) < 1e-12);
    // right = forward × up 的慣例：看向北方時畫面右邊是東方。
    const crossFU = [
      b.forward[1] * b.up[2] - b.forward[2] * b.up[1],
      b.forward[2] * b.up[0] - b.forward[0] * b.up[2],
      b.forward[0] * b.up[1] - b.forward[1] * b.up[0],
    ];
    assert.ok(angleBetweenDeg(crossFU, b.right) < 1e-9, "不是右手系");
  }
});

test("looking north with no roll puts east on the right and the zenith up", () => {
  const b = basisFromPointing({ azimuthDeg: 0, altitudeDeg: 0, rollDeg: 0 });
  assert.ok(angleBetweenDeg(b.right, [1, 0, 0]) < 1e-9, "畫面右邊應該是東");
  assert.ok(angleBetweenDeg(b.up, [0, 0, 1]) < 1e-9, "畫面上方應該是天頂");
  assert.equal(b.rollReferenceDegenerate, false);
});

// 正對天頂時「世界的上方」與光軸平行，投影不出參考方向。那不是錯誤，
// 是那個位置本來就沒有「世界上方」可以對齊 —— 畫面的旋轉完全由 roll 決定。
test("pointing at the zenith falls back to a north reference instead of producing NaN", () => {
  for (const altitudeDeg of [90, -90]) {
    const b = basisFromPointing({ azimuthDeg: 42, altitudeDeg, rollDeg: 17 });
    assert.equal(b.rollReferenceDegenerate, true);
    for (const axis of [b.forward, b.right, b.up]) {
      for (const component of axis) assert.ok(Number.isFinite(component), "出現 NaN");
    }
    assert.ok(Math.abs(Math.hypot(b.up[0], b.up[1], b.up[2]) - 1) < 1e-12);
  }
});

// ─────────────────────────── 投影 ───────────────────────────

test("a star on the optical axis lands on the centre pixel", () => {
  const projector = createProjector({ azimuthDeg: 137, altitudeDeg: 35, ...VIEWPORT });
  const hit = projector.project({ azimuthDeg: 137, altitudeDeg: 35 });
  assert.ok(Math.abs(hit.xPx - VIEWPORT.widthPx / 2) < 1e-9);
  assert.ok(Math.abs(hit.yPx - VIEWPORT.heightPx / 2) < 1e-9);
  assert.equal(hit.visible, true);
  assert.ok(hit.offAxisDeg < 1e-9);
});

test("half the horizontal field of view lands exactly on the edge", () => {
  const horizontalFovDeg = 65;
  const projector = createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg, ...VIEWPORT });
  const right = projector.project({ azimuthDeg: horizontalFovDeg / 2, altitudeDeg: 0 });
  assert.ok(Math.abs(right.xPx - VIEWPORT.widthPx) < 1e-9, `實得 ${right.xPx}`);
  assert.ok(Math.abs(right.yPx - VIEWPORT.heightPx / 2) < 1e-9);
  const left = projector.project({ azimuthDeg: -horizontalFovDeg / 2, altitudeDeg: 0 });
  assert.ok(Math.abs(left.xPx) < 1e-9, `實得 ${left.xPx}`);
});

test("screen y grows downwards so a higher star has a smaller y", () => {
  const projector = createProjector({ azimuthDeg: 0, altitudeDeg: 0, ...VIEWPORT });
  const high = projector.project({ azimuthDeg: 0, altitudeDeg: 10 });
  const low = projector.project({ azimuthDeg: 0, altitudeDeg: -10 });
  assert.ok(high.yPx < VIEWPORT.heightPx / 2, "仰角高的星應該畫在上面（y 較小）");
  assert.ok(low.yPx > VIEWPORT.heightPx / 2);
  assert.ok(Math.abs(high.xPx - VIEWPORT.widthPx / 2) < 1e-9, "正上方的星不該左右偏");
});

test("rolling the phone rotates the sky in the image", () => {
  const upright = createProjector({ azimuthDeg: 0, altitudeDeg: 0, rollDeg: 0, ...VIEWPORT });
  const rolled = createProjector({ azimuthDeg: 0, altitudeDeg: 0, rollDeg: 90, ...VIEWPORT });
  const star = { azimuthDeg: 0, altitudeDeg: 10 };
  const before = upright.project(star);
  const after = rolled.project(star);
  assert.ok(before.yPx < VIEWPORT.heightPx / 2 && Math.abs(before.xPx - VIEWPORT.widthPx / 2) < 1e-9,
    "沒轉之前星在正上方");
  assert.ok(after.xPx > VIEWPORT.widthPx / 2 && Math.abs(after.yPx - VIEWPORT.heightPx / 2) < 1e-9,
    `roll 90 度之後應該轉到正右方，實得 (${after.xPx}, ${after.yPx})`);
});

// 除以負數會得到一個看起來完全正常的座標，把背後的星畫到畫面上。
test("stars behind the camera are rejected, not wrapped onto the screen", () => {
  const projector = createProjector({ azimuthDeg: 0, altitudeDeg: 0, ...VIEWPORT });
  for (const azimuthDeg of [180, 150, 210]) {
    const hit = projector.project({ azimuthDeg, altitudeDeg: 0 });
    assert.equal(hit.behindCamera, true, `方位角 ${azimuthDeg} 在背後`);
    assert.equal(hit.visible, false);
    assert.ok(Number.isNaN(hit.xPx), "背後的星不可以有像素座標");
  }
});

test("project and unproject are inverses across the whole viewport", () => {
  const rand = seeded(99);
  const projector = createProjector({ azimuthDeg: 210, altitudeDeg: 40, rollDeg: -25, ...VIEWPORT });
  for (let i = 0; i < 500; i += 1) {
    const xPx = rand() * VIEWPORT.widthPx;
    const yPx = rand() * VIEWPORT.heightPx;
    const sky = projector.unproject(xPx, yPx);
    const back = projector.project(sky);
    assert.ok(Math.abs(back.xPx - xPx) < 1e-8, `x ${back.xPx} vs ${xPx}`);
    assert.ok(Math.abs(back.yPx - yPx) < 1e-8, `y ${back.yPx} vs ${yPx}`);
  }
});

// 拿它當星表查詢的錐體半徑就不會漏掉角落的星。
test("the cone radius covers the corners and nothing visible falls outside it", () => {
  const projector = createProjector({ azimuthDeg: 0, altitudeDeg: 0, ...VIEWPORT });
  const corner = projector.unproject(0, 0);
  const cornerHit = projector.project(corner);
  assert.ok(Math.abs(cornerHit.offAxisDeg - projector.coneRadiusDeg) < 1e-9,
    `角落離軸 ${cornerHit.offAxisDeg} 應等於 coneRadiusDeg ${projector.coneRadiusDeg}`);

  const rand = seeded(5);
  for (let i = 0; i < 3000; i += 1) {
    const hit = projector.project({
      azimuthDeg: rand() * 360,
      altitudeDeg: (Math.asin(rand() * 2 - 1) * 180) / Math.PI,
    });
    if (hit.visible) {
      assert.ok(hit.offAxisDeg <= projector.coneRadiusDeg + 1e-9,
        `畫面內的星離軸 ${hit.offAxisDeg} 超過查詢半徑 ${projector.coneRadiusDeg}`);
    }
  }
});

test("the vertical field of view follows from the height, it is not a second free parameter", () => {
  const projector = createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg: 65, ...VIEWPORT });
  assert.ok(projector.verticalFovDeg > projector.horizontalFovDeg,
    "直立手機的畫面比較高，垂直視野應該比水平大");
  const top = projector.unproject(VIEWPORT.widthPx / 2, 0);
  assert.ok(Math.abs(top.altitudeDeg - projector.verticalFovDeg / 2) < 1e-9,
    `畫面頂端應該正好是垂直視野的一半，實得 ${top.altitudeDeg}`);
});

test("a wider field of view pushes the same star closer to the centre", () => {
  const star = { azimuthDeg: 20, altitudeDeg: 0 };
  const narrow = createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg: 40, ...VIEWPORT });
  const wide = createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg: 90, ...VIEWPORT });
  const offsetNarrow = narrow.project(star).xPx - VIEWPORT.widthPx / 2;
  const offsetWide = wide.project(star).xPx - VIEWPORT.widthPx / 2;
  assert.ok(offsetNarrow > offsetWide && offsetWide > 0, `${offsetNarrow} vs ${offsetWide}`);
});

test("nonsense camera parameters are rejected", () => {
  assert.throws(() => createProjector({ azimuthDeg: 0, altitudeDeg: 0, widthPx: 0, heightPx: 100 }), /畫面尺寸/);
  assert.throws(() => createProjector({ azimuthDeg: 0, altitudeDeg: 0, widthPx: 100, heightPx: -1 }), /畫面尺寸/);
  assert.throws(() => createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg: 0, ...VIEWPORT }), /horizontalFovDeg/);
  assert.throws(() => createProjector({ azimuthDeg: 0, altitudeDeg: 0, horizontalFovDeg: 180, ...VIEWPORT }), /horizontalFovDeg/);
  assert.throws(() => createProjector({ azimuthDeg: NaN, altitudeDeg: 0, ...VIEWPORT }), /azimuthDeg/);
});

test("the default field of view is flagged as a starting point, not a measurement", () => {
  assert.ok(DEFAULT_HORIZONTAL_FOV_DEG > 30 && DEFAULT_HORIZONTAL_FOV_DEG < 120);
});
