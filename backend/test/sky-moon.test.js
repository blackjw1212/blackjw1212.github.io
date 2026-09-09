import test from "node:test";
import assert from "node:assert/strict";
import { angularSeparation } from "../../sky/lib/angles.mjs";
import { equatorialToHorizontal } from "../../sky/lib/coords.mjs";
import {
  illuminatedFraction, meanObliquityDeg, moonEclipticOfDate,
  moonEquatorialOfDate, moonPosition, topocentricEquatorial,
} from "../../sky/lib/moon.mjs";

// ── 基準值的來源與它到底驗到了什麼 ─────────────────────────────────────
//
// 下面的數字由 repo 外的 venv 以 pyerfa 產生（`erfa.moon98`），**一個位元組的
// pyerfa 都不進 repo**——同星表對 HYG、天文算式對 erfa 的既有模式。
//
// **要誠實說清楚這驗到的是什麼**：ERFA 自己的文件寫著 moon98 是
// "a full implementation of the algorithm published by Meeus ... except that the
// light-time correction to the Moon's mean longitude has been omitted"。
// 也就是說它跟 sky/lib/moon.mjs 實作的是**同一套** Meeus 截斷 ELP2000-82B。
// 所以這組比對驗的是**抄寫正確性**（120 個週期項有沒有抄錯），
// **不是演算法的絕對精度**。抄錯一個係數會讓殘差跳到角分等級，這條擋得住。
//
// 地心方向的殘差實測 0.83 角秒，而且是**常數**——那正好就是 moon98 拿掉的
// 光行時項（月球光行時 1.26 秒 × 每秒 0.549 角秒 ≈ 0.7 角秒）。解釋得通，不是雜訊。
//
// **絕對精度**要引 ERFA 的文件而不是自己宣稱：對現代的 ELP/MPP02，
// 1950–2100 期間 RMS 2.9 角秒、最差 18.3 角秒。相對於這一頁 2–10 度的
// heading 誤差預算，還有 400 到 2000 倍的餘裕。
//
// 站心那一組**刻意走另一條路**產生：不是用 Meeus 第 40 章的視差公式，而是在 GCRS
// 裡直接把觀測者的位置向量從月球的位置向量減掉（erfa.pvtob）。方法不同才叫獨立驗證。
const REFERENCES = [
  {
    "utc": [
      2026,
      9,
      9,
      15,
      0,
      0
    ],
    "geo": {
      "raDeg": 149.597202,
      "decDeg": 12.618942,
      "distanceKm": 371702.4
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 149.668591,
        "decDeg": 12.048733
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 148.684142,
        "decDeg": 12.714056
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 149.091024,
        "decDeg": 11.791143
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 150.075662,
        "decDeg": 12.99746
      }
    ]
  },
  {
    "utc": [
      2026,
      9,
      24,
      3,
      30,
      0
    ],
    "geo": {
      "raDeg": 332.125132,
      "decDeg": -11.413129,
      "distanceKm": 390572.4
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 332.474447,
        "decDeg": -11.615144
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 331.175261,
        "decDeg": -11.434399
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 331.673236,
        "decDeg": -12.170223
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 332.765498,
        "decDeg": -10.816628
      }
    ]
  },
  {
    "utc": [
      2027,
      1,
      1,
      0,
      0,
      0
    ],
    "geo": {
      "raDeg": 201.05498,
      "decDeg": -13.823355,
      "distanceKm": 391498.5
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 200.751775,
        "decDeg": -14.379772
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 201.996755,
        "decDeg": -13.78011
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 201.523528,
        "decDeg": -14.630952
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 200.432106,
        "decDeg": -13.432595
      }
    ]
  },
  {
    "utc": [
      2027,
      6,
      15,
      18,
      45,
      0
    ],
    "geo": {
      "raDeg": 223.32889,
      "decDeg": -21.899322,
      "distanceKm": 392691.5
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 222.415709,
        "decDeg": -22.283036
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 223.958523,
        "decDeg": -22.171616
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 223.446752,
        "decDeg": -22.814758
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 222.564853,
        "decDeg": -21.308618
      }
    ]
  },
  {
    "utc": [
      2030,
      3,
      21,
      12,
      0,
      0
    ],
    "geo": {
      "raDeg": 201.600856,
      "decDeg": -13.484081,
      "distanceKm": 363098
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 202.544219,
        "decDeg": -13.898446
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 201.210468,
        "decDeg": -13.273246
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 201.623782,
        "decDeg": -14.203752
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 202.278135,
        "decDeg": -13.055026
      }
    ]
  },
  {
    "utc": [
      2020,
      12,
      31,
      23,
      0,
      0
    ],
    "geo": {
      "raDeg": 125.324197,
      "decDeg": 23.111394,
      "distanceKm": 386610.5
    },
    "sites": [
      {
        "name": "嘉義（使用者所在）",
        "latDeg": 23.469,
        "lonDeg": 120.455,
        "elevationM": 0,
        "raDeg": 124.38969,
        "decDeg": 22.818342
      },
      {
        "name": "赤道",
        "latDeg": 0,
        "lonDeg": 0,
        "elevationM": 0,
        "raDeg": 125.987005,
        "decDeg": 23.399559
      },
      {
        "name": "高緯",
        "latDeg": 60,
        "lonDeg": 25,
        "elevationM": 100,
        "raDeg": 125.452797,
        "decDeg": 22.534884
      },
      {
        "name": "南半球",
        "latDeg": -33.9,
        "lonDeg": 151.2,
        "elevationM": 0,
        "raDeg": 124.536172,
        "decDeg": 23.475093
      }
    ]
  }
];

