#!/usr/bin/env node
// `ccrc-host` — giữ ConPTY của ĐÚNG MỘT phiên Claude, nuôi buffer cuộn cho nó,
// và mở một named pipe cho những ai muốn xem hoặc gõ vào. Không mở cổng mạng
// nào; phần web vẫn là việc của `ccrc-term`.
//
// Đây là vai `tmux server` đóng trên macOS, và Windows không có ai đóng sẵn:
// giữ terminal sống, sống lâu hơn bất kỳ người xem nào, cho nhiều người xem
// cùng lúc. Ba việc đó là toàn bộ lý do file này tồn tại (spec §6).
//
// CHỈ CHẠY TRÊN WINDOWS. Ở nơi khác đã có tmux thật, và file này thoát ngay với
// một câu giải thích — chứ không tạo ra một socket unix mang cái tên
// `\\.\pipe\ccrc-...` vô nghĩa giữa thư mục làm việc của người dùng.

import net from 'node:net';
import crypto from 'node:crypto';
import { createScreenBuffer } from '../src/screen-buffer.js';
import { createMouseMode } from '../src/mouse-mode.js';
import { createAttachQueue } from '../src/attach-queue.js';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';
import { writeHost, removeHost } from '../src/host-registry.js';
import { parsePositiveMs } from '../src/env.js';
import { ccrcHome } from '../../shared/home.js';

// 10.000 dòng, con số spec §6 chốt.
//
// KHÔNG bằng bản tmux, dù dễ tưởng thế: dự án không đặt `history-limit` ở đâu
// cả, nên trên macOS tmux dùng mặc định của chính nó là 2000 dòng. Windows vì
// vậy cuộn ngược xa hơn gấp năm. Đó là khác biệt thật giữa hai nền tảng, ghi ra
// để không ai đọc lướt rồi tưởng chúng bằng nhau.
//
// Cũng đúng bằng mặc định của screen-buffer.js — truyền tường minh ở đây là để
// con số này là một lựa chọn đọc được, không phải một thứ thừa hưởng im lặng.
const SCROLLBACK = 10_000;
// Kích thước lúc chưa client nào khai. Không phải "kích thước thật của ai cả",
// chỉ là chỗ đứng cho tới lúc có người khai (xem applySize).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Biên cho cols/rows do client khai. Cùng lối nghĩ với ccrc-term.js: con số ấy
// đến từ đầu bên kia của một cái ống và đi thẳng vào `pty.resize`, nên loại
// những gì không phải "một terminal thật" trước.
const MIN_COLS = 10;
const MAX_COLS = 1000;
const MIN_ROWS = 4;
const MAX_ROWS = 500;
// sessionId đi vào CẢ tên pipe LẪN tên file hồ sơ. host-registry.js đã tự lọc
// cho phần tên file, nhưng tên pipe thì không ai lọc hộ — nên lọc ở đây, bằng
// đúng tập ký tự ấy.
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
// Một kết nối chưa gửi bí mật thì chưa là gì cả. Không có trần này, ai mở được
// pipe cũng giữ được một socket im lặng vô hạn trong một tiến trình sống nhiều
// ngày.
//
// Cho phép đè bằng biến môi trường CHỈ để bộ test chạm được vào nó mà không
// phải ngồi chờ đủ mười giây — cùng lối nghĩ với CCRC_TERM_MAX_TICKET_MS trong
// ccrc-term.js, và dùng lại đúng hàm ccrc-term.js dùng. `parsePositiveMs` tồn
// tại vì một cái bẫy đã có comment riêng ở src/env.js: `Number('rác')` là NaN,
// mọi phép so với NaN đều false, nên một biến gõ sai sẽ làm cái trần biến mất
// không tiếng động. Nó cũng đã có test riêng (env.test.js).
const AUTH_TIMEOUT_MS = parsePositiveMs(process.env.CCRC_HOST_AUTH_TIMEOUT_MS, 10_000);

// --- môi trường ------------------------------------------------------------

