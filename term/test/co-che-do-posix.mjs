// "Hệ thống file này có chế độ quyền kiểu POSIX không?"
//
// NTFS thì không. `fs.chmod` trên Windows không ném — nó chỉ bật/tắt được đúng
// bit chỉ-đọc — nên `statSync().mode & 0o777` trả về một con số vô nghĩa
// (thường `0o666`), và một bài khẳng định `0o600` sẽ đỏ ở chỗ chẳng có lỗi nào.
//
// Rào theo NĂNG LỰC chứ không theo nền tảng, cùng lý lẽ với `coTmux()`: câu
// hỏi thật là "chmod ở đây có nghĩa không", và một hệ thống file lạ trên Linux
// (một số mount FAT/exFAT, vài loại container) cũng trả lời "không".
//
// ĐO chứ không suy: tạo một file thật, chmod 600, rồi đọc lại. Suy từ
// process.platform là quay về đúng cái rào theo nền tảng mà chỗ này tránh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let daHoi = null;

export function coCheDoPosix() {
  if (daHoi !== null) return daHoi;
  let d;
  try {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-mode-'));
    const f = path.join(d, 'thu');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o600);
    daHoi = (fs.statSync(f).mode & 0o777) === 0o600;
  } catch {
    daHoi = false;
  } finally {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác tạm */ } }
  }
  return daHoi;
}

export const LY_DO_POSIX = 'hệ thống file này không có chế độ quyền POSIX';
