# Web terminal — Kế hoạch 1: đường ống

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ một client WebSocket bất kỳ, nối được vào đúng pane tmux đang chạy Claude Code trên máy dev, sau khi người dùng gõ `/remote on`.

**Architecture:** Một daemon `ccrc-term` trên máy dev giữ pane, bật `tailscale serve`, và báo metadata lên hub. Hub cấp vé HMAC ngắn hạn nhưng **không nằm trên đường đi** của byte terminal. Client nối thẳng tới máy dev qua tailnet.

**Tech Stack:** Node 22 ESM, `ws` (WebSocket server — Node không có sẵn), tmux 3.7b, Tailscale 1.98.8. Không dùng framework nào khác. **Không** dùng Cloudflare Tunnel, **không** cài `cloudflared`.

**Spec:** `docs/superpowers/specs/2026-07-27-web-terminal-design.md`

**Kế hoạch 2** (giao diện di động trong PWA) viết SAU khi kế hoạch này chạy được — vì §9 của spec nói nếu phép đo phiên nhóm tmux hỏng thì phần bố cục phải thiết kế lại.

## Global Constraints

- Node 22 ESM. Workspace mới `term/` được thêm vào `workspaces` của `package.json` gốc.
- **Dependency duy nhất được phép thêm:** `ws`. Mọi thứ khác dùng built-in. `node-pty` CHỈ được thêm nếu Task 1 chứng minh control mode không dùng được.
- Comment bằng **tiếng Anh**; mọi chữ người dùng đọc bằng **tiếng Việt**.
- Chạy test: `npm test` ở gốc, hoặc `cd term && npm test`. **KHÔNG dùng `node --test test/`** — dạng truyền thẳng thư mục hỏng trên Node v22.23.1. Dùng `node --test test/*.test.js`.
- Số test hiện tại: server **14**, hook **35**. Mỗi task ghi rõ con số mới.
- `sessionId` là chuỗi ngẫu nhiên do daemon sinh mỗi lần `/remote on`. **Không bao giờ** gửi tên phiên tmux thật ra khỏi máy dev.
- Vé: HMAC, TTL **60 giây**, dùng **một lần**, ràng buộc `sessionId` + tên máy.
- Nhịp tim: daemon POST mỗi **20 giây**; hub coi là "không phản hồi" sau **60 giây**.
- Cổng daemon cục bộ: **8730** (`CCRC_TERM_PORT`), chỉ nghe `127.0.0.1`.
- Mặc định **TẮT**. Không gõ `/remote on` thì không có serve, không có cửa nào mở.
- Đường vào là **IP Tailscale**, mỗi người một tailnet riêng. Lấy từ `tailscale status --json` → `Self.TailscaleIPs[0]`. Ví dụ (địa chỉ minh hoạ, không phải máy nào có thật): `100.101.102.103`. **Không** `tailscale serve`, **không** chứng chỉ TLS (D2c — xem Task 9).
- Hai điều kiện tiên quyết, thiếu cái nào cũng phải **báo lỗi rõ và không bật gì**: (1) đang trong tmux, (2) Tailscale đang chạy và có IP.
- Daemon bind **đúng IP Tailscale**, tuyệt đối không `0.0.0.0` — bind mọi giao diện là hở cổng ra wifi/LAN.
- **Không** dùng `caffeinate` hay bất cứ lệnh riêng hệ điều hành nào.

## File Structure

| File | Trách nhiệm |
|---|---|
| `term/package.json` | Workspace mới, dep `ws` |
| `term/src/ticket.js` | Ký và kiểm vé HMAC. Hàm thuần, không I/O |
| `term/src/nonce-store.js` | Nhớ nonce đã dùng, tự xoá mục quá hạn |
| `term/src/tmux.js` | Bọc mọi lệnh tmux: tìm pane, kiểm pane sống, chụp màn hình |
| `term/src/tailscale.js` | Bọc CLI Tailscale: kiểm điều kiện, bật/tắt serve, lấy URL |
| `term/src/config.js` | Đọc `~/.ccrc/config` và `~/.ccrc/term-secret` |
| `term/bin/ccrc-term.js` | Daemon: WS server, attach pane, đóng khi pane chết |
| `term/bin/ccrc-term-cli.js` | Lệnh `/remote on\|off\|status` |
| `server/src/terminal-sessions.js` | Hub: sổ đăng ký phiên + cấp vé. Tách khỏi `index.js` để file đó không phình |
| `server/src/index.js` | Chỉ thêm phần đấu dây endpoint |
| `deploy/commands/remote.md` | Slash command |

---

### Task 1: Bước 0 — ba phép đo, không viết code sản phẩm

**Files:**
- Create: `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md`
- Create: `tools/measure-tmux-group.sh`, `tools/measure-tmux-control.mjs`

**Interfaces:**
- Consumes: không có
- Produces: kết quả đo quyết định Task 3 và Task 6. **Không task nào sau đây được bắt đầu trước khi task này xong.**

**Vì sao task này tồn tại:** spec §9 liệt kê ba thứ mà nếu sai thì thiết kế phải đổi chứ không sửa vặt. Dự án này đã một lần mất cả ngày vì viết code trên một giả định sai nằm trong đề bài. Đo trước.

- [ ] **Step 1: Viết script đo phiên nhóm tmux**

Tạo `tools/measure-tmux-group.sh`:

```bash
#!/usr/bin/env bash
# Đo: phiên nhóm (tmux new-session -t) có giữ kích thước ĐỘC LẬP không.
# Nếu KHÔNG, màn hình máy tính sẽ co lại khi điện thoại nối vào — spec §5.5.
set -uo pipefail
T=$(command -v tmux) || { echo "KHÔNG có tmux"; exit 1; }
S="ccrc-measure-$$"

"$T" kill-session -t "$S" 2>/dev/null || true
"$T" new-session -d -s "$S" -x 200 -y 50
echo "phiên gốc: $("$T" display-message -p -t "$S" '#{window_width}x#{window_height}')"

# Client thứ hai, phiên nhóm, màn hình hẹp như điện thoại
"$T" new-session -d -t "$S" -s "${S}-phone" -x 40 -y 30
"$T" set-window-option -t "$S" aggressive-resize on

sleep 1
GOC=$("$T" display-message -p -t "$S" '#{window_width}x#{window_height}')
PHONE=$("$T" display-message -p -t "${S}-phone" '#{window_width}x#{window_height}')
echo "sau khi phone nối vào — gốc: $GOC | phone: $PHONE"

"$T" kill-session -t "${S}-phone" 2>/dev/null || true
"$T" kill-session -t "$S" 2>/dev/null || true

case "$GOC" in
  200x50) echo "KẾT LUẬN: ĐẠT — kích thước độc lập, thiết kế §5.5 dùng được" ;;
  *)      echo "KẾT LUẬN: HỎNG — gốc bị co còn $GOC. Phải thiết kế lại phần bố cục." ;;
esac
```

- [ ] **Step 2: Chạy phép đo 1**

```bash
chmod +x tools/measure-tmux-group.sh && ./tools/measure-tmux-group.sh
```

Ghi nguyên văn output vào file kết quả. **Nếu KẾT LUẬN là HỎNG: dừng toàn bộ kế hoạch, báo lại Huy.**

- [ ] **Step 3: Viết script đo tmux control mode**

Tạo `tools/measure-tmux-control.mjs`:

```js
// Đo: `tmux -C` (control mode) có stream được output của pane qua stdio không.
// Nếu ĐƯỢC, daemon không cần node-pty — không thêm native dependency nào.
// Nếu KHÔNG, phải dùng node-pty (native module, phải build).
import { spawn } from 'node:child_process';

const S = `ccrc-ctl-${process.pid}`;
const run = (args) => new Promise((r) => spawn('tmux', args, { stdio: 'ignore' }).on('exit', r));

await run(['kill-session', '-t', S]);
await run(['new-session', '-d', '-s', S, '-x', '80', '-y', '24']);

const ctl = spawn('tmux', ['-C', 'attach-session', '-t', S], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let saw = '';
ctl.stdout.on('data', (b) => { saw += b.toString(); });

// Gõ một chuỗi nhận dạng vào pane rồi xem control mode có phát lại không.
setTimeout(() => {
  ctl.stdin.write('send-keys -t %0 "echo CCRC_MARKER_OK" Enter\n');
}, 500);

setTimeout(async () => {
  ctl.kill();
  await run(['kill-session', '-t', S]);
  const hasOutput = saw.includes('%output');
  const hasMarker = saw.includes('CCRC_MARKER_OK');
  console.log('có dòng %output:', hasOutput);
  console.log('thấy chuỗi nhận dạng:', hasMarker);
  console.log(hasOutput && hasMarker
    ? 'KẾT LUẬN: ĐẠT — dùng control mode, KHÔNG cần node-pty'
    : 'KẾT LUẬN: HỎNG — phải dùng node-pty');
  console.log('--- 600 ký tự đầu của stdout ---');
  console.log(saw.slice(0, 600));
  process.exit(0);
}, 2500);
```

- [ ] **Step 4: Chạy phép đo 2**

```bash
node tools/measure-tmux-control.mjs
```

Ghi nguyên văn output. Kết quả này **quyết định Task 6**: ĐẠT ⇒ không thêm dependency nào ngoài `ws`; HỎNG ⇒ thêm `node-pty` và ghi lý do vào file kết quả.

- [ ] **Step 5: Đo cú pháp TẮT của `tailscale serve`**

Cú pháp **bật** đã chắc: `tailscale serve --bg 8730`. Cú pháp **tắt chỉ phần của mình** thì
chưa — CLI đã đổi giữa các bản. Trên 1.98.8 có `serve reset` (xoá **toàn bộ** cấu hình serve,
kể cả serve khác của người dùng) và `serve clear <service>` (dành cho "services", không phải
serve của node). Cần tìm cách tắt đúng cổng 8730 mà không đụng phần còn lại.

⚠️ **Bật Tailscale trước** (đang ở trạng thái `Stopped`), và **hỏi Huy trước khi chạy
`serve reset`** — nó có thể xoá cấu hình serve khác trên máy.

```bash
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
"$TS" serve status --json          # ghi lại cấu hình HIỆN CÓ trước khi đụng vào
"$TS" serve --bg 8730
"$TS" serve status --json          # xác nhận đã gắn vào cổng 8730
# thử từng cách tắt, xem cách nào chỉ gỡ 8730:
"$TS" serve --https=443 off 2>&1 | head -5
"$TS" serve status --json
```

