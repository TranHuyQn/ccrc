// Cách DUY NHẤT dừng daemon tử tế trên Windows: một file cờ.
//
// Vì sao phải có, đo được ngày 2026-08-18 trên máy Windows thật (cùng kịch bản
// chạy trên macOS để so):
//
//   nền     mã đóng WebSocket   hub nhận unregister   file sổ phiên
//   macOS   4001 sau 113ms      có                    đã xoá
//   Windows 1006 sau 500ms      KHÔNG                 CÒN NGUYÊN
//
// `process.kill(pid, 'SIGTERM')` trên Windows là `TerminateProcess`: không
// handler nào chạy, nên `shutdown()` (term/bin/ccrc-term.js) bị bỏ qua trọn
// vẹn. 1006 là "đứt bất thường" — cùng một mã mà rớt wifi sinh ra — nên trang
// web KHÔNG phân biệt được, và nó quay vòng "đang nối lại…" mãi mãi cho một
// phiên đã chết (term/public/term.js, nhánh CLOSE_SESSION_ENDED).
//
// Vì sao là file chứ không phải một cổng/pipe điều khiển: daemon là code DÙNG
// CHUNG với macOS, và mọi thứ thêm vào nó phải nằm sau một nhánh chỉ chạy trên
// Windows. Một file cờ cần đúng một `fs.watch` + một vòng poll, không thêm mặt
// mạng nào, và dùng lại nguyên `shutdown()` — đường đã được canh kỹ nhất trong
// cả daemon. Ranh giới tin cậy không đổi: ai ghi được vào `~/.ccrc` thì vốn đã
// ghi được file pid, và file pid là thứ quyết định `off` bắn vào pid nào.
//
// `platform` là THAM SỐ, không phải `process.platform` đọc lén: đó là cách
// src/pane-source-chon.js đã làm, và lý do giống hệt — cái nhánh nguy hiểm nhất
// ở đây là "macOS/Linux không được mọc thêm đường dừng thứ hai", và nó phải
// sai được ngay trên máy macOS của bộ test.
import fs from 'node:fs';
import path from 'node:path';

// Cùng tập ký tự với `SAFE_SESSION_ID` của bin/ccrc-host.js và `safeId` của
// shared/session-registry.js — trên Windows `paneId` CHÍNH LÀ sessionId của
// host, nên đây không phải một luật thứ ba mọc thêm mà là cùng một luật.
//
// Cái này đứng giữa một chuỗi đến từ biến môi trường và một lời gọi
// `path.join`. Không khớp thì trả `null`, và người gọi rơi về đúng hành vi cũ
// (TerminateProcess) — từ chối, không ghép bừa một đường dẫn ra ngoài `.ccrc`.
const ID_AN_TOAN = /^[A-Za-z0-9._-]{1,128}$/;

// Nhịp poll mặc định. `fs.watch` là đường nhanh (thường vài ms), poll là lưới
// đỡ cho những ca fs.watch im lặng không báo: thư mục chưa tồn tại lúc dựng,
// ổ đĩa mạng, hoặc trần watcher của hệ điều hành đã cạn. 250ms nằm gọn dưới
// hạn chờ 3 giây mà `/remote off` cho daemon để tự dừng tử tế.
export const NHIP_MAC_DINH_MS = 250;

