#!/usr/bin/env node
// `ccrc-client` — cửa sổ của người ngồi trước máy nhìn vào phiên mà
// `ccrc-host` đang giữ. Nối vào named pipe của host, đổ byte của pty ra
// stdout, đẩy byte gõ vào trở lại pipe. Hết. Không giữ trạng thái, không vẽ
// gì thêm, không quyết định gì thay ai.
//
// Đây là vai `tmux attach-session` đóng trên macOS. Cái mỏng ấy là CHỦ Ý: phiên
// sống trong host, nên đóng cửa sổ này không làm phiên hết, và mở ba cửa sổ
// cùng lúc là ba người cùng nhìn một màn hình.
//
// KHÔNG có rào nền tảng như `ccrc-host.js`. Host phải chặn vì nó nạp node-pty
// và đặt tên `\\.\pipe\...`; file này chỉ có `net` với `process.stdin` — chạy
// được ở đâu thì cũng đúng ở đó. Trên macOS đơn giản là không có hồ sơ host nào
// để tìm, và đường "không tìm thấy phiên" bên dưới đã nói đúng câu cần nói.

import net from 'node:net';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';
import { readHost, hostsDir } from '../src/host-registry.js';
import { ccrcHome } from '../../shared/home.js';

// Lưới an toàn cho lúc thoát: xem `thoat()`. Ngắn hơn mọi hạn chờ trong bộ
// test, dài hơn nhiều so với thời gian xả một bộ đệm stdout bình thường.
const HAN_THOAT_MS = 2000;

const SESSION_ID = process.argv[2] || '';

if (!SESSION_ID) {
  console.error('[client] Cách dùng: ccrc-client <sessionId>');
  process.exit(2);
}

const HOME = ccrcHome();
const ho = readHost(SESSION_ID, { home: HOME });
if (!ho || !ho.pipe || !ho.secret) {
  // Câu này phải nêu CẢ tên phiên LẪN chỗ đã tìm: người dùng gõ nhầm một ký tự
  // và người dùng có một phiên đã chết là hai chuyện khác nhau, và không ai
  // đoán được là chuyện nào nếu câu báo chỉ nói "không thấy".
  console.error(`[client] Không tìm thấy phiên "${SESSION_ID}" — không có hồ sơ host trong ${hostsDir(HOME)}.`);
  console.error('[client] Phiên chưa được mở, hoặc đã kết thúc. `ccrc list` để xem những phiên đang sống.');
  process.exit(1);
}

// --- trả lại terminal --------------------------------------------------------

// Raw mode là thứ DUY NHẤT file này làm với terminal của người dùng mà không tự
// hoàn tác được. Bỏ lại nó là người dùng phải đóng cửa sổ: không còn dòng nào
// được xử lý, nên `reset` gõ vào cũng không chạy.
//
// Nên việc khôi phục KHÔNG được treo vào một đường thoát nào cả. Nó treo vào
// `process.on('exit')` — mắt xích mà mọi đường thoát đều đi qua: return bình
// thường, `process.exit()`, và cả một exception không ai bắt. Hai handler ném
// bên dưới có mặt chỉ để trả terminal về TRƯỚC khi vệt lỗi được in ra; nếu
// thiếu chúng thì vệt lỗi vẫn in, chỉ là in trong raw mode nên xuống dòng
// không về đầu dòng — xấu, chứ không hỏng.
//
// VÌ SAO KHÔNG CÓ BÀI TEST CHO ĐIỀU NÀY, dù nó là chỗ brief gọi là dễ sai nhất.
// Đã thử, và phải bỏ đi: bài viết ra XANH CẢ TRÊN BẢN ĐÃ GỠ HẲN dòng
// `setRawMode(false)` bên dưới. Đo lại bằng `GetConsoleMode` qua P/Invoke, cả
// bốn lượt (bản thật / bản đã phá × có chạy client / không) đều ra đúng một con
// số: `0x01F7`, ECHO và LINE đều bật.
//
// Lý do là libuv gọi `uv_tty_reset_mode()` khi tiến trình thoát, nên trên
// Windows một raw mode bị bỏ quên KHÔNG quan sát được từ bên ngoài chừng nào
// tiến trình còn thoát bình thường. Mà những đường thoát KHÔNG bình thường
// (TerminateProcess) thì cũng chẳng chạy dòng nào của file này.
//
// Nên dòng khôi phục dưới đây là dây an toàn thứ hai, không phải dây duy nhất.
// Giữ nó vì nó là HỢP ĐỒNG được viết ra chứ không phải một chi tiết cài đặt của
// libuv mà ta tình cờ dựa vào, và vì ngày nào client không còn thoát bằng cách
// kết thúc tiến trình nữa thì nó là thứ duy nhất còn đúng. Nhưng đừng ai viết
// một bài test cho nó rồi tin rằng mình vừa canh được cái gì — bài ấy sẽ xanh
// dù code có đúng hay không.
let daBatRaw = false;
let daTraTerminal = false;

