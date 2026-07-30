# CC Remote Control — user guide

For people who were given a token by whoever runs the hub. About 10 minutes to
read, about 15 to set up.

Running the hub yourself? [`self-hosting.md`](self-hosting.md) instead.

> 🇻🇳 Bản tiếng Việt: [`huong-dan.md`](huong-dan.md)

---

## 1. What this does

You run Claude Code on your computer. It works for a while, then **stops and
waits for you** — a question, or permission to run something. If you were making
coffee, it just sits there.

Two things, independent of each other:

**1. Notify.** Claude stops and waits → your phone buzzes.

**2. Answer from your phone.** Open a web terminal pointed at the exact Claude
session that is waiting. Read it, type, answer — then put the phone away.

It is **not** screen mirroring and **not** a chat bot. Each web terminal is
bound to one tmux pane and never opens another window.

### The two halves need different things

| | Notify (part 1) | Web terminal (part 2) |
|---|---|---|
| Needs Tailscale | ❌ no | ✅ **required**, on both computer and phone |
| Needs tmux | ❌ no | ✅ **required** |
| Path taken | your machine → hub → phone | your machine → **straight to** your phone |

So **part 1 works today** even if you have never installed Tailscale or used
tmux. Part 2 can wait.

---

## 2. What you need

- **Node.js** (any supported version)
- **Claude Code**, working on your machine
- **A personal token** — sent to you privately by whoever runs the hub. Treat it
  as a password; do not paste it into a group chat.
- **A phone**, iPhone or Android
- *(part 2 only)* **tmux**, and **Tailscale** — **your own account**, not shared
  with anyone. §6 explains why.

---

## 3. Install on your computer

### Quick way — one command

```bash
curl -fsSL https://<your-hub>/install.sh | sh -s -- <your-token> https://<your-hub>
```

Two things to substitute:

- `<your-hub>` — the hub address your administrator set up. You type it
  **twice**: once to fetch the script, once so the script knows where to send
  notifications (piped through `curl | sh`, a script cannot tell where it was
  downloaded from). There is no default, because everyone runs their own hub and
  a built-in one would mean sending your token to a stranger's machine.
- `<your-token>` — the token your administrator sent you.

No git, no account anywhere — the command pulls the code from that hub itself.

It also asks for a **machine name** (shown in notifications); press Enter to use
the current hostname. Then you are done.

Want to read the script first — entirely reasonable, it runs on your machine:

```bash
curl -fsSL https://<your-hub>/install.sh -o install.sh
less install.sh
CCRC_HUB_URL=https://<your-hub> sh install.sh <your-token>
```

**It touches exactly these places and nothing else:**

| Place | What |
|---|---|
| `~/.local/share/ccrc` | The code |
| `~/.ccrc/config` | Hub URL, token, machine name (chmod 600) |
| `~/.claude/commands/` | The `/notify` and `/remote` slash commands |
| `~/.claude/settings.json` | **One added** hook entry — your existing hooks are untouched |
| next to the `claude` binary | A `ccrc` command (see §6) |

Remove it completely at any time:

```bash
curl -fsSL https://<your-hub>/uninstall.sh | sh
```

### Other way — from a git clone

If you have the repo, run this inside it:

```bash
./setup-notify.sh
```

It asks three things:

| Question | Answer |
|---|---|
| Hub URL | `https://<your-hub>` |
| Personal token | the one your administrator sent |
| Machine name shown in notifications | something you will recognise, e.g. `Kien's MacBook` |

Then it:

- writes `~/.ccrc/config` (chmod 600 — only you can read it)
- installs the `/notify` and `/remote` slash commands
- installs the `Notification` hook into Claude Code
- leaves notifications **OFF** — deliberately; you turn them on when you are
  about to walk away

**What the machine name is for:** it appears on notifications and on terminal
cards. If you run several machines, that is how you tell them apart.

---

## 4. Install on your phone

### iPhone

1. Open **Safari** (it must be Safari, not Chrome) and go to `https://<your-hub>`
2. Share button → **Add to Home Screen**
3. **Open the app from that new icon** — not from Safari again
4. Paste your token → Log in
5. Tap **Enable notifications on this device**, and allow when iOS asks

