// Sổ những `ccrc-host` đang chạy: một file JSON cho mỗi host, dưới
// `<ccrcHome>/.ccrc/hosts/`.
//
// Vì sao có: trên macOS, `ccrc remote` tìm phiên bằng cách dò toàn bộ bảng tiến
// trình rồi lọc theo cây con và khớp tty — và cách đoán ấy đã sai hai lần, một
// lần bắt nhầm `claude` headless do plugin worker sinh ra. Trên Windows không
// phải đoán: host tự khai mình vào đây.
//
// Kỷ luật lấy nguyên từ shared/session-registry.js, không phát minh lại — hai
// sổ này giải cùng một bài toán và khác nhau ở chi tiết là cách chúng trôi xa
// nhau.
import fs from 'node:fs';
import path from 'node:path';
import { ccrcHome } from '../../shared/home.js';

export function hostsDir(home) {
  return path.join(home || ccrcHome(), '.ccrc', 'hosts');
}

// sessionId do code của dự án sinh ra, nhưng nó đi vào TÊN FILE — nên không
// được tin. Bất cứ thứ gì ngoài tập này đều có thể thoát khỏi thư mục.
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id)
    && id !== '.' && id !== '..';
}

const filePath = (dir, id) => path.join(dir, `${id}.json`);

// Phân biệt "không có tiến trình này" với "có nhưng không phải của mình":
// chỉ ESRCH mới là đã chết. EPERM nghĩa là tiến trình CÓ THẬT nhưng thuộc người
// dùng khác — vẫn đang sống.
function defaultIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Không hàm nào trong file này được ném. Một sổ hỏng không được phép làm chết
// thứ đang dùng nó — cùng lý do session-registry.js nói ở đầu file.
export function writeHost(entry, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!entry || !safeId(entry.sessionId)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      sessionId: entry.sessionId,
      pid: Number(entry.pid) || 0,
      pipe: typeof entry.pipe === 'string' ? entry.pipe : '',
      // Bí mật này là thứ canh cửa pipe. Quyền trên pipe do Node tạo KHÔNG đo
      // được (Get-Acl trả lỗi 231), nên không dựa vào nó — mà dựa vào việc thư
      // mục này được đặt ACL lúc cài.
      secret: typeof entry.secret === 'string' ? entry.secret : '',
      // cwd KHÔNG BAO GIỜ rời khỏi máy. Nó là khoá đối chiếu cục bộ, y như
      // trong session-registry — gửi đi là mở lại đúng lỗ rò riêng tư mà cái
      // sổ ấy sinh ra để bịt.
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      createdAt: Number(entry.createdAt) || Date.now(),
    });
    // Ghi file tạm rồi rename: người đọc không bao giờ thấy một file viết dở.
    const tmp = filePath(dir, entry.sessionId) + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, filePath(dir, entry.sessionId));
    return true;
  } catch {
    return false;
  }
}

export function readHost(sessionId, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!safeId(sessionId)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(filePath(dir, sessionId), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function removeHost(sessionId, opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  if (!safeId(sessionId)) return false;
  try {
    fs.unlinkSync(filePath(dir, sessionId));
    return true;
  } catch {
    return false;
  }
}

export function listHosts(opts = {}) {
  const dir = opts.dir || hostsDir(opts.home);
  const isAlive = opts.isAlive || ((pid) => defaultIsAlive(pid));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // đọc không được hoặc viết dở — bỏ qua, không bao giờ ném
    }
    if (!entry || typeof entry !== 'object') continue;
    // KHÔNG có pid nghĩa là không chứng minh được đã chết — giữ lại. Bỏ sót
    // một hồ sơ rác thì vô hại; dọn nhầm một phiên đang sống thì người dùng
    // mất việc, và dự án này đã trả giá cho hướng ngược lại hai lần.
    if (!entry.pid) { out.push(entry); continue; }
    // isAlive có thể là code của người gọi (trên Windows: gọi ra hệ điều
    // hành) — nó ném thì cũng là không chứng minh được đã chết, cùng luật với
    // "không có pid" ở trên. Để nó ném xuyên qua đây là phá lời hứa đầu file:
    // không hàm nào trong file này được ném.
    let song;
    try {
      song = isAlive(entry.pid, entry);
    } catch {
      out.push(entry);
      continue;
    }
    if (!song) {
      removeHost(entry.sessionId, { dir });
      continue;
    }
    out.push(entry);
  }
  return out;
}
