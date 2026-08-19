// "Máy này chạy được một script `#!/bin/sh` như một chương trình không?"
//
// Nhiều bài test dựng binary giả bằng cách ghi một file `#!/bin/sh` rồi
// `chmod 755`. Trên Windows cả hai nửa đều vô nghĩa: không có shebang, không có
// bit thực thi, và `execFileSync` trên một file không đuôi sẽ thất bại. 13 bài
// trong tailscale.test.js đỏ vì đúng chuyện đó — logic đang được kiểm thì không
// phụ thuộc nền tảng, chỉ có CÁCH DỰNG ĐỒ GIẢ là phụ thuộc.
//
// Rào theo năng lực, không theo nền tảng — cùng lý lẽ với `coTmux()` và
// `coCheDoPosix()`. Và ĐO chứ không suy: dựng một script thật rồi chạy nó.
//
// GHI CHÚ CHO NGƯỜI SAU: rào là giải pháp tối thiểu, không phải giải pháp tốt
// nhất. Tốt hơn là dựng đồ giả bằng `.cmd` khi ở trên Windows, để `checkPrereqs`
// được kiểm trên chính nền tảng có nhánh dò Tailscale riêng. Chưa làm vì nó là
// viết lại fixture của một file test có sẵn, và việc đó xứng đáng một lượt soát
// riêng chứ không nên đi kèm một bản vá về CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let daHoi = null;

export function coShebang() {
  if (daHoi !== null) return daHoi;
  let d;
  try {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-sheb-'));
    const bin = path.join(d, 'thu');
    fs.writeFileSync(bin, '#!/bin/sh\necho SHEBANG-OK\n', { mode: 0o755 });
    daHoi = execFileSync(bin, [], { encoding: 'utf8' }).trim() === 'SHEBANG-OK';
  } catch {
    daHoi = false;
  } finally {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác tạm */ } }
  }
  return daHoi;
}

export const LY_DO_SHEBANG = 'máy này không chạy được script #!/bin/sh làm chương trình';
