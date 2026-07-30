# Ghép cặp thiết bị — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lấy hub ra khỏi vai trò ký vé — điện thoại tự ký token mở terminal bằng khoá riêng non-extractable, máy dev xác minh bằng khoá công khai học được một lần lúc ghép cặp.

**Architecture:** Ghép cặp đi qua hub như người đưa thư mù; so số 6 chữ số kiểu Bluetooth với cam-kết-trước-mở-sau làm cho việc tin hub trở nên không cần thiết. Khoá công khai vào `~/.ccrc/devices.json` trên máy dev, ngoài daemon nên sống qua mọi `/remote on/off`. Đường vé HMAC cũ bị **cắt dứt điểm**, không chạy song song.

**Tech Stack:** Node.js ESM, `node:test`, `node:crypto` (ECDSA P-256), WebCrypto trong PWA, IndexedDB, không thêm dependency runtime nào.

**Spec:** `docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md`

## Global Constraints

- **Ngôn ngữ:** tên test và thông điệp người dùng bằng **tiếng Việt**; comment giải thích *vì sao* bằng tiếng Anh hoặc tiếng Việt theo file đang sửa; commit message bằng **tiếng Anh**.
- **Không thêm dependency runtime.** `ws` vẫn là dependency duy nhất của `term`.
- **Đường mã hoá:** ECDSA **P-256**, băm **SHA-256**. Chữ ký dạng **IEEE P1363** (`r‖s` raw) — `node:crypto` phải đặt `dsaEncoding: 'ieee-p1363'`.
- **Mã hoá chuỗi:** mọi nhị phân đi qua dây là **base64url**. Nhờ vậy `.` không bao giờ xuất hiện trong dữ liệu và dùng được làm dấu phân tách.
- **`SAS_DIGITS` mặc định = 6**, nhưng **phải tiêm được** vào hàm tính (test đối chứng dùng 3).
- **`MAX_DEVICES` = 20**, **`PAIR_TTL_MS` = 5 phút**, **`NONCE_BYTES` = 32**.
- **Không bao giờ ném:** `term/src/devices.js` nằm trên đường đi của mọi kết nối — mọi hàm trả giá trị, không ném.
- **Kỷ luật phân tách người dùng:** mọi tra cứu trên hub scope theo `userName` TRƯỚC. Yêu cầu ghép cặp của người này không bao giờ trả lời câu hỏi hỏi nhân danh người khác.
- **TDD bắt buộc:** viết test đỏ → chạy thấy đỏ → sửa → chạy thấy xanh → commit. Không viết code sản xuất trước test.
- **Chạy toàn bộ suite** (`npm test`) trước mỗi commit. Hiện tại: 506 test xanh.

---

## Cấu trúc file

| File | Trách nhiệm | Task |
|---|---|---|
| `term/src/pairing.js` | **Mới.** Nonce, cam kết, SAS. Thuần tuý, không I/O. | 1 |
| `term/src/devices.js` | **Mới.** Đọc/ghi `~/.ccrc/devices.json`. Không bao giờ ném. | 2 |
| `term/src/ticket.js` | **Sửa.** v1 HMAC → v2 ECDSA. | 3 |
| `server/src/pairing.js` | **Mới.** Hàng đợi ghép cặp + máy trạng thái, trong RAM. | 4 |
| `server/src/index.js` | **Sửa.** Thêm 6 route `/api/pair/*` (T5); bỏ đường vé cũ (T10). | 5, 10 |
| `term/bin/ccrc-term-cli.js` | **Sửa.** Thêm `pair`, `devices`, `unpair`. | 6 |
| `server/public/app.js` | **Sửa.** Keystore, UI ghép cặp (T7); ký token mở terminal (T9). | 7, 9 |
| `term/bin/ccrc-term.js` | **Sửa.** Xác minh v2 qua `devices.json`; bỏ gửi `secret`. | 8 |
| `term/public/term.js` | **Sửa.** `?ticket=` → `?token=`. | 9 |
| `server/src/terminal-sessions.js` | **Sửa.** Bỏ `secret`, bỏ `issueTicket`. | 10 |
| `deploy/commands/remote.md`, `docs/huong-dan.md` | **Sửa.** Tài liệu. | 11 |

**Cửa sổ gãy có chủ ý:** sau Task 8, daemon chỉ nhận token v2 còn PWA vẫn gửi vé v1 — hệ thống **không mở được terminal** cho tới hết Task 9. Đây là hệ quả không tránh được của quyết định cắt dứt điểm (spec §3, mục 4). Task 9 phải làm ngay sau Task 8, không bỏ dở giữa hai task này.

---

### Task 1: `term/src/pairing.js` — nonce, cam kết, SAS

**Files:**
- Create: `term/src/pairing.js`
- Test: `term/test/pairing.test.js`

**Interfaces:**
- Consumes: không có (task đầu tiên, thuần tuý)
- Produces:
  - `SAS_DIGITS: number` = 6
  - `NONCE_BYTES: number` = 32
  - `randomNonce(): string` — base64url
  - `commitFor(nonce: string): string` — base64url của SHA-256(nonce)
  - `commitMatches(commit: string, nonce: string): boolean` — tổng, không ném
  - `shortAuthString({pubKey: string, noncePhone: string, nonceMachine: string, digits?: number}): string` — chuỗi số, đệm 0 cho đủ `digits`

- [ ] **Step 1: Viết test đỏ — tính chất cơ bản của SAS và cam kết**

Tạo `term/test/pairing.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAS_DIGITS, randomNonce, commitFor, commitMatches, shortAuthString,
} from '../src/pairing.js';

const PUB = 'khoa-cong-khai-gia-dinh-base64url';

test('SAS xác định: cùng đầu vào cho cùng một số', () => {
  const a = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  const b = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  assert.equal(a, b);
});

test('SAS mặc định đúng 6 chữ số, đệm 0 khi cần', () => {
  for (let i = 0; i < 200; i += 1) {
    const s = shortAuthString({ pubKey: PUB, noncePhone: randomNonce(), nonceMachine: 'nm' });
    assert.equal(s.length, SAS_DIGITS, `"${s}" phải đúng ${SAS_DIGITS} chữ số`);
    assert.match(s, /^[0-9]+$/);
  }
});

test('đổi bất kỳ thành phần nào cũng đổi SAS', () => {
  const base = shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm' });
  assert.notEqual(base, shortAuthString({ pubKey: PUB + 'x', noncePhone: 'np', nonceMachine: 'nm' }));
  assert.notEqual(base, shortAuthString({ pubKey: PUB, noncePhone: 'np2', nonceMachine: 'nm' }));
  assert.notEqual(base, shortAuthString({ pubKey: PUB, noncePhone: 'np', nonceMachine: 'nm2' }));
});

test('cam kết khớp đúng nonce của nó, và chỉ nonce đó', () => {
  const n = randomNonce();
  assert.equal(commitMatches(commitFor(n), n), true);
  assert.equal(commitMatches(commitFor(n), randomNonce()), false);
});

test('commitMatches tổng: đầu vào rác trả false, không ném', () => {
  for (const x of [null, undefined, '', 42, {}, []]) {
    assert.equal(commitMatches(x, 'n'), false, `commit=${JSON.stringify(x)}`);
    assert.equal(commitMatches('c', x), false, `nonce=${JSON.stringify(x)}`);
  }
});

test('nonce đủ dài và không lặp lại', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const n = randomNonce();
    assert.ok(n.length >= 40, 'nonce 32 byte base64url phải dài ít nhất 40 ký tự');
    assert.equal(seen.has(n), false, 'nonce trùng nhau là hỏng toàn bộ giá trị của cam kết');
    seen.add(n);
  }
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test term/test/pairing.test.js`
Expected: FAIL — `Cannot find module '../src/pairing.js'`

- [ ] **Step 3: Viết `term/src/pairing.js`**

```js
// Nghi thức so số khi ghép một điện thoại với máy này.
//
// Ba hàm nhỏ, thuần tuý, không I/O — vì chúng phải được viết LẠI y hệt trong
// trình duyệt (server/public/app.js). Hai bản cài đặt cho ra hai số khác nhau
// thì người dùng thấy lệch và không ghép được: một lỗi cắt ngang hai ngôn ngữ,
// nên phần đúng-sai phải nằm ở nơi test được trực tiếp.
//
// Vì sao có `commit`: xem docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md §5.2.
// Tóm tắt: SAS ngây thơ thì hub tráo được khoá rồi dò nonce cho hai màn hình
// trùng số — sáu chữ số là 10^6 phép băm, vài mili giây.

import crypto from 'node:crypto';

export const SAS_DIGITS = 6;
export const NONCE_BYTES = 32;

export function randomNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('base64url');
}

export function commitFor(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('base64url');
}

// Tổng: mọi đầu vào dị dạng là `false`, không bao giờ ném. Hàm này chạy trên
// dữ liệu tới từ hub.
export function commitMatches(commit, nonce) {
  if (typeof commit !== 'string' || !commit) return false;
  if (typeof nonce !== 'string' || !nonce) return false;
  const a = Buffer.from(commit);
  const b = Buffer.from(commitFor(nonce));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Ba thành phần nối bằng dấu chấm. An toàn vì cả ba đều là base64url, mà bảng
// chữ base64url KHÔNG có dấu chấm — nên không có cách nào ghép hai bộ đầu vào
// khác nhau ra cùng một chuỗi. Nối trần không dấu phân tách thì có.
//
// `digits` tiêm được vì test đối chứng (pairing-attack.test.js) phải DÒ RA
// được va chạm để chứng minh cam kết là thứ chặn nó; ở 6 chữ số việc dò mất
// vài giây mỗi lần chạy suite, ở 3 chữ số là tức thì. Tính chất mật mã cần
// chứng minh không phụ thuộc độ dài — chỉ độ khó mới phụ thuộc.
export function shortAuthString({ pubKey, noncePhone, nonceMachine, digits = SAS_DIGITS }) {
  const material = [pubKey, noncePhone, nonceMachine].join('.');
  const h = crypto.createHash('sha256').update(material).digest();
  const n = h.readUInt32BE(0) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node --test term/test/pairing.test.js`
Expected: PASS, 6/6

- [ ] **Step 5: Viết test đỏ — hub ác, và test đối chứng**

Đây là test load-bearing nhất của cả kế hoạch. Tạo `term/test/pairing-attack.test.js`:

```js
// Chứng minh vì sao có bước cam kết — bằng cách cho một hub ác thử tấn công
// thật, ở cả hai phiên bản giao thức.
//
// Chạy ở 3 chữ số (không gian 10^3) để việc dò xong tức thì. Tính chất được
// chứng minh không phụ thuộc độ dài SAS; ở 6 chữ số kẻ tấn công chỉ tốn thêm
// thời gian, không có thêm khả năng nào.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomNonce, commitFor, commitMatches, shortAuthString } from '../src/pairing.js';

const DIGITS = 3;
const KHOA_THAT = 'khoa-cong-khai-cua-dien-thoai-that';
const KHOA_AC = 'khoa-cong-khai-cua-hub-ac';

// Giao thức NGÂY THƠ, không có cam kết: SAS chỉ tính trên khoá + nonce máy.
// Giữ ở đây, trong test, đúng bằng vai trò của nó: một thứ để chứng minh là sai.
const sasNgayTho = (pubKey, nonceMachine) =>
  shortAuthString({ pubKey, noncePhone: '', nonceMachine, digits: DIGITS });

test('ĐỐI CHỨNG: không có cam kết thì hub tráo được khoá và ép hai màn hình trùng số', () => {
  // Hub tráo khoá gửi cho máy dev. Máy dev sinh nonce và hiện số của nó.
  const nonceMachine = randomNonce();
  const sasTrenMayDev = sasNgayTho(KHOA_AC, nonceMachine);

  // Hub THẤY nonce của máy rồi mới đi dò một nonce khác để gửi cho điện thoại.
  let nonceGia = null;
  for (let i = 0; i < 200_000 && nonceGia === null; i += 1) {
    const thu = `n-${i}`;
    if (sasNgayTho(KHOA_THAT, thu) === sasTrenMayDev) nonceGia = thu;
  }

  assert.notEqual(nonceGia, null,
    'dò được — đúng như dự đoán. Đây là lý do giao thức thật KHÔNG được ngây thơ');
  assert.equal(sasNgayTho(KHOA_THAT, nonceGia), sasTrenMayDev,
    'hai màn hình hiện cùng một số trong khi khoá đã bị tráo: người dùng bấm Khớp và hub thắng');
});

test('GIAO THỨC THẬT: có cam kết thì cùng cuộc tấn công đó thất bại', () => {
  // Điện thoại cam kết TRƯỚC, chưa mở.
  const noncePhone = randomNonce();
  const commit = commitFor(noncePhone);

  // Hub tráo khoá gửi cho máy dev, kèm cam kết thật (nó không tạo nổi cam kết
  // khác có ích: muốn mở ra một nonce khác thì phải tìm tiền ảnh SHA-256).
  const nonceMachine = randomNonce();
  const sasTrenMayDev = shortAuthString({
    pubKey: KHOA_AC, noncePhone, nonceMachine, digits: DIGITS,
  });

  // Hub thấy nonceMachine rồi mới dò. Nhưng nonce nó gửi lên phải MỞ ĐÚNG cam
  // kết đã nộp, nếu không máy dev từ chối ngay ở bước kiểm cam kết.
  let thanhCong = false;
  for (let i = 0; i < 200_000; i += 1) {
    const thu = `n-${i}`;
    if (!commitMatches(commit, thu)) continue; // không mở được cam kết → vô dụng
    if (shortAuthString({ pubKey: KHOA_THAT, noncePhone: thu, nonceMachine, digits: DIGITS })
        === sasTrenMayDev) {
      thanhCong = true;
      break;
    }
  }

  assert.equal(thanhCong, false,
    'không có nonce nào vừa mở được cam kết vừa ép hai SAS trùng — đúng thứ cam kết sinh ra để làm');
});

test('GIAO THỨC THẬT: chuyển tiếp nonce thật thì SAS lệch, người dùng thấy', () => {
  // Đường duy nhất còn lại cho hub: chuyển tiếp đúng nonce thật. Khi đó cam
  // kết khớp, nhưng SAS tính trên hai khoá khác nhau nên hai số khác nhau.
  const noncePhone = randomNonce();
  const nonceMachine = randomNonce();

  assert.equal(commitMatches(commitFor(noncePhone), noncePhone), true, 'cam kết khớp');

  const sasDienThoai = shortAuthString({ pubKey: KHOA_THAT, noncePhone, nonceMachine, digits: DIGITS });
  const sasMayDev = shortAuthString({ pubKey: KHOA_AC, noncePhone, nonceMachine, digits: DIGITS });

  assert.notEqual(sasDienThoai, sasMayDev,
    'hai màn hình phải hiện số khác nhau — đó là toàn bộ tín hiệu người dùng nhận được');
});
```

- [ ] **Step 6: Chạy, xác nhận cả ba xanh**

Run: `node --test term/test/pairing-attack.test.js`
Expected: PASS, 3/3. Test đối chứng phải **dò ra được** (nếu nó cũng thất bại thì test không chứng minh gì — kiểm lại `sasNgayTho`).

- [ ] **Step 7: Chạy toàn bộ suite**

Run: `npm test`
Expected: 506 + 9 = 515 test xanh, 0 lỗi

- [ ] **Step 8: Commit**

```bash
git add term/src/pairing.js term/test/pairing.test.js term/test/pairing-attack.test.js
git commit -m "Add the numeric-comparison pairing primitives, and prove why they commit first

A naive short authentication string lets a relay swap the key and then
grind a nonce until both screens agree — six digits is a few milliseconds
of work. Committing to the phone's nonce before the machine's is revealed
turns that grind into a SHA-256 preimage search.

The attack test runs the real attack at three digits so the control case
actually finds its collision inside a test run. What it proves does not
depend on the length; only how long it takes does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `term/src/devices.js` — sổ thiết bị đã ghép

**Files:**
- Create: `term/src/devices.js`
- Test: `term/test/devices.test.js`

**Interfaces:**
- Consumes: không có
- Produces:
  - `MAX_DEVICES: number` = 20
  - `devicesPath(home?: string): string`
  - `deviceIdFor(pubKey: string): string` — 16 ký tự hex
  - `listDevices(opts?: {home?, file?}): Array<{id, pubKey, label, pairedAt}>`
  - `addDevice({pubKey, label}, opts?): {ok: true, id} | {ok: false, reason: string}`
  - `removeDevice(id: string, opts?): boolean`
  - `findDevice(id: string, opts?): {id, pubKey, label, pairedAt} | null`

- [ ] **Step 1: Viết test đỏ**

Tạo `term/test/devices.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DEVICES, devicesPath, deviceIdFor, listDevices, addDevice, removeDevice, findDevice,
} from '../src/devices.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-dev-'));
const PUB_A = 'khoa-cong-khai-A';
const PUB_B = 'khoa-cong-khai-B';

test('thêm rồi liệt kê thấy đúng thiết bị đó', () => {
  const home = tmpHome();
  const r = addDevice({ pubKey: PUB_A, label: 'iPhone · Safari' }, { home });
  assert.equal(r.ok, true);
  const list = listDevices({ home });
  assert.equal(list.length, 1);
  assert.equal(list[0].pubKey, PUB_A);
  assert.equal(list[0].label, 'iPhone · Safari');
  assert.equal(list[0].id, deviceIdFor(PUB_A));
  assert.equal(typeof list[0].pairedAt, 'number');
});

test('id dẫn xuất từ khoá: cùng khoá cho cùng id, khác khoá cho khác id', () => {
  assert.equal(deviceIdFor(PUB_A), deviceIdFor(PUB_A));
  assert.notEqual(deviceIdFor(PUB_A), deviceIdFor(PUB_B));
  assert.match(deviceIdFor(PUB_A), /^[0-9a-f]{16}$/);
});

test('ghép lại thiết bị đã có: cập nhật, KHÔNG nhân bản', () => {
  const home = tmpHome();
  addDevice({ pubKey: PUB_A, label: 'iPhone · Safari' }, { home });
  const truoc = listDevices({ home })[0].pairedAt;
  addDevice({ pubKey: PUB_A, label: 'iPhone · Chrome' }, { home });
  const list = listDevices({ home });
  assert.equal(list.length, 1, 'khoá công khai là khoá định danh — cùng khoá là cùng thiết bị');
  assert.equal(list[0].label, 'iPhone · Chrome', 'nhãn phải được cập nhật');
  assert.ok(list[0].pairedAt >= truoc);
});

