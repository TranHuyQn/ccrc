# Kế hoạch: rút tầng adapter "nguồn pane" (đợt 1/2)

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`
> (khuyến nghị) hoặc `superpowers:executing-plans` để làm từng task. Các bước dùng
> checkbox (`- [ ]`) để theo dõi.

**Mục tiêu:** Rút mọi lời gọi tmux trong `term/bin/ccrc-term.js` ra sau một
interface "nguồn pane", **không đổi một hành vi nào** trên macOS/Linux.

**Kiến trúc:** Tạo `term/src/pane-source.js` với factory `createTmuxPaneSource()`
gói lại các hàm sẵn có của `term/src/tmux.js`. Chuyển khối
`wss.on('connection')` (`ccrc-term.js:429-955`) sang gọi qua factory đó. Bản
ConPTY cho Windows là đợt 2, KHÔNG thuộc kế hoạch này.

**Tech Stack:** Node.js 22, ESM, `node:test`, tmux thật (không mô phỏng), `ws`.

**Spec:** [`docs/superpowers/specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md)

## Ràng buộc toàn cục

- **Không được đổi hành vi trên macOS/Linux.** 482 test hiện có phải xanh, và
  không được sửa một bài test nào để cho nó xanh.
- **Không một dòng code Windows nào** trong kế hoạch này. Không `node-pty`, không
  named pipe, không `process.platform`.
- **Không thêm dependency nào.** Cả ba workspace hiện không có dependency native
  nào; giữ nguyên.
- Ngôn ngữ: code và commit message tiếng Anh; comment theo file đang sửa (file
  này pha tiếng Việt/Anh, viết theo đoạn xung quanh).
- Mọi commit kết thúc bằng trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Chạy `npm test` từ gốc worktree `.worktrees/windows-compat`.
- Adapter có **hai tầng**, không phải một danh sách phẳng:

  **Nguồn — MỘT cho cả daemon.** Đọc (7): `alive`, `snapshot`, `historySize`,
  `history`, `mouseMode`, `cwd`, `socket`. Cộng `attach({onData, onCtlReply,
  onGone})` trả về `{ok, conn}`.

  **Kết nối (`conn`) — MỘT cho mỗi trình duyệt đang xem.** `close`, `type`,
  `paste`, `resize`.

  Hai tầng vì bản đang chạy đã như vậy: phiên nhóm tmux dựng MỘT lần
  (`ccrc-term.js:479-509`) còn client `tmux -C` dựng cho TỪNG kết nối (`:517`,
  ngoài khối `if`). Gộp lại là kết nối thứ hai không có ống nào — bài test có
  sẵn `daemon.test.js` → `'hai client cùng gửi'` bắt được ngay. Hàng đợi lời đáp
  cũng thuộc tầng dưới, vì nó ghép lời đáp theo VỊ TRÍ trên MỘT ống.
- **Năm lời gọi tmux nằm NGOÀI khối connection** — đừng bỏ sót, Task 4 sẽ gãy
  build nếu chúng chưa được chuyển: `ccrc-term.js:146` (kiểm tra lúc khởi động),
  `:422` (trong upgrade handler), `:1084` (`paneCwd` ghi sổ tra phiên), `:1085`
  (`paneSocket`, cùng object nhưng là lời gọi riêng), `:1111` (vòng poll
  `PANE_CHECK_MS` = 2 giây).

## Cấu trúc file

| File | Trách nhiệm |
|---|---|
| `term/src/pane-source.js` (tạo mới) | Factory `createTmuxPaneSource()`. Không chứa logic mới — gói `tmux.js` lại sau một hình dạng ổn định. |
| `term/test/pane-source.test.js` (tạo mới) | Test cho factory, chạy trên tmux thật. |
| `term/bin/ccrc-term.js` (sửa) | Thay lời gọi tmux trực tiếp bằng lời gọi factory. |
| `term/src/tmux.js` | **KHÔNG SỬA.** Nó vốn đã đúng hình dạng cần. |

---

### Task 1: Nhóm đọc màn hình

Năm hàm thuần đọc, không đổi trạng thái gì — nhóm an toàn nhất, làm trước để
hình dạng factory được chốt trước khi đụng tới phần có trạng thái.

**Files:**
- Create: `term/src/pane-source.js`
- Create: `term/test/pane-source.test.js`
- Modify: `term/bin/ccrc-term.js` — khối connection 429–955 **và** năm chỗ ngoài
  nó: `:45` (thêm `paneChung`), `:146`, `:422`, `:1084-1085`, `:1111`

**Interfaces:**
- Consumes: `paneAlive`, `snapshotPane`, `paneHistorySize`, `captureHistory`,
  `paneMouseMode`, `paneCwd`, `paneSocket` từ `term/src/tmux.js` (đã có, không sửa).
- Produces: `createTmuxPaneSource({ pane })` trả về object có
  `alive(): boolean`, `snapshot(): string`, `historySize(): number`,
  `history(offset: number, rows: number): string`,
  `mouseMode(): { mouse: boolean, sgr: boolean }`,
  `cwd(): string`, `socket(): string`.

- [ ] **Bước 1: Viết test đỏ**

Tạo `term/test/pane-source.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmuxBin } from '../src/tmux.js';
import { createTmuxPaneSource } from '../src/pane-source.js';

const T = tmuxBin();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nhân bản có chủ ý của withSession trong tmux.test.js. Không rút ra dùng chung
// vì làm thế là sửa một file test đang xanh, mà cả kế hoạch này dựng trên việc
// 482 bài hiện có giữ nguyên làm mốc so sánh. Sáu dòng trùng rẻ hơn rủi ro đó.
function withSession(fn) {
  const s = `ccrc-ps-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  try {
    const pane = execFileSync(T, ['list-panes', '-t', s, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();
    return fn({ session: s, pane });
  } finally {
    try { execFileSync(T, ['kill-session', '-t', `=${s}`]); } catch {}
  }
}

test('alive() đúng cho pane sống và pane không tồn tại', () => {
  withSession(({ pane }) => {
    assert.equal(createTmuxPaneSource({ pane }).alive(), true);
    assert.equal(createTmuxPaneSource({ pane: '%999999' }).alive(), false);
  });
});

test('snapshot() chứa chữ đang hiện trên pane', async () => {
  await withSession(async ({ pane }) => {
    execFileSync(T, ['send-keys', '-t', pane, 'echo MOC-SNAPSHOT', 'Enter']);
    await sleep(300);
    const out = createTmuxPaneSource({ pane }).snapshot();
    assert.match(out, /MOC-SNAPSHOT/);
    // snapshotPane bọc bằng clear+home và đóng bằng SGR reset — hợp đồng này
    // là thứ trình duyệt dựa vào, không phải chi tiết trang trí.
    assert.ok(out.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
    assert.ok(out.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  });
});

test('historySize() tăng sau khi pane in nhiều dòng', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    execFileSync(T, ['send-keys', '-t', pane, 'for i in $(seq 1 60); do echo dong-$i; done', 'Enter']);
    await sleep(600);
    assert.ok(src.historySize() > 0, 'lịch sử phải khác 0 sau 60 dòng');
  });
});