const msOf = ([y, mo, d, h, mi, s]) => Date.UTC(y, mo - 1, d, h, mi, s);
const ARCSEC = 1 / 3600;

// ── 星曆本體 ────────────────────────────────────────────────────────

test("the geocentric direction matches the oracle to under 1.2 arcsec", () => {
  // 門檻是量出來的，不是猜的。逐項把程式改壞、量殘差：
  //
  //     基準（未變更）              0.83 角秒   ← 常數，就是 moon98 拿掉的光行時項
  //     最後一位打錯                0.85        擋不住，但那只有 0.036 角秒，
  //                                             遠小於演算法本身 2.9 角秒的 RMS，無所謂
  //     數字顛倒 1274027→1274207    1.45        要擋
  //     漏掉離心率 E 的修正          1.59        要擋
  //     加項打錯 3958→3598          1.50        要擋
  //     漏一位數                    4070
  //     係數符號寫反                1311
  //     漏掉一整個週期項            2347
  //
  // 門檻取 1.2 角秒：擋得住上面三個「subtle」的，對基準值仍有 45% 餘裕。
  // 基準殘差是**確定性的常數**（同一套演算法、同一個被拿掉的項），不是浮動雜訊，
  // 所以這個餘裕是夠的——500 點跨 2020–2035 量下來中位／p95／最大都是 0.8。
  // 第一版門檻寫 3 角秒，上面那三個 subtle 的全部漏掉，反向測試當場抓到。
  for (const ref of REFERENCES) {
    const ours = moonEquatorialOfDate(msOf(ref.utc));
    const sep = angularSeparation(ours.raDeg, ours.decDeg, ref.geo.raDeg, ref.geo.decDeg) / ARCSEC;
    assert.ok(sep < 1.2, `${ref.utc.join("-")} 地心方向差 ${sep.toFixed(2)} 角秒`);
  }
});

test("the geocentric distance matches the oracle to under 1 km", () => {
  // 距離對係數抄錯特別敏感（Σr 那一欄），而且它與方向是兩組獨立的係數。
  for (const ref of REFERENCES) {
    const ours = moonEquatorialOfDate(msOf(ref.utc));
    const diff = Math.abs(ours.distanceKm - ref.geo.distanceKm);
    assert.ok(diff < 1, `${ref.utc.join("-")} 距離差 ${diff.toFixed(2)} km`);
  }
});