// Kiểm nền tảng TRƯỚC khi nạp node-pty: trên macOS gói mã máy ấy có thể có,
// có thể không, và không có lý do gì để chạm vào nó chỉ để nói "chỗ này không
// chạy file này".
if (process.platform !== 'win32') {
  console.error('[host] ccrc-host chỉ chạy trên Windows. Trên macOS/Linux, tmux giữ phiên'
    + ' — dùng `ccrc-term` như thường lệ.');
  process.exit(1);
}

const SESSION_ID = process.env.CCRC_HOST_SESSION_ID || '';
const COMMAND = process.env.CCRC_HOST_COMMAND || 'claude';
const CWD = process.env.CCRC_HOST_CWD || process.cwd();

if (!SESSION_ID) {
  console.error('[host] Thiếu CCRC_HOST_SESSION_ID');
  process.exit(1);
}
if (!SAFE_SESSION_ID.test(SESSION_ID)) {
  console.error(`[host] CCRC_HOST_SESSION_ID không hợp lệ: "${SESSION_ID}"`);
  process.exit(1);
}

const PIPE = `\\\\.\\pipe\\ccrc-${SESSION_ID}`;

// --- node-pty --------------------------------------------------------------

// node-pty là `optionalDependencies`, không phải `dependencies` — gói đầu tiên
// của dự án có mã máy, và khai thường thì mỗi `npm ci` trên macOS cũng kéo nó
// về, nơi một phiên bản Node thiếu prebuild làm HỎNG cả lượt cài. Optional
// nghĩa là thiếu prebuild chỉ là không có gói, không gãy gì.
//
// Cái giá của lựa chọn ấy phải trả ở đây: lỗi chuyển từ lúc cài sang lúc chạy,
// nên lúc chạy phải nói được một câu người dùng làm theo được. Để
// `MODULE_NOT_FOUND` nổ ra là hỏng — nó không nói cho ai biết phải làm gì.
let pty;
try {
  const mod = await import('node-pty');
  pty = mod.default || mod;
  if (typeof pty.spawn !== 'function') throw new Error('node-pty không có spawn()');
} catch (e) {
  console.error('[host] Không nạp được node-pty — thiếu gói này thì không mở được ConPTY,'
    + ' và không có ConPTY thì không có phiên nào để phục vụ.');
  console.error('[host] Cách sửa: vào thư mục cài rồi chạy'
    + ' `npm.cmd install --workspace term node-pty`.'
    + ' (node-pty được khai là optionalDependency nên `npm ci` bỏ qua nó khi máy'
    + ' không có prebuild hợp với phiên bản Node đang dùng.)');
  console.error(`[host] Lý do gốc: ${e && e.message ? e.message : e}`);
  process.exit(1);
}

// --- ConPTY ----------------------------------------------------------------

let term;
try {
  term = pty.spawn(COMMAND, [], {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: CWD,
    // CCRC_SESSION_ID đi vào môi trường của phiên, và hook thông báo thừa
    // hưởng nó (spec §7.4). Trên macOS việc khớp phiên phải hỏi tmux bằng
    // TMUX_PANE; ở đây phiên tự mang theo tên mình.
    env: { ...process.env, CCRC_SESSION_ID: SESSION_ID },
  });
} catch (e) {
  console.error(`[host] Không mở được ConPTY cho "${COMMAND}": ${e && e.message ? e.message : e}`);
  process.exit(1);
}

// Terminal trong bộ nhớ — thứ thay `tmux capture-pane`. ConPTY không giữ gì
// cả, nên nếu host không tự nuôi thì đóng cửa sổ rồi nối lại sẽ thấy một hình
// chữ nhật trống.
const screen = createScreenBuffer({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: SCROLLBACK });
const mouse = createMouseMode();

