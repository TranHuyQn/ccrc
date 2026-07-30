# Đánh dấu phiên có thông báo chưa đọc — kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thẻ terminal trên web UI của hub hiện một chấm tròn màu accent khi phiên đó có thông báo chưa xem, và tắt chấm khi người dùng mở phiên ra.

**Architecture:** Hook đã gửi `sessionId` kèm mỗi thông báo và hub đã dùng nó để nén push cho phiên đang được xem — nó chỉ bị vứt đi đúng lúc ghi vào lịch sử. Nối lại mắt xích đó là toàn bộ phần server. Phía PWA, "chưa đọc" = có thông báo của phiên đó mới hơn mốc `ccrc_read_<sessionId>` trong `localStorage` của chính máy đang xem. Hub không có state mới, không có endpoint mới.

**Tech Stack:** Node 20 + Express (hub), JavaScript trình duyệt thuần không bundler (`server/public/app.js`), `node:test` + bộ khung `node:vm` fake-DOM (`server/test/dom-harness.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-30-danh-dau-chua-doc-design.md`

## Global Constraints

- Ngôn ngữ chú thích code và tên test: **tiếng Việt** (theo đúng file đang sửa). Commit message: **tiếng Anh**.
- Chuỗi do máy dev / người dùng đặt (`label`, `machine`) luôn gán bằng `textContent`, **không bao giờ** `innerHTML`.
- `server/public/app.js` là script trình duyệt cổ điển chạy trong `node:vm` khi test: mọi hàm cần test gọi tới phải khai báo bằng `function` (khai báo `const`/`let` không lộ ra `context`).
- **Tên phiên luôn là span CUỐI** trong hàng tiêu đề thẻ. Đây là hợp đồng giữa `buildTerminalCard()` và helper `titleOf` trong test.
- Trường `sessionId` **vắng mặt hẳn** khi không có, không phải chuỗi rỗng.
- Chạy test: `npm test --workspace server` (hoặc một file: `node --test server/test/app-terminal.test.js`).
- Không đụng `term/` và `hook/` — hook đã gửi đủ dữ liệu từ trước.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/src/index.js` | Giữ `sessionId` khi ghi thông báo vào lịch sử | 1 |
| `server/test/notify-api.test.js` | Kiểm `/notify` → `/api/notifications` mang theo `sessionId` | 1 |
| `server/public/app.js` | Tính chưa đọc, dựng chấm, ba đường đánh dấu đã đọc, dọn khoá | 2–5 |
| `server/public/style.css` | Kiểu của chấm và hàng tiêu đề thẻ | 2 |
| `server/public/index.html` | Bump `?v=` để PWA nhận bản mới | 5 |
| `server/test/dom-harness.mjs` | `sessionStorage` giả, `remove()`, liệt kê khoá `localStorage` | 3, 5 |
| `server/test/app-terminal.test.js` | Toàn bộ test hành vi phía PWA | 2–5 |

---

### Task 1: Hub giữ lại `sessionId` trong lịch sử thông báo

**Files:**
- Modify: `server/src/index.js:172` (dòng dựng `note` trong route `POST /notify`)
- Test: `server/test/notify-api.test.js` (thêm sau test ở dòng ~160, `'sessionId không tồn tại / sai kiểu → vẫn đẩy, không nổ'`)

**Interfaces:**
- Consumes: không có (task đầu tiên).
- Produces: `GET /api/notifications` trả `{ items: [{ type, title, body, tag, at, sessionId? }] }`. Trường `sessionId` là chuỗi ≤ 200 ký tự, **vắng mặt** khi thông báo không thuộc phiên nào. Task 2 đọc đúng hình dạng này.

- [ ] **Step 1: Viết test đang đỏ**

Thêm vào `server/test/notify-api.test.js`, ngay sau test `'sessionId không tồn tại / sai kiểu → vẫn đẩy, không nổ'`:

```js
// --- sessionId trong lịch sử ------------------------------------------------
//
// Hook đã gửi sessionId từ trước (hook/src/notify-payload.js) và hub đã dùng
// nó để nén push cho phiên đang được xem. Nó phải đi tiếp vào lịch sử nữa,
// vì đó là thứ duy nhất cho PWA biết thông báo này thuộc thẻ terminal nào.
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
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/notify-api.test.js`
Expected: FAIL — test đầu báo `undefined !== 's-abc'`, test cuối báo đọc `.length` của `undefined`. Hai test "không có trường" thì XANH sẵn (đúng, chúng canh phần không được phép hồi quy).

- [ ] **Step 3: Sửa hub**

Trong `server/src/index.js`, thay dòng dựng `note` trong route `POST /notify`:

```js
  const note = { type: String(n.type || ''), title: n.title.slice(0, 200), body: n.body.slice(0, 200), tag: String(n.tag || 'ccrc') };
```

bằng:

```js
  const note = {
    type: String(n.type || ''),
    title: n.title.slice(0, 200),
    body: n.body.slice(0, 200),
    tag: String(n.tag || 'ccrc'),
    // Thứ cho PWA biết thông báo này thuộc thẻ terminal nào — chính là dữ liệu
    // dựng nên chấm "chưa đọc". Hook gửi nó từ trước
    // (hook/src/notify-payload.js) và ngay dưới đây hub đã dùng nó để nén push
    // cho phiên đang được xem; trước bản này nó bị vứt đi đúng ở dòng này, nên
    // lịch sử có nội dung thông báo mà không có cách nào nối về phiên.
    //
    // Vắng mặt hẳn khi thông báo không thuộc phiên nào (không chạy /remote cho
    // thư mục đó) — trường thiếu, KHÔNG phải chuỗi rỗng, để phía PWA không
    // phải phân biệt hai loại "không có".
    //
    // Cắt 200 ký tự cho đồng bộ với title/body ngay trên: /notify mở cho bất
    // cứ ai cầm một token hợp lệ, và đây là một mảng nằm trong RAM tới 50 mục.
    ...(typeof n.sessionId === 'string' && n.sessionId
      ? { sessionId: n.sessionId.slice(0, 200) }
      : {}),
  };
```

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `node --test server/test/notify-api.test.js`
Expected: PASS toàn bộ file (mọi test cũ vẫn xanh — `/notify` chỉ trả `{ok, pushed}`, không ai assert hình dạng `note` đã lưu).

- [ ] **Step 5: Commit**

```bash
git add server/src/index.js server/test/notify-api.test.js
git commit -m "Keep sessionId on stored notifications so the PWA can attribute them"
```

---

### Task 2: Chấm "chưa đọc" hiện trên thẻ terminal

**Files:**
- Modify: `server/public/app.js` — `refreshList()` (~dòng 32), thêm khối hàm mới trước `refreshTerminal()`, `buildTerminalCard()` (~dòng 146)
- Modify: `server/public/style.css` (thêm cuối file)
- Modify: `server/test/dom-harness.mjs` — `FakeElement.setAttribute/getAttribute`
- Test: `server/test/app-terminal.test.js`

**Interfaces:**
- Consumes: hình dạng note từ Task 1 — `{ type, title, body, tag, at, sessionId? }`.
- Produces:
  - `recentNotes` (biến module, mảng note của lần `refreshList()` gần nhất)
  - `function markRead(sessionId)` — ghi `localStorage['ccrc_read_<id>'] = String(Date.now())`; bỏ qua khi `sessionId` rỗng
  - `function lastReadAt(sessionId) -> number` — 0 nếu chưa từng đọc
  - `function hasUnread(sessionId) -> boolean`
  - Hằng `READ_PREFIX = 'ccrc_read_'`, `OPENED_KEY = 'ccrc_opened'`
  - DOM thẻ: `div.card.terminal-card[.has-unread] > div.row.terminal-title > [span.unread-dot?] + span(tên)`
  - Task 3 dùng `markRead`, `OPENED_KEY`; Task 5 dùng `READ_PREFIX`, `recentNotes`.

- [ ] **Step 1: Viết test đang đỏ**

Trong `server/test/app-terminal.test.js`, sửa helper `titleOf` ở dòng 61 (tên giờ nằm trong một span con, không còn là text của cả hàng):

```js
// Hàng tiêu đề giờ chứa tối đa hai span: chấm "chưa đọc" (chỉ khi có) rồi
// tên. Tên LUÔN là span cuối — hợp đồng này giữ cho helper không phải đoán
// chỉ số theo việc có chấm hay không.
const titleOf = (card) => card.children[0].children.at(-1).textContent;
const dotOf = (card) => card.children[0].children.find((c) => c.classList.contains('unread-dot'));
```

Thêm vào cuối file:

```js
// --- Chấm "chưa đọc" trên thẻ ----------------------------------------------
//
// Badge được tính từ GIAO của hai nguồn: /api/terminal (có phiên nào) và
// /api/notifications (phiên nào có việc). Nên mọi test dưới đây phải phục vụ
// cả hai URL, và phải gọi refreshList() trước refreshTerminal() — đúng thứ tự
// trang thật chạy.
const NOTE_BASE = {
  type: 'idle_prompt',
  title: '🔔 may-dev · cc-remote-control',
  body: 'Claude đang chờ bạn nhập',
  tag: 'ccrc-idle_prompt',
};

// `notes`/`sessions` là hộp có thể sửa giữa chừng, để một test dựng được cảnh
// "trong lúc mình đi vắng thì có thông báo mới về".
function makeFetchBoth(box) {
  return makeFetch(async (url) => {
    if (url === '/api/notifications') return { status: 200, body: { items: box.notes } };
    if (url === '/api/terminal') return { status: 200, body: { sessions: box.sessions } };
    throw new Error('unexpected url ' + url);
  });
}

async function refreshBoth(context) {
  await context.refreshList();
  await context.refreshTerminal();
}

test('thông báo mới hơn mốc đã đọc → thẻ của đúng phiên đó hiện chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'phải có chấm chưa đọc');
  assert.equal(card.classList.contains('has-unread'), true);
  assert.equal(titleOf(card), 'cc-remote-control · may-dev', 'tên vẫn phải là span cuối');
});

