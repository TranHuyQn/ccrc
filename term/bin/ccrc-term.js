#!/usr/bin/env node
// The daemon that exposes exactly one tmux pane over a WebSocket, and nothing
// else. It refuses every request that is not a valid, unused, unexpired token
// signed by a device the user actually paired, for the one session it was
// started for, and it exits the moment that pane dies — there is no state in
// which it is listening with nothing to serve.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { verifyAttachToken } from '../src/ticket.js';
import { findDevice } from '../src/devices.js';
import { createNonceStore } from '../src/nonce-store.js';
import { createSessionKeys } from '../src/session-keys.js';
import { wheelBytes, notchesForLines, clickBytes } from '../src/mouse.js';
import { chonNguonPane } from '../src/pane-source-chon.js';
import { theoDoiFileDung } from '../src/win-stop-file.js';
import { resolveSessionName } from '../src/session-name.js';
import { writeSession, removeSession } from '../../shared/session-registry.js';
import { ccrcHome } from '../../shared/home.js';
import { readConfig } from '../src/config.js';
import { checkPrereqs } from '../src/tailscale.js';
import { parsePositiveMs, requestedPortLabel } from '../src/env.js';
import { DEFAULT_MAX_TICKET_LIFETIME_MS } from '../src/ticket-policy.js';
import { handleStatic } from '../src/static.js';
import { PROTOCOL_VERSION } from '../../shared/protocol-version.js';
import { phienBanTrenDia } from '../src/disk-version.js';
import { docPhienBanHub, docDauVanTayHub } from '../src/hub-version.js';
import { dauVanTay } from '../../shared/bundle-fingerprint.js';

// Default 0 asks the OS for any free port, which is what lets more than one
// daemon run at once (each on its own pane) — a fixed port meant the second
// `/remote on` always failed with EADDRINUSE. The real bound port is only
// known once `listen`'s callback fires (see below); CCRC_TERM_PORT still
// pins it for tests that need a predictable, pre-known port.
const PORT = Number(process.env.CCRC_TERM_PORT || 0);
const PANE = process.env.CCRC_TERM_PANE;
// Nguồn pane dùng chung cho những câu hỏi KHÔNG thuộc về một kết nối nào: kiểm
// tra lúc khởi động, vòng poll, và ghi sổ tra phiên — VÀ giờ cũng là nơi vòng
// đời phiên nhóm thật sự sống (attach/close), dùng chung cho MỌI kết nối.
//
// runId không truyền vào đây — pane-source.js tự sinh một cái (mặc định
// `runId = makeRunId()`) ngay lúc dựng, đúng một lần, trước khi kết nối đầu
// tiên tới. Cái id đó là thứ tmux.js dùng để phân biệt "phiên nhóm của lượt
// chạy này" với một phiên bị bỏ rơi bởi daemon đã chết (xem
// isReclaimableMarker trong src/tmux.js) — nhưng việc sinh và so sánh nó giờ
// hoàn toàn ở trong pane-source.js, không còn là việc của file này.
const paneChung = chonNguonPane({ pane: PANE });
const SESSION_ID = process.env.CCRC_TERM_SESSION_ID;
let publicUrl = process.env.CCRC_TERM_URL || '';
const NO_HUB = process.env.CCRC_TERM_NO_HUB === '1';
// What the phone shows for this session. The pane's directory basename used
// to be it, and on a lock screen that names the project — so the default is
// now an opaque id, and a readable name appears only because the user typed
// one (`/remote on <tên>`, carried here by the CLI). Resolved ONCE at
// startup, unlike the old label which was recomputed per heartbeat: a name
// that changes under the user while they are looking at it is worse than one
// that goes slightly stale.
const SESSION_NAME = resolveSessionName(process.env.CCRC_TERM_NAME);
const HEARTBEAT_MS = 20_000;
const PANE_CHECK_MS = 2_000;
// The longest a token is allowed to have been MINTED for (exp - iat),
// regardless of how far exp looks from here right now. Bounding on the
// minted lifetime instead of "exp minus my current clock" means a normal
// 60s token from a phone whose clock runs ahead of ours is accepted
// immediately rather than refused now and quietly becoming usable later —
// see task-6-report.md, round 3, for why that distinction matters.
// parsePositiveMs guards against a typo in the override disabling the
// clamp outright (Number('garbage') is NaN, and every comparison against
// NaN is false). Overridable only so tests can exercise it without a real
// 60s wait.
// DEFAULT_MAX_TICKET_LIFETIME_MS (term/src/ticket-policy.js) is deliberately
// HIGHER than the 60s the PWA hardcodes when it mints a token
// (server/public/app.js's signAttachToken) — see that file's comment for why
// zero headroom between the two is itself a bug (item 6, final fix wave).
const MAX_TICKET_LIFETIME_MS = parsePositiveMs(process.env.CCRC_TERM_MAX_TICKET_MS, DEFAULT_MAX_TICKET_LIFETIME_MS);
// Plausible bounds for a `ccrc_resize` control message's cols/rows. These
// numbers come from a browser (client-reported, never trusted) and are
// about to reach `tmux refresh-client -C`, i.e. a command line — reject
// anything outside "some real terminal" before it gets anywhere near that.
const MIN_TERM_COLS = 10;
const MAX_TERM_COLS = 1000;
const MIN_TERM_ROWS = 4;
const MAX_TERM_ROWS = 500;
// Bound on a single `ccrc_scroll` request. Same reasoning as the cols/rows
// bounds above: this number comes from a browser and lands in a tmux command.
const MAX_SCROLL_LINES = 500;
// Trần cho MỘT lượt dán từ ô soạn. Không phải giới hạn của tmux (buffer nhận
// thoải mái hơn thế nhiều) mà là trần cho thứ đến từ trình duyệt: nó được ghi
// vào một tiến trình con và dội thẳng vào phiên đang sống của người dùng.
// 100 KB rộng hơn mọi tin nhắn viết tay, và vẫn là một con số.
const MAX_PASTE_BYTES = 100_000;

