// Device-code qua HTTP thật. Cùng khuôn startHub với terminal-api.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

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

async function startHub(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-dev-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'),
    JSON.stringify([{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok-huy' }]));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: {
      ...process.env,
      CCRC_DATA_DIR: dataDir,
      CCRC_PORT: String(port),
      CCRC_TOKEN: 'admin-tok',
      // Xoá biến của môi trường ngoài rồi mới chồng `extraEnv` lên: mặc định
      // "không tin proxy" là thứ đang được kiểm, nên nó không được phép phụ
      // thuộc vào shell của người chạy test.
      CCRC_TRUST_PROXY: '',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // stderr được giữ lại vì một trong những chốt ở đây (rate-limit) có phần
  // việc duy nhất mà người vận hành thấy được là MỘT DÒNG LOG — chế độ hỏng
  // cũ của nó là hoàn toàn im lặng.
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop: () => proc.kill(), stderr: () => stderr };
}

const post = (base, p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  },
  body: JSON.stringify(body || {}),
});

// Duyệt TRƯỚC rồi mới poll lần đầu. Lần poll đầu không bị chặn nhịp
// (`lastPollAt` còn 0), nên test không phải ngủ 5 giây thật — POLL_INTERVAL_S
// nằm trong tiến trình hub nên không tiêm `now` vào được từ đây.
test('start → approve → poll ra đúng token của người duyệt', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.ok(s.deviceCode && s.userCode);

    const ap = await post(hub.base, '/api/device/approve', { userCode: s.userCode }, 'tok-huy');
    assert.equal(ap.status, 200);

    const p = await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    assert.equal(p.status, 200);
    const body = await p.json();
    assert.equal(body.token, 'tok-huy');
    assert.equal(body.displayName, 'huy');
  } finally { hub.stop(); }
});

test('chưa duyệt thì poll trả 428', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.equal((await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode })).status, 428);
  } finally { hub.stop(); }
});

test('approve KHÔNG có token thì 401', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.equal((await post(hub.base, '/api/device/approve', { userCode: s.userCode })).status, 401);
  } finally { hub.stop(); }
});

test('deviceCode bịa ra → 410', async () => {
  const hub = await startHub();
  try {
    const r = await post(hub.base, '/api/device/poll', { deviceCode: 'bia-dat' });
    assert.equal(r.status, 410);
  } finally { hub.stop(); }
});

test('poll nhanh quá → 429', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    const r = await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    assert.equal(r.status, 429);
  } finally { hub.stop(); }
});

test('gõ sai userCode trả về số lần còn lại', async () => {
  const hub = await startHub();
  try {
    await post(hub.base, '/api/device/start');
    const r = await post(hub.base, '/api/device/approve', { userCode: 'ZZZZ-ZZZZ' }, 'tok-huy');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).remaining, 4);
  } finally { hub.stop(); }
});

test('GET /link phục vụ trang PWA chứ không 404', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/link');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div id="link-card"/);
  } finally { hub.stop(); }
});

// Chủ hub duyệt bằng CCRC_TOKEN (nhánh admin của resolveUser), không phải
// token của một user trong users.json. Nhánh đó phải trả displayName giống
// nhánh usersByToken, nếu không grant đi ra khỏi poll() sẽ thiếu tên hiển thị
// đúng cho chính người dùng đầu tiên mà tính năng này phục vụ.
test('duyệt bằng token của hub (admin) thì poll ra đủ cả token lẫn displayName', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    const ap = await post(hub.base, '/api/device/approve', { userCode: s.userCode }, 'admin-tok');
    assert.equal(ap.status, 200);

    const p = await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    const body = await p.json();
    assert.equal(body.token, 'admin-tok');
    assert.equal(body.displayName, 'admin');
  } finally { hub.stop(); }
});

// /link phục vụ index.html qua route tay, không qua express.static — nên
// không tự động thừa hưởng no-cache mà setHeaders() gắn cho mọi asset khác.
// Thiếu dòng này, /link sẽ rơi vào đúng cái bẫy Cloudflare 4h mà setHeaders()
// sinh ra để tránh, và khi Task 9 thêm #link-card, trang cũ có thể còn bị
// cache thêm nhiều giờ.
test('GET /link trả Cache-Control: no-cache', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/link');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  } finally { hub.stop(); }
});

// Khoá của mọi state trên hub là slack_user_id ("U01ABCDEF"). Nếu /api/me trả
// về nó thì header PWA hiện một chuỗi máy đọc cho mọi người đăng nhập bằng
// Slack, và không ai đối chiếu được mình đang dùng tài khoản nào. displayName
// là trường sinh ra đúng để hiển thị (spec §3, quyết định 6) — không có bài
// kiểm này thì nó đi hết đường ống mà không tới mắt ai.
test('/api/me trả về displayName để hiển thị, không phải slack_user_id', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/api/me', { headers: { authorization: 'Bearer tok-huy' } });
    assert.equal(r.status, 200);
    const me = await r.json();
    assert.equal(me.user, 'huy', 'phải là displayName');
    assert.notEqual(me.user, 'U01ABCDEF', 'không được là khoá slack_user_id');
  } finally { hub.stop(); }
});

