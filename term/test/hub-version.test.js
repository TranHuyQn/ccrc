// Đọc phiên bản hợp đồng mà HUB khai, từ thân trả lời của nhịp heartbeat.
//
// Ba nguồn phiên bản trong hệ này, đừng lẫn: code daemon đang chạy trong RAM,
// code đang nằm trên đĩa của máy đó, và gói cài hub đang phục vụ. Cái thứ ba
// là thứ trả lời câu "có nên chạy lại install.sh không".
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { docPhienBanHub, docDauVanTayHub } from '../src/hub-version.js';

test('đọc được số hub khai', () => {
  assert.equal(docPhienBanHub({ ok: true, protocolVersion: 7 }), 7);
});

test('hub CŨ không khai gì thì trả null, không phải 0', () => {
  // Một hub chưa cập nhật không khai trường này. Trả 0 ở đây sẽ thành "hub cũ
  // hơn mọi thứ" và trang sẽ giục người dùng cài lại vì một chuyện không có
  // thật — tức là biến cơ chế cảnh báo thành cơ chế làm phiền.
  assert.equal(docPhienBanHub({ ok: true }), null);
});

test('thân trả lời hỏng hay không phải số thì trả null', () => {
  for (const xau of [null, undefined, 'chuỗi', 42, { protocolVersion: 'hai' },
                     { protocolVersion: 1.5 }, { protocolVersion: -1 }]) {
    assert.equal(docPhienBanHub(xau), null, `phải từ chối: ${JSON.stringify(xau)}`);
  }
});

// --- dấu vân tay gói cài hub đang phục vụ ---------------------------------

test('đọc được dấu vân tay hub khai', () => {
  const vt = 'a'.repeat(64);
  assert.equal(docDauVanTayHub({ ok: true, bundleFingerprint: vt }), vt);
});

test('hub cũ không khai dấu vân tay thì trả null', () => {
  assert.equal(docDauVanTayHub({ ok: true, protocolVersion: 1 }), null);
});

test('thứ không phải sha256 hex đều bị từ chối', () => {
  for (const xau of [null, 'ngắn quá', 'A'.repeat(64), 'g'.repeat(64), 123,
                     { bundleFingerprint: 42 }]) {
    assert.equal(docDauVanTayHub(typeof xau === 'object' && xau ? xau : { bundleFingerprint: xau }),
      null, `phải từ chối: ${JSON.stringify(xau)}`);
  }
});
