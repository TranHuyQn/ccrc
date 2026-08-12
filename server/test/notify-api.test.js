import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNotificationHistory, HISTORY_MAX, HISTORY_TTL_MS } from '../src/notification-history.js';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

// A port the OS just told us is free, rather than a guess.
//
// This used to be `8790 + random(200)`, and it broke as soon as this file
// started more hubs: two picking the same number meant the second failed to
// bind and died, while the test went on talking to the FIRST hub — a
// different process with a different users.json. The symptom was a 401 in
// whichever test happened to lose, never the same one twice, and nothing
// about it pointed at ports.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const DEFAULT_USERS = [{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }];

async function startHub(users = DEFAULT_USERS, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));
  const port = await freePort();
  // Tên biến là CCRC_PORT và CCRC_DATA_DIR — không phải PORT. Dùng sai tên thì
  // server bind cổng mặc định 8720 và test đỏ vì lý do không liên quan.
  const proc = spawn('node', [SRV], {
    env: {
      ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let died = null;
  // Giữ lại vì cảnh báo CCRC_VAPID_SUBJECT lúc khởi động là MỘT DÒNG LOG —
  // không có API nào để hỏi hub "bạn có cảnh báo không", đúng khuôn với
  // stderr() của device-api.test.js.
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  proc.once('exit', (code, signal) => { died = `hub thoát sớm (code=${code}, signal=${signal})`; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    // Checked every round: a hub that failed to start must surface as THAT,
    // not as a puzzling 401 from whatever else answers on this port.
    if (died) throw new Error(`${died}\n${stderr}`);
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (died) throw new Error(`${died}\n${stderr}`);
  return { proc, base, dataDir, stop: () => proc.kill(), stderr: () => stderr };
}

const NOTE = { type: 'idle_prompt', title: '🔔 dev · dự-án', body: 'Claude đang chờ bạn nhập', tag: 'ccrc-idle_prompt' };

test('POST /notify với token hợp lệ được chấp nhận', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
    body: JSON.stringify(NOTE),
  });
  assert.equal(r.status, 200);
  // `pushed` reports whether the push actually went out — it is false only
  // when the user is already watching that session's terminal. With no
  // session registered at all there is nothing to suppress.
  assert.deepEqual(await r.json(), { ok: true, pushed: true });
  h.stop();
});

// --- Việc 1: không báo về phiên người dùng đang mở trên điện thoại ---------

async function registerTerminal(h, { sessionId, viewing }) {
  const r = await fetch(h.base + '/api/terminal/register', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
    body: JSON.stringify({
      sessionId, machine: 'may-dev', url: 'http://100.86.1.2:9/', secret: 'x'.repeat(32),
      label: 'k7m2', viewing,
    }),
  });
  assert.equal(r.status, 200);
}

