// Buffer cuộn cho bản Windows — thứ thay `tmux capture-pane`.
//
// tmux giữ lịch sử của pane và trả về MÀN HÌNH ĐÃ VẼ khi được hỏi. ConPTY
// không giữ gì cả: nó chỉ đưa ra một luồng byte. Nên phía Windows phải tự nuôi
// một terminal trong bộ nhớ và tự trả lời ba câu hỏi tmux vẫn trả lời:
// "màn hình đang thế nào", "có bao nhiêu dòng ở trên", "cho tôi cửa sổ này".
//
// Dùng @xterm/headless vì trình duyệt cũng chạy xterm: cùng một bộ diễn giải
// escape sequence ở hai đầu nghĩa là không có chuyện hai bên hiểu khác nhau.
//
// CommonJS cả hai gói, mà dự án này thuần ESM — nhập kiểu default rồi rã, chứ
// `import { Terminal } from '@xterm/headless'` ném lỗi ngay lúc nạp.
import headless from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serializePkg;

// Cùng ba mảnh đóng khung mà bản tmux dùng (xem tmux.js snapshotPane /
// captureHistory). Trình duyệt đã dựa vào chúng, nên đây là hợp đồng chứ không
// phải lựa chọn.
const OPEN = '\x1b[2J\x1b[H';
const CLOSE = '\x1b[0m';

// Một dòng không có gì nhìn thấy được: bỏ hết mã SGR đi thì chỉ còn khoảng
// trắng. Một mã màu trơ trọi vẫn phải tính là trắng, nếu không nó vô hiệu hoá
// việc cắt đuôi.
function isBlankLine(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
}

// serialize() kết thúc mỗi dòng bằng '\r' chứ không phải '\n' — đo được trên
// addon-serialize 0.14.0. Tách theo '\n' rồi bỏ '\r' thừa ở cuối mỗi dòng.
function splitLines(raw) {
  return raw.split('\n').map((l) => l.replace(/\r$/, ''));
}

function frame(lines) {
  return `${OPEN}${lines.join('\r\n')}${CLOSE}`;
}

export function createScreenBuffer({ cols = 80, rows = 24, scrollback = 10_000 } = {}) {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const ser = new SerializeAddon();
  term.loadAddon(ser);

  return {
    // xterm nuốt dữ liệu bất đồng bộ và chỉ gọi lại khi đã xử lý xong. Hỏi
    // buffer trước lúc ấy là đọc một trạng thái dở dang — nên hàm này trả
    // Promise và mọi chỗ gọi phải chờ.
    write(data) {
      return new Promise((resolve) => term.write(data, resolve));
    },

    resize(c, r) {
      if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1) return;
      term.resize(c, r);
    },

    // Số dòng đã trôi lên phía trên màn hình. `baseY` chính là con số đó —
    // đo được trên @xterm/headless 6.0.0: ghi 30 dòng vào màn hình 6 dòng cho
    // baseY = 25.
    historySize() {
      return term.buffer.active.baseY;
    },

    // Màn hình hiện tại, đã cắt các dòng trắng ở cuối.
    //
    // Cắt đuôi không phải để cho gọn: pane cao hơn màn hình trình duyệt thì
    // phần đệm trắng đẩy nội dung thật cuộn khỏi đỉnh, và người dùng mở
    // terminal ra thấy một khoảng gần như trống.
    snapshot() {
      const lines = splitLines(ser.serialize());
      while (lines.length > 0 && isBlankLine(lines[lines.length - 1])) lines.pop();
      if (lines.length === 0) return '';
      return frame(lines);
    },

    // Một màn hình lịch sử, bắt đầu từ `offset` dòng phía trên đỉnh màn hình.
    //
    // serialize() KHÔNG lấy được một cửa sổ tuỳ ý — nó chỉ lấy được "màn hình
    // cộng N dòng lịch sử". Nên xin đúng `offset` dòng (kết quả bắt đầu ở
    // baseY - offset, đo được) rồi cắt lấy `rows` dòng đầu.
    //
    // Đường vòng qua `getLine().translateToString()` trông thẳng hơn nhưng
    // MẤT MÀU — và màu là thứ trình duyệt cần.
    history(offset, rows) {
      if (!Number.isInteger(offset) || offset < 1) return '';
      if (!Number.isInteger(rows) || rows < 1) return '';
      const max = term.buffer.active.baseY;
      const o = Math.min(offset, max);
      if (o < 1) return '';
      const lines = splitLines(ser.serialize({ scrollback: o })).slice(0, rows);
      if (lines.length === 0) return '';
      return frame(lines);
    },

    dispose() {
      try { term.dispose(); } catch { /* đã đóng rồi */ }
    },
  };
}
