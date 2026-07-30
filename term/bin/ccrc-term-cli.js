#!/usr/bin/env node
// `/remote on|off` and, with no argument, the status report.
//
// The status path deliberately calls the hub for real rather than reading the
// local config and declaring things fine: everything else in this system fails
// quietly, so this is the only place a broken setup can surface.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.js';
import { requestedPortLabel } from '../src/env.js';
import { currentPane, paneAlive } from '../src/tmux.js';
import { cleanSessionName } from '../src/session-name.js';
import { randomNonce, commitMatches, shortAuthString } from '../src/pairing.js';
import { addDevice, listDevices, removeDevice } from '../src/devices.js';
import { writePending, readPending, clearPending } from '../src/pending-pair.js';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ccrc-term.js');
const say = (s) => process.stdout.write(s + '\n');

// One PID file per tmux PANE, not one global file (Task 5). With a single
// shared file, a second `/remote on` (a different pane, a different daemon)
// overwrote the first pane's entry — `off` in the first pane then read the
// SECOND daemon's pid, could not find its own, and reported "already off"
// while its daemon kept running and serving a shell on the tailnet. Keying
// the file by pane id means each pane's `on`/`off` only ever reads and
// writes its own file and can never see, let alone touch, another pane's.
function pidFilePath(paneId) {
  return path.join(os.homedir(), '.ccrc', `term-pane-${paneId}.pid`);
}

const cfg = readConfig(os.homedir());
if (!cfg) {
  say('Chưa cấu hình — chạy ./setup-notify.sh trước.');
  process.exit(1);
}

const mode = process.argv[2];

