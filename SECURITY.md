# Security

This is a personal project published in the hope it is useful. It has had **no external
security audit**. The design decisions below were made deliberately and are documented so
you can judge whether they fit your situation — not because they are the only reasonable
choices.

## Reporting a vulnerability

Open a GitHub issue for anything that is already public knowledge or purely theoretical.
For something exploitable against a running deployment, use GitHub's **private
vulnerability reporting** (Security → Report a vulnerability) rather than a public issue.

There is no bounty and no SLA. Expect a reply within a couple of weeks.

## What this system actually is

Three trust boundaries, and it is worth being precise about which is which:

| Boundary | What crosses it | What protects it |
|---|---|---|
| Dev machine → hub | Notification title/body (≤200 chars each), session metadata | Bearer token over HTTPS |
| Hub → phone | The same notification, as Web Push | VAPID + the push service's own transport |
| Phone → dev machine | **Terminal I/O — full shell access to one tmux pane** | Tailscale network membership **plus** an ECDSA P-256 token the phone signs itself |

The third row is the one that matters. Everything else leaks at most "somebody needs to
look at Claude on machine X". That row is a shell.

## Design decisions that look like flaws and are not

### The terminal daemon serves plain HTTP, not HTTPS

This is intentional and it is the decision most likely to be reported as a bug.

Getting a TLS certificate for a Tailscale machine name means `tailscale cert`, which means
the machine name is written into the public **Certificate Transparency log — permanently
and irrevocably**. The hard requirement for this project was that nothing about the
machines leaks outside the tailnet, and a CT entry is the opposite of that: it is a public,
append-only, un-deletable record that a machine with that name exists.

What plain HTTP costs here, and why it was judged acceptable:

- The daemon binds **only** the machine's Tailscale address (`100.64.0.0/10`), never
  `0.0.0.0`. The port is not exposed to the LAN, the wifi, or the internet.
- Traffic inside a tailnet is already end-to-end encrypted by WireGuard. The `http://`
  is inside that tunnel, not on the open network.
- The consequence that was accepted: the terminal page cannot be embedded in the HTTPS
  PWA (mixed content), so it is a separate page the PWA links out to.

The threat this does **not** cover: another device already inside your tailnet. That is why
each person is expected to run their own tailnet with only their own two devices, and why
"remove the phone from Tailscale" is documented as the real revocation.

Full reasoning: `docs/superpowers/specs/2026-07-27-web-terminal-design.md` (decision D2c).

### Pairing confirmation is one-directional, not "does this number match?"

The dev machine prints no number of its own. The phone shows a 6-digit code, you read it
**on your phone**, and you type it into the dev machine. The dev machine compares it
against the number it computed independently and only then trusts the device.

The reason a two-screen "Matches / Doesn't match" flow was rejected: the hub decides which
pairing request it serves to whom. A malicious hub can honestly relay an attacker's phone
without altering a single string — both screens then show genuinely matching numbers,
because they are genuinely talking to each other. The comparison has to be made by the
party that is not the hub, on input the user read off their own device.

Full reasoning: `docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md` §12.2.

### The hub is treated as untrusted for terminal access

The hub holds no key that opens any session. Attach tokens are signed on the phone with a
non-extractable WebCrypto key; the dev machine verifies with the public key it learned at
pairing time. An earlier version signed with an HMAC secret the hub held, which meant the
hub operator could mint a ticket into anybody's session — that is gone.

Tokens are bound to the session id **and** the daemon's own host, so a modified hub cannot
return its own tailnet address as the session URL and have the phone sign something usable
against the real daemon (`term/src/ticket.js`).

## Known weaknesses, not yet addressed

Stated plainly so you can decide, rather than discovering them yourself:

- **An authenticated caller can spam `/notify`.** Nothing throttles a request that carries a
  valid token, and the notification history is an in-RAM list per user. Bounded per entry
  (200 characters for title and body, 50 entries per user) and lost on restart, so this
  costs memory and phone battery rather than anything durable.
- **No CORS policy, no security headers.** No `helmet`, no CSP on the hub's own pages.
- **Push subscriptions and the user list are stored unencrypted on disk** — see below.
- **Push subscriptions and the user list are stored unencrypted on disk** in
  `CCRC_DATA_DIR`. Anyone with that directory can send push to those devices and read every
  token. Back it up accordingly — or rather, do not back it up carelessly.
- **Notification history is per-user in RAM with no persistence and no size limit per
  field beyond 200 chars.** A hub restart loses it, by design.

## Addressed since this file was first written

Kept here rather than deleted: if you read an older copy, this says what changed.

- **Token probing is throttled.** Requests that fail to authenticate are counted per client
  IP — 20 per 10 minutes, then `429` with `Retry-After`. Only failures count, so a valid
  token is never delayed or blocked. That asymmetry is deliberate: behind a proxy with
  `CCRC_TRUST_PROXY` unset every request appears to come from one address, and blocking the
  address itself would let a stranger with bad tokens lock a whole team out of their own hub.
- **The admin token is compared with `crypto.timingSafeEqual`**, length checked first (it
  throws on a length mismatch, and turning wrong-length tokens into `500`s would trade an
  unexploitable timing leak for an availability bug). User tokens remain a `Map` lookup,
  which is a hash lookup rather than a character-by-character compare.
- **`CCRC_BIND` now reaches `app.listen()`.** It previously steered only the compose
  `ports:` publish, so running the hub under Node directly ignored it: an operator could set
  `127.0.0.1`, believe the port was closed, and still serve the whole LAN. The default is
  still `0.0.0.0`, which is required inside a container — the tunnel reaches the hub over
  the compose network, so binding loopback there would cut the origin off entirely.

## What is deliberately out of scope

- **A compromised dev machine.** If the machine running Claude Code is compromised, the
  attacker already has the shell this project exposes. Nothing here helps.
- **A compromised phone.** The signing key is non-extractable, but a phone under someone
  else's control can simply use it. Revoke by removing the device from Tailscale.
- **Other devices in your tailnet.** The design assumes your tailnet contains only your own
  devices. Sharing a tailnet is explicitly documented against.
- **Traffic analysis.** That a notification was sent, and when, is visible to the push
  service. Content is limited to 200-character title/body, and directory names are never
  sent — but the timing is not hidden.

## What never leaves the dev machine

Worth stating, since it is a design goal rather than an accident:

- Directory names and tmux session names. Sessions appear under a random id unless you name
  one yourself with `/remote on <label>`.
- Claude Code transcripts. The hub stores none, and the terminal daemon relays shell I/O
  directly to the phone without the hub seeing a byte.
- Any private key. The phone's signing key is generated on the phone and non-extractable;
  `~/.ccrc/devices.json` holds public keys only.
