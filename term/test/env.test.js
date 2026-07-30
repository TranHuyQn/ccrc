import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePositiveMs, requestedPortLabel } from '../src/env.js';

// CCRC_TERM_MAX_TICKET_MS in the daemon goes through this exact function
// (CCRC_TERM_NONCE_TTL_MS, the other former call site, was deleted — final
// fix wave, item 8: it was dead configuration on every real path).
// `Number('garbage')` is NaN, and `NaN > x` /
// `x > NaN` are always false — an unguarded `Number(env || fallback)` lets
// a typo silently disable whatever clamp the value was guarding.
const BAD_INPUTS = [
  ['rác không phải số', 'not-a-number'],
  ['chuỗi rỗng', ''],
  ['"0"', '0'],
  ['số âm', '-100'],
  ['chưa đặt (undefined)', undefined],
  ['NaN thật', NaN],
  ['Infinity', 'Infinity'],
];

for (const [label, raw] of BAD_INPUTS) {
  test(`parsePositiveMs dùng giá trị mặc định khi input là ${label}`, () => {
    assert.equal(parsePositiveMs(raw, 60_000), 60_000);
  });
}

test('parsePositiveMs giữ nguyên một giá trị hợp lệ', () => {
  assert.equal(parsePositiveMs('5000', 60_000), 5000);
  assert.equal(parsePositiveMs(5000, 60_000), 5000);
});

// --- Đợt sửa cuối, mục 5: KHÔNG BAO GIỜ in ra "Cổng 0" -----------------------
//
// Mặc định sản xuất của CCRC_TERM_PORT là 0 — "cho tôi cổng nào rảnh cũng
// được". Nhét thẳng con số đó vào câu là ra "Cổng 0 đã có tiến trình khác
// dùng": vừa sai (không có gì nghe trên cổng 0 bao giờ) vừa vô dụng (không có
// cổng 0 nào để đi kiểm tra). Đây là chỗ DUY NHẤT kiểm được nhánh port-0:
// EADDRINUSE trên một cổng do OS tự cấp là điều không dựng ra được, vì OS chỉ
// cấp cổng đang rảnh — nên nếu chỉ test qua daemon thì nhánh sai này không
// bao giờ chạy. Xem `requestedPortLabel` trong src/env.js.

test('requestedPortLabel: cổng 0 được MÔ TẢ, tuyệt đối không in ra số 0', () => {
  for (const raw of ['0', 0]) {
    const s = requestedPortLabel(raw);
    assert.doesNotMatch(s, /0/, `"${s}" không được chứa con số nào — cổng 0 không phải một cổng để đi kiểm tra`);
    assert.match(s, /OS tự cấp/);
  }
});

test('requestedPortLabel: cổng được ghim thì nêu ĐÚNG con số đã yêu cầu', () => {
  assert.equal(requestedPortLabel('8730'), 'cổng 8730');
  assert.equal(requestedPortLabel(59155), 'cổng 59155');
});

test('requestedPortLabel: giá trị rác cũng không đẻ ra một "cổng" bịa', () => {
  for (const raw of ['rác', '', undefined, '-1', '99999', '80.5']) {
    assert.equal(requestedPortLabel(raw), 'cổng do OS tự cấp',
      `"${raw}" không phải số hiệu cổng đọc được thì không được trích dẫn lại như thể là`);
  }
});
