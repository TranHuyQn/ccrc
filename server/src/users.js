// Turning data/users.json into the token -> user map the hub authenticates
// against.
//
// Extracted from index.js so the one rule that matters here can be tested at
// unit grain: `admin` is a RESERVED NAME.
//
// Why it is reserved. CCRC_TOKEN logs in as a user literally called 'admin'
// (see resolveUser in index.js), and every piece of per-user state on the hub
// is keyed by that NAME, not by the token that produced it:
//
//     pushSubs[user.name]        which phones get the notifications
//     history                    the last 50 notifications
//     terminals.byUser           open sessions
//
// So a second entry named 'admin' is not a duplicate label, it is a second
// key to the same box. Whoever held it could list the hub owner's terminal
// sessions, read their notification history, and delete their push devices.
// (Task 15 review: this used to also read "and mint a ticket for any of them
// — a signed shell credential for the hub owner's machine". That described
// v1, where the hub held an HMAC secret per terminal session and signed
// tickets with it. v2 (2026-07-29) replaced that: the phone signs its own
// ECDSA attach token with a private key that never leaves it, and the hub
// keeps no secret capable of minting one — see term/src/ticket.js. The
// 'admin'-name collision above is still real for the three capabilities that
// remain; ticket-minting is not one of them anymore.)
// `./deploy.sh adduser admin` was enough to create it: that command only
// checks for duplicates among the entries already in the file.
//
// The entry is DROPPED rather than renamed. Renaming would silently hand
// someone an account that is not the one they were promised; dropping means
// their token stops working, they say so, and the hub owner fixes the file.
// Loudly, on stderr, so the reason is in the log rather than a mystery.

export const HUB_USER_NAME = 'admin';

/**
 * Hình dạng hợp lệ của một `slack_user_id`: một chữ HOA rồi tới chữ HOA và
 * số. Slack cấp `U…`/`W…` (người) và `B…` (bot), 8–12 ký tự — luật ở đây rộng
 * hơn thế một chút để không đỏ vì Slack nới độ dài, nhưng vẫn là DANH SÁCH
 * CHO PHÉP chứ không phải danh sách cấm.
 *
 * Vì sao phải là allowlist. `name` là khoá của `pushSubs`, của lịch sử thông
 * báo và của danh sách phiên. `pushSubs` là một object thường, nên một `name`
 * bằng `__proto__` làm `pushSubs[user.name] || []` trả về Object.prototype —
 * truthy, nhưng không có `.some()` — và mọi lần đăng ký push của người đó nổ
 * thành 500. `constructor`, `toString` cũng cùng họ. Chặn từng cái một là
 * cuộc chơi đuổi bắt; mô tả hình dạng ĐÚNG thì cả họ đó rơi ra ngoài một
 * lượt, và `admin` (chữ thường) cũng vậy.
 *
 * Chỉ tới được khi token-slayer bị chiếm hoặc có bug — hub tin danh tính nó
 * trả về. Nhưng "phải tin" và "phải nhận bất cứ chuỗi nào" là hai chuyện.
 */
const SLACK_USER_ID_RE = /^[A-Z][A-Z0-9]{1,31}$/;

/** @param {unknown} v */
export function isValidSlackUserId(v) {
  return typeof v === 'string' && SLACK_USER_ID_RE.test(v);
}

/**
 * @param {unknown} parsed  the already-JSON.parse'd contents of users.json
 * @param {string} hubToken CCRC_TOKEN — an entry reusing it is dropped too
 * @returns {{users: Map<string, {name: string, displayName: string, admin: boolean}>, rejected: Array<{name: string, why: string}>}}
 *   `users` maps token -> user. `rejected` is what was thrown out and why, so
 *   the caller can say it out loud instead of failing silently.
 */
export function parseUsers(parsed, hubToken) {
  const users = new Map();
  const rejected = [];
  if (!Array.isArray(parsed)) return { users, rejected };

  for (const u of parsed) {
    if (!u || typeof u !== 'object' || !u.name || !u.token) continue;
    const name = String(u.name);
    if (name === HUB_USER_NAME) {
      rejected.push({ name, why: `'${HUB_USER_NAME}' là tên dành riêng cho token của hub` });
      continue;
    }
    if (u.token === hubToken) {
      rejected.push({ name, why: 'token trùng CCRC_TOKEN của hub' });
      continue;
    }
    // displayName mặc định bằng name: users.json trên hub đang chạy toàn entry
    // cũ do `deploy.sh adduser` tạo, và chúng không có trường này. Không cần
    // migration file — chỉ cần đọc được cả hai hình.
    const displayName = typeof u.displayName === 'string' && u.displayName ? u.displayName : name;
    users.set(u.token, { name, displayName, admin: !!u.admin });
  }
  return { users, rejected };
}

/**
 * Thêm hoặc cập nhật entry theo slack_user_id. THUẦN: nhận mảng, trả mảng mới,
 * không đụng đĩa — index.js là nơi duy nhất đọc/ghi file.
 *
 * Token cũ được GIỮ NGUYÊN khi entry đã tồn tại. Đăng nhập lại trên điện thoại
 * mà đổi token là đá văng máy dev của chính người đó, và họ sẽ không hiểu vì
 * sao thông báo im bặt.
 *
 * @param {Array} list      nội dung users.json đã JSON.parse
 * @param {string} slackUserId  khoá bất biến (`name`)
 * @param {string} displayName  handle Slack, chỉ để hiển thị
 * @param {string} newToken     token dùng khi phải tạo mới
 * @returns {{list: Array, token: string, created: boolean}}
 */
export function upsertBySlackId(list, slackUserId, displayName, newToken) {
  const arr = Array.isArray(list) ? [...list] : [];
  const i = arr.findIndex((u) => u && typeof u === 'object' && u.name === slackUserId);

  if (i >= 0) {
    const token = arr[i].token;
    arr[i] = { ...arr[i], name: slackUserId, displayName, token };
    return { list: arr, token, created: false };
  }

  arr.push({ name: slackUserId, displayName, token: newToken });
  return { list: arr, token: newToken, created: true };
}

/**
 * Xoá một entry theo `name` HOẶC `displayName`.
 *
 * Khớp nhiều thì KHÔNG xoá gì và trả về danh sách khớp: lệnh này chạy lúc có
 * sự cố nhân sự, và xoá nhầm người là mất push subs, lịch sử và phiên đang mở
 * của họ. Thà bắt gõ lại bằng `name` còn hơn đoán.
 *
 * @param {Array} list
 * @param {string} needle
 * @returns {{list: Array, removed: object|null, matches: Array}}
 */
export function removeUser(list, needle) {
  const arr = Array.isArray(list) ? list : [];
  const matches = arr.filter(
    (u) => u && typeof u === 'object' && (u.name === needle || u.displayName === needle),
  );

  if (matches.length !== 1) return { list: arr, removed: null, matches };

  const removed = matches[0];
  return { list: arr.filter((u) => u !== removed), removed, matches };
}