test('history() trả về màn hình đã đóng khung, rỗng khi tham số vô lý', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    execFileSync(T, ['send-keys', '-t', pane, 'for i in $(seq 1 60); do echo dong-$i; done', 'Enter']);
    await sleep(600);
    const screen = src.history(10, 5);
    assert.ok(screen.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
    // Số 0 và số âm là "không có gì để hỏi", không phải lỗi — trả chuỗi rỗng.
    assert.equal(src.history(0, 5), '');
    assert.equal(src.history(10, 0), '');
  });
});

test('mouseMode() báo không có chuột cho shell thường', () => {
  withSession(({ pane }) => {
    assert.deepEqual(createTmuxPaneSource({ pane }).mouseMode(), { mouse: false, sgr: false });
  });
});

test('mouseMode() trả về mặc định an toàn cho pane đã chết', () => {
  // Không biết thì KHÔNG gửi byte chuột — gửi nhầm là gõ rác vào shell người
  // dùng. Hướng an toàn duy nhất.
  assert.deepEqual(createTmuxPaneSource({ pane: '%999999' }).mouseMode(), { mouse: false, sgr: false });
});

test('cwd() và socket() trả về khoá đối chiếu của sổ tra phiên', () => {
  withSession(({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    assert.ok(path.isAbsolute(src.cwd()), 'cwd phải là đường dẫn tuyệt đối');
    assert.ok(src.socket().length > 0, 'socket phải cho biết pane này thuộc server tmux nào');
  });
});

test('cwd() và socket() trả chuỗi rỗng cho pane đã chết, không ném', () => {
  // Pane chết là chuyện thường ngày (người dùng đóng Claude). Ném ở đây sẽ nổ
  // trong vòng poll 2 giây của daemon, ở một chỗ không ai bắt.
  const src = createTmuxPaneSource({ pane: '%999999' });
  assert.equal(src.cwd(), '');
  assert.equal(src.socket(), '');
});
```

Thêm `import path from 'node:path';` vào đầu file test.

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/pane-source.test.js`
Mong đợi: FAIL — `Cannot find module '../src/pane-source.js'`

- [ ] **Bước 3: Viết factory tối thiểu**

Tạo `term/src/pane-source.js`:

```js
// Một "nguồn pane" là mọi thứ ccrc-term cần biết về cái terminal nó đang phục
// vụ — đọc màn hình, gõ vào, đổi kích thước, biết khi nào nó mất.
//
// Tách ra khỏi ccrc-term.js vì trên Windows không có tmux, và cũng không có gì
// thay thế: kiến trúc ở đó phải lật từ "gắn vào pane có sẵn" sang "sở hữu
// ConPTY". Interface này là ranh giới giữa hai câu trả lời đó. Xem
// docs/superpowers/specs/2026-08-17-windows-native-design.md §5.
//
// Bản tmux dưới đây KHÔNG chứa logic mới. Nó gói lại các hàm đã có trong
// tmux.js, đúng nguyên trạng — mọi hành vi, mọi bài học đã trả giá vẫn nằm
// nguyên ở đó. Đây là điều kiện để 482 bài test hiện có còn dùng được làm mốc
// "không đổi gì".

import {
  paneAlive, snapshotPane, paneHistorySize, captureHistory, paneMouseMode,
  paneCwd, paneSocket,
} from './tmux.js';

export function createTmuxPaneSource({ pane }) {
  return {
    alive: () => paneAlive(pane),
    snapshot: () => snapshotPane(pane),
    historySize: () => paneHistorySize(pane),
    history: (offset, rows) => captureHistory(pane, offset, rows),
    mouseMode: () => paneMouseMode(pane),

    // Hai thứ này KHÔNG phải để vẽ ra màn hình — chúng là cách sổ tra phiên
    // (shared/session-registry.js) nhận ra phiên nào là phiên nào, để hook
    // thông báo gắn đúng tên vào đúng thẻ. cwd() không bao giờ rời khỏi máy;
    // nó là khoá đối chiếu cục bộ, và gửi nó đi là mở lại đúng lỗ rò riêng tư
    // mà cái sổ ấy sinh ra để bịt.
    cwd: () => paneCwd(pane),
    socket: () => paneSocket(pane),
  };
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/pane-source.test.js`
Mong đợi: PASS, 8/8 bài.

- [ ] **Bước 5: Chuyển `ccrc-term.js` sang dùng factory**

Trong `term/bin/ccrc-term.js`:

1. Thêm import (cạnh các import `../src/` hiện có, khoảng dòng 27):

```js
import { createTmuxPaneSource } from '../src/pane-source.js';
```

2. Ngay đầu callback `wss.on('connection', (ws, mintKey) => {` (dòng 429), trước
   `function sendPane`, thêm:

```js
  // Nguồn pane của riêng kết nối này. Nhóm đọc không giữ trạng thái nên tạo mới
  // mỗi kết nối là vô hại; các nhóm có trạng thái (attach/close) sẽ cần đúng
  // vòng đời này ở task sau.
  const paneSrc = createTmuxPaneSource({ pane: PANE });
```

3. Thay đúng năm chỗ sau, không đụng gì khác:

| Dòng (gốc) | Từ | Thành |
|---|---|---|
| 461 | `sendPane(snapshotPane(PANE));` | `sendPane(paneSrc.snapshot());` |
| 541 | `paneAlive(PANE)` | `paneSrc.alive()` |
| 578 | `const max = paneHistorySize(PANE);` | `const max = paneSrc.historySize();` |
| 588 | `sendPane(snapshotPane(PANE));` | `sendPane(paneSrc.snapshot());` |
| 591 | `const screen = captureHistory(PANE, offset, clientRows);` | `const screen = paneSrc.history(offset, clientRows);` |
| 852 | `const clickMode = paneMouseMode(PANE);` | `const clickMode = paneSrc.mouseMode();` |
| 885 | `const mode = paneMouseMode(PANE);` | `const mode = paneSrc.mouseMode();` |

4. Bốn lời gọi NGOÀI khối connection cũng phải chuyển ở bước này, nếu không Task
   4 sẽ gãy build. Thêm một nguồn dùng chung cho cả tiến trình, ngay sau
   `const PANE = process.env.CCRC_TERM_PANE;` (dòng 45):

```js
// Nguồn pane dùng chung cho những câu hỏi KHÔNG thuộc về một kết nối nào: kiểm
// tra lúc khởi động, vòng poll, và ghi sổ tra phiên. Nhóm đọc không giữ trạng
// thái nên dùng chung là an toàn — khác với attach/close, vốn phải theo đúng
// vòng đời của một kết nối.
const paneChung = createTmuxPaneSource({ pane: PANE });
```

rồi thay:

| Dòng (gốc) | Từ | Thành |
|---|---|---|
| 146 | `if (!paneAlive(PANE)) {` | `if (!paneChung.alive()) {` |
| 422 | `if (!paneAlive(PANE)) {` | `if (!paneChung.alive()) {` |
| 1084 | `cwd: paneCwd(PANE),` | `cwd: paneChung.cwd(),` |
| 1085 | `pane: PANE, tmux: paneSocket(PANE),` | `pane: PANE, tmux: paneChung.socket(),` |
| 1111 | `if (!paneAlive(PANE)) shutdown('pane tmux đã chết');` | `if (!paneChung.alive()) shutdown('pane tmux đã chết');` |

**Chưa xoá import cũ** khỏi `ccrc-term.js` ở bước này — `tmuxBin`,
`createGroupSession` và các hàm nhóm còn được dùng cho tới Task 2/3. Dọn import
là việc của Task 4; xoá sớm là gãy build.

- [ ] **Bước 6: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **490 bài** (482 cũ + 8 mới), 0 đỏ.

Nếu có bài đỏ: **KHÔNG sửa test.** Bài đỏ ở đây nghĩa là hành vi đã đổi, tức là
việc thay ở bước 5 sai — quay lại sửa code.

- [ ] **Bước 7: Commit**

```bash
git add term/src/pane-source.js term/test/pane-source.test.js term/bin/ccrc-term.js
git commit -m "refactor: read the pane's screen through a source interface

Windows has no tmux and nothing replaces it, so the daemon there has to
own a ConPTY instead of attaching to a pane somebody else already made.
This interface is where those two answers meet.

Nothing about the tmux path changes. The factory forwards to the same
functions in tmux.js, so every behaviour those encode — the snapshot's
clear+home framing, the SGR reset that stops a leaked colour tinting
everything after it, the safe 'no mouse' answer for a pane we cannot
read — is still decided in exactly one place.

Read-only calls first, on purpose: they hold no state, so the shape of
the interface gets settled before anything that can be got wrong twice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Vòng đời — attach, onData, onGone, close

Nhóm có trạng thái: dựng phiên nhóm, chạy `tmux -C`, và phân biệt "mất tạm" với
"hết phiên". Đây là chỗ nguy hiểm nhất của cả kế hoạch — sai ở `onGone` làm
trình duyệt nối lại vô hạn.

> **ĐỌC KỸ ĐOẠN NÀY TRƯỚC — nó là thứ bản kế hoạch đầu tiên viết SAI, và cái sai
> đó chỉ lộ ra khi có hai trình duyệt cùng mở.**
>
> Trên bản đang chạy (`ccrc-term.js`): `if (groupClientCount === 0)` mở ở dòng
> 479 và ĐÓNG ở 509; `groupClientCount++` ở 515; `const ctl = spawn(...)` ở
> **517 — NGOÀI khối if**.
>
> Nghĩa là: **phiên nhóm dựng MỘT lần cho cả daemon, còn client `tmux -C` dựng
> cho TỪNG kết nối.** Đó là cách nhiều tab trình duyệt mỗi cái có một đường
> đọc/ghi riêng vào cùng phiên nhóm.
>
> Gộp cả hai vào trong khối `if` là kết nối thứ 2 trở đi không có ctl nào. Đo
> được bằng bài test CÓ SẴN `term/test/daemon.test.js` → `'hai client cùng gửi:
> không ai nuốt tin nhắn của ai'`: nó đỏ với `tin nhắn của client A biến mất`,
> vì `ctlCmd` của client B gọi `null.stdin.write(...)` → TypeError không ai bắt
> → chết cả tiến trình daemon, kéo theo cả tin nhắn của A.
>
> Cùng lý do đó, **hàng đợi lời đáp `choLoiDap` thuộc về từng KẾT NỐI, không
> phải factory dùng chung.** Nó ghép lời đáp với lệnh bằng VỊ TRÍ trên MỘT ống
> ctl; hai kết nối dùng chung một hàng đợi sẽ ăn lời đáp của nhau — hỏng âm
> thầm, đúng kiểu tệ nhất mà comment trong code đã cảnh báo.

**Hình dạng đúng:**

```
createTmuxPaneSource({ pane, runId })      // MỘT cho cả daemon
  .alive() .snapshot() .historySize() .history() .mouseMode() .cwd() .socket()
  .attach({ onData, onCtlReply, onGone }) -> { ok: true, conn } | { ok: false, message }
       conn.ctlCmd(cmd, cb)   // quá độ, Task 3 thay bằng type/paste/resize
       conn.close()
```

Phiên nhóm dựng ở lần `attach()` đầu tiên, dọn khi `conn` cuối cùng đóng —
**factory tự đếm**, daemon không còn giữ sổ sách vòng đời phiên nhóm nữa. Đó
đúng là thứ cuộc refactor này sinh ra để bỏ đi, và nó ánh xạ sạch sang Windows:
factory là host, `attach()` là mở một pipe tới host.

**Files:**
- Modify: `term/src/pane-source.js`
- Modify: `term/test/pane-source.test.js`
- Modify: `term/bin/ccrc-term.js` (dòng 45 vùng khai báo, 479–530, 640–660, 935–965)

**Interfaces:**
- Consumes: `createTmuxPaneSource({ pane })` từ Task 1 (7 phương thức đọc).
- Produces: factory nhận thêm `runId`, và có thêm:
  - `attach({ onData, onCtlReply, onGone }): { ok: true, conn } | { ok: false, message }`
  - `conn.ctlCmd(cmd: string, cb?: (ok: boolean, message: string) => void): void`
  - `conn.close(): void`
  - `onGone` được gọi với `({ fatal: boolean, reason: string })`.
    `fatal:false` = mất đường tiếp sức của MỘT kết nối (WebSocket đóng `1011`);
    `fatal:true` = phiên hết thật (`4001`).
  - `onCtlReply(ok, message)` chỉ còn là đường báo lỗi cho lời đáp **không ai
    đăng ký nhận** — hàng đợi đã nằm trong `conn`.

> **Mọi bài test có gọi `attach()` PHẢI gọi `conn.close()` trong `finally`.**
> `attach()` đẻ ra một tiến trình `tmux -C` con; không đóng thì nó sống tiếp và
> `node --test` **không bao giờ thoát** — bài test treo chứ không đỏ, và treo
> khó chẩn đoán hơn đỏ nhiều. Đặt trong `finally`, không phải cuối thân hàm.
>
> **Đừng dùng `sleep()` cố định để chờ pane in ra chữ.** Đo được trên máy này:
> shell mất 1,15–1,75 giây mới nhận lệnh. Task 1 đã để sẵn `waitForLine(pane,
> marker)` — khớp CẢ DÒNG, vì `send-keys` đặt nguyên văn lệnh chưa chạy lên màn
> hình ngay lập tức nên chuỗi con khớp từ trước khi Enter được xử lý. Chờ thứ
> khác thì viết vòng lặp điều kiện + hạn chót.

- [ ] **Bước 1: Viết test đỏ**

Thêm vào cuối `term/test/pane-source.test.js` (thêm `hasSession`,
`GROUP_MARKER_OPTION` vào khối import từ `../src/tmux.js`):

```js
test('attach() dựng phiên nhóm mang dấu của mình, conn cuối đóng thì dọn đi', async () => {
  await withSession(async ({ pane }) => {
    const runId = `${process.pid}-t2a`;
    const src = createTmuxPaneSource({ pane, runId });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    assert.equal(r.ok, true, r.message);
    await sleep(400);

    // Lọc theo runId của CHÍNH lần chạy này. `npm test` chạy
    // --test-concurrency=4 và tmux.test.js cũng tạo phiên mang dấu trên cùng
    // một tmux server — đếm tổng là bài đỏ ngẫu nhiên đang chờ xảy ra.
    const nhom = () => execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}\t#{session_name}`],
      { encoding: 'utf8' }).trim().split('\n')
      .filter((l) => l.split('\t')[0] === runId)
      .map((l) => l.split('\t')[1]);

    assert.equal(nhom().length, 1, 'đúng một phiên nhóm mang runId này');
    const ten = nhom()[0];

    r.conn.close();
    await sleep(400);
    assert.equal(hasSession(ten), false, 'conn cuối đóng thì phiên nhóm phải được dọn');
    // Pane của người dùng KHÔNG được chết theo. Giết phiên nhóm chỉ gỡ liên
    // kết, không phá cửa sổ — đây là chỗ dự án đã từng giết nhầm phiên sống.
    assert.equal(src.alive(), true, 'pane gốc phải còn nguyên');
  });
});

