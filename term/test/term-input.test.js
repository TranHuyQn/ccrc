// The compose box, key bar, and virtual-keyboard relayout — Task 4. Same
// node:vm + fake-DOM approach as term-page.test.js (Task 3), and the SAME
// harness (dom-harness.mjs) — not a second one.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTermPage, KEY_BUTTONS } from './dom-harness.mjs';

// Keystrokes go out as BINARY frames (Uint8Array); control messages go out
// as TEXT frames (plain JSON strings) — see term.js's sendInput/sendControl
// and bin/ccrc-term.js's frame-type dispatch. Decodes either shape back to
// a comparable string for the tests below that check CONTENT; frame-TYPE
// itself is asserted separately (see "…bằng KHUNG NHỊ PHÂN" /
// "…bằng TEXT FRAME" tests further down).
function decodeSent(x) {
  return typeof x === 'string' ? x : new TextDecoder().decode(x);
}

function lastSent(page) {
  const ws = page.ws()[page.ws().length - 1];
  return ws.sent[ws.sent.length - 1];
}

// Small test-only wrapper around a loaded page: drives the compose box and
// key bar the way a user would (fill textarea + submit the form; click a
// key-bar button) and hands back exactly what term.js sent to the daemon
// over the WebSocket, so tests read like the brief's own examples
// (`gui.submit(...)`, `gui.press(...)`).
function makeGui(page) {
  return {
    submit(text) {
      page.oto.value = text;
      page.soan.dispatch('submit');
      return decodeSent(lastSent(page));
    },
    press(label) {
      const btn = page.phimButtons.find((b) => b.label === label);
      if (!btn) throw new Error('không tìm thấy nút thanh phím: ' + label);
      btn.el.dispatch('click');
      return decodeSent(lastSent(page));
    },
  };
}

// Reads the MOST RECENT JSON resize control message out of everything sent
// so far, if any — connecting also sends one immediately (see the
// "kết nối vừa mở..." test below), so callers checking a LATER relayout
// must not be satisfied by that earlier one. Control messages are always
// TEXT frames (plain strings) — a binary keystroke frame must never even be
// attempted here, so non-strings are filtered out before parsing.
function findResizeMessage(sent) {
  const msgs = sent
    .filter((s) => typeof s === 'string')
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((m) => m && m.type === 'ccrc_resize');
  return msgs[msgs.length - 1];
}

// --- Đường 1: ô soạn kiểu chat, bracketed paste (spec §5.2) ----------------

test('gửi nhiều dòng bọc trong bracketed paste, không thành nhiều Enter', () => {
  const page = loadTermPage({ storedKey: 'khoa-soan' });
  page.ws()[0].open();
  const gui = makeGui(page);

  const sent = gui.submit('dòng một\ndòng hai');
  assert.equal(sent, '\x1b[200~dòng một\ndòng hai\x1b[201~\r');
});

test('ô soạn gửi bằng KHUNG NHỊ PHÂN — daemon chỉ gõ vào pane những gì đến trên khung nhị phân', () => {
  const page = loadTermPage({ storedKey: 'khoa-soan-nhiphan' });
  page.ws()[0].open();
  page.oto.value = 'echo xin chao';
  page.soan.dispatch('submit');
  assert.ok(lastSent(page) instanceof Uint8Array, 'phím gõ phải đi bằng khung nhị phân, không phải text frame');
});

test('ô soạn được xoá sau khi gửi', () => {
  const page = loadTermPage({ storedKey: 'khoa-soan' });
  page.ws()[0].open();
  const gui = makeGui(page);

  gui.submit('git status');
  assert.equal(page.oto.value, '');
});

test('gửi chuỗi rỗng thì không gửi gì cả', () => {
  const page = loadTermPage({ storedKey: 'khoa-soan' });
  page.ws()[0].open(); // also sends one initial ccrc_resize — not what this test checks
  const before = page.ws()[0].sent.length;

  page.oto.value = '';
  page.soan.dispatch('submit');

  assert.equal(page.ws()[0].sent.length, before, 'không được gọi ws.send khi ô soạn rỗng');
});