async function notify(h, extra, token = 'tok-huy') {
  const r = await fetch(h.base + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ ...NOTE, ...extra }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

test('đang xem terminal của phiên đó → KHÔNG đẩy thông báo', async () => {
  const h = await startHub();
  try {
    await registerTerminal(h, { sessionId: 's-dang-xem', viewing: true });
    assert.deepEqual(await notify(h, { sessionId: 's-dang-xem' }), { ok: true, pushed: false });
  } finally { h.stop(); }
});

test('vẫn lưu vào "Gần đây" dù không đẩy — không được mất dấu', async () => {
  const h = await startHub();
  try {
    await registerTerminal(h, { sessionId: 's-dang-xem', viewing: true });
    await notify(h, { sessionId: 's-dang-xem' });
    const list = await (await fetch(h.base + '/api/notifications',
      { headers: { authorization: 'Bearer tok-huy' } })).json();
    assert.equal(list.items.length, 1, 'thông báo bị nuốt mất, không tra lại được');
  } finally { h.stop(); }
});

test('terminal mở nhưng đang ẩn (khoá màn hình) → VẪN đẩy', async () => {
  const h = await startHub();
  try {
    await registerTerminal(h, { sessionId: 's-an', viewing: false });
    assert.deepEqual(await notify(h, { sessionId: 's-an' }), { ok: true, pushed: true });
  } finally { h.stop(); }
});

test('đang xem phiên KHÁC → vẫn đẩy thông báo của phiên này', async () => {
  const h = await startHub();
  try {
    await registerTerminal(h, { sessionId: 's-dang-xem', viewing: true });
    await registerTerminal(h, { sessionId: 's-khac', viewing: false });
    assert.deepEqual(await notify(h, { sessionId: 's-khac' }), { ok: true, pushed: true });
  } finally { h.stop(); }
});

// The boundary every lookup in this hub has to respect: one person's session
// id must never answer a question asked on another person's behalf.
test('phiên của người khác đang xem → KHÔNG được làm mình mất thông báo', async () => {
  const h = await startHub();
  try {
    await registerTerminal(h, { sessionId: 's-cua-huy', viewing: true });
    // kien gửi thông báo, mượn đúng sessionId của huy
    assert.deepEqual(await notify(h, { sessionId: 's-cua-huy' }, 'tok-kien'), { ok: true, pushed: true });
  } finally { h.stop(); }
});

test('daemon cũ không gửi trường viewing → vẫn nhận thông báo bình thường', async () => {
  const h = await startHub();
  try {
    const r = await fetch(h.base + '/api/terminal/register', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ sessionId: 's-cu', machine: 'm', url: 'http://100.86.1.2:9/', secret: 'x'.repeat(32) }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await notify(h, { sessionId: 's-cu' }), { ok: true, pushed: true });
  } finally { h.stop(); }
});

test('sessionId không tồn tại / sai kiểu → vẫn đẩy, không nổ', async () => {
  const h = await startHub();
  try {
    assert.deepEqual(await notify(h, { sessionId: 'khong-co-that' }), { ok: true, pushed: true });
    assert.deepEqual(await notify(h, { sessionId: 12345 }), { ok: true, pushed: true });
    assert.deepEqual(await notify(h, {}), { ok: true, pushed: true });
  } finally { h.stop(); }
});

// --- sessionId trong lịch sử ------------------------------------------------
//
// Hook đã gửi sessionId từ trước (hook/src/notify-payload.js) và hub đã dùng
// nó ngay trên kia để nén push cho phiên đang được xem. Nó phải đi tiếp vào
// lịch sử nữa, vì đó là thứ duy nhất cho PWA biết thông báo này thuộc thẻ
// terminal nào — nếu không, "Gần đây" có nội dung mà không nối được về phiên.
async function historyOf(h, token = 'tok-huy') {
  const r = await fetch(h.base + '/api/notifications',
    { headers: { authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200);
  const { items } = await r.json();
  return items;
}

test('/notify kèm sessionId → lịch sử giữ lại để PWA biết thông báo của phiên nào', async () => {
  const h = await startHub();
  try {
    await notify(h, { sessionId: 's-abc' });
    const items = await historyOf(h);
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, 's-abc');
  } finally { h.stop(); }
});

test('/notify không kèm sessionId → note KHÔNG có trường đó, không phải chuỗi rỗng', async () => {
  const h = await startHub();
  try {
    await notify(h, {});
    const items = await historyOf(h);
    assert.equal('sessionId' in items[0], false,
      'trường rỗng bắt PWA phải phân biệt hai loại "không có"');
  } finally { h.stop(); }
});

test('/notify với sessionId sai kiểu → lịch sử bỏ qua trường đó, không nổ', async () => {
  const h = await startHub();
  try {
    await notify(h, { sessionId: 12345 });
    const items = await historyOf(h);
    assert.equal('sessionId' in items[0], false);
  } finally { h.stop(); }
});

test('sessionId dài bất thường bị cắt như title/body — không nhận chuỗi tuỳ ý vào RAM', async () => {
  const h = await startHub();
  try {
    await notify(h, { sessionId: 'x'.repeat(5000) });
    const items = await historyOf(h);
    assert.equal(items[0].sessionId.length, 200);
  } finally { h.stop(); }
});

test('gửi hơn 50 thông báo → "Gần đây" chỉ giữ đúng 50 mục mới nhất', async () => {
  const h = await startHub();
  try {
    for (let i = 1; i <= HISTORY_MAX + 5; i++) {
      await notify(h, { title: `t-${i}` });
    }
    const items = await historyOf(h);
    assert.equal(items.length, HISTORY_MAX, 'phải cắt đúng ở HISTORY_MAX, không phình vô hạn');
    assert.equal(items[0].title, `t-${HISTORY_MAX + 5}`, 'mới nhất phải đứng đầu');
    assert.equal(items[HISTORY_MAX - 1].title, 't-6', 'năm mục cũ nhất (t-1..t-5) phải bị đẩy ra');
  } finally { h.stop(); }
});

test('token sai bị từ chối 401', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sai-be-bet' },
    body: JSON.stringify(NOTE),
  });
  assert.equal(r.status, 401);
  h.stop();
});

