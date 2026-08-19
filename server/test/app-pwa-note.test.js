// Ghi chú "thêm vào màn hình chính rồi mở từ đó" chỉ có nghĩa với người đang
// đứng ngoài PWA. Người đã cài rồi mà vẫn bị nhắc thì hoặc là họ tưởng mình
// làm sai, hoặc họ học được rằng ghi chú trong app này không đáng đọc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const an = (page) => page.byId['pwa-note'].classList.contains('hidden');

test('mở bằng trình duyệt thường: ghi chú HIỆN', () => {
  const page = loadAppPage({});
  assert.equal(an(page), false);
});

test('mở từ PWA đã cài (display-mode: standalone): ghi chú ẨN', () => {
  const page = loadAppPage({ media: { '(display-mode: standalone)': true } });
  assert.equal(an(page), true);
});

test('iOS không hỗ trợ display-mode — navigator.standalone là đường thứ hai', () => {
  const page = loadAppPage({ navigatorImpl: { standalone: true } });
  assert.equal(an(page), true, 'thiếu nhánh này thì iPhone — đúng máy cần nhất — vẫn bị nhắc');
});

// `media: null` bảo harness đừng định nghĩa matchMedia CHÚT NÀO. Gán
// `window.matchMedia = undefined` sau khi trang đã nạp thì vô nghĩa: việc dò
// PWA chạy đúng một lần, lúc nạp, và đã chạy xong trước dòng gán đó.
test('trình duyệt không có matchMedia thì vẫn hiện, không nổ', () => {
  const page = loadAppPage({ media: null });
  assert.equal(an(page), false);
});
