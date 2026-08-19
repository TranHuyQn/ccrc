// Khung cho named pipe giữa ccrc-host (giữ ConPTY) và những ai nối vào nó.
//
// Quy ước lấy lại nguyên từ WebSocket của dự án: NHỊ PHÂN là dữ liệu pane,
// TEXT là điều khiển. Không bịa quy ước thứ ba — dự án đã từng đoán loại khung
// bằng "khung đầu tiên là điều khiển", và mọi thông báo lỗi sau khung đầu bị vẽ
// ra lưới thành cục JSON, tức là kênh báo lỗi chưa từng tới được người dùng.
//
// Pipe là luồng byte: nó không hứa một lần đọc là một khung. Nên phải tự đóng
// khung, và bộ giải mã phải chịu được mọi kiểu cắt.

export const FRAME = { PANE: 0, CONTROL: 1 };

const HEAD = 5; // 1 byte kind + 4 byte length

// Trần cho một khung. Độ dài đến từ đầu bên kia của pipe, nên cấp phát theo
// lời khai là để một khung hỏng (hoặc cố ý) xin 4GB.
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (body.length > MAX_FRAME) throw new Error(`khung qua dai: ${body.length}`);
  const head = Buffer.alloc(HEAD);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// Một khi push() ném lỗi, bộ giải mã này COI NHƯ HỎNG HẲN — không tự đồng bộ
// lại. Độ dài hỏng nghĩa là không còn biết ranh giới của khung kế tiếp nằm ở
// đâu trong luồng byte; đoán bừa (vd bỏ qua 1 byte rồi thử đọc lại) chỉ khiến
// mọi khung phía sau bị vẽ sai vị trí một cách âm thầm, còn nguy hiểm hơn là
// dừng hẳn. Vì vậy header hỏng không bị tiêu thụ: gọi push() lần nữa sẽ ném
// lại đúng lỗi đó. Bên gọi phải bỏ decoder này và ngắt kết nối (pipe/reconnect
// lại từ đầu), không được cố gắng bơm tiếp dữ liệu vào.
export function createFrameDecoder() {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      rest = rest.length === 0 ? Buffer.from(chunk) : Buffer.concat([rest, chunk]);
      const out = [];
      for (;;) {
        if (rest.length < HEAD) break;
        const len = rest.readUInt32BE(1);
        // Kiểm TRƯỚC khi chờ đủ byte: một độ dài vô lý không được phép làm bộ
        // đệm phình lên trong lúc chờ số byte không bao giờ tới.
        if (len > MAX_FRAME) throw new Error(`khung qua dai: ${len}`);
        if (rest.length < HEAD + len) break;
        out.push({ kind: rest.readUInt8(0), payload: rest.subarray(HEAD, HEAD + len) });
        rest = rest.subarray(HEAD + len);
      }
      return out;
    },
  };
}