test('thông báo cũ hơn mốc đã đọc → không có chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '2000'); // đã xem sau thông báo đó
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
  assert.equal(byId['terminal-list'].children[0].classList.contains('has-unread'), false);
});

test('thông báo đúng mốc đã đọc (bằng nhau) → coi như đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 2000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '2000');
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined,
    'so sánh phải là > chứ không >=, nếu không mở xong vẫn còn chấm');
});

test('thông báo của phiên KHÁC không làm phiên này sáng chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-2', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('thông báo không thuộc phiên nào (không có sessionId) không sáng chấm ở đâu cả', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('phiên không phản hồi vẫn sáng chấm — thông báo đã đến là chuyện có thật', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'máy ngủ không có nghĩa là không có việc chờ mình');
  assert.equal(openButtonOf(card), undefined, 'vẫn không được dựng nút mở');
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/app-terminal.test.js`
Expected: FAIL — `card.children[0].children.at(-1)` là `undefined` (hàng tiêu đề chưa có span con nào), nên cả test cũ lẫn test mới đều nổ ở `titleOf`/`dotOf`.

- [ ] **Step 3: Thêm khối tính "chưa đọc" vào `app.js`**

Trong `server/public/app.js`, sửa `refreshList()` để nhớ lại danh sách — thay dòng đầu thân hàm:

```js
async function refreshList() {
  const { items } = await (await api('/api/notifications')).json();
```

bằng:

```js
async function refreshList() {
  const { items } = await (await api('/api/notifications')).json();
  // Giữ lại cho phần tính chấm "chưa đọc" bên dưới. Danh sách terminal được
  // dựng từ một fetch KHÁC, nên đây là nơi duy nhất nó biết được phiên nào
  // đang có việc chờ.
  recentNotes = items || [];
```

Thêm khối sau đây ngay **trước** chú thích của `refreshTerminal()` (khoảng dòng 60):

```js
// --- Phiên nào đang có thông báo chưa đọc -----------------------------------
//
// Hub gắn `sessionId` vào mỗi thông báo nó ghi lại (server/src/index.js), nên
// "phiên này có việc chờ mình" rút gọn thành: có thông báo nào của phiên đó
// mới hơn lần cuối mình xem nó không.
//
// Mốc "lần cuối xem" nằm trong localStorage của CHÍNH máy này, không phải trên
// hub: không endpoint mới, không state mới ở server, và hai thiết bị thì mỗi
// thiết bị tự đếm — vốn đúng hơn là dùng chung. Lịch sử thông báo trên hub
// cũng chỉ nằm trong RAM (HISTORY_MAX = 50), nên mốc đọc không cần bền hơn nó.

// Thông báo của lần refreshList() gần nhất.
let recentNotes = [];

const READ_PREFIX = 'ccrc_read_';

// Khoá của phiên vừa được mở, đặt trong sessionStorage chứ KHÔNG localStorage
// (xem openTerminal()): nó phải sống qua lần điều hướng sang máy dev rồi quay
// lại trong cùng một tab, nhưng phải chết khi đóng app.
const OPENED_KEY = 'ccrc_opened';

function readMarkKey(sessionId) { return READ_PREFIX + sessionId; }

function lastReadAt(sessionId) {
  // Number(null) là 0, Number('rác') là NaN — `|| 0` gộp cả hai thành "chưa
  // từng đọc", nên một khoá bị hỏng bằng tay chỉ làm chấm sáng lên, không bao
  // giờ làm nó tắt oan.
  return Number(localStorage.getItem(readMarkKey(sessionId))) || 0;
}

function markRead(sessionId) {
  if (!sessionId) return;
  localStorage.setItem(readMarkKey(sessionId), String(Date.now()));
}

function hasUnread(sessionId) {
  if (!sessionId) return false;
  const since = lastReadAt(sessionId);
  // `>` chứ không `>=`: markRead() ghi Date.now(), và một thông báo đến đúng
  // cùng mili-giây với lúc mở phải tính là đã đọc.
  return recentNotes.some((n) => n && n.sessionId === sessionId && n.at > since);
}
```

- [ ] **Step 4: Dựng chấm trong `buildTerminalCard()`**

Thay phần đầu `buildTerminalCard()` (từ `const title = ...` tới `card.appendChild(title);`):

```js
  const title = document.createElement('div');
  title.className = 'row';
  title.textContent = session.label ? `${session.label} · ${session.machine}` : session.machine;
  card.appendChild(title);
```

bằng:

```js
  const title = document.createElement('div');
  title.className = 'row terminal-title';
  const unread = hasUnread(session.sessionId);
  if (unread) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    // Chấm là THÔNG TIN, không phải trang trí: chỉ có màu thì trình đọc màn
    // hình không đọc được gì cả.
    dot.setAttribute('aria-label', 'có thông báo chưa đọc');
    title.appendChild(dot);
  }
  const name = document.createElement('span');
  name.textContent = session.label ? `${session.label} · ${session.machine}` : session.machine;
  // Tên LUÔN là span cuối trong hàng, chấm đứng trước nó. Test đọc tên bằng
  // children.at(-1), nên đảo thứ tự ở đây làm đỏ test chứ không hỏng ngầm.
  title.appendChild(name);
  card.appendChild(title);
  if (unread) card.classList.add('has-unread');
```

`setAttribute` chưa có trong bộ khung test; thêm vào `FakeElement` trong `server/test/dom-harness.mjs`, ngay sau `append(...)`:

```js
  // app.js gắn aria-label lên chấm "chưa đọc". Không cần đọc lại trong test,
  // nhưng thiếu hẳn phương thức thì script nổ ngay lúc dựng thẻ.
  setAttribute(name, value) { this._attrs = this._attrs || {}; this._attrs[name] = String(value); }
  getAttribute(name) { return (this._attrs && this._attrs[name]) ?? null; }
```

- [ ] **Step 5: Thêm CSS**

Thêm vào cuối `server/public/style.css`:

```css
/* Chấm "phiên này có thông báo chưa xem" trên thẻ terminal (app.js).
   `.row` mặc định là justify-content: space-between — để nguyên thì chấm bị
   đẩy sang tận mép phải, xa cái tên nó đang nói về. Quầng sáng mờ quanh chấm
   là thứ làm nó nổi trên nền --card tối mà không phải tô cả thẻ. */
.terminal-title { justify-content: flex-start; gap: 8px; }
.unread-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
  background: var(--accent); box-shadow: 0 0 0 3px rgba(217, 119, 87, .20); }
```

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `node --test server/test/app-terminal.test.js`
Expected: PASS toàn bộ file, kể cả các test cũ dùng `titleOf`.

- [ ] **Step 7: Commit**

```bash
git add server/public/app.js server/public/style.css server/test/app-terminal.test.js server/test/dom-harness.mjs
git commit -m "Show an unread dot on terminal cards with pending notifications"
```

---

### Task 3: Ba đường đánh dấu đã đọc

**Files:**
- Modify: `server/public/app.js` — `doRefreshTerminal()` (~dòng 80), `buildTerminalCard()`, `openTerminal()` (~dòng 244)
- Modify: `server/test/dom-harness.mjs` — `sessionStorage` giả, `FakeElement.remove()`
- Test: `server/test/app-terminal.test.js`

**Interfaces:**
- Consumes: `markRead`, `hasUnread`, `OPENED_KEY` từ Task 2.
- Produces: `loadAppPage()` trả thêm `sessionStorage` (cùng hình dạng `localStorage` giả). `FakeElement` có `remove()`.

- [ ] **Step 1: Thêm `sessionStorage` và `remove()` vào bộ khung**

Trong `server/test/dom-harness.mjs`, sửa `FakeElement` để nút con biết cha là ai:

```js
  appendChild(child) { this.children.push(child); return child; }
```

thành:

```js
  appendChild(child) { child._parent = this; this.children.push(child); return child; }
  // app.js gỡ chấm "chưa đọc" tại chỗ khi người dùng chạm vào thẻ, thay vì
  // dựng lại cả danh sách. Không có remove() thì đường đó nổ trong test dù
  // trình duyệt thật chạy tốt.
  remove() {
    const p = this._parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this._parent = null;
  }
```

Trong `loadAppPage()`, ngay sau khối `const localStorage = {...}`:

```js
  // sessionStorage là một kho RIÊNG, không phải bí danh của localStorage:
  // app.js cố ý chọn nó cho dấu "vừa mở phiên nào" vì nó chết khi đóng app.
  // Gộp chung hai kho ở đây sẽ làm test "mở lại app sau khi đóng" xanh sai.
  const sessionStore = new Map();
  const sessionStorage = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  };
```

Thêm `sessionStorage,` vào `contextObj` (cạnh `localStorage,`) và vào object trả về ở cuối hàm (cạnh `localStorage,`).

- [ ] **Step 2: Viết test đang đỏ**

Thêm vào cuối `server/test/app-terminal.test.js`:

```js
// --- Ba đường đánh dấu đã đọc ----------------------------------------------

test('bấm "Mở terminal" → phiên đó coi như đã đọc, lần dựng sau hết chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage, sessionStorage, location } =
    loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  assert.ok(dotOf(byId['terminal-list'].children[0]), 'tiền đề: đang có chấm');

  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.match(location.href, /#t=/, 'tiền đề: đã thực sự điều hướng đi');
  assert.ok(Number(localStorage.getItem('ccrc_read_s-1')) > 0, 'phải ghi mốc đã đọc');
  assert.equal(sessionStorage.getItem('ccrc_opened'), 's-1', 'phải nhớ để lần quay về đánh dấu tiếp');

  await refreshBoth(context);
  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('ký hỏng (chưa ghép) → KHÔNG được coi là đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  // crypto một phần: mọi thứ ensureDeviceKey()/pairedMachines() cần vẫn thật,
  // riêng subtle.sign() ném — đúng cảnh điện thoại chưa ghép với máy đó.
  // Cùng một `brokenCrypto` với test 'ký thất bại (IndexedDB/WebCrypto lỗi)…'
  // đã có trong file này — giữ y hệt để hai test không lệch nhau về bộ phương
  // thức mà ensureDeviceKey()/rememberMachine() cần.
  const brokenCrypto = {
    getRandomValues: (arr) => webcrypto.getRandomValues(arr),
    subtle: {
      generateKey: (...a) => webcrypto.subtle.generateKey(...a),
      exportKey: (...a) => webcrypto.subtle.exportKey(...a),
      digest: (...a) => webcrypto.subtle.digest(...a),
      verify: (...a) => webcrypto.subtle.verify(...a),
      sign: () => { throw new Error('ký giả lập thất bại'); },
    },
  };
  const { context, byId, localStorage, sessionStorage } =
    loadAppPage({ fetchImpl: makeFetchBoth(box), cryptoImpl: brokenCrypto });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.equal(localStorage.getItem('ccrc_read_s-1'), null, 'không mở được thì không mất chấm');
  assert.equal(sessionStorage.getItem('ccrc_opened'), null);
  assert.ok(dotOf(byId['terminal-list'].children[0]), 'chấm phải còn nguyên');
});

test('quay về từ terminal → thông báo đến TRONG LÚC đang xem cũng coi là đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  // Hub vẫn GHI thông báo vào lịch sử trong lúc mình xem terminal (nó chỉ nén
  // push) — đây chính là thứ sẽ sáng chấm oan nếu thiếu bước đánh dấu lúc về.
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() }];
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined,
    'vừa xem xong quay ra mà vẫn thấy chấm là sai');
});

