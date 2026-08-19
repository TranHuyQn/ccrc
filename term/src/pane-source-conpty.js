// Nguồn pane cho Windows: cùng hình dạng với `createTmuxPaneSource`, nhưng
// phía sau là một `ccrc-host` đang giữ ConPTY và một named pipe, chứ không
// phải tmux.
//
// VÌ SAO PHẢI TỰ NUÔI MỘT BẢN SAO MÀN HÌNH.
//
// Interface trong pane-source.js là ĐỒNG BỘ: `snapshot()` trả về chuỗi, không
// trả về Promise. Trên tmux điều đó rẻ — `capture-pane` là một lời hỏi cục bộ
// có ngay câu trả lời. Qua một cái ống thì mọi câu hỏi đều bất đồng bộ, và đổi
// interface thành async nghĩa là sửa `ccrc-term.js`, tức là đụng vào đường
// macOS — thứ nhánh này không được phép làm.
//
// Nên bản này lật ngược bài toán: thay vì HỎI host mỗi lần, nó nuôi sẵn một
// terminal trong bộ nhớ từ chính dòng byte mà nó vẫn nhận, bằng
// `screen-buffer.js` và `mouse-mode.js` — đúng hai mảnh mà host cũng dùng. Mọi
// lời đọc vì thế thành cục bộ và đồng bộ, và host KHÔNG cần thêm một verb nào
// (`snapshot`/`history`/`mouseMode` cố ý không tồn tại trong giao thức pipe).
//
// MỘT ỐNG CHO CẢ NGUỒN, KHÔNG PHẢI MỘT ỐNG MỖI KẾT NỐI. Đây là khác biệt kiến
// trúc lớn nhất so với bản tmux, và nó bắt buộc chứ không phải sở thích: bản
// sao màn hình chỉ đúng khi nó được nuôi bởi ĐÚNG MỘT dòng byte. Hai socket
// cùng nhận cùng nội dung mà cùng đổ vào một buffer là chữ vẽ hai lần; đổi
// người nuôi giữa chừng (socket A chết, cho B nuôi tiếp) còn tệ hơn — hai
// socket không bao giờ ở cùng một vị trí trong dòng, nên chỗ nối sẽ lặp hoặc
// nuốt một đoạn, im lặng. Vì vậy: một ống, fan-out ra các kết nối.
//
// Cái mất khi gộp ống là host chỉ còn thấy MỘT client, nên phép "màn nhỏ nhất
// thắng" của nó không còn phân biệt được hai trình duyệt của ta. Nên phép ấy
// được dựng lại ở đây (capNhatKichThuoc), bằng đúng luật host dùng: client
// chưa khai kích thước thì không tính, và không ai khai thì giữ nguyên.
//
// BẢN SAO LUÔN ĐI SAU MỘT NHỊP, VÀ LỜI ĐỌC KHÔNG XẾP HÀNG SAU LƯỢT GHI.
//
// `screen.write()` bất đồng bộ, mà `snapshot()` phải trả lời ngay — nên nó
// KHÔNG THỂ đứng sau hàng ghi như `attach-queue.js` bên host làm. Đo được trên
// chính `screen-buffer.js`, sau khi nối một lượt ghi vào chuỗi:
//
//     ngay sau enqueue: false
//     sau setImmediate: false      ← qua trọn một pha check vẫn chưa áp dụng
//     sau setTimeout 0: true
//
// Tức là cửa sổ rộng TRỌN MỘT LƯỢT MACROTASK. Mà sự kiện `connection` của
// WebSocket cũng là một macrotask I/O, nên nó rơi vào đúng cửa sổ ấy mỗi khi
// terminal đang chảy chữ — banner khởi động, một câu trả lời đang in. Tức là ca
// thường gặp, không phải ca hiếm:
//
//     t0  nạp T vào hàng ghi (chưa áp dụng)
//     t0  phát T cho những kết nối ĐANG có
//     t1  kết nối mới tới → snapshot() chưa thấy T → attach() thêm conn2
//         → T được áp dụng sau đó, nhưng conn2 KHÔNG BAO GIỜ nhận được T
//
// Nói "những byte ấy vừa gửi thẳng cho trình duyệt qua onData rồi" chỉ đúng với
// các kết nối ĐÃ CÓ. Kẻ hở nằm đúng ở kết nối đang gắn — mà gắn lại chính là
// lúc `snapshot()` được gọi. Đây đúng hạng lỗi mà `attach-queue.js` được tách
// ra thành module riêng để chống, và nó sống sót qua trọn một vòng review ở đó.
//
// Nên cách bịt cũng lấy nguyên ý ấy, thu nhỏ lại cho vừa: mọi mảng byte có lượt
// ghi CHƯA xong nằm trong `dangCho`, và `attach()` gửi bù cả `dangCho` cho kết
// nối mới NGAY SAU khi thêm nó vào tập phát. Không thể gửi trùng: theo định
// nghĩa, kết nối ấy chưa nằm trong tập lúc những mảng đó được phát đi.
//
// ĐIỀU KIỆN để phép này đúng: người gọi phải hỏi `snapshot()` và gọi `attach()`
// TRONG CÙNG MỘT LƯỢT ĐỒNG BỘ. `ccrc-term.js` làm đúng vậy (cả hai nằm trong
// cùng một handler `connection`, không có `await` nào ở giữa). Ai chèn một
// `await` vào giữa hai lời gọi ấy sẽ mở lại đúng khe này ở chiều ngược lại:
// một mảng vừa áp dụng xong sẽ rời `dangCho` mà ảnh chụp cũ thì chưa có nó.
//
// Phần còn lại của độ trễ vẫn thật và không sửa được: `historySize()`/
// `history()` có thể thiếu mảng byte mới nhất trong đúng cửa sổ ấy. Trên tmux
// không có độ trễ này — hai nền tảng KHÔNG tương đương ở đây.

