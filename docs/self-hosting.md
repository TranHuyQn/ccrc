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

Each person needs exactly two things, and nothing else:

**1. A personal token**, issued on the hub machine:

```bash
./deploy.sh adduser their-name
```

It prints a token. Send it to that person **directly** — not into a group chat.
The hub reloads the user list within about 5 seconds; no restart needed.

Editing `users.json` inside the data volume by hand does the same thing:

```json
[
  { "name": "alice", "token": "alices-own-token" },
  { "name": "bob",   "token": "bobs-own-token" }
]
```

The name `admin` is reserved for `CCRC_TOKEN` itself, and an entry using it is
ignored with a message in the log rather than silently dropped.

**2. Their own Tailscale account** — needed only for the web terminal, not for
notifications. Do not invite them to your tailnet and do not join theirs. The
free personal plan is enough. The reasoning is in
[`huong-dan.md`](huong-dan.md) §6 and [`../SECURITY.md`](../SECURITY.md); the
short version is that leaving a tailnet is each person's own kill switch, and a
shared tailnet takes that switch away from them.

## Dev machine setup

From a checkout:

```bash
./setup-notify.sh
```

Or on a machine with no checkout, straight from your hub — the hub URL is
required and has no default:

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
| `CCRC_BIND` | `0.0.0.0` | Host bind address. Set `127.0.0.1` once a tunnel or proxy is in front, so the port is not exposed to your LAN |
| `CCRC_DATA_DIR` | `server/data` (Docker: volume `ccrc-data`) | Users, VAPID keys, push subscriptions |
| `CCRC_VAPID_SUBJECT` | `mailto:admin@localhost` | Contact address embedded in Web Push |
| `CCRC_TUNNEL_TOKEN` | (empty) | Cloudflare Tunnel token — required by the `cloudflare` profile |
| `CCRC_DOMAIN` | (empty) | Domain for Caddy — required by the `tls` profile |

## When it does not work

| Symptom | Cause |
|---|---|
| Tunnel container restarts in a loop | `CCRC_TUNNEL_TOKEN` empty or wrong. `./deploy.sh status` shows the cloudflared log |
| Hub is up, hostname returns 502 | Tunnel's public hostname is not pointing at `HTTP → hub:8720` |
| Caddy cannot get a certificate | DNS does not resolve to this machine yet, or 80/443 are not reachable from outside |
| `/notify` on a dev machine says it cannot reach the hub | Wrong URL or token in `~/.ccrc/config` — rerun `setup-notify.sh` |
| Browser will not enable notifications | Not on HTTPS, or (on iPhone) the page was opened in a Safari tab instead of the installed home-screen app |
| Hub exits immediately with `CCRC_TOKEN is required` | `.env` missing or the variable is empty |
