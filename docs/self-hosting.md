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

For a machine that can accept inbound traffic on ports 80 and 443 — a VPS, or a
home server with those ports forwarded and an address that does not move
(static IP, or dynamic DNS keeping the A record current).

**⚠ `./deploy.sh` does not drive this path — read this whole section before
running anything.** It was written for Option A: it only ever fills in
`.env` for a Cloudflare Tunnel, and the one profile it ever brings up is
`cloudflare`, never `tls`. Run bare `./deploy.sh` on a Caddy box and it happily
builds and starts the hub with nothing listening on 80 or 443, while also
skipping two `.env` variables that a tunnel deployment gets for free. Both gaps
are in the steps below, with the commands that work around them. `./deploy.sh
adduser` / `deluser` are unaffected — they talk to whichever hub container is
already running — but do not use bare `./deploy.sh` for this path.

**Prerequisites**

- A domain with an A (and/or AAAA) record **already** pointing at this
  machine's public IP — confirm with `dig +short ccrc.example.com` before you
  go further. Caddy requests the certificate the moment it starts, and Let's
  Encrypt validates over HTTP, so this has to be true first, not "soon."
- Ports 80 and 443 reachable from the public internet, not just open in this
  machine's own firewall — check any router or cloud security group in front
  of it too. Let's Encrypt's validation request comes from the outside, and
  one blocking layer anywhere on that path fails the same way as all of them
  blocking it.
- Docker with Compose v2 (`docker compose version`).

**1. Prepare `.env` — by hand, not with `./deploy.sh`.**

```bash
git clone https://github.com/TranHuyQn/ccrc && cd ccrc
cp .env.example .env
```

Edit `.env` and set:

```
CCRC_TOKEN=<output of: openssl rand -hex 24>
CCRC_DOMAIN=ccrc.example.com
CCRC_TRUST_PROXY=1
CCRC_BIND=127.0.0.1
```

