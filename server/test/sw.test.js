// Chạy server/public/sw.js — một script service worker cổ điển, không module
// — trong node:vm với một `self` giả. Cùng kỹ thuật với dom-harness.mjs,
// nhưng `self` của service worker gần như không giao nhau với DOM của trang,
// nên nó có harness nhỏ riêng ngay trong file này thay vì làm phình cái kia.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
);

function loadSw({ windows = [] } = {}) {
  const shown = [];
  const opened = [];
  const listeners = {};
  const self_ = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting() {},
    registration: {
      showNotification(title, opts) { shown.push({ title, opts }); return Promise.resolve(); },
    },
    clients: {
      claim() { return Promise.resolve(); },
      matchAll() { return Promise.resolve(windows); },
      openWindow(url) { opened.push(url); return Promise.resolve(null); },
    },
  };
  const context = vm.createContext({ self: self_, console });
  vm.runInContext(SW_JS, context, { filename: 'sw.js' });

  // Gom mọi promise mà handler đưa vào waitUntil, để test await được thay vì
  // phải đoán thời điểm.
  const fire = async (type, event) => {
    const waits = [];
    const ev = Object.assign({ waitUntil: (p) => waits.push(p) }, event);
    for (const fn of (listeners[type] || [])) fn(ev);
    await Promise.all(waits);
  };
  return { fire, shown, opened };
}

const pushEvent = (data) => ({ data: { json: () => data } });

test('push có sessionId → notification mang nó trong data', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 'Xong', body: 'Claude đang chờ', sessionId: 's-1' }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Xong');
  // `opts.data` được tạo ra bởi code chạy trong vm context của sw.js, nên nó
  // mang Object.prototype của context đó — khác với Object.prototype ở
  // realm của test. deepEqual (= deepStrictEqual dưới 'node:assert/strict')
  // so cả prototype nên structuredClone trước để đưa về plain object của
  // realm hiện tại; nếu không, so sánh trượt dù giá trị giống hệt nhau.
  assert.deepEqual(structuredClone(sw.shown[0].opts.data), { sessionId: 's-1' });
});

test('push không có sessionId → không bịa ra data', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 'Xong', body: 'x' }));
  assert.equal(sw.shown[0].opts.data, undefined);
});

test('bấm thông báo, chưa có cửa sổ nào → mở /?open=<sessionId>', async () => {
  const sw = loadSw({ windows: [] });
  let closed = 0;
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's 1/đặc biệt' }, close() { closed += 1; } },
  });
  assert.equal(closed, 1, 'thông báo phải được đóng lại');
  assert.deepEqual(sw.opened, ['/?open=' + encodeURIComponent('s 1/đặc biệt')]);
});

test('bấm thông báo, đã có cửa sổ → focus rồi nhắn cho nó, không mở thêm cửa sổ', async () => {
  const messages = [];
  let focused = 0;
  const win = { focus() { focused += 1; return Promise.resolve(); }, postMessage: (m) => messages.push(m) };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.equal(focused, 1);
  // Cùng lý do structuredClone như test push ở trên: postMessage được gọi
  // với object literal tạo ra bên trong vm context của sw.js.
  assert.deepEqual(structuredClone(messages), [{ type: 'ccrc_open', sessionId: 's-1' }]);
  assert.deepEqual(sw.opened, [], 'đã có cửa sổ thì không được mở thêm cái nữa');
});

test('bấm thông báo, focus() bị từ chối nhưng postMessage vẫn được → phiên vẫn tới nơi', async () => {
  const messages = [];
  const win = {
    focus() { return Promise.reject(new Error('cửa sổ vừa đóng')); },
    postMessage: (m) => messages.push(m),
  };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.deepEqual(structuredClone(messages), [{ type: 'ccrc_open', sessionId: 's-1' }]);
  assert.deepEqual(sw.opened, [], 'nhắn được rồi thì không cần mở cửa sổ mới');
});

// `focus()` trả về promise theo đúng đặc tả, nhưng nó là một API của nền tảng
// và một cú NÉM ĐỒNG BỘ (cửa sổ đã chết, nền tảng chặn) không có gì bảo đảm là
// không xảy ra. Khi đó `win.focus().catch(...)` tự nó là một TypeError: nó kéo
// đổ cả promise trong waitUntil, và cùng với đó là nhánh openWindow dự phòng —
// nghĩa là mất luôn phiên, đúng thứ nhánh dự phòng ấy sinh ra để cứu.
test('focus() ném ĐỒNG BỘ → vẫn nhắn được cho cửa sổ, không kéo đổ cả handler', async () => {
  const messages = [];
  const win = {
    focus() { throw new TypeError('focus không dùng được'); },
    postMessage: (m) => messages.push(m),
  };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.deepEqual(structuredClone(messages), [{ type: 'ccrc_open', sessionId: 's-1' }]);
  assert.deepEqual(sw.opened, [], 'nhắn được rồi thì không cần mở cửa sổ mới');
});

test('focus() ném đồng bộ VÀ postMessage hỏng → vẫn rơi xuống mở cửa sổ mới', async () => {
  const win = {
    focus() { throw new TypeError('focus không dùng được'); },
    postMessage() { throw new Error('cửa sổ đã chết'); },
  };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.deepEqual(sw.opened, ['/?open=' + encodeURIComponent('s-1')]);
});

// Kiểu hỏng thứ ba: focus() trả về thứ không phải promise. Đặc tả nói nó trả
// về promise, nhưng `.catch` gọi trên `undefined` là một TypeError ném ngay
// tại chỗ — cùng hậu quả với hai kiểu trên.
test('focus() trả về undefined (không phải promise) → vẫn nhắn được cho cửa sổ', async () => {
  const messages = [];
  const win = { focus() { /* trả về undefined */ }, postMessage: (m) => messages.push(m) };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.deepEqual(structuredClone(messages), [{ type: 'ccrc_open', sessionId: 's-1' }]);
  assert.deepEqual(sw.opened, []);
});

test('bấm thông báo, focus() lẫn postMessage đều hỏng → vẫn mở cửa sổ mới, không im lặng bỏ cuộc', async () => {
  const win = {
    focus() { return Promise.reject(new Error('cửa sổ vừa đóng')); },
    postMessage() { throw new Error('cửa sổ đã chết'); },
  };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.deepEqual(sw.opened, ['/?open=' + encodeURIComponent('s-1')]);
});

test('thông báo không thuộc phiên nào → mở app như cũ, không nhắn gì', async () => {
  const messages = [];
  const win = { focus() { return Promise.resolve(); }, postMessage: (m) => messages.push(m) };
  const sw1 = loadSw({ windows: [win] });
  await sw1.fire('notificationclick', { notification: { data: undefined, close() {} } });
  assert.deepEqual(messages, []);

  const sw2 = loadSw({ windows: [] });
  await sw2.fire('notificationclick', { notification: { data: {}, close() {} } });
  assert.deepEqual(sw2.opened, ['/']);
});
