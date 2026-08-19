// Gỡ phần cấu hình trên Windows — thứ `remove-notify.sh` làm trên macOS/Linux.
//
// Node chứ không PowerShell, cùng lý do với `setup-notify-win.mjs`: một file
// `.ps1` nằm trên đĩa bị ExecutionPolicy mặc định (Restricted) chặn chạy, nên
// người cài thủ công sẽ có một trình gỡ không chạy nổi.
//
// KHÔNG đụng gì tới đường macOS/Linux: file mới, remove-notify.sh giữ nguyên.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const noi = (m) => console.log(m);
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NHA = process.env.CCRC_HOME || process.env.USERPROFILE || os.homedir();
const CFG_DIR = path.join(NHA, '.ccrc');
const CMD_DIR = path.join(NHA, '.claude', 'commands');
const SETTINGS = path.join(NHA, '.claude', 'settings.json');

// Tìm `ccrc.cmd` theo đúng cách lúc cài đặt nó: cạnh claude.exe, hoặc chỗ được
// chỉ định. Không quét PATH mù — xoá nhầm một `ccrc.cmd` của người khác thì
// không hoàn tác được.
function timCcrcCmd() {
  const ungVien = [];
  if (process.env.CCRC_BIN_DIR) ungVien.push(path.join(process.env.CCRC_BIN_DIR, 'ccrc.cmd'));
  const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    ungVien.push(path.join(path.dirname(r.stdout.split(/\r?\n/)[0].trim()), 'ccrc.cmd'));
  }
  ungVien.push(path.join(NHA, '.local', 'bin', 'ccrc.cmd'));
  return ungVien.find((p) => fs.existsSync(p)) || '';
}
const ccrcCmd = timCcrcCmd();

// --- nói trước sẽ xoá gì ----------------------------------------------------
noi('== CC Remote Control — gỡ trên Windows ==');
noi('Sẽ xoá:');
if (fs.existsSync(CFG_DIR)) noi(`  • ${CFG_DIR} (config, notify, hosts)`);
if (fs.existsSync(path.join(CMD_DIR, 'notify.md'))) noi('  • slash command /notify');
if (fs.existsSync(path.join(CMD_DIR, 'remote.md'))) noi('  • slash command /remote');
noi('  • hook ccrc trong ~/.claude/settings.json (chỉ entry của ccrc)');
if (ccrcCmd) noi(`  • lệnh ccrc (${ccrcCmd})`);
noi('  • mọi phiên /remote đang chạy trên máy này');

// --- hỏi cho chắc -----------------------------------------------------------
//
// Không có console thì TỪ CHỐI, không tự cho là "có". Đây là lệnh xoá; đoán sai
// hướng này thì mất dữ liệu, còn đoán sai hướng kia chỉ mất một lần gõ `-y`.
// Khác hẳn `setup-notify-win.mjs`, nơi không có console thì dùng mặc định là an
// toàn vì nó chỉ GHI thứ của chính mình.
const dongY = process.argv.includes('-y') || process.env.CCRC_YES === '1';
if (!dongY) {
  if (!process.stdin.isTTY) {
    noi('✗ Không có terminal để hỏi. Chạy lại với -y nếu chắc chắn muốn gỡ.');
    process.exit(1);
  }
  process.stdout.write('Tiếp tục? [y/N] ');
  let traLoi = '';
  try {
    const dem = Buffer.alloc(64);
    const n = fs.readSync(0, dem, 0, dem.length, null);
    traLoi = dem.subarray(0, n).toString('utf8').trim().toLowerCase();
  } catch { /* không đọc được = không đồng ý */ }
  if (!['y', 'yes'].includes(traLoi)) { noi('Đã huỷ.'); process.exit(0); }
}

