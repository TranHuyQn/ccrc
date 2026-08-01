// Runs term.js — a classic browser script, no bundler, no modules — inside
// node:vm with a small hand-built fake DOM/xterm/WebSocket. There is no
// browser in this test suite, so the loader below IS the harness: kept
// plain and readable on purpose rather than pulling in a framework. It is
// shared with term-input.test.js (Task 4) via dom-harness.mjs so the two
// suites can never drift on what the fake DOM/xterm/WebSocket actually do.
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTermPage, ThrowingTerminal, GetThrowsStorage, SetThrowsStorage } from './dom-harness.mjs';

// ---------------------------------------------------------------------------

test('xterm khởi tạo với disableStdin — terminal không nhận phím', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  assert.equal(page.term.opts.disableStdin, true);

  const helper = page.termContainer.querySelector('.xterm-helper-textarea');
  assert.ok(helper, 'phải tìm thấy helper textarea trong container terminal');
  assert.equal(helper.getAttribute('disabled'), 'disabled', 'helper textarea phải bị vô hiệu hoá');
  assert.equal(helper.tabIndex, -1, 'helper textarea không được nhận Tab focus');
  assert.equal(helper._blurred, true, 'helper textarea phải bị blur nếu đang giữ focus');
});

test('đọc vé từ fragment URL rồi xoá khỏi thanh địa chỉ', () => {
  const page = loadTermPage({ hash: '#t=ve-bi-mat' });
  assert.equal(page.historyCalls.length, 1, 'phải gọi history.replaceState đúng một lần');
  assert.equal(page.location.hash, '', 'hash phải rỗng ngay sau khi trang chạy xong');
  // Prove the ticket wasn't just discarded — it must have actually been used
  // to open the first connection.
  const sockets = page.ws();
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /[?&]token=ve-bi-mat(&|$)/);
});

test('lưu sessionKey vào sessionStorage khi nhận khung ccrc_session', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  const ws = page.ws()[0];
  ws.open();
  ws.receive(JSON.stringify({ type: 'ccrc_session', key: 'khoa-bi-mat-32-byte' }));
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), 'khoa-bi-mat-32-byte');
});

test('nối lại dùng key, KHÔNG dùng lại vé đã cháy', () => {
  const page = loadTermPage({ hash: '#t=ve1' });
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]token=ve1(&|$)/);

  ws1.open();
  ws1.receive(JSON.stringify({ type: 'ccrc_session', key: 'khoa-1' }));
  ws1.dropped(); // connection drops after the ticket already did its job

  page.clock.fireNext(); // fire the scheduled reconnect

  const ws2 = page.ws()[1];
  assert.match(ws2.url, /[?&]key=khoa-1(&|$)/, 'phải nối lại bằng sessionKey');
  assert.equal(ws2.url.includes('token='), false, 'không được gửi lại vé đã cháy');
});

test('đứt kết nối thì backoff tăng dần, tối đa 30s', () => {
  // Ticket-based on purpose (not storedKey): a ticket is retained across a
  // never-opened drop (see the dedicated test below), so this repeatedly
  // produces a genuine fresh socket each iteration. A key would instead be
  // discarded after the very first never-opened drop (task 7 fix 2's
  // refusal handling) and this loop would stop creating new sockets after
  // iteration 1 — wrong fixture for what this test is actually about, which
  // is purely the backoff math.
  const page = loadTermPage({ hash: '#t=ve-backoff' });
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const sockets = page.ws();
    sockets[sockets.length - 1].dropped(); // never opens — backoff must not reset
    delays.push(page.clock.fireNext());
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(page.ws().length, 8, 'mỗi lần đứt phải thử lại bằng một socket mới, dùng lại đúng vé (chưa từng bị dùng)');
});

test('quay lại từ nền (visibilitychange) nối lại NGAY, bỏ backoff', () => {
  const page = loadTermPage({ storedKey: 'khoa-nen' });
  const ws1 = page.ws()[0];
  ws1.open(); // must have connected successfully first — a never-opened key
  // drop is task 7 fix 2's refusal case (discard, don't retry), a different
  // scenario than the one under test here (backoff bypass on foreground).
  ws1.dropped(); // schedules a 1s backoff, and bumps backoff to 2s for next time
  assert.equal(page.clock.pending.length, 1);

  page.document.visibilityState = 'visible';
  page.document.dispatch('visibilitychange');

  assert.equal(page.clock.pending.length, 0, 'timer chờ backoff phải bị huỷ ngay');
  assert.equal(page.ws().length, 2, 'phải nối lại ngay, không chờ hết backoff');

  // Backoff must have been reset by the foreground event: the NEXT
  // disconnect should wait only 1s again, not continue the old streak.
  page.ws()[1].dropped();
  const delay = page.clock.fireNext();
  assert.equal(delay, 1000, 'backoff phải reset về 1s sau khi quay lại từ nền');
});

