// Keys that let one browser reconnect without a fresh ticket.
//
// Unlike a ticket these are reusable, on purpose: the page that holds one has
// no personal token and cannot mint another. They live only in memory, so
// `/remote off` or a daemon restart invalidates every one of them — which is
// the property that makes reuse acceptable.

import crypto from 'node:crypto';

export function createSessionKeys() {
  /** @type {Set<string>} */
  const keys = new Set();

  return {
    issue() {
      const key = crypto.randomBytes(32).toString('base64url');
      keys.add(key);
      return key;
    },
    valid(key) {
      return typeof key === 'string' && key.length > 0 && keys.has(key);
    },
    size() { return keys.size; },
  };
}
