// Every tmux call the daemon makes goes through here, for two reasons learned
// the hard way on the previous direction:
//
//  1. `tmux` is not on the minimal PATH some background launchers provide, so
//     resolving the binary is not optional.
//  2. `tmux display-message` exits 0 with EMPTY output for a dead pane. Asking
//     "does this pane exist?" and treating exit 0 as yes reports every dead
//     pane as alive. We make the pane state its own id and compare.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/home/linuxbrew/.linuxbrew/bin/tmux',
  '/opt/local/bin/tmux',
  '/usr/bin/tmux',
];

let cached = null;

export function tmuxBin() {
  if (cached) return cached;
  if (process.env.CCRC_TMUX_BIN) return (cached = process.env.CCRC_TMUX_BIN);
  try {
    const found = execFileSync('command', ['-v', 'tmux'], { encoding: 'utf8', shell: true }).trim();
    if (found) return (cached = found);
  } catch { /* fall through to the fixed list */ }
  for (const p of CANDIDATES) if (fs.existsSync(p)) return (cached = p);
  throw new Error('Không tìm thấy tmux. Đặt CCRC_TMUX_BIN trỏ tới nó.');
}

function tmux(args) {
  return execFileSync(tmuxBin(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function currentPane(env = process.env) {
  const p = env.TMUX_PANE;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

export function paneAlive(paneId) {
  if (typeof paneId !== 'string' || !paneId) return false;
  try {
    // The pane must report its OWN id back. A dead pane yields empty output
    // with exit 0, which would otherwise read as success.
    return tmux(['display-message', '-p', '-t', paneId, '#{pane_id}']).trim() === paneId;
  } catch {
    return false;
  }
}

export function paneSession(paneId) {
  if (!paneAlive(paneId)) return null;
  try {
    const s = tmux(['display-message', '-p', '-t', paneId, '#{session_name}']).trim();
    return s || null;
  } catch {
    return null;
  }
}

// The pane's working directory, in full.
//
// There used to be a paneLabel() beside this that reduced the same value to
// its basename and shipped it to the hub as the session's label. That was the
// privacy leak: on a lock screen and in every screenshot it named the
// project. It is deleted rather than left unused — a helper that turns a path
// into a display label is exactly the thing someone wires back up later.
//
// This value NEVER leaves the machine. It is the key the notification hook
// matches its own `cwd` against in the local session registry, so a
// notification can carry the same session name the phone shows on the
// terminal card. Sending it anywhere would reintroduce exactly the leak that
// registry exists to close.
export function paneCwd(paneId) {
  if (!paneAlive(paneId)) return '';
  try {
    const raw = tmux(['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

// Which tmux SERVER this pane lives on, as its socket path.
//
// Pane ids (`%3`) are unique only inside one server, so the notification hook
// needs this beside the pane id to be sure the session it found is the one it
// is running in (shared/session-registry.js findByPane).
//
// Asked of tmux, not read from the daemon's own $TMUX: the daemon is not
// always started from inside the pane it watches — `ccrc remote` runs the CLI
// from an ordinary shell and hands it `--pane`, and that shell may have no
// $TMUX at all. The environment answers "where was I started", which is a
// different question from "which server owns this pane", and the two come
// apart on exactly the path this project's own launcher uses.
// paneAlive() first, and not for tidiness: `display-message -t <pane không có
// thật>` exits 0 and prints the socket of the DEFAULT server anyway (đo
// 2026-08-15, tmux 3.7b) — the same "exit 0 means yes" trap this file opens by
// warning about. Without the check, a pane on another server would be recorded
// under this one's socket, which is the exact confusion the field exists to
// prevent.
export function paneSocket(paneId) {
  if (!paneAlive(paneId)) return '';
  try {
    const raw = tmux(['display-message', '-p', '-t', paneId, '#{socket_path}']);
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

// Every pane on this tmux server, for `candidates` (ccrc-term-cli.js) to
// filter down to the ones running claude and offer as a pick list.
//
// One tmux call, same shape as listSessions() below for the same reason:
// only ONE field in this format string can be free-form (contain a tab),
// because the split below has nowhere else to look for the separator once
// one is consumed. #{session_name} is the field chosen for that slot — but
// #{pane_current_path} (cwd), read here too, is exactly as free-form and
// sits at a FIXED position ahead of the index fields. A tab in a directory
// path shifts windowIndex/paneIndex/sessionName by one and corrupts `target`
// — display only, since #{pane_id} is field 1 and is unaffected, so the
// daemon still targets the right pane regardless.
//
// `cmd` (#{pane_current_command}) is kept here for callers that want it, but
// `candidates` no longer filters on it — measured on a real machine that it
// reports the pane's FOREGROUND process, not "is claude running in this
// pane" (see ccrc-term-cli.js's isClaudeCommand/subtreeHasClaude for the
// full incident). `panePid` (#{pane_pid}) is what candidates actually needs:
// the root of the pane's process tree, to walk downward from.
//
// `paneTty` (#{pane_tty}) was added after subtree-only matching was itself
// found too loose: a `claude` process ANYWHERE in a pane's subtree includes
// one that has nothing to do with that pane's own terminal — measured live,
// a headless `claude` spawned by a background plugin worker, detached with
// no controlling terminal of its own, living under an unrelated pane's
// subtree purely by process-tree accident. `candidates` now also requires
// the matching `claude` process's OWN tty (from `ps`) to equal the pane's
// tty, and #{pane_tty} is what it compares against. tmux prints this WITH a
// leading `/dev/` (`/dev/ttys004`); `ps` prints it WITHOUT (`ttys004`) — see
// ccrc-term-cli.js's stripDevPrefix for where that's normalised (exactly
// once, so the two spellings are never compared directly against each
// other in more than one place).
export function listPanes() {
  let out;
  try {
    out = tmux(['list-panes', '-a', '-F',
      '#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}\t#{pane_current_path}\t#{window_index}\t#{pane_index}\t#{session_name}']);
  } catch {
    return []; // no server running, or no panes
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 8) continue;
    const [paneId, panePid, paneTty, cmd, cwd, windowIndex, paneIndex, ...nameParts] = parts;
    const sessionName = nameParts.join('\t');
    rows.push({ paneId, panePid, paneTty, cmd, cwd, target: `${sessionName}:${windowIndex}.${paneIndex}` });
  }
  return rows;
}

// Does the application in this pane want mouse events?
//
// This is the fork in how a scroll gesture must be handled, and getting it
// wrong is not cosmetic:
//   · mouse ON (Claude Code, vim, less --mouse) — the app is on the alternate
//     screen, tmux holds no scrollback for it, and the history the user wants
//     lives inside the app. Send it a wheel event.
//   · mouse OFF (a plain shell) — the app knows nothing about scrolling, and
//     wheel bytes would be TYPED INTO IT as garbage. tmux's own history is
//     the real thing here, so page that instead.
//
// `sgr` reports which encoding the app asked for (mode 1006). Both are read in
// one tmux call, because this runs on every scroll gesture.
export function paneMouseMode(paneId) {
  if (!paneAlive(paneId)) return { mouse: false, sgr: false };
  try {
    const raw = tmux(['display-message', '-p', '-t', paneId, '#{mouse_any_flag} #{mouse_sgr_flag}']);
    const [any, sgr] = String(raw).trim().split(/\s+/);
    return { mouse: any === '1', sgr: sgr === '1' };
  } catch {
    // Unknown means "do not send bytes into somebody's shell" — the safe
    // direction, since the history path can only ever be useless, never
    // destructive.
    return { mouse: false, sgr: false };
  }
}

export function capturePane(paneId) {
  try {
    // -p print to stdout, -e keep escape sequences (colours), -J unwrap lines.
    return tmux(['capture-pane', '-p', '-e', '-J', '-t', paneId]);
  } catch {
    return '';
  }
}

// How far back tmux's own history goes for this pane, in lines. The ceiling
// for scrolling back — asking for more just returns blank rows, which reads
// as "the terminal broke" rather than "you reached the top".
export function paneHistorySize(paneId) {
  try {
    const n = Number(tmux(['display-message', '-p', '-t', paneId, '#{history_size}']).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// One screenful of scrollback, ready to write to a terminal.
//
// This exists because a control-mode client cannot be scrolled. `tmux -C`
// forwards a pane's OUTPUT (`%output`), not the screen tmux renders — so
// putting the pane into copy mode, which was the first thing tried, changed
// what the desktop showed and sent the browser nothing at all (measured:
// pane_in_mode became 1 and scroll_position 30 while the browser went on
// displaying the live tail). The history therefore has to be fetched and
// shipped explicitly.
//
// `offset` is how many lines above the live screen's top row to start, and
// `rows` is how many to return.
export function captureHistory(paneId, offset, rows) {
  if (!Number.isInteger(offset) || offset < 1) return '';
  if (!Number.isInteger(rows) || rows < 1) return '';
  const start = -offset;
  const end = start + rows - 1;
  try {
    const raw = tmux([
      'capture-pane', '-p', '-e', '-J', '-t', paneId,
      '-S', String(start), '-E', String(end),
    ]);
    if (!raw) return '';
    // Same framing as snapshotPane: clear + home so the screen lands in a
    // known state, '\r\n' between rows so each starts at column 0, and a
    // trailing SGR reset so a colour left open by the capture cannot bleed.
    return `\x1b[2J\x1b[H${raw.split('\n').join('\r\n')}\x1b[0m`;
  } catch {
    return '';
  }
}

// A line with nothing visible on it — stripped of any SGR/ANSI escape codes,
// only whitespace remains. Used to find the trailing run of blank rows below
// whatever is actually on screen (a prompt with nothing typed after it,
// typically) so it can be trimmed. A trailing colour code alone (e.g. a bare
// `ESC[0m`) must still count as blank, or it would defeat the trim.
function isBlankLine(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
}

// The snapshot sent to a browser the instant it connects (spec: "send what
// is on screen right now, so the client opens onto the current state instead
// of an empty rectangle"). Built on top of capturePane, not a replacement for
// it — capturePane stays the plain "what does this pane currently show"
// primitive (see tmux.test.js), this layers on the two behaviours needed
// specifically for that first frame over the wire:
//
//   1. capture-pane returns the pane's FULL height, not the browser's
//      current terminal size — unknown at connect time, since the resize
//      report only arrives after the client has mounted xterm.js. Measured
//      on a real machine (docs/superpowers/specs/2026-07-27-nghiem-thu-trinh-duyet.md):
//      a 50-row pane written into a 39-row browser terminal scrolled the
//      first 11 rows — where the content was — off the top, so the user
//      opened the terminal onto a near-blank screen. Rather than try to size
//      to the client (impossible at this point), trim the pane's own
//      trailing blank rows: a shell prompt with nothing typed after it
//      captures as content on top and blank padding down to the pane's full
//      height, and trimming that padding shrinks the snapshot to roughly how
//      much is actually on screen, which comfortably fits even a much
//      shorter browser terminal.
//   2. `capture-pane -e` can leave SGR state set on its very last line (the
//      acceptance run's tmux status line rendered black-on-white) with no
//      trailing reset. Every row streamed after inherits that styling —
//      visible as a tinted band across the whole terminal. An explicit
//      `ESC[0m` at the end closes that off.
//
// A leading clear-screen + cursor-home (`ESC[2J ESC[H`) is prepended too, so
// the snapshot lands in a known blank state rather than drawn on top of
// whatever the browser terminal's buffer already held.
export function snapshotPane(paneId) {
  const raw = capturePane(paneId);
  if (!raw) return raw;
  const lines = raw.split('\n');
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1])) lines.pop();
  // A terminal treats '\n' as line-feed ONLY — down one row, same column —
  // never as an implicit return to column 0. capture-pane separates lines
  // with a bare '\n', so joining with it reproduces that: each line starts
  // wherever the previous one ended, cascading into a diagonal staircase
  // down the screen (content byte-for-byte right, position wrong). Joining
  // with '\r\n' instead sends an explicit carriage return before every
  // line-feed, so each line starts at column 0 like a real terminal write
  // would. The leading ESC[H already homes the cursor to (0,0) for the
  // first line; '\r\n' between lines keeps every line after it starts there
  // too.
  return `\x1b[2J\x1b[H${lines.join('\r\n')}\x1b[0m`;
}

// --- grouped session (spec §5.5) --------------------------------------
//
// tmux sizes a shared window to the smallest client currently attached to
// it. Attaching the daemon's control-mode client straight to the user's own
// session means the moment a phone connects at ~40 columns, the user's real
// desktop tmux — the one they are sitting in front of — collapses to 40
// columns. The fix is to never attach directly: create a GROUPED session
// (`tmux new-session -t <original>`) that shares the same window/pane list
// but is its own session object, and attach the control-mode client there
// instead. Keeping the group is still correct — it gives an independent
// current-window, clean teardown, and the GROUP_MARKER_OPTION identity below
// — only the sizing option this group is given has since been reversed
// (read on).
//
// `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md` (Đo 1) measured that
// a DETACHED grouped session never disturbs the original — true, but
// trivially so: a session with no live client never drives a resize. Hand
// verification while building this task (see task-5-report.md) showed that
// a REAL, live-attached control client is a different story: with tmux's
// default `window-size latest`, whichever client resized most recently
// wins, and a small phone client drags the original session's window down
// with it — `aggressive-resize` does not prevent this on its own, because
// aggressive-resize only changes what happens when the CURRENT WINDOW
// changes on another session, not how a live client's own resize is
// applied. The fix landed at the time was pinning the grouped session's own
// `window-size` to `largest`: the shared window was then sized to the
// largest attached session, so a small phone client only ever got a cropped
// view instead of shrinking the window for everyone else.
//
// REVERSED. tmux gives a window exactly one size, full stop — there is no
// way for the phone and the desktop to each see their own. `largest`
// resolved that trade-off in the desktop's favour: on a real phone, the
// window stayed sized to the Mac's ~200-column terminal, so the phone
// received lines five times wider than its screen, wrapped them, and
// rendered unreadable, interleaved mush — verified by the user hitting it
// on a real device. The harm `largest` was written to prevent is real but
// mild and self-correcting: the desktop is unattended while the phone is in
// use, and tmux restores the window to the desktop's size (attached clients
// are re-measured on every attach/detach) the moment the phone disconnects,
// with Claude Code redrawing on top. The harm `largest` itself caused —
// the phone view being unusable for the entire time it is the one open —
// is not self-correcting; it is the whole session. So the trade-off is
// flipped: `window-size` is now `smallest`, and the phone decides. The
// Mac's terminal narrows while a phone is attached and returns to full
// width as soon as it disconnects. `aggressive-resize` is kept — it is
// still the documented recipe for grouped sessions with more than one
// window, and changing it is no part of this decision.
// Suffix ccrc-term appends to a real tmux session's name to name its
// browser-facing GROUPED session (spec §5.5). Defined once, here, so the
// convention lives in exactly one place.
//
// IMPORTANT: this suffix names things. It never IDENTIFIES them. Nothing
// destructive in this file is decided by a name matching this shape — see
// GROUP_MARKER_OPTION below for what identity is actually built on, and the
// header of killGroupSession for the incident that forced the distinction.
export const GROUP_SESSION_SUFFIX = '-ccrc-web';

// The tmux session user option ccrc-term stamps on every grouped session it
// creates, and the ONLY thing that makes a session "ours".
//
// This replaces an earlier `baseSessionName()` that stripped a trailing
// GROUP_SESSION_SUFFIX off any session name to recover the original. That
// inferred identity from a name's SHAPE, and a user who happens to call a
// real session `myproj-ccrc-web` was destroyed by it: the strip produced
// base `myproj`, the derived group name came back out as `myproj-ccrc-web`
// — the user's own live session — and the kill-before-create step then
// killed it. It was the last session on that server, so the whole tmux
// server went down with it. This project had already made exactly this
// mistake once before, in `/remote off`, which used to signal any process
// whose pid matched a stale file.
//
// A marker cannot be arrived at by accident. A session carrying it was
// created by createGroupSession below and by nothing else, so "may I kill
// this?" is answered by knowledge instead of by a guess about a string.
export const GROUP_MARKER_OPTION = '@ccrc_group';

// The value stamped into GROUP_MARKER_OPTION: `<pid>-<random>`.
//
// Both halves earn their place. The PID is what lets any later run ask the
// operating system whether the daemon that created a marked session is still
// running — the whole basis of isReclaimableMarker below. The random half is
// what keeps that answer honest across pid reuse: two runs that happen to get
// the same pid still get different run ids, so "is this marker MINE?" is an
// exact string comparison that no coincidence can satisfy.
//
// Defined here, next to the option it is written into, so the format is
// parsed and produced in exactly one place.
export function makeRunId() {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

// May we destroy a session carrying this marker?
//
// Presence of a marker only proves "ccrc-term created this at some point". It
// does NOT prove the session is abandoned, and acting as if it did is the
// multi-daemon defect this function exists to close: with two panes of the
// SAME tmux session each running `/remote on`, both daemons derive the same
// candidate group name from the same base session, and the second one used to
// kill the first one's LIVE group and take its name — the first browser was
// dropped with "tmux control mode đã đóng bất ngờ" and the marker flipped from
// one run id to the other. (Two SEPARATE tmux sessions never collide on the
// name, which is why the earlier acceptance run missed this.)
//
// Only two things make a marked session ours to destroy:
//   - it names OUR OWN run — we made it, in this process;
//   - it names a run whose process is GONE — a daemon that crashed or was
//     SIGKILLed, so nothing is serving that group any more.
//
// Every other answer is "no": a marker naming a live process, and equally a
// marker in a shape we cannot parse, since a marker we cannot read is a
// marker we cannot prove dead. Both fall through to the caller's next
// candidate name. That direction is the safe one — the cost of refusing is a
// group named `-2`, the cost of a wrong yes is a live terminal destroyed.
//
// PID REUSE cuts the safe way here too: if a dead run's pid has since been
// handed to some unrelated process, that process is alive, so we decline to
// reclaim and route around the name. We leak a name, never a session.
export function isReclaimableMarker(marker, runId) {
  if (typeof marker !== 'string' || marker === '') return false;
  if (typeof runId === 'string' && runId !== '' && marker === runId) return true;
  const m = /^(\d+)-/.exec(marker);
  if (!m) return false; // unrecognised shape — cannot prove the owner is gone
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // the creating run is still running — not ours to touch
  } catch (e) {
    // ESRCH is the only "no such process". EPERM means the process EXISTS but
    // belongs to another user — very much alive, and treating it as gone
    // would be exactly the wrong reading.
    return e && e.code === 'ESRCH';
  }
}

// Every session on this tmux server, with the two facts about it that
// matter here. Read in ONE tmux call, via list-sessions rather than
// per-session lookups, because tmux's target resolution (`-t <name>`) is
// not exact: it falls back to a start-of-name prefix match, so asking about
// `foo` can silently answer about `foobar`. Matching #{session_name} in JS
// with === is exact by construction and has no such fallback.
//
// #{session_name} is placed LAST in the format so that a session name
// containing the separator still round-trips: the fields before it are
// values ccrc-term itself sets (a hex run id) or tmux integers, none of
// which can contain a tab.
//
//  - marker:    GROUP_MARKER_OPTION's value, '' for every session we did
//               not create.
//  - groupSize: how many sessions share this session's group. 2+ means the
//               windows it holds are also held by another session, so
//               killing THIS session cannot destroy them; 1 means it is the
//               lone survivor of its group and its windows would die with
//               it; '' means it is not grouped at all.
function listSessions() {
  let out;
  try {
    out = tmux(['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}\t#{session_group_size}\t#{session_name}`]);
  } catch {
    return []; // no server running, or no sessions
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    rows.push({ marker: parts[0], groupSize: Number(parts[1]) || 0, name: parts.slice(2).join('\t') });
  }
  return rows;
}

function findSession(name) {
  if (typeof name !== 'string' || !name) return null;
  return listSessions().find((s) => s.name === name) || null;
}

// Every session that currently holds this pane, each carrying the same two
// facts listSessions() reports. Usually one — the user's own session — but a
// grouped session shares its origin's whole window list, so every ccrc-term
// group on that origin holds the pane too, including groups belonging to
// OTHER live daemons serving a different pane of the same tmux session.
//
// `list-panes -a` is what makes this a single tmux call: measured on tmux
// 3.7b, it walks sessions → windows → panes, so a pane shared by a grouped
// session is listed once under EACH session that references it. That is
// precisely the mapping needed here, and it is why this does not have to ask
// tmux about each session in turn.
//
// This replaces asking `display-message -t <pane> '#{session_name}'` and
// trusting the answer. That question has no single correct answer once a
// pane is shared, and tmux answers with whichever session it currently
// considers current — routinely one of our own groups rather than the user's
// real session.
//
// #{session_name} is placed LAST for the same reason as in listSessions: a
// pane id (`%12`) can never contain a tab, a session name can.
function sessionsWithPane(paneId) {
  if (typeof paneId !== 'string' || !paneId) return [];
  let out;
  try {
    out = tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}']);
  } catch {
    return []; // no server, no sessions, no panes
  }
  const names = new Set();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    if (parts[0] !== paneId) continue;
    names.add(parts.slice(1).join('\t'));
  }
  return listSessions().filter((s) => names.has(s.name));
}

// True if a session by this EXACT name currently exists. Used to tell "the
// GROUPED session disappeared" apart from "the underlying pane died" when a
// control-mode client exits unexpectedly — see ccrc-term.js's onCtlGone.
export function hasSession(name) {
  return findSession(name) !== null;
}

// True only for a session this project created and marked. Never true for a
// session that merely LOOKS like one of ours.
export function isOurGroupSession(name) {
  const s = findSession(name);
  return s !== null && s.marker !== '';
}

export function createGroupSession(sessionName, groupName, runId = makeRunId()) {
  // `=` forces tmux to match the target session name exactly instead of
  // falling back to a prefix match — grouping onto the wrong session
  // because its name merely starts the same way would be silent and wrong.
  tmux(['new-session', '-d', '-t', `=${sessionName}`, '-s', groupName]);
  // Deliberately a SEPARATE tmux invocation from the new-session above, not
  // chained onto it with `;`. If new-session fails because the name is
  // already taken, a chained set-option would go on to stamp OUR marker on
  // whatever session already holds that name — handing us permission to
  // kill a session we did not create, which is the entire class of bug this
  // marker exists to prevent. Marking only ever follows a creation that
  // actually succeeded.
  //
  // The marker is set first, and in the same invocation as everything else,
  // so the window in which a freshly created group exists UNMARKED is as
  // short as two lines of straight-line code. A group that somehow survives
  // unmarked is never killed by us (correct — we cannot prove we made it);
  // claimGroupName below simply routes around its name.
  tmux([
    'set-option', '-t', groupName, GROUP_MARKER_OPTION, runId, ';',
    'set-option', '-t', groupName, 'window-size', 'smallest', ';',
    'set-window-option', '-t', groupName, 'aggressive-resize', 'on',
  ]);
  // `new-session -t <target>` does NOT fail when the target session does not
  // exist — measured on tmux 3.7: it exits 0 and silently creates an
  // ORDINARY, ungrouped session with a fresh shell in it. Left unchecked
  // that turns "the session I meant to mirror is gone" into "here is a brand
  // new empty terminal, reported as success", and the browser attaches to a
  // shell that is not the user's pane at all. sessionName is verified alive
  // by the caller, but only a moment earlier — it can die in between.
  //
  // A genuinely grouped session shares its group with sessionName, so its
  // group holds 2+ members. Anything less means the grouping did not happen:
  // clean up what we just made and fail loudly instead of serving a
  // convincing impostor.
  const created = findSession(groupName);
  if (created === null || created.groupSize < 2) {
    killGroupSession(groupName);
    throw new Error(`phiên nhóm ${groupName} không gắn được vào phiên ${sessionName}`);
  }
}

// Removes a grouped session — but ONLY one carrying our creation marker.
// A session we did not create is left strictly alone no matter what it is
// called; see GROUP_MARKER_OPTION above for the live session this rule was
// written over the corpse of.
//
// The window/pane a real group shared with its origin session is untouched:
// killing a grouped session unlinks it from the shared window, it does not
// destroy that window. Idempotent — killing an already-gone (or never
// created) group is a silent no-op, since callers use this for best-effort
// cleanup on every disconnect path, including ones racing each other.
export function killGroupSession(groupName) {
  if (!groupName) return;
  if (!isOurGroupSession(groupName)) return;
  // `=` again: exact name only. Without it, killing a name that no longer
  // exists can fall through to a prefix match and destroy a different,
  // living session.
  try { tmux(['kill-session', '-t', `=${groupName}`]); } catch { /* already gone */ }
}

// Picks the name for a new grouped session derived from `base`, and clears
// the way for it.
//
// The preferred name is `<base><GROUP_SESSION_SUFFIX>`. Three cases:
//   - nothing holds it            → take it.
//   - a RECLAIMABLE group holds it → ours, or one whose creating run is gone
//                                   (a crashed daemon's leak). Reclaim the
//                                   name by killing it. See
//                                   isReclaimableMarker for why a marker
//                                   alone is not enough to answer this.
//   - anything else holds it      → someone else's session that merely
//                                   shares the shape, OR another LIVE
//                                   daemon's group — which is what two panes
//                                   of the same tmux session produce, since
//                                   both derive this same candidate name
//                                   from the same base. Do not touch it; try
//                                   the next candidate name instead.
// Returns null if no candidate is available, which the caller must treat as
// "cannot serve this connection" — never as licence to kill something.
export function claimGroupName(base, runId) {
  for (let i = 1; i <= 20; i++) {
    const name = i === 1 ? `${base}${GROUP_SESSION_SUFFIX}` : `${base}${GROUP_SESSION_SUFFIX}-${i}`;
    const existing = findSession(name);
    if (existing === null) return name;
    if (isReclaimableMarker(existing.marker, runId)) { killGroupSession(name); return name; }
  }
  return null;
}

// The REAL session a pane belongs to — the user's own, never one of ours.
//
// paneSession() reports whatever session tmux currently considers "current"
// for the pane's window, which is ambiguous the moment more than one
// session references that window: exactly what a grouped session creates.
// A daemon that is SIGKILLed never runs its cleanup, so the group it made
// simply stays on the tmux server — a tmux session needs no client to go on
// existing, and measurement (see critical-fix-report.md) shows the daemon's
// own `tmux -C` child does NOT outlive it: the child exits on stdin EOF
// within ~50ms of the parent dying, while the SESSION survives indefinitely.
// paneSession() then reports that leftover group rather than the user's
// session — measured directly: it answers with the group even when the
// group is merely detached. Deriving a new group name from that answer is
// what used to produce `<sess>-ccrc-web-ccrc-web`, one more layer per crash.
//
// Rather than un-mangle the name (the guess that caused the incident), the
// shadowing session is removed: it carries our marker, so we know we made
// it, and it needed cleaning up regardless. tmux then has only the real
// session left to report. Bounded, so a pathological chain of leaked groups
// terminates instead of looping.
//
// A group that is the LONE remaining member of its group (groupSize < 2) is
// NOT killed: its windows are held by nothing else, so killing it would
// destroy the very pane we are here to serve.
//
// REWRITTEN for more than one daemon. The old version walked
// paneSession() → kill → ask again, killing ANY marked session on the way.
// With two panes of one tmux session that meant daemon B, starting up,
// killed daemon A's live group simply because tmux named it as the pane's
// "current" session — dropping A's browser. Two changes close that:
//
//   - the shadow is only killed when isReclaimableMarker says so (ours, or a
//     dead run). Another live daemon's group is left strictly alone.
//   - the real session is then found DIRECTLY, from the list of sessions
//     holding the pane, instead of by killing shadows until tmux happens to
//     name the right one. That is what makes leaving a live group in place
//     possible at all: we no longer need it gone to see past it.
//
// Returns null when nothing unmarked holds the pane — a dead pane, or the
// pathological case where only our own groups remain (killing those would
// kill the pane). The caller must treat that as "cannot serve", never as
// licence to kill something.
export function reclaimPaneSession(paneId, runId) {
  // Clean up the shadows we can PROVE are ours to remove. Best-effort: a
  // failure here only means a leaked group lives a little longer, and the
  // answer below does not depend on it.
  for (const s of sessionsWithPane(paneId)) {
    if (s.marker === '') continue; // the user's own session
    if (s.groupSize < 2) continue; // nothing else holds the pane — killing it kills the pane
    if (!isReclaimableMarker(s.marker, runId)) continue; // another live daemon's group
    killGroupSession(s.name);
  }

  const remaining = sessionsWithPane(paneId);
  // Prefer whatever tmux itself calls the pane's session, when that is a
  // session we did not create — it is the most faithful answer available and
  // keeps behaviour identical to before in the ordinary single-daemon case.
  // Otherwise take any unmarked session holding the pane: tmux's "current"
  // answer is one of our groups, and the user's real session is the one it
  // is standing in front of.
  const current = paneSession(paneId);
  const currentEntry = remaining.find((s) => s.name === current);
  if (currentEntry && currentEntry.marker === '') return currentEntry.name;
  const real = remaining.find((s) => s.marker === '');
  return real ? real.name : null;
}
