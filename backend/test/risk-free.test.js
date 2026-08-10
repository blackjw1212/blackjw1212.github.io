import test from "node:test";
import assert from "node:assert/strict";
import { parseDiscountRows, latestRate } from "../../scripts/update-risk-free.mjs";

// 央行「央行貼放利率」頁的實際結構：每格帶 data-th，可用欄名取值。
const row = (date, redisc, secured, short) =>
  `<tr><td data-th="調整日期"><span>${date}</span></td>` +
  `<td data-th="重貼現率"><span>${redisc}</span></td>` +
  `<td data-th="擔保放款融通利率"><span>${secured}</span></td>` +
  `<td data-th="短期融通利率"><span>${short}</span></td></tr>`;

const page = (rows) =>
  `<html><body><table><tr><th>調整日期</th><th>重貼現率</th></tr>${rows.join("")}</table></body></html>`;

test("parses the discount-rate table by column name, not column order", () => {
  const rows = parseDiscountRows(page([row("2024/3/22", "2", "2.375", "4.25")]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { effectiveFrom: "2024-03-22", rate: 2 });
});

// 靠欄序（cells[1]）的寫法在央行加一欄時會靜默抓到別的利率。
// 抓到「擔保放款融通利率」2.375 而不是重貼現率 2，畫面不會有任何異狀。
test("an inserted column does not shift the reading onto another rate", () => {
  const shifted =
    '<tr><td data-th="調整日期"><span>2024/3/22</span></td>' +
    '<td data-th="生效說明"><span>理監事會決議</span></td>' +
    '<td data-th="重貼現率"><span>2</span></td>' +
    '<td data-th="擔保放款融通利率"><span>2.375</span></td></tr>';
  const rows = parseDiscountRows(page([shifted]));
  assert.equal(rows[0].rate, 2, "多插一欄仍要抓到重貼現率，不可位移到擔保放款融通利率");
});

// 表格目前由新到舊排序，但那不是契約。若央行改成由舊到新，
// 取 rows[0] 會抓到 1980 年代的利率而毫無警訊。
test("the newest effective date wins regardless of table order", () => {
  const oldestFirst = [
    row("2009/2/19", "1.25", "1.625", "3.5"),
    row("2022/3/18", "1.375", "1.75", "3.625"),
    row("2024/3/22", "2", "2.375", "4.25"),
  ];
  const picked = latestRate(parseDiscountRows(page(oldestFirst)));
  assert.equal(picked.rate, 2);
  assert.equal(picked.effectiveFrom, "2024-03-22");
});

test("a not-yet-effective adjustment cannot be used for today's returns", () => {
  const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10).replace(/-0?/g, "/").replace(/^\//, "");
  const rows = [row("2024/3/22", "2", "2.375", "4.25"), row(future, "3", "3.375", "5.25")];
  const parsed = parseDiscountRows(page(rows));
  // 若未來日期的字串組壞了，那一列會在解析階段就被跳過，
  // 這條測試就會因為「根本沒測到」而假通過。先釘住兩列都解析成功。
  assert.equal(parsed.length, 2, `未來日期 ${future} 必須解析得出來，否則這條測試沒有測到東西`);
  assert.equal(latestRate(parsed).rate, 2, "尚未生效的調整不可拿來算今天的 Sharpe");
});

// 解析錯位最常見的結果是抓到日期或空字串當數字。
// 這條擋的是「靜默寫入一個荒謬的利率」——沒人會用肉眼發現 Sharpe 全部變成負的。
test("out-of-band values are rejected rather than written", () => {
  assert.equal(latestRate(parseDiscountRows(page([row("2024/3/22", "2024", "1", "1")]))), null,
    "把年份當成利率必須被擋下");
  assert.equal(latestRate(parseDiscountRows(page([row("2024/3/22", "0", "1", "1")]))), null,
    "0% 不是有效的無風險利率，會把超額報酬灌成全額報酬");
  assert.equal(latestRate([]), null);
});

test("malformed rows are skipped without taking the whole table down", () => {
  const rows = parseDiscountRows(page([
    '<tr><td data-th="調整日期"><span>不是日期</span></td><td data-th="重貼現率"><span>2</span></td></tr>',
    row("2023/3/24", "1.875", "2.25", "4.125"),
  ]));
  assert.equal(rows.length, 1, "壞掉的列跳過，好的列仍要留下");
  assert.equal(rows[0].rate, 1.875);
});