function traLaiTerminal() {
  if (daTraTerminal) return;
  daTraTerminal = true;
  if (daBatRaw) {
    daBatRaw = false;
    try { process.stdin.setRawMode(false); } catch { /* stdin vừa mất — không còn gì để trả */ }
  }
  try { process.stdin.pause(); } catch { /* đã đóng */ }
}

process.on('exit', traLaiTerminal);
process.on('uncaughtException', (e) => {
  traLaiTerminal();
  console.error(`[client] lỗi không lường trước: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  traLaiTerminal();
  console.error(`[client] promise hỏng không ai bắt: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

function batRaw() {
  // stdin có thể là một cái ống (bị chuyển hướng, hoặc chạy trong bộ test). Ống
  // không có raw mode, và cũng không cần: nó vốn đã đưa byte thô.
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return;
  try {
    process.stdin.setRawMode(true);
    daBatRaw = true;
  } catch { /* không bật được thì cứ chạy tiếp ở chế độ dòng, còn hơn không chạy */ }
}

// --- nối vào host ------------------------------------------------------------

const sock = net.createConnection(ho.pipe);
const giaiMa = createFrameDecoder();

// Host đã gửi cho ta byte nào chưa. Đây là thứ phân biệt HAI ca đóng kết nối mà
// bản thân cái đóng không phân biệt được — cả hai đều là `sock.destroy()` ở đầu
// bên kia:
//
//   * bí mật sai → host đóng NGAY và cố ý không nói một lời (trả lời khác nhau
//     theo kiểu sai là dựng sẵn một cái máy dò cho người khác);
//   * phiên kết thúc → ta đã xem màn hình một lúc rồi mới mất pipe.
//
// Không có ack trong giao thức để hỏi thẳng, và thêm một cái ack là đổi host —
// ngoài phạm vi task này. "Đã nhận byte nào chưa" là dấu hiệu đúng và rẻ: host
// chỉ phát cho những kết nối ĐÃ xác thực, nên một byte tới là bằng chứng đã
// được nhận vào.
//
// Chiều ngược lại có một khe THẬT: gắn thành công vào một phiên chưa in gì rồi
// mất pipe ngay, và ta báo nhầm là lỗi. Đừng tin vào lời trấn an rằng "khai
// kích thước xong là ConPTY vẽ lại nên kiểu gì cũng có byte" — `applySize()`
// của host RETURN SỚM khi kích thước không đổi, mà `curCols/curRows` khởi đầu
// đúng bằng 80×24, tức là mặc định của console Windows. Ở đúng cái kích thước
// phổ biến nhất thì không có resize, không có vẽ lại, không có byte nào cả.
//
// Nên khe ấy hẹp chứ không đóng, và cái giá của nó là một câu báo sai chỗ chứ
// không phải mất dữ liệu. Vì vậy câu báo ở `close` nêu CẢ HAI khả năng thay vì
// khẳng định một.
let daNhanByte = false;
let dangThoat = false;

function thoat(ma, loi) {
  if (dangThoat) return;
  dangThoat = true;
  traLaiTerminal();
  process.stdin.removeAllListeners('data');
  process.stdout.removeListener('resize', khaiKichThuoc);
  process.removeListener('SIGWINCH', khaiKichThuoc);
  // KHÔNG giết host: đóng cửa sổ chỉ là rời đi, phiên vẫn phải sống tiếp cho
  // lần sau nối lại. Ta chỉ bỏ đúng cái socket của mình.
  try { sock.destroy(); } catch { /* đã đứt */ }
  if (loi) process.stderr.write(`[client] ${loi}\n`);
  // Đặt mã rồi để Node tự thoát, KHÔNG gọi `process.exit()`: trên Windows
  // stdout nối vào một ống là ghi bất đồng bộ, và thoát ngay sẽ cắt cụt đúng
  // những byte cuối của phiên — thứ người dùng vừa nhìn thấy trên màn hình.
  process.exitCode = ma;
  // Lưới an toàn: nếu còn một handle nào đó giữ vòng lặp sống, vẫn phải thoát
  // chứ không treo. `unref` để chính cái hẹn này không phải là thứ giữ tiến
  // trình lại thêm hai giây.
  const hen = setTimeout(() => process.exit(ma), HAN_THOAT_MS);
  if (typeof hen.unref === 'function') hen.unref();
}

// --- khai kích thước ---------------------------------------------------------

// CHỈ KHAI, KHÔNG QUYẾT. Host lấy min trên mọi client rồi mới `resize` pty.
// Client tự resize là hai client giẫm lên nhau: trên macOS tmux chặn hộ bằng
// `window-size smallest`, ở đây không ai chặn — nên cái chặn phải là việc client
// không bao giờ tự làm.
let khaiCuoi = '';

function khaiKichThuoc() {
  if (dangThoat || !sock.writable) return;
  const cot = process.stdout.columns;
  const dong = process.stdout.rows;
  // stdout không phải terminal thì ta KHÔNG có kích thước thật nào để khai, và
  // khai bừa một con số mặc định là thay mặt người dùng kéo pty của người khác
  // về 80×24. Im lặng mới đúng: host bỏ qua những ai chưa khai.
  if (!Number.isInteger(cot) || !Number.isInteger(dong) || cot <= 0 || dong <= 0) return;
  const moi = `${cot}x${dong}`;
  if (moi === khaiCuoi) return;
  khaiCuoi = moi;
  guiDieuKhien({ type: 'resize', cols: cot, rows: dong });
}

function guiDieuKhien(msg) {
  try {
    sock.write(encodeFrame(FRAME.CONTROL, JSON.stringify(msg)));
  } catch { /* socket vừa đứt — 'close' sẽ dọn */ }
}

// --- vòng đời ----------------------------------------------------------------

sock.on('connect', () => {
  // Khung ĐẦU TIÊN phải là bí mật — host đóng ngay mọi kết nối mở đầu bằng thứ
  // khác. Mọi lời gửi sau đây đều nằm sau nó trên cùng một socket, nên thứ tự
  // được bảo đảm mà không cần chờ ack.
  guiDieuKhien({ type: 'auth', secret: ho.secret });
  khaiKichThuoc();

  batRaw();
  process.stdin.on('data', (buf) => {
    if (dangThoat || !sock.writable) return;
    // Buffer đi thẳng vào khung, KHÔNG qua `toString`. Byte của chuột và của
    // phím nóng không phải UTF-8 hợp lệ, và một vòng chuyển sang chuỗi rồi
    // ngược lại biến chúng thành U+FFFD — tức là gõ sai một cách âm thầm.
    try {
      sock.write(encodeFrame(FRAME.PANE, buf));
    } catch { /* vượt MAX_FRAME là không thể với một lượt gõ; socket đứt thì 'close' dọn */ }
  });
  process.stdin.on('error', () => { /* stdin đóng không phải lý do để bỏ màn hình */ });
  process.stdin.resume();

  // Hai nguồn cho cùng một sự kiện, và cả hai đều vô hại nhờ dedupe trong
  // `khaiKichThuoc`: `resize` của stdout là đường chính thức, còn SIGWINCH là
  // đường mà Node dựng `resize` ở trên — nghe cả hai để không phụ thuộc vào
  // việc bản Node nào nối chúng lại với nhau ra sao.
  process.stdout.on('resize', khaiKichThuoc);
  process.on('SIGWINCH', khaiKichThuoc);
});

sock.on('data', (chunk) => {
  daNhanByte = true;
  let khung;
  try {
    khung = giaiMa.push(chunk);
  } catch (e) {
    // pipe-frame.js nói rõ: khung hỏng là hỏng HẲN. Không còn biết ranh giới
    // khung kế tiếp nằm đâu, nên đồng bộ lại chỉ là vẽ sai vị trí một cách âm
    // thầm. Bỏ kết nối, không bao giờ bơm tiếp.
    thoat(1, `luồng khung hỏng: ${e && e.message ? e.message : e}`);
    return;
  }
  for (const f of khung) {
    // Kiểu khác PANE là điều khiển từ host, mà host hôm nay chưa gửi gì cả. Bỏ
    // im lặng chứ không đoán: vẽ một khung điều khiển ra lưới là đổ JSON lên
    // màn hình của người dùng — đúng cái lỗi mà quy ước khung sinh ra để tránh.
    if (f.kind !== FRAME.PANE) continue;
    process.stdout.write(f.payload);
  }
});

sock.on('error', (e) => {
  // ĐÃ GẮN RỒI thì mọi lỗi socket đều là "phiên hết", không phải "client hỏng".
  //
  // Cụ thể là một cuộc đua có thật, không phải giả thuyết: `sock.writable` chỉ
  // thành false khi đầu NÀY biết đầu kia đã đi, mà nó biết muộn hơn lúc đầu kia
  // thực sự đóng. Người dùng gõ một phím đúng trong khe ấy → `write` hỏng
  // EPIPE → 'error' bắn TRƯỚC 'close'. Không có nhánh này thì một phím lạc làm
  // client thoát 1 và in `lỗi pipe: write EPIPE` đè lên khung cuối của phiên,
  // trong khi hành vi 6 nói pipe đóng là thoát 0. Lời khai kích thước cũng rơi
  // vào đúng khe đó.
  //
  // Nuốt như thế KHÔNG che mất lỗi thật sau khi gắn: khung hỏng có đường thoát
  // riêng của nó ở chỗ bắt lỗi của bộ giải mã, và nó thoát khác 0.
  if (daNhanByte) { thoat(0, null); return; }
  // Chưa gắn được: pipe biến mất giữa lúc đọc hồ sơ và lúc nối, host vừa tắt.
  // Nói thẳng, đừng để người dùng đọc một mã lỗi trần.
  const ly = e && e.code === 'ENOENT'
    ? `phiên "${SESSION_ID}" có hồ sơ nhưng pipe đã biến mất — host vừa tắt. Hồ sơ sẽ được dọn ở lần \`ccrc list\` kế tiếp.`
    : `lỗi pipe: ${e && e.message ? e.message : e}`;
  thoat(1, ly);
});

sock.on('close', () => {
  if (daNhanByte) {
    // Phiên kết thúc — không phải lỗi, và KHÔNG in gì thêm: dòng cuối cùng
    // người dùng thấy phải là màn hình của phiên.
    thoat(0, null);
    return;
  }
  thoat(1, `host đóng kết nối trước khi gửi gì cho phiên "${SESSION_ID}".`
    + ' Hoặc hồ sơ mang một bí mật cũ (host đã khởi động lại kể từ lần ghi ấy),'
    + ' hoặc phiên vừa kết thúc đúng lúc ta nối vào. `ccrc list` cho biết là ca nào.');
});

// stdout gãy (người dùng đóng đầu kia của một ống) thì không còn chỗ nào để vẽ.
// Đó là kết thúc bình thường, không phải lỗi của phiên.
process.stdout.on('error', () => thoat(0, null));

// Ctrl+C KHÔNG được giết client. Đây là chỗ khác một CLI thường nhất trong cả
// file, và sai ở đây thì client trông như hỏng còn lỗi thì trông như của host.
//
// Người dùng đang gõ vào Claude Code, không gõ vào chương trình này: 0x03 là
// một byte của phiên, phải đi tới pty y như mọi byte khác.
//
// ĐO ĐƯỢC, không phải suy ra: một tiến trình Node đặt stdin raw mode bên trong
// một ConPTY, khi nhận Ctrl+C, thấy `data` = [3] và KHÔNG hề thấy SIGINT. Raw
// mode tắt ENABLE_PROCESSED_INPUT, nên console không sinh sự kiện điều khiển
// nữa — byte đi thẳng, đúng đường qua listener `data` ở trên.
//
// Handler rỗng này vì vậy chỉ bịt một đường CÒN LẠI: nơi nào SIGINT vẫn được
// bắn (stdin không phải TTY nên không bật được raw mode, hoặc một nền tảng
// dựng nó theo cách khác), hành vi mặc định của Node là giết tiến trình — và
// người dùng mất cửa sổ vì đã bấm một phím lẽ ra chỉ để ngắt Claude.
//
// Cố ý KHÔNG tự bơm 0x03 vào pipe trong handler này: nếu byte cũng tới qua
// stdin thì phiên nhận HAI lần ngắt cho một lần bấm.
process.on('SIGINT', () => { /* nuốt — xem trên */ });

// SIGTERM/SIGHUP thì khác hẳn: đó là "cửa sổ này phải đi", không phải một phím
// người dùng bấm. Đi cho đàng hoàng — trả terminal, để host sống tiếp.
process.on('SIGTERM', () => thoat(0, null));
process.on('SIGHUP', () => thoat(0, null));

// SIGBREAK là Ctrl+Break trên Windows. KHÔNG phải Ctrl+C: nó không phải một
// byte của phiên, nó là "dừng chương trình này lại" — nên đi cho đàng hoàng chứ
// không nuốt.
//
// Điều phải bịt ở đây là hành vi MẶC ĐỊNH khi không ai nghe: Node để hệ điều
// hành giết tiến trình, và một tiến trình bị giết không chạy handler `exit`,
// nên raw mode không được trả lại — console của shell cha ở lại chế độ thô, mà
// đó đúng là hạng lỗi cả file này dựng ra để tránh. Có listener thì Node chạy
// nó thay vì chết ngay, và `thoat()` mới có cơ hội dọn.
//
// SUY RA, KHÔNG PHẢI ĐO ĐƯỢC: Ctrl+Break đòi một console tương tác thật nên
// không dựng lại được qua SSH. Một dòng này rẻ và không có mặt trái — nó chỉ
// biến một đường chết đột ngột thành đường thoát đã dọn.
process.on('SIGBREAK', () => thoat(0, null));
