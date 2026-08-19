// "Máy này có tmux dùng được không?" — một câu hỏi về NĂNG LỰC, không phải về
// nền tảng.
//
// Vì sao không dùng `process.platform !== 'win32'`: một container CI Linux
// không cài tmux đâm vào đúng bức tường ấy, và `tmuxBin()` đã biết câu trả lời
// rồi. Rào theo nền tảng là đoán; rào theo năng lực là hỏi.
//
// Tách khỏi tmux.js để file test nào cần nó cũng import được mà không kéo theo
// cả bộ lệnh tmux — và để hàng rào của pane-source-boundary.test.js, thứ cấm
// ccrc-term.js nhắc tới tmux.js, không phải nới ra vì một hàm kiểm tra.
import { tmuxBin } from './tmux.js';

let daHoi = null;

export function coTmux() {
  if (daHoi !== null) return daHoi;
  try {
    daHoi = Boolean(tmuxBin());
  } catch {
    // tmuxBin() ném khi không tìm thấy ở bất cứ đâu — đó là câu trả lời, không
    // phải một lỗi cần báo lên.
    daHoi = false;
  }
  return daHoi;
}
