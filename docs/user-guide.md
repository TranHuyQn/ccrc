# CC Remote Control — user guide

For new users. About 10 minutes to read, about 15 to set up.

Running the hub yourself? [`self-hosting.md`](self-hosting.md) instead.

> 🇻🇳 Bản tiếng Việt: [`huong-dan.md`](huong-dan.md)

> **`<your-hub>` in this guide is a blank to fill in, not a real address.**
> Replace it with your team's hub domain — whoever set the hub up will tell you,
> something like `ccrc.yourcompany.com`. Every team runs its own hub: this project
> operates no shared service, so there is no default to pre-fill.
>
> Leave the angle brackets in and the command will fail — drop them too.

---

## 1. What this does

You run Claude Code on your computer. Claude works for a while, then **stops and waits for
you** — it asks a question, or wants permission to run something. If you happen to be making
coffee, it just sits there.

Two independent halves:

**1. Notify.** Claude stops and waits → your phone buzzes.

**2. Answer from your phone.** A web terminal wired to the exact Claude session that is
waiting. Read it, type into it, answer — then put the phone away.

It is **not** screen mirroring and **not** a chat bot. Each web terminal is bound to one tmux
pane and never opens a window of its own.

### The two halves need different things

| | Notify (part 1) | Web terminal (part 2) |
|---|---|---|
| Needs Tailscale | ❌ no | ✅ **required**, on both computer and phone |
| Needs tmux | ❌ no | ✅ **required** |
| Path the data takes | your machine → hub → your phone | your machine → **straight to** your phone |

So: **you can use part 1 today** without Tailscale and without knowing tmux. Part 2 can wait.

---

## 2. What you need

- **Node.js** (any supported version)
- **Claude Code**, working on your machine
- **A company Slack account** — you sign in yourself; nobody has to issue you a token
- **A phone**, iPhone or Android
- *(part 2 only)* **tmux**, and **Tailscale** — **your own account**, not shared with anyone.
  Section 6 explains why.

---

## 3. Install on your computer

### The quick way — one command

```bash
curl -fsSL https://<your-hub>/install.sh | CCRC_HUB_URL=https://<your-hub> sh
```

No token, no git, no repository access — the command fetches the code itself.

**Why the hub address appears twice:** the first one downloads the script, the second tells
the script which hub it serves. It reads as redundant, but a script running on your machine
has no way to know where it was downloaded from. Drop `CCRC_HUB_URL=` and it stops
immediately with `✗ Thiếu URL hub.` — deliberately, because guessing a hub means sending your
token to the wrong place.

It prints an **8-character code** and waits:

```
  Duyệt mã này trong app CC Notify trên điện thoại:
  thẻ "Duyệt máy dev" → Mở → nhập mã.
  Chưa cài app thì mở https://<your-hub>/link trên trình duyệt đã đăng nhập.

      K7M2-QX9F

  Đang chờ duyệt (tối đa 600 giây)…
```

**The fastest way to approve is inside the app on your phone** — no browser needed:

1. Open the CC Notify app
2. Find the **Duyệt máy dev** ("Approve dev machine") card → tap **Mở** ("Open")
3. Type the code, tap **Duyệt** ("Approve")

The terminal picks up the token within seconds and prints who approved it:

```
  ✓ Đã nhận token của sam-lee.
```

**Read that name.** If it is not you, somebody else just approved your code — this machine has
written *their* token. Run `curl -fsSL https://<your-hub>/uninstall.sh | sh` and install again.

**The `/link` page still exists** for approving from a desktop browser. But if you installed
the app to your home screen, do not go that way: the installed app and the browser are **two
separate sign-in sessions** (iOS keeps their cookies apart), so opening `/link` in Safari will
ask you to sign in from scratch. Approving in the app is the whole job.

Then it asks for a **machine name** (the one that shows up in notifications). If a suggestion
appears in square brackets, Enter accepts it. **Not every machine gets a suggestion:** on a
machine whose hostname is its IP address (`hostname` prints `192.168.x.x`) the script throws
the suggestion away — a name made of digits tells one machine from another exactly not at all
— and a bare Enter will just ask again. Type something you will recognise, like `Sam's
MacBook`.

