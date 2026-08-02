# Tự động hết hạn thông báo trong "Gần đây" — thiết kế

Ngày: 2026-08-02

## 1. Vấn đề

Danh sách "Gần đây" trên PWA (`GET /api/notifications`, hiển thị bởi
`refreshList()` trong `server/public/app.js`) chỉ giới hạn 50 mục trong RAM
(`HISTORY_MAX`, `server/src/index.js`). Không có ngưỡng thời gian: một mục chỉ
biến mất khi hub restart hoặc khi có đủ 50 mục mới hơn đẩy nó ra.

Trong tuần phát triển vừa rồi, hub bị redeploy nhiều lần nên RAM bị xoá liên
tục — tạo cảm giác "thông báo cũ tự động biến mất". Giờ hub chạy ổn định,
không restart, nên thông báo cứ chồng lên và không còn tự rụng — hành vi đúng
như code viết ra, chỉ là trước đây bị che bởi tần suất redeploy cao.

Kết quả mong muốn: thông báo cũ hơn 24 giờ tự động biến mất khỏi danh sách
"Gần đây", không cần hub restart.

## 2. Phạm vi

Có:

- Ngưỡng hết hạn 24 giờ cho mỗi thông báo, tính từ lúc `/notify` ghi nhận nó.
- Prune lười (lazy), chạy tại mọi điểm vào của module lịch sử thông báo —
  không dùng timer riêng.
- Cap 50 mục (`HISTORY_MAX`) giữ nguyên, hoạt động song song với TTL.

Không có (cố ý để ngoài):

- Nút "xóa" thủ công.
- Xóa theo trạng thái đã đọc/chưa đọc — đã có cơ chế chấm chưa đọc riêng
  (`docs/superpowers/specs/2026-07-30-danh-dau-chua-doc-design.md`), không đụng tới.
- Xóa khi phiên terminal kết thúc — không liên quan tới tuổi của thông báo.
- Ngưỡng TTL có thể cấu hình qua env/API — 24 giờ cố định, hardcode như
  `SESSION_EVICT_MS`/`HEARTBEAT_DEAD_MS` đã làm.

## 3. Quyết định nền tảng

Đi theo đúng khuôn mẫu đã có trong `server/src/terminal-sessions.js`: một
module tách riêng, factory nhận `now` có thể tiêm (`now = () => Date.now()`)
để test dùng đồng hồ giả, và một hàm `prune()` nội bộ chạy **lười** — gọi lại ở
đầu mỗi hàm public thay vì đặt trên `setInterval` — vì lịch sử thông báo cũng
chỉ tồn tại trong RAM, không có gì để dọn khi không ai đang nhìn vào nó.

Danh sách của một user luôn ở thứ tự mới nhất trước (`unshift` trong
`remember()` hiện tại), nên mục quá hạn luôn nằm ở **cuối** mảng. `prune()` vì
vậy chỉ cần `pop()` từ cuối, dừng ngay khi gặp mục còn hạn — không cần duyệt
toàn bộ mảng mỗi lần, và không rủi ro xoá nhầm mục vừa thêm vào đầu.

## 4. Module mới: `server/src/notification-history.js`

```js
export const HISTORY_MAX = 50;
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

export function createNotificationHistory({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Array<any>>} userName -> notifications, newest first */
  const byUser = new Map();

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
```

`remember()` tự prune sau khi thêm — dọn dẹp ngay cả khi không ai gọi
`list()` trong lúc đó, giữ RAM không phình vô hạn nếu user có push liên tục
trong một ngày rồi ngừng.

## 5. Thay đổi ở `server/src/index.js`

Xoá `HISTORY_MAX`, `history` Map và hàm `remember()` cục bộ (dòng ~120-129).
Thay bằng:

```js
import { createNotificationHistory } from './notification-history.js';
// ...
const notificationHistory = createNotificationHistory();
```

- Route `POST /notify`: `remember(user.name, note)` → `notificationHistory.remember(user.name, note)`.
- Route `GET /api/notifications`: `history.get(user.name) || []` →
  `notificationHistory.list(user.name)`.

Không đổi hình dạng `note` hay bất cứ gì khác trong hai route này.

## 6. Phía PWA (`server/public/app.js`)

Không đổi code. `refreshList()` đã hiển thị nguyên trạng những gì
`/api/notifications` trả về, nên danh sách tự ngắn lại khi mục quá 24h biến
mất khỏi response.

**Tác dụng phụ chấp nhận được**: `hasUnread()` xét trên `recentNotes`, vốn
được gán từ chính response này (`app.js:37`). Một thông báo chưa đọc quá 24h
sẽ mất khỏi `recentNotes` cùng lúc, nên chấm "chưa đọc" trên thẻ terminal
tương ứng cũng tắt theo — coi đây là hành vi đúng (một tín hiệu 24h tuổi không
còn đáng để giữ chấm cam), không phải hồi quy, và không cần xử lý riêng.

## 7. Kiểm thử

`server/test/notify-api.test.js`, thêm khối mới ở cuối file, theo đúng mẫu
"Unit-level tests" mà `server/test/terminal-api.test.js` đã dùng cho
`createTerminalSessions` — import thẳng module thay vì spawn hub, đồng hồ giả
qua biến `let t`:

```js
import { createNotificationHistory, HISTORY_MAX, HISTORY_TTL_MS } from '../src/notification-history.js';
```

Ca kiểm:

- Thông báo mới ghi → `list()` trả về ngay, có trường `at`.
- Tiến đồng hồ tới đúng `HISTORY_TTL_MS` (chưa vượt) → vẫn còn trong `list()`.
- Tiến đồng hồ qua `HISTORY_TTL_MS + 1` → biến mất khỏi `list()`.
- Trộn mục mới và mục đã quá hạn trong cùng user → chỉ mục quá hạn bị prune,
  mục mới giữ nguyên thứ tự.
- Ghi đủ hơn `HISTORY_MAX` mục còn trong hạn → vẫn cắt đúng 50, không liên
  quan tới TTL (xác nhận cap cũ chưa bị hỏng khi chuyển sang module mới).
- User không có thông báo nào → `list()` trả mảng rỗng, không ném lỗi.

Không cần sửa các test tích hợp hiện có trong `notify-api.test.js` (chạy qua
HTTP, spawn hub thật) — hành vi observable không đổi trong 24h đầu.

## 8. Triển khai

Thay đổi chỉ nằm ở `server/src/` (phía hub) — không đụng `server/public/`, nên
**không cần** bump `?v=` trên `app.js`/`style.css` trong `index.html`. Deploy
bằng rsync + `docker compose` rebuild lại hub như thường lệ.