test("the topocentric correction matches an independent vector subtraction", () => {
  // 基準值是向量相減算的，我們是 Meeus 40 的公式——兩條路。實測最大 10.5 角秒，
  // 差異來自橢球常數（WGS84 vs IAU76）等細節，門檻取 30 角秒。
  for (const ref of REFERENCES) {
    const unixMs = msOf(ref.utc);
    const geo = moonEquatorialOfDate(unixMs);
    for (const site of ref.sites) {
      const ours = topocentricEquatorial({
        ...geo, latitudeDeg: site.latDeg, longitudeDeg: site.lonDeg, unixMs, elevationM: site.elevationM,
      });
      const sep = angularSeparation(ours.raDeg, ours.decDeg, site.raDeg, site.decDeg) / ARCSEC;
      assert.ok(sep < 30, `${ref.utc.join("-")} @ ${site.name} 站心差 ${sep.toFixed(1)} 角秒`);
    }
  }
});

// ── 視差的定義性檢查 ────────────────────────────────────────────────
// 這一段不靠記住的數字，靠幾何上必然成立的關係。基準值錯了它們也會紅。

test("parallax always pushes the Moon down, never up", () => {
  // 觀測者站在地表、月球在有限距離，所以站心高度**恆小於等於**地心高度。
  // 這條若反過來，多半是 rhoSinPhi 的正負號寫反了——而符號錯在數字上看不出來。
  const unixMs = Date.UTC(2026, 8, 9, 15, 0, 0);
  const geo = moonEquatorialOfDate(unixMs);
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let hour = 0; hour < 24; hour += 2) {
      const t = unixMs + hour * 3600000;
      const g = moonEquatorialOfDate(t);
      const geoAlt = equatorialToHorizontal({ ...g, latitudeDeg: lat, longitudeDeg: 0, unixMs: t }).altitudeDeg;
      const topo = topocentricEquatorial({ ...g, latitudeDeg: lat, longitudeDeg: 0, unixMs: t });
      const topoAlt = equatorialToHorizontal({ ...topo, latitudeDeg: lat, longitudeDeg: 0, unixMs: t }).altitudeDeg;
      assert.ok(topoAlt <= geoAlt + 1e-9,
        `緯度 ${lat}、第 ${hour} 小時：站心高度 ${topoAlt.toFixed(4)} 竟然高於地心 ${geoAlt.toFixed(4)}`);
    }
  }
  assert.ok(geo.distanceKm > 350000 && geo.distanceKm < 410000, "地月距離要落在合理範圍");
});

test("the parallax shift vanishes at the zenith and peaks at the horizon", () => {
  // 幾何上：月球在天頂時觀測者的位移與視線平行，位移量為 0；貼地平時最大。
  const unixMs = Date.UTC(2026, 8, 9, 15, 0, 0);
  let atZenith = null;
  let atHorizon = null;
  for (let hour = 0; hour < 24 * 30; hour += 1) {
    const t = unixMs + hour * 3600000;
    const g = moonEquatorialOfDate(t);
    // 把觀測者放在月球正下方 → 月球在天頂
    const lat = g.decDeg;
    const horizon = equatorialToHorizontal({ ...g, latitudeDeg: lat, longitudeDeg: 0, unixMs: t });
    const topo = topocentricEquatorial({ ...g, latitudeDeg: lat, longitudeDeg: 0, unixMs: t });
    const shift = angularSeparation(g.raDeg, g.decDeg, topo.raDeg, topo.decDeg);
    if (horizon.altitudeDeg > 89.5) atZenith = Math.min(atZenith ?? Infinity, shift);
    if (Math.abs(horizon.altitudeDeg) < 0.5) atHorizon = Math.max(atHorizon ?? 0, shift);
  }
  assert.ok(atZenith !== null && atHorizon !== null, "取樣要同時涵蓋天頂與地平");
  assert.ok(atZenith < 0.01, `天頂的視差位移應趨近 0，實得 ${(atZenith * 60).toFixed(2)} 角分`);
  assert.ok(atHorizon > 0.9 && atHorizon < 1.1,
    `地平的視差位移應接近地平視差（約 1 度），實得 ${atHorizon.toFixed(3)} 度`);
});