test('thiếu hẳn header authorization bị từ chối 401', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(NOTE),
  });
  assert.equal(r.status, 401);
  h.stop();
});

test('payload dị dạng không làm sập hub', async () => {
  const h = await startHub();
  for (const body of ['null', '"chuỗi"', '42', '[]', '{bad', '{}']) {
    const r = await fetch(h.base + '/notify', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' }, body,
    });
    assert.ok(r.status === 200 || r.status === 400, `status lạ: ${r.status}`);
  }
  // Hub vẫn sống sau tất cả
  assert.equal((await fetch(h.base + '/healthz')).status, 200);
  h.stop();
});

test('/api/me trả về tên người dùng và số thiết bị đã đăng ký push', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/api/me', { headers: { authorization: 'Bearer tok-huy' } });
  assert.equal(r.status, 200);
  const me = await r.json();
  assert.equal(me.user, 'huy');
  assert.equal(me.pushDevices, 0);
  h.stop();
});

test('/api/notifications chỉ trả về thông báo của chính mình', async () => {
  const h = await startHub();
  await fetch(h.base + '/notify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' }, body: JSON.stringify({ ...NOTE, body: 'của huy' }) });
  await fetch(h.base + '/notify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-kien' }, body: JSON.stringify({ ...NOTE, body: 'của kien' }) });

  const mine = await (await fetch(h.base + '/api/notifications', { headers: { authorization: 'Bearer tok-huy' } })).json();
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].body, 'của huy');

  const theirs = await (await fetch(h.base + '/api/notifications', { headers: { authorization: 'Bearer tok-kien' } })).json();
  assert.equal(theirs.items.length, 1);
  assert.equal(theirs.items[0].body, 'của kien');
  h.stop();
});

test('lịch sử cắt ở 50 mục, mới nhất lên đầu', async () => {
  const h = await startHub();
  for (let i = 0; i < 55; i++) {
    await fetch(h.base + '/notify', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ ...NOTE, body: 'số ' + i }),
    });
  }
  const j = await (await fetch(h.base + '/api/notifications', { headers: { authorization: 'Bearer tok-huy' } })).json();
  assert.equal(j.items.length, 50);
  assert.equal(j.items[0].body, 'số 54', 'mới nhất phải lên đầu');
  h.stop();
});

test('/api/vapid-key trả về khoá công khai', async () => {
  const h = await startHub();
  const j = await (await fetch(h.base + '/api/vapid-key')).json();
  assert.ok(typeof j.publicKey === 'string' && j.publicKey.length > 20);
  h.stop();
});

