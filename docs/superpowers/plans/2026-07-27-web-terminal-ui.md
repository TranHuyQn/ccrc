# Web terminal — Kế hoạch 2: giao diện

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở `http://<ip-tailscale>:8730/` trên trình duyệt là thấy và gõ được vào đúng pane tmux đang chạy Claude Code, mượt trên cả máy tính lẫn điện thoại.

**Architecture:** Daemon phục vụ luôn trang tĩnh cùng origin với WebSocket. Trang dùng xterm.js **chỉ để hiển thị** — `disableStdin`, không nhận phím. Mọi input đi qua ô soạn kiểu chat và một thanh phím điều khiển.

**Spec:** `docs/superpowers/specs/2026-07-27-web-terminal-design.md` §4.3b, §5, §6

**Điều kiện:** Kế hoạch 1 đã xong (vé HMAC, hub, daemon, `/remote`, bind IP Tailscale).

## Global Constraints

- Node 22 ESM. Comments **tiếng Anh**; mọi chữ người dùng đọc **tiếng Việt**.
- **Ngoại lệ dependency, được spec §5.6 cho phép:** thêm `@xterm/xterm@^6.0.0` và `@xterm/addon-fit@^0.11.0` vào `term/` (phiên bản đã kiểm trên registry ngày 2026-07-27 — **không** dùng 5.x, API đã đổi). Đóng gói kèm, phục vụ từ daemon — **tuyệt đối không CDN**. Ngoài hai gói này, không thêm gì.
- Chạy test: `cd term && npm test`. **KHÔNG** `node --test test/` — hỏng trên Node v22.23.1.
- `server` và `hook` không được đổi số test.
- Test **không được rò** phiên tmux hay tiến trình daemon. **Không chạy `tmux kill-server`** — đã có lần làm kẹt socket dùng chung. Chỉ giết thứ mình tạo, theo tên, trong `finally`.
- **Không đụng trạng thái Tailscale thật.** Cấu hình serve đang rỗng và phải giữ rỗng.
- Test harness **không được giả định daemon đã khởi động** — dùng `waitListening` đã có. Một daemon chưa lên mà test vẫn xanh là lỗi đã xảy ra một lần rồi.
- Trang phục vụ qua **HTTP** trong tailnet. Cùng origin với WebSocket ⇒ không có vấn đề nội dung hỗn hợp. Không thêm TLS, không xin chứng chỉ (D2c).

## File Structure

| File | Trách nhiệm |
|---|---|
| `term/src/session-keys.js` | Sinh, giữ, kiểm `sessionKey`. Trong RAM, chết cùng daemon |
| `term/public/index.html` | Khung trang: vùng terminal, thanh phím, ô soạn |
| `term/public/term.js` | Nối WebSocket, hiển thị xterm, nối lại, gửi input |
| `term/public/term.css` | Bố cục, xử lý bàn phím ảo |
| `term/vendor/` | `xterm.js`, `xterm.css`, `addon-fit.js` sao từ node_modules lúc build |
| `term/bin/ccrc-term.js` | Thêm phục vụ file tĩnh + cấp `sessionKey` |

---

### Task 1: `sessionKey` — vé bootstrap một phiên trình duyệt

**Files:**
- Create: `term/src/session-keys.js`, `term/test/session-keys.test.js`
- Modify: `term/bin/ccrc-term.js`, `term/test/daemon.test.js`

**Interfaces:**
- Produces: `createSessionKeys() → {issue() → string, valid(key) → boolean, size() → number}`

**Vì sao cần:** trang terminal nằm trên origin của máy dev nên **không có token cá nhân**. Vé dùng một lần, 60 giây — đứt kết nối là không xin lại được. `sessionKey` tiếp quản sau khi vé làm xong việc (spec §4.3b).

**Đánh đổi đã ghi trong spec:** `sessionKey` **dùng lại được**, khác vé. Chấp nhận vì nó chỉ tồn tại trong tailnet, chết cùng daemon, và phương án thay thế là dán token cá nhân sang origin thứ hai — bí mật mạnh hơn, sống lâu hơn.

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/session-keys.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionKeys } from '../src/session-keys.js';

