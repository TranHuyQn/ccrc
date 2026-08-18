// CC Notify — web client
'use strict';
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('ccrc_token') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), authorization: 'Bearer ' + token },
  });
  if (res.status === 401) { logout(); throw new Error('Token không hợp lệ'); }
  return res;
}

function logout() {
  token = '';
  localStorage.removeItem('ccrc_token');
  $('main').classList.add('hidden');
  // #link-card cũng phải ẩn. Một lần 401 trong lúc đang bấm "Duyệt" ở /link
  // gọi thẳng vào đây, và thiếu dòng này thì thẻ duyệt nằm chồng lên thẻ đăng
  // nhập: người dùng thấy cả ô nhập mã lẫn ô dán token, không biết cái nào
  // đang có tác dụng.
  $('link-card').classList.add('hidden');
  $('login').classList.remove('hidden');
}

// Nút Slack chỉ hiện khi hub thực sự cấu hình được. Hỏi hub thay vì đoán:
// một nút dẫn tới 503 tệ hơn là không có nút.
(async () => {
  try {
    const { slackLogin } = await (await fetch('/api/auth/config')).json();
    if (slackLogin) $('slack-login').classList.remove('hidden');
    else $('login-or').classList.add('hidden');
  } catch {
    // Im lặng: ô dán token vẫn còn đó, người dùng vẫn vào được.
    $('login-or').classList.add('hidden');
  }
})();

$('slack-login').onclick = () => { location.href = '/auth/start'; };

// ?login=<claimCode> — đổi lấy token thật rồi xoá mã khỏi thanh địa chỉ.
async function consumeLoginCode() {
  const code = new URLSearchParams(location.search).get('login');
  if (!code) return false;
  // replaceState TRƯỚC await: nếu người dùng chia sẻ hay bookmark đúng lúc
  // request đang bay, cái họ cầm không được là một mã còn dùng được.
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch('/api/auth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    if (!body.token) return false;
    token = body.token;
    localStorage.setItem('ccrc_token', token);
    // Nói ngay mình vừa đăng nhập thành AI. Đăng nhập bằng Slack GHI ĐÈ token
    // đang có trong localStorage, nên đây là khoảnh khắc duy nhất người dùng
    // có thể nhận ra "đây không phải tài khoản của tôi" — chính là thứ mà cú
    // tấn công state-không-ràng-buộc (xem /auth/start trong server/src/index.js)
    // làm âm thầm. /api/me ngay sau đó là nguồn sự thật và sẽ vẽ đè lên; dòng
    // này chỉ để không có khoảng trống nào ở giữa.
    if (body.displayName) $('who').textContent = body.displayName;
    return true;
  } catch {
    return false;
  }
}

// Trang /link: duyệt một máy dev đang chờ.
function showLink() {
  $('login').classList.add('hidden');
  $('main').classList.add('hidden');
  if (!token) { $('login').classList.remove('hidden'); return; }
  $('link-card').classList.remove('hidden');
}

// Duyệt có HAI chỗ vào, cùng một xử lý: trang /link (mở từ trình duyệt) và thẻ
// gập trong app. Chỗ thứ hai không phải tiện thêm — nó là chỗ vào DUY NHẤT của
// người đã cài PWA, vì app standalone không gõ được URL và iOS không deep-link
// vào web app đã cài. Một hàm cho cả hai để hai đường không trôi khỏi nhau.
function bindApprove(codeId, btnId, msgId, errId) {
  $(btnId).onclick = async () => {
    $(errId).classList.add('hidden');
    $(msgId).classList.add('hidden');
    const userCode = $(codeId).value.trim();
    if (!userCode) return;
    const res = await api('/api/device/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      $(msgId).textContent = 'Đã duyệt. Quay lại terminal máy dev — nó tự nhận token trong vài giây.';
      $(msgId).classList.remove('hidden');
      $(codeId).value = '';
      return;
    }
    $(errId).textContent = body.error || 'Duyệt không thành công.';
    $(errId).classList.remove('hidden');
  };
}

bindApprove('link-code', 'link-btn', 'link-msg', 'link-err');
bindApprove('approve-code', 'approve-btn', 'approve-msg', 'approve-err');

async function showMain() {
  const me = await (await api('/api/me')).json();
  $('who').textContent = `${me.user} · ${me.pushDevices} thiết bị`;
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  await refreshPushState();
  await refreshTerminal();
}

// --- Phiên nào đang có thông báo chưa đọc -----------------------------------
//
// Hub trả `lastNotifiedAt` kèm mỗi phiên (server/src/terminal-sessions.js) —
// lúc thông báo gần nhất của phiên đó tới. Nên "phiên này có việc chờ mình"
// rút gọn thành: mốc ấy có mới hơn lần cuối mình xem không.
//
// Trước đây câu hỏi này được trả lời bằng cách tải về 50 thông báo gần nhất
// rồi soi xem cái nào thuộc phiên nào — tức là hub phải giữ tiêu đề và nội
// dung thật của mọi thông báo chỉ để trang này vẽ được một cái chấm. Một con
// số cho mỗi phiên nói đúng chừng ấy và không nói gì thêm.
//
// Mốc "lần cuối xem" nằm trong localStorage của CHÍNH máy này, không phải trên
// hub: không endpoint mới, không state mới ở server, và hai thiết bị thì mỗi
// thiết bị tự đếm — vốn đúng hơn là dùng chung.

const READ_PREFIX = 'ccrc_read_';

// Khoá của phiên vừa được mở, đặt trong sessionStorage chứ KHÔNG localStorage
// (xem openTerminal()): nó phải sống qua lần điều hướng sang máy dev rồi quay
// lại trong cùng một tab, nhưng phải chết khi đóng app.
const OPENED_KEY = 'ccrc_opened';

function readMarkKey(sessionId) { return READ_PREFIX + sessionId; }

function lastReadAt(sessionId) {
  // Number(null) là 0, Number('rác') là NaN — `|| 0` gộp cả hai thành "chưa
  // từng đọc", nên một khoá bị hỏng bằng tay chỉ làm chấm sáng lên, không bao
  // giờ làm nó tắt oan.
  return Number(localStorage.getItem(readMarkKey(sessionId))) || 0;
}

function markRead(sessionId) {
  if (!sessionId) return;
  localStorage.setItem(readMarkKey(sessionId), String(Date.now()));
}

function hasUnread(session) {
  if (!session || !session.sessionId) return false;
  // Một daemon/hub cũ không gửi trường này. `Number(undefined)` là NaN và mọi
  // so sánh với NaN là false, nên `|| 0` giữ cho nhánh ấy nghĩa là "chưa có
  // thông báo nào" — chấm không sáng — thay vì một so sánh im lặng không bao
  // giờ đúng.
  const at = Number(session.lastNotifiedAt) || 0;
  // `>` chứ không `>=`: markRead() ghi Date.now(), và một thông báo đến đúng
  // cùng mili-giây với lúc mở phải tính là đã đọc.
  return at > lastReadAt(session.sessionId);
}