Want to read the script before running it? Entirely reasonable — it runs on your machine:

```bash
curl -fsSL https://<your-hub>/install.sh -o install.sh
less install.sh
CCRC_HUB_URL=https://<your-hub> sh install.sh
```

**Can't sign in with Slack?** Ask whoever runs the hub for a token, then:

```bash
curl -fsSL https://<your-hub>/install.sh | sh -s -- <your-token> https://<your-hub>
```

With a token, the script skips the short-code step entirely. The hub address goes after the
token — same reason as above, the script cannot see where it came from.

**This command touches exactly five places, nothing else:**

| Place | What |
|---|---|
| `~/.local/share/ccrc` | The code |
| `~/.ccrc/config` | Hub URL, token, machine name (chmod 600) |
| `~/.claude/commands/` | Two slash commands, `/notify` and `/remote` |
| `~/.claude/settings.json` | **One added** hook entry — your existing hooks are left alone |
| next to the `claude` binary | The `ccrc` command (see section 6) |

Remove all of it whenever you like:

```bash
curl -fsSL https://<your-hub>/uninstall.sh | sh
```

### The other way — from a git clone

If you have the repository on your machine, run this inside it:

```bash
./setup-notify.sh
```

It asks:

| Question | Answer |
|---|---|
| Hub URL | `https://<your-hub>` |
| Machine name shown in notifications | something you recognise, e.g. `Sam's MacBook` |

It does **not** ask about the token — it prints the same 8-character code and waits for you to
approve it in the app (or at `/link`). A machine that was set up before reuses its existing
token and is not asked to approve again.

Then it will:

- write `~/.ccrc/config` (chmod 600 — only you can read it)
- install the `/notify` and `/remote` slash commands
- install the `Notification` hook into Claude Code
- leave notifications **OFF** (on purpose — you turn them on when you are about to walk away)

**What the machine name is for:** it appears in notifications and on the terminal card. With
several machines running, it is how you tell them apart.

---

## 4. Install on your phone

### iPhone

1. Open **Safari** (it has to be Safari, not Chrome) and go to `https://<your-hub>`
2. Share button → **Add to Home Screen**
3. **Open the app from the new icon** — not from Safari again
4. Tap **Đăng nhập bằng Slack** ("Sign in with Slack")
5. Tap **Bật thông báo trên thiết bị này** ("Enable notifications on this device") and allow
   when iOS asks

⚠️ **Steps 2 and 3 are requirements, not suggestions.** iOS only allows push notifications for
a web app that was added to the home screen and opened from there. Open it in Safari and the
enable-notifications button will not work.

### Android

Chrome → go to `https://<your-hub>` → Chrome offers to install the app → **sign in with
Slack** → enable notifications. Installing is optional but nicer.

### What signing in with Slack does

The hub asks Slack who you are, then issues you a token of its own. **The hub never holds your
Slack password or anything that could open your Slack account** — all it receives back is a
name.

Signing in again on another device returns **the same token**, so your phone and your dev
machines never fight each other. Changing your Slack display name costs you nothing either:
the hub keys off your Slack id, not your name.

### The app and the browser are separate sign-ins

Signing in inside the app does **not** count for Safari, and vice versa — iOS keeps an
installed web app's cookies entirely apart from the browser's. So do not be surprised when
`https://<your-hub>` in Safari shows a sign-in screen while the app has you signed in.

Signing in in both places is **harmless**: the hub keys off your Slack id, so it hands back
**the same token** rather than issuing a new one. You just do not need to — everything
day-to-day, approving a dev machine included, works inside the app.

### Check it worked

Back on the computer, run `/notify`. It must report **1 device**. If it warns that no device
is registered, enabling notifications on the phone did not take — redo section 4.

---

## 5. Day to day — the Notify half

Type in Claude Code:

| Command | What it does |
|---|---|
| `/notify on` | Turn notifications on. Do this when you are about to leave the machine. |
| `/notify off` | Turn them off. |
| `/notify` | Status: on or off, whether the hub is alive, how many devices are registered. |

**Off by default is deliberate.** Sitting right in front of the machine while your phone buzzes
is worse than useless.

You get a notification when:

- 🔔 Claude is waiting for input
- 🔐 Claude needs confirmation (a question, or permission to run a tool)

**The work itself is never sent.** A notification carries the machine name, the session name,
and one of those two lines. It says *"something needs you"*, never *what*.

---

## 6. Day to day — the web terminal

### Requirements

Claude Code has to be **running inside tmux**. You do not need to know what tmux is — the
installer set up `ccrc` for you:

```bash
ccrc            # instead of `claude`
```

`ccrc` behaves **exactly** like `claude`: same arguments (`ccrc --continue`, `ccrc -p "..."`,
…), it just opens tmux for you. Quit Claude and the tmux session goes with it, leaving nothing
behind.

If tmux is missing, the first `ccrc` offers to install it. Saying no is fine — Claude opens
normally, that session just cannot use `/remote`.

Already comfortable with tmux? The old way still works:

```bash
tmux
claude
```

Running `ccrc` while already inside a tmux session is fine too: it runs right there in that
pane without nesting another session. When Claude exits it **turns `/remote` off for that
pane** — the terminal on your phone closes with it, so nobody can type into the shell that
just appeared.

### Tailscale — one account per person

**Create your own Tailscale account** (the free personal plan is enough), then install it on
**your computer** and **your phone**. Those two devices only. Do not join the admin's tailnet,
and do not invite anyone into yours.

That sounds backwards — same system, but everyone on their own network, so how does anything
connect? The answer: **nothing needs to connect across people.** Terminal content only ever
travels from your machine to your phone. No traffic ever needs to run between your machine and
someone else's. The one shared thing is the hub (`<your-hub>`) — it lives on the public
internet and **needs no Tailscale at all**.

**Why separate accounts matter, beyond tidiness:**

Since 2026-07-29 the hub holds no key that can open your session — the phone signs its own
requests and the dev machine verifies them with a key it learned during pairing (details in
section 8). But the reason for a private Tailscale account is unchanged, just relocated: it is
**your own kill switch**. Removing your phone from your tailnet removes the only route it has
to your machine's `100.x.x.x` address — instantly, across every dev machine you ever paired it
with.

Share one tailnet and that switch stops being yours: removing a device from a shared tailnet
touches everybody's routing, not just yours, and it goes through whoever administers that
tailnet instead of being something you can do right now.

*(This is decision D2b in the design, settled at the start of the project — the original
reasoning changed when the hub stopped holding keys, but the conclusion did not.)*

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

`k7m2` is a **random id**. Give it a readable name if you prefer:

```
/remote on payments-api
```

→ the phone shows `payments-api` instead of `k7m2`.

**Why the default is a random id:** this label sits on your lock screen and in every screenshot
you send anyone. It used to be the directory name — which names the project, and sometimes
names the client. What has been seen cannot be unseen, so the directory name **never leaves
your machine** any more.

### Other commands

| Command | What it does |
|---|---|
| `/remote` | List all your open sessions, marking the current one |
| `/remote off` | Close the session for **this pane**, leaving others alone |
| `/remote pair` | Start pairing a phone with **this machine** — see section 8 |
| `/remote pair xac-nhan <number>` | Step two: type the number you read ON THE PHONE so this machine records the device — see section 8 |
| `/remote devices` | List phones paired with this machine |
| `/remote unpair <number>` | Remove a paired phone — this machine only, see section 8 |

**Several sessions at once** is fine — one `/remote on` per Claude pane, and the phone shows
them as a list of cards.

### Opening it on the phone

Open the app → the **TERMINAL** section → tap **Mở terminal** ("Open terminal") on the card.

---

## 7. What's on the terminal screen

