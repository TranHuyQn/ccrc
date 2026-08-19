// Bước cấu hình của bản cài Windows — thứ `setup-notify.sh` làm trên macOS/Linux.
//
// VÌ SAO LÀ NODE CHỨ KHÔNG PHẢI POWERSHELL: đo trên máy thật, ExecutionPolicy
// mặc định là Restricted, nên MỘT FILE .ps1 NẰM TRÊN ĐĨA BỊ CHẶN CHẠY. Đường
// `irm | iex` lách được vì nó là chuỗi, nhưng bản cài thủ công thì không —
// người dùng sẽ có một file không chạy nổi. `node.exe <file>.mjs` không dính
// chính sách ấy, và bước này vốn phải trộn JSON vào settings.json, việc mà
// Node làm sẵn còn PowerShell 5.1 thì làm vụng.
//
// KHÔNG đụng gì tới đường macOS/Linux: file mới, setup-notify.sh giữ nguyên.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const noi = (m) => console.log(m);
const chet = (m) => { console.error(`✗ ${m}`); process.exit(1); };

// Gốc bản cài = thư mục cha của tools/. Bản cài thủ công chạy file này thẳng
// từ trong cây nguồn, nên tự định vị chứ không nhận tham số.
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NHA = process.env.USERPROFILE || os.homedir();
const CFG_DIR = path.join(NHA, '.ccrc');