// Mỗi `/remote on` sinh một sessionId mới, nên không dọn thì localStorage tích
// một khoá vĩnh viễn cho mỗi phiên từng chạy. Danh sách phiên hiện tại là
// nguồn duy nhất quyết định: một mốc đã đọc chỉ ảnh hưởng tới cái chấm trên
// một cái thẻ, và thẻ thì đến từ đúng danh sách này — không còn thẻ thì mốc
// không còn tác dụng gì để mà giữ.
function pruneReadMarks(sessions) {
  const keep = new Set();
  for (const s of sessions) if (s && s.sessionId) keep.add(s.sessionId);
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (typeof k === 'string' && k.startsWith(READ_PREFIX)
        && !keep.has(k.slice(READ_PREFIX.length))) {
      doomed.push(k);
    }
  }
  // Xoá SAU khi duyệt xong: removeItem() giữa chừng làm chỉ số của key(i)
  // trượt và bỏ sót đúng khoá kế tiếp.
  for (const k of doomed) localStorage.removeItem(k);
}

// --- mở thẳng một phiên khi bấm thông báo (spec §3) -------------------------
//
// Service worker không đọc được localStorage, nên nó không cầm token đăng
// nhập và không ký nổi một yêu cầu mở terminal. Nó chỉ nói được TÊN PHIÊN —
// qua `?open=` khi phải mở cửa sổ mới, hoặc qua postMessage khi trang đã
// chạy sẵn. Việc còn lại làm ở đây, đi đúng đường mà một cú bấm tay vẫn đi.

let pendingOpen = null;

// Cùng một sự việc thì phải cùng một câu, ở cả hai chỗ nó xuất hiện: thẻ của
// một phiên không còn nhịp tim (buildTerminalCard), và lời từ chối khi một cú
// bấm thông báo trỏ vào đúng phiên đó (consumePendingOpen). Hai bản chép tay
// sẽ lệch nhau ở lần sửa câu chữ đầu tiên, và người dùng thì không có cách nào
// biết hai câu khác nhau đang nói về cùng một chuyện.
const MSG_MAY_KHONG_PHAN_HOI = 'Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt.';

function showTerminalErr(msg) {
  const err = $('terminal-err');
  err.textContent = msg;
  err.classList.remove('hidden');
}

// Xoá tham số ngay khi đọc: một lần nạp lại trang (kéo xuống để nạp lại,
// chẳng hạn) không được mở lại terminal lần nữa sau khi người dùng đã cố ý
// quay ra.
function readPendingOpenFromUrl() {
  let raw = '';
  try { raw = new URLSearchParams(location.search || '').get('open') || ''; }
  catch (e) { raw = ''; }
  if (!raw) return;
  pendingOpen = raw;
  try { history.replaceState(null, '', location.pathname || '/'); }
  catch (e) { /* không xoá được thì cùng lắm mở lại một lần — không hỏng gì */ }
}
readPendingOpenFromUrl();

if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.type !== 'ccrc_open' || typeof d.sessionId !== 'string' || !d.sessionId) return;
    pendingOpen = d.sessionId;
    // Còn ở màn hình đăng nhập thì KHÔNG tự nạp lại: api() gặp 401 sẽ gọi
    // logout() rồi ném, và câu lỗi được vẽ lên một phần tử nằm trong #main
    // đang ẩn — người dùng bấm thông báo và thấy đúng không có gì xảy ra.
    // `pendingOpen` cố ý được GIỮ NGUYÊN: showMain() kết thúc bằng
    // refreshTerminal(), nên đăng nhập xong là phiên họ vừa bấm mở ra ngay.
    // Cùng phép thử mà refreshOnReturn() dùng, vì cùng một lý do.
    if ($('main').classList.contains('hidden')) return;
    refreshTerminal();
  });
  // Hôm nay không có dòng này vẫn chạy, nhưng chỉ vì app.js là script CỔ ĐIỂN,
  // không `async`: nó chạy xong trước khi trình duyệt bơm hàng đợi tin nhắn.
  // Thêm `async` vào thẻ <script> sau này sẽ âm thầm làm rơi mọi `ccrc_open`
  // đã xếp hàng trước đó — không lỗi, không dấu vết, chỉ là bấm thông báo thì
  // không mở đúng phiên nữa. Gọi tường minh ở đây biến một chỗ dựa vô tình
  // thành một lời yêu cầu.
  if (typeof navigator.serviceWorker.startMessages === 'function') navigator.serviceWorker.startMessages();
}

// Array.from(card.children), KHÔNG gọi thẳng card.children.find(...): trên
// DOM thật .children là một HTMLCollection và không có .find — chỉ mảng giả
// trong bộ khung test mới có. Gọi thẳng sẽ vỡ ngay ở lần tải trang thật đầu
// tiên dù mọi test ở đây vẫn xanh — đúng loại lỗi `f({a} = {})` đã lọt lưới
// ba lần trong kế hoạch này, giờ đổi hình dạng. Một chỗ duy nhất cho lời giải
// thích này — cả consumePendingOpen() và buildTerminalCardAsync() gọi vào đây.
function openButtonOf(card) {
  return card && Array.from(card.children).find((c) => c.tagName === 'BUTTON');
}

// `sessions` là null khi lượt nạp vừa rồi hỏng. Giữ nguyên yêu cầu mở trong
// trường hợp đó: "không hỏi được hub" không phải bằng chứng phiên đã đóng, và
// nói thế là nói dối về máy của người dùng.
async function consumePendingOpen(sessions) {
  if (!pendingOpen || !sessions) return;
  // Bấm thông báo trong lúc đang ở Cài đặt: điều hướng thẳng đi từ một màn hình
  // không liên quan là chuyện khó hiểu. Đóng trước, rồi mới mở phiên.
  if (settingsOpen) history.back();
  const sid = pendingOpen;
  // Tiêu thụ TRƯỚC khi hành động: openTerminal() có nhánh lỗi tự gọi
  // refreshTerminal() lại, và một yêu cầu chưa tiêu thụ ở đây sẽ thành vòng
  // lặp mở-hỏng-mở-hỏng.
  pendingOpen = null;
  const i = sessions.findIndex((s) => s && s.sessionId === sid);
  if (i === -1) return showTerminalErr('Phiên đó đã đóng — không mở được.');
  const session = sessions[i];
  if (!session.alive) {
    return showTerminalErr(MSG_MAY_KHONG_PHAN_HOI);
  }
  if (!(await pairedMachines()).includes(session.machine)) {
    return showTerminalErr('Điện thoại này chưa ghép với máy đó — bấm "Ghép máy này".');
  }
  // renderTerminalList() dựng đúng một thẻ cho mỗi phiên, theo đúng thứ tự
  // của `sessions`, nên chỉ số là mối nối duy nhất cần thiết giữa hai bên.
  //
  // Mối nối đó là BEST-EFFORT, không phải bất biến: `await pairedMachines()`
  // ngay trên kia nhả quyền điều khiển, và một 'visibilitychange' rơi đúng vào
  // khe đó dựng lại cả danh sách — `sessions` khi ấy là ảnh chụp cũ, còn
  // children[i] là thẻ mới. Không sao, vì chuyến điều hướng đi từ `session`
  // (biến đã bắt ở trên) chứ không từ cái thẻ: điều tệ nhất xảy ra được là
  // thẻ khác hiện "Đang mở…", hoặc children[i] là undefined và rơi xuống câu
  // "thử bấm vào thẻ trong danh sách" ngay dưới. Không có đường nào mở nhầm
  // phiên, nên chỗ này không đáng đổi lấy một cấu trúc phức tạp hơn.
  const btn = openButtonOf($('terminal-list').children[i]);
  if (!btn) return showTerminalErr('Không mở được phiên đó — thử bấm vào thẻ trong danh sách.');
  await openTerminal(session, btn);
}