test('khoá cấp ra là hợp lệ', () => {
  const k = createSessionKeys();
  const key = k.issue();
  assert.equal(k.valid(key), true);
});

test('khoá đủ dài để không đoán được', () => {
  const key = createSessionKeys().issue();
  assert.ok(key.length >= 32, `khoá quá ngắn: ${key.length}`);
});

test('mỗi lần cấp một khoá khác nhau', () => {
  const k = createSessionKeys();
  assert.notEqual(k.issue(), k.issue());
});

test('khoá bịa bị từ chối', () => {
  const k = createSessionKeys();
  k.issue();
  for (const rac of ['', 'abc', null, undefined, 0, {}, 'a'.repeat(64)]) {
    assert.equal(k.valid(rac), false, `phải từ chối: ${JSON.stringify(rac)}`);
  }
});

test('khoá dùng lại được — KHÁC vé một lần, đây là chủ ý', () => {
  const k = createSessionKeys();
  const key = k.issue();
  assert.equal(k.valid(key), true);
  assert.equal(k.valid(key), true, 'sessionKey phải dùng lại được để nối lại sau khi đứt');
});
```

- [ ] **Step 2: Chạy để thấy ĐỎ**

```bash
cd term && npm test
```
Expected: FAIL — không tìm thấy `../src/session-keys.js`.

- [ ] **Step 3: Viết implementation**

Tạo `term/src/session-keys.js`:

```js
// Keys that let one browser reconnect without a fresh ticket.
//
// Unlike a ticket these are reusable, on purpose: the page that holds one has
// no personal token and cannot mint another. They live only in memory, so
// `/remote off` or a daemon restart invalidates every one of them — which is
// the property that makes reuse acceptable.

import crypto from 'node:crypto';

export function createSessionKeys() {
  /** @type {Set<string>} */
  const keys = new Set();

  return {
    issue() {
      const key = crypto.randomBytes(32).toString('base64url');
      keys.add(key);
      return key;
    },
    valid(key) {
      return typeof key === 'string' && key.length > 0 && keys.has(key);
    },
    size() { return keys.size; },
  };
}
```

- [ ] **Step 4: Đấu vào daemon**

Trong `term/bin/ccrc-term.js`: import `createSessionKeys`, tạo `const sessionKeys = createSessionKeys();`.

Trong handler `upgrade`, chấp nhận **một trong hai**: `?ticket=` (như cũ, cháy nonce) hoặc `?key=` (kiểm `sessionKeys.valid`). Vé sai **và** khoá sai ⇒ 401 như cũ.

Ngay sau khi WebSocket mở bằng **vé**, gửi cho client một khung điều khiển đầu tiên:

```js
ws.send(JSON.stringify({ type: 'ccrc_session', key: sessionKeys.issue() }));
```

Khung này là JSON một dòng, phân biệt với dữ liệu terminal (nhị phân/chuỗi thô) bằng cách gửi dưới dạng **text frame bắt đầu bằng `{`** — client thử `JSON.parse` dòng đầu tiên, thất bại thì coi là dữ liệu terminal.

Nối bằng `?key=` thì **không** cấp khoá mới.

- [ ] **Step 5: Thêm test daemon**

Vào `term/test/daemon.test.js`:

```js
test('nối bằng vé thì nhận được sessionKey', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(goodTicket()));
    assert.equal(c.ok, true);
    const key = await c.sessionKey();
    assert.ok(typeof key === 'string' && key.length >= 32, 'phải cấp sessionKey ngay sau khi vé được nhận');
    c.ws.close();
  } finally { d.stop(); }
});

