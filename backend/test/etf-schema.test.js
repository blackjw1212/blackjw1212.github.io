// 資料層 Schema 驗證：確保 pipeline 產出的 JSON 結構與型別穩定。
// 這取代 TypeScript 介面的角色——本 repo 無 TS 工具鏈，用執行期驗證達成同一目的：
// 擋住壞資料進入前端與最佳化器。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classifyEtf, cvWindowAmounts, dividendCv, isCoreEtf } from "../../scripts/update-etf-feed.mjs";

const readJson = async (rel) => JSON.parse(await readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const optNum = (v) => v == null || isNum(v);

// 上游一個市場中斷就整批消失，是 2026-07-28 實際發生的事故（ETF 348→231、個股上櫃 853→0）。
// 逐市場下限比「總筆數下限」更有意義：總數掉一半才會觸發，掉一個市場往往還在門檻之上。
const assertBothMarkets = (rows, label, floors) => {
  const byMarket = rows.reduce((acc, row) => ({ ...acc, [row.market]: (acc[row.market] || 0) + 1 }), {});
  assert.ok(byMarket.twse >= floors.twse, `${label}: 上市只剩 ${byMarket.twse || 0} 檔（下限 ${floors.twse}）——上游中斷未被保留？`);
  assert.ok(byMarket.tpex >= floors.tpex, `${label}: 上櫃只剩 ${byMarket.tpex || 0} 檔（下限 ${floors.tpex}）——上游中斷未被保留？`);
};

test("market-feed.json matches the expected schema", async () => {
  const feed = await readJson("../../data/market-feed.json");
  assert.match(feed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feed.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(feed.tradeDate <= new Date().toISOString().slice(0, 10), "交易日不得在未來");
  assert.ok(Array.isArray(feed.stocks) && feed.stocks.length >= 1500, `expected 1500+ stocks, got ${feed.stocks.length}`);
  assert.equal(feed.count, feed.stocks.length);
  assert.ok(Array.isArray(feed.errors));
  assertBothMarkets(feed.stocks, "market-feed", { twse: 800, tpex: 500 });

  // 估值日：PE/PB/殖利率的分母是股價，來源比收盤晚一天發佈是常態，
  // 所以 feed 必須說得出這些欄位是哪一天的，不能讓人以為＝tradeDate。
  assert.match(feed.valuationDate, /^\d{4}-\d{2}-\d{2}$/, "valuationDate 必須存在且為 ISO 日期");
  assert.ok(feed.valuationDate <= new Date().toISOString().slice(0, 10), "估值日不得在未來");
  assert.equal(typeof feed.valuationDates, "object");
  for (const market of Object.keys(feed.valuationDates)) {
    assert.ok(market === "twse" || market === "tpex", `valuationDates 只該有 twse/tpex，出現 ${market}`);
    assert.match(feed.valuationDates[market], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(feed.valuationDate <= feed.valuationDates[market], "valuationDate 應為各市場的最舊者");
  }
  // 落差要**逐市場**判斷。只比 valuationDate 與 tradeDate 會漏報：兩者都取最小值，
  // 當 TWSE 收盤比 TPEX 新時最小值會相等，但上市那千餘檔的落差是真的。
  // 這裡不斷言「估值日必定 ≤ 收盤日」——TPEX 收盤保留舊值而估值抓到新的時，
  // 反向落差也會發生，那同樣是要被揭露的事實，不是解析錯誤。
  for (const market of Object.keys(feed.valuationDates)) {
    if (!feed.marketDates || !feed.marketDates[market]) continue;
    if (feed.valuationDates[market] === feed.marketDates[market]) continue;
    assert.ok(
      feed.errors.some((e) => e && e.source === "stale-valuation" && e.market === market),
      `${market} 的估值日 ${feed.valuationDates[market]} 與收盤日 ${feed.marketDates[market]} 不一致時必須寫進 errors[]`,
    );
  }

  const codes = new Set();
  for (const row of feed.stocks) {
    const at = (msg) => `${row.code}: ${msg}`;
    assert.match(row.code, /^\d{4}[A-Z]?$/, at("code shape"));
    assert.ok(!codes.has(row.code), at("duplicate code"));
    codes.add(row.code);
    assert.equal(typeof row.name, "string", at("name"));
    assert.ok(row.market === "twse" || row.market === "tpex", at("market"));
    // close = 0 曾被當成價格寫入（9110），會讓漲跌幅與估值除以零
    assert.ok(isNum(row.close) && row.close > 0, at("close must be a positive number"));
    for (const key of ["change", "open", "high", "low", "volume", "pe", "dividendYield", "pbRatio", "hi52", "lo52", "fromHi"]) {
      assert.ok(optNum(row[key]), at(`${key} must be a number or absent`));
    }
    if (isNum(row.hi52) && isNum(row.lo52)) assert.ok(row.hi52 >= row.lo52, at("52w high must not sit below the low"));
  }
});

test("etf-feed.json matches the expected schema", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  assert.match(feed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(feed.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(feed.tradeDate <= new Date().toISOString().slice(0, 10), "交易日不得在未來");
  assert.ok(Array.isArray(feed.stocks) && feed.stocks.length >= 300, `expected 300+ ETFs, got ${feed.stocks.length}`);
  assert.equal(feed.count, feed.stocks.length);
  assert.ok(Array.isArray(feed.errors));
  assertBothMarkets(feed.stocks, "etf-feed", { twse: 150, tpex: 80 });

  const codes = new Set();
  for (const row of feed.stocks) {
    const at = (msg) => `${row.code}: ${msg}`;
    assert.match(row.code, /^00\d{2,4}[A-Z]?$/, at("code shape"));
    assert.ok(!codes.has(row.code), at("duplicate code"));
    codes.add(row.code);
    assert.equal(typeof row.name, "string", at("name"));
    assert.ok(row.market === "twse" || row.market === "tpex", at("market"));
    assert.ok(isNum(row.close) && row.close > 0, at("close must be a positive number"));
    for (const key of ["change", "volume", "nav", "discountPremium", "aum", "yield", "expenseRatio", "divMonthsCovered", "dividendCv", "yieldEstimated"]) {
      assert.ok(optNum(row[key]), at(`${key} must be a number or absent`));
    }
    // 推估與實績互斥：有完整年度實績就不該再掛推估值，否則畫面會二選一失準
    if (row.yieldEstimated != null) {
      assert.equal(row.yield, null, at("an estimate must only exist where there is no full-year yield"));
      assert.ok(row.yieldBasis && isNum(row.yieldBasis.events) && isNum(row.yieldBasis.months),
        at("an estimate must carry its basis"));
      assert.ok(row.yieldBasis.events >= 2 && row.yieldBasis.months >= 6, at("estimate basis too thin"));
    }
    assert.ok(typeof row.hasHoldingsData === "boolean", at("hasHoldingsData must be a boolean flag"));
    assert.ok(typeof row.isCore === "boolean", at("isCore must be a boolean flag"));
    assert.ok(typeof row.isActive === "boolean", at("isActive must be a boolean flag"));
    assert.ok(!(row.isActive && row.isCore), at("an actively managed fund must never be flagged core"));
    if (row.dps != null) {
      assert.ok(Array.isArray(row.dps), at("dps array"));
      for (const event of row.dps) {
        assert.ok(isNum(event.m) && event.m >= 1 && event.m <= 12, at("dps month in 1..12"));
        assert.ok(isNum(event.a) && event.a > 0, at("dps amount positive"));
      }
    }
    if (row.payMonths != null) {
      assert.ok(Array.isArray(row.payMonths), at("payMonths array"));
      row.payMonths.forEach((m) => assert.ok(isNum(m) && m >= 1 && m <= 12, at("payMonth in 1..12")));
    }
    if (row.topHoldings != null) {
      assert.ok(Array.isArray(row.topHoldings) && row.topHoldings.length <= 10, at("topHoldings <= 10"));
      let sum = 0;
      for (const holding of row.topHoldings) {
        assert.equal(typeof holding.name, "string", at("holding name"));
        assert.ok(isNum(holding.weight) && holding.weight > 0 && holding.weight <= 100, at("holding weight 0..100"));
        sum += holding.weight;
      }
      assert.ok(sum <= 100.01, at(`top holdings sum ${sum.toFixed(2)} exceeds 100%`));
      assert.match(row.holdingsAsOf || "", /^\d{4}-\d{2}-\d{2}$/, at("holdingsAsOf ISO date"));
      assert.ok(row.holdingsSource, at("holdings must carry a source attribution"));
      // 成分股是月頻揭露，資料日必為過去；未來日代表來源解析錯誤
      assert.ok(row.holdingsAsOf <= new Date().toISOString().slice(0, 10), at("holdingsAsOf must not be in the future"));
    }
  }
});

test("derived fields agree with the pipeline's own formulas", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  let checkedCv = 0;
  let checkedCore = 0;
  // CV 的窗（24 月）比 dps 的窗（12 月）長，所以不能用 dps 回推。
  // 改為從版控中的配息歷史重算——這是真正的端到端一致性檢查。
  const history = await readJson("../../data/etf-div-history.json");
  for (const row of feed.stocks) {
    const expectedCv = dividendCv(cvWindowAmounts(history.stocks[row.code], feed.tradeDate));
    if (expectedCv == null) {
      assert.equal(row.dividendCv, undefined, `${row.code}: cv must be absent when it cannot be computed`);
    } else {
      assert.equal(row.dividendCv, expectedCv, `${row.code}: stored cv drifted from the formula`);
      checkedCv += 1;
    }
    // 波動度必須真的用比殖利率更長的窗，否則這次改動等於沒生效
    const window = cvWindowAmounts(history.stocks[row.code], feed.tradeDate);
    if (row.dps && row.dps.length) {
      assert.ok(window.length >= row.dps.length, `${row.code}: CV 窗不得短於 dps 窗`);
    }
    assert.equal(row.isCore, isCoreEtf(row), `${row.code}: stored isCore drifted from the rule`);
    if (row.isCore) checkedCore += 1;
    assert.equal(row.hasHoldingsData, Boolean(row.topHoldings && row.topHoldings.length), `${row.code}: hasHoldingsData drifted`);
  }
  assert.ok(checkedCv > 50, `expected many ETFs with a CV, got ${checkedCv}`);
  assert.ok(checkedCore >= 1, "at least one core ETF must be flagged");
});

test("known ETFs land in the expected quality bands", async () => {
  const feed = await readJson("../../data/etf-feed.json");
  const by = Object.fromEntries(feed.stocks.map((row) => [row.code, row]));

  // 大型市值型必須被標為核心（0050 殖利率最低，純殖利率排序永遠看不到它）
  assert.equal(by["0050"].isCore, true, "0050 must be flagged core");
  assert.equal(by["006208"].isCore, true, "006208 must be flagged core");
  // 長天期債 ETF 不得佔走核心位置
  assert.equal(by["00679B"].isCore, false, "a bond ETF must never be core");
  // 槓反／期貨／外幣計價原本只是「剛好沒有配息紀錄」才沒被標成核心；
  // 00631L 規模 2,188億，一次配息就會誤標，必須由規則而非巧合擋住
  assert.equal(by["00631L"].isCore, false, "a leveraged ETF must never be core");
  assert.equal(isCoreEtf({ ...by["00631L"], aum: 2188, yield: 2, isActive: false }), false,
    "even with a qualifying size and yield, 槓桿反向 must stay out of core");
  for (const type of ["期貨型", "外幣計價", "債券型"]) {
    assert.equal(isCoreEtf({ type, aum: 5000, yield: 2, isActive: false, code: "0000", name: "x" }), false, `${type} must never be core`);
  }

  // 穩定配息者 CV 落在安全區、劇烈者被標出來
  // 後綴家族分類（先前 29 檔 A 全被誤歸主題型並已進入產生器候選池）。
  // 直接測純函式：綁 feed 裡的特定代碼會在該檔當日無成交時假性失敗——
  // 00625K 就因為 2026-07-29 沒有成交、收盤為 "--" 被正確剔除而弄倒過這條測試。
  assert.equal(classifyEtf("00403A", "野村臺灣新科技50"), "主動型");
  assert.equal(classifyEtf("00981T", "統一台灣高息動能平衡"), "平衡型");
  assert.equal(classifyEtf("00625K", "富邦上證180+R"), "外幣計價");
  assert.equal(classifyEtf("00840B", "凱基美國非投等債"), "債券型", "IG/非投等債即使名稱沒有『債』字也要歸債券型");
  assert.equal(classifyEtf("00981D", "主動統一台股增長"), "主動型");
  assert.equal(classifyEtf("00631L", "元大台灣50正2"), "槓桿反向");
  assert.equal(classifyEtf("00682U", "元大美元指數"), "期貨型");

  // feed 端只檢查「這些型別確實存在且旗標一致」，不綁單一代碼
  const activeFunds = feed.stocks.filter((row) => row.isActive);
  assert.ok(activeFunds.length >= 20, `expected the active family to be populated, got ${activeFunds.length}`);
  assert.equal(activeFunds.every((row) => row.isCore === false), true, "主動型一律不得為核心");
  for (const type of ["主動型", "債券型", "槓桿反向", "高股息", "市值型"]) {
    assert.ok(feed.stocks.some((row) => row.type === type), `feed 應涵蓋 ${type}`);
  }

  // 波動度改看 24 個月後的實際落點（與 Yahoo 2 年資料獨立算過、逐檔相符）。
  // 大型穩配標的仍在安全區——核心部位不會因為換窗而消失：
  assert.ok(by["0050"].dividendCv < 0.6, `0050 cv ${by["0050"].dividendCv} should be safe`);
  assert.ok(by["0056"].dividendCv < 0.3, `0056 cv ${by["0056"].dividendCv} should be very safe`);
  assert.ok(by["00878"].dividendCv < 0.3, `00878 cv ${by["00878"].dividendCv} should be very safe`);
  assert.ok(by["00919"].dividendCv < 0.3, `00919 cv ${by["00919"].dividendCv} should be very safe`);
  // 006208 的配息由 0.989 跳到 4.75。12 個月窗只看到 4.75 那一段而算出 0.16，
  // 24 個月窗才看得到跳升（0.65）。這是刻意的行為改變：本工具用近 12 月配息推估
  // 未來年配息，水準跳升正是該被標出來的推估風險，不是「誤殺成長股」。
  assert.ok(by["006208"].dividendCv > 0.6, `006208 cv ${by["006208"].dividendCv} should now surface the level shift`);
  assert.ok(by["00905"].dividendCv > 0.6, `00905 cv ${by["00905"].dividendCv} should be flagged volatile`);
});

test("curated domicile entries carry evidence and reach the feed", async () => {
  const staticData = await readJson("../../data/etf-static.json");
  const feed = await readJson("../../data/etf-feed.json");
  const by = Object.fromEntries(feed.stocks.map((row) => [row.code, row]));

  const curated = Object.entries(staticData.etfs).filter(([, v]) => typeof v.domesticRatio === "number");
  assert.ok(curated.length >= 3, `expected curated domicile entries, got ${curated.length}`);
  for (const [code, entry] of curated) {
    assert.ok(entry.domesticRatio >= 0 && entry.domesticRatio <= 1, `${code}: ratio 必須在 0..1`);
    // 人工判定一定要留下依據與日期，否則沒人敢動它、也無從複查
    assert.ok(entry.domicileBasis && entry.domicileBasis.length > 20, `${code}: 必須寫明判定依據`);
    assert.match(entry.domicileAsOf || "", /^\d{4}-\d{2}-\d{2}$/, `${code}: 必須有資料日`);
    if (by[code]) assert.equal(by[code].domesticRatio, entry.domesticRatio, `${code}: 人工值必須進到 feed`);
  }

  // 沒建表的標的不得被寫入這個欄位——前端要靠 undefined 才會回退到名稱推定，
  // 若誤寫成 0 等於讓全市場配息變免稅
  const uncurated = feed.stocks.filter((row) => row.domesticRatio != null && !staticData.etfs[row.code]);
  assert.deepEqual(uncurated.map((r) => r.code), [], "只有人工表裡的標的可以有 domesticRatio");
});

test("holdings expose overseas funds the name cannot reveal", async () => {
  // 這條是「表格別腐爛」的護欄：只要成分股顯示某檔幾乎全是外國公司，
  // 但名稱推定又認定它是國內、且沒有人工建表，就要當場失敗提醒補表。
  // 00712 復華富時不動產就是這樣被抓出來的——中文譯名（安納利資本管理公司…）
  // 完全看不出那是美國 REITs。
  const feed = await readJson("../../data/etf-feed.json");
  const staticData = await readJson("../../data/etf-static.json");
  const OVERSEAS = /美國|北美|美債|NASDAQ|那斯達克|S&P|標普|費城|全球|世界|歐洲|日本|韓|印度|越南|中國|陸股|滬深|新興|已開發|成熟市場|亞太|東協|德國|英國|加拿大|澳洲|巴西|港股|新加坡/i;
  // 外國公司的線索：拉丁字母，或中文譯名常見的公司型態後綴
  const looksForeign = (name) => /[A-Za-z]{3,}/.test(name)
    || /資本管理公司|投資公司|資產信託|不動產投資信託公司|抵押信託|房產基金|環球公司|數位公司/.test(name);

  const missing = [];
  for (const row of feed.stocks) {
    if (!row.topHoldings || row.topHoldings.length < 5) continue;
    if (row.domesticRatio != null || staticData.etfs[row.code]) continue;   // 已建表
    if (row.type === "債券型" || row.type === "外幣計價") continue;             // 型別已判定
    if (OVERSEAS.test(row.name)) continue;                                  // 名稱已看得出來
    // 不配息的標的產生不出應稅所得，判定它的來源地沒有意義——
    // 硬要建表只會養出一張沒人維護得動的表
    if (!(row.dps && row.dps.length)) continue;
    const foreignWeight = row.topHoldings.filter((h) => looksForeign(h.name))
      .reduce((sum, h) => sum + h.weight, 0);
    const total = row.topHoldings.reduce((sum, h) => sum + h.weight, 0);
    if (total > 0 && foreignWeight / total > 0.7) {
      missing.push(`${row.code} ${row.name}（前十大外國成分 ${Math.round(foreignWeight / total * 100)}%）`);
    }
  }
  assert.deepEqual(missing, [],
    `這些標的的成分股看起來是海外，但名稱推定會當成國內全額應稅——請在 etf-static.json 補 domesticRatio：\n  ${missing.join("\n  ")}`);
});

test("tax params carry their source and stay internally consistent", async () => {
  const params = await readJson("../../data/tax-params.json");
  assert.equal(params.rocYear, 115, "115 年度＝2026 年所得，正是模擬對象");
  assert.ok(Array.isArray(params.sources) && params.sources.length, "稅率數字必須附出處");
  assert.ok(params.sources.every((s) => /^https:\/\//.test(s.url)), "出處要是可查證的連結");

  // 級距必須遞增、最後一級無上限，否則速算公式會選錯級距
  const ups = params.brackets.map((b) => b.upTo);
  assert.equal(ups[ups.length - 1], null, "最高級距不得有上限");
  const finite = ups.slice(0, -1);
  assert.deepEqual(finite, [...finite].sort((a, b) => a - b), "級距上緣必須遞增");
  assert.deepEqual(finite, [610000, 1380000, 2770000, 5190000]);

  // 累進差額的定義性檢查：在每個交界點，速算結果必須等於下一級距算出來的同一個數。
  // 這條會擋住「抄錯一個累進差額」——那種錯誤肉眼很難看出來。
  const quick = (net) => {
    for (const band of params.brackets) {
      if (band.upTo == null || net <= band.upTo) return net * band.rate - band.quickDeduction;
    }
    return 0;
  };
  for (let i = 0; i < params.brackets.length - 1; i += 1) {
    const edge = params.brackets[i].upTo;
    const next = params.brackets[i + 1];
    assert.ok(Math.abs(quick(edge) - (edge * next.rate - next.quickDeduction)) < 0.01,
      `級距 ${edge} 的交界處兩式不相等——累進差額抄錯了`);
  }
  assert.equal(Math.round(quick(610000)), 30500, "對照財政部速算表");
  assert.equal(Math.round(quick(5190000)), 1126900);

  assert.equal(params.dividend.creditRate, 0.085);
  assert.equal(params.dividend.creditCap, 80000);
  assert.equal(params.dividend.separateRate, 0.28);
  // 免稅額＋標準扣除＋薪資特扣，UI 用它當「年薪 −N」的提示
  const d = params.deductions;
  assert.equal(d.personalExemption + d.standardDeduction + d.salarySpecialDeduction, d.singleStandardThreshold);
});

test("the inline tax fallback never drifts from data/tax-params.json", async () => {
  // 頁面在載不到 JSON 時要能算稅，所以內建了一份備援。兩份各改一邊就會給出不同稅額，
  // 而使用者不會知道自己看到的是哪一份——這條測試就是為了讓分叉當場失敗。
  const params = await readJson("../../data/tax-params.json");
  const html = await readFile(fileURLToPath(new URL("../../market/index.html", import.meta.url)), "utf8");
  const block = html.slice(html.indexOf("const TAX_FALLBACK = {"), html.indexOf("let taxParams"));
  assert.ok(block, "找不到內建備援");

  assert.match(block, new RegExp(`rocYear:${params.rocYear}\\b`));
  for (const band of params.brackets) {
    const upTo = band.upTo == null ? "null" : String(band.upTo);
    assert.ok(block.includes(`{upTo:${upTo}, rate:${band.rate}, quickDeduction:${band.quickDeduction}}`),
      `備援缺少級距 upTo=${upTo} rate=${band.rate} quickDeduction=${band.quickDeduction}`);
  }
  assert.ok(block.includes(`creditRate:${params.dividend.creditRate}`));
  assert.ok(block.includes(`creditCap:${params.dividend.creditCap}`));
  assert.ok(block.includes(`separateRate:${params.dividend.separateRate}`));
  assert.ok(block.includes(`singleStandardThreshold:${params.deductions.singleStandardThreshold}`));
});

test("the rate table is parsed by label and self-validated before it can overwrite", async () => {
  const { parseRateTables, validateBrackets, sameBrackets } = await import("../../scripts/update-tax-params.mjs");
  // 取自台北國稅局「適用稅率」頁的真實結構：年度標籤在表格前，表格是真的 <table>
  const table = (rows) => `<table><tbody>
    <tr><th>級距</th><th>綜合所得淨額</th><th>乘法</th><th>稅率</th><th>減法</th><th>累進差額</th><th>等於</th><th>全年應納稅額</th></tr>
    ${rows.map(([r, rate, qd], i) => `<tr><td>${i + 1}</td><td>${r}</td><td>×</td><td>${rate}</td><td>－</td><td>${qd}</td><td>=</td><td></td></tr>`).join("")}
  </tbody></table>`;
  const html = `<p>► 115年度累進稅率：</p>${table([
    ["0~610,000", "5%", "0"], ["610,001~1,380,000", "12%", "42,700"], ["1,380,001~2,770,000", "20%", "153,100"],
    ["2,770,001~5,190,000", "30%", "430,100"], ["5,190,001以上", "40%", "949,100"]])}
    <p>► 113至114年度累進稅率：</p>${table([
    ["0~590,000", "5%", "0"], ["590,001~1,330,000", "12%", "41,300"], ["1,330,001~2,660,000", "20%", "147,700"],
    ["2,660,001~4,980,000", "30%", "413,700"], ["4,980,001以上", "40%", "911,700"]])}`;

  const parsed = parseRateTables(html);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].years, [115]);
  assert.deepEqual(parsed[1].years, [113, 114], "「113至114年度」要展開成兩個年度");
  assert.deepEqual(parsed[0].brackets, [
    { upTo: 610000, rate: 0.05, quickDeduction: 0 },
    { upTo: 1380000, rate: 0.12, quickDeduction: 42700 },
    { upTo: 2770000, rate: 0.2, quickDeduction: 153100 },
    { upTo: 5190000, rate: 0.3, quickDeduction: 430100 },
    { upTo: null, rate: 0.4, quickDeduction: 949100 },
  ]);
  // 解析結果必須與版控中的值一致——不一致代表解析器或資料其一失準
  const stored = await readJson("../../data/tax-params.json");
  assert.ok(sameBrackets(parsed[0].brackets, stored.brackets), "解析值與 tax-params.json 必須相同");

  // 沒有年度標籤的表格不得被誤收
  assert.equal(parseRateTables(table([["0~610,000", "5%", "0"]])).length, 0);
  assert.equal(parseRateTables("").length, 0);
});

test("validateBrackets is the only licence to auto-write tax rates", async () => {
  const { validateBrackets } = await import("../../scripts/update-tax-params.mjs");
  const good = [
    { upTo: 610000, rate: 0.05, quickDeduction: 0 },
    { upTo: 1380000, rate: 0.12, quickDeduction: 42700 },
    { upTo: 2770000, rate: 0.2, quickDeduction: 153100 },
    { upTo: 5190000, rate: 0.3, quickDeduction: 430100 },
    { upTo: null, rate: 0.4, quickDeduction: 949100 },
  ];
  assert.equal(validateBrackets(good).ok, true);

  // 累進差額抄錯一位 → 定義性檢查必須抓到。這是自動化最危險的失效模式：
  // 數字看起來很正常，但稅全錯。
  const off = good.map((b, i) => (i === 1 ? { ...b, quickDeduction: 42800 } : b));
  const bad = validateBrackets(off);
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(""), /42700/, "要指出正確值是多少");

  // 其他失效型態
  assert.equal(validateBrackets(good.map((b, i) => (i === 0 ? { ...b, quickDeduction: 5 } : b))).ok, false, "首級距差額必須為 0");
  assert.equal(validateBrackets(good.map((b, i) => (i === 4 ? { ...b, upTo: 9999999 } : b))).ok, false, "最高級距不得有上限");
  assert.equal(validateBrackets(good.slice(0, 2).map((b, i) => (i === 1 ? { ...b, rate: 0.05 } : b))).ok, false, "稅率必須遞增");
  assert.equal(validateBrackets([]).ok, false);
  assert.equal(validateBrackets(null).ok, false);
});

test("tax params freshness is detected, never silently guessed", async () => {
  const { assessFreshness, incomeRocYear, latestAnnouncedYear } = await import("../../scripts/update-tax-params.mjs");

  // 民國所得年度：2026 年的所得屬 115 年度，116 年 5 月申報
  assert.equal(incomeRocYear(new Date("2026-07-30T00:00:00Z")), 115);
  assert.equal(incomeRocYear(new Date("2027-01-02T00:00:00Z")), 116);
  assert.equal(incomeRocYear("not-a-date"), null);

  // 只讀公告標題，不碰 PDF 附件
  assert.equal(latestAnnouncedYear("…公告115年度綜合所得稅及所得基本稅額相關…"), 115);
  assert.equal(latestAnnouncedYear("公告114年度綜合所得稅…公告116年度綜合所得稅…"), 116, "取最新的年度");
  assert.equal(latestAnnouncedYear("完全無關的內容"), null);

  const now = new Date("2026-07-30T00:00:00Z");
  assert.equal(assessFreshness({ rocYear: 115 }, now, 115).stale, false);
  // 所得年度已經走到下一年，參數還沒更新
  const rolled = assessFreshness({ rocYear: 115 }, new Date("2027-03-01T00:00:00Z"), 115);
  assert.equal(rolled.stale, true);
  assert.match(rolled.reasons.join(""), /116/);
  // 財政部已公告新年度
  const announced = assessFreshness({ rocYear: 115 }, now, 116);
  assert.equal(announced.stale, true);
  assert.match(announced.reasons.join(""), /已公告 116/);
  // 缺欄位要當成過期，不可當作通過
  assert.equal(assessFreshness({}, now, 115).stale, true);
});

test("holdings parser is anchored on header labels, not CSS classes", async () => {
  const { parseHoldings, parseAsOf } = await import("../../scripts/fetch-etf-holdings.mjs");

  const table = (cls) => `<table id="Repeater1" class="datalist">
    <tr><th>股票名稱</th><th>持股(千股)</th><th>比例</th><th>增減</th></tr>
    <tr><td class="${cls}a">台積電</td><td class="${cls}b">525,977.00</td><td class="${cls}c">57.37</td><td class="${cls}d">-0.91%</td></tr>
    <tr><td class="${cls}a">聯發科</td><td class="${cls}b">60,000.00</td><td class="${cls}c">6.11</td><td class="${cls}d">+0.２%</td></tr>
  </table>`;

  const original = parseHoldings(table("col05"));
  assert.deepEqual(original, [{ name: "台積電", weight: 57.37 }, { name: "聯發科", weight: 6.11 }]);
  // 這是抗改版的核心價值：class 全部改名仍要解析成功
  assert.deepEqual(parseHoldings(table("brandNew")), original, "a CSS class rename must not break the parser");

  // 頁面把持股拆成左右兩張表，兩張都要收
  assert.equal(parseHoldings(table("col05") + table("col05")).length, 4);
  // 取前十大就停
  const many = `<table><tr><th>股票名稱</th><th>比例</th></tr>`
    + Array.from({ length: 30 }, (_, i) => `<tr><td>股${i}</td><td>${(30 - i) / 10}</td></tr>`).join("") + `</table>`;
  assert.equal(parseHoldings(many).length, 10);

  // 表頭不見了＝上游真的改版 → 回空陣列，讓呼叫端記為失敗並保留前次值
  assert.deepEqual(parseHoldings(`<table><tr><th>代號</th><th>數量</th></tr><tr><td>x</td><td>1</td></tr></table>`), []);
  assert.deepEqual(parseHoldings("<div>no table at all</div>"), []);

  // 資料日：頁面標示的持股日期，與抓取日不同（實測相差 11 天）
  assert.equal(parseAsOf('<div>資料日期：2026/07/17</div>'), "2026-07-17");
  assert.equal(parseAsOf('資料日期: 2026/7/1'), "2026-07-01", "single-digit month and day");
  assert.equal(parseAsOf("<div>no date here</div>"), null);
});

test("holdings scrape refuses to overwrite good data when upstream degrades", async () => {
  const { isDegraded, moneydjId, parseHoldings } = await import("../../scripts/fetch-etf-holdings.mjs");

  // 實測正常成功數 202/348（槓反與期貨型結構上沒有成分股頁），
  // 所以護欄必須比「相對前次」而非絕對成功率——否則上游小幅劣化偵測不到。
  assert.equal(isDegraded(202, 202), false, "a normal run must write");
  assert.equal(isDegraded(150, 202), false, "mild variance still writes");
  assert.equal(isDegraded(140, 202), true, "a 30% drop means upstream changed — keep the old file");
  assert.equal(isDegraded(0, 202), true, "total failure must never wipe the file");
  // 首次執行沒有比較基準，用絕對下限擋住近乎空的檔案
  assert.equal(isDegraded(202, 0), false);
  assert.equal(isDegraded(10, 0), true, "first run must not persist a near-empty result");

  assert.equal(moneydjId("0050", "twse"), "0050.TW");
  assert.equal(moneydjId("00679B", "tpex"), "00679B.TWO");
  assert.equal(moneydjId("../evil", "twse"), "", "only validated codes reach the URL");
  // 上游改版（class 名變動）時要回空陣列，讓呼叫端判定失敗並保留前次值
  assert.deepEqual(parseHoldings('<td class="colXX">台積電</td>'), []);
  assert.deepEqual(parseHoldings(""), []);
});

test("etf-holdings.json is well formed when present", async () => {
  let holdings;
  try {
    holdings = await readJson("../../data/etf-holdings.json");
  } catch {
    return; // 尚未執行過抓取工具時跳過
  }
  assert.match(holdings.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(holdings.source, "must attribute the scraped source");
  for (const [code, entry] of Object.entries(holdings.etfs || {})) {
    assert.match(code, /^00\d{2,4}[A-Z]?$/, `${code}: code shape`);
    assert.ok(Array.isArray(entry.topHoldings) && entry.topHoldings.length <= 10, `${code}: <= 10 holdings`);
    entry.topHoldings.forEach((h) => {
      assert.equal(typeof h.name, "string", `${code}: holding name`);
      assert.ok(isNum(h.weight) && h.weight > 0 && h.weight <= 100, `${code}: weight range`);
    });
    assert.match(entry.asOf || "", /^\d{4}-\d{2}-\d{2}$/, `${code}: asOf`);
  }
});