// Mã đóng WebSocket cho "phiên này chấm dứt hẳn".
//
// Phân biệt với rớt mạng là điều bắt buộc: rớt mạng thì trang phải nối lại,
// còn phiên đã đóng thì nối lại mãi mãi cũng vô ích — và người dùng sẽ ngồi
// nhìn "đang nối lại…" quay vòng mà không hiểu chuyện gì. Dải 4000–4999 dành
// cho ứng dụng tự định nghĩa.
const CLOSE_SESSION_ENDED = 4001;
// Thiết bị chưa được ghép với máy này.
//
// Vì sao phải bắt tay rồi mới đóng, thay vì từ chối bằng 401 như mọi lỗi
// khác: trình duyệt KHÔNG đọc được mã trạng thái HTTP của một cái bắt tay
// WebSocket bị từ chối — nó chỉ thấy `error` rồi `close` mã 1006, y hệt rớt
// mạng. Muốn nói được với người dùng "bạn chưa ghép máy này" thì phải nói
// SAU khi bắt tay xong, bằng một mã đóng của ứng dụng.
//
// CHỈ dùng cho `unknown_device`. `bad_signature` là có kẻ ký bậy — với nó,
// im lặng từ chối vẫn đúng: không bắt tay, và không giải thích gì.
const CLOSE_DEVICE_NOT_PAIRED = 4003;

if (!PANE || !SESSION_ID) {
  console.error('Thiếu CCRC_TERM_PANE hoặc CCRC_TERM_SESSION_ID');
  process.exit(1);
}
// CCRC_TERM_URL, khi hỏng định dạng, trước đây chỉ bị `new URL()` ném BÊN
// TRONG callback bất đồng bộ của server.listen() (xây ownHost — xem bên
// dưới) — SAU khi cổng đã bind thật, TRƯỚC dòng "[term] nghe…" mà `/remote
// on` chờ để biết daemon đã lên. Kết quả: một stack trace thô, và phía CLI
// chỉ thấy im lặng cho tới khi hết giờ chờ của chính nó. Validate ở đây,
// trước bất cứ việc gì khác, để một giá trị hỏng chết NGAY với một câu gọi
// tên đúng biến.
if (publicUrl) {
  try {
    // eslint-disable-next-line no-new
    new URL(publicUrl);
  } catch {
    console.error(`[term] CCRC_TERM_URL không phải một URL hợp lệ: "${publicUrl}"`);
    process.exit(1);
  }
}
if (!paneChung.alive()) {
  console.error(`Pane ${PANE} không tồn tại.`);
  process.exit(1);
}

// `ccrcHome()`, cùng nhà với mọi thứ khác daemon này ghi (sổ tra phiên ở
// dưới). Để `os.homedir()` ở đây nghĩa là daemon KHÔNG cô lập được: một bài
// test dựng daemon thật dưới CCRC_HOME giả sẽ thấy nó đọc cấu hình thật —
// hoặc, đúng như đã đo trong task này, không đọc được cấu hình nào và im
// lặng không đăng ký với hub, mà chẳng có gì báo.
const cfg = readConfig(ccrcHome());
const nonces = createNonceStore();
// Created fresh per daemon process, never shared: a key must die with the
// daemon it was issued by, and must never open a connection on any other
// daemon (see the "khoá của daemon này KHÔNG dùng được cho daemon khác" test).
const sessionKeys = createSessionKeys();

let shuttingDown = false;

// Vòng đời phiên nhóm (spec §5.5, src/tmux.js) không còn được daemon giữ sổ
// sách nữa kể từ Task 2 — `paneChung` (attach/close) tự đếm và tự dọn. Cái còn
// lại ở đây là `conn` của MỌI kết nối đang sống, để shutdown() có thể đóng
// đồng loạt, ĐỒNG BỘ, ngay trong tiến trình — xem shutdown() bên dưới để biết
// vì sao không thể chỉ đợi sự kiện 'close' của từng WebSocket tới.
const liveConns = new Set();

// Which connected clients currently have this page ON SCREEN.
//
// This is what suppresses a push notification for a session the user is
// already looking at. "The WebSocket is open" would have been the easy
// signal and the wrong one: a phone that locks its screen, or switches apps,
// keeps the socket alive for a while — and the user would simply stop
// receiving notifications with no way to tell why. So the page reports its
// own visibility (see term.js's `ccrc_visibility` frame) and a client that
// says nothing is treated as watching, since that is the state it is in the
// moment it connects.
const viewers = new Map(); // ws -> visible?

function someoneIsWatching() {
  for (const visible of viewers.values()) if (visible) return true;
  return false;
}

// Assigned once the hub heartbeat exists (see `beat` below). Watching state
// has to reach the hub PROMPTLY, not on the next 20-second beat: waiting
// would let a notification through for a terminal the user opened seconds
// ago, and keep them suppressed for up to 20 seconds after they close it.
// So every change pushes a beat of its own.
let sendHeartbeat = () => {};
let lastWatching = null;

function watchingChanged() {
  const now = someoneIsWatching();
  if (now === lastWatching) return; // nothing to tell the hub
  lastWatching = now;
  // Fire and forget: a failed heartbeat is already handled by the periodic
  // one, and this must never reject into a WebSocket handler.
  try { Promise.resolve(sendHeartbeat()).catch(() => {}); } catch {}
}

// Gốc của bản cài này: term/bin/ → term/ → gốc. Cùng cây mà install.sh bung ra,
// nên dấu vân tay tính ở đây so được thẳng với dấu vân tay hub khai.
const GOC_BAN_CAI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Dấu vân tay của code ĐANG CHẠY: chụp một lần lúc khởi động, không bao giờ
// tính lại. Đem so với dấu vân tay đọc từ đĩa lúc có người nối vào là biết
// ngay bản cài đã bị thay dưới chân daemon hay chưa — tình trạng đã âm thầm
// kéo dài hai ngày trước 2026-08-17.
const VT_RAM = dauVanTay(GOC_BAN_CAI);

// Phiên bản hợp đồng của gói cài hub đang phục vụ, học được từ nhịp heartbeat.
// null nghĩa là chưa biết: chưa nhịp nào thành công, hoặc hub cũ không khai.
// "Chưa biết" phải khác "bằng 0", nếu không thì lời nhắc cài lại sẽ hiện mãi.
let phienBanHub = null;
// Dấu vân tay gói cài hub đang phục vụ. Khác với dấu vân tay trên đĩa nghĩa là
// có bản mới để CÀI (chạy lại install.sh), khác với chuyện nạp lại daemon.
let vanTayHub = null;

