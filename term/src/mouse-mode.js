// Ứng dụng trong pane có muốn nhận sự kiện chuột không, và nếu có thì mã hoá
// kiểu nào — thứ tmux trả lời bằng #{mouse_any_flag} và #{mouse_sgr_flag}.
//
// tmux biết vì nó tự phân tích luồng ra của ứng dụng. ConPTY không nói gì cả,
// nên phía Windows phải đọc lấy.
//
// Vì sao đáng cẩn thận: đây là chỗ quyết định một cú cuộn đi đường nào. Ứng
// dụng bật chuột thì gửi nó sự kiện bánh xe; ứng dụng KHÔNG bật mà gửi byte
// chuột vào là gõ rác thẳng vào dòng lệnh người dùng. Không bên nào báo lỗi.

// 1000 X11, 1002 theo nút, 1003 mọi chuyển động — bất kỳ cái nào bật nghĩa là
// ứng dụng đang chờ chuột. 1006 KHÔNG bật chuột: nó chỉ nói "gửi cho tôi kiểu
// SGR", nên được đếm riêng.
const MOUSE_MODES = new Set([1000, 1002, 1003]);
const SGR_MODE = 1006;

// Trần cho phần đuôi chưa hoàn chỉnh. Một luồng nhị phân có thể chứa `ESC[`
// rồi không bao giờ kết thúc; giữ mãi là rò bộ nhớ trong một tiến trình sống
// nhiều ngày. Chuỗi DEC private mode dài nhất trong thực tế chưa tới 40 ký tự.
const MAX_TAIL = 256;

export function createMouseMode() {
  const enabled = new Set();
  let sgr = false;
  let tail = '';

  return {
    feed(data) {
      const s = tail + String(data);
      tail = '';
      // `ESC [ ? <số>(;<số>)* <h|l>` — DEC private mode set/reset.
      const re = /\x1b\[\?([0-9;]*)([hl])/g;
      let m;
      let end = 0;
      while ((m = re.exec(s)) !== null) {
        end = re.lastIndex;
        const on = m[2] === 'h';
        for (const part of m[1].split(';')) {
          const n = Number(part);
          if (!Number.isInteger(n)) continue;
          if (MOUSE_MODES.has(n)) { if (on) enabled.add(n); else enabled.delete(n); }
          else if (n === SGR_MODE) sgr = on;
        }
      }
      // Giữ lại phần đuôi CÓ THỂ là đầu một chuỗi chưa trọn vẹn, để lần đọc
      // sau ghép tiếp. Chỉ giữ từ dấu ESC cuối cùng trở đi, và không quá trần.
      const rest = s.slice(end);
      const esc = rest.lastIndexOf('\x1b');
      tail = esc === -1 ? '' : rest.slice(esc);
      if (tail.length > MAX_TAIL) tail = '';
    },

    state() {
      return { mouse: enabled.size > 0, sgr };
    },
  };
}