test('findDevice tra đúng theo id, không thấy thì null', () => {
  const home = tmpHome();
  addDevice({ pubKey: PUB_A, label: 'A' }, { home });
  assert.equal(findDevice(deviceIdFor(PUB_A), { home }).pubKey, PUB_A);
  assert.equal(findDevice(deviceIdFor(PUB_B), { home }), null);
  assert.equal(findDevice('khong-phai-id', { home }), null);
});

test('removeDevice gỡ đúng một cái, những cái khác còn nguyên', () => {
  const home = tmpHome();
  addDevice({ pubKey: PUB_A, label: 'A' }, { home });
  addDevice({ pubKey: PUB_B, label: 'B' }, { home });
  assert.equal(removeDevice(deviceIdFor(PUB_A), { home }), true);
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB_B]);
  assert.equal(removeDevice(deviceIdFor(PUB_A), { home }), false, 'gỡ cái đã gỡ trả false');
});

test('quá MAX_DEVICES thì từ chối, không âm thầm cắt bớt', () => {
  const home = tmpHome();
  for (let i = 0; i < MAX_DEVICES; i += 1) {
    assert.equal(addDevice({ pubKey: `khoa-${i}`, label: `d${i}` }, { home }).ok, true);
  }
  const r = addDevice({ pubKey: 'khoa-tran', label: 'thua' }, { home });
  assert.equal(r.ok, false);
  assert.match(r.reason, /20|đầy|giới hạn/i);
  assert.equal(listDevices({ home }).length, MAX_DEVICES);
});

test('file hỏng → mảng rỗng, KHÔNG ném', () => {
  // File này nằm trên đường đi của mọi kết nối tới daemon. Ném ở đây là
  // biến một file hỏng thành một daemon chết.
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(devicesPath(home), '{ khong phai json');
  assert.deepEqual(listDevices({ home }), []);
  assert.equal(findDevice('bat-ky', { home }), null);
});

test('chưa có file → mảng rỗng, không ném', () => {
  assert.deepEqual(listDevices({ home: tmpHome() }), []);
});

test('entry dị dạng trong file bị bỏ qua, entry lành còn lại', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(devicesPath(home), JSON.stringify({
    version: 1,
    devices: [
      { id: 'x', pubKey: PUB_A, label: 'lành', pairedAt: 1 },
      null,
      { label: 'thiếu khoá' },
      'khong-phai-object',
    ],
  }));
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB_A]);
});

test('addDevice từ chối đầu vào dị dạng, không ghi gì', () => {
  const home = tmpHome();
  for (const x of [null, undefined, '', 42, {}]) {
    assert.equal(addDevice({ pubKey: x, label: 'a' }, { home }).ok, false, JSON.stringify(x));
  }
  assert.deepEqual(listDevices({ home }), []);
});

test('file ghi với quyền 600 — nó ở trong thư mục nhà người ta', () => {
  const home = tmpHome();
  addDevice({ pubKey: PUB_A, label: 'A' }, { home });
  assert.equal(fs.statSync(devicesPath(home)).mode & 0o777, 0o600);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test term/test/devices.test.js`
Expected: FAIL — `Cannot find module '../src/devices.js'`

- [ ] **Step 3: Viết `term/src/devices.js`**

```js
// Sổ những thiết bị đã ghép với máy này: `~/.ccrc/devices.json`.
//
// Chỉ chứa khoá CÔNG KHAI. Trộm được file này không mở được gì — đó là điểm
// khác biệt cốt lõi so với `term-secret` ngày xưa, và là lý do nó được phép
// nằm trên đĩa trong khi bí mật ký vé thì không.
//
// Nằm NGOÀI daemon: một thiết bị đã ghép phải sống qua mọi `/remote on/off`
// và mọi lần khởi động lại máy. Daemon chỉ đọc, `/remote pair` mới ghi.
//
// Không hàm nào ở đây được ném. File này nằm trên đường đi của mọi kết nối
// tới daemon; một file hỏng phải nghĩa là "chưa ghép thiết bị nào" (mọi kết
// nối 401), không phải một daemon chết. Cùng kỷ luật với src/static.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Không phải vì ai cần 20, mà để một file bị nhét phình không làm daemon ì
// trên đường đi của mọi kết nối.
export const MAX_DEVICES = 20;

export function devicesPath(home) {
  return path.join(home || os.homedir(), '.ccrc', 'devices.json');
}

// Định danh thiết bị = dấu vân tay của chính khoá công khai. Nhờ vậy "cùng
// khoá là cùng thiết bị" đúng theo định nghĩa, không cần một bảng ánh xạ thứ
// hai để lệch với sự thật.
export function deviceIdFor(pubKey) {
  return crypto.createHash('sha256').update(String(pubKey)).digest('hex').slice(0, 16);
}

function fileFor(opts) {
  return opts.file || devicesPath(opts.home);
}

function readAll(opts) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(opts), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.devices)) return [];
    return raw.devices.filter((d) => d && typeof d === 'object'
      && typeof d.pubKey === 'string' && d.pubKey);
  } catch {
    return [];
  }
}

function writeAll(devices, opts) {
  try {
    const file = fileFor(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function listDevices(opts = {}) {
  return readAll(opts).map((d) => ({
    id: deviceIdFor(d.pubKey),
    pubKey: d.pubKey,
    label: typeof d.label === 'string' ? d.label : '',
    pairedAt: Number(d.pairedAt) || 0,
  }));
}

export function findDevice(id, opts = {}) {
  if (typeof id !== 'string' || !id) return null;
  return listDevices(opts).find((d) => d.id === id) || null;
}

export function addDevice({ pubKey, label } = {}, opts = {}) {
  if (typeof pubKey !== 'string' || !pubKey) {
    return { ok: false, reason: 'khoá công khai không hợp lệ' };
  }
  const devices = readAll(opts);
  const id = deviceIdFor(pubKey);
  const i = devices.findIndex((d) => deviceIdFor(d.pubKey) === id);
  const entry = {
    pubKey,
    label: typeof label === 'string' ? label : '',
    pairedAt: Date.now(),
  };
  if (i >= 0) {
    // Cùng khoá là cùng thiết bị: ghép lại là CẬP NHẬT, không phải thêm mới.
    // Nếu không, ghép lại vài lần là danh sách đầy những dòng giống hệt nhau
    // mà người dùng không biết xoá cái nào.
    devices[i] = entry;
  } else {
    if (devices.length >= MAX_DEVICES) {
      return { ok: false, reason: `đã đủ giới hạn ${MAX_DEVICES} thiết bị — gỡ bớt bằng /remote unpair` };
    }
    devices.push(entry);
  }
  if (!writeAll(devices, opts)) return { ok: false, reason: 'không ghi được devices.json' };
  return { ok: true, id };
}

export function removeDevice(id, opts = {}) {
  if (typeof id !== 'string' || !id) return false;
  const devices = readAll(opts);
  const con = devices.filter((d) => deviceIdFor(d.pubKey) !== id);
  if (con.length === devices.length) return false;
  return writeAll(con, opts);
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node --test term/test/devices.test.js`
Expected: PASS, 11/11

- [ ] **Step 5: Chạy toàn bộ suite và commit**

Run: `npm test` → 526 xanh

```bash
git add term/src/devices.js term/test/devices.test.js
git commit -m "Keep paired devices in a file that is safe to steal

devices.json holds public keys only, which is why it is allowed on disk at
all — the old per-run HMAC secret never was. It also lives outside the
daemon, so a device paired once survives every /remote on and off.

Nothing here throws. The file sits on the path of every connection to the
daemon, so a corrupt one has to mean \"no devices paired\" and a 401, not a
dead daemon.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `term/src/ticket.js` — v2, chữ ký ECDSA

**Files:**
- Modify: `term/src/ticket.js` (thay hoàn toàn phần HMAC)
- Test: `term/test/ticket.test.js` (viết lại), `term/test/ticket-interop.test.js` (mới)

**Interfaces:**
- Consumes: không (nhận `findDevice` qua tham số, không import `devices.js` — giữ module thuần tuý và test được mà không đụng đĩa)
- Produces:
  - `TOKEN_VERSION: string` = `'v2'`
  - `signingInputFor(payloadB64: string): string` — chuỗi được ký, dùng chung cho cả bên ký
  - `verifyAttachToken(token: string, {findDevice: (id) => ({pubKey}|null), sessionId: string, now?: number}): {ok: true, nonce, exp, iat, deviceId} | {ok: false, reason}`
  - `reason` ∈ `'malformed' | 'unknown_device' | 'bad_signature' | 'wrong_session' | 'expired'`

- [ ] **Step 1: Viết test đỏ — tương thích chéo WebCrypto ↔ node:crypto**

Đây là test bắt cái bẫy `ieee-p1363`. Tạo `term/test/ticket-interop.test.js`:

```js
// Điện thoại ký bằng WebCrypto; máy dev xác minh bằng node:crypto. Hai thư
// viện, hai định dạng chữ ký mặc định khác nhau:
//
//   WebCrypto  → raw r‖s   (IEEE P1363)
//   node:crypto→ DER       (mặc định)
//
// Quên `dsaEncoding: 'ieee-p1363'` là MỌI chữ ký hợp lệ đều bị từ chối, và
// triệu chứng nhìn y hệt "khoá sai". Test này ký bằng đúng thứ trình duyệt
// dùng, nên cái bẫy lộ ra ở đây chứ không phải trên điện thoại.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyAttachToken, signingInputFor, TOKEN_VERSION } from '../src/ticket.js';
import { deviceIdFor } from '../src/devices.js';

const { subtle } = crypto.webcrypto;

async function taoDienThoai() {
  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
  );
  const spki = Buffer.from(await subtle.exportKey('spki', pair.publicKey));
  const pubKey = spki.toString('base64url');
  return { pair, pubKey, id: deviceIdFor(pubKey) };
}

async function kyToken(phone, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    phone.pair.privateKey,
    Buffer.from(signingInputFor(payloadB64)),
  );
  return `${TOKEN_VERSION}.${payloadB64}.${Buffer.from(sig).toString('base64url')}`;
}

const payloadFor = (phone, over = {}) => ({
  sid: 's-abc', m: 'may-dev', iat: 1_000_000, exp: 1_060_000, n: 'nonce-1', k: phone.id, ...over,
});

test('chữ ký WebCrypto xác minh được bằng node:crypto', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: (id) => (id === phone.id ? { pubKey: phone.pubKey } : null),
    sessionId: 's-abc',
    now: 1_030_000,
  });
  assert.equal(r.ok, true, `bị từ chối vì "${r.reason}" — nghi ngờ dsaEncoding chưa đặt ieee-p1363`);
  assert.equal(r.nonce, 'nonce-1');
  assert.equal(r.deviceId, phone.id);
});

test('token ký bởi điện thoại KHÁC bị từ chối, dù nó tự khai id của người khác', async () => {
  const that = await taoDienThoai();
  const gia = await taoDienThoai();
  // Kẻ giả ký bằng khoá riêng của MÌNH nhưng khai `k` của thiết bị thật.
  const token = await kyToken(gia, payloadFor(gia, { k: that.id }));
  const r = verifyAttachToken(token, {
    findDevice: (id) => (id === that.id ? { pubKey: that.pubKey } : null),
    sessionId: 's-abc',
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('thiết bị đã bị gỡ → unknown_device, phân biệt hẳn với chữ ký sai', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => null, // devices.json không còn nó
    sessionId: 's-abc',
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_device',
    'hai chuyện khác hẳn nhau với người đang gỡ rối: bị gỡ, hay ký sai');
});

test('sửa một byte trong payload là chữ ký hỏng', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const [v, b64, sig] = token.split('.');
  const doi = JSON.parse(Buffer.from(b64, 'base64url').toString());
  doi.sid = 's-khac';
  const gia = `${v}.${Buffer.from(JSON.stringify(doi)).toString('base64url')}.${sig}`;
  const r = verifyAttachToken(gia, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-khac', now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('token hết hạn bị từ chối', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-abc', now: 1_060_001,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('token của phiên khác bị từ chối', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-phien-khac', now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_session');
});
```

- [ ] **Step 2: Viết test đỏ — tính tổng của bộ phân tích**

Thay nội dung `term/test/ticket.test.js` bằng:

```js
// Phần không cần khoá thật: mọi đầu vào dị dạng phải trả về LÝ DO, không ném.
// Hàm này là thứ duy nhất đứng giữa một URL bị lộ và một shell trên máy dev,
// nên nó cố tình nhỏ, thuần tuý, và tổng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAttachToken, TOKEN_VERSION } from '../src/ticket.js';

const opts = { findDevice: () => ({ pubKey: 'bat-ky' }), sessionId: 's-abc', now: 1000 };

test('phiên bản token là v2', () => {
  assert.equal(TOKEN_VERSION, 'v2');
});

test('đầu vào dị dạng trả malformed, không ném', () => {
  const xau = [
    null, undefined, 42, {}, [], '', 'khong-co-dau-cham',
    'a.b', 'a.b.c.d', 'v1.abc.def', `${TOKEN_VERSION}..def`, `${TOKEN_VERSION}.abc.`,
    `${TOKEN_VERSION}.khong-phai-base64url-json.abc`,
  ];
  for (const t of xau) {
    const r = verifyAttachToken(t, opts);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.equal(typeof r.reason, 'string');
  }
});

test('payload thiếu trường bắt buộc là malformed, không phải bỏ qua', () => {
  // Một trường thiếu mà được mặc định hoá âm thầm là đúng loại lỗi mà định
  // dạng token này sinh ra để chặn: nó vô hiệu hoá kiểm tra của người gọi.
  const day = { sid: 's-abc', m: 'm', iat: 1, exp: 2, n: 'n', k: 'k' };
  for (const thieu of Object.keys(day)) {
    const p = { ...day };
    delete p[thieu];
    const b64 = Buffer.from(JSON.stringify(p)).toString('base64url');
    const r = verifyAttachToken(`${TOKEN_VERSION}.${b64}.YWJj`, opts);
    assert.equal(r.ok, false, `thiếu ${thieu}`);
    assert.equal(r.reason, 'malformed', `thiếu ${thieu} phải là malformed`);
  }
});
```

- [ ] **Step 3: Chạy hai file test, xác nhận đỏ**

Run: `node --test term/test/ticket.test.js term/test/ticket-interop.test.js`
Expected: FAIL — `verifyAttachToken is not a function` (hoặc không export)

- [ ] **Step 4: Viết lại `term/src/ticket.js`**

```js
// Kiểm token mà ĐIỆN THOẠI tự ký để mở WebSocket terminal. Đây là thứ duy
// nhất đứng giữa một URL bị lộ và một shell trên máy dev, nên nó cố tình
// nhỏ, thuần tuý, và tổng: mọi đầu vào dị dạng trả về LÝ DO chứ không ném.
//
// v1 (bỏ) ký bằng HMAC với một bí mật hub giữ hộ. Nghĩa là chủ hub ký được
// vé vào phiên của bất kỳ ai. v2 ký bằng ECDSA P-256 với khoá riêng nằm
// trên chính điện thoại, non-extractable; máy dev xác minh bằng khoá công
// khai học được một lần lúc ghép cặp. Hub không còn gì để ký.
// Xem docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md.

import crypto from 'node:crypto';

export const TOKEN_VERSION = 'v2';

// Chữ ký phủ CẢ phiên bản lẫn payload. Nếu chỉ ký payload thì một chữ ký v2
// hợp lệ dán được sang một token khai phiên bản khác — và bất cứ phiên bản
// nào thêm sau này với luật lỏng hơn sẽ nhận nó.
export function signingInputFor(payloadB64) {
  return `${TOKEN_VERSION}.${payloadB64}`;
}

function verifySignature(pubKeyB64, payloadB64, sigB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubKeyB64, 'base64url'), format: 'der', type: 'spki',
    });
    return crypto.verify(
      'sha256',
      Buffer.from(signingInputFor(payloadB64)),
      // WebCrypto ký ra raw r‖s. node:crypto mặc định chờ DER, và không đặt
      // cờ này thì MỌI chữ ký hợp lệ đều bị từ chối — triệu chứng nhìn y hệt
      // "khoá sai". Xem term/test/ticket-interop.test.js.
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64, 'base64url'),
    );
  } catch {
    // Khoá công khai hỏng trong devices.json, chữ ký sai độ dài, v.v. —
    // tất cả là "không xác minh được", không phải một tiến trình chết.
    return false;
  }
}

/**
 * @param {string} token
 * @param {{findDevice: (id: string) => ({pubKey: string}|null), sessionId: string, now?: number}} o
 *   `findDevice` được TIÊM chứ không import từ devices.js: giữ module này
 *   thuần tuý và test được mà không đụng tới đĩa.
 */
export function verifyAttachToken(token, { findDevice, sessionId, now = Date.now() }) {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, b64, sig] = parts;

  let data;
  try {
    data = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'malformed' };
  }
  // Mọi trường bắt buộc, không trường nào được mặc định hoá âm thầm: một
  // mặc định lặng lẽ ở đây là vô hiệu hoá kiểm tra của người gọi.
  if (typeof data.k !== 'string' || !data.k) return { ok: false, reason: 'malformed' };
  if (typeof data.n !== 'string' || !data.n) return { ok: false, reason: 'malformed' };
  if (typeof data.sid !== 'string' || !data.sid) return { ok: false, reason: 'malformed' };
  if (typeof data.m !== 'string' || !data.m) return { ok: false, reason: 'malformed' };
  if (typeof data.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (typeof data.iat !== 'number') return { ok: false, reason: 'malformed' };

  // Tra thiết bị TRƯỚC khi xác minh, để phân biệt được "đã bị gỡ" với "ký
  // sai" — hai chuyện hoàn toàn khác nhau với người đang gỡ rối.
  const device = findDevice(data.k);
  if (!device || typeof device.pubKey !== 'string') {
    return { ok: false, reason: 'unknown_device' };
  }
  if (!verifySignature(device.pubKey, b64, sig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Chỉ kiểm nội dung SAU khi chữ ký đã đúng: trước đó payload là dữ liệu
  // của kẻ lạ, và một token giả không được đốt nonce nó chưa từng có.
  if (data.sid !== sessionId) return { ok: false, reason: 'wrong_session' };
  if (now > data.exp) return { ok: false, reason: 'expired' };

  // exp và iat đi kèm kết quả để người gọi buộc phần ghi sổ của mình (nhớ
  // nonce bao lâu, chấp nhận tuổi đúc tối đa bao nhiêu) vào chính vòng đời
  // của token, thay vì đoán bằng một hằng số rời hay đo bằng đồng hồ đang xem.
  return { ok: true, nonce: data.n, exp: data.exp, iat: data.iat, deviceId: data.k };
}
```

- [ ] **Step 5: Chạy hai file test, xác nhận xanh**

Run: `node --test term/test/ticket.test.js term/test/ticket-interop.test.js`
Expected: PASS

- [ ] **Step 6: Sửa các nơi còn import `signTicket`/`verifyTicket`**

`server/src/terminal-sessions.js` và `term/test/ticket-ttl-relation.test.js` còn tham chiếu tên cũ. **Chưa xoá ở task này** — chỉ làm cho suite chạy được: trong `terminal-sessions.js`, để nguyên `issueTicket` nhưng đổi import thành một hàm ký cục bộ tạm thời **không được có**. Thay vào đó, giữ `term/src/ticket-v1.js` là bản sao nguyên trạng của file cũ và cho `terminal-sessions.js` import từ đó.

```bash
git show HEAD:term/src/ticket.js > term/src/ticket-v1.js
```

Sửa dòng import trong `server/src/terminal-sessions.js`:

```js
import { signTicket } from '../../term/src/ticket-v1.js';
```

Và trong `term/test/ticket-ttl-relation.test.js`, đổi import tương ứng sang `ticket-v1.js`.

Thêm ghi chú đầu `term/src/ticket-v1.js`:

```js
// TẠM THỜI. Đây là bản v1 (HMAC do hub ký) giữ nguyên trạng, chỉ để đường vé
// cũ còn chạy trong lúc chuyển đổi. Task 10 xoá cả file này cùng với
// /api/terminal/ticket. Không viết gì mới dựa trên nó.
```

- [ ] **Step 7: Chạy toàn bộ suite, xác nhận xanh**

Run: `npm test`
Expected: mọi test cũ vẫn xanh + test mới. Nếu `ticket.test.js` cũ còn khẳng định hành vi HMAC thì nó đã bị thay ở Step 2 — không giữ lại bản cũ.

- [ ] **Step 8: Commit**

```bash
git add term/src/ticket.js term/src/ticket-v1.js term/test/ticket.test.js \
        term/test/ticket-interop.test.js term/test/ticket-ttl-relation.test.js \
        server/src/terminal-sessions.js
git commit -m "Verify an attach token the phone signed, not one the hub signed

v1 signed with an HMAC key the hub held on the daemon's behalf, which is
exactly what let the hub owner mint a ticket into anyone's session. v2
verifies an ECDSA P-256 signature against a public key the machine learned
once, at pairing.

The interop test signs with WebCrypto and verifies with node:crypto,
because those two disagree on signature encoding by default and the
symptom of getting it wrong is indistinguishable from a wrong key.

v1 is parked in ticket-v1.js so the old path keeps working until the
cut-over. It goes away with /api/terminal/ticket.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `server/src/pairing.js` — hàng đợi ghép cặp trên hub

**Files:**
- Create: `server/src/pairing.js`
- Test: `server/test/pairing.test.js`

**Interfaces:**
- Consumes: không có
- Produces:
  - `PAIR_TTL_MS: number` = `5 * 60_000`
  - `createPairings({now?: () => number}): Pairings`
  - `Pairings.start(userName, {pubKey, commit, label}): {ok: true, pairId} | {ok: false, reason}`
  - `Pairings.pending(userName): Array<{pairId, pubKey, commit, label, at}>` — chỉ trạng thái `started`
  - `Pairings.challenge(userName, pairId, nonceMachine): {ok} | {ok: false, reason}`
  - `Pairings.reveal(userName, pairId, noncePhone): {ok} | {ok: false, reason}`
  - `Pairings.finish(userName, pairId, ok: boolean): {ok} | {ok: false, reason}`
  - `Pairings.get(userName, pairId): {state, pubKey, commit, label, nonceMachine, noncePhone} | null`
  - Trạng thái: `'started' | 'challenged' | 'revealed' | 'done' | 'aborted'`

- [ ] **Step 1: Viết test đỏ**

Tạo `server/test/pairing.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairings, PAIR_TTL_MS } from '../src/pairing.js';

const REQ = { pubKey: 'khoa-cong-khai', commit: 'cam-ket', label: 'iPhone · Safari' };

test('luồng đầy đủ: start → challenge → reveal → finish(true) → done', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);

  assert.deepEqual(p.pending('huy').map((x) => x.pairId), [pairId]);
  assert.equal(p.get('huy', pairId).state, 'started');
  assert.equal(p.get('huy', pairId).pubKey, 'khoa-cong-khai');

  assert.equal(p.challenge('huy', pairId, 'nonce-may').ok, true);
  assert.equal(p.get('huy', pairId).state, 'challenged');
  assert.equal(p.get('huy', pairId).nonceMachine, 'nonce-may');

  assert.equal(p.reveal('huy', pairId, 'nonce-dien-thoai').ok, true);
  assert.equal(p.get('huy', pairId).state, 'revealed');
  assert.equal(p.get('huy', pairId).noncePhone, 'nonce-dien-thoai');

  assert.equal(p.finish('huy', pairId, true).ok, true);
  assert.equal(p.get('huy', pairId).state, 'done');
});

test('finish(false) — người dùng bấm [Không khớp] — cho trạng thái aborted', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  p.challenge('huy', pairId, 'nm');
  p.reveal('huy', pairId, 'np');
  assert.equal(p.finish('huy', pairId, false).ok, true);
  assert.equal(p.get('huy', pairId).state, 'aborted');
});