test('hai attach() dùng CHUNG một phiên nhóm, mỗi cái một ctl riêng', async () => {
  // Đây là bài canh đúng cái mà bản kế hoạch đầu tiên làm hỏng: phiên nhóm dựng
  // một lần, nhưng mỗi kết nối phải có ống ctl của riêng nó.
  await withSession(async ({ pane }) => {
    const runId = `${process.pid}-t2e`;
    const src = createTmuxPaneSource({ pane, runId });
    const a = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    const b = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(a.ok, true, a.message);
      assert.equal(b.ok, true, b.message);
      assert.notEqual(a.conn, b.conn, 'mỗi kết nối một handle riêng');
      await sleep(400);
      const dem = execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}`],
        { encoding: 'utf8' }).trim().split('\n').filter((l) => l === runId).length;
      assert.equal(dem, 1, 'hai kết nối vẫn chỉ MỘT phiên nhóm');

      // Đóng một cái không được kéo cái kia xuống theo.
      a.conn.close();
      await sleep(300);
      assert.equal(src.alive(), true, 'pane còn sống sau khi một kết nối đóng');
      const conNhom = execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}`],
        { encoding: 'utf8' }).trim().split('\n').filter((l) => l === runId).length;
      assert.equal(conNhom, 1, 'phiên nhóm phải sống tiếp khi vẫn còn kết nối khác');
    } finally {
      try { a.conn && a.conn.close(); } catch {}
      try { b.conn && b.conn.close(); } catch {}
    }
  });
});