test('hiện "đang nối lại…" chứ không im lặng', () => {
  const page = loadTermPage({ storedKey: 'khoa-status' });
  page.ws()[0].dropped();
  assert.match(page.trangthai.textContent, /đang nối lại/, 'trạng thái phải hiện rõ, không im lặng');
});

test('khung ccrc_session KHÔNG được vẽ ra terminal như dữ liệu', () => {
  const page = loadTermPage({ hash: '#t=ve2' });
  const ws = page.ws()[0];
  ws.open();

  ws.receive(JSON.stringify({ type: 'ccrc_session', key: 'khoa-2' }));
  assert.equal(page.term.writes.length, 0, 'khung điều khiển không được ghi ra màn hình');

  // A LATER frame that also happens to start with '{' (e.g. real pane
  // output from a JSON-heavy CLI) must still reach the screen — only the
  // very first message on a ticket connection is the control frame.
  ws.receive('{"khong phai": "khung dieu khien"}');
  assert.deepEqual(page.term.writes, ['{"khong phai": "khung dieu khien"}']);
});

test('kết nối bằng key: dữ liệu bắt đầu bằng { vẫn lên màn hình nguyên vẹn ngay từ byte đầu', () => {
  // A `?key=` connection never gets a control frame at all (daemon-side
  // contract) — so there must be zero sniffing here, not even for message 1.
  const page = loadTermPage({ storedKey: 'khoa-co-san' });
  const ws = page.ws()[0];
  assert.match(ws.url, /[?&]key=khoa-co-san(&|$)/);
  ws.open();

  const paneOutput = '{"đây là": "dữ liệu pane thật, không phải điều khiển"}';
  ws.receive(paneOutput);
  assert.deepEqual(page.term.writes, [paneOutput]);
});

test('kết nối bằng key: dữ liệu pane TRÙNG HÌNH DẠNG khung ccrc_session vẫn không bị nuốt — không được sniff nội dung', () => {
  // The exact collision the "no JSON.parse sniffing" rule exists to
  // prevent: the pane itself could legitimately print something that
  // parses as {"type":"ccrc_session",...} (e.g. `cat` on a log line, or a
  // Claude Code tool call echoing JSON). On a `?key=` connection this can
  // ONLY ever be real terminal data — the daemon never sends a control
  // frame on this path — so it must reach the screen unchanged, never be
  // treated as a control frame no matter what it looks like.
  const page = loadTermPage({ storedKey: 'khoa-co-san' });
  const ws = page.ws()[0];
  ws.open();

  const lookalike = JSON.stringify({ type: 'ccrc_session', key: 'khong-phai-that' });
  ws.receive(lookalike);
  assert.deepEqual(page.term.writes, [lookalike], 'dữ liệu giống khung điều khiển vẫn phải lên màn hình nguyên vẹn');
  // And it must NOT have been mistaken for a real session key.
  assert.notEqual(page.sessionStorage.getItem('ccrc_session_key'), 'khong-phai-that');
});

// --- round 2 review fixes --------------------------------------------------

test('kết nối chưa kịp mở đã đứt (chưa từng open()) thì nối lại DÙNG LẠI đúng vé đó', () => {
  // The daemon never saw this attempt at all — no upgrade happened, so no
  // nonce was ever spent server-side. The ticket is still perfectly valid
  // and must not be thrown away over a network blip that never reached it.
  const page = loadTermPage({ hash: '#t=ve-giu-lai' });
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]token=ve-giu-lai(&|$)/);

  ws1.dropped(); // never called ws1.open() — the daemon never accepted it
  page.clock.fireNext();

  const ws2 = page.ws()[1];
  assert.match(ws2.url, /[?&]token=ve-giu-lai(&|$)/, 'phải thử lại với ĐÚNG vé cũ, vì vé chưa từng bị dùng');
});