test('đóng app rồi mở lại → thông báo đến sau đó VẪN sáng chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId, sessionStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  // Đóng app: sessionStorage chết theo tab, localStorage thì không. Đây đúng
  // là lý do dấu "vừa mở phiên nào" không được đặt trong localStorage.
  sessionStorage.removeItem('ccrc_opened');
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() + 60_000 }];
  await refreshBoth(context);

  assert.ok(dotOf(byId['terminal-list'].children[0]),
    'thông báo đến sau khi rời đi không được bị nuốt mất');
});

test('chạm vào thẻ phiên không phản hồi → tắt chấm ngay, không cần fetch lại', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'tiền đề: đang có chấm');
  assert.equal(openButtonOf(card), undefined, 'tiền đề: không có nút nào để bấm');

  card.onclick();

  assert.equal(dotOf(card), undefined, 'chấm phải biến mất tại chỗ');
  assert.equal(card.classList.contains('has-unread'), false);
  assert.ok(Number(localStorage.getItem('ccrc_read_s-1')) > 0);
});

test('thẻ không có chấm thì không gắn onclick — không có gì để chạm cả', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  assert.equal(byId['terminal-list'].children[0].onclick, null);
});
```

- [ ] **Step 3: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/app-terminal.test.js`
Expected: FAIL — `sessionStorage.getItem('ccrc_opened')` trả `null` thay vì `'s-1'`, và `card.onclick` là `null` trên thẻ có chấm.