// Renders the terminal list from GET /api/terminal. Silence is the wrong
// default here (unlike the rest of this file) — the terminal spec (§7) is
// explicit that a person is standing there waiting, so every branch below
// leaves something visible rather than a stale or blank list.
//
// Coalesced through `terminalRefreshInFlight`: a bfcache restore can fire
// 'pageshow' and 'visibilitychange' back to back (see the listeners below),
// and both must resolve to exactly one GET /api/terminal — not one per
// event, and not one per rendered card. Any caller during a refresh already
// in flight just gets that same promise instead of starting a second one —
// true for the fetch/render phase. The `consumePendingOpen` tail chained
// onto it in refreshTerminal() below runs AFTER the flag is cleared (see the
// comment there for why), so it sits deliberately outside this coalesced
// window: a caller landing during that tail starts its own GET
// /api/terminal rather than joining it. Harmless in practice — there is at
// most one `pendingOpen` in flight regardless — but worth naming so this
// comment stays true of the code below it.
let terminalRefreshInFlight = null;

function refreshTerminal() {
  if (terminalRefreshInFlight) return terminalRefreshInFlight;
  // consumePendingOpen chạy SAU khi cờ đã được gỡ (`.finally` chạy trước
  // `.then`): nhánh lỗi của openTerminal() gọi refreshTerminal() lại, và nếu
  // cờ còn treo thì nó nhận về chính promise đang chờ chính nó — khoá chết.
  terminalRefreshInFlight = doRefreshTerminal()
    .finally(() => { terminalRefreshInFlight = null; })
    .then((sessions) => consumePendingOpen(sessions));
  return terminalRefreshInFlight;
}

async function doRefreshTerminal() {
  const err = $('terminal-err');
  err.classList.add('hidden');

  // Vừa quay về từ một terminal: đánh dấu đã đọc lần nữa, mốc là LÚC NÀY, để
  // những thông báo đến trong lúc đang xem không sáng chấm ngay khi quay ra.
  // Đặt ở đây chứ không trong refreshOnReturn() để mọi lối vào đều được phủ —
  // kể cả showMain() chạy lại từ đầu, vốn không đi qua refreshOnReturn().
  const opened = sessionStorage.getItem(OPENED_KEY);
  if (opened) {
    markRead(opened);
    sessionStorage.removeItem(OPENED_KEY);
  }

  let sessions;
  try {
    const res = await api('/api/terminal');
    if (!res.ok) throw new Error('terminal fetch failed');
    ({ sessions } = await res.json());
  } catch (e) {
    // Network hiccup or hub error: say so and leave the previous list alone
    // rather than guessing — clearing it here would be lying if sessions
    // actually exist.
    showTerminalErr('Không lấy được trạng thái terminal, thử lại sau.');
    return null;   // null = "chưa biết", khác hẳn [] = "không có phiên nào"
  }

  await renderTerminalList(sessions || []);
  return sessions || [];
}

// Rebuilds the whole list from scratch on every refresh, one card per
// session. This also fixes any button stuck reading "Đang mở…" from a
// previous tap (the bfcache case below) for free: the old button node is
// discarded along with the rest of its card, never mutated in place, so a
// fresh render can never inherit stale busy state.
async function renderTerminalList(sessions) {
  const list = $('terminal-list');
  const empty = $('terminal-empty');
  list.textContent = '';

  // Đặt trước nhánh "không có phiên nào" bên dưới: danh sách rỗng là đúng lúc
  // có nhiều khoá mồ côi nhất.
  pruneReadMarks(sessions);

  if (!sessions.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');
  for (const session of sessions) list.appendChild(await buildTerminalCardAsync(session));
}

// Một máy chưa ghép không có gì để chấp nhận chữ ký từ điện thoại này — đưa
// thẳng nút "Mở terminal" vào đó chỉ dẫn tới một token bị daemon từ chối. Nút
// "Ghép máy này" là LỐI VÀO DUY NHẤT tới startPairing(): bảng ghép cặp (Task 7)
// không có chỗ nào khác trong UI gọi tới nó, nên thiếu bước này thì tính năng
// ghép cặp không ai bấm tới được (⚠️ của báo cáo task trước).
async function buildTerminalCardAsync(session) {
  const card = buildTerminalCard(session);
  if (session.alive && !(await pairedMachines()).includes(session.machine)) {
    const btn = openButtonOf(card);
    if (btn) {
      btn.textContent = 'Ghép máy này';
      btn.onclick = () => startPairing(session.machine);
    }
  }
  return card;
}

// `label` and `machine` both originate on the developer's machine — label is
// a project directory basename the user controls — so both are set with
// textContent, never innerHTML.
function buildTerminalCard(session) {
  const card = document.createElement('div');
  card.className = 'card terminal-card';

  const title = document.createElement('div');
  title.className = 'row terminal-title';
  const unread = hasUnread(session);
  if (unread) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot';
    // Chấm là THÔNG TIN, không phải trang trí: chỉ có màu thì trình đọc màn
    // hình không đọc được gì cả.
    dot.setAttribute('aria-label', 'có thông báo chưa đọc');
    title.appendChild(dot);
  }
  const name = document.createElement('span');
  name.textContent = session.label ? `${session.label} · ${session.machine}` : session.machine;
  // Tên LUÔN là span cuối trong hàng, chấm đứng trước nó. Test đọc tên bằng
  // children.at(-1), nên đảo thứ tự ở đây làm đỏ test chứ không hỏng ngầm.
  title.appendChild(name);
  card.appendChild(title);
  if (unread) {
    card.classList.add('has-unread');
    const dot = title.children[0];
    // Lối thoát DUY NHẤT cho thẻ "máy không phản hồi", vốn không dựng nút nào
    // để bấm: thiếu nó thì chấm kẹt lại cho tới khi hub evict phiên sau 30
    // phút. Gỡ chấm tại chỗ thay vì fetch lại — trạng thái vẫn đúng ở lần dựng
    // sau vì mốc đã nằm trong localStorage rồi. Click vào nút "Mở terminal"
    // cũng nổi bọt lên đây; vô hại, openTerminal() đã đánh dấu sẵn.
    card.onclick = () => {
      markRead(session.sessionId);
      dot.remove();
      card.classList.remove('has-unread');
    };
  }

  if (session.alive) {
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Mở terminal';
    openBtn.onclick = () => openTerminal(session, openBtn);
    card.appendChild(openBtn);
  } else {
    // Do NOT render a button: a link into a daemon that stopped sending
    // heartbeats would just hang the tap — see brief.
    const note = document.createElement('p');
    note.className = 'dim small';
    note.textContent = MSG_MAY_KHONG_PHAN_HOI;
    card.appendChild(note);
  }
  return card;
}

// Would this page navigate there?
//
// `location.href = session.url + …` below is, read plainly, "go wherever the
// server said". This page holds the personal token in localStorage, so that
// sentence has to be narrowed: a `javascript:` URL does not navigate at all,
// it RUNS, in this origin, with that token in reach; an ordinary URL on
// another host serves a page that looks like the terminal and asks for the
// token back.
//
// The hub refuses these at registration (src/session-url.js, where the same
// rule is spelled out at length). This is the second lock, on the side that
// would actually be robbed — deliberately duplicated rather than shared,
// since this file is a plain browser script with no import of its own.
function isTailnetTerminalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const parts = u.hostname.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return false;
  }
  // Tailscale's CGNAT block, 100.64.0.0/10.
  return Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}

