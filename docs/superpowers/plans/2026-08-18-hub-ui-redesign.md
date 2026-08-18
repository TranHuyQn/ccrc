# Làm lại giao diện hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa công tắc thông báo và danh sách terminal lên màn hình đầu, dồn mọi thứ còn lại vào một trang Cài đặt, và thay bảng màu bằng bảng dịu mắt hơn có chế độ sáng.

**Architecture:** `server/public` là ba file phẳng, không bundler: `index.html` + `style.css` + `app.js` (script cổ điển, không module). Kế hoạch này viết lại markup và CSS, còn `app.js` chỉ sửa đúng hai loại chỗ: nơi dựng DOM và nơi chuyển màn hình. Toàn bộ logic mạng, ký vé, bfcache, kéo-xuống-nạp-lại giữ nguyên. Test chạy `app.js` thật trong `node:vm` với một DOM giả (`server/test/dom-harness.mjs`), nên mọi thay đổi cấu trúc DOM đều phải kèm cập nhật harness.

**Tech Stack:** HTML/CSS/JS thuần, không framework, không build step. Test: `node:test` + `node:vm` + fake DOM tự viết.

**Spec:** `docs/superpowers/specs/2026-08-18-hub-ui-redesign-design.md`

## Global Constraints

- Thư mục làm việc: worktree `.worktrees/hub-ui`, nhánh `feat/hub-ui-redesign`.
- Phạm vi sửa: **chỉ** `server/public/*` và `server/test/*`. Không đụng `term/`, `hook/`, `server/src/`, `sw.js`, `manifest.webmanifest`.
- Chạy test: `cd server && npm test`. Mọi task phải kết thúc với bảng test **xanh hoàn toàn**.
- Ngôn ngữ giao diện: tiếng Việt. Commit message: tiếng Anh.
- Tên biến CSS cũ phải giữ nguyên: `--bg --card --border --text --dim --accent --err --mono`.
- Mọi id đang có trong `index.html` chỉ được xoá khi `app.js` cũng thôi tham chiếu tới nó, và ngược lại — `server/test/app-markup.test.js` canh cả hai chiều.
- **Bump `?v=` của `app.js` và `style.css` trong `index.html` mỗi lần đụng vào hai file đó.** Hiện tại là `?v=14`. Cloudflare đè `no-cache` của hub bằng TTL 4 giờ cho `.js`/`.css`; `?v=` mới là thứ duy nhất tới được trình duyệt đã mở trang.
- Không dùng `innerHTML` cho bất cứ dữ liệu nào đến từ hub hay từ máy dev — chỉ `textContent`.
- Vùng bấm nhỏ nhất 44×44 cho mọi nút biểu tượng.
- **Không truyền `token` vào `loadAppPage()` trong test mới.** Có token trong
  `localStorage` là `app.js` tự chạy `showMain()` ngay lúc nạp; nó gọi `/api/me`,
  gặp 404 của fetch giả rồi rơi vào `logout()` — mà `logout()` ẩn `#main`. Test
  sẽ chạy đua với một luồng không liên quan gì đến thứ nó đang kiểm.
  `server/test/app-terminal.test.js` đã ghi rõ quy ước này; theo đúng nó.

---

### Task 1: Bảng màu mới (bản tối) và kiểu thẻ/nút

Đổi bảng màu và kiểu dáng trước, khi markup còn nguyên — để nhìn thấy ngay bảng màu trên trang thật mà chưa phải động vào một dòng JS nào. Kèm một test mới canh chuyện "dùng biến chưa định nghĩa", vốn là loại lỗi CSS không ai thấy cho tới khi nó hiện ra màu đen trên nền đen.

**Files:**
- Modify: `server/public/style.css` (viết lại phần biến và phần thành phần; giữ nguyên phần chống zoom, safe-area, `#ptr`, `.sas`)
- Modify: `server/public/index.html:26` và `:107` (bump `?v=14` → `?v=15`)
- Create: `server/test/style-tokens.test.js`

**Interfaces:**
- Consumes: không có.
- Produces: các biến CSS mà Task 2–6 sẽ dùng — `--bg`, `--card`, `--surface-2`, `--border`, `--text`, `--dim`, `--accent`, `--accent-soft`, `--on-accent`, `--err`, `--mono`. Các class mới: `.icon-btn`, `.btn-soft`, `.terminal-meta`, `.terminal-note`, `.switch`, `.field-label`.

- [ ] **Step 1: Viết test canh "biến CSS dùng mà chưa định nghĩa"**

Tạo `server/test/style-tokens.test.js`:

```js
// Một biến CSS gõ sai tên không báo lỗi ở đâu cả: trình duyệt lặng lẽ bỏ qua
// khai báo đó và phần tử rơi về màu kế thừa — thường là chữ đen trên nền đen.
// Không có gì trong repo bắt được chuyện này, nên file này làm việc đó: mọi
// var(--x) được dùng đều phải có một khai báo --x ở đâu đó trong cùng file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CSS = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

const dungTrongVar = () =>
  new Set(Array.from(CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/g), (m) => m[1]));
const daKhaiBao = () =>
  new Set(Array.from(CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (m) => m[1]));

test('mọi var(--x) trong style.css đều có khai báo --x', () => {
  const khaiBao = daKhaiBao();
  const thieu = [...dungTrongVar()].filter((v) => !khaiBao.has(v)).sort();
  assert.deepEqual(thieu, [], `style.css dùng biến chưa khai báo: ${thieu.join(', ')}`);
});

test('bảng màu tối khai báo đủ bộ biến bắt buộc', () => {
  const khaiBao = daKhaiBao();
  const batBuoc = ['--bg', '--card', '--surface-2', '--border', '--text',
    '--dim', '--accent', '--accent-soft', '--on-accent', '--err', '--mono'];
  const thieu = batBuoc.filter((v) => !khaiBao.has(v));
  assert.deepEqual(thieu, [], `thiếu biến: ${thieu.join(', ')}`);
});
```

