# Tự động hết hạn thông báo trong "Gần đây" — kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thông báo cũ hơn 24 giờ tự động biến mất khỏi danh sách "Gần đây" trên PWA, không cần hub restart.

**Architecture:** Tách lịch sử thông báo (hiện là một `Map` + hàm `remember()` nằm trực tiếp trong `server/src/index.js`) ra thành module riêng `server/src/notification-history.js`, theo đúng khuôn mẫu `createTerminalSessions()` đã có: factory nhận `now` có thể tiêm, `prune()` nội bộ chạy lười ở mọi điểm vào. Danh sách một user luôn mới nhất trước, nên `prune()` chỉ cần `pop()` từ cuối mảng khi mục cuối đã quá `HISTORY_TTL_MS`. `index.js` chỉ còn gọi `remember()`/`list()` qua instance của module mới. Không đụng phía PWA — nó đã hiển thị nguyên trạng response của `/api/notifications`.

**Tech Stack:** Node 20 + Express (hub), `node:test` (không mock/framework ngoài).

**Spec:** `docs/superpowers/specs/2026-08-02-het-han-thong-bao-design.md`

## Global Constraints

- Ngôn ngữ chú thích code và tên test: **tiếng Việt**. Commit message: **tiếng Anh**.
- `HISTORY_TTL_MS = 24 * 60 * 60 * 1000` (24 giờ), hardcode — không thêm biến môi trường hay tham số cấu hình cho ngưỡng này (spec §2, "Không có").
- `HISTORY_MAX = 50` giữ nguyên giá trị, hoạt động song song với TTL, không phụ thuộc nhau.
- Danh sách lịch sử của một user luôn ở thứ tự **mới nhất trước** (`unshift`) — mọi logic prune dựa vào bất biến này.
- Không đổi hình dạng `note` (`type`, `title`, `body`, `tag`, `at`, `sessionId?`) hay bất cứ route nào khác ngoài cách chúng đọc/ghi lịch sử.
- Không đụng `server/public/` (PWA), `term/`, `hook/` — ngoài phạm vi (spec §6, §8).
- Chạy test: `npm test --workspace server` (cả file), hoặc `node --test server/test/notify-api.test.js` (một file).

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/src/notification-history.js` | Lưu + prune lịch sử thông báo theo TTL và cap, factory nhận `now` tiêm được | 1 |
| `server/test/notify-api.test.js` | Test unit trực tiếp vào module mới (đồng hồ giả) + test HTTP cắt đúng `HISTORY_MAX` | 1, 2 |
| `server/src/index.js` | Bỏ `Map`/`remember()` cục bộ, dùng instance `createNotificationHistory()` | 2 |

---

### Task 1: Module `notification-history.js` với TTL + cap

**Files:**
- Create: `server/src/notification-history.js`
- Test: `server/test/notify-api.test.js` (thêm import ở đầu file, khối test unit ở cuối file)

**Interfaces:**
- Consumes: không có (task đầu tiên).
- Produces:
  - `createNotificationHistory({ now = () => Date.now() } = {})` → `{ remember(userName, note), list(userName) }`.
  - `remember(userName, note)`: thêm `note` vào đầu danh sách của `userName`, gán `at: now()`, cắt còn tối đa `HISTORY_MAX`, rồi tự prune mục quá hạn. Không trả về gì.
  - `list(userName)`: prune rồi trả mảng (mới nhất trước) của `userName`, `[]` nếu chưa từng có.
  - Named export `HISTORY_MAX = 50`, `HISTORY_TTL_MS = 24 * 60 * 60 * 1000`.
  - Task 2 import ba cái tên này và gọi đúng hai hàm trên, không hàm nào khác.

- [ ] **Step 1: Viết test đang đỏ**

Ở đầu `server/test/notify-api.test.js`, thêm vào khối import hiện có (sau dòng `import { fileURLToPath } from 'node:url';`):

```js
import { createNotificationHistory, HISTORY_MAX, HISTORY_TTL_MS } from '../src/notification-history.js';
```

Ở **cuối file** `server/test/notify-api.test.js`, thêm:

```js
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