test('attach() báo lỗi thay vì ném khi pane không tồn tại', () => {
  const src = createTmuxPaneSource({ pane: '%999999', runId: `${process.pid}-t2b` });
  const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  assert.equal(r.ok, false);
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0, 'phải nói được vì sao');
});

test('onData nhận byte pane in ra', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t2c` });
    let thay = '';
    const r = src.attach({ onData: (d) => { thay += d; }, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      execFileSync(T, ['send-keys', '-t', pane, 'echo MOC-ONDATA', 'Enter']);
      // Chờ ĐIỀU KIỆN, không chờ một con số mili giây.
      const hetGio = Date.now() + 8000;
      while (!/MOC-ONDATA/.test(thay) && Date.now() < hetGio) await sleep(100);
      assert.match(thay, /MOC-ONDATA/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('onGone báo fatal:true khi pane chết hẳn', async () => {
  const s = `ccrc-ps-gone-${process.pid}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['list-panes', '-t', s, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();
  const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t2d` });
  let bao = null;
  let r = null;
  try {
    r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (e) => { bao = e; } });
    assert.equal(r.ok, true, r.message);
    await sleep(400);
    // `kill-pane`, KHÔNG phải `kill-session`. Đo được trên tmux của máy này:
    // giết phiên GỐC trong khi phiên nhóm vẫn giữ cùng cửa sổ thì PANE VẪN
    // SỐNG — nên `fatal:true` không bao giờ đạt tới theo đường đó, client
    // control-mode cũng không thoát, và bài test đứng chờ một sự kiện không
    // đến. Chỉ kill-pane mới thật sự huỷ pane ở mọi phiên đang giữ nó.
    execFileSync(T, ['kill-pane', '-t', pane]);
    const hetGio = Date.now() + 8000;
    while (bao === null && Date.now() < hetGio) await sleep(100);
    assert.ok(bao, 'phải gọi onGone');
    assert.equal(bao.fatal, true, 'pane chết là hết phiên, không phải trục trặc tạm');
  } finally {
    if (r && r.conn) r.conn.close();
    try { execFileSync(T, ['kill-session', '-t', `=${s}`]); } catch {}
  }
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test --test-timeout=60000 term/test/pane-source.test.js`
Mong đợi: FAIL — `src.attach is not a function`

- [ ] **Bước 3: Thêm vòng đời vào factory**

Sửa `term/src/pane-source.js`. Bổ sung import:

```js
import { spawn } from 'node:child_process';
import {
  tmuxBin, hasSession, reclaimPaneSession, claimGroupName, createGroupSession,
  killGroupSession, makeRunId,
} from './tmux.js';
import { attachControlOutput } from './control-stream.js';
```

và đổi factory thành:

```js
export function createTmuxPaneSource({ pane, runId = makeRunId() }) {
  // MỘT nguồn cho cả daemon. Phiên nhóm dựng một lần và dùng chung; mỗi kết
  // nối trình duyệt có ống `tmux -C` của riêng nó. Đó đúng là hình dạng bản
  // đang chạy — xem ghi chú đầu Task 2 để biết vì sao gộp lại là hỏng.
  let groupName = null;
  let soKetNoi = 0;
  // Đếm chung cho CẢ TIẾN TRÌNH, không phải cho từng kết nối: tên buffer dán
  // sinh ra từ `runId` + số này, mà runId dùng chung cả daemon. Đặt bộ đếm
  // trong attach() là hai kết nối cùng bắt đầu từ 0, lượt dán đầu của cả hai
  // trùng tên, và cái sau đè nội dung cái trước ngay trước khi paste-buffer
  // kịp đọc. Bài test có sẵn 'hai client cùng gửi' bắt được đúng ca này.
  let pasteSeq = 0;

  const doc = {
    alive: () => paneAlive(pane),
    snapshot: () => snapshotPane(pane),
    historySize: () => paneHistorySize(pane),
    history: (offset, rows) => captureHistory(pane, offset, rows),
    mouseMode: () => paneMouseMode(pane),
    cwd: () => paneCwd(pane),
    socket: () => paneSocket(pane),
  };

  // Dựng phiên nhóm nếu chưa có. Idempotent: kết nối thứ hai dùng lại phiên
  // nhóm đã có, KHÔNG đi qua claimGroupName lần nữa — `isReclaimableMarker`
  // coi dấu mang đúng runId của mình là "được phép thu hồi", nên gọi lại sẽ
  // GIẾT chính phiên nhóm đang phục vụ những kết nối khác.
  function baoDamNhom() {
    if (groupName) return { ok: true };
    // reclaimPaneSession trả null khi pane đã chết, và cả khi thứ duy nhất còn
    // giữ pane là phiên nhóm của chính mình — dọn nó đi là giết luôn cái pane
    // đang định phục vụ. Cả hai đều nghĩa là "không phục vụ được".
    const base = reclaimPaneSession(pane, runId);
    if (!base) return { ok: false, message: 'pane đã chết' };
    const name = claimGroupName(base, runId);
    if (!name) return { ok: false, message: 'không đặt được tên cho phiên nhóm terminal' };
    try {
      createGroupSession(base, name, runId);
    } catch {
      return { ok: false, message: 'không tạo được phiên nhóm cho terminal' };
    }
    groupName = name;
    return { ok: true };
  }

  return {
    ...doc,

    attach({ onData, onCtlReply, onGone }) {
      const g = baoDamNhom();
      if (!g.ok) return g;

      // Gắn vào PHIÊN NHÓM, không bao giờ vào phiên thật của người dùng: tmux
      // co cửa sổ dùng chung về client nhỏ nhất, nên gắn thẳng nghĩa là điện
      // thoại vừa nối là màn hình trên bàn tụt còn 40 cột.
      const ctl = spawn(tmuxBin(), ['-C', 'attach-session', '-t', groupName], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      soKetNoi += 1;
      let dangTuDong = false;

      // Ghi vào stdin của tiến trình đã chết bắn 'error' (EPIPE); không có
      // handler là ngoại lệ không ai bắt. Con chết đã có bao() lo.
      ctl.stdin.on('error', () => {});

      // Client control-mode thoát KHÔNG đồng nghĩa pane chết. Nó cũng xảy ra
      // khi chỉ riêng phiên nhóm bị gỡ (một `tmux kill-session` từ bên ngoài,
      // một cuộc đua) trong khi pane và phiên thật của người dùng nguyên vẹn.
      // Phân biệt hai ca là việc của hàm này — và phải xong TRƯỚC khi ai đó
      // đóng socket, vì đóng nhầm mã là trình duyệt nối lại vô hạn.
      const bao = (reason) => {
        if (dangTuDong) return;
        const nhomMat = groupName !== null && !hasSession(groupName);
        onGone({ fatal: !(nhomMat && paneAlive(pane)), reason });
      };
      ctl.on('exit', () => bao('tmux -C thoát bất ngờ'));
      ctl.on('error', (err) => bao(`tmux -C lỗi: ${err.message}`));

      // Hàng đợi lời đáp thuộc về ĐÚNG ống này, không dùng chung giữa các kết
      // nối. tmux control mode trả lời mỗi lệnh bằng đúng một khối theo đúng
      // thứ tự nhận, nên ghép theo VỊ TRÍ chỉ đúng khi hàng đợi và ống là
      // một-một. Dùng chung là hai trình duyệt ăn lời đáp của nhau.
      //
      // Và MỌI lệnh phải đi qua ctlCmd, không ngoại lệ: một `ctl.stdin.write`
      // viết thẳng ở đâu đó là lệch cả hàng từ điểm ấy trở đi.
      const choLoiDap = [];
      function ctlCmd(cmd, cb) {
        choLoiDap.push(cb || null);
        ctl.stdin.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
      }

      attachControlOutput(ctl.stdout, pane, onData, (ok, message) => {
        const cb = choLoiDap.shift();
        if (cb) { cb(ok, String(message || '').slice(0, 200)); return; }
        onCtlReply(ok, message);
      });

      const conn = {
        // Quá độ: Task 3 thay mọi lời gọi ctlCmd ở ccrc-term.js bằng
        // type/paste/resize, rồi cái này thành nội bộ.
        ctlCmd,
        close() {
          if (dangTuDong) return;
          dangTuDong = true;
          try { ctl.kill(); } catch {}
          soKetNoi = Math.max(0, soKetNoi - 1);
          // Kết nối cuối cùng rời đi thì phiên nhóm không còn lý do tồn tại,
          // và bỏ lại là rò vĩnh viễn. killGroupSession chỉ giết thứ mang dấu
          // của mình, nên một phiên trùng tên do người dùng đặt vẫn an toàn.
          if (soKetNoi === 0 && groupName) { killGroupSession(groupName); groupName = null; }
        },
      };
      return { ok: true, conn };
    },
  };
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test --test-timeout=60000 term/test/pane-source.test.js`
Mong đợi: PASS, 13/13 bài.

- [ ] **Bước 5: Chuyển `ccrc-term.js` sang dùng vòng đời**

1. Tạo nguồn dùng chung ở phạm vi module. `paneChung` (Task 1) đã ở đó cho các
   câu hỏi ngoài kết nối; **thêm `runId` cho nó** và dùng luôn nó làm nguồn
   chung, thay vì tạo cái thứ hai:

```js
const paneChung = createTmuxPaneSource({ pane: PANE, runId: RUN_ID });
```

2. Trong khối `wss.on('connection')`: XOÁ dòng `const paneSrc =
   createTmuxPaneSource({ pane: PANE });` của Task 1 và thay mọi `paneSrc.` bằng
   `paneChung.` cho các phương thức ĐỌC.

3. `showHistory`, `historyOffset`, `clientRows`, `clientCols` phải khai báo
   **TRƯỚC** lời gọi `attach()`, vì `onData` đọc `historyOffset`. Di chuyển cả
   cụm lên trên.

4. Thay khối dựng nhóm (479–509) **và** khối `spawn(tmuxBin(), ['-C', ...])` +
   `onCtlGone` + `attachControlOutput` (517–627) bằng:

```js
  const gan = paneChung.attach({
    onData: (data) => {
      // Giữ lại chứ không vứt: showHistory(0) gửi lại nguyên màn hình hiện tại
      // trên đường quay về, nên không mất gì.
      if (historyOffset > 0) return;
      sendPane(data);
    },
    onCtlReply: (ok, message) => {
      // Lời đáp không ai đăng ký nhận. Xuôi thì chẳng có gì để nói; hỏng thì
      // vẫn phải nói ra — im lặng ở đây nghĩa là người dùng ngồi chờ Claude
      // trả lời một câu nó chưa bao giờ nhận.
      if (!ok) sendCtl({ type: 'ccrc_loi', message: String(message).slice(0, 200) });
    },
    onGone: ({ fatal, reason }) => {
      if (!fatal) {
        // Chỉ mất đường tiếp sức của riêng kết nối này; pane vẫn sống, nối lại
        // là được — đúng lúc để dùng mã "lỗi máy chủ".
        try { ws.close(1011, 'tmux control mode đã đóng bất ngờ'); } catch {}
        close();
        return;
      }
      // Pane không còn: phiên hết thật. Để shutdown() tự nói bằng mã 4001.
      shutdown(reason);
    },
  });
  if (!gan.ok) { ws.close(1011, gan.message); return; }
  const conn = gan.conn;
```

   Lưu ý thứ tự: `attach()` bây giờ gọi cho MỌI kết nối, không nằm trong
   `if (groupClientCount === 0)` nữa.

5. `ctlCmd` trong `ccrc-term.js` (dòng ~652) đổi thành gọi thẳng `conn.ctlCmd`,
   và XOÁ `choLoiDap` khỏi `ccrc-term.js` — hàng đợi đã nằm trong `conn`:

```js
  const ctlCmd = (cmd, cb) => conn.ctlCmd(cmd, cb);
```

6. Trong `close()` (dòng ~941), thay `try { ctl.kill(); } catch {}` và khối
   `killGroupSession(groupSessionName)` bằng:

```js
    conn.close();
```

   và xoá biến `groupSessionName` cùng `closingByUs` khỏi `ccrc-term.js` — cả
   hai đã chuyển vào factory. `groupClientCount` giữ lại nếu còn chỗ khác dùng;
   nó không còn quyết định vòng đời phiên nhóm nữa.

- [ ] **Bước 6: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **496 bài** (490 + 5 mới + 1 test canh shutdown), 0 đỏ.

Ba suite phải nhìn kỹ nếu có đỏ, theo đúng thứ tự này:
1. `term/test/daemon.test.js` → `'hai client cùng gửi: không ai nuốt tin nhắn
   của ai'` — bài canh chính xác cái lỗi kiến trúc mô tả ở đầu task.
2. `term/test/pane-label-race.test.js` — đua giữa nhiều client.
3. `term/test/compose-delivery.test.js` — ack của ô soạn.

- [ ] **Bước 7: Commit**

```bash
git add term/src/pane-source.js term/test/pane-source.test.js term/bin/ccrc-term.js
git commit -m "refactor: move the pane's lifecycle behind the source interface

One source per daemon, one attach per connection. That split is not a
design preference, it is what the daemon already does: the grouped tmux
session is created once, but each browser gets its own tmux -C client,
which is how two tabs each have a working pipe into the same session.
Collapsing them would leave the second connection with no pipe at all,
and the existing two-client test proves it — the write goes to null and
the TypeError takes the whole daemon down with it.

The reply queue moves into the connection for the same reason. tmux
control mode answers commands in the order it receives them, so pairing
replies to commands by position is only correct while queue and pipe are
one-to-one. Sharing one queue across connections would have two browsers
eating each other's answers, silently.

onGone answers with {fatal}, which is the distinction that matters here.
A control client exiting does not prove the pane died — it also happens
when only the group is removed while the pane and the user's real
session are untouched. The first is one connection losing its relay
(close 1011, reconnect works); the second is the session actually being
over (4001). Deciding this AFTER closing the socket makes 1011 win, and
the browser then reconnects forever.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Nhóm ghi — type, paste, resize

**Files:**
- Modify: `term/src/pane-source.js`
- Modify: `term/test/pane-source.test.js`
- Modify: `term/bin/ccrc-term.js` (dòng ~652–790, và các chỗ gọi `ctlCmd`)

**Interfaces:**
- Consumes: `attach()` → `conn` từ Task 2.
- Produces, **trên `conn` chứ không phải trên factory** (chúng ghi vào ống ctl
  của riêng kết nối đó):
  - `conn.type(bytes: Buffer|Uint8Array): void`
  - `conn.paste(text: string, { onAck, onErr }): void` — `onAck()` khi tmux đã
    xác nhận CẢ lệnh dán LẪN cú Enter; `onErr(message: string)` khi hỏng.
  - `conn.resize(cols: number, rows: number): void`
  - `conn.ctlCmd` trở thành nội bộ, không còn ai ngoài factory gọi.

- [ ] **Bước 1: Viết test đỏ**

Thêm vào `term/test/pane-source.test.js`:

```js
test('type() gõ chữ vào pane thật', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3a` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      r.conn.type(Buffer.from('echo MOC-TYPE\r', 'utf8'));
      await waitForLine(pane, 'MOC-TYPE');
      assert.match(src.snapshot(), /MOC-TYPE/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('paste() chỉ báo ack sau khi tmux xác nhận cả nội dung lẫn Enter', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3b` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      const ack = await new Promise((resolve, reject) => {
        const treo = setTimeout(() => reject(new Error('không nhận được ack')), 15000);
        r.conn.paste('echo MOC-PASTE', {
          onAck: () => { clearTimeout(treo); resolve(true); },
          onErr: (m) => { clearTimeout(treo); reject(new Error(m)); },
        });
      });
      assert.equal(ack, true);
      await waitForLine(pane, 'MOC-PASTE');
      assert.match(src.snapshot(), /MOC-PASTE/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('resize() không giết gì cả', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3c` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      r.conn.resize(60, 20);
      await sleep(500);
      // Không khẳng định con số cụ thể của pane: tmux quyết kích thước theo mọi
      // client đang gắn, và trong test không có client thật nào ngồi trước
      // phiên gốc. Chỉ khẳng định điều thật sự quan trọng.
      assert.equal(src.alive(), true);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test --test-timeout=60000 term/test/pane-source.test.js`
Mong đợi: FAIL — `r.conn.type is not a function`

- [ ] **Bước 3: Thêm nhóm ghi vào `conn`**

Thêm import `splitForSendKeys`:

```js
import { splitForSendKeys } from './key-chunks.js';
```

Chuyển hai hằng sau từ `ccrc-term.js:88` và `:100` sang đầu
`term/src/pane-source.js` kèm nguyên văn comment, rồi **xoá khỏi
`ccrc-term.js`**:

```js
// Nhịp nghỉ giữa nội dung dán và cú Enter kết thúc nó. Đủ để TUI phía kia đọc
// xong đoạn dán trong một lượt riêng, đủ nhỏ để không ai nhận ra.
const COMMIT_DELAY_MS = 30;

// Bao lâu thì coi như `tmux load-buffer` treo. Nó ghi vào một tiến trình con,
// và hàng đợi gõ phím của kết nối đó ĐANG chờ nó xong — treo mà không có trần
// thì không chỉ tin nhắn ấy mất, mà mọi phím bấm sau đó của cái điện thoại ấy
// cũng chết câm, không một lời báo.
const PASTE_LOAD_TIMEOUT_MS = 5000;
```

`MAX_PASTE_BYTES = 100_000` (`ccrc-term.js:94`) **Ở LẠI** `ccrc-term.js`: nó là
trần cho thứ đến từ trình duyệt, không phải giới hạn của cái pane.

Bên trong `attach()`, cạnh `ctlCmd`, thêm:

```js
      // send-keys -H nhận hex, nên không còn câu hỏi trích dẫn nào để trả lời
      // sai — ký tự điều khiển, xuống dòng, UTF-8 đều đi qua nguyên vẹn.
      function sendKeysHex(bytes, cb) {
        const hex = Buffer.from(bytes).toString('hex').match(/../g) || [];
        if (hex.length === 0) return;
        ctlCmd(`send-keys -t ${pane} -H ${hex.join(' ')}`, cb);
      }

      // Nối tiếp, không song song, và DÙNG CHUNG giữa type và paste: một cú
      // Enter của thanh phím chen vào giữa đoạn dán sẽ gửi đi nửa tin nhắn.
      // Hàng đợi này theo TỪNG kết nối — nó canh thứ tự ghi vào ống của riêng
      // kết nối ấy.
      let typeQueue = Promise.resolve();
```

và ba phương thức vào object `conn`:

```js
        type(data) {
          const { chunks, commit } = splitForSendKeys(data);
          if (chunks.length === 0 && !commit) return;
          typeQueue = typeQueue.then(async () => {
            for (const chunk of chunks) sendKeysHex(chunk);
            if (commit) {
              await new Promise((r) => setTimeout(r, COMMIT_DELAY_MS));
              sendKeysHex(commit);
            }
          }).catch(() => { /* một lượt hỏng không được làm nghẽn những lượt sau */ });
        },

        // Dán KHÁC hẳn gõ, và khác vì một lý do đo được: ứng dụng trong pane có
        // thể hiểu bracketed paste, hoặc không. Claude Code KHÔNG bật (`?2004h`
        // xuất hiện 0 lần trong bản 2.1.233) — trang tự bọc dấu là cả cụm bị
        // vứt trong hộp thoại AskUserQuestion. zsh thì ngược lại: gửi chữ thô
        // nhiều dòng vào đấy là mỗi dòng chạy thành một lệnh.
        //
        // Không đoán hộ ai: `paste-buffer -p` bọc dấu KHI VÀ CHỈ KHI ứng dụng
        // đã xin chế độ đó, và tmux là bên duy nhất biết. `-r` giữ nguyên LF
        // (mặc định tmux đổi thành CR, tức gửi dòng đầu đi như một câu hoàn
        // chỉnh). `-d` xoá buffer ngay sau khi dán để không bỏ rác vào danh
        // sách buffer của người dùng.
        paste(text, { onAck, onErr }) {
          const bytes = Buffer.from(text, 'utf8');
          if (bytes.length === 0) return;
          // Tên buffer riêng từng lượt: hai client dán cùng lúc mà dùng chung
          // một tên thì lượt sau đè nội dung lượt trước ngay trước khi nó kịp
          // được dán.
          const name = `ccrc-${runId}-${pasteSeq += 1}`.replace(/[^A-Za-z0-9_-]/g, '');
          typeQueue = typeQueue.then(() => new Promise((resolve) => {
            const loader = spawn(tmuxBin(), ['load-buffer', '-b', name, '-'], {
              stdio: ['pipe', 'ignore', 'ignore'],
            });
            // Một lượt dán chỉ được kết thúc ĐÚNG MỘT LẦN. Khi spawn hỏng, Node
            // bắn 'error' rồi bắn tiếp 'close' với mã null — không chốt lại thì
            // người dùng nhận hai thông báo, cái thứ hai vô nghĩa.
            let done = false;
            let treo = null;
            const finish = () => { if (done) return false; done = true; clearTimeout(treo); resolve(); return true; };
            const fail = (why) => {
              // Im lặng ở đây nghĩa là ô soạn phía người dùng vẫn trống đi như
              // đã gửi, còn tin nhắn thì chưa từng tồn tại.
              if (!finish()) return;
              onErr(`không dán được: ${why}`);
            };
            treo = setTimeout(() => {
              try { loader.kill('SIGKILL'); } catch {}
              fail('tmux không phản hồi');
            }, PASTE_LOAD_TIMEOUT_MS);
            loader.on('error', (e) => fail(String(e && e.message).slice(0, 120)));
            loader.on('close', (code) => {
              if (done) return;
              if (code !== 0) return fail(`load-buffer trả mã ${code}`);
              // load-buffer xong mới chỉ chứng minh cái BUFFER đã có. Nó không
              // nói gì về việc pane có nhận được hay không — pane có thể vừa
              // chết trong đúng khoảnh khắc này.
              ctlCmd(`paste-buffer -d -p -r -b ${name} -t ${pane}`, (ok, message) => {
                if (!ok) return fail(message || 'tmux từ chối paste-buffer');
                setTimeout(() => {
                  sendKeysHex(Buffer.from([0x0d]), (okEnter, loiEnter) => {
                    if (!okEnter) return fail(loiEnter || 'tmux từ chối cú Enter');
                    // ĐÃ dán VÀ đã chốt bằng Enter, cả hai đều được tmux xác
                    // nhận — chỉ tới đây điện thoại mới được phép quên chữ đó.
                    onAck();
                    finish();
                  });
                }, COMMIT_DELAY_MS);
              });
            });
            loader.stdin.on('error', () => { /* 'close' ở trên lo nốt */ });
            loader.stdin.end(bytes);
          })).catch(() => {});
        },

        resize(cols, rows) {
          ctlCmd(`refresh-client -C ${cols}x${rows}`);
        },
```

Rồi **bỏ `ctlCmd` khỏi object `conn`** — không ai ngoài factory gọi nó nữa.

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test --test-timeout=60000 term/test/pane-source.test.js`
Mong đợi: PASS, 16/16 bài.

- [ ] **Bước 5: Chuyển `ccrc-term.js` sang dùng nhóm ghi**

1. Xoá `ctlCmd`, `sendKeysHex`, `typeIntoPane`, `pasteIntoPane`, `typeQueue`,
   `pasteSeq` khỏi `ccrc-term.js` — tất cả đã chuyển vào `conn`.
2. Thay các chỗ gọi:

| Chỗ | Từ | Thành |
|---|---|---|
| `ws.on('message')` nhánh nhị phân | `typeIntoPane(data);` | `conn.type(data);` |
| `ccrc_click` | `ctlCmd('send-keys -t ... -H ...')` | `conn.type(Buffer.from(clickBytes({...}), 'binary'));` |
| `ccrc_scroll` nhánh có chuột | `ctlCmd('send-keys -t ... -H ...')` | `conn.type(Buffer.from(bytes, 'binary'));` |
| `ccrc_resize` | `ctlCmd(\`refresh-client -C ${cols}x${rows}\`)` | `conn.resize(cols, rows);` |

3. `ccrc_paste` — kiểm tra độ dài ở lại `ccrc-term.js` vì `MAX_PASTE_BYTES` là
   giới hạn của giao thức với trình duyệt, không phải của cái pane:

```js
      if (historyOffset > 0) showHistory(0);
      const bytes = Buffer.byteLength(msg.text, 'utf8');
      if (bytes > MAX_PASTE_BYTES) {
        sendCtl({ type: 'ccrc_loi', seq: msg.seq, message: `tin nhắn quá dài (${bytes} byte)` });
        return;
      }
      conn.paste(msg.text, {
        onAck: () => sendCtl({ type: 'ccrc_ack', seq: msg.seq }),
        onErr: (m) => sendCtl({ type: 'ccrc_loi', seq: msg.seq, message: m }),
      });
```

**Chú ý:** `clickBytes` và `wheelBytes` giờ đi qua `conn.type()`, nghĩa là chúng
bị `splitForSendKeys` cắt. Byte chuột luôn ngắn (dưới 20 byte) nên không bao giờ
chạm ngưỡng cắt — nhưng phải kiểm chứng bằng test ở bước 6, không được tin lời.

- [ ] **Bước 6: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **499 bài**, 0 đỏ.

Ba suite đáng nhìn kỹ nếu có đỏ: `term/test/compose-delivery.test.js` (ack của ô
soạn), `term/test/mouse.test.js` (byte chuột), `term/test/term-input.test.js`.

- [ ] **Bước 7: Commit**

```bash
git add term/src/pane-source.js term/test/pane-source.test.js term/bin/ccrc-term.js
git commit -m "refactor: move typing, pasting and resizing onto the connection

They belong to a connection, not to the pane: each writes into that
connection's own tmux -C pipe, and the reply queue that pairs answers
with commands is per-pipe. Hanging them off the shared source would have
two browsers writing into one queue and reading each other's answers.

type and paste stay separate because they are separate. An application
may or may not understand bracketed paste, and only tmux knows which:
paste-buffer -p adds the markers if and only if the app asked for that
mode. Claude Code does not (?2004h appears zero times in 2.1.233), zsh
does. Guessing wrong costs a whole message either way.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---


### Task 4: Dọn — không còn lời gọi tmux nào ngoài adapter

**Files:**
- Modify: `term/bin/ccrc-term.js` (khối import, dòng 8–37)
- Create: `term/test/pane-source-boundary.test.js`

**Interfaces:**
- Consumes: mọi thứ ba task trước tạo ra.
- Produces: không có API mới. Task này dựng một **hàng rào** để đợt 2 không phá.

- [ ] **Bước 1: Viết test đỏ (test canh ranh giới)**

Tạo `term/test/pane-source-boundary.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = path.dirname(fileURLToPath(import.meta.url));
const doc = (p) => fs.readFileSync(path.join(GOC, '..', p), 'utf8');

// Ranh giới này là toàn bộ lý do đợt refactor tồn tại. Nếu ccrc-term.js được
// phép gọi thẳng tmux lần nữa thì bản ConPTY cho Windows sẽ thiếu đúng chỗ ấy
// — và thiếu một cách âm thầm, chỉ lộ ra trên máy Windows của người dùng.
// Nên nó được canh bằng test, không bằng lời hứa trong tài liệu.
test('ccrc-term.js không import gì từ tmux.js', () => {
  const src = doc('bin/ccrc-term.js');
  const m = src.match(/^import[\s\S]*?from '\.\.\/src\/tmux\.js';/m);
  assert.equal(m, null, `ccrc-term.js vẫn còn import từ tmux.js:\n${m && m[0]}`);
});

// Lột comment trước khi soi. `ccrc-term.js:76` là một comment đang đúng việc —
// nó giải thích vì sao cols/rows phải chặn khoảng, và có nhắc `refresh-client`.
// Comment ấy ở lại (phần validate cols/rows ở lại), nên soi cả file là bài test
// không bao giờ xanh được trừ khi xoá một comment không có gì sai.
function chiCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('ccrc-term.js không tự chạy binary tmux', () => {
  const src = chiCode(doc('bin/ccrc-term.js'));
  assert.ok(!src.includes('tmuxBin('), 'ccrc-term.js không được tự gọi tmuxBin()');
  assert.ok(!/send-keys|paste-buffer|load-buffer|capture-pane|refresh-client/.test(src),
    'ccrc-term.js không được dựng lệnh tmux nào');
});

test('pane-source.js là nơi duy nhất trong term/src dựng client control-mode', () => {
  const files = fs.readdirSync(path.join(GOC, '..', 'src')).filter((f) => f.endsWith('.js'));
  const coCtl = files.filter((f) => doc(path.join('src', f)).includes("'-C', 'attach-session'"));
  assert.deepEqual(coCtl, ['pane-source.js']);
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/pane-source-boundary.test.js`
Mong đợi: FAIL — `ccrc-term.js vẫn còn import từ tmux.js`

- [ ] **Bước 3: Dọn import**

Trong `term/bin/ccrc-term.js`:

1. Xoá toàn bộ khối `import { ... } from '../src/tmux.js';` (dòng 18–23).
2. Xoá `import { attachControlOutput } from '../src/control-stream.js';` (dòng
   27) và `import { splitForSendKeys } from '../src/key-chunks.js';` (dòng 28) —
   cả hai giờ chỉ `pane-source.js` dùng.
3. Xoá `import { spawn } from 'node:child_process';` (dòng 8) **nếu** không còn
   lời gọi `spawn` nào khác trong file. Kiểm tra bằng:
   `grep -n 'spawn(' term/bin/ccrc-term.js`

**KHÔNG phải làm gì với `PANE`.** Daemon lấy nó từ `process.env.CCRC_TERM_PANE`
(`ccrc-term.js:45`), không qua `currentPane()` của `tmux.js` — nên nó không vi
phạm ranh giới ở đợt này. Việc `CCRC_TERM_PANE` là khái niệm riêng của tmux
(trên Windows sẽ là một sessionId) là chuyện của đợt 2; sửa bây giờ là mở rộng
phạm vi.

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/pane-source-boundary.test.js`
Mong đợi: PASS, 3/3 bài.

- [ ] **Bước 5: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **502 bài**, 0 đỏ.

- [ ] **Bước 6: Commit**

```bash
git add term/bin/ccrc-term.js term/test/pane-source-boundary.test.js
git commit -m "test: fence the daemon off from tmux, and check it in CI

The boundary is the whole reason this refactor exists, so it is worth
more than a note in a design doc. If ccrc-term.js is allowed to reach
for tmux again, the ConPTY implementation will be missing exactly that
call — and missing it silently, surfacing only on a user's Windows
machine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Nghiệm thu tay trên Mac

Test xanh không phải bằng chứng đủ. Hai chỗ suite hiện có canh mỏng — thứ tự lời
đáp control-mode, và thời điểm 4001 vs 1011 — đều là chỗ dự án đã từng đau, và cả
hai chỉ lộ ra khi có người thật ngồi trước một phiên thật.

**Files:** không sửa file nào.

- [ ] **Bước 1: Chép bản vừa sửa sang chỗ daemon thật chạy**

Daemon chạy bản ĐÃ CÀI (`~/.local/share/ccrc`), không phải bản trong repo — sửa
code trong worktree rồi `/remote on` vẫn chạy bản cũ. Chép sang trước:

```bash
rsync -a --delete term/ ~/.local/share/ccrc/term/
rsync -a --delete shared/ ~/.local/share/ccrc/shared/
```

- [ ] **Bước 2: Đi hết tám nhánh**

Trong một pane tmux có Claude Code đang chạy:

1. `/remote on ktra` → thấy `✓ Remote ĐÃ BẬT`, có tên và URL.
2. Mở URL trên trình duyệt → **màn hình hiện ra ngay**, không phải ô trống.
3. Gõ vài phím → chữ hiện đúng trên cả trình duyệt lẫn màn hình trên bàn.
4. Gửi một tin nhắn dài (>2000 ký tự) qua ô soạn → ô soạn **chỉ trống đi sau khi
   Claude thật sự nhận**, không trống ngay lúc bấm Gửi.
5. Cuộn chuột trong Claude Code → nội dung hội thoại cuộn (KHÔNG phải màn hình
   lặp lại dòng prompt).
6. Thoát Claude Code, về shell trần, cuộn chuột → lần này lịch sử tmux được lật,
   và **không có byte rác nào bị gõ vào dòng lệnh**.
7. Mở trình duyệt thứ hai vào cùng URL → cả hai cùng xem được; đóng một cái, cái
   còn lại vẫn chạy.
8. `/remote off` → trình duyệt báo hết phiên và **không nối lại vô hạn**.

- [ ] **Bước 3: Nhánh pane chết**

`/remote on` lại, mở trình duyệt, rồi **đóng Claude Code** (không phải `/remote
off`). Trình duyệt phải báo hết phiên bằng mã 4001 — biểu hiện là "phiên đã kết
thúc", KHÔNG phải "vé đã dùng" và KHÔNG nối lại vòng vòng.

Đây chính là ca mà mã 1011 từng thắng 4001 và làm trình duyệt nối lại mãi. Nếu
thấy triệu chứng đó, `onGone({fatal})` ở Task 2 đang trả sai chiều.

- [ ] **Bước 4: So với hành vi cũ nếu có nghi ngờ**

```bash
git stash push -u -m "ktra-adapter-$(date +%s)"
# chép lại bản gốc, đo lại đúng nhánh đang nghi
git stash list --format='%H %gs'   # lấy SHA, rồi git stash apply <sha>
```

- [ ] **Bước 5: Bàn giao cho Huy nghiệm thu**

Báo cáo: số bài test, tám nhánh đã đi, nhánh nào chưa kiểm được và vì sao. Không
tô hồng. **Chỉ khi Huy xác nhận chạy ổn mới được bắt đầu đợt 2.**

---

## Định nghĩa "xong" của đợt 1

- [ ] `term/src/pane-source.js` đủ hai tầng: nguồn (7 đọc + `attach`) và `conn`
      (`close`, `type`, `paste`, `resize`), bản tmux trả lời được hết.
- [ ] `ccrc-term.js` không import gì từ `tmux.js`, có test canh.
- [ ] `npm test` xanh, 502 bài, không sửa một bài cũ nào.
- [ ] Tám nhánh ở Task 5 đi hết trên Mac thật.
- [ ] Huy xác nhận `/remote` không đổi gì so với trước.
- [ ] Không một dòng code Windows nào trong nhánh.