// Ký yêu cầu mở terminal NGAY TRÊN ĐIỆN THOẠI — hub không còn tham gia bước
// này (xem openTerminal() bên dưới), và không còn gì để ký nữa: khoá riêng
// chỉ tồn tại trên chính máy này, non-extractable (xem ensureDeviceKey()).
//
// Chuỗi đem đi ký PHẢI khớp signingInputFor() của term/src/ticket.js từng ký
// tự — `v2.${b64}`, ký CẢ phiên bản lẫn payload. Lệch một ký tự và mọi chữ
// ký bị daemon từ chối, với triệu chứng giống hệt "khoá sai" chứ không phải
// "định dạng chữ ký sai" — xem server/test/app-terminal.test.js's bài kiểm
// vòng khép kín (ký ở đây, xác minh bằng đúng verifyAttachToken() của daemon).
async function signAttachToken(session) {
  const { deviceId } = await ensureDeviceKey();
  const now = Date.now();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  // Host mà trang này SẮP đi tới, không phải host nào khác. Ràng nó vào chữ ký
  // là thứ làm cho một token bị lừa sang trang lạ trở nên vô dụng ở mọi daemon
  // (C3, spec §13). openTerminal() đã chạy isTailnetTerminalUrl(session.url)
  // TRƯỚC khi gọi hàm này, nên `new URL` ở đây không ném.
  const h = new URL(session.url).host;
  const payload = {
    sid: session.sessionId,
    m: session.machine,
    iat: now,
    // 60s — phải NHỎ HƠN đáng kể so với clamp
    // DEFAULT_MAX_TICKET_LIFETIME_MS của daemon (term/src/ticket-policy.js),
    // nếu không mọi vé mới ký sẽ bị 401 hết. Quan hệ này được canh bởi
    // term/test/ticket-ttl-relation.test.js, đọc hằng số này bằng regex trên
    // chính file nguồn.
    exp: now + 60_000,
    n: b64url(nonceBytes),
    k: deviceId,
    h,
  };
  const b64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    deviceKeyPair.privateKey,
    new TextEncoder().encode(`v2.${b64}`),
  );
  return `v2.${b64}.${b64url(sig)}`;
}

async function openTerminal(session, btn) {
  const err = $('terminal-err');
  err.classList.add('hidden');
  // Checked before signing, not after: this mints a signed key to a shell,
  // and there is no reason to sign one for a card we have already decided
  // not to follow. Stays BEFORE signing on purpose — see task-9-brief.md.
  if (!isTailnetTerminalUrl(session.url)) {
    btn.disabled = false;
    btn.textContent = 'Mở terminal';
    err.textContent = 'Phiên này báo một địa chỉ không hợp lệ — không mở. Hãy chạy /remote off rồi /remote on trên máy dev.';
    err.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Đang mở…';
  try {
    // Không còn bước hỏi hub xin vé. Điện thoại tự ký, hub không tham gia và
    // không biết gì về việc này — /api/terminal/ticket không còn được gọi.
    const token = await signAttachToken(session);
    // Đánh dấu đã đọc CHỈ khi thật sự sắp đi tới đó: URL đã qua kiểm tra và
    // chữ ký đã ký xong. Một thẻ bị từ chối vì URL lạ, hay một lần ký hỏng vì
    // điện thoại chưa ghép, đều kết thúc bằng "không mở được gì cả" — và
    // không được vì thế mà mất dấu chưa đọc.
    markRead(session.sessionId);
    // Để lần QUAY VỀ còn đánh dấu tiếp: hub vẫn ghi thông báo vào lịch sử
    // trong lúc mình đang xem terminal (nó chỉ nén push, xem route /notify),
    // nên không có bước này thì vừa xem xong quay ra vẫn thấy chấm cam.
    //
    // sessionStorage, KHÔNG localStorage: nó sống qua lần điều hướng sang máy
    // dev rồi quay lại trong cùng một tab, nhưng chết khi đóng app. Nếu dùng
    // localStorage thì "mở lại app sau ba tiếng" sẽ âm thầm đánh dấu đã đọc
    // cả đống thông báo đến trong lúc đó — đúng những cái cần sáng chấm nhất.
    sessionStorage.setItem(OPENED_KEY, session.sessionId);
    // Fragment, not query string — never sent to a server, stays out of most
    // logs, and term.js strips it from the address bar on arrival (spec §6).
    //
    // CHỈ token, không thêm tham số nào — không có `h` (origin của hub) hay
    // bất cứ gì khác. Ghép thêm `&h=` vào đây từng là thiết kế, cho một cơ
    // chế điều hướng cử chỉ back về danh sách phiên mà đo trên iPhone thật đã
    // bác bỏ và đã bị gỡ hẳn (xem term.js — back giờ để iOS tự lo, qua nút
    // Done của cửa sổ phụ). Nó cũng hỏng ở đúng chỗ khó thấy nhất: một máy dev
    // chưa cập nhật vẫn chạy `term.js` bản cũ, bản đó đọc token bằng regex
    // tham lam `/^#t=(.+)$/`, nên cái đuôi `&h=…` chui thẳng vào trong token
    // và mọi chữ ký bị daemon từ chối — điện thoại chỉ thấy "đang nối lại…"
    // quay mãi.
    location.href = session.url + '#t=' + encodeURIComponent(token);
  } catch (e) {
    // Ký thất bại (IndexedDB bị chặn, WebCrypto lỗi, …) hoặc phiên đã đóng:
    // never navigate into a page with nothing waiting on the other end.
    // Refresh FIRST so the list reflects reality (e.g. this card drops out),
    // then set the message — refreshTerminal() clears #terminal-err at its
    // own start, so setting it before the refresh would just have it wiped a
    // tick later with nothing ever painted.
    await refreshTerminal();
    err.textContent = 'Không ký được yêu cầu mở — điện thoại này có thể chưa ghép với máy đó.';
    err.classList.remove('hidden');
  }
}

// --- Danh sách thiết bị nhận thông báo -------------------------------------
//
// "5 thiết bị" was the whole truth the hub could tell, and it was not enough
// to act on: a push subscription carries nothing identifying, so four entries
// from four reinstalls of the same phone look identical. The list shows what
// CAN be known — which push service, and (for devices added from now on) a
// label and a date — and marks the row belonging to the phone reading it.

async function refreshDevices() {
  const err = $('devices-err');
  const box = $('devices');
  err.classList.add('hidden');
  let devices;
  try {
    const sub = await currentSub();
    const res = await api('/api/push/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub ? sub.endpoint : null }),
    });
    if (!res.ok) throw new Error('devices fetch failed');
    ({ devices } = await res.json());
  } catch (e) {
    // Leave whatever is on screen alone and say so — clearing the list here
    // would claim the user has no devices, which is a lie about their own
    // account.
    err.textContent = 'Không lấy được danh sách thiết bị, thử lại sau.';
    err.classList.remove('hidden');
    return;
  }
  renderDevices(devices || []);
}

function deviceTitle(d) {
  // Everything here is text the hub derived on this user's own machines, but
  // it is still set with textContent, never innerHTML.
  //
  // With no label — every device registered before the hub started recording
  // one — the service alone would read as a device called "Apple". Saying the
  // machine is unknown is the honest version, and it is also the signal that
  // this is one of the old entries worth clearing out.
  const parts = [];
  parts.push(d.label || 'máy không rõ');
  if (d.service) parts.push(d.service);
  const name = parts.join(' · ');
  return d.current ? name + ' — thiết bị này' : name;
}

function deviceWhen(d) {
  if (!d.addedAt) {
    // Devices registered before the hub started recording this. Saying so is
    // better than inventing a date.
    return 'đăng ký trước khi hệ thống ghi ngày';
  }
  return 'đăng ký ' + new Date(d.addedAt).toLocaleString('vi-VN');
}

