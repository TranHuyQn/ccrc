// Sổ những thiết bị đã ghép với máy này: `~/.ccrc/devices.json`.
//
// Chỉ chứa khoá CÔNG KHAI. Trộm được file này không mở được gì — đó là điểm
// khác biệt cốt lõi so với `term-secret` ngày xưa, và là lý do nó được phép
// nằm trên đĩa trong khi bí mật ký vé thì không.
//
// Nằm NGOÀI daemon: một thiết bị đã ghép phải sống qua mọi `/remote on/off`
// và mọi lần khởi động lại máy. Daemon chỉ đọc, `/remote pair` mới ghi.
//
// Không hàm nào ở đây được ném. File này nằm trên đường đi của mọi kết nối
// tới daemon; một file hỏng phải nghĩa là "chưa ghép thiết bị nào" (mọi kết
// nối 401), không phải một daemon chết. Cùng kỷ luật với src/static.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ccrcHome } from '../../shared/home.js';

// Không phải vì ai cần 20, mà để một file bị nhét phình không làm daemon ì
// trên đường đi của mọi kết nối.
export const MAX_DEVICES = 20;

// `label` tới đây từ HUB (spec §5.3: hub dẫn xuất nó từ User-Agent của
// request /api/pair/start) — và hub là bên KHÔNG được tin (xem đầu file
// this project). Spec §5.3 chỉ phân tích label như một đầu vào XÁC THỰC
// ("nhãn sai gây nhầm lẫn, không mở được cửa nào"); nó chưa từng được phân
// tích như NỘI DUNG hiển thị trên máy dev — mà nó chính là thế:
// `cmdPairConfirm`/`cmdDevices` (ccrc-term-cli.js) in nó thẳng ra terminal,
// và `deploy/commands/remote.md` chạy CLI này qua một agent Claude Code CÓ
// quyền Bash rồi bảo agent đó THUẬT LẠI đầu ra — một label dài/chứa ký tự
// điều khiển là bên KHÔNG được tin ghi thẳng vào luồng ngữ cảnh của bên
// ĐƯỢC tin. Cắt tại đây, biên giới tin cậy, để mọi thứ ghi vào sau này
// (không chỉ addDevice) cũng được che: cap chiều dài (64 dư sức cho
// "iPhone · Safari") và bỏ mọi ký tự điều khiển C0/C1 (có thể che một dòng
// "✗" bằng line-overwrite, hoặc mang OSC 52 — ghi vào clipboard — mà tmux
// vẫn tuân theo). Vẫn là một chuỗi thường: không phát minh lược đồ escape
// nào.
export const MAX_LABEL_LEN = 64;
export function sanitizeLabel(label) {
  if (typeof label !== 'string') return '';
  let out = '';
  for (const ch of label) {
    const cp = ch.codePointAt(0);
    // C0 (0-0x1f), DEL (0x7f), C1 (0x80-0x9f). Iterate CODE POINTS, not
    // UTF-16 code units, so a multi-byte character (the middle dot in
    // "iPhone · Safari", an emoji) never gets split by this loop.
    if ((cp >= 0 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += ch;
    if (out.length >= MAX_LABEL_LEN) break;
  }
  return out;
}

// Mặc định là `ccrcHome()`, KHÔNG phải `os.homedir()`. Cùng một lỗi đã xảy ra
// ba lần trong dự án này, và luôn ở đúng chỗ này: một người gọi quên truyền
// `home`, tưởng mình đang trong hộp cát, và ghi thẳng vào hồ sơ thật của người
// dùng. Đặt mặc định ở đây thì cái bẫy không còn nằm lại cho người gọi sau.
// `ccrcHome()` trả đúng `os.homedir()` khi CCRC_HOME không đặt, nên
// macOS/Linux không đổi gì (có bài đo riêng trong test/home-boundary.test.js).
export function devicesPath(home) {
  if (home != null && typeof home !== 'string') {
    return path.join(ccrcHome(), '.ccrc', 'devices.json');
  }
  return path.join(home || ccrcHome(), '.ccrc', 'devices.json');
}

// Định danh thiết bị = dấu vân tay của chính khoá công khai. Nhờ vậy "cùng
// khoá là cùng thiết bị" đúng theo định nghĩa, không cần một bảng ánh xạ thứ
// hai để lệch với sự thật.
export function deviceIdFor(pubKey) {
  return crypto.createHash('sha256').update(String(pubKey)).digest('hex').slice(0, 16);
}

function fileFor(opts) {
  return opts.file || devicesPath(opts.home);
}

function readAll(opts) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(opts), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.devices)) return [];
    return raw.devices.filter((d) => d && typeof d === 'object'
      && typeof d.pubKey === 'string' && d.pubKey);
  } catch {
    return [];
  }
}

function writeAll(devices, opts) {
  let tmp;
  try {
    const file = fileFor(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (tmp) fs.unlinkSync(tmp);
    } catch {
      // Ignore cleanup failure
    }
    return false;
  }
}

export function listDevices(opts = {}) {
  return readAll(opts).map((d) => ({
    id: deviceIdFor(d.pubKey),
    pubKey: d.pubKey,
    label: typeof d.label === 'string' ? d.label : '',
    pairedAt: Number(d.pairedAt) || 0,
  }));
}

export function findDevice(id, opts = {}) {
  if (typeof id !== 'string' || !id) return null;
  return listDevices(opts).find((d) => d.id === id) || null;
}

export function addDevice(device, opts) {
  if (!device || typeof device !== 'object' || typeof device.pubKey !== 'string' || !device.pubKey) {
    return { ok: false, reason: 'khoá công khai không hợp lệ' };
  }
  const { pubKey, label } = device;
  opts = opts || {};
  const devices = readAll(opts);
  const id = deviceIdFor(pubKey);
  const i = devices.findIndex((d) => deviceIdFor(d.pubKey) === id);
  const entry = {
    pubKey,
    label: sanitizeLabel(label),
    pairedAt: Date.now(),
  };
  if (i >= 0) {
    // Cùng khoá là cùng thiết bị: ghép lại là CẬP NHẬT, không phải thêm mới.
    // Nếu không, ghép lại vài lần là danh sách đầy những dòng giống hệt nhau
    // mà người dùng không biết xoá cái nào.
    devices[i] = entry;
  } else {
    if (devices.length >= MAX_DEVICES) {
      return { ok: false, reason: `đã đủ giới hạn ${MAX_DEVICES} thiết bị — gỡ bớt bằng /remote unpair` };
    }
    devices.push(entry);
  }
  if (!writeAll(devices, opts)) return { ok: false, reason: 'không ghi được devices.json' };
  return { ok: true, id };
}

export function removeDevice(id, opts = {}) {
  if (typeof id !== 'string' || !id) return false;
  const devices = readAll(opts);
  const con = devices.filter((d) => deviceIdFor(d.pubKey) !== id);
  if (con.length === devices.length) return false;
  return writeAll(con, opts);
}