// Giải mã UTF-8 CÓ NHỚ TRẠNG THÁI, cùng lý do control-stream.js dùng
// `setEncoding('utf8')`: một ký tự nhiều byte bị cắt ngang hai lần đọc mà
// decode riêng từng mảng sẽ thành U+FFFD, và người dùng thấy chữ Việt vỡ ra.
//
// Đo được trên node-pty 1.1.0: trên Windows nó tự `setEncoding('utf8')` cho
// ống conout (windowsPtyAgent.js) và CẢNH BÁO nếu ta xin encoding khác — nên
// `onData` ở đây luôn đưa string đã được StringDecoder ghép sẵn, đúng cơ chế
// ta cần. Nhưng đó là chuyện bên trong một gói khác: nhánh Buffer vẫn phải có
// và phải đúng, chứ không đặt cược vào một chi tiết cài đặt.
const decoder = new TextDecoder('utf-8');
function decodeChunk(chunk) {
  if (typeof chunk === 'string') return chunk;
  return decoder.decode(chunk, { stream: true });
}

// Hàng ghi của màn hình, cộng nghi thức gắn một người xem mới vào giữa dòng
// chảy. CẢ CHUỖI nằm trong attach-queue.js chứ không phải ở đây, và lý lẽ vì
// sao nó phải có đúng hình dạng ấy cũng đã dọn sang bên đó — đó mới là nhà của
// nó. Ai định sửa thứ tự chụp/gửi bù/đăng ký thì đọc file ấy trước.
//
// `snapshot()` trả về KHUNG chứ không phải chuỗi: việc mã hoá phải nằm trong
// mắt xích chụp. Rỗng nghĩa là chưa có gì trên màn hình; gửi một khung rỗng chỉ
// tổ làm đầu kia xoá màn hình mà không được gì.
const queue = createAttachQueue({
  write: (text) => screen.write(text),
  snapshot: () => {
    const snap = screen.snapshot();
    return snap ? encodeFrame(FRAME.PANE, snap) : null;
  },
});

// MỘT tập client duy nhất, do queue sở hữu — host chỉ MƯỢN để tính kích thước
// nhỏ nhất và để dọn lúc đóng. Dựng thêm một tập song song ở đây là dựng lại
// đúng hạng lỗi vừa vá.
const clients = queue.clients;

term.onData((chunk) => {
  const text = decodeChunk(chunk);
  if (!text) return;
  // Nuôi CẢ HAI: buffer cuộn để trả lời "màn hình đang thế nào", và mouse-mode
  // để biết ứng dụng có đang chờ sự kiện chuột không. tmux trả lời cả hai câu
  // ấy hộ; ConPTY không nói gì cả.
  mouse.feed(text);
  let frame = null;
  try {
    frame = encodeFrame(FRAME.PANE, text);
  } catch {
    // Quá MAX_FRAME. Không thể xảy ra với một mảng byte của ConPTY, nhưng ném ở
    // đây là ném ra giữa callback của node-pty — không ai bắt, chết cả host.
    // Byte vẫn phải vào buffer, nếu không màn hình lệch khỏi thứ pty đã in.
    frame = null;
  }
  queue.feed(text, frame);
});

// --- client ----------------------------------------------------------------

// Kích thước đang áp cho pty. Bắt đầu bằng mặc định, đổi khi có client khai.
let curCols = DEFAULT_COLS;
let curRows = DEFAULT_ROWS;

