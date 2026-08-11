// Luồng đăng nhập Slack, qua HTTP thật — khuôn `terminal-api.test.js`.
//
// Ở đây có một token vĩnh viễn đi qua trình duyệt, nên thứ đáng test nhất
// không phải "đăng nhập được không" mà là: token KHÔNG bao giờ nằm trong URL,
// `state` không dùng lại được, và không có lỗi nào để lại users.json ghi dở.
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

// token-slayer giả: trả đúng thứ endpoint thật trả, và ghi lại nó nhận được gì.
async function startFakeTs(handler) {
  const port = await freePort();
  const { createServer } = await import('node:http');
  const calls = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const { status, json } = handler(JSON.parse(body || '{}'));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, calls, stop: () => srv.close() };
}

async function startHub(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-auth-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([]));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: {
      ...process.env,
      CCRC_DATA_DIR: dataDir,
      CCRC_PORT: String(port),
      CCRC_TOKEN: 'admin-tok',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let died = null;
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  proc.once('exit', (code) => { died = `hub thoát sớm (code=${code})`; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (died) throw new Error(`${died}\n${stderr}`);
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const usersFile = path.join(dataDir, 'users.json');
  return {
    base,
    stop: () => proc.kill(),
    users: () => JSON.parse(fs.readFileSync(usersFile, 'utf8')),
  };
}

const okIdentity = () => ({ status: 200, json: { slackUserId: 'U01ABCDEF', handle: 'huy' } });

// fetch của Node không có cookie jar, nên việc mà TRÌNH DUYỆT làm — mang
// cookie ccrc_oauth từ /auth/start sang /auth/callback — phải làm tay ở đây.
// Đúng chỗ này là điểm mấu chốt của cả nhóm test dưới: một callback KHÔNG
// kèm cookie chính là cú tấn công (Mallory gửi link cho Bob), nên nó phải
// hỏng, và mọi test luồng-bình-thường phải nói rõ nó đang giả lập một trình
// duyệt duy nhất đi hết cả hai chặng.
function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];   // "ccrc_oauth=<nonce>"
}

async function startLogin(hub) {
  const r = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
  return {
    res: r,
    state: new URL(r.headers.get('location')).searchParams.get('state'),
    cookie: cookieOf(r),
  };
}

// Một chuyến callback của cùng trình duyệt đã bấm đăng nhập.
function callback(hub, { state, cookie, token = 't' }) {
  return fetch(`${hub.base}/auth/callback?token=${token}&state=${state}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

test('chưa cấu hình thì không có nút Slack và /auth/start từ chối', async () => {
  const hub = await startHub();
  try {
    const cfg = await (await fetch(hub.base + '/api/auth/config')).json();
    assert.equal(cfg.slackLogin, false);
    const r = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    assert.equal(r.status, 503);
  } finally { hub.stop(); }
});

test('/auth/start redirect sang token-slayer kèm return=ccrc và state', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://ts.example.com/auth/slack');
    assert.equal(loc.searchParams.get('return'), 'ccrc');
    assert.ok(loc.searchParams.get('state').length >= 40);
  } finally { hub.stop(); ts.stop(); }
});

test('callback tạo user rồi trả claimCode — TOKEN KHÔNG nằm trong URL', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const start = await startLogin(hub);

    const cb = await callback(hub, { ...start, token: 'one-time' });
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('location');
    assert.match(loc, /^\/\?login=/);

    const users = hub.users();
    assert.equal(users.length, 1);
    assert.equal(users[0].name, 'U01ABCDEF');
    assert.equal(users[0].displayName, 'huy');
    assert.ok(!loc.includes(users[0].token), 'token vĩnh viễn không được đi qua thanh địa chỉ');

    const code = new URL(loc, hub.base).searchParams.get('login');
    const claim = await (await fetch(hub.base + '/api/auth/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json();
    assert.equal(claim.token, users[0].token);
    assert.equal(claim.displayName, 'huy');
  } finally { hub.stop(); ts.stop(); }
});

test('claimCode dùng một lần', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const cb = await callback(hub, await startLogin(hub));
    const code = new URL(cb.headers.get('location'), hub.base).searchParams.get('login');

    const body = { code };
    const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    assert.equal((await fetch(hub.base + '/api/auth/claim', opts)).status, 200);
    assert.equal((await fetch(hub.base + '/api/auth/claim', opts)).status, 410);
  } finally { hub.stop(); ts.stop(); }
});

test('state dùng lại bị chặn', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const start = await startLogin(hub);
    await callback(hub, start);
    const again = await callback(hub, start);
    assert.equal(again.status, 400);
  } finally { hub.stop(); ts.stop(); }
});

test('state bịa ra bị chặn, và KHÔNG hỏi token-slayer', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=bia-dat`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.equal(ts.calls.length, 0);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); ts.stop(); }
});

test('đăng nhập lần hai KHÔNG đổi token và KHÔNG đẻ entry mới', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const login = async () => {
      await callback(hub, await startLogin(hub));
    };
    await login();
    const first = hub.users()[0].token;
    await login();
    assert.equal(hub.users().length, 1);
    assert.equal(hub.users()[0].token, first);
  } finally { hub.stop(); ts.stop(); }
});