async function tellHub(pathname, body) {
  if (NO_HUB || !cfg) return;
  try {
    const res = await fetch(new URL(pathname, cfg.hubUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    // Nhân tiện: hub khai phiên bản gói cài nó đang phục vụ. Không tự cập nhật
    // gì cả — chỉ để nói được với người dùng là có bản mới.
    const than = await res.json().catch(() => null);
    const v = docPhienBanHub(than);
    if (v !== null) phienBanHub = v;
    const vt = docDauVanTayHub(than);
    if (vt !== null) vanTayHub = vt;
  } catch { /* the hub being unreachable must never take the terminal down */ }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[term] đóng: ${reason}`);
  // Belt-and-suspenders: per-connection cleanup (see `close()` below) is
  // what normally removes the grouped session, but that runs off the
  // WebSocket's own 'close' event, which is not guaranteed to have fired
  // yet by the time we get here (e.g. the pane died and this was reached
  // straight from the PANE_CHECK_MS poll). A tmux session outlives this
  // process, so skipping this would leak it forever.
  //
  // Since Task 2, the group itself is torn down by `conn.close()` (inside
  // `paneChung`, once the last connection using it has gone) rather than by
  // a name this file holds — so belt-and-suspenders now means closing every
  // live `conn` synchronously, right here, instead of waiting on a WebSocket
  // round trip that is not guaranteed to finish before this process exits.
  for (const conn of liveConns) { try { conn.close(); } catch {} }
  liveConns.clear();
  // Tell every browser this is the END, not a hiccup. Without a distinct code
  // the page cannot tell the two apart and retries for ever — the phone would
  // sit on "đang nối lại…" for a session that no longer exists.
  for (const client of wss.clients) {
    try { client.close(CLOSE_SESSION_ENDED, 'phiên đã đóng'); } catch { /* already gone */ }
  }
  // Take this session out of the local registry the notification hook reads,
  // so notifications from this directory stop claiming a name that no longer
  // exists. A `kill -9` skips this, which is why every reader also checks
  // that the recorded pid is still alive (shared/session-registry.js).
  removeSession(SESSION_ID, { home: ccrcHome() });
  tellHub('/api/terminal/unregister', { sessionId: SESSION_ID }).finally(() => {
    process.exit(0);
  });
}

// --- static files ------------------------------------------------------
//
// Serves the browser page itself (public/) and the vendored xterm.js
// build (vendor/) from this same origin, so the page and the WebSocket
// never hit a mixed-content or cross-origin problem. The actual serving
// logic lives in ../src/static.js — a plain module with no side effects at
// import time, so it can be unit-tested directly instead of only through a
// spawned daemon process.

const TERM_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.resolve(TERM_ROOT, 'public');
const VENDOR_DIR = path.resolve(TERM_ROOT, 'vendor');

// --- WebSocket -------------------------------------------------------------

const server = http.createServer((req, res) => handleStatic(req, res, { publicDir: PUBLIC_DIR, vendorDir: VENDOR_DIR }));
const wss = new WebSocketServer({ noServer: true });

// Origin nào được phép bắt tay WebSocket với daemon này.
//
// Chốt này KHÔNG thay thế phép kiểm token — nó đứng trước một đường mà token
// không đóng được. Token do trang PWA ký, và trang PWA do HUB phục vụ: một hub
// bị chiếm sửa `app.js` để ký một token hoàn toàn hợp lệ (đúng `sid`, đúng
// `h`, chưa hết hạn) rồi đẩy điện thoại sang một trang `http://` của kẻ tấn
// công. Trang đó mở WebSocket tới đây TỪ CHÍNH ĐIỆN THOẠI NẠN NHÂN — cái máy
// đang ở trong tailnet — và tiếp sức shell ra ngoài. Mọi phép kiểm trong
// ticket.js đều qua, vì cái token ấy thật.
//
// `Origin` là thứ duy nhất phân biệt được hai trang: trình duyệt tự đặt nó cho
// mọi kết nối WebSocket và một trang web không sửa được nó cho chính mình.
//
// So `host`, không so cả URL — cùng quy ước `data.h` của ticket.js dùng, và vì
// scheme không mang thông tin gì ở đây (daemon chỉ phục vụ http).
//
// VẮNG MẶT thì cho qua, và đây là chỗ dễ siết nhầm theo phản xạ "chặt hơn thì
// an toàn hơn". Kẻ tấn công mà chốt này nhắm tới là một TRANG WEB chạy trong
// trình duyệt nạn nhân, và trình duyệt LUÔN gửi Origin — trang đó không có
// cách nào bỏ header ấy đi. Nên chặn thêm ca vắng mặt không chặn thêm được ai;
// nó chỉ giết những client không phải trình duyệt (script, công cụ gỡ rối, bộ
// test này) để đổi lấy đúng không gì cả.
//
// Chuỗi `"null"` thì NGƯỢC LẠI: đó là thứ trình duyệt thật gửi từ một ngữ cảnh
// đã bị tước nguồn gốc (iframe sandbox, `file://`) — có Origin, và Origin đó
// không phải daemon này. `new URL('null')` ném, nên nó rơi vào nhánh từ chối
// mà không cần một phép kiểm riêng.
function originDuocPhep(origin, host) {
  if (origin === undefined || origin === '') return true;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/attach') return socket.destroy();

  // Trước cả token: một trang lạ không được phép tiến thêm bước nào, kể cả
  // bước đốt nonce của một token thật mà nó vừa được đưa cho.
  if (!originDuocPhep(req.headers.origin, ownHost)) {
    console.log(`[term] bắt tay bị từ chối: Origin "${req.headers.origin}" không phải daemon này (${ownHost})`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }

  // `?token=` thay cho `?ticket=`: token do CHÍNH ĐIỆN THOẠI ký, không phải
  // do hub ký hộ. Hub không còn giữ gì ký được nó. Vẫn đúng luật cũ: kiểm
  // trước, và khi có token thì chỉ xét token — một `?key=` đi kèm một token
  // hỏng không được rơi xuống nhánh key, nếu không một khoá phiên bị lộ sẽ
  // che lấp được một token bị từ chối.
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  let mintKey = false;

  if (token !== null) {
    const v = verifyAttachToken(token, {
      // Đọc lại devices.json ở MỖI kết nối, không nạp một lần lúc khởi động:
      // `/remote unpair` phải có hiệu lực ngay, không đợi khởi động lại daemon.
      findDevice: (id) => findDevice(id),
      sessionId: SESSION_ID,
      // Host chính daemon này quảng bá (spec §13, C3) — một token ký cho một
      // host khác đã bị lừa sang trang lạ, và không xác minh được ở đây.
      expectedHost: ownHost,
    });
    if (!v.ok) {
      if (v.reason === 'unknown_device') {
        // Bắt tay đã, rồi đóng ngay bằng mã riêng — xem chú thích ở
        // CLOSE_DEVICE_NOT_PAIRED. Không attach vào pane, không mint khoá
        // phiên: kết nối này chỉ sống đủ lâu để mang một mã đóng đi.
        return wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.close(CLOSE_DEVICE_NOT_PAIRED, 'thiết bị chưa được ghép'); } catch { /* đã đóng */ }
        });
      }
      // Mọi lý do khác đây là một 401 CÂM phía trình duyệt: không mã đóng
      // riêng nào giải thích được (xem CLOSE_DEVICE_NOT_PAIRED ở trên — nó
      // CHỈ dành cho unknown_device). Không ghi gì ra log ở đây thì người
      // đang gỡ rối trên máy dev không có cách nào biết VÌ SAO "Mở terminal"
      // không hoạt động. wrong_host ghi kèm CẢ HAI host — cái token khai và
      // cái daemon này chấp nhận — vì sau bản vá C3 đây là lý do nhiều khả
      // năng nhất sẽ bị dính (CCRC_TERM_URL/CCRC_TERM_BIND lệch nhau, ownHost
      // tính sai, v.v.).
      if (v.reason === 'wrong_host') {
        console.log(`[term] token bị từ chối (wrong_host): token ký cho "${v.gotHost}", daemon này chỉ chấp nhận "${ownHost}"`);
      } else {
        console.log(`[term] token bị từ chối: ${v.reason}`);
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    // Clamp: refuse any token MINTED for longer than we are willing to
    // honour, no matter how far exp looks from here right now. Bounding on
    // (exp - iat) rather than (exp - Date.now()) matters: the latter is
    // evaluated against whatever clock is doing the looking, so a phone running
    // ahead of this daemon would see its perfectly normal 60s tokens refused
    // now and then — nonsensically — become usable on their own later, once
    // enough real time passes that (exp - Date.now()) drops under the clamp.
    // Measuring the MINTED lifetime instead means a normal token is accepted
    // immediately regardless of clock skew, and only a token actually minted
    // for an excessive lifetime is refused.
    if (v.exp - v.iat > MAX_TICKET_LIFETIME_MS) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    // One-time use. Checked only after the signature, so a forged token cannot
    // burn a nonce it never legitimately held. Retained until the TOKEN'S OWN
    // exp, not a fixed window unrelated to it — see the finding this fixes.
    if (!nonces.use(v.nonce, Date.now(), v.exp)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    // Only a token connection mints a sessionKey. A `?key=` connection must
    // never spend a nonce and must never mint another key — otherwise a
    // single leaked token could be turned into an unbounded chain of keys.
    mintKey = true;
  } else if (!sessionKeys.valid(key)) {
    // No token at all, and the key (missing, malformed, or unknown) is not
    // valid either — 401, same as a bad token.
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  // The pane can die in the (up to PANE_CHECK_MS) gap between polls. A
  // connection that cleared every other check must still not be allowed to
  // open onto a pane that is already gone.
  if (!paneChung.alive()) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, mintKey));
});

wss.on('connection', (ws, mintKey) => {
  // Hai đường ra, phân biệt bằng KIỂU KHUNG WebSocket, không bao giờ bằng nội
  // dung: nhị phân là byte của pane, text là JSON điều khiển. Trang đọc đúng
  // theo quy ước đó (public/term.js), và nó đối xứng với chiều vào — nơi
  // khung nhị phân là phím gõ còn khung text là điều khiển.
  //
  // Trước 2026-08-16 cả hai đi chung khung text, nên trang phải đoán bằng
  // "khung đầu tiên là điều khiển". Đoán ấy chỉ đủ cho MỘT khung điều khiển
  // mỗi kết nối: mọi `ccrc_loi` gửi sau đó bị vẽ ra lưới thành cục JSON, tức
  // là kênh báo lỗi thêm vào ngày 2026-08-15 chưa từng tới được người dùng.

  // Nguồn pane dùng chung (paneChung, khai ở đầu file) phục vụ MỌI kết nối —
  // các phương thức đọc không giữ trạng thái nên dùng chung là an toàn; vòng
  // đời có trạng thái (phiên nhóm, ctl) sống bên trong attach()/conn.close()
  // của chính nó, riêng cho từng kết nối (xem pane-source.js, Task 2).

  function sendPane(text) {
    if (!text) return;
    try { ws.send(Buffer.from(text, 'utf8'), { binary: true }); } catch {}
  }
  function sendCtl(obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  // A key is only ever issued right after a ticket does its job — never on a
  // `?key=` reconnect, which cannot mint another one for itself. Sent first,
  // ahead of the pane snapshot below, so it is reliably the WebSocket's very
  // first message and a client can read it without racing terminal data.
  if (mintKey) {
    sendCtl({ type: 'ccrc_session', key: sessionKeys.issue() });
  }
  // Send what is on screen right now, so the phone opens onto the current
  // state instead of an empty rectangle until the next byte of output.
  // snapshotPane (src/tmux.js) trims the pane's trailing blank rows and
  // wraps the capture in a clear-screen/home + SGR reset — see its comment
  // for the two acceptance-run defects (content scrolled off a shorter
  // browser terminal; a leaked background colour tinting everything after)
  // this fixes.
  sendPane(paneChung.snapshot());

  // --- xem lại lịch sử ---------------------------------------------------
  //
  // While the user is looking at scrollback, live output must NOT be written
  // over what they are reading — but it must not be lost either: coming back
  // to the present re-sends the current screen, which is exactly what the
  // pane looks like after everything that happened meanwhile.
  //
  // `historyOffset` is how many lines above the live screen's top row the
  // browser is currently parked. 0 means live.
  //
  // Khai báo TRƯỚC lời gọi attach() dưới đây: onData của attach() đọc
  // historyOffset ngay trong closure của nó.
  let historyOffset = 0;
  // The browser's own grid height, learned from its resize report. The
  // history screen must be exactly this tall or it will not line up with
  // what the terminal expects.
  let clientRows = 24;
  let clientCols = 80;

  function showHistory(want) {
    const max = paneChung.historySize();
    let offset = want;
    if (offset < 0) offset = 0;
    if (offset > max) offset = max;

    if (offset === 0) {
      // Back to the present. Re-send the live screen so the user sees
      // everything that arrived while they were reading back, then let live
      // output through again.
      historyOffset = 0;
      sendPane(paneChung.snapshot());
      return;
    }
    const screen = paneChung.history(offset, clientRows);
    // An empty capture means tmux had nothing to give (a pane that just
    // died, a history shorter than claimed). Staying where we are beats
    // blanking the terminal.
    if (!screen) return;
    historyOffset = offset;
    sendPane(screen);
  }

  // Mỗi kết nối một đường tiếp sức riêng vào cùng phiên nhóm — vòng đời (dựng
  // nhóm ở lần attach() đầu tiên, dọn khi conn cuối cùng đóng) sống bên trong
  // paneChung từ Task 2. GỌI CHO MỌI KẾT NỐI, không chỉ kết nối đầu tiên — xem
  // đầu Task 2 (pane-source.js) để biết vì sao gộp lại là hỏng: hai trình
  // duyệt cần hai ống ctl riêng vào cùng một phiên nhóm.
  //
  // Phải quyết định "hỏng tạm" hay "hết phiên" TRƯỚC khi đóng socket, không
  // phải sau. Đóng bằng 1011 rồi mới gọi shutdown() là mã 1011 thắng: socket
  // đã ở trạng thái đang đóng, lệnh close(4001) trong shutdown() thành vô
  // hiệu, và trình duyệt đọc 1011 là "trục trặc, thử lại đi" nên nối lại mãi.
  //
  // Đo được trên máy thật: đóng Claude → điện thoại báo "vé đã dùng", đúng
  // hành vi của nhánh rớt mạng. Test cũ không thấy vì nó bắn SIGTERM — đường
  // của `/remote off`, ở đó shutdown() chạy trước và 4001 kịp đi. Đường
  // thường ngày lại là pane chết, và ở đó thứ tự ngược lại.
  const gan = paneChung.attach({
    onData: (data) => {
      // Giữ lại chứ không vứt: showHistory(0) gửi lại nguyên màn hình hiện tại
      // trên đường quay về, nên không mất gì.
      if (historyOffset > 0) return;
      sendPane(data);
    },
    onCtlReply: (ok, message) => {
      // Lời đáp không ai đăng ký nhận. Xuôi thì chẳng có gì để nói; hỏng thì
      // vẫn phải nói ra — im lặng ở đây nghĩa là người dùng ngồi chờ Claude
      // trả lời một câu nó chưa bao giờ nhận.
      if (!ok) sendCtl({ type: 'ccrc_loi', message: String(message).slice(0, 200) });
    },
    onGone: ({ fatal, reason }) => {
      if (!fatal) {
        // Chỉ mất đường tiếp sức của riêng kết nối này; pane vẫn sống, nối lại
        // là được — đúng lúc để dùng mã "lỗi máy chủ".
        try { ws.close(1011, 'tmux control mode đã đóng bất ngờ'); } catch {}
        close();
        return;
      }
      // Pane không còn: phiên hết thật. Để shutdown() tự nói bằng mã 4001.
      shutdown(reason);
    },
  });
  if (!gan.ok) { ws.close(1011, gan.message); return; }
  const conn = gan.conn;
  liveConns.add(conn);

  // A client that just opened the page is looking at it — anything else
  // would let one notification through before the first visibility frame.
  viewers.set(ws, true);
  watchingChanged();

  // Binary frames are keystrokes; text frames are control messages (so far
  // just the resize report from spec §5.4). This is a FRAME-TYPE
  // discriminator, decided by `isBinary` alone — never content sniffing.
  // The daemon used to treat every message as input, hex-encoding and
  // typing it verbatim; once the client started also sending a JSON resize
  // report over the same socket, that meant a rotate/keyboard event typed
  // a JSON blob straight into the user's live Claude Code session. Same
  // discipline already applied server→client for the `ccrc_session` frame
  // (see term.js) — tell control and data apart by what channel it came
  // in on, not by what it happens to look like.
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      handleControlMessage(data);
      return;
    }
    // Typing means "I am done reading back". Snapping to the present first
    // matters for more than tidiness: the keystroke IS going to the live
    // pane whatever the browser is displaying, so leaving a history screen up
    // would show the user their input landing nowhere.
    if (historyOffset > 0) showHistory(0);
    conn.type(data);
  });

  // A text frame that isn't valid JSON, or whose `type` isn't recognised,
  // is dropped — never typed into the pane, never echoed anywhere. cols/rows
  // are range- and type-checked before they ever reach tmux: they come from
  // a browser and are about to reach a command line.
  function handleControlMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; } // not JSON — drop
    if (!msg || typeof msg !== 'object') return;
    // Trang hỏi "tôi đang nói chuyện với ai". Daemon CŨ không biết khung này
    // nên nó rơi vào nhánh drop cuối hàm và im lặng — chính sự im lặng đó là
    // cách trang nhận ra một bản quá cũ, nên đừng bao giờ biến khung lạ thành
    // một lời đáp chung chung.
    if (msg.type === 'ccrc_chao') {
      sendCtl({
        type: 'ccrc_chao_lai',
        // Phiên bản của code ĐANG CHẠY trong RAM tiến trình này...
        v: PROTOCOL_VERSION,
        // ...và phiên bản đang nằm trên đĩa lúc này. Hai số khác nhau nghĩa là
        // bản cài đã được cập nhật sau khi daemon khởi động, và daemon vẫn
        // đang chạy code cũ cho tới lần `/remote on` kế tiếp. Đúng tình trạng
        // đã âm thầm kéo dài hai ngày trước 2026-08-17.
        dia: phienBanTrenDia(),
        // ...và phiên bản gói cài hub đang phục vụ, nếu đã học được. Lớn hơn
        // hai số trên nghĩa là có bản mới để cài, không phải chỉ để nạp lại.
        hub: phienBanHub,
        // Ba dấu vân tay, đọc theo cùng một lối như ba số phiên bản trên.
        // Chúng bắt được cả bản chỉ sửa lỗi — thứ mà số phiên bản hợp đồng cố
        // ý không đổi theo, và vì thế bỏ sót.
        vtRam: VT_RAM,
        vtDia: dauVanTay(GOC_BAN_CAI),
        vtHub: vanTayHub,
      });
      return;
    }
    if (msg.type === 'ccrc_visibility') {
      // Only an explicit boolean counts. A malformed frame must not be able
      // to flip this either way — silently turning notifications off is the
      // failure the user would never diagnose.
      if (typeof msg.visible === 'boolean') {
        viewers.set(ws, msg.visible);
        watchingChanged();
      }
      return;
    }
    if (msg.type === 'ccrc_paste') {
      // Chuỗi, và không rỗng. Một khung hỏng không được biến thành cái gì gõ
      // vào phiên đang sống của người dùng.
      if (typeof msg.text === 'string' && msg.text.length > 0) {
        // Gửi tin nhắn cũng là "tôi đọc xong rồi", y như gõ phím ở nhánh
        // nhị phân — và cần nói riêng ở đây vì ô soạn KHÔNG còn đi qua nhánh
        // đó nữa. Thiếu dòng này thì tin nhắn tới pane thật nhưng màn hình
        // đứng im ở đoạn lịch sử đang đọc: người dùng bấm Gửi và không thấy
        // gì xảy ra cả.
        if (historyOffset > 0) showHistory(0);
        // Kiểm độ dài ở lại đây: MAX_PASTE_BYTES là trần cho giao thức với
        // trình duyệt, không phải giới hạn của cái pane.
        const bytes = Buffer.byteLength(msg.text, 'utf8');
        if (bytes > MAX_PASTE_BYTES) {
          sendCtl({ type: 'ccrc_loi', seq: msg.seq, message: `tin nhắn quá dài (${bytes} byte)` });
          return;
        }
        // `seq` do trang tự đánh số, chỉ để nó ghép lời xác nhận với đúng
        // lượt gửi. Không kiểm kiểu ở đây: nó không bao giờ chạm tới tmux,
        // chỉ đi ngược lại nguyên vẹn trong ccrc_ack/ccrc_loi.
        conn.paste(msg.text, {
          onAck: () => sendCtl({ type: 'ccrc_ack', seq: msg.seq }),
          onErr: (m) => sendCtl({ type: 'ccrc_loi', seq: msg.seq, message: m }),
        });
      }
      return;
    }
    if (msg.type === 'ccrc_click') {
      // The buttons worth pressing are drawn BY the application inside the
      // terminal — "Jump to bottom", a menu entry — so a tap on the phone has
      // to reach it as a real click at a real cell.
      //
      // Bounded like every other client-supplied number here: it comes from a
      // browser and ends up on a tmux command line.
      const { col, row } = msg;
      if (!Number.isInteger(col) || !Number.isInteger(row)) return;
      if (col < 1 || col > MAX_TERM_COLS) return;
      if (row < 1 || row > MAX_TERM_ROWS) return;

      const clickMode = paneChung.mouseMode();
      // No mouse reporting means the application has no idea what these bytes
      // are, and they would be TYPED INTO IT. There is no useful fallback for
      // a click — unlike scrolling, which has tmux's own history — so this
      // does nothing at all rather than something wrong.
      if (!clickMode.mouse) return;

      conn.mouse(Buffer.from(clickBytes({ sgr: clickMode.sgr, col, row }), 'binary'));
      return;
    }
    if (msg.type === 'ccrc_scroll') {
      // The browser has no scrollback of its own, and neither has a
      // control-mode client: `tmux -C` forwards a pane's OUTPUT, never the
      // screen tmux draws. Driving tmux's copy mode was tried first and
      // measured to do exactly the wrong thing — the desktop view scrolled
      // and the browser's did not. So the history is fetched here and shipped
      // as a rendered screen.
      //
      // The count comes from a browser and lands in a tmux command line:
      // integer, non-zero, bounded, exactly like cols/rows below.
      const n = msg.lines;
      if (!Number.isInteger(n) || n === 0) return;
      if (n > MAX_SCROLL_LINES || n < -MAX_SCROLL_LINES) return;

      // Which mechanism, decided by what is actually running in the pane —
      // not assumed. Measured on the live session: Claude Code sits on the
      // ALTERNATE SCREEN with mouse reporting on, which means tmux holds no
      // scrollback for it at all (`history_size` was 2) and the conversation
      // the user wants to read back is inside the application. Paging tmux's
      // history there returns nothing useful — it is what put a screenful of
      // repeated prompt lines on the phone.
      const mode = paneChung.mouseMode();
      if (mode.mouse) {
        // The app is listening for the wheel, so give it one. Sent as INPUT,
        // exactly like a keystroke, because that is what it is.
        //
        // Positive `lines` means "back into history", which is a wheel UP.
        const bytes = wheelBytes({
          up: n > 0,
          sgr: mode.sgr,
          // Middle of the client's own grid: an app that scrolls the region
          // under the pointer needs the pointer to be over its content.
          col: Math.max(1, Math.round(clientCols / 2)),
          row: Math.max(1, Math.round(clientRows / 2)),
          notches: notchesForLines(n),
        });
        conn.mouse(Buffer.from(bytes, 'binary'));
        return;
      }

      // No mouse reporting: a plain shell, which knows nothing about wheels —
      // sending the bytes would TYPE them into the user's command line. Here
      // tmux's own history is the real thing, so page that.
      showHistory(historyOffset + n);
      return;
    }
    if (msg.type !== 'ccrc_resize') return; // unknown type — drop
    const { cols, rows } = msg;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < MIN_TERM_COLS || cols > MAX_TERM_COLS) return;
    if (rows < MIN_TERM_ROWS || rows > MAX_TERM_ROWS) return;
    // Remembered for showHistory(): a history screen has to be exactly as
    // tall as the browser's grid.
    clientRows = rows;
    clientCols = cols;
    conn.resize(cols, rows);
  }

  // Guards against running twice: onGone can call this directly (the
  // "grouped session merely disappeared" branch above), and ws.close()
  // called from there also fires the 'close' event bound below — both
  // paths must be safe to hit for the same connection without double-
  // closing conn.
  let cleanedUp = false;
  const close = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // conn.close() kills this connection's tmux -C child and, if it was the
    // last one still using the grouped session, tears that session down too
    // (Task 2, pane-source.js) — this never touches PANE or the user's real
    // session, only the grouped one this connection was borrowing.
    conn.close();
    liveConns.delete(conn);
    // A client that has gone is not watching. Dropped here rather than left
    // behind, or the map would keep a dead socket's `true` forever and
    // notifications would never resume.
    viewers.delete(ws);
    watchingChanged();
  };
  ws.on('close', close);
  ws.on('error', close);
});

