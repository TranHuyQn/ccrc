import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenBuffer } from '../src/screen-buffer.js';

// Nạp nhiều dòng đánh số, trả về buffer đã sẵn sàng để hỏi.
async function dungBuffer({ cols = 40, rows = 6, soDong = 30 } = {}) {
  const b = createScreenBuffer({ cols, rows, scrollback: 1000 });
  for (let i = 1; i <= soDong; i++) await b.write(`dong-${i}\r\n`);
  return b;
}

test('snapshot() đóng khung y như bản tmux', async () => {
  const b = await dungBuffer({ soDong: 3 });
  const s = b.snapshot();
  b.dispose();
  // Ba thứ này là hợp đồng với trình duyệt, không phải trang trí: clear+home
  // để màn hình về trạng thái biết trước, và SGR reset để một màu bỏ ngỏ
  // không nhuộm mọi dòng gửi sau đó.
  assert.ok(s.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
  assert.ok(s.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  assert.match(s, /dong-3/);
});

test('snapshot() cắt dòng trắng ở cuối', async () => {
  // Pane cao 6 dòng nhưng chỉ có 2 dòng chữ: 4 dòng trắng còn lại phải biến
  // mất, nếu không màn hình trình duyệt (thấp hơn) sẽ cuộn mất phần có chữ.
  const b = createScreenBuffer({ cols: 40, rows: 6, scrollback: 100 });
  await b.write('mot\r\nhai\r\n');
  const s = b.snapshot();
  b.dispose();
  const than = s.slice('\x1b[2J\x1b[H'.length, -'\x1b[0m'.length);
  const dong = than.split('\r\n');
  assert.equal(dong[dong.length - 1].trim() !== '', true, 'dòng cuối phải có chữ');
});

test('historySize() bằng số dòng đã trôi lên trên màn hình', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  const n = b.historySize();
  b.dispose();
  // 30 dòng ghi vào một màn hình 6 dòng: 25 dòng nằm trên. Đo được trên
  // @xterm/headless 6.0.0 — baseY = 25.
  assert.equal(n, 25);
});

test('historySize() bằng 0 khi chưa có gì trôi lên', async () => {
  const b = createScreenBuffer({ cols: 40, rows: 6, scrollback: 100 });
  await b.write('mot\r\n');
  const n = b.historySize();
  b.dispose();
  assert.equal(n, 0);
});

test('history() trả đúng cửa sổ được hỏi, đúng số dòng', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  // offset=10 nghĩa là bắt đầu từ 10 dòng phía trên đỉnh màn hình.
  // baseY=25, nên cửa sổ bắt đầu ở dòng 15 (0-based) = "dong-16".
  const s = b.history(10, 3);
  b.dispose();
  assert.ok(s.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
  assert.ok(s.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  const than = s.slice('\x1b[2J\x1b[H'.length, -'\x1b[0m'.length);
  const dong = than.split('\r\n');
  assert.equal(dong.length, 3, 'phải trả đúng số dòng được hỏi');
  assert.match(dong[0], /dong-16/);
  assert.match(dong[2], /dong-18/);
});

test('history() giữ được màu', async () => {
  // Mất màu là thứ khiến `getLine().translateToString()` không dùng được, và
  // là lý do module này phải đi qua serialize. Bài test canh chính điều đó.
  const b = createScreenBuffer({ cols: 40, rows: 4, scrollback: 100 });
  for (let i = 1; i <= 20; i++) {
    await b.write(i === 5 ? '\x1b[31mDO-O-DAY\x1b[0m\r\n' : `dong-${i}\r\n`);
  }
  // offset=13, không phải 12. Đo trực tiếp: 20 dòng ghi vào màn hình 4 dòng
  // cho baseY=17 (= 20 dòng + 1 dòng trắng đang gõ dở − 4 dòng màn hình),
  // không phải 16 như phép trừ đơn giản "20 − 4" gợi ý — cùng công thức
  // baseY = tổng-dòng-đã-ghi + 1 − rows đã xác nhận ở bài historySize() bên
  // trên (30 dòng, 6 hàng → baseY=25). DO-O-DAY là dòng thứ 5, tức chỉ số 0
  // là 4; để nó lọt vào cửa sổ [baseY-offset, ...] cần offset ≥ baseY-4=13.
  const s = b.history(13, 4);
  b.dispose();
  assert.match(s, /DO-O-DAY/);
  assert.match(s, /\x1b\[[0-9;]*m/, 'phải còn mã màu');
});

test('history() trả chuỗi rỗng với tham số vô lý, không ném', async () => {
  const b = await dungBuffer();
  const s = b;
  assert.equal(s.history(0, 5), '');
  assert.equal(s.history(10, 0), '');
  assert.equal(s.history(-1, 5), '');
  assert.equal(s.history(10, -1), '');
  b.dispose();
});

test('resize() không làm mất lịch sử', async () => {
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  const truoc = b.historySize();
  b.resize(60, 10);
  const sau = b.historySize();
  b.dispose();
  // Không khẳng định hai số bằng nhau: đổi chiều rộng làm xterm gói lại dòng,
  // nên số dòng lịch sử ĐƯỢC PHÉP đổi. Điều phải giữ là không mất sạch.
  assert.ok(truoc > 0 && sau > 0, `lịch sử không được biến mất (${truoc} → ${sau})`);
});

test('history() với offset vượt xa lịch sử: kẹp về dòng sớm nhất, không ném, không rỗng', async () => {
  // Module này sắp được ConPTY thật nuôi offset không giới hạn — một lần kẹp
  // sai là màn hình lạ, không phải lỗi. Nên bài test này không chỉ kiểm tra
  // "không ném", mà kiểm tra ĐÚNG nội dung dòng bắt đầu.
  const b = await dungBuffer({ rows: 6, soDong: 30 });
  // baseY=25 (đã đo ở bài historySize() bên trên). offset=9999 vượt xa 25 nên
  // phải kẹp về o=25 — cửa sổ bắt đầu ở dòng 0 (0-based) = "dong-1", đúng
  // dòng sớm nhất còn trong lịch sử.
  const s = b.history(9999, 3);
  b.dispose();
  assert.ok(s.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
  assert.ok(s.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  const than = s.slice('\x1b[2J\x1b[H'.length, -'\x1b[0m'.length);
  const dong = than.split('\r\n');
  assert.equal(dong.length, 3, 'phải trả đúng số dòng được hỏi, không phải khung rỗng');
  assert.match(dong[0], /dong-1$/, 'cửa sổ kẹp phải bắt đầu ở dòng sớm nhất, không phải dòng nào khác');
  assert.match(dong[2], /dong-3$/);
});

test('history() khi chưa có gì trôi lên (baseY=0) trả chuỗi rỗng', async () => {
  const b = createScreenBuffer({ cols: 40, rows: 6, scrollback: 100 });
  await b.write('mot\r\n');
  assert.equal(b.historySize(), 0);
  const s = b.history(1, 5);
  b.dispose();
  assert.equal(s, '', 'không có lịch sử để trả về thì phải là chuỗi rỗng, không phải khung trống');
});
