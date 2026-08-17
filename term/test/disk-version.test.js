// Đọc phiên bản hợp đồng ĐANG NẰM TRÊN ĐĨA, khác với hằng số đã nạp vào RAM.
//
// Cả ý nghĩa của module này nằm ở chỗ khác nhau đó: `PROTOCOL_VERSION` import
// vào là ảnh chụp lúc tiến trình khởi động và không bao giờ đổi nữa, còn đĩa
// thì có thể được cập nhật ngay dưới chân một daemon đang chạy. So hai số là
// cách duy nhất daemon tự biết mình đã lỗi thời.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phienBanTrenDia } from '../src/disk-version.js';
import { PROTOCOL_VERSION } from '../../shared/protocol-version.js';

test('đọc đúng số phiên bản trong cây nguồn thật', () => {
  assert.equal(phienBanTrenDia(), PROTOCOL_VERSION);
});

test('file đã bị cập nhật thành số khác thì đọc ra SỐ MỚI, không phải số đã nạp', () => {
  const goc = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ver-'));
  fs.mkdirSync(path.join(goc, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(goc, 'shared', 'protocol-version.js'),
    'export const PROTOCOL_VERSION = 42;\n');

  assert.equal(phienBanTrenDia(goc), 42);
  fs.rmSync(goc, { recursive: true, force: true });
});

test('không đọc được thì trả null, KHÔNG đoán bừa một con số', () => {
  // Đoán ở đây là tệ nhất: một con số bịa sẽ hoặc kết tội oan một daemon đang
  // chạy đúng, hoặc bỏ qua một daemon thật sự đã lỗi thời.
  assert.equal(phienBanTrenDia('/khong/co/thu/muc/nay'), null);
});

test('file có nội dung rác cũng trả null chứ không ném', () => {
  const goc = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ver-'));
  fs.mkdirSync(path.join(goc, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(goc, 'shared', 'protocol-version.js'), 'không phải javascript');

  assert.equal(phienBanTrenDia(goc), null);
  fs.rmSync(goc, { recursive: true, force: true });
});