function renderDevices(devices) {
  const box = $('devices');
  box.textContent = '';

  if (!devices.length) {
    const p = document.createElement('p');
    p.className = 'dim small';
    p.textContent = 'Chưa có thiết bị nào đăng ký nhận thông báo.';
    box.appendChild(p);
    return;
  }

  for (const d of devices) {
    const row = document.createElement('div');
    row.className = 'device' + (d.current ? ' device-current' : '');

    const title = document.createElement('div');
    title.className = 'device-name';
    title.textContent = deviceTitle(d);

    const when = document.createElement('div');
    when.className = 'dim small';
    when.textContent = deviceWhen(d);

    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = d.current ? 'Xoá (tắt trên máy này)' : 'Xoá';
    del.onclick = () => removeDevice(d, del);

    row.append(title, when, del);
    box.appendChild(row);
  }

  // The action that actually solves an accumulated list: the user cannot tell
  // four identical-looking entries apart, but they always know which device
  // they are holding.
  const others = devices.filter((d) => !d.current).length;
  if (others > 0 && devices.some((d) => d.current)) {
    const sweep = document.createElement('button');
    sweep.className = 'ghost';
    sweep.textContent = `Xoá ${others} thiết bị khác, chỉ giữ thiết bị này`;
    sweep.onclick = () => keepOnlyThisDevice(sweep);
    box.appendChild(sweep);
  }
}

async function removeDevice(d, btn) {
  const err = $('devices-err');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Đang xoá…';
  try {
    // Removing THIS device has a second half the hub cannot do: the browser
    // still holds a live subscription, and leaving it would have the page go
    // on claiming notifications are enabled while the hub pushes to nobody.
    if (d.current) {
      const sub = await currentSub();
      if (sub) await sub.unsubscribe().catch(() => {});
    }
    const res = await api('/api/push/devices/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: d.id }),
    });
    if (!res.ok) throw new Error('delete failed');
  } catch (e) {
    err.textContent = 'Xoá thiết bị thất bại, thử lại sau.';
    err.classList.remove('hidden');
  }
  await refreshDevices();
  await refreshPushState();
  await refreshWho();
}

async function keepOnlyThisDevice(btn) {
  const err = $('devices-err');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Đang xoá…';
  try {
    const sub = await currentSub();
    if (!sub) throw new Error('no subscription on this device');
    const res = await api('/api/push/devices/keep-only', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!res.ok) throw new Error('keep-only failed');
  } catch (e) {
    err.textContent = 'Không xoá được các thiết bị khác, thử lại sau.';
    err.classList.remove('hidden');
  }
  await refreshDevices();
  await refreshWho();
}

// Just the header count, without pulling the notification list and the
// terminal list along with it the way showMain() does.
async function refreshWho() {
  try {
    const me = await (await api('/api/me')).json();
    $('who').textContent = `${me.user} · ${me.pushDevices} thiết bị`;
  } catch (e) { /* header is cosmetic — never let it break an action */ }
}

async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return (reg && await reg.pushManager.getSubscription()) || null;
}

async function refreshPushState() {
  const el = $('push-state');
  const btn = $('enable-push');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.textContent = 'trình duyệt không hỗ trợ';
    btn.classList.add('hidden');
    $('devices-wrap').classList.add('hidden');
    return;
  }
  const on = !!(await currentSub());
  el.textContent = on ? 'đã bật trên thiết bị này' : 'chưa bật';
  btn.textContent = on ? 'Tắt thông báo trên thiết bị này' : 'Bật thông báo trên thiết bị này';
  // Shown even when this device has no subscription of its own: the whole
  // point is being able to see and remove the OTHER devices from here.
  $('devices-wrap').classList.remove('hidden');
}

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$('login-btn').onclick = async () => {
  // Clear any stale error from a previous failed attempt before trying again,
  // otherwise it keeps showing on a fresh login screen after a successful
  // login/logout cycle and wrongly suggests something is still wrong.
  $('login-err').classList.add('hidden');
  token = $('token').value.trim();
  try {
    // Ở /link thì đăng nhập xong phải quay lại ĐÚNG thẻ duyệt. Trước bản này
    // nhánh duy nhất là showMain(), nên người vào /link chưa đăng nhập bị
    // showLink() đẩy về thẻ đăng nhập (đúng), rồi đăng nhập xong lại bị ném
    // sang màn hình thông báo — với thanh địa chỉ vẫn là /link, không còn ô
    // nhập mã, và không có gì bảo họ nạp lại trang. Máy dev thì vẫn đang
    // ngồi đếm giây chờ được duyệt.
    if (location.pathname === '/link') {
      // Vẫn phải THỬ token trước khi tin nó: showLink() không gọi hub, nên
      // không có bước này thì một token sai chỉ lộ ra ở lần bấm "Duyệt", dưới
      // dạng 401 → logout() → về màn hình đăng nhập, không kèm lời giải thích
      // nào.
      const res = await api('/api/me');
      if (!res.ok) throw new Error('token không dùng được');
      localStorage.setItem('ccrc_token', token);
      showLink();
      return;
    }
    await showMain();
    localStorage.setItem('ccrc_token', token);
  } catch (e) {
    $('login-err').textContent = 'Token không hợp lệ.';
    $('login-err').classList.remove('hidden');
  }
};

$('logout').onclick = logout;

async function disablePush() {
  const el = $('push-state');
  const sub = await currentSub();
  if (!sub) { await refreshPushState(); return; }
  // Tell the hub first. If that fails we keep the browser subscription, so the
  // UI still says "đã bật" — which is the truth, since the hub would go on
  // pushing to this device. Dropping it locally first would leave the hub
  // sending into the void with no way for the user to see or fix it.
  const res = await api('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  if (!res.ok) { el.textContent = 'Tắt thông báo thất bại, thử lại sau.'; return; }
  await sub.unsubscribe().catch(() => {});
  await refreshPushState();
  await showMain();
}

$('enable-push').onclick = async () => {
  const el = $('push-state');
  if (await currentSub()) return disablePush();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      el.textContent = 'trình duyệt từ chối quyền thông báo — vào cài đặt trình duyệt để cho phép rồi thử lại';
      return;
    }
    const reg = await navigator.serviceWorker.register('sw.js');
    const vapidRes = await fetch('/api/vapid-key');
    if (!vapidRes.ok) throw new Error('vapid-key fetch failed');
    const { publicKey } = await vapidRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const subRes = await api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!subRes.ok) {
      // The browser accepted the subscription but the hub did not record it.
      // Undo it so the device's local state matches what the hub actually
      // knows, otherwise refreshPushState() would claim "đã bật" from now on
      // even though no notification can ever arrive.
      await sub.unsubscribe().catch(() => {});
      throw new Error('subscribe POST failed');
    }
    await refreshPushState();
    await showMain();
  } catch (e) {
    // Any failure not handled above (service worker registration, the
    // VAPID key fetch, subscribe() being rejected by the browser, or the
    // hub rejecting the subscription) must still leave the user with a
    // visible, actionable message instead of silence.
    el.textContent = 'Bật thông báo thất bại, thử lại sau.';
  }
};

