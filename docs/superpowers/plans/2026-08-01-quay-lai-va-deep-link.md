# Quay lại từ terminal + bấm thông báo mở thẳng terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang terminal không bao giờ rơi vào màn hình trắng khi quay lại, và bấm một thông báo đẩy mở thẳng terminal của đúng phiên đã gửi nó.

**Architecture:** PWA truyền hub origin kèm token qua fragment; `term.js` bỏ hẳn `history.back()` và điều hướng tường minh về hub, cộng một mục lịch sử đệm để nuốt cử chỉ back của cửa sổ trình duyệt phụ trên iOS. Ở chiều thông báo, `sw.js` giữ lại `sessionId` vốn đã có sẵn trong push payload và chuyển nó cho trang hub, trang hub tự bấm "Mở terminal" hộ người dùng.

**Tech Stack:** JavaScript trình duyệt thuần (không bundler, không module), `node:test` + `node:vm` với fake DOM tự viết (`server/test/dom-harness.mjs`, `term/test/dom-harness.mjs`).

**Spec:** `docs/superpowers/specs/2026-08-01-quay-lai-va-deep-link-design.md`

## Global Constraints

- Mọi chuỗi hiển thị cho người dùng: **tiếng Việt**. Comment: theo phong cách file đang sửa (cả hai file đều trộn Việt/Anh — giải thích *vì sao*, không phải *cái gì*).
- Commit message: **tiếng Anh**, một dòng tiêu đề + thân giải thích lý do.
- Không đụng `term/bin/`, không đụng `server/src/`, không đổi giao thức WebSocket, không đổi cách ký token.
- `server/public/app.js` và `server/public/style.css` được nạp qua `?v=` trong `server/public/index.html`. Bất kỳ thay đổi nào ở `app.js` **bắt buộc** bump `?v=9` → `?v=10` (Task 7), nếu không PWA đã cài vẫn chạy bản cũ trong cache.
- `term.js` không cần version: daemon phục vụ file tươi từ đĩa mỗi lượt.
- Chạy test: `npm test --workspace server` và `npm test --workspace term` (toàn bộ: `npm test` ở gốc).
- Chuỗi kiểm tra hub origin phải chặt đúng như `isTailnetTerminalUrl()` ở chiều ngược lại: chỉ `https:`, không user/pass, path phải là `/`.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/public/app.js` | Ghép hub origin vào fragment; đọc `?open=`; nghe message từ SW; tự mở phiên | 1, 6 |
| `server/public/sw.js` | Giữ `sessionId` trong notification data; điều hướng khi bấm | 5 |
| `server/public/index.html` | Bump `?v=` | 7 |
| `term/public/term.js` | Đọc/kiểm/lưu hub origin; `goBack()` điều hướng; mục lịch sử đệm + `popstate` | 1, 2, 3 |
| `server/test/dom-harness.mjs` | Thêm `location.origin/pathname/search`, `history`, `URLSearchParams` vào sandbox | 1, 6 |
| `term/test/dom-harness.mjs` | Thêm `URL`, `location.href`, `history.pushState`, tuỳ chọn `hubSaved` | 1, 3 |
| `server/test/app-terminal.test.js` | Test fragment mang `h=`; test bốn nhánh `?open=` | 1, 6 |
| `server/test/sw.test.js` (mới) | Test `sw.js` bằng `self` giả | 5 |
| `term/test/term-page.test.js` | Test đọc `h`, từ chối `h` xấu, `goBack()` điều hướng, `popstate` | 1, 2, 3 |

---

### Task 1: Hub origin đi kèm token, được đọc và kiểm ở trang terminal

> **ĐÃ BỊ GỠ HẲN** (đo trên iPhone thật ngày 2026-08-01,
> `.superpowers/sdd/2026-08-01-quay-lai-va-deep-link/revert-back-nav-brief.md`
> và `revert-back-nav-report.md`). Cơ chế hub origin ở Task này — và mọi thứ nó
> đưa xuống cho Task 2, 3 dùng (`currentHub()`, `validHubOrigin()`, `HUB_KEY`,
> route `GET /hub` phía daemon) — không còn tồn tại trong code. Back từ
> terminal giờ để iOS tự lo bằng nút Done của cửa sổ phụ. Nội dung dưới đây là
> hồ sơ lịch sử, không mô tả code hiện tại.

**Files:**
- Modify: `server/public/app.js:389` (dòng `location.href = session.url + '#t=' + …`)
- Modify: `server/public/dom-harness` → `server/test/dom-harness.mjs:241` (đối tượng `location`)
- Modify: `term/public/term.js:99-118` (`readAndClearTicket`), `term/public/term.js:411-425` (`hashchange`)
- Modify: `term/test/dom-harness.mjs:311` (`location`), `:328-347` (contextObj)
- Test: `server/test/app-terminal.test.js`, `term/test/term-page.test.js`

**Interfaces:**
- Produces (dùng ở Task 2, 3): trong `term.js` — `currentHub()` trả về chuỗi origin `https://…` (không dấu `/` cuối) hoặc `null`; `validHubOrigin(raw)` trả origin đã chuẩn hoá hoặc `null`; hằng `HUB_KEY = 'ccrc_hub'` là khoá sessionStorage.
- Consumes: `safeStorageGet/safeStorageSet` đã có sẵn trong `term.js` (khai báo bằng `function` nên hoisted — gọi được từ trên xuống).

- [ ] **Step 1: Mở rộng fake DOM của server cho `location.origin`**

Trong `server/test/dom-harness.mjs`, thay dòng khai báo `location` (hiện là `const location = { href: '', reloads: 0, reload() { this.reloads += 1; } };`) bằng:

```js
  // `origin` là thứ app.js ghép vào fragment để trang terminal biết đường
  // quay về; `pathname`/`search` là thứ nó đọc `?open=` rồi xoá đi. Cả ba đều
  // là thuộc tính chuẩn của `location` thật, vắng mặt ở đây chỉ vì trước
  // đây app.js chưa dùng tới.
  const location = {
    href: '',
    origin: 'https://hub.example.com',
    pathname: '/',
    search: '',
    reloads: 0,
    reload() { this.reloads += 1; },
  };
```

- [ ] **Step 2: Viết test thất bại — fragment phải mang cả `h=`**

Thêm vào cuối `server/test/app-terminal.test.js`:

```js
// --- hub origin đi kèm token (spec §2.3) ------------------------------------
//
// Trang terminal nằm ở origin khác, trong một cửa sổ trình duyệt phụ có lịch
// sử riêng gần như rỗng. Nó không thể tự đoán đường về; PWA phải nói cho nó
// biết, và fragment là chỗ duy nhất đi cùng chuyến điều hướng đó mà không
// bao giờ được gửi lên server nào.
test('bấm Mở terminal: fragment mang cả token lẫn hub origin', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  await openButtonOf(card).onclick();

  const hash = location.href.slice(location.href.indexOf('#') + 1);
  const params = new URLSearchParams(hash);
  assert.ok(params.get('t'), 'phải có token trong fragment');
  assert.equal(params.get('h'), 'https://hub.example.com');
});
```

- [ ] **Step 3: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace server 2>&1 | grep -A5 "hub origin"`
Kỳ vọng: FAIL — `params.get('h')` là `null`.

- [ ] **Step 4: Ghép hub origin vào fragment**

Trong `server/public/app.js`, thay dòng cuối khối `try` của `openTerminal()`:

```js
    // Fragment, not query string — never sent to a server, stays out of most
    // logs, and term.js strips it from the address bar on arrival (spec §6).
    //
    // `h` là đường về. Trang terminal nằm ở origin khác, và trên iOS nó mở
    // trong một cửa sổ trình duyệt phụ có lịch sử RIÊNG, gần như rỗng —
    // `history.back()` ở đó rơi vào trang trắng. Nó không suy ra được hub ở
    // đâu (referrer bị chặn khi hạ cấp https → http), nên chỗ duy nhất nói
    // cho nó biết là ngay đây, đi cùng token.
    location.href = session.url + '#t=' + encodeURIComponent(token)
      + '&h=' + encodeURIComponent(location.origin);
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace server`
Kỳ vọng: PASS toàn bộ (test cũ `#t=<token>` vẫn xanh vì nó khớp bằng regex có `(&|$)`; nếu có test nào khớp `$` cứng thì sửa nó sang `URLSearchParams` như Step 2).

- [ ] **Step 6: Mở rộng fake DOM của term**

Trong `term/test/dom-harness.mjs`:

(a) thay khai báo `location` (dòng ~311) bằng:

```js
  // `href` là thứ term.js GHI vào để điều hướng về hub (goBack) — test đọc
  // lại nó để chứng minh trang đã đi đâu, thay vì phải giả lập cả một trình
  // duyệt. Giá trị khởi tạo phản chiếu đúng hash được truyền vào.
  const location = {
    hash,
    href: 'http://localhost:8730/' + hash,
    pathname: '/',
    search: '',
    host: 'localhost:8730',
    protocol: 'http:',
  };
```

(b) thêm `pushState` vào đối tượng `history` (ngay dưới `replaceState`):

```js
    pushState(state, title, url) {
      pushCalls.push({ state, title, url });
      // Mục đệm KHÔNG đổi hash: nó chỉ tồn tại để cử chỉ back có gì đó để
      // pop ra thay vì rơi khỏi trang.
    },
```

và khai báo `const pushCalls = [];` cạnh `const historyCalls = [];`, rồi trả `pushCalls` ra trong đối tượng return (cạnh `historyCalls`).

(c) thêm `URL` vào `contextObj` (cạnh `TextEncoder`):

```js
    // term.js dùng `new URL(...)` để kiểm hub origin nhận từ fragment. Một vm
    // context trống không có sẵn global nào, kể cả global chuẩn của trình
    // duyệt — thiếu nó thì mọi origin, kể cả origin đúng, đều bị từ chối.
    URL,
```

- [ ] **Step 7: Viết test thất bại — term.js đọc và kiểm `h`**

Thêm vào `term/test/term-page.test.js`:

```js
// --- hub origin: đường về duy nhất của trang này (spec §2.3) ----------------

test('đọc hub origin từ fragment, xoá cả fragment, nhớ vào sessionStorage', () => {
  const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent('https://hub.example.com') });
  assert.equal(page.location.hash, '', 'fragment phải bị xoá sạch, không sót h=');
  assert.equal(page.sessionStorage.getItem('ccrc_hub'), 'https://hub.example.com');
  // Token vẫn phải đi vào kết nối như trước — thêm tham số không được làm
  // hỏng việc đọc token.
  assert.match(page.ws()[0].url, /[?&]token=ve1(&|$)/);
});

test('fragment chỉ có token (bản cũ) vẫn chạy, không có hub origin', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  assert.equal(page.sessionStorage.getItem('ccrc_hub'), null);
  assert.match(page.ws()[0].url, /[?&]token=ve1(&|$)/);
});

for (const xau of [
  'http://hub.example.com',            // không phải https
  'https://user:pw@hub.example.com',   // mang thông tin đăng nhập
  'https://hub.example.com/duong/dan', // có path — không phải origin thuần
  'javascript:alert(1)',               // không phải URL http(s)
  'khong-phai-url',
]) {
  test(`từ chối hub origin không hợp lệ: ${xau}`, () => {
    const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent(xau) });
    assert.equal(page.sessionStorage.getItem('ccrc_hub'), null,
      'một giá trị không hợp lệ không được trở thành đích điều hướng');
  });
}
```