// --- Kiểm toán 2026-08-12: CCRC_VAPID_SUBJECT mặc định bị Apple từ chối ----
//
// Xác nhận sống với một hub thật và một subscription iPhone thật: đổi đúng
// một biến này, giữ nguyên mọi thứ khác, quan sát 403 BadJwtToken đổi thành
// 201. Google/Mozilla nuốt subject mặc định mà không phàn nàn, nên lỗi chỉ lộ
// ra trên iPhone — đúng đối tượng chính của sản phẩm. Hub không được từ chối
// khởi động vì việc này (một hub chỉ phục vụ Android vẫn đúng với subject mặc
// định), nên cách đúng là cảnh báo to ra log, không phải chặn.
async function subjectWarning(extraVapidEnv) {
  const h = await startHub(DEFAULT_USERS, { CCRC_VAPID_SUBJECT: '', ...extraVapidEnv });
  try {
    assert.equal((await fetch(h.base + '/healthz')).status, 200, 'hub phải sống dù subject có vấn đề');
    const vapid = await (await fetch(h.base + '/api/vapid-key')).json();
    assert.ok(typeof vapid.publicKey === 'string' && vapid.publicKey.length > 20,
      'hub phải phục vụ bình thường, không chỉ /healthz — cảnh báo không được làm gãy route khác');
    return h.stderr();
  } finally { h.stop(); }
}

test('không đặt CCRC_VAPID_SUBJECT (rơi về mặc định) → hub cảnh báo ra log lúc khởi động', async () => {
  const stderr = await subjectWarning({});
  assert.match(stderr, /CCRC_VAPID_SUBJECT/, `phải nêu tên biến để người vận hành biết sửa gì. stderr=${stderr}`);
  assert.match(stderr, /BadJwtToken/i, `phải nói rõ Apple từ chối thế nào, không chỉ "có vấn đề". stderr=${stderr}`);
});

test('CCRC_VAPID_SUBJECT trỏ về localhost → hub cảnh báo, dù không phải giá trị mặc định', async () => {
  const stderr = await subjectWarning({ CCRC_VAPID_SUBJECT: 'mailto:admin@localhost' });
  assert.match(stderr, /CCRC_VAPID_SUBJECT/, `stderr=${stderr}`);
});

test('CCRC_VAPID_SUBJECT là domain https thật → KHÔNG cảnh báo', async () => {
  const stderr = await subjectWarning({ CCRC_VAPID_SUBJECT: 'https://hub.acme.dev' });
  assert.doesNotMatch(stderr, /CCRC_VAPID_SUBJECT/,
    `subject hợp lệ mà vẫn bị cảnh báo thì người vận hành sẽ bỏ qua cảnh báo thật. stderr=${stderr}`);
});

test('CCRC_VAPID_SUBJECT là mailto thật → KHÔNG cảnh báo', async () => {
  const stderr = await subjectWarning({ CCRC_VAPID_SUBJECT: 'mailto:ops@mycompany.vn' });
  assert.doesNotMatch(stderr, /CCRC_VAPID_SUBJECT/, `stderr=${stderr}`);
});

test('không còn endpoint WebSocket', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/ws', { headers: { authorization: 'Bearer tok-huy' } });
  assert.equal(r.status, 404);
  h.stop();
});

const SUB_A = { endpoint: 'https://web.push.apple.com/AAA', keys: { p256dh: 'k1', auth: 'a1' } };
const SUB_B = { endpoint: 'https://fcm.googleapis.com/fcm/send/BBB', keys: { p256dh: 'k2', auth: 'a2' } };

const post = (h, path, token, body) => fetch(h.base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const devices = async (h, token) =>
  (await (await fetch(h.base + '/api/me', { headers: { authorization: `Bearer ${token}` } })).json()).pushDevices;

// A failing assertion must still stop the hub, otherwise the orphaned child
// keeps the test runner's event loop alive and the whole suite hangs instead
// of reporting the failure.
async function withHub(fn) {
  const h = await startHub();
  try { await fn(h); } finally { h.stop(); }
}

test('huỷ đăng ký xoá đúng thiết bị gọi lên, giữ nguyên thiết bị còn lại', async () => {
  await withHub(async (h) => {
    await post(h, '/api/push/subscribe', 'tok-huy', SUB_A);
    await post(h, '/api/push/subscribe', 'tok-huy', SUB_B);
    assert.equal(await devices(h, 'tok-huy'), 2);

    const r = await post(h, '/api/push/unsubscribe', 'tok-huy', { endpoint: SUB_A.endpoint });
    assert.equal(r.status, 200);
    assert.equal(await devices(h, 'tok-huy'), 1, 'chỉ được xoá đúng một');
  });
});

test('huỷ đăng ký hai lần không lỗi — bấm lại vẫn yên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/push/subscribe', 'tok-huy', SUB_A);
    await post(h, '/api/push/unsubscribe', 'tok-huy', { endpoint: SUB_A.endpoint });
    const r = await post(h, '/api/push/unsubscribe', 'tok-huy', { endpoint: SUB_A.endpoint });
    assert.equal(r.status, 200);
    assert.equal(await devices(h, 'tok-huy'), 0);
  });
});

