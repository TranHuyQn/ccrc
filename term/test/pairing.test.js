import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAS_DIGITS, randomNonce, commitFor, commitMatches, shortAuthString,
} from '../src/pairing.js';

const PUB = 'khoa-cong-khai-gia-dinh-base64url';

test('SAS xác định: cùng đầu vào cho cùng một số', () => {
  const a = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  const b = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  assert.equal(a, b);
});

test('SAS mặc định đúng 6 chữ số, đệm 0 khi cần', () => {
  for (let i = 0; i < 200; i += 1) {
    const s = shortAuthString({ pubKey: PUB, noncePhone: randomNonce(), nonceMachine: 'nm' });
    assert.equal(s.length, SAS_DIGITS, `"${s}" phải đúng ${SAS_DIGITS} chữ số`);
    assert.match(s, /^[0-9]+$/);
  }
});

test('đổi bất kỳ thành phần nào cũng đổi SAS', () => {
  const base = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  assert.notEqual(base, shortAuthString({ pubKey: PUB + 'x', noncePhone: 'np', nonceMachine: 'nm' }));
  assert.notEqual(base, shortAuthString({ pubKey: PUB, noncePhone: 'np2', nonceMachine: 'nm' }));
  assert.notEqual(base, shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm2' }));
});

test('cam kết khớp đúng nonce của nó, và chỉ nonce đó', () => {
  const n = randomNonce();
  assert.equal(commitMatches(commitFor(n), n), true);
  assert.equal(commitMatches(commitFor(n), randomNonce()), false);
});

test('commitMatches tổng: đầu vào rác trả false, không ném', () => {
  for (const x of [null, undefined, '', 42, {}, []]) {
    assert.equal(commitMatches(x, 'n'), false, `commit=${JSON.stringify(x)}`);
    assert.equal(commitMatches('c', x), false, `nonce=${JSON.stringify(x)}`);
  }
});

// Task 15 review, mục 5: lần thứ năm hình dạng `f({a} = {}) xuất hiện trong
// dự án này — bản trình duyệt (server/public/app.js's sasFor) đã được sửa
// bằng `opts || {}` (KHÔNG chỉ `= {}` trên tham số: `null` không phải
// `undefined` nên default không kích hoạt, "Cannot destructure property
// 'pubKey' of 'object null'" vẫn ném y hệt), nhưng bản gốc ở đây thì chưa.
test('shortAuthString(null) không được ném — trả một chuỗi (đầu vào rác, không phải lỗi lập trình)', () => {
  assert.doesNotThrow(() => shortAuthString(null));
  assert.doesNotThrow(() => shortAuthString(undefined));
});

test('nonce đủ dài và không lặp lại', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const n = randomNonce();
    assert.ok(n.length >= 40, 'nonce 32 byte base64url phải dài ít nhất 40 ký tự');
    assert.equal(seen.has(n), false, 'nonce trùng nhau là hỏng toàn bộ giá trị của cam kết');
    seen.add(n);
  }
});