test('Enter trong ô soạn xuống dòng, KHÔNG gửi', () => {
  const page = loadTermPage({ storedKey: 'khoa-soan' });
  page.ws()[0].open(); // also sends one initial ccrc_resize — not what this test checks
  const before = page.ws()[0].sent.length;

  page.oto.value = 'câu đang viết dở';
  // A <textarea> does not implicitly submit its form on Enter (unlike a
  // text <input>), so term.js must add NO keydown handling for this at
  // all. Dispatching the keydown here would only do something if term.js
  // wrongly wired one up.
  page.oto.dispatch('keydown', { key: 'Enter', shiftKey: false });

  assert.equal(page.ws()[0].sent.length, before, 'Enter một mình không được gửi gì');
  assert.equal(page.oto.value, 'câu đang viết dở', 'nội dung đang gõ không được mất');
});

// --- Đường 2: thanh phím điều khiển (spec §5.3) ----------------------------

test('mỗi nút thanh phím gửi đúng chuỗi thoát', () => {
  const page = loadTermPage({ storedKey: 'khoa-phim' });
  page.ws()[0].open();
  const gui = makeGui(page);

  assert.equal(gui.press('Esc'), '\x1b');
  assert.equal(gui.press('↑'), '\x1b[A');
  assert.equal(gui.press('↓'), '\x1b[B');
  assert.equal(gui.press('←'), '\x1b[D');
  assert.equal(gui.press('→'), '\x1b[C');
  assert.equal(gui.press('⏎'), '\r');
  assert.equal(gui.press('Tab'), '\t');
  assert.equal(gui.press('⇧Tab'), '\x1b[Z');
  assert.equal(gui.press('^C'), '\x03');
});

