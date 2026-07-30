# Chỉ gửi thông báo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi Claude Code dừng lại chờ người dùng, điện thoại nhận được thông báo đẩy. Không gì khác.

**Architecture:** Hook `Notification` của Claude Code gọi một script; script đọc công tắc local, nếu bật thì POST thẳng lên hub kèm token cá nhân; hub bắn Web Push. Không WebSocket, không phiên, không tiến trình nền, không tmux.

**Tech Stack:** Node 22 ESM, `node:test` có sẵn, Express + `web-push` (đã là dependency của hub), PWA thuần không framework.

**Spec:** `docs/superpowers/specs/2026-07-26-notify-only-design.md`

## Global Constraints

- **KHÔNG thêm npm dependency nào.** `web-push` và `express` đã có; `ws` sẽ bị gỡ.
- **Hook LUÔN `exit 0`** ở mọi nhánh: mất mạng, hub sập, token sai, file hỏng, JSON rác. Claude Code không bao giờ được ảnh hưởng.
- **Công tắc TẮT ⇒ không một byte nào rời khỏi máy.** Hook đọc `~/.ccrc/notify` **trước mọi việc khác**.
- **Mặc định TẮT.** File thiếu, không đọc được, hoặc nội dung không phải đúng chữ `on` ⇒ coi như tắt.
- **Chỉ báo `idle_prompt` và `permission_prompt`.** Whitelist, không phải blacklist: loại lạ thì im lặng bỏ qua.
- **Không gửi nội dung công việc** trong thông báo — chỉ tên máy, tên thư mục, và một câu cố định.
- Comment trong code bằng **tiếng Anh**; chuỗi hiển thị cho người dùng bằng **tiếng Việt**.
- Test chạy bằng `node --test test/*.test.js`. **KHÔNG dùng `node --test test/`** — dạng thư mục trần hỏng trên Node v22.23.1.
- **Máy local hiện đang sạch** (đã chạy `remove-agent.sh`). Mọi thứ task này cài là cài mới.

## Sự thật đã đo — đừng suy diễn lại

Từ 8.868 payload hook thật:

| Sự thật | Bằng chứng |
|---|---|
| Chỉ có 2 loại `Notification` | `idle_prompt` 131, `permission_prompt` 70 |
| `AskUserQuestion` phát `permission_prompt` khi đang chờ | 63/65 lần |
| Payload `Notification` luôn có `cwd`, `session_id`, `message` | 208/208 |
| `SubagentStop` 781 lần | Báo cái này là rung liên tục — không báo |
| `Stop` 189 ≠ `idle_prompt` 131 | ~58 lần Claude tự đi tiếp, không chờ ai |

Mẫu payload thật:
```json
{"session_id":"8be17c1b-…","transcript_path":"/Users/…","cwd":"/Users/dev/projects/acme/demo-app",
 "message":"Claude is waiting for your input","notification_type":"idle_prompt","hook_event_name":"Notification"}
```

## File Structure

| File | Trách nhiệm |
|---|---|
| `hook/src/notify-payload.js` *(mới)* | Hàm thuần: payload hook → nội dung thông báo, hoặc `null` |
| `hook/bin/ccrc-notify.js` *(mới)* | Script hook: đọc công tắc, dựng, POST, luôn exit 0 |
| `hook/bin/ccrc-notify-cli.js` *(mới)* | Lệnh `/notify on\|off\|status` |
| `hook/bin/install-hook.mjs` *(mới)* | Thêm/gỡ hook `Notification` trong `~/.claude/settings.json` |
| `hook/test/*.test.js` *(mới)* | Test cho ba file trên |
| `server/src/index.js` *(viết lại)* | HTTP thuần: static, `/healthz`, `/api/*`, `POST /notify` |
| `server/public/{index.html,app.js,style.css}` *(viết lại)* | PWA tối thiểu |
| `server/public/sw.js`, `manifest.webmanifest`, `icons/` *(giữ nguyên)* | Đã đúng, không đụng |
| `setup-notify.sh`, `remove-notify.sh` *(mới)* | Cài/gỡ trên máy dev |
| `deploy/commands/notify.md` *(mới)* | Slash command |
| `agent/`, `server/public/activity.js`, `setup-agent.sh`, `remove-agent.sh`, `deploy/commands/remote.md` *(XOÁ)* | Hướng cũ |

---

### Task 1: Hàm thuần dựng nội dung thông báo

**Files:**
- Create: `hook/src/notify-payload.js`
- Test: `hook/test/notify-payload.test.js`
- Create: `hook/package.json`

**Interfaces:**
- Consumes: không có
- Produces: `buildNotification(payload, opts) => {type, title, body, tag} | null` với `opts = {machineName}`

- [ ] **Step 1: Tạo package.json cho hook**

```json
{
  "name": "ccrc-hook",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/*.test.js" }
}
```

- [ ] **Step 2: Write the failing test**

Tạo `hook/test/notify-payload.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification } from '../src/notify-payload.js';

const OPTS = { machineName: 'dev' };
const base = (extra) => ({
  hook_event_name: 'Notification',
  session_id: '8be17c1b-8ead-4ceb-8029-177cf4dc4fbf',
  cwd: '/Users/dev/projects/cc-remote-control',
  ...extra,
});

test('idle_prompt thành thông báo đang chờ nhập', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), OPTS);
  assert.equal(n.type, 'idle_prompt');
  assert.match(n.title, /dev/);
  assert.match(n.title, /cc-remote-control/);
  assert.match(n.body, /đang chờ bạn nhập/);
});

test('permission_prompt nói "cần bạn xác nhận", KHÔNG nói "duyệt quyền"', () => {
  // Đo được: AskUserQuestion cũng phát permission_prompt (63/65 lần), nên nói
  // "duyệt quyền" sẽ sai gần một nửa số lần.
  const n = buildNotification(base({ notification_type: 'permission_prompt', message: 'Claude needs your permission' }), OPTS);
  assert.equal(n.type, 'permission_prompt');
  assert.match(n.body, /cần bạn xác nhận/);
  assert.ok(!/duyệt quyền/.test(n.body), 'không được nói "duyệt quyền"');
});

test('tên dự án lấy từ tên thư mục cuối của cwd', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', cwd: '/Users/dev/projects/acme/demo-app' }), OPTS);
  assert.match(n.title, /demo-app/);
  assert.ok(!/acme/.test(n.title), 'chỉ lấy thư mục cuối, không lấy cả đường dẫn');
});

test('KHÔNG mang nội dung công việc sang thông báo', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', message: 'BÍ MẬT KHÔNG ĐƯỢC LỘ' }), OPTS);
  const all = JSON.stringify(n);
  assert.ok(!/BÍ MẬT/.test(all), 'message của Claude Code không được lọt vào thông báo');
  assert.ok(!/8be17c1b/.test(all), 'session id không được lọt vào');
  assert.ok(!/\/Volumes\//.test(all), 'đường dẫn đầy đủ không được lọt vào');
});

test('loại Notification lạ thì trả null — whitelist chứ không phải blacklist', () => {
  assert.equal(buildNotification(base({ notification_type: 'loai_moi_nao_do' }), OPTS), null);
  assert.equal(buildNotification(base({ notification_type: undefined }), OPTS), null);
});

test('hook khác Notification thì trả null', () => {
  assert.equal(buildNotification({ hook_event_name: 'Stop' }, OPTS), null);
  assert.equal(buildNotification({ hook_event_name: 'SubagentStop', notification_type: 'idle_prompt' }, OPTS), null);
});

test('payload rác thì trả null, không ném', () => {
  for (const bad of [null, undefined, 'chuỗi', 42, [], true]) {
    assert.equal(buildNotification(bad, OPTS), null);
  }
});

test('thiếu cwd vẫn dựng được, chỉ mất tên dự án', () => {
  const n = buildNotification({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, OPTS);
  assert.ok(n, 'không được trả null chỉ vì thiếu cwd');
  assert.match(n.title, /dev/);
});

test('tag khác nhau theo loại để thông báo không đè nhau', () => {
  const a = buildNotification(base({ notification_type: 'idle_prompt' }), OPTS);
  const b = buildNotification(base({ notification_type: 'permission_prompt' }), OPTS);
  assert.notEqual(a.tag, b.tag);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd hook && npm test`
