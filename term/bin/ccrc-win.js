#!/usr/bin/env node
// `ccrc` trên Windows — lệnh người ta thật sự gõ.
//
// Nó không tự làm gì mới cả: nó nối ba mảnh đã có thành một câu lệnh. Quét dọn
// hồ sơ mồ côi, dựng một `ccrc-host` sống sót qua lúc đóng cửa sổ, chờ host
// khai mình vào sổ, rồi giao hẳn terminal cho `ccrc-client`. Đóng cửa sổ chỉ là
// rời đi; phiên vẫn chạy, và `ccrc attach <id>` mở lại cửa sổ vào đúng nó.
//
// Đây là vai `deploy/ccrc` đóng trên macOS, viết lại cho một hệ điều hành không
// có tmux. Khác biệt lớn nhất: trên macOS phiên sống trong tmux server, ở đây
// phiên sống trong một tiến trình của chính dự án, nên việc dọn xác phải là
// việc của lệnh này chứ không của ai khác (xem `quetDon`).
//
// CHỈ CHẠY TRÊN WINDOWS, cùng lý do với ccrc-host.js: nó gọi `where.exe` và
// WMI, và trên macOS/Linux lối vào là `deploy/ccrc` chứ không phải file này.
// Cho nó chạy nửa vời ở đó (lệnh `list` thì được, mở phiên thì không) chỉ tổ
// liệt kê ra một loại phiên không bao giờ tồn tại ở đó.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listHosts, readHost } from '../src/host-registry.js';
import { resolveCommand, launchSurviving } from '../src/win-launch.js';
import { randomSessionName } from '../src/session-name.js';
import { parsePositiveMs } from '../src/env.js';
import { ccrcHome } from '../../shared/home.js';

if (process.platform !== 'win32') {
  console.error('[ccrc] ccrc-win chỉ chạy trên Windows. Trên macOS/Linux, lối vào là'
    + ' `ccrc` (deploy/ccrc) và phiên sống trong tmux.');
  process.exit(1);
}

const THU_MUC_BIN = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = path.join(THU_MUC_BIN, 'ccrc-host.js');
const CLIENT_JS = path.join(THU_MUC_BIN, 'ccrc-client.js');
const HOME = ccrcHome();

// Lệnh mà một phiên chạy. Cho đè bằng biến môi trường theo đúng lối
// CCRC_TMUX_BIN / CCRC_TAILSCALE_BIN đã có: bộ test cần chạy `cmd.exe` thay cho
// một phiên Claude thật, và người dùng có nhiều bản `claude` cũng cần chỉ đúng
// bản mình muốn. Không mở thêm quyền gì: ai đặt được biến môi trường của tiến
// trình này thì vốn đã chạy được bất cứ lệnh nào rồi.
const LENH_CLAUDE = process.env.CCRC_CLAUDE_BIN || 'claude';

// Chờ host khai mình vào sổ. Hào phóng vì lần chạy đầu còn phải nạp node-pty
// (gói mã máy) trên một máy vừa khởi động; đè được để bộ test chạm tới đường
// quá hạn mà không phải ngồi chờ. `parsePositiveMs` chứ không `Number()`: một
// biến gõ sai mà thành NaN sẽ làm cái hạn chót biến mất không tiếng động (lý do
// đầy đủ ở src/env.js).
const HAN_KHOI_DONG_MS = parsePositiveMs(process.env.CCRC_WIN_START_TIMEOUT_MS, 20_000);
const NHIP_HOI_MS = 100;

const ngu = (ms) => new Promise((r) => setTimeout(r, ms));