- [ ] **Step 2: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/style-tokens.test.js`
Expected: FAIL — `thiếu biến: --surface-2, --accent-soft, --on-accent`

- [ ] **Step 3: Viết lại phần đầu `style.css`**

Thay khối `:root { … }` hiện tại bằng:

```css
:root {
  /* Bảng "Đất nung", bản tối. Tên biến giữ nguyên như bản cũ để không file nào
     khác phải đổi theo; ba biến cuối là biến mới. */
  --bg: #101318; --card: #191d24; --surface-2: #242932; --border: #262b34;
  --text: #edeff2; --dim: #98a1b0;
  --accent: #e0805f; --accent-soft: rgba(224, 119, 87, .16); --on-accent: #1a0e08;
  --err: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- [ ] **Step 4: Đổi kiểu thẻ, nút, tiêu đề trong `style.css`**

Thay các quy tắc `h1`, `h2`, `.card`, `button`, `button.ghost`, `input`, `code`,
`.terminal-card` hiện có bằng:

```css
h1 { font-size: 19px; font-weight: 650; letter-spacing: -.01em; margin: 0; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
  color: var(--dim); margin: 18px 2px 8px; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 14px;
  padding: 14px; margin-bottom: 10px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }

/* Nút chính. 46px là chiều cao mà ngón cái bấm được mà không phải nhìn — đây là
   nút được bấm nhiều nhất trong cả app. */
button { width: 100%; min-height: 46px; padding: 13px; background: var(--accent);
  color: var(--on-accent); border: 0; border-radius: 11px; font-size: 15px;
  font-weight: 600; cursor: pointer; }
button:active { filter: brightness(.94); }
button.ghost { width: auto; min-height: 0; background: transparent; color: var(--dim);
  border: 1px solid var(--border); padding: 8px 12px; font-size: 13px; font-weight: 500; }
/* Nút phụ: cùng hình dáng nút chính nhưng nền nhạt — dùng cho việc có thật
   nhưng không phải việc người ta vào đây để làm. */
button.btn-soft { background: var(--accent-soft); color: var(--accent); }
/* Nút biểu tượng ở header. 44×44 là vùng bấm nhỏ nhất còn bấm trúng được. */
button.icon-btn { width: 44px; height: 44px; min-height: 44px; padding: 0;
  border-radius: 50%; background: var(--surface-2); color: var(--dim);
  font-size: 17px; font-weight: 400; }

input { width: 100%; min-height: 46px; padding: 13px; margin: 10px 0;
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 11px; font-family: var(--mono); font-size: 15px; }
code { font-family: var(--mono); background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }

.terminal-card button { margin-top: 12px; }
.terminal-card button:disabled { opacity: .6; cursor: default; }
```

Cập nhật `header` cho hai màn hình dùng chung:

```css
header { display: flex; justify-content: space-between; align-items: center;
  gap: 10px; margin-bottom: 16px; }
```

Trong `#ptr`, đổi `background: var(--card)` giữ nguyên — không cần sửa.

- [ ] **Step 5: Đổi quầng chấm chưa đọc sang biến mới**

Thay quy tắc `.unread-dot` hiện có:

```css
.unread-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
```

- [ ] **Step 6: Bump `?v=`**

Trong `server/public/index.html`, đổi `style.css?v=14` → `style.css?v=15` và
`app.js?v=14` → `app.js?v=15`.

- [ ] **Step 7: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ, gồm cả `style-tokens.test.js` và `app-markup.test.js`.

- [ ] **Step 8: Commit**

```bash
git add server/public/style.css server/public/index.html server/test/style-tokens.test.js
git commit -m "style: warmer, calmer palette and a bigger primary button

The palette keeps the old variable names so nothing else has to change, and
adds the three the new design needs. A new test refuses a var(--x) that no
rule ever declares — CSS fails that silently, as black text on black."
```

---

### Task 2: Màn hình Cài đặt và nút Back

**Files:**
- Modify: `server/public/index.html` (tách `#settings`, bỏ hai nút gập)
- Modify: `server/public/app.js` (bỏ hai handler gập, thêm chuyển màn hình)
- Modify: `server/test/dom-harness.mjs` (`REQUIRED_IDS`, `BUTTON_IDS`, `history.pushState/back`, `popstate`)
- Modify: `server/test/app-devices.test.js`, `server/test/app-login.test.js`
- Create: `server/test/app-settings.test.js`

**Interfaces:**
- Consumes: các class từ Task 1 (`.icon-btn`, `.card`, `.row`).
- Produces: `openSettings()`, `closeSettings()` (không tham số, không trả về) làm global trong sandbox; id `settings`, `settings-open`, `settings-close`; `loadAppPage()` trả thêm `pushCalls` (mảng `{state, title, url}`).

- [ ] **Step 1: Mở rộng harness — `pushState`, `back`, `popstate`**

Trong `server/test/dom-harness.mjs`, thay khối `const history = { … }` bằng:

```js
  const replaceCalls = [];
  const pushCalls = [];
  // Một chồng lịch sử tí hon. back() bắn 'popstate' trên window đúng như trình
  // duyệt, vì đó chính là thứ nút Back của điện thoại tiêu thụ — không có nó,
  // test không chứng minh được trang Cài đặt đóng lại bằng cử chỉ vuốt cạnh.
  const stack = [];
  const history = {
    replaceState(state, title, url) {
      replaceCalls.push({ state, title, url });
      location.search = '';
    },
    pushState(state, title, url) {
      pushCalls.push({ state, title, url });
      stack.push(state);
    },
    back() {
      if (!stack.length) return;
      stack.pop();
      window_.dispatch('popstate', { state: stack[stack.length - 1] ?? null });
    },
  };
```

Và thêm `pushCalls` vào object `return` cuối `loadAppPage()`.

- [ ] **Step 2: Cập nhật `REQUIRED_IDS` và `BUTTON_IDS`**

Trong `dom-harness.mjs`, sửa `REQUIRED_IDS`: bỏ `'approve-toggle'`, `'approve-body'`,
`'devices-toggle'`; thêm `'settings'`, `'settings-open'`, `'settings-close'`.
Dòng thiết bị và duyệt máy trở thành:

```js
  'approve-code', 'approve-btn', 'approve-msg', 'approve-err',
  'terminal-list', 'terminal-err', 'terminal-empty',
  'devices-wrap', 'devices', 'devices-err',
  'settings', 'settings-open', 'settings-close',
```

Trong `loadAppPage()`, sửa `BUTTON_IDS`: bỏ `'devices-toggle'`, `'approve-toggle'`;
thêm `'settings-open'`, `'settings-close'`.

- [ ] **Step 3: Viết test cho màn hình Cài đặt**

Tạo `server/test/app-settings.test.js`:

```js
// Trang Cài đặt là màn hình thứ hai trong cùng một file HTML. Hai chuyện phải
// đúng và không có gì khác bắt được: nó dùng pushState chứ không replaceState
// (replaceState làm nút Back rời khỏi trang, đúng cái người dùng không định
// làm), và nó KHÔNG đổi đường dẫn (vì /link dùng chung file này).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const moCaiDat = (page) => page.byId['settings-open'].onclick();

test('bấm ⚙ thì hiện Cài đặt, ẩn danh sách', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  assert.equal(page.byId.settings.classList.contains('hidden'), false);
  assert.equal(page.byId.main.classList.contains('hidden'), true);
});

test('mở Cài đặt đẩy một mục vào lịch sử, và KHÔNG đổi đường dẫn', () => {
  const page = loadAppPage({});
  moCaiDat(page);
  assert.equal(page.pushCalls.length, 1, 'phải pushState — replaceState làm Back rời khỏi trang');
  assert.equal(page.pushCalls[0].url, '/', 'không được đổi đường dẫn: /link dùng chung file này');
});

test('nút Back của điện thoại đóng Cài đặt, quay về danh sách', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  page.window.dispatch('popstate', { state: null });
  assert.equal(page.byId.settings.classList.contains('hidden'), true);
  assert.equal(page.byId.main.classList.contains('hidden'), false);
});

test('nút ‹ đóng bằng đường history.back(), không tự ẩn tay', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  page.byId['settings-close'].onclick();
  assert.equal(page.byId.settings.classList.contains('hidden'), true,
    'back() phải bắn popstate và popstate mới là chỗ đóng — một đường duy nhất');
  assert.equal(page.byId.main.classList.contains('hidden'), false);
});

test('bấm ⚙ hai lần không đẩy hai mục vào lịch sử', () => {
  const page = loadAppPage({});
  moCaiDat(page);
  moCaiDat(page);
  assert.equal(page.pushCalls.length, 1, 'hai mục thì phải bấm Back hai lần mới ra — bẫy quen thuộc');
});
```

- [ ] **Step 4: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/app-settings.test.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'onclick')`, vì `settings-open` chưa có trong markup lẫn `app.js`.

- [ ] **Step 5: Tách `index.html` thành hai màn hình**

Thay toàn bộ khối `<div id="main"> … </div>` hiện tại bằng:

```html
<div id="main" class="hidden">
  <header>
    <h1>Terminal</h1>
    <button id="settings-open" class="icon-btn" aria-label="Cài đặt">⚙</button>
  </header>

  <div class="card">
    <div class="row">
      <span>Thông báo đẩy</span>
      <span id="push-state" class="dim small">đang kiểm tra…</span>
    </div>
    <button id="enable-push">Bật thông báo trên thiết bị này</button>
  </div>

  <div id="pair-panel" class="card hidden">
    <div class="row" id="pair-title">Ghép máy này</div>
    <p class="dim small" id="pair-step">Đang chờ máy dev…</p>
    <p id="pair-sas" class="sas"></p>
    <p class="dim small" id="pair-help">Khi có số, chạy trên máy dev: <code>/remote pair xac-nhan &lt;số&gt;</code></p>
    <button id="pair-cancel" class="ghost">Huỷ</button>
    <p id="pair-err" class="err hidden"></p>
  </div>

  <div id="terminal-list" class="hidden"></div>
  <p id="terminal-empty" class="dim small hidden">Chưa có terminal nào đang mở. Gõ <code>/remote on</code> trên máy để bật.</p>
  <p id="terminal-err" class="err hidden"></p>