Expected: FAIL — `Cannot find module '../src/notify-payload.js'`

- [ ] **Step 4: Write minimal implementation**

Tạo `hook/src/notify-payload.js`:

```js
// Turn a raw Claude Code `Notification` hook payload into the push notification
// the phone shows. Pure: no I/O, no config reading — everything it needs is an
// argument, so it can be tested against the real payload shapes.

import path from 'node:path';

// Whitelist, deliberately. Claude Code emits exactly two notification types
// today (measured: idle_prompt 131, permission_prompt 70). A type we do not
// recognise must stay silent rather than guess a wording for it.
const KINDS = {
  idle_prompt: { icon: '🔔', body: 'Claude đang chờ bạn nhập' },
  // `permission_prompt` covers BOTH a permission request and an
  // AskUserQuestion (measured: 63 of 65 questions emit this type), so the
  // wording must not say "duyệt quyền" — it would be wrong about half the time.
  permission_prompt: { icon: '🔐', body: 'Claude cần bạn xác nhận' },
};

export function buildNotification(payload, opts = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.hook_event_name !== 'Notification') return null;
  const kind = KINDS[payload.notification_type];
  if (!kind) return null;

  const machine = opts.machineName || 'máy dev';
  // Only the last path segment: the full path is on the user's disk and adds
  // nothing they do not already know.
  const project = payload.cwd ? path.basename(String(payload.cwd)) : '';
  const where = project ? `${machine} · ${project}` : machine;

  return {
    type: payload.notification_type,
    title: `${kind.icon} ${where}`,
    body: kind.body,
    // Per-type tag so a "waiting" notification does not replace a pending
    // "needs you" one on the phone.
    tag: `ccrc-${payload.notification_type}`,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hook && npm test`
Expected: PASS, 9 test.

- [ ] **Step 6: Commit**

```bash
git add hook/src/notify-payload.js hook/test/notify-payload.test.js hook/package.json
git commit -m "Build the push notification from a Notification hook payload"
```

---

### Task 2: Script hook

**Files:**
- Create: `hook/bin/ccrc-notify.js`
- Test: `hook/test/ccrc-notify.test.js`

**Interfaces:**
- Consumes: `buildNotification` (Task 1)
- Produces: script chạy được; đọc `~/.ccrc/notify` và `~/.ccrc/config`; POST `/notify` với header `authorization: Bearer <token>`

- [ ] **Step 1: Write the failing test**

Tạo `hook/test/ccrc-notify.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function run(stdin, home) {
  return new Promise((resolve) => {
    const child = execFile('node', [HOOK], { env: { ...process.env, HOME: home }, timeout: 15000 },
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
  assert.match(received[0].body.title, /cc-remote-control/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hook && npm test`
Expected: FAIL — không tìm thấy `bin/ccrc-notify.js`.

- [ ] **Step 3: Write minimal implementation**

Tạo `hook/bin/ccrc-notify.js`:

```js
#!/usr/bin/env node
// Claude Code `Notification` hook -> push notification.
//
// This runs inside Claude Code every time it stops to wait for the user, so it
// must be cheap and it must never fail loudly: every path exits 0, and nothing
// is written to stderr on an expected failure. Claude Code keeps working
// whether or not the hub, the network, or the config exist.
//
// The toggle is read FIRST, before anything else happens. When it is off,
// nothing leaves the machine at all — not a DNS lookup, not a byte.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { buildNotification } from '../src/notify-payload.js';

const CFG_DIR = path.join(os.homedir(), '.ccrc');
const REQUEST_TIMEOUT_MS = 3000;

function readToggle() {
  try {
    // Exactly "on" and nothing else. A missing file, an unreadable one, or any
    // other content means off: silence is the safe default when the
    // configuration cannot be trusted.
    return fs.readFileSync(path.join(CFG_DIR, 'notify'), 'utf8').trim() === 'on';
  } catch {
    return false;
  }
}

function readConfig() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(CFG_DIR, 'config'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* handled by the caller: no url or token means nothing to send */ }
  return out;
}

function post(urlStr, token, body) {
  let url;
  try { url = new URL('/notify', urlStr); } catch { return process.exit(0); }
  const mod = url.protocol === 'https:' ? https : http;
  const data = JSON.stringify(body);
  const req = mod.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      authorization: `Bearer ${token}`,
    },
    timeout: REQUEST_TIMEOUT_MS,
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(data);
}

if (!readToggle()) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) { raw = ''; process.exit(0); } });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const cfg = readConfig();
  if (!cfg.CCRC_HUB_URL || !cfg.CCRC_TOKEN) process.exit(0);
  const note = buildNotification(payload, { machineName: cfg.CCRC_MACHINE_NAME || os.hostname().replace(/\.local$/, '') });
  if (!note) process.exit(0);
  post(cfg.CCRC_HUB_URL, cfg.CCRC_TOKEN, note);
});
```

- [ ] **Step 4: Make executable and run tests**

```bash
chmod +x hook/bin/ccrc-notify.js
cd hook && npm test
```
Expected: PASS, 19 test.