- [ ] **Step 4: Đánh dấu đã đọc lúc mở terminal**

Trong `openTerminal()` của `server/public/app.js`, thay:

```js
    const token = await signAttachToken(session);
    // Fragment, not query string — never sent to a server, stays out of most
    // logs, and term.js strips it from the address bar on arrival (spec §6).
    location.href = session.url + '#t=' + encodeURIComponent(token);
```

bằng:

```js
    const token = await signAttachToken(session);
    // Đánh dấu đã đọc CHỈ khi thật sự sắp đi tới đó: URL đã qua kiểm tra và
    // chữ ký đã ký xong. Một thẻ bị từ chối vì URL lạ, hay một lần ký hỏng vì
    // điện thoại chưa ghép, đều kết thúc bằng "không mở được gì cả" — và
    // không được vì thế mà mất dấu chưa đọc.
    markRead(session.sessionId);
    // Để lần QUAY VỀ còn đánh dấu tiếp: hub vẫn ghi thông báo vào lịch sử
    // trong lúc mình đang xem terminal (nó chỉ nén push, xem route /notify),
    // nên không có bước này thì vừa xem xong quay ra vẫn thấy chấm cam.
    //
    // sessionStorage, KHÔNG localStorage: nó sống qua lần điều hướng sang máy
    // dev rồi quay lại trong cùng một tab, nhưng chết khi đóng app. Nếu dùng
    // localStorage thì "mở lại app sau ba tiếng" sẽ âm thầm đánh dấu đã đọc
    // cả đống thông báo đến trong lúc đó — đúng những cái cần sáng chấm nhất.
    sessionStorage.setItem(OPENED_KEY, session.sessionId);
    // Fragment, not query string — never sent to a server, stays out of most
    // logs, and term.js strips it from the address bar on arrival (spec §6).
    location.href = session.url + '#t=' + encodeURIComponent(token);
```