async function hub(pathname, init = {}) {
  const res = await fetch(new URL(pathname, cfg.hubUrl), {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

// Flags that make node run inline code (-e/--eval) or print an inline
// expression (-p/--print) instead of running a script file. Any argument
// that merely follows one of these is source code or a coincidental extra
// argument — never a script that got executed — which is exactly the
// round-2 false positive below depends on excluding.
//
// Round 4: these are compared against the flag NAME only, after
// `--flag=value` has been split at the first `=`. The set used to be matched
// against whole argv entries, so `node --eval=<code> <daemon path>` — the
// `=`-joined spelling node accepts for every one of these — sailed straight
// past it and the daemon path that followed was read as a script we had run.
const INLINE_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

// argv[0] must be node itself. Without this, ANY command carrying the
// daemon's path as an argument reads as our daemon: `tail -f <daemon path>`,
// but equally an editor, `less`, `grep`, `cp` — all of them ordinary things
// to be doing to a file, none of them running it. Reproduced with a real
// `tail` as the victim.
//
// Matched on the BASENAME so an absolute path (`/opt/homebrew/.../bin/node`,
// which is what `process.execPath` gives cmdOn), a bare `node` from PATH, and
// a versioned or Debian-style name (`node22`, `nodejs`) are all recognised,
// while `/usr/bin/tail` and friends are not. Deliberately no attempt to allow
// arbitrary renames of the node binary: a false "not ours" costs a daemon
// that must be stopped by hand, a false "ours" costs an unrelated process its
// life, and this function exists because the latter has happened here twice.
function isNodeBinary(exe) {
  return /^node(js)?[0-9.]*$/.test(path.basename(exe));
}

// `ps` and `lsof` below read the local process table — normally a few
// milliseconds. They get an explicit timeout anyway because both run on the
// `/remote off` path, where a hang is strictly worse than a throw: a throw is
// caught and identification simply fails closed (we signal nothing and clear
// the stale file), while a hang leaves the user with a command that never
// returns and a daemon they cannot stop. Without a timeout `execFileSync`
// waits forever, so an `lsof` blocked on a wedged mount — its classic failure
// mode — would take `/remote off` down with it. Same reasoning and the same
// order of magnitude as the timeouts in src/tailscale.js.
const PROBE_TIMEOUT_MS = 2000;

// True when execFileSync gave up on its own `timeout` rather than the command
// failing: Node kills the child with SIGTERM and the error carries both the
// signal and ETIMEDOUT.
function timedOut(e) {
  return Boolean(e && (e.code === 'ETIMEDOUT' || e.signal));
}

// The daemon's absolute path, with symlinks resolved, so argument paths
// (which may go through a symlink themselves) compare correctly against it.
// Falls back to the unresolved path if realpath fails (e.g. broken symlink)
// so comparisons stay consistent either way.
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}
const DAEMON_REAL = realpathOrSelf(DAEMON);

// A relative argument (`node ccrc-term.js`) can only be resolved correctly
// against the directory the TARGET process was actually launched from —
// resolving it against our own cwd instead would only ever match by
// coincidence. `lsof -d cwd` reads that directory for a live pid.
//
// Returns { cwd } — the directory, or null when lsof answered but told us
// nothing useful, in which case the caller may fall back to a guess. A
// timeout is reported separately as { timedOut: true }, because "lsof hung
// and we gave up" is not the same as "lsof answered": we know nothing about
// this process, so the identification must fail closed rather than guess.
function processCwd(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return { cwd: line ? line.slice(1) : null };
  } catch (e) {
    if (timedOut(e)) return { timedOut: true };
    return { cwd: null };
  }
}

// A live PID alone proves nothing — PIDs get reused, especially after the
// machine has been up a while or rebooted since the file was written. Read
// the process's own command line and require it to actually be our daemon
// before ever treating the number in the file as "ours". `-ww` asks BSD ps
// for the untruncated command line regardless of terminal width.
//
// Round 2: matching the daemon's path ANYWHERE on the command line (a plain
// substring check) was too weak — `node -e '...' /path/to/ccrc-term.js`
// matched, with the path sitting there as a coincidental extra argument to
// -e, never executed. That was closed by requiring the path in the exact
// position right after the executable (argv[1]).
//
// Round 3: argv[1]-only turned out too STRICT in the other direction — it
// only matches an absolute path with no leading flag, which is all `cmdOn`
// spawns today, but refuses to recognise a real daemon started with a
// relative path (`node ccrc-term.js`) or a leading flag (`node
// --enable-source-maps <path>`). Neither is reachable through this CLI
// right now, but the failure direction matters: refusing to recognise a
// REAL daemon makes `off` report "vốn đã tắt" while it is still running and
// still serving a shell on the tailnet — a false "nothing here" that leaves
// the user with no way to stop it, worse than the round-2 false positive it
// replaced.
//
// Round 3's answer was "the daemon's path in ANY argument position, with
// inline-script invocations excluded". Round 4 found two ways through it,
// both reproduced with a live victim process that the old code signalled:
//
//   - `node --eval=<code> <daemon path>`. The inline-script exclusion
//     compared whole argv entries against the flag set, so the `=`-joined
//     spelling — which node accepts for all four flags — never matched, and
//     the trailing path was accepted as a script.
//   - `tail -f <daemon path>`. argv[0] was never required to be node at all,
//     so ANY command holding the daemon's path as an argument passed:
//     `tail`, `less`, `grep`, `cp`, an editor. Reading a file is not running
//     it.
//
// Round 4 models what node itself does with its argv instead of scanning it:
//
//   1. argv[0] must be a node binary (isNodeBinary above). A command that is
//      not node cannot be running our daemon, whatever it is holding.
//   2. Arguments are walked in order. A leading `-` is a node flag; it is
//      normalised by splitting at the first `=`, so `--eval=x` and `--eval x`
//      are the same flag, and hitting any inline-script flag ends the answer
//      at "not ours" — node is running code, not a file.
//   3. The FIRST non-flag argument is the script node was told to run. That
//      one is resolved (against the process's own cwd, so a relative
//      `node ccrc-term.js` still matches) and compared. Everything after it
//      is the SCRIPT's argv, not node's, and proves nothing — which is why
//      the scan stops there rather than continuing.
//
// Known limit, unchanged from earlier rounds: `ps -o command=` is a single
// string, so an argument containing whitespace is indistinguishable from two
// arguments. The daemon's own path contains none, and every mis-split lands
// on "not ours" (a refusal), never on a wrong kill.
function isOurDaemon(pid) {
  let cmd;
  try {
    cmd = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  } catch {
    // Includes our own timeout: if we cannot read the command line we do not
    // know whose pid this is, so it is not ours.
    return false;
  }
  const argv = cmd.trim().split(/\s+/);
  if (argv.length < 2) return false; // nothing was run, or nothing to compare
  if (!isNodeBinary(argv[0])) return false;

  const probe = processCwd(pid);
  if (probe.timedOut) return false; // fail closed — see processCwd
  const cwd = probe.cwd || process.cwd();
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) {
      // `--flag=value` and `--flag value` are the same flag to node; compare
      // the name only.
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (INLINE_SCRIPT_FLAGS.has(name)) return false;
      continue;
    }
    // First non-flag argument: the script node actually runs. This is the
    // only argument that can make the process ours, so the answer is decided
    // here either way.
    return realpathOrSelf(path.resolve(cwd, arg)) === DAEMON_REAL;
  }
  return false;
}

