# Kế hoạch C (đợt 2/3): sổ hồ sơ host + `ccrc-host` giữ ConPTY

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`.
> Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** Dựng tiến trình nền giữ ConPTY và mở named pipe — thứ đóng vai trò
`tmux server` trên Windows. Xong kế hoạch này, trên máy Windows sẽ có một tiến
trình chạy Claude Code trong ConPTY mà tiến trình khác nối vào đọc/ghi được.

Client mỏng và bộ khởi chạy WMI thuộc kế hoạch D.

**Tech Stack:** Node.js 22, ESM, `node:test`, `node-pty` (optionalDependency),
`net` (named pipe), ba module của kế hoạch B.

**Spec:** [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md) §6

## Ràng buộc toàn cục

- **Không đổi hành vi trên macOS/Linux.** Huy nhấn mạnh ba lần. 1008 test hiện
  có phải xanh, **không sửa một bài cũ nào**. Task 1 chạy được ở mọi nơi; Task 2
  là code chỉ Windows và không được nạp trên macOS.
- **`node-pty` khai là `optionalDependencies`, KHÔNG phải `dependencies`.** Đây
  là gói đầu tiên của dự án có mã máy. Khai thường thì mỗi `npm ci` trên macOS
  cũng kéo nó về, và một phiên bản Node thiếu prebuild sẽ làm `npm ci` HỎNG —
  tức làm gãy đúng nền tảng đang chạy ổn định. Optional thì thiếu prebuild chỉ
  là không cài, không gãy.
- Vì thế **`ccrc-host.js` phải kiểm `node-pty` có nạp được không và báo một câu
  rõ ràng** nếu không, chứ đừng để `MODULE_NOT_FOUND` nổ ra.
- **Định danh tiếng Anh, comment tiếng Việt** — như mọi file trong `term/src/`.
- Commit tiếng Anh, kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Máy Windows: `ssh dev@100.101.102.103`, repo `C:\Users\dev\ccrc-src`.
  PowerShell mặc định; dùng `npm.cmd`, không phải `npm`.
- **Trước VÀ sau mỗi lần chạy test trên Windows**, ghi lại
  `(Get-Item "$env:USERPROFILE\.claude\settings.json").LastWriteTime` và
  `Get-ChildItem -Force "$env:USERPROFILE\.ccrc"`. Hồ sơ thật không được đụng.
  Bộ test đã từng ghi vào đó một lần.
- Tiến trình node `9232` trên máy Windows là của Huy — không bao giờ được giết.

## Năm điều đã ĐO, đừng đo lại

| Câu hỏi | Kết quả |
|---|---|
| `node-pty` cài được trên Windows không | ✓ 11 giây, có prebuild `win32-x64`, **không cần Visual Studio Build Tools** |
| ConPTY trả escape sequence dùng được không | ✓ đầy đủ (`ESC[?9001h`, `ESC[2J`, `ESC[m ESC[H`) |
| Tiến trình nền sống qua việc phiên đóng | ✗ với `spawn detached`; ✓ qua WMI `Win32_Process.Create` (kế hoạch D) |
| Named pipe của Node phục vụ nhiều client cùng lúc | ✓ hai client, phục vụ độc lập |
| Client là tiến trình KHÁC nối vào được không | ✓ đo bằng tiến trình con riêng biệt |

**Chưa đo được:** quyền (DACL) trên pipe do Node tạo — `Get-Acl` trả lỗi 231.
Nên **không dựa vào quyền của pipe**: bí mật trong hồ sơ host là thứ canh cửa,
và đó cũng là lý do nó tồn tại.

---

### Task 1: sổ hồ sơ host

Một file JSON cho mỗi host đang chạy, dưới `<ccrcHome>/.ccrc/hosts/`. Đây là thứ
cho `ccrc remote` biết có những phiên nào — thay cho việc dò `ps` rồi đoán bằng
cây tiến trình và tty, cách đã sai hai lần trên macOS.

**Chạy được ở mọi nơi** — chỉ đụng filesystem, nên test trên macOS.

**Files:**
- Create: `term/src/host-registry.js`
- Create: `term/test/host-registry.test.js`

**Interfaces:**
- Produces:
  - `writeHost(entry, opts = {}): boolean` — `entry` gồm
    `{ sessionId, pid, pipe, secret, cwd, name }`
  - `readHost(sessionId, opts = {}): object | null`
  - `listHosts(opts = {}): object[]` — quét và **dọn** hồ sơ mồ côi
  - `removeHost(sessionId, opts = {}): boolean`
  - `hostsDir(home): string`
  - `opts` nhận `{ home, dir, isAlive }` — `isAlive` để test bơm vào

**Kỷ luật lấy nguyên từ `shared/session-registry.js`**, không phát minh lại:
- **Không hàm nào được ném.** Sổ hỏng không được làm chết thứ đang dùng nó.
- Ghi qua file tạm rồi `rename`, để người đọc không bao giờ thấy file viết dở.
- `sessionId` đi vào tên file nên phải qua bộ lọc ký tự.
- **Chỉ dọn hồ sơ chứng minh được là đã chết.** Pid không đọc được thì để lại.
  Bỏ sót một hồ sơ rác thì vô hại; dọn nhầm một phiên đang sống thì mất việc
  của người dùng.

- [ ] **Bước 1: Viết test đỏ**

Tạo `term/test/host-registry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHost, readHost, listHosts, removeHost, hostsDir } from '../src/host-registry.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hr-'));
}