```
┌──────────────────────────────────────┐
│ đã nối                               │  ← connection status
│                                      │
│  (your Claude session)               │
│                                      │
├──────────────────────────────────────┤
│ Esc  ↑  ↓  ←  →  ⏎  Tab  ⇧Tab  ^C   │  ← key bar
├──────────────────────────────────────┤
│ [ Nhắn cho Claude…            ] Gửi  │  ← compose box
└──────────────────────────────────────┘
```

**The compose box** is where you type your answer. Accented text works normally. When you are
done, tap **Gửi** ("Send"). Enter inside the compose box is a **newline**, not send; to send
several lines, type them all and tap Gửi once — the whole block arrives intact.

**The key bar** drives the interface:

| Key | Use it when |
|---|---|
| `↑` `↓` | Moving through one of Claude's option lists |
| `←` `→` | Moving the cursor |
| `⏎` | Confirming a selection |
| `Tab` / `⇧Tab` | Next / previous option |
| `Esc` | Cancel |
| `^C` | Stop whatever Claude is running |

**Scrolling back:** drag down inside the terminal area to see what scrolled past, drag up to
return to the present. While you are reading the past, new output is **kept, not lost** — you
will see all of it when you come back. Pressing any key also jumps back to the present.

**Buttons inside the terminal are tappable:** Claude Code draws some buttons in the screen
itself (`Jump to bottom`, option lists…). Tap them directly — a quick tap counts as a click, a
drag counts as scrolling, a long press counts as selecting text.

**Copying:** long-press on text to select, then Copy as usual.

**Prompt icons** (separators, folder, git, clock…) render exactly as they do on your machine —
a Nerd Font icon set ships with the page. That file is 2.4 MB but is **downloaded once per
device** and then cached permanently, and only when the screen actually contains icons. The
first terminal you open over mobile data may show icons a few seconds after the text — never
again after that.

The terminal is **display-only** and does not take keystrokes directly — everything you type
goes through the compose box or the key bar. This is deliberate: a virtual keyboard popping up
unbidden is the single most irritating bug on mobile, and this design means it cannot happen.

---

## 8. Privacy — what goes where

| Thing | Does it leave your machine? |
|---|---|
| Terminal content | ✅ but **straight to your phone** over Tailscale; the hub never sees a byte |
| Directory names / paths | ❌ **never** |
| The content of Claude's question | ❌ no — the notification only says "something needs you" |
| Machine name, session name you chose | ✅ yes, shown in notifications and on the terminal card |
| The private key — the only thing that opens a session | ❌ **never leaves your phone**, not even during pairing |

The hub keeps only: who you are, which sessions are open, and — for exactly five minutes while
you pair a phone — that phone's **public key**, then deletes it. A public key is not a secret:
that is what asymmetric cryptography means, it verifies signatures and cannot produce them, so
on its own it opens nothing. What opens a session is the private key, and the private key never
leaves your phone. The hub keeps **no** conversation history. Restart the hub and the session
list is gone — `/remote on` again and you are back.

The terminal runs **plain HTTP** over the Tailscale IP, no HTTPS. That is **deliberate**: the
link is already encrypted by Tailscale, while requesting an HTTPS certificate would write your
machine's name into a Certificate Transparency log — a public, permanent, **unerasable**
ledger.

While you have a session's terminal open on your phone, that session **sends no notifications**
(you are already looking at it; buzzing would be noise). Lock the screen or switch apps and
they resume immediately.

### Can other people on the same hub see your stuff?

No. The hub partitions by user: session lists, in-progress pairings, the devices that receive
notifications — each is tied to your token, and someone else's token cannot ask for yours.

### Can whoever runs the hub watch your session?

No — and since 2026-07-29 that is a technical fact rather than a promise.

