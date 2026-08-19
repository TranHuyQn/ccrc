import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeSession } from '../../shared/session-registry.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-notify.js');

function tmpHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  fs.mkdirSync(path.join(home, '.ccrc'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, '.ccrc', name), content);
  }
  return home;
}

function stubServer() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, received, port: srv.address().port })));
}

// TMUX/TMUX_PANE are stripped unless a test asks for them: this suite is
// itself often run from inside tmux, and inheriting the runner's pane would
// silently give every test a pane id it never asked for.
function run(stdin, home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, CCRC_HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return new Promise((resolve) => {
    const child = execFile('node', [HOOK], { env: { ...env, ...extraEnv }, timeout: 15000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const PAYLOAD = JSON.stringify({
  hook_event_name: 'Notification', notification_type: 'idle_prompt',
  cwd: '/Users/dev/projects/cc-remote-control',
  message: 'Claude is waiting for your input', session_id: 's1',
});

test('BẬT thì gửi lên hub kèm token', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/notify');
  assert.equal(received[0].auth, 'Bearer tok-abc');
  assert.equal(received[0].body.type, 'idle_prompt');
  // No terminal session is registered under this temp HOME, so the title
  // carries the machine and nothing else — in particular NOT the cwd's
  // basename, which is what it used to leak.
  assert.ok(!/cc-remote-control/.test(received[0].body.title), 'tên thư mục bị gửi lên hub');
});

// End to end through the real binary: the hook reads the registry off disk,
// so a fake `session` object handed to buildNotification() would prove
// nothing about whether the two halves agree on the file format.
test('có phiên trong sổ tra → thông báo mang đúng tên và sessionId', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  writeSession(
    { sessionId: 'sess-abc', cwd: '/Users/dev/projects/cc-remote-control', name: 'du an A', pid: process.pid },
    { home });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 1);
  assert.match(received[0].body.title, /du an A/);
  assert.equal(received[0].body.sessionId, 'sess-abc');
  assert.ok(!/cc-remote-control/.test(received[0].body.title));
});

// The bug this pairing exists to kill. Claude Code reports the directory the
// SESSION is currently in, and one `cd` in a Bash call moves it; the pane the
// daemon watches stays put. Measured on a real machine: every notification for
// a session with a terminal open arrived with no sessionId at all, so the hub
// had nothing to match and pushed anyway.
test('cwd đã trôi sang thư mục con → vẫn ghép đúng phiên nhờ pane', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  writeSession({ sessionId: 'sess-pane', cwd: '/Users/dev/projects', name: 'du an B', pane: '%3', pid: process.pid }, { home });
  const payload = JSON.stringify({
    hook_event_name: 'Notification', notification_type: 'idle_prompt', session_id: 's1',
    cwd: '/Users/dev/projects/app-cua-toi/packages/core/src',
    message: 'Claude is waiting for your input',
  });
  const r = await run(payload, home, { TMUX_PANE: '%3' });
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.sessionId, 'sess-pane', 'thiếu sessionId thì hub không nén được push');
  assert.match(received[0].body.title, /du an B/);
});

test('pane của mình không có trong sổ → vẫn lùi về khớp theo cwd', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  writeSession(
    { sessionId: 'sess-abc', cwd: '/Users/dev/projects/cc-remote-control', name: 'du an A', pane: '%9', pid: process.pid },
    { home });
  const r = await run(PAYLOAD, home, { TMUX_PANE: '%3' });
  srv.close();
  assert.equal(received[0].body.sessionId, 'sess-abc');
});

test('phiên trong sổ nhưng KHÁC thư mục → không ghép, chỉ tên máy', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  writeSession({ sessionId: 'sess-khac', cwd: '/mot/thu/muc/khac', name: 'khong-phai-cai-nay', pid: process.pid }, { home });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(received.length, 1);
  assert.ok(!/khong-phai-cai-nay/.test(received[0].body.title), 'ghép nhầm phiên còn tệ hơn không ghép');
  assert.equal(received[0].body.sessionId, undefined);
});

// A daemon killed with -9 leaves its file behind. Nothing else sweeps this
// directory, so a stale entry must not go on naming notifications forever.
test('mục sổ tra của daemon đã chết → bỏ qua và bị dọn', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  // pid 2^31-1: valid to ask about, and not a running process.
  writeSession(
    { sessionId: 'sess-chet', cwd: '/Users/dev/projects/cc-remote-control', name: 'ma-cu', pid: 2147483647 },
    { home });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(received.length, 1);
  assert.ok(!/ma-cu/.test(received[0].body.title));
  assert.equal(fs.existsSync(path.join(home, '.ccrc', 'sessions', 'sess-chet.json')), false,
    'mục chết phải bị dọn, nếu không thư mục phình mãi');
});

test('TẮT thì KHÔNG gửi gì cả — không một byte rời khỏi máy', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'off\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 0, 'tắt mà vẫn gửi là vi phạm nghiêm trọng');
});

test('THIẾU file notify thì coi như tắt', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=tok-abc\n` });
  const r = await run(PAYLOAD, home);
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 0, 'mặc định phải là im lặng');
});

test('nội dung notify lạ thì coi như tắt', async () => {
  for (const val of ['ON', 'true', '1', 'bật', '']) {
    const { srv, received, port } = await stubServer();
    const home = tmpHome({ notify: val, config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=t\n` });
    const r = await run(PAYLOAD, home);
    srv.close();
    assert.equal(r.code, 0);
    assert.equal(received.length, 0, `"${val}" không phải "on" nên phải im lặng`);
  }
});

test('loại Notification không nằm trong whitelist thì không gửi', async () => {
  const { srv, received, port } = await stubServer();
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=t\n` });
  const r = await run(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'la_hoac' }), home);
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(received.length, 0);
});

test('exit 0 khi thiếu config', async () => {
  const home = tmpHome({ notify: 'on\n' });
  const r = await run(PAYLOAD, home);
  assert.equal(r.code, 0);
});

test('exit 0 khi hub không tồn tại', async () => {
  const home = tmpHome({ notify: 'on\n', config: 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\n' });
  const r = await run(PAYLOAD, home);
  assert.equal(r.code, 0);
});

test('exit 0 khi hub treo không trả lời', async () => {
  const srv = http.createServer(() => { /* không bao giờ trả lời */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=t\n` });
  const t0 = Date.now();
  const r = await run(PAYLOAD, home);
  const elapsed = Date.now() - t0;
  srv.close();
  assert.equal(r.code, 0);
  assert.ok(elapsed < 8000, `phải bỏ cuộc sớm, mất ${elapsed}ms`);
});

test('exit 0 khi stdin là JSON hỏng hoặc rỗng', async () => {
  const home = tmpHome({ notify: 'on\n', config: 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\n' });
  assert.equal((await run('{khong-phai-json', home)).code, 0);
  assert.equal((await run('', home)).code, 0);
});

test('không in gì ra stderr ở các nhánh hỏng thông thường', async () => {
  const home = tmpHome({ notify: 'on\n', config: 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\n' });
  const r = await run(PAYLOAD, home);
  assert.equal(r.stderr.trim(), '', 'stderr bẩn sẽ hiện lên trong Claude Code');
});