const mau = (sessionId, pid = process.pid) => ({
  sessionId, pid, pipe: `\\\\.\\pipe\\ccrc-${sessionId}`,
  secret: 'bi-mat-' + sessionId, cwd: '/du/an/a', name: 'du an A',
});

test('ghi rồi đọc lại nguyên vẹn', () => {
  const home = tmpHome();
  assert.equal(writeHost(mau('abc'), { home }), true);
  const ra = readHost('abc', { home });
  assert.equal(ra.sessionId, 'abc');
  assert.equal(ra.pid, process.pid);
  assert.equal(ra.secret, 'bi-mat-abc');
  assert.equal(ra.name, 'du an A');
});

test('đọc phiên không có trả null, không ném', () => {
  const home = tmpHome();
  assert.equal(readHost('khong-co', { home }), null);
});

test('sessionId có ký tự lạ bị từ chối, không thoát ra khỏi thư mục', () => {
  // sessionId đi thẳng vào tên file. Đây là chỗ duy nhất chặn nó.
  const home = tmpHome();
  for (const xau of ['../thoat', 'a/b', '.', '..', '', 'x'.repeat(200)]) {
    assert.equal(writeHost(mau(xau), { home }), false, `phải từ chối: ${JSON.stringify(xau)}`);
  }
  assert.equal(fs.existsSync(path.join(hostsDir(home), '..', 'thoat.json')), false);
});

test('file JSON hỏng bị bỏ qua, không làm chết listHosts', () => {
  const home = tmpHome();
  writeHost(mau('tot'), { home });
  fs.mkdirSync(hostsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hostsDir(home), 'hong.json'), '{ khong phai json');
  const ds = listHosts({ home, isAlive: () => true });
  assert.deepEqual(ds.map((h) => h.sessionId), ['tot']);
});

test('hồ sơ của tiến trình đã chết bị dọn', () => {
  const home = tmpHome();
  writeHost(mau('song'), { home });
  writeHost(mau('chet'), { home });
  const ds = listHosts({ home, isAlive: (pid, entry) => entry.sessionId === 'song' });
  assert.deepEqual(ds.map((h) => h.sessionId), ['song']);
  assert.equal(readHost('chet', { home }), null, 'hồ sơ chết phải bị xoá khỏi đĩa');
});