// BAO NHIÊU sự kiện trong MỘT cửa sổ thì coi là bão, và bỏ hẳn watcher.
//
// Đây là phép đo TRỰC TIẾP của căn bệnh, khác hẳn vòng trước. Vòng trước tôi
// hỏi "thư mục còn đó không?" — một dấu hiệu GIÁN TIẾP — và nó bỏ lọt đúng ca
// hay xảy ra nhất: xoá `.ccrc` rồi dựng lại ngay. Thư mục có mặt trở lại, phép
// kiểm thấy nó bình thường, watcher không bao giờ đóng, và một lõi CPU cháy mãi.
// Đo được trên máy Windows thật, 2 giây mỗi lượt:
//
//   kịch bản                          771d02f   690dd54   bản này
//   xoá `.ccrc` rồi để yên            2047ms    31ms      (xem báo cáo)
//   xoá rồi DỰNG LẠI ngay            —         1985ms    (xem báo cáo)
//   vòng xoá/dựng lại mỗi 100ms      —         1984ms    (xem báo cáo)
//
// Cái tốn CPU là libuv chuyển sự kiện, không phải `existsSync` — nên thứ duy
// nhất chữa được là THÔI NHẬN sự kiện.
//
// 200 sự kiện trong một giây là con số không đời nào một `~/.ccrc` bình thường
// chạm tới: nó chỉ nhận vài sự kiện mỗi 20 giây (nhịp tim ghi `sessions/*.json`)
// cộng dăm lần đọc cấu hình. Đóng nhầm cũng chỉ mất đường nhanh — vòng poll vẫn
// gánh, và daemon vẫn dừng được.
const NGUONG_SU_KIEN_MAC_DINH = 200;
const CUA_SO_DEM_MS = 1000;

/**
 * Đường dẫn file cờ dừng của một phiên, hoặc `null` nếu không dựng được an
 * toàn. Nằm cạnh file pid (`term-pane-<id>.pid`) và theo đúng quy ước tên ấy,
 * để hai thứ của cùng một phiên không bao giờ trôi khỏi nhau.
 *
 * ĐÂY là hàm cả hai bên phải dùng — CLI khi ghi cờ, daemon khi rình cờ. Trong
 * dự án này đã ba lần một đợt sửa vá đúng những chỗ được chỉ mà bỏ sót cái hàm
 * dùng chung; một cái tên file ghép tay ở mỗi bên là đúng hình dạng ấy, và nó
 * hỏng CÂM: CLI ghi một chỗ, daemon rình một chỗ khác, `off` vẫn in "✓ ĐÃ TẮT"
 * vì lưới cuối vẫn giết được tiến trình — chỉ là tử tế thì không.
 */
export function duongDanFileDung(paneId, home) {
  if (typeof paneId !== 'string' || !ID_AN_TOAN.test(paneId)) return null;
  if (paneId === '.' || paneId === '..') return null;
  if (typeof home !== 'string' || home.trim() === '') return null;
  return path.join(home, '.ccrc', `term-pane-${paneId}.stop`);
}

/**
 * Rình file cờ của phiên này; thấy thì gọi `khiThay()` ĐÚNG MỘT LẦN rồi tự gỡ.
 *
 * Trả `null` — nghĩa là "không có gì được dựng" — khi nền tảng không phải
 * Windows, khi `tat` được bật, hoặc khi không dựng được đường dẫn an toàn.
 * `null` không phải lỗi: nó là hành vi CŨ, và hành vi cũ vẫn dừng được daemon
 * bằng TerminateProcess.
 *
 * KHÔNG xoá file cờ khi thấy: bên ghi cờ (`/remote off`) là bên dọn, vì chỉ nó
 * biết lúc nào cuộc dừng đã xong. Nhưng cờ CŨ còn sót lại từ lượt trước thì bị
 * dọn ngay lúc dựng — không thế thì một daemon vừa bật lên sẽ tự tắt ở nhịp
 * poll đầu tiên vì đọc phải mệnh lệnh dành cho người tiền nhiệm.
 */