test("the parallax shift is far larger than the Moon itself", () => {
  // 這是「站心修正非做不可」的量化理由：位移約 1 度，而月面直徑只有約 0.5 度。
  // 省掉它，標記會偏將近兩個月亮寬，使用者會把它當成方位角偏差校進去。
  const moon = moonPosition({ latitudeDeg: 23.469, longitudeDeg: 120.455, unixMs: Date.UTC(2026, 8, 9, 15, 0, 0) });
  assert.ok(moon.parallaxDeg > 0.89 && moon.parallaxDeg < 1.02, `地平視差 ${moon.parallaxDeg}`);
  assert.ok(moon.semiDiameterDeg * 2 > 0.48 && moon.semiDiameterDeg * 2 < 0.57, `視直徑 ${moon.semiDiameterDeg * 2}`);
  assert.ok(moon.parallaxDeg > moon.semiDiameterDeg * 2 * 1.5,
    "地平視差必須遠大於視直徑，這是站心修正不可省的理由");
});

// ── 其他 ───────────────────────────────────────────────────────────

test("the obliquity is right for J2000 and drifts the right way", () => {
  const j2000 = meanObliquityDeg(Date.UTC(2000, 0, 1, 12, 0, 0));
  assert.ok(Math.abs(j2000 - 23.4392911) < 1e-4, `J2000 平黃赤交角實得 ${j2000}`);
  // 每世紀約減少 47 角秒。
  const later = meanObliquityDeg(Date.UTC(2100, 0, 1, 12, 0, 0));
  const dropArcsec = (j2000 - later) * 3600;
  assert.ok(dropArcsec > 46 && dropArcsec < 48, `一世紀應減少約 47 角秒，實得 ${dropArcsec.toFixed(2)}`);
});

test("the illuminated fraction stays in range and hits both extremes", () => {
  let min = 1;
  let max = 0;
  for (let day = 0; day < 60; day += 1) {
    const f = illuminatedFraction(Date.UTC(2026, 0, 1) + day * 86400000);
    assert.ok(f >= 0 && f <= 1, `照亮比例超出 0–1：${f}`);
    min = Math.min(min, f);
    max = Math.max(max, f);
  }
  // 兩個朔望月裡一定走過一次接近新月與一次接近滿月。
  assert.ok(min < 0.05, `兩個月內應出現接近新月，實得最小 ${min.toFixed(3)}`);
  assert.ok(max > 0.95, `兩個月內應出現接近滿月，實得最大 ${max.toFixed(3)}`);
});

test("moonPosition reports geometric altitude, leaving refraction to the caller", () => {
  // 與恆星那條路徑一致：頁面在畫之前才套折射。這裡若偷偷套了，月亮會比星星高一截。
  const unixMs = Date.UTC(2026, 8, 9, 15, 0, 0);
  const site = { latitudeDeg: 23.469, longitudeDeg: 120.455, unixMs };
  const moon = moonPosition(site);
  const geo = moonEquatorialOfDate(unixMs);
  const topo = topocentricEquatorial({ ...geo, ...site });
  const expected = equatorialToHorizontal({ ...topo, ...site });
  assert.ok(Math.abs(moon.altitudeDeg - expected.altitudeDeg) < 1e-9,
    "moonPosition 的高度必須是未套折射的幾何值");
});

test("the ecliptic longitude runs forward through a full circle in a month", () => {
  // 月亮每天約走 13 度。這條擋的是「引數單位寫錯」那一類——用弧度餵進去的話
  // 週期會整個跑掉，但單點數值可能還落在合理範圍。
  const start = Date.UTC(2026, 0, 1);
  const a = moonEclipticOfDate(start).longitudeDeg;
  const b = moonEclipticOfDate(start + 86400000).longitudeDeg;
  const daily = ((b - a) % 360 + 360) % 360;
  assert.ok(daily > 11 && daily < 16, `一天應走 11–16 度，實得 ${daily.toFixed(2)}`);
});
