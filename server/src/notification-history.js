// Lịch sử thông báo cho "Gần đây" trên PWA. Chỉ tồn tại trong RAM — một hub
// restart xoá sạch là chấp nhận được, đây không phải một bản ghi cần bền.
//
// Hai cơ chế cắt bớt hoạt động song song, không phụ thuộc nhau:
//   - HISTORY_MAX: không bao giờ giữ quá 50 mục một user, dù mới tới đâu.
//   - HISTORY_TTL_MS: một mục quá 24 giờ tự biến mất, dù danh sách chưa đầy.
//
// Theo đúng khuôn mẫu server/src/terminal-sessions.js: factory nhận `now` có
// thể tiêm để test dùng đồng hồ giả, và prune() chạy LƯỜI — gọi lại ở đầu mỗi
// hàm public thay vì đặt trên setInterval, vì không có gì để dọn khi không ai
// đang nhìn vào nó.
export const HISTORY_MAX = 50;
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

export function createNotificationHistory({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Array<any>>} userName -> notifications, newest first */
  const byUser = new Map();

  // Danh sách luôn mới nhất trước (remember() dùng unshift), nên mục quá hạn
  // luôn nằm ở CUỐI mảng — pop() từ cuối, dừng ngay khi gặp mục còn hạn, thay
  // vì duyệt và lọc toàn bộ mảng mỗi lần.
  function prune(userName) {
    const list = byUser.get(userName);
    if (!list) return;
    const t = now();
    while (list.length && t - list[list.length - 1].at > HISTORY_TTL_MS) list.pop();
    if (list.length === 0) byUser.delete(userName);
  }

  return {
    remember(userName, note) {
      const list = byUser.get(userName) || [];
      list.unshift({ ...note, at: now() });
      if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
      byUser.set(userName, list);
      prune(userName);
    },

    list(userName) {
      prune(userName);
      return byUser.get(userName) || [];
    },
  };
}
