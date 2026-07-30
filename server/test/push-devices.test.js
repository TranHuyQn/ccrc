// Naming and identifying a push device.
//
// A subscription carries an endpoint and two keys and nothing else, which is
// why the hub could only ever say "5 thiết bị" — four of which were the same
// iPhone, re-subscribed after four reinstalls. These are the two facts that
// can be recovered: the push service (readable from any endpoint, including
// ones stored long ago) and a label derived at subscribe time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceId, serviceOf, labelFromUserAgent, toPublicDevice, listDevices } from '../src/push-devices.js';

test('nhận ra dịch vụ đẩy từ endpoint — kể cả bản ghi cũ không có gì khác', () => {
  assert.equal(serviceOf('https://web.push.apple.com/QK123abc'), 'Apple');
  assert.equal(serviceOf('https://fcm.googleapis.com/fcm/send/xyz'), 'Google');
  assert.equal(serviceOf('https://android.googleapis.com/gcm/send/xyz'), 'Google');
  assert.equal(serviceOf('https://updates.push.services.mozilla.com/wpush/v2/abc'), 'Mozilla');
});

test('endpoint lạ → trả về host, không đoán bừa', () => {
  assert.equal(serviceOf('https://push.example.org/abc'), 'push.example.org');
});

test('endpoint hỏng không làm nổ — trả "không rõ"', () => {
  for (const bad of ['', 'không-phải-url', null, undefined, 42, {}]) {
    assert.doesNotThrow(() => serviceOf(bad));
    assert.equal(serviceOf(bad), 'không rõ');
  }
});

// Order matters in the UA sniffing: every iOS browser puts "Safari" in its
// string, and Chrome on iOS calls itself CriOS.
test('nhãn từ user-agent: nhận đúng máy và trình duyệt', () => {
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone · Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/126 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1', 'iPad · Safari'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', 'Android · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Mac · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'Mac · Safari'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 Edg/126', 'Windows · Edge'],
    ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/128.0', 'Linux · Firefox'],
  ];
  for (const [ua, want] of cases) {
    assert.equal(labelFromUserAgent(ua), want, ua.slice(0, 50));
  }
});

test('không có user-agent dùng được → không có nhãn, KHÔNG bịa', () => {
  for (const bad of ['', null, undefined, 42, {}, 'gì đó lạ hoắc']) {
    assert.equal(labelFromUserAgent(bad), '');
  }
});

// A user agent is a fingerprint; only the two words needed to recognise a
// device are kept, and the raw string is never stored.
test('nhãn chỉ giữ hai từ, không mang theo cả chuỗi user-agent', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const label = labelFromUserAgent(ua);
  assert.equal(label, 'iPhone · Safari');
  assert.ok(!label.includes('Mozilla'));
  assert.ok(!label.includes('15E148'), 'mã build là dấu vết nhận dạng, không được giữ');
  assert.ok(label.length < 30);
});

// The endpoint plus the VAPID key is the ability to push to that phone, so it
// must not travel to the browser just to name a row in a list.
test('id là băm của endpoint — endpoint KHÔNG bao giờ ra tới trình duyệt', () => {
  const ep = 'https://web.push.apple.com/BIMAT-secret-token-here';
  const pub = toPublicDevice({ endpoint: ep }, null);
  const all = JSON.stringify(pub);
  assert.ok(!all.includes('BIMAT-secret-token-here'), 'endpoint bị lộ ra trong dữ liệu công khai');
  assert.ok(!all.includes('keys'), 'khoá không được lộ');
  assert.match(pub.id, /^[0-9a-f]{16}$/);
  assert.equal(pub.id, deviceId(ep), 'id phải suy ra được từ endpoint, để xoá theo id');
});

test('id ổn định cho cùng endpoint, khác nhau giữa hai endpoint', () => {
  const a = 'https://web.push.apple.com/one';
  const b = 'https://web.push.apple.com/two';
  assert.equal(deviceId(a), deviceId(a));
  assert.notEqual(deviceId(a), deviceId(b));
});

test('đánh dấu đúng thiết bị đang hỏi, và chỉ nó', () => {
  const subs = [
    { endpoint: 'https://web.push.apple.com/a' },
    { endpoint: 'https://web.push.apple.com/b' },
    { endpoint: 'https://fcm.googleapis.com/c' },
  ];
  const list = listDevices(subs, 'https://web.push.apple.com/b');
  assert.deepEqual(list.map((d) => d.current), [false, true, false]);
});

test('không biết thiết bị hiện tại → không đánh dấu cái nào', () => {
  const subs = [{ endpoint: 'https://web.push.apple.com/a' }];
  for (const cur of [null, undefined, '', 42]) {
    assert.equal(listDevices(subs, cur)[0].current, false);
  }
});

// Everything registered before the hub started recording these fields.
test('bản ghi CŨ không có nhãn/ngày → trả về rỗng và null, không bịa', () => {
  const d = toPublicDevice({ endpoint: 'https://web.push.apple.com/cu' }, null);
  assert.equal(d.label, '');
  assert.equal(d.addedAt, null);
  assert.equal(d.service, 'Apple', 'dịch vụ vẫn đọc được từ endpoint có sẵn');
});

test('nhãn/ngày sai kiểu trong file trên đĩa → bỏ qua, không nổ', () => {
  const d = toPublicDevice({ endpoint: 'https://web.push.apple.com/x', label: 42, addedAt: 'hôm qua' }, null);
  assert.equal(d.label, '');
  assert.equal(d.addedAt, null);
});

test('danh sách rỗng hoặc thiếu → mảng rỗng, không nổ', () => {
  for (const bad of [null, undefined, []]) {
    assert.deepEqual(listDevices(bad, null), []);
  }
});