test('token-slayer trả 410 → không ghi users.json', async () => {
  const ts = await startFakeTs(() => ({ status: 410, json: { error: 'token_invalid_or_expired' } }));
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await callback(hub, await startLogin(hub));
    assert.equal(r.status, 400);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); ts.stop(); }
});

test('token-slayer chết → 503, và nói rõ token cũ vẫn dùng được', async () => {
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: 'http://127.0.0.1:1',
  });
  try {
    const r = await callback(hub, await startLogin(hub));
    assert.equal(r.status, 503);
    assert.match(await r.text(), /vẫn dùng/i);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); }
});

test('danh tính tên "admin" bị từ chối', async () => {
  const ts = await startFakeTs(() => ({ status: 200, json: { slackUserId: 'admin', handle: 'admin' } }));
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await callback(hub, await startLogin(hub));
    assert.equal(r.status, 400);
    assert.deepEqual(hub.users(), [], "'admin' là chìa thứ hai vào hộp của chủ hub");
  } finally { hub.stop(); ts.stop(); }
});

// `admin` không còn là một nhánh riêng: luật hình dạng trong users.js gánh cả
// nó (chữ thường). Bài kiểm ngay dưới chốt rằng cả họ khoá ma thuật cũng rơi
// ra cùng lượt — `__proto__` làm `pushSubs[user.name] || []` trả về
// Object.prototype, và mọi lần đăng ký push của người đó thành 500.
test('danh tính có hình dạng lạ bị từ chối, kể cả __proto__', async () => {
  for (const evil of ['__proto__', 'constructor', 'u01abcdef', 'người dùng']) {
    const ts = await startFakeTs(() => ({ status: 200, json: { slackUserId: evil, handle: 'x' } }));
    const hub = await startHub({
      CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
    });
    try {
      const r = await callback(hub, await startLogin(hub));
      assert.equal(r.status, 400, `phải từ chối "${evil}"`);
      assert.deepEqual(hub.users(), [], `không được ghi entry cho "${evil}"`);
    } finally { hub.stop(); ts.stop(); }
  }
});

test('trang lỗi KHÔNG tự redirect — nó có nút bấm', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/auth/callback?token=t&state=x', { redirect: 'manual' });
    assert.ok(r.status >= 400);
    assert.equal(r.headers.get('location'), null,
      'token-slayer từng ping-pong vô hạn vì lỗi tự redirect lại — đừng lặp lại');
    assert.match(await r.text(), /<a href="\/"/);
  } finally { hub.stop(); }
});

// --- state phải thuộc về ĐÚNG trình duyệt đã bấm đăng nhập ------------------
//
// Không có chốt này thì "state hợp lệ" chỉ chứng minh CÓ MỘT lần đăng nhập vừa
// bắt đầu trên hub, không chứng minh nó là của người đang mở link. Cả nhóm
// dưới đây kiểm đúng một câu: callback của Mallory không được đăng nhập hộ
// trình duyệt của Bob.

test('/auth/start đặt cookie nonce HttpOnly, SameSite=Lax, Path=/, và nonce KHÁC state', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const { res, state, cookie } = await startLogin(hub);
    const raw = res.headers.get('set-cookie');
    assert.match(raw, /^ccrc_oauth=/, 'phải đặt cookie ccrc_oauth');
    assert.match(raw, /HttpOnly/i, 'JavaScript trên trang không được đọc nonce này');
    assert.match(raw, /SameSite=Lax/i, 'callback là điều hướng top-level — Lax vẫn gửi cookie đi');
    assert.match(raw, /Path=\//i);
    const nonce = cookie.slice('ccrc_oauth='.length);
    assert.ok(nonce.length >= 40, `nonce quá ngắn: ${nonce.length}`);
    assert.notEqual(nonce, state,
      'nonce không được BẰNG state — thế thì kẻ cầm được state cũng dựng được cookie');
  } finally { hub.stop(); ts.stop(); }
});