</div>

<!-- Màn hình thứ hai trong CÙNG một file, không phải route mới: /link dùng
     chung file này và showLink() rẽ nhánh trên location.pathname, nên đổi path
     là làm nó hiểu sai màn hình. -->
<div id="settings" class="hidden">
  <header>
    <button id="settings-close" class="icon-btn" aria-label="Quay lại">‹</button>
    <h1>Cài đặt</h1>
    <span class="icon-btn" style="visibility:hidden" aria-hidden="true"></span>
  </header>

  <div class="card">
    <div class="row">
      <span id="who"></span>
      <button id="logout" class="ghost">Đăng xuất</button>
    </div>
  </div>

  <h2>Thiết bị nhận thông báo</h2>
  <div id="devices-wrap" class="card hidden">
    <div id="devices"></div>
    <p id="devices-err" class="err small hidden"></p>
  </div>

  <h2>Duyệt máy dev</h2>
  <div class="card">
    <p class="dim small">Nhập mã đang hiện trên terminal của máy dev.</p>
    <input id="approve-code" type="text" placeholder="XXXX-XXXX" autocomplete="off"
           autocapitalize="characters" spellcheck="false">
    <button id="approve-btn">Duyệt</button>
    <p id="approve-msg" class="dim hidden"></p>
    <p id="approve-err" class="err hidden"></p>
  </div>
</div>
```

Xoá luôn khối chú thích dài phía trên thẻ "Duyệt máy dev" cũ — lý do nó tồn tại
(người cài PWA không gõ được URL `/link`) vẫn đúng, nên chép lại một câu ngắn
ngay trên `<h2>Duyệt máy dev</h2>`:

```html
  <!-- Lối vào DUY NHẤT của người đã cài PWA: app standalone không có thanh địa
       chỉ để gõ /link, và iOS không deep-link vào web app đã cài. -->
```

- [ ] **Step 6: Bỏ hai handler gập trong `app.js`**

Xoá nguyên khối dòng 111–120 (`let approveOpen = false;` cho tới hết
`$('approve-toggle').onclick = …`).

Xoá nguyên khối dòng 758–763 (`$('devices-toggle').onclick = …`).

Trong `refreshDevices()` (dòng 603), xoá dòng `if (!devicesOpen) return;` và xoá
khai báo `let devicesOpen = false;` ở dòng 601.

Trong `refreshPushState()`, xoá dòng cuối `await refreshDevices();` — danh sách
thiết bị giờ nạp khi mở Cài đặt, không phải mỗi lần trạng thái push đổi. Giữ
nguyên hai dòng `$('devices-wrap').classList.add/remove('hidden')`.

- [ ] **Step 7: Thêm chuyển màn hình vào `app.js`**

Chèn ngay trước dòng `$('pair-cancel').onclick = () => cancelPairing();` ở cuối file:

```js
// --- Màn hình Cài đặt -------------------------------------------------------
//
// pushState chứ KHÔNG replaceState: mục được thêm vào lịch sử chính là thứ nút
// Back của điện thoại tiêu thụ để đóng trang này. replaceState sẽ làm Back rời
// khỏi trang — đúng cái người dùng không định làm.
//
// URL giữ nguyên `location.pathname`. /link dùng chung file này và showLink()
// rẽ nhánh trên đúng giá trị đó.
let settingsOpen = false;

function openSettings() {
  if (settingsOpen) return;   // bấm hai lần thì phải Back hai lần mới ra
  settingsOpen = true;
  history.pushState({ ccrc: 'settings' }, '', location.pathname);
  $('main').classList.add('hidden');
  $('settings').classList.remove('hidden');
  refreshDevices();
}

// Chỉ ĐÓNG, không đụng lịch sử — nó được gọi TỪ popstate. Nút ‹ gọi
// history.back() để cả hai đường đóng đều đi qua đúng một chỗ này.
function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  $('settings').classList.add('hidden');
  $('main').classList.remove('hidden');
}

$('settings-open').onclick = () => openSettings();
$('settings-close').onclick = () => history.back();
window.addEventListener('popstate', () => closeSettings());
```

- [ ] **Step 8: Đóng Cài đặt khi một thông báo được bấm**

Trong `consumePendingOpen(sessions)`, ngay sau dòng bảo vệ `if (!pendingOpen) return;`,
chèn:

```js
  // Bấm thông báo trong lúc đang ở Cài đặt: điều hướng thẳng đi từ một màn hình
  // không liên quan là chuyện khó hiểu. Đóng trước, rồi mới mở phiên.
  if (settingsOpen) history.back();
```

- [ ] **Step 9: Chạy test Cài đặt, xác nhận XANH**

Run: `cd server && node --test test/app-settings.test.js`
Expected: PASS cả 5 test.

- [ ] **Step 10: Sửa test cũ đang bấm hai nút gập đã bỏ**

Trong `server/test/app-devices.test.js`:
- Trong `openDevices()`, thay `await page.byId['devices-toggle'].onclick();` bằng
  `await page.context.refreshDevices();`
- Trong test `'hub lỗi → báo rõ, KHÔNG xoá trắng danh sách đang hiện'`, thay
  `await page.byId['devices-toggle'].onclick();` bằng `await page.context.refreshDevices();`
- Đổi tên test `'bấm Xem thì hiện danh sách, mỗi thiết bị một dòng'` thành
  `'danh sách thiết bị: mỗi thiết bị một dòng'` và xoá dòng
  `assert.equal(page.byId['devices-toggle'].textContent, 'Ẩn');`
- **Xoá hẳn** test `'bấm Ẩn thì đóng lại và không gọi hub nữa'` — nó kiểm hành vi
  gập/mở, mà hành vi đó không còn tồn tại. Đừng nới lỏng nó thành assertion vô nghĩa.

Trong `server/test/app-login.test.js`:
- **Xoá hẳn** test `'thẻ duyệt trong app: bấm Mở thì bung ra, đổi nhãn, và đưa con trỏ vào ô nhập'`.
- Trong `seedApproveCollapsed()`, xoá dòng `page.byId['approve-body'].classList.add('hidden');`
  và đổi tên hàm thành `seedApprove()`; cập nhật mọi chỗ gọi.

- [ ] **Step 11: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ. `app-markup.test.js` phải xanh — nó là thứ chứng minh
`REQUIRED_IDS`, `index.html` và `$()` trong `app.js` đã khớp lại với nhau.

- [ ] **Step 12: Commit**

```bash
git add server/public/index.html server/public/app.js server/test/
git commit -m "feat: move everything but the switch and the list behind a settings screen