test('KHÔNG huỷ được đăng ký của người khác', async () => {
  await withHub(async (h) => {
    await post(h, '/api/push/subscribe', 'tok-kien', SUB_A);
    await post(h, '/api/push/unsubscribe', 'tok-huy', { endpoint: SUB_A.endpoint });
    assert.equal(await devices(h, 'tok-kien'), 1, 'thiết bị của kien phải còn nguyên');
  });
});

test('huỷ đăng ký không có token bị từ chối 401', async () => {
  await withHub(async (h) => {
    const r = await fetch(h.base + '/api/push/unsubscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: SUB_A.endpoint }),
    });
    assert.equal(r.status, 401);
  });
});

test('huỷ đăng ký thiếu endpoint bị từ chối 400', async () => {
  await withHub(async (h) => {
    const r = await post(h, '/api/push/unsubscribe', 'tok-huy', {});
    assert.equal(r.status, 400);
  });
});

// --- Danh sách thiết bị: xem là những thiết bị nào, và xoá được -------------

const SUB = (id, host = 'web.push.apple.com') => ({
  endpoint: `https://${host}/${id}`,
  keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
});

async function subscribe(h, sub, token = 'tok-huy', ua = null) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
  if (ua) headers['user-agent'] = ua;
  const r = await fetch(h.base + '/api/push/subscribe', {
    method: 'POST', headers, body: JSON.stringify(sub),
  });
  assert.equal(r.status, 200);
}

async function deviceList(h, endpoint = null, token = 'tok-huy') {
  const r = await fetch(h.base + '/api/push/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ endpoint }),
  });
  assert.equal(r.status, 200);
  return (await r.json()).devices;
}

test('liệt kê thiết bị: có dịch vụ đẩy, và đánh dấu đúng thiết bị đang hỏi', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('a'));
    await subscribe(h, SUB('b', 'fcm.googleapis.com'));
    const list = await deviceList(h, `https://fcm.googleapis.com/b`);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.service), ['Apple', 'Google']);
    assert.deepEqual(list.map((d) => d.current), [false, true]);
  } finally { h.stop(); }
});

test('đăng ký kèm user-agent → có nhãn và ngày; endpoint KHÔNG lộ ra', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('iphone'), 'tok-huy',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
    const [d] = await deviceList(h);
    assert.equal(d.label, 'iPhone · Safari');
    assert.ok(typeof d.addedAt === 'number' && d.addedAt > 0);
    const all = JSON.stringify(d);
    assert.ok(!all.includes('iphone'), `endpoint lọt ra: ${all}`);
    assert.ok(!all.includes('p256dh'), 'khoá lọt ra');
  } finally { h.stop(); }
});

test('xoá một thiết bị theo id — những cái khác còn nguyên', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('a'));
    await subscribe(h, SUB('b'));
    await subscribe(h, SUB('c'));
    const before = await deviceList(h);
    const victim = before[1];

    const r = await fetch(h.base + '/api/push/devices/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ id: victim.id }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, pushDevices: 2 });

    const after = await deviceList(h);
    assert.equal(after.length, 2);
    assert.ok(!after.some((d) => d.id === victim.id), 'thiết bị bị xoá vẫn còn');
  } finally { h.stop(); }
});

