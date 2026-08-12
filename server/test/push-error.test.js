// Unit tests cho src/push-error.js — cách hub biến err.body của một lần push
// hỏng thành một dòng log đọc được. Trước bản sửa này, notifyUser() chỉ log
// statusCode: một cú push bị Apple từ chối vì subject sai (403 BadJwtToken)
// và một cú push hỏng vì lý do khác hoàn toàn đều ra "push failed: 403" —
// không phân biệt được, phải đổi biến rồi thử lại thật với điện thoại mới
// biết lý do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPushErrorBody, PUSH_ERROR_BODY_MAX } from '../src/push-error.js';

test('body dạng chuỗi (trường hợp thật của WebPushError) được giữ nguyên', () => {
  assert.equal(formatPushErrorBody('{"reason":"BadJwtToken"}'), '{"reason":"BadJwtToken"}');
});

test('body dạng object được chuyển thành JSON để đọc được, không phải "[object Object]"', () => {
  const out = formatPushErrorBody({ reason: 'BadJwtToken' });
  assert.equal(out, '{"reason":"BadJwtToken"}');
});

test('body vắng mặt (undefined/null/rỗng) → nói rõ "không có", không log "undefined" trần trụi', () => {
  assert.equal(formatPushErrorBody(undefined), '(no body)');
  assert.equal(formatPushErrorBody(null), '(no body)');
  assert.equal(formatPushErrorBody(''), '(no body)');
});

test('body cực dài bị cắt ở PUSH_ERROR_BODY_MAX — dịch vụ push độc hại/lắm lời không phình được log', () => {
  const huge = 'x'.repeat(PUSH_ERROR_BODY_MAX * 20);
  const out = formatPushErrorBody(huge);
  assert.ok(out.length < huge.length, 'phải ngắn hơn bản gốc');
  assert.ok(out.startsWith('x'.repeat(PUSH_ERROR_BODY_MAX)), 'phải giữ đúng phần đầu, không cắt lệch');
  assert.match(out, /cắt/, 'phải tự nói là đã bị cắt, không để im lặng làm người đọc tưởng đó là toàn bộ');
});

test('body vừa đúng ngưỡng PUSH_ERROR_BODY_MAX → giữ nguyên, chưa cắt', () => {
  const exact = 'y'.repeat(PUSH_ERROR_BODY_MAX);
  assert.equal(formatPushErrorBody(exact), exact);
});

test('object không JSON.stringify được (vòng lặp tham chiếu) → không nổ, vẫn ra chuỗi', () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => formatPushErrorBody(circular));
  assert.equal(typeof formatPushErrorBody(circular), 'string');
});