Ghi lại: cấu hình serve trước khi đụng vào, cú pháp nào tắt được đúng phần của mình, và cú
pháp nào bị từ chối. Nếu **không** có cách nào ngoài `serve reset`, ghi rõ điều đó — Task 4
sẽ phải lưu lại cấu hình cũ và khôi phục.

- [ ] **Step 5b: Đo độ ổn định WebSocket qua tailnet**

```bash
mkdir -p /tmp/ccrc-measure && cd /tmp/ccrc-measure && npm init -y >/dev/null && npm i ws >/dev/null
cat > echo.mjs <<'EOF'
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8731, host: '127.0.0.1' });
let n = 0;
wss.on('connection', (ws) => {
  const t = setInterval(() => ws.send(`tick ${++n}`), 5000);
  ws.on('close', () => clearInterval(t));
});
console.log('echo ws chạy ở 127.0.0.1:8731');
EOF
node echo.mjs &
"$TS" serve --bg 8731
"$TS" status --json | python3 -c "import json,sys; print('wss://' + json.load(sys.stdin)['Self']['DNSName'].rstrip('.') + '/')"
```

Từ một thiết bị khác **trong cùng tailnet**, nối vào URL đó, giữ **ít nhất 30 phút**, đếm số
lần đứt. Ghi kết quả. Dọn sau khi đo: tắt serve cổng 8731 và `rm -rf /tmp/ccrc-measure`.

- [ ] **Step 6: Ghi file kết quả**

Tạo `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md` với đúng cấu trúc:

```markdown
# Bước 0 — kết quả đo (2026-07-27)

## Đo 1: phiên nhóm tmux giữ kích thước độc lập
Lệnh: `./tools/measure-tmux-group.sh`
Output nguyên văn:
```
<dán vào đây>
```
Kết luận: ĐẠT / HỎNG
Hệ quả: <spec §5.5 dùng được / phải thiết kế lại>

## Đo 2: tmux control mode
Lệnh: `node tools/measure-tmux-control.mjs`
Output nguyên văn:
```
<dán vào đây>
```
Kết luận: ĐẠT / HỎNG
**Quyết định dependency:** <chỉ `ws` / thêm `node-pty` vì ...>

## Đo 3: cú pháp TẮT của tailscale serve
Cấu hình serve có sẵn trước khi đo:
```
<dán `serve status --json` ban đầu vào đây>
```
Cú pháp tắt được đúng phần của mình: <lệnh, hoặc "KHÔNG CÓ — phải dùng serve reset">
**Hệ quả cho Task 4:** <tắt thẳng được / phải lưu và khôi phục cấu hình cũ>

## Đo 4: độ ổn định WebSocket qua tailnet
Thời gian giữ kết nối: <bao lâu>
Số lần đứt: <số>
Kết luận: ĐẠT / HỎNG
```

- [ ] **Step 7: Commit**

```bash
git add tools/measure-tmux-group.sh tools/measure-tmux-control.mjs \
        docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md
git commit -m "Measure the three assumptions the terminal design rests on"
```

---

### Task 2: Vé HMAC — hàm thuần

**Files:**
- Create: `term/package.json`, `term/src/ticket.js`, `term/src/nonce-store.js`
- Modify: `package.json` (thêm `term` vào `workspaces` và script test)
- Test: `term/test/ticket.test.js`

**Interfaces:**
- Consumes: không có
- Produces:
  - `signTicket({sessionId, machine, secret, ttlMs = 60000, now = Date.now(), nonce}) → string`
  - `verifyTicket(ticket, {secret, sessionId, now = Date.now()}) → {ok: true, nonce: string} | {ok: false, reason: 'malformed'|'bad_signature'|'expired'|'wrong_session'}`
  - `createNonceStore({ttlMs = 60000}) → {use(nonce, now) → boolean, size() → number}`

**Vì sao vé phải chặt:** đây là thứ duy nhất đứng giữa một URL bị lộ và một shell đầy đủ trên máy dev. Vé sai một chỗ là mất máy, không phải mất một thông báo.

- [ ] **Step 1: Tạo workspace**

Tạo `term/package.json`:

```json
{
  "name": "ccrc-term",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/*.test.js" },
  "dependencies": { "ws": "^8.18.0" }
}
```

Sửa `package.json` gốc:

```json
{
  "name": "cc-remote-control",
  "version": "0.2.0",
  "private": true,
  "description": "Gửi thông báo tới điện thoại khi Claude Code dừng lại chờ bạn",
  "workspaces": ["server", "hook", "term"],
  "scripts": {
    "server": "npm run start --workspace server",
    "test": "npm test --workspace server && npm test --workspace hook && npm test --workspace term"
  }
}
```

- [ ] **Step 2: Viết test đỏ**

Tạo `term/test/ticket.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { signTicket, verifyTicket } from '../src/ticket.js';
import { createNonceStore } from '../src/nonce-store.js';

const BASE = { sessionId: 's-abc', machine: 'may-dev', secret: 'bi-mat-32-ky-tu-cho-du-dai-nhe' };

test('vé hợp lệ được chấp nhận và trả lại nonce', () => {
  const t = signTicket({ ...BASE, now: 1000, nonce: 'n1' });
  const r = verifyTicket(t, { secret: BASE.secret, sessionId: 's-abc', now: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.nonce, 'n1');
});

test('vé hết hạn bị từ chối', () => {
  const t = signTicket({ ...BASE, now: 1000, ttlMs: 60000, nonce: 'n1' });
  const r = verifyTicket(t, { secret: BASE.secret, sessionId: 's-abc', now: 1000 + 60001 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('đúng biên hết hạn vẫn còn hiệu lực', () => {
  const t = signTicket({ ...BASE, now: 1000, ttlMs: 60000, nonce: 'n1' });
  const r = verifyTicket(t, { secret: BASE.secret, sessionId: 's-abc', now: 1000 + 60000 });
  assert.equal(r.ok, true);
});

test('sai bí mật bị từ chối', () => {
  const t = signTicket({ ...BASE, now: 1000, nonce: 'n1' });
  const r = verifyTicket(t, { secret: 'bi-mat-khac-hoan-toan-nhe-ban', sessionId: 's-abc', now: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('vé của phiên này KHÔNG mở được phiên khác', () => {
  const t = signTicket({ ...BASE, now: 1000, nonce: 'n1' });
  const r = verifyTicket(t, { secret: BASE.secret, sessionId: 's-khac', now: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_session');
});

test('sửa một ký tự trong payload là chữ ký hỏng', () => {
  const t = signTicket({ ...BASE, now: 1000, nonce: 'n1' });
  const [v, payload, sig] = t.split('.');
  const doi = Buffer.from(payload, 'base64url').toString().replace('may-dev', 'may-khac');
  const gia = `${v}.${Buffer.from(doi).toString('base64url')}.${sig}`;
  const r = verifyTicket(gia, { secret: BASE.secret, sessionId: 's-abc', now: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('chuỗi rác không làm ném lỗi', () => {
  for (const rac of ['', 'abc', 'a.b', 'a.b.c.d', '...', 'v1..', null, undefined]) {
    const r = verifyTicket(rac, { secret: BASE.secret, sessionId: 's-abc', now: 1000 });
    assert.equal(r.ok, false, `phải từ chối: ${JSON.stringify(rac)}`);
  }
});

test('nonce dùng một lần: lần hai bị từ chối', () => {
  const store = createNonceStore({ ttlMs: 60000 });
  assert.equal(store.use('n1', 1000), true);
  assert.equal(store.use('n1', 1000), false, 'dùng lại phải bị chặn');
});

test('nonce quá hạn được dọn, không phình vô hạn', () => {
  const store = createNonceStore({ ttlMs: 60000 });
  store.use('n1', 1000);
  store.use('n2', 1000);
  assert.equal(store.size(), 2);
  store.use('n3', 1000 + 60001);
  assert.equal(store.size(), 1, 'hai nonce cũ phải bị dọn');
});
```

- [ ] **Step 3: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `../src/ticket.js`.

- [ ] **Step 4: Viết implementation**

Tạo `term/src/ticket.js`:

```js
// Sign and verify the short-lived ticket that lets a browser open the terminal
// WebSocket. This is the only thing standing between a leaked URL and a full
// shell on the dev machine, so it is deliberately small, pure, and total:
// every malformed input returns a reason rather than throwing.

import crypto from 'node:crypto';

const VERSION = 'v1';

function mac(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function signTicket({ sessionId, machine, secret, ttlMs = 60_000, now = Date.now(), nonce }) {
  const payload = JSON.stringify({ sid: sessionId, m: machine, exp: now + ttlMs, n: nonce });
  const b64 = Buffer.from(payload).toString('base64url');
  return `${VERSION}.${b64}.${mac(secret, b64)}`;
}

export function verifyTicket(ticket, { secret, sessionId, now = Date.now() }) {
  if (typeof ticket !== 'string') return { ok: false, reason: 'malformed' };
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, b64, sig] = parts;

  const expected = mac(secret, b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof data.n !== 'string' || !data.n) return { ok: false, reason: 'malformed' };
  if (data.sid !== sessionId) return { ok: false, reason: 'wrong_session' };
  if (typeof data.exp !== 'number' || now > data.exp) return { ok: false, reason: 'expired' };

  return { ok: true, nonce: data.n };
}
```

Tạo `term/src/nonce-store.js`:

```js
// Remember which tickets have already been redeemed. Kept in memory on
// purpose: a daemon restart invalidating every outstanding ticket is the
// behaviour we want, not a bug to work around.

export function createNonceStore({ ttlMs = 60_000 } = {}) {
  /** @type {Map<string, number>} nonce -> expiry */
  const seen = new Map();

  function sweep(now) {
    for (const [n, exp] of seen) if (now > exp) seen.delete(n);
  }

  return {
    /** @returns {boolean} true if this nonce had not been used before */
    use(nonce, now = Date.now()) {
      sweep(now);
      if (seen.has(nonce)) return false;
      seen.set(nonce, now + ttlMs);
      return true;
    },
    size() { return seen.size; },
  };
}
```

- [ ] **Step 5: Chạy để thấy XANH**