// A tap on "Mở terminal" navigates away with `location.href`; coming back
// (Back button, or the phone just switching apps and returning) restores
// this page from the browser's back/forward cache — the DOM is reinstated
// exactly as the click handler left it (that card's button disabled,
// "Đang mở…") and no script re-runs. Only 'pageshow' fires reliably on that
// path, so the list is refreshed there rather than relying on the load-time
// call in showMain(), which never happens again on a bfcache restore.
// 'visibilitychange' is also covered for the same-app-switch case with no
// navigation at all (e.g. Control Center, another app, back to this PWA
// without ever leaving the page) — a stale "Đang mở…" would be just as
// misleading there.
//
// Một lần nạp là đủ cho cả hai việc: `lastNotifiedAt` đi kèm từng phiên trong
// chính phản hồi /api/terminal, nên chấm "chưa đọc" và danh sách thẻ không còn
// là hai nguồn phải giữ đồng bộ với nhau nữa.
//
// Coalescing vẫn nằm ở ĐÂY chứ không mượn của refreshTerminal(): một cụm
// 'pageshow' + 'visibilitychange' bắn sát nhau phải quy về đúng một lượt nạp.
// refreshTerminal() vẫn giữ coalescing riêng của nó cho các lối gọi khác
// (nhánh lỗi của openTerminal()).
let returnRefreshInFlight = null;

function refreshOnReturn() {
  // Only relevant once logged in; on the login screen there is no terminal
  // list, and a stale/absent token would just bounce off 401 → logout().
  if ($('main').classList.contains('hidden')) return;
  if (returnRefreshInFlight) return returnRefreshInFlight;
  returnRefreshInFlight = (async () => {
    await refreshTerminal();
  })().finally(() => { returnRefreshInFlight = null; });
  // Returning the promise is a no-op for a real addEventListener callback
  // (browsers ignore it) but lets tests await the refresh triggered by an
  // event instead of racing it.
  return returnRefreshInFlight;
}
window.addEventListener('pageshow', refreshOnReturn);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') return refreshOnReturn();
});

// --- Giữ trang ở 1×, không cho phóng to -----------------------------------
//
// iOS Safari ignores the viewport meta's `user-scalable=no` on purpose (an
// accessibility decision), so on iPhone the only way to refuse pinch-zoom is
// to cancel Safari's own `gesturestart` — the event no other browser fires.
// Chrome and Android are already covered by `touch-action` in style.css.
// Double-tap zoom rides on the same gesture events, so all three are taken.
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(name, (e) => {
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }, { passive: false });
}

// --- Kéo xuống để nạp lại trang -------------------------------------------
//
// An installed PWA has no address bar, so it has no reload button either, and
// neither platform offers the gesture here: iOS standalone has no native
// pull-to-refresh at all, and on Android style.css's `overscroll-behavior-y:
// contain` suppresses the browser's own. This restores it.
//
// It reloads the whole page rather than just re-fetching data, on purpose: an
// installed PWA holds on to its cached app.js/style.css, so a data-only
// refresh could never deliver a new build — and being stuck on an old build
// with no way to escape is precisely the situation this gesture exists for.
const PTR_THRESHOLD_PX = 70;   // drag at least this far before a release reloads
const PTR_MAX_PX = 110;        // the indicator never travels further than this
const PTR_RESISTANCE = 0.5;    // drag feels weighted, like the native gesture

let ptrStartY = null;   // null means "not tracking a pull right now"
let ptrDistance = 0;
let ptrEl = null;

function ptrIndicator() {
  if (ptrEl) return ptrEl;
  ptrEl = document.createElement('div');
  ptrEl.id = 'ptr';
  document.body.appendChild(ptrEl);
  return ptrEl;
}

function ptrShow(distance, armed) {
  const el = ptrIndicator();
  el.style.transform = 'translateY(' + distance + 'px)';
  el.textContent = armed ? 'Thả ra để nạp lại' : 'Kéo xuống để nạp lại';
  el.classList.add('visible');
}

function ptrReset() {
  ptrStartY = null;
  ptrDistance = 0;
  if (ptrEl) {
    ptrEl.classList.remove('visible');
    ptrEl.style.transform = '';
  }
}

// At the very top of the page, and logged in. Both matter: mid-page this
// gesture is an ordinary upward scroll and must not be stolen, and on the
// login screen there is nothing worth reloading for.
function ptrEligible() {
  if ($('main').classList.contains('hidden')) return false;
  const scrolled = (typeof window.scrollY === 'number' ? window.scrollY : 0)
    || (document.scrollingElement ? document.scrollingElement.scrollTop : 0);
  return scrolled <= 0;
}

function ptrTouchY(e) {
  return e && e.touches && e.touches[0] ? e.touches[0].clientY : null;
}

document.addEventListener('touchstart', (e) => {
  const y = ptrTouchY(e);
  ptrStartY = (y !== null && ptrEligible()) ? y : null;
  ptrDistance = 0;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (ptrStartY === null) return;
  const y = ptrTouchY(e);
  if (y === null) return;
  const dy = y - ptrStartY;
  if (dy <= 0) {
    // Dragging upward: this is a normal scroll, so hand it back to the
    // browser untouched instead of holding a half-open indicator.
    ptrReset();
    return;
  }
  // Only now claim the gesture. Calling preventDefault() before knowing the
  // direction would break ordinary upward scrolling from the top of the page.
  if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
  ptrDistance = Math.min(dy * PTR_RESISTANCE, PTR_MAX_PX);
  ptrShow(ptrDistance, ptrDistance >= PTR_THRESHOLD_PX);
}, { passive: false });

document.addEventListener('touchend', () => {
  if (ptrStartY === null) return;
  if (ptrDistance >= PTR_THRESHOLD_PX) {
    ptrIndicator().textContent = 'Đang nạp lại…';
    ptrStartY = null;
    location.reload();
    return;
  }
  ptrReset();
});

// A cancelled touch (an incoming call, the system taking over the gesture)
// must not leave the indicator stuck on screen the way the "Đang mở…" button
// once did — same class of bug, same fix: never rely on the happy path alone.
document.addEventListener('touchcancel', ptrReset);

// --- kho khoá thiết bị -----------------------------------------------------
//
// Một cặp khoá ECDSA P-256 cho cả người dùng, dùng với mọi máy dev. Khoá riêng
// sinh ra với extractable:false và nằm trong IndexedDB — theo đặc tả WebCrypto,
// với cặp khoá thì cờ đó chỉ áp cho khoá RIÊNG, khoá công khai vẫn xuất được,
// nên vẫn lấy được SPKI để gửi đi.
//
// Vì sao non-extractable là điều đáng đánh đổi: hub phục vụ chính file này, nên
// một hub bị chiếm đẩy được một bản app.js độc xuống. Không có cờ đó, bản độc
// bê luôn khoá riêng đi và dùng mãi mãi. Có cờ đó, nó chỉ ký hộ được trong lúc
// trang đang mở.
//
// Cái giá, phải nói với người dùng: khoá này KHÔNG sao lưu được. Xoá dữ liệu
// trang hay cài lại app là mất, và phải ghép lại từng máy.

const KEY_DB = 'ccrc';
const KEY_STORE = 'keys';
const KEY_ID = 'device';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE).put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// `var`, không phải `let`: chỉ `var` và khai báo `function` mới xuất hiện trên
// đối tượng context của vm.runInContext, và harness test truy cập qua đó.
var deviceKeyPair = null;