test('nối lại bằng sessionKey KHÔNG cần vé mới', async () => {
  const d = await startDaemon();
  try {
    const a = await connect(d.url(goodTicket()));
    const key = await a.sessionKey();
    a.ws.close();
    const b = await connect(`ws://127.0.0.1:${d.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(b.ok, true, 'đây là toàn bộ lý do sessionKey tồn tại');
    b.ws.close();
  } finally { d.stop(); }
});

test('sessionKey bịa bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const r = await connect(`ws://127.0.0.1:${d.port}/attach?key=khong-phai-khoa-that-dau-nhe`);
    assert.equal(r.ok, false);
  } finally { d.stop(); }
});

test('khoá của daemon này KHÔNG dùng được cho daemon khác', async () => {
  const d1 = await startDaemon();
  const d2 = await startDaemon();
  try {
    const a = await connect(d1.url(goodTicket()));
    const key = await a.sessionKey();
    a.ws.close();
    const r = await connect(`ws://127.0.0.1:${d2.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(r.ok, false, 'khoá giữ trong RAM từng daemon, không được dùng chéo');
  } finally { d1.stop(); d2.stop(); }
});
```

Bổ sung helper `sessionKey()` vào `connect()`: đọc khung text đầu tiên, `JSON.parse`, trả `key`.

- [ ] **Step 6: Chạy XANH + mutation**

```bash
cd term && npm test
```

| Đột biến | Test phải đỏ |
|---|---|
| `valid()` luôn trả `true` | "sessionKey bịa bị từ chối" |
| Dùng chung một `Set` toàn cục cho mọi daemon | "khoá của daemon này KHÔNG dùng được cho daemon khác" |
| Không gửi khung `ccrc_session` | "nối bằng vé thì nhận được sessionKey" |

- [ ] **Step 7: Commit**

```bash
git add term/src/session-keys.js term/test/session-keys.test.js term/bin/ccrc-term.js term/test/daemon.test.js
git commit -m "Let a ticket bootstrap a reconnectable browser session"
```

---

### Task 2: Daemon phục vụ trang tĩnh, xterm.js đóng gói kèm

**Files:**
- Modify: `term/package.json`, `term/bin/ccrc-term.js`
- Create: `term/public/index.html`, `term/public/term.css`, `term/tools/vendor-xterm.mjs`
- Test: `term/test/static.test.js`

**Interfaces:**
- Produces: `GET /` → HTML; `GET /vendor/*`, `GET /term.js`, `GET /term.css` → file tĩnh

**Ràng buộc bảo mật:** chỉ phục vụ đúng những file trong `term/public` và `term/vendor`. Không được cho `..` thoát ra ngoài — có test riêng.

- [ ] **Step 1: Thêm dependency và script sao chép**

`term/package.json` thêm:

```json
"dependencies": {
  "ws": "^8.18.0",
  "@xterm/xterm": "^6.0.0",
  "@xterm/addon-fit": "^0.11.0"
},
"scripts": {
  "test": "node --test test/*.test.js",
  "vendor": "node tools/vendor-xterm.mjs"
}
```

Tạo `term/tools/vendor-xterm.mjs` sao `xterm.js`, `xterm.css`, `addon-fit.js` từ `node_modules` sang `term/vendor/`, tạo thư mục nếu chưa có, và in ra kích thước từng file.

Chạy `npm install` **ở gốc repo** (workspaces), rồi `cd term && npm run vendor`.

- [ ] **Step 2: Viết test đỏ**

Tạo `term/test/static.test.js`. Dùng `startDaemon` sẵn có từ `daemon.test.js` (tách ra `term/test/helpers.mjs` nếu cần):

```js
test('GET / trả về HTML', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /<div id="term"/);
  } finally { d.stop(); }
});

test('phục vụ được xterm.js đóng gói kèm', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/xterm.js`);
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers.get('content-length')) > 100000, 'phải là file xterm thật, không phải trang lỗi');
  } finally { d.stop(); }
});

test('KHÔNG thoát ra ngoài thư mục public bằng ..', async () => {
  const d = await startDaemon();
  try {
    for (const p of ['/../src/ticket.js', '/..%2fsrc%2fticket.js', '/vendor/../../src/ticket.js', '/%2e%2e/package.json']) {
      const r = await fetch(`http://127.0.0.1:${d.port}${p}`);
      assert.notEqual(r.status, 200, `đường dẫn phải bị chặn: ${p}`);
    }
  } finally { d.stop(); }
});