test('pid không đọc được thì GIỮ LẠI, không dọn', () => {
  // Bỏ sót một hồ sơ rác thì vô hại. Dọn nhầm một phiên đang sống thì người
  // dùng mất việc — dự án này đã trả giá cho hướng ngược lại hai lần.
  const home = tmpHome();
  fs.mkdirSync(hostsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hostsDir(home), 'la.json'),
    JSON.stringify({ sessionId: 'la', pipe: 'x', secret: 'y' })); // không có pid
  const ds = listHosts({ home, isAlive: () => false });
  assert.deepEqual(ds.map((h) => h.sessionId), ['la'], 'không có pid = không chứng minh được đã chết');
});

test('removeHost xoá đúng một hồ sơ', () => {
  const home = tmpHome();
  writeHost(mau('a'), { home });
  writeHost(mau('b'), { home });
  assert.equal(removeHost('a', { home }), true);
  assert.equal(readHost('a', { home }), null);
  assert.ok(readHost('b', { home }), 'không được đụng hồ sơ khác');
});

test('thư mục chưa tồn tại thì listHosts trả mảng rỗng, không ném', () => {
  assert.deepEqual(listHosts({ home: tmpHome() }), []);
});

test('CCRC_HOME quyết định thư mục, không phải HOME', () => {
  // Trên Windows os.homedir() bỏ qua HOME, nên đây là biến duy nhất cô lập
  // được. Đã có sự cố ghi vào hồ sơ thật vì chuyện này.
  const home = tmpHome();
  assert.match(hostsDir(home), new RegExp(home.replace(/\\/g, '\\\\')));
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/host-registry.test.js`
Mong đợi: FAIL — `Cannot find module '../src/host-registry.js'`

- [ ] **Bước 3: Viết `term/src/host-registry.js`**

```js
// Sổ những `ccrc-host` đang chạy: một file JSON cho mỗi host, dưới
// `<ccrcHome>/.ccrc/hosts/`.
//
// Vì sao có: trên macOS, `ccrc remote` tìm phiên bằng cách dò toàn bộ bảng tiến
// trình rồi lọc theo cây con và khớp tty — và cách đoán ấy đã sai hai lần, một
// lần bắt nhầm `claude` headless do plugin worker sinh ra. Trên Windows không
// phải đoán: host tự khai mình vào đây.
//
// Kỷ luật lấy nguyên từ shared/session-registry.js, không phát minh lại — hai
// sổ này giải cùng một bài toán và khác nhau ở chi tiết là cách chúng trôi xa
// nhau.
import fs from 'node:fs';
import path from 'node:path';
import { ccrcHome } from '../../shared/home.js';

export function hostsDir(home) {
  return path.join(home || ccrcHome(), '.ccrc', 'hosts');
}

// sessionId do code của dự án sinh ra, nhưng nó đi vào TÊN FILE — nên không
// được tin. Bất cứ thứ gì ngoài tập này đều có thể thoát khỏi thư mục.
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id)
    && id !== '.' && id !== '..';
}

const filePath = (dir, id) => path.join(dir, `${id}.json`);

// Phân biệt "không có tiến trình này" với "có nhưng không phải của mình":
// chỉ ESRCH mới là đã chết. EPERM nghĩa là tiến trình CÓ THẬT nhưng thuộc người
// dùng khác — vẫn đang sống.
function defaultIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Không hàm nào trong file này được ném. Một sổ hỏng không được phép làm chết
// thứ đang dùng nó — cùng lý do session-registry.js nói ở đầu file.
export function writeHost(entry, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!entry || !safeId(entry.sessionId)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      sessionId: entry.sessionId,
      pid: Number(entry.pid) || 0,
      pipe: typeof entry.pipe === 'string' ? entry.pipe : '',
      // Bí mật này là thứ canh cửa pipe. Quyền trên pipe do Node tạo KHÔNG đo
      // được (Get-Acl trả lỗi 231), nên không dựa vào nó — mà dựa vào việc thư
      // mục này được đặt ACL lúc cài.
      secret: typeof entry.secret === 'string' ? entry.secret : '',
      // cwd KHÔNG BAO GIỜ rời khỏi máy. Nó là khoá đối chiếu cục bộ, y như
      // trong session-registry — gửi đi là mở lại đúng lỗ rò riêng tư mà cái
      // sổ ấy sinh ra để bịt.
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      createdAt: Number(entry.createdAt) || Date.now(),
    });
    // Ghi file tạm rồi rename: người đọc không bao giờ thấy một file viết dở.
    const tmp = filePath(dir, entry.sessionId) + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, filePath(dir, entry.sessionId));
    return true;
  } catch {
    return false;
  }
}

