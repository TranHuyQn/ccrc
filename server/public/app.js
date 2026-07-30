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
  $('login').classList.remove('hidden');
}

async function showMain() {
  const me = await (await api('/api/me')).json();
  $('who').textContent = `${me.user} · ${me.pushDevices} thiết bị`;
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  await refreshPushState();
  await refreshList();
  await refreshTerminal();
}

async function refreshList() {
  const { items } = await (await api('/api/notifications')).json();
  // Giữ lại cho phần tính chấm "chưa đọc" bên dưới. Danh sách terminal được
  // dựng từ một fetch KHÁC, nên đây là nơi duy nhất nó biết được phiên nào
  // đang có việc chờ.
  recentNotes = items || [];
  const list = $('list');
  list.textContent = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = 'Chưa có thông báo nào.';
    list.appendChild(p);
    return;
  }
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'note';
    const t = document.createElement('div');
    t.className = 'note-title';
    t.textContent = it.title;
    const b = document.createElement('div');
    b.className = 'note-body';
    b.textContent = it.body;
    const w = document.createElement('div');
    w.className = 'note-when dim';
    w.textContent = new Date(it.at).toLocaleString('vi-VN');
    el.append(t, b, w);
    list.appendChild(el);
  }
}

// --- Phiên nào đang có thông báo chưa đọc -----------------------------------
//
// Hub gắn `sessionId` vào mỗi thông báo nó ghi lại (server/src/index.js), nên
// "phiên này có việc chờ mình" rút gọn thành: có thông báo nào của phiên đó
// mới hơn lần cuối mình xem nó không.
//
// Mốc "lần cuối xem" nằm trong localStorage của CHÍNH máy này, không phải trên
// hub: không endpoint mới, không state mới ở server, và hai thiết bị thì mỗi
// thiết bị tự đếm — vốn đúng hơn là dùng chung. Lịch sử thông báo trên hub
// cũng chỉ nằm trong RAM (HISTORY_MAX = 50), nên mốc đọc không cần bền hơn nó.

// Thông báo của lần refreshList() gần nhất.
let recentNotes = [];

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

function hasUnread(sessionId) {
  if (!sessionId) return false;
  const since = lastReadAt(sessionId);
  // `>` chứ không `>=`: markRead() ghi Date.now(), và một thông báo đến đúng
  // cùng mili-giây với lúc mở phải tính là đã đọc.
  return recentNotes.some((n) => n && n.sessionId === sessionId && n.at > since);
}

// Mỗi `/remote on` sinh một sessionId mới, nên không dọn thì localStorage tích
// một khoá vĩnh viễn cho mỗi phiên từng chạy. Chỉ xoá khoá mà CẢ danh sách
// phiên hiện tại LẪN lịch sử thông báo đều không nhắc tới — khi cả hai đều
// không nhắc thì mốc đã đọc đó không còn ảnh hưởng tới bất cứ thứ gì hiển thị
// được, nên xoá là an toàn.
function pruneReadMarks(sessions) {
  const keep = new Set();
  for (const s of sessions) if (s && s.sessionId) keep.add(s.sessionId);
  for (const n of recentNotes) if (n && n.sessionId) keep.add(n.sessionId);
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

// Renders the terminal list from GET /api/terminal. Silence is the wrong
// default here (unlike the rest of this file) — the terminal spec (§7) is
// explicit that a person is standing there waiting, so every branch below
// leaves something visible rather than a stale or blank list.
//
// Coalesced through `terminalRefreshInFlight`: a bfcache restore can fire
// 'pageshow' and 'visibilitychange' back to back (see the listeners below),
// and both must resolve to exactly one GET /api/terminal — not one per
// event, and not one per rendered card. Any caller during a refresh already
// in flight just gets that same promise instead of starting a second one.
let terminalRefreshInFlight = null;

function refreshTerminal() {
  if (terminalRefreshInFlight) return terminalRefreshInFlight;
  terminalRefreshInFlight = doRefreshTerminal().finally(() => {
    terminalRefreshInFlight = null;
  });
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
    err.textContent = 'Không lấy được trạng thái terminal, thử lại sau.';
    err.classList.remove('hidden');
    return;
  }

  await renderTerminalList(sessions || []);
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
    // Array.from(card.children), KHÔNG gọi thẳng card.children.find(...):
    // trên DOM thật .children là một HTMLCollection và không có .find — chỉ
    // mảng giả trong bộ khung test mới có. Gọi thẳng sẽ vỡ ngay ở lần tải
    // trang thật đầu tiên dù mọi test ở đây vẫn xanh — đúng loại lỗi
    // `f({a} = {})` đã lọt lưới ba lần trong kế hoạch này, giờ đổi hình dạng.
    const btn = Array.from(card.children).find((c) => c.tagName === 'BUTTON');
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
  const unread = hasUnread(session.sessionId);
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
    note.textContent = 'Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt.';
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

let devicesOpen = false;

async function refreshDevices() {
  if (!devicesOpen) return;
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

$('devices-toggle').onclick = async () => {
  devicesOpen = !devicesOpen;
  $('devices').classList.toggle('hidden', !devicesOpen);
  $('devices-toggle').textContent = devicesOpen ? 'Ẩn' : 'Xem';
  await refreshDevices();
};

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
  await refreshDevices();
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
// Cả hai danh sách được nạp lại, không riêng terminal: chấm "chưa đọc" trên
// thẻ được tính từ giao của /api/terminal và /api/notifications (xem
// hasUnread()), nên chỉ nạp lại một cái thì chấm hoặc không bao giờ sáng, hoặc
// không bao giờ tắt.
//
// Coalescing nằm ở ĐÂY chứ không mượn của refreshTerminal(): một cụm
// 'pageshow' + 'visibilitychange' bắn sát nhau phải quy về đúng một lượt nạp
// CẢ ĐÔI, không phải một lượt mỗi sự kiện. refreshTerminal() vẫn giữ
// coalescing riêng của nó cho các lối gọi khác (nhánh lỗi của openTerminal()).
let returnRefreshInFlight = null;

function refreshOnReturn() {
  // Only relevant once logged in; on the login screen there is no terminal
  // list, and a stale/absent token would just bounce off 401 → logout().
  if ($('main').classList.contains('hidden')) return;
  if (returnRefreshInFlight) return returnRefreshInFlight;
  returnRefreshInFlight = (async () => {
    // refreshList() không tự bắt lỗi như refreshTerminal(). Một lần 401 ở đây
    // đã logout() rồi ném tiếp, và không được để nó thành unhandled rejection
    // trên một promise mà listener của trình duyệt vứt đi. Nuốt lỗi ở đây chỉ
    // làm chấm được tính trên dữ liệu cũ; danh sách terminal vẫn phải dựng.
    await refreshList().catch(() => {});
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

$('pair-cancel').onclick = () => cancelPairing();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (token) showMain().catch(() => logout());