- [ ] **Step 5: Tiêu thụ dấu "vừa mở" khi dựng lại danh sách**

Trong `doRefreshTerminal()`, thay:

```js
async function doRefreshTerminal() {
  const err = $('terminal-err');
  err.classList.add('hidden');
```

bằng:

```js
async function doRefreshTerminal() {
  const err = $('terminal-err');
  err.classList.add('hidden');

  // Vừa quay về từ một terminal: đánh dấu đã đọc lần nữa, mốc là LÚC NÀY, để
  // những thông báo đến trong lúc đang xem không sáng chấm ngay khi quay ra.
  // Đặt ở đây chứ không trong refreshOnReturn() để mọi lối vào đều được phủ —
  // kể cả showMain() chạy lại từ đầu, vốn không đi qua refreshOnReturn().
  const opened = sessionStorage.getItem(OPENED_KEY);
  if (opened) {
    markRead(opened);
    sessionStorage.removeItem(OPENED_KEY);
  }
```

- [ ] **Step 6: Gắn chạm-để-tắt-chấm lên thẻ**

Trong `buildTerminalCard()`, thay dòng Task 2 vừa thêm:

```js
  if (unread) card.classList.add('has-unread');
```

bằng:

```js
  if (unread) {
    card.classList.add('has-unread');
    const dot = title.children[0];
    // Lối thoát DUY NHẤT cho thẻ "máy không phản hồi", vốn không dựng nút nào
    // để bấm: thiếu nó thì chấm kẹt lại cho tới khi hub evict phiên sau 30
    // phút. Gỡ chấm tại chỗ thay vì fetch lại — trạng thái vẫn đúng ở lần dựng
    // sau vì mốc đã nằm trong localStorage rồi. Click vào nút "Mở terminal"
    // cũng nổi bọt lên đây; vô hại, openTerminal() đã đánh dấu sẵn.
    card.onclick = () => {
      markRead(session.sessionId);
      dot.remove();
      card.classList.remove('has-unread');
    };
  }
```

