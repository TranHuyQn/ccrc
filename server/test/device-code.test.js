// Device-code cho máy dev: script in một mã ngắn, người duyệt gõ nó trên
// thiết bị đã đăng nhập, script đổi lấy token.
//
// Bất đối xứng ở đây là toàn bộ thiết kế: `userCode` ngắn để gõ được, nhưng
// thứ ĐỔI RA TOKEN là `deviceCode` 32 byte. Nếu `userCode` đổi được token thì
// tám ký tự đó là toàn bộ hàng rào (RFC 8628 tách hai thứ này vì đúng lý do
// đó).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_TTL_MS, MAX_PENDING, MAX_WRONG, POLL_INTERVAL_S,
  createDeviceCodes, normalizeUserCode,
} from '../src/device-code.js';

const GRANT = { name: 'U01ABCDEF', displayName: 'huy', token: 'tok-huy' };

// `now` tiêm được nên test không phải chờ thật; mặc định nhảy quá interval để
// poll không bị chặn nhịp.
function mk() {
  let t = 0;
  const d = createDeviceCodes({ now: () => t });
  return { d, tick: (s) => { t += s * 1000; }, at: (s) => { t = s * 1000; } };
}

test('happy path: start → approve → poll ra token', () => {
  const { d, tick } = mk();
  const s = d.start();
  assert.equal(s.ok, true);
  assert.equal(d.poll(s.deviceCode).status, 'pending');

  assert.deepEqual(d.approve('U01ABCDEF', s.userCode, GRANT), { ok: true });

  tick(POLL_INTERVAL_S);
  const p = d.poll(s.deviceCode);
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.grant, GRANT);
});

test('userCode KHÔNG đổi ra token được — chỉ deviceCode mới đổi được', () => {
  const { d, tick } = mk();
  const s = d.start();
  d.approve('U01ABCDEF', s.userCode, GRANT);
  tick(POLL_INTERVAL_S);
  assert.equal(d.poll(s.userCode).status, 'gone',
    'gõ userCode vào chỗ deviceCode phải vô dụng, không thì 8 ký tự là toàn bộ hàng rào');
});

test('poll xong một lần thì phiên chết, không đổi được lần hai', () => {
  const { d, tick } = mk();
  const s = d.start();
  d.approve('U01ABCDEF', s.userCode, GRANT);
  tick(POLL_INTERVAL_S);
  assert.equal(d.poll(s.deviceCode).status, 'ready');
  assert.equal(d.poll(s.deviceCode).status, 'gone');
});

test('poll nhanh hơn interval bị chặn nhịp', () => {
  const { d, tick } = mk();
  const s = d.start();
  assert.equal(d.poll(s.deviceCode).status, 'pending');
  tick(1);
  const p = d.poll(s.deviceCode);
  assert.equal(p.status, 'throttled');
  assert.ok(p.retryIn > 0);
});

test('quá TTL thì phiên chết', () => {
  const { d, at } = mk();
  const s = d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.poll(s.deviceCode).status, 'gone');
});

test('duyệt sau khi hết hạn thì không ăn thua', () => {
  const { d, at } = mk();
  const s = d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, false);
});

test('gõ sai đếm ngược, đủ MAX_WRONG thì khoá người duyệt đó', () => {
  const { d } = mk();
  const s = d.start();
  for (let i = 1; i < MAX_WRONG; i++) {
    const r = d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT);
    assert.equal(r.ok, false);
    assert.equal(r.remaining, MAX_WRONG - i);
  }
  assert.equal(d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT).remaining, 0);
  // Khoá rồi thì mã ĐÚNG cũng không dùng được nữa.
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, false);
  assert.equal(d.poll(s.deviceCode).status, 'pending');
});

test('khoá chỉ áp cho người gõ sai, không lây sang người khác', () => {
  const { d } = mk();
  const s = d.start();
  for (let i = 0; i < MAX_WRONG; i++) d.approve('U-KE-XAU', 'ZZZZ-ZZZZ', GRANT);
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, true);
});

test('gõ đúng thì bộ đếm sai được xoá', () => {
  const { d } = mk();
  const a = d.start();
  d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT);
  d.approve('U01ABCDEF', a.userCode, GRANT);
  const b = d.start();
  assert.equal(d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT).remaining, MAX_WRONG - 1);
  assert.equal(d.approve('U01ABCDEF', b.userCode, GRANT).ok, true);
});

test('chạm trần phiên pending thì từ chối cấp thêm', () => {
  const { d } = mk();
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(d.start().ok, true);
  const over = d.start();
  assert.equal(over.ok, false);
  assert.match(over.reason, /quá nhiều/i);
});

test('phiên hết hạn nhả lại chỗ trong trần', () => {
  const { d, at } = mk();
  for (let i = 0; i < MAX_PENDING; i++) d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.start().ok, true);
});

test('userCode hiện ra dạng XXXX-XXXX và không chứa ký tự dễ đọc nhầm', () => {
  const { d } = mk();
  for (let i = 0; i < 50; i++) {
    const { userCode } = d.start();
    assert.match(userCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      `mã đọc từ màn hình laptop rồi gõ sang điện thoại: ${userCode}`);
    assert.ok(!/[ILOU]/.test(userCode), `còn ký tự dễ nhầm: ${userCode}`);
  }
});

test('gõ mã bằng chữ thường hoặc thiếu gạch vẫn nhận', () => {
  const { d } = mk();
  const s = d.start();
  const messy = s.userCode.toLowerCase().replace('-', ' ');
  assert.equal(d.approve('U01ABCDEF', messy, GRANT).ok, true);
});

test('normalizeUserCode chịu được đầu vào rác', () => {
  assert.equal(normalizeUserCode('k7m2-qx9f'), 'K7M2QX9F');
  assert.equal(normalizeUserCode('  K7M2 QX9F '), 'K7M2QX9F');
  assert.equal(normalizeUserCode(null), '');
  assert.equal(normalizeUserCode(42), '');
});

test('deviceCode bịa ra không lấy được gì', () => {
  const { d } = mk();
  d.start();
  assert.equal(d.poll('bia-dat').status, 'gone');
  assert.equal(d.poll(undefined).status, 'gone');
});