- [ ] **Step 5: Xác nhận từng test mới thật sự bắt lỗi**

Với mỗi test dưới đây, bẻ đúng chỗ nó nhắm rồi chạy lại, xác nhận **chỉ test đó** fail, rồi khôi phục. Ghi lại kết quả quan sát được.

| Test | Đột biến để thử |
|---|---|
| TẮT thì không gửi gì | bỏ dòng `if (!readToggle()) process.exit(0);` |
| thiếu file notify coi như tắt | đổi `catch { return false; }` thành `catch { return true; }` |
| nội dung lạ coi như tắt | đổi `=== 'on'` thành `!== 'off'` |
| whitelist | trả về một object cứng thay vì `null` khi `kind` không khớp |
| exit 0 khi hub treo | bỏ `req.on('timeout', …)` |

- [ ] **Step 6: Commit**

```bash
git add hook/bin/ccrc-notify.js hook/test/ccrc-notify.test.js
git commit -m "Add the notification hook, silent by default"
```

---

### Task 3: Hub — viết lại thành HTTP thuần

**Files:**
- Rewrite: `server/src/index.js`
- Test: `server/test/notify-api.test.js`
- Modify: `server/package.json` (bỏ `ws`)

**Interfaces:**
- Consumes: không có
- Produces: `POST /notify`, `GET /api/vapid-key`, `POST /api/push/subscribe`, `GET /api/me`, `GET /api/notifications`, `GET /healthz`

Hub hiện tại 742 dòng, phần lớn là relay WebSocket, phiên, transcript, duyệt quyền — bỏ hết. Giữ lại nguyên vẹn: nạp `users.json` có hot-reload, khởi tạo VAPID, `notifyUser`, lưu push subscription. Đó là phần đã chạy tốt và đã verify trên production.

- [ ] **Step 1: Write the failing test**

Tạo `server/test/notify-api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'),
    JSON.stringify([{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }]));
  const port = 8790 + Math.floor(Math.random() * 200);
  // Tên biến là CCRC_PORT và CCRC_DATA_DIR — không phải PORT. Dùng sai tên thì
  // server bind cổng mặc định 8720 và test đỏ vì lý do không liên quan.
  const proc = spawn('node', [SRV], {
    env: { ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { proc, base, dataDir, stop: () => proc.kill() };
}

const NOTE = { type: 'idle_prompt', title: '🔔 dev · dự-án', body: 'Claude đang chờ bạn nhập', tag: 'ccrc-idle_prompt' };

test('POST /notify với token hợp lệ được chấp nhận', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-huy' },
    body: JSON.stringify(NOTE),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  h.stop();
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

test('không còn endpoint WebSocket', async () => {
  const h = await startHub();
  const r = await fetch(h.base + '/ws', { headers: { authorization: 'Bearer tok-huy' } });
  assert.equal(r.status, 404);
  h.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `/notify` chưa tồn tại, `/ws` vẫn trả về khác 404.

- [ ] **Step 3: Write the implementation**

Viết lại `server/src/index.js`. Giữ nguyên khối nạp `users.json` (có `fs.watchFile` hot-reload), khối VAPID, `pushSubs`/`savePushSubs`, `notifyUser` — chép y nguyên từ bản cũ. Thay toàn bộ phần WebSocket bằng:

```js
// ---------------------------------------------------------------------------
// Notification history. Kept in memory only: it exists so the phone can glance
// back at what it missed, not as a record. A hub restart losing it is fine.
const HISTORY_MAX = 50;
/** @type {Map<string, Array<any>>} userName -> notifications, newest first */
const history = new Map();

function remember(userName, note) {
  const list = history.get(userName) || [];
  list.unshift({ ...note, at: Date.now() });
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  history.set(userName, list);
}

// Bearer token -> user, or null. Every authenticated route goes through here.
function userFromRequest(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? resolveUser(m[1].trim()) : null;
}

function requireUser(req, res) {
  const user = userFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'Token không hợp lệ' }); return null; }
  return user;
}

app.post('/notify', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const n = req.body;
  // The hook is the only legitimate caller and it always sends this shape, but
  // the endpoint is reachable by anything holding a token, so validate.
  if (!n || typeof n !== 'object' || Array.isArray(n) || typeof n.title !== 'string' || typeof n.body !== 'string') {
    return res.status(400).json({ ok: false, error: 'Nội dung không hợp lệ' });
  }
  const note = { type: String(n.type || ''), title: n.title.slice(0, 200), body: n.body.slice(0, 200), tag: String(n.tag || 'ccrc') };
  remember(user.name, note);
  notifyUser(user.name, note);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ user: user.name, pushDevices: (pushSubs[user.name] || []).length });
});

app.get('/api/notifications', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ items: history.get(user.name) || [] });
});

app.get('/api/vapid-key', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

app.post('/api/push/subscribe', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ ok: false });
  const list = pushSubs[user.name] || [];
  if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
  pushSubs[user.name] = list;
  savePushSubs();
  res.json({ ok: true });
});
```

Xoá khỏi file: `import WebSocket from 'ws'`, toàn bộ `WebSocketServer`, `sessions`, `agents`, `subscribers`, `pendingPermissions`, `handleClientMessage`, `handleAgentMessage`, `appendTranscript`, `readTranscript`, `broadcastSubscribers`, `pushStateToClients`, `notifySessionOwner`, heartbeat, `SESSIONS_FILE`, `NO_PERSIST`, và dòng `fs.mkdirSync(path.join(DATA_DIR, 'transcripts'), …)` — không còn transcript để lưu.

**Giữ nguyên tên biến môi trường đang dùng:** `CCRC_PORT`, `CCRC_DATA_DIR`, `CCRC_TOKEN`, `CCRC_VAPID_SUBJECT`. Đổi tên sẽ làm hỏng `docker-compose.yml` và `.env` trên server.

Gỡ `ws` khỏi `server/package.json` dependencies.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && npm install && npm test
```
Expected: PASS, **74 test** — 9 test mới của bạn, cộng 65 test cũ của
`activity.test.js` vẫn còn ở bước này (đã đo). Task 4 mới xoá chúng, lúc đó mới
còn 9. Thấy 74 là đúng, đừng tưởng mình làm hỏng.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.js server/test/notify-api.test.js server/package.json server/package-lock.json
git commit -m "Rewrite the hub as an HTTP notification endpoint"
```

---

### Task 4: PWA tối thiểu

**Files:**
- Rewrite: `server/public/index.html`, `server/public/app.js`, `server/public/style.css`
- Delete: `server/public/activity.js`, `server/test/activity.test.js`
- Keep untouched: `server/public/sw.js`, `manifest.webmanifest`, `icons/`

**Interfaces:**
- Consumes: `/api/vapid-key`, `/api/push/subscribe`, `/api/me`, `/api/notifications` (Task 3)
- Produces: không có

Một màn hình: nhập token, bật thông báo, xem 50 thông báo gần nhất.

- [ ] **Step 1: Viết index.html**

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>CC Notify</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0f1115">
<!-- Bump ?v= whenever app.js or style.css changes. An installed PWA also caches
     index.html itself, so a markup change needs the app reinstalled. -->
<link rel="stylesheet" href="style.css?v=1">

<div id="login" class="card">
  <h1>CC Notify</h1>
  <p class="dim">Dán token cá nhân để nhận thông báo khi Claude Code dừng lại chờ bạn.</p>
  <input id="token" type="password" placeholder="Token cá nhân" autocomplete="off">
  <button id="login-btn">Đăng nhập</button>
  <p id="login-err" class="err hidden"></p>
</div>

<div id="main" class="hidden">
  <header>
    <span id="who"></span>
    <button id="logout" class="ghost">Đăng xuất</button>
  </header>
  <div class="card">
    <div class="row">
      <span>Thông báo đẩy</span>
      <span id="push-state" class="dim">đang kiểm tra…</span>
    </div>
    <button id="enable-push">Bật thông báo trên thiết bị này</button>
    <p class="dim small">iPhone: phải thêm vào màn hình chính rồi mở từ đó thì mới nhận được.</p>
  </div>
  <h2>Gần đây</h2>
  <div id="list"></div>
</div>

<script src="app.js?v=1"></script>
```