The terminal list is why the app gets opened, and it used to sit below two
cards of setup. Settings is a second screen in the same file — pushState, not
replaceState, so the phone's Back button closes it instead of leaving the page.
Drops the two fold buttons: reaching this screen is already the deliberate act
they were guarding."
```

---

### Task 3: Ghi chú iPhone chỉ hiện khi mở bằng trình duyệt

**Files:**
- Modify: `server/public/index.html` (thêm `#pwa-note` vào `#settings`, gỡ ghi chú khỏi thẻ thông báo)
- Modify: `server/public/app.js` (dò PWA)
- Modify: `server/public/style.css` (kiểu `.note`)
- Modify: `server/test/dom-harness.mjs` (`window.matchMedia` giả, `REQUIRED_IDS`)
- Create: `server/test/app-pwa-note.test.js`

**Interfaces:**
- Consumes: `#settings` từ Task 2.
- Produces: id `pwa-note`; `loadAppPage({ media })` nhận map `{ '<truy vấn>': boolean }`; `navigatorImpl.standalone` được đọc.

- [ ] **Step 1: Thêm `matchMedia` giả vào harness**

Trong `dom-harness.mjs`, thêm `media = {}` vào tham số của `loadAppPage({...})`, rồi
ngay sau `const window_ = new FakeWindow();` chèn:

```js
  // matchMedia thật trả về một MediaQueryList có addEventListener. app.js dùng
  // nó cho hai việc khác hẳn nhau — dò PWA đã cài, và nghe hệ thống đổi
  // sáng/tối — nên cái giả này phải nhận truy vấn nào cũng được, mặc định
  // `matches: false`, chứ không cứng hoá một truy vấn cụ thể.
  // `media: null` = trình duyệt KHÔNG có matchMedia. Cần một cách nói điều đó,
  // vì gán undefined sau khi trang đã nạp thì muộn — dò PWA và áp theme đều
  // chạy đúng một lần, lúc nạp.
  window_.mediaListeners = [];
  if (media) {
    window_.matchMedia = (query) => ({
      media: query,
      matches: !!media[query],
      addEventListener: (type, fn) => window_.mediaListeners.push({ query, type, fn }),
      addListener: (fn) => window_.mediaListeners.push({ query, type: 'change', fn }),
    });
  }
```

- [ ] **Step 2: Thêm `pwa-note` vào `REQUIRED_IDS`**

Trong `dom-harness.mjs`, thêm `'pwa-note'` vào mảng `REQUIRED_IDS`.

- [ ] **Step 3: Viết test**

Tạo `server/test/app-pwa-note.test.js`:

```js
// Ghi chú "thêm vào màn hình chính rồi mở từ đó" chỉ có nghĩa với người đang
// đứng ngoài PWA. Người đã cài rồi mà vẫn bị nhắc thì hoặc là họ tưởng mình
// làm sai, hoặc họ học được rằng ghi chú trong app này không đáng đọc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const an = (page) => page.byId['pwa-note'].classList.contains('hidden');

test('mở bằng trình duyệt thường: ghi chú HIỆN', () => {
  const page = loadAppPage({});
  assert.equal(an(page), false);
});

test('mở từ PWA đã cài (display-mode: standalone): ghi chú ẨN', () => {
  const page = loadAppPage({ media: { '(display-mode: standalone)': true } });
  assert.equal(an(page), true);
});

test('iOS không hỗ trợ display-mode — navigator.standalone là đường thứ hai', () => {
  const page = loadAppPage({ navigatorImpl: { standalone: true } });
  assert.equal(an(page), true, 'thiếu nhánh này thì iPhone — đúng máy cần nhất — vẫn bị nhắc');
});

// `media: null` bảo harness đừng định nghĩa matchMedia CHÚT NÀO. Gán
// `window.matchMedia = undefined` sau khi trang đã nạp thì vô nghĩa: việc dò
// PWA chạy đúng một lần, lúc nạp, và đã chạy xong trước dòng gán đó.
test('trình duyệt không có matchMedia thì vẫn hiện, không nổ', () => {
  const page = loadAppPage({ media: null });
  assert.equal(an(page), false);
});
```

- [ ] **Step 4: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/app-pwa-note.test.js`
Expected: FAIL — ba test đầu đỏ vì `#pwa-note` chưa bao giờ được đặt `hidden`.

- [ ] **Step 5: Thêm khối ghi chú vào `index.html`**

Trong `#settings`, chèn ngay **sau** thẻ chứa `#who` và `#logout`:

```html
  <div id="pwa-note" class="card note">
    <p class="small">iPhone: phải thêm trang này vào màn hình chính rồi mở từ đó
    thì mới nhận được thông báo.</p>
  </div>
```

Và **xoá** dòng ghi chú cũ trong thẻ thông báo ở `#main`:
`<p class="dim small">iPhone: phải thêm vào màn hình chính rồi mở từ đó thì mới nhận được.</p>`
(dòng này đã không còn trong markup Task 2 — kiểm lại và xoá nếu còn sót).

- [ ] **Step 6: Thêm kiểu `.note` vào `style.css`**

```css
/* Ghi chú: không phải lỗi, nhưng cũng không phải chữ nền — viền nhấn nhạt là
   đủ để mắt dừng lại một nhịp mà không kêu như một cảnh báo. */
.card.note { background: var(--accent-soft); border-color: var(--accent); }
.card.note p { margin: 0; }
```

- [ ] **Step 7: Thêm dò PWA vào `app.js`**

Chèn ngay dưới khối `openSettings/closeSettings` của Task 2:

```js
// Một tab trình duyệt không tự biến thành PWA giữa chừng, nên hỏi một lần lúc
// nạp trang là đủ. iOS Safari không hỗ trợ `display-mode`, nó có
// `navigator.standalone` riêng — thiếu nhánh đó thì đúng cái máy mà ghi chú
// này nhắm tới lại là máy vẫn bị nhắc.
function dangChayTrongPwa() {
  if (navigator.standalone === true) return true;
  if (!window.matchMedia) return false;
  try { return window.matchMedia('(display-mode: standalone)').matches; }
  catch (e) { return false; }
}

if (dangChayTrongPwa()) $('pwa-note').classList.add('hidden');
```

- [ ] **Step 8: Chạy test, xác nhận XANH**

Run: `cd server && node --test test/app-pwa-note.test.js`
Expected: PASS cả 4 test.

- [ ] **Step 9: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ.

- [ ] **Step 10: Commit**

```bash
git add server/public/ server/test/
git commit -m "feat: stop telling installed PWA users to install the PWA

The note only means something to someone standing outside the installed app.
Checks navigator.standalone as well as display-mode, because iOS Safari has no
display-mode — and iPhone is the exact device the note is written for."
```

---

### Task 4: Dropdown giao diện và bản sáng

**Files:**
- Modify: `server/public/index.html` (`#theme-select`, `#theme-meta`)
- Modify: `server/public/style.css` (bảng sáng, kiểu `select`)
- Modify: `server/public/app.js` (đọc/ghi lựa chọn, đặt `data-theme`, đổi `theme-color`)
- Modify: `server/test/dom-harness.mjs` (`document.documentElement`, `REQUIRED_IDS`)
- Modify: `server/test/style-tokens.test.js` (canh bảng sáng đủ biến)
- Create: `server/test/app-theme.test.js`

**Interfaces:**
- Consumes: `matchMedia` giả từ Task 3; `#settings` từ Task 2.
- Produces: id `theme-select`, `theme-meta`; khoá `localStorage['ccrc_theme']` nhận `'light' | 'dark' | 'auto'`; hàm global `apDatTheme(giaTri)`.