test('kết nối đã mở rồi đứt TRƯỚC khung điều khiển thì báo trạng thái không thể khôi phục, có hướng dẫn, KHÔNG còn timer treo', () => {
  // Here the daemon DID accept the upgrade (open() fired), which means the
  // one-time nonce backing this ticket was spent server-side the moment
  // that happened — even though the connection died before the control
  // frame carrying a reusable sessionKey ever arrived. No retry with any
  // ticket can succeed now; the page must say so, not spin forever.
  const page = loadTermPage({ hash: '#t=ve-mot-lan' });
  const ws1 = page.ws()[0];
  ws1.open();
  ws1.dropped(); // dies before any message — no sessionKey was ever received

  page.clock.fireNext(); // the reconnect scheduled by onclose fires connect() again

  assert.equal(page.clock.pending.length, 0, 'không được để lại timer treo khi không thể khôi phục được nữa');
  assert.equal(page.ws().length, 1, 'không được lãng phí mở thêm socket khi biết chắc sẽ thất bại');
  assert.match(page.trangthai.textContent, /hết hạn|vé đã dùng/, 'phải hướng dẫn người dùng, không được im lặng dừng lại');
});

test('N sự kiện visibilitychange dồn dập trong lúc socket vẫn đang sống chỉ tạo đúng MỘT kết nối', () => {
  // Reproduces the review's exact finding: three visibilitychange events
  // against one live socket used to leave four open sockets behind.
  const page = loadTermPage({ storedKey: 'khoa-song' });
  const ws0 = page.ws()[0];
  ws0.open(); // OPEN
  page.document.visibilityState = 'visible';
  page.document.dispatch('visibilitychange');
  page.document.dispatch('visibilitychange');
  page.document.dispatch('visibilitychange');
  assert.equal(page.ws().length, 1, 'không được mở thêm socket song song trong khi cái cũ vẫn OPEN');

  // Same guard must also hold while still CONNECTING (readyState 0) — a
  // socket that has not failed yet is not something to replace either.
  const page2 = loadTermPage({ storedKey: 'khoa-dang-noi' });
  page2.document.visibilityState = 'visible';
  page2.document.dispatch('visibilitychange');
  page2.document.dispatch('visibilitychange');
  assert.equal(page2.ws().length, 1, 'không được mở thêm socket song song trong khi cái cũ vẫn CONNECTING');
});

test('sessionStorage.getItem lỗi (vd Safari chế độ riêng tư) không làm trang crash — vẫn nối được bằng vé', () => {
  let page;
  assert.doesNotThrow(() => {
    page = loadTermPage({ hash: '#t=ve-an-toan', sessionStorageImpl: new GetThrowsStorage() });
  }, 'sessionStorage.getItem ném lỗi không được làm sập cả trang');
  assert.equal(page.ws().length, 1, 'phải vẫn thử nối bằng vé dù đọc sessionStorage lỗi');
  assert.match(page.ws()[0].url, /[?&]token=ve-an-toan(&|$)/);
});

test('sessionStorage.setItem lỗi khi lưu sessionKey không làm crash, trạng thái vẫn hiện điều gì đó', () => {
  const page = loadTermPage({ hash: '#t=ve-thu2', sessionStorageImpl: new SetThrowsStorage() });
  const ws0 = page.ws()[0];
  ws0.open();
  assert.doesNotThrow(() => {
    ws0.receive(JSON.stringify({ type: 'ccrc_session', key: 'khoa-khong-luu-duoc' }));
  }, 'sessionStorage.setItem ném lỗi không được làm sập việc nhận khung điều khiển');
  assert.ok(page.trangthai.textContent.length > 0, 'trạng thái phải luôn hiện điều gì đó, không được im lặng');
});

// --- task 7 fix 2: dead key vs fresh ticket, hashchange (browser acceptance) ---

test('vé mới trong URL đè lên key cũ đã lưu — key không được thử trước', () => {
  // Reproduces defect 1's root cause directly: the daemon restarted, so the
  // stored key is dead, but the user just tapped the card again and has a
  // perfectly good fresh ticket in the URL. The ticket must be tried FIRST,
  // not the stale key.
  const page = loadTermPage({ hash: '#t=ve-song', storedKey: 'khoa-chet-vi-daemon-restart' });
  assert.equal(page.ws().length, 1, 'chỉ được mở đúng một kết nối');
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]token=ve-song(&|$)/, 'vé trong URL phải thắng key đã lưu');
  assert.equal(ws1.url.indexOf('key=') === -1, true, 'không được thử key cũ trước khi thử vé');
});

