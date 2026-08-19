// Chỗ DUY NHẤT quyết định daemon nói chuyện với tmux hay với ConPTY.
//
// Vì sao tách ra khỏi ccrc-term.js thay vì viết thẳng một `? :` ở đó: cái đáng
// kiểm ở đây là PHÉP CHỌN, mà kiểm phép chọn bên trong ccrc-term.js nghĩa là
// dựng cả một daemon (cổng, token, WebSocket) chỉ để hỏi một câu hỏi một dòng
// — và một bài test như thế chỉ chạy được trên đúng nền tảng đang ngồi. Ở đây
// `platform` là tham số, nên máy macOS kiểm được nhánh Windows và ngược lại:
// một nhánh bị đảo lộ ra ở CẢ HAI nền tảng, không đợi tới lúc có máy Windows.
//
// `taoTmux`/`taoConpty` mở ra để test không phải dựng nguồn thật (nguồn thật
// mở ống, sinh tiến trình con) chỉ để biết cái nào được chọn.

import { createTmuxPaneSource } from './pane-source.js';
import { createConptyPaneSource } from './pane-source-conpty.js';

export function chonNguonPane({
  pane,
  platform = process.platform,
  taoTmux = createTmuxPaneSource,
  taoConpty = createConptyPaneSource,
} = {}) {
  // CCRC_TERM_PANE mang thứ KHÁC NHAU trên hai nền tảng: trên macOS là pane id
  // của tmux (`%15267`), trên Windows là sessionId của host. Daemon không cần
  // biết mình đang cầm cái nào — nó chuyển tiếp nguyên vẹn cho nguồn tương
  // ứng; đặt đúng giá trị vào biến môi trường là việc của CLI.
  if (platform === 'win32') return taoConpty({ sessionId: pane });

  // Đường macOS/Linux giữ NGUYÊN lời gọi cũ, kể cả việc KHÔNG truyền runId:
  // pane-source.js tự sinh runId đúng một lần lúc dựng, và việc sinh/so sánh
  // nó nằm trọn trong đó (xem ghi chú ở ccrc-term.js).
  return taoTmux({ pane });
}
