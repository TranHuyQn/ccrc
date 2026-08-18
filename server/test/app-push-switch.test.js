// Nút cũ nói rõ nó sắp làm gì ("Tắt thông báo trên thiết bị này"); một cần gạt
// thì không nói gì cả. Nên trạng thái phải đọc được bằng hai đường khác: dòng
// chữ #push-state cho mắt, và aria-checked cho trình đọc màn hình. Thiếu đường
// thứ hai thì cần gạt này là một nút không nhãn với người mù.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage, makeFetch } from './dom-harness.mjs';

function navigatorCoPush(endpoint) {
  return {
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => (endpoint
            ? { endpoint, unsubscribe: async () => true }
            : null),
        },
      }),
      register: async () => ({}),
    },
  };
}

// Không cần mock /api/push/devices: từ Task 2, refreshPushState() thôi gọi
// refreshDevices() — danh sách thiết bị nạp khi mở Cài đặt, không phải mỗi lần
// trạng thái push đổi.
async function dungTrang(endpoint) {
  const fetchImpl = makeFetch(async () => ({ status: 404, body: {} }));
  const page = loadAppPage({ fetchImpl, navigatorImpl: navigatorCoPush(endpoint) });
  page.context.window.PushManager = function () {};
  await page.context.refreshPushState();
  return page;
}

test('đang bật: aria-checked=true, có class on, và #push-state nói rõ', async () => {
  const page = await dungTrang('https://web.push.apple.com/b');
  const btn = page.byId['enable-push'];
  assert.equal(btn.getAttribute('aria-checked'), 'true');
  assert.equal(btn.classList.contains('on'), true);
  assert.match(page.byId['push-state'].textContent, /đã bật/i);
});

test('đang tắt: aria-checked=false, không có class on', async () => {
  const page = await dungTrang(null);
  const btn = page.byId['enable-push'];
  assert.equal(btn.getAttribute('aria-checked'), 'false');
  assert.equal(btn.classList.contains('on'), false);
  assert.match(page.byId['push-state'].textContent, /chưa bật/i);
});

test('cần gạt không có chữ, nên phải có aria-label nói việc nó sắp làm', async () => {
  const bat = await dungTrang('https://web.push.apple.com/b');
  assert.match(bat.byId['enable-push'].getAttribute('aria-label'), /^Tắt/);
  const tat = await dungTrang(null);
  assert.match(tat.byId['enable-push'].getAttribute('aria-label'), /^Bật/);
});

test('đặt nhãn KHÔNG được ghi đè textContent — cần gạt vẽ bằng CSS', async () => {
  const page = await dungTrang('https://web.push.apple.com/b');
  assert.equal(page.byId['enable-push'].textContent, '',
    'ghi textContent vào nút này là in chữ đè lên cần gạt');
});
