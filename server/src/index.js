// CC Remote Control — Hub server
// Receives a small notification from the dev-machine hook and pushes it to
// the user's phone via Web Push. Nothing here is remote-controlled or
// mirrored: no sessions, no transcripts, no WebSocket relay.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { createTerminalSessions } from './terminal-sessions.js';
import { deviceId, labelFromUserAgent, listDevices } from './push-devices.js';
import { isSessionUrlAllowed } from './session-url.js';
import { HUB_USER_NAME, parseUsers } from './users.js';
import { createPairings } from './pairing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CCRC_PORT || 8720);
const TOKEN = process.env.CCRC_TOKEN; // hub token; also logs in as the "admin" user
const DATA_DIR = process.env.CCRC_DATA_DIR || path.join(__dirname, '..', 'data');

// Tạo TRƯỚC mọi thứ đọc/ghi bên dưới. Mặc định là `server/data/`, thư mục nằm
// trong .gitignore vì nó giữ khoá VAPID và token của mọi người — và vì git
// không track thư mục rỗng, một bản clone sạch KHÔNG có nó. Không có dòng này
// thì hub chết ngay lúc khởi động, trước khi phục vụ được request nào:
//
//   Error: ENOENT ... open '.../server/data/vapid.json'
//
// Chỉ hiện ra với người vừa clone repo và chạy hub bằng Node trực tiếp; máy
// nào từng chạy hub một lần rồi thì đã có sẵn thư mục, và Docker cũng không
// dính vì Dockerfile.hub tự `mkdir -p /data`. Nghĩa là đúng những người mới
// nhất gặp nó, còn người phát triển thì không bao giờ.
// `recursive: true` cũng làm hàm này thành no-op khi thư mục đã có.
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!TOKEN) {
  console.error('CCRC_TOKEN is required. Generate one, e.g.: openssl rand -hex 24');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Users (per-user tokens). CCRC_TOKEN is the hub token and also acts as the
// "admin" user. Team members get personal tokens in
// data/users.json: [{"name": "huy", "token": "..."}]

const USERS_FILE = path.join(DATA_DIR, 'users.json');
/** @type {Map<string, {name: string, admin: boolean}>} token -> user */
let usersByToken = new Map();

function loadUsers() {
  try {
    const { users, rejected } = parseUsers(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')), TOKEN);
    usersByToken = users;
    console.log(`[hub] loaded ${usersByToken.size} user(s) from users.json`);
    // Said out loud, every reload. A dropped entry means somebody's token
    // stopped working, and the one thing worse than that is it happening
    // without a line anywhere saying why.
    for (const r of rejected) {
      console.error(`[hub] BỎ QUA user "${r.name}" trong users.json: ${r.why}`);
    }
  } catch {
    usersByToken = new Map();
  }
}
loadUsers();
fs.watchFile(USERS_FILE, { interval: 5000 }, loadUsers);

function resolveUser(token) {
  if (token === TOKEN) return { name: HUB_USER_NAME, admin: true };
  return usersByToken.get(token) || null;
}

// ---------------------------------------------------------------------------
// Web Push. VAPID keys are generated on first run and kept in the data dir.
// Subscriptions are stored per user so notifications stay private.

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const VAPID_SUBJECT = process.env.CCRC_VAPID_SUBJECT || 'mailto:admin@localhost';

let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
}
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

/** @type {Record<string, Array<any>>} userName -> push subscriptions */
let pushSubs = {};
try { pushSubs = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch {}

function savePushSubs() {
  fs.writeFile(PUSH_SUBS_FILE, JSON.stringify(pushSubs, null, 2), () => {});
}

async function notifyUser(userName, payload) {
  const subs = pushSubs[userName];
  if (!subs || !subs.length) return;
  const dead = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      else console.error('[hub] push failed:', err.statusCode || err.message);
    }
  }));
  if (dead.length) {
    pushSubs[userName] = subs.filter((s) => !dead.includes(s.endpoint));
    savePushSubs();
  }
}

// ---------------------------------------------------------------------------
// Notification history. Kept in memory only: it exists so the phone can glance
// back at what it missed, not as a record. A hub restart losing it is fine.
const HISTORY_MAX = 50;
/** @type {Map<string, Array<any>>} userName -> notifications, newest first */
const history = new Map();

