// Single source of truth for the relationship between how long a ticket is
// MINTED for and how long the daemon is willing to HONOUR one
// (ccrc-term.js's MAX_TICKET_LIFETIME_MS clamp).
//
// The minting side used to be the hub (`server/src/terminal-sessions.js`'s
// TICKET_TTL_MS, 60s) — Task 10 deleted that route along with the hub's
// ability to sign anything. The phone mints now: `signAttachToken` in
// `server/public/app.js` hardcodes the same 60s. The property this file
// exists for did not move when the minter did.
//
// The clamp must have headroom over the mint lifetime. With both pinned to
// the exact same number, a mint lifetime raised by even one millisecond
// would make every ticket (exp - iat, measured at mint time) exceed the
// clamp and get refused outright — a one-line change on the minting side
// silently 401ing every phone. See term/test/ticket-ttl-relation.test.js,
// which checks this relationship holds and fails if the two are ever
// brought back into exact lockstep.
export const DEFAULT_MAX_TICKET_LIFETIME_MS = 75_000;