export function readHost(sessionId, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!safeId(sessionId)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(filePath(dir, sessionId), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function removeHost(sessionId, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!safeId(sessionId)) return false;
  try {
    fs.unlinkSync(filePath(dir, sessionId));
    return true;
  } catch {
    return false;
  }
}

export function listHosts(opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  const isAlive = opts.isAlive || ((pid) => defaultIsAlive(pid));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // đọc không được hoặc viết dở — bỏ qua, không bao giờ ném
    }
    if (!entry || typeof entry !== 'object') continue;
    // KHÔNG có pid nghĩa là không chứng minh được đã chết — giữ lại. Bỏ sót
    // một hồ sơ rác thì vô hại; dọn nhầm một phiên đang sống thì người dùng
    // mất việc, và dự án này đã trả giá cho hướng ngược lại hai lần.
    if (!entry.pid) { out.push(entry); continue; }
    if (!isAlive(entry.pid, entry)) {
      removeHost(entry.sessionId, { dir });
      continue;
    }
    out.push(entry);
  }
  return out;
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/host-registry.test.js`
Mong đợi: PASS, 9/9.

- [ ] **Bước 5: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **1017 bài** (1008 + 9 mới), 0 đỏ. Báo con số thật nếu khác —
các kế hoạch trước đã nhiều lần có số cũ trong đề bài.

- [ ] **Bước 6: Commit**

```bash
git add term/src/host-registry.js term/test/host-registry.test.js
git commit -m "feat: let hosts announce themselves instead of being guessed at

On macOS, ccrc remote finds sessions by walking the whole process
table, filtering by subtree and matching ttys. That guess has been wrong
twice, once picking up a headless claude spawned by a background plugin
worker. On Windows there is nothing to guess: the host writes a file
saying what it is.

The discipline is session-registry.js's, deliberately not reinvented:
nothing throws, writes go through a temp file and a rename so a reader
never sees a half-written record, the session id is filtered before it
becomes a filename, and only a profile that can be PROVEN dead is swept.
An entry with no pid is kept — missing a stale file is harmless, while
deleting a live session costs the user their work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `ccrc-host` — giữ ConPTY, mở pipe

Tiến trình nền đóng vai `tmux server`. **Chỉ chạy trên Windows**, nhưng phải
không làm gãy gì khi ai đó lỡ nạp nó trên macOS.

**Files:**
- Create: `term/bin/ccrc-host.js`
- Create: `term/test/ccrc-host.test.js` (chỉ chạy trên Windows, tự bỏ qua nơi khác)
- Modify: `term/package.json` (thêm `optionalDependencies`)

**Interfaces:**
- Consumes: `createScreenBuffer`, `createMouseMode`, `FRAME`/`encodeFrame`/
  `createFrameDecoder` (kế hoạch B), `writeHost`/`removeHost` (Task 1).
- Produces: một chương trình chạy được, không phải thư viện. Nhận qua môi
  trường: `CCRC_HOST_SESSION_ID`, `CCRC_HOST_COMMAND` (mặc định `claude`),
  `CCRC_HOST_CWD`.

**Hành vi bắt buộc:**

1. Nạp `node-pty` **có kiểm**. Không có thì in một câu tiếng Việt nói rõ phải
   làm gì và thoát mã khác 0 — tuyệt đối không để `MODULE_NOT_FOUND` nổ ra.
   Đây là hệ quả trực tiếp của việc khai nó `optionalDependencies`.
2. Mở ConPTY chạy `CCRC_HOST_COMMAND`, nạp mọi byte ra vào **cả** screen buffer
   **lẫn** mouse-mode reader.
