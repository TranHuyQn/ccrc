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

// The lookup the hook does: which live session is running in this directory?
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
