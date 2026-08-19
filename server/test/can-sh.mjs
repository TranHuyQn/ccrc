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

const LY_DO = 'máy này không có môi trường shell POSIX (thiếu /bin/sh hoặc /dev/tty)';

// ĐO chứ không suy từ process.platform — nhưng phải đo ĐÚNG THỨ CẦN.
//
// Bản đầu chỉ hỏi "chạy được `sh` không", và nó SAI trên CI `windows-latest`:
// runner ấy có cả `sh` LẪN `dash` (Git for Windows ship kèm), nên rào không bắn,
// 5 bài chạy thật rồi đỏ. Thứ chúng thật sự cần không phải một binary mà là
// THIẾT BỊ TERMINAL của POSIX:
//
//   - `setup-notify.sh` / `remove-notify.sh` đọc câu hỏi từ `/dev/tty`, chứ
//     không từ stdin — vì dưới `curl | sh` thì stdin CHÍNH LÀ script.
//   - bài Ctrl-C dựng một pty thật bằng module `pty` của Python, để script đi
//     vào nhánh `[ -t 0 ] && [ -t 1 ]` thay vì rẽ sang run_plain.
//
// Windows không có `/dev/tty` và không có pty kiểu POSIX, nên một `sh.exe` chạy
// được vẫn không đủ. Hỏi cả hai.
function coSh() {
  // `/dev/tty` tồn tại kể cả khi tiến trình không có terminal điều khiển (lúc
  // ấy MỞ nó mới lỗi) — nhưng nó KHÔNG tồn tại trên Windows, và đó chính là
  // ranh giới cần phân biệt ở đây.
  if (!fs.existsSync('/dev/tty')) return false;
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
