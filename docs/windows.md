# CC Remote Control on Windows

This replaces sections 3 and 6 of [`user-guide.md`](user-guide.md). Everything else there —
the phone, the Notify half, privacy, uninstalling — works the same on all three platforms.

A more detailed Vietnamese version lives at [`huong-dan-windows.md`](huong-dan-windows.md),
including a step-by-step manual install ([`cai-thu-cong-windows.md`](cai-thu-cong-windows.md)).

---

## 1. The one difference that changes everything

On macOS and Linux, `/remote` attaches to a **tmux pane that already exists**. You can open
Claude Code, work for an hour, then decide you want it on your phone — and the phone sees
the history from before that decision.

Windows has no tmux and nothing equivalent, so the design is inverted: **`ccrc` builds its
own terminal (a ConPTY) and runs Claude Code inside it.**

| | macOS / Linux | Windows |
|---|---|---|
| Turn on remote for a session already running | yes | **no** — must be opened with `ccrc` |
| Scroll back | tmux's full scrollback | only to when the session started |
| Extra software needed | `tmux` | none |
| Closing the window | session survives | session survives |

**The habit to change:** on Windows, type `ccrc` instead of `claude` **from the start**,
even when you have no intention of using your phone. Open with plain `claude` and change
your mind later, and there is no way back — you have to quit and reopen.

## 2. Install

```powershell
$env:CCRC_HUB_URL='https://<your-hub>'; irm https://<your-hub>/install.ps1 | iex
```

`CCRC_HUB_URL` is required, for the same reason `install.sh` requires it: a script read
from a pipe has no way to know where it was downloaded from. Leave it out and the command
stops immediately rather than installing half of something. This project runs no shared
hub — every team runs its own ([`self-hosting.md`](self-hosting.md)) — so there is no
sensible default to fill in.

It asks for a machine name (the label your phone shows next to notifications and
sessions), then installs to:

| Path | What |
|---|---|
| `%USERPROFILE%\.local\share\ccrc` | the code |
| `%USERPROFILE%\.ccrc\config` | hub, token, machine name — ACL'd to you only |
| `%USERPROFILE%\.ccrc\hosts` | session records, including the named-pipe secret |
| `%USERPROFILE%\.claude\commands\` | the `/notify` and `/remote` commands |
| `%USERPROFILE%\.claude\settings.json` | **one** hook entry added, file not replaced |
| next to `claude.exe` | the `ccrc` command |

Nothing else is touched: no service is installed, no registry key is written, and your
PATH is left alone (the installer prints the `setx` line if it needs one).

> **Why `irm | iex` and not a `.ps1` file.** Windows ships with `ExecutionPolicy` set to
> `Restricted`, which blocks running script *files* but not `Invoke-Expression` on a
> string. So the one-liner works without asking you to lower your machine's security
> policy to install something — which would be a bad trade for a convenience.

Uninstall:

```powershell
irm https://<your-hub>/uninstall.ps1 | iex
```

It asks before deleting, stops every running session **before** removing the directory
that records them, and leaves your `settings.json` byte-identical to how it was before
you installed — the hook entry goes, nothing else does.

## 3. The `ccrc` command

Three forms, and only three:

| Command | What it does |
|---|---|
| `ccrc` | open a new Claude Code session |
| `ccrc list` | list running sessions |
| `ccrc attach <id>` | reopen a window onto a running session |

`ccrc` prints the session's label as it starts:

```
[ccrc] phiên k7m2 — đóng cửa sổ không làm phiên chết; `ccrc attach k7m2` để vào lại.
```

The alphabet deliberately omits `i l o 0 1`, because you read that label off the screen
and type it back.

> **Claude Code's own flags do not pass through `ccrc`.** `ccrc -p …`, `ccrc --help` and
> the like will not work — run `claude …` directly for those (that session will not have
> `/remote`). The host runs `claude` with no arguments, and forwarding arbitrary arguments
> would mean hand-building a `cmd.exe` command line, which is the exact class of bug this
> project avoids everywhere else.

## 4. Closing the window does not end the session

This surprises people, and it is deliberate. The session is held by a **background host**
started detached from the window that launched it. Closing the window closes only the
view: Claude Code keeps running, keeps working, and your phone keeps seeing it.

To get back in: `ccrc list` for the id, then `ccrc attach <id>`.

To actually **end** a session, quit Claude Code from inside it as usual. Closing the
window is not a way to stop anything — which also means a forgotten session runs forever.
`ccrc list` is where you notice that.

In Task Manager you will see a `node.exe` and a `conhost.exe` per session. That is normal:
the `conhost` runs in `--headless` mode as the terminal's pseudoconsole, not as a hidden
window.

## 5. Turning remote on

Inside a `ccrc` session:

```
/remote on my-label
```

The label is what your phone shows. It is optional — without one you get a random id — but
with two or three sessions open, unlabelled cards look identical.

It prints a `http://100.x.y.z:<port>/` URL. Open that on your phone, on the same Tailscale
network.