test('bước sai thứ tự bị từ chối', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  assert.equal(p.reveal('huy', pairId, 'np').ok, false, 'chưa challenge thì chưa reveal được');
  assert.equal(p.finish('huy', pairId, true).ok, false, 'chưa reveal thì chưa finish được');
  p.challenge('huy', pairId, 'nm');
  assert.equal(p.challenge('huy', pairId, 'nm2').ok, false, 'challenge hai lần bị từ chối');
});

test('người này KHÔNG thấy, KHÔNG đụng được yêu cầu của người kia', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  assert.deepEqual(p.pending('kien'), []);
  assert.equal(p.get('kien', pairId), null);
  assert.equal(p.challenge('kien', pairId, 'nm').ok, false);
  assert.equal(p.reveal('kien', pairId, 'np').ok, false);
  assert.equal(p.finish('kien', pairId, true).ok, false);
  assert.equal(p.get('huy', pairId).state, 'started', 'người khác không được làm gì thay đổi nó');
});

test('pairId không tồn tại → mọi thao tác trả false, get trả null', () => {
  const p = createPairings();
  assert.equal(p.get('huy', 'khong-co'), null);
  assert.equal(p.challenge('huy', 'khong-co', 'nm').ok, false);
});

test('quá hạn 5 phút thì biến mất', () => {
  let t = 0;
  const p = createPairings({ now: () => t });
  const { pairId } = p.start('huy', REQ);

  t = PAIR_TTL_MS;
  assert.equal(p.get('huy', pairId).state, 'started', 'đúng bằng ngưỡng thì chưa hết hạn');

  t = PAIR_TTL_MS + 1;
  assert.equal(p.get('huy', pairId), null);
  assert.deepEqual(p.pending('huy'), []);
  assert.equal(p.challenge('huy', pairId, 'nm').ok, false);
});

test('pairId của hai yêu cầu khác nhau thì khác nhau, và không đoán được', () => {
  const p = createPairings();
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { pairId } = p.start('huy', { ...REQ, pubKey: `k-${i}` });
    assert.ok(pairId.length >= 20, 'pairId ngắn là đoán được, mà đoán được là chen ngang được');
    assert.equal(ids.has(pairId), false);
    ids.add(pairId);
  }
});

test('start từ chối đầu vào dị dạng', () => {
  const p = createPairings();
  assert.equal(p.start('huy', { commit: 'c' }).ok, false, 'thiếu pubKey');
  assert.equal(p.start('huy', { pubKey: 'k' }).ok, false, 'thiếu commit');
  assert.equal(p.start('huy', null).ok, false);
  assert.deepEqual(p.pending('huy'), []);
});

test('pending chỉ trả yêu cầu đang chờ, không trả cái đã xong hay đã huỷ', () => {
  const p = createPairings();
  const a = p.start('huy', REQ).pairId;
  const b = p.start('huy', { ...REQ, pubKey: 'k2' }).pairId;
  p.challenge('huy', a, 'nm');
  assert.deepEqual(p.pending('huy').map((x) => x.pairId), [b],
    'yêu cầu đã bắt tay rồi không còn "đang chờ máy dev nhận" nữa');
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test server/test/pairing.test.js`
Expected: FAIL — `Cannot find module '../src/pairing.js'`

- [ ] **Step 3: Viết `server/src/pairing.js`**

```js
// Toàn bộ phần việc của hub trong nghi thức ghép cặp: giữ hộ mấy chuỗi trong
// đúng năm phút, theo đúng thứ tự, và không để yêu cầu của người này trả lời
// câu hỏi hỏi nhân danh người khác.
//
// Hub cố tình KHÔNG hiểu gì về mật mã ở đây. Nó không tính SAS, không kiểm
// cam kết, không biết cam kết mở ra cái gì. Đó là điểm mấu chốt: nếu hub tráo
// một chuỗi nào trong số này, hai màn hình sẽ hiện hai số khác nhau và người
// dùng thấy. Xem spec §5.2.
//
// Trong RAM, hệt như terminal-sessions.js: một cuộc ghép cặp dở dang sống
// được năm phút, và một hub khởi động lại chỉ có nghĩa là làm lại từ đầu.

import crypto from 'node:crypto';

export const PAIR_TTL_MS = 5 * 60_000;

export function createPairings({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {userName, pubKey, commit, label, state, nonceMachine, noncePhone, at}>} */
  const byId = new Map();

  // Dọn lười, từ mọi lối vào — cùng lý do như terminal-sessions.js: một entry
  // không còn tồn tại chỉ quan trọng vào đúng lúc có người nhìn nó, mà nhìn
  // chính là lúc này. Cũng nhờ vậy toàn bộ bị `now` tiêm điều khiển, và test
  // đẩy được thời gian tới mà không phải chờ thật.
  function prune() {
    const t = now();
    for (const [id, p] of byId) if (t - p.at > PAIR_TTL_MS) byId.delete(id);
  }

  // Tra theo id RỒI mới đối chiếu chủ sở hữu — không bao giờ quét theo người
  // dùng rồi tìm id. Cùng kỷ luật với terminal-sessions.js: một người không
  // được chạm tới thứ của người khác kể cả khi đoán trúng id.
  function own(userName, pairId) {
    prune();
    const p = byId.get(pairId);
    if (!p || p.userName !== userName) return null;
    return p;
  }

  const no = (reason) => ({ ok: false, reason });

  return {
    start(userName, req) {
      prune();
      if (!req || typeof req !== 'object') return no('thiếu thông tin ghép cặp');
      const { pubKey, commit, label } = req;
      if (typeof pubKey !== 'string' || !pubKey) return no('thiếu khoá công khai');
      if (typeof commit !== 'string' || !commit) return no('thiếu cam kết');
      // 24 byte: một pairId đoán được là một cách chen ngang vào cuộc ghép
      // cặp của người khác trong đúng cửa sổ năm phút đó.
      const pairId = crypto.randomBytes(24).toString('base64url');
      byId.set(pairId, {
        userName,
        pubKey,
        commit,
        label: typeof label === 'string' ? label : '',
        state: 'started',
        nonceMachine: null,
        noncePhone: null,
        at: now(),
      });
      return { ok: true, pairId };
    },

    pending(userName) {
      prune();
      const out = [];
      for (const [pairId, p] of byId) {
        if (p.userName !== userName || p.state !== 'started') continue;
        out.push({ pairId, pubKey: p.pubKey, commit: p.commit, label: p.label, at: p.at });
      }
      return out;
    },

    challenge(userName, pairId, nonceMachine) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'started') return no(`sai thứ tự: đang ở ${p.state}`);
      if (typeof nonceMachine !== 'string' || !nonceMachine) return no('thiếu nonce của máy');
      p.nonceMachine = nonceMachine;
      p.state = 'challenged';
      return { ok: true };
    },

    reveal(userName, pairId, noncePhone) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'challenged') return no(`sai thứ tự: đang ở ${p.state}`);
      if (typeof noncePhone !== 'string' || !noncePhone) return no('thiếu nonce của điện thoại');
      p.noncePhone = noncePhone;
      p.state = 'revealed';
      return { ok: true };
    },

    finish(userName, pairId, ok) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'revealed') return no(`sai thứ tự: đang ở ${p.state}`);
      p.state = ok === true ? 'done' : 'aborted';
      return { ok: true };
    },

    get(userName, pairId) {
      const p = own(userName, pairId);
      if (!p) return null;
      return {
        state: p.state,
        pubKey: p.pubKey,
        commit: p.commit,
        label: p.label,
        nonceMachine: p.nonceMachine,
        noncePhone: p.noncePhone,
      };
    },
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node --test server/test/pairing.test.js`
Expected: PASS, 9/9

- [ ] **Step 5: Chạy toàn bộ suite và commit**

Run: `npm test`

```bash
git add server/src/pairing.js server/test/pairing.test.js
git commit -m "Hold the pairing handshake for five minutes, understanding none of it

The hub does not compute the short authentication string, does not check
the commitment, and does not know what the commitment opens to. That is
the point: if it substitutes any of these strings, the two screens show
different numbers and the person pairing sees it.

Scoped per user with the same discipline as terminal-sessions: look up by
id, then check the owner — never scan one user's entries for another's.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Hub — sáu route `/api/pair/*`

**Files:**
- Modify: `server/src/index.js`
- Test: `server/test/pair-api.test.js` (mới)

**Interfaces:**
- Consumes: `createPairings` từ `server/src/pairing.js` (Task 4); `labelFromUserAgent` từ `server/src/push-devices.js` (đã có)
- Produces: sáu route HTTP. Mọi route đòi Bearer token và scope theo người dùng.
  - `POST /api/pair/start` `{pubKey, commit}` → `{ok: true, pairId}` | 400
  - `GET /api/pair/pending` → `{pairs: [{pairId, pubKey, commit, label, at}]}`
  - `POST /api/pair/challenge` `{pairId, nonceMachine}` → `{ok: true}` | 400
  - `POST /api/pair/reveal` `{pairId, noncePhone}` → `{ok: true}` | 400
  - `POST /api/pair/finish` `{pairId, ok: boolean}` → `{ok: true}` | 400
  - `GET /api/pair/:pairId` → `{state, pubKey, commit, label, nonceMachine, noncePhone}` | 404

- [ ] **Step 1: Viết test đỏ**

Tạo `server/test/pair-api.test.js`. Dùng lại nguyên helper `startHub`/`withHub` của `server/test/terminal-api.test.js` (đã nhận tham số `users` từ đợt sửa trước) — **sao chép** helper vào file mới, đúng như hai file test hub hiện có đang làm.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const DEFAULT_USERS = [{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }];

async function startHub(users = DEFAULT_USERS) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: { ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let died = null;
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  proc.once('exit', (code, signal) => { died = `hub thoát sớm (code=${code}, signal=${signal})`; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (died) throw new Error(`${died}\n${stderr}`);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (died) throw new Error(`${died}\n${stderr}`);
  return { base, stop: () => proc.kill() };
}

async function withHub(fn, users) {
  const h = await startHub(users);
  try { await fn(h); } finally { h.stop(); }
}

const post = (h, p, tok, body, headers = {}) => fetch(h.base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...headers },
  body: JSON.stringify(body),
});
const get = (h, p, tok) => fetch(h.base + p, { headers: { authorization: `Bearer ${tok}` } });

const REQ = { pubKey: 'khoa-cong-khai-cua-dien-thoai', commit: 'cam-ket-cua-dien-thoai' };

test('luồng đầy đủ qua HTTP thật', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.ok(pairId);

    const { pairs } = await (await get(h, '/api/pair/pending', 'tok-huy')).json();
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].pubKey, REQ.pubKey);
    assert.equal(pairs[0].commit, REQ.commit);

    assert.equal((await post(h, '/api/pair/challenge', 'tok-huy', { pairId, nonceMachine: 'nm' })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).nonceMachine, 'nm');

    assert.equal((await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).noncePhone, 'np');

    assert.equal((await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: true })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'done');
  });
});

test('nhãn do hub dẫn xuất từ User-Agent, KHÔNG nhận từ thân request', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy',
      { ...REQ, label: 'NHÃN NGƯỜI GỬI TỰ ĐẶT' },
      { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari/604.1' },
    )).json();
    const { pairs } = await (await get(h, '/api/pair/pending', 'tok-huy')).json();
    assert.equal(pairs[0].label, 'iPhone · Safari');
    assert.ok(pairId);
  });
});

test('người này KHÔNG thấy, KHÔNG đụng được yêu cầu ghép cặp của người kia', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.deepEqual((await (await get(h, '/api/pair/pending', 'tok-kien')).json()).pairs, []);
    assert.equal((await get(h, `/api/pair/${pairId}`, 'tok-kien')).status, 404);
    assert.equal((await post(h, '/api/pair/challenge', 'tok-kien', { pairId, nonceMachine: 'nm' })).status, 400);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'started',
      'kien không được làm gì thay đổi cuộc ghép cặp của huy');
  });
});

test('bước sai thứ tự bị từ chối 400', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.equal((await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' })).status, 400);
    assert.equal((await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: true })).status, 400);
  });
});

test('thân request dị dạng bị từ chối 400, hub vẫn sống', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/pair/start', 'tok-huy', { commit: 'c' })).status, 400);
    assert.equal((await post(h, '/api/pair/start', 'tok-huy', null)).status, 400);
    assert.equal((await post(h, '/api/pair/challenge', 'tok-huy', {})).status, 400);
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200, 'hub phải còn sống');
  });
});

test('không token thì cả sáu route đều 401', async () => {
  await withHub(async (h) => {
    const noAuth = (m, p) => fetch(h.base + p, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: m === 'POST' ? '{}' : undefined,
    });
    assert.equal((await noAuth('POST', '/api/pair/start')).status, 401);
    assert.equal((await noAuth('GET', '/api/pair/pending')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/challenge')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/reveal')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/finish')).status, 401);
    assert.equal((await noAuth('GET', '/api/pair/bat-ky')).status, 401);
  });
});

test('finish(false) cho trạng thái aborted — người dùng bấm [Không khớp]', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    await post(h, '/api/pair/challenge', 'tok-huy', { pairId, nonceMachine: 'nm' });
    await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' });
    await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: false });
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'aborted');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test server/test/pair-api.test.js`
Expected: FAIL — mọi route 404

- [ ] **Step 3: Nối `pairing.js` vào `server/src/index.js`**

Thêm import cạnh các import khác:

```js
import { createPairings } from './pairing.js';
```

Cạnh `const terminals = createTerminalSessions();` thêm:

```js
const pairings = createPairings();
```

Thêm khối route **trước** khối xử lý lỗi cuối file (`app.use((err, ...))`):

```js
// ---------------------------------------------------------------------------
// Ghép cặp thiết bị.
//
// Hub ở đây là người đưa thư MÙ: nó chuyển mấy chuỗi qua lại và không hiểu gì
// về chúng — không tính SAS, không kiểm cam kết, không biết cam kết mở ra cái
// gì. Nếu nó tráo một chuỗi nào, hai màn hình hiện hai số khác nhau và người
// dùng thấy. Đó là điều làm cho việc chuyển tiếp qua đây trở nên an toàn dù
// hub không được tin. Xem docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md §5.