- [ ] **Step 2: Viết app.js**

```js
'use strict';
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('ccrc_token') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), authorization: 'Bearer ' + token },
  });
  if (res.status === 401) { logout(); throw new Error('Token không hợp lệ'); }
  return res;
}

function logout() {
  token = '';
  localStorage.removeItem('ccrc_token');
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
}

async function showMain() {
  const me = await (await api('/api/me')).json();
  $('who').textContent = `${me.user} · ${me.pushDevices} thiết bị`;
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  await refreshPushState();
  await refreshList();
}

async function refreshList() {
  const { items } = await (await api('/api/notifications')).json();
  const list = $('list');
  list.textContent = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = 'Chưa có thông báo nào.';
    list.appendChild(p);
    return;
  }
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'note';
    const t = document.createElement('div');
    t.className = 'note-title';
    t.textContent = it.title;
    const b = document.createElement('div');
    b.className = 'note-body';
    b.textContent = it.body;
    const w = document.createElement('div');
    w.className = 'note-when dim';
    w.textContent = new Date(it.at).toLocaleString('vi-VN');
    el.append(t, b, w);
    list.appendChild(el);
  }
}

async function refreshPushState() {
  const el = $('push-state');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.textContent = 'trình duyệt không hỗ trợ'; return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  el.textContent = sub ? 'đã bật trên thiết bị này' : 'chưa bật';
}

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$('login-btn').onclick = async () => {
  token = $('token').value.trim();
  try {
    await showMain();
    localStorage.setItem('ccrc_token', token);
  } catch (e) {
    $('login-err').textContent = 'Token không hợp lệ.';
    $('login-err').classList.remove('hidden');
  }
};

$('logout').onclick = logout;

$('enable-push').onclick = async () => {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { $('push-state').textContent = 'bị từ chối quyền'; return; }
  const reg = await navigator.serviceWorker.register('sw.js');
  const { publicKey } = await (await fetch('/api/vapid-key')).json();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  await refreshPushState();
  await showMain();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (token) showMain().catch(() => logout());
```

- [ ] **Step 3: Viết style.css**

```css
:root {
  --bg: #0f1115; --card: #161a21; --border: #23262d;
  --text: #e6e8eb; --dim: #9aa3b2; --accent: #d97757; --err: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 24px 0 8px; }
.hidden { display: none; }
.dim { color: var(--dim); }
.small { font-size: 13px; }
.err { color: var(--err); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
input { width: 100%; padding: 12px; margin: 12px 0; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; font-family: var(--mono); }
button { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: 0;
  border-radius: 8px; font-size: 15px; cursor: pointer; }
button.ghost { width: auto; background: transparent; color: var(--dim); border: 1px solid var(--border); padding: 6px 12px; font-size: 13px; }
.note { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 8px; }
.note-title { font-family: var(--mono); font-size: 14px; }
.note-body { margin-top: 2px; }
.note-when { font-size: 12px; margin-top: 6px; }
```

- [ ] **Step 4: Xoá file thừa và kiểm cú pháp**

```bash
git rm server/public/activity.js server/test/activity.test.js
node --check server/public/app.js
(cd server && npm test)
```
Expected: cú pháp OK; test 9/9 pass (bộ activity đã xoá cùng file).

- [ ] **Step 5: Commit**

```bash
git add server/public/index.html server/public/app.js server/public/style.css
git commit -m "Replace the web UI with a one-screen notification app"
```

---

### Task 5: Lệnh `/notify`

**Files:**
- Create: `hook/bin/ccrc-notify-cli.js`
- Create: `deploy/commands/notify.md`
- Test: `hook/test/notify-cli.test.js`

**Interfaces:**
- Consumes: `~/.ccrc/notify`, `~/.ccrc/config`, `/api/me` (Task 3)
- Produces: `ccrc-notify-cli.js [on|off]` — không tham số thì in trạng thái, có kiểm hub thật

- [ ] **Step 1: Write the failing test**

Tạo `hook/test/notify-cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-notify-cli.js');

function tmpHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  fs.mkdirSync(path.join(home, '.ccrc'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(home, '.ccrc', n), c);
  return home;
}

function run(args, home) {
  return new Promise((r) => execFile('node', [CLI, ...args], { env: { ...process.env, HOME: home }, timeout: 15000 },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('`on` ghi đúng chữ on vào file', async () => {
  const home = tmpHome();
  const r = await run(['on'], home);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(home, '.ccrc', 'notify'), 'utf8').trim(), 'on');
  assert.match(r.stdout, /BẬT/);
});

test('`off` ghi đúng chữ off', async () => {
  const home = tmpHome({ notify: 'on\n' });
  await run(['off'], home);
  assert.equal(fs.readFileSync(path.join(home, '.ccrc', 'notify'), 'utf8').trim(), 'off');
});

test('không tham số thì in trạng thái, chưa cấu hình vẫn không sập', async () => {
  const home = tmpHome();
  const r = await run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TẮT/);
  assert.match(r.stdout, /chưa cấu hình|Hub/);
});

test('trạng thái GỌI THẬT lên hub và báo kết quả', async () => {
  let hit = 0;
  const srv = http.createServer((req, res) => {
    hit++;
    assert.equal(req.headers.authorization, 'Bearer tok-abc');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: 'huy', pushDevices: 2 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=tok-abc\n` });
  const r = await run([], home);
  srv.close();
  assert.equal(hit, 1, 'phải gọi thật lên hub, không được đoán từ file');
  assert.match(r.stdout, /huy/);
  assert.match(r.stdout, /2 thiết bị/);
});

