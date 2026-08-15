// A small on-disk registry of running terminal sessions: one JSON file per
// session under `~/.ccrc/sessions/`.
//
// Written by the ccrc-term daemon, read by the notification hook. It exists
// because those two are separate programs that must agree on one thing: the
// name a session goes by. Without it a notification could only ever fall back
// to the directory name — the exact leak this whole change removes — and the
// hub would have no way to tell that an arriving notification belongs to a
// session the user is already watching.
//
// Lives outside both workspaces on purpose: duplicating the file format in
// two places is how the two sides drift apart, and drift here is silent (a
// notification simply stops carrying a name, and nothing fails).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function registryDir(home) {
  return path.join(home || os.homedir(), '.ccrc', 'sessions');
}

// A session id comes from this project's own code, but it lands in a
// filename, so it is not taken on trust: anything outside this set could
// escape the directory.
function safeId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(sessionId)
    && sessionId !== '.' && sessionId !== '..';
}

function entryPath(dir, sessionId) {
  return path.join(dir, `${sessionId}.json`);
}

// $TMUX is `<socket-path>,<server-pid>,<session-index>`; only the socket path
// says WHICH tmux server, and the rest changes for reasons that have nothing
// to do with identity. Stored and compared in that reduced form so the two
// sides can hand each other the raw variable and still agree.
function socketOf(tmuxEnv) {
  return typeof tmuxEnv === 'string' && tmuxEnv ? tmuxEnv.split(',')[0] : '';
}

// `pid` is recorded so a reader can tell a live session from one whose daemon
// was killed without getting the chance to clean up (`kill -9`, a crash, a
// power cut). Nothing here may throw: a notification must still go out even
// if the registry is unreadable.
export function writeSession(entry, opts = {}) {
  const dir = opts.dir || registryDir(opts.home);
  if (!entry || !safeId(entry.sessionId)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      sessionId: entry.sessionId,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      // The tmux pane this session's daemon watches, and the server that pane
      // belongs to. This is the pair the hook matches on — see findByPane.
      pane: typeof entry.pane === 'string' ? entry.pane : '',
      tmux: socketOf(entry.tmux),
      pid: Number(entry.pid) || 0,
    });
    // Written via a temp file and renamed, so a reader never sees a half-
    // written file — the hook reads this on every single notification.
    const tmp = entryPath(dir, entry.sessionId) + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, entryPath(dir, entry.sessionId));
    return true;
  } catch {
    return false;
  }
}

export function removeSession(sessionId, opts = {}) {
  const dir = opts.dir || registryDir(opts.home);
  if (!safeId(sessionId)) return false;
  try {
    fs.unlinkSync(entryPath(dir, sessionId));
    return true;
  } catch {
    return false;
  }
}

// Distinguishes "no such process" from "exists but is not ours": only ESRCH
// means the session is gone. EPERM means a live process we may not signal,
// which is still a live process — the same distinction the daemon reclaim
// path had to learn.
function defaultIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function listSessions(opts = {}) {
  const dir = opts.dir || registryDir(opts.home);
  const isAlive = opts.isAlive || defaultIsAlive;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // unreadable or half-written — skip it, never throw
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!isAlive(entry.pid)) {
      // A stale file from a daemon that died without cleaning up. Removing it
      // here keeps the directory from growing forever, since nothing else
      // ever sweeps it.
      removeSession(entry.sessionId, { dir });
      continue;
    }
    out.push(entry);
  }
  return out;
}

// The lookup the hook does FIRST: which live session watches the pane I am
// running inside?
//
// Why this beats the directory lookup below, which it now leads: the cwd a
// notification carries is Claude Code's CURRENT directory, and that walks off
// into subdirectories as the session works — one `cd` inside a Bash call is
// enough. The pane never moves. Measured on a real session (2026-08-15): 24
// events at the directory the pane was opened in against 266 in one
// subdirectory and 212 in another, so the exact-directory match below missed
// essentially every notification and the hub never had a session id to hold a
// push back with.
//
// `pane` alone would be a cheap signal: pane ids are unique within ONE tmux
// server, and a second server hands out `%0` all over again. So the socket has
// to agree too — but only when both sides know it, since an entry written by
// an older daemon has no socket recorded and must still be usable.
export function findByPane(pane, opts = {}) {
  if (typeof pane !== 'string' || !pane) return null;
  const want = socketOf(opts.tmux);
  for (const entry of listSessions(opts)) {
    if (!entry.pane || entry.pane !== pane) continue;
    if (entry.tmux && want && entry.tmux !== want) continue;
    return entry;
  }
  return null;
}

// The lookup the hook falls back on: which live session is running in this directory?
// Exact match only. A prefix or parent-directory match would be guessing, and
// guessing wrong here means a notification labelled with the wrong session —
// worse than one labelled with none.
export function findByCwd(cwd, opts = {}) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const want = path.resolve(cwd);
  for (const entry of listSessions(opts)) {
    if (entry.cwd && path.resolve(entry.cwd) === want) return entry;
  }
  return null;
}