app.post('/api/pair/start', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body;
  // Nhãn DẪN XUẤT từ User-Agent, không nhận từ thân request — cùng cách hub
  // đã làm cho thiết bị nhận thông báo, và cùng lý do: một User-Agent đầy đủ
  // là một dấu vân tay, còn "iPhone · Safari" là tất cả những gì cần.
  // Người gửi tự đặt nhãn thì nhãn thành thứ bịa được cho người khác đọc.
  const label = labelFromUserAgent(req.headers && req.headers['user-agent']);
  const r = pairings.start(user.name, {
    pubKey: b && b.pubKey, commit: b && b.commit, label,
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true, pairId: r.pairId });
});

app.get('/api/pair/pending', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ pairs: pairings.pending(user.name) });
});

app.post('/api/pair/challenge', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const r = pairings.challenge(user.name, b.pairId, b.nonceMachine);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

app.post('/api/pair/reveal', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const r = pairings.reveal(user.name, b.pairId, b.noncePhone);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

app.post('/api/pair/finish', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  // Chỉ đúng `true` là đồng ý. Một thân request dị dạng phải nghĩa là HUỶ,
  // không phải là ghép — mặc định ở đây phải nghiêng về phía không mở cửa.
  const r = pairings.finish(user.name, b.pairId, b.ok === true);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

// Đặt SAU /api/pair/pending, nếu không `:pairId` sẽ nuốt mất chuỗi "pending".
app.get('/api/pair/:pairId', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = pairings.get(user.name, req.params.pairId);
  if (!p) return res.status(404).json({ ok: false, error: 'không có yêu cầu ghép cặp nào như vậy' });
  res.json(p);
});
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node --test server/test/pair-api.test.js`
Expected: PASS, 7/7

Nếu `GET /api/pair/pending` trả 404 với `error: không có yêu cầu...` thì thứ tự khai báo route bị sai — `:pairId` phải nằm SAU `pending`.

- [ ] **Step 5: Chạy toàn bộ suite và commit**

Run: `npm test`

```bash
git add server/src/index.js server/test/pair-api.test.js
git commit -m "Relay the pairing handshake, and derive the device label here

The label comes from this request's User-Agent, never from its body — the
same way push device labels already work, and for the same reason: a full
user agent is a fingerprint and \"iPhone · Safari\" is all this needs. A
sender-supplied label is a label someone else can forge.

/api/pair/:pairId is declared after /api/pair/pending, or the parameter
route swallows the literal path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: CLI — `/remote pair`, `/remote devices`, `/remote unpair`

**Files:**
- Modify: `term/bin/ccrc-term-cli.js`
- Test: `term/test/remote-pair-cli.test.js` (mới)

**Interfaces:**
- Consumes: `randomNonce`, `commitMatches`, `shortAuthString` (Task 1); `addDevice`, `listDevices`, `removeDevice` (Task 2); sáu route `/api/pair/*` (Task 5)
- Produces: ba lệnh con của CLI. Thoát mã 0 khi thành công, khác 0 khi thất bại.

- [ ] **Step 1: Đọc phần điều phối lệnh hiện có**

Run: `grep -n "cmdOn\|cmdOff\|cmdStatus\|process.argv\|switch" term/bin/ccrc-term-cli.js`

Mục đích: bám đúng khuôn có sẵn (`say()`, `readConfig()`, cách gọi hub) chứ không dựng khuôn thứ hai.

- [ ] **Step 2: Viết test đỏ**

Tạo `term/test/remote-pair-cli.test.js`. Test chạy CLI thật với một `HOME` tạm và một hub giả cục bộ:

```js
// Chạy CLI thật với HOME tạm và một hub GIẢ cục bộ, để nghi thức ghép cặp
// được kiểm từ đầu tới cuối mà không cần điện thoại — vai điện thoại do
// chính test đóng, đúng như một điện thoại thật sẽ làm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomNonce, commitFor, shortAuthString } from '../src/pairing.js';
import { listDevices } from '../src/devices.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js');
const PUB = 'khoa-cong-khai-gia-cua-dien-thoai';

// Hub giả: giữ đúng máy trạng thái mà server/src/pairing.js giữ, ở mức tối
// thiểu CLI cần. Vai điện thoại do test điều khiển qua `state`.
//
// `soYeuCau` cho phép dựng tình huống hai điện thoại xin ghép cùng lúc —
// dựng nó ở HUB GIẢ chứ không phải bằng một cờ trong CLI: mã sản xuất không
// được mang nhánh nào chỉ tồn tại vì test.
function hubGia(soYeuCau = 1) {
  const state = {
    pairId: 'pair-1', pubKey: PUB, commit: null, label: 'iPhone · Safari',
    state: 'started', nonceMachine: null, noncePhone: null,
  };
  const srv = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/pair/pending') {
        if (state.state !== 'started') return send(200, { pairs: [] });
        const pairs = [];
        for (let i = 0; i < soYeuCau; i += 1) {
          pairs.push({ ...state, pairId: `pair-${i + 1}`, pubKey: `${PUB}-${i}` });
        }
        return send(200, { pairs });
      }
      if (req.url === '/api/pair/challenge') {
        state.nonceMachine = body.nonceMachine; state.state = 'challenged';
        return send(200, { ok: true });
      }
      if (req.url.startsWith('/api/pair/')) return send(200, { ...state });
      return send(404, {});
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      state,
      base: `http://127.0.0.1:${srv.address().port}`,
      stop: () => srv.close(),
    }));
  });
}

function homeTam(hubUrl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hubUrl}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);
  return home;
}

function chayCLI(home, args) {
  return new Promise((resolve) => {
    const p = spawn('node', [CLI, ...args], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

test('pair: in ra đúng SAS mà điện thoại tính được, rồi ghi devices.json khi được xác nhận', async () => {
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const noncePhone = randomNonce();
  hub.state.commit = commitFor(noncePhone);

  const chay = chayCLI(home, ['pair']);

  // Vai điện thoại: chờ máy dev gửi nonce của nó, rồi mở cam kết và đồng ý.
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub.state.nonceMachine, 'CLI phải gửi nonce của máy lên hub');
  hub.state.noncePhone = noncePhone;
  hub.state.state = 'revealed';
  const sasDienThoai = shortAuthString({ pubKey: PUB, noncePhone, nonceMachine: hub.state.nonceMachine });

  // Đợi CLI in số ra rồi mới xác nhận — đúng thứ tự người dùng thật làm.
  await new Promise((r) => setTimeout(r, 500));
  hub.state.state = 'done';

  const { code, out } = await chay;
  hub.stop();

  assert.equal(code, 0, out);
  assert.ok(out.includes(sasDienThoai),
    `phải in đúng số điện thoại đang hiện (${sasDienThoai}); thấy:\n${out}`);
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB]);
});

test('pair: cam kết không mở đúng → CẢNH BÁO và KHÔNG ghi gì', async () => {
  const hub = await hubGia();
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce()); // cam kết của một nonce KHÁC

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.state.noncePhone = randomNonce(); // không mở được cam kết trên
  hub.state.state = 'revealed';

  const { code, out } = await chay;
  hub.stop();

  assert.notEqual(code, 0);
  assert.match(out, /đứng giữa|không khớp|✗/i, `phải cảnh báo; thấy:\n${out}`);
  assert.deepEqual(listDevices({ home }), [], 'tuyệt đối không ghi gì khi cam kết sai');
});

test('pair: hai điện thoại xin ghép cùng lúc → từ chối cả hai, không đoán bừa', async () => {
  const hub = await hubGia(2);
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce());

  const { code, out } = await chayCLI(home, ['pair']);
  hub.stop();

  assert.notEqual(code, 0);
  assert.match(out, /từng cái|nhiều hơn một/i, `phải nói rõ vì sao; thấy:\n${out}`);
  assert.equal(hub.state.nonceMachine, null,
    'không được bắt tay với cái nào — chọn bừa một trong hai là phá đúng tính chất so số bảo vệ');
  assert.deepEqual(listDevices({ home }), []);
});

test('devices: liệt kê thiết bị đã ghép; unpair gỡ đúng cái được chỉ', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  fs.writeFileSync(path.join(home, '.ccrc', 'devices.json'), JSON.stringify({
    version: 1,
    devices: [
      { pubKey: 'khoa-A', label: 'iPhone · Safari', pairedAt: 1 },
      { pubKey: 'khoa-B', label: 'Android · Chrome', pairedAt: 2 },
    ],
  }));

  const ds = await chayCLI(home, ['devices']);
  assert.equal(ds.code, 0, ds.out);
  assert.match(ds.out, /iPhone · Safari/);
  assert.match(ds.out, /Android · Chrome/);

  const up = await chayCLI(home, ['unpair', '1']);
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(listDevices({ home }).map((d) => d.label), ['Android · Chrome']);
});

test('devices: chưa ghép cái nào thì nói rõ, không in bảng rỗng', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const { code, out } = await chayCLI(home, ['devices']);
  assert.equal(code, 0);
  assert.match(out, /chưa ghép|chưa có/i);
});
```

- [ ] **Step 3: Chạy test, xác nhận đỏ**

Run: `node --test term/test/remote-pair-cli.test.js`
Expected: FAIL — CLI chưa biết lệnh `pair`

- [ ] **Step 4: Thêm ba lệnh vào `term/bin/ccrc-term-cli.js`**

Thêm import ở đầu file:

```js
import { randomNonce, commitMatches, shortAuthString } from '../src/pairing.js';
import { addDevice, listDevices, removeDevice } from '../src/devices.js';
```

Thêm ba hàm lệnh (đặt cạnh các `cmd*` có sẵn, dùng lại `say()` và `readConfig()` của file):

```js
const PAIR_POLL_MS = 1000;
const PAIR_WAIT_MS = 120_000;

async function pairFetch(cfg, pathname, init = {}) {
  const res = await fetch(new URL(pathname, cfg.hubUrl), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  return res;
}

async function cmdPair() {
  const cfg = readConfig();
  if (!cfg) { say('Chưa cấu hình — chạy ./setup-notify.sh trước.'); return 1; }

  say('Đang chờ điện thoại xin ghép…');
  say('  Trên điện thoại: mở app, bấm "Ghép máy này".');

  // 1) Đợi một yêu cầu xuất hiện.
  let pair = null;
  const hetGio = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < hetGio) {
    let pairs = [];
    try {
      const r = await pairFetch(cfg, '/api/pair/pending');
      if (r.ok) ({ pairs } = await r.json());
    } catch { /* hub chớp nhoáng — thử lại vòng sau */ }

    if (pairs.length > 1) {
      // Từ chối chứ không đoán. So số chỉ có nghĩa khi biết CHẮC đang so với
      // ai; chọn bừa một trong hai là phá đúng cái tính chất đang bảo vệ.
      say('✗ Có nhiều hơn một điện thoại đang xin ghép.');
      say('  Làm từng cái một: bảo những người khác đợi, rồi chạy lại /remote pair.');
      return 1;
    }
    if (pairs.length === 1) { [pair] = pairs; break; }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  if (!pair) {
    say('✗ Không thấy điện thoại nào xin ghép trong 2 phút.');
    say('  Mở app trên điện thoại, bấm "Ghép máy này", rồi chạy lại /remote pair.');
    return 1;
  }

  // 2) Gửi nonce của máy.
  const nonceMachine = randomNonce();
  const ch = await pairFetch(cfg, '/api/pair/challenge', {
    method: 'POST',
    body: JSON.stringify({ pairId: pair.pairId, nonceMachine }),
  });
  if (!ch.ok) { say('✗ Hub từ chối bước bắt tay. Thử lại.'); return 1; }

  // 3) Đợi điện thoại mở cam kết.
  let st = null;
  const hetGio2 = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < hetGio2) {
    try {
      const r = await pairFetch(cfg, `/api/pair/${encodeURIComponent(pair.pairId)}`);
      if (r.ok) {
        st = await r.json();
        if (st.state === 'revealed' || st.state === 'done' || st.state === 'aborted') break;
      } else if (r.status === 404) {
        say('✗ Yêu cầu ghép cặp đã hết hạn. Làm lại từ đầu.');
        return 1;
      }
    } catch { /* thử lại vòng sau */ }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  if (!st || !st.noncePhone) { say('✗ Điện thoại không trả lời kịp. Làm lại từ đầu.'); return 1; }

  // 4) Cam kết phải mở ra đúng nonce vừa nhận. Đây là chỗ phát hiện hub tráo
  //    khoá: nếu nó tráo, nó không mở nổi cam kết thật.
  if (!commitMatches(pair.commit, st.noncePhone)) {
    say('✗ CẢNH BÁO: cam kết của điện thoại không khớp.');
    say('  Có thể có người đứng giữa, hoặc hub đang hỏng. KHÔNG ghép.');
    return 1;
  }

  const sas = shortAuthString({
    pubKey: pair.pubKey, noncePhone: st.noncePhone, nonceMachine,
  });
  say('');
  say(`  Mã xác nhận:  ${sas.split('').join(' ')}`);
  say('');
  say('So với số đang hiện trên điện thoại.');
  say('  Khớp   → bấm [Khớp] trên điện thoại.');
  say('  Lệch   → bấm [Không khớp]. Lệch nghĩa là CÓ NGƯỜI ĐỨNG GIỮA.');

  // 5) Đợi người dùng quyết trên điện thoại.
  const hetGio3 = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < hetGio3) {
    try {
      const r = await pairFetch(cfg, `/api/pair/${encodeURIComponent(pair.pairId)}`);
      if (r.ok) {
        const s = await r.json();
        if (s.state === 'done') {
          const add = addDevice({ pubKey: pair.pubKey, label: pair.label });
          if (!add.ok) { say(`✗ Không ghi được: ${add.reason}`); return 1; }
          say(`✓ Đã ghép ${pair.label || 'thiết bị'}`);
          say('  Từ giờ điện thoại này mở được mọi phiên /remote trên máy này.');
          return 0;
        }
        if (s.state === 'aborted') {
          say('✗ Điện thoại báo số KHÔNG khớp — không ghép.');
          say('  Số lệch nghĩa là có người đứng giữa. Đừng thử lại cho tới khi hiểu vì sao.');
          return 1;
        }
      }
    } catch { /* thử lại vòng sau */ }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  say('✗ Điện thoại chưa xác nhận. Làm lại từ đầu.');
  return 1;
}

function cmdDevices() {
  const list = listDevices();
  if (!list.length) {
    say('Chưa ghép điện thoại nào với máy này.');
    say('  Ghép bằng: /remote pair');
    return 0;
  }
  say(`Thiết bị đã ghép (${list.length}):`);
  list.forEach((d, i) => {
    const ngay = d.pairedAt ? new Date(d.pairedAt).toLocaleString('vi-VN') : 'không rõ';
    say(`  ${i + 1}. ${d.label || '(không nhãn)'} — ghép ${ngay}`);
  });
  say('');
  say('Gỡ một cái: /remote unpair <số>');
  say('Mất điện thoại: gỡ nó khỏi Tailscale trước — đó mới là công tắc ngắt thật,');
  say('và nó có hiệu lực trên MỌI máy cùng lúc.');
  return 0;
}

function cmdUnpair(arg) {
  const list = listDevices();
  if (!list.length) { say('Chưa ghép thiết bị nào.'); return 0; }
  const i = Number(arg) - 1;
  const d = Number.isInteger(i) && i >= 0 && i < list.length
    ? list[i]
    : list.find((x) => x.label === arg);
  if (!d) {
    say(`✗ Không có thiết bị "${arg}". Xem danh sách bằng: /remote devices`);
    return 1;
  }
  if (!removeDevice(d.id)) { say('✗ Không gỡ được.'); return 1; }
  say(`✓ Đã gỡ ${d.label || d.id}`);
  return 0;
}
```

Nối vào phần điều phối lệnh có sẵn — bám đúng khuôn `run()` của file:

```js
  if (cmd === 'pair') { process.exitCode = await cmdPair(); return; }
  if (cmd === 'devices') { process.exitCode = cmdDevices(); return; }
  if (cmd === 'unpair') { process.exitCode = cmdUnpair(args[1]); return; }
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `node --test term/test/remote-pair-cli.test.js`
Expected: PASS, 5/5

- [ ] **Step 6: Chạy toàn bộ suite và commit**

Run: `npm test`

```bash
git add term/bin/ccrc-term-cli.js term/test/remote-pair-cli.test.js
git commit -m "Add /remote pair, devices, and unpair

pair refuses outright when two phones are waiting rather than picking one.
Comparing numbers only means something if you know which device you are
comparing with, so guessing there breaks the property being protected.

devices tells the truth about revocation: removing the phone from
Tailscale is the real kill switch and it works on every machine at once,
while unpair only cleans up this one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: PWA — keystore và màn hình ghép cặp

**Files:**
- Modify: `server/public/app.js`, `server/public/index.html`
- Modify: `server/test/dom-harness.mjs` (tiêm `crypto` thật và `indexedDB` giả)
- Test: `server/test/app-pairing.test.js` (mới)

**Interfaces:**
- Consumes: sáu route `/api/pair/*` (Task 5)
- Produces (khai báo bằng `function` ở tầng cao nhất của `app.js` — chỉ `function` và `var` mới xuất hiện trên `context` của `vm.runInContext`; `const`/`let` thì **không**, nên đừng khai báo chúng bằng `const`):
  - `ensureDeviceKey(): Promise<{pubKey: string, deviceId: string, keyPair: CryptoKeyPair}>` — trả cả `keyPair` như một phần API thật, không phải cửa sau cho test
  - `sasFor({pubKey, noncePhone, nonceMachine, digits?}): Promise<string>` — bản trình duyệt của `shortAuthString`, mặc định 6 chữ số
  - `startPairing(machineName?: string): Promise<void>` — chạy toàn bộ nghi thức, cập nhật DOM. `machineName` là máy đang ghép, để ghi vào danh sách cục bộ khi thành công
  - `pairedMachines(): Promise<string[]>` — tên các máy đã ghép, để vẽ nút đúng

- [ ] **Step 1: Thêm `crypto` và `indexedDB` vào harness**

Sửa `server/test/dom-harness.mjs`. Thêm import và một IndexedDB giả tối thiểu — chỉ `open/transaction/objectStore/get/put`, đúng bằng những gì `app.js` dùng:

```js
import { webcrypto } from 'node:crypto';

// IndexedDB giả, tối thiểu. Chỉ đủ cho một kho khoá: mở CSDL, get, put.
// Dựng một bản IndexedDB đầy đủ ở đây là dựng cái harness thứ hai trá hình —
// nhưng KHÔNG dựng gì cả thì không test được đường lưu khoá, mà đó chính là
// đường quyết định điện thoại có ghép được hay không.
//
// `crypto` thì tiêm bản THẬT của Node (webcrypto): chữ ký trong test phải là
// chữ ký thật, nếu không test chỉ chứng minh được cái giả hoạt động.
export class FakeIDBRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
  _done(result) {
    this.result = result;
    queueMicrotask(() => { if (this.onsuccess) this.onsuccess({ target: this }); });
  }
}

export function makeFakeIndexedDB() {
  const stores = new Map(); // tênStore -> Map(key -> value)
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    _stores: stores,
    open(/* name, version */) {
      const req = new FakeIDBRequest();
      req.onupgradeneeded = null;
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => { storeOf(n); return {}; },
        transaction: (n) => ({
          objectStore: () => ({
            get(key) { const r = new FakeIDBRequest(); r._done(storeOf(n).get(key)); return r; },
            put(value, key) { storeOf(n).set(key, value); const r = new FakeIDBRequest(); r._done(undefined); return r; },
          }),
        }),
      };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        req._done(db);
      });
      return req;
    },
  };
}
```

Trong `contextObj`, thêm:

```js
    crypto: webcrypto,
    indexedDB: indexedDBImpl || makeFakeIndexedDB(),
