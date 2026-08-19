# Kế hoạch A (đợt 2/1): cô lập test + notify chạy trên Windows

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`
> hoặc `superpowers:executing-plans`. Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** (1) làm cho bộ test cô lập được trên Windows, và (2) cho `/notify`
chạy đúng trên Windows. Kết quả: máy Windows nhận được thông báo đẩy khi Claude
Code dừng chờ.

**Kiến trúc:** Thêm `shared/home.js` với `ccrcHome()` — đọc `CCRC_HOME` trước,
rồi mới `os.homedir()`. Cùng lối nghĩ với `CCRC_TMUX_BIN`/`CCRC_TAILSCALE_BIN`
đã có. Lệnh hook ghi vào `settings.json` rẽ nhánh theo nền tảng.

**Tech Stack:** Node.js 22, ESM, `node:test`.

**Spec:** [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md) §7.5

## Ràng buộc toàn cục

- **Không đổi hành vi trên macOS/Linux.** Huy nhấn mạnh ba lần. 506 test hiện có
  phải xanh và **không được sửa một bài cũ nào để cho nó xanh**.
- Không thêm dependency nào.
- **Không chạy bộ test trên máy Windows cho tới khi Task 1 xong.** Lý do ở dưới.
- Commit tiếng Anh, kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Máy Windows: `ssh dev@100.101.102.103`, repo ở `C:\Users\dev\ccrc-src`.
  PowerShell là shell mặc định. Dùng `npm.cmd`, không phải `npm` (ExecutionPolicy
  `Restricted` chặn `npm.ps1`).

## Vì sao Task 1 phải làm trước — đã xảy ra thật

Ba file test trong `hook/test/` cô lập bằng
`execFile(..., { env: { ...process.env, HOME: home } })`. **Trên Windows
`os.homedir()` đọc `USERPROFILE`, không phải `HOME`** — đo được: đặt `HOME` trỏ
thư mục tạm rồi hỏi `os.homedir()` vẫn ra `C:\Users\dev`.

Hậu quả đã xảy ra ngày 2026-08-18 trên máy Huy: chạy bộ test hook cho 30/48
pass, và 18 bài đỏ **chính vì chúng đang thao tác trên hồ sơ THẬT**. Nó cài một
hook ccrc vào `~/.claude/settings.json` thật và tạo `~/.ccrc/notify`. Đã dọn,
nhưng không được để xảy ra lần nữa — vòng lặp phát triển sẽ chạy test hàng trăm
lần.

---

### Task 1: `ccrcHome()` — cô lập được trên cả hai nền tảng

**Files:**
- Create: `shared/home.js`
- Create: `shared/home.test.js` — KHÔNG có, xem ghi chú dưới
- Modify: `hook/bin/ccrc-notify.js:20`, `hook/bin/ccrc-notify-cli.js:14`, `hook/bin/install-hook.mjs:28`
- Modify: `hook/test/ccrc-notify.test.js:40`, `hook/test/install-hook.test.js:40`, `hook/test/notify-cli.test.js:20`
- Create: `hook/test/home.test.js`

Ghi chú: `shared/` không có bộ test riêng (`npm test` chỉ chạy server/hook/term),
nên test cho `ccrcHome()` đặt trong `hook/test/`.

**Interfaces:**
- Produces: `ccrcHome(env = process.env): string` từ `shared/home.js`.
  Trả `env.CCRC_HOME` nếu đó là chuỗi không rỗng; ngược lại `os.homedir()`.

- [ ] **Bước 1: Viết test đỏ**

Tạo `hook/test/home.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { ccrcHome } from '../../shared/home.js';

test('mặc định là thư mục nhà của hệ điều hành', () => {
  assert.equal(ccrcHome({}), os.homedir());
});