⚠️ **Steps 2 and 3 are required, not suggestions.** iOS only permits Web Push
for a web app added to the home screen and opened from there. Opened in a Safari
tab, the enable button will not work.

### Android

Chrome → go to `https://<your-hub>` → Chrome offers to install the app → log in
→ enable notifications. Installing is not mandatory, but it is nicer.

### Check it

Back on the computer, run `/notify`. It should say **1 device**. If it warns
that no device is registered, enabling notifications on the phone did not
succeed — redo §4.

---

## 5. Daily use — notifications

In Claude Code:

| Command | What it does |
|---|---|
| `/notify on` | Turn notifications on. Do this when you are about to walk away. |
| `/notify off` | Off. |
| `/notify` | Status: on or off, whether the hub is alive, how many devices are registered. |

**Off by default is deliberate.** Sitting right in front of the machine while
your phone buzzes is more annoying than useful.

You get a notification when:

- 🔔 Claude is waiting for your input
- 🔐 Claude needs confirmation (a question, or permission to run a tool)

**Your work is never sent.** A notification carries only the machine name, the
session name, and one of those two lines. It says *"something needs you"*, not
*what*.

---

## 6. Daily use — the web terminal

### Requirements

Claude Code has to be running **inside tmux**. You do not need to know tmux —
the installer created `ccrc` for you:

```bash
ccrc            # instead of `claude`
```

`ccrc` is used **exactly** like `claude`: every argument is the same
(`ccrc --continue`, `ccrc -p "..."`, …), it just starts tmux for you. Quit
Claude and the tmux session closes with it, leaving nothing behind.

If tmux is not installed, the first `ccrc` run offers to install it. Declining
is fine — Claude opens normally, that session just cannot use `/remote`.

Already comfortable with tmux? The old way still works:

```bash
tmux
claude
```

Running `ccrc` while already inside a tmux session is fine too: it runs right in
that pane without nesting. Quitting Claude then **turns off `/remote` for that
pane** — the phone's terminal closes with it, so nobody can type into the shell
that just appeared.

### Tailscale — one account each

**Create your own Tailscale account** (the free personal plan is enough) and
install it on **your computer** and **your phone**. Only those two devices. Do
not join anyone else's tailnet and do not invite anyone into yours.

That sounds backwards — same system, separate networks, so how do they connect?
They do not need to. Terminal content only ever travels from your machine to
your phone. Nothing needs to flow between your machine and anyone else's. The
only shared thing is the hub, which lives on the public internet and **needs no
Tailscale at all**.

**Why separation matters, beyond tidiness:**

Since 2026-07-29 the hub holds no key that can open your session — the phone
signs its own requests and the dev machine verifies with a key it learned at
pairing time (§8). But the reason for separate Tailscale accounts is unchanged,
just relocated: it is **your own kill switch**. Removing your phone from your
tailnet removes the only path it has to reach your machine's `100.x.x.x`
address — instantly, across every dev machine you ever paired it with.

Share a tailnet and that switch is no longer yours: removing a device affects
everyone's routing, not just yours, and it goes through whoever administers that
tailnet instead of being something you just do.

*(This is decision D2b in the design docs, settled at the start of the project.
The original reasoning changed when the hub stopped holding keys; the conclusion
did not.)*

### Turning it on

```
/remote on
```

Result:

```
✓ Remote ĐÃ BẬT
  Tên hiện trên web: k7m2
  URL: http://100.x.x.x:53812/
⚠ Máy ngủ là mất kết nối. Hãy đặt máy không ngủ trước khi rời đi.
```

*(The CLI still speaks Vietnamese: remote is ON, the name shown on the web is
`k7m2`, and the warning says a sleeping machine drops the connection — keep the
machine awake before you leave.)*

`k7m2` is a **random id**. Give it a readable name instead:

```
/remote on payments-api
```

→ the phone shows `payments-api` rather than `k7m2`.

