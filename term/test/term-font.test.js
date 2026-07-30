// The vendored terminal font, and the zoom lock, in term/public/term.js.
//
// What makes this worth testing is not "the font is applied" — it is the
// ORDER. xterm measures its cell size from whatever font resolves at the
// moment the Terminal is constructed, and that measurement decides the column
// count this page sends to tmux. Naming a still-downloading font in the
// constructor would have xterm measure the fallback and report a size derived
// from the wrong metrics — a silent, off-by-a-column version of the garbled
// terminal this project already shipped once. So: system stack first, switch
// only after the font has actually loaded, and re-fit when switching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTermPage } from './dom-harness.mjs';

const WEB_FONT = '"JetBrains Mono Web"';
const ICON_FONT = '"Nerd Icons Web"';

// A fake `document.fonts` whose load() this test resolves or rejects by hand,
// so the "font arrived" moment is an explicit step rather than a race.
function makeFonts() {
  const calls = [];
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return {
    calls,
    fonts: { load: (spec) => { calls.push(spec); return promise; } },
    arrive: () => { settle.resolve([]); return promise.then(() => {}, () => {}); },
    fail: () => { settle.reject(new Error('không tải được')); return promise.then(() => {}, () => {}); },
  };
}

test('dựng terminal bằng font HỆ THỐNG, không phải font đang tải', () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  const initial = page.term.opts.fontFamily;
  assert.ok(initial, 'không đặt fontFamily nào — xterm sẽ dùng Courier New mặc định');
  assert.ok(!initial.includes(WEB_FONT),
    'font nhúng bị đặt ngay lúc dựng → xterm đo nhầm ô, báo sai số cột cho tmux');
  assert.ok(initial.includes('ui-monospace'));
});

test('font tải xong → đổi sang font nhúng RỒI đo lại lưới', async () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  const fitsBefore = page.fitAddon.fitCount;

  assert.deepEqual(f.calls, ['16px "JetBrains Mono Web"', '16px "Nerd Icons Web"']);
  await f.arrive();

  assert.ok(page.term.options.fontFamily.startsWith(WEB_FONT),
    'font nhúng phải đứng ĐẦU stack, nếu không hệ thống vẫn thắng');
  // The re-fit is the half that is easy to forget: switching the font without
  // re-measuring leaves tmux believing the old column count.
  assert.ok(page.fitAddon.fitCount > fitsBefore, 'đổi font mà không đo lại lưới');
});

test('font nhúng vẫn giữ nguyên stack hệ thống làm dự phòng', async () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  await f.arrive();
  // ⏺ ⎿ ⠋ ✔ are in neither vendored font (see term.css) — they can only render
  // if the system stack is still behind them.
  assert.ok(page.term.options.fontFamily.includes('ui-monospace'));
  assert.ok(page.term.options.fontFamily.includes('Menlo'));
});

// Order is the whole design: JetBrains Mono supplies every letter, the icon
// font supplies only icons. Reversed, the icon font — which contains not one
// letter — would sit in front of the text font for no reason, and any glyph it
// happened to carry would win over the font chosen for its Vietnamese.
test('font chữ đứng TRƯỚC font icon trong stack', async () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  await f.arrive();
  const stack = page.term.options.fontFamily;
  assert.ok(stack.indexOf(WEB_FONT) >= 0, 'thiếu font chữ');
  assert.ok(stack.indexOf(ICON_FONT) >= 0, 'thiếu font icon');
  assert.ok(stack.indexOf(WEB_FONT) < stack.indexOf(ICON_FONT),
    `font icon đứng trước font chữ: ${stack}`);
});

// Switching resets xterm's cell measurement and re-fits the grid, which sends
// tmux a resize report. Doing it once per font would do that twice for nothing.
test('đợi CẢ HAI font rồi mới đổi — chỉ đo lại lưới một lần', async () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  const before = page.fitAddon.fitCount;
  await f.arrive();
  assert.equal(page.fitAddon.fitCount, before + 1, 'đo lại lưới nhiều hơn một lần');
});

// Naming a font that failed to load is harmless — the browser skips a family
// it does not have and moves down the stack — and with two vendored fonts it
// is the only rule that handles ONE of them failing. So the assertion is not
// "it refused to switch" (the old, single-font behaviour) but the thing that
// actually matters: whatever happens to a font, real text still has a font to
// come from and the terminal still works.
test('font tải HỎNG → trang vẫn chạy, chữ vẫn có font để rơi về', async () => {
  const f = makeFonts();
  // With a ticket, so the connection actually opens and the assertion below
  // has something real to check — the point is that a font failure costs the
  // terminal nothing, which is only visible on a page that connects.
  const page = loadTermPage({ fontsImpl: f.fonts, hash: '#t=ve-thu' });
  await f.fail();
  const stack = page.term.options.fontFamily;
  assert.ok(stack.includes('ui-monospace'), 'mất stack hệ thống thì không còn gì vẽ chữ');
  assert.ok(stack.includes('monospace'), 'phải luôn còn một họ monospace chung ở cuối');
  // Still connected and usable — a missing font must never cost the terminal.
  assert.equal(page.ws().length, 1);
});

test('trình duyệt không có document.fonts → không nổ, vẫn dựng terminal', () => {
  const page = loadTermPage({}); // fontsImpl bỏ trống → document.fonts undefined
  assert.ok(page.term, 'thiếu API font mà trang chết là hỏng nặng hơn nhiều');
  assert.ok(page.term.options.fontFamily.includes('ui-monospace'));
});

test('xterm từ chối gán fontFamily → nuốt lỗi, không đo lại, không chết', async () => {
  const f = makeFonts();
  const page = loadTermPage({ fontsImpl: f.fonts });
  const fitsBefore = page.fitAddon.fitCount;
  Object.defineProperty(page.term.options, 'fontFamily', {
    get() { return 'ui-monospace, Menlo, monospace'; },
    set() { throw new Error('options chỉ đọc'); },
    configurable: true,
  });
  await f.arrive();
  assert.equal(page.fitAddon.fitCount, fitsBefore, 'gán hỏng mà vẫn đo lại là sai luồng');
});

test('chặn cả ba sự kiện pinch-zoom của iOS Safari', () => {
  const page = loadTermPage({});
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    let blocked = false;
    page.document.dispatch(name, { preventDefault() { blocked = true; } });
    assert.equal(blocked, true, `${name} không bị chặn — iPhone vẫn phóng to được`);
  }
});
