// Kho one-shot dùng cho `state` của OAuth và `claimCode` trao token cho PWA.
//
// Cả hai đều là thứ đi qua thanh địa chỉ trình duyệt, tức là đi vào history,
// vào Referer, vào access log của reverse proxy. Chúng chỉ an toàn chừng nào
// dùng-một-lần và hết hạn là thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneShotStore } from '../src/oauth-state.js';

test('issue rồi consume trả lại đúng payload', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  const code = s.issue({ token: 'tok', displayName: 'huy' });
  assert.deepEqual(s.consume(code), { token: 'tok', displayName: 'huy' });
});

test('consume lần hai trả null — đây là toàn bộ lý do kho này tồn tại', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  const code = s.issue({ a: 1 });
  s.consume(code);
  assert.equal(s.consume(code), null);
});

test('quá TTL thì chết', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  const code = s.issue({ a: 1 });
  t = 1001;
  assert.equal(s.consume(code), null);
});

test('còn trong TTL thì sống', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  const code = s.issue({ a: 1 });
  t = 999;
  assert.deepEqual(s.consume(code), { a: 1 });
});

test('mã bịa ra không đổi được gì', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  s.issue({ a: 1 });
  assert.equal(s.consume('bia-dat'), null);
  assert.equal(s.consume(''), null);
  assert.equal(s.consume(undefined), null);
  assert.equal(s.consume(null), null);
  assert.equal(s.consume(123), null);
});

test('hai lần issue cho hai mã khác nhau', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  assert.notEqual(s.issue({}), s.issue({}));
});

test('entry hết hạn được dọn khỏi bộ nhớ, không chỉ bị từ chối', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  s.issue({ a: 1 });
  s.issue({ a: 2 });
  assert.equal(s.size(), 2);
  t = 1001;
  assert.equal(s.size(), 0, 'không dọn thì một hub chạy lâu ngày là một chỗ rò bộ nhớ');
});

test('mã đủ dài để không đoán được', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  assert.ok(s.issue({}).length >= 40, 'base64url của 32 byte dài 43 ký tự');
});