- [ ] **Step 1: Thêm `documentElement` vào harness**

Trong `FakeDocument`, ngay sau `this.scrollingElement = new FakeElement('html');`, thêm:

```js
    // Trong chế độ chuẩn, document.scrollingElement CHÍNH LÀ documentElement.
    // Dựng hai đối tượng khác nhau ở đây sẽ làm test về theme xanh trong khi
    // trang thật đặt data-theme lên một phần tử không ai đọc.
    this.documentElement = this.scrollingElement;
```

Thêm `'theme-select'`, `'theme-meta'` vào `REQUIRED_IDS`.

- [ ] **Step 2: Mở rộng test biến CSS sang bảng sáng**

Thêm vào cuối `server/test/style-tokens.test.js`:

```js
// Bảng sáng thiếu một biến thì biến đó rơi về giá trị của bảng tối — chữ tối
// trên nền tối, hoặc ngược lại, chỉ với một dòng bị quên.
function bienTrongKhoi(dauKhoi) {
  const i = CSS.indexOf(dauKhoi);
  assert.notEqual(i, -1, `không tìm thấy khối ${dauKhoi}`);
  const mo = CSS.indexOf('{', i);
  const dong = CSS.indexOf('}', mo);
  return new Set(Array.from(CSS.slice(mo, dong).matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

test('mỗi khối theme khai báo đủ đúng bộ biến như :root', () => {
  const goc = bienTrongKhoi(':root {');
  for (const khoi of [':root:not([data-theme="dark"])', ':root[data-theme="light"]',
    ':root[data-theme="dark"]']) {
    const co = bienTrongKhoi(khoi);
    const thieu = [...goc].filter((v) => !co.has(v) && v !== '--mono').sort();
    assert.deepEqual(thieu, [], `${khoi} thiếu: ${thieu.join(', ')}`);
  }
});
```

- [ ] **Step 3: Viết test cho dropdown giao diện**

Tạo `server/test/app-theme.test.js`:

```js
// Ba lựa chọn giao diện. Điều đáng canh không phải "đặt được thuộc tính" mà là
// hai chuyện dễ quên: "theo thiết bị" phải GỠ HẲN data-theme (để lại là CSS hệ
// thống không bao giờ thắng được nữa), và thẻ theme-color phải đổi theo — CSS
// tự đổi màu, thẻ meta thì không, và thanh trạng thái PWA trên iPhone lấy màu
// từ đúng thẻ đó.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const TOI = '#101318';
const SANG = '#f6f4f2';
const theme = (page) => page.document.documentElement.getAttribute('data-theme');
const mauThanh = (page) => page.byId['theme-meta'].getAttribute('content');

test('mặc định là "theo thiết bị": không đặt data-theme', () => {
  const page = loadAppPage({});
  assert.equal(theme(page), null);
  assert.equal(page.byId['theme-select'].value, 'auto');
});

test('chọn Sáng: đặt data-theme=light, đổi cả màu thanh trạng thái, và nhớ lại', () => {
  const page = loadAppPage({});
  page.byId['theme-select'].value = 'light';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), 'light');
  assert.equal(mauThanh(page), SANG);
  assert.equal(page.localStorage.getItem('ccrc_theme'), 'light');
});

test('chọn Tối: đặt data-theme=dark dù hệ thống đang để sáng', () => {
  const page = loadAppPage({ media: { '(prefers-color-scheme: dark)': false } });
  page.byId['theme-select'].value = 'dark';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), 'dark');
  assert.equal(mauThanh(page), TOI);
});

test('quay lại "theo thiết bị" thì GỠ HẲN data-theme', () => {
  const page = loadAppPage({});
  page.byId['theme-select'].value = 'light';
  page.byId['theme-select'].onchange();
  page.byId['theme-select'].value = 'auto';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), null, 'để lại data-theme="light" thì cài đặt hệ thống không bao giờ thắng nữa');
});

test('mở lại app: đọc lựa chọn đã lưu, áp ngay, và dropdown khớp', () => {
  const page = loadAppPage({ storeSeed: { ccrc_theme: 'light' } });
  assert.equal(theme(page), 'light');
  assert.equal(page.byId['theme-select'].value, 'light');
});

test('"theo thiết bị" + hệ thống đổi sang tối → màu thanh trạng thái đổi theo', () => {
  const page = loadAppPage({ media: { '(prefers-color-scheme: dark)': false } });
  assert.equal(mauThanh(page), SANG);
  const l = page.window.mediaListeners.find((x) => x.query === '(prefers-color-scheme: dark)');
  assert.ok(l, 'phải nghe hệ thống đổi — CSS tự đổi, thẻ meta thì không');
  l.fn({ matches: true });
  assert.equal(mauThanh(page), TOI);
});
```

- [ ] **Step 4: Thêm `storeSeed` vào harness**

Test trên cần nạp sẵn `localStorage` trước khi script chạy. Trong `loadAppPage`,
thêm `storeSeed = {}` vào tham số và ngay sau `if (token) store.set('ccrc_token', token);`:

```js
  // Nạp sẵn localStorage TRƯỚC khi app.js chạy. Đặt sau khi script đã chạy thì
  // muộn: theme được đọc và áp ngay dòng đầu, đúng để không chớp nền sai màu.
  for (const [k, v] of Object.entries(storeSeed)) store.set(k, String(v));
```