export function theoDoiFileDung({
  paneId,
  home,
  platform = process.platform,
  khiThay,
  nhipMs = NHIP_MAC_DINH_MS,
  // Mở ra để bộ test dựng được một cơn bão nhỏ (vài chục sự kiện) thay vì phải
  // sinh ra hàng trăm nghìn sự kiện thật chỉ để chạm tới ngưỡng.
  nguongSuKien = NGUONG_SU_KIEN_MAC_DINH,
  // Van CHỈ dành cho bộ test: dựng một daemon thật nhưng "điếc" với cờ, để đo
  // được rằng lưới cuối (TerminateProcess) vẫn còn nguyên. Không có nó thì
  // điều khoản "đừng biến việc dừng thành thứ dễ vỡ hơn trước" không có cách
  // nào chứng minh. Bật nhầm trong sản xuất chỉ làm mọi thứ lùi về đúng hành
  // vi trước bản này — khó chịu, không nguy hiểm.
  tat = false,
} = {}) {
  if (platform !== 'win32' || tat) return null;
  if (typeof khiThay !== 'function') return null;
  const file = duongDanFileDung(paneId, home);
  if (!file) return null;

  // Dọn mệnh lệnh của người tiền nhiệm. Cửa sổ đua duy nhất — một `off` đang
  // ghi cờ đúng lúc một `on` dựng daemon mới — không tồn tại trong thực tế:
  // `on` từ chối ngay khi `daemonInfo()` còn thấy một daemon sống, nên đã có
  // daemon để mà `off` thì chưa có daemon mới để mà dựng.
  try { fs.unlinkSync(file); } catch { /* chưa có thì thôi */ }

  const thuMuc = path.dirname(file);
  let xong = false;
  let watcher = null;

  function dongWatcher() {
    if (!watcher) return;
    try { watcher.close(); } catch { /* đã đóng */ }
    watcher = null;
  }

  const doc = () => {
    if (xong) return;
    let co;
    try { co = fs.existsSync(file); } catch { co = false; }
    if (!co) return;
    xong = true;
    ngung();
    khiThay();
  };

  // Nhịp poll làm HAI việc, và việc thứ hai chỉ thuộc về nó.
  //
  // Thư mục bị xoá rồi ĐỂ YÊN là ca mà bộ đếm sự kiện không bắt được trên mọi
  // nền tảng: trên Windows nó nổ thành bão (bộ đếm lo), nhưng trên macOS
  // `fs.watch` chỉ bắn một lần rồi im — watcher trở thành một thứ vô dụng treo
  // lại đó. Hỏi ở đây thì rẻ (4 lần mỗi giây) và không nằm trên đường đi của sự
  // kiện, khác hẳn chỗ tôi đặt nó vòng trước.
  //
  // Đây là dấu hiệu GIÁN TIẾP và tôi ghi rõ như thế: nó KHÔNG chữa được cơn bão
  // — xoá rồi dựng lại ngay thì thư mục vẫn có mặt ở mọi lần hỏi, và vòng trước
  // đúng chỗ này đã bỏ lọt (đo được: 1985ms CPU trên 2000ms). Cái chữa bão là bộ
  // đếm sự kiện trong `tuWatch`.
  const nhipDoc = () => {
    if (xong) return;
    if (watcher) {
      let coThuMuc;
      try { coThuMuc = fs.existsSync(thuMuc); } catch { coThuMuc = false; }
      if (!coThuMuc) dongWatcher();
    }
    doc();
  };

  // ĐẾM SỰ KIỆN, và bỏ watcher khi nhịp bắn trở nên vô lý.
  //
  // KHÔNG gộp sự kiện bằng hẹn giờ nữa. Vòng trước tôi gộp ở 20ms và viết trong
  // comment rằng nó cắt được cơn bão; người soát đo thì nó **không cắt được gì**
  // — chi phí nằm ở libuv chuyển sự kiện, không nằm ở `existsSync` mà phép gộp
  // tiết kiệm. Đổi lại nó cộng thêm tới 20ms vào độ trễ dừng daemon (đo được:
  // 32-33ms có gộp, 3-17ms không gộp). Trả tiền mà không mua được gì, nên bỏ.
  //
  // Cái CÓ tác dụng là thôi nhận sự kiện: đếm, và khi vượt ngưỡng thì đóng
  // watcher vĩnh viễn, để vòng poll gánh. Cửa sổ đếm trượt theo kiểu thô — hết
  // một giây thì đặt lại về 0 — vì thứ cần phân biệt ở đây là "vài sự kiện" với
  // "hàng trăm nghìn", không phải hai con số sát nhau.
  let dem = 0;
  let mocDem = Date.now();
  const tuWatch = () => {
    if (xong || !watcher) return;
    const bayGio = Date.now();
    if (bayGio - mocDem >= CUA_SO_DEM_MS) { mocDem = bayGio; dem = 0; }
    dem += 1;
    if (dem > nguongSuKien) {
      // Đọc một lần cuối TRƯỚC khi bỏ watcher: cơn bão có thể chính là lượt ghi
      // cờ dừng lẫn trong đó, và bỏ đi mà không nhìn là hoãn việc dừng daemon
      // lại tới nhịp poll sau — đúng lúc người dùng vừa gõ `off`.
      dongWatcher();
      doc();
      return;
    }
    doc();
  };

  // `fs.watch` trên THƯ MỤC, không trên file: file chưa tồn tại lúc này, và
  // watch một đường dẫn chưa có thì ném.
  try {
    watcher = fs.watch(thuMuc, tuWatch);
    // Phòng thân, không phải vá một lỗi đã đo: người soát không provoke được
    // một `error` nào từ watcher. Nhưng một `error` không ai nghe trên
    // EventEmitter là một cú ném không bắt được, và nó sẽ giết daemon — tức là
    // cơ chế thêm vào để dừng tử tế lại thành thứ làm chết đột ngột. Đóng
    // watcher và để poll gánh, y như ca thư mục biến mất.
    //
    // NÓI RA khi nó xảy ra. Nuốt im lặng thì một cấu hình Windows nào đó mà
    // `fs.watch` luôn lỗi — ổ mạng, cạn trần watcher — sẽ mất đường nhanh
    // VĨNH VIỄN mà không ai biết; triệu chứng duy nhất là `off` chậm thêm
    // ≤250ms, thứ không ai đi truy. Một dòng stderr là đủ để lần sau có người
    // đọc log thì thấy ngay, và nó không làm hỏng gì: daemon vẫn chạy tiếp
    // bằng poll.
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (e) => {
        process.stderr.write(`[term] fs.watch lỗi (${e && e.message ? e.message : e})`
          + ' — chuyển sang poll, /remote off sẽ chậm hơn một chút.\n');
        dongWatcher();
      });
    }
    // Cùng lý do với `nhip.unref()` bên dưới: không giữ vòng lặp sự kiện sống
    // hộ ai cả. Daemon tự có cái giữ nó sống.
    if (watcher && typeof watcher.unref === 'function') watcher.unref();
  } catch { /* không watch được thì poll gánh */ }

  const nhip = setInterval(nhipDoc, nhipMs);
  // `unref()` KHÔNG tắt nhịp poll — nó chỉ thôi giữ vòng lặp sự kiện sống, và
  // daemon vốn luôn có một cổng đang nghe cộng vòng PANE_CHECK_MS giữ hộ. Đổi
  // lại: một bài test quên gọi `dung()` sẽ ĐỎ ngay chỗ nó sai, thay vì treo
  // `node --test` vô hạn — đo được, một lượt đột biến đã treo đúng như thế
  // trước khi có dòng này, và một bài test treo thì không nói được nó hỏng ở
  // đâu. Người gọi vẫn gỡ hẳn bằng `dung()`.
  if (typeof nhip.unref === 'function') nhip.unref();

  function ngung() {
    dongWatcher();
    clearInterval(nhip);
  }

  // `dangXem` chỉ để bộ test đo được rằng watcher ĐÃ ĐÓNG khi thư mục biến mất
  // — cái đó không quan sát được từ bên ngoài bằng cách nào khác, và không đo
  // được thì bản vá cơn bão CPU ở trên là một lời hứa suông.
  return { file, dung: ngung, dangXem: () => watcher !== null };
}
