// Which `url` the hub is willing to remember for a terminal session.
//
// This is not cosmetic validation. The PWA opens a terminal by navigating to
// whatever string the hub hands back:
//
//     location.href = session.url + '#t=' + ticket        (public/app.js)
//
// so whoever controls that string controls where the phone goes. A
// `javascript:` URL runs inside the PWA's own origin and reads
// localStorage.ccrc_token; an ordinary URL on some other host serves a page
// that looks exactly like the terminal and asks for the token back. Neither
// needs a browser bug — both are just "we navigated where we were told".
//
// The rule below is not an invented restriction, it is a description of what
// the daemon actually produces. `publicUrl` is built in exactly one place
// (term/bin/ccrc-term.js) as `http://${hostIp}:${port}/`, and `hostIp` comes
// from checkPrereqs(), which picks the IPv4 Tailscale address and nothing
// else (term/src/tailscale.js — IPv6 is deliberately skipped there because
// binding an IPv6 literal would need bracket handling everywhere). So a real
// session URL is always http on a 100.64.0.0/10 address, and anything else
// arriving here did not come from a daemon.

// Tailscale hands every node an address in the CGNAT block 100.64.0.0/10 —
// second octet 64..127. That block is not routable off the tailnet, which is
// the property the whole design leans on: a ticket is only useful to someone
// who can already reach the machine.
const TAILNET_FIRST_OCTET = 100;
const TAILNET_SECOND_OCTET_MIN = 64;
const TAILNET_SECOND_OCTET_MAX = 127;

// `hostname` off a parsed URL, never a raw string. WHATWG's parser normalises
// every IPv4 spelling — octal (`0x64.64.0.1`), integer (`1681007361`) — into
// dotted decimal before we see it, so matching decimal here cannot be walked
// around by writing the same address a different way. A name like
// `100.64.0.1.evil.com` stays a name and fails this outright.
function isTailnetIPv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const nums = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    nums.push(n);
  }
  return nums[0] === TAILNET_FIRST_OCTET
    && nums[1] >= TAILNET_SECOND_OCTET_MIN
    && nums[1] <= TAILNET_SECOND_OCTET_MAX;
}

/**
 * True only for a URL a real daemon could have reported: http(s) on a
 * Tailscale IPv4 address, with no embedded credentials.
 *
 * Total by design — every malformed input is `false`, never a throw. This
 * runs on a request body, and a URL nobody can parse is simply not a URL a
 * daemon sent.
 */
export function isSessionUrlAllowed(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // `http://100.64.0.1@evil.com/` parses with hostname `evil.com` and the
  // tailnet address as a USERNAME — the check below already rejects it. This
  // refuses credentials outright anyway: a daemon never sends any, and a URL
  // shaped to be misread by a human reading it off a screen has no business
  // being stored.
  if (u.username || u.password) return false;
  return isTailnetIPv4(u.hostname);
}