import net from 'node:net';
import { readHost } from './host-registry.js';
import { FRAME, encodeFrame, createFrameDecoder } from './pipe-frame.js';
import { createScreenBuffer } from './screen-buffer.js';
import { createMouseMode } from './mouse-mode.js';

// Nhịp nghỉ giữa nội dung dán và cú Enter kết thúc nó — cùng con số, cùng lý
// do với bản tmux: đủ để TUI phía kia đọc xong đoạn dán trong một lượt riêng.
const COMMIT_DELAY_MS = 30;

// Trần cho một lượt dán. Bản tmux có trần vì `load-buffer` là một tiến trình
// con có thể treo; ở đây cái treo được là lượt xả của socket. Cùng hậu quả nếu
// không có trần: hàng đợi gõ phím của kết nối ấy chết câm, không một lời báo.
const PASTE_TIMEOUT_MS = 5000;

// Cùng 10.000 dòng mà host giữ (xem ccrc-host.js). Bản sao ngắn hơn host là
// người dùng cuộn ngược tới một khoảng trống mà phiên thật vẫn còn giữ.
const SCROLLBACK = 10_000;

// Kích thước lúc chưa kết nối nào khai. Đúng bằng mặc định của host, để bản
// sao và pty khởi đầu trên cùng một lưới.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// Khoảng nghỉ tối thiểu giữa hai lần thử nối lại ống. Mọi lời đọc đều gọi
// baoDamOng(), nên một host đã chết mà không có nhịp nghỉ là một cơn bão
// connect mỗi lần trình duyệt hỏi lịch sử.
const RETRY_MS = 1000;

