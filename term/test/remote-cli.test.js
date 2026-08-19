import test from './can-tmux.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmuxBin, GROUP_SESSION_SUFFIX } from '../src/tmux.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpHome(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

// Mirrors ccrc-term-cli.js's own pidFilePath(): one file per pane, under
// ~/.ccrc/term-pane-<paneId>.pid. Kept here as a single source of truth for
// the test suite so every test that pokes at a pid file agrees with the CLI
// on where it lives, instead of duplicating the path shape at each call site.
function pidFilePath(home, pane) {
  return path.join(home, '.ccrc', `term-pane-${pane}.pid`);
}

function stubHub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// CCRC_HOME ĐI KÈM HOME, không thay HOME.
//
// `...process.env` kế thừa luôn một CCRC_HOME của môi trường ngoài, và từ khi
// `readConfig` mặc định về `ccrcHome()` thì biến kế thừa ấy THẮNG HOME giả mà
// bài test vừa dựng — CLI đọc cấu hình ở nhà của người chạy test. Đo được:
// xuất CCRC_HOME rồi chạy bộ term → cả 31 bài trong file này đỏ, rồi lượt chạy
// treo. Mỗi lời gọi ở đây đều đưa HOME, nên suy CCRC_HOME ra từ chính HOME ấy
// là đúng một chỗ và không thể trôi khỏi nhau; caller nào tự đặt CCRC_HOME thì
// vẫn thắng. HOME ở lại vì tmux, shell và mọi thứ khác trong pane vẫn đọc nó.
function run(args, env, opts = {}) {
  const goi = { ...process.env, ...env };
  // HOME là BẮT BUỘC, không có ngoại lệ nào — kể cả khi caller đã tự đưa
  // CCRC_HOME. Đây là chỗ bản trước còn hở, và hở đúng vào ca mà phép kiểm
  // `in` sinh ra để phục vụ: `run(['off'], { CCRC_HOME: '' })` là một caller
  // cố tình thử nhánh "coi như chưa đặt" của ccrcHome() — nó đi lọt cửa, thừa
  // kế HOME THẬT từ `...process.env`, rồi ccrcHome() coi `''` là chưa đặt và
  // rơi về os.homedir(). Kết quả: CLI đọc VÀ GHI hồ sơ thật, tái tạo đúng sự
  // cố mà cả đợt việc này sinh ra để đóng, ngay bên trong cái cửa dựng lên để
  // chặn nó.
  //
  // Tách đôi cho rõ: HOME luôn phải là một nhà giả, còn CCRC_HOME thì tôn
  // trọng nguyên văn nếu caller có nói — `'CCRC_HOME' in env` chứ không
  // `env.CCRC_HOME`, vì một phép kiểm falsy sẽ lặng lẽ thay mất cái `''` mà
  // bài test muốn đo.
  if (!env || typeof env.HOME !== 'string' || env.HOME === '') {
    throw new Error('run() cần HOME trỏ một nhà giả — không thì CLI đọc hồ sơ thật.');
  }
  if (!('CCRC_HOME' in env)) goi.CCRC_HOME = env.HOME;
  return new Promise((r) => execFile('node', [CLI, ...args], { env: goi, ...opts },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

// Canh chính cái cửa ở trên. Không có bài này thì lỗ hở kia im lặng: nó không
// làm bài nào đỏ, nó chỉ làm CLI ghi vào hồ sơ thật của người chạy test.
test('run() từ chối một lời gọi không có nhà giả — kể cả khi đã đưa CCRC_HOME', () => {
  // `assert.throws` chứ không `assert.rejects`: cửa này chốt ĐỒNG BỘ, trước cả
  // khi có promise nào. Đó là chỗ đúng để chốt — người viết test sai thấy lỗi
  // ngay tại dòng gọi, không phải trong một promise bị bỏ quên.
  //
  // Ca đã hở: CCRC_HOME rỗng nghĩa là "coi như chưa đặt", nên nếu HOME không
  // được đòi thì CLI rơi thẳng về os.homedir() — hồ sơ THẬT.
  assert.throws(() => run(['off'], { CCRC_HOME: '' }), /nhà giả/);
  assert.throws(() => run(['off'], { CCRC_HOME: '/tmp/co-that' }), /nhà giả/);
  assert.throws(() => run(['off'], {}), /nhà giả/);
  assert.throws(() => run(['off'], { HOME: '' }), /nhà giả/);
});

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A live process that is emphatically NOT our daemon — used to prove that a
// PID file naming an unrelated (but real, running) process is never trusted
// or signalled just because the number matches.
function spawnForeign() {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  return p;
}

// A pid that is guaranteed dead: spawn a process, wait for it to exit, then
// hand back its former pid.
function deadPid() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = p.pid;
    p.on('exit', () => resolve(pid));
  });
}

// A live process that merely MENTIONS the daemon's path — as a trailing,
// incidental argument, not as the script being run. `node -e '<code>'
// <path>` executes <code> via -e; <path> just lands in argv unused. This is
// exactly the shape a naive `command.includes(daemonPath)` would misidentify
// as our daemon (a linter, a file watcher, anything invoked with the path as
// an argument), even though the process running is plainly something else.
const DAEMON_PATH = path.join(path.dirname(CLI), 'ccrc-term.js');
function spawnLookalike() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', DAEMON_PATH], { stdio: 'ignore' });
}

// Round 4, bypass 1: the SAME shape as spawnLookalike, spelled with `=`.
// node accepts `--eval=<code>` for every one of -e/--eval/-p/--print, and the
// guard used to compare whole argv entries against that set — so `--eval=…`
// never matched it, and the daemon path trailing behind was read as a script
// this process had run. A real victim: the code below keeps it alive for 30s,
// so if `off` signals it the assertion sees a corpse.
//
// The inline code deliberately contains NO WHITESPACE. `ps -o command=` hands
// back one flat string, so a payload with spaces splits into several pseudo-
// arguments and the very first of them (`=>`) is a non-flag that fails the
// path comparison — the check would then pass for an accidental reason and a
// mutation removing the `--flag=value` normalisation would stay green. With a
// space-free payload the daemon path really is the first non-flag argument,
// so only the flag normalisation can save it.
function spawnEvalEqualsLookalike() {
  return spawn(process.execPath, ['--eval=setTimeout(function(){},30000)', DAEMON_PATH], { stdio: 'ignore' });
}

// Round 4, bypass 3 (not in the report, found while checking that "first
// non-flag argument only" is load-bearing): a REAL node script, run with the
// daemon's path as that script's OWN argument — `node lint.js
// <daemon path>`. Round 3 accepted the daemon's path in any argument
// position, so this was ours too. Everything after the script name is the
// script's argv, and node never looked at it.
function spawnScriptWithDaemonArg(dir) {
  const script = path.join(dir, 'khong-phai-daemon.js');
  fs.writeFileSync(script, 'setTimeout(function () {}, 30000);\n');
  return { script, proc: spawn(process.execPath, [script, DAEMON_PATH], { stdio: 'ignore' }) };
}

// Round 4, bypass 2: not node at all. `tail -f <daemon path>` merely READS
// the file — as would an editor, `less`, `grep`, `cp`. argv[0] was never
// required to be a node binary, so any command carrying the daemon's path as
// an argument was accepted as our daemon and signalled. `-f` keeps it alive.
function spawnNonNodeHolder() {
  return spawn('tail', ['-f', DAEMON_PATH], { stdio: 'ignore' });
}

// A directory containing one executable that never answers, placed first on
// PATH so the CLI's `execFileSync('ps'|'lsof', ...)` resolves to it instead
// of the real tool. `exec` keeps it a single process, so the timeout's
// SIGTERM lands on the thing that is actually sleeping. The sleep is far
// longer than the CLI's own timeout on purpose: it only ever elapses in full
// if that timeout is missing, so it costs the suite nothing when the code is
// correct.
function hangingBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hang-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexec sleep 30\n');
  fs.chmodSync(file, 0o755);
  return dir;
}

// Generous enough that a slow machine never trips it, far below the 30s the
// fake would take if the CLI waited for it.
const BOUNDED_MS = 8000;

// Env for a real daemon that never touches Tailscale or a real hub — the
// same pattern daemon.test.js uses for its fakes.
//
// `home` KHÔNG có giá trị mặc định, và đó là chủ ý. Hàm này từng không nhận nhà
// nào cả: nó trải `...process.env` rồi thôi, nên ba con daemon THẬT nó dựng lên
// chạy dưới nhà thật của người chạy test và để lại
// `~/.ccrc/sessions/s-test.json` trong đó. Vòng sửa trước đã vá `run()` trong
// chính file này mà bỏ sót đúng cái helper không mang tên `run`. Bắt buộc phải
// truyền thì không ai bỏ sót được nữa — quên là lỗi cú pháp lúc gọi, không phải
// một file lặng lẽ xuất hiện trong hồ sơ thật.
function daemonEnv(pane, port, home) {
  if (typeof home !== 'string' || home === '') {
    throw new Error('daemonEnv cần một HOME giả — daemon này ghi sổ tra phiên vào đó.');
  }
  return {
    ...process.env,
    HOME: home,
    CCRC_HOME: home,
    CCRC_TERM_PANE: pane,
    CCRC_TERM_SESSION_ID: 's-test',
    CCRC_TERM_PORT: String(port),
    CCRC_TERM_BIND: '127.0.0.1',
    CCRC_TERM_NO_HUB: '1',
  };
}

