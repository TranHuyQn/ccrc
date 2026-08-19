// Thư mục nhà mà ccrc dùng để tìm `.ccrc` và `.claude`.
//
// Vì sao không gọi thẳng os.homedir(): bộ test cần cô lập, và cách cô lập duy
// nhất trước đây là đặt biến HOME cho tiến trình con. Trên Windows điều đó
// KHÔNG có tác dụng — os.homedir() ở đó đọc USERPROFILE. Đo được: đặt HOME trỏ
// một thư mục tạm rồi hỏi os.homedir() vẫn ra C:\Users\<user>.
//
// Hậu quả không phải lý thuyết. Ngày 2026-08-18, chạy bộ test hook trên một máy
// Windows đã cài một hook vào ~/.claude/settings.json THẬT của người dùng và
// tạo ~/.ccrc/notify — vì mọi bài test tưởng mình đang ở trong hộp cát.
//
// CCRC_HOME là cùng một lối nghĩ với CCRC_TMUX_BIN và CCRC_TAILSCALE_BIN đã có:
// một biến môi trường rõ ràng, do dự án tự định nghĩa, không phụ thuộc vào việc
// hệ điều hành nào diễn giải biến chuẩn nào ra sao.
import os from 'node:os';

export function ccrcHome(env = process.env) {
  const v = env && env.CCRC_HOME;
  // Chuỗi rỗng hoặc toàn khoảng trắng KHÔNG được tính là "có đặt": tin nó là
  // ghi vào `.ccrc` ở gốc ổ đĩa, hỏng theo kiểu khó lần ra nhất.
  if (typeof v === 'string' && v.trim() !== '') return v;
  return os.homedir();
}