test('CCRC_HOME đè lên, kể cả khi HOME nói khác', () => {
  // Đây là toàn bộ lý do hàm này tồn tại: trên Windows, đặt HOME KHÔNG đổi
  // được os.homedir() (nó đọc USERPROFILE), nên test không cô lập nổi và
  // ghi thẳng vào hồ sơ thật của người dùng. Đã xảy ra một lần, 2026-08-18.
  assert.equal(ccrcHome({ CCRC_HOME: '/tmp/gia', HOME: '/tmp/khac' }), '/tmp/gia');
});

test('chuỗi rỗng hoặc kiểu sai thì bỏ qua, không biến thành đường dẫn rỗng', () => {
  // Một biến môi trường đặt hụt (`CCRC_HOME=`) mà được tin là sẽ ghi vào
  // `/.ccrc` ở gốc ổ đĩa — hỏng theo kiểu khó lần ra nhất.
  assert.equal(ccrcHome({ CCRC_HOME: '' }), os.homedir());
  assert.equal(ccrcHome({ CCRC_HOME: '   ' }), os.homedir());
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test hook/test/home.test.js`
Mong đợi: FAIL — `Cannot find module '../../shared/home.js'`

- [ ] **Bước 3: Viết `shared/home.js`**

```js
// Thư mục nhà mà ccrc dùng để tìm `.ccrc` và `.claude`.
//
// Vì sao không gọi thẳng os.homedir(): bộ test cần cô lập, và cách cô lập duy
// nhất trước đây là đặt biến HOME cho tiến trình con. Trên Windows điều đó
// KHÔNG có tác dụng — os.homedir() ở đó đọc USERPROFILE. Đo được: đặt HOME trỏ
// một thư mục tạm rồi hỏi os.homedir() vẫn ra C:\Users\<user>.
//
// Hậu quả không phải lý thuyết. Ngày 2026-08-18, chạy bộ test hook trên một máy
// Windows đã cài một hook vào ~/.claude/settings.json THẬT của người dùng và
// tạo ~/.ccrc/notify — vì mọi bài test tưởng mình đang ở trong hộp cát.
//
// CCRC_HOME là cùng một lối nghĩ với CCRC_TMUX_BIN và CCRC_TAILSCALE_BIN đã có:
// một biến môi trường rõ ràng, do dự án tự định nghĩa, không phụ thuộc vào việc
// hệ điều hành nào diễn giải biến chuẩn nào ra sao.
import os from 'node:os';

export function ccrcHome(env = process.env) {
  const v = env && env.CCRC_HOME;
  // Chuỗi rỗng hoặc toàn khoảng trắng KHÔNG được tính là "có đặt": tin nó là
  // ghi vào `.ccrc` ở gốc ổ đĩa, hỏng theo kiểu khó lần ra nhất.
  if (typeof v === 'string' && v.trim() !== '') return v;
  return os.homedir();
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test hook/test/home.test.js`
Mong đợi: PASS, 3/3.

- [ ] **Bước 5: Dùng nó trong `hook/`**

| File:dòng | Từ | Thành |
|---|---|---|
| `hook/bin/ccrc-notify.js:20` | `path.join(os.homedir(), '.ccrc')` | `path.join(ccrcHome(), '.ccrc')` |
| `hook/bin/ccrc-notify-cli.js:14` | `path.join(os.homedir(), '.ccrc')` | `path.join(ccrcHome(), '.ccrc')` |
| `hook/bin/install-hook.mjs:28` | `path.join(os.homedir(), '.claude', 'settings.json')` | `path.join(ccrcHome(), '.claude', 'settings.json')` |

Thêm `import { ccrcHome } from '../../shared/home.js';` vào mỗi file. Xoá
`import os from 'node:os';` ở file nào không còn dùng `os` — kiểm bằng grep,
đừng xoá mò.

`shared/session-registry.js:19` đã nhận tham số `home` nên **không sửa**; nó
được gọi với `home` do caller truyền.

- [ ] **Bước 6: Sửa ba file test cô lập bằng CCRC_HOME**

Ở cả ba chỗ, thêm `CCRC_HOME: home` vào object env. **GIỮ NGUYÊN `HOME: home`**
— trên POSIX nó vẫn là thứ mọi thứ khác trong tiến trình con dựa vào, và bỏ đi
là đổi hành vi test trên macOS mà không có lý do.

| File:dòng | Thành |
|---|---|
| `hook/test/ccrc-notify.test.js:40` | `const env = { ...process.env, HOME: home, CCRC_HOME: home };` |
| `hook/test/install-hook.test.js:40` | `{ env: { ...process.env, HOME: home, CCRC_HOME: home } }` |
| `hook/test/notify-cli.test.js:20` | `{ env: { ...process.env, HOME: home, CCRC_HOME: home }, timeout: 15000 }` |

- [ ] **Bước 7: Chạy toàn bộ suite trên macOS**

Chạy: `npm test`
Mong đợi: PASS, **980 bài** (server 423 + hook 51 + term 506), 0 đỏ.
Hook workspace phải tăng đúng +3 (48 → 51).

Đỏ ở đây nghĩa là hành vi macOS đã đổi — sửa code, KHÔNG sửa test.

- [ ] **Bước 8: Chứng minh cô lập THẬT SỰ hoạt động trên Windows**

Đây là bước quan trọng nhất của cả task, và nó phải là một phép đo chứ không
phải một lời khẳng định.

```powershell
# Trên máy Windows, TRƯỚC khi chạy test — ghi lại mốc thời gian hồ sơ thật
(Get-Item "$env:USERPROFILE\.claude\settings.json").LastWriteTime
Test-Path "$env:USERPROFILE\.ccrc"
```

Đẩy nhánh lên máy Windows (git bundle + `git fetch`), `npm.cmd ci`, rồi chạy
`node --test hook/test/*.test.js`.

```powershell
# SAU khi chạy — mốc thời gian phải KHÔNG ĐỔI, và .ccrc phải KHÔNG xuất hiện
(Get-Item "$env:USERPROFILE\.claude\settings.json").LastWriteTime
Test-Path "$env:USERPROFILE\.ccrc"
```

**Tiêu chí đạt:** mốc thời gian y hệt trước và sau; `.ccrc` vẫn không tồn tại.
Số bài đỏ ở lần chạy này CHƯA cần bằng 0 — Task 2 mới xử phần đó. Nhưng nếu hồ
sơ thật bị đụng thì task này CHƯA xong, dù test có xanh bao nhiêu đi nữa.

Báo cáo phải chứa cả hai mốc thời gian, nguyên văn.

- [ ] **Bước 9: Commit**

```bash
git add shared/home.js hook/bin hook/test
git commit -m "fix: give the tests a home directory Windows actually honours

The suite isolated itself by setting HOME on the child process. On
Windows that does nothing: os.homedir() reads USERPROFILE there, so
every test believing it was sandboxed was in fact reading and writing
the real profile.

This is not theoretical. Running the hook suite on a Windows machine
installed a ccrc hook into the user's actual ~/.claude/settings.json and
created ~/.ccrc/notify.

CCRC_HOME is the same idea as CCRC_TMUX_BIN and CCRC_TAILSCALE_BIN
already in the project: an explicit variable the project defines itself,
rather than depending on which standard variable a given OS happens to
honour. HOME is still set alongside it, because on POSIX everything else
in the child still relies on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: notify chạy được thật trên Windows

Hai việc, cùng một mục tiêu: cho `/notify` hoạt động đúng trên Windows.

**Việc 1 — sổ tra phiên tra nhầm thư mục.** Bốn chỗ gọi sổ tra phiên KHÔNG
truyền `home`, nên `registryDir(undefined)` rơi về `os.homedir()` trần, đi vòng
qua `ccrcHome()` của Task 1. Trên POSIX vô hại (os.homedir() vốn tôn trọng
`HOME`); trên Windows thì hook tra vào hồ sơ thật trong khi test ghi vào thư mục
tạm. Đo được: 4 bài đỏ trên Windows, thông báo mất cả tên phiên lẫn `sessionId`,
và mục của daemon đã chết không ai dọn.

Đây là chẩn đoán ĐÃ ĐƯỢC KIỂM CHỨNG ĐỘC LẬP hai lần. Một giả thuyết khác —
`process.kill(pid,0)` trả `EPERM` trên Windows làm `defaultIsAlive` tưởng còn
sống — **đã đo và BÁC BỎ**: cả hai nền tảng đều trả `ESRCH`. Đừng đi lại đường đó.

**Việc 2 — lệnh hook trong `settings.json`.** `install-hook.mjs:92` ghi
`"<đường dẫn>"` trần. POSIX chạy được nhờ shebang + bit execute; **Windows
không có cả hai** — hook lỗi mỗi lần Claude Code bắn Notification, và lỗi ấy
người dùng không nhìn thấy: họ chỉ thấy thông báo không bao giờ tới.

**Files:**
- Modify: `hook/bin/ccrc-notify.js:89-90`
- Modify: `term/bin/ccrc-term.js:252` và `:868-871`
- Modify: `hook/bin/install-hook.mjs:92`
- Modify: `hook/test/install-hook.test.js`

**Interfaces:**
- Consumes: `ccrcHome()` từ Task 1.
- Produces: `lenhHook(hookPath, platform)` từ `hook/bin/install-hook.mjs`.

- [ ] **Bước 0: truyền `home` vào mọi chỗ tra sổ phiên**

| File:dòng | Từ | Thành |
|---|---|---|
| `hook/bin/ccrc-notify.js:89` | `findByPane(process.env.TMUX_PANE, { tmux: process.env.TMUX })` | `findByPane(process.env.TMUX_PANE, { tmux: process.env.TMUX, home: ccrcHome() })` |
| `hook/bin/ccrc-notify.js:90` | `findByCwd(payload && payload.cwd)` | `findByCwd(payload && payload.cwd, { home: ccrcHome() })` |
| `term/bin/ccrc-term.js:252` | `removeSession(SESSION_ID)` | `removeSession(SESSION_ID, { home: ccrcHome() })` |
| `term/bin/ccrc-term.js:868` | `writeSession({ ... })` | `writeSession({ ... }, { home: ccrcHome() })` |

Thêm `import { ccrcHome } from '../../shared/home.js';` vào `term/bin/ccrc-term.js`.

**Hai đầu phải đổi CÙNG LÚC.** Daemon ghi sổ và hook đọc sổ; chuyển một bên mà
để bên kia dùng `os.homedir()` là hai bên nhìn hai thư mục khác nhau — hỏng âm
thầm, đúng thứ mà comment đầu `session-registry.js` đã cảnh báo ("drift here is
silent").

**Trên macOS hành vi KHÔNG đổi:** `CCRC_HOME` không được đặt trong sản xuất, nên
`ccrcHome()` trả đúng `os.homedir()`. Bộ test term/ đặt `HOME` và `os.homedir()`
vẫn tôn trọng nó trên POSIX. Nếu bài term/ nào đỏ sau bước này, DỪNG và báo —
đừng sửa test.

- [ ] **Bước 1: Viết test đỏ**

Thêm vào `hook/test/install-hook.test.js`:

```js
import { lenhHook } from '../bin/install-hook.mjs';

test('trên POSIX, lệnh hook là đường dẫn trần — giữ nguyên hành vi cũ', () => {
  assert.equal(lenhHook('/duong/dan/ccrc-notify.js', 'darwin'), '"/duong/dan/ccrc-notify.js"');
  assert.equal(lenhHook('/duong/dan/ccrc-notify.js', 'linux'), '"/duong/dan/ccrc-notify.js"');
});

test('trên Windows phải gọi qua node — không có shebang, không có bit execute', () => {
  // Thiếu chỗ này thì hook lỗi mỗi lần Claude Code bắn Notification, và người
  // dùng không thấy gì cả ngoài việc thông báo không bao giờ tới.
  assert.equal(lenhHook('C:\\d\\ccrc-notify.js', 'win32'), 'node "C:\\d\\ccrc-notify.js"');
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test hook/test/install-hook.test.js`
Mong đợi: FAIL — `lenhHook is not a function`

- [ ] **Bước 3: Tách và rẽ nhánh**

Trong `hook/bin/install-hook.mjs`, thêm hàm export (đặt trên chỗ dùng):

```js
// Lệnh mà Claude Code sẽ chạy cho hook này.
//
// POSIX: đường dẫn trần chạy được nhờ shebang + bit execute, và đó là hình
// dạng đã nằm trong settings.json của người dùng hiện tại — đổi nó là đổi hành
// vi trên máy đang chạy ổn định, nên KHÔNG đổi.
//
// Windows: không có shebang, không có bit execute. Một đường dẫn trần ở đây
// lỗi mỗi lần Claude Code bắn Notification, và lỗi ấy người dùng không nhìn
// thấy — họ chỉ thấy thông báo không bao giờ tới.
export function lenhHook(hookPath, platform = process.platform) {
  return platform === 'win32' ? `node "${hookPath}"` : `"${hookPath}"`;
}
```

rồi thay dòng 92:

```js
  kept.push({ hooks: [{ type: 'command', command: lenhHook(hookPath), timeout: 10 }] });
```

**Chú ý:** file này đang là script chạy thẳng (`process.exit` ở thân file). Thêm
`export` biến nó thành module mà test import được — mà import một module có
`process.exit` ở thân là test tự sát. Phải bọc phần thân trong một guard "chỉ
chạy khi được gọi trực tiếp":

```js
import { fileURLToPath } from 'node:url';
const chayTrucTiep = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (chayTrucTiep) {
  // ... toàn bộ thân script hiện tại ...
}
```

Nếu cách này làm hỏng bài test nào đang gọi script qua `execFile`, DỪNG và báo
— đừng nới lỏng bài test.

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test hook/test/install-hook.test.js`
Mong đợi: PASS, tất cả bài cũ vẫn xanh + 2 bài mới.

- [ ] **Bước 5: Chạy toàn bộ suite trên macOS**

Chạy: `npm test`
Mong đợi: PASS, **982 bài** (hook 53), 0 đỏ.

- [ ] **Bước 6: Chạy trên Windows, và đo lại hồ sơ thật**

Như Task 1 bước 8: ghi mốc thời gian trước/sau. Lần này mong đợi **hook suite
xanh hết** (48/48). Bài nào còn đỏ thì báo cáo nguyên văn lý do — đừng sửa test
cho nó xanh.

- [ ] **Bước 7: Commit**

```bash
git add hook/bin/install-hook.mjs hook/test/install-hook.test.js
git commit -m "fix: call the notify hook through node on Windows

A bare path works on POSIX because of the shebang and the execute bit.
Windows has neither, so the hook fails every time Claude Code fires a
Notification — and fails invisibly: the user just never gets a
notification and has nothing to look at.

POSIX keeps the bare path deliberately. That is the shape already
written into every existing user's settings.json, and changing it would
change behaviour on machines that are working today.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Định nghĩa "xong" của kế hoạch A

- [ ] `npm test` trên macOS xanh, 982 bài, không sửa một bài cũ nào
- [ ] Bộ test hook chạy trên Windows **không đụng vào hồ sơ thật** — chứng minh
      bằng mốc thời gian trước/sau
- [ ] Bộ test hook trên Windows xanh 48/48
- [ ] Không thêm dependency nào