function remember(userName, note) {
  const list = history.get(userName) || [];
  list.unshift({ ...note, at: Date.now() });
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  history.set(userName, list);
}

// Bearer token -> user, or null. Every authenticated route goes through here.
function userFromRequest(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? resolveUser(m[1].trim()) : null;
}

function requireUser(req, res) {
  const user = userFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'Token không hợp lệ' }); return null; }
  return user;
}

// ---------------------------------------------------------------------------
// HTTP wiring

const terminals = createTerminalSessions();
const pairings = createPairings();

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    // Express's default here is "public, max-age=0", which is weak/ambiguous
    // enough that behind Cloudflare Tunnel it gets replaced by Cloudflare's
    // own default Browser Cache TTL (4h), making deploys of app.js/
    // activity.js/style.css invisible to already-loaded browsers for hours.
    // Be explicit instead so the origin's intent can't be second-guessed.
    if (filePath.startsWith(path.join(__dirname, '..', 'public', 'icons') + path.sep)) {
      // Icons are content-stable; if the artwork ever changes, the filename
      // would too. Safe to cache for a long time.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Everything else — app.js/activity.js/style.css/index.html, and also
      // manifest.webmanifest and any file added later. "no-cache" does NOT
      // mean "don't cache", it means "revalidate before reuse". Combined with
      // Express's built-in ETag support this yields a cheap 304 Not Modified
      // on every load while still guaranteeing a new deploy is picked up on
      // the very next request. This arm is a catch-all on purpose: silence is
      // the exact condition that let Cloudflare apply its own 4h Browser
      // Cache TTL, so no asset may fall through without a header.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/notify', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const n = req.body;
  // The hook is the only legitimate caller and it always sends this shape, but
  // the endpoint is reachable by anything holding a token, so validate.
  if (!n || typeof n !== 'object' || Array.isArray(n) || typeof n.title !== 'string' || typeof n.body !== 'string') {
    return res.status(400).json({ ok: false, error: 'Nội dung không hợp lệ' });
  }
  const note = {
    type: String(n.type || ''),
    title: n.title.slice(0, 200),
    body: n.body.slice(0, 200),
    tag: String(n.tag || 'ccrc'),
    // Thứ cho PWA biết thông báo này thuộc thẻ terminal nào — chính là dữ liệu
    // dựng nên chấm "chưa đọc" trên danh sách phiên. Hook gửi nó từ trước
    // (hook/src/notify-payload.js) và ngay dưới đây hub đã dùng nó để nén push
    // cho phiên đang được xem; trước bản này nó bị vứt đi đúng ở dòng này, nên
    // lịch sử có nội dung thông báo mà không có cách nào nối về phiên.
    //
    // Vắng mặt hẳn khi thông báo không thuộc phiên nào (không chạy /remote cho
    // thư mục đó) — trường thiếu, KHÔNG phải chuỗi rỗng, để phía PWA không
    // phải phân biệt hai loại "không có".
    //
    // Cắt 200 ký tự cho đồng bộ với title/body ngay trên: /notify mở cho bất
    // cứ ai cầm một token hợp lệ, và đây là một mảng nằm trong RAM tới 50 mục.
    ...(typeof n.sessionId === 'string' && n.sessionId
      ? { sessionId: n.sessionId.slice(0, 200) }
      : {}),
  };
  // Always recorded, even when the push is held back below: "Gần đây" is the
  // record of what happened, and dropping entries from it would mean the one
  // notification the user missed while looking away is also the one they can
  // never go back and find.
  remember(user.name, note);
  // The user is already looking at this session's terminal on their phone —
  // buzzing them about it is noise. `sessionId` only arrives when a terminal
  // daemon is registered for the directory Claude is running in (the hook
  // looks it up locally), so the common case skips this entirely.
  const watching = typeof n.sessionId === 'string' && terminals.isViewing(user.name, n.sessionId);
  if (!watching) notifyUser(user.name, note);
  res.json({ ok: true, pushed: !watching });
});

app.get('/api/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ user: user.name, pushDevices: (pushSubs[user.name] || []).length });
});

app.get('/api/notifications', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ items: history.get(user.name) || [] });
});