// Returns { pid, sessionId, file } for PANE's daemon only if that pane's PID
// file names a live process that is verifiably our daemon. Any other case —
// missing file, garbage content, a dead pid, or a live pid that belongs to
// something else entirely — is treated as "not running", and the
// stale/wrong file is discarded so it cannot mislead the next invocation
// either. Exactly the same identity discipline as before Task 5 (a bare pid
// is never trusted — see isOurDaemon above) — only the file is now scoped to
// one pane instead of shared, so this can never see, and never touch,
// another pane's daemon.
//
// The file holds JSON `{pid, sessionId}` rather than a bare number: sessionId
// is what lets `/remote` (cmdStatus) point out which of the hub's sessions is
// THIS pane's, by matching it against the sessionId the hub was registered
// with (see cmdOn below).
function daemonInfo(paneId) {
  const file = pidFilePath(paneId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const pid = parsed && typeof parsed === 'object' ? parsed.pid : NaN;
  const sessionId = parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
  if (!Number.isInteger(pid) || pid <= 0 || !sessionId) {
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    return null;
  }
  try {
    process.kill(pid, 0);
  } catch {
    // No such process — stale file left over from a prior run.
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    return null;
  }
  if (!isOurDaemon(pid)) {
    // The pid is alive but is not our daemon — a reused number. Never
    // signal it, and drop the file so it stops looking like a session.
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    return null;
  }
  return { pid, sessionId, file };
}

// How long `/remote on` waits for the freshly spawned daemon to prove it
// actually started (bound its port, or told us why it couldn't) before
// giving up and reporting failure. checkPrereqs (term/src/tailscale.js)
// itself times out its own `tailscale status` call at 2s, so this leaves
// comfortable headroom above the daemon's own worst case.
const DAEMON_START_TIMEOUT_MS = 6000;

// Waits for the daemon to either announce it is listening (stdout line
// `[term] nghe …`, see ccrc-term.js) or exit before ever reaching that line
// (failure — Tailscale off, port taken, pane died in the gap, ...).
//
// This is the fix for reporting ✓ before the daemon proved anything: with
// `stdio: 'ignore'` (the old behaviour), a Tailscale-off or port-taken
// failure went nowhere and the CLI printed success regardless, leaving the
// user with a tick on the CLI and an empty card in the PWA.
// The port this run actually asked the daemon to bind — mirrors the daemon's
// own default (term/bin/ccrc-term.js: `Number(process.env.CCRC_TERM_PORT ||
// 0)`). '0' means "let the OS pick", which is the production default since
// Task 1 made the port dynamic so a second daemon can bind at all; a fixed
// port is only ever requested by a test. Read once, at module load, same as
// the daemon reads its own copy of the same variable.
const REQUESTED_PORT = process.env.CCRC_TERM_PORT || '0';

function waitForDaemonStart(child) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('exit', onExit);
      resolve(result);
    };
    const onStdout = (d) => { out += d; };
    const onStderr = (d) => { err += d; };
    const onExit = (code, signal) => {
      const message = err.trim() || out.trim() || `daemon thoát bất ngờ (code=${code}, signal=${signal})`;
      finish({ ok: false, message });
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    const poll = setInterval(() => {
      if (!/^\[term\] nghe /m.test(out)) return;
      const m = /\[term\] URL: (\S+)/.exec(out);
      const n = /\[term\] tên: (.+)/.exec(out);
      finish({ ok: true, url: m ? m[1] : null, name: n ? n[1].trim() : null });
    }, 50);
    const timer = setTimeout(() => {
      // Used to hard-code "cổng 8730" here, which stopped being true once
      // Task 1 made the port dynamic (default 0 — OS-assigned). Report the
      // port actually requested for THIS run instead, via the same
      // requestedPortLabel the daemon's own EADDRINUSE message uses, so the
      // two halves of the system never describe this differently.
      finish({ ok: false, message: `daemon không phản hồi kịp lúc — kiểm tra Tailscale hoặc xem ${requestedPortLabel(REQUESTED_PORT)} có đang bị chiếm không.` });
    }, DAEMON_START_TIMEOUT_MS);
    // Never let holding these pipes open to a long-running DETACHED daemon
    // pin this CLI process's own event loop — once we are done waiting
    // (finish() above), nothing else should keep this process alive.
    child.stdout.unref();
    child.stderr.unref();
  });
}

