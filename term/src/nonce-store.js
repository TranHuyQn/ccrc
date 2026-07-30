// Remember which tokens have already been redeemed. Kept in memory on
// purpose: this store only ever needs to give one-token-one-use FOR THE
// LIFETIME OF A SINGLE DAEMON PROCESS, so there is nothing here worth
// persisting across a restart.
//
// This used to also be the reason a restart invalidated every outstanding
// ticket — true under v1, where a fresh HMAC secret was generated per
// process and a restart made every previously-signed ticket unverifiable
// regardless of this store. Under token v2 (term/src/ticket.js) that is NO
// LONGER what makes a restart safe: a v2 token's signature is checked
// against a public key that lives in devices.json, on disk, outside this
// process's lifetime — so a still-unexpired, unused token verifies exactly
// the same after a restart as before one. What actually invalidates
// outstanding tokens across a restart is `/remote on` minting a FRESH random
// sessionId every time (term/bin/ccrc-term-cli.js) and the daemon rejecting
// any token whose `sid` does not match (`wrong_session`, term/src/ticket.js)
// — never this module. Losing this in-memory store on restart means an
// already-used token could, in principle, be replayed once more within its
// remaining TTL if a sessionId were ever reused across a restart; see the
// "Final fix wave, item 2 (v1)" comment in term/test/daemon.test.js (around
// the deleted secret-rotation test) for the fuller writeup of this
// trade-off.

export function createNonceStore({ ttlMs = 60_000 } = {}) {
  /** @type {Map<string, number>} nonce -> expiry */
  const seen = new Map();

  function sweep(now) {
    for (const [n, exp] of seen) if (now > exp) seen.delete(n);
  }

  return {
    /**
     * @param {string} nonce
     * @param {number} [now]
     * @param {number} [expiresAt] absolute time to forget this nonce at. Lets
     *   a caller tie retention to something meaningful — e.g. a ticket's own
     *   exp — rather than always falling back to this store's fixed ttlMs,
     *   which has no relationship to any particular caller's lifetime.
     * @returns {boolean} true if this nonce had not been used before
     */
    use(nonce, now = Date.now(), expiresAt = now + ttlMs) {
      sweep(now);
      if (seen.has(nonce)) return false;
      seen.set(nonce, expiresAt);
      return true;
    },
    size() { return seen.size; },
  };
}
