import test from "node:test";
import assert from "node:assert/strict";
import {
  orientationToMatrix, cameraAxisFromMatrix, pointingFromMatrix, orientationToPointing,
  rotationRateFromEvent, rotationRateToPointingRates,
  fuseAngleDeg, createPointingFilter,
  DEFAULT_TIME_CONSTANT_SECONDS, MAX_GAP_SECONDS,
} from "../../sky/lib/orientation.mjs";
import { normalizeHourAngle } from "../../sky/lib/angles.mjs";

const D2R = Math.PI / 180;

// 測試自己的參考實作：三個基本旋轉矩陣連乘。lib 用的是展開後的封閉形式，
// 兩者比對就抓得到代數手滑 —— 那種錯誤不會拋例外，只會讓星圖整片偏掉。
function mul(a, b) {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) {
    out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  }
  return out;
}
const rotZ = (t) => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
const rotX = (t) => [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
const rotY = (t) => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
const byProduct = (a, b, g) => mul(mul(rotZ(a * D2R), rotX(b * D2R)), rotY(g * D2R));

// Rodrigues：在本體座標下以角速度轉 dt 秒，用來做速率的數值微分檢查。
function expmBody(omegaRad, dt) {
  const v = omegaRad.map((x) => x * dt);
  const th = Math.hypot(v[0], v[1], v[2]);
  if (th < 1e-15) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = v.map((x) => x / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
    k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
    k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C,
  ];
}

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// ───────────────────────── 姿態角 → 相機指向 ─────────────────────────

test("the closed form matrix equals the triple product of the basic rotations", () => {
  const rand = seeded(20260908);
  let worst = 0;
  for (let i = 0; i < 5000; i += 1) {
    const a = rand() * 360, b = rand() * 360 - 180, g = rand() * 180 - 90;
    const mine = orientationToMatrix({ alphaDeg: a, betaDeg: b, gammaDeg: g });
    const reference = byProduct(a, b, g);
    for (let k = 0; k < 9; k += 1) worst = Math.max(worst, Math.abs(mine[k] - reference[k]));
  }
  assert.ok(worst < 1e-12, `封閉形式與連乘差 ${worst}`);
});

test("the rotation matrix stays orthonormal", () => {
  const rand = seeded(7);
  for (let i = 0; i < 500; i += 1) {
    const m = orientationToMatrix({ alphaDeg: rand() * 360, betaDeg: rand() * 360 - 180, gammaDeg: rand() * 180 - 90 });
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    assert.ok(Math.abs(det - 1) < 1e-12, `det = ${det}`);
    const axis = cameraAxisFromMatrix(m);
    const norm = Math.hypot(axis.east, axis.north, axis.up);
    assert.ok(Math.abs(norm - 1) < 1e-12, `相機軸不是單位向量：${norm}`);
  }
});

// 後鏡頭沿裝置的 -z 看出去。這張表是整個 Phase 2 的地基：接錯了，
// 後面濾波再漂亮也只是把一個錯的量平滑得很順。
test("known ways of holding the phone map to the expected pointing", () => {
  const cases = [
    { label: "平放桌面、螢幕朝上（鏡頭朝地）", alphaDeg: 0, betaDeg: 0, gammaDeg: 0, altitudeDeg: -90 },
    { label: "直立、鏡頭看北方地平線", alphaDeg: 0, betaDeg: 90, gammaDeg: 0, azimuthDeg: 0, altitudeDeg: 0 },
    { label: "直立、面向東", alphaDeg: 270, betaDeg: 90, gammaDeg: 0, azimuthDeg: 90, altitudeDeg: 0 },
    { label: "直立、面向西", alphaDeg: 90, betaDeg: 90, gammaDeg: 0, azimuthDeg: 270, altitudeDeg: 0 },
    { label: "螢幕朝下（鏡頭朝天頂）", alphaDeg: 0, betaDeg: 180, gammaDeg: 0, altitudeDeg: 90 },
    { label: "朝北抬高 45 度", alphaDeg: 0, betaDeg: 135, gammaDeg: 0, azimuthDeg: 0, altitudeDeg: 45 },
  ];
  for (const c of cases) {
    const got = orientationToPointing(c);
    assert.ok(Math.abs(got.altitudeDeg - c.altitudeDeg) < 1e-9,
      `${c.label}: 仰角 ${got.altitudeDeg} 應為 ${c.altitudeDeg}`);
    if (c.azimuthDeg !== undefined) {
      assert.ok(Math.abs(normalizeHourAngle(got.azimuthDeg - c.azimuthDeg)) < 1e-9,
        `${c.label}: 方位角 ${got.azimuthDeg} 應為 ${c.azimuthDeg}`);
    }
  }
});

// α 是繞天頂逆時針量的，方位角是順時針。直立時兩者的關係是 az = 360 - α。
// 直接把 alpha 當方位角用是這一層最常見的錯誤。
test("alpha runs the opposite way from azimuth", () => {
  for (const alphaDeg of [0, 30, 90, 180, 270, 359]) {
    const got = orientationToPointing({ alphaDeg, betaDeg: 90, gammaDeg: 0 });
    const expected = (360 - alphaDeg) % 360;
    assert.ok(Math.abs(normalizeHourAngle(got.azimuthDeg - expected)) < 1e-9,
      `α=${alphaDeg} 應對到方位角 ${expected}，實得 ${got.azimuthDeg}`);
  }
});

test("azimuth is reported as undefined when the camera looks straight up or down", () => {
  for (const betaDeg of [0, 180]) {
    const got = orientationToPointing({ alphaDeg: 37, betaDeg, gammaDeg: 0 });
    assert.equal(got.azimuthDefined, false, `β=${betaDeg} 時方位角沒有意義`);
    assert.ok(Number.isFinite(got.azimuthDeg), "即使無定義也不可以是 NaN");
  }
  assert.equal(orientationToPointing({ alphaDeg: 0, betaDeg: 90, gammaDeg: 0 }).azimuthDefined, true);
});

// roll 量的是「世界的上方落在畫面的哪個方向」，Phase 4 畫標籤時要用。
// 它與 screen.orientation.angle 是兩回事，而方位角/仰角完全不受螢幕角度影響
// ——後鏡頭光軸恆為裝置 -z。
test("roll tracks the world up direction in the image plane", () => {
  assert.ok(Math.abs(pointingFromMatrix(orientationToMatrix({ alphaDeg: 0, betaDeg: 90, gammaDeg: 0 })).rollDeg) < 1e-9,
    "直立朝北時世界上方就是畫面上方，roll = 0");
  const flatRolled = pointingFromMatrix(orientationToMatrix({ alphaDeg: 0, betaDeg: 0, gammaDeg: 30 }));
  assert.ok(Math.abs(flatRolled.rollDeg + 90) < 1e-9, `實得 ${flatRolled.rollDeg}`);
});

// ───────────────────────── 陀螺儀速率 → 指向速率 ─────────────────────────

// DeviceMotionEvent.rotationRate 的欄位名沿用 alpha/beta/gamma，但它們是
// 繞 z/x/y 的角速度 —— 與 deviceorientation 的角同名不同軸。照著名字接會把三軸接錯。
test("rotation rate event fields map onto the device axes, not onto the angle names", () => {
  const got = rotationRateFromEvent({ alpha: 1, beta: 2, gamma: 3 });
  assert.deepEqual(got, { rateXDegPerSec: 2, rateYDegPerSec: 3, rateZDegPerSec: 1 });
  assert.deepEqual(rotationRateFromEvent(null), { rateXDegPerSec: 0, rateYDegPerSec: 0, rateZDegPerSec: 0 });
  assert.deepEqual(rotationRateFromEvent({ alpha: null, beta: undefined, gamma: 5 }),
    { rateXDegPerSec: 0, rateYDegPerSec: 5, rateZDegPerSec: 0 });
});

test("analytic pointing rates match a central finite difference of the orientation", () => {
  const rand = seeded(424242);
  const dt = 1e-4;
  let worstAz = 0, worstAlt = 0, samples = 0;
  for (let i = 0; i < 3000; i += 1) {
    const alphaDeg = rand() * 360, betaDeg = rand() * 160 + 10, gammaDeg = rand() * 160 - 80;
    const rates = {
      rateXDegPerSec: rand() * 200 - 100,
      rateYDegPerSec: rand() * 200 - 100,
      rateZDegPerSec: rand() * 200 - 100,
    };
    const m = orientationToMatrix({ alphaDeg, betaDeg, gammaDeg });
    const axis = cameraAxisFromMatrix(m);
    if (Math.abs(axis.up) > 0.98) continue;   // 天頂附近另有專屬測試
    samples += 1;

    const omega = [rates.rateXDegPerSec * D2R, rates.rateYDegPerSec * D2R, rates.rateZDegPerSec * D2R];
    const ahead = pointingFromMatrix(mul(m, expmBody(omega, dt / 2)));
    const behind = pointingFromMatrix(mul(m, expmBody(omega, -dt / 2)));
    const fdAz = normalizeHourAngle(ahead.azimuthDeg - behind.azimuthDeg) / dt;
    const fdAlt = (ahead.altitudeDeg - behind.altitudeDeg) / dt;

    const got = rotationRateToPointingRates({ alphaDeg, betaDeg, gammaDeg, ...rates });
    worstAz = Math.max(worstAz, Math.abs(got.azimuthRateDegPerSec - fdAz) / Math.max(1, Math.abs(fdAz)));
    worstAlt = Math.max(worstAlt, Math.abs(got.altitudeRateDegPerSec - fdAlt) / Math.max(1, Math.abs(fdAlt)));
  }
  assert.ok(samples > 2000, `有效樣本太少：${samples}`);
  assert.ok(worstAz < 1e-4, `方位角速率相對誤差 ${worstAz}`);
  assert.ok(worstAlt < 1e-4, `仰角速率相對誤差 ${worstAlt}`);
});

test("spinning about the world vertical changes azimuth and nothing else", () => {
  // 直立時裝置 y 軸指向天頂，繞它轉就是純粹的方位角變化。
  const upright = { alphaDeg: 0, betaDeg: 90, gammaDeg: 0 };
  const yaw = rotationRateToPointingRates({ ...upright, rateXDegPerSec: 0, rateYDegPerSec: 10, rateZDegPerSec: 0 });
  assert.ok(Math.abs(yaw.azimuthRateDegPerSec + 10) < 1e-9,
    `右手定則繞天頂是逆時針，方位角順時針為正，所以應得 -10，實得 ${yaw.azimuthRateDegPerSec}`);
  assert.ok(Math.abs(yaw.altitudeRateDegPerSec) < 1e-9);

  const pitch = rotationRateToPointingRates({ ...upright, rateXDegPerSec: 10, rateYDegPerSec: 0, rateZDegPerSec: 0 });
  assert.ok(Math.abs(pitch.altitudeRateDegPerSec - 10) < 1e-9, `實得 ${pitch.altitudeRateDegPerSec}`);
  assert.ok(Math.abs(pitch.azimuthRateDegPerSec) < 1e-9);
});

test("a still phone produces no pointing rates", () => {
  const got = rotationRateToPointingRates({
    alphaDeg: 123, betaDeg: 77, gammaDeg: -14,
    rateXDegPerSec: 0, rateYDegPerSec: 0, rateZDegPerSec: 0,
  });
  assert.equal(got.azimuthRateDegPerSec, 0);
  assert.equal(got.altitudeRateDegPerSec, 0);
});

test("azimuth rate is null at the zenith where azimuth itself has no meaning", () => {
  const got = rotationRateToPointingRates({
    alphaDeg: 0, betaDeg: 180, gammaDeg: 0,
    rateXDegPerSec: 5, rateYDegPerSec: 5, rateZDegPerSec: 5,
  });
  assert.equal(got.azimuthRateDegPerSec, null, "無定義要說出來，不可回一個看起來正常的數字");
  assert.ok(Number.isFinite(got.altitudeRateDegPerSec), "仰角速率在天頂仍然有定義");
});

// ───────────────────────────── 互補濾波 ─────────────────────────────

const TAU = 0.35;

test("the first sample is taken as-is because there is nothing to blend with", () => {
  const got = fuseAngleDeg({ previousDeg: null, measuredDeg: 123.4, rateDegPerSec: 50, dtSeconds: 0.02, timeConstantSeconds: TAU });
  assert.equal(got, 123.4);
});

test("a constant measurement is approached exponentially", () => {
  let value = 0;
  const dt = 0.02;
  for (let t = 0; t < 3 * TAU; t += dt) {
    value = fuseAngleDeg({ previousDeg: value, measuredDeg: 100, rateDegPerSec: 0, dtSeconds: dt, timeConstantSeconds: TAU });
  }
  const remaining = (100 - value) / 100;
  assert.ok(Math.abs(remaining - Math.exp(-3)) < 0.01,
    `經過 3 個時間常數後應剩約 ${Math.exp(-3).toFixed(3)} 的誤差，實得 ${remaining.toFixed(3)}`);
});

// 這是整個濾波器最容易寫錯的一行。359 度與 1 度的中點是 0 度，不是 180 度。
// 直接寫 w*a + (1-w)*b 會讓使用者面向北方時畫面瞬間甩到南方。
test("blending across the 0/360 seam goes the short way round", () => {
  const got = fuseAngleDeg({ previousDeg: 359, measuredDeg: 1, rateDegPerSec: 0, dtSeconds: TAU * Math.LN2, timeConstantSeconds: TAU });
  assert.ok(Math.abs(normalizeHourAngle(got - 0)) < 1e-9, `359 與 1 的中點應是 0，實得 ${got}`);
  const other = fuseAngleDeg({ previousDeg: 1, measuredDeg: 359, rateDegPerSec: 0, dtSeconds: TAU * Math.LN2, timeConstantSeconds: TAU });
  assert.ok(Math.abs(normalizeHourAngle(other - 0)) < 1e-9, `反過來也一樣，實得 ${other}`);
});

// 感測器回呼的間隔本來就不規則（rAF 掉幀、背景分頁）。權重寫成固定的 0.98
// 會讓平滑程度隨幀率漂移；用 exp(-dt/tau) 才是真的與取樣率無關。
test("the filter gives the same answer regardless of how the interval is subdivided", () => {
  const once = fuseAngleDeg({ previousDeg: 0, measuredDeg: 90, rateDegPerSec: 0, dtSeconds: 0.1, timeConstantSeconds: TAU });
  let stepped = 0;
  for (let i = 0; i < 10; i += 1) {
    stepped = fuseAngleDeg({ previousDeg: stepped, measuredDeg: 90, rateDegPerSec: 0, dtSeconds: 0.01, timeConstantSeconds: TAU });
  }
  assert.ok(Math.abs(once - stepped) < 1e-9, `一步 ${once} vs 十步 ${stepped}`);
});

// 互補濾波與單純低通的差別就在這裡：轉頭時陀螺儀提供了預測，所以沒有穩態落後。
test("the gyro term removes the lag that a plain low pass would have", () => {
  const rate = 60, dt = 0.02;
  let fused = 0, lowPassed = 0, truth = 0;
  for (let i = 0; i < 200; i += 1) {
    truth += rate * dt;
    fused = fuseAngleDeg({ previousDeg: fused, measuredDeg: truth, rateDegPerSec: rate, dtSeconds: dt, timeConstantSeconds: TAU });
    lowPassed = fuseAngleDeg({ previousDeg: lowPassed, measuredDeg: truth, rateDegPerSec: 0, dtSeconds: dt, timeConstantSeconds: TAU });
  }
  const fusedLag = normalizeHourAngle(truth - fused);
  const lowPassLag = normalizeHourAngle(truth - lowPassed);
  assert.ok(Math.abs(fusedLag) < 1e-9, `有陀螺儀就不該有落後，實得 ${fusedLag}`);
  assert.ok(Math.abs(lowPassLag - rate * TAU) < 1.5,
    `純低通的落後應約為 速率×時間常數 = ${rate * TAU} 度，實得 ${lowPassLag}`);
});

test("measurement noise is attenuated", () => {
  const rand = seeded(99);
  const dt = 0.02;
  let value = 0, sumSq = 0, rawSumSq = 0, n = 0;
  for (let i = 0; i < 2000; i += 1) {
    const noise = (rand() - 0.5) * 6;
    value = fuseAngleDeg({ previousDeg: value, measuredDeg: noise, rateDegPerSec: 0, dtSeconds: dt, timeConstantSeconds: TAU });
    // 輸出是 [0,360) 的循環角，值在 0 附近會在 0.1 與 359.9 之間跳。
    // 量離散度必須取對 0 的最短差，直接平方會得到荒謬的結果。
    const deviation = normalizeHourAngle(value);
    if (i > 200) { sumSq += deviation * deviation; rawSumSq += noise * noise; n += 1; }
  }
  const ratio = Math.sqrt(sumSq / n) / Math.sqrt(rawSumSq / n);
  assert.ok(ratio < 0.35, `輸出雜訊應顯著低於輸入，實得比值 ${ratio.toFixed(3)}`);
});

test("a bounded angle never escapes its range", () => {
  let value = 89;
  for (let i = 0; i < 100; i += 1) {
    value = fuseAngleDeg({ previousDeg: value, measuredDeg: 90, rateDegPerSec: 100, dtSeconds: 0.02, timeConstantSeconds: TAU, cyclic: false });
    assert.ok(value >= -90 && value <= 90, `仰角跑出範圍：${value}`);
  }
});

test("nonsense filter parameters are rejected", () => {
  assert.throws(() => fuseAngleDeg({ previousDeg: 0, measuredDeg: 0, dtSeconds: 0, timeConstantSeconds: TAU }), /dtSeconds/);
  assert.throws(() => fuseAngleDeg({ previousDeg: 0, measuredDeg: 0, dtSeconds: -1, timeConstantSeconds: TAU }), /dtSeconds/);
  assert.throws(() => fuseAngleDeg({ previousDeg: 0, measuredDeg: 0, dtSeconds: 0.02, timeConstantSeconds: 0 }), /timeConstantSeconds/);
  assert.throws(() => fuseAngleDeg({ previousDeg: 0, measuredDeg: NaN, dtSeconds: 0.02, timeConstantSeconds: TAU }), /measuredDeg/);
});

// ───────────────────────────── 有狀態的包裝 ─────────────────────────────

function sample(overrides) {
  return {
    azimuthDeg: 100, altitudeDeg: 30, rollDeg: 0,
    azimuthRateDegPerSec: 0, altitudeRateDegPerSec: 0,
    timestampMs: 1000, ...overrides,
  };
}

test("the pointing filter passes the first sample through and reports the reset", () => {
  const filter = createPointingFilter();
  const first = filter.update(sample());
  assert.equal(first.azimuthDeg, 100);
  assert.equal(first.altitudeDeg, 30);
  assert.equal(first.reset, true);
  assert.equal(first.dtSeconds, null);
  const second = filter.update(sample({ timestampMs: 1020, azimuthDeg: 110 }));
  assert.equal(second.reset, false);
  assert.ok(Math.abs(second.dtSeconds - 0.02) < 1e-12);
  assert.ok(second.azimuthDeg > 100 && second.azimuthDeg < 110, `應介於兩者之間，實得 ${second.azimuthDeg}`);
});

// 分頁切走再切回來時，感測器停了幾秒而時間戳沒停。拿那段 dt 去積分陀螺儀速率
// 會把畫面甩到不知道哪裡，重新初始化才是對的。
test("a long gap re-initialises instead of integrating a stale rate", () => {
  const filter = createPointingFilter();
  filter.update(sample());
  const after = filter.update(sample({
    timestampMs: 1000 + (MAX_GAP_SECONDS + 0.5) * 1000,
    azimuthDeg: 250, azimuthRateDegPerSec: 90,
  }));
  assert.equal(after.reset, true);
  assert.equal(after.azimuthDeg, 250, "重新初始化就是直接採用當下的量測值");
});

test("duplicate or out-of-order timestamps leave the state untouched", () => {
  const filter = createPointingFilter();
  filter.update(sample());
  const held = filter.update(sample({ timestampMs: 1000, azimuthDeg: 200 }));
  assert.equal(held.azimuthDeg, 100, "重複的時間戳不可以改變狀態");
  assert.equal(held.dtSeconds, null);
  const backwards = filter.update(sample({ timestampMs: 900, azimuthDeg: 200 }));
  assert.equal(backwards.azimuthDeg, 100, "時間倒退也一樣");
});

test("a null azimuth rate is treated as no gyro information, not as an error", () => {
  const filter = createPointingFilter();
  filter.update(sample());
  const got = filter.update(sample({ timestampMs: 1020, azimuthDeg: 110, azimuthRateDegPerSec: null }));
  assert.ok(Number.isFinite(got.azimuthDeg));
  assert.ok(got.azimuthDeg > 100 && got.azimuthDeg < 110);
});

test("reset clears the state so the next sample is taken as-is", () => {
  const filter = createPointingFilter();
  filter.update(sample());
  filter.reset();
  const got = filter.update(sample({ timestampMs: 5000, azimuthDeg: 320 }));
  assert.equal(got.reset, true);
  assert.equal(got.azimuthDeg, 320);
});

test("the default time constant is documented as a starting point, not a tuned value", () => {
  assert.ok(DEFAULT_TIME_CONSTANT_SECONDS > 0 && DEFAULT_TIME_CONSTANT_SECONDS < 2);
  assert.ok(MAX_GAP_SECONDS > 0);
});