test('callback KHÔNG kèm cookie bị chặn — và KHÔNG hỏi token-slayer, KHÔNG ghi users.json', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    // Đây CHÍNH LÀ cú tấn công: Mallory bấm đăng nhập (nên state là thật và
    // còn sống), chặn redirect cuối, rồi gửi URL đó cho Bob. Trình duyệt Bob
    // không có cookie của Mallory.
    const { state } = await startLogin(hub);
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=${state}`, { redirect: 'manual' });

    assert.equal(r.status, 400);
    assert.equal(r.headers.get('location'), null, 'lỗi phải dừng ở trang tĩnh, không redirect');
    assert.equal(ts.calls.length, 0,
      'không được tiêu một one_time token của người khác trước khi biết callback này của ai');
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); ts.stop(); }
});

test('callback kèm cookie của TRÌNH DUYỆT KHÁC bị chặn', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const mallory = await startLogin(hub);
    const bob = await startLogin(hub);
    // state của Mallory + cookie của Bob: đúng hình dạng thứ Bob's browser sẽ
    // gửi đi khi Bob bấm vào link Mallory gửi trong lúc chính Bob cũng đang
    // đăng nhập dở.
    const r = await callback(hub, { state: mallory.state, cookie: bob.cookie });
    assert.equal(r.status, 400);
    assert.deepEqual(hub.users(), []);

    // Và cookie của Bob KHÔNG bị xoá — luồng đăng nhập của chính Bob vẫn đi
    // tiếp được. Chặn một cú tấn công không được phép biến thành phá luồng
    // của nạn nhân.
    const ok = await callback(hub, bob);
    assert.equal(ok.status, 302, 'Bob vẫn phải đăng nhập được bằng state của chính mình');
  } finally { hub.stop(); ts.stop(); }
});

test('cookie dùng một lần: callback thành công thì xoá nó đi', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const cb = await callback(hub, await startLogin(hub));
    assert.equal(cb.status, 302);
    const cleared = cb.headers.get('set-cookie') || '';
    assert.match(cleared, /^ccrc_oauth=;/,
      'callback xong phải xoá cookie — nó đã làm xong việc, hệt như state');
  } finally { hub.stop(); ts.stop(); }
});

// Hub được với tới bằng HTTP thuần trong tailnet lẫn HTTPS qua Cloudflare
// Tunnel. `Secure` bật cứng nghĩa là trình duyệt trên đường tailnet không lưu
// cookie, và MỌI lần đăng nhập Slack qua tailnet chết ở trang lỗi — im lặng.
// Nên cờ này đi theo request, không theo cấu hình.
test('cờ Secure của cookie đi theo giao thức thật của request, không bật cứng', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const plain = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/i,
      'HTTP thuần (tailnet): Secure sẽ làm trình duyệt vứt cookie, và đăng nhập chết im lặng');

    // Đúng thứ cloudflared gắn vào khi đi từ internet.
    const behindTunnel = await fetch(hub.base + '/auth/start', {
      redirect: 'manual', headers: { 'x-forwarded-proto': 'https' },
    });
    assert.match(behindTunnel.headers.get('set-cookie'), /Secure/i,
      'qua Cloudflare Tunnel thì phải có Secure');
  } finally { hub.stop(); ts.stop(); }
});

// --- ghi users.json ---------------------------------------------------------

// Bất biến, không phải chi tiết cài đặt: đoạn đọc–sửa–ghi trong saveSlackUser
// an toàn trước hai lần đăng nhập song song CHỈ VÌ nó không có `await` nào —
// Node một luồng nên cả đoạn là một lượt liền mạch. Đổi sang fs.promises làm
// mất tính chất đó ÂM THẦM: một người mất entry, và triệu chứng là "token vừa
// cấp đã không dùng được", không có gì trong log chỉ về đây. rename nguyên tử
// cứu file khỏi cụt, nó KHÔNG cứu lost update.
test('saveSlackUser không có await nào — đó là thứ giữ cho hai lần đăng nhập song song không đè nhau', () => {
  const src = fs.readFileSync(SRV, 'utf8');
  const start = src.indexOf('function saveSlackUser(');
  assert.ok(start !== -1, 'không tìm thấy saveSlackUser — đổi tên rồi?');
  // Tới dòng `}` ở cột 0 kế tiếp: hàm này khai báo ở top level.
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /\bawait\b/,
    'thêm await vào saveSlackUser là mở lại cửa lost update giữa hai lần đăng nhập cùng lúc');
  assert.doesNotMatch(body, /fs\.promises|node:fs\/promises/,
    'API promise ở đây là await trá hình');
});

test('file tạm của hub mang pid — không dùng chung tên với deploy.sh', () => {
  const src = fs.readFileSync(SRV, 'utf8');
  assert.match(src, /\.tmp\.\$\{process\.pid\}/,
    'deploy.sh cũng ghi /data/users.json; tên tạm dùng chung là hai tiến trình đạp lên nhau trong chính file tạm');
});

test('hai người đăng nhập cùng lúc thì cả hai đều có entry', async () => {
  // token-slayer giả trả danh tính THEO one_time token, nên hai callback song
  // song là hai người khác nhau chứ không phải hai lần của cùng một người.
  const ts = await startFakeTs((body) => ({
    status: 200,
    json: { slackUserId: `U0${body.token}`, handle: `nguoi-${body.token}` },
  }));
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const a = await startLogin(hub);
    const b = await startLogin(hub);
    const [ra, rb] = await Promise.all([
      callback(hub, { ...a, token: 'AAAA' }),
      callback(hub, { ...b, token: 'BBBB' }),
    ]);
    assert.equal(ra.status, 302);
    assert.equal(rb.status, 302);
    const names = hub.users().map((u) => u.name).sort();
    assert.deepEqual(names, ['U0AAAA', 'U0BBBB'],
      'một entry biến mất nghĩa là lần ghi sau đọc bản trước khi lần ghi trước kịp xuống đĩa');
  } finally { hub.stop(); ts.stop(); }
});