// MÀN NHỎ NHẤT THẮNG, và HOST tính chứ không phải client.
//
// Hai client tự gọi resize là hai client giẫm lên nhau — trên tmux thì tmux
// chặn hộ bằng `window-size smallest`, ở đây không ai chặn. Dự án cũng đã thử
// hướng ngược lại (`largest`) và hỏng trên máy thật: điện thoại nhận dòng rộng
// gấp năm màn hình, xuống dòng loạn, không đọc nổi.
//
// Client chưa khai kích thước thì KHÔNG tính vào min — một cửa sổ chưa nói gì
// không được phép kéo pty về 0, và cũng không được thay mặt ai đó khai hộ.
function applySize() {
  let cols = 0;
  let rows = 0;
  for (const c of clients) {
    if (!c.cols || !c.rows) continue;
    cols = cols === 0 ? c.cols : Math.min(cols, c.cols);
    rows = rows === 0 ? c.rows : Math.min(rows, c.rows);
  }
  // Chưa ai khai: giữ nguyên. Người xem cuối cùng rời đi cũng rơi vào đây, và
  // giữ nguyên là đúng — phiên vẫn đang chạy với kích thước ấy.
  if (cols === 0 || rows === 0) return;
  if (cols === curCols && rows === curRows) return;
  curCols = cols;
  curRows = rows;
  try { term.resize(cols, rows); } catch { /* pty vừa chết — onExit sẽ dọn */ }
  // Buffer phải đổi theo pty, nếu không ảnh chụp trả về sai hình dạng màn hình.
  //
  // NỐI VÀO CHUỖI, không gọi thẳng: `screen.resize()` đổi lưới NGAY và đồng
  // bộ, trong khi những lượt ghi trước nó còn đang xếp hàng — nghĩa là byte
  // sinh ra ở bề rộng cũ sẽ được trải lại theo bề rộng mới. Kỷ luật mà hàng ghi
  // đòi cho phép ĐỌC còn đúng hơn cho phép SỬA.
  queue.enqueue(() => screen.resize(cols, rows));
}

// So bí mật bằng timingSafeEqual, và chỉ khi độ dài bằng nhau — nó ném khi hai
// buffer khác độ dài, và độ dài thì vốn không phải điều cần giấu.
const SECRET = crypto.randomBytes(32).toString('hex');
function secretMatches(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Khung ĐẦU TIÊN của mỗi client phải là bí mật. Sai — dù sai kiểu khung, sai
// JSON, sai `type`, hay sai chuỗi — thì đóng ngay và không trả lời gì thêm:
// một câu trả lời khác nhau theo kiểu sai là một cái máy dò.
function isAuthFrame(frame) {
  if (frame.kind !== FRAME.CONTROL) return false;
  let msg;
  try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return false; }
  if (!msg || typeof msg !== 'object' || msg.type !== 'auth') return false;
  return secretMatches(msg.secret);
}

function handleFrame(client, frame) {
  if (frame.kind === FRAME.PANE) {
    // Buffer đi thẳng vào pty, KHÔNG qua toString('utf8'). Byte của chuột
    // (X10) không phải UTF-8 hợp lệ, và đổi sang chuỗi rồi ngược lại sẽ biến
    // chúng thành U+FFFD — tức là toạ độ click sai, âm thầm. node-pty đưa
    // thẳng giá trị này cho một net.Socket (terminal.js không kiểm kiểu), nên
    // Buffer qua nguyên vẹn.
    try { term.write(frame.payload); } catch { /* pty vừa chết */ }
    return;
  }
  if (frame.kind !== FRAME.CONTROL) return; // kiểu lạ — bỏ, không đoán
  let msg;
  try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'resize') return; // chưa hiểu — bỏ im lặng
  const { cols, rows } = msg;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
  // `0×0` nghĩa là RÚT LẠI ràng buộc, không phải một kích thước.
  //
  // Vì sao cần: daemon là một client của host, và nó khai kích thước MÀN HÌNH
  // ĐIỆN THOẠI. Khi người dùng đóng trình duyệt, daemon vẫn nối (vì `/remote`
  // vẫn bật) và trước đây vẫn giữ nguyên con số cũ — nên cửa sổ PowerShell trên
  // máy KHÔNG BAO GIỜ rộng trở lại, dù không còn ai xem từ xa. Đó là lỗi người
  // dùng gặp thật.
  //
  // `applySize()` vốn đã bỏ qua client có `cols` rỗng, nên đặt về 0 là vừa đủ:
  // không thêm nhánh nào vào phép tính min, chỉ thêm một đường để nói "đừng
  // tính tôi nữa".
  if (cols === 0 && rows === 0) {
    client.cols = 0;
    client.rows = 0;
    applySize();
    return;
  }
  if (cols < MIN_COLS || cols > MAX_COLS) return;
  if (rows < MIN_ROWS || rows > MAX_ROWS) return;
  client.cols = cols;
  client.rows = rows;
  applySize();
}