test('hub sập thì BÁO RÕ chứ không im lặng', async () => {
  const home = tmpHome({ notify: 'on\n', config: 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\n' });
  const r = await run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /không gọi được|lỗi/i, 'hỏng im lặng là thứ lệnh này sinh ra để chống');
});

test('token sai thì báo token sai', async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=sai\n` });
  const r = await run([], home);
  srv.close();
  assert.match(r.stdout, /token/i);
});

test('cảnh báo khi BẬT mà chưa có thiết bị nào đăng ký push', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: 'huy', pushDevices: 0 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=t\n` });
  const r = await run([], home);
  srv.close();
  assert.match(r.stdout, /chưa có thiết bị|⚠/, 'bật mà không có thiết bị thì thông báo bay vào hư không');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hook && npm test`
Expected: FAIL — không tìm thấy `bin/ccrc-notify-cli.js`.

- [ ] **Step 3: Write minimal implementation**

Tạo `hook/bin/ccrc-notify-cli.js`:

```js
#!/usr/bin/env node
// `/notify on|off` toggles push notifications; `/notify` reports status.
//
// The status path deliberately calls the hub for real instead of describing the
// local config. Everything else in this system fails silently by design — the
// hook swallows every error so it can never disturb Claude Code — so this is
// the only place a broken setup can be noticed at all. Reading a file and
// declaring "looks fine" would defeat the one diagnostic the user has.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG_DIR = path.join(os.homedir(), '.ccrc');
const NOTIFY_FILE = path.join(CFG_DIR, 'notify');

function readConfig() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(CFG_DIR, 'config'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

function isOn() {
  try { return fs.readFileSync(NOTIFY_FILE, 'utf8').trim() === 'on'; } catch { return false; }
}

function setState(on) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(NOTIFY_FILE, on ? 'on\n' : 'off\n');
}