The last two do not happen on their own here, and that is the first real gap
in `./deploy.sh`: it only ever writes `CCRC_TRUST_PROXY` and `CCRC_BIND` inside
the branch that runs once `CCRC_TUNNEL_TOKEN` is already set. A Caddy
deployment has no tunnel token, so that branch never runs, and both variables
stay unset even after `./deploy.sh` finishes without complaint. Left unset,
both failures are silent: the rate limiter reads Caddy's own address on every
request, so one noisy caller exhausts the shared bucket for the whole team
(same mechanism as the row about `429` in
[When it does not work](#when-it-does-not-work), just with Caddy instead of a
tunnel in front); and Compose still publishes port 8720 on
`${CCRC_BIND:-0.0.0.0}` under the `tls` profile exactly as it does everywhere
else, so anyone on the same LAN can skip Caddy entirely and talk to the hub
directly — on that direct path `CCRC_TRUST_PROXY=1` is actively harmful,
because the "trusted" header it reads is now whatever the direct caller wrote.
Set both by hand, as above, before you bring anything up. See
[Environment variables](#environment-variables) for what each one does.

**2. Bring it up — with the `tls` profile named explicitly.**

```bash
docker compose -p cc-remote-control --profile tls up -d --build
```

`--profile tls` is the second gap: it is not optional, and `./deploy.sh` never
passes it under any circumstance. Leave it off and Compose brings up the `hub`
service only — it builds, it health-checks fine internally, and there is
still nothing on 80 or 443 for the outside world to reach.

Keep `-p cc-remote-control` too, for an unrelated reason that bites here just
as it would on Option A: `deploy.sh` always uses that project name, while
Compose on its own names the project after whatever directory you cloned into.
If the two disagree, `./deploy.sh status` prints an empty table and
`./deploy.sh down` stops nothing, both while the hub is running fine — they
are just looking at a different project. Nothing warns you; the output simply
looks like the hub was never started.

This starts two services from `docker-compose.yml`: `hub`, and `caddy`
(`caddy:2-alpine`, publishing `80:80` and `443:443`, running
[`deploy/Caddyfile.docker`](../deploy/Caddyfile.docker) — a single
`reverse_proxy` to `hub:8720` on the domain read from `CCRC_DOMAIN`). Caddy
requests and renews the Let's Encrypt certificate itself; there is nothing
else to configure for that part.

Note this puts the machine's hostname into public Certificate Transparency
logs permanently. That is normal for a public service, but it is the exact
tradeoff the terminal daemon refuses to make — see
[`../SECURITY.md`](../SECURITY.md).

**3. Verify, in this order.**

```bash
# a) Caddy issued a real certificate for your domain, not the localhost fallback
openssl s_client -connect ccrc.example.com:443 -servername ccrc.example.com \
  </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject
# issuer should mention "Let's Encrypt"; subject should be your domain, not "localhost"

# b) the hub answers through Caddy
curl -fsS https://ccrc.example.com/healthz     # {"ok":true}

# c) 8720 is NOT reachable from another machine on the LAN
curl -m 3 http://<this-machine's-LAN-IP>:8720/healthz
# should time out or refuse the connection — if it answers, CCRC_BIND never
# got set; go back to step 1
```

Do all three. (b) alone will not catch a leftover open port or a
localhost-only certificate — those two fail quietly, and (a)/(c) are the only
way to see them before someone else does.

### Optional — Slack sign-in

Same two hub variables as everywhere else in this guide — `CCRC_TS_PUBLIC_URL`
and `CCRC_TS_INTERNAL_URL`, set together, all-or-nothing — see
[Let them sign themselves in](#let-them-sign-themselves-in-optional). What is
specific to this path is the other end: `CCRC_CALLBACK_URL` on the
token-slayer side has to point at *this* hub's real domain —
`https://ccrc.example.com/auth/callback` — because it is token-slayer's own
server, not the browser, that reads it after the Slack round trip.

**The cutover trap.** `CCRC_CALLBACK_URL` is a single value in token-slayer's
own `.env` — one deployment of token-slayer can serve exactly one hub. If
you're moving sign-in from a test or staging hub to this production hub, the
two ends have to change in this order, or there's a window where **neither**
hub can finish a sign-in:

1. Bring the production hub up first, with `CCRC_TS_PUBLIC_URL` /
   `CCRC_TS_INTERNAL_URL` already set, and confirm `/healthz` on its real
   domain. Its "Sign in with Slack" button will not fully work yet — clicking
   it still round-trips through the *old* callback — and that's expected;
   nobody should be relying on it yet.
2. Only once the production hub is confirmed up, change `CCRC_CALLBACK_URL` on
   token-slayer to the production hub's callback URL and restart or redeploy
   token-slayer so it picks up the change.
3. Test one real sign-in against the production hub immediately after.

Do step 2 before step 1 and you get the exact failure this order exists to
prevent: the old hub's sign-in now points at a callback that no longer serves
it, while the production hub — not yet up, or not yet configured with the two
`CCRC_TS_*` variables — has nothing there to receive the callback either. Both
broken at once, and neither error message points at the other end.

Tokens already issued keep working through all of this — the hub never
re-checks with the identity provider after first sign-in (see
[Removing people](#removing-people)) — so the cutover only affects people
signing in for the first time, or on a new device, during the switch.

### Operating a Caddy deployment

Both services restart automatically after a crash (`restart: unless-stopped`
in `docker-compose.yml`), but that only fires once the Docker daemon itself is
back after a host reboot — on Linux that means `systemctl enable docker`;
`./deploy.sh` does not do this for you.

`./deploy.sh status` and `./deploy.sh down` are safe to use as-is on this
path: `down` stops the whole project regardless of which profile flag it is
given — `./deploy.sh down` hardcodes `--profile cloudflare`, but that still
tears down `caddy` along with `hub`. Verified on Compose v5; older versions
were reported to filter `down` by profile, so confirm the first time rather
than assume:

```bash
./deploy.sh down
docker compose -p cc-remote-control ps      # expect no rows
```

An empty list is the point — if `caddy` survives, it is still holding 80 and
443, and the port looks closed from the outside only because nothing is
answering behind it.

Re-running bare `./deploy.sh` after a `git pull` is not the same: it rebuilds
and restarts `hub` as always, but it will not touch `caddy` — `up` (unlike
`down`) only acts on services inside the profile it is given, and
`./deploy.sh` never passes `tls`. If you change the Caddyfile or want to pick
up a new Caddy image, rebuild that service explicitly:

```bash
docker compose -p cc-remote-control --profile tls up -d --build caddy
```

Back up the data volume the same way as any other deployment — see
[Backups](#backups); nothing about running Caddy in front changes what's in
it.

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
| Certificate never gets issued, DNS looks right | Port 80 or 443 is not reachable from the public internet — check the router or cloud security group in front of this machine, not just its own firewall; Let's Encrypt's validation request comes from outside |
| Certificate never gets issued, and/or Caddy logs a DNS error | DNS has not propagated yet, or points at the wrong IP — `dig +short ccrc.example.com` should already match this machine before you bring Caddy up |
| `openssl s_client` shows a certificate for `localhost`, not your domain | `CCRC_DOMAIN` is unset in `.env` — Compose falls back to `CCRC_DOMAIN=localhost` and Caddy self-signs for that instead of requesting a real one |
| Hub answers directly (`docker compose exec hub …/healthz`) but the domain 502s | Caddy is up but can't reach `hub` — check `docker compose -p cc-remote-control ps` for a hub container that's still building or has crashed |
| One noisy caller seems to rate-limit the whole team, and this deployment has no tunnel | `CCRC_TRUST_PROXY` / `CCRC_BIND` were never set — `./deploy.sh` only writes that pair when `CCRC_TUNNEL_TOKEN` exists, which a Caddy deployment never has. Set both by hand — see Option B, step 1 |
| `/notify` on a dev machine says it cannot reach the hub | Wrong URL or token in `~/.ccrc/config` — rerun `setup-notify.sh` |
| Browser will not enable notifications | Not on HTTPS, or (on iPhone) the page was opened in a Safari tab instead of the installed home-screen app |
| Hub exits immediately with `CCRC_TOKEN is required` | `.env` missing or the variable is empty |
| No "sign in with Slack" button on the login page | One of `CCRC_TS_PUBLIC_URL` / `CCRC_TS_INTERNAL_URL` is unset — the pair is all-or-nothing |
| Sign-in reaches the identity service but the hub then says the session expired | Its `CCRC_CALLBACK_URL` does not point back at this hub, or more than five minutes passed between clicking and returning |
| Everyone starts getting `429` from the installer at once | A proxy is in front but `CCRC_TRUST_PROXY` is unset, so the whole internet shares one rate-limit bucket |
| Installer prints a code, then "expired" even though somebody approved it | The wait was interrupted with Ctrl-C; that spends the approval. Run the installer again for a fresh code |
