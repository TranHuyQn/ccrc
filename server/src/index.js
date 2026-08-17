// CC Remote Control — Hub server
// Receives a small notification from the dev-machine hook and pushes it to
// the user's phone via Web Push. Nothing here is remote-controlled or
// mirrored: no sessions, no transcripts, no WebSocket relay.

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { createTerminalSessions } from './terminal-sessions.js';
import { createNotificationHistory } from './notification-history.js';
import { deviceId, labelFromUserAgent, listDevices } from './push-devices.js';
import { isSessionUrlAllowed } from './session-url.js';
import { listenAddr } from './listen-addr.js';
import { PROTOCOL_VERSION } from '../../shared/protocol-version.js';
import { dauVanTay } from '../../shared/bundle-fingerprint.js';
import { HUB_USER_NAME, isValidSlackUserId, parseUsers, upsertBySlackId } from './users.js';
import { createPairings } from './pairing.js';
import { createIdentity } from './identity.js';
import { createOneShotStore } from './oauth-state.js';
import { createDeviceCodes, DEVICE_TTL_MS, MAX_PENDING } from './device-code.js';
import { createRateLimit } from './rate-limit.js';
import { DEFAULT_VAPID_SUBJECT, isVapidSubjectUnusableForApple } from './vapid-subject.js';
import { formatPushErrorBody } from './push-error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CCRC_PORT || 8720);
const TOKEN = process.env.CCRC_TOKEN; // hub token; also logs in as the "admin" user
const DATA_DIR = process.env.CCRC_DATA_DIR || path.join(__dirname, '..', 'data');
// Có reverse proxy / tunnel đáng tin đứng trước hub hay không. MẶC ĐỊNH TẮT —
// lý do đầy đủ nằm ở khối chú thích chỗ `app.set('trust proxy', 1)` bên dưới.
//
// ALLOWLIST, không phải denylist. docker-compose truyền biến này xuống dưới
// dạng chuỗi, nên `CCRC_TRUST_PROXY=0` tới đây là chuỗi "0" — truthy trong JS,
// tức một phép `!!` sẽ hiểu ngược ý người viết. Nhưng liệt kê "những chữ nghĩa
// là không" thì vẫn hỏng ÂM THẦM theo hướng nguy hiểm: `none`, `disabled`,
// `n`, `null` đều rơi ra ngoài danh sách và thành BẬT. Với một cờ mà bật nhầm
// = thủng chốt không ai thấy, chỉ có bốn chữ dưới đây là "có"; mọi thứ khác,
// kể cả chữ đánh máy sai, là KHÔNG.
const TRUST_PROXY = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.CCRC_TRUST_PROXY ?? '').trim().toLowerCase());

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

// --- Đăng nhập bằng Slack, danh tính lấy qua token-slayer -------------------
//
// Hai URL tách bạch và KHÔNG dùng lẫn: PUBLIC là thứ dán vào redirect cho
// trình duyệt đi, INTERNAL là thứ hub gọi trong docker network. Thiếu một
// trong hai thì tính năng không tồn tại — fail-closed, chứ không phải gọi
// vào một địa chỉ đoán được.
const TS_PUBLIC_URL = process.env.CCRC_TS_PUBLIC_URL || '';
const TS_INTERNAL_URL = process.env.CCRC_TS_INTERNAL_URL || '';
const slackLoginEnabled = !!(TS_PUBLIC_URL && TS_INTERNAL_URL);

const identity = createIdentity({ internalUrl: TS_INTERNAL_URL });
const oauthStates = createOneShotStore({ ttlMs: 5 * 60_000 });
const loginClaims = createOneShotStore({ ttlMs: 60_000 });
const deviceCodes = createDeviceCodes();

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Ghi entry cho một danh tính Slack rồi nạp lại ngay. Trả token của người đó,
 * hoặc null nếu không ghi được.
 *
 * Ghi qua temp + rename như devices.js: một users.json cụt vì mất điện giữa
 * chừng là cả team mất quyền cùng lúc. Gọi loadUsers() luôn thay vì chờ
 * watchFile 5 giây — người dùng đang đứng nhìn màn hình.
 *
 * BẤT BIẾN, đọc trước khi sửa hàm này: đoạn đọc–sửa–ghi dưới đây an toàn
 * trước hai lần đăng nhập song song CHỈ VÌ trong nó KHÔNG CÓ MỘT `await` NÀO.
 * Node chạy một luồng, nên cả đoạn là một lượt không ai chen vào được: không
 * có khe nào để một request khác đọc bản cũ rồi ghi đè lên bản mình vừa ghi.
 * Đổi sang `fs.promises` (hoặc chèn bất cứ `await` nào vào giữa) làm mất
 * đúng tính chất đó, âm thầm: hai người đăng nhập cùng lúc thì một người mất
 * entry, và triệu chứng là "token vừa cấp xong đã không dùng được" — không
 * có gì trong log chỉ về đây. `rename` nguyên tử chỉ cứu được file khỏi cụt,
 * nó KHÔNG cứu được lost update.
 *
 * (Đây cũng là lý do tên file tạm mang pid: `deploy.sh` là một tiến trình
 * KHÁC, và giữa hai tiến trình thì lập luận một-luồng ở trên không còn đúng.
 * Tên tạm riêng không xoá được cuộc đua đọc–sửa–ghi giữa hai tiến trình —
 * không có gì ở tầng này xoá được — nhưng nó bỏ đi mối nguy thứ hai: hai bên
 * ghi đè lên nhau NGAY TRONG file tạm, đẻ ra một lần rename ra nội dung lai
 * của cả hai.)
 */