app.get('/api/vapid-key', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

// The dev-machine half of the repo, for the one-command installer.
//
// Behind a token on purpose. `public/install.sh` is world-readable and holds no
// secrets; so does this tarball — the source is MIT and public. The token is
// here for a duller reason: an open tarball endpoint is free bandwidth for
// anyone who guesses the URL, and this hub is somebody's home server behind a
// domestic connection. Serving the bundle from the hub at all (rather than
// pointing at a code host) is what lets a dev machine install with neither git
// nor an account anywhere, and guarantees it gets the version this hub runs.
//
// Built into the image (docker/Dockerfile.hub), so a container with no bundle
// says so plainly rather than 404ing like a mistyped path.
const BUNDLE_FILE = path.join(__dirname, '..', '..', 'ccrc-bundle.tar.gz');
app.get('/api/install/bundle.tar.gz', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!fs.existsSync(BUNDLE_FILE)) {
    return res.status(503).json({ ok: false, error: 'Hub chưa có gói cài — build lại image' });
  }
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(BUNDLE_FILE);
});

app.post('/api/push/subscribe', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ ok: false });
  const list = pushSubs[user.name] || [];
  if (!list.some((s) => s.endpoint === sub.endpoint)) {
    // Recorded so the device list can say something more useful than a count.
    // The label is DERIVED from the user agent and the raw string is dropped:
    // a full UA is a fingerprint, and "iPhone · Safari" is all this needs to
    // be. Both fields are optional — entries stored before this exist without
    // them and are shown as unknown rather than guessed at.
    const label = labelFromUserAgent(req.headers && req.headers['user-agent']);
    list.push({ ...sub, addedAt: Date.now(), ...(label ? { label } : {}) });
  }
  pushSubs[user.name] = list;
  savePushSubs();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ ok: false });
  // Scoped to this user's own list: a token must never be able to silence
  // somebody else's phone by guessing or replaying their endpoint. Removing
  // something already gone is a success, so pressing the button twice — or
  // after the hub pruned a dead endpoint — is quiet rather than an error.
  const list = (pushSubs[user.name] || []).filter((s) => s.endpoint !== endpoint);
  pushSubs[user.name] = list;
  savePushSubs();
  res.json({ ok: true, pushDevices: list.length });
});

// The device list. POST rather than GET because the browser sends its OWN
// endpoint so the hub can mark which row is the phone doing the asking —
// there is no other way to tell, and putting an endpoint in a query string
// would write a push capability into logs.
app.post('/api/push/devices', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const current = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : null;
  res.json({ devices: listDevices(pushSubs[user.name], current) });
});

// Removing a device by the id the list handed out. Scoped to this user's own
// subscriptions, like unsubscribe: a token must never silence somebody else's
// phone. Deleting something already gone is a success — pressing twice, or
// deleting an entry the hub pruned in between, is quiet rather than an error.
app.post('/api/push/devices/delete', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const id = req.body && req.body.id;
  if (typeof id !== 'string' || !id) return res.status(400).json({ ok: false });
  const list = (pushSubs[user.name] || []).filter((s) => deviceId(s.endpoint) !== id);
  pushSubs[user.name] = list;
  savePushSubs();
  res.json({ ok: true, pushDevices: list.length });
});

// "Remove every device except this one." The reason it exists: a
// subscription carries nothing identifying, so four entries from four
// reinstalls of the same phone are indistinguishable — one by one, the user
// cannot tell which to keep. `keep` is the caller's own endpoint, so the
// worst this can do to somebody else is nothing at all.
app.post('/api/push/devices/keep-only', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const keep = req.body && req.body.endpoint;
  if (typeof keep !== 'string' || !keep) return res.status(400).json({ ok: false });
  const list = (pushSubs[user.name] || []).filter((s) => s.endpoint === keep);
  // Refuse to leave the user with nothing: an endpoint that is not in their
  // own list would wipe every device and register none.
  if (!list.length) return res.status(409).json({ ok: false, error: 'thiết bị này chưa đăng ký' });
  pushSubs[user.name] = list;
  savePushSubs();
  res.json({ ok: true, pushDevices: list.length });
});

