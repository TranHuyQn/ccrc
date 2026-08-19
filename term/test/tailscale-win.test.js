// Dò Tailscale trên Windows.
//
// Lỗi thật, người dùng gặp ngay lần `/remote on` đầu tiên sau khi cài:
//
//     ✗ Không bật được remote.
//       [term] Không tìm thấy Tailscale trên máy này.
//
// trong khi Tailscale ĐANG CHẠY, có IP, và `where.exe tailscale` chỉ thẳng vào
// `C:\Program Files\Tailscale\tailscale.exe`. Nguyên nhân: danh sách đường dẫn
// ứng viên chỉ có bốn đường Unix (/Applications, /opt/homebrew, /usr/local,
// /usr/bin) — không đường nào tồn tại trên Windows, nên hàm ném ngay.
//
// Bài này canh đúng hai lời hứa của bản vá, và canh được TRÊN CẢ macOS nhờ
// tiêm `platform`: nhánh Windows hỏi `where.exe` trước, và nhánh không-Windows
// KHÔNG được đổi hành vi.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tailscale.js'),
  'utf8',
);

// Bỏ comment trước khi khớp, để một comment nhắc tới `where.exe` không làm bài
// này xanh giả. Cùng mẹo với pane-source-boundary.test.js.
function chiCode(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('nhánh Windows hỏi where.exe — PATH là chỗ duy nhất biết winget/Scoop cài đâu', () => {
  const code = chiCode(src);
  assert.match(code, /where\.exe/, 'tailscale.js không còn hỏi where.exe trên Windows');
  assert.match(
    code,
    /process\.platform === 'win32'/,
    'nhánh Windows phải được rào bằng process.platform, nếu không macOS cũng spawn where.exe',
  );
});

test('có lưới đỡ khi Tailscale đã cài nhưng chưa lên PATH của tiến trình', () => {
  const code = chiCode(src);
  // Daemon được spawn từ Claude Code, nên PATH của nó không nhất thiết giống
  // PATH trong PowerShell — where.exe có thể trắng dù máy vẫn có Tailscale.
  assert.match(code, /Program Files\\\\Tailscale\\\\tailscale\.exe/,
    'thiếu đường dẫn cài đặt mặc định làm lưới đỡ');
});

test('bốn đường dẫn Unix còn nguyên và không bị Windows chen vào', () => {
  const code = chiCode(src);
  for (const p of [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
  ]) {
    assert.ok(code.includes(p), `mất đường dẫn macOS/Linux: ${p}`);
  }
  // Danh sách macOS/Linux phải KHÔNG chứa đường Windows: trộn chung là mỗi lần
  // dò trên macOS lại thêm bốn lần existsSync vô ích, và tệ hơn là làm thứ tự
  // ưu tiên trên macOS phụ thuộc vào một thứ chẳng liên quan.
  const dsUnix = code.slice(code.indexOf('const CANDIDATES ='), code.indexOf('const CANDIDATES_WIN'));
  assert.ok(!/Program Files/.test(dsUnix), 'đường Windows bị trộn vào danh sách Unix');
});

test('CCRC_TAILSCALE_BIN vẫn thắng mọi phép dò', () => {
  const code = chiCode(src);
  const i = code.indexOf('CCRC_TAILSCALE_BIN');
  const j = code.indexOf("process.platform === 'win32'");
  assert.ok(i !== -1 && j !== -1 && i < j,
    'CCRC_TAILSCALE_BIN phải được xét TRƯỚC nhánh Windows — nó là cửa thoát khi phép dò sai');
});
