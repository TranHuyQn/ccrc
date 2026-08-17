// Mọi thứ server/src import PHẢI có mặt trong image hub.
//
// Bối cảnh (2026-08-17): thêm `import ... from '../../shared/protocol-version.js'`
// vào server/src/index.js. Toàn bộ 477+421+48 test đều xanh, vì test chạy từ
// cây nguồn nơi `shared/` nằm ngay đó. Nhưng Dockerfile.hub chỉ COPY `shared`
// vào `./bundle/shared` rồi `rm -rf bundle` sau khi nén gói cài — nên trong
// image không hề có `/app/shared/`. Hub deploy lên production và chết ngay ở
// dòng import đầu tiên, restart vô hạn, 502 từ internet.
//
// Bài học: cây nguồn KHÔNG phải hình dạng mà hub chạy thật. Test này đọc
// Dockerfile và kiểm đúng điều đó, không cần Docker.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCKERFILE = path.join(GOC, 'docker', 'Dockerfile.hub');

// Những đường dẫn được COPY vào /app và SỐNG SÓT tới lúc chạy. `./bundle/...`
// không tính: nó bị `rm -rf bundle` xoá ngay sau khi nén gói cài — đó chính là
// cái bẫy đã làm hub chết.
function duongDanConLai() {
  const noi = fs.readFileSync(DOCKERFILE, 'utf8');
  const ra = [];
  for (const dong of noi.split('\n')) {
    const m = dong.match(/^\s*COPY\s+(.+)$/);
    if (!m) continue;
    const phan = m[1].trim().split(/\s+/);
    const dich = phan[phan.length - 1];
    if (dich.startsWith('./bundle')) continue; // bị xoá trước khi container chạy
    for (const nguon of phan.slice(0, -1)) ra.push(nguon.replace(/^\.\//, ''));
  }
  return ra;
}

// Mọi import trong server/src trỏ RA NGOÀI server/ — tức thứ phải được COPY
// riêng, vì `COPY server/src` không kéo theo.
function importRaNgoai() {
  const thuMuc = path.join(GOC, 'server', 'src');
  const ra = [];
  for (const ten of fs.readdirSync(thuMuc)) {
    if (!ten.endsWith('.js')) continue;
    const noi = fs.readFileSync(path.join(thuMuc, ten), 'utf8');
    for (const m of noi.matchAll(/^\s*import\s[^'"]*['"](\.\.[^'"]+)['"]/gm)) {
      const tuyetDoi = path.resolve(thuMuc, m[1]);
      const tuongDoi = path.relative(GOC, tuyetDoi);
      if (tuongDoi.startsWith('server/')) continue; // đã nằm trong COPY server/src
      ra.push({ file: `server/src/${ten}`, can: tuongDoi });
    }
  }
  return ra;
}

test('mọi module server/src import từ ngoài server/ đều được COPY vào image', () => {
  const con = duongDanConLai();
  const thieu = importRaNgoai().filter(({ can }) =>
    // Đủ khi chính file đó, hoặc thư mục chứa nó, được COPY vào image.
    !con.some((c) => can === c || can.startsWith(c.replace(/\/$/, '') + '/')));

  assert.deepEqual(thieu, [],
    'thiếu trong image → hub chết ngay dòng import đầu tiên và restart vô hạn, '
    + 'trong khi mọi test chạy từ cây nguồn vẫn xanh');
});

test('Dockerfile vẫn xoá cây bundle sau khi nén — nếu bỏ, test trên mất ý nghĩa', () => {
  // Test trên chỉ đúng chừng nào `./bundle` thật sự biến mất. Ngày nào đó ai
  // bỏ `rm -rf bundle` đi thì phép loại trừ ở duongDanConLai() thành sai lệch
  // theo hướng nghiêm khắc thừa — thà biết ngay.
  const noi = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(noi, /rm -rf bundle/);
});