```

và cho `loadAppPage` nhận tuỳ chọn `indexedDBImpl` giống cách nó đã nhận `navigatorImpl`.

- [ ] **Step 2: Viết test đỏ**

Tạo `server/test/app-pairing.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadAppPage, makeFetch } from './dom-harness.mjs';
import { shortAuthString, commitFor } from '../../term/src/pairing.js';

test('sinh khoá một lần rồi dùng lại — mở app lần hai không sinh khoá mới', async () => {
  const idb = (await import('./dom-harness.mjs')).makeFakeIndexedDB();
  const fetchImpl = makeFetch(async () => ({ status: 200, body: {} }));

  const a = loadAppPage({ fetchImpl, indexedDBImpl: idb });
  const k1 = await a.context.ensureDeviceKey();
  const b = loadAppPage({ fetchImpl, indexedDBImpl: idb });
  const k2 = await b.context.ensureDeviceKey();

  assert.equal(k1.pubKey, k2.pubKey, 'khoá phải sống qua lần mở app sau — nếu không, ghép cặp vô nghĩa');
  assert.equal(k1.deviceId, k2.deviceId);
  assert.ok(k1.pubKey.length > 40);
});

test('khoá riêng KHÔNG xuất được — kể cả mã trên chính trang này', async () => {
  const { context } = loadAppPage({
    fetchImpl: makeFetch(async () => ({ status: 200, body: {} })),
  });
  // `keyPair` là một phần giá trị trả về thật của ensureDeviceKey, không phải
  // cửa sau mở riêng cho test.
  const { keyPair } = await context.ensureDeviceKey();
  assert.equal(keyPair.privateKey.extractable, false,
    'extractable:true là app.js độc bê được khoá đi — mất toàn bộ điểm của thiết kế');
  await assert.rejects(() => webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  // Khoá công khai thì PHẢI xuất được, nếu không chẳng gửi đi ghép cặp được.
  // Đặc tả WebCrypto: với cặp khoá, cờ extractable chỉ áp cho khoá riêng.
  assert.ok(await webcrypto.subtle.exportKey('spki', keyPair.publicKey));
});

test('SAS bản trình duyệt cho ĐÚNG số mà bản Node cho', async () => {
  // Hai bản cài đặt của cùng một công thức, ở hai ngôn ngữ. Lệch nhau là
  // người dùng thấy hai số khác nhau và không ghép được máy nào — mà triệu
  // chứng đó nhìn y hệt "có người đứng giữa".
  const { context } = loadAppPage({ fetchImpl: makeFetch(async () => ({ status: 200, body: {} })) });
  for (const [pubKey, noncePhone, nonceMachine] of [
    ['k1', 'np1', 'nm1'], ['k2', 'np2', 'nm2'], ['a'.repeat(120), 'b'.repeat(43), 'c'.repeat(43)],
  ]) {
    assert.equal(
      await context.sasFor({ pubKey, noncePhone, nonceMachine }),
      shortAuthString({ pubKey, noncePhone, nonceMachine }),
      `lệch ở ${pubKey.slice(0, 8)}`,
    );
  }
});

test('ghép cặp: gửi cam kết TRƯỚC, chỉ mở nonce SAU khi nhận nonce của máy', async () => {
  // Thứ tự này CHÍNH LÀ tính chất bảo vệ. Mở sớm là quay về giao thức ngây
  // thơ mà term/test/pairing-attack.test.js chứng minh là bẻ được.
  const goi = [];
  let thanRevealSom = false;
  const fetchImpl = makeFetch(async (url, opts) => {
    goi.push(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url === '/api/pair/start') {
      assert.ok(body.commit, 'phải gửi cam kết ngay từ bước đầu');
      assert.equal(body.noncePhone, undefined, 'KHÔNG được gửi nonce ở bước đầu');
      return { status: 200, body: { ok: true, pairId: 'p1' } };
    }
    if (url === '/api/pair/p1') {
      // Máy dev đã gửi nonce của nó.
      return { status: 200, body: { state: 'challenged', nonceMachine: 'nm-cua-may' } };
    }
    if (url === '/api/pair/reveal') {
      if (!goi.includes('/api/pair/p1')) thanRevealSom = true;
      assert.ok(body.noncePhone, 'reveal phải mang nonce');
      return { status: 200, body: { ok: true } };
    }
    if (url === '/api/pair/finish') return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });

  const { context, byId } = loadAppPage({ fetchImpl });
  await context.startPairing();

  assert.equal(thanRevealSom, false, 'mở nonce trước khi biết nonce của máy là bỏ mất cam kết');
  assert.match(byId['pair-sas'].textContent, /^\d{6}$/, 'phải hiện đúng 6 chữ số cho người dùng so');
});

test('bấm [Không khớp] gửi finish(ok:false) và KHÔNG ghi máy vào danh sách đã ghép', async () => {
  let finishBody = null;
  const fetchImpl = makeFetch(async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url === '/api/pair/start') return { status: 200, body: { ok: true, pairId: 'p1' } };
    if (url === '/api/pair/p1') return { status: 200, body: { state: 'challenged', nonceMachine: 'nm' } };
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    if (url === '/api/pair/finish') { finishBody = body; return { status: 200, body: { ok: true } }; }
    return { status: 404, body: {} };
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.startPairing();
  await byId['pair-mismatch'].onclick();

  assert.equal(finishBody.ok, false);
  assert.deepEqual(await context.pairedMachines(), [],
    'số lệch mà vẫn ghi vào danh sách là đúng cái lỗi nghi thức này sinh ra để chặn');
});
```

- [ ] **Step 3: Chạy test, xác nhận đỏ**

Run: `node --test server/test/app-pairing.test.js`
Expected: FAIL — `ensureDeviceKey is not a function`

- [ ] **Step 4: Thêm các phần tử vào `server/public/index.html`**

Trong khối `#main`, trên phần danh sách terminal:

```html
<div id="pair-panel" class="card hidden">
  <div class="row" id="pair-title">Ghép máy này</div>
  <p class="dim small" id="pair-step">Đang chờ máy dev…</p>
  <p id="pair-sas" class="sas"></p>
  <p class="dim small" id="pair-help">So với số đang hiện trên máy dev.</p>
  <button id="pair-match">Khớp</button>
  <button id="pair-mismatch">Không khớp</button>
  <p id="pair-err" class="err hidden"></p>
</div>
```

Thêm vào `server/public/style.css`:

```css
.sas { font-size: 2rem; letter-spacing: .4em; text-align: center; font-variant-numeric: tabular-nums; }
```

Thêm cả sáu id mới vào `REQUIRED_IDS` trong `server/test/dom-harness.mjs`, và `pair-match`/`pair-mismatch` vào `BUTTON_IDS`.

- [ ] **Step 5: Viết phần keystore + ghép cặp trong `server/public/app.js`**

```js
// --- kho khoá thiết bị -----------------------------------------------------
//
// Một cặp khoá ECDSA P-256 cho cả người dùng, dùng với mọi máy dev. Khoá riêng
// sinh ra với extractable:false và nằm trong IndexedDB — theo đặc tả WebCrypto,
// với cặp khoá thì cờ đó chỉ áp cho khoá RIÊNG, khoá công khai vẫn xuất được,
// nên vẫn lấy được SPKI để gửi đi.
//
// Vì sao non-extractable là điều đáng đánh đổi: hub phục vụ chính file này, nên
// một hub bị chiếm đẩy được một bản app.js độc xuống. Không có cờ đó, bản độc
// bê luôn khoá riêng đi và dùng mãi mãi. Có cờ đó, nó chỉ ký hộ được trong lúc
// trang đang mở.
//
// Cái giá, phải nói với người dùng: khoá này KHÔNG sao lưu được. Xoá dữ liệu
// trang hay cài lại app là mất, và phải ghép lại từng máy.

const KEY_DB = 'ccrc';
const KEY_STORE = 'keys';
const KEY_ID = 'device';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// `var`, không phải `let`: chỉ `var` và khai báo `function` mới xuất hiện trên
// đối tượng context của vm.runInContext, và harness test truy cập qua đó.
var deviceKeyPair = null;

async function ensureDeviceKey() {
  const db = await idbOpen();
  let rec = await idbGet(db, KEY_ID);
  if (!rec) {
    // extractable:false — xem khối chú thích trên. Đây là dòng làm cho câu
    // "app.js độc cũng không bê khoá đi được" là sự thật.
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    );
    rec = { keyPair: kp, machines: [] };
    await idbPut(db, KEY_ID, rec);
  }
  deviceKeyPair = rec.keyPair;
  const spki = await crypto.subtle.exportKey('spki', rec.keyPair.publicKey);
  const pubKey = b64url(spki);
  const idBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubKey));
  const deviceId = Array.from(new Uint8Array(idBuf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // Phải khớp từng ký tự với deviceIdFor() trong term/src/devices.js: 8 byte
  // ĐẦU của SHA-256 trên chuỗi base64url của khoá công khai, viết hex thường.
  // Lệch cách tính là daemon trả unknown_device cho một thiết bị đã ghép.
  return { pubKey, deviceId, keyPair: rec.keyPair };
}

// Bản trình duyệt của term/src/pairing.js's shortAuthString. Hai bản cài đặt,
// một công thức — lệch nhau là hai màn hình hiện hai số khác nhau, mà triệu
// chứng đó nhìn y hệt "có người đứng giữa". server/test/app-pairing.test.js
// so trực tiếp hai bản với nhau, đúng vì lý do đó.
async function sasFor({ pubKey, noncePhone, nonceMachine, digits = 6 }) {
  const material = [pubKey, noncePhone, nonceMachine].join('.');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

function randomNonceB64() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256B64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function pairedMachines() {
  const db = await idbOpen();
  const rec = await idbGet(db, KEY_ID);
  return (rec && Array.isArray(rec.machines)) ? rec.machines : [];
}

async function rememberMachine(machine) {
  const db = await idbOpen();
  const rec = await idbGet(db, KEY_ID);
  if (!rec) return;
  rec.machines = Array.from(new Set([...(rec.machines || []), machine]));
  await idbPut(db, KEY_ID, rec);
}

var pairState = null;

async function startPairing(machineName) {
  const panel = $('pair-panel');
  const err = $('pair-err');
  panel.classList.remove('hidden');
  err.classList.add('hidden');
  $('pair-sas').textContent = '';
  $('pair-step').textContent = 'Đang chờ máy dev…';

  const { pubKey } = await ensureDeviceKey();
  const noncePhone = randomNonceB64();
  // Cam kết đi TRƯỚC, nonce mở SAU. Đảo thứ tự này là quay về giao thức ngây
  // thơ mà hub tráo được khoá rồi dò nonce cho hai màn hình trùng số.
  const commit = await sha256B64(noncePhone);

  const started = await api('/api/pair/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubKey, commit }),
  });
  if (!started.ok) {
    err.textContent = 'Không bắt đầu được. Thử lại.';
    err.classList.remove('hidden');
    return;
  }
  const { pairId } = await started.json();

  // Đợi máy dev gửi nonce của nó.
  let nonceMachine = null;
  for (let i = 0; i < 120 && nonceMachine === null; i += 1) {
    const r = await api(`/api/pair/${encodeURIComponent(pairId)}`);
    if (r.ok) {
      const s = await r.json();
      if (s.nonceMachine) { nonceMachine = s.nonceMachine; break; }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!nonceMachine) {
    $('pair-step').textContent = 'Máy dev không trả lời. Chạy /remote pair trên máy rồi thử lại.';
    return;
  }

  await api('/api/pair/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairId, noncePhone }),
  });

  pairState = { pairId, machine: machineName || null };
  $('pair-step').textContent = 'So số này với số trên máy dev:';
  $('pair-sas').textContent = await sasFor({ pubKey, noncePhone, nonceMachine });
}

async function finishPairing(ok) {
  if (!pairState) return;
  const { pairId, machine } = pairState;
  await api('/api/pair/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairId, ok }),
  });
  if (ok && machine) await rememberMachine(machine);
  pairState = null;
  $('pair-panel').classList.add('hidden');
  if (!ok) {
    const err = $('pair-err');
    err.textContent = 'Số lệch nghĩa là có người đứng giữa. Đừng thử lại cho tới khi hiểu vì sao.';
    err.classList.remove('hidden');
    $('pair-panel').classList.remove('hidden');
  }
  await refreshTerminal();
}

$('pair-match').onclick = () => finishPairing(true);
$('pair-mismatch').onclick = () => finishPairing(false);
```

- [ ] **Step 6: Chạy test, xác nhận xanh**

Run: `node --test server/test/app-pairing.test.js`
Expected: PASS, 5/5

Nếu test "khoá riêng KHÔNG xuất được" không với tới được cặp khoá, đổi khẳng định sang kiểm qua `crypto.subtle.exportKey` phải reject — đừng thêm biến chỉ để test đọc.

- [ ] **Step 7: Chạy toàn bộ suite và commit**

Run: `npm test`

```bash
git add server/public/app.js server/public/index.html server/public/style.css \
        server/test/dom-harness.mjs server/test/app-pairing.test.js
git commit -m "Give the phone a key it cannot hand over, and a screen to compare on

The private key is generated non-extractable, which matters precisely
because the hub serves this file: a compromised hub can ship a modified
app.js, and the most that buys it is signing while the page is open — not
the key itself.

The commitment is sent with the public key and the nonce only after the
machine's nonce arrives. Reversing that is the naive protocol the attack
test already broke.

The browser's SAS is checked against the Node one directly. Two
implementations of one formula that disagree would show two different
numbers, which looks exactly like an attack.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Daemon xác minh v2, bỏ gửi `secret`

> **Cửa sổ gãy bắt đầu ở đây.** Sau task này daemon chỉ nhận token v2 còn PWA vẫn gửi vé v1 — terminal **không mở được** cho tới hết Task 9. Làm Task 9 ngay sau.

**Files:**
- Modify: `term/bin/ccrc-term.js`
- Test: `term/test/daemon.test.js` (thêm), `term/test/helpers.mjs` (thêm helper ký v2)

**Interfaces:**
- Consumes: `verifyAttachToken`, `signingInputFor`, `TOKEN_VERSION` (Task 3); `findDevice` (Task 2)
- Produces: daemon nhận `?token=` thay `?ticket=`; nhịp tim không còn trường `secret`

- [ ] **Step 1: Thêm helper ký token v2 vào `term/test/helpers.mjs`**

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signingInputFor, TOKEN_VERSION } from '../src/ticket.js';
import { deviceIdFor } from '../src/devices.js';

// Đóng vai điện thoại trong test daemon: sinh cặp khoá, ký token v2 bằng ĐÚNG
// định dạng chữ ký mà WebCrypto sinh ra (raw r‖s).
export async function taoThietBiTest() {
  const { subtle } = crypto.webcrypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pubKey = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64url');
  return {
    pubKey,
    id: deviceIdFor(pubKey),
    async ky({ sessionId, machine = 'may-test', ttlMs = 60_000, now = Date.now(), nonce }) {
      const payload = {
        sid: sessionId, m: machine, iat: now, exp: now + ttlMs,
        n: nonce || crypto.randomBytes(12).toString('base64url'), k: deviceIdFor(pubKey),
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
        Buffer.from(signingInputFor(b64)));
      return `${TOKEN_VERSION}.${b64}.${Buffer.from(sig).toString('base64url')}`;
    },
  };
}

// Ghi devices.json vào một HOME tạm, đúng định dạng term/src/devices.js đọc.
// `raw` cho phép ghi thẳng chuỗi rác, để dựng ca "file hỏng".
export function ghiDevices(home, devices, raw) {
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ccrc', 'devices.json'),
    raw !== undefined ? raw : JSON.stringify({ version: 1, devices }),
  );
}
```

- [ ] **Step 2: Viết test đỏ trong `term/test/daemon.test.js`**

Thêm vào cuối file (bám khuôn `connect()`/`waitPortListening()` sẵn có trong đó):

Trước hết thêm một helper dựng cảnh, ngay trên các test mới — bốn test dưới đây dùng chung
nó nên phần dựng tmux/daemon chỉ viết một lần:

```js
import { taoThietBiTest, ghiDevices } from './helpers.mjs';

// Dựng: một tmux session thật, một HOME tạm có devices.json, và một daemon
// trỏ vào pane đó. Trả về mọi thứ cần cho test + hàm dọn.
//
// `devices` là mảng ghi vào devices.json; `rawDevices` ghi thẳng chuỗi (để
// dựng ca file hỏng). CCRC_TERM_NO_HUB=1 vì mấy test này không nói gì tới hub.
async function dungCanh({ devices = [], rawDevices } = {}) {
  const T = tmuxBin();
  const sess = `ccrc-pair-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'],
    { encoding: 'utf8' }).trim();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-pair-'));
  ghiDevices(home, devices, rawDevices);

  const port = await freePort();
  const proc = spawn('node', [DAEMON], {
    env: {
      ...process.env,
      HOME: home,
      CCRC_TERM_PANE: pane,
      CCRC_TERM_SESSION_ID: 's-pair',
      CCRC_TERM_PORT: String(port),
      CCRC_TERM_BIND: '127.0.0.1',
      CCRC_TERM_NO_HUB: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  await waitPortListening(port, proc);

  return {
    port,
    home,
    async dong() {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* đã chết */ }
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* đã chết */ } }
      await sleep(200);
      try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch { /* không có */ }
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* không có */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* thôi */ }
    },
  };
}

