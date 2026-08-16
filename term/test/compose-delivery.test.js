// Ô soạn: chữ của người dùng không được biến mất trừ khi nó đã thật sự tới pane.
//
// Bối cảnh (2026-08-16, Huy báo): "thỉnh thoảng soạn prompt xong bấm Gửi thì
// không thấy prompt đâu nữa, cũng không thấy được gửi vào terminal". Ô soạn
// trống đi NGAY khi bấm Gửi, không đợi biết chữ có đi được hay không — tức là
// "đã gọi hàm gửi" đang đứng thay cho "chữ đã tới pane", đúng khuôn cái bẫy
// mà dự án này đã vấp nhiều lần.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTermPage } from './dom-harness.mjs';

// Kết nối bằng khoá đã lưu — hình dạng thường gặp nhất khi người dùng đang
// dùng dở. Dữ liệu pane vào bằng receiveData() (khung nhị phân), khung điều
// khiển bằng receive() (khung text): đó là cái phân biệt hai đường, và một
// fixture dùng lẫn sẽ mô hình sai chính thứ đang được kiểm.
function connected(extra) {
  const page = loadTermPage(Object.assign({ storedKey: 'khoa-test' }, extra || {}));
  const ws = page.ws()[0];
  ws.open();
  return { page, ws };
}

function sentControls(ws) {
  return ws.sent
    .filter((s) => typeof s === 'string')
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

// --- Kênh báo lỗi: daemon nói được, nhưng trang có nghe không? -------------
//
// Bản vá 2026-08-15 thêm khung `ccrc_loi` để một lượt dán hỏng không còn im
// lặng. Nhưng trang chỉ coi frame ĐẦU TIÊN của mỗi socket là control frame;
// mọi frame sau đó đi thẳng vào term.write(). Nếu đúng thế thì lời báo lỗi ấy
// chưa bao giờ tới được mắt người dùng — nó bị đổ vào lưới terminal dưới dạng
// một cục JSON.

test('lỗi daemon báo sau khi đã nối hiện ở thanh trạng thái, không đổ vào lưới', () => {
  const { page, ws } = connected();
  ws.receiveData('nội dung màn hình lúc vừa nối');
  ws.receive(JSON.stringify({ type: 'ccrc_loi', message: 'tin nhắn quá dài (200000 byte)' }));

  assert.match(page.trangthai.textContent, /quá dài/);
  const rac = page.term.writes.filter((w) => String(w).includes('ccrc_loi'));
  assert.deepEqual(rac, [], 'khung điều khiển bị viết thẳng vào terminal');
});

// --- Lớp 1: socket không gửi được thì chữ phải ở lại ------------------------

test('bấm Gửi khi đang nối lại: chữ ở lại trong ô, không mất', () => {
  const { page, ws } = connected();
  ws.dropped(); // rớt mạng — trang chuyển sang chờ nối lại

  page.oto.value = 'prompt dài mình vừa soạn';
  page.soan.dispatch('submit');

  assert.equal(page.oto.value, 'prompt dài mình vừa soạn');
});

test('bấm Gửi khi đang nối lại: nói rõ là CHƯA gửi được', () => {
  const { page, ws } = connected();
  ws.dropped();

  page.oto.value = 'prompt dài mình vừa soạn';
  page.soan.dispatch('submit');

  assert.match(page.trangthai.textContent, /chưa gửi được/i);
});

test('bấm Gửi khi đang nối lại: chữ được ghi vào nháp ngay, không đợi gõ thêm', () => {
  const { page, ws } = connected();
  ws.dropped();

  // Đặt thẳng giá trị rồi submit, KHÔNG phát sự kiện input — đúng cảnh người
  // dùng gõ xong từ lâu (nháp đã lưu bản cũ hơn), rồi mới bấm Gửi. Nếu nhánh
  // này không tự lưu, đóng tab ngay lúc đó là mất đúng câu vừa soạn.
  page.oto.value = 'câu vừa soạn';
  page.soan.dispatch('submit');

  assert.equal(page.localStorage.getItem('ccrc_nhap'), 'câu vừa soạn');
});

// --- Lớp 2: chỉ xoá khi daemon xác nhận đã dán xong -------------------------
//
// Đóng nốt hai đường mà lớp 1 không với tới: socket chết kiểu half-open
// (readyState vẫn OPEN, send() không hề báo lỗi, dữ liệu vào hư không — rất
// thường gặp khi điện thoại đổi WiFi↔4G), và daemon nhận được nhưng từ chối.

// Ô trống đi NGAY để gõ câu tiếp được — 99% lượt gửi là xuôi, bắt người dùng
// đứng chờ mỗi lần là đắt hơn nhiều so với cái nó phòng. Nhưng chữ không hề
// bị vứt đi: nó nằm trong danh sách chờ, mang theo seq, và quay lại ô nếu lượt
// gửi ấy hỏng (xem ba test ngay dưới). Đây là chỗ dễ hiểu nhầm nhất của cả
// bản vá, nên nó có test riêng.
test('gửi xong ô trống ngay, nhưng chữ được giữ để trả lại nếu hỏng', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');

  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');
  assert.ok(paste, 'phải gửi khung ccrc_paste');
  assert.equal(typeof paste.seq, 'number', 'thiếu seq thì không ghép được lời xác nhận với lượt gửi');
  assert.equal(page.oto.value, '');

  // Bằng chứng chữ chưa bị vứt: cho lượt này hỏng, nó phải quay về.
  ws.receive(JSON.stringify({ type: 'ccrc_loi', seq: paste.seq, message: 'tmux không phản hồi' }));
  assert.equal(page.oto.value, 'câu hỏi cho Claude');
});