**The hub holds no key that opens your session.** Your phone signs each request to open a
terminal with a private key that lives inside it, and the dev machine verifies that with a
public key it learned exactly once — when you paired. The hub only relays a few strings during
pairing, and it **chooses which phone it is talking to** — which is why the thing protecting
you is not "swapped strings would show up" (a hub can redirect an entire pairing to an
attacker's phone perfectly honestly, swapping nothing), but this: **you read a number off your
own phone and type it into your dev machine, and the dev machine refuses every other number.**
See "Pairing a phone with a machine" just below.

What the hub does know: which of your machines has which session open, the session names you
chose, the Tailscale address, and the moment Claude stopped to wait for you each time.

One last thing worth saying plainly: **the hub serves this web page.** Whoever controls the hub
can push malicious code to your phone. The private key is stored non-exportable, so that code
cannot carry the key away — it could only sign on your behalf while the page is open, and doing
so leaves an auditable trace. That is the boundary of the design; better to know it up front.

### Pairing a phone with a machine

Once per machine. `/remote` does not need to be on.

Since 2026-07-29 this is **two commands**, not one compare-and-tap as before. The reason: **the
dev machine is the one that decides**, not the phone. Your phone may be comparing numbers with
an attacker's phone without knowing it — the hub picks who it talks to, and it can do that
perfectly honestly. A "Match"/"No match" pair of buttons on the phone is no longer trustworthy
enough to decide anything, so they were removed.

1. On the dev machine, in Claude Code: `/remote pair`. It waits, and **prints no number of its
   own** — deliberately, so you cannot accidentally copy back the number in front of you
   instead of actually reading the phone.
2. On the phone: open the app, tap **Ghép máy này** ("Pair this machine"). The phone shows a
   6-digit number and a line telling you to type it into the dev machine.
3. Read the number **off your own phone**, then type it on the dev machine:
   ```
   /remote pair xac-nhan <the number on the phone>
   ```
4. The dev machine compares what you typed against what it computed. Match → device recorded,
   done. Mismatch → **nothing is recorded**, and the machine does not reveal the number it
   expected.

**A mismatch means somebody is in the middle** — do not retype until it matches, and do not try
pairing again until you understand why. This is not ceremony: you personally reading the number
off your own phone and typing it into your machine — not "the two screens look alike" — is the
only thing protecting you from the hub itself. The phone still has a **Huỷ** ("Cancel") button,
but it only tidies the pairing queue on the hub; pressing it or not changes nothing about what
the dev machine records.

### Losing your phone

Remove it from Tailscale immediately — that is the **real kill switch**, and it takes effect on
**every dev machine at once**: out of the tailnet, a paired key is useless, because there is no
longer any way to reach a `100.x.x.x` address.

Then tidy up: `/remote unpair <number>` on **each machine** (`/remote devices` lists them). That
is housekeeping, not a kill switch — it does not propagate anywhere, so do not treat it as
equivalent to removing the device from Tailscale.

### Clearing site data loses the key

The private key is deliberately **impossible to back up** — that is why malicious code cannot
carry it off either. So clearing the site's data, or removing the app from your home screen and
reinstalling it, means **losing the key and pairing every machine again**. A few minutes, but
better known in advance than discovered in a panic.

---

## 9. Troubleshooting

| Symptom | Usual cause |
|---|---|
| The installer prints a code then says **"Mã đã hết hạn"** (code expired) | Codes live 10 minutes. Also happens if you hit Ctrl-C partway and approve afterwards — that approval is spent. Run the installer again for a fresh code |
| The installer says **"Hết thời gian chờ duyệt"** (approval timed out) | Nobody approved within 10 minutes. Run it again with the **Duyệt máy dev** card already open in the app |
| Approval worked but the printed name **is not you** | Somebody else typed your code. Uninstall and reinstall — this machine is holding their token |
| `/link` shows a sign-in screen | That browser is not signed in — the installed app and the browser are separate sessions. Approve in the app instead, or sign in with Slack right there (it returns you to the code box) |
| No **Đăng nhập bằng Slack** button | The hub has no Slack sign-in configured — use the paste-a-token box and tell whoever runs the hub (section 12) |
| Slack button then **"Phiên đăng nhập hết hạn"** (sign-in expired) | The callback link was opened twice, or more than 5 minutes passed between the tap and Slack's response. Start the sign-in again |
| `/notify` says no device is registered | Notifications were never enabled on the phone, or the iPhone opened it in Safari instead of from the home-screen icon |
| The phone gets no notifications | First: is `/notify` **off**? Turn it on with `/notify on`. Still silent, but other machines or an Android phone do get through and **only iPhones do not** → it is the hub's side: whoever runs it has not set `CCRC_VAPID_SUBJECT` (section 12). That failure shows no sign at all — `/notify` still reports the push as sent, and the app still lists the device as subscribed — so do not uninstall and reinstall the app: it fixes nothing and loses your pairing key |
| `/remote on` cannot find tmux | Claude Code is running outside tmux. Quit, run `tmux`, then run `claude` inside it |
| `/remote on` reports a Tailscale error | Tailscale is not running or not signed in. Open the Tailscale app |
| A card says the machine is not responding, possibly asleep | The computer slept or lost the network. **Stop it sleeping before you walk away** |
| "Open terminal" does not connect | Tailscale is off on the phone, or the phone and the computer are **not on your same Tailscale account** (e.g. two different accounts by mistake) |
| It says the device is not paired with that machine, then sits there without retrying | This phone is **not paired** with that machine, or was just removed with `/remote unpair` — pair again with `/remote pair` (section 8) |
| The web shows an old version after an update | Swipe the app fully closed in the app switcher and reopen it. **Do not uninstall and reinstall** — that fixes nothing and destroys your pairing key. Still stale? That is a hub-side mistake: whoever deployed forgot to bump `?v=` |

If no session appears and you are sure one is on, run `/remote` on the machine to see what the
hub thinks.

---

## 10. Habits worth building

Before you leave the machine:

```
/notify on          ← so you get told
/remote on <name>   ← so you can answer from the phone
```

Remember to **stop the machine sleeping**. On macOS: System Settings → Lock Screen → set "Turn
display off on power adapter when inactive" to *Never*; or more simply, open a Terminal window
and leave `caffeinate -dimsu` running.

The system **deliberately never touches your machine's settings** — Mac, Linux and Windows are
all treated the same, and keeping your machine awake is a decision that should be yours. A
sleeping machine drops the connection and the card on your phone turns into "not responding".

Back at your desk:

```
/remote off
/notify off
```

---

## 11. Uninstalling

Installed with the one-liner? Remove it with one too:

```bash
curl -fsSL https://<your-hub>/uninstall.sh | sh
```

Installed from a git clone? Run this inside the repository:

```bash
./remove-notify.sh
```

Afterwards the machine is back in **exactly the state it was in before installing**: every
running `/remote` session is stopped, every file the installer created is deleted, and the
directories it created are cleaned up if they are empty. Your `settings.json` is preserved byte
for byte — only the ccrc hook entry is lifted out.

Both list what they are about to delete and **ask for confirmation** first: `~/.ccrc`, the two
slash commands, and the hook entry in `~/.claude/settings.json` (the ccrc entry only; your
other hooks are untouched). Nothing else on the machine is touched, and the repository stays
where it is.

`~/.ccrc` is also where `devices.json` lives — the list of phones paired with **this machine**.
Uninstalling loses that list; reinstalling means running `/remote pair` again for every phone,
including ones paired long ago.

---

## 12. Adding new users (for whoever runs the hub)

**You no longer hand out tokens.** Anyone who can sign in to the company Slack can install by
themselves: open `https://<your-hub>`, sign in with Slack, then run the one-line installer from
section 3. The hub creates their account on first sign-in.

The one thing the new person must do, and you cannot do for them: **their own Tailscale
account.** Do not invite them into yours, and do not ask to be invited into theirs. The free
personal plan is enough.

### When someone leaves

⚠️ **The hub does not know who left.** It never asks Slack again after the first sign-in, so a
departed colleague's token **keeps working until you revoke it by hand**:

```bash
./deploy.sh deluser display-name        # or the Slack id
```

If that matches several people the command **deletes nothing** and lists them so you can retry
with a Slack id — deleting the wrong person costs them their push subscriptions, their history
and their open sessions.

This belongs on your off-boarding checklist. Disabling the Slack account blocks **new sign-ins**
but does nothing about a token already sitting on their laptop.

### People who do not use Slack

You can still issue tokens by hand — for automation, contractors, shared accounts:

```bash
./deploy.sh adduser their-name
```

It prints a token — send it to them **privately**, not into a group chat. The hub picks it up
within about 5 seconds, no restart needed. They install with the token form from section 3.

### ⚠ Anyone on an iPhone: you must set `CCRC_VAPID_SUBJECT`

This is the only setting that, left wrong, gives **nobody on the team anything to see** —
including you. The hub attaches this contact to every push it sends, and Apple checks it far
more strictly than Google: a contact it cannot route — the hub's own default
`mailto:admin@localhost` included — gets `403 BadJwtToken` for **every** push, permanently.
From the outside:

- `/notify` still reports the notification as sent
- the app still shows the iPhone as **subscribed to notifications**
- Android and Firefox users on the same hub keep receiving normally — so if you test on
  Android, you will conclude the hub is fine

Put the hub's public domain in `.env`:

```
CCRC_VAPID_SUBJECT=https://<your-hub>
```

then **recreate** the container (`./deploy.sh` — `docker restart` does not pick up a new
variable). Verify:

```bash
docker compose -p cc-remote-control exec hub printenv CCRC_VAPID_SUBJECT
docker compose -p cc-remote-control logs --tail=50 hub | grep -i vapid
```

The first must print your domain; the second must print no warning. Changing this value does
not affect existing subscriptions — **nobody has to reinstall the app or re-enable
notifications.**

Running the hub under systemd instead of Docker? `.env` is not read at all: set the variable
in the unit file (`deploy/ccrc-hub.service` ships with the line to edit).

### Turning on Slack sign-in

**Both** variables are needed in `.env`; with only one, the feature is off entirely and the PWA
falls back to the paste-a-token box:

| Variable | Value |
|---|---|
| `CCRC_TS_PUBLIC_URL` | The identity service's public URL — the browser is redirected here |
| `CCRC_TS_INTERNAL_URL` | Its URL inside the docker network — the hub calls this itself, never leaving the host |

On the identity service, set `CCRC_CALLBACK_URL` to point back at the hub, e.g.
`https://<your-hub>/auth/callback`.

### Why not one shared tailnet — even though it sounds simpler

| | One tailnet per person | One shared tailnet |
|---|---|---|
| Phone A opens machine A's terminal | ✅ | ✅ |
| Machine A can reach machine B | ❌ no route | ✅ **it can** |
| Lost phone: revoke immediately, your call alone | ✅ remove it from your tailnet, done | ❌ go through whoever runs the shared tailnet |
| Tailscale ACLs to configure | ❌ none | ✅ required, and required to be correct |

The right-hand column is not "slightly less safe" — it **takes away your own kill switch**.
Losing a phone on a private tailnet is your problem alone and is over in a minute. Losing one on
a shared tailnet means asking someone else and waiting, with a gap in between.

Private tailnets require trusting nobody and **no extra configuration at all** — each person
installs Tailscale on their machine and their phone, and that is the whole setup.

### What the hub sees and does not see

| The hub keeps | The hub does NOT keep |
|---|---|
| The user list and their tokens | Terminal content (not one byte) |
| Which sessions are open, machine names, session names | Directory names, paths |
| A phone's public key — for exactly 5 minutes during pairing, then deleted (not a secret) | Any phone's private key — the only thing that opens a session |
| The time of each session's most recent notification — one number | **What the notification said.** Title and body pass through the hub on their way out and are forgotten immediately; they are not stored anywhere |

That last row used to read the other way round: the hub kept your 50 most recent
notifications, real titles and bodies, so the PWA could draw the "unread" dot on a session
card. That dot asks exactly one question — "has anything happened in this session since I last
looked?" — so the hub now keeps just that answer, one number per session, and forgets the rest.
Whoever can read the hub's data still cannot read what Claude asked.

The hub runs **ephemeral** — restart it and the session list is gone. That is the design, not a
fault: everyone just runs `/remote on` again.