- [ ] **Step 8: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace term 2>&1 | grep -B2 -A8 "hub origin"`
Kỳ vọng: FAIL — `sessionStorage.getItem('ccrc_hub')` là `null` ở test đầu.

- [ ] **Step 9: Đọc, kiểm và nhớ hub origin trong term.js**

Trong `term/public/term.js`, thay toàn bộ khối `readAndClearTicket` (dòng ~99-118) bằng:

```js
  // --- token + hub origin từ URL fragment, xoá ngay (spec §6) -------------
  //
  // Done first, before anything else — including terminal setup below — so
  // a ticket never lingers in the address bar or history regardless of
  // whether the rest of the page manages to come up.
  //
  // Fragment giờ mang hai thứ: `t` là token, `h` là origin của hub — đường về
  // duy nhất trang này có. Trên iOS, trang này mở trong một cửa sổ trình
  // duyệt phụ có lịch sử riêng gần như rỗng, và `document.referrer` không
  // tới nơi (hạ cấp https → http thì trình duyệt không gửi gì), nên nếu PWA
  // không nói thì không có cách nào khác để biết.

  var HUB_KEY = 'ccrc_hub';
  var hubOrigin = null;

  var ticket = readAndClearTicket();

  function parseFragment(raw) {
    var out = {};
    String(raw || '').replace(/^#/, '').split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i === -1) return;
      try { out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1)); }
      catch (e) { /* phần bị mã hoá hỏng — bỏ qua đúng phần đó thôi */ }
    });
    return out;
  }

  // Đây là lối DUY NHẤT một giá trị từ bên ngoài quyết định được trang này
  // điều hướng đi đâu, nên nó bị siết đúng bằng mức isTailnetTerminalUrl()
  // của app.js siết chiều ngược lại: chỉ https, không thông tin đăng nhập,
  // và phải là origin THUẦN — có path nghĩa là ai đó đang cố lái đường về
  // sang một trang cụ thể, không phải danh sách phiên.
  function validHubOrigin(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    var u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  }

  function rememberHub(raw) {
    var ok = validHubOrigin(raw);
    if (!ok) return;
    hubOrigin = ok;
    safeStorageSet(HUB_KEY, ok);
  }

  // Nhớ qua cả lần nối lại và lần tải lại trang: fragment chỉ đi cùng đúng
  // một chuyến điều hướng, còn nhu cầu quay về thì tồn tại suốt phiên.
  function currentHub() {
    if (hubOrigin) return hubOrigin;
    var saved = validHubOrigin(safeStorageGet(HUB_KEY));
    if (saved) hubOrigin = saved;
    return hubOrigin;
  }

  function readAndClearTicket() {
    var hash = location.hash || '';
    if (!hash) return null;
    var p = parseFragment(hash);
    // Only replace when there was actually a fragment to strip — but when
    // there WAS one, it must never survive as a history entry or in the
    // visible address bar. replaceState (not setting location.hash) is what
    // avoids adding a new history entry.
    history.replaceState(null, '', location.pathname + (location.search || ''));
    if (p.h) rememberHub(p.h);
    return p.t || null;
  }
```

Chú ý thứ tự: `readAndClearTicket()` được gọi ở dòng `var ticket = …` phía trên phần khai báo `function` của nó — hợp lệ vì khai báo `function` được hoisted, giống hệt cách file này vẫn làm với `reportSize()`.

- [ ] **Step 10: Xác nhận `hashchange` không cần sửa logic**

`readAndClearTicket()` giờ tự gọi `rememberHub()`, nên listener `hashchange` (dòng ~411) đã nhận hub origin mới miễn phí. Chỉ sửa **một dòng comment** trong đó cho khỏi nói dối — dòng `// That does not reload the page — the browser fires 'hashchange' and` giữ nguyên, nhưng thêm ngay dưới `var fresh = readAndClearTicket();`:

```js
    // Cùng lượt này cũng cập nhật hub origin nếu fragment mới mang `h` —
    // readAndClearTicket() lo cả hai.
```

Không đổi dòng code nào ở bước này.

- [ ] **Step 11: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace term`
Kỳ vọng: PASS toàn bộ, kể cả test cũ `'đọc vé từ fragment URL rồi xoá khỏi thanh địa chỉ'` (nó khẳng định `historyCalls.length === 1` — vẫn đúng, vẫn đúng một lần `replaceState`).

- [ ] **Step 12: Commit**

```bash
git add server/public/app.js server/test/dom-harness.mjs server/test/app-terminal.test.js \
        term/public/term.js term/test/dom-harness.mjs term/test/term-page.test.js
git commit -m "Carry the hub origin alongside the attach token

The terminal page runs on a different origin, in an iOS in-app browser
window whose history is its own, and a downgraded https -> http referrer
tells it nothing. The fragment is the one channel that travels with the
navigation and never reaches a server, so the hub origin rides there —
validated on arrival as strictly as the phone validates the terminal URL."
```

---

### Task 2: `goBack()` điều hướng về hub thay vì `history.back()`

> **ĐÃ BỊ GỠ HẲN** — xem banner ở Task 1. `goBack()` và `canGoBack()` không còn
> tồn tại; back từ terminal không tự điều hướng đi đâu cả.

**Files:**
- Modify: `term/public/term.js:78-92` (`canGoBack`, `goBack`)
- Test: `term/test/term-page.test.js`

**Interfaces:**
- Consumes: `currentHub()` từ Task 1.
- Produces: `goBack()` giờ ghi `location.href`; `canGoBack()` trả `true` khi và chỉ khi có hub origin hợp lệ.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `term/test/term-page.test.js`:

```js
test('phiên đóng + có hub origin → điều hướng về hub, KHÔNG gọi history.back()', () => {
  const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent('https://hub.example.com') });
  const ws = page.ws()[0];
  ws.open();
  ws.dropped(4001); // CLOSE_SESSION_ENDED
  assert.match(page.trangthai.textContent, /đang quay lại danh sách/);
  assert.equal(page.quaylai.hidden, false, 'nút quay lại phải hiện ra');

  page.clock.fireNext(); // hết 1.5s
  assert.equal(page.location.href, 'https://hub.example.com');
  assert.equal(page.backCalls.length, 0, 'history.back() rơi vào trang trắng — không được gọi nữa');
});