```bash
cd term && npm test
```
Expected: PASS, **9 test**.

- [ ] **Step 6: Kiểm mutation — chứng minh test có bảo vệ thật**

Chạy từng đột biến, xác nhận có test đỏ, rồi hoàn tác:

| Đột biến | Test phải đỏ |
|---|---|
| Bỏ dòng `if (data.sid !== sessionId)` | "vé của phiên này KHÔNG mở được phiên khác" |
| Đổi `now > data.exp` thành `now > data.exp + 999999` | "vé hết hạn bị từ chối" |
| Thay `timingSafeEqual` bằng `sig === expected` | không test nào đỏ — **đây là đột biến hợp lệ về hành vi**, ghi nhận rồi hoàn tác |
| Bỏ `sweep(now)` trong `use()` | "nonce quá hạn được dọn" |

Ghi kết quả từng dòng vào báo cáo.

- [ ] **Step 7: Commit**

```bash
git add term/package.json term/src/ticket.js term/src/nonce-store.js term/test/ticket.test.js package.json
git commit -m "Add the short-lived ticket that guards the terminal socket"
```

---

### Task 3: Bọc tmux

**Files:**
- Create: `term/src/tmux.js`
- Test: `term/test/tmux.test.js`

**Interfaces:**
- Consumes: không có
- Produces:
  - `tmuxBin() → string` — đường dẫn tmux, ném lỗi rõ nếu không có
  - `currentPane(env = process.env) → string | null` — id pane từ `$TMUX_PANE`
  - `paneAlive(paneId) → boolean`
  - `paneSession(paneId) → string | null`
  - `capturePane(paneId) → string` — nội dung màn hình hiện tại, giữ mã màu

**Bài học phải tuân thủ:** ở hướng cũ đã xoá, `paneAlive` từng dương tính giả vì `tmux display-message` trả **exit 0 kèm output rỗng** cho pane đã chết. Lần này bắt pane **tự khai id của chính nó** và so khớp. Có test riêng cho đúng cái bẫy đó.

Và: `tmux` không nằm trong PATH tối giản của một số môi trường chạy nền — `tmuxBin()` phải dò `CCRC_TMUX_BIN` → `$PATH` → các vị trí Homebrew/MacPorts.

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/tmux.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmuxBin, currentPane, paneAlive, paneSession, capturePane } from '../src/tmux.js';

const T = tmuxBin();
const tmux = (...args) => execFileSync(T, args, { encoding: 'utf8' }).trim();

function withSession(fn) {
  const s = `ccrc-t-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  try { return fn(s); } finally {
    try { execFileSync(T, ['kill-session', '-t', s]); } catch {}
  }
}

test('tmuxBin trả về đường dẫn chạy được', () => {
  assert.ok(tmuxBin().length > 0);
  assert.match(execFileSync(tmuxBin(), ['-V'], { encoding: 'utf8' }), /^tmux /);
});

test('currentPane đọc từ TMUX_PANE', () => {
  assert.equal(currentPane({ TMUX_PANE: '%7' }), '%7');
  assert.equal(currentPane({}), null);
  assert.equal(currentPane({ TMUX_PANE: '' }), null);
});

test('paneAlive đúng với pane đang sống', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    assert.equal(paneAlive(pane), true);
  });
});

test('paneAlive FALSE với pane đã chết — cái bẫy exit 0 output rỗng', () => {
  let pane;
  withSession((s) => { pane = tmux('display-message', '-p', '-t', s, '#{pane_id}'); });
  // phiên đã bị huỷ ở đây
  assert.equal(paneAlive(pane), false, 'pane chết mà báo sống là lỗi đã từng mất cả ngày');
});

test('paneAlive FALSE với id bịa', () => {
  assert.equal(paneAlive('%999999'), false);
  assert.equal(paneAlive('khong-phai-id'), false);
  assert.equal(paneAlive(''), false);
});

test('paneSession trả tên phiên chứa pane', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    assert.equal(paneSession(pane), s);
  });
});

test('capturePane lấy được nội dung đang hiển thị', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    execFileSync(T, ['send-keys', '-t', pane, 'echo CCRC_HELLO_MARKER', 'Enter']);
    execFileSync(T, ['run-shell', 'sleep 0.5']);
    assert.match(capturePane(pane), /CCRC_HELLO_MARKER/);
  });
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `../src/tmux.js`.

- [ ] **Step 3: Viết implementation**

Tạo `term/src/tmux.js`:

```js
// Every tmux call the daemon makes goes through here, for two reasons learned
// the hard way on the previous direction:
//
//  1. `tmux` is not on the minimal PATH some background launchers provide, so
//     resolving the binary is not optional.
//  2. `tmux display-message` exits 0 with EMPTY output for a dead pane. Asking
//     "does this pane exist?" and treating exit 0 as yes reports every dead
//     pane as alive. We make the pane state its own id and compare.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/home/linuxbrew/.linuxbrew/bin/tmux',
  '/opt/local/bin/tmux',
  '/usr/bin/tmux',
];

let cached = null;

export function tmuxBin() {
  if (cached) return cached;
  if (process.env.CCRC_TMUX_BIN) return (cached = process.env.CCRC_TMUX_BIN);
  try {
    const found = execFileSync('command', ['-v', 'tmux'], { encoding: 'utf8', shell: true }).trim();
    if (found) return (cached = found);
  } catch { /* fall through to the fixed list */ }
  for (const p of CANDIDATES) if (fs.existsSync(p)) return (cached = p);
  throw new Error('Không tìm thấy tmux. Đặt CCRC_TMUX_BIN trỏ tới nó.');
}

