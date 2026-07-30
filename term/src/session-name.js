// What the phone is allowed to see instead of a directory name.
//
// The label used to be the pane's directory basename. On a phone's lock
// screen and in a shared-screenshot that is a leak: it names the project, the
// client, sometimes the company. So the default is now an opaque id, and a
// meaningful name only ever appears because the user typed it themselves
// (`/remote on <tên>`).

import { randomInt as cryptoRandomInt } from 'node:crypto';

// No `i l o 0 1` — an id is read off a phone screen and typed back into a
// terminal, and those five are the pairs people confuse. 31^4 ≈ 923k, which
// is far more than enough to tell apart the handful of sessions one person
// runs at once; this is a label, not a secret, and it is never used for
// authentication.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RANDOM_LEN = 4;

export const MAX_NAME_LEN = 24;

// `randomInt` is injected so a test can make the output deterministic without
// stubbing global crypto.
export function randomSessionName(randomInt) {
  // crypto.randomInt is uniform over the range; Math.random would be adequate
  // for a label, but there is no reason to reach for the weaker one.
  const pick = randomInt || cryptoRandomInt;
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) out += ALPHABET[pick(ALPHABET.length)];
  return out;
}

// Accepts what a user may type after `/remote on`. Returns the cleaned name,
// or null when there is nothing usable — callers fall back to a random id
// rather than refusing to start, because failing to open a terminal over a
// bad label would be a wildly disproportionate response.
//
// The charset is deliberately narrow. This string is rendered on the web page
// and travels through the hub, and while both render it with textContent (never
// innerHTML), a label is not the place to find out whether every consumer got
// that right. Letters, digits, space, dash, dot and underscore cover every
// name a person actually wants.
export function cleanSessionName(raw) {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (!/^[\p{L}\p{N} ._-]+$/u.test(collapsed)) return null;
  return collapsed.slice(0, MAX_NAME_LEN);
}

// The one place that decides what a session is called: an explicit name if the
// user gave a usable one, otherwise a fresh random id.
export function resolveSessionName(raw, randomInt) {
  return cleanSessionName(raw) || randomSessionName(randomInt);
}
