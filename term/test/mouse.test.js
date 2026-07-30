// Encoding a wheel event, and choosing when to send one at all.
//
// This whole path exists because the earlier scroll implementation was tested
// against the WRONG SHAPE. It was exercised with `echo` in a bare shell — a
// pane with real tmux scrollback — while the actual target is Claude Code: a
// full-screen TUI on the alternate screen, where measurement on the live
// session showed `alternate_on=1` and `history_size=2`. There is no tmux
// history to page. The conversation lives inside the application, and the
// application had mouse reporting switched on (`mouse_any_flag=1`,
// `mouse_sgr_flag=1`), which is the way in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelEvent, wheelBytes, clickBytes, notchesForLines, LINES_PER_NOTCH, MAX_NOTCHES } from '../src/mouse.js';

test('SGR: lăn lên là nút 64, lăn xuống là 65', () => {
  assert.equal(wheelEvent({ up: true, sgr: true, col: 40, row: 12 }), '\x1b[<64;40;12M');
  assert.equal(wheelEvent({ up: false, sgr: true, col: 40, row: 12 }), '\x1b[<65;40;12M');
});

// Verified by hand against `less --mouse` through tmux before this was
// written: five of the "down" sequence moved the view from line 1 to line 6,
// three "up" brought it back to line 3.
test('SGR khớp đúng chuỗi đã thử tay qua tmux', () => {
  const hex = Buffer.from(wheelEvent({ up: false, sgr: true, col: 40, row: 12 }), 'binary').toString('hex');
  assert.equal(hex, '1b5b3c36353b34303b31324d');
});

test('kiểu cũ (không SGR): mỗi trường một byte, cộng 32', () => {
  const s = wheelEvent({ up: true, sgr: false, col: 1, row: 1 });
  assert.equal(s.length, 6);
  assert.equal(s.slice(0, 3), '\x1b[M');
  assert.equal(s.charCodeAt(3), 32 + 64, 'nút lăn lên');
  assert.equal(s.charCodeAt(4), 32 + 1);
  assert.equal(s.charCodeAt(5), 32 + 1);
});

// The legacy encoding has one byte per coordinate, so anything past 223 simply
// cannot be expressed. Wrapping would point at a completely different cell.
test('kiểu cũ: toạ độ vượt 223 bị kẹp, KHÔNG bị quấn vòng', () => {
  const s = wheelEvent({ up: true, sgr: false, col: 5000, row: 5000 });
  assert.equal(s.charCodeAt(4), 32 + 223);
  assert.equal(s.charCodeAt(5), 32 + 223);
});

test('SGR không có trần toạ độ — số thập phân, viết bao nhiêu cũng được', () => {
  assert.equal(wheelEvent({ up: true, sgr: true, col: 5000, row: 4000 }), '\x1b[<64;5000;4000M');
});

test('toạ độ 0 hoặc âm được nâng lên 1 — cả hai kiểu đều đánh số từ 1', () => {
  for (const bad of [0, -5, NaN, undefined, null]) {
    assert.equal(wheelEvent({ up: true, sgr: true, col: bad, row: bad }), '\x1b[<64;1;1M');
  }
});

test('quy đổi số dòng sang số nấc lăn', () => {
  assert.equal(notchesForLines(LINES_PER_NOTCH), 1);
  assert.equal(notchesForLines(LINES_PER_NOTCH * 4), 4);
  // Direction is decided by the caller; this only ever answers "how many".
  assert.equal(notchesForLines(-LINES_PER_NOTCH * 4), 4);
});

test('kéo nhẹ vẫn phải cuộn được ít nhất một nấc', () => {
  assert.equal(notchesForLines(1), 1);
  assert.equal(notchesForLines(0.4), 1);
});

// One flick must not turn into hundreds of send-keys calls into tmux.
test('số nấc bị chặn trần', () => {
  assert.equal(notchesForLines(100000), MAX_NOTCHES);
  assert.equal(notchesForLines(-100000), MAX_NOTCHES);
});