- [ ] **Step 7: Chạy test, xác nhận XANH**

Run: `node --test server/test/app-terminal.test.js`
Expected: PASS toàn bộ file.

- [ ] **Step 8: Commit**

```bash
git add server/public/app.js server/test/dom-harness.mjs server/test/app-terminal.test.js
git commit -m "Clear the unread dot on open, on return, and on tapping the card"
```

---

### Task 4: Quay lại trang nạp lại CẢ hai danh sách

**Files:**
- Modify: `server/public/app.js` — `refreshTerminalOnReturn()` và hai listener (~dòng 570)
- Test: `server/test/app-terminal.test.js` (sửa 4 test bfcache sẵn có + thêm 1 test mới)

**Interfaces:**
- Consumes: `refreshList()`, `refreshTerminal()`, `recentNotes` từ Task 2.
- Produces: `function refreshOnReturn()` thay cho `refreshTerminalOnReturn()`; trả về promise của cả hai lần nạp, hoặc `undefined` khi chưa đăng nhập.

- [ ] **Step 1: Viết test đang đỏ**

Thêm vào cuối `server/test/app-terminal.test.js`:

```js
test('pageshow nạp lại CẢ thông báo lẫn terminal → chấm sáng lên mà không phải gọi tay', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId, window } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.remove('hidden'); // đã đăng nhập
  await refreshBoth(context);
  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined, 'tiền đề: chưa có gì');

  // Trong lúc app nằm nền, một thông báo về.
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() }];
  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  assert.ok(dotOf(byId['terminal-list'].children[0]),
    'chỉ nạp lại /api/terminal thì chấm không bao giờ sáng — phải nạp cả /api/notifications');
});

test('pageshow + visibilitychange dồn dập → mỗi endpoint đúng một lần gọi', async () => {
  let terminalCalls = 0;
  let noteCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') { terminalCalls++; return { status: 200, body: { sessions: [SESSION_ALIVE] } }; }
    if (url === '/api/notifications') { noteCalls++; return { status: 200, body: { items: [] } }; }
    throw new Error('unexpected url ' + url);
  });
  const { byId, window, document } = loadAppPage({ fetchImpl });
  byId['main'].classList.remove('hidden');

  await Promise.all([
    ...window.dispatch('pageshow', { persisted: true }),
    ...document.dispatch('visibilitychange'),
    ...document.dispatch('visibilitychange'),
  ]);

  assert.equal(terminalCalls, 1, 'coalescing phải gộp cả ba sự kiện');
  assert.equal(noteCalls, 1);
});

test('/api/notifications lỗi khi quay lại → danh sách terminal vẫn được dựng', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('notifications down');
  });
  const { context, byId, window } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.remove('hidden');

  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  assert.equal(byId['terminal-list'].children.length, 1,
    'một endpoint hỏng không được kéo theo endpoint kia');
});
```

Đồng thời sửa **bốn** test bfcache sẵn có (`'bfcache restore (pageshow) đưa nút về "Mở terminal"…'`, `'phiên đã đóng trong lúc rời đi…'`, `'pageshow và visibilitychange dồn dập chỉ gọi GET /api/terminal đúng một lần…'`, `'chưa đăng nhập (màn hình main còn ẩn) → pageshow không gọi hub'`): mỗi `fetchImpl` của chúng thêm một nhánh trước dòng `throw new Error('unexpected url ' + url)`:

```js
    if (url === '/api/notifications') return { status: 200, body: { items: [] } };
```