const server = net.createServer((sock) => {
  // Một client hỏng không được làm chết host: mọi lỗi ở đây chỉ đóng đúng cái
  // socket ấy.
  sock.on('error', () => sock.destroy());

  const decode = createFrameDecoder();
  // `client` còn null nghĩa là CHƯA xác thực.
  let client = null;
  let closed = false;
  const authTimer = setTimeout(() => { if (!client) sock.destroy(); }, AUTH_TIMEOUT_MS);

  sock.on('data', (chunk) => {
    let frames;
    try {
      frames = decode.push(chunk);
    } catch {
      // pipe-frame.js nói rõ: khung hỏng là hỏng HẲN. Không còn biết ranh giới
      // khung kế tiếp nằm đâu, nên đồng bộ lại là vẽ sai vị trí một cách âm
      // thầm. Bỏ kết nối, để đầu kia nối lại từ đầu.
      sock.destroy();
      return;
    }
    for (const frame of frames) {
      if (!client) {
        if (!isAuthFrame(frame)) { sock.destroy(); return; }
        clearTimeout(authTimer);
        // `send` sống trên chính client vì hàng ghi phát bằng nó, và nó KHÔNG
        // được ném: một socket vừa đứt không được cắt ngang lượt phát của
        // những người xem còn lại.
        client = {
          sock,
          cols: 0,
          rows: 0,
          send(frame) {
            try { sock.write(frame); } catch { /* socket vừa đứt — 'close' sẽ dọn */ }
          },
        };
        attach(client);
        continue;
      }
      handleFrame(client, frame);
    }
  });

  sock.on('close', () => {
    closed = true;
    clearTimeout(authTimer);
    if (!client) return;
    queue.detach(client);
    client = null;
    // Người xem màn hẹp rời đi thì những người còn lại được rộng trở lại.
    applySize();
  });

  // Gắn client đã xác thực vào luồng ra. Toàn bộ nghi thức — chụp theo chuỗi,
  // gửi bù đúng phần thiếu, đăng ký vào tập phát, cả ba trong CÙNG một lượt
  // đồng bộ — nằm trong attach-queue.js, kèm nguyên lý lẽ vì sao nó phải như
  // vậy. Ở đây chỉ còn ba câu trả lời mà riêng host mới biết.
  function attach(c) {
    queue.attach(c, {
      // Socket có thể đã đứt trong lúc chờ ảnh chụp — đăng ký một client đã
      // chết vào tập phát là giữ nó ở đó mãi.
      stillWanted: () => !closed && !sock.destroyed,
      // Client có thể đã kịp khai kích thước trong lúc chờ, lúc nó chưa nằm
      // trong `clients` nên applySize() bỏ qua. Tính lại một lần cho chắc.
      onAttached: applySize,
      // Một lần gắn hỏng chỉ giết đúng client ấy — hành vi 8 cấm một client
      // làm chết host. `queue.attach()` không bao giờ reject, nên lỗi tới đây
      // chứ không thành unhandled rejection.
      onError: (e) => {
        console.error(`[host] gắn client hỏng: ${e && e.message ? e.message : e}`);
        sock.destroy();
      },
    });
  }
});

// --- vòng đời --------------------------------------------------------------

// Tiến trình NÀY đã ghi hồ sơ hay chưa. Chỉ đặt true ngay sau khi writeHost
// thành công, trong callback của listen.
//
// Đây là thứ duy nhất cho phép stop() xoá hồ sơ, và nó là một cái chốt CẤU
// TRÚC chứ không phải một danh sách mã lỗi. Hồ sơ mang tên `<sessionId>.json`
// nhưng KHÔNG nhất thiết là của ta: một host thứ hai cho cùng sessionId sẽ
// hỏng lúc mở pipe, và trên named pipe của Windows lỗi ấy có thể tới dưới dạng
// EADDRINUSE, EACCES hay EPERM tuỳ hoàn cảnh. Nếu điều kiện xoá là "mã lỗi nào
// đó", thì đúng một mã không lường trước sẽ xoá mất hồ sơ của một host ĐANG
// SỐNG, và người dùng mất đường về một phiên vẫn đang chạy. Hỏi "ta đã ghi
// chưa" thì không mã lỗi nào lách qua được.
let profileWritten = false;