3. Byte thô phải được giải mã UTF-8 **có nhớ trạng thái** trước khi đưa vào
   mouse-mode reader — một ký tự nhiều byte bị cắt ngang mảng không được biến
   thành U+FFFD. Dùng `new TextDecoder('utf-8')` với `{ stream: true }`, cùng lý
   do `control-stream.js` dùng `setEncoding('utf8')`.
4. Mở named pipe `\\.\pipe\ccrc-<sessionId>`. **Khung đầu tiên mỗi client gửi
   phải là bí mật**; sai thì đóng ngay, không trả lời gì thêm.
5. Sau khi xác thực: đẩy mọi byte pty tới client dưới khung `FRAME.PANE`; nhận
   khung `FRAME.PANE` từ client và ghi thẳng vào pty; nhận khung `FRAME.CONTROL`
   (JSON) cho `resize`.
6. **Kích thước: host tính, không phải client.** Mỗi client khai kích thước của
   mình; host lấy `min` trên các client đang gắn rồi gọi `pty.resize` một lần.
   Client tự resize là hai client giẫm lên nhau — trên tmux thì tmux chặn hộ, ở
   đây không ai chặn.
7. Ghi hồ sơ bằng `writeHost` lúc khởi động; **xoá bằng `removeHost` khi pty
   thoát**, rồi tự thoát. Pty chết là phiên hết — giống hệt tmux, một phiên chỉ
   chạy một lệnh thì lệnh xong là hết.
8. Một client ngắt kết nối **không** được làm chết host.

- [ ] **Bước 1: Khai `node-pty` là optionalDependency**

```bash
npm install --workspace term --save-optional node-pty@^1.1.0
```

Kiểm: `term/package.json` có `optionalDependencies`, và `dependencies` **không**
có `node-pty`. Nếu npm đặt nhầm chỗ, sửa tay rồi chạy lại `npm install`.

- [ ] **Bước 2: Viết test đỏ**

Tạo `term/test/ccrc-host.test.js`. Toàn bộ file tự bỏ qua khi không phải
Windows — đây là code chỉ Windows, và giả vờ test nó ở nơi khác là tệ hơn không
test:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';
import { readHost } from '../src/host-registry.js';

const CHI_WINDOWS = process.platform !== 'win32';
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dựng một host thật trong một CCRC_HOME riêng, chạy `cmd.exe` thay cho
// `claude` — cùng hình dạng, không tốn một phiên Claude thật.
async function dungHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-host-'));
  const sessionId = 'test' + crypto.randomBytes(4).toString('hex');
  const proc = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      CCRC_HOME: home,
      CCRC_HOST_SESSION_ID: sessionId,
      CCRC_HOST_COMMAND: 'cmd.exe',
      CCRC_HOST_CWD: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Chờ ĐIỀU KIỆN: hồ sơ xuất hiện. Không chờ một con số mili giây.
  const hetGio = Date.now() + 15000;
  let ho = null;
  while (!ho && Date.now() < hetGio) { ho = readHost(sessionId, { home }); if (!ho) await sleep(100); }
  if (!ho) { proc.kill(); throw new Error('host không ghi hồ sơ kịp'); }
  return { proc, home, sessionId, ho };
}

// Nối vào pipe và gửi bí mật ngay, như một client thật.
function noi(ho, { secret = ho.secret } = {}) {
  const c = net.createConnection(ho.pipe);
  const dec = createFrameDecoder();
  const khung = [];
  c.on('data', (d) => { for (const f of dec.push(d)) khung.push(f); });
  c.on('connect', () => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret }))));
  return { c, khung };
}

test('host ghi hồ sơ rồi phục vụ pipe', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  try {
    assert.ok(h.ho.pipe.startsWith('\\\\.\\pipe\\'), 'hồ sơ phải nói tên pipe');
    assert.ok(h.ho.secret && h.ho.secret.length >= 16, 'bí mật phải đủ dài');
    assert.equal(h.ho.pid > 0, true);
  } finally { h.proc.kill(); }
});