function tmux(args) {
  return execFileSync(tmuxBin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function currentPane(env = process.env) {
  const p = env.TMUX_PANE;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

export function paneAlive(paneId) {
  if (typeof paneId !== 'string' || !paneId) return false;
  try {
    // The pane must report its OWN id back. A dead pane yields empty output
    // with exit 0, which would otherwise read as success.
    return tmux(['display-message', '-p', '-t', paneId, '#{pane_id}']).trim() === paneId;
  } catch {
    return false;
  }
}

export function paneSession(paneId) {
  if (!paneAlive(paneId)) return null;
  try {
    const s = tmux(['display-message', '-p', '-t', paneId, '#{session_name}']).trim();
    return s || null;
  } catch {
    return null;
  }
}

export function capturePane(paneId) {
  try {
    // -p print to stdout, -e keep escape sequences (colours), -J unwrap lines.
    return tmux(['capture-pane', '-p', '-e', '-J', '-t', paneId]);
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Chạy để thấy XANH**

```bash
cd term && npm test
```
Expected: PASS, **16 test** (9 của Task 2 + 7 mới).

- [ ] **Step 5: Kiểm mutation trên đúng cái bẫy**

Đổi `paneAlive` thành dạng ngây thơ:

```js
export function paneAlive(paneId) {
  try { tmux(['display-message', '-p', '-t', paneId, '#{pane_id}']); return true; }
  catch { return false; }
}
```

Chạy `cd term && npm test`. Test **"paneAlive FALSE với pane đã chết"** phải đỏ. Nếu nó vẫn xanh thì test không bảo vệ được gì — báo lại. Hoàn tác sau khi xác nhận.

- [ ] **Step 6: Commit**

```bash
git add term/src/tmux.js term/test/tmux.test.js
git commit -m "Wrap tmux, refusing to call a dead pane alive"
```

---

### Task 4: Cấu hình và Tailscale

**Files:**
- Create: `term/src/config.js`, `term/src/tailscale.js`
- Test: `term/test/config.test.js`, `term/test/tailscale.test.js`

**Interfaces:**
- Consumes: không có
- Produces:
  - `readConfig(home = os.homedir()) → {hubUrl, token, machine} | null`
  - `readSecret(home = os.homedir()) → string | null`
  - `ensureSecret(home = os.homedir()) → string` — sinh nếu chưa có, chmod 600
  - `tailscaleBin() → string` — ném lỗi rõ nếu không tìm thấy
  - `checkPrereqs(bin = tailscaleBin()) → {ok: true, url: string} | {ok: false, reason: 'no_binary'|'stopped'|'no_certs', message: string}`
  - `serveStart(port, bin = tailscaleBin()) → void` — ném lỗi kèm stderr nếu hỏng
  - `serveStop(port, bin = tailscaleBin()) → void` — không bao giờ ném

**Cú pháp tắt serve lấy từ Task 1 Đo 3.** Đọc `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md`.
Nếu Đo 3 kết luận **"KHÔNG CÓ — phải dùng serve reset"** thì `serveStart` phải lưu lại
`serve status --json` ban đầu và `serveStop` khôi phục nó bằng `serve set-config`, vì
`serve reset` xoá cả cấu hình serve khác của người dùng. **Không được đoán** — đọc file đo.

`~/.ccrc/config` đã tồn tại từ hệ thống thông báo, cùng định dạng `KEY=value`. Dùng lại, **không** tạo file cấu hình thứ hai.

- [ ] **Step 1: Viết test đỏ cho config**

Tạo `term/test/config.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readSecret, ensureSecret } from '../src/config.js';

function tmpHome(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cfg-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

test('đọc đủ ba khoá từ ~/.ccrc/config', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\nCCRC_TOKEN=tok123\nCCRC_MACHINE_NAME=may-dev\n');
  assert.deepEqual(readConfig(home), { hubUrl: 'https://h.example', token: 'tok123', machine: 'may-dev' });
});

test('giá trị có dấu = bên trong không bị cắt', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\nCCRC_TOKEN=a=b=c\nCCRC_MACHINE_NAME=m\n');
  assert.equal(readConfig(home).token, 'a=b=c');
});

test('thiếu file trả về null, không ném', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cfg-'));
  assert.equal(readConfig(home), null);
});

test('thiếu khoá bắt buộc trả về null', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\n');
  assert.equal(readConfig(home), null);
});

test('ensureSecret sinh bí mật dài và chmod 600', () => {
  const home = tmpHome('');
  const s = ensureSecret(home);
  assert.ok(s.length >= 32, 'bí mật phải đủ dài');
  const mode = fs.statSync(path.join(home, '.ccrc', 'term-secret')).mode & 0o777;
  assert.equal(mode, 0o600, 'bí mật HMAC không được để người khác đọc');
});

test('ensureSecret gọi hai lần trả về CÙNG một bí mật', () => {
  const home = tmpHome('');
  assert.equal(ensureSecret(home), ensureSecret(home), 'sinh lại là mọi vé cũ hỏng');
});

test('readSecret trả null khi chưa có', () => {
  const home = tmpHome('');
  assert.equal(readSecret(home), null);
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `../src/config.js`.

- [ ] **Step 3: Viết config.js**

Tạo `term/src/config.js`:

```js
// Reuse the notification system's ~/.ccrc/config rather than inventing a
// second config file: one place to look when something is wrong.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = (home) => path.join(home, '.ccrc');

export function readConfig(home = os.homedir()) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir(home), 'config'), 'utf8');
  } catch {
    return null;
  }
  const kv = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const hubUrl = kv.CCRC_HUB_URL;
  const token = kv.CCRC_TOKEN;
  const machine = kv.CCRC_MACHINE_NAME;
  if (!hubUrl || !token || !machine) return null;
  return { hubUrl, token, machine };
}

export function readSecret(home = os.homedir()) {
  try {
    const s = fs.readFileSync(path.join(dir(home), 'term-secret'), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

export function ensureSecret(home = os.homedir()) {
  const existing = readSecret(home);
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dir(home), { recursive: true });
  fs.writeFileSync(path.join(dir(home), 'term-secret'), secret + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(dir(home), 'term-secret'), 0o600);
  return secret;
}
```

- [ ] **Step 4: Viết test đỏ cho Tailscale**

Tạo `term/test/tailscale.test.js`. Dùng một script giả đóng vai `tailscale`, để test không
phụ thuộc trạng thái mạng thật:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrereqs, serveStart, serveStop } from '../src/tailscale.js';

// Giả lập CLI tailscale: `status --json` in ra JSON cho sẵn, mọi lệnh khác ghi
// log vào file để test kiểm được đã gọi đúng gì.
function fakeTailscale(statusJson, { failServe = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-'));
  const log = path.join(d, 'calls.log');
  const bin = path.join(d, 'fake-tailscale');
  fs.writeFileSync(path.join(d, 'status.json'), JSON.stringify(statusJson));
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = "status" ]; then cat ${path.join(d, 'status.json')}; exit 0; fi
if [ "$1" = "serve" ]; then ${failServe ? 'echo "serve hong" >&2; exit 1' : 'exit 0'}; fi
exit 0
`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

const RUNNING = {
  BackendState: 'Running',
  Self: { DNSName: 'may-dev.tailnet-example.ts.net.' },
  CertDomains: ['may-dev.tailnet-example.ts.net'],
};

test('đủ điều kiện: trả về URL, bỏ dấu chấm cuối của DNSName', () => {
  const { bin } = fakeTailscale(RUNNING);
  const r = checkPrereqs(bin);
  assert.equal(r.ok, true);
  assert.equal(r.url, 'may-dev.tailnet-example.ts.net', 'dấu chấm cuối lọt vào URL là hỏng');
});

test('Tailscale đang dừng: báo reason stopped kèm việc cần làm', () => {
  const { bin } = fakeTailscale({ ...RUNNING, BackendState: 'Stopped' });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
  assert.match(r.message, /Tailscale/i);
});

test('tailnet chưa bật HTTPS: báo reason no_certs', () => {
  const { bin } = fakeTailscale({ ...RUNNING, CertDomains: null });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_certs');
});

test('CertDomains rỗng cũng là no_certs, không phải hợp lệ', () => {
  const { bin } = fakeTailscale({ ...RUNNING, CertDomains: [] });
  assert.equal(checkPrereqs(bin).reason, 'no_certs');
});

test('không có binary: báo no_binary chứ không ném', () => {
  const r = checkPrereqs('/khong/ton/tai/tailscale');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_binary');
});

test('serveStart gọi đúng cổng', () => {
  const { bin, calls } = fakeTailscale(RUNNING);
  serveStart(8730, bin);
  assert.match(calls(), /serve .*8730/);
});

test('serveStart ném lỗi kèm stderr khi tailscale từ chối', () => {
  const { bin } = fakeTailscale(RUNNING, { failServe: true });
  assert.throws(() => serveStart(8730, bin), /serve hong/,
    'serve hỏng mà im lặng thì người dùng ngồi chờ một URL không tồn tại');
});

test('serveStop KHÔNG bao giờ ném, kể cả khi tailscale hỏng', () => {
  const { bin } = fakeTailscale(RUNNING, { failServe: true });
  serveStop(8730, bin);
  serveStop(8730, '/khong/ton/tai/tailscale');
});
```

- [ ] **Step 5: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `../src/tailscale.js`.

- [ ] **Step 6: Viết tailscale.js**

⚠️ **Trước khi viết `serveStop`, đọc `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md`
mục Đo 3** để biết cú pháp tắt đúng. Không được đoán.

Tạo `term/src/tailscale.js`:

```js
// Everything this project knows about Tailscale lives here.
//
// The three prerequisite checks matter more than they look: a stopped daemon
// and a tailnet without HTTPS certificates both produce a URL that resolves to
// nothing, which from the phone is indistinguishable from a sleeping machine.
// Checking up front turns a mystery into a sentence telling the user what to do.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];

let cached = null;

export function tailscaleBin() {
  if (cached) return cached;
  if (process.env.CCRC_TAILSCALE_BIN) return (cached = process.env.CCRC_TAILSCALE_BIN);
  for (const p of CANDIDATES) if (fs.existsSync(p)) return (cached = p);
  throw new Error('Không tìm thấy Tailscale. Đặt CCRC_TAILSCALE_BIN trỏ tới nó.');
}

export function checkPrereqs(bin = tailscaleBin()) {
  let status;
  try {
    status = JSON.parse(execFileSync(bin, ['status', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return { ok: false, reason: 'no_binary', message: 'Không chạy được Tailscale trên máy này.' };
  }

  if (status.BackendState === 'Stopped' || !status.BackendState) {
    return { ok: false, reason: 'stopped', message: 'Tailscale đang tắt — mở app Tailscale và bật lên.' };
  }
  if (!Array.isArray(status.CertDomains) || status.CertDomains.length === 0) {
    return {
      ok: false, reason: 'no_certs',
      message: 'Tailnet chưa bật HTTPS Certificates — bật trong admin console rồi thử lại.',
    };
  }
  const dns = status.Self && status.Self.DNSName;
  if (typeof dns !== 'string' || !dns) {
    return { ok: false, reason: 'stopped', message: 'Tailscale chưa có tên máy — đăng nhập lại.' };
  }
  // DNSName carries a trailing dot; leaving it in produces a URL that silently
  // fails to match the certificate.
  return { ok: true, url: dns.replace(/\.$/, '') };
}

export function serveStart(port, bin = tailscaleBin()) {
  try {
    execFileSync(bin, ['serve', '--bg', String(port)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`Không bật được tailscale serve: ${detail}`);
  }
}

export function serveStop(port, bin = tailscaleBin()) {
  // Turning off must never throw: it runs on the shutdown path, where an
  // exception would leave the serve mount in place with nothing behind it.
  try {
    execFileSync(bin, ['serve', '--https=443', 'off'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* see Đo 3 — fall back per the measured syntax */ }
}
```

- [ ] **Step 7: Chạy để thấy XANH**

```bash
cd term && npm test
```
Expected: PASS, **31 test** (16 + 7 config + 8 tailscale).

- [ ] **Step 8: Commit**

```bash
git add term/src/config.js term/src/tailscale.js term/test/config.test.js term/test/tailscale.test.js
git commit -m "Check the three Tailscale prerequisites before promising a URL"
```

---

### Task 5: Hub — sổ đăng ký phiên và cấp vé

**Files:**
- Create: `server/src/terminal-sessions.js`
- Modify: `server/src/index.js` (chỉ thêm phần đấu dây endpoint)
- Test: `server/test/terminal-api.test.js`

**Interfaces:**
- Consumes: `signTicket` (Task 2) — hub import từ `term/src/ticket.js` qua đường dẫn tương đối `../../term/src/ticket.js`
- Produces (HTTP, đều cần `Authorization: Bearer <token cá nhân>`):
  - `POST /api/terminal/register` `{sessionId, machine, url, secret}` → `{ok: true}` — cũng là nhịp tim
  - `POST /api/terminal/unregister` `{sessionId}` → `{ok: true}`
  - `GET /api/terminal` → `{session: {sessionId, machine, url, alive} | null}`
  - `POST /api/terminal/ticket` `{sessionId}` → `{ticket, expiresAt}` hoặc 404 nếu không có phiên

**Ranh giới phải giữ:** hub **không bao giờ** thấy byte terminal. Nó chỉ giữ metadata và ký vé. Bí mật HMAC giữ **trong RAM**, không ghi đĩa — daemon gửi lại mỗi nhịp tim, nên hub khởi động lại tự lành trong ≤20 giây.

- [ ] **Step 1: Viết test đỏ**

Tạo `server/test/terminal-api.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyTicket } from '../../term/src/ticket.js';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'),
    JSON.stringify([{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }]));
  const port = 8990 + Math.floor(Math.random() * 200);
  const proc = spawn('node', [SRV], {
    env: { ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { base, stop: () => proc.kill() };
}

async function withHub(fn) {
  const h = await startHub();
  try { await fn(h); } finally { h.stop(); }
}

const post = (h, p, tok, body) => fetch(h.base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  body: JSON.stringify(body),
});
const get = (h, p, tok) => fetch(h.base + p, { headers: { authorization: `Bearer ${tok}` } });

const REG = { sessionId: 's-abc', machine: 'may-dev', url: 'wss://term.example/attach', secret: 'bi-mat-du-dai-32-ky-tu-nhe-ban' };

test('đăng ký rồi GET /api/terminal thấy phiên', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', REG)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.session.sessionId, 's-abc');
    assert.equal(j.session.machine, 'may-dev');
    assert.equal(j.session.url, 'wss://term.example/attach');
  });
});

test('hub KHÔNG trả bí mật HMAC ra ngoài', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const body = await (await get(h, '/api/terminal', 'tok-huy')).text();
    assert.ok(!body.includes(REG.secret), 'bí mật lộ ra API là mất toàn bộ giá trị của vé');
  });
});

test('chưa đăng ký thì session là null', async () => {
  await withHub(async (h) => {
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.session, null);
  });
});

test('vé cấp ra kiểm được bằng đúng bí mật đã đăng ký', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const j = await (await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: 's-abc' })).json();
    const r = verifyTicket(j.ticket, { secret: REG.secret, sessionId: 's-abc' });
    assert.equal(r.ok, true);
  });
});