Không sửa thì `pageshow` sẽ đâm vào nhánh `throw` và chỉ được cứu bởi `.catch()`, tức là test xanh trong khi đang chạy một đường hỏng — đúng loại xanh giả cần tránh. Riêng test `'pageshow và visibilitychange dồn dập chỉ gọi GET /api/terminal đúng một lần'` giờ trùng nội dung với test mới ở trên: **xoá test cũ**, giữ bản mới đếm cả hai endpoint.

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/app-terminal.test.js`
Expected: FAIL — test đầu tiên báo chấm vẫn `undefined` (pageshow chưa nạp lại thông báo); `noteCalls` bằng 0.

- [ ] **Step 3: Sửa `app.js`**

Thay toàn bộ khối `refreshTerminalOnReturn()` và hai listener bằng:

```js
// Quay lại trang phải nạp lại CẢ HAI danh sách: thông báo và terminal. Chấm
// "chưa đọc" trên thẻ được tính từ giao của hai thứ đó (xem hasUnread()), nên
// nếu chỉ nạp lại /api/terminal thì chấm hoặc không bao giờ sáng, hoặc không
// bao giờ tắt.
//
// Coalescing chuyển lên đúng ở đây: một lần khôi phục bfcache có thể bắn
// 'pageshow' và 'visibilitychange' sát nhau, và cả cụm phải quy về đúng một
// lượt nạp — không phải một lượt mỗi sự kiện. refreshTerminal() vẫn giữ
// coalescing riêng của nó cho các lối gọi khác (nhánh lỗi của openTerminal()).
let returnRefreshInFlight = null;

function refreshOnReturn() {
  // Chỉ có nghĩa sau khi đăng nhập; ở màn hình login không có danh sách nào,
  // và một token cũ/thiếu chỉ đập vào 401 → logout().
  if ($('main').classList.contains('hidden')) return;
  if (returnRefreshInFlight) return returnRefreshInFlight;
  returnRefreshInFlight = (async () => {
    // refreshList() không tự bắt lỗi như refreshTerminal(). Một lần 401 ở đây
    // đã logout() rồi ném tiếp, và không được để nó thành unhandled rejection
    // trên một promise mà listener của trình duyệt vứt đi. Nuốt lỗi ở đây chỉ
    // làm chấm tính trên dữ liệu cũ; danh sách terminal vẫn phải dựng.
    await refreshList().catch(() => {});
    await refreshTerminal();
  })().finally(() => { returnRefreshInFlight = null; });
  // Trả promise ra là vô nghĩa với addEventListener thật (trình duyệt bỏ qua)
  // nhưng cho test await được thay vì phải đua với nó.
  return returnRefreshInFlight;
}
window.addEventListener('pageshow', refreshOnReturn);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') return refreshOnReturn();
});
```

Giữ nguyên khối chú thích dài phía trên (giải thích bfcache và vì sao cần cả hai sự kiện) — nó vẫn đúng.

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `node --test server/test/app-terminal.test.js && node --test server/test/app-pull-refresh.test.js`
Expected: PASS cả hai.

- [ ] **Step 5: Commit**

```bash
git add server/public/app.js server/test/app-terminal.test.js
git commit -m "Refresh notifications alongside terminals when returning to the page"
```

---

### Task 5: Dọn khoá `localStorage` và phát hành

**Files:**
- Modify: `server/public/app.js` — `renderTerminalList()` (~dòng 106), thêm `pruneReadMarks()`
- Modify: `server/test/dom-harness.mjs` — `localStorage.length` và `key(i)`
- Modify: `server/public/index.html:18,71` — `?v=8` → `?v=9`
- Test: `server/test/app-terminal.test.js`

**Interfaces:**
- Consumes: `READ_PREFIX`, `recentNotes` từ Task 2.
- Produces: `function pruneReadMarks(sessions)`. `loadAppPage()` trả `localStorage` có thêm `length` (getter) và `key(i)`.

- [ ] **Step 1: Thêm liệt kê khoá vào `localStorage` giả**

Trong `server/test/dom-harness.mjs`, thay:

```js
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
```

bằng:

```js
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    // Web Storage API thật có length/key(i); app.js dùng chúng để dọn mốc
    // "đã đọc" của những phiên không còn tồn tại. Map giữ thứ tự chèn, đúng
    // như trình duyệt.
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
```

- [ ] **Step 2: Viết test đang đỏ**

Thêm vào cuối `server/test/app-terminal.test.js`:

```js
// --- Dọn mốc đã đọc của những phiên không còn nữa ---------------------------
//
// Mỗi lần `/remote on` sinh một sessionId mới, nên không dọn thì localStorage
// tích một khoá vĩnh viễn cho mỗi phiên từng chạy trong đời máy này.

