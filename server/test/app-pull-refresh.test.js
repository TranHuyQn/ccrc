// Exercises the pull-to-refresh gesture and the zoom lock in
// server/public/app.js through the same node:vm fake-DOM harness the terminal
// list tests use.
//
// The property that matters is not "a long drag reloads" — it is that the
// gesture is claimed ONLY in the one situation it belongs in. A pull-to-
// refresh that fires mid-page, or on the login screen, or on an upward
// scroll, would make the page feel broken in a way that is much worse than
// not having the gesture at all. Most of the tests below are about refusing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

// Mirrors app.js's own constants — a drag is measured after PTR_RESISTANCE
// (0.5) is applied, so crossing the 70px threshold takes a 140px+ finger
// travel. Tests state finger distances and let the code do the halving.
const PULL_PAST_THRESHOLD = 200; // → 100px of indicator travel, armed
const PULL_SHORT = 60;           // → 30px, not armed

// Drives one complete gesture: touchstart, one or more touchmoves, touchend.
// `moves` are finger positions relative to the start point.
function pull(page, moves, { end = 'touchend' } = {}) {
  const prevented = [];
  const ev = (y) => ({
    touches: [{ clientY: y }],
    cancelable: true,
    preventDefault() { prevented.push(y); },
  });
  page.document.dispatch('touchstart', ev(0));
  for (const dy of moves) page.document.dispatch('touchmove', ev(dy));
  page.document.dispatch(end, {});
  return prevented;
}

// app.js only arms the gesture once logged in — it reads this exact class.
function logIn(page) { page.byId.main.classList.remove('hidden'); }

function indicator(page) {
  return page.document.body.children.find((c) => c.id === 'ptr') || null;
}

test('ở đầu trang, kéo xuống đủ xa rồi thả → nạp lại cả trang', () => {
  const page = loadAppPage({});
  logIn(page);
  pull(page, [PULL_PAST_THRESHOLD]);
  assert.equal(page.location.reloads, 1);
});

test('kéo xuống nhưng chưa đủ ngưỡng → KHÔNG nạp lại, chỉ báo thu về', () => {
  const page = loadAppPage({});
  logIn(page);
  pull(page, [PULL_SHORT]);
  assert.equal(page.location.reloads, 0);
  assert.equal(indicator(page).classList.contains('visible'), false);
});

test('đang ở giữa trang → cử chỉ không được cướp, không nạp lại', () => {
  const page = loadAppPage({});
  logIn(page);
  page.window.scrollY = 250;
  const prevented = pull(page, [PULL_PAST_THRESHOLD]);
  assert.equal(page.location.reloads, 0);
  // The decisive part: the browser's own scrolling was never blocked.
  assert.deepEqual(prevented, []);
});

// window.scrollY is not the only way a page reports its scroll position, and
// app.js falls back to document.scrollingElement.scrollTop. Without this the
// fallback branch could rot unnoticed on whichever platform reports that way.
test('giữa trang nhưng chỉ scrollingElement biết → vẫn không nạp lại', () => {
  const page = loadAppPage({});
  logIn(page);
  page.window.scrollY = 0;
  page.document.scrollingElement.scrollTop = 250;
  pull(page, [PULL_PAST_THRESHOLD]);
  assert.equal(page.location.reloads, 0);
});

test('chưa đăng nhập → kéo bao nhiêu cũng không nạp lại', () => {
  const page = loadAppPage({});
  // #main starts hidden; loadAppPage with no token leaves it that way.
  assert.equal(page.byId.main.classList.contains('hidden'), false,
    'harness dựng #main không có class hidden — test này phải tự đặt');
  page.byId.main.classList.add('hidden');
  pull(page, [PULL_PAST_THRESHOLD]);
  assert.equal(page.location.reloads, 0);
});

test('kéo LÊN từ đầu trang → cuộn bình thường, không chặn, không nạp lại', () => {
  const page = loadAppPage({});
  logIn(page);
  const prevented = pull(page, [-PULL_PAST_THRESHOLD]);
  assert.equal(page.location.reloads, 0);
  assert.deepEqual(prevented, [], 'cuộn lên bị chặn thì trang thành cứng đờ');
});

// The direction is only known on the first touchmove, so preventDefault()
// must not be called before then — otherwise an upward scroll starting at the
// top of the page would be swallowed.
test('chỉ chặn cuộn khi đã biết là kéo XUỐNG', () => {
  const page = loadAppPage({});
  logIn(page);
  const prevented = pull(page, [PULL_PAST_THRESHOLD]);
  assert.deepEqual(prevented, [PULL_PAST_THRESHOLD]);
});

test('kéo xuống rồi đổi ý kéo ngược lên quá điểm đầu → không nạp lại', () => {
  const page = loadAppPage({});
  logIn(page);
  pull(page, [PULL_PAST_THRESHOLD, -10]);
  assert.equal(page.location.reloads, 0);
});

// Same class of bug as the "Đang mở…" button that stayed stuck after a
// bfcache restore: the happy path cleaned up, the interrupted path did not.
test('touchcancel giữa chừng → chỉ báo biến mất, không nạp lại', () => {
  const page = loadAppPage({});
  logIn(page);
  pull(page, [PULL_PAST_THRESHOLD], { end: 'touchcancel' });
  assert.equal(page.location.reloads, 0);
  assert.equal(indicator(page).classList.contains('visible'), false);
});

test('chỉ báo đổi chữ khi đã kéo đủ ngưỡng', () => {
  const page = loadAppPage({});
  logIn(page);
  const ev = (y) => ({ touches: [{ clientY: y }], cancelable: true, preventDefault() {} });
  page.document.dispatch('touchstart', ev(0));
  page.document.dispatch('touchmove', ev(PULL_SHORT));
  assert.equal(indicator(page).textContent, 'Kéo xuống để nạp lại');
  page.document.dispatch('touchmove', ev(PULL_PAST_THRESHOLD));
  assert.equal(indicator(page).textContent, 'Thả ra để nạp lại');
});

test('chỉ dựng đúng MỘT phần tử chỉ báo dù kéo nhiều lần', () => {
  const page = loadAppPage({});
  logIn(page);
  pull(page, [PULL_SHORT]);
  pull(page, [PULL_SHORT]);
  pull(page, [PULL_SHORT]);
  assert.equal(page.document.body.children.filter((c) => c.id === 'ptr').length, 1);
});

// --- khoá zoom -------------------------------------------------------------

test('chặn cả ba sự kiện pinch-zoom của iOS Safari', () => {
  const page = loadAppPage({});
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    let blocked = false;
    page.document.dispatch(name, { preventDefault() { blocked = true; } });
    assert.equal(blocked, true, `${name} không bị chặn`);
  }
});
