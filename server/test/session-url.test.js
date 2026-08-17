// Unit tests cho src/session-url.js — luật quyết định PWA có đi tới một địa
// chỉ hay không.
//
// terminal-api.test.js đã chứng minh luật này có hiệu lực qua HTTP thật. File
// này đi vào những cách viết CÙNG một địa chỉ theo kiểu khác nhau, thứ không
// tiện dựng cả một hub lên để thử từng cái.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionUrlAllowed } from '../src/session-url.js';

test('địa chỉ IPv4 Tailscale bình thường được chấp nhận', () => {
  assert.equal(isSessionUrlAllowed('http://100.101.102.103:62539/'), true);
  assert.equal(isSessionUrlAllowed('http://100.64.0.1/'), true, 'đầu dải 100.64.0.0/10');
  assert.equal(isSessionUrlAllowed('http://100.127.255.254:8730/'), true, 'cuối dải 100.64.0.0/10');
});

test('IP bắt đầu bằng 100 nhưng NGOÀI dải CGNAT bị từ chối', () => {
  // 100.64.0.0/10 nghĩa là octet thứ hai từ 64 tới 127. 100.1.2.3 trông rất
  // giống địa chỉ Tailscale và không phải — chính fixture cũ của
  // app-terminal.test.js đã nhầm đúng chỗ này.
  assert.equal(isSessionUrlAllowed('http://100.1.2.3:8730/'), false);
  assert.equal(isSessionUrlAllowed('http://100.63.255.255/'), false, 'ngay dưới đầu dải');
  assert.equal(isSessionUrlAllowed('http://100.128.0.1/'), false, 'ngay trên cuối dải');
});

test('scheme không phải http/https bị từ chối', () => {
  assert.equal(isSessionUrlAllowed('javascript:alert(1)'), false);
  assert.equal(isSessionUrlAllowed('data:text/html,<script>1</script>'), false);
  assert.equal(isSessionUrlAllowed('file:///etc/passwd'), false);
  // ws: hợp lệ về cú pháp và từng là hình dạng url cũ trong test — nhưng
  // trình duyệt không điều hướng cấp cao nhất tới nó được, nên nó không bao
  // giờ là thứ daemon báo lên.
  assert.equal(isSessionUrlAllowed('wss://100.86.1.2:8730/attach'), false);
});

test('tên miền bị từ chối, kể cả khi có địa chỉ tailnet nhét vào trong tên', () => {
  assert.equal(isSessionUrlAllowed('https://evil.example/term/'), false);
  assert.equal(isSessionUrlAllowed('http://100.86.1.2.evil.example/'), false,
    'tiền tố trông giống IP vẫn chỉ là một cái tên');
  assert.equal(isSessionUrlAllowed('http://100.86.1.2-evil.example/'), false);
});

test('địa chỉ tailnet đặt ở phần userinfo KHÔNG lừa được — host thật mới tính', () => {
  // `http://100.86.1.2@evil.example/` đọc lướt trên màn hình điện thoại y hệt
  // một địa chỉ tailnet; trình duyệt đi tới evil.example.
  assert.equal(isSessionUrlAllowed('http://100.86.1.2@evil.example/'), false);
  assert.equal(isSessionUrlAllowed('http://user:pw@100.86.1.2:8730/'), false,
    'daemon không bao giờ gửi thông tin đăng nhập trong url');
});

test('viết địa chỉ theo kiểu khác (bát phân, thập lục, số nguyên) không đi vòng được luật', () => {
  // WHATWG URL chuẩn hoá mọi cách viết IPv4 về dạng thập phân trước khi tới
  // đây, nên kiểm dạng thập phân là đủ — nhưng phải đúng theo địa chỉ SAU
  // chuẩn hoá, không phải theo chuỗi người ta gõ vào.
  assert.equal(isSessionUrlAllowed('http://0x64.86.1.2/'), true, '0x64 = 100 — vẫn là đúng máy đó, chấp nhận là đúng');
  assert.equal(isSessionUrlAllowed('http://1681007361/'), false, 'số nguyên này ra 100.50.35.1, ngoài dải');
  assert.equal(isSessionUrlAllowed('http://0100.86.1.2/'), false, '0100 bát phân = 64, không phải 100');
});

test('IPv6 bị từ chối — daemon chỉ bind IPv4', () => {
  // term/src/tailscale.js cố ý chỉ lấy địa chỉ IPv4 (bind một literal IPv6 sẽ
  // kéo theo chuyện xử lý dấu ngoặc vuông khắp nơi). Nên một url IPv6 không
  // thể do daemon thật sinh ra.
  assert.equal(isSessionUrlAllowed('http://[fd7a:115c:a1e0::1]:8730/'), false);
});

test('đầu vào dị dạng trả false chứ không ném lỗi', () => {
  // Hàm này chạy trên body của request — thứ gì cũng có thể tới. Ném lỗi ở
  // đây là biến một url rác thành một request 500.
  for (const x of ['', 'khong-phai-url', '///', 'http://', null, undefined, 42, {}, [], true]) {
    assert.equal(isSessionUrlAllowed(x), false, `${JSON.stringify(x)} phải là false`);
  }
});