// Đọc lại cấu hình lần cài trước, y như `setup-notify.sh` đọc OLD_URL/OLD_TOK.
//
// Không có phần này thì file này CHỈ chạy được từ install.ps1, và người đã cài
// rồi không có cách nào chạy lại để đổi tên máy — họ phải cài lại từ đầu, hoặc
// sửa tay file config. Đó là một bước lùi so với macOS, và nó chỉ lộ ra khi có
// người thật muốn đổi tên sau khi cài.
function docConfigCu() {
  try {
    const raw = fs.readFileSync(path.join(CFG_DIR, 'config'), 'utf8');
    const lay = (khoa) => {
      const m = raw.match(new RegExp(`^${khoa}=(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return { hub: lay('CCRC_HUB_URL'), token: lay('CCRC_TOKEN'), may: lay('CCRC_MACHINE_NAME') };
  } catch {
    return { hub: '', token: '', may: '' };
  }
}
const cu = docConfigCu();

// Env thắng config: install.ps1 vừa xin token mới thì token ấy phải được dùng,
// không phải token cũ có thể đã bị thu hồi.
const HUB = process.env.CCRC_HUB_URL || cu.hub;
const TOKEN = process.env.CCRC_TOKEN || cu.token;
if (!HUB) chet('Thiếu CCRC_HUB_URL, và chưa có cấu hình cũ để đọc lại.');
if (!TOKEN) chet('Thiếu CCRC_TOKEN, và chưa có cấu hình cũ để đọc lại.');

noi('== CC Remote Control — cấu hình (Windows) ==');

// --- tên máy ---------------------------------------------------------------
//
// Đây là tên hiện trên ĐIỆN THOẠI, cạnh mỗi thông báo và mỗi phiên remote. Mặc
// định của Windows là dạng `DESKTOP-A1B2C3D` — vô nghĩa khi có hai ba máy. Nên
// phải hỏi, y như `setup-notify.sh` hỏi trên macOS; bản đầu của file này lấy
// thẳng COMPUTERNAME và đó là một bước bị bỏ sót, không phải một lựa chọn.
//
// Trên Windows `hostname -s` KHÔNG tồn tại (đo được: "unknown option -- s"),
// nên mặc định lấy COMPUTERNAME — thứ người dùng thấy trong Settings.
// Tên đã đặt lần trước làm mặc định, không phải COMPUTERNAME: chạy lại để sửa
// một thứ khác mà bị âm thầm đổi tên máy về `DESKTOP-…` là mất công của người
// dùng — họ đã trả lời câu này một lần rồi.
const MAC_DINH = cu.may || process.env.COMPUTERNAME || os.hostname() || 'máy dev';

// Hỏi trên console, và KHÔNG bao giờ treo nếu không có console.
//
// macOS giải cùng bài toán này bằng cách đọc thẳng /dev/tty, vì dưới
// `curl … | sh` thì stdin CHÍNH LÀ script đang chạy. Ở đây khác: file này được
// `install.ps1` spawn ra, thừa kế console thật, nên stdin dùng được — nhưng
// chỉ khi có console. Chạy qua SSH, qua CI, hay khi ai đó chuyển hướng stdin
// thì `isTTY` là false, và lúc ấy im lặng dùng mặc định còn hơn đứng chờ một
// dòng không bao giờ tới.
function hoi(cauHoi, macDinh) {
  if (process.env.CCRC_MACHINE_NAME) return process.env.CCRC_MACHINE_NAME;
  if (!process.stdin.isTTY) return macDinh;
  try {
    process.stdout.write(cauHoi);
    // readSync trên fd 0: gọn hơn readline cho đúng MỘT câu hỏi, và không để
    // lại một interface phải đóng — quên đóng là tiến trình không thoát.
    const dem = Buffer.alloc(1024);
    const n = fs.readSync(0, dem, 0, dem.length, null);
    const traLoi = dem.subarray(0, n).toString('utf8').trim();
    return traLoi || macDinh;
  } catch {
    // EAGAIN/EOF/không đọc được — mặc định vẫn là câu trả lời đúng.
    return macDinh;
  }
}

const MAY = hoi(`Tên máy hiện trong thông báo [${MAC_DINH}]: `, MAC_DINH);

// --- ~/.ccrc/config --------------------------------------------------------
fs.mkdirSync(CFG_DIR, { recursive: true });
const cfgFile = path.join(CFG_DIR, 'config');
fs.writeFileSync(cfgFile, `CCRC_HUB_URL=${HUB}\nCCRC_TOKEN=${TOKEN}\nCCRC_MACHINE_NAME=${MAY}\n`);

// `chmod 600` không có nghĩa gì trên NTFS. Thứ tương đương là cắt thừa kế rồi
// chỉ để lại chính chủ. Token nằm trong file này, nên đây không phải trang trí.
// `laThuMuc` KHÔNG phải tham số cho gọn — nó quyết định file bên trong có được
// bảo vệ hay không, và làm sai thì hỏng theo hướng ngược với mong đợi.
//
// Đo trên Windows thật. Với một THƯ MỤC, `/grant:r user:(F)` áp cho chính thư
// mục và KHÔNG di truyền, nên file tạo sau đó nhận một ACL hoàn toàn khác:
//
//   sau `/inheritance:r` + `/grant:r user:(F)`  → file có SYSTEM(F),
//     Administrators(F), và một SID PHIÊN ĐĂNG NHẬP (RX). Chủ máy KHÔNG có ACE
//     mang tên mình.
//   thêm `(OI)(CI)`                              → file có đúng `user:(F)`.
//   không siết gì cả                             → file kế thừa từ
//     %USERPROFILE%: SYSTEM(F), Administrators(F), user(F).
//
// Nghĩa là cách cũ vừa KHÔNG đạt mục tiêu ("chỉ chủ máy đọc"), vừa tệ hơn việc
// không làm gì: quyền duy nhất của chủ máy đến từ SID phiên đăng nhập, mà SID
// ấy đổi sau mỗi lần đăng nhập lại — hồ sơ host có thể thành không đọc được.
// Đây là thư mục chứa BÍ MẬT CANH CỬA NAMED PIPE, nên nó phải đúng.
function chiChuMoiDoc(duongDan, { laThuMuc = false } = {}) {
  // (OI) object-inherit: file con nhận ACE. (CI) container-inherit: thư mục con
  // nhận. Với một file thì hai cờ ấy vô nghĩa và icacls từ chối.
  const quyen = laThuMuc ? '(OI)(CI)(F)' : '(F)';
  try {
    execFileSync('icacls.exe', [duongDan, '/inheritance:r'], { stdio: 'ignore' });
    execFileSync('icacls.exe', [duongDan, '/grant:r', `${process.env.USERNAME}:${quyen}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
if (chiChuMoiDoc(cfgFile)) noi(`• Đã ghi ${cfgFile} (chỉ chủ máy đọc được)`);
else noi(`• Đã ghi ${cfgFile} ⚠ KHÔNG siết được quyền — token đang để lộ cho user khác trên máy này.`);

// Thư mục hồ sơ host: bí mật của named pipe nằm trong đó, và cơ chế xác thực
// pipe TIN VÀO quyền thư mục này. Không siết thì bí mật ấy vô nghĩa.
const hostsDir = path.join(CFG_DIR, 'hosts');
fs.mkdirSync(hostsDir, { recursive: true });
if (!chiChuMoiDoc(hostsDir, { laThuMuc: true })) {
  noi('⚠ Không siết được quyền ~/.ccrc/hosts — bí mật của pipe có thể bị user khác đọc.');
}

// --- mặc định TẮT ----------------------------------------------------------
// Người dùng chủ động bật khi sắp rời máy.
const notifyFile = path.join(CFG_DIR, 'notify');
if (!fs.existsSync(notifyFile)) {
  fs.writeFileSync(notifyFile, 'off\n');
  noi('• Thông báo mặc định TẮT — bật bằng /notify on');
}

// --- slash command ---------------------------------------------------------
const cmdDir = path.join(NHA, '.claude', 'commands');
fs.mkdirSync(cmdDir, { recursive: true });
for (const ten of ['notify', 'remote']) {
  const nguon = path.join(REPO, 'deploy', 'commands', `${ten}.md`);
  if (!fs.existsSync(nguon)) { noi(`⚠ Thiếu ${nguon} — bỏ qua /${ten}`); continue; }
  const noiDung = fs.readFileSync(nguon, 'utf8').split('{{CCRC_REPO}}').join(REPO);
  fs.writeFileSync(path.join(cmdDir, `${ten}.md`), noiDung);
  noi(`• Đã cài slash command /${ten}`);
}

// --- lệnh `ccrc` -----------------------------------------------------------
//
// Đặt cạnh chính `claude.exe`: thư mục đó chắc chắn đã nằm trên PATH, vì người
// dùng vẫn đang gọi được `claude`. Đo trên máy thật: claude.exe nằm ở
// %USERPROFILE%\.local\bin, và thư mục ấy có trong PATH của user.
//
// KHÔNG chép deploy\ccrc.cmd sang: file đó tự định vị bằng %~dp0 nên chỉ đúng
// khi nằm cạnh term\. Bản đặt ở nơi khác phải nhúng đường dẫn tuyệt đối.
//
// CCRC_BIN_DIR là để BỘ TEST cô lập được, và nó không phải chuyện thừa: lần đo
// đầu tiên trên máy thật, đặt USERPROFILE vào thư mục tạm KHÔNG cô lập được
// bước này — `where.exe claude` vẫn tìm ra claude.exe thật, nên bài thử ghi
// ccrc.cmd thẳng vào hồ sơ thật. Cùng họ lỗi với "tưởng đang ở trong hộp cát".
function timThuMucBin() {
  if (process.env.CCRC_BIN_DIR) return process.env.CCRC_BIN_DIR;
  const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    return path.dirname(r.stdout.split(/\r?\n/)[0].trim());
  }
  return path.join(NHA, '.local', 'bin');
}
const binDir = timThuMucBin();
const dichCcrc = path.join(binDir, 'ccrc.cmd');
// Mọi chữ trong file .cmd phải là ASCII: cmd.exe đọc nó theo code page OEM của
// máy, nên chữ Việt có dấu sẽ ra rác ngay trên màn hình người dùng.
const noiDungCmd = [
  '@echo off',
  'rem `ccrc` tren Windows - sinh ra luc cai, duong dan tuyet doi da nhung san.',
  'setlocal',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo [ccrc] Khong tim thay lenh "node". Cai Node.js roi thu lai. 1>&2',
  '  exit /b 127',
  ')',
  `node "${path.join(REPO, 'term', 'bin', 'ccrc-win.js')}" %*`,
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');
// Quy tắc ASCII ở trên từng là comment thôi, và mình đã vi phạm nó ngay lần
// viết đầu: một dấu gạch ngang dài lọt vào, và trên máy thật nó hiện ra là
// `�?"`. Nên biến quy tắc thành thứ dừng được chương trình.
const xau = [...noiDungCmd].find((c) => c.charCodeAt(0) > 0x7e);
if (xau) chet(`ccrc.cmd chứa ký tự ngoài ASCII (${JSON.stringify(xau)}) — cmd.exe sẽ hiện ra rác.`);

try {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(dichCcrc, noiDungCmd);
  noi(`• Đã cài lệnh ccrc vào ${binDir}`);
  const duongDan = (process.env.Path || process.env.PATH || '').split(';');
  if (!duongDan.some((d) => d && path.resolve(d) === path.resolve(binDir))) {
    // Không tự sửa PATH của người dùng — đó là cấu hình máy họ.
    noi(`⚠ ${binDir} chưa nằm trên PATH. Thêm bằng:`);
    noi(`    setx PATH "%PATH%;${binDir}"`);
  }
} catch (e) {
  noi(`⚠ Không cài được lệnh ccrc vào ${binDir}: ${e.message}`);
  noi(`  Vẫn dùng được bằng: node "${path.join(REPO, 'term', 'bin', 'ccrc-win.js')}"`);
}

// --- hook Notification -----------------------------------------------------
const r = spawnSync(process.execPath, [
  path.join(REPO, 'hook', 'bin', 'install-hook.mjs'),
  'install',
  path.join(REPO, 'hook', 'bin', 'ccrc-notify.js'),
], { stdio: 'inherit' });
if (r.status !== 0) {
  noi('⚠ KHÔNG cài được hook — sẽ không có thông báo nào. Xem lỗi ở trên.');
  process.exit(1);
}
noi('• Đã cài hook Notification');

noi('');
noi('== XONG ==');
noi("Từ giờ gõ 'ccrc' thay cho 'claude' — nó tự dựng terminal riêng, nên /remote dùng được ngay.");
noi(`Bước tiếp: mở ${HUB} trên điện thoại, đăng nhập bằng token, bật thông báo.`);
noi('iPhone: phải thêm vào màn hình chính rồi mở từ đó thì mới nhận được push.');
noi('Kiểm tra bất cứ lúc nào bằng: /notify');
