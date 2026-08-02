# Bật /remote từ một pane khác — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ccrc remote` — a command run from any tmux pane, including one
where Claude Code is NOT busy — that lists every pane currently running
`claude`, lets the user pick one by index, and starts the `/remote` daemon
against that pane directly, without ever depending on the busy Claude Code
session's own input queue.

**Architecture:** `term/src/tmux.js` gets one new query function
(`listPanes`). `term/bin/ccrc-term-cli.js` gets a new `candidates` mode (lists
panes running claude, tab-separated, machine-readable) and a `--pane <id>`
flag on the existing `on` mode (targets an explicit pane instead of the
inherited `$TMUX_PANE`). `deploy/ccrc` gets a new `remote` subcommand that
does the interactive picking (reads `/dev/tty`, same technique
`setup-notify.sh` already uses) and calls the two CLI additions above.
`/remote` itself (the slash command, `deploy/commands/remote.md`) is not
touched.

**Tech Stack:** Node.js (`node --test`), POSIX `sh`, tmux.

**Spec:** `docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md`

## Global Constraints

- No change to `/remote on|off|pair|devices|unpair` behaviour when invoked
  the existing way (from inside the busy Claude Code session). Every existing
  test in `term/test/remote-cli.test.js` must keep passing unmodified.
- `candidates` output is **tab-separated text, one pane per line** — `pane\ton\tcwd\ttarget`,
  in that order, `target` last. (The spec sketched this as JSON; tab-separated
  was chosen during implementation because the only consumer is a POSIX `sh`
  script with no `jq`/`python` available, and the rest of `term/src/tmux.js`
  already uses exactly this tab-separated, variable-field-last convention —
  see `listSessions()` there. Semantics are identical to the spec: same four
  facts, same filter to panes running `claude`.)
- Only panes whose `pane_current_command` is exactly `claude` ever appear in
  `candidates`. This is the ONLY enforcement point for "never target a plain
  shell" (spec §2, D2) — `on --pane` itself does not re-check, because the
  caller (`ccrc remote`) already re-runs `candidates` immediately before
  calling `on --pane` (spec §3, step 6), and requiring every direct caller of
  `on --pane` to already be tmux-verified would duplicate a check the one
  real caller already performs.
- Work happens on the current branch, `claude/web-terminal` — this repo does
  not use a separate branch per spec/plan (every existing file under
  `docs/superpowers/specs/` lives on whatever branch was active when it was
  written; the design doc's "nhánh dự kiến" was a brainstorming-time guess,
  superseded by this observed convention).
- Run tests with: `cd term && node --test --test-concurrency=4 test/*.test.js`
  (the concurrency cap is load-bearing — see the comment in `term/package.json`;
  higher concurrency exhausts real ptys and produces unrelated failures).

---

### Task 1: `listPanes()` in `term/src/tmux.js`

**Files:**
- Modify: `term/src/tmux.js` (add a new exported function; insert after `paneCwd`, i.e. after line 87)
- Test: `term/test/tmux.test.js` (add a test; the file already imports `tmuxBin`, `withSession`-style setup exists as a local helper)

**Interfaces:**
- Produces: `listPanes(): Array<{ paneId: string, cmd: string, cwd: string, target: string }>` — one entry per pane on the tmux server. `target` is `"<session_name>:<window_index>.<pane_index>"`. Returns `[]` if tmux has no server/no panes (never throws).

- [ ] **Step 1: Write the failing test**

Add to `term/test/tmux.test.js`. First, add `listPanes` to the existing import list at the top of the file (it currently reads `paneCwd,` on its own line — add `listPanes,` right after it):

```js
import {
  tmuxBin, currentPane, paneAlive, paneSession, capturePane, snapshotPane,
  createGroupSession, killGroupSession, hasSession,
  isOurGroupSession, claimGroupName, reclaimPaneSession, GROUP_MARKER_OPTION,
  paneCwd, listPanes,
  makeRunId, isReclaimableMarker,
} from '../src/tmux.js';
```

