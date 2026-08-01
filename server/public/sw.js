// CC Notify — service worker for Web Push
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Trình duyệt chỉ coi trang là "cài đặt được" (PWA) khi service worker có
// handler fetch. Không cache gì — thông báo cũ không còn giá trị.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const opts = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: true,
  };
  // `sessionId` đi cùng payload từ hub (server/src/index.js) khi thông báo
  // thuộc về một phiên terminal. Giữ nó lại ở đây là thứ duy nhất làm cho cú
  // bấm bên dưới biết phải mở phiên NÀO — trước bản này nó bị vứt đúng chỗ
  // này. Vắng mặt hẳn khi không thuộc phiên nào, không phải chuỗi rỗng.
  if (typeof data.sessionId === 'string' && data.sessionId) {
    opts.data = { sessionId: data.sessionId };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'CC Notify', opts));
});

// Bấm vào thông báo của một phiên terminal thì đi thẳng tới terminal của
// phiên đó — không phải "mở app rồi tự tìm lấy". Trang hub là chặng dừng bắt
// buộc chứ không phải đích: token đăng nhập nằm trong localStorage mà service
// worker không đọc được, nên việc ký token mở terminal phải do trang làm.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const sid = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : null;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const win = wins[0];
      // focus() có thể hỏng ba kiểu, và cả ba đều phải nuốt được: promise bị
      // từ chối (cửa sổ vừa đóng, nền tảng từ chối đưa nó lên trước), ném
      // ĐỒNG BỘ, hoặc trả về thứ không phải promise. Đường mang sessionId
      // sang trang là postMessage ngay dưới đây, và nhánh openWindow dự phòng
      // nằm dưới nữa — một focus() hỏng không được phép kéo đổ cả hai, vì mất
      // chúng là mất luôn phiên người dùng vừa bấm vào.
      //
      // `try/await/catch` chứ không phải `win.focus().catch(…)`: cái sau tự nó
      // là một TypeError khi focus() trả về undefined, và nó không hề đứng
      // giữa một cú ném đồng bộ — hai trong ba kiểu hỏng ở trên đi thẳng qua
      // nó. `await` một giá trị không phải promise thì hoàn toàn hợp lệ.
      try { await win.focus(); } catch { /* không lên trước được thì thôi */ }
      // Trang đang chạy sẵn: không tải lại nó (sẽ mất trạng thái đang có).
      // Không có sessionId thì cũng không có gì để nhắn — dừng ở đây.
      if (!sid) return;
      try {
        win.postMessage({ type: 'ccrc_open', sessionId: sid });
        return;
      } catch {
        // postMessage cũng hỏng — cửa sổ này coi như không dùng được nữa,
        // rơi xuống mở cửa sổ mới thay vì im lặng bỏ cuộc và mất phiên.
      }
    }
    await self.clients.openWindow(sid ? '/?open=' + encodeURIComponent(sid) : '/');
  })());
});