// --- chốt thứ hai của spec §5.2: rate-limit theo IP ------------------------
//
// Endpoint này không có auth và với tới được từ internet qua Cloudflare
// Tunnel. Chỉ có trần MAX_PENDING thì 50 POST ẩn danh mỗi 10 phút giữ kín mọi
// chỗ pending, và mọi ./setup-notify.sh từ đó rơi ÊM về hỏi token tay.
test('/api/device/start chặn theo IP sau đủ số lượt, kèm Retry-After', async () => {
  const hub = await startHub();
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(hub.base, '/api/device/start');
      codes.push(r.status);
      if (r.status === 429) {
        assert.ok(Number(r.headers.get('retry-after')) > 0,
          'phải nói khi nào quay lại được, nếu không script chỉ biết đập cửa tiếp');
        const body = await r.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /thử lại sau/i);
      }
    }
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200],
      'một người cài máy mới, gõ sai vài lần, không được chạm trần');
    assert.equal(codes[5], 429, 'lượt thứ 6 từ cùng một IP phải bị chặn');

    // Chế độ hỏng cũ là IM LẶNG hoàn toàn: mọi installer rơi về dán token tay
    // và không có dòng nào ở đâu nói vì sao. Một dòng log là toàn bộ thứ
    // người vận hành có.
    await new Promise((r) => setTimeout(r, 100));
    assert.match(hub.stderr(), /device\/start.*vượt 5 lượt/,
      `hub phải ghi log khi trần bị chạm. stderr=${hub.stderr()}`);
  } finally { hub.stop(); }
});

// --- khoá rate-limit không được để client tự chọn ---------------------------
//
// docker-compose publish cổng 8720 ở `${CCRC_BIND:-0.0.0.0}` trong MỌI profile,
// nên luôn tồn tại một đường đi THẲNG vào hub, không qua proxy nào. Trên đường
// đó, "chặng gần app nhất" mà `trust proxy` tin lại chính là client — nó tự
// đặt X-Forwarded-For, tự chọn khoá đếm, và chốt 5 lượt/10 phút thành trang
// trí. Đây là bài kiểm cho đúng cái lỗ đó: đã đo được 7/7 lượt đi lọt khi hub
// bật `trust proxy` vô điều kiện.
const startWithXff = (base, xff) => fetch(base + '/api/device/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
  body: '{}',
});

test('không có CCRC_TRUST_PROXY: xoay X-Forwarded-For KHÔNG thoát được rate-limit', async () => {
  const hub = await startHub();
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      // Mỗi lượt một IP giả khác nhau — đúng kiểu một script tấn công viết ra.
      codes.push((await startWithXff(hub.base, `203.0.113.${i + 1}`)).status);
    }
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.deepEqual(codes.slice(5), [429, 429],
      `header bịa ra không được đổi khoá đếm — mặc định khoá là địa chỉ socket. codes=${codes}`);
  } finally { hub.stop(); }
});

// Cờ đọc theo ALLOWLIST, không phải denylist. Một danh sách "những chữ nghĩa
// là không" ('', '0', 'false', 'no', 'off') fail OPEN: `none`, `disabled`,
// `n`, `null` rơi ra ngoài và thành BẬT — đúng hướng hỏng âm thầm mà cả chốt
// này sinh ra để tránh. Giá trị lạ phải là TẮT.
test('CCRC_TRUST_PROXY=none là TẮT — giá trị lạ không được fail open', async () => {
  const hub = await startHub({ CCRC_TRUST_PROXY: 'none' });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await startWithXff(hub.base, `192.0.2.${i + 1}`)).status);
    }
    assert.equal(codes[5], 429,
      `"none" phải được hiểu là tắt, không phải "chuỗi khác rỗng nên bật". codes=${codes}`);
  } finally { hub.stop(); }
});

// Mặt còn lại của cùng một quyết định: khi người vận hành nói rõ là CÓ proxy,
// chốt phải quay lại đếm theo từng client thật. Không có bài này thì "sửa" cho
// an toàn rất dễ thành đếm chung một rổ cho cả internet — cả team bị một người
// gọi nhiều làm cho 429, tự gây DoS cho chính deployment mà README khuyến nghị.
test('CCRC_TRUST_PROXY=1: hai client sau proxy có hai rổ đếm riêng', async () => {
  const hub = await startHub({ CCRC_TRUST_PROXY: '1' });
  try {
    const a = [];
    for (let i = 0; i < 6; i++) a.push((await startWithXff(hub.base, '198.51.100.7')).status);
    assert.deepEqual(a, [200, 200, 200, 200, 200, 429], `client A phải bị chặn ở lượt 6. a=${a}`);

    // Client B chưa gọi lượt nào — nó không được lãnh hậu quả của A.
    const b = await startWithXff(hub.base, '198.51.100.8');
    assert.equal(b.status, 200, 'client khác phải có rổ đếm riêng');

    // Và chặng do "proxy" ghi là phần tử CUỐI: thứ client tự nhét vào bên trái
    // không được tính. Cùng chặng cuối 198.51.100.7 → vẫn thuộc rổ đã bị chặn.
    const spoof = await startWithXff(hub.base, '10.0.0.1, 198.51.100.7');
    assert.equal(spoof.status, 429,
      'chỉ chặng cuối mới tính; nhét thêm IP vào bên trái không đổi được rổ');
  } finally { hub.stop(); }
});

// Chặn xong thì phải chặn CẢ việc cấp phiên: một lượt bị từ chối mà vẫn ngốn
// một chỗ pending là chốt chỉ có tiếng, không có miếng.
test('lượt bị rate-limit KHÔNG tiêu một chỗ pending nào', async () => {
  const hub = await startHub();
  try {
    for (let i = 0; i < 5; i++) await post(hub.base, '/api/device/start');
    const blocked = await post(hub.base, '/api/device/start');
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.deviceCode, undefined, 'bị chặn thì không được cấp mã nào');
    assert.equal(body.userCode, undefined);
  } finally { hub.stop(); }
});