Then add this test anywhere after the existing `paneCwd` tests:

```js
test('listPanes liệt kê pane vừa tạo, đúng target và cwd', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    const rows = listPanes();
    const row = rows.find((r) => r.paneId === pane);
    assert.ok(row, 'phải thấy pane vừa tạo trong danh sách toàn bộ pane trên server');
    assert.equal(row.target, `${s}:0.0`, 'phiên mới luôn là window 0, pane 0');
    assert.equal(typeof row.cmd, 'string');
    assert.ok(row.cmd.length > 0, 'pane vừa tạo luôn đang chạy MỘT shell nào đó');
    assert.equal(typeof row.cwd, 'string');
  });
});

test('listPanes: mỗi entry đúng field, không lẫn pane của session khác', () => {
  withSession((s1) => {
    withSession((s2) => {
      const p1 = tmux('display-message', '-p', '-t', s1, '#{pane_id}');
      const p2 = tmux('display-message', '-p', '-t', s2, '#{pane_id}');
      const rows = listPanes();
      const r1 = rows.find((r) => r.paneId === p1);
      const r2 = rows.find((r) => r.paneId === p2);
      assert.ok(r1 && r2, 'cả hai pane phải xuất hiện');
      assert.notEqual(r1.target, r2.target, 'hai session khác nhau phải cho target khác nhau');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd term && node --test --test-concurrency=4 test/tmux.test.js`
Expected: FAIL — `listPanes is not a function` (or a SyntaxError on the import, since it does not exist yet).

- [ ] **Step 3: Write minimal implementation**

In `term/src/tmux.js`, insert this new exported function immediately after `paneCwd` (i.e. right after the closing `}` currently on line 87, before the `paneMouseMode` comment block):

```js
// Every pane on this tmux server, for `candidates` (ccrc-term-cli.js) to
// filter down to the ones running claude and offer as a pick list.
//
// One tmux call, same shape as listSessions() below for the same reason:
// #{session_name} is the one field here that could in principle contain a
// tab (see listSessions' own comment), so it is read as its own trailing
// field and only combined into `target` AFTER the split — never joined into
// the format string before we control where the split happens.
export function listPanes() {
  let out;
  try {
    out = tmux(['list-panes', '-a', '-F',
      '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{window_index}\t#{pane_index}\t#{session_name}']);
  } catch {
    return []; // no server running, or no panes
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const [paneId, cmd, cwd, windowIndex, paneIndex, ...nameParts] = parts;
    const sessionName = nameParts.join('\t');
    rows.push({ paneId, cmd, cwd, target: `${sessionName}:${windowIndex}.${paneIndex}` });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd term && node --test --test-concurrency=4 test/tmux.test.js`