test('lượt gửi hỏng không đè lên câu người dùng đã gõ tiếp', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu một';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');

  // Người dùng gõ câu tiếp trong lúc chờ — chuyện thường, vì ô đã trống.
  page.oto.value = 'câu hai';
  ws.receive(JSON.stringify({ type: 'ccrc_loi', seq: paste.seq, message: 'tmux không phản hồi' }));

  assert.equal(page.oto.value, 'câu mộtcâu hai', 'chữ trả về phải đứng trước, không nuốt câu đang gõ');
});

test('daemon xác nhận dán xong thì ô mới trống', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');

  ws.receive(JSON.stringify({ type: 'ccrc_ack', seq: paste.seq }));

  assert.equal(page.oto.value, '');
});

test('daemon im lặng quá lâu: trả chữ về ô và nói rõ', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');

  // Bắn hết mọi hẹn giờ đang chờ — trong đó có đồng hồ chờ xác nhận.
  while (page.clock.pending.length) page.clock.fireNext();

  assert.equal(page.oto.value, 'câu hỏi cho Claude');
  assert.match(page.trangthai.textContent, /không nhận được xác nhận|chưa gửi được/i);
});

test('daemon từ chối lượt dán: trả chữ về ô kèm lý do', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');

  ws.receive(JSON.stringify({ type: 'ccrc_loi', seq: paste.seq, message: 'không dán được: tmux không phản hồi' }));

  assert.equal(page.oto.value, 'câu hỏi cho Claude');
  assert.match(page.trangthai.textContent, /tmux không phản hồi/);
});

// --- Nói đúng sự thật, kể cả khi không biết chắc ---------------------------
//
// Hết giờ chờ KHÔNG chứng minh tin nhắn chưa tới. Ca dễ xảy ra nhất — điện
// thoại đổi WiFi↔4G — làm mất đúng lời XÁC NHẬN, còn tin nhắn thì daemon vẫn
// dán vào pane bình thường (nó không cần socket để làm việc đó). Bảo người
// dùng "đã được trả lại" ở đây là mời họ gửi lần thứ hai một câu Claude đã
// nhận rồi.

test('hết giờ chờ: không được khẳng định là chưa gửi', () => {
  const { page } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  while (page.clock.pending.length) page.clock.fireNext();

  assert.match(page.trangthai.textContent, /có thể đã gửi/i);
});

test('xác nhận về muộn sau khi đã trả chữ: nói rõ là ĐÃ gửi được', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');
  while (page.clock.pending.length) page.clock.fireNext(); // hết giờ, chữ về ô

  ws.receive(JSON.stringify({ type: 'ccrc_ack', seq: paste.seq }));

  assert.match(page.trangthai.textContent, /ĐÃ gửi được/);
});