test('client gửi đúng bí mật thì nhận được byte của pty', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho);
  try {
    const hetGio = Date.now() + 15000;
    while (khung.length === 0 && Date.now() < hetGio) await sleep(100);
    assert.ok(khung.length > 0, 'phải nhận được gì đó từ pty');
    assert.equal(khung[0].kind, FRAME.PANE, 'byte pty phải đi bằng khung PANE');
  } finally { c.destroy(); h.proc.kill(); }
});

test('sai bí mật thì bị đóng ngay, không nhận được gì', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho, { secret: 'sai-be-bet' });
  try {
    let dongRoi = false;
    c.on('close', () => { dongRoi = true; });
    const hetGio = Date.now() + 10000;
    while (!dongRoi && Date.now() < hetGio) await sleep(100);
    assert.equal(dongRoi, true, 'phải bị đóng');
    assert.equal(khung.length, 0, 'không được gửi một byte pty nào cho client chưa xác thực');
  } finally { c.destroy(); h.proc.kill(); }
});

test('gõ vào pty thì thấy chữ vọng lại', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho);
  try {
    await sleep(1500); // để cmd.exe kịp khởi động
    c.write(encodeFrame(FRAME.PANE, 'echo MOC-HOST\r'));
    const hetGio = Date.now() + 15000;
    const thay = () => khung.map((f) => f.payload.toString('utf8')).join('');
    while (!/MOC-HOST/.test(thay()) && Date.now() < hetGio) await sleep(100);
    assert.match(thay(), /MOC-HOST/);
  } finally { c.destroy(); h.proc.kill(); }
});

test('một client ngắt không làm chết host', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const a = noi(h.ho);
  await sleep(1000);
  a.c.destroy();
  await sleep(1000);
  const b = noi(h.ho);
  try {
    const hetGio = Date.now() + 15000;
    while (b.khung.length === 0 && Date.now() < hetGio) await sleep(100);
    assert.ok(b.khung.length > 0, 'host phải còn sống và phục vụ client mới');
  } finally { b.c.destroy(); h.proc.kill(); }
});

test('pty thoát thì host dọn hồ sơ rồi tự thoát', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c } = noi(h.ho);
  await sleep(1500);
  c.write(encodeFrame(FRAME.PANE, 'exit\r'));
  const hetGio = Date.now() + 20000;
  while (readHost(h.sessionId, { home: h.home }) && Date.now() < hetGio) await sleep(200);
  c.destroy();
  assert.equal(readHost(h.sessionId, { home: h.home }), null, 'hồ sơ phải bị dọn');
});
```

- [ ] **Bước 3: Chạy test trên Windows, xác nhận nó đỏ**

Đưa nhánh lên máy Windows bằng git bundle + `git fetch`, rồi:
`node --test term/test/ccrc-host.test.js`
Mong đợi: FAIL — không tìm thấy `ccrc-host.js`.

Trên macOS cùng lệnh phải cho **6 bài skip**, 0 đỏ.

- [ ] **Bước 4: Viết `term/bin/ccrc-host.js`**

Không có khối code sẵn ở đây — đây là task đầu tiên của cả đợt cần viết mới thật
sự, và bảy hành vi bắt buộc ở trên là đặc tả. Viết theo chúng, và theo phong
cách của `term/bin/ccrc-term.js`: comment giải thích *vì sao*, định danh tiếng
Anh.

Ba chỗ dễ sai, nêu trước:

- **Giải mã UTF-8 phải có nhớ trạng thái.** `new TextDecoder('utf-8')` rồi
  `decode(chunk, { stream: true })`. Gọi `chunk.toString('utf8')` từng mảng một
  sẽ biến ký tự nhiều byte bị cắt thành U+FFFD, và người dùng thấy chữ Việt vỡ.
- **Byte pty phải vào screen buffer TRƯỚC khi trả lời một câu hỏi nào về màn
  hình.** `write()` của buffer là bất đồng bộ; đọc trước khi nó xong là đọc
  trạng thái dở dang.
- **Client chưa xác thực không được nhận một byte pty nào.** Đăng ký nó vào
  danh sách nhận SAU khi bí mật đúng, không phải trước rồi lọc sau.

- [ ] **Bước 5: Chạy test trên Windows, xác nhận xanh**

`node --test term/test/ccrc-host.test.js` → 6/6 trên Windows.
Ghi lại mốc thời gian hồ sơ thật trước/sau, nguyên văn, vào báo cáo.

- [ ] **Bước 6: Chạy toàn bộ suite trên macOS**

Chạy: `npm test`
Mong đợi: PASS, 1017 bài + 6 skip, 0 đỏ. Không bài cũ nào đỏ.

- [ ] **Bước 7: Commit**

```bash
git add term/bin/ccrc-host.js term/test/ccrc-host.test.js term/package.json package-lock.json
git commit -m "feat: a host process that owns the ConPTY and serves a pipe