Expected: PASS (all tests in the file, not just the two new ones — confirm nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add term/src/tmux.js term/test/tmux.test.js
git commit -m "term: add listPanes() for enumerating every tmux pane on the server"
```

---

### Task 2: `candidates` mode in `ccrc-term-cli.js`

**Files:**
- Modify: `term/bin/ccrc-term-cli.js` (import line 16; add `cmdCandidates`; add dispatch branch)
- Test: `term/test/remote-cli.test.js`

**Interfaces:**
- Consumes: `listPanes()` from Task 1 (`term/src/tmux.js`); existing `daemonInfo(paneId)` (already defined in this file, returns `{pid, sessionId, file}` or `null`).
- Produces: running `node ccrc-term-cli.js candidates` prints, to stdout, one line per pane running `claude`: `<paneId>\t<0 or 1>\t<cwd>\t<target>` — nothing at all (empty stdout, exit 0) when there are none. Exit code is always 0 (this mode never fails — same as `listSessions()`/`listPanes()` never throwing).

- [ ] **Step 1: Write the failing test**

Add to `term/test/remote-cli.test.js`. First add a fixture helper — a REAL running process whose command name is literally `claude`, so `#{pane_current_command}` genuinely reports `claude` (a shebang script would report the interpreter, not the script; a copied signed macOS system binary fails Gatekeeper — copying the current `node` binary itself is what works reliably, verified by hand). Add this near the other fixture helpers (e.g. right after `newTmuxPane`):

```js
// A tmux pane whose #{pane_current_command} is genuinely "claude" — needed
// because `candidates` filters on exactly that. A shebang script named
// "claude" reports as its INTERPRETER (sh), not as "claude" (verified by
// hand); copying a real node binary to a file named `claude` and running
// THAT is what actually works, because pane_current_command reflects the
// real executable that got exec'd, not argv[0] or the invoking path.
function newClaudePane(name) {
  const T = tmuxBin();
  const sess = `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakeclaude-'));
  const fakeClaude = path.join(dir, 'claude');
  fs.copyFileSync(process.execPath, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24',
    `${fakeClaude} -e "setTimeout(()=>{},30000)"`]);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  return {
    sess, pane,
    kill() {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
```

Then add the tests (anywhere after that helper):

```js
// --- `candidates`: machine-readable pane list for `ccrc remote` -----------

function parseCandidates(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [pane, on, cwd, target] = line.split('\t');
    return { pane, on, cwd, target };
  });
}