async function cmdOn(rawName) {
  const pane = currentPane();
  if (!pane || !paneAlive(pane)) {
    say('✗ Không chạy trong tmux — /remote cần một phiên tmux để nối vào.');
    say('  Khởi động lại Claude Code bên trong tmux rồi thử lại.');
    process.exit(1);
  }
  const pidfile = pidFilePath(pane);
  if (daemonInfo(pane)) { say('✓ Remote đã bật sẵn cho phiên này'); return; }

  const sessionId = crypto.randomBytes(9).toString('base64url');
  // What the phone will show for this session. An unusable name is not an
  // error — the daemon falls back to a random id — but say so, because
  // silently ignoring what the user typed would leave them staring at an id
  // wondering why their name did not take.
  const name = cleanSessionName(rawName);
  if (rawName && !name) {
    say(`⚠ Tên "${rawName}" không dùng được (chỉ chữ, số, khoảng trắng, . _ -) — dùng id ngẫu nhiên.`);
  }

  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      CCRC_TERM_PANE: pane,
      CCRC_TERM_SESSION_ID: sessionId,
      CCRC_TERM_URL: process.env.CCRC_TERM_URL || '',
      CCRC_TERM_NAME: name || '',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();

  const result = await waitForDaemonStart(child);
  if (!result.ok) {
    say('✗ Không bật được remote.');
    if (result.message) say(`  ${result.message}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, sessionId }));

  say('✓ Remote ĐÃ BẬT');
  // The name is echoed back because it is now the ONLY way to tell one card
  // from another on the phone — the directory name that used to do that job
  // is deliberately no longer sent anywhere.
  if (result.name) say(`  Tên hiện trên web: ${result.name}`);
  if (result.url) say(`  URL: ${result.url}`);
  say('⚠ Máy ngủ là mất kết nối. Hãy đặt máy không ngủ trước khi rời đi.');
}

async function cmdOff() {
  // `off` acts on THIS pane's daemon and no other — it needs to know which
  // pane it is running in to even find the right file. Outside tmux there is
  // no pane to key off, so there is nothing safe to do but say so; a pane
  // that is merely no longer alive is not treated the same way (below), an
  // unset TMUX_PANE means "we cannot even name a candidate file".
  const pane = currentPane();
  if (!pane) {
    say('✗ Không chạy trong tmux — không biết phiên nào để tắt.');
    say('  Dùng `/remote` (không tham số) để xem mọi phiên đang mở.');
    process.exit(1);
  }
  const info = daemonInfo(pane);
  if (!info) { say('✓ Remote vốn đã tắt'); return; }
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { fs.unlinkSync(info.file); } catch { /* nothing to remove */ }
  say('✓ Remote ĐÃ TẮT');
}

async function cmdStatus() {
  // The local half: does THIS pane have a daemon of its own? Kept separate
  // from the hub listing below because the hub can be unreachable, slow, or
  // simply not yet know about a daemon that only just started — the one
  // thing this process can always answer for itself is its own pane.
  const pane = currentPane();
  const local = pane ? daemonInfo(pane) : null;
  if (pane) {
    say(`Remote (phiên này): ${local ? 'ĐANG BẬT' : 'ĐANG TẮT'}`);
  } else {
    say('Remote (phiên này): không xác định — không chạy trong tmux.');
  }

  let res;
  const t0 = Date.now();
  try {
    res = await hub('/api/terminal');
  } catch (e) {
    say(`Hub: ${cfg.hubUrl} — không gọi được (${e.message})`);
    return;
  }
  say(`Hub: ${cfg.hubUrl} — OK (${Date.now() - t0}ms)`);

  if (res.status === 401) { say('Token: KHÔNG hợp lệ — hub từ chối.'); return; }
  if (!res.ok) { say(`Hub trả lỗi ${res.status}`); return; }

  // With no argument, this listing is the only diagnostic a user away from
  // their machine has — it must show every session the hub knows about for
  // this user, not just this pane's, or a daemon left running in another
  // pane becomes invisible and un-stoppable from anywhere. sessionId lets us
  // mark the one entry (if any) that is this pane's own daemon.
  const body = await res.json();
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  if (sessions.length === 0) {
    say('Phiên: chưa mở phiên nào — gõ `/remote on` trong tmux để mở.');
    return;
  }
  say(`Phiên đang mở (${sessions.length}):`);
  for (const s of sessions) {
    const mine = Boolean(local && s.sessionId === local.sessionId);
    const label = s.label || '(không rõ tên)';
    const state = s.alive ? 'còn nhịp tim' : '⚠ KHÔNG phản hồi — máy có thể đã ngủ';
    say(`  • ${label} · ${s.machine} — ${state}${mine ? '  ← phiên này' : ''}`);
  }
}

// Dừng MỌI daemon của máy này, không riêng pane đang gọi.
//
// Chỉ lệnh gỡ cài đặt dùng tới. `off` thường ngày cố ý chỉ đụng pane của
// chính nó (xem pidFilePath ở trên); nhưng lúc gỡ thì ngược lại: bỏ sót một
// daemon là để lại một tiến trình phục vụ shell trên tailnet sau khi người
// dùng tưởng đã gỡ sạch — và file pid, thứ duy nhất ghi lại nó, sắp bị xoá
// cùng ~/.ccrc.
//
// Không tự dò pid: daemonInfo() đã kiểm pid còn sống VÀ isOurDaemon() để một
// số pid được cấp lại cho tiến trình khác không bao giờ bị bắn nhầm.
async function cmdOffAll() {
  const dir = path.join(os.homedir(), '.ccrc');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('term-pane-') && f.endsWith('.pid'));
  } catch {
    say('✓ Không có phiên remote nào đang chạy');
    return;
  }
  let stopped = 0;
  for (const f of files) {
    // Lấy lại đúng pane id từ tên file — daemonInfo() nhận pane, không nhận
    // đường dẫn, và đó là hàm mang toàn bộ phần kiểm tra an toàn.
    const pane = f.slice('term-pane-'.length, -'.pid'.length);
    const info = daemonInfo(pane);
    if (!info) continue;
    try { process.kill(info.pid, 'SIGTERM'); stopped += 1; } catch { /* vừa tự thoát */ }
    try { fs.unlinkSync(info.file); } catch { /* nothing to remove */ }
  }
  say(stopped ? `✓ Đã dừng ${stopped} phiên remote` : '✓ Không có phiên remote nào đang chạy');
}

// How often /remote pair polls the hub, and how long it waits at each of
// the three stages (a phone showing up, the phone opening its commitment,
// the human's verdict typed on the phone) before giving up. Each stage gets
// its own budget rather than one shared deadline: a slow human deciding on
// the phone is not a network failure and should not race the earlier steps.
const PAIR_POLL_MS = 1000;
const PAIR_WAIT_MS = 120_000;

// How long a computed-but-unconfirmed SAS stays valid on disk, waiting for
// `/remote pair xac-nhan <số>`. Matches the hub's own pairing-queue lifetime
// (server/src/pairing.js PAIR_TTL_MS) so the two halves expire together
// instead of one outliving the other by an arbitrary margin.
const PAIR_TTL_MS = 5 * 60_000;

// `/remote pair` never reads a keypress either — it computes its own SAS,
// prints it, saves it to `~/.ccrc/pairing-pending.json`, and STOPS. It never
// asks the hub whether the human agreed, because the hub is the one that
// chose which phone it was talking to — it could honestly complete a
// handshake with an attacker's phone while the user's own phone sits on a
// different `pairId` (C2, spec §12.2). The verdict lives in `cmdPairConfirm`
// below, which the user runs as a SEPARATE command after reading the number
// off their own phone. See spec §12.3.
async function cmdPair() {
  // Dọn một cuộc ghép dở trước đó (nếu có) trước khi bắt đầu cái mới. Không
  // dọn thì một lần chạy `pair` thất bại giữa chừng để lại
  // `pairing-pending.json` sống tới 5 phút (PAIR_TTL_MS) — `xac-nhan` chạy
  // sau đó âm thầm xác nhận đúng cuộc ghép CŨ, không phải cuộc vừa thử.
  clearPending();

  say('Đang chờ điện thoại xin ghép…');
  say('  Trên điện thoại: mở app, bấm "Ghép máy này".');

  // 1) Đợi một yêu cầu xuất hiện.
  let pair = null;
  let tungGoiDuocHub = false; // để phân biệt "hub sống nhưng chưa có điện
  // thoại nào" với "chưa từng gọi được hub" — hai tình huống khác hẳn nhau,
  // gộp làm một thông báo thì người dùng đi sửa nhầm chỗ.
  const hetGio1 = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < hetGio1) {
    let pairs = [];
    try {
      const r = await hub('/api/pair/pending');
      if (r.ok) { ({ pairs } = await r.json()); tungGoiDuocHub = true; }
    } catch { /* hub chớp nhoáng — thử lại vòng sau */ }

    if (pairs.length > 1) {
      // Từ chối chứ không đoán. So số chỉ có nghĩa khi biết CHẮC đang so với
      // ai; chọn bừa một trong hai là phá đúng cái tính chất đang bảo vệ.
      say('✗ Có nhiều hơn một điện thoại đang xin ghép.');
      say('  Làm từng cái một: bảo những người khác đợi, rồi chạy lại /remote pair.');
      return 1;
    }
    if (pairs.length === 1) { [pair] = pairs; break; }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  if (!pair) {
    if (tungGoiDuocHub) {
      say('✗ Không thấy điện thoại nào xin ghép trong 2 phút.');
      say('  Mở app trên điện thoại, bấm "Ghép máy này", rồi chạy lại /remote pair.');
    } else {
      say('✗ Không gọi được hub trong 2 phút.');
      say('  Kiểm tra mạng/Tailscale và cấu hình hub rồi chạy lại /remote pair.');
    }
    return 1;
  }

  // Ảnh chụp chốt Ở ĐÂY, từ phản hồi /pending — TRƯỚC khi gửi nonceMachine.
  //
  // Đây là toàn bộ chỗ dựa của lập luận an toàn (spec §5.2): hub phải nộp
  // `commit` trước khi biết `nonce_M`. Chốt ở bước 3 (sau challenge) là để
  // hub biết nonce trước rồi bịa cặp (commit, noncePhone) khớp nhau — lúc đó
  // commitMatches() luôn qua và chứng minh RỖNG. Xem spec §12.1.
  const snapshot = {
    pairId: pair.pairId, pubKey: pair.pubKey, commit: pair.commit, label: pair.label,
  };

  // 2) Gửi nonce của máy.
  const nonceMachine = randomNonce();
  const ch = await hub('/api/pair/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairId: pair.pairId, nonceMachine }),
  });
  if (!ch.ok) { say('✗ Hub từ chối bước bắt tay. Thử lại.'); return 1; }

  // 3) Đợi điện thoại mở cam kết.
  let st = null;
  const hetGio2 = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < hetGio2) {
    try {
      const r = await hub(`/api/pair/${encodeURIComponent(pair.pairId)}`);
      if (r.ok) {
        st = await r.json();
        if (st.state === 'revealed' || st.state === 'done' || st.state === 'aborted') break;
      } else if (r.status === 404) {
        say('✗ Yêu cầu ghép cặp đã hết hạn. Làm lại từ đầu.');
        return 1;
      }
    } catch { /* thử lại vòng sau */ }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  // Task 15 review: vòng lặp trên thoát ở CẢ BA state cuối
  // (revealed|done|aborted) để không phải đợi hết PAIR_WAIT_MS khi hub đã
  // quyết định xong — nhưng bản cũ chỉ kiểm `st.noncePhone`, nên một
  // `aborted` vẫn còn giữ `noncePhone` rơi rớt từ lần 'revealed' trước đó
  // (hub thật không xoá trường này khi chuyển state) lọt qua y hệt một cuộc
  // mở cam kết hợp lệ. `aborted` nghĩa là hàng đợi đã bị đóng — không được
  // đi tiếp dù `noncePhone` vẫn còn đó.
  //
  // KHÔNG loại luôn `done`: một hub trung thực hoàn tất TRUNG THỰC với một
  // điện thoại KHÁC (C2, spec §12.2) hợp lệ đưa state tới `done` trong lúc
  // vòng lặp trên vẫn đang đợi — test "hub chuyển hướng sang điện thoại
  // khác…" dựng đúng tình huống này, và cố ý đo `done` xuất hiện trước khi
  // vòng lặp bắt được `revealed` (khoảng đợi PAIR_POLL_MS=1s dài hơn hẳn
  // 300ms hub tự chuyển sang `done` trong test đó). An toàn ở đây không tới
  // từ việc từ chối `done` sớm — nó tới từ việc quyết định KHÔNG BAO GIỜ dựa
  // vào `state` của hub nữa sau bước này: SAS được tính từ ảnh chụp đã chốt
  // (bước 1) và chỉ được ghi nếu người dùng gõ đúng số đọc TRÊN ĐIỆN THOẠI
  // CỦA HỌ (xem cmdPairConfirm) — số đó khác số vừa tính ở đây nếu hub đã
  // chuyển hướng, nên `xac-nhan` mới là nơi an toàn thật sự nằm.
  if (!st || st.state === 'aborted' || !st.noncePhone) {
    say('✗ Điện thoại không trả lời kịp. Làm lại từ đầu.');
    return 1;
  }

  // Bản ghi ở bước 3 phải khớp ảnh chụp đã chốt ở bước 1. Lệch không phải
  // chuyện đua tranh vô hại — hub là bên duy nhất có thể làm nó lệch, và làm
  // thế là tráo đổi (C1, spec §12.1): hễ hub được phép nộp một `commit`/
  // `pubKey` MỚI sau khi đã biết `nonceMachine`, nó chỉ cần bịa một cặp
  // (commit, noncePhone) tự khớp nhau — commitMatches() qua và không chứng
  // minh được gì. Chốt ảnh chụp TRƯỚC khi gửi nonceMachine (bước 1, ở trên)
  // là thứ duy nhất buộc hub phải cam kết trước khi biết nonce của máy.
  if (st.pubKey !== snapshot.pubKey || st.commit !== snapshot.commit) {
    say('✗ CẢNH BÁO: hub trả về khoá hoặc cam kết khác lúc đầu.');
    say('  Đây là dấu hiệu có người đứng giữa. KHÔNG ghép.');
    return 1;
  }

  // 4) Cam kết phải mở ra đúng nonce vừa nhận. Điều này CHỈ chứng minh
  //    `noncePhone` khớp với `commit` trong ảnh chụp — nó không nói gì về
  //    `pubKey`; đó là lý do `pubKey` phải đến từ CÙNG ảnh chụp này chứ
  //    không phải một giả định riêng.
  if (!commitMatches(snapshot.commit, st.noncePhone)) {
    say('✗ CẢNH BÁO: cam kết của điện thoại không khớp.');
    say('  Có thể có người đứng giữa, hoặc hub đang hỏng. KHÔNG ghép.');
    return 1;
  }

  const sas = shortAuthString({
    pubKey: snapshot.pubKey, noncePhone: st.noncePhone, nonceMachine,
  });

  // Dừng NGAY TẠI ĐÂY, không hỏi hub xem người dùng đã đồng ý chưa (C2, spec
  // §12.2/§12.3). Hub chọn nó đang phục vụ yêu cầu ghép của điện thoại nào —
  // nó có thể hoàn tất TRUNG THỰC một cuộc bắt tay với điện thoại của kẻ tấn
  // công trong lúc điện thoại thật của người dùng đang chờ ở một `pairId`
  // khác. Nếu máy tin `state === 'done'` từ hub, tiếng "Không khớp" của
  // người dùng trên chính điện thoại của họ không bao giờ tới được đây.
  //
  // Nên quyết định chuyển hẳn về máy: giữ số này lại, rồi DỪNG. Người dùng
  // đọc số TRÊN ĐIỆN THOẠI của họ — thứ chỉ họ nhìn thấy — và gõ vào máy bằng
  // `/remote pair xac-nhan <số>`. Nếu hub đã chuyển hướng sang một điện thoại
  // khác, số máy tính ra ở đây là số của khoá kẻ tấn công, còn số người dùng
  // gõ vào là số của chính điện thoại họ — hai số lệch nhau, máy từ chối ghi.
  //
  // MÁY KHÔNG ĐƯỢC IN SỐ NÀY RA (spec §12.3, sửa sau review — bản đầu của
  // mục đó bảo in, sai). In nó ngay trên dòng "gõ số trên điện thoại vào đây"
  // biến việc gõ thành chép lại đúng con số vừa hiện — máy khi đó so với
  // chính nó, luôn khớp, và quyền phủ quyết ở C2 bốc hơi.
  const ghi = writePending({
    pairId: snapshot.pairId,
    pubKey: snapshot.pubKey,
    label: snapshot.label,
    sas,
    expiresAt: Date.now() + PAIR_TTL_MS,
  });
  if (!ghi) { say('✗ Không lưu được trạng thái ghép cặp. Thử lại.'); return 1; }

  say('');
  say('Nhìn số đang hiện TRÊN ĐIỆN THOẠI.');
  say('Nếu đúng số đó, gõ nó vào đây:');
  say('  /remote pair xac-nhan <số trên điện thoại>');
  say('Lệch nhau nghĩa là CÓ NGƯỜI ĐỨNG GIỮA — đừng gõ, và đừng thử lại cho tới khi hiểu vì sao.');
  return 0;
}

// Báo lại cho hub máy vừa quyết định gì (spec §12.3: "máy mới là bên gọi
// /api/pair/finish — vai của endpoint đó đảo lại"). CỐ TÌNH fire-and-forget:
// nuốt mọi lỗi mạng, không bao giờ ném, không bao giờ đổi mã thoát của lệnh
// gọi nó. `devices.json` (nếu `ok:true`) đã được ghi CỤC BỘ trên máy này
// TRƯỚC KHI hàm này chạy — một hub không gọi được không được phép biến một
// lần ghép cặp THÀNH CÔNG ở máy thành một dòng lệnh báo lỗi; nó chỉ khiến
// điện thoại (đang chờ xem verdict qua GET /api/pair/<id>, server/public/
// app.js's waitForPairVerdict()) không biết máy đã quyết định gì mà thôi —
// một hiển thị sai trên điện thoại, không phải một khoá sai trên máy.
async function reportPairOutcome(pairId, ok) {
  try {
    await hub('/api/pair/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairId, ok }),
    });
  } catch {
    // Xem comment ở trên: im lặng có chủ đích.
  }
}

// `/remote pair xac-nhan <số>` — bước quyết định thật sự. `soNhap` là chuỗi
// người dùng gõ trên dòng lệnh, đọc từ chính điện thoại của họ; nó có thể
// hoàn toàn VẮNG MẶT (`undefined`, quên gõ số) hoặc `null` — không nhánh nào
// dưới đây được phép ném vì thế.
async function cmdPairConfirm(soNhap) {
  const pending = readPending();
  if (!pending) {
    say('✗ Không có cuộc ghép cặp nào đang chờ (hoặc đã hết hạn).');
    say('  Chạy lại /remote pair trước.');
    return 1;
  }
  if (soNhap === undefined || soNhap === null || String(soNhap).trim() === '') {
    say('✗ Thiếu số xác nhận.');
    say('  Gõ số đang hiện trên điện thoại: /remote pair xac-nhan <số>');
    return 1;
  }
  const soDaGo = String(soNhap).trim();
  if (soDaGo !== pending.sas) {
    say('✗ CẢNH BÁO: số không khớp — CÓ NGƯỜI ĐỨNG GIỮA. Không ghép.');
    say('  Đừng thử lại cho tới khi hiểu vì sao.');
    // Task 15 review: bản trước nói thêm "/remote pair vẫn còn dở để xem lại
    // số của máy" — máy không in số của nó ra (xem cmdPair ở trên), nên cách
    // DUY NHẤT làm theo câu đó là `cat ~/.ccrc/pairing-pending.json`, đọc SAS
    // rồi gõ lại — đúng thứ cảnh báo này vừa bảo đừng làm. Xoá mệnh đề đó.
    //
    // Xoá luôn file pending ở đây: sau khi phát hiện MITM thì không còn gì
    // đáng giữ trong đó — giữ lại là để khoá công khai của kẻ tấn công nằm
    // trong file thêm tới 5 phút (PAIR_TTL_MS), cách đúng MỘT lần gõ đúng số
    // (giờ không còn tồn tại nữa) khỏi bị ghi vào devices.json.
    clearPending();
    // Báo hub để dọn hàng đợi VÀ để điện thoại (đang chờ xem verdict) biết
    // máy đã từ chối — không đợi kết quả, không để một hub im lặng đổi mã
    // thoát của một lần từ chối vốn đã đúng.
    await reportPairOutcome(pending.pairId, false);
    return 1;
  }
  const add = addDevice({ pubKey: pending.pubKey, label: pending.label });
  if (!add.ok) { say(`✗ Không ghi được: ${add.reason}`); return 1; }
  clearPending();
  say(`✓ Đã ghép ${pending.label || 'thiết bị'}`);
  say('  Từ giờ điện thoại này mở được mọi phiên /remote trên máy này.');
  // `devices.json` đã ghi xong Ở TRÊN — cái này chỉ là báo lại, không phải
  // một phần của quyết định. Xem comment của reportPairOutcome().
  await reportPairOutcome(pending.pairId, true);
  return 0;
}

function cmdDevices() {
  const list = listDevices();
  if (!list.length) {
    say('Chưa ghép điện thoại nào với máy này.');
    say('  Ghép bằng: /remote pair');
    return 0;
  }
  say(`Thiết bị đã ghép (${list.length}):`);
  list.forEach((d, i) => {
    const ngay = d.pairedAt ? new Date(d.pairedAt).toLocaleString('vi-VN') : 'không rõ';
    say(`  ${i + 1}. ${d.label || '(không nhãn)'} — ghép ${ngay}`);
  });
  say('');
  say('Gỡ một cái: /remote unpair <số>');
  say('Mất điện thoại: gỡ nó khỏi Tailscale trước — đó mới là công tắc ngắt thật,');
  say('và nó có hiệu lực trên MỌI máy cùng lúc.');
  return 0;
}

// `arg` là chuỗi người dùng gõ trên dòng lệnh — có thể là số thứ tự, có thể
// là nhãn, và (`/remote unpair` không kèm gì) có thể HOÀN TOÀN VẮNG MẶT
// (`undefined`). Không nhánh nào bên dưới giả định `arg` là một chuỗi hay
// tồn tại: `Number(undefined)` là NaN — trượt nhánh số — rồi so sánh nhãn
// với `undefined` cũng chỉ trượt, không bao giờ ném.
function cmdUnpair(arg) {
  const list = listDevices();
  if (!list.length) { say('Chưa ghép thiết bị nào.'); return 0; }
  if (arg === undefined || arg === null || arg === '') {
    say('✗ Thiếu số thứ tự hoặc nhãn thiết bị cần gỡ.');
    say('  Xem danh sách và số thứ tự bằng: /remote devices');
    return 1;
  }
  const i = Number(arg) - 1;
  let d;
  if (Number.isInteger(i) && i >= 0 && i < list.length) {
    // Số thứ tự luôn thắng, không đụng gì tới nhãn — nhãn là dữ liệu HUB
    // (spec §5.3), một hub có thể đặt nhãn một thiết bị trùng nhãn thiết bị
    // khác một cách CỐ Ý, đúng lúc người dùng gõ theo nhãn.
    d = list[i];
  } else {
    // Khớp theo nhãn: nếu NHIỀU thiết bị cùng nhãn, `find` sẽ âm thầm lấy
    // cái ĐẦU TIÊN — người dùng tưởng đã gỡ đúng thiết bị lạ, thực ra có thể
    // đã gỡ thiết bị THẬT của chính mình còn để thiết bị lạ nằm lại. Từ chối
    // và bảo dùng số thứ tự (luôn định danh chính xác — xem /remote devices)
    // thay vì đoán bừa cái nào người dùng muốn.
    const trung = list.filter((x) => x.label === arg);
    if (trung.length > 1) {
      say(`✗ Có nhiều hơn một thiết bị tên "${arg}" — dùng số thứ tự thay vì nhãn.`);
      say('  Xem số thứ tự bằng: /remote devices');
      return 1;
    }
    [d] = trung;
  }
  if (!d) {
    say(`✗ Không có thiết bị "${arg}". Xem danh sách bằng: /remote devices`);
    return 1;
  }
  if (!removeDevice(d.id)) { say('✗ Không gỡ được.'); return 1; }
  say(`✓ Đã gỡ ${d.label || d.id}`);
  return 0;
}

// Everything after `on` is the session name, joined back together so
// `/remote on du an moi` works without quoting.
const nameArg = process.argv.slice(3).join(' ');
const run = mode === 'on' ? () => cmdOn(nameArg)
  : mode === 'off' ? cmdOff
  : mode === 'off-all' ? cmdOffAll
  // `pair xac-nhan <số>` must be checked BEFORE the bare `pair` branch below
  // — both share mode === 'pair', and only argv[3] tells them apart.
  : mode === 'pair' && process.argv[3] === 'xac-nhan'
    ? async () => { process.exitCode = await cmdPairConfirm(process.argv[4]); }
  : mode === 'pair' ? async () => { process.exitCode = await cmdPair(); }
  : mode === 'devices' ? async () => { process.exitCode = cmdDevices(); }
  : mode === 'unpair' ? async () => { process.exitCode = cmdUnpair(process.argv[3]); }
  : cmdStatus;
run().catch((e) => { say(`Lỗi: ${e.message}`); process.exit(1); });
