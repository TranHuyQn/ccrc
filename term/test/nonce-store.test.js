// Hai test này từng nằm trong ticket.test.js, vì nonce là thứ mà việc xác
// minh vé tiêu đi (spend) để chặn dùng lại. Chúng chuyển ra đây khi
// ticket.test.js bị viết lại cho v2 (ECDSA) — createNonceStore là module
// riêng của nó, với hợp đồng riêng, không phụ thuộc gì vào định dạng vé.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNonceStore } from '../src/nonce-store.js';

test('nonce dùng một lần: lần hai bị từ chối', () => {
  const store = createNonceStore({ ttlMs: 60000 });
  assert.equal(store.use('n1', 1000), true);
  assert.equal(store.use('n1', 1000), false, 'dùng lại phải bị chặn');
});

test('nonce quá hạn được dọn, không phình vô hạn', () => {
  const store = createNonceStore({ ttlMs: 60000 });
  store.use('n1', 1000);
  store.use('n2', 1000);
  assert.equal(store.size(), 2);
  store.use('n3', 1000 + 60001);
  assert.equal(store.size(), 1, 'hai nonce cũ phải bị dọn');
});