This is what tmux server does on macOS: hold the terminal, outlive any
single viewer, and let more than one of them attach. Windows has nothing
that does it, so the project grows one.

node-pty is an optionalDependency, not a dependency. It is the first
package here with native code, and declaring it normally means every npm
ci on macOS pulls it too — where a Node version without a matching
prebuild would fail the install outright and break the platform that
works today. Optional means a missing prebuild is simply not installed,
so the host checks for it and says what to do rather than exploding with
MODULE_NOT_FOUND.

The secret gates the pipe because the pipe's own permissions could not be
measured — Get-Acl returns error 231 on it. A client is added to the
broadcast list only after its secret checks out, so an unauthenticated
connection never receives a single byte of the terminal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Định nghĩa "xong" của kế hoạch C

- [ ] `npm test` trên macOS xanh, 1017 bài, không sửa một bài cũ nào
- [ ] `term/test/ccrc-host.test.js` 6/6 trên Windows, và **skip** sạch trên macOS
- [ ] Hồ sơ thật trên Windows không bị đụng — chứng minh bằng mốc thời gian
- [ ] `node-pty` nằm trong `optionalDependencies`, không phải `dependencies`
- [ ] Thiếu `node-pty` thì host báo một câu rõ ràng, không nổ `MODULE_NOT_FOUND`

---

### Task 3: tách `attach-queue` ra để cuộc đua test được

`ccrc-host.js` hiện có **zero bề mặt unit-test**: nó gọi `pty.spawn` ở top level
và `process.exit` khi không phải win32, nên toàn bộ logic chỉ được canh bởi 9
bài chạy tiến trình thật, chỉ trên Windows. Nó là file duy nhất trong `term/`ở
tình trạng đó.

Và bug attach vừa rồi — client mới gắn mất hẳn output — **sống sót qua trọn một
vòng review**, chỉ lộ ra nhờ một probe tầng module. Hàng phòng thủ duy nhất hôm
nay là một câu comment: *"TỪ ĐÂY TỚI HẾT KHÔNG ĐƯỢC CÓ `await` NÀO"*. Lần
refactor sau sẽ không đọc nó.

> **Tách CẢ CHUỖI, không tách riêng phần số học.** Đo được: một module chỉ giữ
> `seq`/`written`/`pending` thì **bản hỏng cũng pass** — 48 tổ hợp cộng 9 ca
> attach chồng nhau cho kết quả giống hệt khi gỡ bỏ phép so. Bất biến thật sự
> bảo vệ dữ liệu là **hình dạng của chuỗi promise**. Tách riêng phần số học
> không chỉ vô dụng mà còn tạo niềm tin sai.

**Files:**
- Create: `term/src/attach-queue.js`
- Create: `term/test/attach-queue.test.js`
- Modify: `term/bin/ccrc-host.js` (dùng module mới thay cho logic nội bộ)

