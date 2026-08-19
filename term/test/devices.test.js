import test from 'node:test';
import { coCheDoPosix, LY_DO_POSIX } from './co-che-do-posix.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_DEVICES, MAX_LABEL_LEN, devicesPath, deviceIdFor, listDevices, addDevice, removeDevice,
  findDevice, sanitizeLabel,
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

test('file ghi với quyền 600 — nó ở trong thư mục nhà người ta', { skip: coCheDoPosix() ? false : LY_DO_POSIX }, () => {
  const home = tmpHome();
  addDevice({ pubKey: PUB_A, label: 'A' }, { home });
  assert.equal(fs.statSync(devicesPath(home)).mode & 0o777, 0o600);
});

test('addDevice(null) không ném, trả ok:false', () => {
  const home = tmpHome();
  const r = addDevice(null, { home });
  assert.equal(r.ok, false);
  assert.equal(listDevices({ home }).length, 0);
});

test('addDevice(undefined) không ném, trả ok:false', () => {
  const home = tmpHome();
  const r = addDevice(undefined, { home });
  assert.equal(r.ok, false);
  assert.equal(listDevices({ home }).length, 0);
});

test('devicesPath(42) không ném', () => {
  const path1 = devicesPath(42);
  assert.ok(path1.includes('.ccrc'));
  assert.ok(typeof path1 === 'string');
});

test('devicesPath({}) không ném', () => {
  const path1 = devicesPath({});
  assert.ok(path1.includes('.ccrc'));
  assert.ok(typeof path1 === 'string');
});

test('devicesPath(true) không ném', () => {
  const path1 = devicesPath(true);
  assert.ok(path1.includes('.ccrc'));
  assert.ok(typeof path1 === 'string');
});

// Item 1, review toàn nhánh (spec §5.3 bổ sung): `label` là dữ liệu HUB —
// bên KHÔNG được tin — chảy tới cmdPairConfirm/cmdDevices rồi ra terminal
// của một agent Claude Code có quyền Bash (deploy/commands/remote.md).
// Trước bản vá này, addDevice chỉ kiểm `typeof label === 'string'`: đo được
// một label 200004 ký tự chứa ESC vẫn ghi lọt nguyên văn.
test('addDevice cắt nhãn dài quá MAX_LABEL_LEN, không ghi nguyên văn', () => {
  const home = tmpHome();
  const dai = 'A'.repeat(500);
  addDevice({ pubKey: PUB_A, label: dai }, { home });
  const list = listDevices({ home });
  assert.equal(list[0].label.length, MAX_LABEL_LEN);
  assert.equal(list[0].label, 'A'.repeat(MAX_LABEL_LEN));
});

test('addDevice bỏ ký tự điều khiển C0/C1 khỏi nhãn (chặn tiêm escape terminal)', () => {
  const home = tmpHome();
  // \x1b[2K\x1b[1G che một dòng bằng line-overwrite; \x07 là BEL; \x9b là
  // một C1 viết dạng UTF-8 hai byte (0xC2 0x9B khi mã hoá). Bỏ đúng BYTE điều
  // khiển (ESC, BEL, C1) là đủ để vô hiệu hoá chuỗi escape — phần ký tự in
  // được còn lại ("[2K[1G") không còn dẫn đầu bằng ESC thì chỉ còn là văn
  // bản trơ, không phải một chuỗi escape nữa.
  const doc = 'iPhone\x1b[2K\x1b[1G\x07 · Safari\x9b';
  addDevice({ pubKey: PUB_A, label: doc }, { home });
  const { label } = listDevices({ home })[0];
  assert.equal(label, 'iPhone[2K[1G · Safari');
  assert.doesNotMatch(label, /[\x00-\x1f\x7f-\x9f]/, 'không còn byte điều khiển thô nào trong nhãn đã lưu');
});

test('sanitizeLabel: không phải chuỗi → chuỗi rỗng, không ném', () => {
  for (const x of [null, undefined, 42, {}, []]) {
    assert.equal(sanitizeLabel(x), '', JSON.stringify(x));
  }
});

test('sanitizeLabel: giữ nguyên nhãn lành, kể cả ký tự nhiều byte', () => {
  assert.equal(sanitizeLabel('iPhone · Safari'), 'iPhone · Safari');
});

test('writeAll dọn sạch .tmp file khi rename thất bại', () => {
  const home = tmpHome();
  const devDir = path.join(home, '.ccrc');
  fs.mkdirSync(devDir, { recursive: true });
  // Tạo file cùng tên với path mục tiêu để gây ra EISDIR khi rename
  fs.mkdirSync(path.join(devDir, 'devices.json'));

  const r = addDevice({ pubKey: PUB_A, label: 'A' }, { home });
  // addDevice thất bại vì không thể rename .tmp sang .json
  assert.equal(r.ok, false);
  // .tmp file phải được dọn sạch
  const files = fs.readdirSync(devDir);
  assert.ok(!files.some(f => f.endsWith('.tmp')), 'stray .tmp file not cleaned up');
});