// "Còn sống" theo đúng luật host-registry.js dùng: ESRCH mới là đã chết, EPERM
// nghĩa là tiến trình CÓ THẬT nhưng của người dùng khác.
function pidSong(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

export function createConptyPaneSource({ sessionId, home }) {
  const hoSo = () => readHost(sessionId, { home });

  const screen = createScreenBuffer({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: SCROLLBACK });
  const mouse = createMouseMode();

  // Hàng ghi của bản sao. Cùng kỷ luật với attach-queue.js trong host:
  // `screen.resize()` đổi lưới NGAY và đồng bộ, nên gọi thẳng nó trong khi
  // những lượt ghi trước còn xếp hàng là đem byte viết ở bề rộng cũ trải lại
  // theo bề rộng mới.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); };

  // Những mảng byte đã phát đi mà lượt ghi vào bản sao CHƯA xong. Đây là thứ
  // duy nhất giữ cho một kết nối gắn vào giữa cửa sổ macrotask ấy không mất
  // chữ — xem đoạn dài ở đầu file. Rời khỏi đây ngay khi lượt ghi xong, kể cả
  // khi nó hỏng: một mảng bị bỏ quên trong này là mọi kết nối về sau đều được
  // gửi bù một đoạn đã nằm sẵn trong ảnh chụp, tức là chữ vẽ hai lần.
  const dangCho = new Set();

  // Nạp một mảng byte: vào hàng ghi TRƯỚC, phát cho các kết nối SAU. Hai việc
  // này nằm trong cùng một hàm chứ không rải ra hai chỗ, vì thứ tự của chúng là
  // bất biến chứ không phải sở thích — phát trước khi kịp vào `dangCho` là mở
  // lại đúng khe mất chữ ở trên.
  function napVaPhat(text) {
    const muc = { text };
    dangCho.add(muc);
    chain = chain
      .then(() => screen.write(text))
      .then(() => { dangCho.delete(muc); })
      .catch(() => { dangCho.delete(muc); });
    mouse.feed(text);
    // Chụp tập kết nối TRƯỚC vòng lặp: một `onData` có thể gắn thêm kết nối
    // ngay trong lượt này (và kết nối ấy đã được gửi bù `dangCho` rồi), nên
    // lặp trên tập đang đổi là gửi trùng đúng mảng vừa gửi bù.
    for (const c of [...conns]) c.baoData(text);
  }

  // Giải mã UTF-8 CÓ NHỚ TRẠNG THÁI — cùng lý do host và control-stream.js
  // dùng: một ký tự nhiều byte bị cắt ngang hai lần đọc mà decode riêng từng
  // mảng sẽ thành U+FFFD, và người dùng thấy chữ Việt vỡ ra. Hôm nay host
  // đóng khung theo từng chuỗi đã decode nên khe ấy hẹp, nhưng đó là chi tiết
  // cài đặt của đầu kia, không phải lời hứa của giao thức.
  const decoder = new TextDecoder('utf-8');

  let sock = null;
  let giaiMa = null;
  let lanThuCuoi = 0;
  // Kích thước ta ĐÃ khai với host. Giữ lại để không khai lại y hệt.
  let khaiCols = 0;
  let khaiRows = 0;

  const conns = new Set();

  function alive() {
    const h = hoSo();
    return !!(h && pidSong(h.pid));
  }

  // Kích thước khai với host = nhỏ nhất trên các kết nối ĐÃ khai. Bản sao đổi
  // lưới theo đúng con số ấy.
  //
  // Một chỗ không khớp được, và ghi ra để không ai tưởng là bug: nếu người
  // ngồi trước máy đang mở một `ccrc-client` hẹp hơn, host lấy min với cả cửa
  // sổ ấy, nên pty hẹp hơn bản sao của ta và những dòng dài sẽ xuống dòng ở
  // chỗ khác. Giao thức pipe không có đường để host nói lại kích thước thật;
  // thêm một verb cho việc đó là đổi host, ngoài phạm vi task này.
  function capNhatKichThuoc() {
    let cols = 0;
    let rows = 0;
    for (const c of conns) {
      if (!c.cols || !c.rows) continue;
      cols = cols === 0 ? c.cols : Math.min(cols, c.cols);
      rows = rows === 0 ? c.rows : Math.min(rows, c.rows);
    }
    // KHÔNG CÒN AI XEM: rút lại ràng buộc thay vì giữ con số cũ.
    //
    // Chỗ này từng `return` và giữ nguyên, sao chép lý lẽ của `applySize()` bên
    // host. Lý lẽ ấy ĐÚNG cho host — phiên vẫn chạy, giữ kích thước là phải —
    // nhưng SAI cho adapter, vì adapter không phải người cuối cùng: nó là một
    // client của host, và bên cạnh nó còn cửa sổ `ccrc-client` người dùng đang
    // ngồi trước. Giữ con số cũ nghĩa là mãi mãi ép pty theo màn hình một chiếc
    // điện thoại đã đóng trình duyệt từ lâu — cửa sổ PowerShell không bao giờ
    // rộng trở lại. Đó là lỗi người dùng gặp thật, không phải giả định.
    //
    // `0×0` là verb rút-lại của host (xem handleControl). Vẫn gửi qua chốt
    // `khaiCols/khaiRows` bên dưới nên không spam khi đã rút rồi.
    if (cols === 0 || rows === 0) {
      if (khaiCols === 0 && khaiRows === 0) return;
      khaiCols = 0;
      khaiRows = 0;
      ghiKhung(FRAME.CONTROL, JSON.stringify({ type: 'resize', cols: 0, rows: 0 }));
      // KHÔNG đụng `screen`: bản sao giữ nguyên lưới cũ. Không còn ai xem thì
      // không có gì để vẽ lại, và co bản sao về 0 là làm hỏng ảnh chụp mà người
      // xem tiếp theo sẽ nhận.
      return;
    }
    if (cols === khaiCols && rows === khaiRows) return;
    khaiCols = cols;
    khaiRows = rows;
    ghiKhung(FRAME.CONTROL, JSON.stringify({ type: 'resize', cols, rows }));
    enqueue(() => screen.resize(cols, rows));
  }

  // Ghi một khung ra ống. Trả false khi không ghi được — người gọi nào cần
  // biết thì hỏi, người gọi nào không cần (gõ phím, chuột) thì im lặng bỏ, y
  // như bản tmux ghi vào stdin của một tiến trình vừa chết.
  function ghiKhung(kind, payload, cb) {
    if (!sock || sock.destroyed) {
      if (cb) cb(new Error('ống tới host đã đứt'));
      return false;
    }
    let khung;
    try {
      khung = encodeFrame(kind, payload);
    } catch (e) {
      if (cb) cb(e);
      return false;
    }
    try {
      sock.write(khung, cb);
      return true;
    } catch (e) {
      if (cb) cb(e);
      return false;
    }
  }

  // Ống đứt. QUYẾT ĐỊNH fatal PHẢI XONG TRƯỚC KHI ĐỤNG VÀO SOCKET và trước khi
  // ai đó ở tầng trên đóng WebSocket — dự án đã ship đúng lỗi ngược thứ tự này
  // một lần: đóng bằng mã "trục trặc" trước rồi mới kết luận "phiên hết" thì
  // mã đầu thắng, và trình duyệt nối lại vô hạn vào một phiên không còn nữa.
  //
  //   hồ sơ còn + pid còn sống → fatal:false. Chỉ đường tiếp sức này mất; phiên
  //                              vẫn sống, trình duyệt nối lại là được.
  //   hồ sơ mất hoặc pid chết  → fatal:true. Phiên hết thật.
  function ongDut(reason) {
    const fatal = !alive();
    const cu = sock;
    sock = null;
    giaiMa = null;
    khaiCols = 0;
    khaiRows = 0;
    if (cu) { try { cu.destroy(); } catch { /* đã đứt */ } }
    for (const c of [...conns]) c.baoGone(fatal, reason);
  }

  // Bảo đảm có ống tới host. Gọi từ MỌI lời đọc, không chỉ từ attach(): một
  // bản sao ngừng được nuôi mà vẫn trả lời như thường là hạng lỗi tệ nhất ở
  // đây — màn hình đứng im, không ai báo gì cả.
  function baoDamOng() {
    if (sock && !sock.destroyed) return { ok: true };
    const now = Date.now();
    if (now - lanThuCuoi < RETRY_MS) return { ok: false, message: 'chưa nối lại được ống tới phiên Windows' };
    lanThuCuoi = now;

    const h = hoSo();
    if (!h || !h.pipe || !h.secret) return { ok: false, message: `không tìm thấy hồ sơ host cho phiên "${sessionId}"` };
    if (!pidSong(h.pid)) return { ok: false, message: `phiên "${sessionId}" đã kết thúc` };

    const s = net.createConnection(h.pipe);
    const dec = createFrameDecoder();
    sock = s;
    giaiMa = dec;
    // Ống này KHÔNG phải lý do để tiến trình sống tiếp: daemon đã có server
    // HTTP giữ vòng lặp, còn trong bộ test một socket ref sẽ treo cả lượt chạy.
    if (typeof s.unref === 'function') s.unref();

    // Khung ĐẦU TIÊN phải là bí mật, và nó được ghi NGAY BÂY GIỜ chứ không đợi
    // sự kiện 'connect': net.Socket đệm mọi lượt ghi trước lúc nối xong, nên
    // một `type()` gọi sớm sẽ chen lên trước lời chào nếu lời chào còn nằm
    // trong callback. Host đóng ngay mọi kết nối mở đầu bằng thứ khác bí mật —
    // và đóng câm, đúng như thiết kế, nên lỗi ấy sẽ không tự nói ra là gì.
    try {
      s.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret: h.secret })));
    } catch { /* 'error' bên dưới lo */ }

    s.on('data', (chunk) => {
      if (s !== sock) return; // ống cũ vừa bị thay — byte của nó không còn nghĩa gì
      let khung;
      try {
        khung = dec.push(chunk);
      } catch (e) {
        // pipe-frame.js nói rõ: khung hỏng là hỏng HẲN, không đồng bộ lại được.
        ongDut(`luồng khung hỏng: ${e && e.message ? e.message : e}`);
        return;
      }
      for (const f of khung) {
        // Khung điều khiển từ host: hôm nay host chưa gửi cái nào. Bỏ im lặng
        // chứ không đoán — đúng như ccrc-client làm.
        if (f.kind !== FRAME.PANE) continue;
        const text = decoder.decode(f.payload, { stream: true });
        if (!text) continue;
        napVaPhat(text);
      }
    });

    s.on('error', (e) => {
      if (s !== sock) return;
      ongDut(`lỗi ống tới host: ${e && e.message ? e.message : e}`);
    });
    s.on('close', () => {
      if (s !== sock) return;
      ongDut('ống tới host đã đóng');
    });

    return { ok: true };
  }

  const doc = {
    alive,

    // Ba câu hỏi về màn hình, trả lời từ bản sao cục bộ. Xem ghi chú đầu file
    // về độ trễ một nhịp so với tmux.
    snapshot() {
      baoDamOng();
      return screen.snapshot();
    },
    // LỊCH SỬ CHỈ CÓ TỪ LÚC ỐNG ĐƯỢC MỞ, không xa hơn. Ảnh chụp mà host gửi
    // lúc gắn là MÀN HÌNH ĐANG HIỆN, không bao giờ là 10.000 dòng cuộn mà host
    // đang giữ — giao thức pipe không có verb để xin phần ấy. Nên một điện
    // thoại nối vào một phiên Windows đã chạy vài tiếng chỉ cuộn ngược được tới
    // lúc daemon mở ống. Trên tmux, `capture-pane -S` lấy được toàn bộ lịch sử
    // của pane bất kể daemon mới chạy hay chạy từ hôm qua. Đây là khác biệt
    // hành vi thật giữa hai nền tảng, không phải một chi tiết cài đặt.
    historySize() {
      baoDamOng();
      return screen.historySize();
    },
    history(offset, rows) {
      baoDamOng();
      return screen.history(offset, rows);
    },
    mouseMode() {
      baoDamOng();
      return mouse.state();
    },

    // Hai thứ này KHÔNG phải để vẽ ra màn hình — chúng là khoá đối chiếu cục
    // bộ của sổ tra phiên, y như bên tmux. cwd() không bao giờ rời khỏi máy.
    // `socket()` bên tmux là đường tới tmux server; ở đây thứ tương đương là
    // tên named pipe của host.
    cwd() {
      const h = hoSo();
      return h && typeof h.cwd === 'string' ? h.cwd : '';
    },
    socket() {
      const h = hoSo();
      return h && typeof h.pipe === 'string' ? h.pipe : '';
    },
  };

  return {
    ...doc,

    // `onCtlReply` được nhận cho đúng hợp đồng nhưng KHÔNG BAO GIỜ được gọi:
    // giao thức pipe không có kênh trả lời. tmux đáp lại từng lệnh, nên bên đó
    // một lệnh bị từ chối tới được người dùng thành `ccrc_loi`; ở đây thứ duy
    // nhất báo được là lượt dán (qua onErr) và cái chết của ống (qua onGone).
    attach({ onData, onCtlReply, onGone }) {
      void onCtlReply;
      if (!alive()) return { ok: false, message: `phiên "${sessionId}" không còn` };
      const ong = baoDamOng();
      if (!ong.ok) return ong;

      let dong = false;
      // Nối tiếp, không song song, và DÙNG CHUNG giữa type và paste: một cú
      // Enter của thanh phím chen vào giữa đoạn dán sẽ gửi đi nửa tin nhắn.
      let typeQueue = Promise.resolve();

      const conn = {
        cols: 0,
        rows: 0,

        // Hai đường vào từ ống dùng chung. Không phải API cho người ngoài —
        // chỉ là chỗ nguồn gọi ngược lại từng kết nối.
        baoData(text) {
          if (dong) return;
          try { onData(text); } catch { /* một kết nối hỏng không được cắt ngang những cái khác */ }
        },
        baoGone(fatal, reason) {
          if (dong) return;
          try { onGone({ fatal, reason }); } catch { /* như trên */ }
        },

        type(data) {
          if (dong) return;
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
          if (bytes.length === 0) return;
          // KHÔNG đi qua splitForSendKeys: việc cắt nhỏ bên tmux là để tránh
          // tràn parser của `send-keys` (12000 byte là %error), một giới hạn
          // của tmux chứ không phải của pty. Ống này nhận tới MAX_FRAME.
          typeQueue = typeQueue.then(() => { ghiKhung(FRAME.PANE, bytes); }).catch(() => {});
        },

        // ACK Ở ĐÂY YẾU HƠN TMUX, VÀ PHẢI ĐỌC LÀ YẾU HƠN.
        //
        // Bên tmux, `onAck` chỉ chạy sau khi tmux đã XÁC NHẬN cả `paste-buffer`
        // lẫn cú Enter — tức là đã có bằng chứng lệnh tới được pane. Giao thức
        // pipe không có lời đáp nào cả, nên tín hiệu tốt nhất còn lại là
        // callback của `socket.write`: "hệ điều hành đã nhận số byte này". Nó
        // KHÔNG chứng minh host đã đọc, càng không chứng minh pty đã in.
        //
        // Hậu quả nhìn thấy được: ô soạn trên điện thoại trống đi SỚM HƠN MỘT
        // NHỊP so với macOS, và trong một khe hẹp (host chết ngay sau khi ta xả
        // xong byte) nó trống đi cho một tin nhắn chưa từng tới nơi. Đừng ai
        // đọc hai nhánh này rồi tưởng chúng tương đương.
        //
        // Cũng KHÔNG có bracketed paste ở đây — nhưng ĐỪNG đọc thành "macOS an
        // toàn hơn". Bên tmux, `paste-buffer -p` bọc dấu KHI VÀ CHỈ KHI ứng
        // dụng đã xin `?2004`; không ai xin thì tmux cũng gửi chữ thô y hệt
        // đường này. Mà trong cấu hình đang ship thì KHÔNG AI XIN: `cmd.exe`
        // không bật 2004, PowerShell/PSReadLine không bật, Claude Code không
        // bật (đo được: 0 lần trong bản 2.1.233). Hai nền tảng vì thế hành xử
        // GIỐNG HỆT nhau hôm nay.
        //
        // Khe chỉ mở ra khi `CCRC_HOST_COMMAND` trỏ vào một thứ CÓ bật 2004 —
        // bash trong WSL, bash của Git for Windows, hay một REPL kiểu
        // python/node — vì ở đó tmux sẽ bọc dấu còn đường này thì không, và
        // một đoạn dán nhiều dòng biến thành mỗi dòng một lệnh. Muốn đóng thì phải tự theo dõi `?2004` (mouse-mode
        // .js chỉ theo dõi 1000/1002/1003/1006), chứ không đoán hộ ai.
        paste(text, { onAck, onErr }) {
          if (dong) return;
          const bytes = Buffer.from(text, 'utf8');
          if (bytes.length === 0) return;
          typeQueue = typeQueue.then(() => new Promise((resolve) => {
            // Một lượt dán chỉ được kết thúc ĐÚNG MỘT LẦN: hết giờ và lỗi ghi
            // có thể tới cùng lúc, và người dùng nhận hai thông báo thì cái
            // thứ hai vô nghĩa.
            let xong = false;
            let treo = null;
            const finish = () => {
              if (xong) return false;
              xong = true;
              clearTimeout(treo);
              resolve();
              return true;
            };
            const fail = (why) => {
              // Im lặng ở đây nghĩa là ô soạn phía người dùng vẫn trống đi như
              // đã gửi, còn tin nhắn thì chưa từng tồn tại.
              if (!finish()) return;
              onErr(`không dán được: ${why}`);
            };
            treo = setTimeout(() => fail('ống tới host không xả kịp'), PASTE_TIMEOUT_MS);
            if (typeof treo.unref === 'function') treo.unref();

            ghiKhung(FRAME.PANE, bytes, (err) => {
              if (xong) return;
              if (err) return fail(String(err && err.message ? err.message : err).slice(0, 120));
              // Nhịp nghỉ trước cú Enter, cùng lý do với bản tmux: để TUI phía
              // kia đọc xong đoạn dán trong một lượt riêng.
              const hen = setTimeout(() => {
                if (xong) return;
                ghiKhung(FRAME.PANE, Buffer.from([0x0d]), (err2) => {
                  if (xong) return;
                  if (err2) return fail(String(err2 && err2.message ? err2.message : err2).slice(0, 120));
                  // `finish()` TRƯỚC `onAck()`: onAck là code của người gọi.
                  // Ném ở đó mà lượt dán chưa được chốt thì promise không bao
                  // giờ resolve, hàng đợi gõ phím của kết nối ấy kẹt luôn, và
                  // 5 giây sau cái trần bắn `fail()` — người dùng nhận CẢ ack
                  // LẪN một câu báo lỗi cho cùng một tin nhắn. Người gọi hôm
                  // nay bọc `ws.send` nên không ném; đổi thứ tự thì nó không
                  // ném được nữa, kể cả ngày mai.
                  finish();
                  // Byte đã ra khỏi tiến trình này — thứ mạnh nhất đường này có.
                  onAck();
                });
              }, COMMIT_DELAY_MS);
              if (typeof hen.unref === 'function') hen.unref();
            });
          })).catch(() => {});
        },

        // Chuột đi TẮT qua typeQueue, đúng như bản tmux: một cú chạm xếp sau
        // một lượt dán đang treo sẽ phải chờ tới PASTE_TIMEOUT_MS trong ca xấu
        // nhất, và một cái chạm ngón tay trễ 5 giây là hành vi khác.
        mouse(bytes) {
          if (dong) return;
          ghiKhung(FRAME.PANE, Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'binary'));
        },

        resize(cols, rows) {
          if (dong) return;
          if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
          if (cols < 1 || rows < 1) return;
          conn.cols = cols;
          conn.rows = rows;
          capNhatKichThuoc();
        },

        // KHÔNG đóng ống dùng chung và KHÔNG giết host: đóng một cửa sổ chỉ là
        // rời đi. Bản sao phải được nuôi tiếp kể cả lúc không còn ai xem —
        // ngừng nuôi là lần sau người dùng mở lại thấy một màn hình đông cứng ở
        // quá khứ, và mất sạch phần lịch sử của quãng vắng mặt. Bên tmux, tmux
        // giữ lịch sử ấy hộ; ở đây không ai giữ hộ cả.
        close() {
          if (dong) return;
          dong = true;
          conns.delete(conn);
          // Người xem màn hẹp rời đi thì những người còn lại được rộng trở lại.
          capNhatKichThuoc();
        },
      };

      conns.add(conn);
      // GỬI BÙ NGAY, trong cùng lượt đồng bộ với `conns.add`: những mảng byte
      // này đã được phát cho các kết nối khác nhưng lượt ghi của chúng chưa
      // xong, nên ảnh chụp mà người gọi vừa lấy KHÔNG chứa chúng. Xem đầu file.
      // Không thể trùng — kết nối này chưa tồn tại lúc chúng được phát đi.
      for (const m of dangCho) conn.baoData(m.text);
      capNhatKichThuoc();
      return { ok: true, conn };
    },
  };
}