test('token ký bởi thiết bị ĐÃ GHÉP mở được WebSocket', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }],
  });
  try {
    const token = await phone.ky({ sessionId: 's-pair' });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'thiết bị đã ghép phải mở được');
    ws.ws.close();
  } finally { await c.dong(); }
});

test('token ký bởi thiết bị CHƯA ghép bị từ chối 401', async () => {
  const daGhep = await taoThietBiTest();
  const la = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: daGhep.pubKey, label: 'da-ghep', pairedAt: 1 }],
  });
  try {
    const token = await la.ky({ sessionId: 's-pair' });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, false, 'khoá lạ mở được là toàn bộ thiết kế này vô nghĩa');
  } finally { await c.dong(); }
});

test('devices.json hỏng → 401, daemon KHÔNG sập', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({ rawDevices: '{ day khong phai json' });
  try {
    const token = await phone.ky({ sessionId: 's-pair' });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, false);
    // Daemon phải còn sống: một file cấu hình hỏng nghĩa là "chưa ghép thiết
    // bị nào", không phải một tiến trình chết.
    const r = await fetch(`http://127.0.0.1:${c.port}/`);
    assert.equal(r.status, 200, 'một file hỏng không được giết daemon');
  } finally { await c.dong(); }
});

test('token dùng lại lần hai bị từ chối — nonce một lần vẫn còn hiệu lực', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }],
  });
  try {
    const token = await phone.ky({ sessionId: 's-pair' });
    const c1 = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c1.ok, true);
    c1.ws.close();
    await sleep(200);
    const c2 = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c2.ok, false, 'token một lần là một lần — dù chữ ký vẫn còn hợp lệ');
  } finally { await c.dong(); }
});
```

Test cuối dùng `captureRegisterHub()` đã có sẵn trong file này (nó bắt thân request của nhịp
tim đầu tiên), nên nó dựng daemon theo khuôn của chính hàm đó chứ không qua `dungCanh`:

```js
test('nhịp tim KHÔNG còn mang trường secret', async () => {
  const T = tmuxBin();
  const sess = `ccrc-nosecret-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'],
    { encoding: 'utf8' }).trim();

  const hub = await captureRegisterHub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-nosecret-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);

  const port = await freePort();
  let proc;
  try {
    // Cố tình KHÔNG đặt CCRC_TERM_NO_HUB: đây chính là đường nhịp tim thật.
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-nosecret',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_URL: `http://100.86.1.2:${port}/`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);

    const body = await hub.waitForCount(1);
    assert.equal(body.secret, undefined,
      'gửi bí mật lên hub là đúng thứ thiết kế này vừa bỏ đi — còn gửi nghĩa là chưa bỏ');
    assert.ok(body.sessionId && body.machine && body.url,
      'phần còn lại của nhịp tim phải giữ nguyên');
    assert.equal(typeof body.label, 'string');
  } finally {
    try { proc && process.kill(proc.pid, 'SIGKILL'); } catch { /* đã chết */ }
    if (proc) {
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* đã chết */ } }
    }
    await sleep(200);
    try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch { /* không có */ }
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* không có */ }
    hub.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* thôi */ }
  }
});
```

`dungCanh` dựa vào `tmuxBin`, `freePort`, `waitPortListening`, `childPids`, `sleep`, `connect`
và `DAEMON` — tất cả đã có sẵn ở đầu `daemon.test.js`. Không khai báo lại cái nào.

- [ ] **Step 3: Chạy test, xác nhận đỏ**

Run: `node --test term/test/daemon.test.js`
Expected: các test mới FAIL — daemon còn đòi `?ticket=`

- [ ] **Step 4: Sửa `term/bin/ccrc-term.js`**

Đổi import:

```js
import { verifyAttachToken } from '../src/ticket.js';
import { findDevice } from '../src/devices.js';
```

Xoá dòng sinh `secret`:

```js
// XOÁ: const secret = process.env.CCRC_TERM_SECRET || crypto.randomBytes(32).toString('base64url');
```

Thay khối kiểm trong `server.on('upgrade', …)`:

```js
  // `?token=` thay cho `?ticket=`: token do CHÍNH ĐIỆN THOẠI ký, không phải
  // do hub ký hộ. Hub không còn giữ gì ký được nó. Vẫn đúng luật cũ: kiểm
  // trước, và khi có token thì chỉ xét token — một `?key=` đi kèm một token
  // hỏng không được rơi xuống nhánh key, nếu không một khoá phiên bị lộ sẽ
  // che lấp được một token bị từ chối.
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  let mintKey = false;

  if (token !== null) {
    const v = verifyAttachToken(token, {
      // Đọc lại devices.json ở MỖI kết nối, không nạp một lần lúc khởi động:
      // `/remote unpair` phải có hiệu lực ngay, không đợi khởi động lại daemon.
      findDevice: (id) => findDevice(id),
      sessionId: SESSION_ID,
    });
    if (!v.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    if (v.exp - v.iat > MAX_TICKET_LIFETIME_MS) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    if (!nonces.use(v.nonce, Date.now(), v.exp)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    mintKey = true;
  } else if (!sessionKeys.valid(key)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
```

Bỏ `secret` khỏi nhịp tim trong `beat()`:

```js
    return tellHub('/api/terminal/register', {
      sessionId: SESSION_ID,
      machine: cfg ? cfg.machine : os.hostname(),
      url: publicUrl,
      // `secret` đã bỏ: hub không còn ký vé nữa, nên nó không còn lý do gì
      // để biết bí mật của máy này. Đó chính là thay đổi mà cả thiết kế này
      // xoay quanh.
      label: SESSION_NAME,
      viewing: someoneIsWatching(),
    });
```

Sửa luôn khối chú thích ở đầu file nói về `secret` sinh mỗi lần chạy — nó không còn đúng.

- [ ] **Step 5: Chạy test daemon, xác nhận xanh**

Run: `node --test term/test/daemon.test.js`
Expected: PASS. Các test cũ dựa trên `CCRC_TERM_SECRET` + `signTicket` phải được **viết lại** sang token v2 bằng `taoThietBiTest()`, không phải xoá đi — tính chất chúng canh (một lần, hết hạn, sai phiên, khởi động lại) vẫn nguyên giá trị.

- [ ] **Step 6: Commit** (suite chưa xanh hoàn toàn — PWA còn gửi v1; ghi rõ trong commit)

```bash
git add term/bin/ccrc-term.js term/test/daemon.test.js term/test/helpers.mjs
git commit -m "Verify the phone's own signature, and stop telling the hub any secret

The daemon reads devices.json on every connection rather than caching it
at startup, so /remote unpair takes effect immediately instead of at the
next restart.

The heartbeat no longer carries a secret. The hub has no reason to know
one now that it does not sign anything, and that removal is the whole
point of the design.

The PWA still sends v1 tickets at this commit, so terminals do not open
until the next one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: PWA ký token, `term.js` nhận `?token=`

> **Cửa sổ gãy đóng lại ở task này.** Kết thúc task, hệ thống chạy lại đầy đủ.

**Files:**
- Modify: `server/public/app.js`, `term/public/term.js`
- Test: `server/test/app-terminal.test.js` (sửa)

**Interfaces:**
- Consumes: `ensureDeviceKey`, `pairedMachines` (Task 7)
- Produces: `signAttachToken(session): Promise<string>`

- [ ] **Step 1: Sửa test đỏ trong `server/test/app-terminal.test.js`**

Đổi test "bấm Mở terminal → xin vé rồi điều hướng" thành:

```js
test('bấm Mở terminal: KHÔNG gọi hub xin vé, tự ký rồi điều hướng sang <url>#t=<token>', async () => {
  let goiVe = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal/ticket') { goiVe += 1; return { status: 404, body: {} }; }
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, location } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.equal(goiVe, 0, 'hub không còn vai trò gì trong việc mở terminal');
  assert.ok(location.href.startsWith(SESSION_ALIVE.url + '#t=v2.'),
    `phải là token v2 tự ký; thấy: ${location.href}`);
});

test('token tự ký xác minh được bằng đúng bộ kiểm của daemon', async () => {
  // Vòng khép kín: ký ở trình duyệt, kiểm bằng chính hàm daemon dùng. Đây là
  // chỗ mọi lệch pha về định dạng chữ ký hay chuỗi được ký sẽ lộ ra.
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, location } = loadAppPage({ fetchImpl });
  const { pubKey, deviceId } = await context.ensureDeviceKey();
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  const token = location.href.split('#t=')[1];
  const r = verifyAttachToken(decodeURIComponent(token), {
    findDevice: (id) => (id === deviceId ? { pubKey } : null),
    sessionId: SESSION_ALIVE.sessionId,
  });
  assert.equal(r.ok, true, `daemon sẽ từ chối token này vì "${r.reason}"`);
});
```

Thêm import `verifyAttachToken` từ `../../term/src/ticket.js` vào đầu file test.

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test server/test/app-terminal.test.js`
Expected: FAIL — vẫn gọi `/api/terminal/ticket`

- [ ] **Step 3: Thay `openTerminal` trong `server/public/app.js`**

```js
async function signAttachToken(session) {
  const { deviceId } = await ensureDeviceKey();
  const now = Date.now();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const payload = {
    sid: session.sessionId,
    m: session.machine,
    iat: now,
    exp: now + 60_000,
    n: b64url(nonceBytes),
    k: deviceId,
  };
  const b64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  // Ký CẢ phiên bản lẫn payload — cùng chuỗi mà term/src/ticket.js's
  // signingInputFor() dựng. Lệch một ký tự là mọi chữ ký bị từ chối.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    deviceKeyPair.privateKey,
    new TextEncoder().encode(`v2.${b64}`),
  );
  return `v2.${b64}.${b64url(sig)}`;
}

async function openTerminal(session, btn) {
  const err = $('terminal-err');
  err.classList.add('hidden');
  if (!isTailnetTerminalUrl(session.url)) {
    btn.disabled = false;
    btn.textContent = 'Mở terminal';
    err.textContent = 'Phiên này báo một địa chỉ không hợp lệ — không mở. Hãy chạy /remote off rồi /remote on trên máy dev.';
    err.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Đang mở…';
  try {
    // Không còn bước hỏi hub. Điện thoại tự ký, hub không tham gia và không
    // biết gì về việc này.
    const token = await signAttachToken(session);
    location.href = session.url + '#t=' + encodeURIComponent(token);
  } catch (e) {
    await refreshTerminal();
    err.textContent = 'Không ký được yêu cầu mở — điện thoại này có thể chưa ghép với máy đó.';
    err.classList.remove('hidden');
  }
}
```

Sửa `buildTerminalCard` để máy chưa ghép hiện nút Ghép:

```js
async function buildTerminalCardAsync(session) {
  const card = buildTerminalCard(session);
  if (session.alive && !(await pairedMachines()).includes(session.machine)) {
    const btn = card.children.find((c) => c.tagName === 'BUTTON');
    if (btn) {
      btn.textContent = 'Ghép máy này';
      btn.onclick = () => startPairing(session.machine);
    }
  }
  return card;
}
```

và gọi nó trong `renderTerminalList`.

- [ ] **Step 4: Sửa `term/public/term.js` — `?ticket=` → `?token=`**

Đổi mọi chỗ dựng URL WebSocket:

```js
      url = wsUrl('token=' + encodeURIComponent(ticket));
```

và thông điệp 401:

```js
      // 401 giờ có nghĩa mới: không phải "vé đã dùng" mà "điện thoại này chưa
      // được ghép với máy này, hoặc đã bị gỡ". Nói đúng thứ đó, kèm đường ra.
      loi('Điện thoại này chưa được ghép với máy đó, hoặc đã bị gỡ. '
        + 'Quay lại danh sách và bấm "Ghép máy này".');
```

- [ ] **Step 5: Chạy toàn bộ suite, xác nhận xanh**

Run: `npm test`
Expected: TẤT CẢ xanh. Cửa sổ gãy đã đóng.

- [ ] **Step 6: Commit**

```bash
git add server/public/app.js term/public/term.js server/test/app-terminal.test.js
git commit -m "Sign the attach token on the phone; the hub is not asked anymore

Opening a terminal no longer involves the hub at all. The round trip that
used to fetch a ticket is gone, and with it the only reason the hub ever
held a signing key.

The PWA test verifies its own token with the exact function the daemon
uses, so any drift in signature encoding or in the signed string shows up
here rather than as a 401 on someone's phone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9b: Nói cho điện thoại biết nó chưa được ghép

> **Bổ sung sau review Task 9, Huy chốt 2026-07-29.** Task 9 đổi thông điệp 401 theo kế
> hoạch, nhưng reviewer lần theo mã và thấy **thông điệp đó không bao giờ hiện ra được**:
> `ticket` chỉ bị xoá trong `socket.onopen`, mà kết nối bị 401 thì `onopen` không bao giờ
> chạy — nên trang thử lại đúng token đã bị từ chối, vô hạn. Người dùng chưa ghép máy chỉ
> thấy "đang nối lại…" quay mãi.
>
> Trình duyệt KHÔNG phân biệt được 401 với rớt mạng trên WebSocket: cả hai đều ra `error`
> rồi `close` mã 1006. Nên không sửa được ở phía trang. Phải để daemon tự nói ra.

**Files:**
- Modify: `term/bin/ccrc-term.js`, `term/public/term.js`
- Test: `term/test/daemon.test.js`, `term/test/term-page.test.js`

**Interfaces:**
- Consumes: `verifyAttachToken` trả `reason: 'unknown_device'` (Task 3)
- Produces: `CLOSE_DEVICE_NOT_PAIRED = 4003` — hằng số này phải khai **giống hệt ở cả hai
  phía**, đúng như `CLOSE_SESSION_ENDED = 4001` đang làm (`ccrc-term.js:86`,
  `term.js:27`)

**Chỉ đúng `unknown_device`, không phải mọi lỗi 401.** `bad_signature` nghĩa là có kẻ đang
ký bậy — với nó thì im lặng từ chối bắt tay vẫn là đúng, không việc gì phải bắt tay rồi
mới nói. `malformed`, `wrong_session`, `expired` cũng giữ nguyên 401. Chỉ thiết bị chưa
ghép mới đáng được giải thích, vì đó là người dùng thật đang không hiểu chuyện gì.

- [ ] **Step 1: Viết test đỏ ở daemon**

Thêm vào `term/test/daemon.test.js`, dùng lại `dungCanh()` đã có:

```js
test('thiết bị CHƯA GHÉP: daemon bắt tay rồi đóng bằng mã 4003, không phải 401 câm', async () => {
  const la = await taoThietBiTest();
  const c = await dungCanh({ devices: [] }); // chưa ghép cái nào
  try {
    const token = await la.ky({ sessionId: 's-pair' });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'phải bắt tay được thì trình duyệt mới đọc được mã đóng');
    const ev = await waitClose(ws.ws);
    assert.equal(ev.code, 4003,
      'mã riêng là thứ DUY NHẤT phân biệt được "chưa ghép" với "rớt mạng" ở phía trình duyệt');
  } finally { await c.dong(); }
});

test('chữ ký SAI vẫn bị từ chối thẳng ở bắt tay, KHÔNG được giải thích gì', async () => {
  // Chữ ký sai nghĩa là có kẻ đang ký bậy. Không bắt tay với nó, và không nói
  // cho nó biết vì sao — khác hẳn một người dùng thật quên ghép máy.
  const phone = await taoThietBiTest();
  const c = await dungCanh({ devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }] });
  try {
    const token = await phone.ky({ sessionId: 's-pair' });
    const [v, b64, sig] = token.split('.');
    const buf = Buffer.from(sig, 'base64url');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const gia = `${v}.${b64}.${buf.toString('base64url')}`;
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(gia)}`);
    assert.equal(ws.ok, false, 'chữ ký sai không được bắt tay');
  } finally { await c.dong(); }
});
```

`waitClose(ws)` chưa có — thêm cạnh `connect()` trong cùng file:

```js
// Đợi sự kiện close và trả về nguyên sự kiện, để test đọc được `code`.
// connect() chỉ trả ok/không-ok nên không đủ cho mã đóng.
function waitClose(ws, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('hết giờ chờ close')), timeoutMs);
    ws.on('close', (code, reason) => { clearTimeout(t); res({ code, reason: String(reason) }); });
  });
}
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test term/test/daemon.test.js`
Expected: test 4003 FAIL — daemon còn trả 401 nên `connect()` cho `ok:false`

- [ ] **Step 3: Sửa `term/bin/ccrc-term.js`**

Cạnh `CLOSE_SESSION_ENDED`:

```js
// Thiết bị chưa được ghép với máy này.
//
// Vì sao phải bắt tay rồi mới đóng, thay vì từ chối bằng 401 như mọi lỗi
// khác: trình duyệt KHÔNG đọc được mã trạng thái HTTP của một cái bắt tay
// WebSocket bị từ chối — nó chỉ thấy `error` rồi `close` mã 1006, y hệt rớt
// mạng. Muốn nói được với người dùng "bạn chưa ghép máy này" thì phải nói
// SAU khi bắt tay xong, bằng một mã đóng của ứng dụng.
//
// CHỈ dùng cho `unknown_device`. `bad_signature` là có kẻ ký bậy — với nó,
// im lặng từ chối vẫn đúng: không bắt tay, và không giải thích gì.
const CLOSE_DEVICE_NOT_PAIRED = 4003;
```

Trong nhánh `if (!v.ok)` của handler `upgrade`:

```js
    if (!v.ok) {
      if (v.reason === 'unknown_device') {
        // Bắt tay đã, rồi đóng ngay bằng mã riêng — xem chú thích ở
        // CLOSE_DEVICE_NOT_PAIRED. Không attach vào pane, không mint khoá
        // phiên: kết nối này chỉ sống đủ lâu để mang một mã đóng đi.
        return wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.close(CLOSE_DEVICE_NOT_PAIRED, 'thiết bị chưa được ghép'); } catch { /* đã đóng */ }
        });
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
```

- [ ] **Step 4: Chạy, xác nhận xanh**

Run: `node --test term/test/daemon.test.js`

- [ ] **Step 5: Viết test đỏ ở trang, rồi sửa `term/public/term.js`**

Thêm vào `term/test/term-page.test.js` một test: đóng socket với mã 4003 thì trang hiện
thông điệp chưa-ghép và **không** thử nối lại. Rồi sửa `term.js` — khai hằng số cạnh
`CLOSE_SESSION_ENDED` và thêm nhánh trong `socket.onclose`, ngay cạnh nhánh 4001 sẵn có:

```js
      if (ev && ev.code === CLOSE_DEVICE_NOT_PAIRED) {
        // Nối lại mãi cũng vô ích: máy này chưa có khoá công khai của điện
        // thoại. Dừng hẳn và chỉ đúng việc cần làm.
        loi('Điện thoại này chưa được ghép với máy đó. Quay lại danh sách và bấm "Ghép máy này".');
        return;
      }