test('kết nối bằng key bị từ chối (chưa từng open): key bị xoá, không lặp lại — không có vé thì báo không thể khôi phục, không còn timer treo', () => {
  // "Refused" on the wire looks exactly like "died before open" from the
  // client's point of view (the daemon writes a raw 401 and destroys the
  // socket before any WebSocket upgrade happens) — see bin/ccrc-term.js's
  // upgrade handler. No ticket was ever supplied here, so after the key is
  // discarded there is nothing left to retry with.
  const page = loadTermPage({ storedKey: 'khoa-chet' });
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]key=khoa-chet(&|$)/);

  ws1.dropped(); // never opened — the daemon refused it outright
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), null, 'key bị từ chối phải bị xoá khỏi sessionStorage ngay');

  // One backoff cycle is scheduled (same as any other drop) — firing it
  // must NOT retry the dead key. With no ticket available either, connect()
  // must land on the unrecoverable branch and stop, not schedule another.
  assert.equal(page.clock.pending.length, 1);
  page.clock.fireNext();

  assert.equal(page.ws().length, 1, 'không được mở thêm socket nào — không có gì hợp lệ để thử');
  assert.equal(page.clock.pending.length, 0, 'không được để lại timer treo, không được lặp vô hạn');
  assert.match(page.trangthai.textContent, /hết hạn|vé đã dùng/, 'phải báo trạng thái không thể khôi phục, có hướng dẫn');
});

test('kết nối bằng key bị từ chối, rồi có vé mới (qua hashchange) trước khi kịp thử lại: dùng vé, không lặp lại key chết', () => {
  const page = loadTermPage({ storedKey: 'khoa-chet' });
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]key=khoa-chet(&|$)/);

  ws1.dropped(); // refused before open
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), null);
  assert.equal(page.clock.pending.length, 1, 'một chu kỳ backoff vẫn được đặt lịch như mọi lần đứt kết nối khác');

  // The user notices, goes back to the PWA, and taps the card again —
  // second tap while this tab is already open delivers the fresh ticket via
  // hashchange (defect 2's path), which pre-empts the pending backoff timer.
  page.location.hash = '#t=ve-cuu-vien';
  page.window.dispatch('hashchange');

  assert.equal(page.clock.pending.length, 0, 'hashchange phải huỷ timer nối lại đang chờ, không để cả hai cùng chạy');
  assert.equal(page.ws().length, 2, 'phải mở đúng một kết nối mới, bằng vé');
  const ws2 = page.ws()[1];
  assert.match(ws2.url, /[?&]token=ve-cuu-vien(&|$)/, 'phải dùng vé mới, không lặp lại key đã chết');
});

test('vé đến qua hashchange trên trang đã mở (tap thẻ PWA lần hai): được dùng, fragment bị xoá, có kết nối mới, key cũ bị bỏ', () => {
  // Same origin+path with only the fragment changed does NOT reload the
  // page — the browser fires 'hashchange', term.js's top-level code (which
  // read the ticket once, at load) never re-runs. Without a hashchange
  // listener the ticket would sit untouched in location.hash forever.
  const page = loadTermPage({ storedKey: 'khoa-cu' }); // no ticket at load — connects with the key
  const ws1 = page.ws()[0];
  ws1.open();
  assert.match(ws1.url, /[?&]key=khoa-cu(&|$)/);

  page.location.hash = '#t=ve-lan-hai';
  page.window.dispatch('hashchange');

  assert.equal(page.location.hash, '', 'vé phải bị xoá khỏi fragment ngay sau khi lấy, giống lúc tải trang');
  assert.equal(page.ws().length, 2, 'phải thử kết nối mới ngay khi vé xuất hiện qua hashchange');
  const ws2 = page.ws()[1];
  assert.match(ws2.url, /[?&]token=ve-lan-hai(&|$)/, 'kết nối mới phải dùng vé vừa nhận, không phải key cũ');
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), null, 'key cũ phải bị bỏ — vé mới nghĩa là người dùng chủ động lập lại phiên');
  assert.equal(ws1.onclose, null, 'socket cũ phải bị tháo handler (đã bị đóng có chủ đích), không để nó cũng kích hoạt nối lại');
});

test('nối lại bình thường: có key hợp lệ, không có vé trong URL — vẫn dùng key như trước (không đổi hành vi cũ)', () => {
  const page = loadTermPage({ storedKey: 'khoa-con-song' }); // hash mặc định rỗng — không có vé
  assert.equal(page.ws().length, 1);
  const ws1 = page.ws()[0];
  assert.match(ws1.url, /[?&]key=khoa-con-song(&|$)/);
  assert.equal(ws1.url.indexOf('token=') === -1, true);
});

