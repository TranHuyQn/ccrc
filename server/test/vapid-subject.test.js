// Unit tests cho src/vapid-subject.js — luật quyết định CCRC_VAPID_SUBJECT có
// đáng bị cảnh báo hay không.
//
// notify-api.test.js chứng minh cảnh báo này thật sự lên stderr qua một hub
// thật (khởi động lại tiến trình cho từng trường hợp rất tốn). File này đi
// vào các cách viết subject khác nhau, thứ không tiện dựng cả hub để thử.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VAPID_SUBJECT, isVapidSubjectUnusableForApple } from '../src/vapid-subject.js';

test('subject mặc định của hub bị đánh dấu — đây chính là ca Apple từ chối', () => {
  assert.equal(isVapidSubjectUnusableForApple(DEFAULT_VAPID_SUBJECT), true);
  assert.equal(DEFAULT_VAPID_SUBJECT, 'mailto:admin@localhost');
});

test('bất cứ subject nào trỏ về localhost đều bị đánh dấu, không chỉ giá trị mặc định', () => {
  assert.equal(isVapidSubjectUnusableForApple('mailto:ai-do-khac@localhost'), true);
  assert.equal(isVapidSubjectUnusableForApple('https://localhost'), true);
  assert.equal(isVapidSubjectUnusableForApple('https://localhost:8720'), true);
  assert.equal(isVapidSubjectUnusableForApple('https://hub.localhost'), true, 'tên con của localhost');
});

test('địa chỉ loopback IPv4/IPv6 bị đánh dấu như localhost', () => {
  assert.equal(isVapidSubjectUnusableForApple('https://127.0.0.1'), true);
  assert.equal(isVapidSubjectUnusableForApple('https://127.0.0.1:8720'), true);
  assert.equal(isVapidSubjectUnusableForApple('mailto:a@[::1]'), true);
});

test('domain mẫu copy-paste từ tài liệu (example.com...) bị đánh dấu', () => {
  assert.equal(isVapidSubjectUnusableForApple('https://example.com'), true);
  assert.equal(isVapidSubjectUnusableForApple('mailto:admin@example.org'), true);
  assert.equal(isVapidSubjectUnusableForApple('https://yourdomain.com'), true);
});

test('subject không parse được (thiếu scheme, rỗng...) bị đánh dấu — không vin cớ được', () => {
  assert.equal(isVapidSubjectUnusableForApple('admin@localhost'), true, 'thiếu scheme mailto:');
  assert.equal(isVapidSubjectUnusableForApple(''), true);
  assert.equal(isVapidSubjectUnusableForApple(undefined), true);
});

test('domain thật, không phải localhost/mẫu → KHÔNG bị đánh dấu', () => {
  assert.equal(isVapidSubjectUnusableForApple('https://hub.acme.dev'), false,
    'chính domain đã kiểm chứng sống với Apple trong báo cáo lỗi');
  assert.equal(isVapidSubjectUnusableForApple('https://hub.mycompany.vn'), false);
});

test('mailto thật (không phải localhost/mẫu) → KHÔNG bị đánh dấu', () => {
  assert.equal(isVapidSubjectUnusableForApple('mailto:ops@mycompany.vn'), false);
});