// The boundary this hub has to respect everywhere: one person's id must never
// act on another person's account.
test('id của người khác KHÔNG xoá được thiết bị của mình', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('cua-huy'), 'tok-huy');
    const [huyDevice] = await deviceList(h, null, 'tok-huy');

    // kien gửi đúng id thiết bị của huy
    const r = await fetch(h.base + '/api/push/devices/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-kien' },
      body: JSON.stringify({ id: huyDevice.id }),
    });
    assert.equal(r.status, 200); // xoá thứ không có trong danh sách CỦA MÌNH là no-op
    assert.equal((await deviceList(h, null, 'tok-huy')).length, 1, 'thiết bị của huy bị người khác xoá mất');
  } finally { h.stop(); }
});

test('người này không thấy thiết bị của người kia', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('cua-huy'), 'tok-huy');
    await subscribe(h, SUB('cua-kien'), 'tok-kien');
    assert.equal((await deviceList(h, null, 'tok-huy')).length, 1);
    assert.equal((await deviceList(h, null, 'tok-kien')).length, 1);
  } finally { h.stop(); }
});

// The action that actually solves an accumulated list — four entries from four
// reinstalls of one phone cannot be told apart, but the user always knows
// which device is in their hand.
test('giữ lại chỉ thiết bị này — xoá hết phần còn lại', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('cu-1'));
    await subscribe(h, SUB('cu-2'));
    await subscribe(h, SUB('cu-3'));
    await subscribe(h, SUB('dang-cam'));
    const r = await fetch(h.base + '/api/push/devices/keep-only', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ endpoint: 'https://web.push.apple.com/dang-cam' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, pushDevices: 1 });
    const left = await deviceList(h, 'https://web.push.apple.com/dang-cam');
    assert.equal(left.length, 1);
    assert.equal(left[0].current, true, 'giữ nhầm thiết bị');
  } finally { h.stop(); }
});

// Refusing this is the difference between "clean up" and "silence every phone
// I own" — an endpoint not in the list would match nothing and wipe the lot.
test('giữ-lại-thiết-bị-này với endpoint KHÔNG có trong danh sách → từ chối, không xoá gì', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('a'));
    await subscribe(h, SUB('b'));
    const r = await fetch(h.base + '/api/push/devices/keep-only', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ endpoint: 'https://web.push.apple.com/khong-co-that' }),
    });
    assert.equal(r.status, 409);
    assert.equal((await deviceList(h)).length, 2, 'đã xoá sạch dù endpoint không hợp lệ');
  } finally { h.stop(); }
});

test('giữ-lại chỉ đụng danh sách của chính mình', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('cua-huy-1'), 'tok-huy');
    await subscribe(h, SUB('cua-huy-2'), 'tok-huy');
    await subscribe(h, SUB('cua-kien'), 'tok-kien');
    await fetch(h.base + '/api/push/devices/keep-only', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
      body: JSON.stringify({ endpoint: 'https://web.push.apple.com/cua-huy-1' }),
    });
    assert.equal((await deviceList(h, null, 'tok-kien')).length, 1, 'thiết bị của kien bị cuốn theo');
  } finally { h.stop(); }
});

test('id thiếu hoặc sai kiểu → 400, không xoá gì', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('a'));
    for (const body of [{}, { id: 42 }, { id: '' }, { id: null }]) {
      const r = await fetch(h.base + '/api/push/devices/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await deviceList(h)).length, 1);
  } finally { h.stop(); }
});

test('cần token — không có thì 401', async () => {
  const h = await startHub();
  try {
    for (const p of ['/api/push/devices', '/api/push/devices/delete', '/api/push/devices/keep-only']) {
      const r = await fetch(h.base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 401, p);
    }
  } finally { h.stop(); }
});

test('đăng ký lại cùng endpoint không tạo thiết bị trùng', async () => {
  const h = await startHub();
  try {
    await subscribe(h, SUB('a'));
    await subscribe(h, SUB('a'));
    await subscribe(h, SUB('a'));
    assert.equal((await deviceList(h)).length, 1);
  } finally { h.stop(); }
});

// --- Gói cài cho máy dev ---------------------------------------------------
//
// `install.sh` is public and holds no secrets. The SOURCE it downloads is not:
// the repository is private, so the bundle sits behind the same token as
// everything else. Serving it from a static path would publish the code to
// anyone who guessed the URL.