test('Terminal không khởi tạo được (thiếu xterm.js) thì trang báo lỗi rõ, không crash, và không cố nối WebSocket', () => {
  let page;
  assert.doesNotThrow(() => {
    page = loadTermPage({ hash: '#t=ve-khong-dung-toi', TerminalCtor: ThrowingTerminal });
  }, 'Terminal() ném lỗi không được làm sập cả trang');
  assert.equal(page.ws().length, 0, 'không có gì để vẽ lên thì không nên mở kết nối WebSocket');
  assert.match(page.trangthai.textContent, /terminal|xterm/i, 'phải báo rõ lý do bằng tiếng Việt');
  // The ticket must still have been stripped from the address bar even
  // though the terminal itself failed to come up.
  assert.equal(page.location.hash, '', 'vé vẫn phải bị xoá khỏi URL dù terminal lỗi');
});

// --- Phiên đóng hẳn: dừng, đừng quay vòng ---------------------------------
//
// A dropped network and a closed session look identical to the browser unless
// the daemon says which. They could not be more different to the person
// holding the phone: one should retry, the other never can, and a spinner
// that retries forever against a daemon that no longer exists is the worst of
// both.

test('mã 4001 → dừng hẳn, KHÔNG hẹn nối lại', () => {
  const page = loadTermPage({ storedKey: 'khoa-cu' });
  page.ws()[0].open();

  const socketsBefore = page.ws().length;

  page.ws()[0].dropped(4001);
  // Fire whatever was scheduled — the point is that none of it opens a socket.
  while (page.clock.pending.length) page.clock.fireNext();

  assert.equal(page.ws().length, socketsBefore,
    'đã mở socket mới — nối lại với một phiên không còn tồn tại là vòng lặp vô tận');
  assert.match(page.trangthai.textContent, /phiên đã đóng/i);
});

// Không hẹn giờ, không điều hướng, không nút: cửa sổ phụ mà iOS mở cho trang
// này có nút Done ngay trên thanh công cụ, làm đúng việc "về ứng dụng thật"
// trong một thao tác — đứng yên và để người dùng bấm Done là đúng, không có
// JS nào ở đây làm việc đó tốt hơn.
test('mã 4001 → hiện đúng câu, không hẹn giờ, không tự điều hướng', () => {
  const page = loadTermPage({ storedKey: 'khoa-cu' });
  page.ws()[0].open();
  const hrefBefore = page.location.href;

  page.ws()[0].dropped(4001);

  assert.equal(page.trangthai.textContent,
    'Phiên đã đóng trên máy — bấm Done ở góc trên để quay về ứng dụng.');
  assert.equal(page.clock.pending.length, 0, 'không được hẹn giờ cho việc gì cả — không có việc gì để làm sau đó');
  assert.equal(page.location.href, hrefBefore, 'không được tự điều hướng đi đâu — Done của cửa sổ phụ lo việc đó');
});

test('mã 4001 → xoá luôn khoá của phiên đã chết', () => {
  const page = loadTermPage({ storedKey: 'khoa-cu' });
  page.ws()[0].open();
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), 'khoa-cu',
    'khoá phải có mặt trước, nếu không phép kiểm dưới đây không kiểm gì cả');

  page.ws()[0].dropped(4001);
  assert.equal(page.sessionStorage.getItem('ccrc_session_key'), null);
});

test('rớt mạng thường (không có mã) → VẪN hẹn nối lại như cũ', () => {
  const page = loadTermPage({ storedKey: 'khoa' });
  page.ws()[0].open();
  const before = page.ws().length;

  page.ws()[0].dropped();

  assert.equal(page.clock.pending.length, 1, 'rớt mạng mà không nối lại là mất kết nối vĩnh viễn');
  page.clock.fireNext();
  assert.ok(page.ws().length > before, 'timer bắn ra nhưng không mở socket mới');
});

