// Phần không cần khoá thật: mọi đầu vào dị dạng phải trả về LÝ DO, không ném.
// Hàm này là thứ duy nhất đứng giữa một URL bị lộ và một shell trên máy dev,
// nên nó cố tình nhỏ, thuần tuý, và tổng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAttachToken, TOKEN_VERSION } from '../src/ticket.js';

const opts = { findDevice: () => ({ pubKey: 'bat-ky' }), sessionId: 's-abc', expectedHost: 'h', now: 1000 };

test('phiên bản token là v2', () => {
  assert.equal(TOKEN_VERSION, 'v2');
});

test('đầu vào dị dạng trả malformed, không ném', () => {
  const xau = [
    null, undefined, 42, {}, [], '', 'khong-co-dau-cham',
    'a.b', 'a.b.c.d', 'v1.abc.def', `${TOKEN_VERSION}..def`, `${TOKEN_VERSION}.abc.`,
    `${TOKEN_VERSION}.khong-phai-base64url-json.abc`,
  ];
  for (const t of xau) {
    const r = verifyAttachToken(t, opts);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.equal(typeof r.reason, 'string');
  }
});

// Task 15 review, mục 5: lần thứ năm hình dạng `f({a} = {})` xuất hiện trong
// dự án này — destructure thẳng tham số thứ hai trong CHỮ KÝ hàm chỉ đỡ được
// khi tham số đó VẮNG MẶT hoàn toàn (`undefined` kích hoạt default), không
// đỡ được khi ai đó lỡ truyền `null`. `token` không hợp lệ ('không-co-dau-cham')
// vẫn phải trả `malformed` bình thường dù thiếu hẳn tham số thứ hai — không
// được ném "Cannot destructure property 'findDevice' of 'undefined'".
test('thiếu hẳn tham số thứ hai (hoặc truyền null) không được ném', () => {
  assert.doesNotThrow(() => verifyAttachToken('khong-co-dau-cham'));
  assert.equal(verifyAttachToken('khong-co-dau-cham').ok, false);
  assert.doesNotThrow(() => verifyAttachToken('khong-co-dau-cham', null));
  assert.equal(verifyAttachToken('khong-co-dau-cham', null).ok, false);
});

test('payload thiếu trường bắt buộc là malformed, không phải bỏ qua', () => {
  // Một trường thiếu mà được mặc định hoá âm thầm là đúng loại lỗi mà định
  // dạng token này sinh ra để chặn: nó vô hiệu hoá kiểm tra của người gọi.
  // `h` (host đích) nằm trong danh sách này từ C3 (spec §13): thiếu nó phải
  // là malformed, KHÔNG được coi là "bỏ qua phép kiểm host".
  const day = { sid: 's-abc', m: 'm', iat: 1, exp: 2, n: 'n', k: 'k', h: 'h' };
  for (const thieu of Object.keys(day)) {
    const p = { ...day };
    delete p[thieu];
    const b64 = Buffer.from(JSON.stringify(p)).toString('base64url');
    const r = verifyAttachToken(`${TOKEN_VERSION}.${b64}.YWJj`, opts);
    assert.equal(r.ok, false, `thiếu ${thieu}`);
    assert.equal(r.reason, 'malformed', `thiếu ${thieu} phải là malformed`);
  }
});