test('phiên đóng + KHÔNG có hub origin → đứng yên, nói rõ cách mở lại', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  const ws = page.ws()[0];
  ws.open();
  ws.dropped(4001);
  assert.match(page.trangthai.textContent, /remote on/);
  assert.equal(page.location.href.includes('hub'), false, 'không có đường về thì không được đoán bừa');
  assert.equal(page.backCalls.length, 0);
});

test('bấm nút "quay lại" → điều hướng về hub', () => {
  const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent('https://hub.example.com') });
  page.quaylai.dispatch('click');
  assert.equal(page.location.href, 'https://hub.example.com');
});
```

Ghi chú: `historyLength` không còn ảnh hưởng tới hai test này — đó chính là điều đang được chứng minh.

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace term 2>&1 | grep -B2 -A10 "history.back"`
Kỳ vọng: FAIL — `page.location.href` vẫn là URL cũ, `backCalls.length` là 1.

- [ ] **Step 3: Sửa `canGoBack` và `goBack`**

Trong `term/public/term.js`, thay hai hàm (dòng ~76-92) bằng:

```js
  // `document.referrer` KHÔNG dùng được ở đây: hub chạy https còn trang này
  // chạy http trên IP tailnet, và chính sách referrer mặc định không gửi gì
  // khi hạ cấp https → http. `history.length` từng được dùng thay thế, và đó
  // là một phép đoán SAI trên iOS: PWA mở trang này trong một cửa sổ trình
  // duyệt phụ có lịch sử riêng, thường đã sẵn một mục trống, nên phép đoán
  // trả về "quay lại được" rồi `history.back()` rơi thẳng vào trang trắng —
  // đúng lỗi người dùng gặp. Giờ chỉ còn một nguồn sự thật: hub origin do
  // PWA nói cho biết qua fragment.
  function canGoBack() {
    return !!currentHub();
  }

  function goBack() {
    var hub = currentHub();
    // Không có đường về thì đứng yên: câu thông báo trên màn hình vẫn còn
    // nguyên, và đó là thứ trung thực hơn một cú nhảy vào hư không.
    if (!hub) return;
    location.href = hub;
  }
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace term`
Kỳ vọng: PASS. Nếu có test cũ dựa vào `historyLength: 1` để chứng minh nhánh "không quay lại được", nó vẫn xanh khi fragment không có `h` — kiểm lại và sửa fixture nếu cần (đổi từ `historyLength: 1` sang bỏ `h` khỏi hash).

- [ ] **Step 5: Commit**

```bash
git add term/public/term.js term/test/term-page.test.js
git commit -m "Navigate back to the hub instead of calling history.back()

history.length was a guess, and on iOS it guesses wrong: the in-app
browser window the PWA opens this page in carries its own history, often
with a blank entry already in it, so the guess said 'yes' and back landed
on a white page. The hub origin from the fragment is the only thing that
actually knows where back goes."
```

---

### Task 3: Mục lịch sử đệm — nút Back của cửa sổ phụ cũng về danh sách

> **ĐÃ BỊ GỠ HẲN** — xem banner ở Task 1. Không còn mục lịch sử đệm, không còn
> listener `popstate`; cử chỉ back của cửa sổ phụ giữ nguyên hành vi gốc của
> iOS (thoát về PWA qua nút Done).

**Files:**
- Modify: `term/public/term.js` (ngay sau khối `readAndClearTicket` của Task 1)
- Test: `term/test/term-page.test.js`

**Interfaces:**
- Consumes: `currentHub()`, `goBack()` từ Task 1 và 2; `history.pushState` (harness đã thêm ở Task 1 Step 6b).

- [ ] **Step 1: Viết test thất bại**

Thêm vào `term/test/term-page.test.js`:

```js
// Sửa goBack() thôi chưa đủ: nút Back trên thanh công cụ của cửa sổ phụ, và
// cử chỉ vuốt cạnh trái, là của TRÌNH DUYỆT — chúng không đi qua code này.
// Một mục lịch sử đệm cho chúng thứ để pop ra, và popstate biến cú pop đó
// thành một chuyến đi có đích.
test('có hub origin → đẩy một mục lịch sử đệm, popstate đưa về hub', () => {
  const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent('https://hub.example.com') });
  assert.equal(page.pushCalls.length, 1, 'phải có đúng một mục đệm');
  page.window.dispatch('popstate');
  assert.equal(page.location.href, 'https://hub.example.com');
});

test('không có hub origin → KHÔNG đệm gì, back giữ nguyên hành vi trình duyệt', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  assert.equal(page.pushCalls.length, 0,
    'mở trực tiếp bằng URL thì không được giam người dùng lại trong trang này');
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace term 2>&1 | grep -B2 -A8 "lịch sử đệm"`
Kỳ vọng: FAIL — `pushCalls.length` là 0.

- [ ] **Step 3: Cài mục đệm**

Trong `term/public/term.js`, ngay sau khai báo `function readAndClearTicket() { … }` (tức sau khi `ticket` đã được đọc và hub origin đã được nhớ), thêm:

```js
  // --- nuốt cử chỉ back của cửa sổ trình duyệt phụ ------------------------
  //
  // goBack() chỉ chi phối được đường ĐI của chính trang này. Nút Back trên
  // thanh công cụ, và cử chỉ vuốt cạnh trái, là của trình duyệt: chúng pop
  // lịch sử trước khi bất cứ dòng nào ở đây chạy. Trong cửa sổ phụ mà iOS mở
  // cho một điều hướng ra ngoài scope của PWA, thứ nằm dưới cùng ngăn lịch
  // sử đó là một trang trống — đúng màn hình trắng người dùng báo.
  //
  // Một mục đệm cho cử chỉ đó thứ để pop ra mà không rời trang, rồi popstate
  // biến nó thành chuyến đi về danh sách phiên — thứ người dùng vốn muốn.
  //
  // CHỈ khi có hub origin, nghĩa là trang được mở từ PWA. Mở trực tiếp bằng
  // URL gõ tay hay bookmark thì không có đích để đi, và giam người dùng
  // trong một trang họ đang cố rời khỏi là hành vi tệ hơn hẳn cái nó sửa.
  if (currentHub()) {
    try {
      history.pushState({ ccrc: 1 }, '', location.pathname + (location.search || ''));
    } catch (e) { /* không đẩy được thì nút Back trở lại hành vi cũ — không tệ hơn */ }
    window.addEventListener('popstate', function () { goBack(); });
  }
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace term`
Kỳ vọng: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add term/public/term.js term/test/term-page.test.js
git commit -m "Give the in-app browser's back gesture somewhere to land

The toolbar arrow and the left-edge swipe pop history before any line
here runs, and in the window iOS opens for an out-of-scope navigation the
thing underneath is a blank page. A sentinel entry absorbs the pop and
popstate turns it into the trip the user meant to take. Only when the
page was opened from the PWA — trapping someone who typed the URL is
worse than the bug."
```

---

### Task 4: Nghiệm thu tay trên iPhone — đo ẩn số localStorage (CỔNG CHẶN)

> **ĐÃ CHẠY, RỒI CƠ CHẾ NÓ ĐO BỊ GỠ HẲN.** Step 3 chạy trên máy thật ngày
> 2026-08-01: kết quả là **A** (cửa sổ phụ dùng chung phiên đăng nhập với
> PWA) — ghi trong spec §2.4. Nhưng cùng lượt đo đó lộ ra hai lỗi khác của cơ
> chế Task 1-3 (xem
> `.superpowers/sdd/2026-08-01-quay-lai-va-deep-link/revert-back-nav-brief.md`),
> nên toàn bộ cơ chế đã bị gỡ thay vì đóng cổng đi tiếp. Step 4 (phương án dự
> phòng cho kết quả B) không còn áp dụng.

Task này **không viết code**. Nó trả lời câu hỏi §2.4 của spec: cửa sổ trình duyệt phụ có dùng chung `localStorage` với PWA không. Task 5-7 không phụ thuộc vào kết quả này, nên có thể chạy song song; nhưng **không được coi việc 1 là xong** trước khi qua cổng này.

⚠️ Bước 2 dưới đây là **deploy lên hub production** — phải hỏi Huy trước, theo quy ước của workspace.

- [ ] **Step 1: Chạy toàn bộ test một lượt cuối**

Chạy: `npm test`
Kỳ vọng: PASS cả ba workspace.

- [ ] **Step 2: Hỏi Huy rồi deploy hub, và cài lại daemon trên máy dev**

Hub mang `app.js` mới; máy dev mang `term.js` mới. Không đủ cả hai thì fragment không có `h` và không có gì để đo.

- [ ] **Step 3: Đo trên iPhone**

1. Mở PWA đã cài ra màn hình chính (không phải tab Safari)
2. Bấm "Mở terminal" → cửa sổ phụ mở ra, terminal chạy
3. Bấm mũi tên Back ở thanh công cụ đáy

Ghi lại **một trong ba**:
- **A. Hiện danh sách phiên, đã đăng nhập** → localStorage dùng chung. Việc 1 xong, đóng cổng.
- **B. Hiện màn hình đăng nhập, đòi token** → localStorage KHÔNG dùng chung. Sang Step 4.
- **C. Vẫn trắng** → giả thuyết sai ở chỗ khác. Dừng lại, mở điều tra mới với `superpowers:systematic-debugging`, không vá mù.

- [ ] **Step 4 (CHỈ khi kết quả là B): phương án dự phòng**

Đổi `goBack()` trong `term/public/term.js` thành hiện chỉ dẫn thay vì điều hướng, giữ nguyên mục đệm của Task 3 (nó vẫn là thứ chặn màn hình trắng):

```js
  function goBack() {
    // Cửa sổ phụ không dùng chung phiên đăng nhập với PWA (đo được ở nghiệm
    // thu 2026-08-01), nên điều hướng về hub chỉ đưa người dùng tới một màn
    // hình đòi token — tệ hơn cả trang trắng. Thứ đúng ở đây là chỉ đúng cử
    // chỉ đóng cửa sổ này.
    setStatus('Vuốt xuống để đóng cửa sổ này và quay về ứng dụng.', 'err');
  }
```

Sửa kèm hai test của Task 2 cho khớp (khẳng định nội dung `trangthai` thay vì `location.href`), chạy `npm test --workspace term`, rồi commit.

---

### Task 5: `sw.js` giữ `sessionId` và điều hướng khi bấm thông báo

**Files:**
- Modify: `server/public/sw.js:11-30`
- Test: `server/test/sw.test.js` (tạo mới)

**Interfaces:**
- Consumes: push payload từ hub đã có sẵn `sessionId` (`server/src/index.js:203`) — không sửa gì phía server.
- Produces (dùng ở Task 6): message gửi tới trang có dạng `{ type: 'ccrc_open', sessionId: '<sid>' }`; URL mở cửa sổ mới có dạng `/?open=<sid>` (đã `encodeURIComponent`).

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/sw.test.js`:

```js
// Chạy server/public/sw.js — một script service worker cổ điển, không module
// — trong node:vm với một `self` giả. Cùng kỹ thuật với dom-harness.mjs,
// nhưng `self` của service worker gần như không giao nhau với DOM của trang,
// nên nó có harness nhỏ riêng ngay trong file này thay vì làm phình cái kia.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js'),
  'utf8',
);

function loadSw({ windows = [] } = {}) {
  const shown = [];
  const opened = [];
  const listeners = {};
  const self_ = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting() {},
    registration: {
      showNotification(title, opts) { shown.push({ title, opts }); return Promise.resolve(); },
    },
    clients: {
      claim() { return Promise.resolve(); },
      matchAll() { return Promise.resolve(windows); },
      openWindow(url) { opened.push(url); return Promise.resolve(null); },
    },
  };
  const context = vm.createContext({ self: self_, console });
  vm.runInContext(SW_JS, context, { filename: 'sw.js' });

  // Gom mọi promise mà handler đưa vào waitUntil, để test await được thay vì
  // phải đoán thời điểm.
  const fire = async (type, event) => {
    const waits = [];
    const ev = Object.assign({ waitUntil: (p) => waits.push(p) }, event);
    for (const fn of (listeners[type] || [])) fn(ev);
    await Promise.all(waits);
  };
  return { fire, shown, opened };
}

const pushEvent = (data) => ({ data: { json: () => data } });

test('push có sessionId → notification mang nó trong data', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 'Xong', body: 'Claude đang chờ', sessionId: 's-1' }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Xong');
  assert.deepEqual(sw.shown[0].opts.data, { sessionId: 's-1' });
});

test('push không có sessionId → không bịa ra data', async () => {
  const sw = loadSw();
  await sw.fire('push', pushEvent({ title: 'Xong', body: 'x' }));
  assert.equal(sw.shown[0].opts.data, undefined);
});

test('bấm thông báo, chưa có cửa sổ nào → mở /?open=<sessionId>', async () => {
  const sw = loadSw({ windows: [] });
  let closed = 0;
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's 1/đặc biệt' }, close() { closed += 1; } },
  });
  assert.equal(closed, 1, 'thông báo phải được đóng lại');
  assert.deepEqual(sw.opened, ['/?open=' + encodeURIComponent('s 1/đặc biệt')]);
});

test('bấm thông báo, đã có cửa sổ → focus rồi nhắn cho nó, không mở thêm cửa sổ', async () => {
  const messages = [];
  let focused = 0;
  const win = { focus() { focused += 1; return Promise.resolve(); }, postMessage: (m) => messages.push(m) };
  const sw = loadSw({ windows: [win] });
  await sw.fire('notificationclick', {
    notification: { data: { sessionId: 's-1' }, close() {} },
  });
  assert.equal(focused, 1);
  assert.deepEqual(messages, [{ type: 'ccrc_open', sessionId: 's-1' }]);
  assert.deepEqual(sw.opened, [], 'đã có cửa sổ thì không được mở thêm cái nữa');
});

test('thông báo không thuộc phiên nào → mở app như cũ, không nhắn gì', async () => {
  const messages = [];
  const win = { focus() { return Promise.resolve(); }, postMessage: (m) => messages.push(m) };
  const sw1 = loadSw({ windows: [win] });
  await sw1.fire('notificationclick', { notification: { data: undefined, close() {} } });
  assert.deepEqual(messages, []);

  const sw2 = loadSw({ windows: [] });
  await sw2.fire('notificationclick', { notification: { data: {}, close() {} } });
  assert.deepEqual(sw2.opened, ['/']);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace server 2>&1 | grep -B2 -A8 "sessionId"`
Kỳ vọng: FAIL — `opts.data` là `undefined` ở test đầu.

- [ ] **Step 3: Sửa `sw.js`**

Thay hai handler cuối `server/public/sw.js` bằng:

```js
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const opts = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: true,
  };
  // `sessionId` đi cùng payload từ hub (server/src/index.js) khi thông báo
  // thuộc về một phiên terminal. Giữ nó lại ở đây là thứ duy nhất làm cho cú
  // bấm bên dưới biết phải mở phiên NÀO — trước bản này nó bị vứt đúng chỗ
  // này. Vắng mặt hẳn khi không thuộc phiên nào, không phải chuỗi rỗng.
  if (typeof data.sessionId === 'string' && data.sessionId) {
    opts.data = { sessionId: data.sessionId };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'CC Notify', opts));
});

// Bấm vào thông báo của một phiên terminal thì đi thẳng tới terminal của
// phiên đó — không phải "mở app rồi tự tìm lấy". Trang hub là chặng dừng bắt
// buộc chứ không phải đích: token đăng nhập nằm trong localStorage mà service
// worker không đọc được, nên việc ký token mở terminal phải do trang làm.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const sid = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : null;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      await wins[0].focus();
      // Trang đang chạy sẵn: không tải lại nó (sẽ mất trạng thái đang có),
      // chỉ nhắn cho nó biết phải mở phiên nào.
      if (sid && typeof wins[0].postMessage === 'function') {
        wins[0].postMessage({ type: 'ccrc_open', sessionId: sid });
      }
      return;
    }
    await self.clients.openWindow(sid ? '/?open=' + encodeURIComponent(sid) : '/');
  })());
});
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace server`
Kỳ vọng: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add server/public/sw.js server/test/sw.test.js
git commit -m "Keep the sessionId a push already carries, and act on it

The hub has been sending sessionId with every notification for a while;
the service worker threw it away and opened the app's front door. Now a
tap carries the session through to the page, which is the side that holds
the login token and can sign its way into that terminal."
```

---

### Task 6: Trang hub tự mở phiên được chỉ định

**Files:**
- Modify: `server/public/app.js` (thêm khối mới; sửa `refreshTerminal()` ~dòng 141-147 và `doRefreshTerminal()` ~dòng 149-178)
- Modify: `server/test/dom-harness.mjs` (thêm `history`, `URLSearchParams` vào sandbox; tuỳ chọn `search`)
- Test: `server/test/app-terminal.test.js`

**Interfaces:**
- Consumes: message `{ type: 'ccrc_open', sessionId }` và URL `/?open=<sid>` từ Task 5; `pairedMachines()`, `openTerminal(session, btn)`, `refreshTerminal()` đã có sẵn trong `app.js`.
- Produces: `consumePendingOpen(sessions)` — async, tiêu thụ `pendingOpen` đúng một lần; `showTerminalErr(msg)` — đặt text và bỏ `hidden` khỏi `#terminal-err`.

