// Shared daemon-under-test harness, used by both daemon.test.js and
// static.test.js. Kept as a single copy so the two suites can never drift on
// what "the daemon is actually listening" means — see waitListening below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmuxBin } from '../src/tmux.js';
import { signingInputFor, TOKEN_VERSION } from '../src/ticket.js';
import { deviceIdFor } from '../src/devices.js';

export const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term.js');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Đóng vai điện thoại trong test daemon: sinh cặp khoá, ký token v2 bằng ĐÚNG
// định dạng chữ ký mà WebCrypto sinh ra (raw r‖s).
export async function taoThietBiTest() {
  const { subtle } = crypto.webcrypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pubKey = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('base64url');
  return {
    pubKey,
    id: deviceIdFor(pubKey),
    // `host` là BẮT BUỘC (không có mặc định): nó trở thành `h` trong payload,
    // và verifyAttachToken() (C3, spec §13) từ chối MỌI token thiếu nó. Ném
    // lỗi thẳng ở đây, thay vì để JSON.stringify() âm thầm bỏ khoá `h` khi
    // `host` là `undefined` — một test quên truyền host phải chết ngay tại
    // chỗ ký, với một thông báo rõ ràng, không phải trôi xuống thành
    // "wrong_host"/"malformed" khó hiểu ở xa tít bên dưới.
    async ky({ sessionId, machine = 'may-test', ttlMs = 60_000, now = Date.now(), nonce, host }) {
      if (!host) throw new Error('ky(): thiếu host — mọi token phải mang trường h (spec §13, C3)');
      const payload = {
        sid: sessionId, m: machine, iat: now, exp: now + ttlMs,
        n: nonce || crypto.randomBytes(12).toString('base64url'), k: deviceIdFor(pubKey), h: host,
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
        Buffer.from(signingInputFor(b64)));
      return `${TOKEN_VERSION}.${b64}.${Buffer.from(sig).toString('base64url')}`;
    },
  };
}

// Ghi devices.json vào một HOME tạm, đúng định dạng term/src/devices.js đọc.
// `raw` cho phép ghi thẳng chuỗi rác, để dựng ca "file hỏng".
export function ghiDevices(home, devices, raw) {
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.ccrc', 'devices.json'),
    raw !== undefined ? raw : JSON.stringify({ version: 1, devices }),
  );
}

// Ceiling for "this event must eventually happen" waits. It is a failure
// deadline, not a delay: every such wait finishes the instant the event
// arrives, so a generous ceiling costs a healthy run nothing and only stops a
// slow machine from being reported as a broken one.
export const EVENT_TIMEOUT_MS = 20_000;

// Session count is unique per test run (process.pid), but the session NAME
// is reused across tests within the same run, so pane ids must be unique too
// to keep concurrently-running startDaemon() calls from colliding.
let daemonSeq = 0;

