// Cắt một khối byte của người dùng thành những lệnh `send-keys -H` mà tmux
// chịu nuốt, và tách cú Enter cuối ra thành lệnh riêng.
//
// VÌ SAO PHẢI CẮT — đo ngày 2026-08-13 trên tmux 3.7b, qua đúng đường daemon
// dùng (`tmux -C`, mỗi byte là một tham số hex riêng):
//
//   |  byte gửi | tmux trả lời                          |
//   |-----------|---------------------------------------|
//   |     8000  | ok                                    |
//   |    12000  | %error parse error: yacc stack overflow|
//
// Mỗi byte thành một token, nên một khối đủ dài làm tràn stack parser của
// tmux. Trước bản này daemon ghi thẳng một lệnh dài bao nhiêu cũng ghi, và —
// tệ hơn cả việc hỏng — nó KHÔNG đọc phản hồi, nên lời từ chối rơi vào hư
// không: ô soạn phía người dùng vẫn trống đi như đã gửi, còn tin nhắn thì
// chưa từng tồn tại.
//
// 1024 chứ không phải 8000: trần đo được là của MỘT phiên bản tmux trên MỘT
// máy, và giá phải trả cho việc cắt nhỏ hơn chỉ là vài lệnh nữa trên một ống
// cục bộ. Bám sát mép đo được là đặt cược vào con số mình không kiểm soát.
export const MAX_KEY_BYTES = 1024;

// Byte tiếp diễn của UTF-8: 10xxxxxx.
const isContinuation = (b) => (b & 0xc0) === 0x80;

/**
 * Tìm chỗ cắt ≤ `max` mà không rơi vào giữa một ký tự UTF-8 nhiều byte.
 *
 * Cắt giữa chừng thực ra vẫn tới nơi đúng — pty là dòng byte, ứng dụng phía
 * kia tự ghép lại. Nhưng nó chỉ đúng khi mọi khúc đều tới, mà một khúc hỏng
 * giữa đường sẽ biến ký tự đó thành rác thay vì mất nguyên khúc. Lùi vài byte
 * là cái giá rẻ để hỏng cho gọn.
 */
function cutAt(buf, start, max) {
  let end = Math.min(start + max, buf.length);
  if (end >= buf.length) return end;
  // Nhiều nhất 3 byte tiếp diễn trong UTF-8 hợp lệ; giới hạn vòng lặp để một
  // chuỗi byte hỏng không đẩy chỗ cắt lùi vô hạn về `start`.
  let back = 0;
  while (end > start + 1 && back < 4 && isContinuation(buf[end])) { end--; back++; }
  return end;
}

/**
 * @param {Buffer|Uint8Array} input byte thô từ trình duyệt
 * @param {number} max số byte tối đa mỗi lệnh send-keys
 * @returns {{chunks: Buffer[], commit: Buffer|null}}
 *   `chunks` gửi liền nhau; `commit` (nếu có) là cú Enter cuối, PHẢI gửi thành
 *   một lệnh riêng sau một nhịp nghỉ — xem lý do ở nơi gọi.
 */
export function splitForSendKeys(input, max = MAX_KEY_BYTES) {
  const buf = Buffer.from(input || []);
  if (buf.length === 0) return { chunks: [], commit: null };

  // Chỉ tách khi Enter đi KÈM nội dung. Một cú Enter trơ trọi (bấm phím
  // Enter trên thanh phím) không có gì để tách khỏi, và tách ra thì thành
  // một lệnh rỗng.
  let body = buf;
  let commit = null;
  if (buf.length > 1 && buf[buf.length - 1] === 0x0d) {
    body = buf.subarray(0, buf.length - 1);
    commit = buf.subarray(buf.length - 1);
  }

  const chunks = [];
  let i = 0;
  while (i < body.length) {
    const end = cutAt(body, i, max);
    chunks.push(Buffer.from(body.subarray(i, end)));
    i = end;
  }
  return { chunks, commit: commit ? Buffer.from(commit) : null };
}