- [ ] **Step 5: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/app-theme.test.js`
Expected: FAIL — `theme-select` chưa có handler `onchange`.

- [ ] **Step 6: Thêm bảng sáng vào `style.css`**

Ngay sau khối `:root { … }`:

```css
/* Ba khối, không phải hai. Khối media lo trường hợp "theo thiết bị"; hai khối
   [data-theme] lo trường hợp người dùng tự chọn — và phải có CẢ dark, không chỉ
   light, nếu không thì chọn "Tối" trên một máy đang để sáng sẽ không thắng
   được khối media ở trên. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f6f4f2; --card: #ffffff; --surface-2: #eee9e5; --border: #e3dcd6;
    --text: #1b1917; --dim: #6d6660;
    --accent: #c05f3c; --accent-soft: rgba(192, 95, 60, .12); --on-accent: #ffffff;
    --err: #c0392b;
  }
}
:root[data-theme="light"] {
  --bg: #f6f4f2; --card: #ffffff; --surface-2: #eee9e5; --border: #e3dcd6;
  --text: #1b1917; --dim: #6d6660;
  --accent: #c05f3c; --accent-soft: rgba(192, 95, 60, .12); --on-accent: #ffffff;
  --err: #c0392b;
}
:root[data-theme="dark"] {
  --bg: #101318; --card: #191d24; --surface-2: #242932; --border: #262b34;
  --text: #edeff2; --dim: #98a1b0;
  --accent: #e0805f; --accent-soft: rgba(224, 119, 87, .16); --on-accent: #1a0e08;
  --err: #f87171;
}

select { width: 100%; min-height: 46px; padding: 12px; background: var(--surface-2);
  color: var(--text); border: 1px solid var(--border); border-radius: 11px; font-size: 15px; }
```

- [ ] **Step 7: Thêm thẻ meta và dropdown vào `index.html`**

Trong `<head>`, thay `<meta name="theme-color" content="#0f1115">` bằng:

```html
<!-- Có id để app.js đổi được màu khi người dùng đổi giao diện. CSS tự đổi màu
     trang, còn thanh trạng thái của PWA trên iPhone lấy màu từ đúng thẻ này. -->
<meta id="theme-meta" name="theme-color" content="#101318">
```

Trong `#settings`, chèn ngay **sau** `#pwa-note`:

```html
  <h2>Giao diện</h2>
  <div class="card">
    <select id="theme-select" aria-label="Giao diện">
      <option value="auto">Theo thiết bị</option>
      <option value="light">Sáng</option>
      <option value="dark">Tối</option>
    </select>
  </div>
```

- [ ] **Step 8: Thêm xử lý theme vào `app.js`**

Chèn **ngay sau dòng `let token = …`** ở đầu file — phải chạy trước mọi thứ khác
để trang không chớp nền sai màu một nhịp:

```js
// --- Giao diện sáng/tối -----------------------------------------------------
//
// Ba giá trị: 'light', 'dark', 'auto'. 'auto' GỠ HẲN data-theme chứ không đặt
// một giá trị nào đó — để lại thuộc tính là khối @media theo cài đặt hệ thống
// không bao giờ thắng được nữa.
//
// Chạy ở đây, trước mọi thứ khác, vì đây là thứ duy nhất trong file này mà độ
// trễ nhìn thấy được: áp muộn một nhịp là người dùng thấy nền chớp sai màu.
const THEME_KEY = 'ccrc_theme';
const MAU_NEN = { light: '#f6f4f2', dark: '#101318' };

function heThongDangToi() {
  if (!window.matchMedia) return true;   // không hỏi được thì mặc định tối, như bản cũ
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch (e) { return true; }
}

function apDatTheme(giaTri) {
  const el = document.documentElement;
  if (giaTri === 'light' || giaTri === 'dark') el.setAttribute('data-theme', giaTri);
  else el.removeAttribute('data-theme');
  const dangToi = giaTri === 'dark' || (giaTri !== 'light' && heThongDangToi());
  const meta = $('theme-meta');
  if (meta) meta.setAttribute('content', dangToi ? MAU_NEN.dark : MAU_NEN.light);
}

(function khoiTaoTheme() {
  const luu = localStorage.getItem(THEME_KEY);
  const giaTri = (luu === 'light' || luu === 'dark') ? luu : 'auto';
  apDatTheme(giaTri);
  const sel = $('theme-select');
  if (sel) {
    sel.value = giaTri;
    sel.onchange = () => {
      const v = sel.value;
      if (v === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, v);
      apDatTheme(v);
    };
  }
  // CSS tự đổi khi hệ thống đổi; thẻ theme-color thì không. Không nghe ở đây
  // thì thanh trạng thái PWA giữ nguyên màu cũ cho tới lần nạp lại trang.
  if (window.matchMedia) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const doi = () => { if (!localStorage.getItem(THEME_KEY)) apDatTheme('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', doi);
      else if (mq.addListener) mq.addListener(doi);
    } catch (e) { /* trình duyệt cũ: cùng lắm là màu thanh trạng thái chậm một nhịp */ }
  }
})();
```

- [ ] **Step 9: Chạy test theme, xác nhận XANH**

Run: `cd server && node --test test/app-theme.test.js test/style-tokens.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 10: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ.

- [ ] **Step 11: Commit**

```bash
git add server/public/ server/test/
git commit -m "feat: a light theme, and a three-way picker for it

'Theo thiết bị' removes data-theme outright rather than writing a value —
leaving one behind means the system setting can never win again. The
theme-color meta tag is updated by hand on every change: CSS repaints itself,
that tag does not, and the iPhone status bar reads its colour from it."
```

---

### Task 5: Thẻ terminal mới và nút "Mở terminal" nổi bật

**Files:**
- Modify: `server/public/app.js` (`buildTerminalCard`, `buildTerminalCardAsync`)
- Modify: `server/public/style.css` (`.terminal-title`, `.terminal-meta`, `.terminal-note`)
- Modify: `server/test/app-terminal.test.js` (4 helper ở dòng 64–67, các assertion tên phiên)

**Interfaces:**
- Consumes: `hasUnread(session)`, `pairedMachines()`, `MSG_MAY_KHONG_PHAN_HOI`, `startPairing(machine)`, `openTerminal(session, btn)` — đều đã có trong `app.js`.
- Produces: `buildTerminalCard(session, daGhep)` với `daGhep` là boolean; `terminalMetaText(session, daGhep)` trả về string (rỗng nghĩa là không dựng dòng phụ). Cấu trúc thẻ: `div.terminal-title` → `div.terminal-meta`? → `button` hoặc `p.terminal-note`.

> **Lệch với spec §4.3, có chủ ý.** Spec viết dòng phụ nối thêm `· máy không phản hồi`.
> Nhưng câu thật trong `app.js` là hằng số `MSG_MAY_KHONG_PHAN_HOI` = *"Máy không
> phản hồi — có thể đã ngủ, hoặc /remote đã tắt."* — một câu đầy đủ, và vế "có thể
> đã ngủ" chính là thứ giúp người dùng biết phải làm gì. Rút gọn nó để nhét vừa
> dòng phụ là vứt đi phần hữu ích. Nên: câu đó ở lại một dòng riêng
> (`p.terminal-note`), đúng như hôm nay, và dòng phụ chỉ mang tên máy. Hằng số
> giữ nguyên, nên nó vẫn khớp từng chữ với lời từ chối trong `consumePendingOpen()`.

- [ ] **Step 1: Sửa 4 helper trong `app-terminal.test.js`**

Thay dòng 64–67 bằng:

```js
// Cấu trúc thẻ: [hàng tên] [dòng phụ?] [nút | câu "máy không phản hồi"?].
// Tìm theo class chứ KHÔNG theo kiểu loại trừ ("phần tử không phải hàng tên và
// không phải button"): dòng phụ mới sẽ lọt vào đúng cái lưới loại trừ đó, và
// test sẽ xanh trong khi nó đang soi nhầm phần tử.
const titleOf = (card) => card.children[0].children.at(-1).textContent;
const dotOf = (card) => card.children[0].children.find((c) => c.classList.contains('unread-dot'));
const openButtonOf = (card) => card.children.find((c) => c.tagName === 'BUTTON');
const metaOf = (card) => card.children.find((c) => c.classList.contains('terminal-meta'));
const noteOf = (card) => card.children.find((c) => c.classList.contains('terminal-note'));
```

- [ ] **Step 2: Sửa các assertion về tên phiên**

Tên thẻ giờ là `label` một mình, tên máy xuống dòng phụ. Sửa dòng 117–118:

```js
  assert.equal(titleOf(byId['terminal-list'].children[0]), 'cc-remote-control');
  assert.equal(metaOf(byId['terminal-list'].children[0]).textContent, 'may-dev');
  assert.equal(titleOf(byId['terminal-list'].children[1]), 'workspace');
  assert.equal(metaOf(byId['terminal-list'].children[1]).textContent, 'may-dev');
```

Đổi luôn tên test ở dòng ~91 từ `'… tiêu đề "label · machine", nút Mở terminal hiện'`
thành `'… tiêu đề là nhãn, tên máy xuống dòng phụ, nút Mở terminal hiện'` — tên test
mô tả sai cấu trúc là một cái bẫy cho người đọc sau.

Chạy `cd server && node --test test/app-terminal.test.js` và sửa nốt mọi assertion
khác so tên phiên với chuỗi có dấu `·` theo đúng cách trên — mỗi lần một chỗ,
đọc lỗi rồi sửa, đừng sửa mù.

- [ ] **Step 3: Thêm test cho dòng phụ**

Thêm vào cuối `server/test/app-terminal.test.js`:

```js
const SESSION_KHONG_NHAN = makeSession('s-3', { alive: true, label: '', machine: 'may-dev' });

test('phiên không có nhãn: tên là tên máy, và KHÔNG lặp lại nó ở dòng phụ', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_KHONG_NHAN] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_KHONG_NHAN.machine);
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.equal(titleOf(card), 'may-dev');
  assert.equal(metaOf(card), undefined, 'lặp lại tên máy ngay dưới chính nó là chữ thừa');
});

test('máy không phản hồi: giữ nguyên từng chữ của câu dùng chung, không rút gọn', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_DEAD] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.equal(openButtonOf(card), undefined, 'máy chết thì không dựng nút nào');
  assert.match(noteOf(card).textContent, /có thể đã ngủ/,
    'vế "có thể đã ngủ" là thứ nói cho người dùng biết phải làm gì — không được rút gọn đi');
});

test('máy chưa ghép: dòng phụ nói rõ, nút đổi thành Ghép máy này', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId } = loadAppPage({ fetchImpl });   // KHÔNG gọi pairMachine
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.match(metaOf(card).textContent, /chưa ghép với máy này/);
  assert.equal(openButtonOf(card).textContent, 'Ghép máy này');
});
```

`makeSession`, `pairMachine`, `SESSION_ALIVE`, `SESSION_DEAD` là helper và fixture
đã có sẵn ở đầu file — dùng lại đúng chúng, đừng dựng bộ mới. Đặt
`SESSION_KHONG_NHAN` cạnh ba fixture kia ở đầu file, không phải giữa phần test.

- [ ] **Step 4: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/app-terminal.test.js`
Expected: FAIL — `metaOf(...)` trả `undefined` vì `.terminal-meta` chưa được dựng.

- [ ] **Step 5: Viết lại `buildTerminalCard` trong `app.js`**

Thay hàm `buildTerminalCard(session)` hiện có bằng:

```js
// Dòng phụ chỉ nói những gì hub THẬT SỰ trả về. Hub không gửi mốc heartbeat
// cuối (xem toPublic() trong server/src/terminal-sessions.js), nên ở đây không
// có "2 phút trước" — bịa ra một con số là nói dối về máy của người dùng.
function terminalMetaText(session, daGhep) {
  const ve = [];
  // Tên thẻ đã là machine khi phiên không có nhãn — nhắc lại ngay dưới nó là
  // chữ thừa.
  if (session.label) ve.push(session.machine);
  if (session.alive && !daGhep) ve.push('chưa ghép với máy này');
  if (hasUnread(session)) ve.push('thông báo lúc ' + gioPhut(session.lastNotifiedAt));
  return ve.join(' · ');
}

function gioPhut(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// `label` và `machine` đều đến từ máy dev — label là tên thư mục dự án người
// dùng tự đặt — nên cả hai đi qua textContent, không bao giờ innerHTML.
function buildTerminalCard(session, daGhep = true) {
  const card = document.createElement('div');
  card.className = 'card terminal-card';

  const title = document.createElement('div');
  title.className = 'row terminal-title';
  const unread = hasUnread(session);
  if (unread) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    // Chấm là THÔNG TIN, không phải trang trí: chỉ có màu thì trình đọc màn
    // hình không đọc được gì cả.
    dot.setAttribute('aria-label', 'có thông báo chưa đọc');
    title.appendChild(dot);
  }
  const name = document.createElement('span');
  name.className = 'terminal-name';
  name.textContent = session.label || session.machine;
  // Tên LUÔN là span cuối trong hàng, chấm đứng trước nó. Test đọc tên bằng
  // children.at(-1), nên đảo thứ tự ở đây làm đỏ test chứ không hỏng ngầm.
  title.appendChild(name);
  card.appendChild(title);

  const metaText = terminalMetaText(session, daGhep);
  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'terminal-meta';
    meta.textContent = metaText;
    card.appendChild(meta);
  }

  if (unread) {
    card.classList.add('has-unread');
    const dot = title.children[0];
    // Lối thoát DUY NHẤT cho thẻ "máy không phản hồi", vốn không dựng nút nào
    // để bấm: thiếu nó thì chấm kẹt lại cho tới khi hub evict phiên sau 30
    // phút. Gỡ chấm tại chỗ thay vì fetch lại — trạng thái vẫn đúng ở lần dựng
    // sau vì mốc đã nằm trong localStorage rồi.
    card.onclick = () => {
      markRead(session.sessionId);
      dot.remove();
      card.classList.remove('has-unread');
    };
  }

  if (session.alive) {
    const openBtn = document.createElement('button');
    if (daGhep) {
      openBtn.textContent = 'Mở terminal';
      openBtn.onclick = () => openTerminal(session, openBtn);
    } else {
      // Một máy chưa ghép không có gì để chấp nhận chữ ký từ điện thoại này —
      // nút "Mở terminal" ở đó chỉ dẫn tới một vé bị daemon từ chối. Đây là LỐI
      // VÀO DUY NHẤT tới startPairing().
      openBtn.className = 'btn-soft';
      openBtn.textContent = 'Ghép máy này';
      openBtn.onclick = () => startPairing(session.machine);
    }
    card.appendChild(openBtn);
  } else {
    // KHÔNG dựng nút: một đường dẫn vào daemon đã thôi gửi nhịp tim chỉ làm cú
    // chạm treo lại.
    const note = document.createElement('p');
    note.className = 'dim small terminal-note';
    note.textContent = MSG_MAY_KHONG_PHAN_HOI;
    card.appendChild(note);
  }
  return card;
}
```

- [ ] **Step 6: Rút gọn `buildTerminalCardAsync`**

Thay hàm `buildTerminalCardAsync(session)` hiện có bằng:

```js
// Hỏi "máy này đã ghép chưa" TRƯỚC khi dựng thẻ, không phải sửa nút sau khi
// dựng: dòng phụ cũng cần biết câu trả lời đó.
async function buildTerminalCardAsync(session) {
  const daGhep = !session.alive || (await pairedMachines()).includes(session.machine);
  return buildTerminalCard(session, daGhep);
}
```

Hàm `openButtonOf(card)` trong `app.js` (dòng 265) giữ nguyên — `consumePendingOpen()`
vẫn dùng nó để bấm hộ.

- [ ] **Step 7: Thêm kiểu cho thẻ terminal vào `style.css`**

Thay quy tắc `.terminal-title` hiện có và thêm hai quy tắc mới:

```css
/* `.row` mặc định là justify-content: space-between — để nguyên thì chấm bị đẩy
   sang tận mép phải, xa cái tên nó đang nói về. */
.terminal-title { justify-content: flex-start; gap: 9px; }
.terminal-name { font-size: 15px; font-weight: 600; letter-spacing: -.005em; }
.terminal-meta { color: var(--dim); font-size: 12px; margin-top: 3px; }
.terminal-note { margin: 6px 0 0; }
```

- [ ] **Step 8: Chạy test terminal, xác nhận XANH**

Run: `cd server && node --test test/app-terminal.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 9: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ.

- [ ] **Step 10: Commit**

```bash
git add server/public/ server/test/
git commit -m "feat: give each session card a name, a subtitle, and a real button

The name is now the label alone and the machine moves to a subtitle, so the
most-tapped button in the app gets a full-width 46px target instead of a
sentence-sized one. The subtitle states only what the hub actually sends — it
has no last-heartbeat timestamp, so there is no 'x minutes ago' to show.
The dead-machine sentence keeps its own line: shortening it would drop the
'may have gone to sleep' half, which is the part that says what to do."
```

---

### Task 6: Công tắc bật/tắt thông báo