// The close code is the ONLY thing distinguishing "your session ended" from
// "the wifi blinked", and it is written twice — once in the daemon, once in
// the browser script, in two languages that no compiler checks against each
// other. Drift here is silent: the page falls back to reconnecting forever
// against a daemon that will never answer.
test('mã đóng 4001 khớp giữa daemon và trang', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const grab = (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const m = src.match(/CLOSE_SESSION_ENDED\s*=\s*(\d+)/);
    assert.ok(m, `${file} không khai báo CLOSE_SESSION_ENDED`);
    return m[1];
  };
  const daemon = grab('../bin/ccrc-term.js');
  assert.equal(daemon, grab('../public/term.js'));
  // 4000–4999 is the range reserved for the application; anything else is
  // either a protocol code or one the browser refuses to send.
  assert.ok(Number(daemon) >= 4000 && Number(daemon) <= 4999, `ngoài dải cho ứng dụng: ${daemon}`);
});

// --- Task 9b: thiết bị chưa ghép — mã 4003, dừng hẳn KHÔNG hẹn nối lại ------
//
// 401 câm không đọc được từ JS: `error` rồi `close` mã 1006, y hệt rớt mạng.
// Daemon (Task 9b) bắt tay xong rồi mới đóng bằng 4003 — đây là test cho nửa
// bên trang: nhận mã đó thì phải DỪNG HẲN, không hẹn nối lại (nối lại vô ích
// vì máy vẫn sẽ không có khoá công khai của điện thoại này) và phải nói rõ
// cho người dùng lý do, khác hẳn câu "mất kết nối" của rớt mạng thường.

test('mã 4003 → dừng hẳn, KHÔNG hẹn nối lại', () => {
  const page = loadTermPage({ storedKey: 'khoa-cu' });
  page.ws()[0].open();

  const socketsBefore = page.ws().length;

  page.ws()[0].dropped(4003);
  // Fire whatever was scheduled — the point is that none of it opens a socket.
  while (page.clock.pending.length) page.clock.fireNext();

  assert.equal(page.ws().length, socketsBefore,
    'đã mở socket mới — nối lại mãi mãi với một thiết bị chưa ghép là vòng lặp vô tận');
  assert.equal(page.clock.pending.length, 0, 'không được hẹn giờ nối lại cho một việc nối lại cũng vô ích');
});

test('mã 4003 → nói rõ "chưa được ghép", khác câu "mất kết nối" của rớt mạng thường', () => {
  const page = loadTermPage({ storedKey: 'khoa-cu' });
  page.ws()[0].open();

  page.ws()[0].dropped(4003);

  assert.match(page.trangthai.textContent, /chưa được ghép/i,
    'người dùng phải biết ĐÚNG lý do — không phải chỉ "mất kết nối" chung chung');
});

test('mã đóng 4003 khớp giữa daemon và trang', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const grab = (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const m = src.match(/CLOSE_DEVICE_NOT_PAIRED\s*=\s*(\d+)/);
    assert.ok(m, `${file} không khai báo CLOSE_DEVICE_NOT_PAIRED`);
    return m[1];
  };
  const daemon = grab('../bin/ccrc-term.js');
  assert.equal(daemon, grab('../public/term.js'));
  assert.ok(Number(daemon) >= 4000 && Number(daemon) <= 4999, `ngoài dải cho ứng dụng: ${daemon}`);
  // Không được trùng với CLOSE_SESSION_ENDED — hai tình huống khác nhau phải
  // có hai mã khác nhau, nếu không trang không phân biệt được để hiện đúng câu.
  const grabEnded = (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    return src.match(/CLOSE_SESSION_ENDED\s*=\s*(\d+)/)[1];
  };
  assert.notEqual(daemon, grabEnded('../public/term.js'));
});

// TƯƠNG THÍCH NGƯỢC, hướng "PWA cũ trong cache điện thoại". Bản app.js cũ —
// từ khi hub origin còn đi qua fragment thay vì bị bỏ hẳn — ghép
// `&h=<origin>` vào sau token. Trang này không đọc `h` nữa — nhưng nó cũng
// KHÔNG được vì thế mà đọc sai token: tách fragment theo `&` (parseFragment)
// là thứ giữ cho token vẫn nguyên vẹn ở đây, trong khi regex tham lam
// `/^#t=(.+)$/` sẽ nuốt cả `&h=…` vào token và làm daemon từ chối chữ ký.
test('fragment cũ còn mang &h= → token vẫn đọc đúng, h bị lờ đi', () => {
  const page = loadTermPage({ hash: '#t=ve1&h=' + encodeURIComponent('https://gia-mao.example') });
  assert.match(page.ws()[0].url, /[?&]token=ve1(&|$)/, 'token không được dính đuôi &h=');
  assert.equal(page.location.hash, '', 'fragment vẫn phải bị xoá sạch');
});