// --- lifecycle -------------------------------------------------------------

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // PORT is the port this run REQUESTED, which since Task 1 is 0 by default
    // — "give me any free port", an address the OS only ever hands out
    // unoccupied, so this branch is effectively unreachable in production.
    // The old text substituted the requested port straight into the sentence
    // as though it were always a real number, which with the default read
    // "Cổng 0 đã có tiến trình khác dùng": untrue on its face and useless to
    // anyone who did manage to hit it. requestedPortLabel (src/env.js) names
    // the requested port when there is one to name and describes it
    // otherwise; the CLI's own start-timeout hint uses the same function so
    // the two never describe this differently.
    console.error(`[term] Không chiếm được ${requestedPortLabel(PORT)} — có thể một daemon` +
      ' khác đang chạy cho phiên này. Dừng tiến trình cũ rồi thử lại.');
  } else {
    console.error(`[term] Lỗi server: ${err.message}`);
  }
  process.exit(1);
});

// Bind to the machine's own Tailscale IP, never 0.0.0.0: binding all
// interfaces would open this port on every network the machine joins — café
// wifi, hotel wifi, the office LAN — turning a private terminal into a public
// one. CCRC_TERM_BIND exists only so tests can pin this to 127.0.0.1 without
// touching real Tailscale state; production always derives it from
// checkPrereqs().
let bindAddr = process.env.CCRC_TERM_BIND || '';
// Only known once checkPrereqs() has run (production path, below) — kept
// separate from `bindAddr` so the listen callback can tell "we need to build
// a URL from this IP" apart from "CCRC_TERM_BIND overrode bindAddr and any
// URL is CCRC_TERM_URL's business, not ours".
let hostIp = null;
// The host THIS daemon accepts an attach token for (spec §13, C3) — set once
// the real bound port is known, in the `listen` callback below. Never left as
// "unknown, so skip the check": even the CCRC_TERM_BIND test-override branch
// (hostIp stays null) must produce a real value here, or a token's `h` field
// would have nothing meaningful to be compared against.
let ownHost = '';
if (!bindAddr) {
  const pre = checkPrereqs();
  if (!pre.ok) {
    console.error(`[term] ${pre.message}`);
    process.exit(1);
  }
  bindAddr = pre.ip;
  hostIp = pre.ip;
}

