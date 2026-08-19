import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';

test('gói rồi mở ra được nguyên vẹn', () => {
  const d = createFrameDecoder();
  const out = d.push(encodeFrame(FRAME.PANE, 'xin chao'));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, FRAME.PANE);
  assert.equal(out[0].payload.toString('utf8'), 'xin chao');
});

test('phân biệt pane với điều khiển bằng LOẠI, không phải nội dung', () => {
  // Đây là cả điểm của quy ước. Dự án từng đoán loại khung bằng "khung đầu
  // tiên là điều khiển" và kênh báo lỗi chết câm suốt một thời gian dài.
  const d = createFrameDecoder();
  const out = d.push(Buffer.concat([
    encodeFrame(FRAME.CONTROL, '{"type":"ccrc_loi"}'),
    encodeFrame(FRAME.PANE, '{"type":"ccrc_loi"}'),
  ]));
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, FRAME.CONTROL);
  assert.equal(out[1].kind, FRAME.PANE);
});

test('nhiều khung trong một lần đọc', () => {
  const d = createFrameDecoder();
  const out = d.push(Buffer.concat([
    encodeFrame(FRAME.PANE, 'a'), encodeFrame(FRAME.PANE, 'b'), encodeFrame(FRAME.PANE, 'c'),
  ]));
  assert.deepEqual(out.map((f) => f.payload.toString()), ['a', 'b', 'c']);
});

test('một khung bị cắt làm nhiều lần đọc', () => {
  // Pipe không hứa hẹn gì về ranh giới. Cắt từng byte một là ca xấu nhất.
  const d = createFrameDecoder();
  const frame = encodeFrame(FRAME.PANE, 'chuoi dai hon mot chut');
  let out = [];
  for (const b of frame) out = out.concat(d.push(Buffer.from([b])));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString(), 'chuoi dai hon mot chut');
});

test('payload rỗng vẫn là một khung hợp lệ', () => {
  const d = createFrameDecoder();
  const out = d.push(encodeFrame(FRAME.CONTROL, ''));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.length, 0);
});

test('UTF-8 nhiều byte bị cắt giữa chừng không hỏng', () => {
  // Cắt theo byte, ghép lại theo byte — không được decode sớm thành U+FFFD.
  const d = createFrameDecoder();
  const frame = encodeFrame(FRAME.PANE, 'tiếng Việt có dấu');
  const out = d.push(frame.subarray(0, 8)).concat(d.push(frame.subarray(8)));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString('utf8'), 'tiếng Việt có dấu');
});

test('từ chối khung khai độ dài vô lý thay vì cấp phát theo lời khai', () => {
  // Độ dài đến từ đầu bên kia của một pipe. Tin nó là để một khung hỏng xin
  // 4GB bộ nhớ.
  const bad = Buffer.alloc(5);
  bad.writeUInt8(FRAME.PANE, 0);
  bad.writeUInt32BE(0xffffffff, 1);
  const d = createFrameDecoder();
  assert.throws(() => d.push(bad), /qua dai|too large|khung/i);
});

test('khung hỏng là hỏng hẳn: bộ giải mã không tự đồng bộ lại', () => {
  // Đây là hợp đồng cố ý, không phải bug được giữ nguyên: một khi độ dài khai
  // báo hỏng, không còn biết ranh giới khung kế tiếp nằm ở đâu trong luồng
  // byte, nên đoán bừa để "tự hồi phục" chỉ khiến mọi thứ phía sau bị vẽ sai
  // vị trí một cách âm thầm. Bên gọi phải bỏ decoder và ngắt kết nối.
  const bad = Buffer.alloc(5);
  bad.writeUInt8(FRAME.PANE, 0);
  bad.writeUInt32BE(0xffffffff, 1);
  const d = createFrameDecoder();
  assert.throws(() => d.push(bad), /qua dai|too large|khung/i);

  const good = encodeFrame(FRAME.PANE, 'khung hop le sau do');
  assert.throws(() => d.push(good), /qua dai|too large|khung/i);
});
