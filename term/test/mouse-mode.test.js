import test from 'node:test';
import assert from 'node:assert/strict';
import { createMouseMode } from '../src/mouse-mode.js';

test('mặc định là không có chuột — hướng an toàn duy nhất', () => {
  // Không biết thì KHÔNG gửi byte chuột. Gửi nhầm vào shell trần là gõ rác
  // vào dòng lệnh người dùng; không gửi thì cùng lắm là cuộn không ăn.
  assert.deepEqual(createMouseMode().state(), { mouse: false, sgr: false });
});

test('bật rồi tắt từng chế độ một', () => {
  const m = createMouseMode();
  for (const mode of [1000, 1002, 1003]) {
    m.feed(`\x1b[?${mode}h`);
    assert.equal(m.state().mouse, true, `${mode}h phải bật chuột`);
    m.feed(`\x1b[?${mode}l`);
    assert.equal(m.state().mouse, false, `${mode}l phải tắt chuột`);
  }
});

test('1006 là cách MÃ HOÁ, không phải bật chuột', () => {
  const m = createMouseMode();
  m.feed('\x1b[?1006h');
  assert.deepEqual(m.state(), { mouse: false, sgr: true });
  m.feed('\x1b[?1000h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
});

test('nhiều chế độ trong một chuỗi, ngăn bằng dấu chấm phẩy', () => {
  // Đây là hình dạng thật mà ứng dụng gửi: `ESC[?1002;1006h`.
  const m = createMouseMode();
  m.feed('\x1b[?1002;1006h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
  m.feed('\x1b[?1002;1006l');
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
});

test('tắt một chế độ không tắt chế độ khác đang bật', () => {
  const m = createMouseMode();
  m.feed('\x1b[?1000h');
  m.feed('\x1b[?1003h');
  m.feed('\x1b[?1000l');
  assert.equal(m.state().mouse, true, '1003 vẫn còn bật');
  m.feed('\x1b[?1003l');
  assert.equal(m.state().mouse, false);
});

test('chuỗi bị cắt làm đôi giữa hai lần đọc vẫn nhận ra', () => {
  // Đây là cái bẫy thật của việc đọc luồng: ConPTY trả từng mảng byte, và
  // một chuỗi escape không hứa nằm gọn trong một mảng.
  const m = createMouseMode();
  m.feed('\x1b[?10');
  m.feed('02;1006h');
  assert.deepEqual(m.state(), { mouse: true, sgr: true });
});

test('không nhầm chuỗi khác thành chế độ chuột', () => {
  const m = createMouseMode();
  m.feed('\x1b[?25l');        // ẩn con trỏ
  m.feed('\x1b[?1049h');      // màn hình phụ
  m.feed('\x1b[2J');          // xoá màn hình
  m.feed('chu binh thuong 1000h');
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
});

test('bộ đệm không phình vô hạn khi gặp ESC[ không bao giờ kết thúc', () => {
  // Một luồng nhị phân bất kỳ có thể chứa `ESC[` rồi không bao giờ có ký tự
  // kết thúc. Giữ mãi phần đuôi là rò bộ nhớ trong một tiến trình chạy nhiều
  // ngày.
  const m = createMouseMode();
  m.feed('\x1b[' + 'x'.repeat(100_000));
  assert.deepEqual(m.state(), { mouse: false, sgr: false });
  m.feed('\x1b[?1000h');
  assert.equal(m.state().mouse, true, 'vẫn phải nhận ra chuỗi hợp lệ sau đó');
});