test('mỗi vé có nonce khác nhau', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const a = await (await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: 's-abc' })).json();
    const b = await (await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: 's-abc' })).json();
    assert.notEqual(a.ticket, b.ticket, 'vé trùng nhau là vé dùng lại được');
  });
});

test('xin vé cho sessionId không tồn tại bị từ chối 404', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    assert.equal((await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: 's-khac' })).status, 404);
  });
});

test('KHÔNG thấy được phiên của người khác', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const j = await (await get(h, '/api/terminal', 'tok-kien')).json();
    assert.equal(j.session, null, 'phiên của huy không được lộ cho kien');
  });
});

test('KHÔNG xin được vé vào phiên của người khác', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    assert.equal((await post(h, '/api/terminal/ticket', 'tok-kien', { sessionId: 's-abc' })).status, 404);
  });
});

test('unregister xoá phiên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    await post(h, '/api/terminal/unregister', 'tok-huy', { sessionId: 's-abc' });
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.session, null);
  });
});

test('không token bị từ chối 401 ở cả bốn endpoint', async () => {
  await withHub(async (h) => {
    const noAuth = (m, p) => fetch(h.base + p, {
      method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined,
    });
    assert.equal((await noAuth('POST', '/api/terminal/register')).status, 401);
    assert.equal((await noAuth('POST', '/api/terminal/unregister')).status, 401);
    assert.equal((await noAuth('POST', '/api/terminal/ticket')).status, 401);
    assert.equal((await noAuth('GET', '/api/terminal')).status, 401);
  });
});

test('body dị dạng bị từ chối 400, không làm sập hub', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { machine: 'x' })).status, 400);
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', null)).status, 400);
    assert.equal((await post(h, '/api/terminal/ticket', 'tok-huy', {})).status, 400);
    assert.equal((await fetch(h.base + '/healthz')).status, 200, 'hub phải còn sống');
  });
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd server && npm test
```
Expected: FAIL — chưa có endpoint nào, các test trả 404 thay vì 200/400/401.

- [ ] **Step 3: Viết terminal-sessions.js**

Tạo `server/src/terminal-sessions.js`:

```js
// The hub's entire involvement with the terminal: remember which session a
// user has open, and sign tickets for it. Bytes never pass through here.
//
// The HMAC secret is held in memory only, never written to disk. The daemon
// resends it on every heartbeat, so a hub restart repairs itself within one
// heartbeat interval instead of leaving a shell key lying in a file.

import crypto from 'node:crypto';
import { signTicket } from '../../term/src/ticket.js';

const HEARTBEAT_DEAD_MS = 60_000;
const TICKET_TTL_MS = 60_000;

export function createTerminalSessions({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {sessionId, machine, url, secret, seenAt}>} userName -> session */
  const byUser = new Map();

  return {
    register(userName, { sessionId, machine, url, secret }) {
      byUser.set(userName, { sessionId, machine, url, secret, seenAt: now() });
    },

    unregister(userName, sessionId) {
      const s = byUser.get(userName);
      if (s && s.sessionId === sessionId) byUser.delete(userName);
    },

    /** Public shape — deliberately omits `secret`. */
    get(userName) {
      const s = byUser.get(userName);
      if (!s) return null;
      return {
        sessionId: s.sessionId,
        machine: s.machine,
        url: s.url,
        alive: now() - s.seenAt <= HEARTBEAT_DEAD_MS,
      };
    },

    /** @returns {{ticket: string, expiresAt: number} | null} null when this user has no such session */
    issueTicket(userName, sessionId) {
      const s = byUser.get(userName);
      if (!s || s.sessionId !== sessionId) return null;
      const t = now();
      return {
        ticket: signTicket({
          sessionId: s.sessionId,
          machine: s.machine,
          secret: s.secret,
          ttlMs: TICKET_TTL_MS,
          now: t,
          nonce: crypto.randomBytes(12).toString('base64url'),
        }),
        expiresAt: t + TICKET_TTL_MS,
      };
    },
  };
}
```

- [ ] **Step 4: Đấu dây vào index.js**

Thêm vào `server/src/index.js` — import ở đầu file, cạnh các import khác:

```js
import { createTerminalSessions } from './terminal-sessions.js';
```

Khởi tạo ngay trước phần `// HTTP wiring`:

```js
const terminals = createTerminalSessions();
```

Thêm bốn route ngay **trước** khối `app.use((err, _req, res, _next) => {`:

```js
app.post('/api/terminal/register', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)
      || typeof b.sessionId !== 'string' || !b.sessionId
      || typeof b.machine !== 'string' || !b.machine
      || typeof b.url !== 'string' || !b.url
      || typeof b.secret !== 'string' || !b.secret) {
    return res.status(400).json({ ok: false, error: 'Thiếu thông tin phiên' });
  }
  terminals.register(user.name, b);
  res.json({ ok: true });
});

app.post('/api/terminal/unregister', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const sessionId = req.body && req.body.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ ok: false });
  terminals.unregister(user.name, sessionId);
  res.json({ ok: true });
});

app.get('/api/terminal', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ session: terminals.get(user.name) });
});

app.post('/api/terminal/ticket', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const sessionId = req.body && req.body.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ ok: false });
  const t = terminals.issueTicket(user.name, sessionId);
  if (!t) return res.status(404).json({ ok: false, error: 'Không có phiên nào như vậy' });
  res.json(t);
});
```

- [ ] **Step 5: Chạy để thấy XANH**

```bash
cd server && npm test
```
Expected: PASS, **25 test** (14 cũ + 11 mới).

- [ ] **Step 6: Kiểm mutation trên ràng buộc phân tách người dùng**

Đổi `issueTicket` để bỏ qua chủ sở hữu:

```js
issueTicket(userName, sessionId) {
  for (const s of byUser.values()) if (s.sessionId === sessionId) { /* ký như cũ */ }
}
```

Chạy test. **"KHÔNG xin được vé vào phiên của người khác"** phải đỏ. Hoàn tác sau khi xác nhận.

- [ ] **Step 7: Sửa Dockerfile — nếu bỏ qua, hub production SẬP lúc khởi động**

`server/src/terminal-sessions.js` import `../../term/src/ticket.js`, nhưng
`docker/Dockerfile.hub` hiện chỉ copy `server/src` và `server/public`. Test dưới máy vẫn
xanh vì cả monorepo nằm đó; trong image thì `term/` không tồn tại và hub chết ngay khi
`node src/index.js` chạy. Đây đúng loại lỗi mà "test xanh" không phát hiện được.

Thay toàn bộ phần COPY của `docker/Dockerfile.hub` để giữ nguyên cấu trúc thư mục, nhờ vậy
đường dẫn import giống hệt dưới máy và trong image:

```dockerfile
WORKDIR /app

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev && npm cache clean --force

COPY server/src ./server/src
COPY server/public ./server/public
COPY term/src/ticket.js ./term/src/ticket.js

ENV CCRC_PORT=8720 \
    CCRC_DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8720

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8720/healthz || exit 1

CMD ["node", "server/src/index.js"]
```

- [ ] **Step 8: Chứng minh image thật khởi động được**

Không tin vào việc đọc Dockerfile — build và chạy thật:

```bash
docker build -f docker/Dockerfile.hub -t ccrc-hub-test .
docker run --rm -e CCRC_TOKEN=test-token -e CCRC_PORT=8720 -d --name ccrc-hub-test -p 18720:8720 ccrc-hub-test
sleep 4
curl -fsS http://127.0.0.1:18720/healthz
docker logs ccrc-hub-test
docker rm -f ccrc-hub-test
```
Expected: `{"ok":true}`, và log **không** có `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 9: Commit**

```bash
git add server/src/terminal-sessions.js server/src/index.js server/test/terminal-api.test.js docker/Dockerfile.hub
git commit -m "Let the hub vouch for a terminal session without carrying its bytes"
```

---

### Task 6: Daemon — WebSocket server và attach pane

**Files:**
- Create: `term/bin/ccrc-term.js`
- Test: `term/test/daemon.test.js`

**Interfaces:**
- Consumes: `verifyTicket`, `createNonceStore` (Task 2); `paneAlive`, `capturePane`, `tmuxBin` (Task 3); `readConfig`, `ensureSecret`, `checkPrereqs`, `serveStart`, `serveStop` (Task 4)
- Produces: tiến trình nghe `127.0.0.1:8730`, đường dẫn `/attach?ticket=…`

**Cách stream phụ thuộc kết quả Task 1:**
- Task 1 Đo 2 = **ĐẠT** ⇒ dùng `tmux -C attach-session`, không thêm dependency.
- Task 1 Đo 2 = **HỎNG** ⇒ thêm `node-pty` vào `term/package.json`, ghi lý do vào báo cáo, và spawn `tmux attach-session -t <phiên nhóm>` trong PTY.

Đọc `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md` để biết đi nhánh nào. **Không được đoán.**

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/daemon.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { signTicket } from '../src/ticket.js';
import { tmuxBin } from '../src/tmux.js';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term.js');
const SECRET = 'bi-mat-test-du-dai-32-ky-tu-nhe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDaemon() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-d-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n');
  fs.writeFileSync(path.join(home, '.ccrc', 'term-secret'), SECRET + '\n', { mode: 0o600 });

  const T = tmuxBin();
  const sess = `ccrc-d-${process.pid}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  const port = 8800 + Math.floor(Math.random() * 100);
  const proc = spawn('node', [DAEMON], {
    env: {
      ...process.env, HOME: home,
      CCRC_TERM_PORT: String(port),
      CCRC_TERM_PANE: pane,
      CCRC_TERM_SESSION_ID: 's-test',
      CCRC_TERM_NO_SERVE: '1',
      CCRC_TERM_NO_HUB: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(1200);
  return {
    proc, port, pane, sess,
    url: (ticket) => `ws://127.0.0.1:${port}/attach?ticket=${encodeURIComponent(ticket)}`,
    stop() {
      try { proc.kill(); } catch {}
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    },
  };
}

const goodTicket = (over = {}) => signTicket({
  sessionId: 's-test', machine: 'may-test', secret: SECRET,
  nonce: `n-${Math.random()}`, ...over,
});

function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const data = [];
    ws.on('message', (m) => data.push(m.toString()));
    ws.on('open', () => resolve({ ws, data, ok: true }));
    ws.on('error', () => resolve({ ws: null, data, ok: false }));
    ws.on('unexpected-response', () => resolve({ ws: null, data, ok: false }));
  });
}

