import test from 'node:test';
import { coCheDoPosix, LY_DO_POSIX } from './co-che-do-posix.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pendingPairPath, writePending, readPending, clearPending,
} from '../src/pending-pair.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-pending-'));

const banGhiHopLe = () => ({
  pairId: 'pair-1',
  pubKey: 'khoa-cong-khai-gia',
  label: 'iPhone · Safari',
  sas: '472915',
  expiresAt: Date.now() + 60_000,
});

test('ghi rồi đọc lại đúng những gì đã ghi', () => {
  const home = tmpHome();
  assert.equal(writePending(banGhiHopLe(), { home }), true);
  const doc = readPending({ home });
  assert.equal(doc.pairId, 'pair-1');
  assert.equal(doc.pubKey, 'khoa-cong-khai-gia');
  assert.equal(doc.label, 'iPhone · Safari');
  assert.equal(doc.sas, '472915');
  assert.equal(typeof doc.expiresAt, 'number');
});

test('chưa có file → readPending trả null, không ném', () => {
  assert.equal(readPending({ home: tmpHome() }), null);
});

test('đã hết hạn → readPending trả null', () => {
  const home = tmpHome();
  writePending({ ...banGhiHopLe(), expiresAt: Date.now() - 1000 }, { home });
  assert.equal(readPending({ home }), null);
});

test('file hỏng → readPending trả null, không ném', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(pendingPairPath(home), '{ khong phai json');
  assert.equal(readPending({ home }), null);
});

test('clearPending xoá file; đọc lại sau đó là null', () => {
  const home = tmpHome();
  writePending(banGhiHopLe(), { home });
  assert.equal(clearPending({ home }), true);
  assert.equal(readPending({ home }), null);
});

test('clearPending khi chưa có file cũng không ném, coi như đã xong', () => {
  const home = tmpHome();
  assert.equal(clearPending({ home }), true);
});

test('file ghi với quyền 600', { skip: coCheDoPosix() ? false : LY_DO_POSIX }, () => {
  const home = tmpHome();
  writePending(banGhiHopLe(), { home });
  assert.equal(fs.statSync(pendingPairPath(home)).mode & 0o777, 0o600);
});

test('thư mục .ccrc được tạo với quyền 700', { skip: coCheDoPosix() ? false : LY_DO_POSIX }, () => {
  const home = tmpHome();
  writePending(banGhiHopLe(), { home });
  assert.equal(fs.statSync(path.join(home, '.ccrc')).mode & 0o777, 0o700);
});

test('writePending từ chối bản ghi dị dạng, không ghi gì, không ném', () => {
  const home = tmpHome();
  for (const x of [null, undefined, {}, 42, '', { pairId: 'p' }]) {
    assert.equal(writePending(x, { home }), false, JSON.stringify(x));
  }
  assert.equal(readPending({ home }), null);
});

test('writePending/readPending/clearPending không ném khi opts hoàn toàn vắng mặt', () => {
  // Không truyền opts nghĩa là dùng nhà mặc định. Trỏ nhà mặc định ấy vào một
  // thư mục tạm cho riêng bài này, nhưng vẫn đi qua đúng nhánh "opts ===
  // undefined" của cả ba hàm.
  //
  // CCRC_HOME chứ KHÔNG phải HOME. Đặt HOME là vô tác dụng trên Windows —
  // os.homedir() ở đó đọc USERPROFILE — nên bài này từng cô lập trên giấy mà
  // không cô lập thật: đo được trên máy Windows với một USERPROFILE mồi, nó
  // tạo `.ccrc` trong hồ sơ và `writePending()` rồi `clearPending()` sẽ GHI RỒI
  // XOÁ đúng file `pairing-pending.json` thật của người dùng. Xem
  // shared/home.js và test/home-boundary.test.js.
  const cu = process.env.CCRC_HOME;
  const homeTam = tmpHome();
  process.env.CCRC_HOME = homeTam;
  try {
    assert.equal(typeof writePending(banGhiHopLe()), 'boolean');
    assert.doesNotThrow(() => readPending());
    assert.doesNotThrow(() => clearPending());
  } finally {
    if (cu === undefined) delete process.env.CCRC_HOME;
    else process.env.CCRC_HOME = cu;
  }
});

test('readPending(null), readPending(undefined), readPending({}) không ném', () => {
  assert.doesNotThrow(() => readPending(null));
  assert.doesNotThrow(() => readPending(undefined));
  assert.doesNotThrow(() => readPending({}));
  assert.equal(readPending(null), null);
  assert.equal(readPending(undefined), null);
  assert.equal(readPending({}), null);
});

test('clearPending(null), clearPending(undefined) không ném', () => {
  assert.doesNotThrow(() => clearPending(null));
  assert.doesNotThrow(() => clearPending(undefined));
  assert.equal(typeof clearPending(null), 'boolean');
});

test('pendingPairPath đầu vào dị dạng không ném', () => {
  for (const x of [42, {}, true, null, undefined]) {
    const p = pendingPairPath(x);
    assert.ok(typeof p === 'string' && p.includes('.ccrc'), JSON.stringify(x));
  }
});

test('entry thiếu sas hoặc pubKey hoặc expiresAt → readPending trả null', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(pendingPairPath(home), JSON.stringify({ pairId: 'p', label: 'x' }));
  assert.equal(readPending({ home }), null);
});

test('ghi qua temp-rename: không để sót file .tmp khi thành công', () => {
  const home = tmpHome();
  writePending(banGhiHopLe(), { home });
  const files = fs.readdirSync(path.join(home, '.ccrc'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
});

// Item 1, review toàn nhánh: `label` tới writePending() từ snapshot.label
// (bản chụp phản hồi /api/pair/pending của HUB) — cùng biên giới không tin
// như addDevice's, và pending-pair.json cũng nằm trên đường đi ra terminal
// ("gõ số này vào máy dev") trước cả khi tới addDevice.
test('writePending cắt nhãn dài và bỏ ký tự điều khiển, không ghi nguyên văn', () => {
  const home = tmpHome();
  const doc = `${'B'.repeat(500)}\x1b[2K\x07`;
  writePending({ ...banGhiHopLe(), label: doc }, { home });
  const { label } = readPending({ home });
  assert.equal(label.length, 64);
  assert.doesNotMatch(label, /[\x00-\x1f\x7f-\x9f]/);
});

test('writePending dọn sạch .tmp khi rename thất bại', () => {
  const home = tmpHome();
  const dir = path.join(home, '.ccrc');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(pendingPairPath(home)); // đường dẫn đích là một thư mục → rename lỗi EISDIR
  const r = writePending(banGhiHopLe(), { home });
  assert.equal(r, false);
  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'stray .tmp file not cleaned up');
});
