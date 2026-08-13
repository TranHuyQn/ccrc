import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForSendKeys, MAX_KEY_BYTES } from '../src/key-chunks.js';

const join = (chunks) => Buffer.concat(chunks);

test('khối rỗng: không sinh lệnh nào', () => {
  assert.deepEqual(splitForSendKeys(Buffer.alloc(0)), { chunks: [], commit: null });
});

test('khối ngắn không có Enter: đúng một lệnh, nguyên vẹn', () => {
  const buf = Buffer.from('xin chao');
  const { chunks, commit } = splitForSendKeys(buf);
  assert.equal(chunks.length, 1);
  assert.equal(commit, null);
  assert.deepEqual(chunks[0], buf);
});

test('Enter cuối được tách ra thành lệnh riêng', () => {
  const { chunks, commit } = splitForSendKeys(Buffer.from('xin chao\r'));
  assert.deepEqual(join(chunks), Buffer.from('xin chao'), 'phần nội dung không được dính \\r');
  assert.deepEqual(commit, Buffer.from('\r'));
});

test('Enter trơ trọi KHÔNG bị tách — tách ra thì còn lại một lệnh rỗng', () => {
  const { chunks, commit } = splitForSendKeys(Buffer.from('\r'));
  assert.equal(commit, null);
  assert.deepEqual(join(chunks), Buffer.from('\r'));
});

test('\\r ở GIỮA không bị đụng tới — chỉ cái cuối cùng mới là cú gửi', () => {
  const { chunks, commit } = splitForSendKeys(Buffer.from('a\rb'));
  assert.equal(commit, null, 'không kết thúc bằng \\r thì không có gì để tách');
  assert.deepEqual(join(chunks), Buffer.from('a\rb'));
});

test('khối dài bị cắt nhỏ, ghép lại phải bằng đúng bản gốc', () => {
  const buf = Buffer.from('a'.repeat(5000) + '\r');
  const { chunks, commit } = splitForSendKeys(buf);
  assert.ok(chunks.length >= 5, `phải cắt thành nhiều khúc, nhận ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= MAX_KEY_BYTES, 'không khúc nào được vượt trần');
  assert.deepEqual(Buffer.concat([join(chunks), commit]), buf, 'ghép lại phải y hệt bản gốc');
});

test('không cắt vào giữa một ký tự UTF-8 nhiều byte', () => {
  // 'ữ' = 3 byte. Xếp sao cho chỗ cắt "ngây thơ" rơi đúng vào giữa nó.
  const s = 'ữ'.repeat(2000);
  const { chunks } = splitForSendKeys(Buffer.from(s), 100);
  for (const c of chunks) {
    assert.equal(c.toString('utf8').includes('�'), false,
      'một khúc chứa ký tự hỏng — chỗ cắt rơi vào giữa chuỗi byte UTF-8');
  }
  assert.equal(join(chunks).toString('utf8'), s, 'ghép lại phải ra đúng chuỗi ban đầu');
});

test('byte rác không làm chỗ cắt lùi vô hạn', () => {
  // Toàn byte tiếp diễn — không hợp lệ UTF-8. Vòng lùi phải dừng, không được
  // trả về khúc rỗng (khúc rỗng = vòng lặp bất tận ở nơi gọi).
  const buf = Buffer.alloc(500, 0x80);
  const { chunks } = splitForSendKeys(buf, 64);
  for (const c of chunks) assert.ok(c.length > 0, 'khúc rỗng sẽ treo vòng lặp gửi');
  assert.deepEqual(join(chunks), buf);
});

test('đúng trần: 1024 byte là một khúc, 1025 byte là hai', () => {
  assert.equal(splitForSendKeys(Buffer.alloc(MAX_KEY_BYTES, 0x61)).chunks.length, 1);
  assert.equal(splitForSendKeys(Buffer.alloc(MAX_KEY_BYTES + 1, 0x61)).chunks.length, 2);
});