**Interfaces:**
- Produces `createAttachQueue({ write, snapshot })` với:
  - `clients: Set` — tập client đang live, host mượn để tính kích thước nhỏ nhất
  - `enqueue(fn)` — nối một việc vào hàng ghi (resize đi đường này)
  - `feed(text, frame)` — nạp byte pty: ghi vào buffer, phát cho client live, ghi vào mọi mảng pending
  - `attach(client, { stillWanted, onAttached })` — chụp màn hình theo chuỗi rồi flush đúng phần thiếu
  - `detach(client)`

**Ràng buộc thiết kế, cả hai đều là bài học đã trả giá:**
- **MỘT tập client duy nhất.** Queue sở hữu, host mượn. Hai tập song song
  phải-add-cùng-lượt chính là hạng lỗi vừa vá.
- Từ sau `await link` tới hết `attach` **không được có `await` nào** — gửi
  snapshot, flush pending, `clients.add` phải nằm gọn một lượt đồng bộ.

- [ ] **Bước 1: Viết test đỏ**

`term/test/attach-queue.test.js`. `write` giả trả promise do **test cầm cương**,
nên mọi interleaving dựng được tất định. Bất biến phải khẳng định:
*mỗi client tái dựng đúng luồng byte kể từ điểm gắn — không sót, không lặp.*

Phải phủ tối thiểu:
1. Không có gì đang bay: attach nhận snapshot, không nhận thừa.
2. **Chunk rơi đúng cửa sổ** (đến sau khi attach bắt đầu, trước khi write settle):
   client phải thấy nó **đúng một lần**.
3. Hai attach chồng nhau: cả hai đều đúng, không ai thấy hai lần.
4. `snapshot()` ném: chỉ client ấy hỏng, `clients` không nhiễm, hàng ghi sống.
5. `stillWanted()` trả false giữa chừng: không add vào `clients`, không rò pending.
6. `enqueue` (resize) giữ đúng thứ tự với `feed`.

**Bài test số 2 là bài quan trọng nhất** — nó phải ĐỎ trên phiên bản đặt
`clients.add` trước `await`. Kiểm chứng bằng cách sửa tạm rồi chạy lại, và ghi
kết quả vào báo cáo. Một bài test không đỏ được trên bản hỏng thì không canh gì.

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

`node --test term/test/attach-queue.test.js` → FAIL, không tìm thấy module.

- [ ] **Bước 3: Viết `term/src/attach-queue.js`**

Hình dạng theo interface trên. Comment giải thích *vì sao* chuỗi phải như vậy —
mang nguyên lý lẽ từ `ccrc-host.js` sang, vì đây mới là nhà của nó.

- [ ] **Bước 4: Chạy test, xác nhận xanh**

- [ ] **Bước 5: Chuyển `ccrc-host.js` sang dùng module**

Xoá `seq`/`written`/`pendingAttachers`/`screenWrites` khỏi host; chúng thuộc về
queue. Host giữ `clients` **mượn từ queue**, không tạo tập riêng.

- [ ] **Bước 6: Chạy cả hai nền tảng**

macOS `npm test`; Windows `node --test term/test/ccrc-host.test.js` phải vẫn
**9/9** — đây là bằng chứng việc tách không đổi hành vi. Ghi mốc thời gian hồ sơ
thật trước/sau.

- [ ] **Bước 7: Commit**

```bash
git add term/src/attach-queue.js term/test/attach-queue.test.js term/bin/ccrc-host.js
git commit -m "refactor: extract the attach queue so its race can be tested

The bug this closes — a newly attached client losing output produced
while the snapshot was still queued — survived a full review and was
found by a module-level probe, not by the suite. What stops it today is
a comment saying no await may appear between the snapshot and the
client joining the broadcast set. The next refactor will not read it.

The whole chain moves, not just the counters. A module holding only
seq and written passes even when the host is broken: measured across 48
interleavings and 9 overlapping attaches, deleting the comparison
changed nothing. The invariant that protects data is the shape of the
promise chain, so that is what had to become testable.

One client set, owned by the queue and borrowed by the host. Two sets
that must be updated in the same tick is the exact bug class just fixed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
