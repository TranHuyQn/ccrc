// createRateLimit — chốt thứ hai mà spec §5.2 đòi cho /api/device/start.
// Đồng hồ tiêm vào, nên mọi biên thời gian ở đây được kiểm mà không phải chờ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit } from '../src/rate-limit.js';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('cho qua đúng `limit` lượt rồi chặn', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 3, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.hit('1.2.3.4').ok, true, `lượt ${i + 1} phải được qua`);
  }
  assert.equal(rl.hit('1.2.3.4').ok, false, 'lượt thứ 4 phải bị chặn');
});

test('mỗi IP có rổ riêng — một kẻ tấn công không khoá được cả team', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 2, windowMs: 60_000, now: c.now });
  rl.hit('1.1.1.1');
  rl.hit('1.1.1.1');
  assert.equal(rl.hit('1.1.1.1').ok, false);
  assert.equal(rl.hit('2.2.2.2').ok, true, 'IP khác không được dính án của IP kia');
});

test('hết cửa sổ thì đếm lại từ đầu', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 1, windowMs: 60_000, now: c.now });
  assert.equal(rl.hit('ip').ok, true);
  assert.equal(rl.hit('ip').ok, false);
  c.advance(60_000);
  assert.equal(rl.hit('ip').ok, true, 'qua cửa sổ là được thử lại');
});

// Cửa sổ CỐ ĐỊNH, không trượt: nếu mỗi lượt bị chặn lại đẩy hạn xa thêm thì
// một người bấm nhầm hai lần bị phạt nặng hơn kẻ đang tấn công.
test('lượt bị chặn KHÔNG kéo dài cửa sổ', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 1, windowMs: 60_000, now: c.now });
  rl.hit('ip');
  c.advance(30_000);
  assert.equal(rl.hit('ip').ok, false);
  c.advance(30_000);   // đúng 60s kể từ lượt ĐẦU
  assert.equal(rl.hit('ip').ok, true);
});

test('retryIn nói đúng còn bao nhiêu giây, và không bao giờ là 0', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 1, windowMs: 60_000, now: c.now });
  rl.hit('ip');
  c.advance(20_000);
  assert.equal(rl.hit('ip').retryIn, 40);
  c.advance(39_999);
  assert.equal(rl.hit('ip').retryIn, 1, 'làm tròn xuống 0 thì client quay lại ngay và lại bị chặn');
});

// Người gọi ghi log dựa vào cờ này. Không có nó thì hoặc log im lặng (đúng
// cái mà finding này sinh ra để sửa), hoặc mỗi request bị chặn là một dòng —
// tức là kẻ tấn công điều khiển được lượng log của hub.
test('firstTrip bật đúng một lần cho mỗi cửa sổ chạm trần', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 1, windowMs: 60_000, now: c.now });
  rl.hit('ip');
  assert.equal(rl.hit('ip').firstTrip, true);
  assert.equal(rl.hit('ip').firstTrip, false);
  c.advance(60_000);
  rl.hit('ip');                                     // cửa sổ mới, được qua
  assert.equal(rl.hit('ip').firstTrip, true, 'cửa sổ mới thì lại đáng một dòng log');
});

test('entry hết hạn được dọn lười, bộ đếm không phình mãi', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 5, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 100; i++) rl.hit(`ip-${i}`);
  assert.equal(rl.size(), 100);
  c.advance(60_000);
  assert.equal(rl.size(), 0, 'dọn phải xảy ra mà không cần timer nào');
});

// Bản thân bộ đếm cũng là RAM mà người lạ điều khiển được lượng — cùng lý do
// MAX_PENDING tồn tại trong device-code.js.
test('số khoá theo dõi có trần của chính nó', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 5, windowMs: 60_000, now: c.now, maxKeys: 10 });
  for (let i = 0; i < 50; i++) rl.hit(`ip-${i}`);
  assert.ok(rl.size() <= 10, `size=${rl.size()} — trần maxKeys không có tác dụng`);
});

test('khoá rỗng/không phải chuỗi vẫn bị đếm, không được miễn trừ', () => {
  const c = fakeClock();
  const rl = createRateLimit({ limit: 1, windowMs: 60_000, now: c.now });
  assert.equal(rl.hit(null).ok, true);
  assert.equal(rl.hit(undefined).ok, false,
    'không đọc được IP không phải là được đi tự do — mọi request phải nằm dưới một cái trần nào đó');
});
