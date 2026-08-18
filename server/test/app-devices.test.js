// The device list in server/public/app.js.
//
// It exists because "5 thiết bị" was not something a person could act on: four
// of those five were the same iPhone, re-subscribed after four reinstalls, and
// the screen gave no way to tell them apart or remove any of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage, makeFetch } from './dom-harness.mjs';

// A navigator with a live push subscription, so app.js can ask "which of these
// rows is me". `endpoint` null means: notifications are off on this device,
// which must still show the list — seeing the OTHERS is the whole point.
function navigatorWith(endpoint) {
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
    // `'PushManager' in window` is what app.js checks; the harness window is a
    // plain object, so this is carried on navigator and the check below is
    // satisfied by the page's own window fake.
  };
}

const DEVICES = [
  { id: 'aaa1', label: '', service: 'Apple', addedAt: null, current: false },
  { id: 'bbb2', label: 'iPhone · Safari', service: 'Apple', addedAt: 1785200000000, current: true },
  { id: 'ccc3', label: 'Android · Chrome', service: 'Google', addedAt: 1785100000000, current: false },
];

// Loads the page, opens the device panel, and returns everything a test needs.
async function openDevices(devices = DEVICES, { endpoint = 'https://web.push.apple.com/b' } = {}) {
  const calls = [];
  const fetchImpl = makeFetch(async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/push/devices') return { status: 200, body: { devices } };
    if (url === '/api/push/devices/delete') return { status: 200, body: { ok: true, pushDevices: 2 } };
    if (url === '/api/push/devices/keep-only') return { status: 200, body: { ok: true, pushDevices: 1 } };
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: devices.length } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, navigatorImpl: navigatorWith(endpoint) });
  page.context.window.PushManager = function () {};
  await page.context.refreshDevices();
  return { page, calls };
}

const rows = (page) => page.byId.devices.children.filter((c) => c.className.includes('device'));

test('danh sách thiết bị: mỗi thiết bị một dòng', async () => {
  const { page } = await openDevices();
  assert.equal(page.byId.devices.classList.contains('hidden'), false);
  assert.equal(rows(page).length, 3);
});

test('đánh dấu rõ thiết bị đang cầm trên tay', async () => {
  const { page } = await openDevices();
  const mine = rows(page).filter((r) => r.className.includes('device-current'));
  assert.equal(mine.length, 1, 'phải có đúng một dòng được đánh dấu');
  assert.match(mine[0].children[0].textContent, /thiết bị này/);
});

test('hiện nhãn và dịch vụ; thiết bị cũ không có nhãn thì nói rõ là không rõ', async () => {
  const { page } = await openDevices();
  const [cu, , android] = rows(page);
  assert.match(android.children[0].textContent, /Android · Chrome/);
  assert.match(android.children[0].textContent, /Google/);
  // Entry registered before the hub recorded labels: says so rather than
  // inventing a name.
  assert.match(cu.children[0].textContent, /không rõ/i);
  assert.match(cu.children[1].textContent, /trước khi hệ thống ghi ngày/);
});

test('gửi endpoint của mình lên để hub biết dòng nào là mình', async () => {
  const { calls } = await openDevices();
  const req = calls.find((c) => c.url === '/api/push/devices');
  assert.equal(req.body.endpoint, 'https://web.push.apple.com/b');
});

// Turning notifications off on this phone must not hide the other devices —
// removing them from here is exactly why someone opens this panel.
test('thiết bị này CHƯA bật thông báo → vẫn xem được các thiết bị khác', async () => {
  const { page, calls } = await openDevices(DEVICES, { endpoint: null });
  assert.equal(rows(page).length, 3);
  assert.equal(calls.find((c) => c.url === '/api/push/devices').body.endpoint, null);
});

test('xoá một thiết bị khác: gửi đúng id', async () => {
  const { page, calls } = await openDevices();
  const other = rows(page)[2]; // Android · Chrome
  const btn = other.children.find((c) => c.tagName === 'BUTTON');
  await btn.onclick();
  const del = calls.find((c) => c.url === '/api/push/devices/delete');
  assert.equal(del.body.id, 'ccc3');
});

