import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionKeys } from '../src/session-keys.js';

test('khoá cấp ra là hợp lệ', () => {
  const k = createSessionKeys();
  const key = k.issue();
  assert.equal(k.valid(key), true);
});

test('khoá đủ dài để không đoán được', () => {
  const key = createSessionKeys().issue();
  assert.ok(key.length >= 32, `khoá quá ngắn: ${key.length}`);
});

test('mỗi lần cấp một khoá khác nhau', () => {
  const k = createSessionKeys();
  assert.notEqual(k.issue(), k.issue());
});

test('khoá bịa bị từ chối', () => {
  const k = createSessionKeys();
  k.issue();
  for (const rac of ['', 'abc', null, undefined, 0, {}, 'a'.repeat(64)]) {
    assert.equal(k.valid(rac), false, `phải từ chối: ${JSON.stringify(rac)}`);
  }
});

test('khoá dùng lại được — KHÁC vé một lần, đây là chủ ý', () => {
  const k = createSessionKeys();
  const key = k.issue();
  assert.equal(k.valid(key), true);
  assert.equal(k.valid(key), true, 'sessionKey phải dùng lại được để nối lại sau khi đứt');
});