app.post('/api/terminal/register', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)
      || typeof b.sessionId !== 'string' || !b.sessionId
      || typeof b.machine !== 'string' || !b.machine
      || typeof b.url !== 'string' || !b.url
      // Not merely "a string": the PWA NAVIGATES to this (see
      // src/session-url.js for what that lets an arbitrary string do). Only a
      // URL a real daemon could have reported is stored.
      || !isSessionUrlAllowed(b.url)
      // label is optional (an older daemon may not send one) but must be a
      // string when present — never silently coerced.
      || (b.label !== undefined && typeof b.label !== 'string')) {
    return res.status(400).json({ ok: false, error: 'Thiếu thông tin phiên' });
  }
  terminals.register(user.name, b);
  res.json({ ok: true });
});

app.post('/api/terminal/unregister', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const sessionId = req.body && req.body.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ ok: false });
  terminals.unregister(user.name, sessionId);
  res.json({ ok: true });
});

app.get('/api/terminal', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ sessions: terminals.list(user.name) });
});

// ---------------------------------------------------------------------------
// Ghép cặp thiết bị.
//
// Hub ở đây là người đưa thư MÙ: nó chuyển mấy chuỗi qua lại và không hiểu gì
// về chúng — không tính SAS, không kiểm cam kết, không biết cam kết mở ra cái
// gì. Nhưng "không hiểu mật mã" không có nghĩa "không làm hại được gì": hub
// vẫn CHỌN nó đang phục vụ pairId nào cho ai — nó có thể chuyển hướng cả cuộc
// ghép sang điện thoại của kẻ tấn công một cách trung thực, không tráo chuỗi
// nào cả, và mọi kiểm tra ở tầng này vẫn qua (spec §12.2, C2). Thứ chặn được
// đó không phải "hai màn hình lệch số" (chúng không lệch trong cuộc tấn công
// này) mà là: máy dev là bên quyết định, qua `/remote pair xac-nhan <số>` gõ
// tay từ chính điện thoại người dùng — hub không tham gia bước so đó, chỉ
// chuyển tiếp. Xem
// docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md §5.2 (nguyên
// uỷ) và §12.2/§12.3 (bản đã sửa).

app.post('/api/pair/start', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body;
  // Nhãn DẪN XUẤT từ User-Agent, không nhận từ thân request — cùng cách hub
  // đã làm cho thiết bị nhận thông báo, và cùng lý do: một User-Agent đầy đủ
  // là một dấu vân tay, còn "iPhone · Safari" là tất cả những gì cần.
  // Người gửi tự đặt nhãn thì nhãn thành thứ bịa được cho người khác đọc.
  const label = labelFromUserAgent(req.headers && req.headers['user-agent']);
  const r = pairings.start(user.name, {
    pubKey: b && b.pubKey, commit: b && b.commit, label,
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true, pairId: r.pairId });
});

app.get('/api/pair/pending', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ pairs: pairings.pending(user.name) });
});

app.post('/api/pair/challenge', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const r = pairings.challenge(user.name, b.pairId, b.nonceMachine);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

app.post('/api/pair/reveal', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const r = pairings.reveal(user.name, b.pairId, b.noncePhone);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

app.post('/api/pair/finish', express.json({ limit: '16kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  // Chỉ đúng `true` là đồng ý. Một thân request dị dạng phải nghĩa là HUỶ,
  // không phải là ghép — mặc định ở đây phải nghiêng về phía không mở cửa.
  const r = pairings.finish(user.name, b.pairId, b.ok === true);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason });
  res.json({ ok: true });
});

// Đặt SAU /api/pair/pending, nếu không `:pairId` sẽ nuốt mất chuỗi "pending".
app.get('/api/pair/:pairId', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = pairings.get(user.name, req.params.pairId);
  if (!p) return res.status(404).json({ ok: false, error: 'không có yêu cầu ghép cặp nào như vậy' });
  res.json(p);
});

// Malformed JSON bodies (e.g. `{bad`) reach express.json's error handler
// rather than the route — turn that into a 4xx instead of letting Express's
// default handler decide, and never let it become an unhandled throw that
// could take the whole long-running process down.
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'JSON không hợp lệ' });
  }
  console.error('[hub] request error:', err);
  res.status(400).json({ ok: false, error: 'Yêu cầu không hợp lệ' });
});

app.listen(PORT, () => {
  console.log(`[hub] CC Remote Control hub listening on http://0.0.0.0:${PORT}`);
});
