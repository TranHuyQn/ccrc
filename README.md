# CC Remote Control

[![test](https://github.com/TranHuyQn/ccrc/actions/workflows/test.yml/badge.svg)](https://github.com/TranHuyQn/ccrc/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Push notifications and a phone-sized web terminal for [Claude Code](https://claude.com/claude-code),
for the moment it stops and waits for you.

Two things, both starting from that moment:

1. **Notify** — a push notification to your phone when Claude needs input or asks
   permission to run a tool, so you know when to come back.
2. **Answer from your phone** — `/remote on` inside Claude Code opens a **web terminal**
   for that exact tmux pane. The terminal page is served by the dev machine itself and is
   **reachable only inside your own Tailscale tailnet**. The phone signs its own attach
   request with a non-extractable private key generated on the phone during pairing
   (`/remote pair`); the dev machine verifies it with the public key it learned then. The
   hub holds metadata only — no key that opens anyone's session — and not one byte of
   shell traffic passes through it. **Multiple concurrent sessions** work: the PWA shows
   one card per pane. While Claude is busy running a tool, a `/remote on` you type sits in
   its input queue until that tool finishes — so run **`ccrc remote`** from any *other*
   pane or terminal instead: it lists every tmux pane running claude, you pick one by
   number, and it starts the daemon for that pane without going through Claude's input
   queue at all. A machine that installed `~/.local/bin/ccrc` earlier needs
   `./setup-notify.sh` re-run once to pick up the subcommand.

**Directory names never leave the dev machine.** Each session shows up under a random id
(`k7m2`); name it yourself if you want to recognise it: `/remote on my-label`. Push
notifications use that same label, and with no session running they show only the machine
name. The reason: this label sits on your lock screen and in every screenshot, and what
has been seen cannot be unseen.

While you have a session's terminal open on your phone, **that session sends no push** —
lock the screen or switch apps and notifications resume immediately.

Still **no** session mirroring and **no** remote chat: each daemon is bound to exactly one
pane and never opens another pane or window.

> 📖 **Where to go next**
>
> | You want to | Read |
> |---|---|
> | Run a hub for yourself or a team | [`docs/self-hosting.md`](docs/self-hosting.md) |
> | Set up a machine and phone | [`docs/user-guide.md`](docs/user-guide.md) · [🇻🇳 tiếng Việt](docs/huong-dan.md) |
> | Know what this defends against, and what it does not | [`SECURITY.md`](SECURITY.md) |
> | Run it on Windows | [`docs/windows.md`](docs/windows.md) · [🇻🇳 tiếng Việt](docs/huong-dan-windows.md) |
>
> This README covers architecture and operations. A Vietnamese version of it lives at
> [`README.vi.md`](README.vi.md).

> 🪟 **Windows works differently, and the difference is not cosmetic.** There is no tmux,
> so `ccrc` **owns** a ConPTY session rather than attaching to a pane that already exists.
> A session started with plain `claude` can never be shared — you have to open it with
> `ccrc` from the start. Scrollback also only reaches back to when the session began.
> Install with
> `$env:CCRC_HUB_URL='https://<your-hub>'; irm https://<your-hub>/install.ps1 | iex` —
> the variable is required for the same reason `install.sh` requires it, since a script
> read from a pipe cannot know where it came from. Details in
> [`docs/windows.md`](docs/windows.md); a step-by-step manual install is in
> [`docs/cai-thu-cong-windows.md`](docs/cai-thu-cong-windows.md) (Vietnamese).

## Status

Personal project, running in production for its author since July 2026, published in the
hope it is useful. Test suite: 650 tests. It has **not** been through an external security
audit — read [`SECURITY.md`](SECURITY.md) before pointing it at anything you care about,
particularly the part about what the threat model does and does not cover.

## Three pieces

```
 Dev machine                      Hub server                    Phone
┌───────────────────┐  HTTP POST ┌───────────────────┐ Web Push ┌────────────────┐
│ Notification hook │───────────►│  /notify → store  │─────────►│ PWA on the     │
│ (hook/)           │  /notify   │  + send Web Push  │          │ home screen    │
└───────────────────┘            └───────────────────┘          └────────────────┘
```

- **Hook** (`hook/`): a script Claude Code runs on its `Notification` event. It reads a
  local on/off switch (`~/.ccrc/notify`) and, if on, POSTs straight to the hub with your
  personal token. No background process, no WebSocket.
- **Hub** (`server/`): Node.js — receives `/notify`, authenticates the token, sends Web
  Push to the right person's phone. No sessions, no transcripts, no relay.
- **PWA** (`server/public/`): a static page served by the hub, installed to the phone's
  home screen to receive notifications.
- **Terminal daemon** (`term/`): started by `/remote on`, binds to one tmux pane, listens
  **only** on the machine's Tailscale address, and serves the terminal page itself.

## Install

### 1. Hub on a server

```bash
git clone https://github.com/TranHuyQn/ccrc && cd ccrc
./deploy.sh                      # generates CCRC_TOKEN, asks for a tunnel token, builds
./deploy.sh adduser some-name    # issue a personal token per team member
```

Use `deploy.sh` rather than driving Docker Compose yourself: it generates `CCRC_TOKEN`,
then asks for a Cloudflare Tunnel token and tells you exactly where to get one
(Zero Trust → Networks → Tunnels → Create a tunnel), which is the step that is easy to
miss. Also available: `./deploy.sh status` · `down`.

**Optional — sign-in with Slack.** If you run token-slayer (a Slack-OAuth identity service)
alongside the hub, set `CCRC_TS_PUBLIC_URL` and `CCRC_TS_INTERNAL_URL` in `.env` (plus
`CCRC_CALLBACK_URL` on the token-slayer side) and your team signs itself in — no `adduser`
per person. A dev machine then runs the installer with no token: it prints a short code,
somebody approves it on a signed-in device, and the machine collects its own token.

Revoking is manual and stays manual: `./deploy.sh deluser <name>`. **The hub never
re-checks with Slack**, so someone who has left keeps working access until that command is
run. Put it in your off-boarding checklist — disabling their Slack account blocks new
logins and nothing else.

Running Compose by hand works too, but **both** variables have to be set in `.env` —
`CCRC_TOKEN` and, for the `cloudflare` profile, `CCRC_TUNNEL_TOKEN`. Without the second
one the tunnel container starts and immediately fails, so the hub is up but unreachable
from the internet, and Web Push (which requires public HTTPS) never works:

```bash
cp .env.example .env             # set CCRC_TOKEN (openssl rand -hex 24)
                                 # AND CCRC_TUNNEL_TOKEN (from Cloudflare Zero Trust)
                                 # AND CCRC_VAPID_SUBJECT if anyone uses an iPhone
docker compose -p cc-remote-control --profile cloudflare up -d --build
```

⚠ **`CCRC_VAPID_SUBJECT` is required, not optional, the moment one person uses an
iPhone.** Leave it unset and the hub falls back to `mailto:admin@localhost`, Apple
answers every push with `403 BadJwtToken`, and that phone receives nothing — while
`/notify` still reports success, the device still shows as subscribed, and Android and
Firefox keep working normally. Testing on an Android phone will never surface it. Set it
to the hub's public domain (`https://<your-hub>`) and **recreate** the container;
`docker restart` does not pick up a new variable. Changing the value does not invalidate
existing subscriptions — nobody has to reinstall the app.

`-p cc-remote-control` is not optional if you ever intend to use `deploy.sh` as well:
that is the project name it uses, and Compose otherwise names the project after the
directory. Get them out of step and `./deploy.sh status` reports nothing at all while
the hub is running perfectly — the two are simply looking at different projects.

Not using Cloudflare Tunnel? `--profile tls` runs Caddy instead and needs a domain
pointed at the machine (`CCRC_DOMAIN`). To try it locally with no tunnel and no TLS,
run Node directly — no Web Push in that mode, since browsers require HTTPS:

```bash
npm install && CCRC_TOKEN=<token> npm run server
```

Step-by-step, including which port to expose and how to back up your data:
[`docs/self-hosting.md`](docs/self-hosting.md).

### 2. Dev machine

From a checkout:

```bash
./setup-notify.sh        # asks for hub URL + personal token, installs the hook and /notify
```

Or, on a machine with no checkout, from your own hub — note the hub URL is required and
has **no default**, since every operator runs their own:

```bash
curl -fsSL https://<your-hub>/install.sh | sh -s -- <token> https://<your-hub>
```

Remove with `./remove-notify.sh` (or `https://<your-hub>/uninstall.sh`). No background
service is installed and tmux is left alone.

## On / off

**Off by default** — every dev machine has to opt in:

```
/notify on       # enable notifications from this machine
/notify off      # disable
/notify          # check status + probe the hub
```

When off, the hook exits immediately: no request leaves the machine, no data is sent.

## On the phone

Open the hub URL and log in with your personal token. **Required on iPhone**: Safari →
Share → *Add to Home Screen* → open the app from that icon before enabling notifications.
Opening it in a normal Safari tab will **not** receive push (an iOS limitation, not a bug).

## Notification kinds

Exactly two, matching Claude Code's `Notification` hook:

- **Waiting for input** — Claude stopped and is waiting for you to type.
- **Needs confirmation** — Claude asked a question, or wants permission to run a tool
  (Bash, file writes, …).

## Environment variables

**Hub** (in `.env`, or when running Node directly):

| Variable | Default | Meaning |
|---|---|---|
| `CCRC_TOKEN` | (required) | The hub's admin token |
| `CCRC_PORT` | `8720` | HTTP port |
| `CCRC_BIND` | `0.0.0.0` | Bind address: the host side of the compose `ports:` publish under Docker, and the `app.listen()` address when the hub runs under Node directly. Set `127.0.0.1` when a tunnel or reverse proxy sits in front. Do not put it in the container's `environment:` — inside the container the hub must listen on `0.0.0.0` or the tunnel cannot reach it |
| `CCRC_TRUST_PROXY` | (empty = off) | Set to `1` when a tunnel or reverse proxy sits in front, so the rate limiter counts the real client IP. **Pair it with `CCRC_BIND=127.0.0.1`** — Compose publishes 8720 on `0.0.0.0` in every profile, and a direct route to that port makes the flag meaningless because the client can write its own `X-Forwarded-For`. Leaving it off *behind* a proxy fails the other way: the whole internet shares one bucket, so one noisy caller rate-limits everybody |
| `CCRC_DATA_DIR` | `server/data` (Docker: volume `ccrc-data`) | Where `users.json`, VAPID keys and push subscriptions live |
| `CCRC_VAPID_SUBJECT` | `mailto:admin@localhost` | Web Push contact — **you must set a real one if anyone uses an iPhone**. Apple refuses to deliver push for the default subject (403 `BadJwtToken`); the hub still reports `/notify` as successful, but the iPhone never receives anything. Android (FCM) and Firefox are unaffected, so this slips through hand-testing on an Android device. The hub warns on startup if the subject is still the default or points at localhost — set it to `https://<your-hub-domain>` or a real `mailto:` contact to silence it |
| `CCRC_TUNNEL_TOKEN` | (empty) | Cloudflare Tunnel token (profile `cloudflare`) |
| `CCRC_DOMAIN` | (empty) | Domain for Caddy TLS (profile `tls`) |
| `CCRC_TS_PUBLIC_URL` | (empty) | token-slayer URL the browser is redirected to — comes as a pair with `CCRC_TS_INTERNAL_URL`; with only one set, Slack sign-in stays off |
| `CCRC_TS_INTERNAL_URL` | (empty) | token-slayer URL the hub calls itself over the internal network. Swap the two and sign-in looks fine in the browser but fails on the hub side |

**Dev machine** — `setup-notify.sh` asks for these and writes `~/.ccrc/config`, so you do
not set them by hand: `CCRC_HUB_URL`, `CCRC_TOKEN` (your personal token),
`CCRC_MACHINE_NAME`. `/remote pair` additionally writes `~/.ccrc/devices.json` — the
**public** key of each phone paired with this machine. Private keys never leave the phone
and are not in that file.

### Per-member accounts

Use `./deploy.sh adduser <name>` (Docker), or edit `CCRC_DATA_DIR/users.json` yourself
(the hub reloads it within ~5s):

```json
[
  { "name": "alice", "token": "alices-own-token" },
  { "name": "bob",   "token": "bobs-own-token" }
]
```

One token per person — a notification only reaches the token's owner.

## Security

Short version below; the full threat model, including what is deliberately **not**
defended against, is in [`SECURITY.md`](SECURITY.md).

- **Personal tokens**: whoever holds a token receives that person's notifications. Revoke
  by deleting the line in `users.json`.
- **Device pairing (terminal)**: attaching to a terminal requires a token signed with
  ECDSA P-256 using a **non-extractable** private key generated on the phone itself during
  `/remote pair`. Confirmation is deliberately **one-directional**: the dev machine prints
  no number of its own and simply waits; the phone displays a 6-digit code; you read that
  code **on your own phone** and type it into the dev machine with
  `/remote pair xac-nhan <number>`. The dev machine compares it against the number it
  computed independently and only then writes the device. The reason: the hub chooses who
  it is talking to, and it can do that perfectly honestly with an attacker's phone while
  your real phone believes it is comparing numbers with your dev machine — a "Matches"
  button on two screens decides nothing. During pairing the hub only relays strings, and
  keeps the phone's **public** key for exactly 5 minutes before deleting it (a public key
  is not a secret: it signs nothing and opens nothing).
- **Real revocation is removing the phone from Tailscale** — that takes effect across every
  dev machine at once. `/remote unpair <number>` cleans up one machine and is not a kill
  switch. Keys cannot be backed up: clearing site data or reinstalling the PWA loses the
  key and requires pairing again.
- **TLS is mandatory on the public internet**: Cloudflare Tunnel (recommended, opens no
  port) or Caddy (`--profile tls`). Web Push requires HTTPS. The terminal daemon is a
  separate case — see `SECURITY.md` for why it serves plain HTTP inside the tailnet.
- The hub stores no Claude Code session content, and **no notification content either**:
  titles and bodies pass through on their way to Web Push and are not retained. All that
  survives is one timestamp per session — enough for the phone to draw an unread dot, not
  enough for anyone to read what Claude asked. On disk there is only the user list and the
  push subscriptions. It holds no key that can open anyone's terminal.
- **The terminal daemon only completes a WebSocket handshake with the page it served
  itself** (`Origin`). The attach token is signed by the PWA and the PWA is served by the
  hub, so a compromised hub could sign a real token and send the phone to an attacker's
  page, which would then open a WebSocket from the phone already inside the tailnet. A
  browser will not let a page forge its own `Origin`, which is what closes that path.

## Layout

```
deploy.sh             Stand up the hub in one command (Docker + Cloudflare Tunnel)
setup-notify.sh       Install the hook + /notify on a dev machine
remove-notify.sh      Remove whatever setup-notify.sh created
docker-compose.yml    Hub (+ profiles: cloudflare, tls)
docker/               Dockerfile.hub
server/               Hub: receives /notify, sends Web Push, serves the PWA (public/)
hook/                 Notification hook for the dev machine + the /notify CLI
term/                 Terminal daemon, its web page, and the /remote CLI
shared/               Session registry shared by hook/ and term/
deploy/               systemd unit, example Caddyfile, slash-command definitions
docs/                 Self-hosting guide, user guide (English + Vietnamese), design specs
```

## Tests

```bash
npm test          # all 644: server + hook + term
```

The `term/` suite starts real tmux sessions and real daemons, so it needs `tmux` on PATH
and holds a pty per session. Its concurrency is capped at 4 for that reason — see the note
in `term/package.json`.

## Development notes

Comments, docs, and user-facing strings are largely Vietnamese; code and commit messages
are English. `docs/superpowers/` holds the design specs and implementation plans each
feature was built from, which is the fastest way to understand *why* a given check exists
before changing it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No notifications on iPhone | Not added to the home screen, or opened from a normal Safari tab instead of the installed icon |
| `/notify` says it cannot reach the hub | Wrong `CCRC_HUB_URL`/token, or the hub is not running — rerun `./setup-notify.sh` to fix the config |
| Cannot enable Web Push in the browser | Not on HTTPS, or the browser is blocking notifications |
| New machine, or lost `~/.ccrc/config` | Rerun `./setup-notify.sh` and re-enter URL + token |
| `/remote on` says tmux is missing | Claude Code must run inside tmux — use the `ccrc` wrapper, which starts it for you |

## License

MIT — see [`LICENSE`](LICENSE). Vendored third-party code keeps its own license:
xterm.js and its fit addon (MIT, `term/vendor/*.LICENSE.txt`), JetBrains Mono (OFL), and
Symbols Nerd Font (MIT/OFL).