```
/remote off
```

On Windows `off` **rejects** unsupported flags rather than quietly doing something else:

```
✗ `off` không nhận tham số nào — nhận được: --pane xxx
```

That is not fussiness. The same bug on macOS once turned off a different session from the
one the user was sitting in, and printed success while doing it.

## 6. Changing the machine name

Set during install; change it any time without reinstalling:

```powershell
node "$env:USERPROFILE\.local\share\ccrc\tools\setup-notify-win.mjs"
```

Press Enter to keep the current name. Or set it outright:

```powershell
$env:CCRC_MACHINE_NAME='Work desktop'; node "$env:USERPROFILE\.local\share\ccrc\tools\setup-notify-win.mjs"
```

The default is `%COMPUTERNAME%`, usually something like `DESKTOP-A1B2C3D` — useless once
you have more than one machine, so it is worth changing.

## 7. Troubleshooting

### `npm.ps1 cannot be loaded because running scripts is disabled`

You typed `npm`. Under PowerShell that resolves to `npm.ps1`, which the default
`Restricted` policy blocks. Type **`npm.cmd`** instead. Inside `cmd.exe`, plain `npm` is
fine.

### `[term] Không tìm thấy Tailscale trên máy này`

Either Tailscale is not installed, or `tailscale.exe` is not on the *daemon's* PATH — the
daemon is spawned by Claude Code, so its PATH is not necessarily the one you see in
PowerShell. Check:

```powershell
where.exe tailscale
tailscale status
```

If it is installed but not found, point at it directly:

```powershell
$env:CCRC_TAILSCALE_BIN='C:\Program Files\Tailscale\tailscale.exe'
```

### `ccrc` not found after installing

PATH is read when a window opens. **Open a new PowerShell window.** If it still is not
found, check where the command landed: `where.exe ccrc` and `where.exe claude` — the
installer puts `ccrc.cmd` next to `claude.exe`, and prints the `setx` line to run if that
directory is not on PATH.

### The phone sits on "reconnecting"

In order: is the phone on the same Tailscale network; is the computer asleep (**a sleeping
machine drops the connection**); is the session still alive (`ccrc list`).

### Bare `/remote` mentions tmux

```
Remote (phiên này): không xác định — không chạy trong tmux.
```

Leftover wording from the macOS path. The `Hub:` and `Phiên:` lines below it are correct
and are the ones to read.

## 8. What Windows does not have yet

Said plainly, so you do not go looking:

- **No attaching to an already-running Claude Code session.** Open with `ccrc` from the start.
- **Scrollback only reaches to the start of the session.** Attach your phone to a session
  that has been running for hours and you will not see what came before you attached.
- **Claude Code's own flags do not pass through `ccrc`.**
- **Push notifications from Windows have not been exercised end to end.** The hook installs
  and its tests pass on Windows, which is not the same as a notification arriving on a phone.
- **The English guides stop here.** The Vietnamese
  [`huong-dan-windows.md`](huong-dan-windows.md) is the fuller version.