// The harness BUILDS its key bar from KEY_BUTTONS rather than parsing the
// page, so every test above would keep passing for a button that exists only
// in the harness. This is the one test that reads the real markup: it proves
// the list the tests exercise is the list the phone actually gets, in the
// same order.
test('thanh phím trong index.html khớp đúng danh sách test dùng', () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');
  const bar = /<div id="phim">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(bar, 'không tìm thấy #phim trong index.html');
  const declared = [...bar[1].matchAll(/<button data-seq="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
    .map((m) => [m[2], m[1]]);
  assert.deepEqual(declared, KEY_BUTTONS);
});

test('thanh phím gửi bằng KHUNG NHỊ PHÂN', () => {
  const page = loadTermPage({ storedKey: 'khoa-phim-nhiphan' });
  page.ws()[0].open();
  const btn = page.phimButtons.find((b) => b.label === 'Esc');
  btn.el.dispatch('click');
  assert.ok(lastSent(page) instanceof Uint8Array, 'phím thoát phải đi bằng khung nhị phân, không phải text frame');
});

test('bấm phím khi socket chưa mở thì không gửi và không crash', () => {
  const page = loadTermPage({ storedKey: 'khoa-chua-mo' });
  // deliberately never call .open() — socket is still CONNECTING
  const gui = makeGui(page);
  assert.doesNotThrow(() => gui.press('Esc'));
  assert.equal(page.ws()[0].sent.length, 0);
});

// --- Bàn phím ảo — hai nhánh code (spec §5.4) -------------------------------

test('Android: dùng VirtualKeyboard API khi có', () => {
  const listeners = {};
  const vk = {
    overlaysContent: false,
    boundingRect: { height: 260 },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const page = loadTermPage({ storedKey: 'khoa-vk', navigatorImpl: { virtualKeyboard: vk } });

  assert.equal(vk.overlaysContent, true, 'phải bật overlaysContent trên Android');
  assert.ok(listeners.geometrychange && listeners.geometrychange.length > 0,
    'phải lắng nghe navigator.virtualKeyboard geometrychange');

  page.ws()[0].open();
  page.term.cols = 100; page.term.rows = 40;
  const fitBefore = page.fitAddon.fitCount;
  for (const fn of listeners.geometrychange) fn({});

  assert.equal(page.fitAddon.fitCount, fitBefore + 1, 'geometrychange phải gọi lại fit()');
  const resizeMsg = findResizeMessage(page.ws()[0].sent);
  assert.deepEqual(resizeMsg, { type: 'ccrc_resize', cols: 100, rows: 40 });
});

test('iOS: lùi về visualViewport khi không có VirtualKeyboard', () => {
  const listeners = {};
  const vv = {
    height: 500,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  // navigatorImpl deliberately has no `virtualKeyboard` key at all — this is
  // what "does not exist on iOS Safari" looks like from feature-detection's
  // point of view.
  const page = loadTermPage({
    storedKey: 'khoa-vv',
    navigatorImpl: {},
    visualViewportImpl: vv,
    windowInnerHeight: 800,
  });

  assert.ok(listeners.resize && listeners.resize.length > 0,
    'phải lắng nghe visualViewport resize khi không có VirtualKeyboard');

  page.ws()[0].open();
  page.term.cols = 90; page.term.rows = 30;
  const fitBefore = page.fitAddon.fitCount;
  vv.height = 300; // on-screen keyboard now covers ~500px
  for (const fn of listeners.resize) fn({});

  assert.equal(page.fitAddon.fitCount, fitBefore + 1, 'visualViewport resize phải gọi lại fit()');
  const resizeMsg = findResizeMessage(page.ws()[0].sent);
  assert.deepEqual(resizeMsg, { type: 'ccrc_resize', cols: 90, rows: 30 });
});

test('đổi kích thước thì báo cols/rows xuống daemon', () => {
  const listeners = {};
  const vk = {
    overlaysContent: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const page = loadTermPage({ storedKey: 'khoa-resize', navigatorImpl: { virtualKeyboard: vk } });
  page.ws()[0].open();

  page.term.cols = 72; page.term.rows = 22;
  for (const fn of listeners.geometrychange) fn({});

  const resizeMsg = findResizeMessage(page.ws()[0].sent);
  assert.deepEqual(resizeMsg, { type: 'ccrc_resize', cols: 72, rows: 22 },
    'phải báo đúng cols/rows hiện tại của terminal xuống daemon');
});

test('kết nối vừa mở cũng tự báo kích thước ban đầu xuống daemon', () => {
  // The daemon needs SOME size before the user ever touches the keyboard —
  // waiting for the first relayout would leave it guessing at connect time.
  const page = loadTermPage({ storedKey: 'khoa-init' });
  page.term.cols = 84; page.term.rows = 26;
  page.ws()[0].open();

  const resizeMsg = findResizeMessage(page.ws()[0].sent);
  assert.deepEqual(resizeMsg, { type: 'ccrc_resize', cols: 84, rows: 26 });
});

test('báo resize gửi bằng TEXT FRAME (chuỗi JSON), KHÔNG phải khung nhị phân', () => {
  // This is the exact defect the coordinator flagged: sending the resize
  // report as input would make the daemon type it into the user's live
  // pane. The frame TYPE is what must keep it out, so assert on that
  // directly rather than only on decoded content.
  const page = loadTermPage({ storedKey: 'khoa-resize-frame' });
  page.term.cols = 84; page.term.rows = 26;
  page.ws()[0].open();

  // Located by CONTENT, not by position: opening the socket now also sends a
  // `ccrc_visibility` frame, and "the last thing sent" quietly stopped being
  // the resize report. Every control frame is checked for frame type, so
  // adding another one cannot weaken this.
  const sent = page.ws()[0].sent;
  for (const frame of sent) {
    assert.equal(typeof frame, 'string',
      'mọi khung điều khiển phải là text frame (chuỗi), không phải Uint8Array — nhị phân sẽ bị gõ thẳng vào pane');
  }
  const resize = sent.map((f) => JSON.parse(f)).find((m) => m.type === 'ccrc_resize');
  assert.deepEqual(resize, { type: 'ccrc_resize', cols: 84, rows: 26 });
});

// --- Cuộn: cử chỉ trở thành lệnh copy-mode của tmux -----------------------
//
// The browser has no scrollback to move. tmux drives the client screen
// directly, so lines that scroll off never enter xterm's buffer — measured in
// a real browser: after 140 lines of output the scroll area was still exactly
// one screen tall and a wheel event changed nothing on screen. CSS could not
// have fixed that; there was nothing to scroll. So a scroll gesture is a
// REQUEST sent to the daemon, and these tests are about what gets sent.

const controlFrames = (page) =>
  page.ws()[0].sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
const scrollFrames = (page) => controlFrames(page).filter((m) => m.type === 'ccrc_scroll');
const touchAt = (y) => ({ touches: [{ clientY: y }], cancelable: true, preventDefault() {} });

test('lăn chuột lên → xin cuộn NGƯỢC về lịch sử (số dương)', () => {
  const page = loadTermPage({ storedKey: 'k-wheel-up' });
  page.ws()[0].open();
  page.termContainer.dispatch('wheel', { deltaY: -100, preventDefault() {} });
  const f = scrollFrames(page);
  assert.equal(f.length, 1);
  assert.ok(f[0].lines > 0, `lăn lên phải cho số dương, nhận được ${f[0].lines}`);
});

test('lăn chuột xuống → xin cuộn về hiện tại (số âm)', () => {
  const page = loadTermPage({ storedKey: 'k-wheel-down' });
  page.ws()[0].open();
  page.termContainer.dispatch('wheel', { deltaY: 100, preventDefault() {} });
  assert.ok(scrollFrames(page)[0].lines < 0);
});

test('cuộn gửi bằng TEXT FRAME — khung nhị phân sẽ bị gõ thẳng vào pane', () => {
  const page = loadTermPage({ storedKey: 'k-frame' });
  page.ws()[0].open();
  page.termContainer.dispatch('wheel', { deltaY: -100, preventDefault() {} });
  for (const f of page.ws()[0].sent) {
    assert.equal(typeof f, 'string', 'khung nhị phân sẽ bị daemon gõ vào pane của người dùng');
  }
});

test('kéo ngón tay xuống → lộ ra dòng cũ; kéo lên → về hiện tại', () => {
  const down = loadTermPage({ storedKey: 'k-drag-down' });
  down.ws()[0].open();
  down.termContainer.dispatch('touchstart', touchAt(0));
  down.termContainer.dispatch('touchmove', touchAt(200));
  down.termContainer.dispatch('touchend', {});
  const a = scrollFrames(down);
  assert.ok(a.length >= 1 && a[0].lines > 0, 'kéo xuống phải lộ ra dòng cũ');

  const up = loadTermPage({ storedKey: 'k-drag-up' });
  up.ws()[0].open();
  up.termContainer.dispatch('touchstart', touchAt(200));
  up.termContainer.dispatch('touchmove', touchAt(0));
  const b = scrollFrames(up);
  assert.ok(b.length >= 1 && b[0].lines < 0);
});

// Selecting text to copy is the other thing this surface has to support, and
// it is driven by the same finger. A drag extending a selection is not a
// scroll; stealing it would remove copy entirely.
test('đang bôi đen thì kéo KHÔNG bị hiểu thành cuộn', () => {
  const page = loadTermPage({ storedKey: 'k-sel', selectionCollapsed: false });
  page.ws()[0].open();
  page.termContainer.dispatch('touchstart', touchAt(0));
  page.termContainer.dispatch('touchmove', touchAt(200));
  assert.equal(scrollFrames(page).length, 0, 'cướp cử chỉ bôi đen là mất tính năng copy');
});

test('ngón tay gần như đứng yên (giữ lâu để bôi đen) không sinh lệnh cuộn', () => {
  const page = loadTermPage({ storedKey: 'k-hold' });
  page.ws()[0].open();
  page.termContainer.dispatch('touchstart', touchAt(100));
  page.termContainer.dispatch('touchmove', touchAt(103)); // chưa đủ một dòng
  assert.equal(scrollFrames(page).length, 0);
});

test('số dòng bị chặn trần — không gửi số vô lý xuống dòng lệnh tmux', () => {
  const page = loadTermPage({ storedKey: 'k-clamp' });
  page.ws()[0].open();
  page.termContainer.dispatch('wheel', { deltaY: -999999, preventDefault() {} });
  const f = scrollFrames(page)[0];
  assert.ok(Number.isInteger(f.lines), 'phải là số nguyên');
  assert.ok(Math.abs(f.lines) <= 500, `vượt trần: ${f.lines}`);
});

test('cuộn khi socket chưa mở: không gửi gì, không crash', () => {
  const page = loadTermPage({ storedKey: 'k-closed' });
  assert.doesNotThrow(() => page.termContainer.dispatch('wheel', { deltaY: -100, preventDefault() {} }));
  assert.equal(page.ws()[0].sent.length, 0);
});