**Why random by default:** this label sits on your lock screen and in every
screenshot you send anyone. It used to be the directory name — which meant
naming the project, and sometimes the client. What has been seen cannot be
unseen, so directory names **never leave your machine** now.

### Other commands

| Command | What it does |
|---|---|
| `/remote` | List all your open sessions, marking the current one |
| `/remote off` | Close the session for **this pane**, leaving others alone |
| `/remote pair` | Start pairing a phone with **this machine** — see §8 |
| `/remote pair xac-nhan <number>` | Step two: type the number shown ON THE PHONE so this machine records the device — see §8 |
| `/remote devices` | List phones paired with this machine |
| `/remote unpair <number>` | Remove a paired phone — this machine only, see §8 |

**Several sessions at once** works — one `/remote on` per Claude pane, and the
phone shows a list of cards.

### Opening it on the phone

Open the app → **TERMINAL** section → tap **Mở terminal** on the card you want.

---

## 7. What the terminal screen has

```
┌──────────────────────────────────────┐
│ đã nối                               │  ← connection status
│                                      │
│  (your Claude session's contents)    │
│                                      │
├──────────────────────────────────────┤
│ Esc  ↑  ↓  ←  →  ⏎  Tab  ⇧Tab  ^C   │  ← key bar
├──────────────────────────────────────┤
│ [ Nhắn cho Claude…            ] Gửi  │  ← compose box
└──────────────────────────────────────┘
```

**The compose box** is where you type your answer. Enter inserts a **newline**,
it does not send; write as many lines as you like and tap **Gửi** (Send) once —
the whole block arrives intact.

**The key bar** is for control:

| Key | Use when |
|---|---|
| `↑` `↓` | Moving through one of Claude's choice lists |
| `←` `→` | Moving the cursor |
| `⏎` | Confirming a choice |
| `Tab` / `⇧Tab` | Cycling choices forward/back |
| `Esc` | Cancelling |
| `^C` | Stopping whatever Claude is running |

**Scrolling back:** drag down inside the terminal area to see what scrolled past,
drag up to return. While you are looking at the past, new output **is kept, not
lost** — you will see all of it when you come back. Typing anything also jumps
you to the present.

**Buttons inside the terminal are tappable:** Claude Code draws some controls
right in the screen (`Jump to bottom`, choice lists…). Tap them directly — a
quick tap counts as a click, a drag counts as scrolling, a long press counts as
selecting.

**Copying:** long-press on text to select, then Copy as usual.

**Prompt icons** (separators, folder, git, clock…) render exactly as on your
machine — a Nerd Font icon set is bundled. It is 2.4 MB but downloads **once per
device**, then stays cached forever, and only downloads when the screen actually
contains icons. The first terminal you open over mobile data may show icons a
few seconds after the text; never again after that.

The terminal is **display only** and takes no direct keystrokes — everything you
type goes through the compose box or the key bar. This is deliberate: a virtual
keyboard popping up mid-scroll is the single most irritating mobile bug, and
this design means it cannot happen.

---

## 8. Privacy — what goes where

| Thing | Does it leave your machine |
|---|---|
| Terminal contents | ✅ but **straight to your phone** over Tailscale; the hub sees not one byte |
| Directory names / paths | ❌ **never** |
| What Claude is asking | ❌ no — the notification only says "something needs you" |
| Machine name, session name you chose | ✅ yes, shown on notifications and terminal cards |
| The private key — the only thing that opens a session | ❌ **never leaves your phone**, not even during pairing |

The hub keeps only: who you are, which sessions are open, and — for exactly 5
minutes while you pair a phone — that phone's **public** key, then deletes it. A
public key is not a secret: by the nature of asymmetric cryptography it can only
verify signatures, never produce them, so on its own it opens nothing. What
opens a session is the private key, and that never leaves your phone. The hub
keeps **no** conversation history. Restart the hub and the session list is gone
— just run `/remote on` again.

The terminal runs **plain HTTP** on a Tailscale address, no HTTPS. This is
**deliberate**: the transport is already encrypted by Tailscale, while
requesting an HTTPS certificate would write your machine's name into public
Certificate Transparency logs — permanent, public, **not removable**.

