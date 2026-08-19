# Kế hoạch B (đợt 2/2): ba module thuần logic cho bản ConPTY

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`.
> Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** Viết ba thứ mà tmux đang làm hộ miễn phí, và Windows sẽ phải tự
làm: buffer cuộn, phát hiện chế độ chuột, và khung giao thức pipe. Cả ba là hàm
thuần — **chạy và test được trên macOS/Linux**, nên chúng vào thẳng CI hiện có
thay vì phải chờ một máy Windows.

**Vì sao ba thứ này đi trước phần ConPTY:** đây là hai chỗ mình đã đánh dấu nguy
hiểm nhất trong spec (buffer cuộn, parse chuột) cộng với khung giao thức. Sai ở
đây là **sai âm thầm** — người dùng chỉ thấy "màn hình lạ", không thấy lỗi. Làm
chúng trước, test kỹ, rồi mới ghép vào ConPTY nghĩa là khi có bug ở giai đoạn
sau, ta biết nó không nằm ở đây.

**Tech Stack:** Node.js 22, ESM, `node:test`, `@xterm/headless` 6.0.0 +
`@xterm/addon-serialize` 0.14.0 (hai dependency MỚI, thuần JS, không native).

**Spec:** [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md) §6

## Ràng buộc toàn cục

- **Không đổi hành vi trên macOS/Linux.** Huy nhấn mạnh ba lần. 982 test hiện có
  phải xanh và **không được sửa một bài cũ nào để cho nó xanh**. Ba module này
  là code MỚI, chưa ai gọi tới — nên ràng buộc này gần như tự thoả, và bất kỳ
  bài cũ nào đỏ đều là dấu hiệu đã đụng nhầm chỗ.
- **Không một dòng ConPTY nào trong kế hoạch này.** Không `node-pty`, không named
  pipe thật, không `process.platform`. Đây là kế hoạch của hàm thuần.
- Hai dependency mới chỉ thêm vào workspace `term`.
- **Định danh bằng tiếng Anh, comment bằng tiếng Việt** — đúng quy ước mọi file
  khác trong `term/src/`. (Bản kế hoạch đầu đặt tên hàm bằng tiếng Việt; đó là
  lỗi của kế hoạch, đã sửa.)
- Commit tiếng Anh, kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Bốn điều đã ĐO trên máy này, đừng đo lại

Chạy `@xterm/headless` 6.0.0 + `@xterm/addon-serialize` 0.14.0, terminal 40×6,
scrollback 1000, ghi 30 dòng có màu:

| Câu hỏi | Kết quả đo |
|---|---|
| Số dòng lịch sử lấy ở đâu | `term.buffer.active.baseY` = 25 (đúng 30 − 6 + 1). **Đây chính là `historySize()`** |
| `serialize()` không tham số | Trả **chỉ màn hình hiện tại**, CÓ mã màu |
| `serialize({ scrollback: N })` | Trả **màn hình + N dòng lịch sử**, CÓ mã màu |
| `buffer.getLine(i).translateToString()` | Trả một dòng bất kỳ nhưng **MẤT MÀU** — không dùng được |

**Hệ quả thiết kế:** serialize KHÔNG lấy được một cửa sổ tuỳ ý. Nhưng nó lấy
được "màn hình + N dòng lịch sử", nên `history(offset, rows)` xin dư
(`scrollback: offset + rows`) rồi **cắt lấy `rows` dòng đầu**. Đó là cách duy
nhất giữ được màu, và màu là thứ trình duyệt cần.

**Hai gói đều là CommonJS**, mà dự án này thuần ESM. Phải nhập kiểu:

```js
import headless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
const { Terminal } = headless;
const { SerializeAddon } = serializePkg;
```

`import { Terminal } from '@xterm/headless'` **ném lỗi lúc nạp**.

Một chi tiết nữa đã thấy: `serialize()` kết thúc mỗi dòng bằng `\r`, không phải
`\n`. Tính đến nó khi tách và ghép dòng.

---

### Task 1: buffer cuộn — `snapshot`, `historySize`, `history`

Thứ thay `tmux capture-pane`. Đây là module nguy hiểm nhất của cả đợt 2: sai ở
đây thì người dùng thấy "màn hình lạ" chứ không thấy lỗi.

**Files:**
- Create: `term/src/screen-buffer.js`
- Create: `term/test/screen-buffer.test.js`
- Modify: `term/package.json` (thêm 2 dependency)

**Interfaces:**
- Produces: `createScreenBuffer({ cols, rows, scrollback })` trả về object có:
  - `write(data: string): Promise<void>` — nạp byte từ pty
  - `resize(cols: number, rows: number): void`
  - `snapshot(): string`
  - `historySize(): number`
  - `history(offset: number, rows: number): string`
  - `dispose(): void`

**Hợp đồng đóng khung — phải GIỐNG HỆT bản tmux**, vì trình duyệt đã dựa vào nó:
mở bằng `\x1b[2J\x1b[H`, các dòng nối bằng `\r\n`, đóng bằng `\x1b[0m`.
`snapshot()` cắt bỏ các dòng trắng ở cuối (như `snapshotPane`); `history()`
không cắt (như `captureHistory`).

- [ ] **Bước 1: Thêm dependency**

```bash
npm install --workspace term @xterm/headless@^6.0.0 @xterm/addon-serialize@^0.14.0
```

Kiểm: `git diff term/package.json` chỉ thêm hai dòng vào `dependencies`.

- [ ] **Bước 2: Viết test đỏ**

Tạo `term/test/screen-buffer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenBuffer } from '../src/screen-buffer.js';

// Nạp nhiều dòng đánh số, trả về buffer đã sẵn sàng để hỏi.
async function dungBuffer({ cols = 40, rows = 6, soDong = 30 } = {}) {
  const b = createScreenBuffer({ cols, rows, scrollback: 1000 });
  for (let i = 1; i <= soDong; i++) await b.write(`dong-${i}\r\n`);
  return b;
}

test('snapshot() đóng khung y như bản tmux', async () => {
  const b = await dungBuffer({ soDong: 3 });
  const s = b.snapshot();
  b.dispose();
  // Ba thứ này là hợp đồng với trình duyệt, không phải trang trí: clear+home
  // để màn hình về trạng thái biết trước, và SGR reset để một màu bỏ ngỏ
  // không nhuộm mọi dòng gửi sau đó.
  assert.ok(s.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
  assert.ok(s.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  assert.match(s, /dong-3/);
});

test('snapshot() cắt dòng trắng ở cuối', async () => {
  // Pane cao 6 dòng nhưng chỉ có 2 dòng chữ: 4 dòng trắng còn lại phải biến
  // mất, nếu không màn hình trình duyệt (thấp hơn) sẽ cuộn mất phần có chữ.
  const b = createScreenBuffer({ cols: 40, rows: 6, scrollback: 100 });
  await b.write('mot\r\nhai\r\n');
  const s = b.snapshot();
  b.dispose();
  const than = s.slice('\x1b[2J\x1b[H'.length, -'\x1b[0m'.length);
  const dong = than.split('\r\n');
  assert.equal(dong[dong.length - 1].trim() !== '', true, 'dòng cuối phải có chữ');
});

test('historySize() bằng số dòng đã trôi lên trên màn hình', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  const n = b.historySize();
  b.dispose();
  // 30 dòng ghi vào một màn hình 6 dòng: 25 dòng nằm trên. Đo được trên
  // @xterm/headless 6.0.0 — baseY = 25.
  assert.equal(n, 25);
});

test('historySize() bằng 0 khi chưa có gì trôi lên', async () => {
  const b = createScreenBuffer({ cols: 40, rows: 6, scrollback: 100 });
  await b.write('mot\r\n');
  const n = b.historySize();
  b.dispose();
  assert.equal(n, 0);
});

test('history() trả đúng cửa sổ được hỏi, đúng số dòng', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  // offset=10 nghĩa là bắt đầu từ 10 dòng phía trên đỉnh màn hình.
  // baseY=25, nên cửa sổ bắt đầu ở dòng 15 (0-based) = "dong-16".
  const s = b.history(10, 3);
  b.dispose();
  assert.ok(s.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
  assert.ok(s.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  const than = s.slice('\x1b[2J\x1b[H'.length, -'\x1b[0m'.length);
  const dong = than.split('\r\n');
  assert.equal(dong.length, 3, 'phải trả đúng số dòng được hỏi');
  assert.match(dong[0], /dong-16/);
  assert.match(dong[2], /dong-18/);
});

test('history() giữ được màu', async () => {
  // Mất màu là thứ khiến `getLine().translateToString()` không dùng được, và
  // là lý do module này phải đi qua serialize. Bài test canh chính điều đó.
  const b = createScreenBuffer({ cols: 40, rows: 4, scrollback: 100 });
  for (let i = 1; i <= 20; i++) {
    await b.write(i === 5 ? '\x1b[31mDO-O-DAY\x1b[0m\r\n' : `dong-${i}\r\n`);
  }
  const s = b.history(12, 4);
  b.dispose();
  assert.match(s, /DO-O-DAY/);
  assert.match(s, /\x1b\[[0-9;]*m/, 'phải còn mã màu');
});

test('history() trả chuỗi rỗng với tham số vô lý, không ném', async () => {
  const b = await dungBuffer();
  const s = b;
  assert.equal(s.history(0, 5), '');
  assert.equal(s.history(10, 0), '');
  assert.equal(s.history(-1, 5), '');
  assert.equal(s.history(10, -1), '');
  b.dispose();
});

test('resize() không làm mất lịch sử', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  const truoc = b.historySize();
  b.resize(60, 10);
  const sau = b.historySize();
  b.dispose();
  // Không khẳng định hai số bằng nhau: đổi chiều rộng làm xterm gói lại dòng,
  // nên số dòng lịch sử ĐƯỢC PHÉP đổi. Điều phải giữ là không mất sạch.
  assert.ok(truoc > 0 && sau > 0, `lịch sử không được biến mất (${truoc} → ${sau})`);
});
```

- [ ] **Bước 3: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/screen-buffer.test.js`
Mong đợi: FAIL — `Cannot find module '../src/screen-buffer.js'`

- [ ] **Bước 4: Viết `term/src/screen-buffer.js`**

```js
// Buffer cuộn cho bản Windows — thứ thay `tmux capture-pane`.
//
// tmux giữ lịch sử của pane và trả về MÀN HÌNH ĐÃ VẼ khi được hỏi. ConPTY
// không giữ gì cả: nó chỉ đưa ra một luồng byte. Nên phía Windows phải tự nuôi
// một terminal trong bộ nhớ và tự trả lời ba câu hỏi tmux vẫn trả lời:
// "màn hình đang thế nào", "có bao nhiêu dòng ở trên", "cho tôi cửa sổ này".
//
// Dùng @xterm/headless vì trình duyệt cũng chạy xterm: cùng một bộ diễn giải
// escape sequence ở hai đầu nghĩa là không có chuyện hai bên hiểu khác nhau.
//
// CommonJS cả hai gói, mà dự án này thuần ESM — nhập kiểu default rồi rã, chứ
// `import { Terminal } from '@xterm/headless'` ném lỗi ngay lúc nạp.
import headless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serializePkg;

// Cùng ba mảnh đóng khung mà bản tmux dùng (xem tmux.js snapshotPane /
// captureHistory). Trình duyệt đã dựa vào chúng, nên đây là hợp đồng chứ không
// phải lựa chọn.
const MO = '\x1b[2J\x1b[H';
const DONG = '\x1b[0m';

// Một dòng không có gì nhìn thấy được: bỏ hết mã SGR đi thì chỉ còn khoảng
// trắng. Một mã màu trơ trọi vẫn phải tính là trắng, nếu không nó vô hiệu hoá
// việc cắt đuôi.
function dongTrang(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
}

// serialize() kết thúc mỗi dòng bằng '\r' chứ không phải '\n' — đo được trên
// addon-serialize 0.14.0. Tách theo '\n' rồi bỏ '\r' thừa ở cuối mỗi dòng.
function tachDong(raw) {
  return raw.split('\n').map((l) => l.replace(/\r$/, ''));
}

function dongKhung(dong) {
  return `${MO}${dong.join('\r\n')}${DONG}`;
}

export function createScreenBuffer({ cols = 80, rows = 24, scrollback = 10_000 } = {}) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const ser = new SerializeAddon();
  term.loadAddon(ser);

  return {
    // xterm nuốt dữ liệu bất đồng bộ và chỉ gọi lại khi đã xử lý xong. Hỏi
    // buffer trước lúc ấy là đọc một trạng thái dở dang — nên hàm này trả
    // Promise và mọi chỗ gọi phải chờ.
    write(data) {
      return new Promise((resolve) => term.write(data, resolve));
    },

    resize(c, r) {
      if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1) return;
      term.resize(c, r);
    },

    // Số dòng đã trôi lên phía trên màn hình. `baseY` chính là con số đó —
    // đo được trên @xterm/headless 6.0.0: ghi 30 dòng vào màn hình 6 dòng cho
    // baseY = 25.
    historySize() {
      return term.buffer.active.baseY;
    },

    // Màn hình hiện tại, đã cắt các dòng trắng ở cuối.
    //
    // Cắt đuôi không phải để cho gọn: pane cao hơn màn hình trình duyệt thì
    // phần đệm trắng đẩy nội dung thật cuộn khỏi đỉnh, và người dùng mở
    // terminal ra thấy một khoảng gần như trống.
    snapshot() {
      const dong = tachDong(ser.serialize());
      while (dong.length > 0 && dongTrang(dong[dong.length - 1])) dong.pop();
      if (dong.length === 0) return '';
      return dongKhung(dong);
    },

    // Một màn hình lịch sử, bắt đầu từ `offset` dòng phía trên đỉnh màn hình.
    //
    // serialize() KHÔNG lấy được một cửa sổ tuỳ ý — nó chỉ lấy được "màn hình
    // cộng N dòng lịch sử". Nên xin đúng `offset` dòng (kết quả bắt đầu ở
    // baseY - offset, đo được) rồi cắt lấy `rows` dòng đầu.
    //
    // Đường vòng qua `getLine().translateToString()` trông thẳng hơn nhưng
    // MẤT MÀU — và màu là thứ trình duyệt cần.
    history(offset, rows) {
      if (!Number.isInteger(offset) || offset < 1) return '';
      if (!Number.isInteger(rows) || rows < 1) return '';
      const max = term.buffer.active.baseY;
      const o = Math.min(offset, max);
      if (o < 1) return '';
      const dong = tachDong(ser.serialize({ scrollback: o })).slice(0, rows);
      if (dong.length === 0) return '';
      return dongKhung(dong);
    },

    dispose() {
      try { term.dispose(); } catch { /* đã đóng rồi */ }
    },
  };
}
```

- [ ] **Bước 5: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/screen-buffer.test.js`
Mong đợi: PASS, 8/8.

Nếu bài `history()` đỏ vì lệch một dòng: ĐỪNG chỉnh con số trong test cho khớp.
Đo lại bằng một script vứt đi (in ra `baseY` và mấy dòng đầu của
`serialize({scrollback: N})`), rồi sửa code cho đúng. Con số trong test đến từ
phép đo thật, không phải từ suy luận.

- [ ] **Bước 6: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **990 bài** (982 + 8 mới), 0 đỏ.

- [ ] **Bước 7: Commit**

```bash
git add term/src/screen-buffer.js term/test/screen-buffer.test.js term/package.json package-lock.json
git commit -m "feat: keep our own scrollback, the way tmux keeps one for us

tmux holds a pane's history and hands back a rendered screen when
asked. ConPTY holds nothing — it emits a byte stream and forgets it. So
the Windows side has to grow its own terminal in memory and answer the
three questions tmux answers today: what is on screen, how far back does
it go, and give me that window.

@xterm/headless because the browser runs xterm too. One escape-sequence
interpreter at both ends means the two cannot disagree about what a byte
stream looks like.

The window comes out of serialize() rather than getLine(), which reads
straighter but drops colour — and colour is the part the browser needs.
serialize cannot take an arbitrary range, only 'the screen plus N lines
of history', so history() asks for offset lines and keeps the first rows
of them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: phát hiện chế độ chuột

Thứ thay `#{mouse_any_flag}` và `#{mouse_sgr_flag}` của tmux. tmux biết vì nó
tự phân tích luồng ra của ứng dụng; ConPTY không nói gì cả, nên ta phải tự đọc.

**Vì sao quan trọng:** đây là cái quyết định một cú cuộn được xử lý ra sao. Ứng
dụng bật chuột (Claude Code, vim) thì phải gửi cho nó sự kiện bánh xe; ứng dụng
KHÔNG bật (shell trần) mà gửi byte chuột vào là **gõ rác thẳng vào dòng lệnh
người dùng**. Sai hướng nào cũng có giá, và không bên nào báo lỗi.

**Files:**
- Create: `term/src/mouse-mode.js`
- Create: `term/test/mouse-mode.test.js`

**Interfaces:**
- Produces: `createMouseMode()` trả về `{ feed(data: string): void, state(): { mouse: boolean, sgr: boolean } }`

- [ ] **Bước 1: Viết test đỏ**

Tạo `term/test/mouse-mode.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMouseMode } from '../src/mouse-mode.js';

test('mặc định là không có chuột — hướng an toàn duy nhất', () => {
  // Không biết thì KHÔNG gửi byte chuột. Gửi nhầm vào shell trần là gõ rác
  // vào dòng lệnh người dùng; không gửi thì cùng lắm là cuộn không ăn.
  assert.deepEqual(createMouseMode().state(), { mouse: false, sgr: false });
});

test('bật rồi tắt từng chế độ một', () => {
  const m = createMouseMode();
  for (const mode of [1000, 1002, 1003]) {
    m.feed(`\x1b[?${mode}h`);
    assert.equal(m.state().mouse, true, `${mode}h phải bật chuột`);
    m.feed(`\x1b[?${mode}l`);
    assert.equal(m.state().mouse, false, `${mode}l phải tắt chuột`);
  }
});

test('1006 là cách MÃ HOÁ, không phải bật chuột', () => {
  const m = createMouseMode();
  m.feed('\x1b[?1006h');
  assert.deepEqual(m.state(), { mouse: false, sgr: true });
  m.feed('\x1b[?1000h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
});

test('nhiều chế độ trong một chuỗi, ngăn bằng dấu chấm phẩy', () => {
  // Đây là hình dạng thật mà ứng dụng gửi: `ESC[?1002;1006h`.
  const m = createMouseMode();
  m.feed('\x1b[?1002;1006h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
  m.feed('\x1b[?1002;1006l');
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
});

test('tắt một chế độ không tắt chế độ khác đang bật', () => {
  const m = createMouseMode();
  m.feed('\x1b[?1000h');
  m.feed('\x1b[?1003h');
  m.feed('\x1b[?1000l');
  assert.equal(m.state().mouse, true, '1003 vẫn còn bật');
  m.feed('\x1b[?1003l');
  assert.equal(m.state().mouse, false);
});

test('chuỗi bị cắt làm đôi giữa hai lần đọc vẫn nhận ra', () => {
  // Đây là cái bẫy thật của việc đọc luồng: ConPTY trả từng mảng byte, và
  // một chuỗi escape không hứa nằm gọn trong một mảng.
  const m = createMouseMode();
  m.feed('\x1b[?10');
  m.feed('02;1006h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
});

test('không nhầm chuỗi khác thành chế độ chuột', () => {
  const m = createMouseMode();
  m.feed('\x1b[?25l');        // ẩn con trỏ
  m.feed('\x1b[?1049h');      // màn hình phụ
  m.feed('\x1b[2J');          // xoá màn hình
  m.feed('chu binh thuong 1000h');
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
});

test('bộ đệm không phình vô hạn khi gặp ESC[ không bao giờ kết thúc', () => {
  // Một luồng nhị phân bất kỳ có thể chứa `ESC[` rồi không bao giờ có ký tự
  // kết thúc. Giữ mãi phần đuôi là rò bộ nhớ trong một tiến trình chạy nhiều
  // ngày.
  const m = createMouseMode();
  m.feed('\x1b[' + 'x'.repeat(100_000));
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
  m.feed('\x1b[?1000h');
  assert.equal(m.state().mouse, true, 'vẫn phải nhận ra chuỗi hợp lệ sau đó');
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/mouse-mode.test.js`
Mong đợi: FAIL — `Cannot find module '../src/mouse-mode.js'`

- [ ] **Bước 3: Viết `term/src/mouse-mode.js`**

```js
// Ứng dụng trong pane có muốn nhận sự kiện chuột không, và nếu có thì mã hoá
// kiểu nào — thứ tmux trả lời bằng #{mouse_any_flag} và #{mouse_sgr_flag}.
//
// tmux biết vì nó tự phân tích luồng ra của ứng dụng. ConPTY không nói gì cả,
// nên phía Windows phải đọc lấy.
//
// Vì sao đáng cẩn thận: đây là chỗ quyết định một cú cuộn đi đường nào. Ứng
// dụng bật chuột thì gửi nó sự kiện bánh xe; ứng dụng KHÔNG bật mà gửi byte
// chuột vào là gõ rác thẳng vào dòng lệnh người dùng. Không bên nào báo lỗi.

// 1000 X11, 1002 theo nút, 1003 mọi chuyển động — bất kỳ cái nào bật nghĩa là
// ứng dụng đang chờ chuột. 1006 KHÔNG bật chuột: nó chỉ nói "gửi cho tôi kiểu
// SGR", nên được đếm riêng.
const MOUSE_MODES = new Set([1000, 1002, 1003]);
const SGR_MODE = 1006;

// Trần cho phần đuôi chưa hoàn chỉnh. Một luồng nhị phân có thể chứa `ESC[`
// rồi không bao giờ kết thúc; giữ mãi là rò bộ nhớ trong một tiến trình sống
// nhiều ngày. Chuỗi DEC private mode dài nhất trong thực tế chưa tới 40 ký tự.
const MAX_TAIL = 256;

export function createMouseMode() {
  const enabled = new Set();
  let sgr = false;
  let tail = '';

  return {
    feed(data) {
      const s = tail + String(data);
      tail = '';
      // `ESC [ ? <số>(;<số>)* <h|l>` — DEC private mode set/reset.
      const re = /\x1b\[\?([0-9;]*)([hl])/g;
      let m;
      let end = 0;
      while ((m = re.exec(s)) !== null) {
        end = re.lastIndex;
        const on = m[2] === 'h';
        for (const part of m[1].split(';')) {
          const n = Number(part);
          if (!Number.isInteger(n)) continue;
          if (MOUSE_MODES.has(n)) { if (on) enabled.add(n); else enabled.delete(n); }
          else if (n === SGR_MODE) sgr = on;
        }
      }
      // Giữ lại phần đuôi CÓ THỂ là đầu một chuỗi chưa trọn vẹn, để lần đọc
      // sau ghép tiếp. Chỉ giữ từ dấu ESC cuối cùng trở đi, và không quá trần.
      const rest = s.slice(end);
      const esc = rest.lastIndexOf('\x1b');
      tail = esc === -1 ? '' : rest.slice(esc);
      if (tail.length > MAX_TAIL) tail = '';
    },

    state() {
      return { mouse: enabled.size > 0, sgr };
    },
  };
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/mouse-mode.test.js`
Mong đợi: PASS, 8/8.

- [ ] **Bước 5: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **998 bài**, 0 đỏ.

- [ ] **Bước 6: Commit**

```bash
git add term/src/mouse-mode.js term/test/mouse-mode.test.js
git commit -m "feat: read the application's mouse mode off the output stream

tmux answers this with mouse_any_flag and mouse_sgr_flag because it
parses the application's output itself. ConPTY says nothing, so the
Windows side has to read it.

This decides where a scroll gesture goes. An application that asked for
mouse reporting gets a wheel event; one that did not gets those bytes
TYPED INTO IT — straight into the user's command line. Neither direction
reports an error, so getting it wrong is silent either way, which is why
the default is 'no mouse'.

1006 is counted separately because it is an encoding, not a request for
mouse events at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: khung giao thức pipe

Đóng gói và phân tích khung cho named pipe giữa host và client. **Thuần hàm** —
không có pipe thật nào trong task này; pipe thật thuộc kế hoạch sau.

Quy ước lấy lại từ WebSocket của dự án: **nhị phân là dữ liệu pane, text là điều
khiển**. Không bịa quy ước thứ ba — dự án đã trả giá một lần cho việc đoán loại
khung bằng "khung đầu tiên là điều khiển", và kênh báo lỗi chết câm suốt một
thời gian dài vì thế.

**Files:**
- Create: `term/src/pipe-frame.js`
- Create: `term/test/pipe-frame.test.js`

**Interfaces:**
- Produces:
  - `FRAME = { PANE: 0, CONTROL: 1 }`
  - `encodeFrame(kind: number, payload: Buffer|string): Buffer`
  - `createFrameDecoder()` → `{ push(chunk: Buffer): Array<{kind: number, payload: Buffer}> }`

Khung: 1 byte loại, 4 byte độ dài (big-endian, uint32), rồi payload.

- [ ] **Bước 1: Viết test đỏ**

Tạo `term/test/pipe-frame.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';

test('gói rồi mở ra được nguyên vẹn', () => {
  const d = createFrameDecoder();
  const out = d.push(encodeFrame(FRAME.PANE, 'xin chao'));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, FRAME.PANE);
  assert.equal(out[0].payload.toString('utf8'), 'xin chao');
});

test('phân biệt pane với điều khiển bằng LOẠI, không phải nội dung', () => {
  // Đây là cả điểm của quy ước. Dự án từng đoán loại khung bằng "khung đầu
  // tiên là điều khiển" và kênh báo lỗi chết câm suốt một thời gian dài.
  const d = createFrameDecoder();
  const out = d.push(Buffer.concat([
    encodeFrame(FRAME.CONTROL, '{"type":"ccrc_loi"}'),
    encodeFrame(FRAME.PANE, '{"type":"ccrc_loi"}'),
  ]));
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, FRAME.CONTROL);
  assert.equal(out[1].kind, FRAME.PANE);
});

test('nhiều khung trong một lần đọc', () => {
  const d = createFrameDecoder();
  const out = d.push(Buffer.concat([
    encodeFrame(FRAME.PANE, 'a'), encodeFrame(FRAME.PANE, 'b'), encodeFrame(FRAME.PANE, 'c'),
  ]));
  assert.deepEqual(out.map((f) => f.payload.toString()), ['a', 'b', 'c']);
});

test('một khung bị cắt làm nhiều lần đọc', () => {
  // Pipe không hứa hẹn gì về ranh giới. Cắt từng byte một là ca xấu nhất.
  const d = createFrameDecoder();
  const frame = encodeFrame(FRAME.PANE, 'chuoi dai hon mot chut');
  let out = [];
  for (const b of frame) out = out.concat(d.push(Buffer.from([b])));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString(), 'chuoi dai hon mot chut');
});

test('payload rỗng vẫn là một khung hợp lệ', () => {
  const d = createFrameDecoder();
  const out = d.push(encodeFrame(FRAME.CONTROL, ''));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.length, 0);
});

test('UTF-8 nhiều byte bị cắt giữa chừng không hỏng', () => {
  // Cắt theo byte, ghép lại theo byte — không được decode sớm thành U+FFFD.
  const d = createFrameDecoder();
  const frame = encodeFrame(FRAME.PANE, 'tiếng Việt có dấu');
  const out = d.push(frame.subarray(0, 8)).concat(d.push(frame.subarray(8)));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString('utf8'), 'tiếng Việt có dấu');
});

test('từ chối khung khai độ dài vô lý thay vì cấp phát theo lời khai', () => {
  // Độ dài đến từ đầu bên kia của một pipe. Tin nó là để một khung hỏng xin
  // 4GB bộ nhớ.
  const bad = Buffer.alloc(5);
  bad.writeUInt8(FRAME.PANE, 0);
  bad.writeUInt32BE(0xffffffff, 1);
  const d = createFrameDecoder();
  assert.throws(() => d.push(bad), /qua dai|too large|khung/i);
});
```

- [ ] **Bước 2: Chạy test, xác nhận nó đỏ**

Chạy: `node --test term/test/pipe-frame.test.js`
Mong đợi: FAIL — `Cannot find module '../src/pipe-frame.js'`

- [ ] **Bước 3: Viết `term/src/pipe-frame.js`**

```js
// Khung cho named pipe giữa ccrc-host (giữ ConPTY) và những ai nối vào nó.
//
// Quy ước lấy lại nguyên từ WebSocket của dự án: NHỊ PHÂN là dữ liệu pane,
// TEXT là điều khiển. Không bịa quy ước thứ ba — dự án đã từng đoán loại khung
// bằng "khung đầu tiên là điều khiển", và mọi thông báo lỗi sau khung đầu bị vẽ
// ra lưới thành cục JSON, tức là kênh báo lỗi chưa từng tới được người dùng.
//
// Pipe là luồng byte: nó không hứa một lần đọc là một khung. Nên phải tự đóng
// khung, và bộ giải mã phải chịu được mọi kiểu cắt.

export const FRAME = { PANE: 0, CONTROL: 1 };

const HEAD = 5; // 1 byte kind + 4 byte length

// Trần cho một khung. Độ dài đến từ đầu bên kia của pipe, nên cấp phát theo
// lời khai là để một khung hỏng (hoặc cố ý) xin 4GB.
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (body.length > MAX_FRAME) throw new Error(`khung qua dai: ${body.length}`);
  const head = Buffer.alloc(HEAD);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export function createFrameDecoder() {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      rest = rest.length === 0 ? Buffer.from(chunk) : Buffer.concat([rest, chunk]);
      const out = [];
      for (;;) {
        if (rest.length < HEAD) break;
        const len = rest.readUInt32BE(1);
        // Kiểm TRƯỚC khi chờ đủ byte: một độ dài vô lý không được phép làm bộ
        // đệm phình lên trong lúc chờ số byte không bao giờ tới.
        if (len > MAX_FRAME) throw new Error(`khung qua dai: ${len}`);
        if (rest.length < HEAD + len) break;
        out.push({ kind: rest.readUInt8(0), payload: rest.subarray(HEAD, HEAD + len) });
        rest = rest.subarray(HEAD + len);
      }
      return out;
    },
  };
}
```

- [ ] **Bước 4: Chạy test, xác nhận xanh**

Chạy: `node --test term/test/pipe-frame.test.js`
Mong đợi: PASS, 7/7.

- [ ] **Bước 5: Chạy toàn bộ suite**

Chạy: `npm test`
Mong đợi: PASS, **1005 bài**, 0 đỏ.

- [ ] **Bước 6: Commit**

```bash
git add term/src/pipe-frame.js term/test/pipe-frame.test.js
git commit -m "feat: frame the host pipe, binary for pane and text for control

Same discipline the WebSocket already uses: tell data and control apart
by which channel they arrived on, never by what they look like. The
project once guessed with 'the first frame is control', and every error
message after the first was drawn into the terminal grid as a blob of
JSON — the error channel had never reached a user at all.

A pipe is a byte stream and promises nothing about where a read ends, so
the decoder has to survive any split, including one byte at a time. The
declared length is checked before the decoder waits for the bytes:
otherwise a corrupt frame parks a buffer waiting for bytes that never
come.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Định nghĩa "xong" của kế hoạch B

- [ ] Ba module tồn tại, đều là hàm thuần, đều chạy được trên macOS/Linux
- [ ] `npm test` xanh, 1005 bài, không sửa một bài cũ nào
- [ ] Không một dòng ConPTY / named pipe thật / `process.platform` nào
- [ ] Hai dependency mới đều thuần JS, không native