- [ ] **Step 1: Mở rộng fake DOM của server**

Trong `server/test/dom-harness.mjs`:

(a) thêm tham số `search = ''` vào `loadAppPage({ … })`, và dùng nó khi dựng `location` (Task 1 Step 1 đã tạo đối tượng này):

```js
    search,
```

(b) thêm `history` giả cạnh `location`:

```js
  // app.js xoá `?open=` khỏi thanh địa chỉ ngay sau khi đọc, để một lần nạp
  // lại trang không mở lại terminal lần nữa. Test đọc `replaceCalls` để
  // chứng minh việc xoá đó có xảy ra.
  const replaceCalls = [];
  const history = {
    replaceState(state, title, url) {
      replaceCalls.push({ state, title, url });
      location.search = '';
    },
  };
```

(c) thêm vào `contextObj`: `history,` và `URLSearchParams,`

(d) trả `replaceCalls` ra trong đối tượng return.

- [ ] **Step 2: Viết test thất bại**

Thêm vào `server/test/app-terminal.test.js`:

```js
// --- bấm thông báo → mở thẳng terminal của phiên đó (spec §3) --------------

test('?open=<sid> → tự mở đúng phiên, và xoá tham số khỏi thanh địa chỉ', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, location, replaceCalls } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();

  assert.equal(replaceCalls.length, 1, 'phải xoá ?open= ngay khi đọc xong');
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'phải điều hướng thẳng vào terminal, đã có ' + location.href);
});

test('?open= tiêu thụ đúng một lần — refresh lần hai không mở lại', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  location.href = '';           // giả lập "đã đi rồi, giờ quay lại"
  await context.refreshTerminal();
  assert.equal(location.href, '', 'lần refresh sau không được tự điều hướng lần nữa');
});

test('?open= trỏ tới phiên không còn trong danh sách → nói rõ phiên đã đóng', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE_2] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-khong-ton-tai' });
  await pairMachine(context, 'may-dev');
  await context.refreshTerminal();
  assert.equal(location.href, '', 'không được điều hướng đi đâu cả');
  assert.equal(byId['terminal-err'].classList.contains('hidden'), false);
  assert.match(byId['terminal-err'].textContent, /đã đóng/);
});

test('?open= trỏ tới phiên máy không phản hồi → nói rõ, không điều hướng', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_DEAD] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_DEAD.machine);
  await context.refreshTerminal();
  assert.equal(location.href, '');
  assert.match(byId['terminal-err'].textContent, /không phản hồi/);
});

test('?open= nhưng máy chưa ghép → chỉ đúng việc cần làm, không ký gì', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  // KHÔNG gọi pairMachine — đây chính là điều đang được kiểm.
  await context.refreshTerminal();
  assert.equal(location.href, '');
  assert.match(byId['terminal-err'].textContent, /Ghép máy này/);
});

test('GET /api/terminal hỏng → giữ nguyên yêu cầu mở, không kết luận phiên đã đóng', async () => {
  let lan = 0;
  const fetchImpl = makeFetch(async () => {
    lan += 1;
    if (lan === 1) throw new Error('network down');
    return { status: 200, body: { sessions: [SESSION_ALIVE] } };
  });
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  assert.match(byId['terminal-err'].textContent, /Không lấy được trạng thái/);
  await context.refreshTerminal();
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'lượt sau thành công thì yêu cầu mở phải vẫn còn hiệu lực');
});
```

- [ ] **Step 3: Chạy test, xác nhận đỏ**

Chạy: `npm test --workspace server 2>&1 | grep -B2 -A8 "?open"`
Kỳ vọng: FAIL — `location.href` rỗng ở test đầu (chưa có gì tự mở).

- [ ] **Step 4: Thêm khối "mở thẳng một phiên" vào app.js**

Trong `server/public/app.js`, thêm ngay **trước** khối `// Renders the terminal list from GET /api/terminal.` (trước `let terminalRefreshInFlight`):

```js
// --- mở thẳng một phiên khi bấm thông báo (spec §3) -------------------------
//
// Service worker không đọc được localStorage, nên nó không cầm token đăng
// nhập và không ký nổi một yêu cầu mở terminal. Nó chỉ nói được TÊN PHIÊN —
// qua `?open=` khi phải mở cửa sổ mới, hoặc qua postMessage khi trang đã
// chạy sẵn. Việc còn lại làm ở đây, đi đúng đường mà một cú bấm tay vẫn đi.

let pendingOpen = null;

function showTerminalErr(msg) {
  const err = $('terminal-err');
  err.textContent = msg;
  err.classList.remove('hidden');
}

// Xoá tham số ngay khi đọc: một lần nạp lại trang (kéo xuống để nạp lại,
// chẳng hạn) không được mở lại terminal lần nữa sau khi người dùng đã cố ý
// quay ra.
function readPendingOpenFromUrl() {
  let raw = '';
  try { raw = new URLSearchParams(location.search || '').get('open') || ''; }
  catch (e) { raw = ''; }
  if (!raw) return;
  pendingOpen = raw;
  try { history.replaceState(null, '', location.pathname || '/'); }
  catch (e) { /* không xoá được thì cùng lắm mở lại một lần — không hỏng gì */ }
}
readPendingOpenFromUrl();

if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.type !== 'ccrc_open' || typeof d.sessionId !== 'string' || !d.sessionId) return;
    pendingOpen = d.sessionId;
    refreshTerminal();
  });
}

// `sessions` là null khi lượt nạp vừa rồi hỏng. Giữ nguyên yêu cầu mở trong
// trường hợp đó: "không hỏi được hub" không phải bằng chứng phiên đã đóng, và
// nói thế là nói dối về máy của người dùng.
async function consumePendingOpen(sessions) {
  if (!pendingOpen || !sessions) return;
  const sid = pendingOpen;
  // Tiêu thụ TRƯỚC khi hành động: openTerminal() có nhánh lỗi tự gọi
  // refreshTerminal() lại, và một yêu cầu chưa tiêu thụ ở đây sẽ thành vòng
  // lặp mở-hỏng-mở-hỏng.
  pendingOpen = null;
  const i = sessions.findIndex((s) => s && s.sessionId === sid);
  if (i === -1) return showTerminalErr('Phiên đó đã đóng — không mở được.');
  const session = sessions[i];
  if (!session.alive) {
    return showTerminalErr('Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt.');
  }
  if (!(await pairedMachines()).includes(session.machine)) {
    return showTerminalErr('Điện thoại này chưa ghép với máy đó — bấm "Ghép máy này".');
  }
  // renderTerminalList() dựng đúng một thẻ cho mỗi phiên, theo đúng thứ tự
  // của `sessions`, nên chỉ số là mối nối duy nhất cần thiết giữa hai bên.
  const card = $('terminal-list').children[i];
  const btn = card && Array.from(card.children).find((c) => c.tagName === 'BUTTON');
  if (!btn) return showTerminalErr('Không mở được phiên đó — thử bấm vào thẻ trong danh sách.');
  await openTerminal(session, btn);
}
```