test('gói cài ĐÒI token — không có thì 401', async () => {
  const h = await startHub();
  try {
    const r = await fetch(h.base + '/api/install/bundle.tar.gz');
    assert.equal(r.status, 401);
  } finally { h.stop(); }
});

test('token sai cũng 401', async () => {
  const h = await startHub();
  try {
    const r = await fetch(h.base + '/api/install/bundle.tar.gz',
      { headers: { authorization: 'Bearer sai-be-bet' } });
    assert.equal(r.status, 401);
  } finally { h.stop(); }
});

// Outside Docker there is no bundle — it is built into the image. Saying so
// beats a bare 404, which reads like a mistyped path.
test('chưa có gói (chạy ngoài Docker) → 503 kèm lời giải thích, không phải 404', async () => {
  const h = await startHub();
  try {
    const r = await fetch(h.base + '/api/install/bundle.tar.gz',
      { headers: { authorization: 'Bearer tok-huy' } });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /gói cài/i);
  } finally { h.stop(); }
});

// The two scripts must stay reachable WITHOUT a token: that is the whole point
// of a one-command install, and the uninstaller must work for someone who has
// lost or never had one.
test('install.sh và uninstall.sh phục vụ công khai, không cần token', async () => {
  const h = await startHub();
  try {
    for (const p of ['/install.sh', '/uninstall.sh']) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 200, p);
      const body = await r.text();
      assert.match(body, /^#!\/bin\/sh/, `${p} phải là script sh`);
      assert.equal(r.headers.get('cache-control'), 'no-cache',
        `${p} phải revalidate, nếu không người cài chạy bản cũ`);
    }
  } finally { h.stop(); }
});

// A public file that shipped a token would hand every reader an account.
test('install.sh KHÔNG chứa token hay bí mật nào', async () => {
  const h = await startHub();
  try {
    const body = await (await fetch(h.base + '/install.sh')).text();
    assert.ok(!body.includes('tok-huy'), 'lộ token');
    assert.ok(!/[0-9a-f]{32}/.test(body), 'có chuỗi trông như token/khoá');
    // The token must arrive as an argument, never be baked in.
    assert.match(body, /\$\{1:-\$\{CCRC_TOKEN:-\}\}/, 'phải nhận token từ tham số');
  } finally { h.stop(); }
});

// --- Kiểm toán 2026-07-29, lỗi 1: "admin" là tên dành riêng ----------------
//
// Phần bên terminal của lỗi này (xin vé vào phiên của chủ hub) nằm ở
// terminal-api.test.js. Đây là phần còn lại, và nó không được tailnet nào che
// cho cả: lịch sử thông báo và danh sách thiết bị đẩy chỉ khoá theo tên người
// dùng, nên một danh tính 'admin' thứ hai đọc thẳng được — và xoá được.
const USERS_WITH_IMPOSTOR = [
  { name: 'huy', token: 'tok-huy' },
  { name: 'admin', token: 'tok-gia-mao' },
];

test('user tên "admin" KHÔNG đọc được lịch sử thông báo của chủ hub', async () => {
  const h = await startHub(USERS_WITH_IMPOSTOR);
  try {
    // Chủ hub nhận một thông báo. Tiêu đề mang tên máy và tên phiên.
    await fetch(h.base + '/notify', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin-tok' },
      body: JSON.stringify(NOTE),
    });

    const r = await fetch(h.base + '/api/notifications',
      { headers: { authorization: 'Bearer tok-gia-mao' } });
    assert.equal(r.status, 401, 'lịch sử thông báo là dấu vết giờ giấc làm việc của người ta');
  } finally { h.stop(); }
});

test('user tên "admin" KHÔNG xoá được thiết bị nhận thông báo của chủ hub', async () => {
  const h = await startHub(USERS_WITH_IMPOSTOR);
  try {
    const r = await fetch(h.base + '/api/push/devices/delete', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-gia-mao' },
      body: JSON.stringify({ id: 'x'.repeat(16) }),
    });
    assert.equal(r.status, 401, 'xoá hết thiết bị của chủ hub là làm họ câm lặng mà không hay biết');
  } finally { h.stop(); }
});