test('[unit] list() trả mảng rỗng cho user chưa từng có thông báo', () => {
  const history = createNotificationHistory();
  assert.deepEqual(history.list('ai-do-chua-tung'), []);
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `node --test server/test/notify-api.test.js`
Expected: FAIL ngay từ lúc import — `Cannot find module '../src/notification-history.js'`.

- [ ] **Step 3: Viết module**

Tạo `server/src/notification-history.js`:

```js
// Lịch sử thông báo cho "Gần đây" trên PWA. Chỉ tồn tại trong RAM — một hub
// restart xoá sạch là chấp nhận được, đây không phải một bản ghi cần bền.
//
// Hai cơ chế cắt bớt hoạt động song song, không phụ thuộc nhau:
//   - HISTORY_MAX: không bao giờ giữ quá 50 mục một user, dù mới tới đâu.
//   - HISTORY_TTL_MS: một mục quá 24 giờ tự biến mất, dù danh sách chưa đầy.
//
// Theo đúng khuôn mẫu server/src/terminal-sessions.js: factory nhận `now` có
// thể tiêm để test dùng đồng hồ giả, và prune() chạy LƯỜI — gọi lại ở đầu mỗi
// hàm public thay vì đặt trên setInterval, vì không có gì để dọn khi không ai
// đang nhìn vào nó.
export const HISTORY_MAX = 50;
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

export function createNotificationHistory({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Array<any>>} userName -> notifications, newest first */
  const byUser = new Map();

  // Danh sách luôn mới nhất trước (remember() dùng unshift), nên mục quá hạn
  // luôn nằm ở CUỐI mảng — pop() từ cuối, dừng ngay khi gặp mục còn hạn, thay
  // vì duyệt và lọc toàn bộ mảng mỗi lần.
  function prune(userName) {
    const list = byUser.get(userName);
    if (!list) return;
    const t = now();
    while (list.length && t - list[list.length - 1].at > HISTORY_TTL_MS) list.pop();
    if (list.length === 0) byUser.delete(userName);
  }

  return {
    remember(userName, note) {
      const list = byUser.get(userName) || [];
      list.unshift({ ...note, at: now() });
      if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
      byUser.set(userName, list);
      prune(userName);
    },

    list(userName) {
      prune(userName);
      return byUser.get(userName) || [];
    },
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `node --test server/test/notify-api.test.js`
Expected: PASS toàn bộ file — bảy test unit mới, cộng mọi test HTTP cũ (chưa đụng `index.js` nên không ảnh hưởng).

- [ ] **Step 5: Commit**

```bash
git add server/src/notification-history.js server/test/notify-api.test.js
git commit -m "Add notification-history module with TTL-based pruning"
```

---

### Task 2: Nối vào hub, bỏ lịch sử cục bộ trong `index.js`

**Files:**
- Modify: `server/src/index.js:11` (khối import), `server/src/index.js:117-129` (khối `HISTORY_MAX`/`history`/`remember()`), `server/src/index.js:211` (route `POST /notify`), `server/src/index.js:230` (route `GET /api/notifications`)
- Test: `server/test/notify-api.test.js` (thêm một test HTTP mới)

**Interfaces:**
- Consumes: `createNotificationHistory`, `HISTORY_MAX`, `HISTORY_TTL_MS` từ Task 1 (`server/src/notification-history.js`).
- Produces: không có task nào sau task này.

- [ ] **Step 1: Viết test đang đỏ (khoá lại hành vi cắt 50 mục qua HTTP)**

Hiện chưa có test nào kiểm `HISTORY_MAX` ở tầng HTTP — chỉ có test unit vừa thêm ở Task 1. Thêm vào `server/test/notify-api.test.js`, ngay sau test `'sessionId dài bất thường bị cắt như title/body — không nhận chuỗi tuỳ ý vào RAM'`:

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận đã XANH sẵn (chưa đổi `index.js`)**

Run: `node --test server/test/notify-api.test.js`
Expected: PASS — code hiện tại (`Map` + `remember()` cục bộ) đã cắt đúng 50 mục từ trước, test này chỉ khoá lại hành vi đó thành test tự động trước khi refactor bên dưới, để bước 4 chứng minh refactor không làm hỏng nó.

- [ ] **Step 3: Nối `index.js` vào module mới**

Trong `server/src/index.js`, thêm vào khối import (dòng 11, ngay sau `import { createTerminalSessions } from './terminal-sessions.js';`):

```js
import { createNotificationHistory } from './notification-history.js';
```

Thay khối (dòng 117-129):

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
```

bằng:

```js
// ---------------------------------------------------------------------------
// Notification history — logic đầy đủ (TTL 24h + cap 50) nằm trong
// notification-history.js, cùng khuôn mẫu với createTerminalSessions().
const notificationHistory = createNotificationHistory();
```

Trong route `POST /notify` (dòng 211), thay:

```js
  remember(user.name, note);
```

bằng:

```js
  notificationHistory.remember(user.name, note);
```

Trong route `GET /api/notifications` (dòng 230), thay:

```js
  res.json({ items: history.get(user.name) || [] });
```

bằng:

```js
  res.json({ items: notificationHistory.list(user.name) });
```

- [ ] **Step 4: Chạy toàn bộ test suite của server, xác nhận XANH**

Run: `npm test --workspace server`
Expected: PASS toàn bộ — bảy test unit của Task 1, test cắt 50 mục vừa thêm, và mọi test HTTP có từ trước (`sessionId`, `viewing`, 401, payload dị dạng, `/api/me`, …), không cái nào phải sửa.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.js server/test/notify-api.test.js
git commit -m "Wire the hub's /notify and /api/notifications routes to notification-history"
```

---

## Nghiệm thu thủ công (sau Task 2)

Không thay được test tự động, vì thứ cần kiểm là "thời gian trôi qua thật".

1. Deploy hub: rsync + `docker compose` rebuild (project `ccrc`) như các lần trước.
2. Gửi một thông báo thật (để Claude dừng lại chờ ở một phiên `/remote on`), mở PWA → thấy nó trong "Gần đây".
3. Không cần đợi đủ 24 giờ để tin cơ chế đúng — điều đó đã được bảy test unit ở Task 1 khoá lại bằng đồng hồ giả. Bước này chỉ xác nhận hub mới không vỡ luồng `/notify` → "Gần đây" bình thường sau khi deploy.
4. (Tuỳ chọn, nếu muốn thấy tận mắt) Chờ qua một thông báo cũ hơn 24 giờ thật, mở lại PWA → mục đó không còn trong "Gần đây".