- [ ] **Step 5: Nối `consumePendingOpen` vào sau lượt refresh**

Trong `server/public/app.js`, thay `refreshTerminal()` bằng:

```js
function refreshTerminal() {
  if (terminalRefreshInFlight) return terminalRefreshInFlight;
  // consumePendingOpen chạy SAU khi cờ đã được gỡ (`.finally` chạy trước
  // `.then`): nhánh lỗi của openTerminal() gọi refreshTerminal() lại, và nếu
  // cờ còn treo thì nó nhận về chính promise đang chờ chính nó — khoá chết.
  terminalRefreshInFlight = doRefreshTerminal()
    .finally(() => { terminalRefreshInFlight = null; })
    .then((sessions) => consumePendingOpen(sessions));
  return terminalRefreshInFlight;
}
```

và trong `doRefreshTerminal()`, đổi hai chỗ trả về ở cuối:

```js
  } catch (e) {
    err.textContent = 'Không lấy được trạng thái terminal, thử lại sau.';
    err.classList.remove('hidden');
    return null;   // null = "chưa biết", khác hẳn [] = "không có phiên nào"
  }

  await renderTerminalList(sessions || []);
  return sessions || [];
}
```

- [ ] **Step 6: Chạy test, xác nhận xanh**

Chạy: `npm test --workspace server`
Kỳ vọng: PASS toàn bộ, kể cả các test cũ về `refreshTerminal()`.

- [ ] **Step 7: Commit**

```bash
git add server/public/app.js server/test/dom-harness.mjs server/test/app-terminal.test.js
git commit -m "Open the notified session straight from the terminal list

The service worker can name a session but cannot sign its way into one —
the login token lives in localStorage, out of its reach. So the page does
the opening, down the same path a tap on the card takes: same URL check,
same signature, same read-marker. A session that closed, a machine gone
quiet, or one this phone never paired with each says so instead."
```

---

### Task 7: Bump `?v=` và nghiệm thu tay việc 2

**Files:**
- Modify: `server/public/index.html:18`, `server/public/index.html:71`

- [ ] **Step 1: Bump version**

Trong `server/public/index.html`, đổi `style.css?v=9` → `style.css?v=10` và `app.js?v=9` → `app.js?v=10`.

- [ ] **Step 2: Chạy toàn bộ test**

Chạy: `npm test`
Kỳ vọng: PASS cả ba workspace. (`server/test/shell-scripts.test.js` và `first-run.test.js` cũng phải xanh — chúng đọc `index.html`.)

- [ ] **Step 3: Commit**

```bash
git add server/public/index.html
git commit -m "Bump the asset version so installed PWAs pick up the new app.js

An installed PWA caches app.js by URL. Without this, the deep-link and
hub-origin changes never reach the one device they were written for."
```

- [ ] **Step 4: Hỏi Huy rồi deploy hub**

Cùng nhịp deploy với Task 4 Step 2 nếu hai task chạy gần nhau.

- [ ] **Step 5: Nghiệm thu tay trên iPhone**

1. Đóng hẳn PWA (vuốt khỏi app switcher) rồi mở lại — để chắc chắn đã nạp `?v=10`
2. Trên máy dev, chạy `/remote on` cho một thư mục, để Claude chạy tới lúc dừng chờ → thông báo đẩy tới điện thoại
3. **Điện thoại khoá màn hình**, bấm vào thông báo → phải vào thẳng terminal của đúng phiên đó
4. Lặp lại với PWA đang mở sẵn ở nền → cũng phải vào thẳng terminal, không mở thêm cửa sổ
5. Chạy `/remote off` rồi bấm lại một thông báo cũ của phiên đó → phải thấy danh sách phiên kèm dòng "Phiên đó đã đóng"

Không đạt bước nào thì ghi lại chính xác thứ nhìn thấy và mở điều tra với `superpowers:systematic-debugging`, không vá mù.

---

## Ghi chú thực thi

- Task 1 → 2 → 3 phải theo thứ tự (Task 2 và 3 dùng `currentHub()` của Task 1).
- Task 5 → 6 nên theo thứ tự (Task 6 dùng hợp đồng message/URL của Task 5), nhưng cả nhánh 5-6 **độc lập hoàn toàn** với nhánh 1-2-3 — chạy song song được.
- Task 4 là cổng chặn của nhánh 1-2-3, Task 7 đóng nhánh 5-6 và tiện thể mang luôn cả hai lên hub.
- Sau khi cả hai nhánh xong, chạy `superpowers:requesting-code-review` trước khi gộp về `claude/remote-control-system-amhnpb`.