test('/api/me của user tên "admin" bị từ chối, không trả về danh tính chủ hub', async () => {
  const h = await startHub(USERS_WITH_IMPOSTOR);
  try {
    const r = await fetch(h.base + '/api/me', { headers: { authorization: 'Bearer tok-gia-mao' } });
    assert.equal(r.status, 401);
  } finally { h.stop(); }
});

// --- Unit-level tests against createNotificationHistory() directly --------
//
// TTL 24 giờ không thể kiểm ở tầng HTTP mà không đợi thật hoặc thêm một cổng
// cấu hình chỉ để phục vụ test — spec cố tình không làm vậy (spec §2). Import
// thẳng module, tiêm đồng hồ giả, là cách duy nhất kiểm được biên của nó.

test('[unit] thông báo mới ghi thì list() trả về ngay, có trường "at"', () => {
  let t = 1_000;
  const history = createNotificationHistory({ now: () => t });
  history.remember('huy', { title: 't-1' });
  const items = history.list('huy');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 't-1');
  assert.equal(items[0].at, 1_000);
});

test('[unit] đúng ngưỡng HISTORY_TTL_MS (chưa vượt) → vẫn còn', () => {
  let t = 0;
  const history = createNotificationHistory({ now: () => t });
  history.remember('huy', { title: 't-1' });
  t = HISTORY_TTL_MS;
  assert.equal(history.list('huy').length, 1, 'đúng bằng ngưỡng thì chưa bị prune');
});

test('[unit] vượt HISTORY_TTL_MS → bị prune, list() trả rỗng', () => {
  let t = 0;
  const history = createNotificationHistory({ now: () => t });
  history.remember('huy', { title: 't-1' });
  t = HISTORY_TTL_MS + 1;
  assert.deepEqual(history.list('huy'), []);
});

test('[unit] mục còn hạn không bị kéo theo khi mục cũ hơn cùng user đã hết hạn', () => {
  let t = 0;
  const history = createNotificationHistory({ now: () => t });
  history.remember('huy', { title: 't-cu' }); // at = 0
  t = HISTORY_TTL_MS - 1;
  history.remember('huy', { title: 't-moi' }); // at = HISTORY_TTL_MS - 1, còn hạn ở bước sau
  t = HISTORY_TTL_MS + 1; // t-cu tuổi HISTORY_TTL_MS+1 (hết hạn); t-moi tuổi 2 (còn hạn)
  const items = history.list('huy');
  assert.equal(items.length, 1, 'chỉ mục hết hạn bị dọn');
  assert.equal(items[0].title, 't-moi');
});

test('[unit] hết hạn ở user này không đụng lịch sử của user khác', () => {
  let t = 0;
  const history = createNotificationHistory({ now: () => t });
  history.remember('huy', { title: 't-huy' }); // at = 0
  t = 100;
  history.remember('kien', { title: 't-kien' }); // at = 100
  t = HISTORY_TTL_MS + 50; // huy tuổi TTL+50 (hết hạn); kien tuổi TTL-50 (còn hạn)
  assert.deepEqual(history.list('huy'), []);
  assert.equal(history.list('kien').length, 1);
});

test('[unit] vẫn cắt đúng HISTORY_MAX dù chưa hết hạn', () => {
  let t = 0;
  const history = createNotificationHistory({ now: () => t });
  for (let i = 1; i <= HISTORY_MAX + 5; i++) {
    t = i; // mỗi mục cách nhau 1ms — tất cả còn rất mới so với HISTORY_TTL_MS
    history.remember('huy', { title: `t-${i}` });
  }
  const items = history.list('huy');
  assert.equal(items.length, HISTORY_MAX);
  assert.equal(items[0].title, `t-${HISTORY_MAX + 5}`, 'mới nhất phải đứng đầu');
});

test('[unit] list() trả mảy rỗng cho user chưa từng có thông báo', () => {
  const history = createNotificationHistory();
  assert.deepEqual(history.list('ai-do-chua-tung'), []);
});