test('vé hợp lệ nối được và nhận nội dung màn hình ban đầu', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(goodTicket()));
    assert.equal(c.ok, true, 'vé hợp lệ phải nối được');
    await sleep(600);
    assert.ok(c.data.length > 0, 'phải gửi nội dung màn hình hiện tại ngay khi nối');
    c.ws.close();
  } finally { d.stop(); }
});

test('không có vé bị từ chối', async () => {
  const d = await startDaemon();
  try {
    assert.equal((await connect(`ws://127.0.0.1:${d.port}/attach`)).ok, false);
  } finally { d.stop(); }
});

test('vé sai chữ ký bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const gia = signTicket({ sessionId: 's-test', machine: 'may-test', secret: 'bi-mat-khac-han-nhe-ban-oi', nonce: 'n1' });
    assert.equal((await connect(d.url(gia))).ok, false);
  } finally { d.stop(); }
});

test('vé hết hạn bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const cu = goodTicket({ now: Date.now() - 120_000 });
    assert.equal((await connect(d.url(cu))).ok, false);
  } finally { d.stop(); }
});

test('vé dùng lần thứ hai bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const t = goodTicket();
    const a = await connect(d.url(t));
    assert.equal(a.ok, true);
    a.ws.close();
    await sleep(200);
    assert.equal((await connect(d.url(t))).ok, false, 'vé phải dùng một lần');
  } finally { d.stop(); }
});

test('vé của sessionId khác bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const t = goodTicket({ sessionId: 's-khac' });
    assert.equal((await connect(d.url(t))).ok, false);
  } finally { d.stop(); }
});

test('gõ vào WebSocket thì chữ hiện ra trong pane', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(goodTicket()));
    assert.equal(c.ok, true);
    c.ws.send('echo CCRC_WS_MARKER\r');
    await sleep(1000);
    const man = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.match(man, /CCRC_WS_MARKER/, 'byte gửi qua WS phải tới đúng pane');
    c.ws.close();
  } finally { d.stop(); }
});

test('pane chết thì daemon tự thoát', async () => {
  const d = await startDaemon();
  try {
    execFileSync(tmuxBin(), ['kill-session', '-t', d.sess]);
    await sleep(3000);
    assert.equal(d.proc.exitCode !== null || d.proc.signalCode !== null, true,
      'pane chết là không còn gì để phơi ra — daemon phải tự đóng');
  } finally { d.stop(); }
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `bin/ccrc-term.js`.

- [ ] **Step 3: Viết daemon (nhánh control mode)**

Tạo `term/bin/ccrc-term.js`. Chỉ dùng bản này nếu Task 1 Đo 2 = ĐẠT:

```js
#!/usr/bin/env node
// The daemon that exposes exactly one tmux pane over a WebSocket, and nothing
// else. It refuses every request that is not a valid, unused, unexpired ticket
// for the one session it was started for, and it exits the moment that pane
// dies — there is no state in which it is listening with nothing to serve.

import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { verifyTicket } from '../src/ticket.js';
import { createNonceStore } from '../src/nonce-store.js';
import { paneAlive, capturePane, tmuxBin, paneSession } from '../src/tmux.js';
import { readConfig, ensureSecret } from '../src/config.js';
import { checkPrereqs, serveStart, serveStop } from '../src/tailscale.js';

const PORT = Number(process.env.CCRC_TERM_PORT || 8730);
const PANE = process.env.CCRC_TERM_PANE;
const SESSION_ID = process.env.CCRC_TERM_SESSION_ID;
let publicUrl = process.env.CCRC_TERM_URL || '';
const NO_SERVE = process.env.CCRC_TERM_NO_SERVE === '1';
const NO_HUB = process.env.CCRC_TERM_NO_HUB === '1';
const HEARTBEAT_MS = 20_000;
const PANE_CHECK_MS = 2_000;

if (!PANE || !SESSION_ID) {
  console.error('Thiếu CCRC_TERM_PANE hoặc CCRC_TERM_SESSION_ID');
  process.exit(1);
}
if (!paneAlive(PANE)) {
  console.error(`Pane ${PANE} không tồn tại.`);
  process.exit(1);
}

const cfg = readConfig(os.homedir());
const secret = ensureSecret(os.homedir());
const nonces = createNonceStore({ ttlMs: 60_000 });

let serving = false;
let shuttingDown = false;

async function tellHub(pathname, body) {
  if (NO_HUB || !cfg) return;
  try {
    await fetch(new URL(pathname, cfg.hubUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* the hub being unreachable must never take the terminal down */ }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[term] đóng: ${reason}`);
  tellHub('/api/terminal/unregister', { sessionId: SESSION_ID }).finally(() => {
    if (serving) serveStop(PORT);
    process.exit(0);
  });
}

// --- WebSocket -------------------------------------------------------------

const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/attach') return socket.destroy();

  const ticket = url.searchParams.get('ticket');
  const v = verifyTicket(ticket, { secret, sessionId: SESSION_ID });
  if (!v.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  // One-time use. Checked only after the signature, so a forged ticket cannot
  // burn a nonce it never legitimately held.
  if (!nonces.use(v.nonce)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  // Send what is on screen right now, so the phone opens onto the current
  // state instead of an empty rectangle until the next byte of output.
  ws.send(capturePane(PANE));

  const ctl = spawn(tmuxBin(), ['-C', 'attach-session', '-t', paneSession(PANE)], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  ctl.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      // %output %<pane> <octal-escaped bytes>
      if (!line.startsWith('%output ')) continue;
      const sp = line.indexOf(' ', 8);
      if (sp < 0) continue;
      if (line.slice(8, sp) !== PANE) continue;
      ws.send(unescapeOctal(line.slice(sp + 1)));
    }
  });

  ws.on('message', (data) => {
    // send-keys -H takes hex, which sidesteps every quoting question about
    // control characters, newlines and UTF-8 the shell would otherwise raise.
    const hex = Buffer.from(data).toString('hex').match(/../g) || [];
    ctl.stdin.write(`send-keys -t ${PANE} -H ${hex.join(' ')}\n`);
  });

  const close = () => { try { ctl.kill(); } catch {} };
  ws.on('close', close);
  ws.on('error', close);
});

function unescapeOctal(s) {
  return s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// --- lifecycle -------------------------------------------------------------

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[term] nghe 127.0.0.1:${PORT}, pane ${PANE}`);

  if (!NO_SERVE) {
    const pre = checkPrereqs();
    if (!pre.ok) {
      console.error(`[term] ${pre.message}`);
      process.exit(1);
    }
    serveStart(PORT);
    serving = true;
    publicUrl = `wss://${pre.url}/attach`;
  }

  const beat = () => tellHub('/api/terminal/register', {
    sessionId: SESSION_ID,
    machine: cfg ? cfg.machine : os.hostname(),
    url: publicUrl,
    secret,
  });
  await beat();
  setInterval(beat, HEARTBEAT_MS).unref();
});

// The pane dying is the primary close signal — see spec §4.2.
setInterval(() => {
  if (!paneAlive(PANE)) shutdown('pane tmux đã chết');
}, PANE_CHECK_MS);

process.on('SIGTERM', () => shutdown('nhận SIGTERM'));
process.on('SIGINT', () => shutdown('nhận SIGINT'));
```

- [ ] **Step 4: Chạy để thấy XANH**

```bash
chmod +x term/bin/ccrc-term.js
cd term && npm test
```
Expected: PASS, **39 test** (31 + 8 mới).

- [ ] **Step 5: Kiểm mutation trên ba ràng buộc bảo mật**

| Đột biến | Test phải đỏ |
|---|---|
| Bỏ `if (!nonces.use(v.nonce))` | "vé dùng lần thứ hai bị từ chối" |
| Đổi `if (!v.ok)` thành `if (false)` | "không có vé", "vé sai chữ ký", "vé hết hạn", "vé của sessionId khác" |
| Bỏ hẳn `setInterval` kiểm pane | "pane chết thì daemon tự thoát" |

Ghi kết quả từng dòng. Nếu có đột biến nào **không** làm đỏ test nào, báo lại — test đó không bảo vệ gì.

- [ ] **Step 6: Commit**

```bash
git add term/bin/ccrc-term.js term/test/daemon.test.js
git commit -m "Expose one tmux pane over a socket that refuses everything else"
```

---

### Task 7: Lệnh `/remote`

**Files:**
- Create: `term/bin/ccrc-term-cli.js`, `deploy/commands/remote.md`
- Test: `term/test/remote-cli.test.js`

**Interfaces:**
- Consumes: `readConfig`, `ensureSecret` (Task 4); `currentPane`, `paneAlive` (Task 3); daemon (Task 6)
- Produces: `ccrc-term-cli.js [on|off]` — không tham số là báo trạng thái

**Nguyên tắc lấy từ `/notify`:** lệnh không tham số **gọi thật lên hub** và báo từng lớp, không suy đoán từ file cấu hình. Đây là chỗ duy nhất phát hiện được hỏng hóc.

**Bắt buộc:** chạy ngoài tmux thì **báo lỗi rõ và không bật gì cả** (spec §4.4). Không được bật một nửa.

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/remote-cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js');

function tmpHome(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

function stubHub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function run(args, env) {
  return new Promise((r) => execFile('node', [CLI, ...args], { env: { ...process.env, ...env } },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('chạy ngoài tmux: báo lỗi rõ, KHÔNG bật gì', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run(['on'], { HOME: home, TMUX_PANE: '', TMUX: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /tmux/i);
});

test('trạng thái khi chưa có phiên nào', async () => {
  const { srv, base } = await stubHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session: null }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  const r = await run([], { HOME: home });
  srv.close();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TẮT|chưa mở/i);
});

test('trạng thái khi đang có phiên: báo hub OK và tên máy', async () => {
  const { srv, base } = await stubHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session: { sessionId: 's1', machine: 'may-dev', url: 'wss://x/attach', alive: true } }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=may-dev\n`);
  const r = await run([], { HOME: home });
  srv.close();
  assert.match(r.stdout, /BẬT|đang mở/i);
  assert.match(r.stdout, /may-dev/);
});