test('mốc đã đọc của phiên không còn trong danh sách lẫn lịch sử bị xoá', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-co-note', at: 1 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '1');        // phiên đang chạy
  localStorage.setItem('ccrc_read_s-co-note', '1');  // không còn chạy nhưng còn thông báo
  localStorage.setItem('ccrc_read_s-cu', '1');       // không ai nhắc tới nữa
  localStorage.setItem('ccrc_token', 'giu-nguyen');  // không thuộc tiền tố này

  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(localStorage.getItem('ccrc_read_s-1'), '1', 'phiên đang chạy phải giữ mốc');
  assert.equal(localStorage.getItem('ccrc_read_s-co-note'), '1',
    'còn thông báo trong lịch sử thì mốc vẫn có tác dụng');
  assert.equal(localStorage.getItem('ccrc_read_s-cu'), null, 'khoá mồ côi phải bị xoá');
  assert.equal(localStorage.getItem('ccrc_token'), 'giu-nguyen', 'không được đụng khoá khác');
  assert.equal(byId['terminal-list'].children.length, 1, 'danh sách vẫn dựng bình thường');
});

test('nhiều khoá mồ côi liền nhau đều bị xoá — không bỏ sót vì chỉ số trượt', async () => {
  const box = { sessions: [], notes: [] };
  const { context, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  for (const id of ['a', 'b', 'c', 'd']) localStorage.setItem('ccrc_read_' + id, '1');

  await refreshBoth(context);

  assert.equal(localStorage.length, 0, 'xoá giữa vòng lặp key(i) là cách bỏ sót kinh điển');
});
```

- [ ] **Step 3: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/app-terminal.test.js`
Expected: FAIL — `ccrc_read_s-cu` vẫn còn (`'1' !== null`), `localStorage.length` là 4.

- [ ] **Step 4: Thêm `pruneReadMarks()` và gọi nó**

Thêm vào cuối khối "Phiên nào đang có thông báo chưa đọc" trong `server/public/app.js` (ngay sau `hasUnread`):

```js
// Mỗi `/remote on` sinh một sessionId mới, nên không dọn thì localStorage tích
// một khoá vĩnh viễn cho mỗi phiên từng chạy. Chỉ xoá khoá mà CẢ danh sách
// phiên hiện tại LẪN lịch sử thông báo đều không nhắc tới — khi cả hai đều
// không nhắc thì mốc đã đọc đó không còn ảnh hưởng tới bất cứ thứ gì hiển thị
// được, nên xoá là an toàn.
function pruneReadMarks(sessions) {
  const keep = new Set();
  for (const s of sessions) if (s && s.sessionId) keep.add(s.sessionId);
  for (const n of recentNotes) if (n && n.sessionId) keep.add(n.sessionId);
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (typeof k === 'string' && k.startsWith(READ_PREFIX)
        && !keep.has(k.slice(READ_PREFIX.length))) {
      doomed.push(k);
    }
  }
  // Xoá SAU khi duyệt xong: removeItem() giữa chừng làm chỉ số của key(i)
  // trượt và bỏ sót đúng khoá kế tiếp.
  for (const k of doomed) localStorage.removeItem(k);
}
```

Trong `renderTerminalList()`, thay:

```js
async function renderTerminalList(sessions) {
  const list = $('terminal-list');
  const empty = $('terminal-empty');
  list.textContent = '';
```

bằng:

```js
async function renderTerminalList(sessions) {
  const list = $('terminal-list');
  const empty = $('terminal-empty');
  list.textContent = '';

  // Đặt trước nhánh "không có phiên nào" bên dưới: danh sách rỗng là đúng lúc
  // có nhiều khoá mồ côi nhất.
  pruneReadMarks(sessions);
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `node --test server/test/app-terminal.test.js`
Expected: PASS.

- [ ] **Step 6: Bump phiên bản tài nguyên**

Trong `server/public/index.html`, đổi `style.css?v=8` → `style.css?v=9` (dòng 18) và `app.js?v=8` → `app.js?v=9` (dòng 71).

- [ ] **Step 7: Chạy toàn bộ test suite**

Run: `npm test`
Expected: PASS toàn bộ (server + hook + term).

- [ ] **Step 8: Commit**

```bash
git add server/public/app.js server/public/index.html server/test/dom-harness.mjs server/test/app-terminal.test.js
git commit -m "Prune read-markers for vanished sessions and bump asset version"
```

---

## Nghiệm thu thủ công (sau Task 5)

Không thay được test tự động, vì thứ cần kiểm là "nhìn có thấy không".

1. Deploy hub: `./deploy.sh` (hoặc rsync + rebuild như lần trước lên `ccrc.example.com`).
2. Trên máy dev: `/remote on ccrc` và `/remote on <tên khác>` ở một thư mục thứ hai → hai thẻ terminal trên PWA.
3. Để Claude dừng lại chờ ở **một** phiên → điện thoại nhận push.
4. Chạm vào thông báo → PWA mở → **đúng một thẻ** có chấm cam, thẻ kia không.
5. Bấm "Mở terminal" của thẻ đó → chấm biến mất; back về hub → vẫn không có chấm.
6. Ngồi trong terminal, để Claude dừng lại chờ lần nữa, rồi back về hub → **không** có chấm (đường "quay về").
7. Đóng hẳn PWA, để Claude dừng lại chờ, mở lại PWA → **có** chấm.
8. Cho máy dev ngủ tới khi thẻ chuyển sang "máy không phản hồi" mà vẫn còn chấm → chạm vào thẻ → chấm tắt.