function newTmuxPane(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  return {
    sess, pane,
    kill() { try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ } },
  };
}

// A tmux pane running Claude the way it ACTUALLY runs in production —
// deploy/ccrc, not a bare `exec`.
//
// This fixture used to build a pane whose #{pane_current_command} was
// literally "claude" (copy a real node binary to a file named `claude`, give
// tmux that path as the WHOLE new-session command, nothing after it). That
// shape is real — `tmux new-session <binary>` with nothing trailing DOES let
// the pane's shell tail-call `exec` straight into the binary — but it is not
// the shape any real launch produces. deploy/ccrc's actual pane command is
// `'<claude path>' args...; printf %s $? > <rcfile>` (see deploy/ccrc's own
// RC_FILE comment): the trailing `; printf` captures Claude's exit code as
// ccrc's own and is deliberately never removed. BECAUSE something has to run
// after Claude exits, the shell cannot exec-optimize into it — it must fork
// Claude as a CHILD and stay alive itself to run the printf. Measured live on
// the user's own machine: both of their real /remote panes report
// #{pane_current_command} = "zsh", with Claude one level down as zsh's child
// (pane_pid 16953 = `zsh -c '.../claude'; printf ...`, 16954 = the real
// claude). `candidates` filtering on `p.cmd === 'claude'` matched the OLD
// fixture's shape and matched NEITHER of those real panes — `ccrc remote`
// printed "Không có phiên Claude Code nào đang chạy trong tmux" against a
// machine that had two. The old fixture was answering an easier question
// (is the pane's foreground process named claude?) than production actually
// asks (is claude running ANYWHERE under this pane?), and every `candidates`
// test passed anyway because the fixture and the assumption matched each
// other, not reality.
//
// The fix here is the same trick deploy/ccrc uses, for the same reason: give
// the shell something to do AFTER the claude process so it cannot tail-call
// into it. `; true` is the minimal version of `; printf ...`. Verified live
// (see fix-claude-detection-report.md) to reproduce pane_current_command=zsh
// with the fake claude binary as the pane_pid's child, matching production.
//
// A shebang script named "claude" reports as its INTERPRETER (sh), not as
// "claude" (verified by hand); copying a real node binary to a file named
// `claude` and running THAT is what actually makes ps see a command whose
// first token's basename is "claude" — see isClaudeCommand in
// ccrc-term-cli.js for why that basename match is what candidates now looks
// for.
// Both fixtures below have to prove the shape they claim to build by
// reading tmux's OWN #{pane_current_command} right after creating the
// session — this is the review finding this pair of comments is about: a
// fixture whose name and comment assert a shape, with nothing checking it,
// is exactly the defect that shipped the ORIGINAL detection bug (see this
// file's header). Polled rather than read once: the pane's shell has to
// actually run for a moment before #{pane_current_command} settles — proven
// live while building this check, a single immediate read after
// `new-session -d` intermittently caught the pre-exec transient state and
// let a broken shape-B fixture (no trailing `; true`) read as correctly
// "not claude" for the wrong reason (a race, not a real non-exec). Bounded
// so a genuinely stuck fixture still fails instead of hanging.
function pollForegroundCommand(T, pane, isDone, attempts = 40) {
  let cmd = '';
  for (let i = 0; i < attempts; i++) {
    cmd = execFileSync(T, ['display-message', '-p', '-t', pane, '#{pane_current_command}'], { encoding: 'utf8' }).trim();
    if (isDone(cmd)) return cmd;
  }
  return cmd; // exhausted — caller's own assertion reports the failure with this last-seen value
}

