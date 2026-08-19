// `test` thay thế, tự skip cả file khi máy không chạy được `/bin/sh`.
//
// `shell-scripts.test.js` tồn tại để kiểm các script POSIX — cú pháp, shebang,
// hành vi dưới `set -u`. Trên máy không có `sh` thì không bài nào trong đó chạy
// có nghĩa được.
//
// VÌ SAO PHẢI RÀO CHỨ KHÔNG ĐỂ NÓ TỰ ĐỎ: đo trên Windows thật, file này không
// đỏ mà **TREO** — sau bài 61 nó đứng im, và `npm test` của cả workspace
// `server` treo quá 900 giây, để lại bốn tiến trình node mồ côi. Một bài đỏ thì
// người ta đọc log rồi sửa; một job CI treo tới hết giờ thì chỉ tốn tiền và
// chẳng nói gì. File này ĐÃ có `HAS_DASH` cho vài bài, nhưng vài bài khác gọi
// `execFileSync('sh', ...)` thẳng, không rào.
//
// Cùng hình dạng với term/test/can-tmux.mjs, và cùng lý do chọn nó: đổi đúng
// DÒNG IMPORT thì thân file test có sẵn không bị chạm một ký tự nào.
import { test as testGoc } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LY_DO = 'máy này không chạy được /bin/sh';

// ĐO chứ không suy từ process.platform: một máy Windows có Git for Windows vẫn
// có thể có `sh` trên PATH, và ở đó các bài này chạy được thật.
function coSh() {
  let d;
  try {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-sh-'));
    const f = path.join(d, 'thu.sh');
    fs.writeFileSync(f, 'echo SH-OK\n');
    return execFileSync('sh', [f], { encoding: 'utf8' }).trim() === 'SH-OK';
  } catch {
    return false;
  } finally {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác tạm */ } }
  }
}

export const chayDuocSh = coSh();

export function test(ten, ...conLai) {
  const fn = typeof conLai[conLai.length - 1] === 'function' ? conLai.pop() : undefined;
  const opts = typeof conLai[0] === 'object' && conLai[0] !== null ? conLai[0] : {};
  if (chayDuocSh) return testGoc(ten, opts, fn);
  return testGoc(ten, { ...opts, skip: opts.skip || LY_DO }, fn);
}

export default test;