async function ensureDeviceKey() {
  const db = await idbOpen();
  let rec = await idbGet(db, KEY_ID);
  if (!rec) {
    // extractable:false — xem khối chú thích trên. Đây là dòng làm cho câu
    // "app.js độc cũng không bê khoá đi được" là sự thật.
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    );
    rec = { keyPair: kp, machines: [] };
    await idbPut(db, KEY_ID, rec);
  }
  deviceKeyPair = rec.keyPair;
  const spki = await crypto.subtle.exportKey('spki', rec.keyPair.publicKey);
  const pubKey = b64url(spki);
  const idBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubKey));
  const deviceId = Array.from(new Uint8Array(idBuf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // Phải khớp từng ký tự với deviceIdFor() trong term/src/devices.js: 8 byte
  // ĐẦU của SHA-256 trên chuỗi base64url của khoá công khai, viết hex thường.
  // Lệch cách tính là daemon trả unknown_device cho một thiết bị đã ghép.
  return { pubKey, deviceId, keyPair: rec.keyPair };
}

// Bản trình duyệt của term/src/pairing.js's shortAuthString. Hai bản cài đặt,
// một công thức — lệch nhau là hai màn hình hiện hai số khác nhau, mà triệu
// chứng đó nhìn y hệt "có người đứng giữa". server/test/app-pairing.test.js
// so trực tiếp hai bản với nhau, đúng vì lý do đó.
// `opts || {}` chứ không phải destructure thẳng trong tham số: `= {}` mặc
// định chỉ đỡ được `sasFor()` (thiếu hẳn tham số), KHÔNG đỡ được `sasFor(null)`
// — `null` không phải `undefined` nên default không kích hoạt, và
// `Cannot destructure property 'pubKey' of 'null'` vẫn ném y hệt. Đây đúng
// là cái lỗi `f({a} = {})` mà kế hoạch này đã để lọt hai lần; `sasFor` là 1
// trong 4 hàm brief liệt là API công khai của module, nằm sẵn trên global
// ngay khi trang chạy — không phải một import nội bộ chỉ gọi từ chỗ đã biết
// chắc đối số hợp lệ.
async function sasFor(opts) {
  const { pubKey, noncePhone, nonceMachine, digits = 6 } = opts || {};
  const material = [pubKey, noncePhone, nonceMachine].join('.');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

function randomNonceB64() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256B64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// Không được ném: buildTerminalCardAsync() await hàm này cho MỌI thẻ, mỗi
// lần vẽ lại danh sách terminal, và cái `await` đó nằm ngoài try/catch của
// doRefreshTerminal() (try/catch ở đó chỉ bọc fetch('/api/terminal')). Review
// Task 9 lần ra: một lỗi IndexedDB (chế độ riêng tư, quota, store bị khoá)
// ở đây từng leo thẳng qua renderTerminalList() → refreshTerminal() →
// showMain(), và `showMain().catch(() => logout())` ở đáy file biến MỘT
// TRỤC TRẶC LƯU TRỮ TẠM THỜI thành ĐĂNG XUẤT NGƯỜI DÙNG — dù token đăng nhập
// chẳng có vấn đề gì. Cùng kỷ luật với readAll() của term/src/devices.js:
// một kho hỏng phải đọc thành "chưa ghép thiết bị nào" (thẻ hiện "Ghép máy
// này" — trạng thái trung thực, khôi phục được), không phải một lỗi xác
// thực giả. Coverage: server/test/app-terminal.test.js.
async function pairedMachines() {
  try {
    const db = await idbOpen();
    const rec = await idbGet(db, KEY_ID);
    return (rec && Array.isArray(rec.machines)) ? rec.machines : [];
  } catch {
    return [];
  }
}

async function rememberMachine(machine) {
  const db = await idbOpen();
  const rec = await idbGet(db, KEY_ID);
  if (!rec) return;
  rec.machines = Array.from(new Set([...(rec.machines || []), machine]));
  await idbPut(db, KEY_ID, rec);
}

// `{pairId, machine}` của cuộc ghép cặp đang chờ máy dev báo lại verdict.
//
// Review sau khi việc này lần đầu ship (Task 13) bắt đúng một lỗ hổng khác:
// bỏ `machine` ở đây (để tránh gọi lại rememberMachine sau một "Khớp" không
// còn tồn tại) vô tình cắt luôn NGƯỜI ĐỌC duy nhất của pairedMachines() —
// buildTerminalCardAsync() (dòng ~128) chỉ hiện "Mở terminal" khi
// pairedMachines() chứa tên máy, và không có nơi nào ghi vào đó nữa thì
// KHÔNG BAO GIỜ hiện "Mở terminal", nghĩa là openTerminal() không ai bấm tới
// được nữa — hỏng tính năng chính của app, không chỉ là "khó chịu về UX".
// Bài học: bỏ người ghi cuối cùng của một trạng thái thì phải soát người đọc
// trước khi kết luận tác động.
var pendingPair = null;

async function startPairing(machineName) {
  const panel = $('pair-panel');
  const err = $('pair-err');
  panel.classList.remove('hidden');
  err.classList.add('hidden');
  $('pair-sas').textContent = '';
  $('pair-step').textContent = 'Đang chờ máy dev…';
  // Cố định ngay từ đầu, không đợi có SAS: đây là chỉ dẫn về nơi con số này
  // (khi hiện ra) phải đi tới, không phải một trạng thái đổi theo bước.
  $('pair-help').textContent = 'Khi có số, chạy trên máy dev: /remote pair xac-nhan <số>';

  const { pubKey } = await ensureDeviceKey();
  const noncePhone = randomNonceB64();
  // Cam kết đi TRƯỚC, nonce mở SAU. Đảo thứ tự này là quay về giao thức ngây
  // thơ mà hub tráo được khoá rồi dò nonce cho hai màn hình trùng số.
  const commit = await sha256B64(noncePhone);

  const started = await api('/api/pair/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubKey, commit }),
  });
  if (!started.ok) {
    err.textContent = 'Không bắt đầu được. Thử lại.';
    err.classList.remove('hidden');
    return;
  }
  const { pairId } = await started.json();

  // Đợi máy dev gửi nonce của nó.
  let nonceMachine = null;
  for (let i = 0; i < 120 && nonceMachine === null; i += 1) {
    const r = await api(`/api/pair/${encodeURIComponent(pairId)}`);
    if (r.ok) {
      const s = await r.json();
      if (s.nonceMachine) { nonceMachine = s.nonceMachine; break; }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!nonceMachine) {
    $('pair-step').textContent = 'Máy dev không trả lời. Chạy /remote pair trên máy rồi thử lại.';
    return;
  }

  await api('/api/pair/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairId, noncePhone }),
  });

  pendingPair = { pairId, machine: machineName || null };
  // KHÔNG hiện lại số trên máy dev để "so" — máy dev cố tình không in số của
  // nó ra (spec §12.3), nên ở đây cũng không còn gì để so với. Chỉ còn một
  // việc: đọc số NÀY trên chính điện thoại và gõ nó vào máy dev.
  $('pair-step').textContent = 'Gõ số này vào máy dev:';
  $('pair-sas').textContent = await sasFor({ pubKey, noncePhone, nonceMachine });

  // `await` ở đây KHÔNG khoá nút Huỷ: mỗi lượt lặp trong waitForPairVerdict()
  // nhường lại luồng thực thi ở điểm `await`, và một trình duyệt thật xử lý
  // sự kiện click trên MỘT LUỒNG đó độc lập với việc promise này đã "xong"
  // hay chưa — hệt như vòng chờ nonceMachine phía trên đã luôn làm. Awaiting
  // ở đây chỉ đổi thời điểm HÀM NÀY trả quyền điều khiển lại cho ai đó đang
  // `await startPairing(...)`, không đổi việc Huỷ có bấm được hay không.
  await waitForPairVerdict(pairId, machineName || null);
  return pairId;
}

// Task 13 (spec §12.2/§12.3): [Khớp]/[Không khớp] trên điện thoại không còn
// tồn tại — hub chọn nó đang nói chuyện với điện thoại nào, nên bất cứ nút
// "quyết định" nào ở đây đều vô nghĩa (nó có thể chuyển hướng cả cuộc ghép
// sang điện thoại của kẻ tấn công một cách TRUNG THỰC). Quyết định thật đã
// chuyển hẳn về máy dev, qua `/remote pair xac-nhan <số>`.
//
// Máy dev — không phải điện thoại — mới là bên gọi `/api/pair/finish` sau
// khi có verdict (term/bin/ccrc-term-cli.js's cmdPairConfirm). Hàm dưới đây
// chỉ CHỜ để hiển thị lại verdict đó cho người dùng xem, không quyết định gì
// bằng việc chờ: `devices.json` (nếu ghi) đã được máy dev ghi CỤC BỘ trước
// khi gọi finish, nên một hub nói dối ở bước này chỉ làm SAI HIỂN THỊ trên
// điện thoại (thẻ "Mở terminal" hiện sai) — daemon vẫn xác minh chữ ký thật
// khi thật sự mở terminal, và sẽ từ chối một khoá chưa từng được ghi. Không
// có gì hub nói ở đây feed được vào một quyết định, chỉ vào một hiển thị.
//
// Bọc toàn bộ trong try/catch dù startPairing() await hàm này: một lỗi mạng
// ở ĐÂY (sau khi đã ghép xong hay chưa đều không quan trọng nữa) không phải
// lỗi người dùng cần thấy dưới dạng "ghép cặp thất bại" — số vẫn còn trên
// màn hình, họ vẫn gõ được lệnh trên máy dev dù điện thoại không nghe lại
// được kết quả.
async function waitForPairVerdict(pairId, machineName) {
  try {
    // 120 lần x 1 giây — cùng ngân sách với vòng chờ nonceMachine ở trên:
    // đủ cho một người đọc số trên điện thoại rồi gõ nó vào một cửa sổ
    // terminal đang mở sẵn trên máy dev.
    for (let i = 0; i < 120; i += 1) {
      // Kiểm TRƯỚC mỗi lần hỏi hub: nếu Huỷ đã chạy, hoặc một lượt ghép cặp
      // MỚI đã bắt đầu (pendingPair trỏ sang pairId khác), vòng này phải bỏ
      // cuộc ngay — nếu không, nó sẽ ghi đè lên UI của lượt ghép cặp khác.
      if (!pendingPair || pendingPair.pairId !== pairId) return;
      let state = null;
      const r = await api(`/api/pair/${encodeURIComponent(pairId)}`);
      if (r.ok) { ({ state } = await r.json()); }
      // Kiểm LẠI ngay sau khi chờ mạng — trong lúc đó người dùng có thể vừa
      // Huỷ hoặc vừa bắt đầu một lượt ghép khác.
      if (!pendingPair || pendingPair.pairId !== pairId) return;

      if (state === 'done') {
        if (machineName) await rememberMachine(machineName);
        pendingPair = null;
        $('pair-step').textContent = '✓ Máy dev đã ghép xong.';
        $('pair-panel').classList.add('hidden');
        await refreshTerminal();
        return;
      }
      if (state === 'aborted') {
        pendingPair = null;
        $('pair-step').textContent = 'Máy dev báo số không khớp — có người đứng giữa.';
        const err = $('pair-err');
        err.textContent = 'Đừng thử lại cho tới khi hiểu vì sao.';
        err.classList.remove('hidden');
        return;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (pendingPair && pendingPair.pairId === pairId) {
      $('pair-step').textContent = 'Máy dev chưa xác nhận. Gõ /remote pair xac-nhan <số> trên máy rồi đợi thêm.';
    }
  } catch {
    // Mạng chập chờn khi đang CHỜ XEM verdict không phải lỗi người dùng cần
    // thấy ngay — số vẫn còn trên màn hình, và lệnh đã gõ trên máy dev (nếu
    // có) vẫn có hiệu lực dù điện thoại không nghe lại được kết quả.
  }
}

// Nút Huỷ KHÔNG phải một phán quyết — nó chỉ dọn hàng đợi ghép cặp trên hub
// (state -> 'aborted') để mục đó không nằm chờ hết hạn 5 phút cho có. Không
// còn nhánh "ok:true": chỉ có máy dev mới gọi finish với ok:true, từ
// `/remote pair xac-nhan <số>`.
async function cancelPairing() {
  if (!pendingPair) return;
  const { pairId } = pendingPair;
  await api('/api/pair/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairId, ok: false }),
  });
  pendingPair = null;
  $('pair-panel').classList.add('hidden');
  await refreshTerminal();
}

// --- Màn hình Cài đặt -------------------------------------------------------
//
// pushState chứ KHÔNG replaceState: mục được thêm vào lịch sử chính là thứ nút
// Back của điện thoại tiêu thụ để đóng trang này. replaceState sẽ làm Back rời
// khỏi trang — đúng cái người dùng không định làm.
//
// URL giữ nguyên `location.pathname`. /link dùng chung file này và showLink()
// rẽ nhánh trên đúng giá trị đó.
let settingsOpen = false;

function openSettings() {
  if (settingsOpen) return;   // bấm hai lần thì phải Back hai lần mới ra
  settingsOpen = true;
  history.pushState({ ccrc: 'settings' }, '', location.pathname);
  $('main').classList.add('hidden');
  $('settings').classList.remove('hidden');
  refreshDevices();
}

// Chỉ ĐÓNG, không đụng lịch sử — nó được gọi TỪ popstate. Nút ‹ gọi
// history.back() để cả hai đường đóng đều đi qua đúng một chỗ này.
function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  $('settings').classList.add('hidden');
  $('main').classList.remove('hidden');
}

$('settings-open').onclick = () => openSettings();
$('settings-close').onclick = () => history.back();
window.addEventListener('popstate', () => closeSettings());

// Một tab trình duyệt không tự biến thành PWA giữa chừng, nên hỏi một lần lúc
// nạp trang là đủ. iOS Safari không hỗ trợ `display-mode`, nó có
// `navigator.standalone` riêng — thiếu nhánh đó thì đúng cái máy mà ghi chú
// này nhắm tới lại là máy vẫn bị nhắc.
function dangChayTrongPwa() {
  if (navigator.standalone === true) return true;
  if (!window.matchMedia) return false;
  try { return window.matchMedia('(display-mode: standalone)').matches; }
  catch (e) { return false; }
}

if (dangChayTrongPwa()) $('pwa-note').classList.add('hidden');

$('pair-cancel').onclick = () => cancelPairing();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  const onLink = location.pathname === '/link';
  // Có ?login= thì phải đổi mã TRƯỚC, vì token trong localStorage (nếu có)
  // là của lần đăng nhập cũ.
  //
  // Chạy TRƯỚC nhánh /link, không phải sau: hôm nay hub luôn redirect về
  // `/?login=`, nhưng nếu một ngày nào đó nó giữ lại đường dẫn thì thứ tự cũ
  // sẽ hiện thẻ đăng nhập trong khi một claimCode còn sống nằm ngay trên
  // thanh địa chỉ — vừa là ngõ cụt, vừa để một mã dùng được nằm phơi ra.
  if (await consumeLoginCode()) {
    if (onLink) { showLink(); return; }
    showMain().catch(() => logout());
    return;
  }
  if (onLink) { showLink(); return; }
  if (token) showMain().catch(() => logout());
})();