async function status() {
  const on = isOn();
  console.log(`Thông báo: ${on ? 'ĐANG BẬT' : 'ĐANG TẮT'}`);
  const cfg = readConfig();
  if (!cfg.CCRC_HUB_URL || !cfg.CCRC_TOKEN) {
    console.log('Hub: chưa cấu hình — chạy ./setup-notify.sh');
    return;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(new URL('/api/me', cfg.CCRC_HUB_URL), {
      headers: { authorization: `Bearer ${cfg.CCRC_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    if (res.status === 401) {
      console.log(`Hub: ${cfg.CCRC_HUB_URL} — OK (${ms}ms)`);
      console.log('Token: KHÔNG hợp lệ — hub từ chối. Xin token mới rồi chạy lại ./setup-notify.sh');
      return;
    }
    if (!res.ok) {
      console.log(`Hub: ${cfg.CCRC_HUB_URL} — lỗi HTTP ${res.status}`);
      return;
    }
    const me = await res.json();
    console.log(`Hub: ${cfg.CCRC_HUB_URL} — OK (${ms}ms)`);
    console.log(`Token: hợp lệ, sẽ báo cho ${me.user}`);
    if (me.pushDevices > 0) {
      console.log(`Push: đã đăng ký ${me.pushDevices} thiết bị`);
    } else {
      console.log('Push: ⚠ chưa có thiết bị nào đăng ký — mở web UI trên điện thoại và bật thông báo,');
      console.log('      nếu không thì thông báo gửi đi sẽ không tới đâu cả.');
    }
    if (!on) console.log('\n(Đang TẮT nên sẽ không có thông báo nào được gửi. Bật bằng: /notify on)');
  } catch (err) {
    console.log(`Hub: ${cfg.CCRC_HUB_URL} — không gọi được (${err.name === 'TimeoutError' ? 'quá hạn' : err.message})`);
  }
}

const arg = (process.argv[2] || '').toLowerCase();
if (arg === 'on' || arg === 'off') {
  setState(arg === 'on');
  console.log(`Thông báo: ${arg === 'on' ? 'ĐÃ BẬT' : 'ĐÃ TẮT'}`);
  if (arg === 'on') await status();
} else {
  await status();
}
```

- [ ] **Step 4: Tạo slash command**

Tạo `deploy/commands/notify.md`:

```markdown
---
description: Bật/tắt thông báo đẩy khi Claude Code dừng lại chờ bạn
allowed-tools: Bash(node:*)
---

## Kết quả

!`node "{{CCRC_REPO}}/hook/bin/ccrc-notify-cli.js" $ARGUMENTS`

## Nhiệm vụ của bạn (Claude)

Thuật lại ngắn gọn kết quả ở trên cho người dùng. Nếu có dòng cảnh báo (⚠) hoặc
báo lỗi, nói rõ cần làm gì để sửa. Không làm gì khác.
```

- [ ] **Step 5: Run tests**

```bash
chmod +x hook/bin/ccrc-notify-cli.js
cd hook && npm test
```
Expected: PASS, 26 test.

- [ ] **Step 6: Commit**

```bash
git add hook/bin/ccrc-notify-cli.js deploy/commands/notify.md hook/test/notify-cli.test.js
git commit -m "Add the /notify toggle, whose status check probes the hub for real"
```

---

### Task 6: Cài và gỡ trên máy dev

**Files:**
- Create: `hook/bin/install-hook.mjs`
- Create: `setup-notify.sh`, `remove-notify.sh`
- Test: `hook/test/install-hook.test.js`

**Interfaces:**
- Consumes: không có
- Produces: `install-hook.mjs <install|uninstall> [đường-dẫn-hook]`

**Ràng buộc cứng:** `~/.claude/settings.json` là **file dùng chung**. Trên máy Huy nó đang giữ hook của ClaudeStatusBar và token_slayer. Ghi đè là hỏng cả ba tool. Phải parse JSON, chèn cạnh, idempotent, và **từ chối không sửa gì** nếu file không parse được.

- [ ] **Step 1: Write the failing test**

Tạo `hook/test/install-hook.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install-hook.mjs');
const NEIGHBOURS = {
  hooks: {
    Notification: [{ hooks: [{ type: 'command', command: '/Applications/Other.app/hook Notification' }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash /other/tool.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bash /other/tool.sh' }] }],
  },
  model: 'opus',
};

function tmpHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-h-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings);
  return home;
}
const read = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const ours = (d) => Object.entries(d.hooks || {}).flatMap(([ev, v]) =>
  v.flatMap((m) => (m.hooks || []).filter((h) => (h.command || '').includes('ccrc-notify.js')).map(() => ev)));
const others = (d) => JSON.stringify(Object.entries(d.hooks || {}).map(([ev, v]) =>
  [ev, v.flatMap((m) => (m.hooks || []).filter((h) => !(h.command || '').includes('ccrc-notify.js')).map((h) => h.command))]));

function run(args, home) {
  return new Promise((r) => execFile('node', [TOOL, ...args], { env: { ...process.env, HOME: home } },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('cài đúng MỘT hook, chỉ trên Notification', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  assert.deepEqual(ours(read(home)), ['Notification']);
});

test('cài 3 lần vẫn chỉ có 1 — idempotent', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  for (let i = 0; i < 3; i++) await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  assert.equal(ours(read(home)).length, 1);
});

test('KHÔNG đụng hook của tool khác', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const before = others(JSON.parse(JSON.stringify(NEIGHBOURS)));
  await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  assert.equal(others(read(home)), before, 'hook của tool khác phải nguyên vẹn sau khi cài');
  await run(['uninstall'], home);
  assert.equal(others(read(home)), before, 'và nguyên vẹn sau khi gỡ');
});

test('gỡ xong không còn hook của mình', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  await run(['uninstall'], home);
  assert.deepEqual(ours(read(home)), []);
});

test('settings.json hỏng thì KHÔNG sửa gì và thoát khác 0', async () => {
  const broken = '{ dòng này không phải JSON';
  const home = tmpHome(broken);
  const r = await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), broken,
    'file hỏng phải được để nguyên, không backup cũng không ghi đè');
});

test('chưa có settings.json thì tạo mới được', async () => {
  const home = tmpHome(undefined);
  const r = await run(['install', '/repo/hook/bin/ccrc-notify.js'], home);
  assert.equal(r.code, 0);
  assert.deepEqual(ours(read(home)), ['Notification']);
});

test('gỡ khi chưa từng cài thì không ghi gì', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const p = path.join(home, '.claude', 'settings.json');
  const before = fs.readFileSync(p, 'utf8');
  const r = await run(['uninstall'], home);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'không có gì để gỡ thì không được chạm vào file');
});

test('đường dẫn hook không tồn tại thì từ chối cài', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const r = await run(['install', '/khong/ton/tai/ccrc-notify.js'], home);
  assert.notEqual(r.code, 0);
  assert.deepEqual(ours(read(home)), [], 'không được đăng ký một lệnh chạy sẽ lỗi mỗi lần');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hook && npm test`
Expected: FAIL — không tìm thấy `bin/install-hook.mjs`.

- [ ] **Step 3: Write minimal implementation**

Tạo `hook/bin/install-hook.mjs`:

```js
#!/usr/bin/env node
// Add or remove the ccrc notification hook in ~/.claude/settings.json WITHOUT
// disturbing anything else in it. That file is shared: on a real machine it
// already holds hooks belonging to other tools, and clobbering it breaks them.
// Parse, splice, write back — idempotently, and refuse outright on a file we
// cannot parse rather than "fixing" it.
//
// Usage: install-hook.mjs install <absolute-path-to-ccrc-notify.js>
//        install-hook.mjs uninstall

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, hookPath] = process.argv.slice(2);
if (mode !== 'install' && mode !== 'uninstall') {
  console.error('Dùng: install-hook.mjs <install|uninstall> [đường-dẫn-hook]');
  process.exit(1);
}
if (mode === 'install') {
  if (!hookPath) { console.error('Thiếu đường dẫn tới ccrc-notify.js'); process.exit(1); }
  if (!fs.existsSync(hookPath)) {
    console.error(`✗ Không thấy ${hookPath} — không đăng ký một lệnh sẽ lỗi mỗi lần chạy.`);
    process.exit(1);
  }
}

const file = path.join(os.homedir(), '.claude', 'settings.json');
const EVENT = 'Notification';
const MARKER = 'ccrc-notify.js';

let settings = {};
let existed = false;
if (fs.existsSync(file)) {
  existed = true;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch {
    console.error(`✗ ${file} không phải JSON hợp lệ — KHÔNG sửa gì cả. Sửa tay rồi chạy lại.`);
    process.exit(1);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`✗ ${file} không phải một object JSON — KHÔNG sửa gì cả.`);
    process.exit(1);
  }
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);
const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
  ? settings.hooks : {};
const groups = Array.isArray(hooks[EVENT]) ? hooks[EVENT] : [];

let changed = 0;
const kept = [];
for (const g of groups) {
  if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; } // shape we do not understand: leave it
  const before = g.hooks.length;
  const rest = g.hooks.filter((h) => !isOurs(h));
  changed += before - rest.length;
  if (rest.length) kept.push({ ...g, hooks: rest });
  else if (before === 0) kept.push(g); // was already empty; not ours to delete
}

if (mode === 'install') {
  kept.push({ hooks: [{ type: 'command', command: `"${hookPath}"`, timeout: 10 }] });
  changed++;
}

if (!changed) {
  console.log(mode === 'install' ? '✓ Hook đã ở đúng trạng thái' : '✓ Không có hook nào của ccrc để gỡ');
  process.exit(0);
}

if (kept.length) hooks[EVENT] = kept;
else delete hooks[EVENT];
if (Object.keys(hooks).length) settings.hooks = hooks;
else delete settings.hooks;

// Atomic replace: a crash mid-write must not leave a truncated shared config.
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
fs.renameSync(tmp, file);
console.log(`✓ ${mode === 'install' ? 'Đã cài' : 'Đã gỡ'} hook thông báo${existed ? '' : ' (tạo settings.json mới)'}`);
```

- [ ] **Step 4: Run tests**

```bash
chmod +x hook/bin/install-hook.mjs
cd hook && npm test
```
Expected: PASS, 34 test.

- [ ] **Step 5: Viết setup-notify.sh**

```bash
#!/usr/bin/env bash
# Cài phần máy dev: cấu hình, slash command /notify, hook Notification.
# KHÔNG cài service, KHÔNG đụng tmux — hệ thống này chỉ gửi thông báo.
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR=$(pwd)
CFG_DIR="$HOME/.ccrc"
say() { printf '%s\n' "$*"; }

command -v node >/dev/null 2>&1 || { say "✗ Cần Node.js"; exit 1; }

say "== CC Notify — cài trên máy dev =="
OLD_URL=$(grep -s '^CCRC_HUB_URL=' "$CFG_DIR/config" | cut -d= -f2- || true)
OLD_TOK=$(grep -s '^CCRC_TOKEN=' "$CFG_DIR/config" | cut -d= -f2- || true)

read -r -p "URL hub${OLD_URL:+ [$OLD_URL]}: " HUB_URL || true
HUB_URL="${HUB_URL:-$OLD_URL}"
while [ -z "$HUB_URL" ]; do read -r -p "URL hub (vd https://ccrc.example.com): " HUB_URL; done
case "$HUB_URL" in http://*|https://*) ;; *) HUB_URL="https://$HUB_URL" ;; esac

read -r -p "Token cá nhân${OLD_TOK:+ [giữ nguyên]}: " TOKEN || true
TOKEN="${TOKEN:-$OLD_TOK}"
while [ -z "$TOKEN" ]; do read -r -p "Token cá nhân: " TOKEN; done

DEF_NAME=$(hostname -s 2>/dev/null || hostname)
read -r -p "Tên máy hiện trong thông báo [$DEF_NAME]: " MACHINE || true
MACHINE="${MACHINE:-$DEF_NAME}"

mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/config" <<EOF
CCRC_HUB_URL=$HUB_URL
CCRC_TOKEN=$TOKEN
CCRC_MACHINE_NAME=$MACHINE
EOF
chmod 600 "$CFG_DIR/config"
say "• Đã ghi $CFG_DIR/config (chmod 600)"

# Mặc định TẮT: người dùng chủ động bật khi sắp rời máy.
[ -f "$CFG_DIR/notify" ] || { printf 'off\n' > "$CFG_DIR/notify"; say "• Thông báo mặc định TẮT — bật bằng /notify on"; }

mkdir -p "$HOME/.claude/commands"
sed "s|{{CCRC_REPO}}|$REPO_DIR|g" deploy/commands/notify.md > "$HOME/.claude/commands/notify.md"
say "• Đã cài slash command /notify"

if node "$REPO_DIR/hook/bin/install-hook.mjs" install "$REPO_DIR/hook/bin/ccrc-notify.js"; then
  say "• Đã cài hook Notification"
else
  say "⚠ KHÔNG cài được hook — sẽ không có thông báo nào. Xem lỗi ở trên."
  exit 1
fi

say ""
say "== XONG =="
say "Bước tiếp: mở $HUB_URL trên điện thoại, đăng nhập bằng token, bật thông báo."
say "iPhone: phải thêm vào màn hình chính rồi mở từ đó thì mới nhận được push."
say "Kiểm tra bất cứ lúc nào bằng: /notify"
```

- [ ] **Step 6: Viết remove-notify.sh**

```bash
#!/usr/bin/env bash
# Gỡ sạch phần máy dev. Repo giữ nguyên.
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR=$(pwd)
CFG_DIR="$HOME/.ccrc"
CMD_FILE="$HOME/.claude/commands/notify.md"
say() { printf '%s\n' "$*"; }

say "== Sẽ gỡ =="
[ -d "$CFG_DIR" ] && say "  • $CFG_DIR (config, notify)"
[ -f "$CMD_FILE" ] && say "  • slash command /notify"
say "  • hook ccrc trong ~/.claude/settings.json (chỉ entry của ccrc)"

if [ "${1:-}" != "-y" ]; then
  read -r -p "Tiếp tục? [y/N] " a || true
  case "$a" in y|Y|yes|YES) ;; *) say "Đã huỷ."; exit 0 ;; esac
fi

node "$REPO_DIR/hook/bin/install-hook.mjs" uninstall || say "⚠ Không gỡ được hook — kiểm tra ~/.claude/settings.json bằng tay"
[ -d "$CFG_DIR" ] && rm -rf "$CFG_DIR" && say "✓ Xoá $CFG_DIR"
if [ -f "$CMD_FILE" ] && grep -qs "ccrc-notify-cli.js" "$CMD_FILE"; then
  rm -f "$CMD_FILE" && say "✓ Xoá slash command /notify"
fi
say "✅ Đã gỡ xong. Repo vẫn ở: $REPO_DIR"
```

- [ ] **Step 7: Kiểm idempotent trên bản sao, KHÔNG đụng file thật**

```bash
chmod +x setup-notify.sh remove-notify.sh
bash -n setup-notify.sh && bash -n remove-notify.sh && echo "cú pháp OK"
TMPH=$(mktemp -d); mkdir -p "$TMPH/.claude"
cp ~/.claude/settings.json "$TMPH/.claude/" 2>/dev/null || echo '{}' > "$TMPH/.claude/settings.json"
BEFORE=$(python3 -c "
import json,sys
d=json.load(open('$TMPH/.claude/settings.json'))
print(sum(len(m.get('hooks',[])) for v in d.get('hooks',{}).values() for m in v))")
for i in 1 2 3; do HOME=$TMPH node hook/bin/install-hook.mjs install "$PWD/hook/bin/ccrc-notify.js"; done
HOME=$TMPH node hook/bin/install-hook.mjs uninstall
AFTER=$(python3 -c "
import json
d=json.load(open('$TMPH/.claude/settings.json'))
print(sum(len(m.get('hooks',[])) for v in d.get('hooks',{}).values() for m in v))")
echo "hook của tool khác: trước=$BEFORE sau=$AFTER (phải bằng nhau)"
rm -rf "$TMPH"
```
Expected: cú pháp OK, và `trước == sau`.

- [ ] **Step 8: Commit**

```bash
git add hook/bin/install-hook.mjs hook/test/install-hook.test.js setup-notify.sh remove-notify.sh
git commit -m "Install and remove the notification hook without clobbering shared settings"
```

---

### Task 7: Xoá hướng cũ

**Files:**
- Delete: `agent/` (toàn bộ), `setup-agent.sh`, `remove-agent.sh`, `deploy/commands/remote.md`
- Delete: spec và plan của GĐ1/GĐ2
- Modify: `README.md`, `package.json` (workspaces)

**Interfaces:**
- Consumes: không có
- Produces: không có

- [ ] **Step 1: Xoá**

```bash
git rm -r agent setup-agent.sh remove-agent.sh deploy/commands/remote.md
git rm docs/superpowers/specs/2026-07-26-activity-view-design.md \
       docs/superpowers/plans/2026-07-26-activity-view-phase1.md \
       docs/superpowers/plans/2026-07-26-activity-view-phase2.md
```

- [ ] **Step 2: Sửa workspaces trong package.json gốc**

```json
{
  "name": "cc-remote-control",
  "version": "0.2.0",
  "private": true,
  "description": "Gửi thông báo tới điện thoại khi Claude Code dừng lại chờ bạn",
  "workspaces": ["server", "hook"],
  "scripts": {
    "server": "npm run start --workspace server",
    "test": "npm test --workspace server && npm test --workspace hook"
  }
}
```

- [ ] **Step 3: Viết lại README.md**

Nội dung phải nêu đúng những điều sau, viết bằng tiếng Việt:
- Hệ thống làm **một việc**: gửi thông báo khi Claude Code dừng chờ người dùng hoặc cần xác nhận. Không mirror, không điều khiển từ xa.
- Ba mảnh: hook trên máy dev, hub, PWA trên điện thoại.
- Cài hub: `docker compose --profile cloudflare up -d --build`, tạo user bằng `./deploy.sh adduser`.
- Cài máy dev: `./setup-notify.sh`, gỡ bằng `./remove-notify.sh`.
- Bật/tắt: `/notify on`, `/notify off`, kiểm tra `/notify`. **Mặc định TẮT.**
- iPhone **bắt buộc** thêm vào màn hình chính rồi mở từ đó, nếu không sẽ không nhận được push.
- Khi tắt, không có dữ liệu nào rời khỏi máy.
- Chỉ báo hai loại: đang chờ nhập, và cần xác nhận (bao gồm cả câu hỏi lẫn xin quyền).

Xoá khỏi README mọi phần nói về `/remote`, `ccrc-claude`, bridge, watch, phiên, chat từ web.

- [ ] **Step 4: Kiểm không còn tham chiếu chết**

```bash
grep -rniE "ccrc-claude|/remote|bridge|tmux|activity\.js|ccrc-hook\.js|agent/src" \
  --include=*.js --include=*.json --include=*.sh --include=*.md --include=*.yml \
  . | grep -v node_modules | grep -v '^\./docs/superpowers/specs/2026-07-26-notify-only' | grep -v '\.git/'
```
Expected: không có kết quả nào. Nếu còn, sửa hoặc xoá cho hết.

- [ ] **Step 5: Chạy toàn bộ test**

```bash
npm test
```
Expected: server 9/9, hook 34/34.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Delete the remote-control implementation"
```

---

### Task 8: Deploy và nghiệm thu đầu-cuối

**Files:** không sửa file nào — chỉ kiểm chứng.

- [ ] **Step 1: Chạy toàn bộ test**

```bash
npm test
```
Expected: tất cả PASS.

- [ ] **Step 2: Deploy hub (việc của controller)**

Chạy thử khô trước, xác nhận 0 file bị xoá, rồi:
```bash
rsync -az --delete --exclude='.git/' --exclude='node_modules/' --exclude='.env' \
  --exclude='.env.bak*' --exclude='server/data/' --exclude='.superpowers/' \
  ./ root@192.168.1.10:/opt/ccrc/
ssh root@192.168.1.10 'cd /opt/ccrc && docker compose --profile cloudflare up -d --build'
```

Kiểm sau khi deploy:
```bash
curl -fsS https://ccrc.example.com/healthz
curl -sI https://ccrc.example.com/ | grep -i cache-control
curl -s -o /dev/null -w '%{http_code}\n' https://ccrc.example.com/ws
```
Expected: `{"ok":true}`; `no-cache` cho index.html; `404` cho `/ws`.

⚠ Hub restart làm mất lịch sử thông báo trong RAM — đúng thiết kế, không phải lỗi.

- [ ] **Step 3: Cài trên máy dev**

```bash
./setup-notify.sh
/notify
```
Expected: `/notify` báo ĐANG TẮT, hub OK, token hợp lệ, và **cảnh báo chưa có thiết bị nào đăng ký push**.

- [ ] **Step 4: Bật push trên điện thoại**

⚠ **PWA cũ đang cài trên máy Huy giữ `index.html` cũ.** Phải **gỡ khỏi màn hình chính rồi cài lại** — bump `?v=` không cứu được `index.html`.

Mở `https://ccrc.example.com` bằng Safari → thêm vào màn hình chính → mở từ đó → đăng nhập bằng token → bật thông báo.

Rồi chạy lại `/notify`: phải báo **1 thiết bị**.

- [ ] **Step 5: Nghiệm thu**

| Kiểm | Cách làm | Kỳ vọng |
|---|---|---|
| Tắt thì im lặng | `/notify off`, rồi để Claude hỏi một câu | Không có thông báo nào |
| Bật thì báo khi cần xác nhận | `/notify on`, khoá màn hình, để Claude xin quyền hoặc hỏi | Điện thoại rung, nội dung "cần bạn xác nhận" kèm tên máy · tên dự án |
| Báo khi chờ nhập | Để Claude làm xong rồi đứng chờ | Thông báo "đang chờ bạn nhập" |
| Không báo khi subagent xong | Chạy việc có subagent | **Không** có thông báo nào cho từng subagent |
| Lịch sử | Mở PWA | Thấy các thông báo vừa rồi, mới nhất trên đầu |
| Không rò nội dung | Đọc kỹ thông báo | Chỉ có tên máy, tên thư mục, một câu cố định |
| Không làm hỏng Claude Code | Tắt mạng, dùng Claude Code bình thường | Không lỗi, không chậm, không rác trên màn hình |

- [ ] **Step 6: Cập nhật trí nhớ dự án**

Cập nhật `brain/status/cc-remote.md`: hướng mới đã chạy, kèm những gì đã xoá.

## Self-Review

**Spec coverage:**

| Mục spec | Task |
|---|---|
| §3 D1 web UI cắt trụi | 4 |
| §3 D2 chỉ 2 loại Notification | 1 (whitelist), 6 (chỉ đăng ký hook Notification) |
| §3 D3 hook gọi thẳng hub, xoá agent | 2, 3, 7 |
| §3 D4 công tắc `/notify` | 5 |
| §3 D5 mặc định TẮT | 1, 2, 5, 6 (setup ghi `off`) |
| §3 D6 thay thẳng hub production | 8 |
| §3 D7 xoá cả code lẫn tài liệu | 7 |
| §4.2 nội dung thông báo, không rò | 1 |
| §4.3 hai file cấu hình tách riêng | 2, 5, 6 |
| §5 chịu lỗi + `/notify` kiểm thật | 2, 5 |
| §6 test | mọi task |
| §7 chuyển đổi, PWA phải cài lại | 8 |

**Chưa làm, cố ý:** §8 hai điểm chưa kiểm chứng (`Notification` khi máy ngủ; trần 50) — không chặn triển khai, ghi lại để theo dõi.

**Sai lệch có chủ ý so với spec:** spec nói script hook nằm ở `agent/bin/ccrc-notify.js`; kế hoạch đặt ở `hook/` vì thư mục `agent/` bị xoá cả và cái tên "agent" không còn đúng — không còn tiến trình nền nào.