// Removing THIS device has a second half the hub cannot do: the browser still
// holds a live subscription. Leaving it would have the page claim
// notifications are on while the hub pushes to nobody.
test('xoá chính thiết bị này thì HUỶ luôn đăng ký trong trình duyệt', async () => {
  let unsubscribed = false;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/push/devices') return { status: 200, body: { devices: DEVICES } };
    if (url === '/api/push/devices/delete') return { status: 200, body: { ok: true, pushDevices: 2 } };
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 2 } };
    return { status: 404, body: {} };
  });
  const nav = {
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => ({
            endpoint: 'https://web.push.apple.com/b',
            unsubscribe: async () => { unsubscribed = true; return true; },
          }),
        },
      }),
      register: async () => ({}),
    },
  };
  const page = loadAppPage({ fetchImpl, navigatorImpl: nav });
  page.context.window.PushManager = function () {};
  await page.context.refreshDevices();

  const mine = rows(page).find((r) => r.className.includes('device-current'));
  await mine.children.find((c) => c.tagName === 'BUTTON').onclick();
  assert.equal(unsubscribed, true,
    'không huỷ đăng ký thì trang vẫn báo "đã bật" trong khi hub không còn đẩy tới đâu');
});

test('có thiết bị khác → hiện nút xoá tất cả trừ thiết bị này', async () => {
  const { page } = await openDevices();
  const sweep = page.byId.devices.children.find(
    (c) => c.tagName === 'BUTTON' && /chỉ giữ thiết bị này/.test(c.textContent));
  assert.ok(sweep, 'thiếu nút dọn — đây là hành động duy nhất giải quyết được danh sách tích tụ');
  assert.match(sweep.textContent, /2 thiết bị khác/);
});

test('chỉ có mỗi thiết bị này → KHÔNG hiện nút dọn', async () => {
  const { page } = await openDevices([DEVICES[1]]);
  const sweep = page.byId.devices.children.find(
    (c) => c.tagName === 'BUTTON' && /chỉ giữ/.test(c.textContent));
  assert.equal(sweep, undefined, 'không còn gì để dọn mà vẫn mời bấm');
});

// Without a subscription there is no "this device" to keep, and the sweep
// would mean "delete everything".
test('thiết bị này chưa đăng ký → KHÔNG hiện nút dọn', async () => {
  const withoutCurrent = DEVICES.map((d) => ({ ...d, current: false }));
  const { page } = await openDevices(withoutCurrent, { endpoint: null });
  const sweep = page.byId.devices.children.find(
    (c) => c.tagName === 'BUTTON' && /chỉ giữ/.test(c.textContent));
  assert.equal(sweep, undefined, 'sẽ xoá sạch mọi thiết bị mà không giữ lại cái nào');
});

test('nút dọn gửi endpoint của chính mình', async () => {
  const { page, calls } = await openDevices();
  const sweep = page.byId.devices.children.find(
    (c) => c.tagName === 'BUTTON' && /chỉ giữ thiết bị này/.test(c.textContent));
  await sweep.onclick();
  const req = calls.find((c) => c.url === '/api/push/devices/keep-only');
  assert.equal(req.body.endpoint, 'https://web.push.apple.com/b');
});

test('hub lỗi → báo rõ, KHÔNG xoá trắng danh sách đang hiện', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/push/devices') return { status: 500, body: {} };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, navigatorImpl: navigatorWith('https://web.push.apple.com/b') });
  page.context.window.PushManager = function () {};
  await page.context.refreshDevices();
  assert.equal(page.byId['devices-err'].classList.contains('hidden'), false);
  assert.match(page.byId['devices-err'].textContent, /không lấy được/i);
});

// Everything here comes off the user's own machines, but a device label still
// goes through textContent and never innerHTML.
test('nhãn thiết bị dựng bằng textContent, không phải innerHTML', async () => {
  const hostile = [{ id: 'x', label: '<img src=x onerror=alert(1)>', service: 'Apple', addedAt: null, current: false }];
  const { page } = await openDevices(hostile);
  const name = rows(page)[0].children[0];
  assert.match(name.textContent, /<img/, 'phải nằm nguyên si trong textContent');
  assert.equal(name.children.length, 0, 'không được sinh ra phần tử con nào');
});