let stopping = false;
function stop(reason, code) {
  if (stopping) return;
  stopping = true;
  console.log(`[host] đóng: ${reason}`);
  // Xoá hồ sơ TRƯỚC mọi việc khác: từ giây này trở đi không ai được tìm thấy
  // một phiên đã hết mà nối vào. Nhưng chỉ xoá cái của CHÍNH MÌNH.
  if (profileWritten) removeHost(SESSION_ID, { home: ccrcHome() });
  try { server.close(); } catch { /* chưa nghe bao giờ */ }
  for (const c of clients) { try { c.sock.destroy(); } catch { /* đã đứt */ } }
  clients.clear();
  try { term.kill(); } catch { /* đã chết */ }
  screen.dispose();
  process.exit(code);
}

// Pty chết là phiên hết — giống hệt tmux: một phiên chỉ chạy một lệnh thì lệnh
// xong là hết, không để lại cái vỏ cho lần sau gắn nhầm vào.
term.onExit(({ exitCode }) => stop(`pty thoát (mã ${exitCode})`, 0));

// Trên Windows `process.kill(pid, 'SIGTERM')` bị dịch thành TerminateProcess
// nên hai handler này KHÔNG chạy cho đường đó (spec §7.1 — đó chính là lý do
// `/remote off` phải có đường riêng). Vẫn giữ, cho Ctrl-C và cho những nơi
// signal là thật.
process.on('SIGINT', () => stop('nhận SIGINT', 0));
process.on('SIGTERM', () => stop('nhận SIGTERM', 0));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[host] "${PIPE}" đã có người dùng — nhiều khả năng một host khác`
      + ' đang chạy cho đúng phiên này. Dừng tiến trình cũ rồi thử lại.');
    try { term.kill(); } catch { /* chưa kịp sống */ }
    process.exit(1);
  }
  // Mọi lỗi khác đi qua stop(), để một hồ sơ ĐÃ ghi không bị bỏ lại mồ côi
  // chỉ vào một pipe đã chết. Còn ca "hỏng ngay lúc mở pipe vì host khác đang
  // giữ nó" — có thể tới dưới EACCES/EPERM chứ không riêng EADDRINUSE — được
  // `profileWritten` trong stop() chặn: chưa ghi thì không xoá.
  console.error(`[host] Lỗi pipe: ${err.message}`);
  stop(`lỗi pipe: ${err.message}`, 1);
});

server.listen(PIPE, () => {
  // Hồ sơ được ghi SAU khi pipe đã nghe, không trước. Hồ sơ xuất hiện là lời
  // hứa "nối vào được ngay bây giờ"; ghi trước là hứa sớm, và đầu kia sẽ nối
  // vào một cái tên chưa tồn tại.
  const ok = writeHost({
    sessionId: SESSION_ID,
    pid: process.pid,
    pipe: PIPE,
    // Bí mật này là thứ canh cửa pipe: quyền (DACL) trên pipe do Node tạo KHÔNG
    // đo được — `Get-Acl` trả lỗi 231 — nên không có gì để mà dựa vào ở đó.
    secret: SECRET,
    // cwd KHÔNG BAO GIỜ rời khỏi máy: nó là khoá đối chiếu cục bộ cho hook
    // thông báo, y như trong shared/session-registry.js.
    cwd: CWD,
    createdAt: Date.now(),
  }, { home: ccrcHome() });
  if (!ok) {
    console.error('[host] Không ghi được hồ sơ host — không ai tìm thấy phiên này để nối vào.');
    stop('không ghi được hồ sơ', 1);
    return;
  }
  // Từ đây stop() mới được phép xoá hồ sơ: đây là chỗ duy nhất chứng minh được
  // cái file mang tên phiên này là của tiến trình NÀY.
  profileWritten = true;
  console.log(`[host] phiên ${SESSION_ID}, lệnh ${COMMAND}, pid pty ${term.pid}`);
  console.log(`[host] nghe ${PIPE}`);
});