server.listen(PORT, bindAddr, async () => {
  // The port actually bound. With CCRC_TERM_PORT unset (production default,
  // now 0) this is whatever the OS handed out — it is NOT knowable before
  // `listen`'s callback fires, which is exactly why the URL below must be
  // built here and not earlier: building it against the requested PORT
  // (0, when nothing overrides it) would have reported a URL containing
  // literal port 0 to the hub, and every phone that tapped it would fail.
  const actualPort = server.address().port;
  if (hostIp) {
    // This is the URL the hub hands back to the PWA for a top-level browser
    // navigation (spec §4.3b/§4.4), not a WebSocket endpoint — term.js derives
    // its own ws(s):// attach URL from `location` once the page has loaded
    // (see public/term.js), so this never needs to be that. Task 9 originally
    // set this to `ws://${pre.ip}:${PORT}/attach` on the theory that it would
    // become a WebSocket connection; no browser can top-level-navigate to a
    // `ws:` URL, which would silently break the "tap card, land on terminal"
    // flow this whole design bends around (see task-6-report.md, web-terminal-ui).
    publicUrl = `http://${hostIp}:${actualPort}/`;
  }
  // Derived from `publicUrl` itself, NOT from `process.env.CCRC_TERM_URL`
  // directly — the two can disagree. `publicUrl` is what actually got
  // reported to the hub a few lines up: `hostIp` truthy (the real production
  // path, no CCRC_TERM_BIND) unconditionally OVERWRITES publicUrl even when
  // CCRC_TERM_URL was set, discarding the env var. Reading the env var here
  // instead would then check tokens against a host the daemon never actually
  // advertised — every attach 401s, forever, with a config that used to be
  // merely ignored. Deriving from `publicUrl` means this always compares
  // against the exact string the phone parsed, and — as a side effect — it
  // is immune to the ":80 drops from a URL's `.host`" hazard that reading
  // `${bindAddr}:${actualPort}` unconditionally would not have been.
  //
  // publicUrl stays blank only in the CCRC_TERM_BIND-without-CCRC_TERM_URL
  // test path (nothing useful to print — see above), where the fallback is
  // this daemon's own bind address + actual port: still a real host, never
  // "unknown, so skip the check".
  ownHost = publicUrl ? new URL(publicUrl).host : `${bindAddr}:${actualPort}`;

  // ORDER MATTERS HERE, and `nghe` goes last.
  //
  // `/remote on` (ccrc-term-cli.js) waits for `[term] nghe` to know the daemon
  // is up, and at that moment reads `tên` and `URL` straight out of the same
  // stdout buffer — it does not wait again. Print `nghe` first and stdout can
  // hand the CLI that line on its own, before the other two exist; the CLI then
  // reports "✓ Remote ĐÃ BẬT" with no session name and no URL, leaving the user
  // with no idea which card to look for on their phone. It showed up as the
  // `on không kèm tên` test failing on a busy machine, with exactly that output.
  //
  // So `nghe` is the last line, which makes it mean what the CLI already
  // assumed it meant: everything worth printing has been printed.
  //
  // Announced by the daemon, not worked out by the CLI: the daemon is what
  // decides the name, including the fall back to a random id when the user
  // gave nothing usable. The CLI parses this line so the two can never
  // disagree about what the phone is going to show.
  console.log(`[term] tên: ${SESSION_NAME}`);
  // Printed only when we actually have one (CCRC_TERM_BIND test overrides with
  // no CCRC_TERM_URL leave publicUrl blank on purpose, and there is nothing
  // useful to print then) — which is also why the CLI cannot simply wait for
  // this line instead: it is not always coming.
  if (publicUrl) console.log(`[term] URL: ${publicUrl}`);
  console.log(`[term] nghe ${bindAddr}:${actualPort}, pane ${PANE}`);

  // Nothing reports to the hub before this point — the very first heartbeat
  // fires from right here, after publicUrl has been built from the real
  // bound port, so the hub never sees a URL with the wrong (or absent) port.
  const beat = () => {
    // MỘT NHỊP TIM SAU KHI ĐÃ ĐÓNG LÀ MỘT LỜI NÓI DỐI — và tệ hơn, nó DỰNG LẠI
    // đúng những thứ `shutdown()` vừa dọn: `writeSession` ngay dưới đây ghi lại
    // file sổ phiên, và `/api/terminal/register` ghi lại phiên vào hub.
    //
    // Đường đi: `shutdown()` đóng mọi client bằng mã 4001 rồi gọi
    // `removeSession()` NGAY trong cùng một lượt. Sự kiện `close` của WebSocket
    // thì tới ở lượt SAU, và handler của nó gọi `watchingChanged()` →
    // `sendHeartbeat()` → chính hàm này. Ai xong trước là do
    // `tellHub('/unregister')` quyết: hub trả lời nhanh thì `process.exit(0)`
    // chạy trước cả cuộc đua; hub trả lời chậm thì nhịp tim kịp ghi lại.
    //
    // ĐÂY LÀ LỖI CỦA CẢ HAI NỀN TẢNG, không riêng Windows. Bản đầu của chốt này
    // ghi rằng "trên macOS cuộc đua chưa từng thắng" — SAI, và cái sai đến từ
    // một phép đo hỏng: hub giả trong bộ đo trả lời trong 0ms. Đo lại với hub
    // trả lời chậm (mọi hub thật, qua Tailscale hay internet, đều trên 5ms):
    //
    //   độ trễ `/unregister`   chưa có chốt                       có chốt
    //   0ms                    sạch (cái phép đo hỏng nhìn thấy)  sạch
    //   5ms                    file sổ phiên còn lại              sạch
    //   30ms                   còn lại + hub nhận `register`      sạch
    //                          SAU `unregister`
    //
    // Nghĩa là trước chốt này, `/remote off` trên macOS cũng để lại file sổ
    // phiên, và với RTT ≥30ms còn đăng ký lại một phiên đã chết lên hub — điện
    // thoại tiếp tục thấy nó trong danh sách tới giây thứ 60. Bài canh:
    // test/off-nhip-tim-hoi-sinh.test.js (macOS, giữ `/unregister` lại 500ms) và
    // test/win-off-tu-te.test.js (Windows).
    //
    // Chốt đặt Ở ĐÂY chứ không ở `watchingChanged()`: đây là chỗ DUY NHẤT ghi sổ
    // phiên và gọi hub, nên mọi người gọi — vòng 20 giây, đổi trạng thái người
    // xem, và bất cứ ai thêm sau này — đều được che, thay vì phải nhớ tự che.
    if (shuttingDown) return Promise.resolve();
    // The registry is refreshed on every heartbeat, not written once: the
    // pane's directory changes whenever the user `cd`s, and the hook matches
    // on that directory. Written before the hub call so a notification
    // arriving in the same instant already has something to find.
    // paneCwd() never throws and returns '' for a dead pane, which simply
    // means no notification will match — never a wrong match.
    // `pane` (with the tmux server it belongs to) is what the hook matches on:
    // the directory below is the PANE's, while a notification carries Claude
    // Code's current one, and those two drift apart the moment a Bash call
    // does a `cd`. The socket comes from tmux itself, not from this process's
    // $TMUX — see paneSocket() for why the daemon's own environment is the
    // wrong place to ask.
    writeSession({
      sessionId: SESSION_ID, cwd: paneChung.cwd(), name: SESSION_NAME,
      pane: PANE, tmux: paneChung.socket(), pid: process.pid,
    }, { home: ccrcHome() });
    return tellHub('/api/terminal/register', {
      sessionId: SESSION_ID,
      machine: cfg ? cfg.machine : os.hostname(),
      url: publicUrl,
      // `secret` đã bỏ: hub không còn ký vé nữa, nên nó không còn lý do gì
      // để biết bí mật của máy này. Đó chính là thay đổi mà cả thiết kế này
      // xoay quanh.
      // The session's name — an opaque id unless the user named it. Fixed at
      // startup, unlike the directory basename this replaced, which was
      // recomputed here every beat.
      label: SESSION_NAME,
      // Whether anyone currently has this terminal on screen. The hub uses
      // it to hold back a push for a session the user is already watching.
      viewing: someoneIsWatching(),
    });
  };
  sendHeartbeat = beat;
  lastWatching = someoneIsWatching();
  await beat();
  setInterval(beat, HEARTBEAT_MS).unref();
});

