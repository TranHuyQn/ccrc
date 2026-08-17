// Dấu vân tay của bản cài: một chuỗi đổi khi và chỉ khi code đổi.
//
// Vì sao không hash thẳng file ccrc-bundle.tar.gz: `tar czf` trong
// docker/Dockerfile.hub không có --sort/--mtime và gzip nhúng thời gian nén,
// nên build lại đúng cùng một cây code vẫn ra file khác. Lấy nó làm mốc thì
// mỗi lần dựng lại image là một lần giục người dùng cài lại vì không có gì cả.
//
// Vì sao không dùng PROTOCOL_VERSION: số đó chỉ tăng khi HỢP ĐỒNG đổi, nên
// một bản chỉ sửa lỗi sẽ trôi qua không ai biết — đúng chỗ nó bỏ sót.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dauVanTay } from '../../shared/bundle-fingerprint.js';

// Dựng một bản cài giả có đúng hình dạng mà install.sh để lại.
function taoBanCai(noiDung) {
  const goc = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-vt-'));
  const ghi = (p, s) => {
    const day = path.join(goc, p);
    fs.mkdirSync(path.dirname(day), { recursive: true });
    fs.writeFileSync(day, s);
  };
  ghi('term/bin/ccrc-term.js', noiDung || 'daemon');
  ghi('term/public/term.js', 'trang');
  ghi('hook/bin/ccrc-notify.js', 'hook');
  ghi('shared/protocol-version.js', 'export const PROTOCOL_VERSION = 1;\n');
  ghi('deploy/commands/remote.md', 'lệnh');
  ghi('deploy/ccrc', 'wrapper');
  ghi('setup-notify.sh', 'setup');
  ghi('remove-notify.sh', 'remove');
  return goc;
}

test('cùng nội dung ở hai chỗ khác nhau cho cùng một dấu vân tay', () => {
  // Đây là tính chất khiến nó dùng được: hub tính trên cây của nó, máy dev
  // tính trên thư mục cài của mình, và hai bên phải ra cùng một chuỗi.
  const a = taoBanCai();
  const b = taoBanCai();
  try {
    assert.equal(dauVanTay(a), dauVanTay(b));
    assert.match(dauVanTay(a), /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('đổi một byte trong bất kỳ file nào cũng đổi dấu vân tay', () => {
  const a = taoBanCai('daemon');
  const b = taoBanCai('daemon ');
  try {
    assert.notEqual(dauVanTay(a), dauVanTay(b));
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('node_modules KHÔNG được tính', () => {
  // Máy dev có node_modules (install.sh chạy npm install), hub thì không
  // (.dockerignore bỏ nó). Tính vào là hai bên không bao giờ khớp, và lời
  // nhắc cài lại sẽ hiện vĩnh viễn.
  const goc = taoBanCai();
  try {
    const truoc = dauVanTay(goc);
    fs.mkdirSync(path.join(goc, 'term/node_modules/ws'), { recursive: true });
    fs.writeFileSync(path.join(goc, 'term/node_modules/ws/index.js'), 'thư viện');
    assert.equal(dauVanTay(goc), truoc);
  } finally { fs.rmSync(goc, { recursive: true, force: true }); }
});

test('package-lock.json do npm sinh ra KHÔNG được tính', () => {
  // Đo thật 2026-08-17: install.sh chạy `npm install --omit=dev` trong
  // $DEST/term, và npm ghi ra một package-lock.json mà gói cài không hề có.
  // Tính nó vào là máy vừa cài xong đã lệch dấu vân tay với hub ngay lập tức,
  // và lời nhắc "có bản mới" hiện vĩnh viễn — biến cơ chế cảnh báo thành cơ
  // chế làm phiền.
  const goc = taoBanCai();
  try {
    const truoc = dauVanTay(goc);
    fs.writeFileSync(path.join(goc, 'term/package-lock.json'), '{"lockfileVersion":3}');
    assert.equal(dauVanTay(goc), truoc);
  } finally { fs.rmSync(goc, { recursive: true, force: true }); }
});

test('thứ tự đọc thư mục không được ảnh hưởng kết quả', () => {
  const goc = taoBanCai();
  try {
    const truoc = dauVanTay(goc);
    // Ghi lại cùng nội dung theo thứ tự khác: nếu hàm phụ thuộc thứ tự
    // readdir trả về thì đây là chỗ nó lộ.
    const p = path.join(goc, 'term/public/term.js');
    const noi = fs.readFileSync(p);
    fs.unlinkSync(p);
    fs.writeFileSync(path.join(goc, 'term/public/zzz.js'), 'thêm');
    fs.writeFileSync(p, noi);
    fs.unlinkSync(path.join(goc, 'term/public/zzz.js'));
    assert.equal(dauVanTay(goc), truoc);
  } finally { fs.rmSync(goc, { recursive: true, force: true }); }
});

test('thiếu thư mục bắt buộc thì trả null, KHÔNG hash phần còn lại', () => {
  // Một bản cài dở dang (install.sh vừa `rm -rf` xong chưa kịp bung) không
  // được sinh ra một dấu vân tay trông hợp lệ — nó sẽ khác hub và giục người
  // dùng cài lại đúng lúc họ đang cài.
  const goc = taoBanCai();
  fs.rmSync(path.join(goc, 'term'), { recursive: true, force: true });
  try {
    assert.equal(dauVanTay(goc), null);
  } finally { fs.rmSync(goc, { recursive: true, force: true }); }
});

test('thư mục không tồn tại thì trả null chứ không ném', () => {
  assert.equal(dauVanTay('/khong/co/thu/muc/nay'), null);
});