While you have a session's terminal open on the phone, that session **sends no
notifications** (you are already looking at it; buzzing would be noise). Lock the
screen or switch apps and they resume immediately.

### Can other people on the same hub see anything of yours

No. The hub separates by user: session lists, in-progress pairings, notification
history — each is tied to your token, and another token cannot ask for it.

### Can whoever runs the hub watch your session

No — and since 2026-07-29 that is a technical fact rather than a promise.

The hub **holds no key that opens your session.** Your phone signs the attach
request with a private key inside itself, and the dev machine verifies it with
the public key it learned exactly once, when you paired. The hub only relays
strings during pairing, and it **chooses which phone it is talking to** — which
is why what protects you is not "tampering would show" (a hub can redirect the
whole pairing to an attacker's phone perfectly honestly, tampering with nothing)
but this: **you read the number off your own phone and type it into the dev
machine, and the dev machine rejects any other number.** See "Pairing a phone
with a machine" below.

What the hub does know: which of your machines has which session open, the
session names you chose, Tailscale addresses, and the time of each moment Claude
stopped to wait for you.

One more thing worth saying plainly: **the hub serves this web app.** Whoever
controls the hub can push a malicious build to your phone. The private key is
non-extractable, so that build cannot carry the key away — it could only get
signatures while the page is open, and that leaves an auditable trace. This is
the boundary of the design, and it is better to know it up front.

### Pairing a phone with a machine

Once per machine. `/remote` does not need to be running.

Since 2026-07-29 this is **two commands**, not a compare-and-tap. The reason:
**the dev machine decides**, not the phone. Your phone could be comparing
numbers with an attacker's phone without knowing — the hub picks who it talks
to, and it can do that entirely honestly. "Matches"/"Doesn't match" buttons on
the phone no longer decide anything, so they were removed.

1. On the dev machine, in Claude Code: `/remote pair`. It waits, and **prints no
   number of its own** — deliberately, so you cannot accidentally copy back the
   number just shown instead of actually reading your phone.
2. On the phone: open the app, tap **Ghép máy này** (Pair this machine). It
   displays a 6-digit number and a line telling you to type it into the dev
   machine.
3. Read the number **on your own phone**, then type it into the dev machine:
   ```
   /remote pair xac-nhan <the number on the phone>
   ```
4. The dev machine compares it against the number it computed independently.
   Match → device recorded, done. Mismatch → **nothing is written**, and the
   machine does not reveal the number it expected.

**A mismatch means somebody is in the middle** — do not retype it until it
matches, and do not try pairing again until you understand why. This is not a
formality: you reading the number off your own phone and typing it in — rather
than "two screens looking alike" — is the only thing protecting you from the hub
itself. The phone still has a **Huỷ** (Cancel) button, but it only tidies the
pairing queue on the hub; pressing it or not changes nothing about what the dev
machine records.

### Losing your phone

Remove it from Tailscale immediately — that is the **real kill switch**, and it
takes effect on **every dev machine at once**: out of the tailnet, a paired key
is useless because it cannot reach any `100.x.x.x` address any more.

Then tidy up: `/remote unpair <number>` on **each machine** (`/remote devices`
lists them). That is cleanup, not a kill switch — it does not propagate
anywhere, so do not treat it as equivalent to removing the device from
Tailscale.

### Clearing site data loses the key

The private key is deliberately **not backup-able** — that is exactly why
malware cannot carry it off either. So clearing the site's data, or removing the
app from your home screen and reinstalling, means **losing the key and pairing
each machine again**. A few minutes, but better known in advance.

---

## 9. When something goes wrong

| Symptom | Usual cause |
|---|---|
| `/notify` says no device is registered | Notifications were never enabled on the phone, or on iPhone the app was opened in Safari instead of from the home-screen icon |
| Phone gets no notifications | `/notify` is **off**. Turn it on with `/notify on` |
| `/remote on` says tmux is missing | Claude Code is running outside tmux. Quit, run `tmux`, then `claude` inside it |
| `/remote on` reports a Tailscale error | Tailscale is not running or not logged in. Open the Tailscale app |
| Card says the machine is not responding | The computer is asleep or off the network. **Keep it awake before you leave** |
| "Open terminal" does nothing | Tailscale is off on the phone, or phone and computer are **not on the same Tailscale account** (easy to do with two different logins) |
| Says "not paired with that machine" and stops, without retrying | This phone is **not paired** with that machine, or was just removed with `/remote unpair` — pair again (§8) |
| Web shows an old version after an update | **Remove the app from the home screen and reinstall** — the installed copy pins the old page |

No sessions listed when you are sure one is on: run `/remote` on the machine to
see what the hub sees.

---

## 10. A routine worth building

Before leaving the machine:

```
/notify on          ← so you get told
/remote on <name>   ← so you can answer from the phone
```

Remember to **keep the machine awake**. On macOS: System Settings → Lock Screen
→ "Turn display off on power adapter when inactive" → *Never*; or more simply,
open a Terminal window and run `caffeinate -dimsu`, then leave it.

The system **deliberately does not touch your machine's settings** — Mac, Linux
and Windows are all treated the same, and keeping your machine awake is your
decision to make. A sleeping machine drops the connection and the phone's card
becomes "not responding".

Back at your desk:

```
/remote off
/notify off
```

---

## 11. Removing it

Installed with the one-liner? Remove it with one:

```bash
curl -fsSL https://<your-hub>/uninstall.sh | sh
```

Installed from a git clone? Run this in the repo:

```bash
./remove-notify.sh
```

Afterwards the machine is back **exactly as it was before installing**: every
running `/remote` session stopped, every file the installer created deleted, and
directories it created removed if they are empty. Your `settings.json` is byte
for byte unchanged apart from the ccrc hook entry being taken out.

Both list what they are about to delete and **ask for confirmation**: `~/.ccrc`,
the two slash commands, and the hook entry in `~/.claude/settings.json` (only
ccrc's; your other hooks stay). Nothing else on the machine is touched, and the
repo stays where it is.

`~/.ccrc` is also where `devices.json` lives — the phones paired with **this
machine**. Removing it loses that list, so reinstalling means running
`/remote pair` again for every phone, including ones paired before.

---

## 12. Adding a new user (for whoever runs the hub)

See [`self-hosting.md`](self-hosting.md) for the full operator guide. The short
version: each person needs exactly two things and nothing else.

**1. Their own token.** On the hub machine:

```bash
./deploy.sh adduser their-name
```

It prints a token — send it **privately**, not into a group chat. The hub picks
it up within about 5 seconds; no restart needed.

**2. Their own Tailscale account.** Do not invite them to yours, do not ask to
join theirs. The free personal plan is enough.

### Why not one shared tailnet, even though it sounds simpler

| | One tailnet each | One shared tailnet |
|---|---|---|
| Phone A opens machine A's terminal | ✅ | ✅ |
| Machine A can reach machine B | ❌ no route | ✅ **it can** |
| Lost phone: revoke instantly, by yourself | ✅ remove it from your tailnet, done | ❌ go through whoever admins the shared one |
| Needs Tailscale ACL configuration | ❌ no | ✅ yes, and correctly |

The right column is not "slightly less safe" — it **takes away your own kill
switch**. Losing a phone on your own tailnet is a one-minute job you do alone.
Losing one on a shared tailnet means asking someone else and waiting, with a gap
in between.

Separate tailnets require trusting nobody and **no extra configuration** — each
person installs Tailscale on their machine and their phone, and that is it.

### What the hub sees and does not see

| The hub keeps | The hub does NOT keep |
|---|---|
| The user list and tokens | Terminal contents (not one byte) |
| Which sessions are open, machine names, session names | Directory names, paths |
| A phone's public key — for exactly 5 minutes during pairing, then deleted (not a secret) | Any phone's private key — the only thing that opens a session |
| Recent notifications (in RAM) | What Claude is asking |

The hub runs **ephemeral** — restarting loses the session list and notification
history. That is the design, not a bug: everyone just runs `/remote on` again.