export async function startDaemon(extraEnv = {}, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-d-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n');

  // Chuẩn bị sẵn một thiết bị ĐÃ GHÉP cho daemon test này ký token v2 —
  // devices.json được daemon đọc lại ở MỖI kết nối (ccrc-term.js), không
  // phải một lần lúc khởi động, nên ghi trước khi spawn là đủ.
  const sessionId = extraEnv.CCRC_TERM_SESSION_ID || 's-test';
  const phone = await taoThietBiTest();
  ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

  const T = tmuxBin();
  const sess = `ccrc-d-${process.pid}-${daemonSeq++}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  // opts.autoPort exercises the REAL production default: CCRC_TERM_PORT is
  // left unset, so the daemon binds port 0 and the OS assigns whatever is
  // free — the actual port is only knowable from the daemon's own stdout
  // (see waitListeningAutoPort below). Every other caller pins a
  // pre-discovered free port instead, which is simpler but would never
  // catch a regression back to a hard-coded port: a fixed port always
  // "matches" whatever free port this helper's own probe happened to find,
  // it just doesn't prove the DAEMON chose it.
  const pinnedPort = opts.autoPort ? undefined : await freePort();
  const proc = spawn('node', [DAEMON], {
    env: {
      ...process.env, HOME: home,
      ...(pinnedPort !== undefined ? { CCRC_TERM_PORT: String(pinnedPort) } : {}),
      CCRC_TERM_PANE: pane,
      CCRC_TERM_SESSION_ID: sessionId,
      CCRC_TERM_BIND: '127.0.0.1',
      CCRC_TERM_NO_HUB: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Makes `proc` the leader of its OWN process group (see stop() below for
    // why that is the point — it is what lets a single group-kill reliably
    // reap the `tmux -C attach-session` child the daemon spawns per
    // WebSocket connection, instead of racing to find it via `pgrep` first).
    detached: true,
  });
  // Keep the daemon's own output so a failure to start says WHY instead of
  // surfacing as a mystery connection refusal much further down.
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  let port;
  try {
    port = pinnedPort !== undefined ? pinnedPort : await waitListeningAutoPort(proc, () => log);
    await waitListening(port, proc);
  } catch (e) {
    // start() failed, so no test will ever get a `stop()` to call — clean up
    // here or the daemon and its tmux session leak for the rest of the run.
    // Group-kill for the same reason stop() below does.
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    throw new Error(`${e.message}\n--- daemon nói ---\n${log}`);
  }

  return {
    proc, port, pane, sess, phone,
    url: (token) => `ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(token)}`,
    // Ký một token v2 hợp lệ cho ĐÚNG thiết bị đã ghép với daemon này, cho
    // đúng sessionId daemon này đang phục vụ, và cho ĐÚNG host daemon này
    // quảng bá — trừ khi test cố tình ghi đè (vé phiên khác, vé hết hạn, vé
    // ký cho host khác, v.v.). Daemon ở đây luôn bind 127.0.0.1 và không có
    // CCRC_TERM_URL (không caller nào của startDaemon() ghi đè hai biến đó),
    // nên ownHost của nó (ccrc-term.js) luôn là đúng `127.0.0.1:${port}` này.
    token: (over = {}) => phone.ky({ sessionId, machine: 'may-test', host: `127.0.0.1:${port}`, ...over }),
    stop() {
      // A test's WebSocket may not have finished its async close handshake
      // before this runs, which can leave the daemon's per-connection
      // `tmux -C attach-session` child (a grandchild of THIS process, not a
      // child — proc.kill() below never touches it) still connected to the
      // shared tmux server. A client that stays connected keeps that server
      // alive indefinitely even once every session on it is gone, which is
      // exactly how two orphaned processes (a `tmux -C` client and the
      // shared server it was keeping up) survived an entire prior test run —
      // see task-7-report.md, fix round 3.
      //
      // This used to reap that child by asking `pgrep -P` for the daemon's
      // children right here and SIGKILLing whatever it found. That raced
      // `pgrep` itself: `pgrep` is a SEPARATE process this line has to spawn,
      // wait for, and read the output of, and by the time all of that
      // happens the daemon may have already been killed — at which point its
      // `tmux -C` child is instantly reparented to init and `pgrep -P
      // <dead pid>` finds nothing, whether or not the child existed a moment
      // earlier. Measured: a single `daemon.test.js` run reliably left 3-4
      // such orphans behind this way (see task-2-report.md, round 2 review).
      //
      // The fix is to not depend on enumerating children at all. `proc` was
      // spawned with `detached: true` above, which makes it the leader of
      // its OWN process group — and `tmux -C` is spawned normally (not
      // detached) BY the daemon, so it inherits that same group. Signalling
      // the NEGATIVE pid sends the signal to every process in that group in
      // one kernel call: the daemon and any live `tmux -C` child together,
      // atomically, with no separate process to spawn and nothing to race.
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      // Belt-and-suspenders: if the group-kill above ever misses something
      // (e.g. a future child that detaches itself into its own group), fall
      // back to the old pgrep-based sweep so this does not regress silently.
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      try { proc.kill('SIGKILL'); } catch {}
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
      // Task 5: any test that connected a WS client made the daemon create
      // a GROUPED session (`${sess}-ccrc-web` — see ccrc-term.js). The
      // daemon's own graceful shutdown normally kills it, but the SIGKILL
      // above gives it no chance to run that cleanup, so it has to be swept
      // here too or it leaks as an orphaned tmux session for the rest of
      // the run. Harmless no-op (via the try/catch) for tests that never
      // connected a client at all.
      try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch {}
      // Test hygiene: don't leave mkdtemp HOME dirs behind (they accumulated
      // across runs before this cleanup existed — see task-6 review round 2).
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

// Ask the OS for a port nobody is using, instead of guessing one out of a
// 100-wide range: a guess collides sooner or later, and a daemon that loses
// that race dies with EADDRINUSE while the test goes on talking to whatever
// else answers on that port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Wait for the daemon to actually accept connections rather than assume a
// fixed sleep is long enough. The fixed sleep this replaces was not merely
// slow — when it ran short (a loaded machine is enough) the daemon was not
// listening yet, and EVERY negative test in this file, all of which assert
// that a connection is refused, passed for the wrong reason: a daemon that
// is not up refuses everything. Waiting for the real condition, and throwing
// loudly when it never arrives, is what keeps those assertions honest.
async function waitListening(port, proc, timeoutMs = EVENT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portListening(port)) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`daemon thoát trước khi kịp lắng nghe cổng ${port} ` +
        `(code=${proc.exitCode} sig=${proc.signalCode})`);
    }
    await sleep(25);
  }
  throw new Error(`daemon không lắng nghe được cổng ${port} sau ${Date.now() - t0}ms`);
}

// Discovers the REAL port a daemon bound when it was started with no
// CCRC_TERM_PORT override (opts.autoPort in startDaemon) — the equivalent of
// `ccrc-term-cli.js`'s own `waitForDaemonStart`, which parses this exact
// line back out of the daemon's stdout for the same reason: with the
// production default of port 0, nothing outside the daemon knows the port
// until the daemon itself says so.
async function waitListeningAutoPort(proc, getLog, timeoutMs = EVENT_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = /\[term\] nghe [^:]+:(\d+), pane/.exec(getLog());
    if (m) return Number(m[1]);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error('daemon thoát trước khi kịp báo cổng đang nghe ' +
        `(code=${proc.exitCode} sig=${proc.signalCode})`);
    }
    await sleep(25);
  }
  throw new Error(`daemon không báo cổng đang nghe sau ${Date.now() - t0}ms`);
}

// Wait for a process to exit ON ITS OWN, up to a generous ceiling. This
// replaces "sleep long enough and hope": a flat sleep has to cover the worst
// case on the slowest machine or it fails at random, and it pays that cost on
// every run even when the process exits immediately.
export function waitExit(proc, timeoutMs = EVENT_TIMEOUT_MS) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

// Finds the direct child pids of a process (used to reach the `tmux -C`
// control-mode child spawned per WebSocket connection, which has no other
// externally visible handle).
export function childPids(ppid) {
  try {
    return execFileSync('pgrep', ['-P', String(ppid)], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