// --- dừng mọi phiên TRƯỚC khi xoá sổ ----------------------------------------
//
// Thứ tự này là thứ quan trọng nhất trong cả file. File pid nằm trong CFG_DIR
// và là thứ DUY NHẤT ghi lại daemon nào đang chạy. Xoá thư mục trước là để lại
// một tiến trình vẫn phục vụ một shell trên tailnet mà không còn cách nào tìm
// ra nó — trong khi người dùng tưởng đã gỡ sạch.
const offAll = spawnSync(process.execPath, [
  path.join(REPO, 'term', 'bin', 'ccrc-term-cli.js'), 'off-all',
], { stdio: 'inherit' });
if (offAll.status !== 0) {
  noi('⚠ Không dừng được phiên remote — kiểm tra bằng: Get-Process node');
}

// --- gỡ hook ----------------------------------------------------------------
const goHook = spawnSync(process.execPath, [
  path.join(REPO, 'hook', 'bin', 'install-hook.mjs'), 'uninstall',
], { stdio: 'inherit' });
if (goHook.status !== 0) {
  noi('⚠ Không gỡ được hook — kiểm tra ~/.claude/settings.json bằng tay');
}

// --- xoá ---------------------------------------------------------------------
function xoaFile(p, nhan) {
  try { fs.rmSync(p, { force: true }); noi(`✓ Xoá ${nhan}`); } catch { /* không có = xong rồi */ }
}
if (fs.existsSync(CFG_DIR)) {
  try { fs.rmSync(CFG_DIR, { recursive: true, force: true }); noi(`✓ Xoá ${CFG_DIR}`); }
  catch (e) { noi(`⚠ Không xoá được ${CFG_DIR}: ${e.message}`); }
}
if (fs.existsSync(path.join(CMD_DIR, 'notify.md'))) xoaFile(path.join(CMD_DIR, 'notify.md'), 'slash command /notify');
if (fs.existsSync(path.join(CMD_DIR, 'remote.md'))) xoaFile(path.join(CMD_DIR, 'remote.md'), 'slash command /remote');

// Chỉ xoá `ccrc.cmd` nếu đúng là file lệnh cài này tạo ra. Người dùng có thể có
// một `ccrc.cmd` của riêng họ trùng tên — xoá nó là mất của người ta.
if (ccrcCmd) {
  let cuaMinh = false;
  try { cuaMinh = /ccrc-win\.js/.test(fs.readFileSync(ccrcCmd, 'utf8')); } catch { /* đọc không được = không phải */ }
  if (cuaMinh) xoaFile(ccrcCmd, 'lệnh ccrc');
  else noi(`⚠ Có ${ccrcCmd} nhưng không phải file do lệnh cài này tạo — để nguyên.`);
}

// settings.json do install-hook tạo ra khi máy chưa có file này. Gỡ entry hook
// xong mà để lại một file rỗng thì máy KHÔNG trở về đúng trạng thái cũ. Chỉ xoá
// khi nội dung đúng là một object rỗng.
try {
  if (fs.readFileSync(SETTINGS, 'utf8').replace(/\s/g, '') === '{}') {
    xoaFile(SETTINGS, '~/.claude/settings.json (rỗng, do lệnh cài tạo)');
  }
} catch { /* không có, hoặc có nội dung thật — để nguyên */ }

// rmdir chứ không xoá đệ quy: thư mục còn thứ gì khác là của người dùng, và
// lệnh này sẽ tự thất bại chứ không xoá nhầm.
for (const [d, nhan] of [
  [CMD_DIR, '~/.claude/commands'],
  [path.join(NHA, '.claude'), '~/.claude'],
  ...(ccrcCmd ? [[path.dirname(ccrcCmd), path.dirname(ccrcCmd)]] : []),
]) {
  try { fs.rmdirSync(d); noi(`✓ Xoá thư mục ${nhan} (đã rỗng)`); } catch { /* còn thứ khác — đúng như mong đợi */ }
}

noi('');
noi('Còn lại thư mục mã nguồn — trình gỡ bên ngoài sẽ xoá nốt.');
