// Chốt `Origin` trên bắt tay WebSocket `/attach`.
//
// Vì sao cần, khi đã có token ký bằng khoá của điện thoại: token được ký BỞI
// trang PWA, và trang PWA do hub phục vụ. Một hub bị chiếm sửa `app.js` để ký
// một token hợp lệ (đúng `sid`, đúng `h`) rồi đẩy điện thoại sang một trang
// `http://` của kẻ tấn công. Trang đó mở WebSocket tới daemon TỪ CHÍNH ĐIỆN
// THOẠI NẠN NHÂN — máy đang ở trong tailnet — và tiếp sức shell ra ngoài. Mọi
// phép kiểm trong ticket.js đều qua, vì token thật sự hợp lệ.
//
// Thứ chặn được đường đó là `Origin`: trình duyệt tự đặt nó cho mọi kết nối
// WebSocket và một trang web KHÔNG sửa được nó. Nên daemon chỉ cần từ chối mọi
// Origin không phải chính mình.
//
// Ca "không có Origin" cố ý được CHO QUA — xem test cuối cùng cho lý do đầy đủ.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startDaemon } from './helpers.mjs';

// connect() của daemon.test.js không đặt được header, mà header mới là thứ
// đang được kiểm ở đây. `origin: null` nghĩa là KHÔNG gửi header nào cả —
// khác hẳn chuỗi 'null', thứ trình duyệt thật gửi từ một iframe sandbox.
function connectWithOrigin(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === null ? {} : { origin });
    ws.on('open', () => resolve({ ws, ok: true }));
    ws.on('error', () => resolve({ ws: null, ok: false }));
    ws.on('unexpected-response', () => resolve({ ws: null, ok: false }));
  });
}

test('Origin của chính daemon: cho qua', async () => {
  const d = await startDaemon();
  try {
    const token = await d.token();
    const c = await connectWithOrigin(d.url(token), `http://127.0.0.1:${d.port}`);
    assert.equal(c.ok, true, 'trang do chính daemon phục vụ phải mở được');
    c.ws.close();
  } finally {
    d.stop();
  }
});

test('Origin của một trang lạ: từ chối, dù token hoàn toàn hợp lệ', async () => {
  const d = await startDaemon();
  try {
    // Token này đúng chữ ký, đúng sid, đúng host, chưa hết hạn, chưa dùng —
    // nghĩa là mọi phép kiểm của ticket.js đều qua. Chỉ Origin sai.
    const token = await d.token();
    const c = await connectWithOrigin(d.url(token), 'http://ke-tan-cong.example');
    assert.equal(c.ok, false, 'một trang lạ không được mở terminal dù cầm token thật');
    assert.match(d.log(), /origin/i, 'daemon phải nói ra vì sao đã từ chối');
  } finally {
    d.stop();
  }
});

test('Origin "null" (iframe sandbox, file://): từ chối', async () => {
  const d = await startDaemon();
  try {
    const token = await d.token();
    // Chuỗi 'null' là thứ trình duyệt thật gửi từ một ngữ cảnh đã bị tước
    // nguồn gốc. Nó KHÔNG phải "không có Origin", và không được hưởng lối
    // thoát dành cho client không phải trình duyệt.
    const c = await connectWithOrigin(d.url(token), 'null');
    assert.equal(c.ok, false, 'ngữ cảnh không có nguồn gốc không được mở terminal');
  } finally {
    d.stop();
  }
});

test('không có Origin: vẫn cho qua — chốt này chỉ nhắm vào trình duyệt', async () => {
  const d = await startDaemon();
  try {
    const token = await d.token();
    const c = await connectWithOrigin(d.url(token), null);
    // Cố ý cho qua, và đây là chỗ dễ siết nhầm cho "chặt hơn thì an toàn hơn".
    // Kẻ tấn công mà chốt này nhắm tới là một TRANG WEB chạy trong trình duyệt
    // nạn nhân, và trình duyệt LUÔN gửi Origin cho WebSocket — trang đó không
    // có cách nào bỏ header ấy đi. Chặn thêm ca "vắng Origin" vì thế không
    // chặn thêm được ai; nó chỉ giết những client không phải trình duyệt
    // (script, công cụ gỡ rối, chính bộ test này) mà không đổi gì về an toàn.
    assert.equal(c.ok, true, 'client không phải trình duyệt vẫn phải dùng được');
    c.ws.close();
  } finally {
    d.stop();
  }
});