test('trạng thái gọi THẬT lên hub, không đọc mỗi file', async () => {
  let hits = 0;
  const { srv, base } = await stubHub((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session: null }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  await run([], { HOME: home });
  srv.close();
  assert.equal(hits, 1, 'phải gọi hub đúng một lần — đây là chẩn đoán duy nhất người dùng có');
});

test('hub chết: báo rõ chứ không im lặng', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run([], { HOME: home });
  assert.match(r.stdout + r.stderr, /không gọi được|lỗi/i);
});

test('chưa cấu hình: chỉ ra việc cần làm', async () => {
  const home = tmpHome(null);
  const r = await run([], { HOME: home });
  assert.match(r.stdout + r.stderr, /chưa cấu hình|setup/i);
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `bin/ccrc-term-cli.js`.

- [ ] **Step 3: Viết CLI**

Tạo `term/bin/ccrc-term-cli.js`:

```js
#!/usr/bin/env node
// `/remote on|off` and, with no argument, the status report.
//
// The status path deliberately calls the hub for real rather than reading the
// local config and declaring things fine: everything else in this system fails
// quietly, so this is the only place a broken setup can surface.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, ensureSecret } from '../src/config.js';
import { currentPane, paneAlive } from '../src/tmux.js';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ccrc-term.js');
const PIDFILE = path.join(os.homedir(), '.ccrc', 'term.pid');
const say = (s) => process.stdout.write(s + '\n');

const cfg = readConfig(os.homedir());
if (!cfg) {
  say('Chưa cấu hình — chạy ./setup-notify.sh trước.');
  process.exit(1);
}

const mode = process.argv[2];

async function hub(pathname, init = {}) {
  const res = await fetch(new URL(pathname, cfg.hubUrl), {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function cmdOn() {
  const pane = currentPane();
  if (!pane || !paneAlive(pane)) {
    say('✗ Không chạy trong tmux — /remote cần một phiên tmux để nối vào.');
    say('  Khởi động lại Claude Code bên trong tmux rồi thử lại.');
    process.exit(1);
  }
  if (runningPid()) { say('✓ Remote đã bật sẵn'); return; }

  const sessionId = crypto.randomBytes(9).toString('base64url');
  ensureSecret(os.homedir());

  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      CCRC_TERM_PANE: pane,
      CCRC_TERM_SESSION_ID: sessionId,
      CCRC_TERM_URL: process.env.CCRC_TERM_URL || '',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));

  say('✓ Remote ĐÃ BẬT');
  say('⚠ Máy ngủ là mất kết nối. Hãy đặt máy không ngủ trước khi rời đi.');
}

async function cmdOff() {
  const pid = runningPid();
  if (!pid) { say('✓ Remote vốn đã tắt'); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  try { fs.unlinkSync(PIDFILE); } catch { /* nothing to remove */ }
  say('✓ Remote ĐÃ TẮT');
}

async function cmdStatus() {
  const pid = runningPid();
  say(`Remote: ${pid ? 'ĐANG BẬT' : 'ĐANG TẮT'}`);

  let res;
  const t0 = Date.now();
  try {
    res = await hub('/api/terminal');
  } catch (e) {
    say(`Hub: ${cfg.hubUrl} — không gọi được (${e.message})`);
    return;
  }
  say(`Hub: ${cfg.hubUrl} — OK (${Date.now() - t0}ms)`);

  if (res.status === 401) { say('Token: KHÔNG hợp lệ — hub từ chối.'); return; }
  if (!res.ok) { say(`Hub trả lỗi ${res.status}`); return; }

  const { session } = await res.json();
  if (!session) {
    say('Phiên: chưa mở phiên nào — gõ `/remote on` trong tmux để mở.');
    return;
  }
  say(`Phiên: đang mở trên ${session.machine}`);
  say(`Trạng thái: ${session.alive ? 'còn nhịp tim' : '⚠ KHÔNG phản hồi — máy có thể đã ngủ'}`);
}

const run = mode === 'on' ? cmdOn : mode === 'off' ? cmdOff : cmdStatus;
run().catch((e) => { say(`Lỗi: ${e.message}`); process.exit(1); });
```

- [ ] **Step 4: Viết slash command**

Tạo `deploy/commands/remote.md`:

```markdown
---
description: Bật/tắt terminal từ xa cho phiên tmux đang chạy Claude
---

Chạy lệnh sau rồi thuật lại nguyên văn kết quả cho người dùng:

!`node {{CCRC_REPO}}/term/bin/ccrc-term-cli.js $ARGUMENTS`

## Nhiệm vụ của bạn (Claude)

Thuật lại ngắn gọn kết quả ở trên. Nếu có dòng cảnh báo (⚠) hoặc báo lỗi (✗),
nói rõ người dùng cần làm gì để sửa. Không làm gì khác.
```

- [ ] **Step 5: Chạy để thấy XANH**

```bash
chmod +x term/bin/ccrc-term-cli.js
cd term && npm test
```
Expected: PASS, **45 test** (39 + 6 mới).

- [ ] **Step 6: Kiểm mutation trên hai ràng buộc**

| Đột biến | Test phải đỏ |
|---|---|
| Bỏ khối `if (!pane \|\| !paneAlive(pane))` trong `cmdOn` | "chạy ngoài tmux: báo lỗi rõ, KHÔNG bật gì" |
| Đổi `cmdStatus` thành chỉ đọc PIDFILE, không gọi hub | "trạng thái gọi THẬT lên hub" |

- [ ] **Step 7: Commit**

```bash
git add term/bin/ccrc-term-cli.js deploy/commands/remote.md term/test/remote-cli.test.js
git commit -m "Add /remote, whose status check asks the hub rather than a file"
```

---

### Task 8: Cài đặt và nghiệm thu đầu-cuối

**Files:**
- Modify: `setup-notify.sh`, `remove-notify.sh`, `README.md`
- Create: `docs/superpowers/specs/2026-07-27-nghiem-thu-ke-hoach-1.md`

**Interfaces:**
- Consumes: mọi task trước
- Produces: không có

**⛔ Ràng buộc:** `~/.claude/settings.json` là file dùng chung, đang giữ hook của ClaudeStatusBar và token_slayer. Mọi thao tác thử nghiệm phải trỏ `HOME` vào thư mục tạm. **Hỏi Huy trước khi chạy `setup-notify.sh` thật.**

- [ ] **Step 1: Thêm phần cài slash command /remote vào setup-notify.sh**

Sửa `setup-notify.sh`, ngay sau dòng cài `/notify`:

```bash
sed "s|{{CCRC_REPO}}|$REPO_DIR|g" deploy/commands/remote.md > "$HOME/.claude/commands/remote.md"
say "• Đã cài slash command /remote"
```

- [ ] **Step 2: Thêm phần gỡ vào remove-notify.sh**

Sửa `remove-notify.sh`, cạnh chỗ xoá `/notify`:

```bash
RCMD_FILE="$HOME/.claude/commands/remote.md"
if [ -f "$RCMD_FILE" ] && grep -qs "ccrc-term-cli.js" "$RCMD_FILE"; then
  rm -f "$RCMD_FILE" && say "✓ Xoá slash command /remote"
fi
```

- [ ] **Step 3: Kiểm cú pháp, KHÔNG chạy thật**

```bash
bash -n setup-notify.sh && bash -n remove-notify.sh && echo "cú pháp OK"
```

- [ ] **Step 4: Chạy toàn bộ test**

```bash
npm test
```
Expected: server **25**, hook **35**, term **45**.

- [ ] **Step 5: Nghiệm thu tay bằng client WebSocket trên máy tính**

Chưa có giao diện di động — kiểm bằng `wscat` hoặc script Node. Ghi kết quả từng dòng:

| Kiểm | Cách làm | Kỳ vọng |
|---|---|---|
| Ngoài tmux thì từ chối | Chạy `/remote on` ngoài tmux | Báo lỗi rõ, exit ≠ 0, không có tiến trình daemon |
| Tailscale tắt thì từ chối | Dừng Tailscale rồi `/remote on` | Báo đúng "Tailscale đang tắt", KHÔNG bật serve |
| Thiết bị ngoài tailnet | Mở WS từ máy không ở trong tailnet | Không nối được — và thông điệp phân biệt được với "máy đã ngủ" |
| Bật được trong tmux | Mở tmux, chạy Claude Code trong đó, gõ `/remote on` | Báo ĐÃ BẬT kèm cảnh báo máy ngủ |
| Hub thấy phiên | `curl -H "authorization: Bearer <token>" https://.../api/terminal` | Trả về `session` có `machine`, `alive: true` |
| Hub KHÔNG lộ bí mật | Đọc kỹ JSON trên | Không có trường `secret` |
| Vé nối được | Xin vé rồi mở WS tới URL `.ts.net` | Nhận được nội dung màn hình hiện tại |
| Gõ vào thì tới pane | Gửi `echo XIN_CHAO\r` qua WS | Chữ hiện trong tmux trên máy |
| Vé dùng lại bị chặn | Mở WS lần hai bằng đúng vé cũ | Bị từ chối |
| Màn hình máy KHÔNG co | Nối vào bằng client 40 cột | tmux trên máy giữ nguyên kích thước |
| Pane chết thì đóng hết | `exit` khỏi Claude Code | Daemon thoát, hub xoá phiên, serve tắt |
| `/remote off` | Gõ lệnh | Daemon chết, `curl /api/terminal` trả `session: null` |
| Tắt rồi thì không nối được | Mở WS lại | Không nối được |

- [ ] **Step 6: Ghi kết quả nghiệm thu**

Tạo `docs/superpowers/specs/2026-07-27-nghiem-thu-ke-hoach-1.md` với bảng trên, mỗi dòng ghi ĐẠT/HỎNG kèm bằng chứng (output thật, không phải mô tả).

- [ ] **Step 7: Cập nhật README**

Thêm một mục vào `README.md`, viết bằng tiếng Việt, nêu đúng:
- `/remote on` mở terminal cho phiên tmux đang chạy Claude; `/remote off` đóng; `/remote` báo trạng thái
- **Bắt buộc chạy Claude Code trong tmux**
- Mặc định TẮT
- Máy ngủ là mất kết nối — người dùng tự đặt máy không ngủ
- Giao diện di động **chưa có** ở kế hoạch này

- [ ] **Step 8: Commit**

```bash
git add setup-notify.sh remove-notify.sh README.md docs/superpowers/specs/2026-07-27-nghiem-thu-ke-hoach-1.md
git commit -m "Install /remote alongside /notify and record the pipeline acceptance run"
```

---

---

### Task 9: Chuyển đường vào sang IP Tailscale, bỏ hẳn `serve` và chứng chỉ

**Files:**
- Modify: `term/src/tailscale.js`, `term/test/tailscale.test.js`
- Modify: `term/bin/ccrc-term.js`, `term/test/daemon.test.js`

**Interfaces:**
- Consumes: không có
- Produces (thay thế bản cũ):
  - `checkPrereqs(bin?) → {ok: true, ip: string} | {ok: false, reason: 'no_binary'|'stopped'|'bad_output', message: string}`
  - `serveStart` và `serveStop` **bị xoá hoàn toàn**

**Vì sao task này tồn tại.** Huy chốt D2c: **không được để lộ bất cứ thứ gì ra ngoài
tailnet**, kể cả tên máy trong Certificate Transparency log — và CT log không xoá được.
`tailscale serve` HTTPS bắt buộc có chứng chỉ, mà mọi chứng chỉ đều vào CT log. Đo thật
trên máy Huy: `tailscale cert may-dev.tailnet-example.ts.net` →
`500: your Tailscale account does not support getting TLS certs`.

Đường vào mới: daemon **nghe thẳng trên IP Tailscale**. Không chứng chỉ, không bản ghi DNS
công khai, không `serve`. Tailscale là WireGuard nên byte vẫn được mã hoá ở tầng dưới.

**Ràng buộc quan trọng nhất của task này:** bind **đúng** `Self.TailscaleIPs[0]`, tuyệt đối
không `0.0.0.0`. Bind `0.0.0.0` mở cổng 8730 ra **mọi mạng máy đang nối** — wifi quán cà
phê, LAN công ty. Có test riêng cho điều này.

- [ ] **Step 1: Sửa test `tailscale.test.js` cho hợp đồng mới**

Xoá mọi test của `serveStart`/`serveStop` và của `no_certs`. Sửa fixture `RUNNING` bỏ
`CertDomains`, thêm `TailscaleIPs`. Đổi test đường-thành-công thành kiểm `ip`:

```js
const RUNNING = {
  BackendState: 'Running',
  Self: { DNSName: 'may-dev.tailnet-example.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
};

test('đủ điều kiện: trả về IPv4 Tailscale', () => {
  const { bin } = fakeTailscale(RUNNING);
  const r = checkPrereqs(bin);
  assert.equal(r.ok, true);
  assert.equal(r.ip, '100.101.102.103');
});

test('bỏ qua IPv6, lấy đúng IPv4', () => {
  const { bin } = fakeTailscale({ ...RUNNING,
    Self: { TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.102.103'] } });
  assert.equal(checkPrereqs(bin).ip, '100.101.102.103');
});

test('chưa có IP nào: báo stopped, không ném', () => {
  const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: [] } });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
});

test('KHÔNG còn reason no_certs — chứng chỉ không còn là điều kiện', () => {
  const { bin } = fakeTailscale(RUNNING);
  assert.equal(checkPrereqs(bin).ok, true, 'thiếu CertDomains không được làm hỏng nữa');
});
```

Giữ nguyên mọi test về `BackendState`, `no_binary`, `bad_output`, và các test timeout của
`checkPrereqs`.

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — `serveStart`/`serveStop` không còn được import, và `checkPrereqs` chưa trả `ip`.

- [ ] **Step 3: Sửa `term/src/tailscale.js`**

Xoá hẳn `serveStart` và `serveStop`. Trong `checkPrereqs`, bỏ khối kiểm `CertDomains` và
đổi phần trả về:

```js
  const ips = (status.Self && status.Self.TailscaleIPs) || [];
  // Bind to the IPv4 address: Node's listen() on an IPv6 literal needs bracket
  // handling the rest of the code would have to learn, for no gain here.
  const ip = ips.find((a) => typeof a === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) {
    return { ok: false, reason: 'stopped', message: 'Tailscale chưa có địa chỉ — mở app Tailscale và đăng nhập.' };
  }
  return { ok: true, ip };
```

Sửa luôn comment đầu file: không còn nói về chứng chỉ hay serve.

- [ ] **Step 4: Sửa daemon `term/bin/ccrc-term.js`**

Bỏ `serveStart`/`serveStop` khỏi import và khỏi mọi nơi dùng. Đổi `NO_SERVE` thành
`CCRC_TERM_BIND` (địa chỉ bind, mặc định lấy từ `checkPrereqs`; test truyền `127.0.0.1`).
Phần khởi động thành:

```js
let bindAddr = process.env.CCRC_TERM_BIND || '';
if (!bindAddr) {
  const pre = checkPrereqs();
  if (!pre.ok) {
    console.error(`[term] ${pre.message}`);
    process.exit(1);
  }
  bindAddr = pre.ip;
  publicUrl = `http://${pre.ip}:${PORT}/`;
}

server.listen(PORT, bindAddr, async () => { /* … như cũ, bỏ phần serveStart … */ });
```

Và trong `shutdown()` bỏ dòng `if (serving) serveStop(PORT);` cùng biến `serving`.

- [ ] **Step 5: Thêm test bind cho daemon**

Vào `term/test/daemon.test.js`:

```js
test('daemon KHÔNG nghe trên 0.0.0.0 — cổng không được hở ra wifi/LAN', async () => {
  const d = await startDaemon();
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    const dong = out.split('\n').filter((l) => l.includes(`:${d.port}`));
    assert.ok(dong.length > 0, 'phải có tiến trình nghe cổng này');
    for (const l of dong) {
      assert.ok(!l.includes('*:'), `nghe trên mọi giao diện là hở ra LAN: ${l}`);
    }
  } finally { d.stop(); }
});
```

Sửa `startDaemon()` truyền `CCRC_TERM_BIND: '127.0.0.1'` thay cho `CCRC_TERM_NO_SERVE: '1'`.
Sửa `remote-cli.test.js` tương tự ở cả ba chỗ đang đặt `CCRC_TERM_NO_SERVE`.

- [ ] **Step 6: Chạy để thấy XANH**

```bash
cd term && npm test
```
Expected: PASS. Số test giảm vài đơn vị do xoá test `serve`, tăng lại do thêm test mới —
ghi con số thật vào báo cáo, **không** chỉnh test cho khớp một con số định sẵn.

- [ ] **Step 7: Kiểm mutation**

| Đột biến | Test phải đỏ |
|---|---|
| `server.listen(PORT, bindAddr)` → `server.listen(PORT, '0.0.0.0')` | "daemon KHÔNG nghe trên 0.0.0.0" |
| `checkPrereqs` trả IPv6 thay vì IPv4 | "bỏ qua IPv6, lấy đúng IPv4" |
| Bỏ kiểm `ips` rỗng | "chưa có IP nào: báo stopped" |

- [ ] **Step 8: Commit**

```bash
git add term/src/tailscale.js term/test/tailscale.test.js term/bin/ccrc-term.js term/test/daemon.test.js term/test/remote-cli.test.js
git commit -m "Listen on the Tailscale address instead of asking for a certificate"
```

## Self-Review

**1. Spec coverage**

| Mục spec | Task |
|---|---|
| §2 sự thật đã đo | 1 (đo lại + bổ sung) |
| §4.1 bốn mảnh | 5 (hub), 6 (daemon), 7 (CLI) |
| §4.2 vòng đời, pane chết là trụ chính | 6 (`setInterval` kiểm pane + test), 7 (`on`/`off`) |
| §4.2 hook `SessionEnd` là tín hiệu phụ | **Kế hoạch 2** — cần hook, thuộc phần tích hợp Claude Code |
| §4.3 vé HMAC, bốn ràng buộc | 2 (vé + nonce), 6 (chỉ attach pane đã đăng ký, một lần) |
| §4.3 các đại lượng (sessionId, nhịp tim, URL tailnet) | 4 (tailscale), 6 (nhịp 20s), 7 (sinh sessionId) |
| §4.4 ba điều kiện tiên quyết (tmux, Tailscale chạy, HTTPS certs) | 7 (tmux), 4 + 6 (hai cái còn lại, có test) |
| §5 nhập liệu di động | **Kế hoạch 2** |
| §6 kết nối lại | **Kế hoạch 2** (phía client) |
| §7 xử lý lỗi | 4 (ba lý do hỏng có thông điệp riêng), 7 (status từng lớp) |
| §8 kiểm thử tầng 1 và 2 | 2–7 |
| §8 nghiệm thu tầng 3 trên điện thoại | **Kế hoạch 2** |
| §9 bước 0 | 1 |

**Khoảng trống có chủ ý:** mọi mục thuộc giao diện di động nằm ở Kế hoạch 2, viết sau khi Task 1 có kết quả. Hook `SessionEnd` cũng để lại vì nó thuộc lớp tích hợp Claude Code chứ không phải đường ống.

**2. Placeholder scan:** không có TBD/TODO. Mọi bước có code thật hoặc lệnh thật. Task 6 có hai nhánh nhưng điều kiện chọn nhánh là kết quả đo cụ thể của Task 1, không phải "tuỳ tình hình".

**3. Type consistency:** đã đối chiếu — `signTicket`/`verifyTicket` (Task 2) dùng đúng tên tham số ở Task 5 và Task 6; `paneAlive`/`capturePane`/`paneSession`/`tmuxBin` (Task 3) dùng đúng ở Task 6 và 7; `readConfig` trả `{hubUrl, token, machine}` dùng đúng ở Task 6 và 7; `checkPrereqs`/`serveStart`/`serveStop` (Task 4) dùng đúng ở Task 6 — `checkPrereqs` trả `{ok, url}` và Task 6 dựng `wss://${pre.url}/attach` từ đó.

**4. Số test cộng dồn:** term 9 → 16 → 31 → 39 → 45; server 14 → 25; hook giữ nguyên 35.