test('lời báo lỗi cũ không được xoá mất thông báo mới', () => {
  const { page, ws } = connected();
  // Một lỗi KHÔNG mang seq (vd tmux từ chối một lệnh nào đó) hẹn giờ 8 giây
  // để tự trả thanh trạng thái về "đã nối".
  ws.receive(JSON.stringify({ type: 'ccrc_loi', message: 'tmux từ chối lệnh' }));

  // Rồi một lượt gửi hỏng, và chữ được trả về ô kèm lời giải thích.
  page.oto.value = 'câu vừa gửi';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');
  ws.receive(JSON.stringify({ type: 'ccrc_loi', seq: paste.seq, message: 'tmux không phản hồi' }));
  const canhBao = page.trangthai.textContent;
  assert.match(canhBao, /trả lại/);

  // Bắn mọi hẹn giờ còn treo. Không được còn cái nào đủ sức xoá lời cảnh báo
  // đó đi — chữ đang nằm trong ô chờ người dùng xử lý, mà thanh trạng thái
  // lại nói "đã nối" thì họ sẽ không nhìn xuống.
  while (page.clock.pending.length) page.clock.fireNext();

  assert.equal(page.trangthai.textContent, canhBao,
    'hẹn giờ của lời báo lỗi cũ đã xoá mất lời cảnh báo mới');
});

// --- Lớp 3: nháp không bao giờ mất ----------------------------------------
//
// Kể cả trong khoảng 8 giây chờ xác nhận. Đây là chỗ lớp 2 suýt vô hiệu hoá
// lớp 3: ô trống đi thì nháp cũng bị dọn theo, nên suốt cửa sổ chờ ấy chữ chỉ
// còn nằm trong RAM — mà iOS thu hồi tab giữa chừng là chuyện thường, và đó
// đúng là lúc chữ đáng được giữ nhất.

test('chữ đang chờ xác nhận vẫn nằm trong bộ nhớ bền, không chỉ trong RAM', () => {
  const { page } = connected();
  page.oto.value = 'prompt dài đang chờ xác nhận';
  page.soan.dispatch('submit');

  assert.equal(page.oto.value, '');
  assert.equal(page.localStorage.getItem('ccrc_dang_gui'), 'prompt dài đang chờ xác nhận');
});

test('mở lại trang sau khi tab chết giữa lúc chờ: chữ hiện lại trong ô', () => {
  const page = loadTermPage({ storedKey: 'k', storedPending: 'prompt dài đang chờ xác nhận' });

  assert.equal(page.oto.value, 'prompt dài đang chờ xác nhận');
});

test('mở lại trang khi có cả nháp lẫn chữ đang chờ: chữ đang chờ đứng trước', () => {
  const page = loadTermPage({ storedKey: 'k', storedPending: 'câu đã bấm Gửi', storedDraft: 'câu gõ dở' });

  assert.equal(page.oto.value, 'câu đã bấm Gửicâu gõ dở');
});

test('xác nhận về thì chữ đang chờ được dọn khỏi bộ nhớ bền', () => {
  const { page, ws } = connected();
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');

  ws.receive(JSON.stringify({ type: 'ccrc_ack', seq: paste.seq }));

  assert.equal(page.localStorage.getItem('ccrc_dang_gui'), null);
});


test('chữ đang soạn được giữ lại để mở trang sau vẫn còn', () => {
  const { page } = connected();
  page.oto.value = 'nháp đang viết dở';
  page.oto.dispatch('input');

  assert.equal(page.localStorage.getItem('ccrc_nhap'), 'nháp đang viết dở');
});

test('mở lại trang thì nháp cũ hiện lại trong ô', () => {
  const page = loadTermPage({ storedKey: 'k', storedDraft: 'nháp đang viết dở' });

  assert.equal(page.oto.value, 'nháp đang viết dở');
});

test('gửi thành công thì nháp cũ bị dọn', () => {
  const { page, ws } = connected({ storedDraft: 'nháp đang viết dở' });
  page.oto.value = 'câu hỏi cho Claude';
  page.soan.dispatch('submit');
  const paste = sentControls(ws).find((m) => m.type === 'ccrc_paste');

  ws.receive(JSON.stringify({ type: 'ccrc_ack', seq: paste.seq }));

  assert.equal(page.localStorage.getItem('ccrc_nhap'), null);
});
