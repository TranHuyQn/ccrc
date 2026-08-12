// Apple's push service checks the VAPID JWT `sub` claim far more strictly
// than Google/Mozilla: it answers a push sent under an unroutable contact
// with 403 `BadJwtToken`, silently and permanently. Verified live against a
// real subscription: the exact same subscription and VAPID keys got
// `403 BadJwtToken` under `mailto:admin@localhost` and `201` under the hub's
// own `https://` origin — only the subject changed. FCM and Mozilla accept
// the same default, so a hub whose users are all on Android works today with
// no configuration, which is
// why a bad subject can never be a reason for the hub to refuse to start
// (see the warning this module feeds, in server/src/index.js) — only a loud
// warning that keeps the hub running.

/** What `CCRC_VAPID_SUBJECT` falls back to when unset. Apple rejects it. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@localhost';

// Hosts nobody's push service can ever reach, or that only ever appear
// because someone copy-pasted a sample straight out of a README without
// replacing it. Not exhaustive — it cannot be, there is no registry of
// "domains that were placeholders" — just the ones actually cheap to catch.
const PLACEHOLDER_HOSTS = new Set([
  'example.com', 'example.org', 'example.net',
  'yourdomain.com', 'yourdomain.org', 'yourhub.com',
  'test.com', 'changeme.com',
]);

// `mailto:` is not a URL scheme the WHATWG `URL` parser breaks into a
// hostname — `new URL('mailto:a@b').hostname` is `''`, the address ends up
// in `pathname` instead. So the address has to be pulled out by hand before
// falling back to `URL` for `https://…` subjects.
function hostOf(subject) {
  const mailto = /^mailto:[^@]*@(.+)$/i.exec(String(subject || '').trim());
  // `[::1]` is legal in an address's domain part with brackets kept; strip
  // them so it compares equal to the bare `::1` a `https://[::1]` subject
  // yields via `URL#hostname` below.
  if (mailto) return mailto[1].toLowerCase().replace(/^\[|\]$/g, '');
  try {
    return new URL(subject).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `subject` is a value Apple's push service is known — or, for the
 * placeholder-host cases, very likely — to reject as the VAPID JWT `sub`
 * claim: the hub's shipped default, anything that resolves to this machine
 * rather than a public contact, or an obvious copy-pasted sample domain.
 *
 * Total by design, same as `isSessionUrlAllowed`: a subject this function
 * cannot even parse into a host is treated as unusable too, since nothing
 * about the actual push service that will reject it is any more forgiving.
 *
 * Advisory only — Google and Mozilla accept every one of these, so this is
 * never grounds to refuse to start, only to warn loudly and keep running.
 */
export function isVapidSubjectUnusableForApple(subject) {
  const host = hostOf(subject);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return PLACEHOLDER_HOSTS.has(host);
}
