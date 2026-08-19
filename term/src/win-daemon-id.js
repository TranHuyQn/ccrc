// "Cái pid trong file này có đúng là daemon của ta không?" — bản dành cho
// Windows.
//
// Trên macOS/Linux câu hỏi ấy được trả lời bằng `ps -o command=` và `lsof`
// (xem ccrc-term-cli.js). Windows không có cả hai. Thứ tương đương là
// `Win32_Process`: nó khai `CommandLine` (dòng lệnh NGUYÊN VĂN, chưa tách) và
// `ExecutablePath` (ảnh thật sự đang chạy).
//
// Vì sao phải hỏi, thay vì tin con số: pid được dùng lại. Một file pid cũ trỏ
// vào một pid mà hệ điều hành đã cấp cho ai khác, rồi `/remote off` giết nhầm
// — trên Windows `process.kill` LUÔN là `TerminateProcess`, tức là giết thẳng,
// không có cửa cho nạn nhân dọn dẹp. Dự án này đã trả giá cho hướng ấy hai lần
// trên macOS; đừng mở lại nó ở đây.
//
// Cả file không gọi ra ngoài, không đọc đĩa, không đụng `process.platform`:
// người gọi đưa vào ba chuỗi, nó trả `true`/`false`. Nhờ vậy toàn bộ luật
// nhận diện chạy được — và SAI được — trên máy macOS của bộ test, chứ không
// chỉ trên đúng cái máy Windows duy nhất.
import path from 'node:path';

// Giống hệt tập trong ccrc-term-cli.js, và vì cùng một lý do: `node -e <code>
// <đường dẫn daemon>` KHÔNG chạy daemon — đường dẫn ấy chỉ là một tham số thừa
// nằm trong argv. So sánh theo TÊN cờ, sau khi đã cắt ở dấu `=` đầu tiên, vì
// node nhận cả `--eval=<code>` lẫn `--eval <code>`.
const CO_CHAY_INLINE = new Set(['-e', '--eval', '-p', '--print']);

// Tách một dòng lệnh Windows thành argv theo luật CommandLineToArgvW — luật mà
// CreateProcess dùng, và cũng là luật mà `quoteArg` trong src/win-launch.js
// escape theo. KHÔNG phải luật của cmd.exe.
//
// Hai luật khác nhau trong cùng một chuỗi:
//  • argv[0] (đường dẫn chương trình): backslash KHÔNG escape gì cả. Mở đầu
//    bằng `"` thì kết thúc ở `"` kế tiếp; ngược lại kết thúc ở khoảng trắng
//    đầu tiên. Đây là chỗ dễ sai nhất, vì đường dẫn Windows đầy backslash:
//    `"C:\Program Files\nodejs\node.exe"` mà đem luật của argv[1..] ra tách
//    thì cặp `\\` sẽ bị nuốt mất một nửa.
//  • argv[1..]: 2n backslash + `"` → n backslash rồi bật/tắt chế độ nháy;
//    2n+1 backslash + `"` → n backslash rồi một dấu `"` NGUYÊN VĂN; backslash
//    không đứng trước `"` thì là chính nó.
//
// Giới hạn đã biết: không xử lý ca `""` bên trong nháy (nghĩa là một dấu nháy
// nguyên văn) của CommandLineToArgvW đời mới. Đường dẫn daemon của ta không
// bao giờ chứa dấu nháy, và mọi sai lệch ở ca ấy đều rơi về "không phải của
// ta" — một lời từ chối, không phải một cú giết nhầm.
export function tachArgvWindows(commandLine) {
  const s = typeof commandLine === 'string' ? commandLine : '';
  const argv = [];
  let i = 0;

  while (i < s.length && /\s/.test(s[i])) i += 1;
  if (i < s.length) {
    let a = '';
    if (s[i] === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') { a += s[i]; i += 1; }
      if (i < s.length) i += 1; // nuốt dấu " đóng
    } else {
      while (i < s.length && !/\s/.test(s[i])) { a += s[i]; i += 1; }
    }
    argv.push(a);
  }

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    let a = '';
    let trongNhay = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (i < s.length && s[i] === '\\') { n += 1; i += 1; }
        if (i < s.length && s[i] === '"') {
          a += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) { a += '"'; } else { trongNhay = !trongNhay; }
          i += 1;
        } else {
          a += '\\'.repeat(n);
        }
        continue;
      }
      if (c === '"') { trongNhay = !trongNhay; i += 1; continue; }
      if (!trongNhay && /\s/.test(c)) break;
      a += c;
      i += 1;
    }
    argv.push(a);
  }
  return argv;
}

// Ảnh đang chạy có phải node không. Cùng ý với `isNodeBinary` bên
// ccrc-term-cli.js — so theo TÊN FILE, chấp nhận `node`, `nodejs`, `node22` —
// chỉ thêm việc cắt đuôi `.exe` và không phân biệt hoa thường, vì đó là cách
// Windows viết tên chương trình. Không nhận một cái tên tuỳ ý: từ chối nhầm
// tốn của người dùng một daemon phải tắt bằng tay, nhận nhầm tốn của một tiến
// trình vô can cả mạng sống.
export function laNodeWindows(exe) {
  const ten = path.win32.basename(String(exe || '')).toLowerCase().replace(/\.exe$/, '');
  return /^node(js)?[0-9.]*$/.test(ten);
}

function chuanHoa(p) {
  return path.win32.normalize(String(p)).replace(/\\+$/, '').toLowerCase();
}

/**
 * `true` khi dòng lệnh này là "node đang chạy ĐÚNG file daemon của ta".
 *
 * Mô phỏng việc node đọc argv của chính nó, y như vòng 4 bên macOS:
 *  1. ảnh phải là node (`ExecutablePath` nếu WMI khai, không thì argv[0]);
 *  2. đi lần lượt qua argv[1..]; thứ bắt đầu bằng `-` là cờ của node, gặp cờ
 *     chạy-inline là dừng ở "không phải của ta";
 *  3. tham số KHÔNG-phải-cờ đầu tiên chính là script node được bảo chạy —
 *     câu trả lời chốt tại đó, vì mọi thứ sau nó là argv của SCRIPT chứ không
 *     của node, và chẳng chứng minh được gì.
 *
 * Khác macOS đúng một điểm: một đường dẫn TƯƠNG ĐỐI bị từ chối thẳng. Muốn
 * phân giải nó cho đúng thì phải biết thư mục làm việc của tiến trình kia, và
 * trên Windows không có `lsof -d cwd` để hỏi. `cmdOn` luôn spawn daemon bằng
 * đường dẫn tuyệt đối, nên ca này không tồn tại trong thực tế; nếu có thì nó
 * rơi về phía từ chối, không phải phía giết nhầm.
 */
export function laDaemonWindows({ executablePath, commandLine, daemonPath } = {}) {
  if (typeof daemonPath !== 'string' || daemonPath === '') return false;
  const argv = tachArgvWindows(commandLine);
  if (argv.length < 2) return false; // chưa chạy gì, hoặc không có gì để so
  const anh = typeof executablePath === 'string' && executablePath !== '' ? executablePath : argv[0];
  if (!laNodeWindows(anh)) return false;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const ten = eq === -1 ? arg : arg.slice(0, eq);
      if (CO_CHAY_INLINE.has(ten)) return false;
      continue;
    }
    if (!path.win32.isAbsolute(arg)) return false;
    return chuanHoa(arg) === chuanHoa(daemonPath);
  }
  return false;
}