test('file không tồn tại trả 404, không lộ đường dẫn hệ thống', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/khong-co-dau.js`);
    assert.equal(r.status, 404);
    assert.ok(!(await r.text()).includes('/Volumes'), 'không được lộ đường dẫn tuyệt đối');
  } finally { d.stop(); }
});
```

- [ ] **Step 3: Chạy ĐỎ, rồi implement**

Trong `ccrc-term.js`, thay handler HTTP `404` hiện tại bằng phục vụ tĩnh: giải `path.normalize`, ghép vào thư mục gốc, rồi **kiểm kết quả vẫn nằm trong thư mục gốc** trước khi đọc (`resolved.startsWith(root + path.sep)`). Content-type theo đuôi file cho `.html`, `.js`, `.css`. Mọi thứ khác 404 với thân rỗng.

Tạo `term/public/index.html` — khung tối giản:

```html
<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Terminal</title>
<link rel="stylesheet" href="/vendor/xterm.css">
<link rel="stylesheet" href="/term.css">
</head>
<body>
<div id="trangthai" class="dim">đang nối…</div>
<div id="term"></div>
<div id="phim">
  <button data-seq="\\x1b">Esc</button>
  <button data-seq="\\x1b[A">↑</button>
  <button data-seq="\\x1b[B">↓</button>
  <button data-seq="\\r">⏎</button>
  <button data-seq="\\t">Tab</button>
  <button data-seq="\\x03">^C</button>
</div>
<form id="soan">
  <textarea id="oto" rows="1" autocapitalize="none" autocorrect="off"
            autocomplete="off" spellcheck="false" enterkeyhint="send"
            placeholder="Nhắn cho Claude…"></textarea>
  <button type="submit">Gửi</button>
</form>
<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script src="/term.js"></script>
</body>
</html>
```

- [ ] **Step 4: XANH + mutation**

Đột biến: bỏ kiểm `startsWith(root)` ⇒ test `..` phải đỏ.

- [ ] **Step 5: Commit**

```bash
git add term/package.json term/tools/vendor-xterm.mjs term/public term/vendor term/bin/ccrc-term.js term/test/static.test.js package-lock.json
git commit -m "Serve the terminal page and a bundled xterm from the daemon"
```

---

### Task 3: Trang terminal — hiển thị và nối lại

**Files:**
- Create: `term/public/term.js`
- Test: `term/test/term-page.test.js` (chạy `term.js` trong `node:vm` với DOM giả)

**Interfaces:**
- Consumes: `sessionKey` (Task 1), file tĩnh (Task 2)

**Nguyên tắc cốt lõi (spec §5.1):** khởi tạo xterm với `disableStdin: true` và vô hiệu hoá `.xterm-helper-textarea`. Terminal **chỉ hiển thị**, không bao giờ giành focus, không bao giờ tự bật bàn phím. Có test riêng.

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/term-page.test.js`. Nạp `term.js` bằng `node:vm` với `Terminal`, `FitAddon`, `WebSocket`, `document`, `location`, `sessionStorage` giả. Kiểm:

```js
test('xterm khởi tạo với disableStdin — terminal không nhận phím', () => { … });
test('đọc vé từ fragment URL rồi xoá khỏi thanh địa chỉ', () => { … });
test('lưu sessionKey vào sessionStorage khi nhận khung ccrc_session', () => { … });
test('nối lại dùng key, KHÔNG dùng lại vé đã cháy', () => { … });
test('đứt kết nối thì backoff tăng dần, tối đa 30s', () => { … });
test('quay lại từ nền (visibilitychange) nối lại NGAY, bỏ backoff', () => { … });
test('hiện "đang nối lại…" chứ không im lặng', () => { … });
test('khung ccrc_session KHÔNG được vẽ ra terminal như dữ liệu', () => { … });
```

Test cuối quan trọng: khung điều khiển JSON lọt vào màn hình terminal là lỗi nhìn thấy được ngay.

- [ ] **Step 2: ĐỎ → implement `term.js`**

Nội dung chính:
- Đọc `#t=<vé>` từ `location.hash`, **xoá hash ngay** (`history.replaceState`) để vé không nằm lại trong thanh địa chỉ hay lịch sử.
- Nối `ws://<host>/attach?ticket=…`; nếu `sessionStorage` đã có key thì ưu tiên `?key=…`.
- Khung text đầu tiên: thử `JSON.parse`; nếu là `{type:'ccrc_session'}` thì lưu key và **không** ghi ra terminal.
- Mọi dữ liệu khác: `term.write(data)`.
- `ws.onclose` → backoff 1s, 2s, 4s… trần 30s; `visibilitychange` khi trở lại → nối ngay.
- Cập nhật `#trangthai` ở mọi chuyển trạng thái.

- [ ] **Step 3: XANH + mutation**

| Đột biến | Test phải đỏ |
|---|---|
| Bỏ `disableStdin` | "terminal không nhận phím" |
| Không xoá hash | "xoá khỏi thanh địa chỉ" |
| Ghi thẳng khung JSON ra terminal | "KHÔNG được vẽ ra terminal" |

- [ ] **Step 4: Commit**

```bash
git add term/public/term.js term/test/term-page.test.js
git commit -m "Show the pane and reconnect without re-using a spent ticket"
```

---

### Task 4: Ô soạn, thanh phím, bracketed paste, bàn phím ảo

**Files:**
- Modify: `term/public/term.js`, `term/public/term.css`
- Test: `term/test/term-input.test.js`

**Ba thứ phải đúng, mỗi thứ một test:**

1. **Bracketed paste.** Gửi thô thì mỗi xuống dòng thành một Enter và **gửi câu trả lời dở dang** cho Claude. Phải bọc `ESC[200~ … ESC[201~` rồi mới `\r`.
2. **Ô soạn giữ IME.** Chỉ tắt `autocapitalize`/`autocorrect`/`spellcheck` — không dùng mẹo `type="password"`, vì nó giết tiếng Việt có dấu (D4).
3. **Bàn phím ảo hai nhánh.** `virtualKeyboard` nếu có (Android), `visualViewport` nếu không (iOS). Feature-detect, không sniff user-agent.

- [ ] **Step 1: Viết test đỏ**

```js
test('gửi nhiều dòng bọc trong bracketed paste, không thành nhiều Enter', () => {
  const sent = gui.submit('dòng một\ndòng hai');
  assert.equal(sent, '\x1b[200~dòng một\ndòng hai\x1b[201~\r');
});

test('ô soạn được xoá sau khi gửi', () => { … });
test('gửi chuỗi rỗng thì không gửi gì cả', () => { … });
test('Enter trong ô soạn xuống dòng, KHÔNG gửi', () => { … });
test('mỗi nút thanh phím gửi đúng chuỗi thoát', () => {
  assert.equal(gui.press('Esc'), '\x1b');
  assert.equal(gui.press('↑'), '\x1b[A');
  assert.equal(gui.press('^C'), '\x03');
});
test('Android: dùng VirtualKeyboard API khi có', () => { … });
test('iOS: lùi về visualViewport khi không có VirtualKeyboard', () => { … });
test('đổi kích thước thì báo cols/rows xuống daemon', () => { … });
```

- [ ] **Step 2: ĐỎ → implement**

- [ ] **Step 3: XANH + mutation**

| Đột biến | Test phải đỏ |
|---|---|
| Bỏ bọc bracketed paste | "không thành nhiều Enter" |
| Enter trong ô soạn gửi luôn | "Enter xuống dòng, KHÔNG gửi" |
| Chỉ dùng `visualViewport`, bỏ nhánh Android | "Android: dùng VirtualKeyboard API" |

- [ ] **Step 4: Commit**

---

### Task 5: Phiên nhóm tmux — điện thoại không làm co màn hình máy tính

**Files:**
- Modify: `term/src/tmux.js`, `term/bin/ccrc-term.js`
- Test: `term/test/tmux.test.js`

**Vấn đề (spec §5.5):** tmux đặt kích thước cửa sổ theo client **nhỏ nhất đang xem**. Trình duyệt attach thẳng vào phiên đang mở trên máy tính sẽ làm màn hình máy tính **co còn ~40 cột**.

**Đã đo (Bước 0, Đo 1 — ĐẠT):** `tmux new-session -t <phiên>` tạo phiên nhóm dùng chung cửa sổ nhưng kích thước độc lập. Phiên gốc giữ nguyên 200x50 khi client 40 cột nối vào.

- [ ] **Step 1: Test đỏ**

```js
test('client nối vào KHÔNG làm co phiên gốc', () => {
  // dựng phiên 200x50, tạo phiên nhóm 40x30, kiểm phiên gốc vẫn 200x50
});
test('phiên nhóm bị dọn khi client rời đi', () => { … });
```

- [ ] **Step 2–4: implement, XANH, mutation, commit**

Daemon tạo phiên nhóm khi có client đầu tiên, đặt `aggressive-resize on`, và `kill-session` phiên nhóm khi client cuối rời đi.

---

### Task 6: Thẻ terminal trong PWA

**Files:**
- Modify: `server/public/app.js`, `server/public/index.html`, `server/public/style.css`
- Test: `server/test/notify-api.test.js` (không đổi số test hiện có)

PWA gọi `GET /api/terminal`; có phiên thì hiện thẻ **"Terminal đang mở · \<máy\>"**. Bấm → gọi `POST /api/terminal/ticket` → điều hướng sang `<url>#t=<vé>`.

**Lưu ý:** điều hướng từ https sang http là **điều hướng cấp trang**, được phép. Không phải nhúng, nên không dính nội dung hỗn hợp.

Thẻ phải nói rõ khi `alive: false`: *"máy không phản hồi — có thể đã ngủ"*.

---

### Task 7: Nghiệm thu bằng trình duyệt trên máy tính

**Files:** không sửa file nào — chỉ kiểm chứng. Ghi kết quả vào `docs/superpowers/specs/2026-07-27-nghiem-thu-trinh-duyet.md`.

Chạy thật: mở tmux, chạy Claude Code trong đó, `/remote on`, mở URL bằng Chrome trên máy này.

| Kiểm | Kỳ vọng |
|---|---|
| Trang mở được, thấy nội dung pane | Đúng màn hình đang có trong tmux |
| Gõ tiếng Việt có dấu rồi Gửi | Tới Claude nguyên vẹn, đủ dấu |
| Gửi đoạn nhiều dòng | Vào nguyên khối, **không** bị cắt thành nhiều lần Enter |
| `Esc` | Ngắt được Claude đang chạy |
| `↑` `↓` `⏎` | Chọn được phương án trong AskUserQuestion |
| Đóng tab rồi mở lại | Tự nối lại bằng `sessionKey`, thấy đúng chỗ cũ |
| Ngắt mạng ~30s rồi bật lại | Tự nối lại, có hiện "đang nối lại…" |
| **Màn hình tmux trên máy KHÔNG co** | Giữ nguyên kích thước |
| `/remote off` | Trang báo phiên đã đóng |
| Vé trong URL | Đã bị xoá khỏi thanh địa chỉ |

## Self-Review

**Spec coverage:** §4.3b → Task 1; §5.1, §5.6 → Task 3; §5.2, §5.3, §5.4 → Task 4; §5.5 → Task 5; §6 → Task 3; §7 → Task 3, 6; §8 tầng 3 → Task 7 (máy tính) + điện thoại do Huy chạy.

**Chưa phủ, có chủ ý:** nghiệm thu trên iPhone và Android thật — Huy chạy sau cùng. Đo 4 (độ ổn định qua nhiều giờ) cần điện thoại.

**Placeholder:** Task 3 và 4 mô tả test bằng tên thay vì code đầy đủ, vì chúng phụ thuộc khuôn DOM giả sẽ dựng ở Task 3 Step 1. Người làm Task 3 dựng khuôn trước, Task 4 dùng lại. Đây là phụ thuộc thật giữa hai task, không phải chỗ trống bỏ ngỏ.
