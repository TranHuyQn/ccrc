// Bắt tay phiên bản giữa trang và daemon.
//
// Bối cảnh (2026-08-17): daemon nạp code vào RAM lúc khởi động nhưng phục vụ
// term.js đọc thẳng từ đĩa, nên cập nhật bản cài trong lúc một daemon đang
// chạy để lại trang MỚI nói chuyện với daemon CŨ. Daemon cũ vứt mọi khung nó
// không biết bằng một `return` không lời, nên ô soạn gửi `ccrc_paste` vào hư
// không suốt hai ngày mà không ai biết.
//
// Điều khó nhất ở đây: daemon cũ KHÔNG THỂ tự khai là mình cũ — nó không biết
// khung `ccrc_chao`. Nên im lặng phải được đọc như một câu trả lời.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTermPage } from './dom-harness.mjs';
import { PROTOCOL_VERSION } from '../../shared/protocol-version.js';

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

// Trang là script cổ điển, không import module được, nên số phiên bản phải
// nằm hai nơi. Test này là thứ duy nhất giữ chúng bằng nhau — thiếu nó thì
// chính cơ chế chống lệch phiên bản lại là chỗ dễ lệch nhất.
test('số phiên bản trong term.js khớp với shared/protocol-version.js', () => {
  const termJs = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/term.js'), 'utf8');
  const m = termJs.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  assert.ok(m, 'không tìm thấy PROTOCOL_VERSION trong term.js');
  assert.equal(Number(m[1]), PROTOCOL_VERSION);
});

test('vừa nối là trang chào ngay, kèm phiên bản của chính nó', () => {
  const { ws } = connected();
  const chao = sentControls(ws).find((m) => m.type === 'ccrc_chao');
  assert.ok(chao, 'không gửi lời chào — daemon sẽ không có cơ hội khai phiên bản');
  assert.equal(chao.v, PROTOCOL_VERSION);
});

test('daemon cùng phiên bản: dùng bình thường, không phiền người dùng', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION }));

  assert.equal(page.oto.disabled, false);
  assert.doesNotMatch(page.trangthai.textContent, /bản cũ|remote off/i);
});

// --- ba cách một máy có thể lệch, cả ba dẫn tới cùng một việc phải làm -----

test('daemon IM LẶNG quá lâu: kết luận là bản quá cũ, khoá ô soạn', () => {
  const { page } = connected();
  // Daemon cũ không biết khung ccrc_chao nên nó `return` không lời. Đây đúng
  // là ca đã xảy ra thật, và là ca duy nhất không thể phát hiện bằng cách hỏi.
  while (page.clock.pending.length) page.clock.fireNext();

  assert.equal(page.oto.disabled, true);
  assert.match(page.trangthai.textContent, /remote off/i);
});

test('daemon khai phiên bản KHÁC: khoá ô soạn, nói đúng việc cần làm', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION + 1, dia: PROTOCOL_VERSION + 1 }));

  assert.equal(page.oto.disabled, true);
  assert.match(page.trangthai.textContent, /remote off/i);
});

test('daemon cùng phiên bản với trang nhưng ĐĨA đã mới hơn: vẫn phải nói', () => {
  // Bản cài vừa được cập nhật, daemon thì vẫn chạy code cũ trong RAM. Lần
  // `/remote on` tới nó sẽ nạp bản mới — nhưng ngay lúc này người dùng cần
  // biết, vì đây chính là tình trạng đã âm thầm kéo dài hai ngày.
  const { page, ws } = connected();
  ws.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION + 1 }));

  assert.match(page.trangthai.textContent, /remote off/i);
});

test('ô soạn bị khoá thì bấm Gửi không gửi gì cả', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION + 1, dia: PROTOCOL_VERSION + 1 }));

  page.oto.value = 'câu này sẽ rơi vào hư không';
  page.soan.dispatch('submit');

  assert.equal(sentControls(ws).some((m) => m.type === 'ccrc_paste'), false,
    'lệch phiên bản mà vẫn gửi là lừa người dùng: daemon cũ vứt im lặng');
  assert.equal(page.oto.value, 'câu này sẽ rơi vào hư không', 'và chữ phải ở lại');
});