```

- [ ] **Step 6: Chạy toàn bộ suite và commit**

```bash
git add term/bin/ccrc-term.js term/public/term.js term/test/daemon.test.js term/test/term-page.test.js
git commit -m "Tell an unpaired phone why it cannot open, instead of retrying forever

A WebSocket handshake refused with 401 reaches the browser as close code
1006, which is what a dropped network looks like too. The page therefore
retried the same rejected token forever and the not-paired message added
in the previous task could never be reached.

So the daemon completes the handshake for an unknown device and closes
with 4003 instead — the same shape as the existing 4001 for a session
that ended. A bad signature still gets the silent 401: that is someone
signing with a key they do not have, not a person who forgot to pair.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Xoá đường vé cũ khỏi hub

**Files:**
- Modify: `server/src/index.js`, `server/src/terminal-sessions.js`, `server/test/terminal-api.test.js`
- Delete: `term/src/ticket-v1.js`
- Modify: `term/test/ticket-ttl-relation.test.js`

**Interfaces:**
- Consumes: không còn gì phụ thuộc `issueTicket` sau Task 9
- Produces: `POST /api/terminal/ticket` → **404**; `register` không còn nhận `secret`

- [ ] **Step 1: Viết test đỏ**

Thêm vào `server/test/terminal-api.test.js`:

```js
// --- Cắt dứt điểm: đường vé do hub ký không còn tồn tại -------------------
//
// Đây là test hồi quy cho một QUYẾT ĐỊNH, không phải cho một hàm. Nếu ai đó
// khôi phục route này "cho tương thích", lỗ hổng mà cả thiết kế ghép cặp
// sinh ra để vá sẽ mở lại nguyên vẹn.
test('POST /api/terminal/ticket không còn tồn tại — 404', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    assert.equal((await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: REG.sessionId })).status, 404);
  });
});

test('register vẫn nhận được khi KHÔNG có secret — daemon mới không gửi nữa', async () => {
  await withHub(async (h) => {
    const { secret, ...khongSecret } = REG;
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', khongSecret)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions.length, 1);
    void secret;
  });
});

test('hub KHÔNG trả secret ra ngoài kể cả khi daemon cũ còn gửi lên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', { ...REG, secret: 'bi-mat-cua-daemon-cu' });
    const body = await (await get(h, '/api/terminal', 'tok-huy')).text();
    assert.ok(!body.includes('bi-mat-cua-daemon-cu'));
  });
});
```

Xoá các test cũ khẳng định hành vi của `/api/terminal/ticket` (`vé cấp ra kiểm được…`, `mỗi vé có nonce khác nhau`, `xin vé cho sessionId không tồn tại…`, `KHÔNG xin được vé vào phiên của người khác`, và hai test `admin` liên quan tới vé). **Không xoá trắng** hai test `admin`: viết lại chúng dựa trên `/api/terminal` và `/api/pair/pending` — tính chất "user tên admin không mượn được danh tính chủ hub" vẫn phải được canh.

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `node --test server/test/terminal-api.test.js`
Expected: FAIL — route còn trả 200/404 sai

- [ ] **Step 3: Xoá khỏi `server/src/index.js`**

Xoá toàn bộ khối `app.post('/api/terminal/ticket', …)`.

Trong khối kiểm của `/api/terminal/register`, xoá hai dòng đòi `secret`:

```js
      // XOÁ: || typeof b.secret !== 'string' || !b.secret
```

- [ ] **Step 4: Xoá khỏi `server/src/terminal-sessions.js`**

Xoá `import { signTicket }`, xoá `import crypto`, xoá `TICKET_TTL_MS`, xoá toàn bộ `issueTicket`, và bỏ `secret` khỏi bản ghi phiên. Sửa khối chú thích đầu file:

```js
// Toàn bộ phần việc của hub với terminal: nhớ người dùng đang mở phiên nào.
// Byte không đi qua đây, và từ 2026-07-29 thì KHOÁ cũng không: điện thoại tự
// ký token mở phiên bằng khoá riêng của nó, máy dev xác minh bằng khoá công
// khai đã ghép. Hub không còn giữ gì mở được một phiên.
```

- [ ] **Step 5: Xoá `term/src/ticket-v1.js` và sửa test còn tham chiếu**

```bash
git rm term/src/ticket-v1.js
```

`term/test/ticket-ttl-relation.test.js` khẳng định quan hệ giữa `TICKET_TTL_MS` của hub và `DEFAULT_MAX_TICKET_LIFETIME_MS` của daemon. `TICKET_TTL_MS` không còn — nhưng **tính chất vẫn còn giá trị**, chỉ đổi chủ: giờ PWA là bên đúc token (60s, viết cứng trong `signAttachToken`). Viết lại test thành: hằng số 60s trong `app.js` phải nhỏ hơn `DEFAULT_MAX_TICKET_LIFETIME_MS`, đọc bằng regex trên nguồn `app.js` — cùng cách các test lint shell đang làm.

- [ ] **Step 6: Chạy toàn bộ suite và commit**

Run: `npm test`
Expected: tất cả xanh

```bash
git add -A
git commit -m "Delete the hub-signed ticket path

Nothing has used it since the phone started signing its own tokens.
Leaving it in place would leave the hole this whole design closes wide
open behind a route nobody calls.

The 404 has its own test. It guards a decision rather than a function: a
future \"restore it for compatibility\" would silently give the hub back
the ability to mint a shell credential for anyone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Tài liệu

**Files:**
- Modify: `deploy/commands/remote.md`, `docs/huong-dan.md`, `README.md`
- Test: `server/test/shell-scripts.test.js` (thêm một lint)

- [ ] **Step 1: Viết test đỏ — tài liệu phải nói đúng về thu hồi**

Thêm vào `server/test/shell-scripts.test.js`:

```js
// Tài liệu là một phần của cơ chế thu hồi, không phải phần trang trí quanh
// nó. Nếu nó để `unpair` và "gỡ khỏi Tailscale" ngang hàng nhau, người ta sẽ
// làm cái yếu (một máy) và bỏ cái mạnh (mọi máy cùng lúc).
test('hướng dẫn nói rõ gỡ khỏi Tailscale mới là công tắc ngắt thật', () => {
  const src = read('docs/huong-dan.md');
  assert.match(src, /ghép cặp|ghép máy/i, 'phải có phần nói về ghép cặp');
  assert.match(src, /Tailscale[^.]{0,80}(công tắc|ngắt|thu hồi)/i,
    'phải nói Tailscale là công tắc ngắt thật khi mất điện thoại');
  assert.match(src, /không sao lưu được|mất khoá|ghép lại/i,
    'phải cảnh báo trước rằng xoá dữ liệu trang là mất khoá và phải ghép lại');
});

test('hướng dẫn KHÔNG còn nói hub giữ khoá ký vé', () => {
  const src = read('docs/huong-dan.md');
  assert.ok(!/hub giữ\s*\n?\s*khoá ký vé/i.test(src),
    '§8 còn mô tả kiến trúc cũ — người đọc sẽ tin vào một mô hình đe doạ không còn đúng');
});
```

- [ ] **Step 2: Chạy, xác nhận đỏ**

Run: `node --test server/test/shell-scripts.test.js`
Expected: FAIL

- [ ] **Step 3: Viết lại `docs/huong-dan.md` §8**

Thay đoạn "Còn **người vận hành hub**…" bằng:

```markdown
### Người vận hành hub có xem được phiên của bạn không

Không — và từ 2026-07-29 thì đó là một sự thật kỹ thuật, không còn là một lời hứa.

Hub **không giữ khoá nào mở được phiên của bạn.** Điện thoại bạn tự ký yêu cầu mở terminal
bằng một khoá riêng nằm trong chính nó, và máy dev xác minh bằng khoá công khai nó học được
một lần duy nhất — lúc bạn ghép cặp và so số. Hub chỉ chuyển tiếp mấy chuỗi trong lúc ghép,
mà nếu nó tráo chuỗi nào thì hai màn hình sẽ hiện hai số khác nhau và bạn thấy ngay.

Cái hub còn biết: máy nào của bạn đang mở phiên nào, tên phiên bạn đặt, địa chỉ Tailscale,
và thời điểm mỗi lần Claude dừng chờ bạn.

Một điều còn lại phải nói thẳng: **hub là nơi phục vụ chính trang web này.** Ai chiếm được
hub thì đẩy được một bản mã độc xuống điện thoại bạn. Khoá riêng đặt ở chế độ không xuất
được nên bản độc đó cũng không bê khoá đi được — nó chỉ ký hộ được trong lúc trang đang mở,
và việc đó để lại dấu vết kiểm tra được. Đây là ranh giới của thiết kế, biết trước thì hơn.

### Ghép cặp điện thoại với một máy

Làm một lần cho mỗi máy. Không cần `/remote` đang bật.

1. Trên máy dev, trong Claude Code: `/remote pair`
2. Trên điện thoại: mở app, bấm **Ghép máy này**
3. Hai màn hình hiện **cùng một số 6 chữ số**. So bằng mắt.
4. Khớp → bấm **Khớp** trên điện thoại. Xong.

**Số lệch nghĩa là có người đứng giữa.** Bấm **Không khớp** và đừng thử lại cho tới khi hiểu
vì sao. Đây không phải thủ tục cho có — nó là toàn bộ thứ bảo vệ bạn khỏi chính cái hub.

### Mất điện thoại

**Gỡ nó khỏi Tailscale.** Đó là công tắc ngắt thật, và nó có hiệu lực trên mọi máy dev cùng
lúc: không còn trong tailnet thì khoá đã ghép cũng vô dụng, vì không chạm tới địa chỉ
`100.x.x.x` được nữa.

Sau đó dọn cho sạch: `/remote unpair <số>` trên từng máy (`/remote devices` để xem danh sách).

### Xoá dữ liệu trang là mất khoá

Khoá riêng cố tình **không sao lưu được** — đó là lý do mã độc cũng không bê nó đi được. Nên
xoá dữ liệu trang web, hay gỡ app khỏi màn hình chính rồi cài lại, là **mất khoá và phải
ghép lại từng máy**. Vài phút, nhưng biết trước thì đỡ hoảng.
```

Cập nhật bảng "Riêng tư — cái gì đi đâu" ở đầu §8: bỏ dòng ngụ ý hub cấp vé, thêm dòng ghi rõ hub không giữ khoá nào.

- [ ] **Step 4: Cập nhật `deploy/commands/remote.md`**

Sửa dòng `description` để nhắc ba lệnh mới:

```markdown
description: "Bật/tắt terminal từ xa, và ghép cặp điện thoại. `/remote on <tên>` đặt tên phiên; `/remote pair` ghép một điện thoại với máy này; `/remote devices` và `/remote unpair <số>` quản lý thiết bị đã ghép"
```

- [ ] **Step 5: Cập nhật `README.md`**

Sửa mọi chỗ mô tả hub ký vé HMAC. Thêm `~/.ccrc/devices.json` vào danh sách file hệ thống ghi.

- [ ] **Step 6: Chạy toàn bộ suite và commit**

Run: `npm test`

```bash
git add docs/huong-dan.md deploy/commands/remote.md README.md server/test/shell-scripts.test.js
git commit -m "Say what is now true: the hub holds no key that opens a session

The old guide was honest about the hub owner being able to sign a ticket
and about the tailnet being what stopped them. Neither sentence is true
anymore, and leaving them would have people reasoning from a threat model
that no longer applies.

It also has to state the cost up front: the key cannot be backed up, so
clearing site data means pairing every machine again. Finding that out by
accident is worse than reading it once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Chốt ảnh chụp đúng lúc, và trả quyền phủ quyết về máy dev

> **Bổ sung sau review toàn nhánh.** Sửa hai lỗ hổng Critical — xem
> `docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md` §12, đọc §12.1 và §12.2
> trước khi viết dòng nào. Đây là task quan trọng nhất của cả kế hoạch: nếu nó sai thì
> mười một task trước không mua được gì.

**Files:**
- Modify: `term/bin/ccrc-term-cli.js`
- Create: `term/src/pending-pair.js`
- Test: `term/test/remote-pair-cli.test.js`, `term/test/pending-pair.test.js` (mới)

**Interfaces:**
- Consumes: `randomNonce`, `commitMatches`, `shortAuthString` (Task 1); `addDevice` (Task 2)
- Produces `term/src/pending-pair.js`:
  - `pendingPairPath(home?): string` → `~/.ccrc/pairing-pending.json`
  - `writePending({pairId, pubKey, label, sas, expiresAt}, opts?): boolean`
  - `readPending(opts?): {pairId, pubKey, label, sas, expiresAt} | null` — trả `null` khi hết hạn, hỏng, hoặc không có
  - `clearPending(opts?): boolean`
  - Không hàm nào được ném. Ghi mode 600 qua temp-rename, đúng khuôn `term/src/devices.js`.

- [ ] **Step 1: Test đỏ — cam kết phải chốt TRƯỚC khi lộ nonceMachine**

Đây là test bắt C1. Nó phải **đỏ trên mã hiện tại**. Thêm vào `term/test/remote-pair-cli.test.js`:

```js
test('hub đổi commit SAU khi nhận nonceMachine → máy dev TỪ CHỐI, không ghi gì', async () => {
  // C1: cam kết chỉ có nghĩa nếu nó được chốt TRƯỚC khi máy công bố nonce của
  // mình. Hub giả ở đây làm đúng thứ một hub ác làm được: nó phục vụ một
  // commit ở /pending, rồi SAU KHI thấy nonceMachine mới bịa ra một cặp
  // (commit', noncePhone') khớp nhau và trả về ở bước 3.
  //
  // Nếu CLI chốt commit ở bước 3 (lỗi cũ), cặp bịa đó qua được commitMatches
  // và máy ghi khoá của hub. Nếu CLI chốt ở bước 1 (đúng), commit không khớp
  // và máy từ chối.
  const hub = await hubGia();
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce()); // commit thật ở /pending

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub.state.nonceMachine, 'CLI phải gửi nonce của máy trước');

  // Hub ác: giờ mới bịa cặp khớp nhau, và tráo cả khoá.
  const nonceBia = randomNonce();
  hub.state.commit = commitFor(nonceBia);
  hub.state.noncePhone = nonceBia;
  hub.state.pubKey = 'khoa-cua-hub-ac';
  hub.state.state = 'revealed';

  const { code, out } = await chay;
  hub.stop();

  assert.notEqual(code, 0, `phải từ chối; thấy:\n${out}`);
  assert.match(out, /đứng giữa|không khớp|✗/i);
  assert.deepEqual(listDevices({ home }), [],
    'ghi được khoá của hub vào devices.json là lỗ hổng còn nguyên');
});
```

- [ ] **Step 2: Chạy, xác nhận ĐỎ vì đúng lý do**

Run: `node --test term/test/remote-pair-cli.test.js`
Expected: FAIL — CLI hiện chốt commit ở bước 3 nên cặp bịa qua được, exit 0 và ghi khoá.
Nếu nó xanh ngay thì test chưa mô phỏng đúng cuộc tấn công — sửa test, đừng sửa mã.

- [ ] **Step 3: Sửa `cmdPair` — chốt ảnh chụp từ `/pending`**

Trong `term/bin/ccrc-term-cli.js`, ngay sau khi chọn được `pair` ở vòng 1:

```js
  // Ảnh chụp chốt Ở ĐÂY, từ phản hồi /pending — TRƯỚC khi gửi nonceMachine.
  //
  // Đây là toàn bộ chỗ dựa của lập luận an toàn (spec §5.2): hub phải nộp
  // `commit` trước khi biết `nonce_M`. Chốt ở bước 3 (sau challenge) là để
  // hub biết nonce trước rồi bịa cặp (commit, noncePhone) khớp nhau — lúc đó
  // commitMatches() luôn qua và chứng minh RỖNG. Xem spec §12.1.
  const snapshot = {
    pairId: pair.pairId, pubKey: pair.pubKey, commit: pair.commit, label: pair.label,
  };
```

Xoá dòng `const snapshot = { pubKey: st.pubKey, ... }` ở bước 3. Sau khi nhận `st`, thêm
kiểm tra tráo đổi:

```js
  // Bản ghi ở bước 3 phải khớp ảnh chụp. Lệch không phải chuyện đua tranh vô
  // hại — hub là bên duy nhất có thể làm nó lệch, và làm thế là tráo đổi.
  if (st.pubKey !== snapshot.pubKey || st.commit !== snapshot.commit) {
    say('✗ CẢNH BÁO: hub trả về khoá hoặc cam kết khác lúc đầu.');
    say('  Đây là dấu hiệu có người đứng giữa. KHÔNG ghép.');
    return 1;
  }
```

- [ ] **Step 4: Chạy, xác nhận xanh**

Run: `node --test term/test/remote-pair-cli.test.js`

Test `'pair: hub đổi pubKey ở vòng poll SAU khi SAS đã tính → vẫn ghi đúng khoá đã chốt lúc so số'`
sẽ ĐỎ — **đúng như phải thế**. Hub giả của nó phục vụ `${PUB}-${i}` ở `/pending` và `PUB`
ở bước 3, rồi khẳng định đĩa chứa `PUB`; tức nó khẳng định CLI lấy khoá từ bước 3. **Test
đó đang khoá chặt lỗ hổng.** Viết lại nó: hub giả giữ nguyên hành vi, nhưng khẳng định
mới là CLI **từ chối** (lệch giữa ảnh chụp và bước 3 là tín hiệu tráo đổi). Đổi cả tên
test cho khớp điều nó thật sự canh.

- [ ] **Step 5: Test đỏ cho `pending-pair.js`**

Tạo `term/test/pending-pair.test.js`: ghi/đọc vòng tròn; hết hạn trả `null`; file hỏng
trả `null` không ném; `clearPending` xoá; mode 600; mọi đầu vào dị dạng (`null`, non-object,
thiếu tham số) trả giá trị chứ không ném.

- [ ] **Step 6: Viết `term/src/pending-pair.js`**

Bám đúng khuôn `term/src/devices.js`: `readAll` bọc try/catch, ghi qua temp + rename, mode
600, không hàm nào ném. Thêm chú thích đầu file:

```js
// Cuộc ghép cặp đang dở, giữa `/remote pair` và `/remote pair xac-nhan <số>`.
//
// KHÔNG chứa bí mật: `sas` là con số đã hiện trên màn hình, `pubKey` là khoá
// công khai. Trộm được file này không ghép được gì — muốn ghép vẫn phải gõ
// đúng số mà chỉ điện thoại thật hiện ra. Đó là lý do nó được phép nằm trên
// đĩa, cùng lý do như devices.json.
```