function saveSlackUser(slackUserId, displayName) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { list = []; }
  if (!Array.isArray(list)) list = [];

  const { list: next, token } = upsertBySlackId(list, slackUserId, displayName, genToken());
  const tmp = `${USERS_FILE}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    // To và đủ để chẩn đoán. Người dùng chỉ thấy một trang lỗi 500, nên cái
    // thật sự xảy ra — đĩa đầy, quyền sai, mount read-only — chỉ còn tồn tại
    // ở dòng này. Một `e.message` trần ("EACCES: permission denied") không
    // nói file nào.
    console.error(`[hub] KHÔNG ghi được ${USERS_FILE} (qua tạm ${tmp}): `
      + `${e.code || 'lỗi'} — ${e.message}. Đăng nhập của "${displayName}" (${slackUserId}) BỊ HUỶ, `
      + 'users.json giữ nguyên bản cũ.', e);
    // Dọn file tạm nếu nó đã kịp ra đời: rename mới là bước hỏng thì cái tạm
    // còn nằm đó, và mỗi lần đăng nhập hỏng lại để lại một xác nữa.
    try { fs.unlinkSync(tmp); } catch { /* chưa kịp tạo — không có gì để dọn */ }
    return null;
  }
  loadUsers();
  return token;
}

// So sánh hai bí mật mà thời gian chạy không phụ thuộc nội dung.
//
// `timingSafeEqual` NÉM khi hai buffer khác độ dài, nên độ dài phải được lọc
// trước — và lọc trước cũng đúng về mặt an toàn: độ dài token không phải bí
// mật cần giấu, chỉ có nội dung mới là.
//
// Thành thật về giá trị: rò rỉ thời gian qua mạng ở đây không thực tế khai
// thác, đúng như SECURITY.md vẫn nói. Vá vì nó rẻ và vì "không phòng gì cả" là
// một câu khó chịu để phải viết trong tài liệu, không phải vì đã có ai bẻ được.
function bangNhauAnToan(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function resolveUser(token) {
  // Cả hai nhánh phải cùng hình dạng: callers (vd. /api/device/poll) đọc
  // displayName off either — thiếu nó ở nhánh admin thì grant đi ra ngoài
  // thiếu tên hiển thị, dù token vẫn đúng.
  if (bangNhauAnToan(token, TOKEN)) return { name: HUB_USER_NAME, displayName: HUB_USER_NAME, admin: true };
  // Token của người dùng tra bằng Map: đây là tra băm, không phải so từng ký
  // tự, nên nó không có cái dốc thời gian mà so sánh chuỗi có.
  return usersByToken.get(token) || null;
}

// ---------------------------------------------------------------------------
// Web Push. VAPID keys are generated on first run and kept in the data dir.
// Subscriptions are stored per user so notifications stay private.

const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const VAPID_SUBJECT = process.env.CCRC_VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
}
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);
// Kiểm toán 2026-08-12: hub từng khởi động câm lặng với subject mặc định
// (hoặc bất kỳ giá trị nào trỏ về máy mình), và Apple từ chối nó với 403
// BadJwtToken cho MỌI push — thấy được đúng một lần, lúc người dùng iPhone
// đầu tiên không bao giờ nhận được thông báo, còn /notify vẫn báo "ok". Đây
// KHÔNG phải lỗi chặn khởi động: hub chỉ phục vụ Android vẫn chạy tốt với
// giá trị này, refuse-to-start sẽ là một regression cho họ. Chỉ cảnh báo.
if (isVapidSubjectUnusableForApple(VAPID_SUBJECT)) {
  console.error(
    `[hub] CẢNH BÁO: CCRC_VAPID_SUBJECT đang là "${VAPID_SUBJECT}" — Apple từ chối giá\n`
    + '[hub] trị này khi gửi push (403 BadJwtToken). Người dùng iPhone sẽ KHÔNG nhận\n'
    + '[hub] được thông báo nào, kể cả khi /notify vẫn báo { ok: true, pushed: true }.\n'
    + '[hub] Android (FCM) và Firefox không bị ảnh hưởng, vì hai dịch vụ đó không\n'
    + '[hub] kiểm subject chặt như Apple.\n'
    + '[hub] Sửa: đặt CCRC_VAPID_SUBJECT thành "https://<domain-hub-của-bạn>" hoặc\n'
    + '[hub] một "mailto:" liên hệ thật rồi khởi động lại hub.',
  );
}

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
      // `err.body` is the push service's own response text — for a rejection
      // like Apple's 403 BadJwtToken it is the ONLY place the actual reason
      // lives. Logging just the status code used to throw it away, which is
      // what made a mis-set CCRC_VAPID_SUBJECT take 40 minutes to diagnose
      // instead of one grep (kiểm toán 2026-08-12).
      else console.error('[hub] push failed:', err.statusCode || err.message, '-', formatPushErrorBody(err.body));
    }
  }));
  if (dead.length) {
    pushSubs[userName] = subs.filter((s) => !dead.includes(s.endpoint));
    savePushSubs();
  }
}

// ---------------------------------------------------------------------------
// Notification history — logic đầy đủ (TTL 24h + cap 50) nằm trong
// notification-history.js, cùng khuôn mẫu với createTerminalSessions().
const notificationHistory = createNotificationHistory();

// Bearer token -> user, or null. Every authenticated route goes through here.
function userFromRequest(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? resolveUser(m[1].trim()) : null;
}

// Chặn dò token: đếm theo IP, và CHỈ đếm những lượt xác thực HỎNG.
//
// Vì sao đếm ở nhánh hỏng thay vì chặn cả IP: một hub sau Cloudflare mà người
// vận hành quên đặt CCRC_TRUST_PROXY thấy mọi request đến từ cùng một địa chỉ,
// nên "khoá IP" ở đó nghĩa là một kẻ lạ gõ token bậy vài chục lần khoá được cả
// team ra khỏi hub của chính họ — biến một lỗ hổng không ai khai thác thành một
// nút tắt dịch vụ ai cũng bấm được. Token đúng đi thẳng qua, không bao giờ bị
// tính, nên người dùng thật không cảm thấy chốt này tồn tại; còn kẻ dò token
// thì mọi request của nó đều là lượt hỏng, nên chốt luôn đóng vào mặt nó.
//
// 20 lượt/10 phút: rộng hơn hẳn mọi cách gõ nhầm hay retry của PWA, và vẫn cắt
// tốc độ dò xuống mức vô nghĩa trước một token 24 byte ngẫu nhiên.
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = 10 * 60_000;
const authFailLimit = createRateLimit({
  limit: AUTH_FAIL_LIMIT, windowMs: AUTH_FAIL_WINDOW_MS,
});

function requireUser(req, res) {
  const user = userFromRequest(req);
  if (user) return user;

  // `req.ip` là địa chỉ socket trừ khi người vận hành bật CCRC_TRUST_PROXY —
  // cùng khoá, cùng lý do như /api/device/start ngay dưới.
  const ip = req.ip || '';
  const gate = authFailLimit.hit(ip);
  if (!gate.ok) {
    if (gate.firstTrip) {
      console.error(`[hub] token sai từ IP ${ip}: vượt ${AUTH_FAIL_LIMIT} lượt/`
        + `${Math.round(AUTH_FAIL_WINDOW_MS / 60_000)} phút — chặn tới hết cửa sổ`);
    }
    res.setHeader('retry-after', String(gate.retryIn));
    res.status(429).json({ ok: false, error: 'Quá nhiều lần thử token sai từ địa chỉ này' });
    return null;
  }
  res.status(401).json({ ok: false, error: 'Token không hợp lệ' });
  return null;
}

// ---------------------------------------------------------------------------
// HTTP wiring

const terminals = createTerminalSessions();
const pairings = createPairings();

const app = express();

// `trust proxy` — MẶC ĐỊNH TẮT, chỉ bật khi người vận hành đặt
// CCRC_TRUST_PROXY=1. Thứ duy nhất đọc nó là `req.ip`, và `req.ip` là khoá
// rate-limit của /api/device/start — endpoint KHÔNG có auth.
//
// Cổng 8720 của hub tới được bằng NHIỀU đường CÙNG LÚC, không phải một:
//
//   (1) Qua proxy — Cloudflare Tunnel hoặc Caddy. Chặng cuối trước hub là
//       cloudflared/Caddy, và chính nó ghi thêm địa chỉ thật của client vào
//       cuối `X-Forwarded-For`. Client bịa header chỉ nhét thêm được vào bên
//       TRÁI phần đó.
//   (2) Thẳng vào cổng. `docker-compose.yml` publish cổng ở
//       `${CCRC_BIND:-0.0.0.0}:8720` trong MỌI profile, kể cả profile
//       cloudflare — nên trừ khi người vận hành đặt CCRC_BIND=127.0.0.1, một
//       `docker compose up` bình thường vẫn mở cổng ra LAN/tailnet (và ra
//       internet nếu router có forward). Đường này không có proxy nào.
//
// `app.set('trust proxy', 1)` nghĩa là "tin đúng một chặng gần app nhất", nên
// Express lấy PHẦN TỬ CUỐI của `X-Forwarded-For`. Trên đường (1) phần tử cuối
// do proxy ghi → đúng client, không bịa được. Trên đường (2) chặng "được tin"
// LẠI CHÍNH LÀ CLIENT → nó tự viết khoá rate-limit của mình, đổi header mỗi
// lượt là không bao giờ chạm trần:
//
//   cùng client, không XFF:      200,200,200,200,200,429,429
//   cùng client, XFF xoay vòng:  200,200,200,200,200,200,200   ← thủng
//
// Vì thế mặc định là TẮT: `req.ip` khi đó là địa chỉ socket, thứ không header
// nào sửa được, nên đường (2) an toàn kể cả khi hub bị phơi ra internet.
//
// Cái giá của việc TẮT khi thật sự CÓ proxy: mọi request đều mang địa chỉ của
// proxy, cả internet dùng chung một rổ đếm, và một người gọi nhiều làm cả team
// bị 429. Đó là lý do biến môi trường tồn tại thay vì hard-code: có proxy thì
// đặt CCRC_TRUST_PROXY=1, lúc ấy header đi qua proxy nên không bịa được.
//
// NHƯNG bật cờ mà KHÔNG đóng đường (2) thì cờ vô nghĩa: hai đường vẫn tồn tại
// song song, và kẻ tấn công cứ chọn đường thẳng để bịa header. Đóng đường (2)
// bằng cách nào thì tuỳ kiểu triển khai, và KHÔNG có cách nào hub tự làm được:
//
//   - Chạy bằng docker-compose: đặt CCRC_BIND=127.0.0.1. Đây là biến của
//     compose (nó nằm ở vế publish `ports:`), KHÔNG phải biến của hub —
//     `app.listen(PORT)` ở cuối file này không đọc nó và luôn nghe trên mọi
//     interface. Nhớ thêm: rule iptables của Docker nằm TRƯỚC ufw, nên một VPS
//     đã `ufw deny 8720` vẫn hở nếu compose còn publish ra 0.0.0.0.
//   - Chạy Node trực tiếp (deploy/ccrc-hub.service, bare-metal sau Caddy):
//     CCRC_BIND không tồn tại ở đây. Phải chặn cổng 8720 ở tường lửa của máy,
//     hoặc cho hub nghe trên loopback bằng cách khác. Không làm gì cả nghĩa là
//     cổng mở trên toàn LAN.
//
// Vì sao mặc định là TẮT chứ không phải BẬT: đặt sai theo hướng nào cũng có
// giá, nhưng chỉ MỘT hướng hỏng âm thầm. Bật nhầm (không có proxy) = chốt
// thủng, không ai thấy gì. Tắt nhầm (có proxy) = chặn quá tay, người dùng kêu
// ngay lượt thứ sáu. An toàn theo mặc định là tính chất phải có cho một thứ
// với tới được từ internet.
if (TRUST_PROXY) app.set('trust proxy', 1);

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
  notificationHistory.remember(user.name, note);
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
  // displayName, KHÔNG phải name. Khoá của mọi state trên hub là
  // `slack_user_id` (`U08K3QZ1X4M`) — đưa nó lên header PWA thì mọi người
  // đăng nhập bằng Slack đều thấy một chuỗi máy đọc thay cho tên mình, và
  // không ai đối chiếu được "mình đang đăng nhập bằng tài khoản nào".
  // parseUsers() đảm bảo displayName luôn có (mặc định bằng name cho entry cũ
  // do `deploy.sh adduser` tạo), nên đây không bao giờ là undefined.
  res.json({ user: user.displayName, pushDevices: (pushSubs[user.name] || []).length });
});

app.get('/api/notifications', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ items: notificationHistory.list(user.name) });
});

app.get('/api/vapid-key', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

// --- Đăng nhập bằng Slack ---------------------------------------------------

// Trang lỗi TĨNH, có nút bấm, KHÔNG tự redirect.
//
// token-slayer đã phải thêm một cờ RETRY_FLAG vì callback hỏng của nó tự
// redirect lại /auth/slack, và một session hỏng vĩnh viễn thì ping-pong vô
// hạn. Không lặp lại: mọi lỗi trong luồng này dừng ở đây.
function authError(res, code, msg) {
  res.status(code).type('html').send(
    '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font:16px/1.5 system-ui;background:#0f1115;color:#e6e6e6;'
    + 'margin:0;display:grid;place-items:center;height:100vh;padding:24px;text-align:center}'
    + 'a{color:#7aa2f7}</style>'
    + `<div><p>${msg}</p><p><a href="/">Quay lại đăng nhập</a></p></div>`,
  );
}

app.get('/api/auth/config', (_req, res) => res.json({ slackLogin: slackLoginEnabled }));

// --- `state` phải chứng minh callback thuộc về ĐÚNG TRÌNH DUYỆT đã bấm -----
//
// Chỉ "state còn sống và chưa dùng" thôi thì mới chỉ chứng minh CÓ MỘT lần
// đăng nhập nào đó vừa bắt đầu trên hub này — không chứng minh nó là của
// người đang mở link. Kịch bản: Mallory bấm đăng nhập, đi hết vòng Slack, rồi
// CHẶN redirect cuối trước khi trình duyệt của mình đi tới, và gửi URL
// `/auth/callback?token=…&state=…` đó cho Bob. Trình duyệt Bob đi theo, hub
// đổi token và nhận về danh tính của MALLORY, rồi app.js ghi token của Mallory
// đè lên localStorage của Bob. Điện thoại Bob từ đó đăng ký push dưới tên
// Mallory — không có màn hình nào báo gì cả.
//
// Chốt: `/auth/start` đặt một nonce ngẫu nhiên vào cookie HttpOnly VÀ vào
// payload của state (payload để trống từ đầu chính là để dành chỗ này).
// Callback đòi hai cái khớp nhau. Bob không có cookie của Mallory, nên link
// kia dừng ở trang lỗi tĩnh thay vì đăng nhập hộ người khác.
const OAUTH_COOKIE = 'ccrc_oauth';
const OAUTH_COOKIE_MAX_AGE_MS = 5 * 60_000;   // đúng bằng TTL của state

// Đọc cookie bằng regex nhỏ, cùng cách header `Bearer` được đọc ở
// userFromRequest() — không thêm phụ thuộc npm cho một dòng phân tách bằng
// "; ". Nonce là base64url nên không có ký tự nào cần giải mã.
function oauthNonceFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)ccrc_oauth=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

// Cờ `Secure` bật theo request, KHÔNG bật cứng.
//
// Hub được với tới bằng hai đường: HTTPS qua Cloudflare Tunnel, và HTTP thuần
// trên IP Tailscale trong tailnet (cố ý — xem README/docs, không dùng TLS vì
// Certificate Transparency log). `Secure` cứng nghĩa là trình duyệt trên
// đường tailnet KHÔNG LƯU cookie này, và mọi lần đăng nhập Slack qua tailnet
// chết ở trang "phiên đăng nhập không thuộc về trình duyệt này" — hỏng im
// lặng, đúng loại lỗi khó truy nhất. Đường tailnet đã được WireGuard mã hoá ở
// tầng dưới, nên thứ `Secure` bảo vệ (cookie đi qua đường trong veo) không
// phải mối lo ở đó.
//
// Vì sao KHÔNG dùng thẳng `req.secure`: `req.secure` phụ thuộc `trust proxy`,
// mà `trust proxy` giờ mặc định TẮT (xem khối chú thích ở đó). Nếu để nguyên
// `req.secure` thì một hub đang chạy sau Cloudflare Tunnel, sau khi nâng cấp
// mà chưa kịp đặt CCRC_TRUST_PROXY=1, sẽ ÂM THẦM cấp cookie mất cờ Secure
// dù trình duyệt đang ở HTTPS — một chốt bảo mật không được phép làm yếu đi
// một chốt khác như thế.
//
// Nên cờ này hỏi một câu KHÁC câu mà rate-limit hỏi: "trình duyệt đang ở
// HTTPS phải không?", và tự đọc X-Forwarded-Proto bất kể có tin proxy hay
// không. Đọc một header không tin được ở đây là an toàn vì nó chỉ THÊM được
// cờ Secure, và chỉ cho cookie của chính người gửi header: kẻ bịa
// `X-Forwarded-Proto: https` rồi nói chuyện HTTP thuần chỉ làm trình duyệt
// CỦA CHÍNH NÓ vứt cookie đi, tức tự phá đăng nhập của mình. Không có đường
// nào để nó gỡ cờ Secure khỏi cookie của người khác — trang web bên ngoài
// không đặt được header cho request của trình duyệt nạn nhân.
//
// RÀNG BUỘC NGẦM, ghi ra để nó không mất khi có người sửa chỗ khác: lập luận
// trên đứng được CHỈ VÌ hub không trả bất kỳ header CORS nào cho phép custom
// request header. Thêm một `Access-Control-Allow-Headers` rộng tay (hoặc một
// middleware cors() đặt bừa) là mở đường cho một trang lạ ép trình duyệt nạn
// nhân gửi `X-Forwarded-Proto` do nó chọn, và đoạn này hết an toàn. Ai thêm
// CORS vào hub phải quay lại đọc chỗ này trước.
//
// Lấy phần tử CUỐI khi header có nhiều chặng, cùng quy ước "chặng gần hub
// nhất" mà X-Forwarded-For dùng.
function browserIsHttps(req) {
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp !== 'string') return false;
  return xfp.split(',').pop().trim().toLowerCase() === 'https';
}

function setOauthCookie(req, res, nonce) {
  res.cookie(OAUTH_COOKIE, nonce, {
    httpOnly: true,
    secure: browserIsHttps(req),
    sameSite: 'lax',   // callback là điều hướng top-level từ token-slayer sang
    path: '/',
    maxAge: OAUTH_COOKIE_MAX_AGE_MS,
  });
}

app.get('/auth/start', (req, res) => {
  if (!slackLoginEnabled) {
    return authError(res, 503, 'Đăng nhập bằng Slack chưa được cấu hình trên hub này.');
  }
  const nonce = crypto.randomBytes(32).toString('base64url');
  const state = oauthStates.issue({ nonce });
  setOauthCookie(req, res, nonce);
  const u = new URL('/auth/slack', TS_PUBLIC_URL);
  u.searchParams.set('return', 'ccrc');
  u.searchParams.set('state', state);
  res.redirect(302, u.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (!slackLoginEnabled) {
    return authError(res, 503, 'Đăng nhập bằng Slack chưa được cấu hình trên hub này.');
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  // Tiêu huỷ state TRƯỚC khi hỏi token-slayer: một callback replay không được
  // phép tiêu tốn thêm một lượt nào nữa, kể cả một lượt thất bại.
  const statePayload = oauthStates.consume(state);
  if (statePayload === null) {
    return authError(res, 400, 'Phiên đăng nhập hết hạn hoặc đã dùng rồi.');
  }

  // Cookie phải khớp nonce nằm trong state. Xem khối chú thích ở /auth/start
  // cho kịch bản tấn công mà chốt này chặn.
  const cookieNonce = oauthNonceFromCookie(req);
  if (!cookieNonce || cookieNonce !== statePayload?.nonce) {
    // KHÔNG xoá cookie ở nhánh này. Đây đúng là nhánh mà nạn nhân đi vào khi
    // ai đó gửi cho họ một link callback của người khác, và họ rất có thể
    // đang có một lần đăng nhập của CHÍNH MÌNH dở dang — xoá cookie ở đây là
    // biến một cú tấn công bị chặn thành một cú phá luồng đăng nhập của nạn
    // nhân.
    console.error('[hub] /auth/callback: state hợp lệ nhưng cookie không khớp — '
      + 'callback không thuộc về trình duyệt đã bắt đầu đăng nhập');
    return authError(res, 400,
      'Phiên đăng nhập này không thuộc về trình duyệt đang mở. Hãy tự bấm đăng nhập lại từ đầu.');
  }
  // Khớp rồi thì cookie đã làm xong việc: dùng một lần, hệt như state.
  res.clearCookie(OAUTH_COOKIE, { path: '/' });

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const r = await identity.exchange(token, state);

  if (!r.ok) {
    if (r.reason === 'unreachable') {
      return authError(res, 503,
        'Không liên lạc được token-slayer. Token đã cài trên máy vẫn dùng bình thường — chỉ đăng nhập mới hỏng.');
    }
    if (r.status === 410) {
      return authError(res, 400, 'Link đăng nhập đã dùng rồi hoặc quá 2 phút — thử lại.');
    }
    return authError(res, 400, 'Không lấy được danh tính Slack.');
  }

  // Mọi state trên hub khoá theo TÊN, nên `name` phải có đúng hình dạng của
  // một slack_user_id chứ không phải "một chuỗi bất kỳ khác 'admin'". Xem
  // isValidSlackUserId() trong users.js: luật allowlist ở đó loại một lượt cả
  // 'admin' (chữ thường) lẫn họ khoá ma thuật của JS — `__proto__` làm
  // `pushSubs[user.name] || []` trả về Object.prototype và mọi lần đăng ký
  // push của người đó thành 500.
  if (!isValidSlackUserId(r.slackUserId)) {
    console.error(`[hub] từ chối danh tính Slack có hình dạng không hợp lệ: ${JSON.stringify(r.slackUserId)}`);
    return authError(res, 400, 'Không lấy được danh tính Slack.');
  }

  const hubToken = saveSlackUser(r.slackUserId, r.handle);
  if (!hubToken) return authError(res, 500, 'Hub không ghi được cấu hình người dùng.');

  // Token đi qua claimCode chứ không qua URL: token của hub sống mãi, mà URL
  // đi vào history trình duyệt, vào Referer và vào access log của reverse
  // proxy. claimCode sống 60 giây và dùng một lần.
  const code = loginClaims.issue({ token: hubToken, displayName: r.handle });
  res.redirect(302, `/?login=${encodeURIComponent(code)}`);
});

app.post('/api/auth/claim', express.json({ limit: '4kb' }), (req, res) => {
  const p = loginClaims.consume(req.body?.code);
  if (!p) return res.status(410).json({ ok: false, error: 'Đăng nhập hết hạn, thử lại' });
  res.json({ ok: true, token: p.token, displayName: p.displayName });
});

// --- Device-code cho máy dev ------------------------------------------------

// Không có auth, đúng bản chất: máy dev chưa có gì để xác thực. Spec §5.2 đòi
// HAI chốt cho endpoint này: trần phiên pending toàn hub (MAX_PENDING trong
// device-code.js) và rate-limit theo IP (rate-limit.js).
//
// Vì sao cần cả hai: trần pending một mình không phân biệt được 50 máy dev
// thật với một kẻ gọi 50 lần. 50 POST ẩn danh mỗi 10 phút giữ kín mọi chỗ, và
// từ đó mọi `./setup-notify.sh` rơi về hỏi token tay — mà nó rơi ÊM, vì hàm
// device_code_login() coi mọi thất bại là "hub cũ chưa có endpoint này".
//
// 5 lượt / 10 phút / IP: một người cài máy mới gọi đúng một lượt, và có gõ
// sai vài lần cũng không chạm. Cửa sổ đặt bằng DEVICE_TTL_MS để hai cái trần
// nói về cùng một quãng thời gian.
const DEVICE_START_LIMIT = 5;
const DEVICE_START_WINDOW_MS = DEVICE_TTL_MS;
const deviceStartLimit = createRateLimit({
  limit: DEVICE_START_LIMIT, windowMs: DEVICE_START_WINDOW_MS,
});

// Trần pending bị chạm cũng phải NÓI RA. Trước đây nó chỉ hiện ra dưới dạng
// mọi installer im lặng rơi về dán token tay — không có dòng nào ở đâu cho
// người vận hành lần ra. Chặn nhịp bằng mốc thời gian để một kẻ tấn công
// không viết được nhật ký hộ hub.
const PENDING_LOG_EVERY_MS = 60_000;
let lastPendingCapLogAt = -Infinity;

app.post('/api/device/start', express.json({ limit: '4kb' }), (req, res) => {
  // `req.ip` mặc định là địa chỉ socket — không header nào sửa được, nên khoá
  // này không bẻ được kể cả khi ai đó gọi thẳng vào cổng 8720. Chỉ khi người
  // vận hành đặt CCRC_TRUST_PROXY=1 (có proxy thật đứng trước) thì nó mới là
  // phần tử cuối của X-Forwarded-For, phần do proxy tự ghi. Xem khối chú thích
  // ở chỗ `if (TRUST_PROXY)` cho đầy đủ hai đường đi và cái giá của mỗi lựa chọn.
  const ip = req.ip || '';
  const gate = deviceStartLimit.hit(ip);
  if (!gate.ok) {
    if (gate.firstTrip) {
      console.error(`[hub] /api/device/start: IP ${ip} vượt ${DEVICE_START_LIMIT} lượt/`
        + `${Math.round(DEVICE_START_WINDOW_MS / 60_000)} phút — chặn tới hết cửa sổ`);
    }
    res.setHeader('retry-after', String(gate.retryIn));
    return res.status(429).json({
      ok: false, error: 'Quá nhiều yêu cầu từ địa chỉ này — thử lại sau vài phút',
    });
  }

  const r = deviceCodes.start();
  if (!r.ok) {
    const t = Date.now();
    if (t - lastPendingCapLogAt >= PENDING_LOG_EVERY_MS) {
      lastPendingCapLogAt = t;
      console.error(`[hub] /api/device/start: chạm trần ${MAX_PENDING} phiên chờ duyệt trên toàn hub `
        + '— mọi máy dev đang phải dán token tay');
    }
    return res.status(429).json({ ok: false, error: r.reason });
  }
  res.json({ ok: true, deviceCode: r.deviceCode, userCode: r.userCode, ttl: r.ttl, interval: r.interval });
});

app.post('/api/device/poll', express.json({ limit: '4kb' }), (req, res) => {
  const r = deviceCodes.poll(req.body?.deviceCode);
  if (r.status === 'gone') return res.status(410).json({ ok: false, error: 'Mã đã hết hạn' });
  if (r.status === 'throttled') return res.status(429).json({ ok: false, retryIn: r.retryIn });
  if (r.status === 'pending') return res.status(428).json({ ok: false, error: 'Chưa được duyệt' });
  res.json({ ok: true, token: r.grant.token, displayName: r.grant.displayName });
});

app.post('/api/device/approve', express.json({ limit: '4kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  // Token của chính người duyệt là thứ được trao đi — đó là ý nghĩa của việc
  // duyệt: "cấp quyền của TÔI cho cái máy đang cầm mã này". Đọc lại header ở
  // đây vì resolveUser() cố ý không trả token ra ngoài; parse này phải khớp
  // đúng cách userFromRequest() parse, không được lệch nhau.
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/, '').trim();
  const r = deviceCodes.approve(user.name, req.body?.userCode, {
    name: user.name, displayName: user.displayName, token: bearer,
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason, remaining: r.remaining });
  res.json({ ok: true });
});

// Trang duyệt máy dev. Cùng index.html với PWA — app.js nhìn location.pathname
// để quyết định hiện thẻ nào, nên không có bundle thứ hai phải bảo trì.
app.get('/link', (_req, res) => {
  // sendFile() không đi qua express.static nên không tự nhận setHeaders() ở
  // trên — phải set tay cùng "no-cache" đó, kẻo /link rơi vào đúng cái bẫy
  // Cloudflare 4h mà setHeaders() sinh ra để tránh.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

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
// Dấu vân tay của gói cài đang phục vụ, tính MỘT LẦN lúc khởi động.
//
// Trong image, cây nguồn tạo ra gói cài đã bị `rm -rf bundle` xoá đi (xem
// docker/Dockerfile.hub), nên dấu vân tay được tính lúc BUILD, ngay trước khi
// xoá, và ghi ra file cạnh gói cài. Chạy thẳng từ cây nguồn (lúc phát triển,
// lúc chạy test) thì không có file đó — tính trực tiếp từ cây, ra cùng một
// chuỗi vì cùng danh sách file.
const BUNDLE_FP_FILE = path.join(__dirname, '..', '..', 'ccrc-bundle-fingerprint.txt');
const BUNDLE_FINGERPRINT = (() => {
  try {
    const s = fs.readFileSync(BUNDLE_FP_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch { /* không có file — đang chạy từ cây nguồn */ }
  return dauVanTay(path.join(__dirname, '..', '..'));
})();
// Cho MÁY DEV tự hỏi "bản tôi đang cài có phải bản mới nhất không". Nhắc trên
// điện thoại là chưa đủ: lúc ngồi trước máy mới là lúc tiện chạy install.sh,
// chứ không phải lúc đang cầm điện thoại ngoài đường.
//
// Sau token như mọi API khác — nó khai hình dạng bản dựng, và repo này vốn
// private.
app.get('/api/install/version', (req, res) => {
  if (!requireUser(req, res)) return;
  res.json({ protocolVersion: PROTOCOL_VERSION, bundleFingerprint: BUNDLE_FINGERPRINT });
});

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
  // Nhân tiện nhịp heartbeat, khai luôn phiên bản hợp đồng của gói cài mà hub
  // này đang phục vụ. Máy đã cài KHÔNG tự cập nhật (và không nên tự cập nhật —
  // hub chạy được code tuỳ ý trên máy dev là một lỗ hổng, không phải tiện ích),
  // nhưng nó cần biết là có bản mới để còn nói với người dùng. Trước
  // 2026-08-17 không có đường nào biết, nên một daemon chạy code lỗi thời suốt
  // hai ngày mà không ai nhận ra.
  res.json({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    // Đổi theo MỌI thay đổi nội dung, kể cả bản chỉ sửa lỗi — thứ mà
    // protocolVersion cố ý không làm.
    bundleFingerprint: BUNDLE_FINGERPRINT,
  });
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

const BIND = listenAddr(process.env);
app.listen(PORT, BIND, () => {
  // In ĐÚNG địa chỉ đang nghe, không in một hằng số: dòng này là thứ người vận
  // hành đọc để tin rằng cổng đã đóng, và một dòng nói "0.0.0.0" trong khi thật
  // ra đang nghe loopback (hoặc ngược lại) là cách nhanh nhất để họ tin nhầm.
  console.log(`[hub] CC Remote Control hub listening on http://${BIND}:${PORT}`);
});