// Cùng luật với `defaultIsAlive` trong src/host-registry.js: chỉ ESRCH mới là
// bằng chứng đã chết, EPERM nghĩa là tiến trình CÓ THẬT nhưng thuộc người dùng
// khác — vẫn sống. Chép lại sáu dòng thay vì xuất hàm bên ấy ra: nó là chuyện
// riêng của cái sổ, và cái sổ có quyền đổi cách nó phán một hồ sơ là rác mà
// không kéo theo lệnh này. Ai sửa một bên thì đọc bên kia.
function conSong(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// QUÉT DỌN, VÀ PHẢI LÀ VIỆC ĐẦU TIÊN CỦA MỌI LỆNH.
//
// Giết một host trên Windows là `TerminateProcess` — kể cả `process.kill(pid,
// 'SIGTERM')` cũng bị dịch thành nó — nên `stop()` của host KHÔNG chạy và hồ sơ
// nó ghi ở lại vĩnh viễn. Không ai khác dọn hộ. `listHosts` đã biết cách: hồ sơ
// nào trỏ một pid đã chết thì bị xoá ngay trong lượt đọc.
//
// Vì thế nó chạy trước cả việc phân nhánh lệnh, chứ không nằm trong nhánh
// `list`: nếu chỉ `ccrc list` mới dọn thì một người chỉ dùng `ccrc` và `ccrc
// attach` sẽ tích rác mãi mãi.
function quetDon() {
  return listHosts({ home: HOME });
}

function sinhSessionId(dangSong) {
  // Cùng bảng chữ với nhãn phiên trên macOS: không có `i l o 0 1`, vì cái id
  // này được đọc trên màn hình rồi gõ lại vào `ccrc attach`. Nó là NHÃN, không
  // phải bí mật — bí mật canh cửa pipe là thứ host tự sinh.
  const daCo = new Set(dangSong.map((h) => h.sessionId));
  for (let i = 0; i < 50; i += 1) {
    const id = randomSessionName();
    if (!daCo.has(id)) return id;
  }
  // 31^4 ≈ 923k tên cho vài phiên chạy cùng lúc: tới được đây nghĩa là sổ có
  // chuyện lạ, chứ không phải xui.
  throw new Error('không sinh nổi một tên phiên chưa dùng — kiểm tra lại sổ host.');
}

function inDanhSach(hosts) {
  if (hosts.length === 0) {
    // stdout để RỖNG. Nó là một danh sách, và một danh sách rỗng phải in ra
    // rỗng để còn nối được vào lệnh khác; lời an ủi cho người đọc đi lối stderr.
    process.stderr.write('[ccrc] Không có phiên nào đang chạy.\n');
    return;
  }
  const theoThuTu = [...hosts].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const h of theoThuTu) {
    // Tab, như `ccrc-term-cli candidates` — cùng một lối cho cùng một việc, để
    // shell script đọc được mà không phải đoán chỗ cắt.
    process.stdout.write(`${h.sessionId}\t${h.pid}\t${h.cwd || ''}\n`);
  }
}

// Chờ hồ sơ xuất hiện: ĐIỀU KIỆN cộng hạn chót, không phải một con số mili giây
// đoán bừa.
//
// Đọc hồ sơ TRƯỚC khi hỏi host còn sống không, mỗi vòng. Host có thể ghi hồ sơ
// rồi chết ngay sau đó, và trong ca ấy hồ sơ vẫn là câu trả lời đúng — client
// sẽ tự nói phiên đã hết, bằng câu của nó, chính xác hơn câu của ta ở đây.
async function choHoSo({ sessionId, pid, lenh, noiLamViec }) {
  const hetGio = Date.now() + HAN_KHOI_DONG_MS;
  for (;;) {
    const ho = readHost(sessionId, { home: HOME });
    if (ho) return ho;
    if (!conSong(pid)) {
      // Đây là cái giá của việc host chạy với stdio không nối vào đâu cả: lý do
      // nó chết được in ra một console mà không ai đọc. Nên đừng chỉ báo "chết"
      // — đưa luôn dòng lệnh chạy lại nó ngay trước mắt.
      throw new Error(`host (pid ${pid}) thoát trước khi mở được phiên "${sessionId}".\n`
        + '[ccrc] Nó in lý do ra console riêng của nó, và console ấy đã đóng theo.'
        + ' Chạy thẳng host để thấy lỗi:\n'
        + `[ccrc]   $env:CCRC_HOST_SESSION_ID="${sessionId}"; `
        + `$env:CCRC_HOST_COMMAND="${lenh}"; `
        + `$env:CCRC_HOST_CWD="${noiLamViec}"; `
        + `node "${HOST_JS}"`);
    }
    if (Date.now() >= hetGio) {
      // KHÔNG giết host ở đây: quá hạn nghĩa là "chưa thấy", không phải "đã
      // hỏng". Một máy đang bận có thể vẫn đang nạp node-pty. Nói ra pid để
      // người dùng tự quyết.
      throw new Error(`host (pid ${pid}) chưa ghi hồ sơ cho phiên "${sessionId}" sau `
        + `${HAN_KHOI_DONG_MS}ms. Nó có thể vẫn đang khởi động: chạy \`ccrc list\` một lát nữa.`
        + ` Nếu không thấy gì, dừng nó bằng \`taskkill /PID ${pid} /F /T\`.`);
    }
    await ngu(NHIP_HOI_MS);
  }
}

// Giao hẳn tiến trình này cho client.
//
// Windows không có `execve`, và cách thay thế quen thuộc — đẻ một tiến trình
// con rồi ngồi đợi nó — ở đây là một tiến trình Node thứ hai nằm không suốt cả
// phiên, chỉ để làm vỏ, cộng thêm nguyên một bài toán chuyển tiếp tín hiệu vào
// đúng chỗ mà `ccrc-client.js` đã lý luận rất kỹ về tín hiệu.
//
// Nên: đặt lại `process.argv` thành ĐÚNG dòng lệnh mà client sẽ thấy nếu được
// gọi thẳng (`node ccrc-client.js <id>`), rồi nạp nó. Từ dòng dưới đây trở đi
// tiến trình này LÀ client — cùng một console, cùng stdin/stdout thật, cùng mã
// thoát. Đó là ý nghĩa của `exec`, thực hiện bằng thứ Node có.
//
// `pathToFileURL` chứ không phải đường dẫn trần: `import('C:\\...')` không phải
// một URL hợp lệ và sẽ ném ngay trên Windows.
async function giaoChoClient(sessionId) {
  process.argv = [process.argv[0], CLIENT_JS, sessionId];
  await import(pathToFileURL(CLIENT_JS).href);
}