test('wheelBytes lặp đúng số nấc', () => {
  const one = wheelEvent({ up: true, sgr: true, col: 1, row: 1 });
  assert.equal(wheelBytes({ up: true, sgr: true, col: 1, row: 1, notches: 3 }), one.repeat(3));
});

test('wheelBytes: số nấc vô lý bị chặn, không sinh chuỗi khổng lồ', () => {
  const one = wheelEvent({ up: true, sgr: true, col: 1, row: 1 });
  assert.equal(wheelBytes({ up: true, sgr: true, col: 1, row: 1, notches: 99999 }).length, one.length * MAX_NOTCHES);
  for (const bad of [0, -3, NaN, undefined]) {
    assert.equal(wheelBytes({ up: true, sgr: true, col: 1, row: 1, notches: bad }), one);
  }
});

// Every byte reaches a real terminal, so nothing may sneak in that a terminal
// would read as a different command.
test('chuỗi sinh ra chỉ gồm byte của đúng một chuỗi thoát chuột', () => {
  for (const sgr of [true, false]) {
    const s = wheelBytes({ up: true, sgr, col: 40, row: 12, notches: 2 });
    assert.ok(s.startsWith('\x1b['), 'phải bắt đầu bằng CSI');
    assert.ok(!s.includes('\n') && !s.includes('\r'), 'không được chứa xuống dòng');
    assert.ok(!s.includes(';;'), 'tham số rỗng là chuỗi thoát hỏng');
  }
});

// --- bấm ------------------------------------------------------------------
//
// The user's report: "Jump to bottom (click) ↓" — a button drawn INSIDE the
// terminal by Claude Code. There is no DOM element to attach anything to, so
// a tap has to reach the application as a real click at a real cell.

test('SGR: một cú bấm gồm NHẤN rồi NHẢ', () => {
  assert.equal(clickBytes({ sgr: true, col: 37, row: 11 }),
    '\x1b[<0;37;11M\x1b[<0;37;11m');
});

// A press on its own reads as a finger still held down; applications fire on
// the release. Dropping it would make the button look broken rather than
// unimplemented.
test('KHÔNG được thiếu sự kiện nhả', () => {
  const s = clickBytes({ sgr: true, col: 5, row: 5 });
  assert.ok(s.endsWith('m'), `thiếu phần nhả: ${JSON.stringify(s)}`);
  assert.equal((s.match(/\x1b\[</g) || []).length, 2, 'phải có đúng hai sự kiện');
});

test('kiểu cũ: nhả dùng nút 3 — mã hoá này không nói được nút nào được nhả', () => {
  const s = clickBytes({ sgr: false, col: 1, row: 1 });
  assert.equal(s.length, 12, 'hai sự kiện, mỗi cái 6 byte');
  assert.equal(s.charCodeAt(3), 32 + 0, 'nhấn: nút trái');
  assert.equal(s.charCodeAt(9), 32 + 3, 'nhả: nút 3');
});

test('kiểu cũ: toạ độ bấm vượt 223 bị kẹp', () => {
  const s = clickBytes({ sgr: false, col: 5000, row: 5000 });
  assert.equal(s.charCodeAt(4), 32 + 223);
  assert.equal(s.charCodeAt(5), 32 + 223);
});

test('toạ độ bấm 0 hoặc âm được nâng lên 1', () => {
  for (const bad of [0, -9, NaN, undefined, null]) {
    assert.equal(clickBytes({ sgr: true, col: bad, row: bad }), '\x1b[<0;1;1M\x1b[<0;1;1m');
  }
});

test('bấm KHÔNG sinh ra nút lăn — lẫn nút là bấm thành cuộn', () => {
  const s = clickBytes({ sgr: true, col: 10, row: 10 });
  assert.ok(!s.includes('<64;') && !s.includes('<65;'));
});