// The pane dying is the primary close signal — see spec §4.2.
setInterval(() => {
  if (!paneChung.alive()) shutdown('pane tmux đã chết');
}, PANE_CHECK_MS);

process.on('SIGTERM', () => shutdown('nhận SIGTERM'));
process.on('SIGINT', () => shutdown('nhận SIGINT'));

// Đường dừng thứ hai, CHỈ trên Windows — và nó tồn tại vì hai handler ngay
// trên KHÔNG chạy ở đó. `process.kill(pid, 'SIGTERM')` trên Windows là
// `TerminateProcess`; đo được ngày 2026-08-18 trên máy Windows thật, `/remote
// off` bỏ qua trọn vẹn `shutdown()`: hub không nhận `unregister`, file sổ phiên
// còn nguyên, và trình duyệt đang mở nhận mã 1006 (đứt bất thường, y hệt rớt
// wifi) thay vì 4001, nên nó quay vòng "đang nối lại…" cho một phiên đã chết.
// Cùng kịch bản trên macOS: 4001 sau 113ms, unregister có, sổ phiên đã xoá.
//
// `theoDoiFileDung` trả `null` trên mọi nền tảng khác — không watcher, không
// timer, không một dòng nào chạy thêm — nên đường macOS/Linux ở trên còn
// nguyên vẹn từng byte. Luật ấy là tham số `platform`, và có bài test chạy
// được trên chính máy macOS (test/win-stop-file.test.js).
theoDoiFileDung({
  paneId: PANE,
  home: ccrcHome(),
  // Van chỉ dành cho bộ test, để chứng minh lưới cuối (TerminateProcess) vẫn
  // còn nguyên khi cơ chế cờ hỏng — xem src/win-stop-file.js.
  tat: process.env.CCRC_TERM_NO_STOP_WATCH === '1',
  // Đi thẳng vào `shutdown()`, không sao chép lại một phần việc của nó: đó là
  // toàn bộ lý do chọn hướng file cờ thay vì để CLI tự dọn — chỉ tiến trình
  // này mới gửi được mã 4001 cho những trình duyệt nó đang phục vụ.
  khiThay: () => shutdown('nhận cờ dừng từ /remote off'),
});
