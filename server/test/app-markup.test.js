// Ba danh sách id phải khớp nhau, và trước file này không có gì bắt chúng khớp:
//
//   1. `$('...')` trong server/public/app.js  — code thật đi tìm phần tử
//   2. `id="..."` trong server/public/index.html — markup thật có phần tử
//   3. REQUIRED_IDS trong test/dom-harness.mjs — DOM giả của test dựng phần tử
//
// Lệch (1) với (2) là lỗi chỉ nổ trên trình duyệt: harness tự dựng phần tử cho
// MỌI id trong REQUIRED_IDS, nên một nút không hề tồn tại trong index.html vẫn
// có `.onclick` gọi được và vẫn xanh hết bảng test. Đó không phải giả thuyết —
// đúng kiểu khe hở này đã cho ra một assertion rỗng về #link-card từng qua mặt
// cả bộ test.
//
// Lệch (3) với (2) thì ngược lại: harness dựng một phần tử mà trang thật không
// có, nên test diễn tập một màn hình không tồn tại.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_IDS } from './dom-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

// Chỉ suy ra được từ literal. Hai dạng, và dạng thứ hai không phải cho đủ bộ:
// bindApprove() nhận id qua tham số, nên sau khi gộp hai đường duyệt vào một
// hàm thì `approve-btn`/`approve-msg`/`approve-err` biến mất khỏi tầm nhìn của
// bộ dò `$('...')` — refactor làm mù chính cái test canh gác này. Bất cứ hàm
// nào nhận id kiểu đó về sau đều phải được thêm vào đây, nếu không nó lặng lẽ
// tuột khỏi lưới.
const ID_CALLS = [
  /\$\('([^']+)'\)/g,                                                   // $('abc')
  /\bbindApprove\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)/g, // bindApprove(a,b,c,d)
];

function idsUsedByAppJs() {
  const ids = new Set();
  for (const re of ID_CALLS) {
    for (const m of APP_JS.matchAll(re)) {
      for (const g of m.slice(1)) if (g) ids.add(g);
    }
  }
  return ids;
}

function idsInMarkup() {
  return new Set(Array.from(INDEX_HTML.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
}

test('mọi $(id) trong app.js đều có thật trong index.html', () => {
  const markup = idsInMarkup();
  const thieu = [...idsUsedByAppJs()].filter((id) => !markup.has(id)).sort();
  assert.deepEqual(thieu, [],
    `app.js đi tìm phần tử không có trong index.html: ${thieu.join(', ')}`);
});

test('mọi id trong REQUIRED_IDS của harness đều có thật trong index.html', () => {
  const markup = idsInMarkup();
  const thua = REQUIRED_IDS.filter((id) => !markup.has(id)).sort();
  assert.deepEqual(thua, [],
    `harness dựng phần tử mà trang thật không có: ${thua.join(', ')}`);
});

test('mọi $(id) app.js dùng đều được harness dựng — nếu không, test nổ vì undefined', () => {
  const co = new Set(REQUIRED_IDS);
  const thieu = [...idsUsedByAppJs()].filter((id) => !co.has(id)).sort();
  assert.deepEqual(thieu, [],
    `harness thiếu id: ${thieu.join(', ')} — thêm vào REQUIRED_IDS`);
});

// Cache-busting: app.js và style.css bị Cloudflare trả max-age=14400 (4 giờ)
// bất kể origin đặt no-cache, nên `?v=` trên thẻ tham chiếu là thứ DUY NHẤT
// đưa được bản mới xuống trình duyệt đã tải trang. index.html thì no-cache
// thật, nên nó luôn thấy `?v=` mới ngay. Quên bump = deploy vô hình tới 4 giờ.
test('app.js và style.css đều được tham chiếu kèm ?v=', () => {
  for (const asset of ['app.js', 'style.css']) {
    assert.match(INDEX_HTML, new RegExp(`${asset.replace('.', '\\.')}\\?v=\\d+`),
      `${asset} phải có ?v=<số> trong index.html`);
  }
});