**Files:**
- Modify: `server/public/index.html` (thẻ thông báo trên `#main`)
- Modify: `server/public/app.js` (`refreshPushState`)
- Modify: `server/public/style.css` (`.switch`)
- Create: `server/test/app-push-switch.test.js`

**Interfaces:**
- Consumes: `currentSub()`, `refreshPushState()` — đã có.
- Produces: `#enable-push` vẫn là `<button>`, mang `role="switch"`, `aria-checked`, `aria-label`, và class `on` khi đang bật. Không còn `textContent`.

- [ ] **Step 1: Viết test**

Tạo `server/test/app-push-switch.test.js`:

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận nó ĐỎ**

Run: `cd server && node --test test/app-push-switch.test.js`
Expected: FAIL — `aria-checked` là `null`, và `textContent` đang là `'Tắt thông báo trên thiết bị này'`.

- [ ] **Step 3: Đổi markup thẻ thông báo trong `index.html`**

Thay thẻ thông báo trong `#main` bằng:

```html
  <div class="card">
    <div class="row">
      <div>
        <div class="field-label">Thông báo đẩy</div>
        <p id="push-state" class="dim small">đang kiểm tra…</p>
      </div>
      <!-- Vẫn là <button>, vẫn cùng id và cùng handler — chỉ đổi cách vẽ. Cần
           gạt được vẽ hoàn toàn bằng CSS (::after), nên app.js tuyệt đối không
           được ghi textContent vào nút này. -->
      <button id="enable-push" class="switch" role="switch" aria-checked="false"
              aria-label="Bật thông báo trên thiết bị này"></button>
    </div>
  </div>
```

- [ ] **Step 4: Đổi `refreshPushState` trong `app.js`**

Trong `refreshPushState()`, thay dòng:

```js
  btn.textContent = on ? 'Tắt thông báo trên thiết bị này' : 'Bật thông báo trên thiết bị này';
```

bằng:

```js
  // KHÔNG ghi textContent: cần gạt được vẽ bằng ::after, chữ sẽ đè lên nó.
  // Trạng thái đọc được qua #push-state cho mắt, và aria-checked cho trình đọc
  // màn hình — cần gạt không có chữ nên nếu thiếu, nó là một nút không nhãn.
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  btn.setAttribute('aria-label',
    on ? 'Tắt thông báo trên thiết bị này' : 'Bật thông báo trên thiết bị này');
```

- [ ] **Step 5: Thêm kiểu cần gạt vào `style.css`**

```css
.field-label { font-size: 15px; }
#push-state { margin: 3px 0 0; }

/* Cần gạt vẽ hoàn toàn bằng CSS — app.js không ghi chữ vào nút này. 44px chiều
   cao vùng bấm dù bản thân cần gạt chỉ cao 26px. */
button.switch { width: 44px; height: 44px; min-height: 44px; padding: 0;
  background: transparent; border-radius: 0; position: relative; flex: 0 0 auto; }
button.switch::before { content: ""; position: absolute; right: 0; top: 9px;
  width: 44px; height: 26px; border-radius: 13px; background: var(--surface-2);
  transition: background .15s; }
button.switch::after { content: ""; position: absolute; top: 12px; left: 3px;
  width: 20px; height: 20px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .35); transition: left .15s; }
button.switch.on::before { background: var(--accent); }
button.switch.on::after { left: 21px; }
```

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `cd server && node --test test/app-push-switch.test.js`
Expected: PASS cả 4 test.

- [ ] **Step 7: Chạy toàn bộ test**

Run: `cd server && npm test`
Expected: PASS toàn bộ.

- [ ] **Step 8: Commit**

```bash
git add server/public/ server/test/
git commit -m "feat: turn the push button into a switch

The switch is drawn entirely in CSS, so the button must never be given
textContent again — a test now says so out loud. A switch with no words is a
button with no label to a screen reader, so aria-checked and aria-label carry
what the old button text used to say."
```

---

### Task 7: Nghiệm thu trên trình duyệt thật và trên iPhone

Không có test tự động nào chứng minh được `popstate` trong PWA đã cài của iOS,
hay màu thanh trạng thái, hay việc ngón cái bấm trúng nút. Task này làm việc đó
bằng tay, và ghi lại kết quả.

**Files:**
- Create: `docs/superpowers/specs/2026-08-18-nghiem-thu-hub-ui.md`

- [ ] **Step 1: Chạy hub local**

```bash
cd server && npm start
```

Mở `http://localhost:<cổng>` bằng Chrome, đăng nhập bằng token cá nhân.

- [ ] **Step 2: Kiểm màn hình chính**

Ghi lại có/không cho từng mục:
- Danh sách terminal hiện ngay, không phải cuộn.
- Nút "Mở terminal" đặc, hết bề ngang, bấm được bằng ngón cái.
- Máy không phản hồi: không có nút, có câu đầy đủ *"Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt."*
- Máy chưa ghép: nút "Ghép máy này" kiểu nhạt, bấm ra bảng số 6 chữ số.
- Cần gạt thông báo bật/tắt được, `#push-state` đổi chữ theo.
- Kéo xuống để nạp lại vẫn chạy.

- [ ] **Step 3: Kiểm trang Cài đặt**

- Bấm ⚙ → hiện Cài đặt; bấm ‹ → về danh sách.
- Bấm ⚙ rồi bấm nút Back của trình duyệt → về danh sách, **không** rời khỏi trang.
- Ba lựa chọn giao diện đều đổi màu ngay, và màu thanh địa chỉ/thanh trạng thái đổi theo.
- Chọn "Tối" trong khi máy đang để chế độ sáng → app vẫn tối.
- Đóng tab, mở lại → giữ đúng lựa chọn.
- Xoá một thiết bị; bấm "Xoá N thiết bị khác, chỉ giữ máy này".
- Nhập một mã duyệt máy dev.

- [ ] **Step 4: Kiểm trên iPhone**

- Mở bằng Safari thường → khối ghi chú iPhone **có** hiện trong Cài đặt.
- Thêm vào màn hình chính, mở từ đó → khối ghi chú **không** hiện.
- Trong PWA: vuốt cạnh để back khi đang ở Cài đặt → về danh sách, không đóng app.
  **Nếu hỏng**: ghi lại bản iOS, và giữ nguyên nút ‹ làm đường đóng chắc chắn —
  đây là rủi ro spec §10 đã lường trước, không phải lỗi phát sinh.
- Bấm một thông báo đẩy → mở đúng phiên.

- [ ] **Step 5: Kiểm trang `/link`**

Mở `/link` khi chưa đăng nhập → hiện thẻ đăng nhập; đăng nhập xong → quay lại
đúng thẻ duyệt, không bị ném sang màn hình chính.

- [ ] **Step 6: Ghi biên bản nghiệm thu**

Tạo `docs/superpowers/specs/2026-08-18-nghiem-thu-hub-ui.md` với ba mục: **Chạy
được**, **Chưa chạy được**, **Quyết định phát sinh**. Ghi cả cái hỏng — biên bản
chỉ có mục đầu là biên bản vô dụng.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-18-nghiem-thu-hub-ui.md
git commit -m "docs: acceptance notes for the hub UI redesign"
```

---

## Sau khi xong

Nhánh `feat/hub-ui-redesign` sẵn sàng để bàn chuyện gộp. Đọc skill
`superpowers:finishing-a-development-branch` trước khi merge, và **hỏi Huy** —
`server/public` là thứ chạy trên hub thật, và bản cài đang chạy không được đụng
vào (đây là quy tắc đã chốt của dự án).