// Review finding: this fixture's whole job is to build shape B, and until
// now nothing checked that it actually had. This is precisely the defect
// that shipped the ORIGINAL bug this file is about — a fixture whose name
// and comment claim a shape, with nothing verifying it, so a shell that
// exec-optimizes despite the trailing `; true` (or a future edit to the
// command string) would silently degrade every shape-B test to exercising a
// foreground-only implementation and they would all stay green. Verified
// here, in the fixture itself, right after the shape is built — a shape
// regression must fail loudly at its source, not surface later as an
// unrelated-looking candidates failure.
function newClaudePane(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakeclaude-'));
  const fakeClaude = path.join(dir, 'claude');
  fs.copyFileSync(process.execPath, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24',
    `${fakeClaude} -e "setTimeout(()=>{},30000)"; true`]);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  // Shape B succeeds by NEVER exec-ing into fakeClaude, so "poll until it
  // becomes claude" is the right predicate here too: if the trailing
  // `; true` is doing its job, the loop simply exhausts its budget without
  // ever seeing "claude" and returns the last (shell) reading — exactly the
  // same total wait as newClaudePaneForeground gets to actually complete
  // its exec, so a fixture that regressed to shape A is given a fair chance
  // to prove it before this assertion is trusted.
  const fgCmd = pollForegroundCommand(T, pane, (c) => c === 'claude');
  assert.notEqual(fgCmd, 'claude',
    `newClaudePane phải dựng shape B (claude chạy như CON của shell, shell vẫn là tiến trình chính của pane) — nhưng #{pane_current_command} lại là "claude": fixture đã suy biến thành shape A, mọi test dựa vào fixture này đang kiểm nhầm cài đặt`);
  return {
    sess, pane,
    kill() {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// The OTHER real shape (A): claude as the pane's OWN foreground process,
// with nothing trailing to stop the shell's tail-call `exec` — rare in
// practice (needs something like `tmux new-session claude` with no wrapper
// at all), but it does happen, and the subtree walk must keep recognising it
// — a pid is trivially a one-node subtree of itself. Kept SEPARATE from
// newClaudePane rather than folded into it, so a regression that breaks
// shape-A detection while shape-B stays fine shows up as its own failing
// test instead of being silently absorbed into a fixture that only ever
// exercises shape B.
//
// Same review finding as newClaudePane above: nothing used to verify the
// pane's shell actually exec-optimized into fakeClaude instead of, say,
// forking it, which would silently turn this into a second copy of shape B.
function newClaudePaneForeground(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakeclaude-fg-'));
  const fakeClaude = path.join(dir, 'claude');
  fs.copyFileSync(process.execPath, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24',
    `${fakeClaude} -e "setTimeout(()=>{},30000)"`]);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  const fgCmd = pollForegroundCommand(T, pane, (c) => c === 'claude');
  assert.equal(fgCmd, 'claude',
    `newClaudePaneForeground phải dựng shape A (claude LÀ tiến trình chính của pane, không qua shell bọc) — nhưng #{pane_current_command} lại là "${fgCmd}", không bao giờ trở thành "claude": fixture không dựng đúng shape A, mọi test dựa vào fixture này đang kiểm nhầm cài đặt`);
  return {
    sess, pane,
    kill() {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// Review finding: the discrimination rule (isClaudeCommand's first-token-
// basename match) had zero coverage — every existing candidates test still
// passes if it is replaced with `cmd => cmd.includes('claude')`. This
// fixture builds the pane that rule exists to reject: a command that merely
// MENTIONS a file named `claude` (as `tail -f`'s argument) without ever
// running it. First token is `tail`, not `claude` — a substring match would
// wrongly include it; the basename-of-first-token match must not.
function newPaneTailingClaudeFile(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-tailclaude-'));
  const fileNamedClaude = path.join(dir, 'claude');
  fs.writeFileSync(fileNamedClaude, 'chỉ là một file tên "claude", không phải chương trình có thể chạy\n');
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24',
    `tail -f ${fileNamedClaude}`]);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  return {
    sess, pane,
    kill() {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// Review finding, second half: the ROUND-2 tightening (see
// ccrc-term-cli.js's design comment on subtreeHasClaude) added a new safety
// property — a claude process in the subtree must be attached to the pane's
// OWN tty — and it must not be assertable-by-accident either. This builds
// the exact shape measured live on the user's machine: a claude-named
// process that exists in the subtree but is NOT the pane's own interactive
// session — a HEADLESS claude with no controlling terminal at all.
//
// `spawn(..., { detached: true })` is what actually produces this
// honestly: on POSIX, Node calls setsid() in the child before exec, making
// it the leader of a brand-new session — which starts with NO controlling
// terminal (`ps` reports `tty ??`), exactly the `stat=Ss, tty=??` shape
// measured for the real headless claude (see the design comment). The
// "supervisor" script that spawns it is kept alive (a live event loop, not
// exiting) so the headless claude's ppid stays a live descendant of the
// pane's own pid — otherwise it would simply be reparented to init and
// vanish from the pane's subtree entirely, which would prove nothing about
// the tty check. Written as `.mjs` so it runs as ESM regardless of what
// `"type"` the nearest package.json declares — this project's is "module",
// but a temp directory has none at all.
function newPaneWithHeadlessClaudeChild(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-headless-'));
  const fakeClaude = path.join(dir, 'claude');
  fs.copyFileSync(process.execPath, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  const supervisor = path.join(dir, 'supervisor.mjs');
  fs.writeFileSync(supervisor, [
    "import { spawn } from 'node:child_process';",
    'const headless = spawn(process.argv[2], ["-e", "setTimeout(()=>{},30000)"], { detached: true, stdio: "ignore" });',
    'headless.unref();',
    'setInterval(() => {}, 1e9); // stay alive so the headless child keeps a live parent inside the pane subtree',
  ].join('\n'));
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24',
    `${process.execPath} ${supervisor} ${fakeClaude}; true`]);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  return {
    sess, pane,
    kill() {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

test('chạy ngoài tmux: báo lỗi rõ, KHÔNG bật gì', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run(['on'], { HOME: home, TMUX_PANE: '', TMUX: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /tmux/i);
});

test('trạng thái khi chưa có phiên nào', async () => {
  const { srv, base } = await stubHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  const r = await run([], { HOME: home, TMUX_PANE: '', TMUX: '' });
  srv.close();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TẮT|chưa mở/i);
});

test('trạng thái khi đang có phiên: báo hub OK và tên máy', async () => {
  const { srv, base } = await stubHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [{ sessionId: 's1', machine: 'may-dev', url: 'wss://x/attach', label: 'proj', alive: true }] }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=may-dev\n`);
  const r = await run([], { HOME: home, TMUX_PANE: '', TMUX: '' });
  srv.close();
  assert.match(r.stdout, /BẬT|đang mở/i);
  assert.match(r.stdout, /may-dev/);
});

test('trạng thái gọi THẬT lên hub, không đọc mỗi file', async () => {
  let hits = 0;
  const { srv, base } = await stubHub((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  await run([], { HOME: home, TMUX_PANE: '', TMUX: '' });
  srv.close();
  assert.equal(hits, 1, 'phải gọi hub đúng một lần — đây là chẩn đoán duy nhất người dùng có');
});

test('hub chết: báo rõ chứ không im lặng', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run([], { HOME: home });
  assert.match(r.stdout + r.stderr, /không gọi được|lỗi/i);
});

test('chưa cấu hình: chỉ ra việc cần làm', async () => {
  const home = tmpHome(null);
  const r = await run([], { HOME: home });
  assert.match(r.stdout + r.stderr, /chưa cấu hình|setup/i);
});

// --- Review finding: PID reuse must never let `off` sign someone else's ----
// --- death warrant just because the number in the file happens to match. --
// All of these give the CLI a plain fake pane id — `off` needs SOME pane to
// know which file to look at, but nothing below requires that pane to be a
// real, live tmux pane; the file it addresses is what's under test.

test('off gặp PID lạ: KHÔNG giết, KHÔNG nhận vơ, xoá file cũ', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-1';
  const foreign = spawnForeign();
  try {
    await sleep(200); // để tiến trình lạ thực sự lên bảng ps trước khi ta ghi pid của nó
    const pidfile = pidFilePath(home, pane);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: foreign.pid, sessionId: 's-fake' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

    assert.equal(isAlive(foreign.pid), true, 'off không được đụng tới tiến trình không phải daemon của mình');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/, 'không được báo như thể vừa tắt được một phiên');
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false, 'file pid sai chủ phải bị dọn, không để lại đánh lừa lần sau');
  } finally {
    try { process.kill(foreign.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// --- Review finding: matching the daemon's path ANYWHERE on the command ---
// --- line is still a weak signal — it must be the script actually run. ----

test('off gặp tiến trình chỉ NHẮC TỚI đường dẫn daemon (không phải chạy nó): không giết, dọn file', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-2';
  const lookalike = spawnLookalike();
  try {
    await sleep(200);
    // Sanity check the setup: the daemon's path really is on this process's
    // command line, just not in the position that identifies it.
    const cmd = execFileSync('ps', ['-ww', '-p', String(lookalike.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(cmd, /ccrc-term\.js/, 'setup sanity: đường dẫn daemon phải thực sự xuất hiện trên command line');

    const pidfile = pidFilePath(home, pane);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: lookalike.pid, sessionId: 's-fake' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

    assert.equal(isAlive(lookalike.pid), true,
      'chỉ nhắc tới đường dẫn daemon trên command line không đủ để bị coi là daemon và bị giết');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/);
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(lookalike.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// --- MED (đợt sửa cuối, mục 3): hai lối lách còn lại của phép nhận diện ----
// --- Cả hai đều đã tái hiện được với một nạn nhân THẬT bị giết. ------------

test('off gặp `node --eval=<code> <đường dẫn daemon>`: KHÔNG giết — dạng cờ nối bằng "=" cũng là chạy code nội tuyến', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-eval-eq';
  const victim = spawnEvalEqualsLookalike();
  try {
    await sleep(200);
    const cmd = execFileSync('ps', ['-ww', '-p', String(victim.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(cmd, /--eval=/, 'setup sanity: phải đúng dạng cờ nối bằng dấu "="');
    assert.match(cmd, /ccrc-term\.js/, 'setup sanity: đường dẫn daemon phải thực sự nằm trên command line');

    const pidfile = pidFilePath(home, pane);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: victim.pid, sessionId: 's-fake' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

    assert.equal(isAlive(victim.pid), true,
      '`--eval=` là chạy code nội tuyến y như `-e` — đường dẫn đi sau nó KHÔNG phải script được chạy, không được giết');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/);
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(victim.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('off gặp `node <script khác> <đường dẫn daemon>`: KHÔNG giết — mọi thứ sau tên script là argv CỦA SCRIPT', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-argv';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-argv-'));
  const { proc: victim } = spawnScriptWithDaemonArg(dir);
  try {
    await sleep(200);
    const cmd = execFileSync('ps', ['-ww', '-p', String(victim.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(cmd, /ccrc-term\.js/, 'setup sanity: đường dẫn daemon phải thực sự nằm trên command line');
    assert.match(cmd, /khong-phai-daemon\.js/, 'setup sanity: script được chạy phải là một script KHÁC');

    const pidfile = pidFilePath(home, pane);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: victim.pid, sessionId: 's-fake' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

    assert.equal(isAlive(victim.pid), true,
      'chỉ tham số ĐẦU TIÊN không phải cờ mới là script node chạy — phần còn lại là argv của script đó, chứng minh không gì cả');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/);
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(victim.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('off gặp `tail -f <đường dẫn daemon>`: KHÔNG giết — đọc một file không phải là chạy nó', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-tail';
  const victim = spawnNonNodeHolder();
  try {
    await sleep(200);
    const cmd = execFileSync('ps', ['-ww', '-p', String(victim.pid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(cmd, /ccrc-term\.js/, 'setup sanity: đường dẫn daemon phải thực sự nằm trên command line');
    assert.doesNotMatch(cmd, /(^|\/)node(js)?[0-9.]*\s/, 'setup sanity: tiến trình này KHÔNG được là node');

    const pidfile = pidFilePath(home, pane);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: victim.pid, sessionId: 's-fake' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

    assert.equal(isAlive(victim.pid), true,
      'bất kỳ lệnh nào (tail, less, grep, cp, trình soạn thảo) mang đường dẫn daemon làm tham số đều KHÔNG phải daemon của ta');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/);
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(victim.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('off gặp PID đã chết hẳn: báo vốn đã tắt, dọn file', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-3';
  const pid = await deadPid();
  const pidfile = pidFilePath(home, pane);
  fs.writeFileSync(pidfile, JSON.stringify({ pid, sessionId: 's-fake' }));

  const r = await run(['off'], { HOME: home, TMUX_PANE: pane });

  assert.match(r.stdout, /vốn đã tắt/i);
  assert.equal(fs.existsSync(pidfile), false);
});

test('trạng thái với PID lạ trong file: coi như đang TẮT', async () => {
  const { srv, base } = await stubHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
  });
  const home = tmpHome(`CCRC_HUB_URL=${base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  const pane = '%fake-4';
  const foreign = spawnForeign();
  try {
    await sleep(200);
    fs.writeFileSync(pidFilePath(home, pane), JSON.stringify({ pid: foreign.pid, sessionId: 's-fake' }));

    const r = await run([], { HOME: home, TMUX_PANE: pane });
    srv.close();

    assert.match(r.stdout, /ĐANG TẮT/, 'PID lạ không được đọc thành daemon đang chạy');
  } finally {
    try { process.kill(foreign.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('on gặp PID lạ trong file: không bị chặn khởi động vì trùng số', async () => {
  const tp = newTmuxPane('ccrc-cli-on');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const foreign = spawnForeign();
  const pidfile = pidFilePath(home, tp.pane);
  try {
    await sleep(200);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: foreign.pid, sessionId: 's-fake' }));

    // CCRC_TERM_BIND/NO_HUB because `on` really does start the daemon here,
    // and the daemon must not touch real Tailscale state or a real hub in a
    // test — pin the bind address to loopback exactly like daemon.test.js
    // does for its fakes.
    const r = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8799',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });

    assert.match(r.stdout, /ĐÃ BẬT/, 'PID lạ trùng số không được làm on nghĩ là "đã bật sẵn"');
    assert.doesNotMatch(r.stdout, /đã bật sẵn/i);
  } finally {
    try { process.kill(foreign.pid, 'SIGKILL'); } catch { /* already gone */ }
    try {
      const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    tp.kill();
  }
});

// Positive case: a genuine daemon this CLI itself started must still be
// recognised and stoppable — the identity check tightening must not turn
// into a false NEGATIVE for the one process it exists to recognise.
// CCRC_TERM_BIND/CCRC_TERM_NO_HUB keep the real daemon from touching
// Tailscale or a real hub, exactly as daemon.test.js does for its fakes.
test('off gặp daemon THẬT do chính on khởi động: nhận diện đúng và tắt được', async () => {
  const tp = newTmuxPane('ccrc-cli-realoff');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  try {
    const on = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8798',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on.stdout, /ĐÃ BẬT/);
    const startedPid = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
    assert.equal(isAlive(startedPid), true, 'daemon thật phải còn sống ngay sau khi bật');

    const off = await run(['off'], { HOME: home, TMUX_PANE: tp.pane });
    assert.match(off.stdout, /ĐÃ TẮT/, 'daemon thật phải được nhận diện đúng, không bị coi là lạ');
    await sleep(300);
    assert.equal(isAlive(startedPid), false, 'daemon thật phải thực sự bị dừng');
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    tp.kill();
  }
});

// --- Review round 3: refusing to recognise a REAL daemon is worse than -----
// --- the round-2 false positive it replaced — off must not lie "nothing ---
// --- here" while a daemon is still up and still serving a shell. ----------

test('daemon thật khởi động bằng đường dẫn TƯƠNG ĐỐI vẫn được nhận diện', async () => {
  const tp = newTmuxPane('ccrc-cli-rel');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  // Not reachable through cmdOn (it always spawns the absolute path), but
  // argv[1] === DAEMON (the round-2 fix) would refuse to recognise this —
  // "ccrc-term.js" is not the absolute DAEMON path as a bare string.
  const proc = spawn(process.execPath, ['ccrc-term.js'], {
    cwd: path.dirname(DAEMON_PATH),
    env: daemonEnv(tp.pane, 8797, home),
    stdio: 'ignore',
  });
  try {
    await sleep(500);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: proc.pid, sessionId: 's-test' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: tp.pane });

    assert.match(r.stdout, /ĐÃ TẮT/,
      'daemon thật khởi động bằng đường dẫn tương đối vẫn phải được nhận diện và tắt được, không phải báo "vốn đã tắt"');
    await sleep(300);
    assert.equal(isAlive(proc.pid), false, 'daemon phải thực sự bị dừng');
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    tp.kill();
  }
});

// --- lsof không có trên mọi máy -------------------------------------------
//
// `lsof` đi kèm macOS, nên phụ thuộc này vô hình ở đây. Debian/Ubuntu KHÔNG cài
// sẵn nó — đo trên Ubuntu 26.04 sạch: `command -v lsof` không thấy gì. Thiếu nó,
// processCwd() không trả lời được, người gọi lùi về cwd của CHÍNH lệnh off, và
// một daemon chạy từ thư mục khác bằng đường dẫn tương đối thôi không còn được
// nhận diện: `off` in "vốn đã tắt" trong khi daemon vẫn sống và vẫn phục vụ một
// shell trên tailnet. Đúng hướng-hỏng mà chú thích "Round 3" trong
// ccrc-term-cli.js nói là tệ hơn cái false positive nó thay thế.
//
// Linux trả lời được câu này mà không cần công cụ nào: /proc/<pid>/cwd là
// symlink do kernel giữ.

// PATH chỉ chứa đúng thứ đường `off` cần, và CỐ Ý không có lsof. Trung thực với
// máy thật: lsof VẮNG MẶT nên execFileSync ném ENOENT, chứ không phải một stub
// chỉ thoát khác 0.
function pathWithoutLsof() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-nolsof-'));
  for (const name of ['node', 'ps', 'tmux']) {
    let real;
    try {
      real = name === 'node' ? process.execPath
        : execFileSync('command', ['-v', name], { encoding: 'utf8', shell: true }).trim();
    } catch { return null; }
    if (!real) return null;
    fs.symlinkSync(real, path.join(bin, name));
  }
  return bin;
}

test('không có lsof: daemon thật khởi động bằng đường dẫn TƯƠNG ĐỐI vẫn được nhận diện', async (t) => {
  // /proc là thứ duy nhất trả lời được câu này mà không cần lsof. macOS không có
  // nó, nên ở đó lsof vẫn là đường duy nhất và bài test này không nói được gì —
  // bỏ qua rõ ràng thay vì đỏ vì một lý do không liên quan.
  if (!fs.existsSync('/proc/self/cwd')) {
    t.skip('máy này không có /proc (macOS) — ở đó lsof vẫn là đường duy nhất, không có gì để canh');
    return;
  }
  const bin = pathWithoutLsof();
  if (!bin) { t.skip('không dựng được PATH tối giản (thiếu ps hoặc tmux)'); return; }

  const tp = newTmuxPane('ccrc-cli-nolsof');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  const proc = spawn(process.execPath, ['ccrc-term.js'], {
    cwd: path.dirname(DAEMON_PATH),
    env: daemonEnv(tp.pane, 8796, home),
    stdio: 'ignore',
  });
  try {
    await sleep(500);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: proc.pid, sessionId: 's-test' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: tp.pane, PATH: bin });

    assert.match(r.stdout, /ĐÃ TẮT/,
      'thiếu lsof vẫn phải nhận ra daemon của mình — báo "vốn đã tắt" là để lại một shell mở trên tailnet mà người dùng không còn cách nào tìm ra');
    await sleep(300);
    assert.equal(isAlive(proc.pid), false, 'daemon phải thực sự bị dừng');
  } finally {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    tp.kill();
  }
});

// --- Review finding: neither shelled-out identification call had a timeout. --
// --- `off` runs on the shutdown path: a hung `ps`/`lsof` there blocks the ----
// --- one command that stops the daemon, forever, with no way out. -----------

test('ps treo: off vẫn trả về trong thời gian có hạn, không nhận vơ, dọn file', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = '%fake-ps-hang';
  const fakeDir = hangingBin('ps');
  const foreign = spawnForeign();
  const pidfile = pidFilePath(home, pane);
  try {
    await sleep(200);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: foreign.pid, sessionId: 's-fake' }));

    const t0 = Date.now();
    const r = await run(['off'], { HOME: home, TMUX_PANE: pane, PATH: `${fakeDir}:${process.env.PATH}` });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < BOUNDED_MS,
      `off phải bỏ cuộc theo hạn của chính nó chứ không chờ ps mãi (mất ${elapsed}ms)`);
    assert.equal(isAlive(foreign.pid), true, 'không đọc được ps thì tuyệt đối không được giết ai');
    assert.doesNotMatch(r.stdout, /ĐÃ TẮT/);
    assert.match(r.stdout, /vốn đã tắt/i);
    assert.equal(fs.existsSync(pidfile), false, 'file pid không xác minh được vẫn phải bị dọn');
  } finally {
    try { process.kill(foreign.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

// lsof is only reached for a command line with no inline-script flag, so this
// needs a genuine daemon — and one started by a RELATIVE path, where lsof's
// answer is the only thing that could resolve it. Hanging lsof must therefore
// end in "not ours": bounded, silent, and emphatically not a SIGTERM.
//
// The CLI is deliberately run FROM the daemon's own directory. That is the
// one cwd where falling back to our own working directory instead of failing
// closed would resolve the daemon's relative argv and "identify" a process we
// in fact learned nothing about — so this test fails if the timeout is
// missing (unbounded) AND if the timeout is handled by guessing (kills the
// daemon it never identified).
// Kể từ khi processCwd() đọc /proc/<pid>/cwd trước, câu hỏi này có HAI câu trả
// lời đúng, tuỳ máy — và cả hai đều phải được canh:
//
//   • Không có procfs (macOS): lsof là đường DUY NHẤT, nên lsof treo nghĩa là
//     không biết gì → fail closed, không gửi tín hiệu cho ai. Đúng như cũ.
//   • Có procfs (Linux): kernel đã trả lời trước khi lsof được gọi tới, nên
//     lsof treo KHÔNG được ảnh hưởng gì tới kết quả. Đây là bảo đảm MẠNH HƠN,
//     không phải nới lỏng: daemon vẫn phải được nhận diện đúng và tắt được,
//     trong thời gian có hạn.
//
// Điểm chung, và là thứ thật sự được canh ở cả hai nhánh: off phải trả về theo
// hạn của chính nó, và không bao giờ được vừa "không xác minh được danh tính"
// vừa gửi SIGTERM.
test('lsof treo: off vẫn trả về trong thời gian có hạn và fail closed (không giết daemon)', async () => {
  const HAS_PROCFS = fs.existsSync('/proc/self/cwd');
  const tp = newTmuxPane('ccrc-cli-lsofhang');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  const fakeDir = hangingBin('lsof');
  const proc = spawn(process.execPath, ['ccrc-term.js'], {
    cwd: path.dirname(DAEMON_PATH),
    env: daemonEnv(tp.pane, 8795, home),
    stdio: 'ignore',
  });
  try {
    await sleep(500);
    assert.equal(isAlive(proc.pid), true, 'setup sanity: daemon phải đang chạy trước khi thử');
    fs.writeFileSync(pidfile, JSON.stringify({ pid: proc.pid, sessionId: 's-test' }));

    const t0 = Date.now();
    const r = await run(['off'], { HOME: home, TMUX_PANE: tp.pane, PATH: `${fakeDir}:${process.env.PATH}` },
      { cwd: path.dirname(DAEMON_PATH) });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < BOUNDED_MS,
      `off phải bỏ cuộc theo hạn của chính nó chứ không chờ lsof mãi (mất ${elapsed}ms)`);
    if (HAS_PROCFS) {
      // /proc đã trả lời, nên lsof treo là chuyện của lsof. Nhận diện đúng và
      // tắt được là câu trả lời ĐÚNG ở đây — nếu ngày nào nhánh này quay về
      // "vốn đã tắt", tức procfs đã bị bỏ và Linux lại phụ thuộc lsof.
      assert.match(r.stdout, /ĐÃ TẮT/,
        'có /proc thì lsof treo không được ảnh hưởng gì — daemon vẫn phải nhận diện được');
      await sleep(300);
      assert.equal(isAlive(proc.pid), false, 'daemon đã nhận diện được thì phải thực sự bị dừng');
    } else {
      assert.doesNotMatch(r.stdout, /ĐÃ TẮT/, 'không xác minh được thì không được báo như thể vừa tắt');
      assert.match(r.stdout, /vốn đã tắt/i);
      await sleep(300);
      assert.equal(isAlive(proc.pid), true, 'không xác minh được danh tính thì tuyệt đối không gửi tín hiệu');
    }
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    tp.kill();
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('daemon thật khởi động kèm CỜ trước đường dẫn script vẫn được nhận diện', async () => {
  const tp = newTmuxPane('ccrc-cli-flag');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  // Not reachable through cmdOn (it never passes flags), but argv[1] ===
  // DAEMON (the round-2 fix) would refuse to recognise this — the flag sits
  // at argv[1], the daemon path at argv[2].
  const proc = spawn(process.execPath, ['--enable-source-maps', DAEMON_PATH], {
    env: daemonEnv(tp.pane, 8796, home),
    stdio: 'ignore',
  });
  try {
    await sleep(500);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: proc.pid, sessionId: 's-test' }));

    const r = await run(['off'], { HOME: home, TMUX_PANE: tp.pane });

    assert.match(r.stdout, /ĐÃ TẮT/,
      'daemon thật khởi động kèm cờ trước script vẫn phải được nhận diện và tắt được, không phải báo "vốn đã tắt"');
    await sleep(300);
    assert.equal(isAlive(proc.pid), false, 'daemon phải thực sự bị dừng');
    assert.equal(fs.existsSync(pidfile), false);
  } finally {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    tp.kill();
  }
});

// --- Final fix wave, item 4: `/remote on` phải in ra URL của daemon ------
// (§4.2 of the design spec claims it already does — it did not).

test('on: in ra URL khi daemon báo có URL (CCRC_TERM_URL)', async () => {
  const tp = newTmuxPane('ccrc-cli-url');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  try {
    const r = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8794',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
      CCRC_TERM_URL: 'http://100.9.9.9:8730/',
    });
    assert.match(r.stdout, /ĐÃ BẬT/);
    assert.match(r.stdout, /http:\/\/100\.9\.9\.9:8730\//,
      '/remote on phải in ra URL — người dùng thường muốn mở terminal ngay trên máy đang đứng cạnh');
  } finally {
    try {
      const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    tp.kill();
  }
});

// --- Việc 5: đặt tên phiên bằng `/remote on <tên>` -----------------------
//
// The label is the only thing distinguishing one card from another on the
// phone now that the directory name is gone, so `/remote on` has to echo back
// what the session will actually be called — and that string has to come from
// the daemon, which is what decides it (including the fall back to a random
// id).

// Runs `/remote on ...`, returns the CLI output, and always kills whatever
// daemon it started.
async function onWithArgs(args, suffix) {
  const tp = newTmuxPane(`ccrc-cli-name-${suffix}`);
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  try {
    const r = await run(['on', ...args], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '0',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    return r;
  } finally {
    try {
      const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    tp.kill();
  }
}

test('on không kèm tên: hiện một id ngẫu nhiên, KHÔNG phải tên thư mục', async () => {
  const r = await onWithArgs([], 'khongten');
  assert.match(r.stdout, /ĐÃ BẬT/);
  const m = /Tên hiện trên web: (.+)/.exec(r.stdout);
  assert.ok(m, `không in ra tên phiên:\n${r.stdout}`);
  assert.match(m[1].trim(), /^[a-z2-9]{4}$/, `phải là id ngẫu nhiên, nhận được: ${m[1]}`);
});

test('on kèm tên: dùng đúng tên đó', async () => {
  const r = await onWithArgs(['test'], 'coten');
  assert.match(r.stdout, /Tên hiện trên web: test/);
});

test('tên nhiều chữ không cần dấu ngoặc', async () => {
  const r = await onWithArgs(['du', 'an', 'moi'], 'nhieuchu');
  assert.match(r.stdout, /Tên hiện trên web: du an moi/);
});

// Refusing to open a terminal over a bad label would be wildly
// disproportionate — but silently ignoring what the user typed would leave
// them staring at an id wondering why their name did not take.
test('tên có ký tự không cho phép: cảnh báo rõ rồi vẫn bật với id ngẫu nhiên', async () => {
  const r = await onWithArgs(['<script>'], 'tenhong');
  assert.match(r.stdout, /ĐÃ BẬT/, 'tên hỏng không được làm hỏng cả việc bật remote');
  assert.match(r.stdout, /không dùng được/);
  const m = /Tên hiện trên web: (.+)/.exec(r.stdout);
  assert.match(m[1].trim(), /^[a-z2-9]{4}$/);
});

// --- Final fix wave, item 5: `/remote on` phải chờ daemon CHỨNG MINH nó ---
// đã bật thật, không được báo ✓ ngay sau khi spawn.

test('on: cổng đã bị chiếm thì báo lỗi thật, không báo ĐÃ BẬT, không để lại pid file', async () => {
  const tp = newTmuxPane('ccrc-cli-portbusy');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);

  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const port = busy.address().port;
  try {
    const r = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: String(port),
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.notEqual(r.code, 0, 'on phải thoát khác 0 khi daemon không thực sự bật được');
    assert.doesNotMatch(r.stdout, /ĐÃ BẬT/,
      'không được báo thành công khi daemon chưa chứng minh được nó đã nghe cổng — đúng lỗi "báo ✓ trước khi daemon chứng minh gì"');
    assert.match(r.stdout + r.stderr, /cổng|đã có tiến trình khác/i);
    // Đợt sửa cuối, mục 5: thông điệp phải nêu đúng cổng đã YÊU CẦU. Ở đây
    // CCRC_TERM_PORT ghim một cổng thật nên phải thấy đúng con số đó — và
    // không bao giờ được thấy "cổng 0", con số vô nghĩa mà bản cũ in ra với
    // mặc định sản xuất. (Nhánh port-0 tự nó không dựng ra được ở tầng này;
    // nó được kiểm trực tiếp trong env.test.js.)
    assert.match(r.stdout + r.stderr, new RegExp(`cổng ${port}\\b`, 'i'),
      'phải nêu đúng cổng đã yêu cầu, để người dùng biết đi kiểm tra cái gì');
    assert.doesNotMatch(r.stdout + r.stderr, /cổng 0\b/i,
      '"cổng 0" là câu vô nghĩa — không có gì nghe trên cổng 0 bao giờ');
    assert.equal(fs.existsSync(pidfile), false, 'không được để lại pid file cho một daemon chưa từng chạy được');
  } finally {
    busy.close();
    tp.kill();
  }
});

// --- Task 5: nhiều phiên cùng lúc ------------------------------------------
//
// Every test above exercises a SINGLE pane against a single per-pane file.
// These exercise the actual point of Task 5: with two panes, each with its
// own daemon and its own file, `on`/`off` on one must never see or touch the
// other's.

test('hai daemon trên hai pane: off ở pane 1 không đụng daemon của pane 2', async () => {
  const tp1 = newTmuxPane('ccrc-cli-multi-1');
  const tp2 = newTmuxPane('ccrc-cli-multi-2');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile1 = pidFilePath(home, tp1.pane);
  const pidfile2 = pidFilePath(home, tp2.pane);
  try {
    const on1 = await run(['on'], {
      HOME: home, TMUX_PANE: tp1.pane, CCRC_TERM_PORT: '8791',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on1.stdout, /ĐÃ BẬT/, 'pane 1 phải bật được');

    const on2 = await run(['on'], {
      HOME: home, TMUX_PANE: tp2.pane, CCRC_TERM_PORT: '8792',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on2.stdout, /ĐÃ BẬT/, 'pane 2 phải bật được độc lập với pane 1');

    const pid1 = JSON.parse(fs.readFileSync(pidfile1, 'utf8')).pid;
    const pid2 = JSON.parse(fs.readFileSync(pidfile2, 'utf8')).pid;
    assert.notEqual(pid1, pid2, 'hai pane phải có hai daemon khác nhau');
    assert.equal(isAlive(pid1), true);
    assert.equal(isAlive(pid2), true);

    const off1 = await run(['off'], { HOME: home, TMUX_PANE: tp1.pane });
    assert.match(off1.stdout, /ĐÃ TẮT/);

    await sleep(300);
    assert.equal(isAlive(pid1), false, 'off ở pane 1 phải thực sự tắt daemon của pane 1');
    assert.equal(fs.existsSync(pidfile1), false, 'file pid của pane 1 phải bị dọn');

    assert.equal(isAlive(pid2), true, 'off ở pane 1 KHÔNG được đụng tới daemon của pane 2');
    assert.equal(fs.existsSync(pidfile2), true, 'file pid của pane 2 phải còn nguyên');

    const off2 = await run(['off'], { HOME: home, TMUX_PANE: tp2.pane });
    assert.match(off2.stdout, /ĐÃ TẮT/, 'pane 2 vẫn phải tắt được bình thường sau đó');
    await sleep(300);
    assert.equal(isAlive(pid2), false);
  } finally {
    try {
      const p1 = JSON.parse(fs.readFileSync(pidfile1, 'utf8')).pid;
      process.kill(p1, 'SIGKILL');
    } catch { /* already gone or never started */ }
    try {
      const p2 = JSON.parse(fs.readFileSync(pidfile2, 'utf8')).pid;
      process.kill(p2, 'SIGKILL');
    } catch { /* already gone or never started */ }
    tp1.kill();
    tp2.kill();
  }
});

test('on trong pane đã có daemon: báo đã bật sẵn, KHÔNG mở thêm', async () => {
  const tp = newTmuxPane('ccrc-cli-nodup');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  try {
    const on1 = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8793',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on1.stdout, /ĐÃ BẬT/);
    const firstPid = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;

    // Same port on purpose: if `on` mistakenly tried to start a second
    // daemon here it would fail on EADDRINUSE, which would make this test
    // pass for the wrong reason (a crash, not a correct "already on"
    // decision). Getting a clean "already on" despite the busy port proves
    // the early return happened before any spawn was attempted.
    const on2 = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8793',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on2.stdout, /đã bật sẵn/i, 'on lần hai trong cùng pane phải báo đã bật sẵn, không mở thêm');
    assert.doesNotMatch(on2.stdout, /ĐÃ BẬT\n/, 'không được in ra như thể vừa bật thành công lần nữa');

    const stillPid = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
    assert.equal(stillPid, firstPid, 'pid file không được đổi — không có daemon thứ hai nào được tạo');
  } finally {
    try {
      const p = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      process.kill(p, 'SIGKILL');
    } catch { /* already gone */ }
    tp.kill();
  }
});

// --- `on --pane <id>`: target an explicit pane, not the inherited env ------

test('on --pane: bật đúng pane được chỉ định, KHÔNG dùng TMUX_PANE kế thừa', async () => {
  const target = newTmuxPane('ccrc-cli-explicit-target');
  const caller = newTmuxPane('ccrc-cli-explicit-caller'); // pane "gọi lệnh" — khác pane đích
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfileTarget = pidFilePath(home, target.pane);
  const pidfileCaller = pidFilePath(home, caller.pane);
  try {
    const r = await run(['on', '--pane', target.pane], {
      HOME: home, TMUX_PANE: caller.pane, CCRC_TERM_PORT: '0',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(r.stdout, /ĐÃ BẬT/);
    assert.equal(fs.existsSync(pidfileTarget), true, 'phải bật daemon cho PANE ĐÍCH (--pane)');
    assert.equal(fs.existsSync(pidfileCaller), false, 'KHÔNG được bật cho pane đang gọi lệnh (TMUX_PANE kế thừa)');
  } finally {
    try {
      const started = JSON.parse(fs.readFileSync(pidfileTarget, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    target.kill();
    caller.kill();
  }
});

test('on --pane: có thể kèm tên phiên, giống hệt on thường', async () => {
  const target = newTmuxPane('ccrc-cli-explicit-name');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, target.pane);
  try {
    const r = await run(['on', '--pane', target.pane, 'du', 'an', 'moi'], {
      HOME: home, TMUX_PANE: '', TMUX: '', CCRC_TERM_PORT: '0',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(r.stdout, /Tên hiện trên web: du an moi/);
  } finally {
    try {
      const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    target.kill();
  }
});

test('on --pane trỏ vào pane đã chết: báo lỗi rõ, không bật gì', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run(['on', '--pane', '%does-not-exist'], { HOME: home });
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /%does-not-exist/);
});

test('on thường (không --pane) vẫn dùng TMUX_PANE như cũ — không bị đổi hành vi', async () => {
  const tp = newTmuxPane('ccrc-cli-still-normal');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  try {
    const r = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '0',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(r.stdout, /ĐÃ BẬT/);
  } finally {
    try {
      const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      if (started) process.kill(started, 'SIGKILL');
    } catch { /* nothing left to clean up */ }
    tp.kill();
  }
});

test('/remote không tham số: liệt kê MỌI phiên từ hub, đánh dấu đúng phiên hiện tại', async () => {
  const tp = newTmuxPane('ccrc-cli-list');
  // hubUrl is a placeholder here — `on` itself never calls the hub
  // (CCRC_TERM_NO_HUB=1), only the later `status` call does, once the config
  // file below has been rewritten to point at the stub.
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pidfile = pidFilePath(home, tp.pane);
  let srv;
  try {
    const on = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8790',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on.stdout, /ĐÃ BẬT/);
    const mySessionId = JSON.parse(fs.readFileSync(pidfile, 'utf8')).sessionId;
    assert.ok(mySessionId, 'setup sanity: on phải ghi sessionId vào pid file');

    // Now point the config at a stub hub that reports TWO sessions: this
    // pane's own (by sessionId) and one belonging to some other pane/machine
    // entirely — exactly the situation `/remote` must report honestly.
    const stub = await stubHub((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sessions: [
          { sessionId: mySessionId, machine: 'may-a', label: 'proj-a', alive: true },
          { sessionId: 'other-session-xyz', machine: 'may-b', label: 'proj-b', alive: true },
        ],
      }));
    });
    srv = stub.srv;
    fs.writeFileSync(path.join(home, '.ccrc', 'config'), `CCRC_HUB_URL=${stub.base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);

    const status = await run([], { HOME: home, TMUX_PANE: tp.pane });

    assert.match(status.stdout, /proj-a/, 'phải liệt kê phiên của chính pane này');
    assert.match(status.stdout, /proj-b/, 'phải liệt kê CẢ phiên của pane/máy khác — đây là chẩn đoán toàn cảnh, không chỉ phần cục bộ');

    const lines = status.stdout.split('\n');
    const mineLine = lines.find((l) => l.includes('proj-a'));
    const otherLine = lines.find((l) => l.includes('proj-b'));
    assert.match(mineLine, /phiên này/i, 'dòng của phiên hiện tại phải được đánh dấu');
    assert.doesNotMatch(otherLine, /phiên này/i, 'dòng của phiên khác KHÔNG được đánh dấu là phiên hiện tại');
  } finally {
    if (srv) srv.close();
    try {
      const p = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
      process.kill(p, 'SIGKILL');
    } catch { /* already gone */ }
    tp.kill();
  }
});

// --- off-all: chỉ lệnh gỡ cài đặt dùng ------------------------------------
//
// `off` thường ngày cố ý chỉ đụng pane của chính nó. Lúc GỠ thì ngược lại: bỏ
// sót một daemon là để lại một tiến trình vẫn phục vụ shell trên tailnet sau
// khi người dùng tưởng đã gỡ sạch — và file pid, thứ duy nhất ghi lại nó, nằm
// trong ~/.ccrc, sắp bị xoá cùng thư mục đó.

test('off-all dừng MỌI daemon thật, ở mọi pane', async () => {
  const a = newTmuxPane('ccrc-offall-a');
  const b = newTmuxPane('ccrc-offall-b');
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  try {
    // KHÔNG ghim cổng: cổng cố định trong test là một tài nguyên dùng chung,
    // và hai test chạy song song ghim trùng nhau thì thua cuộc chết lặng lẽ.
    // Bỏ trống là đúng mặc định production — daemon bind cổng 0, hệ điều hành
    // cấp cổng nào còn trống.
    const env = { HOME: home, CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1' };
    assert.match((await run(['on'], { ...env, TMUX_PANE: a.pane })).stdout, /ĐÃ BẬT/);
    assert.match((await run(['on'], { ...env, TMUX_PANE: b.pane })).stdout, /ĐÃ BẬT/);
    const pidA = JSON.parse(fs.readFileSync(pidFilePath(home, a.pane), 'utf8')).pid;
    const pidB = JSON.parse(fs.readFileSync(pidFilePath(home, b.pane), 'utf8')).pid;
    assert.equal(isAlive(pidA) && isAlive(pidB), true, 'cả hai daemon phải sống trước đã');

    // Không đặt TMUX_PANE: lệnh gỡ chạy từ shell thường, không ở trong tmux.
    const r = await run(['off-all'], { HOME: home });
    assert.match(r.stdout, /Đã dừng 2 phiên/);

    await sleep(400);
    assert.equal(isAlive(pidA), false, 'daemon pane A vẫn sống — vẫn phục vụ shell sau khi gỡ');
    assert.equal(isAlive(pidB), false, 'daemon pane B vẫn sống — vẫn phục vụ shell sau khi gỡ');
    assert.equal(fs.existsSync(pidFilePath(home, a.pane)), false);
    assert.equal(fs.existsSync(pidFilePath(home, b.pane)), false);
  } finally {
    a.kill();
    b.kill();
  }
});

// Cùng một luật với `off`: một số pid được cấp lại cho tiến trình khác thì
// không bao giờ được bắn. Gỡ cài đặt không phải cái cớ để nới lỏng điều đó.
test('off-all gặp PID lạ: KHÔNG giết, chỉ dọn file', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const foreign = spawnForeign();
  const pidfile = pidFilePath(home, '%99');
  try {
    await sleep(200);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: foreign.pid, sessionId: 's-la' }));

    const r = await run(['off-all'], { HOME: home });
    assert.match(r.stdout, /Không có phiên remote nào/);
    assert.equal(isAlive(foreign.pid), true, 'đã giết một tiến trình không phải của mình');
    assert.equal(fs.existsSync(pidfile), false, 'file pid cũ phải được dọn');
  } finally {
    foreign.kill('SIGKILL');
  }
});

// Chạy trên máy chưa từng cài, hoặc chạy lần thứ hai: phải im lặng thành công,
// không được lỗi và làm hỏng phần còn lại của lệnh gỡ.
test('off-all khi không có ~/.ccrc: không lỗi', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-empty-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const r = await run(['off-all'], { HOME: home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Không có phiên remote nào/);
});

// --- `candidates`: machine-readable pane list for `ccrc remote` -----------

function parseCandidates(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [pane, on, cwd, target] = line.split('\t');
    return { pane, on, cwd, target };
  });
}

// `candidates` lists panes across the WHOLE tmux server (tmux has no notion
// of "this test's panes" — see listPanes' own comment), not just the ones
// this test creates. Asserting the entire output is empty used to work by
// accident: the OLD (broken) `p.cmd === 'claude'` filter matched none of a
// real Claude Code session's panes either (that was the bug this whole fix
// is for), so an otherwise-idle dev machine always produced empty output
// regardless of what was really running. Now that detection actually works,
// running this suite on a machine that has real Claude Code sessions open in
// tmux — the exact situation `/remote` exists for — correctly lists them,
// and asserting global emptiness would fail for a reason that has nothing to
// do with this test's own ordinary shell pane. Assert on that pane
// specifically instead, same pattern as the "chỉ liệt kê" test below.
test('candidates: pane chạy shell thường không được liệt kê', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const tp = newTmuxPane('ccrc-cli-cand-none'); // ordinary shell pane, NOT claude
  try {
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    const rows = parseCandidates(r.stdout);
    assert.ok(!rows.find((row) => row.pane === tp.pane), 'pane shell thường không được xuất hiện trong candidates');
  } finally {
    tp.kill();
  }
});

test('candidates: chỉ liệt kê pane chạy claude, bỏ qua shell thường', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const shellPane = newTmuxPane('ccrc-cli-cand-shell');
  const claudePane = newClaudePane('ccrc-cli-cand-claude'); // shape B — claude as a CHILD of the pane's shell, see fixture comment
  try {
    await sleep(300); // để tiến trình fake claude thực sự lên bảng ps
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    const rows = parseCandidates(r.stdout);
    assert.ok(rows.find((row) => row.pane === claudePane.pane), 'pane chạy claude phải xuất hiện');
    assert.ok(!rows.find((row) => row.pane === shellPane.pane), 'pane shell thường không được xuất hiện');
  } finally {
    shellPane.kill();
    claudePane.kill();
  }
});

// Regression for shape A (claude as the pane's OWN foreground process, no
// wrapping shell in the way — see newClaudePaneForeground's comment). The
// subtree walk starts AT #{pane_pid} itself before ever looking at children,
// which is what must keep this shape working alongside shape B above.
test('candidates: pane có claude làm tiến trình chính (không qua shell bọc) vẫn được nhận diện', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const claudePane = newClaudePaneForeground('ccrc-cli-cand-fg');
  try {
    await sleep(300);
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    const rows = parseCandidates(r.stdout);
    assert.ok(rows.find((row) => row.pane === claudePane.pane),
      'pane có claude làm tiến trình chính của chính pane đó vẫn phải được liệt kê');
  } finally {
    claudePane.kill();
  }
});

test('candidates: đúng cwd và target', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const claudePane = newClaudePane('ccrc-cli-cand-fields');
  try {
    await sleep(300);
    const r = await run(['candidates'], { HOME: home });
    const row = parseCandidates(r.stdout).find((x) => x.pane === claudePane.pane);
    assert.ok(row);
    // Window index is NOT assumed to be 0 — it depends on this tmux server's
    // own `base-index` (a global, user-set option outside this project's
    // control; e.g. `set-option -g base-index 1` in ~/.tmux.conf shifts a
    // fresh session's first window to 1). tmux.test.js's own listPanes test
    // sidesteps the same pitfall by reading the value back from tmux rather
    // than hardcoding it. Pane index is asserted as literally '0' because
    // pane-base-index is not something this project's own convention treats
    // as variable (see the "phiên mới luôn là pane 0" comment there).
    const winIndex = execFileSync(tmuxBin(), ['display-message', '-p', '-t', claudePane.pane, '#{window_index}'], { encoding: 'utf8' }).trim();
    assert.equal(row.target, `${claudePane.sess}:${winIndex}.0`);
    assert.equal(row.cwd, process.cwd());
  } finally {
    claudePane.kill();
  }
});

test('candidates: cờ on phản ánh đúng có/không có daemon (pidfile) cho pane đó', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const claudePane = newClaudePane('ccrc-cli-cand-on');
  try {
    await sleep(300);
    const before = parseCandidates((await run(['candidates'], { HOME: home })).stdout)
      .find((x) => x.pane === claudePane.pane);
    assert.equal(before.on, '0', 'chưa bật remote thì cờ on phải là 0');

    // Bật remote thật cho pane này, rồi kiểm tra candidates thấy cờ on = 1.
    const pidfile = pidFilePath(home, claudePane.pane);
    try {
      await run(['on'], {
        HOME: home, TMUX_PANE: claudePane.pane, CCRC_TERM_PORT: '0',
        CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
      });
      const after = parseCandidates((await run(['candidates'], { HOME: home })).stdout)
        .find((x) => x.pane === claudePane.pane);
      assert.equal(after.on, '1', 'đã bật remote thì cờ on phải là 1');
    } finally {
      try {
        const started = JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid;
        if (started) process.kill(started, 'SIGKILL');
      } catch { /* nothing left to clean up */ }
    }
  } finally {
    claudePane.kill();
  }
});

// `tmux list-panes -a` lists a pane once per SESSION that references it. The
// daemon creates a GROUPED session onto a real claude pane while a browser
// is attached (createGroupSession/claimGroupName, tmux.js), and a SIGKILLed
// daemon can leave one behind — so the same pane can show up under both its
// real session name and the daemon's internal `-ccrc-web` name. Without
// dedup that pane would print twice, looking like a second Claude session.
test('candidates: pane trong session được nhóm (grouped) chỉ hiện MỘT dòng, mang tên session thật', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const claudePane = newClaudePane('ccrc-cli-cand-grouped');
  const T = tmuxBin();
  const groupName = `${claudePane.sess}${GROUP_SESSION_SUFFIX}`;
  try {
    await sleep(300);
    // A plain grouped session is enough to reproduce the duplicate row — the
    // full marker-stamping createGroupSession() does is not needed here,
    // only the shape `tmux list-panes -a` produces.
    execFileSync(T, ['new-session', '-d', '-t', `=${claudePane.sess}`, '-s', groupName]);
    try {
      const r = await run(['candidates'], { HOME: home });
      assert.equal(r.code, 0);
      const rows = parseCandidates(r.stdout).filter((row) => row.pane === claudePane.pane);
      assert.equal(rows.length, 1, 'một pane thật chỉ được xuất hiện đúng một dòng dù bị nhiều session tham chiếu');
      assert.ok(rows[0].target.startsWith(`${claudePane.sess}:`),
        `target phải mang tên session THẬT (${claudePane.sess}), không phải tên nhóm nội bộ: ${rows[0].target}`);
    } finally {
      try { execFileSync(T, ['kill-session', '-t', `=${groupName}`]); } catch { /* already gone */ }
    }
  } finally {
    claudePane.kill();
  }
});

// --- Review finding: the discrimination rule itself had zero coverage -----
// --- (isClaudeCommand's first-token-basename match, and the round-2 ---------
// --- tty-attachment requirement layered on top of it in subtreeHasClaude). --

test('candidates: pane chỉ NHẮC TỚI file tên "claude" (tail -f), không chạy nó — không được liệt kê', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = newPaneTailingClaudeFile('ccrc-cli-cand-tail');
  try {
    await sleep(300); // để `tail -f` thực sự lên bảng ps
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    const rows = parseCandidates(r.stdout);
    assert.ok(!rows.find((row) => row.pane === pane.pane),
      '`tail -f` một file tên "claude" chỉ ĐỌC file đó, không CHẠY nó — first token là "tail", không phải "claude", nên không được coi là pane có claude');
  } finally {
    pane.kill();
  }
});

// The new safety property round 2 added: a claude process elsewhere in the
// subtree, attached to a DIFFERENT tty (or none), must not make the pane a
// candidate. Reproduces the exact live incident this tightening closed — a
// headless claude, detached, with no controlling terminal — see
// newPaneWithHeadlessClaudeChild's own comment for how that shape is built
// honestly rather than assumed.
test('candidates: có claude trong subtree nhưng KHÁC tty của pane (headless, không có terminal điều khiển) — không được liệt kê', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const pane = newPaneWithHeadlessClaudeChild('ccrc-cli-cand-headless');
  try {
    await sleep(300); // để tiến trình claude ẩn danh thực sự lên bảng ps
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    const rows = parseCandidates(r.stdout);
    assert.ok(!rows.find((row) => row.pane === pane.pane),
      'claude không gắn với tty CỦA CHÍNH PANE này (headless, tty ??) không được coi là claude của pane — đây là kẽ hở round-2 vừa đóng lại');
  } finally {
    pane.kill();
  }
});

// --- nhắc cập nhật ngay trong terminal trên máy ----------------------------
//
// Nhắc trên điện thoại là chưa đủ: lúc ngồi trước máy mới là lúc tiện chạy
// install.sh, chứ không phải lúc đang cầm điện thoại ngoài đường. Nên `/remote
// on` hỏi hub rồi tự so với bản cài của mình.

test('/remote on: hub có gói cài khác thì nhắc chạy install.sh', async () => {
  const tp = newTmuxPane('ccrc-cli-nhac');
  const hub = await stubHub((req, res) => {
    if (req.url === '/api/install/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Khác hẳn dấu vân tay của cây nguồn đang chạy test.
      return res.end(JSON.stringify({ protocolVersion: 1, bundleFingerprint: 'b'.repeat(64) }));
    }
    res.writeHead(404).end();
  });
  const home = tmpHome(`CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  try {
    const on = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8791',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on.stdout, /ĐÃ BẬT/);
    assert.match(on.stdout, /install\.sh/, 'không nhắc thì người dùng chạy code cũ mà không biết');
    // Từ khi đăng nhập bằng Slack, người dùng KHÔNG biết token của mình nữa —
    // install.sh không tham số sẽ tự xin bằng device-code. Nhắc một lệnh đòi
    // token là chỉ cho người ta một việc họ không làm được.
    assert.doesNotMatch(on.stdout, /<token/,
      'lệnh nhắc không được đòi token: người đăng nhập bằng Slack không có nó');
    // install.sh bản PUBLIC không có hub mặc định (`HUB="${CCRC_HUB_URL:-${2:-}}"`)
    // — mỗi người tự dựng hub riêng — và hub production chạy đúng bản đó. Nên
    // `curl … | sh` trần chết ngay với "Thiếu URL hub". Đã đo thật.
    assert.match(on.stdout, /CCRC_HUB_URL=/,
      'thiếu CCRC_HUB_URL thì lệnh nhắc chết ngay ở dòng đầu');
    // MỘT lệnh dán thẳng được. Đã chạy thật cả hai dạng trước khi chốt dạng
    // này; hai dòng thì người ta dán dòng đầu, không thấy gì xảy ra, rồi thôi.
    assert.match(on.stdout, /curl -fsSL \S+\/install\.sh \| CCRC_HUB_URL=\S+ sh/,
      'phải là một lệnh liền');
    // Địa chỉ hub lấy từ config của MÁY NÀY, không phải một hằng số nào đó:
    // mỗi người tự dựng hub riêng, và bản public cố ý không có hub mặc định.
    assert.match(on.stdout, new RegExp(`CCRC_HUB_URL=${hub.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
      'phải dùng đúng hub trong config, không hard-code');
    // MỘT lệnh dán được thẳng vào terminal. Hai dòng thì người ta dán dòng
    // đầu, thấy không có gì xảy ra, rồi thôi.
    assert.match(on.stdout, /curl -fsSL \S+\/install\.sh \| CCRC_HUB_URL=\S+ sh/,
      'phải là một lệnh liền, đã chạy thật để kiểm chứng');
  } finally {
    await run(['off'], { HOME: home, TMUX_PANE: tp.pane });
    hub.srv.close(); tp.kill();
  }
});

test('/remote on: gói cài khớp thì KHÔNG nhắc gì', async () => {
  const tp = newTmuxPane('ccrc-cli-khop');
  // Dấu vân tay thật của chính cây nguồn đang chạy test — đúng cái CLI sẽ tính.
  const { dauVanTay } = await import('../../shared/bundle-fingerprint.js');
  const that = dauVanTay(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const hub = await stubHub((req, res) => {
    if (req.url === '/api/install/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ protocolVersion: 1, bundleFingerprint: that }));
    }
    res.writeHead(404).end();
  });
  const home = tmpHome(`CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n`);
  try {
    const on = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8792',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on.stdout, /ĐÃ BẬT/);
    assert.doesNotMatch(on.stdout, /install\.sh/, 'nhắc khi không có gì mới là tiếng ồn');
  } finally {
    await run(['off'], { HOME: home, TMUX_PANE: tp.pane });
    hub.srv.close(); tp.kill();
  }
});

test('/remote on: hub chết thì vẫn bật bình thường, không kêu ca', async () => {
  const tp = newTmuxPane('ccrc-cli-hubchet');
  // Cổng 9 (discard) — không ai nghe. Lời nhắc là thứ phụ; làm hỏng `/remote
  // on` vì nó là đổi một tiện ích lấy chức năng chính.
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  try {
    const on = await run(['on'], {
      HOME: home, TMUX_PANE: tp.pane, CCRC_TERM_PORT: '8793',
      CCRC_TERM_BIND: '127.0.0.1', CCRC_TERM_NO_HUB: '1',
    });
    assert.match(on.stdout, /ĐÃ BẬT/);
    assert.doesNotMatch(on.stdout, /install\.sh/);
  } finally {
    await run(['off'], { HOME: home, TMUX_PANE: tp.pane });
    tp.kill();
  }
});
