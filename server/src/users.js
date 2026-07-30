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
 * @param {unknown} parsed  the already-JSON.parse'd contents of users.json
 * @param {string} hubToken CCRC_TOKEN — an entry reusing it is dropped too
 * @returns {{users: Map<string, {name: string, admin: boolean}>, rejected: Array<{name: string, why: string}>}}
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
    users.set(u.token, { name, admin: !!u.admin });
  }
  return { users, rejected };
}