test('candidates: không có pane nào chạy claude → không in dòng nào, exit 0', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const tp = newTmuxPane('ccrc-cli-cand-none'); // ordinary shell pane, NOT claude
  try {
    const r = await run(['candidates'], { HOME: home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    tp.kill();
  }
});

test('candidates: chỉ liệt kê pane chạy claude, bỏ qua shell thường', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const shellPane = newTmuxPane('ccrc-cli-cand-shell');
  const claudePane = newClaudePane('ccrc-cli-cand-claude');
  try {
    await sleep(300); // để tiến trình fake claude thực sự lên #{pane_current_command}
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

test('candidates: đúng cwd và target', async () => {
  const home = tmpHome('CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const claudePane = newClaudePane('ccrc-cli-cand-fields');
  try {
    await sleep(300);
    const r = await run(['candidates'], { HOME: home });
    const row = parseCandidates(r.stdout).find((x) => x.pane === claudePane.pane);
    assert.ok(row);
    assert.equal(row.target, `${claudePane.sess}:0.0`);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd term && node --test --test-concurrency=4 test/remote-cli.test.js`
Expected: FAIL on the four new `candidates` tests (unknown mode falls through to `cmdStatus`, so output/exit code will not match).

- [ ] **Step 3: Write minimal implementation**

In `term/bin/ccrc-term-cli.js`, change the import on line 16 from:

```js
import { currentPane, paneAlive } from '../src/tmux.js';
```

to:

```js
import { currentPane, paneAlive, listPanes } from '../src/tmux.js';
```

Add this new function right after `cmdOn` (i.e. after its closing `}` — currently line 389, right before `async function cmdOff()`):

```js
// Machine-readable listing for `ccrc remote` (deploy/ccrc): every pane on
// this tmux server currently running claude, one per line, tab-separated
// `pane\ton\tcwd\ttarget` — target LAST because it embeds the session name,
// the one field (per term/src/tmux.js's own convention) that could in
// principle contain a tab.
async function cmdCandidates() {
  const rows = listPanes()
    .filter((p) => p.cmd === 'claude')
    .map((p) => `${p.paneId}\t${daemonInfo(p.paneId) ? '1' : '0'}\t${p.cwd}\t${p.target}`);
  if (rows.length) say(rows.join('\n'));
}
```

Add a dispatch branch in the `run` ternary chain (currently lines 807-817) — insert a new line right after the `off-all` branch:

```js
const run = mode === 'on' ? () => cmdOn(nameArg)
  : mode === 'off' ? cmdOff
  : mode === 'off-all' ? cmdOffAll
  : mode === 'candidates' ? cmdCandidates
  // `pair xac-nhan <số>` must be checked BEFORE the bare `pair` branch below
  ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd term && node --test --test-concurrency=4 test/remote-cli.test.js`
Expected: PASS — all tests in the file, including the 4 new ones and every pre-existing test (this confirms nothing about `on`/`off`/`pair`/etc. regressed).

- [ ] **Step 5: Commit**

```bash
git add term/bin/ccrc-term-cli.js term/test/remote-cli.test.js
git commit -m "term: add 'candidates' mode listing panes running claude"
```

---

### Task 3: `--pane <id>` flag on `on` mode

**Files:**
- Modify: `term/bin/ccrc-term-cli.js` (`cmdOn` signature + body, lines 339-389; argv parsing, lines 804-817)
- Test: `term/test/remote-cli.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `node ccrc-term-cli.js on --pane <id> [name...]` behaves exactly like `on [name...]` run with `TMUX_PANE=<id>`, regardless of what (if anything) the CLI process's own `$TMUX_PANE` is set to. Plain `on [name...]` (no `--pane`) is byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test**

Add to `term/test/remote-cli.test.js`, anywhere after the existing `on`-related tests:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd term && node --test --test-concurrency=4 test/remote-cli.test.js`
Expected: FAIL on the four new `on --pane` tests (today `--pane` and the id after it get swallowed into the session NAME, so it tries to open a daemon on the CALLER's pane and/or names the session literally `--pane %...`).

- [ ] **Step 3: Write minimal implementation**

In `term/bin/ccrc-term-cli.js`, change `cmdOn`'s signature and its pane-resolution block (currently lines 339-345):

```js
async function cmdOn(rawName) {
  const pane = currentPane();
  if (!pane || !paneAlive(pane)) {
    say('✗ Không chạy trong tmux — /remote cần một phiên tmux để nối vào.');
    say('  Khởi động lại Claude Code bên trong tmux rồi thử lại.');
    process.exit(1);
  }
```

to:

```js
async function cmdOn(rawName, explicitPane = null) {
  const pane = explicitPane || currentPane();
  if (!pane || !paneAlive(pane)) {
    if (explicitPane) {
      say(`✗ Pane ${explicitPane} không tồn tại hoặc đã đóng.`);
    } else {
      say('✗ Không chạy trong tmux — /remote cần một phiên tmux để nối vào.');
      say('  Khởi động lại Claude Code bên trong tmux rồi thử lại.');
    }
    process.exit(1);
  }
```

The rest of `cmdOn`'s body (lines 346-389) is unchanged — it already only ever refers to the local `pane` variable, never to `currentPane()` again.

Then change the argv-parsing block (currently lines 804-807):

```js
// Everything after `on` is the session name, joined back together so
// `/remote on du an moi` works without quoting.
const nameArg = process.argv.slice(3).join(' ');
const run = mode === 'on' ? () => cmdOn(nameArg)
```

to:

```js
// `on --pane <id> [name...]` targets an explicit pane instead of the one
// this process is running in — used by `ccrc remote` (deploy/ccrc) to start
// a daemon for a pane that is NOT the one invoking this CLI. See
// docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md.
// Everything else after `on` is the session name, joined back together so
// `/remote on du an moi` still works without quoting.
let onPane = null;
let onNameTokens = process.argv.slice(3);
if (mode === 'on' && onNameTokens[0] === '--pane') {
  onPane = onNameTokens[1] || null;
  if (!onPane) {
    say('✗ --pane cần kèm một pane id.');
    process.exit(1);
  }
  onNameTokens = onNameTokens.slice(2);
}
const nameArg = onNameTokens.join(' ');
const run = mode === 'on' ? () => cmdOn(nameArg, onPane)
```

(Every other branch of the `run` ternary — `off`, `off-all`, `candidates`, `pair`, `devices`, `unpair` — is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd term && node --test --test-concurrency=4 test/remote-cli.test.js`
Expected: PASS — the 4 new tests, plus every pre-existing `on`/`off`/etc. test still green.

- [ ] **Step 5: Commit**

```bash
git add term/bin/ccrc-term-cli.js term/test/remote-cli.test.js
git commit -m "term: on accepts --pane <id> to target an explicit pane"
```

---

### Task 4: `ccrc remote` subcommand in `deploy/ccrc`

**Files:**
- Modify: `deploy/ccrc`

**Interfaces:**
- Consumes: `node <repo>/term/bin/ccrc-term-cli.js candidates` (Task 2) and `... on --pane <id> [name]` (Task 3).
- Produces: `ccrc remote`, run from any shell (in tmux or not — this does not need to run inside tmux itself, only the TARGET pane does). Interactive: prints a numbered list, reads a choice and an optional name from `/dev/tty`, then runs `on --pane`.

**No automated test** — this repo has no test harness for interactive `/dev/tty` scripts (`setup-notify.sh` has none either, for the same reason). Verify with the manual checklist in Step 4 instead.

- [ ] **Step 1: Read the current file to confirm line anchors**

Run: `sed -n '1,45p' deploy/ccrc`
Confirm it still matches this plan's assumptions:
- Line 15-16: `CLAUDE_BIN=$(command -v claude ...)` / the `[ -n "$CLAUDE_BIN" ] || { ... exit 127; }` check.
- A `run_plain() { exec "$CLAUDE_BIN" "$@"; }` definition.
- A `REMOTE_CLI="{{CCRC_REPO}}/term/bin/ccrc-term-cli.js"` line with a comment above it saying it's "chỉ dùng cho nhánh 'đã ở trong tmux'".
- An `if [ -n "${TMUX:-}" ]; then` block below that, which is where `off` gets called for cleanup on Claude exit.

If line numbers drifted (unrelated commits touched this file), re-locate these by content, not by line number — the anchors above are unique strings.

- [ ] **Step 2: Move `REMOTE_CLI` earlier and broaden its comment**

Replace:

```sh
# Đường dẫn tới CLI của /remote, do lệnh cài điền vào. Chỉ dùng cho nhánh
# "đã ở trong tmux" ngay dưới đây.
REMOTE_CLI="{{CCRC_REPO}}/term/bin/ccrc-term-cli.js"
```

with, placed immediately after the `CLAUDE_BIN` / `exit 127` check (i.e. BEFORE `run_plain`'s definition, not after it):

```sh
# Đường dẫn tới CLI của /remote, do lệnh cài điền vào — dùng ở cả subcommand
# `ccrc remote` ngay dưới đây VÀ ở nhánh dọn dẹp "đã ở trong tmux" bên dưới.
REMOTE_CLI="{{CCRC_REPO}}/term/bin/ccrc-term-cli.js"
```

(Delete the old declaration from its original location — there must be exactly one `REMOTE_CLI=` line in the file after this step.)

- [ ] **Step 3: Add the `cmd_remote` function and dispatch, right after the moved `REMOTE_CLI` line**

```sh
# --- `ccrc remote`: bật /remote cho MỘT PANE KHÁC ---------------------------
#
# `/remote on` gõ bên trong Claude Code phải đợi Claude rảnh mới được xử lý —
# giới hạn cứng của bản thân Claude Code, không sửa được (xem spec:
# docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md).
# Đường này không đi qua Claude Code chút nào: liệt kê mọi pane đang chạy
# claude, người dùng chọn một pane bằng số, rồi bật thẳng remote cho pane đó.
cmd_remote() {
  [ -f "$REMOTE_CLI" ] || { say "✗ Không tìm thấy $REMOTE_CLI."; exit 1; }
  command -v node >/dev/null 2>&1 || { say "✗ Cần Node.js."; exit 1; }

  list=$(node "$REMOTE_CLI" candidates) || { say "✗ Không lấy được danh sách phiên."; exit 1; }
  if [ -z "$list" ]; then
    say "Không có phiên Claude Code nào đang chạy trong tmux."
    exit 1
  fi

  count=$(printf '%s\n' "$list" | wc -l | tr -d ' ')
  say "Các phiên Claude Code đang chạy:"
  printf '%s\n' "$list" | while IFS="$(printf '\t')" read -r p on cwd target; do
    i=$((${i:-0} + 1))
    state="TẮT"
    [ "$on" = "1" ] && state="BẬT"
    say "  [$i] $target  ($state)  $cwd"
  done

  { [ -r /dev/tty ] && : < /dev/tty; } 2>/dev/null || { say "✗ Cần một terminal thật để chọn."; exit 1; }
  printf 'Nhập số: ' > /dev/tty
  IFS= read -r choice < /dev/tty || choice=""
  case "$choice" in
    ''|*[!0-9]*) say "✗ Số không hợp lệ."; exit 1 ;;
  esac
  if [ "$choice" -lt 1 ] || [ "$choice" -gt "$count" ]; then
    say "✗ Số ngoài khoảng 1-$count."
    exit 1
  fi

  chosen=$(printf '%s\n' "$list" | sed -n "${choice}p")
  pane=$(printf '%s' "$chosen" | cut -f1)
  target=$(printf '%s' "$chosen" | cut -f4)

  # Xác nhận lại NGAY trước khi bật — phòng pane đổi trạng thái giữa lúc liệt
  # kê và lúc người dùng gõ xong số (Claude ở pane đó vừa thoát, chẳng hạn).
  still=""
  still=$(node "$REMOTE_CLI" candidates | cut -f1 | grep -Fx "$pane") || true
  if [ -z "$still" ]; then
    say "✗ Phiên $target không còn nữa. Chạy lại 'ccrc remote'."
    exit 1
  fi

  printf 'Tên hiện trên điện thoại (bỏ trống = ngẫu nhiên): ' > /dev/tty
  IFS= read -r name < /dev/tty || name=""

  if [ -n "$name" ]; then
    node "$REMOTE_CLI" on --pane "$pane" "$name"
  else
    node "$REMOTE_CLI" on --pane "$pane"
  fi
}

if [ "${1:-}" = "remote" ]; then
  cmd_remote
  exit $?
fi
```

Note the `i=$((${i:-0} + 1))` inside the `while` loop: that loop runs in a subshell (right side of a pipe), so `i` does not survive past the loop — this is fine here because `i` is only ever used for DISPLAY inside the loop; the actual selection later re-derives the chosen line from `$list` directly with `sed -n "${choice}p"`, never from `$i`.

- [ ] **Step 4: Manual verification checklist**

There is no automated test for this step — run these by hand and confirm each line of expected output.

1. Re-render the template into a scratch copy so you don't have to reinstall to test:
   ```bash
   sed "s|{{CCRC_REPO}}|$(pwd)|g" deploy/ccrc > /tmp/ccrc-test
   chmod +x /tmp/ccrc-test
   ```
2. No Claude panes running: `/tmp/ccrc-test remote` → prints `Không có phiên Claude Code nào đang chạy trong tmux.`, exits non-zero.
3. Start a real `claude` session in tmux (`tmux new-session -d -s manualtest '<path to claude>'`, or just run `ccrc` for real in a spare terminal). Run `/tmp/ccrc-test remote` from a DIFFERENT pane/terminal → the running session appears in the numbered list, showing its correct working directory and `(TẮT)`.
4. Enter an out-of-range number (e.g. `99`) → `✗ Số ngoài khoảng 1-N.`, nothing started (`/remote` inside the Claude pane still reports off).
5. Enter blank / non-numeric input → `✗ Số không hợp lệ.`.
6. Enter the correct number, then a name at the second prompt → `/remote on --pane` output appears (`✓ Remote ĐÃ BẬT`, echoes the name given), and `/remote` (typed inside the actual Claude pane) now reports ON.
7. Run `/tmp/ccrc-test remote` again while that same session is still on → the list now shows `(BẬT)` for it.
8. Clean up: `/remote off` inside the Claude pane, kill the manual test session.

- [ ] **Step 5: Commit**

```bash
git add deploy/ccrc
git commit -m "deploy: add 'ccrc remote' to start a daemon from a different pane"
```

---

### Task 5: Full suite, docs cross-link, and installed-command refresh note

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md` (mark implemented; note the JSON→tab-separated deviation)

**Interfaces:** none — this task is verification and paperwork, no new code.

- [ ] **Step 1: Run the full test suite**

Run: `cd term && node --test --test-concurrency=4 test/*.test.js`
Expected: PASS, all files (this repo's full 283+ tests, now +9 for this feature: 2 in `tmux.test.js`, 4 in `candidates`, 4 in `on --pane` — Task 4 has no automated tests). No unrelated regressions.

Also run the OTHER two workspaces' suites, since `npm test` at the repo root chains all three and this is the last checkpoint before calling the feature done:

Run: `cd /Volumes/Data/workspace/projects/personal/cc-remote-control && npm test`
Expected: PASS for `server`, `hook`, and `term` workspaces.

- [ ] **Step 2: Update the spec doc's status line**

In `docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md`, change:

```
- **Trạng thái:** đã chốt với Huy, chưa triển khai
```

to:

```
- **Trạng thái:** đã triển khai (`ccrc remote`) — xem
  `docs/superpowers/plans/2026-08-02-kich-hoat-remote-tu-pane-khac.md`
```

Add one line under the "Kiến trúc" section's `candidates` bullet noting the format actually shipped:

```
  (Triển khai thực tế: tab-separated `pane\ton\tcwd\ttarget`, không phải
  JSON — lý do ở phần Global Constraints của plan triển khai.)
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-02-kich-hoat-remote-tu-pane-khac-design.md
git commit -m "docs: mark the external-remote-activation spec as implemented"
```

- [ ] **Step 4: Tell Huy to refresh his installed `ccrc`**

This is a manual step for Huy, not something to automate: his currently
INSTALLED `~/.local/bin/ccrc` is a copy made by `setup-notify.sh` at install
time — editing `deploy/ccrc` in the repo does not change what is already on
his `PATH`. After this plan is merged/deployed to his dev machine, he needs
to re-run `./setup-notify.sh` once to pick up the new `remote` subcommand.
Say this explicitly in the hand-off message; do not run it yourself.

---

## Self-Review Notes

- **Spec coverage:** §2 D1 (no /remote change) — enforced by Global Constraints + Task 3's "existing tests keep passing" gate. D2 (claude-only) — Task 2's filter + Global Constraints note on where enforcement lives. D3 (numbered list) — Task 4. D4 (`ccrc`, not raw `.js`) — Task 4. D5 (no `.tmux.conf`) — nothing in this plan touches it. §3 architecture — Tasks 1-4 map 1:1 to its three components. §4 error table — every row has a corresponding assertion (not-in-tmux/no-claude-panes: Task 4 step 4.2; bad number: step 4.4/4.5; pane changed between list and pick: the `cmd_remote` re-check + spec's own wording; already-on: Task 2's `on` field test + existing `cmdOn` short-circuit, unchanged). §5 testing — Tasks 1-3 give automated tests; Task 4's manual checklist mirrors the spec's own 4-item list. §6 "không đổi" — no task touches `deploy/commands/remote.md` or `.tmux.conf`.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact command.
- **Type consistency:** `listPanes()` → `{ paneId, cmd, cwd, target }` (Task 1) is consumed by `cmdCandidates` (Task 2) via `p.paneId`, `p.cmd`, `p.cwd`, `p.target` — names match. `cmdOn(rawName, explicitPane = null)` (Task 3) is called as `cmdOn(nameArg, onPane)` in the same task — matches.