- [ ] **Step 7: Test đỏ — hub chuyển hướng sang điện thoại khác**

Đây là test bắt C2:

```js
test('hub chuyển hướng sang điện thoại khác → gõ số của MÌNH vào thì máy từ chối', async () => {
  // C2: hub phục vụ yêu cầu của kẻ tấn công làm pending duy nhất và tự hoàn
  // tất handshake TRUNG THỰC — mọi chuỗi đều thật, commitMatches qua, SAS nội
  // bộ nhất quán. Trước đây CLI thấy state==='done' là ghi. Giờ nó chỉ ghi khi
  // người dùng gõ đúng số mà ĐIỆN THOẠI CỦA HỌ hiện ra.
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const nonceKeAc = randomNonce();
  hub.state.commit = commitFor(nonceKeAc);
  hub.state.pubKey = 'khoa-cua-ke-tan-cong';

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.state.noncePhone = nonceKeAc;
  hub.state.state = 'revealed';

  const { code, out } = await chay;
  assert.equal(code, 0, out);
  assert.deepEqual(listDevices({ home }), [],
    '`/remote pair` KHÔNG được ghi gì — nó chỉ in số rồi dừng');

  // Số điện thoại THẬT của người dùng hiện ra là số khác (tính trên khoá của
  // họ). Họ gõ số đó vào.
  const sasThat = shortAuthString({
    pubKey: 'khoa-that-cua-dien-thoai-nguoi-dung',
    noncePhone: nonceKeAc, nonceMachine: hub.state.nonceMachine,
  });
  const xn = await chayCLI(home, ['pair', 'xac-nhan', sasThat]);
  hub.stop();

  assert.notEqual(xn.code, 0);
  assert.match(xn.out, /không khớp|đứng giữa|✗/i);
  assert.deepEqual(listDevices({ home }), [],
    'gõ số không khớp mà vẫn ghi là lỗ hổng còn nguyên');
});

test('gõ đúng số → ghi devices.json, xoá file pending', async () => {
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const noncePhone = randomNonce();
  hub.state.commit = commitFor(noncePhone);

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.state.noncePhone = noncePhone;
  hub.state.state = 'revealed';
  const { out } = await chay;

  const sas = shortAuthString({ pubKey: PUB, noncePhone, nonceMachine: hub.state.nonceMachine });
  assert.ok(out.includes(sas), `phải in đúng số; thấy:\n${out}`);
  assert.equal(readPending({ home }).sas, sas, 'phải lưu lại để lệnh xác nhận dùng');

  const xn = await chayCLI(home, ['pair', 'xac-nhan', sas]);
  hub.stop();
  assert.equal(xn.code, 0, xn.out);
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB]);
  assert.equal(readPending({ home }), null, 'ghép xong phải xoá file pending');
});
```

- [ ] **Step 8: Sửa `cmdPair` để DỪNG, và thêm `cmdPairConfirm`**

`cmdPair` sau khi tính SAS: `writePending({...snapshot, sas, expiresAt: Date.now() + PAIR_TTL_MS})`,
in số kèm hướng dẫn, `return 0`. **Xoá hẳn vòng poll chờ `state === 'done'`** — máy không
còn hỏi hub xem người dùng đã đồng ý chưa.

```js
  say('');
  say(`  Máy này tính ra:  ${sas}`);
  say('');
  say('Nhìn số đang hiện TRÊN ĐIỆN THOẠI. Nếu đúng số này, gõ:');
  say(`  /remote pair xac-nhan ${'<số trên điện thoại>'}`);
  say('Lệch nhau nghĩa là CÓ NGƯỜI ĐỨNG GIỮA — đừng gõ, và đừng thử lại cho tới khi hiểu vì sao.');
```

`cmdPairConfirm(soNhap)`: đọc pending (hết hạn → báo làm lại), so **chuỗi số** với `sas`
đã lưu, khớp thì `addDevice` + `clearPending`, lệch thì cảnh báo và **không** xoá pending
(để người dùng gõ lại nếu lỡ tay). Nối vào dispatch: `pair xac-nhan <số>`.

- [ ] **Step 9: Chạy toàn bộ suite và commit**

Run: `npm test`. Mọi test cũ của `cmdPair` dựa vào `state === 'done'` phải được viết lại
theo nghi thức mới — không xoá, vì tính chất chúng canh vẫn sống.

```bash
git add term/src/pending-pair.js term/bin/ccrc-term-cli.js \
        term/test/pending-pair.test.js term/test/remote-pair-cli.test.js
git commit -m "Bind the commitment, and let the machine refuse

Two holes, both found only when the whole flow was read at once.

The commitment was pinned from the step-3 record, which arrives after the
machine has already published its nonce — so a hub could learn the nonce
first and then fabricate a matching (commit, noncePhone) pair. The check
passed by construction and proved nothing. It is pinned from the pending
response now, before the challenge goes out.

And the machine wrote devices.json purely because the hub said the human
had agreed — while the hub chose which phone was on the other end. It can
serve an attacker's request, complete the handshake honestly, and the
user's own phone, on a different pairId, never gets a say. So the verdict
moves to the machine: it prints its number and stops, and the user types
in the number their own phone shows.

A test asserted the first hole was correct behaviour. It now asserts the
mismatch is a tampering signal, which is what it always was.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Điện thoại thôi quyết định, tài liệu nói đúng

**Files:** `server/public/app.js`, `server/public/index.html`, `docs/huong-dan.md`,
`deploy/commands/remote.md`; test `server/test/app-pairing.test.js`, `server/test/shell-scripts.test.js`

- [ ] **Step 1:** Test đỏ — sau khi có SAS, PWA hiện số kèm câu "gõ số này vào máy dev",
  và **không** còn nút quyết định. Khẳng định `pair-match`/`pair-mismatch` không còn gọi
  `/api/pair/finish`.
- [ ] **Step 2:** Sửa `app.js` + `index.html`: bỏ hai nút, thay bằng dòng hướng dẫn.
  `finishPairing` không còn là đường quyết định; giữ một nút "Huỷ" gọi `finish(ok:false)`
  để dọn hàng đợi hub.
- [ ] **Step 3:** Sửa `docs/huong-dan.md` §8 — nghi thức mới (hai lệnh, gõ số), và **sửa
  câu sai**: "tráo chuỗi nào cũng làm hai màn hình lệch số" không còn đủ, vì hub *chuyển
  hướng* chứ không *tráo*. Nói đúng thứ bảo vệ người dùng: chính họ gõ số của điện thoại
  mình vào máy. Cập nhật `deploy/commands/remote.md` mô tả lệnh mới.
- [ ] **Step 4:** Thêm lint khẳng định tài liệu mô tả bước gõ số. Chạy suite, commit.

---

### Task 14: Ràng token vào đúng máy nó được trao cho

> Sửa lỗ hổng Critical thứ ba. **Đọc spec §13 trước.**

**Files:** `server/public/app.js`, `term/src/ticket.js`, `term/bin/ccrc-term.js`
**Test:** `term/test/ticket-interop.test.js`, `term/test/ticket.test.js`, `term/test/daemon.test.js`, `server/test/app-terminal.test.js`

**Interfaces:**
- `verifyAttachToken(token, {findDevice, sessionId, expectedHost, now})` — thêm **bắt buộc** `expectedHost`
- Payload thêm trường **bắt buộc** `h`. Thiếu `h` → `reason: 'malformed'`. `h` khác `expectedHost` → `reason: 'wrong_host'`.

- [ ] **Step 1: Test đỏ — token ký cho máy KHÁC bị từ chối**

Trong `term/test/ticket-interop.test.js`:

```js
test('token ký cho host KHÁC bị từ chối — hub lừa điện thoại trao token cho trang lạ', async () => {
  // C3 (spec §13): hub sửa mã server trả về một `url` trỏ tới địa chỉ tailnet
  // của kẻ tấn công nhưng GIỮ NGUYÊN sessionId thật. Điện thoại thấy địa chỉ
  // hợp lệ về hình dạng nên ký, rồi trao token cho trang của kẻ tấn công.
  // Trang đó chuyển tiếp tới daemon thật. Nếu token không mang theo đích của
  // nó thì daemon không có cách nào biết.
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone, { h: '100.86.66.66:9999' }));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }),
    sessionId: 's-abc',
    expectedHost: '100.86.1.2:8730',   // daemon thật
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_host',
    'token chuyển tiếp từ trang khác phải chết ở đây — đó là toàn bộ giá trị của trường h');
});

test('token ký cho đúng host được chấp nhận', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone, { h: '100.86.1.2:8730' }));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }),
    sessionId: 's-abc', expectedHost: '100.86.1.2:8730', now: 1_030_000,
  });
  assert.equal(r.ok, true, `bị từ chối vì "${r.reason}"`);
});
```

Và trong `term/test/ticket.test.js`, thêm `h` vào danh sách trường bắt buộc của test
`'payload thiếu trường bắt buộc là malformed'` — thiếu `h` phải là `malformed`, **không**
được bỏ qua.

- [ ] **Step 2: Chạy, xác nhận đỏ.** `expectedHost` chưa tồn tại.

- [ ] **Step 3: `term/src/ticket.js`**

Thêm vào khối kiểm trường bắt buộc:

```js
  if (typeof data.h !== 'string' || !data.h) return { ok: false, reason: 'malformed' };
```

Và sau khi chữ ký đã đúng, cạnh phép kiểm `sid`:

```js
  // Token phải nói rõ nó dành cho máy nào, và đây phải là máy đó.
  //
  // Không có phép kiểm này, một hub sửa mã server chỉ cần trả về một `url` trỏ
  // sang địa chỉ tailnet của nó mà giữ nguyên sessionId: điện thoại ký một
  // token hoàn toàn hợp lệ rồi trao cho trang của kẻ tấn công, trang đó chuyển
  // tiếp tới daemon thật và vào được. Xem spec §13.
  //
  // So host, không so cả URL: cổng do OS cấp và đổi mỗi lần /remote on, còn
  // đường dẫn không mang thông tin gì.
  if (data.h !== expectedHost) return { ok: false, reason: 'wrong_host' };
```

`expectedHost` là tham số **bắt buộc** của `verifyAttachToken`. Nếu người gọi quên truyền,
mọi token phải hỏng — không được mặc định hoá thành "bỏ qua". Đó đúng là loại mặc định
lặng lẽ đã tạo ra C1.

- [ ] **Step 4: `term/bin/ccrc-term.js`** — truyền host của chính nó

Daemon đã biết `hostIp` và `actualPort` lúc `listen` (xem chỗ dựng `publicUrl`). Giữ lại
thành một hằng số ở phạm vi module, rồi truyền vào:

```js
    const v = verifyAttachToken(token, {
      findDevice: (id) => findDevice(id),
      sessionId: SESSION_ID,
      expectedHost: ownHost,   // host chính daemon này quảng bá
    });
```

Lưu ý ca `CCRC_TERM_BIND` (test ghi đè, không qua Tailscale): ở đó `hostIp` là `null`. Dùng
`CCRC_TERM_URL` nếu có, nếu không thì lấy `${bindAddr}:${actualPort}`. Đừng để nhánh này
biến thành "không có host thì bỏ qua kiểm" — nó phải luôn có một giá trị để so.

- [ ] **Step 5: `server/public/app.js`** — ký kèm host

Trong `signAttachToken`, trước khi dựng payload:

```js
  // Host mà trang này SẮP đi tới, không phải host nào khác. Ràng nó vào chữ ký
  // là thứ làm cho một token bị lừa sang trang lạ trở nên vô dụng ở mọi daemon.
  const h = new URL(session.url).host;
```

thêm `h` vào payload. `isTailnetTerminalUrl(session.url)` đã chạy trước đó nên `new URL`
không ném.

- [ ] **Step 6: Test daemon thật** — dựng daemon, ký token với host sai, khẳng định 401
  (không phải 4003 — đây không phải chuyện chưa ghép). Rồi ký đúng host, khẳng định mở được.

- [ ] **Step 7: Chạy toàn bộ suite, commit.** Mọi test gọi `verifyAttachToken` phải truyền
  `expectedHost`; sửa hết, đừng để cái nào rơi vào nhánh mặc định.

```bash
git commit -m "Bind an attach token to the machine it is handed to

The signed payload said which session it was for but never which machine.
A hub running modified server code could return a url pointing at an
address it controls while keeping the real sessionId: the phone signs a
perfectly valid token and hands it to the attacker's page, which relays
it to the real daemon inside its sixty seconds.

That attack needs no modified app.js, so the argument that an active hub
attack leaves comparable evidence does not cover it.

The token now carries the host the phone is actually navigating to, and a
daemon accepts only its own. Host, not the whole URL: the port is
OS-assigned and changes every /remote on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Bốn chỗ còn lại của review cuối

- [ ] **1. Thông điệp lệch số đang chỉ đường phá phép kiểm.** `ccrc-term-cli.js:692` nói
  *"/remote pair vẫn còn dở để xem lại số của máy"*. Spec §12.3 cấm đúng điều đó: người
  dùng vừa được cảnh báo có kẻ đứng giữa, giờ được bảo rằng số của máy **xem lại được** —
  và cách duy nhất để làm theo là `cat ~/.ccrc/pairing-pending.json`, đọc SAS rồi gõ lại.
  Xoá mệnh đề đó. Nói đúng một điều: lệch số nghĩa là có người đứng giữa, làm lại từ đầu
  chỉ khi đã hiểu vì sao. Và **xoá file pending khi lệch** — sau khi phát hiện MITM thì
  không còn gì đáng giữ, mà giữ lại là để khoá của kẻ tấn công nằm cách đúng một lần gõ.

- [ ] **2. README mô tả nghi thức đã bị thay, và lint không soi README.**
  `README.md:138` vẫn nói "so một mã 6 chữ số **trên hai màn hình**". Viết lại theo nghi
  thức một chiều. Và mở rộng hai bài lint ở `server/test/shell-scripts.test.js` để chạy
  trên **cả** `README.md` — chúng chỉ đọc `docs/huong-dan.md`, nên câu này lọt.

- [ ] **3. Test tmux tạo phiên NGOÀI `try` — đây là cơ chế gây cạn pty.**
  `term/test/daemon.test.js` có 8 chỗ (`:504`, `:570`, `:1228`, `:1364`, `:1573`, `:1678`,
  `:1791` trong `dungCanh`, `:1936`) gọi `new-session -d` rồi mới vào `try`. Mọi thứ trong
  khoảng giữa đều ném được: vòng chờ fixture ném khi hết giờ, `waitPortListening` ném khi
  daemon không bind. Mỗi lần ném là rò vĩnh viễn một phiên tmux giữ một shell giữ một pty.
  Và nó **tự khuếch đại**: pty cạn dần thì daemon càng khó khởi động, càng ném, càng rò.
  Đó là lời giải đầy đủ cho 508 shell mồ côi đêm nay.
  `term/test/helpers.mjs` đã làm đúng — `startDaemon` bọc cả phần dựng trong try/catch và
  thu dọn khi lỗi. Sửa 8 chỗ kia theo khuôn đó, hoặc đăng ký `t.after(...)` ngay sau khi
  có tên phiên. Riêng `dungCanh:1818` giết `proc.pid` **rồi mới** `pgrep` con của nó —
  đúng cuộc đua mà `helpers.mjs` đã ghi rõ và sửa bằng `process.kill(-proc.pid)`; `proc`
  ở đây cũng `detached: true` nên dùng được kill theo nhóm.

- [ ] **4. `pairing-attack.test.js:78` flake ~1/1000 và thông điệp của nó đọc như lỗi bảo mật.**
  Ở `DIGITS = 3`, hai `pubKey` khác nhau trên cùng cặp nonce trùng SAS 0,085% (đo được 17
  lần trong 20.000). Khi nó nổ, thông điệp là *"hai màn hình phải hiện số khác nhau"* —
  đủ để người đọc đi truy một lỗ hổng không tồn tại. Test thứ ba này **không cần** rút số
  chữ số (chỉ hai test dò mới cần). Cho nó chạy ở `SAS_DIGITS` thật.

- [ ] **5. Mấy chỗ rẻ mà review cuối bảo làm luôn:**
  - Thêm test khẳng định `signAttachToken` sinh nonce khác nhau giữa các lần gọi — hiện
    không có gì canh, mà nó là thứ đỡ cho "token một lần".
  - `shortAuthString(null)` và `verifyAttachToken(token)` (thiếu tham số thứ hai) đều ném.
    Đây là **lần thứ năm** hình dạng `f({a} = {})` xuất hiện trong dự án này. Hai ký tự mỗi
    chỗ.
  - `server/src/users.js:13,19` vẫn mô tả khả năng đã bị gỡ như hiện hành ("mint a ticket",
    "HMAC signing secrets"). Chuyển sang thì quá khứ.
  - `docs/superpowers/specs/2026-07-27-web-terminal-design.md` §4.1/§4.3 vẫn khẳng định
    tính chất đã bị thay thế. Thêm một dòng "đã bị thay bởi 2026-07-29". Spec trôi chính
    là thứ đẻ ra C1.
  - `ccrc-term-cli.js:581` thoát vòng lặp ở `revealed | done | aborted` rồi chỉ kiểm
    `st.noncePhone` — nên `aborted` kèm nonce vẫn đi tiếp. Đổi thành kiểm
    `st.state === 'revealed'`, cùng lý do `reveal()` bên hub bắt buộc phải ở `challenged`.

---

## Nghiệm thu tay (sau Task 11)

Không test tự động nào thay được bước này — cả nghi thức so số tồn tại là để **một con người
nhìn hai màn hình**.

- [ ] Deploy hub: `./deploy.sh`
- [ ] Cài lại máy dev: `curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token> https://<hub-cua-ban>`
- [ ] Trên điện thoại: gỡ PWA, cài lại (để chắc chắn khoá sinh mới)
- [ ] `/remote pair` trên máy — điện thoại bấm "Ghép máy này"
- [ ] **So số: hai màn hình phải hiện đúng cùng một số 6 chữ số**
- [ ] Bấm Khớp → `/remote devices` thấy điện thoại
- [ ] `ccrc` → `/remote on thu-nghiem` → mở terminal từ điện thoại, gõ được
- [ ] `/remote unpair 1` → mở lại từ điện thoại phải **thất bại** với đúng thông điệp
- [ ] Ghép lại → mở được lần nữa
- [ ] Kiểm tra hub **không** còn `secret`: `curl -H "Authorization: Bearer <token>" https://ccrc.example.com/api/terminal` — không được có trường nào giống bí mật
