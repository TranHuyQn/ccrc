# Self-hosting the hub

Everyone who uses CC Remote Control runs their own hub. There is no shared
service and no default hostname anywhere in this project — a default would mean
sending your team's tokens to a stranger's machine.

This guide is for the person **running the hub**. If somebody else already runs
one and just gave you a token, you do not need any of this: go straight to
[Dev machine setup](#dev-machine-setup).

## What the hub actually does

Worth knowing before you decide where to put it, because it changes what you
need to protect:

- Receives a notification title and body (200 characters each, maximum) from
  the dev machine and forwards it to your phone as Web Push.
- Stores the user list, push subscriptions and the VAPID keypair on disk.
- Keeps the last 50 notifications per user **in memory only** — a restart drops
  them, by design.
- Holds **no** terminal traffic and **no** key that can open anyone's terminal.
  Shell bytes go directly from the dev machine to the phone over your tailnet;
  the hub never sees them.

So the hub is small, and the thing on it worth protecting is the data directory:
whoever has that can send push to your devices and read every personal token.

## Requirements

- A machine that stays on. A home server behind NAT is fine — that is what the
  Cloudflare Tunnel option exists for.
- Docker with Compose. (Or just Node 22+, see [Without Docker](#without-docker).)
- **Public HTTPS.** Not optional: browsers refuse Web Push over plain HTTP, so a
  hub that is only reachable over `http://` cannot deliver a single
  notification. Both options below solve this.

## Option A — Cloudflare Tunnel (recommended)

No open ports, no static IP, no certificate to renew. Good for a home server.

**1. Create the tunnel.** In Cloudflare Zero Trust → **Networks** → **Tunnels** →
*Create a tunnel* → *Cloudflared*. Copy the token it shows (a long string
starting `eyJ`).

**2. Point the tunnel at the hub.** In the tunnel's **Public hostname** tab, add
a hostname on a domain you control, and set the service to **HTTP** →
`hub:8720`. `hub` is the container name, so this resolves inside the Compose
network; it is not a hostname you need to own.

**3. Deploy.**

```bash
git clone https://github.com/TranHuyQn/ccrc && cd ccrc
./deploy.sh
```

It generates `CCRC_TOKEN`, asks for the tunnel token from step 1, writes both to
`.env`, then builds and health-checks. Run it again any time to update — it
keeps the answers it already has.

Because a tunnel token means a proxy is in front, it also writes
`CCRC_TRUST_PROXY=1` and `CCRC_BIND=127.0.0.1`. Those two belong together: the
first tells the hub to read the client IP from the proxy's header so per-IP
rate limiting counts real clients, and the second closes the direct route to
port 8720 — which Compose publishes on `0.0.0.0` in every profile. Leave the
port open and the flag is worthless, because anyone reaching it directly can
write that header themselves. If you already have either key in `.env`, it
leaves your value alone.

**4. Check.**

```bash
curl -fsS https://<your-hostname>/healthz     # {"ok":true}
```

## Option B — Caddy with your own domain

For a machine that can accept inbound traffic on ports 80 and 443.

```bash
cp .env.example .env
# set CCRC_TOKEN   (openssl rand -hex 24)
# set CCRC_DOMAIN  (a domain whose DNS A/AAAA record points at this machine)
docker compose -p cc-remote-control --profile tls up -d --build
```

Caddy obtains and renews a Let's Encrypt certificate automatically. DNS has to
resolve to this machine **before** you start it, or the certificate request
fails.

Keep the `-p cc-remote-control`. `deploy.sh` uses that project name, while
Compose on its own names the project after whatever directory you cloned into.
If the two disagree, `./deploy.sh status` prints an empty table and
`./deploy.sh down` stops nothing, both while the hub is running fine — they are
just looking at a different project. Nothing warns you; the output simply looks
like the hub was never started.

Note this puts the machine's hostname into public Certificate Transparency logs
permanently. That is normal for a public service, but it is the exact tradeoff
the terminal daemon refuses to make — see [`../SECURITY.md`](../SECURITY.md).

## Without Docker

```bash
npm install
CCRC_TOKEN=$(openssl rand -hex 24) npm run server
```

Listens on port 8720. Fine for a look around, but **Web Push will not work**
until it is behind HTTPS, so put a reverse proxy in front before treating it as
a real deployment. Set `CCRC_DATA_DIR` to somewhere outside the checkout if you
do, so a `git pull` and the data never share a directory.

## Adding people

### Let them sign themselves in (optional)

If you run token-slayer — a Slack-OAuth identity service — alongside the hub,
people enrol without you doing anything. Set **both** of these in `.env`:

| Variable | What it is |
|---|---|
| `CCRC_TS_PUBLIC_URL` | The URL the browser is redirected to |
| `CCRC_TS_INTERNAL_URL` | The URL the hub calls itself, over the internal network |

and set `CCRC_CALLBACK_URL` on the token-slayer side to `https://<your-hub>/auth/callback`.

Both hub variables are required. With only one set the feature stays off and the
sign-in page falls back to the paste-a-token box — deliberately, so a
half-configured hub fails visibly rather than sending people into a login it
cannot finish. Swap the two and sign-in appears to work in the browser but fails
on the hub side.

The hub asks that service who just signed in and issues its own token for that
person. It never holds a credential of theirs.

### Or issue a token by hand

For anyone who cannot use that service — a script, a contractor, a shared
account — or if you are not running it at all:

```bash
./deploy.sh adduser their-name
```

It prints a token. Send it to that person **directly** — not into a group chat.
The hub reloads the user list within about 5 seconds; no restart needed.

Editing `users.json` inside the data volume by hand does the same thing:

```json
[
  { "name": "alice", "token": "alices-own-token" },
  { "name": "U01ABCDEF", "displayName": "bob", "token": "bobs-own-token" }
]
```

Both shapes are valid. Entries created by hand carry just a name; entries
created by signing in are keyed by the provider's immutable id, with the
display name kept alongside — so somebody renaming themselves upstream does not
orphan their push subscriptions and open sessions. An entry with no
`displayName` simply shows its `name`.

The name `admin` is reserved for `CCRC_TOKEN` itself, and an entry using it is
ignored with a message in the log rather than silently dropped.

### Their own Tailscale account

This part you cannot do for them, and it is needed only for the web terminal,
not for notifications. Do not invite them to your tailnet and do not join
theirs. The
free personal plan is enough. The reasoning is in
[`huong-dan.md`](huong-dan.md) §6 and [`../SECURITY.md`](../SECURITY.md); the
short version is that leaving a tailnet is each person's own kill switch, and a
shared tailnet takes that switch away from them.

## Removing people

```bash
./deploy.sh deluser their-name        # display name or provider id
```

If the name matches more than one entry the command **removes nothing** and
lists the candidates, so you can retype using the unambiguous id. This runs
during a personnel incident, and deleting the wrong person costs them their
push subscriptions, notification history and open sessions.

**The hub never re-checks with the identity provider.** It asks once, at first
sign-in, and issues its own token. Disabling somebody's Slack account blocks
new logins and does nothing to the token already on their laptop — that keeps
working until you run the command above. Put it in your off-boarding checklist;
it will not happen on its own.

## Dev machine setup

From a checkout:

```bash
./setup-notify.sh
```

Or on a machine with no checkout, straight from your hub. The hub URL is
required and has no default — this project has no central server to fall back
on, and guessing one would send a token to a stranger's machine.

With sign-in configured, no token is needed. The installer prints a short code
and waits for somebody already signed in to approve it at `https://<your-hub>/link`:

```bash
curl -fsSL https://<your-hub>/install.sh | CCRC_HUB_URL=https://<your-hub> sh
```

With a token issued by hand:

```bash
curl -fsSL https://<your-hub>/install.sh | sh -s -- <token> https://<your-hub>
```

Either way it writes `~/.ccrc/config` (chmod 600), installs the `/notify` and
`/remote` slash commands plus one hook entry in `~/.claude/settings.json`, and
puts a `ccrc` wrapper next to your `claude` binary. Notifications start **off**.

Full walkthrough for the person receiving a token, including the phone side:
[`huong-dan.md`](huong-dan.md) (Vietnamese).

## Operating it

```bash
./deploy.sh status     # container state + recent hub and tunnel logs
./deploy.sh down       # stop; the data volume is kept
./deploy.sh            # re-run to update after a git pull
```

### Backups

Everything that matters lives in one place: the `ccrc-data` Docker volume
(`/data` in the container), or `CCRC_DATA_DIR` without Docker.

```bash
docker run --rm -v ccrc-data:/data -v "$PWD:/out" alpine \
  tar czf /out/ccrc-data-backup.tar.gz -C /data .
```

That archive contains **every personal token and the VAPID private key**. Treat
it exactly like the tokens themselves: anyone holding it can send push to your
users' phones and impersonate them to the hub. Do not put it anywhere you would
not put the tokens.

Losing it is not a disaster — the hub generates a new VAPID keypair on next
start — but every phone has to re-subscribe and every token has to be reissued.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CCRC_TOKEN` | (required) | Hub admin token; also logs in as the `admin` user |
| `CCRC_PORT` | `8720` | HTTP port |
| `CCRC_BIND` | `0.0.0.0` | Host bind address (Compose only — a bare `node server/src/index.js` ignores it and listens on every interface). Set `127.0.0.1` once a tunnel or proxy is in front, so the port is not exposed to your LAN |
| `CCRC_TRUST_PROXY` | (empty = off) | Set `1` when a tunnel or reverse proxy is in front, so per-IP rate limiting reads the real client IP. **Pair it with `CCRC_BIND=127.0.0.1`** — with the port still reachable directly, a client can write its own `X-Forwarded-For` and the flag buys nothing. Leaving it off *behind* a proxy fails the other way: every request looks like it comes from the proxy, so one noisy caller rate-limits everybody |
| `CCRC_DATA_DIR` | `server/data` (Docker: volume `ccrc-data`) | Users, VAPID keys, push subscriptions |
| `CCRC_VAPID_SUBJECT` | `mailto:admin@localhost` | Contact address embedded in Web Push |
| `CCRC_TUNNEL_TOKEN` | (empty) | Cloudflare Tunnel token — required by the `cloudflare` profile |
| `CCRC_DOMAIN` | (empty) | Domain for Caddy — required by the `tls` profile |
| `CCRC_TS_PUBLIC_URL` | (empty) | Identity service URL the browser is redirected to. Pairs with the next one; with only one set, sign-in stays off |
| `CCRC_TS_INTERNAL_URL` | (empty) | Identity service URL the hub calls itself, over the internal network |

## When it does not work

| Symptom | Cause |
|---|---|
| Tunnel container restarts in a loop | `CCRC_TUNNEL_TOKEN` empty or wrong. `./deploy.sh status` shows the cloudflared log |
| Hub is up, hostname returns 502 | Tunnel's public hostname is not pointing at `HTTP → hub:8720` |
| Caddy cannot get a certificate | DNS does not resolve to this machine yet, or 80/443 are not reachable from outside |
| `/notify` on a dev machine says it cannot reach the hub | Wrong URL or token in `~/.ccrc/config` — rerun `setup-notify.sh` |
| Browser will not enable notifications | Not on HTTPS, or (on iPhone) the page was opened in a Safari tab instead of the installed home-screen app |
| Hub exits immediately with `CCRC_TOKEN is required` | `.env` missing or the variable is empty |
| No "sign in with Slack" button on the login page | One of `CCRC_TS_PUBLIC_URL` / `CCRC_TS_INTERNAL_URL` is unset — the pair is all-or-nothing |
| Sign-in reaches the identity service but the hub then says the session expired | Its `CCRC_CALLBACK_URL` does not point back at this hub, or more than five minutes passed between clicking and returning |
| Everyone starts getting `429` from the installer at once | A proxy is in front but `CCRC_TRUST_PROXY` is unset, so the whole internet shares one rate-limit bucket |
| Installer prints a code, then "expired" even though somebody approved it | The wait was interrupted with Ctrl-C; that spends the approval. Run the installer again for a fresh code |