async function moPhienMoi(dangSong) {
  // PHÂN GIẢI TRƯỚC, vì `pty.spawn` KHÔNG tìm PATHEXT: đưa cho nó cái tên trần
  // `claude` là nhận `File not found`. Một file `.cmd` thì spawn thẳng được —
  // không bọc qua `cmd.exe /c`, thêm lớp ấy là thêm một tầng gián tiếp vĩnh
  // viễn không lý do (đo được ở src/win-launch.js).
  const duongDanLenh = resolveCommand(LENH_CLAUDE);
  const sessionId = sinhSessionId(dangSong);

  // `Win32_Process.Create` KHÔNG thừa hưởng thư mục làm việc của người gọi —
  // khác hẳn `spawn`, vốn mặc định là `process.cwd()`. Bỏ trống thì host khởi
  // động trong thư mục của WMI provider host, và Claude Code mở ra ở nhầm chỗ:
  // chạy trơn tru, trông bình thường, chỉ là sai. Nên nói tường minh, luôn
  // luôn, cả cho tiến trình host (`cwd`) lẫn cho ConPTY bên trong nó
  // (`CCRC_HOST_CWD`) — cùng một nguồn, không để hai giá trị trôi khỏi nhau.
  const noiLamViec = process.cwd();

  // stdio của host KHÔNG nối vào đâu cả, và đó là chủ ý: `launchSurviving` đi
  // qua WMI nên tiến trình sinh ra không thừa kế một cái ống nào của ta. Host
  // có `console.log` vài dòng; nối chúng vào một ống không ai đọc thì tới lúc
  // bộ đệm đầy host nghẽn lại giữa chừng, và phiên treo mà không một lời báo.
  const pid = launchSurviving({
    command: process.execPath,
    args: [HOST_JS],
    cwd: noiLamViec,
    env: {
      ...process.env,
      CCRC_HOST_SESSION_ID: sessionId,
      CCRC_HOST_COMMAND: duongDanLenh,
      CCRC_HOST_CWD: noiLamViec,
    },
  });

  await choHoSo({ sessionId, pid, lenh: duongDanLenh, noiLamViec });

  // Ra stderr, không stdout: ngay sau dòng này client bắt đầu vẽ màn hình của
  // phiên ra stdout. Và phải in — không ai đoán được cái id để mà `attach` vào
  // lại nếu ta không nói.
  process.stderr.write(`[ccrc] phiên ${sessionId} — đóng cửa sổ không làm phiên chết;`
    + ` \`ccrc attach ${sessionId}\` để vào lại.\n`);

  await giaoChoClient(sessionId);
}

function inCachDung() {
  process.stderr.write([
    '[ccrc] Cách dùng:',
    '  ccrc                mở một phiên Claude Code mới (sống sót qua lúc đóng cửa sổ)',
    '  ccrc list           liệt kê các phiên đang chạy',
    '  ccrc attach <id>    mở lại một cửa sổ vào phiên đang chạy',
    '',
    '[ccrc] Cờ của chính Claude Code (`-p`, `--help`, ...) chưa đi qua `ccrc` trên',
    '[ccrc] Windows được — gõ thẳng `claude ...`. Hai lý do: host chạy `claude` KHÔNG',
    '[ccrc] tham số, còn chuyển tiếp thẳng thì Node từ chối spawn một file `.cmd` nếu',
    '[ccrc] không mượn shell, mà dựng dòng lệnh cmd.exe bằng tay cho tham số tuỳ ý là',
    '[ccrc] đúng hạng lỗi dự án tránh ở mọi chỗ khác.',
  ].join('\n') + '\n');
}

// --- vào lệnh ---------------------------------------------------------------

const thamSo = process.argv.slice(2);
const dangSong = quetDon(); // TRƯỚC MỌI THỨ — xem `quetDon`.

try {
  if (thamSo.length === 0) {
    await moPhienMoi(dangSong);
  } else if (thamSo[0] === 'list') {
    inDanhSach(dangSong);
  } else if (thamSo[0] === 'attach') {
    const id = thamSo[1] || '';
    if (!id) {
      process.stderr.write('[ccrc] `ccrc attach` cần một id phiên. `ccrc list` để xem có những gì.\n');
      process.exit(2);
    }
    // Không tự kiểm hồ sơ ở đây: client đã có đúng câu cần nói cho cả hai ca
    // (gõ nhầm một ký tự, và phiên đã kết thúc), kèm chỗ nó đã tìm. Kiểm hai
    // lần là hai câu báo có thể trôi khỏi nhau.
    await giaoChoClient(id);
  } else {
    inCachDung();
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`[ccrc] ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