test('nối lại được với daemon đã cập nhật thì mở khoá ô soạn', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION + 1, dia: PROTOCOL_VERSION + 1 }));
  assert.equal(page.oto.disabled, true);

  ws.dropped();
  page.clock.fireNext(); // hẹn giờ nối lại
  const ws2 = page.ws()[1];
  ws2.open();
  ws2.receive(JSON.stringify({ type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION }));

  assert.equal(page.oto.disabled, false, 'máy đã chạy bản đúng rồi mà ô vẫn khoá thì người dùng kẹt luôn');
});

// --- hub đã có bản mới hơn bản đang cài -----------------------------------
//
// Khác hẳn ba ca trên: ở đây trang và daemon vẫn hiểu nhau, mọi thứ vẫn chạy
// đúng. Chỉ là trên hub đã có bản mới hơn cái đang cài trên máy. Nên NÓI,
// nhưng không được cản trở gì — cản một thứ đang chạy tốt là làm phiền.

test('hub có bản mới hơn: nhắc cài lại, nhưng KHÔNG khoá ô soạn', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION + 1,
  }));

  assert.match(page.trangthai.textContent, /install\.sh/);
  assert.equal(page.oto.disabled, false, 'mọi thứ vẫn chạy đúng — cản ở đây là làm phiền vô cớ');
});

test('hub cùng phiên bản: không nhắc gì cả', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION,
  }));

  assert.doesNotMatch(page.trangthai.textContent, /install\.sh/);
});

test('hub chưa khai (bản hub cũ, hoặc chưa nhịp nào tới nơi): im lặng', () => {
  // `hub: null` nghĩa là CHƯA BIẾT. Coi nó như 0 rồi kết luận "hub cũ hơn" sẽ
  // bắt người dùng đi cài lại vì một chuyện không có thật.
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: null,
  }));

  assert.doesNotMatch(page.trangthai.textContent, /install\.sh/);
  assert.equal(page.oto.disabled, false);
});

// --- dấu vân tay: bắt cả bản chỉ sửa lỗi ----------------------------------
//
// Ranh giới quan trọng nhất của cả cơ chế nằm ở đây. Lệch HỢP ĐỒNG thì gửi đi
// là mất chữ, nên phải khoá. Lệch NỘI DUNG thì hai bên vẫn hiểu nhau và mọi
// thứ vẫn chạy đúng — chỉ là có bản mới hơn. Khoá ở đây là cản một thứ đang
// hoạt động, tức là làm phiền.

const VT = { ram: 'a'.repeat(64), moi: 'b'.repeat(64) };

test('đĩa đã có bản mới mà daemon chưa nạp: nhắc nạp lại, KHÔNG khoá', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION,
    vtRam: VT.ram, vtDia: VT.moi, vtHub: VT.moi,
  }));

  assert.match(page.trangthai.textContent, /remote off/i);
  assert.equal(page.oto.disabled, false, 'hợp đồng vẫn khớp nên mọi thứ vẫn chạy — khoá là làm phiền');
});

test('hub có bản mới hơn bản đã cài: nhắc chạy install.sh', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION,
    vtRam: VT.ram, vtDia: VT.ram, vtHub: VT.moi,
  }));

  assert.match(page.trangthai.textContent, /install\.sh/);
  assert.equal(page.oto.disabled, false);
});

test('mọi dấu vân tay khớp: im lặng tuyệt đối', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION,
    vtRam: VT.ram, vtDia: VT.ram, vtHub: VT.ram,
  }));

  assert.equal(page.trangthai.textContent, 'đã nối');
});

test('hub chưa khai dấu vân tay (bản hub cũ): không nhắc cài lại', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION, dia: PROTOCOL_VERSION, hub: PROTOCOL_VERSION,
    vtRam: VT.ram, vtDia: VT.ram, vtHub: null,
  }));

  assert.doesNotMatch(page.trangthai.textContent, /install\.sh/);
});

test('lệch hợp đồng thì vẫn khoá, dù dấu vân tay có nói gì đi nữa', () => {
  const { page, ws } = connected();
  ws.receive(JSON.stringify({
    type: 'ccrc_chao_lai', v: PROTOCOL_VERSION + 1, dia: PROTOCOL_VERSION + 1, hub: PROTOCOL_VERSION,
    vtRam: VT.ram, vtDia: VT.ram, vtHub: VT.ram,
  }));

  assert.equal(page.oto.disabled, true, 'mất chữ nặng hơn làm phiền — hợp đồng thắng');
});
