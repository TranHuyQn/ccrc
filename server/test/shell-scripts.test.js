// Static checks on the shell scripts, because the one-command installer runs
// on somebody else's laptop where a syntax slip is not a red test — it is a
// half-installed machine and a message they cannot act on.
//
// The first check exists because of a real failure. `say "Bung vào $DEST…"`
// died with `DEST\xe2: unbound variable`: the `…` follows the expansion
// directly, and with `set -u` under /bin/sh the shell read those UTF-8 bytes
// as part of the variable NAME. Every user-facing string here is Vietnamese,
// so this is one careless space away from happening again.
import test from './can-sh.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// setup-notify.sh and remove-notify.sh live here and NOT in BASH_SCRIPTS
// because install.sh and uninstall.sh invoke them as `sh <file>`, which
// overrides their shebang. Whatever they declare at the top, the shell that
// actually runs them is /bin/sh — dash on Debian/Ubuntu. Measured on Ubuntu
// 26.04: with them written as bash, the one-command install died at exit 2 and
// left a machine with the code unpacked but no ~/.ccrc/config, no hook and no
// slash commands. See "script chạy bằng `sh` phải là script POSIX" below,
// which is the rule that keeps this list honest.
const SH_SCRIPTS = ['server/public/install.sh', 'server/public/uninstall.sh', 'deploy/ccrc',
  'setup-notify.sh', 'remove-notify.sh'];
// deploy.sh is run by hand on the server, by name, from a checkout — its own
// shebang decides, so bash is a real choice there rather than a mistake.
const BASH_SCRIPTS = ['deploy.sh'];
const ALL = [...SH_SCRIPTS, ...BASH_SCRIPTS];

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// macOS /bin/sh is bash 3.2 in POSIX mode — it still understands `printf -v`,
// arrays, and `${v:0:3}`, so it does NOT die on the bashisms a real POSIX
// shell would reject. Only dash catches that class of bug. Used to decide,
// per-test, whether to run install.sh's POSIX-strict runtime checks under a
// real dash or skip them outright — silently falling back to `sh` would make
// the test pass for the wrong reason on exactly the machines that need it.
const hasBinary = (name) => {
  const r = spawnSync(name, ['--version']);
  return !r.error; // exit status doesn't matter (dash has no --version) — only whether it spawned at all
};
const HAS_DASH = hasBinary('dash');
const HAS_PYTHON3 = hasBinary('python3');

test('mọi script đều đúng cú pháp', () => {
  for (const rel of SH_SCRIPTS) {
    assert.doesNotThrow(() => execFileSync('sh', ['-n', path.join(root, rel)]), `sh -n ${rel}`);
  }
  for (const rel of BASH_SCRIPTS) {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', path.join(root, rel)]), `bash -n ${rel}`);
  }
});

// The bug this is named after, in its exact shape.
test('KHÔNG có biến nào đứng ngay trước ký tự không phải ASCII', () => {
  for (const rel of ALL) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      // Skip comments: the rule is about what the shell expands, and a comment
      // is never expanded.
      if (/^\s*#/.test(line)) return;
      const m = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])/.exec(line);
      assert.equal(m, null,
        `${rel}:${i + 1} — "$${m && m[1]}" đứng ngay trước ký tự tiếng Việt. `
        + `Với set -u, /bin/sh nuốt các byte UTF-8 vào TÊN BIẾN và báo "unbound variable". `
        + `Dùng \${${m && m[1]}} thay vì $${m && m[1]}.`);
    });
  }
});

// Scoped to the scripts that can actually END UP on the end of a pipe: the two
// served ones, and the two the installer invokes (which inherit its stdin).
// deploy.sh is run by hand on the server from a checkout and is never piped,
// so a plain `read` there is correct and this rule would be noise.
const PIPED = ['server/public/install.sh', 'server/public/uninstall.sh',
  'setup-notify.sh', 'remove-notify.sh'];

test('script có thể chạy qua pipe không được dùng `read` từ stdin', () => {
  // Under `curl … | sh`, stdin IS the script. A bare `read` there consumes the
  // rest of the script instead of waiting for the user.
  for (const rel of PIPED) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (!/\bread\b/.test(line)) return;
      assert.match(line, /<\s*\/dev\/tty/,
        `${rel}:${i + 1} — \`read\` phải đọc từ /dev/tty, nếu không nó nuốt mất phần còn lại của chính script khi chạy qua pipe`);
    });
  }
});

test('installer dừng ngay khi lỗi — set -eu', () => {
  for (const rel of SH_SCRIPTS) {
    assert.match(read(rel), /^set -eu$/m,
      `${rel} thiếu "set -eu" — một bước hỏng sẽ chạy tiếp và để lại máy cài dở`);
  }
});

// --- Chạy bằng `sh` thì shebang không có tiếng nói ------------------------
//
// `sh foo.sh` runs foo.sh under /bin/sh no matter what its first line says.
// The installer does exactly that, so a `#!/usr/bin/env bash` at the top of
// the invoked file is not a declaration — it is a lie that only macOS keeps,
// because there /bin/sh IS bash. On Debian/Ubuntu it is dash and the script
// dies. Derived from the CALLER rather than from a hand-kept list, so a new
// `sh "$DEST/whatever.sh"` added later is covered without anyone remembering
// this rule exists.
test('script chạy bằng `sh` phải khai shebang /bin/sh', () => {
  const callers = ['server/public/install.sh', 'server/public/uninstall.sh'];
  let found = 0;
  for (const caller of callers) {
    const src = read(caller);
    // `/` belongs in the character class: a script one directory down
    // (`sh "$DEST/term/foo.sh"`) is the same mistake, and leaving it out made
    // this guard report green while quietly matching nothing — the `found >= 2`
    // floor below is met by the two existing top-level call sites either way.
    for (const m of src.matchAll(/\bsh\s+"\$\{?DEST\}?\/([A-Za-z0-9._/-]+)"/g)) {
      found += 1;
      const target = m[1];
      const first = read(target).split('\n')[0];
      assert.equal(first, '#!/bin/sh',
        `${caller} chạy ${target} bằng \`sh\`, nhưng ${target} khai "${first}". `
        + `Shebang bị bỏ qua khi gọi kiểu đó — file PHẢI là POSIX thật, không phải bash.`);
    }
  }
  assert.ok(found >= 2, 'không tìm thấy lời gọi `sh "$DEST/..."` nào — regex đã lạc hậu so với installer');
});

// The bashisms that actually bit, plus the neighbours in the same family.
// `local` is not POSIX either but every shell in reach (dash, bash, ash,
// busybox, ksh93) implements it, so it is left alone deliberately — this list
// is the things that genuinely BREAK, not everything the standard omits.
const BASHISMS = [
  [/\bprintf\s+-v\b/, 'printf -v (bash-only; dash: "Illegal option -v") — gán bằng eval "$var=\\$val"'],
  [/\bset\s+-[a-z]*o\s+pipefail\b/, 'set -o pipefail (dash cũ không có) — dùng set -eu'],
  [/\[\[/, '[[ ... ]] (bash-only) — dùng [ ... ]'],
  [/<<</, '<<< here-string (bash-only) — dùng printf | ...'],
  [/^\s*[A-Za-z_][A-Za-z0-9_]*=\(/m, 'mảng =( ... ) (bash-only)'],
];

test('script POSIX không được dùng bashism', () => {
  for (const rel of SH_SCRIPTS) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const [re, why] of BASHISMS) {
        assert.ok(!re.test(line), `${rel}:${i + 1} — ${why}\n  ${line.trim()}`);
      }
    });
  }
});

// --- Đo THẬT dưới dash, không chỉ đọc chữ ---------------------------------
//
// The static rules above catch the two bashisms we know about. They cannot
// catch the third: `have_tty` used `{ : < /dev/tty; }`, and `:` is a POSIX
// SPECIAL built-in, so a failed redirection on it must terminate a
// non-interactive shell outright. Nothing in the text looks wrong; only
// running it with no terminal shows the script exiting 2 with the reason
// swallowed by its own `2>/dev/null`. So these two run the real scripts.
//
// No tty is the case that used to die silently, and it is also the only case a
// test runner can produce without a pty — which makes it the right one to
// automate. It exercises ask() too (CCRC_MACHINE_NAME is deliberately NOT
// passed), so the printf -v line is reached rather than skipped.
//
// `detached: true` is what makes "no tty" true rather than merely hoped for.
// The controlling terminal is a property of the SESSION, not of the file
// descriptors, so `stdio: ['ignore', …]` does not remove it: run the suite from
// an interactive shell and the child opens /dev/tty happily, `ask` prompts, and
// `read < /dev/tty` blocks — the prompt lands in the developer's terminal,
// keystrokes are taken from the test runner, and the test dies at its timeout.
// Reproduced in a tmux pane; it passed everywhere else only because those
// runners had no controlling terminal, i.e. for the wrong reason. detached
// calls setsid(2), which is portable to macOS as well — unlike the `setsid`
// command, which macOS does not ship.
const DETACH = { detached: true };
const sandboxEnv = (home) => {
  // A PATH with node but WITHOUT `claude`: setup-notify.sh installs the `ccrc`
  // command next to whatever `claude` it finds, and on a dev machine that is a
  // real directory outside the sandbox. Cutting `claude` out of PATH is what
  // keeps this test from writing into the user's own bin.
  const nodeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-path-'));
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  return {
    PATH: `${nodeBin}:/usr/bin:/bin`,
    HOME: home,
    CCRC_HUB_URL: 'https://hub.example.com',
    CCRC_TOKEN: 'tok-test',
  };
};

test('setup-notify.sh chạy trọn dưới dash khi KHÔNG có terminal', (t) => {
  if (!HAS_DASH) { t.skip('máy này không có dash — bỏ qua, không giả bằng sh vì sh trên macOS là bash'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  const r = spawnSync('dash', [path.join(root, 'setup-notify.sh')], {
    env: sandboxEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, ...DETACH,
  });
  assert.equal(r.status, 0,
    `setup-notify.sh chết dưới dash (exit ${r.status}).\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const cfg = path.join(home, '.ccrc', 'config');
  assert.ok(fs.existsSync(cfg), 'không ghi ra ~/.ccrc/config — máy cài dở mà không ai biết');
  assert.match(fs.readFileSync(cfg, 'utf8'), /^CCRC_TOKEN=tok-test$/m);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'commands', 'remote.md')), 'thiếu slash command /remote');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')), 'thiếu hook trong settings.json');
});

test('remove-notify.sh dưới dash, không terminal và không -y: từ chối tử tế chứ không chết câm', (t) => {
  if (!HAS_DASH) { t.skip('máy này không có dash'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  const r = spawnSync('dash', [path.join(root, 'remove-notify.sh')], {
    env: sandboxEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, ...DETACH,
  });
  // Exit 1 with the sentence, not exit 2 with nothing: the user must learn
  // that -y is what they need, instead of watching a command return in silence
  // and assuming it worked.
  assert.equal(r.status, 1, `mong exit 1 kèm lời giải thích, nhận exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /Không có terminal để hỏi/);
});

// The installer is served to anyone who asks for it.
test('script công khai không chứa token, khoá hay URL nội bộ', () => {
  for (const rel of SH_SCRIPTS) {
    const src = read(rel);
    assert.ok(!/[0-9a-f]{32}/.test(src), `${rel} có chuỗi trông như token/khoá`);
    assert.ok(!/192\.168\.\d+\.\d+/.test(src), `${rel} lộ địa chỉ nội bộ`);
    assert.ok(!/100\.\d+\.\d+\.\d+/.test(src), `${rel} lộ địa chỉ Tailscale`);
  }
});

// Deleting the tree you are executing from cannot work. The installer puts the
// code OUTSIDE ~/.ccrc for exactly this reason — the uninstaller wipes ~/.ccrc.
test('code cài KHÔNG nằm trong ~/.ccrc (thư mục mà lệnh gỡ xoá sạch)', () => {
  const src = read('server/public/install.sh');
  const m = /CCRC_APP_DIR:-([^}]+)}/.exec(src);
  assert.ok(m, 'không tìm thấy thư mục cài mặc định');
  assert.ok(!m[1].includes('.ccrc'),
    `thư mục cài mặc định là ${m[1]} — nằm trong .ccrc, mà remove-notify.sh xoá nguyên thư mục đó khi đang chạy từ trong nó`);
});

test('lệnh gỡ chạy remove-notify.sh với -y — qua pipe thì không có terminal để hỏi', () => {
  assert.match(read('server/public/uninstall.sh'), /remove-notify\.sh['"]?\s+-y/);
});

// --- lệnh ccrc -------------------------------------------------------------
//
// It promises to be "exactly claude, just inside tmux". Most of that promise
// is about the cases where wrapping would make it NOT exactly claude.

test('ccrc chuyển tham số qua bằng "$@", không nối chuỗi', () => {
  const src = read('deploy/ccrc');
  assert.match(src, /run_plain\(\)\s*{\s*exec\s+"\$CLAUDE_BIN"\s+"\$@"/,
    'phải exec với "$@" — nối chuỗi là vỡ tham số có dấu cách');
});

// Wrapping these in tmux sends the output into a pane instead of the caller's
// stdout, which is the opposite of "exactly claude".
test('ccrc KHÔNG bọc tmux khi: đã ở trong tmux, không có tty, hoặc dùng -p', () => {
  const src = read('deploy/ccrc');
  assert.match(src, /if \[ -n "\$\{TMUX:-\}" \]; then/, 'thiếu nhánh đã-ở-trong-tmux');
  assert.match(src, /\[ -t 0 \] && \[ -t 1 \]/, 'thiếu kiểm tra tty');
  assert.match(src, /-p\|--print\) run_plain/, 'thiếu nhánh chế độ in một lần');
});

// Inside somebody else's tmux session, ccrc cannot close the session — it may
// hold other windows. What it must close is the remote for THIS pane:
// measured on a live setup, once Claude exits the pane drops back to a bare
// shell that the daemon keeps serving, so the phone could see and type into it.
test('ccrc trong tmux sẵn có: chạy claude rồi TẮT remote của pane này', () => {
  const src = read('deploy/ccrc');
  const branch = src.slice(src.indexOf('if [ -n "${TMUX:-}" ]; then'));
  assert.ok(!/^\s*exec\s/m.test(branch.slice(0, branch.indexOf('\nfi'))),
    'exec là thay tiến trình — phần dọn dẹp sau đó sẽ không bao giờ chạy');
  assert.match(branch, /node "\$REMOTE_CLI" off/, 'thiếu phần tắt remote');
  assert.match(branch, /command -v node/, 'phải kiểm tra node trước khi gọi — máy có thể không có');
  assert.match(branch, /exit "\$rc"/, 'phải trả lại mã thoát của claude');
});

// The tmux server may have been started from a different login long ago, so a
// new session does NOT inherit the caller's environment. Measured, not
// assumed: a variable set immediately before the command did not reach it.
test('ccrc mang môi trường của người gọi vào phiên bằng -e', () => {
  const src = read('deploy/ccrc');
  assert.match(src, /set -- "\$@" -e "\$line"/, 'thiếu phần truyền biến môi trường');
  assert.match(src, /TERM=\*\|TMUX=\*/, 'phải bỏ qua TERM và TMUX — tmux tự đặt cho pane');
});

test('ccrc dùng đường dẫn tuyệt đối của claude, không phải tên lệnh', () => {
  const src = read('deploy/ccrc');
  assert.match(src, /CLAUDE_BIN=\$\(command -v claude/,
    'phải phân giải tuyệt đối: PATH bên trong tmux có thể khác');
  assert.ok(!/new-session[^\n]*\bclaude\b/.test(src),
    'không được đưa tên lệnh trần vào câu lệnh tmux');
});

test('ccrc trả lại mã thoát của claude, không phải của tmux', () => {
  const src = read('deploy/ccrc');
  assert.match(src, /printf %s \\\$\? >/, 'lệnh bên trong phải ghi lại mã thoát');
  assert.match(src, /exit "\$RC"/);
});

test('setup cài ccrc, remove gỡ ccrc', () => {
  const setup = read('setup-notify.sh');
  assert.match(setup, /sed "s\|\{\{CCRC_REPO\}\}\|\$REPO_DIR\|g" deploy\/ccrc > "\$BIN_DIR\/ccrc"/,
    'setup-notify.sh phải cài deploy/ccrc, thay chỗ trống bằng đường dẫn repo');
  // The template and the substitution have to agree, and they live in two
  // different files — a rename in one silently ships the literal placeholder.
  assert.match(read('deploy/ccrc'), /\{\{CCRC_REPO\}\}/,
    'deploy/ccrc thiếu chỗ trống mà setup-notify.sh đang thay');
  const rm = read('remove-notify.sh');
  assert.match(rm, /rm -f "\$CCRC_BIN"/, 'remove-notify.sh phải gỡ ccrc');
  // Deleting by name alone would remove somebody else's unrelated `ccrc`.
  assert.match(rm, /grep -qs '[^']+' "\$CCRC_BIN"/,
    'phải nhận diện bằng NỘI DUNG trước khi xoá, không chỉ bằng tên');
});

test('ccrc nằm trong gói cài phát cho máy dev', () => {
  assert.match(read('docker/Dockerfile.hub'), /COPY deploy\/ccrc/,
    'thiếu trong image thì người cài bằng một lệnh sẽ không có ccrc');
});

// --- gỡ cài đặt phải trả máy về đúng trạng thái trước khi cài -------------
//
// Đo tay trong một HOME giả: cài rồi gỡ, và ba thứ ở lại — lệnh `ccrc` (khi
// thư mục cài không nằm trên PATH), `settings.json` rỗng, và daemon vẫn chạy.
// Ba test dưới đây khoá đúng ba chỗ đó.

test('gỡ: dừng daemon TRƯỚC khi xoá ~/.ccrc', () => {
  const rm = read('remove-notify.sh');
  const stop = rm.indexOf('off-all');
  const wipe = rm.indexOf('rm -rf "$CFG_DIR"');
  assert.ok(stop !== -1, 'không dừng daemon nào — gỡ xong vẫn còn tiến trình phục vụ shell trên tailnet');
  assert.ok(wipe !== -1, 'không xoá $CFG_DIR');
  // File pid nằm TRONG $CFG_DIR và là thứ duy nhất ghi lại daemon nào đang
  // chạy. Xoá trước là vứt mất địa chỉ của thứ mình còn phải dừng.
  assert.ok(stop < wipe, 'xoá ~/.ccrc trước khi dừng daemon — mất luôn danh sách pid');
});

test('gỡ: tìm ccrc cả khi thư mục cài không nằm trên PATH', () => {
  const rm = read('remove-notify.sh');
  assert.match(rm, /command -v ccrc/, 'vẫn nên thử PATH trước');
  // setup-notify.sh tự cảnh báo trường hợp này, nên nó chắc chắn xảy ra được.
  assert.match(rm, /\$HOME\/\.local\/bin/,
    'chỉ tra PATH thì bỏ sót đúng trường hợp lệnh cài đã cảnh báo');
  assert.match(rm, /command -v claude/,
    'phải tra cả thư mục chứa claude — đó là chỗ setup cài vào trước tiên');
});

test('gỡ: xoá settings.json nếu nó rỗng và do lệnh cài tạo ra', () => {
  const rm = read('remove-notify.sh');
  assert.match(rm, /settings\.json/);
  // Chỉ khi RỖNG. Có chữ nào khác thì đó là cấu hình của người dùng.
  assert.match(rm, /= *"\{\}"/, 'phải kiểm nội dung đúng là object rỗng trước khi xoá');
});

test('gỡ: chỉ dùng rmdir cho thư mục — không rm -rf thư mục của người dùng', () => {
  const rm = read('remove-notify.sh');
  for (const dir of ['.claude/commands', '$HOME/.claude', '$HOME/.local']) {
    assert.ok(!new RegExp(`rm -rf "?[^"\\n]*${dir.replace(/[$.\\]/g, '\\$&')}`).test(rm),
      `${dir} bị xoá bằng rm -rf — thư mục còn đồ của người dùng sẽ mất theo`);
  }
  assert.match(rm, /rmdir "\$HOME\/\.claude"/, 'thiếu phần dọn thư mục rỗng');
});

// --- Kiểm toán 2026-07-29, lỗi 1: adduser phải biết "admin" đã có chủ ------
//
// Hub bỏ qua entry tên 'admin' (src/users.js) — đó là lớp chắn thật. Nhưng
// nếu deploy.sh vẫn vui vẻ tạo nó, người quản trị sẽ phát một token cho đồng
// nghiệp, đồng nghiệp báo "token không dùng được", và không ai nối được hai
// đầu đó với nhau. Chặn ngay tại chỗ tạo, kèm lý do.
// Chạy deploy.sh thật, với một `docker` giả trên PATH. Chặn phải xảy ra
// TRƯỚC khi chạm tới docker, nên con giả này chỉ cần đủ để qua hai dòng kiểm
// tra đầu file; nếu cái chặn không bắn, script sẽ đi tiếp và chết ở docker
// giả — hai kết cục phân biệt được bằng thông điệp, đúng thứ cần khẳng định.
function runDeploy(args) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakebin-'));
  fs.writeFileSync(path.join(bin, 'docker'),
    '#!/bin/sh\n[ "$1" = compose ] && [ "$2" = version ] && exit 0\necho "DOCKER GIẢ ĐƯỢC GỌI" >&2\nexit 1\n');
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  try {
    const r = spawnSync('bash', [path.join(root, 'deploy.sh'), ...args], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('deploy.sh adduser từ chối tên "admin" — tên dành riêng cho token hub', () => {
  const r = runDeploy(['adduser', 'admin']);
  assert.notEqual(r.code, 0, 'phải thoát với mã lỗi, không được tạo user');
  assert.match(r.out, /dành riêng/,
    'phải nói rõ vì sao bị từ chối — người quản trị cần biết để đặt tên khác');
  assert.ok(!/DOCKER GIẢ ĐƯỢC GỌI/.test(r.out),
    'phải chặn TRƯỚC khi gọi docker: không được ghi gì vào users.json rồi mới nghĩ lại');
});

test('deploy.sh adduser vẫn nhận tên bình thường — chặn đúng một tên, không hơn', () => {
  const r = runDeploy(['adduser', 'admin-huy']);
  assert.ok(!/dành riêng/.test(r.out),
    'chỉ đúng chuỗi "admin" là tên dành riêng; "admin-huy" là một người thật và phải tạo được');
  assert.match(r.out, /DOCKER GIẢ ĐƯỢC GỌI/,
    'đi qua được cái chặn thì phải tới bước gọi docker — chứng tỏ chặn không bắt nhầm');
});

// --- Task 11: tài liệu phải nói đúng về mô hình đe doạ sau khi ghép cặp ----
//
// Tài liệu là một phần của cơ chế thu hồi, không phải phần trang trí quanh
// nó. Nếu nó để `unpair` và "gỡ khỏi Tailscale" ngang hàng nhau, người ta sẽ
// làm cái yếu (một máy) và bỏ cái mạnh (mọi máy cùng lúc).
test('hướng dẫn nói rõ gỡ khỏi Tailscale mới là công tắc ngắt thật', () => {
  const src = read('docs/huong-dan.md');
  assert.match(src, /ghép cặp|ghép máy/i, 'phải có phần nói về ghép cặp');
  assert.match(src, /Tailscale[^.]{0,80}(công tắc|ngắt|thu hồi)/i,
    'phải nói Tailscale là công tắc ngắt thật khi mất điện thoại');
  assert.match(src, /không sao lưu được|mất khoá|ghép lại/i,
    'phải cảnh báo trước rằng xoá dữ liệu trang là mất khoá và phải ghép lại');
});

test('hướng dẫn KHÔNG còn nói hub giữ khoá ký vé', () => {
  const src = read('docs/huong-dan.md');
  assert.ok(!/hub giữ\s*\n?\s*khoá ký vé/i.test(src),
    '§8 còn mô tả kiến trúc cũ — người đọc sẽ tin vào một mô hình đe doạ không còn đúng');
});

// --- Biến môi trường: code là nguồn sự thật, tài liệu phải theo kịp --------
//
// Ba biến (`CCRC_TRUST_PROXY`, `CCRC_TS_PUBLIC_URL`, `CCRC_TS_INTERNAL_URL`)
// từng được thêm vào hub mà `docs/self-hosting.md` — tài liệu DUY NHẤT để dựng
// hub ở bản public — không hề nhắc tới, suốt cho tới khi có người đọc lại bằng
// tay. Không bài test nào bắt được, vì file đó chỉ tồn tại ở bản public còn bộ
// test thì chạy ở repo private.
//
// `CCRC_TRUST_PROXY` là lý do bài này đáng có: nó hỏng theo CẢ HAI chiều và
// chiều nào cũng im lặng — bật mà quên `CCRC_BIND=127.0.0.1` thì vô nghĩa, còn
// có proxy mà không bật thì cả internet chung một rổ rate-limit. Một biến như
// vậy mà không có trong tài liệu thì coi như không tồn tại.
function bienNguoiVanHanhDatDuoc() {
  const found = new Set();
  // Thứ tiến trình hub thật sự đọc.
  const srcDir = path.join(root, 'server', 'src');
  for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith('.js'))) {
    const m = fs.readFileSync(path.join(srcDir, f), 'utf8').match(/process\.env\.(CCRC_[A-Z_]+)/g) || [];
    for (const hit of m) found.add(hit.replace('process.env.', ''));
  }
  // Thứ chỉ compose đọc (`CCRC_BIND`, `CCRC_DOMAIN`, `CCRC_TUNNEL_TOKEN`) —
  // người vận hành vẫn đặt chúng trong cùng một file `.env`, nên tài liệu vẫn
  // nợ họ một dòng giải thích.
  const compose = read('docker-compose.yml').match(/\$\{(CCRC_[A-Z_]+)/g) || [];
  for (const hit of compose) found.add(hit.replace('${', ''));
  return [...found].sort();
}

// Kiểm mọi tài liệu CÓ MẶT. `docs/self-hosting.md` chỉ tồn tại ở bản public,
// nên bài này phải bỏ qua khi vắng thay vì đỏ — có vậy nó mới chạy được y hệt
// ở cả hai repo, và bản public mới thật sự được canh.
const TAI_LIEU_BIEN_MOI_TRUONG = ['README.md', 'README.vi.md', 'docs/self-hosting.md'];

test('mọi biến người vận hành đặt được đều có trong bảng biến của tài liệu', () => {
  const bien = bienNguoiVanHanhDatDuoc();
  assert.ok(bien.length >= 7, `chỉ tìm thấy ${bien.length} biến — hàm dò hỏng rồi`);

  for (const rel of TAI_LIEU_BIEN_MOI_TRUONG) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    const src = read(rel);
    // Phải là một HÀNG BẢNG có mô tả, không chỉ "tên biến xuất hiện đâu đó
    // trong file". Bản đầu của bài này dùng `includes()` và xanh trơn khi xoá
    // hẳn một hàng khỏi bảng — vì cái tên vẫn còn nằm trong một đoạn văn xuôi
    // vài chục dòng phía trên. Một biến được nhắc giữa câu thì người đi tra
    // bảng vẫn không tìm ra.
    const thieu = bien.filter((b) => !new RegExp(`^\\|\\s*\`${b}\``, 'm').test(src));
    assert.deepEqual(thieu, [],
      `${rel} thiếu hàng bảng cho ${thieu.join(', ')} — thêm biến vào code mà quên ghi `
      + 'tài liệu thì người vận hành không có cách nào biết nó tồn tại');
  }
});

// Cặp đôi này phải đi cùng nhau, và tài liệu là chỗ duy nhất nói ra điều đó:
// code không ép được, còn hậu quả khi đặt lệch thì không ai thấy ngay.
test('tài liệu nói rõ CCRC_TRUST_PROXY phải đi kèm CCRC_BIND', () => {
  for (const rel of TAI_LIEU_BIEN_MOI_TRUONG) {
    if (!fs.existsSync(path.join(root, rel))) continue;
    const src = read(rel);
    if (!src.includes('CCRC_TRUST_PROXY')) continue;
    const doan = src.split(/\n(?=[|#])/).filter((d) => d.includes('CCRC_TRUST_PROXY')).join('\n');
    assert.match(doan, /CCRC_BIND/,
      `${rel}: nhắc CCRC_TRUST_PROXY mà không nhắc CCRC_BIND ngay cạnh — bật một mình là vô nghĩa`);
  }
});

// --- Kiểm toán 2026-08-17: CCRC_VAPID_SUBJECT là biến DUY NHẤT hỏng âm thầm
// theo cách người vận hành không thể tự thấy ------------------------------
//
// Một hub dựng đúng theo hướng dẫn — `./deploy.sh`, tunnel lên, `/notify` trả
// { ok: true, pushed: true } — vẫn không đẩy nổi một thông báo nào tới iPhone,
// vì compose rơi về `mailto:admin@localhost` và Apple trả 403 BadJwtToken cho
// mọi push dưới subject đó. Hub chỉ ghi lỗi vào log của chính nó; phía gọi
// thấy thành công. Trên một server người khác quản, log là thứ người dùng
// KHÔNG với tới được — nên "hub tự cảnh báo trong log" không phải một lớp
// chắn, nó chỉ là một lớp chắn cho người có ssh.
//
// deploy.sh đã tự đặt CCRC_TRUST_PROXY và CCRC_BIND đúng vì nó BIẾT hình dạng
// triển khai. Nó không đoán được domain hub, nên phải hỏi — và phải nói lại
// một lần nữa ở cuối, sau khi hub lên, cho cả những người có sẵn .env cũ và
// không bao giờ đi qua câu hỏi đó.
function runDeployTrongThuMucRieng({ env = '', input = '' } = {}) {
  // deploy.sh `cd "$(dirname "$0")"` rồi ghi thẳng vào ./.env — chạy nó tại
  // gốc repo là ghi vào .env thật của người đang dev. Chép script ra thư mục
  // tạm: nó không đọc file nào khác trong repo, mọi thứ còn lại đi qua docker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-deploy-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakebin-'));
  // Docker giả nói "có" với mọi thứ: `compose version`, `up -d --build`, và
  // lượt `compose exec ... healthz` mà script chờ. Bài này không kiểm docker,
  // nó kiểm những gì script ghi ra .env và nói với người vận hành.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  fs.copyFileSync(path.join(root, 'deploy.sh'), path.join(dir, 'deploy.sh'));
  fs.chmodSync(path.join(dir, 'deploy.sh'), 0o755);
  if (env) fs.writeFileSync(path.join(dir, '.env'), env);
  try {
    const r = spawnSync('bash', [path.join(dir, 'deploy.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      input,
      encoding: 'utf8',
    });
    const sau = fs.existsSync(path.join(dir, '.env'))
      ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '';
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, env: sau };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// .env đã đủ mọi thứ trừ subject — cô lập đúng một biến đang được kiểm.
const ENV_DU_TRU_SUBJECT = 'CCRC_TOKEN=deadbeef\nCCRC_TUNNEL_TOKEN=eyJfake\n';

test('deploy.sh hỏi domain hub khi .env chưa có CCRC_VAPID_SUBJECT, và ghi lại', () => {
  const r = runDeployTrongThuMucRieng({
    env: ENV_DU_TRU_SUBJECT,
    input: 'https://ccrc.congty.vn\n',
  });
  assert.match(r.out, /iPhone/,
    'câu hỏi phải nói rõ hậu quả (iPhone không nhận được gì) — không thì người ta Enter cho xong');
  assert.match(r.env, /^CCRC_VAPID_SUBJECT=https:\/\/ccrc\.congty\.vn$/m,
    'phải ghi đúng giá trị vừa nhập vào .env');
});

test('deploy.sh bỏ qua được câu hỏi subject, nhưng phải cảnh báo lại ở cuối', () => {
  const r = runDeployTrongThuMucRieng({ env: ENV_DU_TRU_SUBJECT, input: '\n' });
  assert.equal(r.code, 0, 'Enter bỏ qua là hợp lệ — hub chỉ phục vụ Android vẫn chạy tốt');
  assert.ok(!/^CCRC_VAPID_SUBJECT=..*$/m.test(r.env),
    'không nhập gì thì không được ghi một giá trị bịa vào .env');
  assert.match(r.out, /CCRC_VAPID_SUBJECT/,
    'phải nhắc lại TÊN biến ở cuối, sau khi hub đã lên — đó là thứ người ta copy đi sửa');
  assert.match(r.out, /iPhone/,
    'cảnh báo cuối phải nói ai bị ảnh hưởng, không chỉ "thiếu biến"');
});

test('deploy.sh cảnh báo cả khi .env có sẵn một subject Apple từ chối', () => {
  // Đường mà mọi hub dựng trước bản này đều đi: .env cũ, không hề trống, nên
  // câu hỏi ở trên không bao giờ bắn — chỉ cảnh báo cuối bắt được ca này.
  const r = runDeployTrongThuMucRieng({
    env: `${ENV_DU_TRU_SUBJECT}CCRC_VAPID_SUBJECT=mailto:admin@localhost\n`,
  });
  assert.match(r.out, /CCRC_VAPID_SUBJECT/,
    'giá trị trỏ về localhost là giá trị Apple từ chối — im lặng ở đây là để nguyên lỗi');
});

test('deploy.sh KHÔNG hỏi lại và KHÔNG cảnh báo khi subject đã đặt đúng', () => {
  const r = runDeployTrongThuMucRieng({
    env: `${ENV_DU_TRU_SUBJECT}CCRC_VAPID_SUBJECT=https://ccrc.congty.vn\n`,
  });
  assert.ok(!/Domain công khai của hub/.test(r.out),
    'đã có giá trị thật thì không được hỏi lại — chạy lại deploy.sh phải im lặng đi qua');
  assert.ok(!/⚠[^\n]*CCRC_VAPID_SUBJECT/.test(r.out),
    'cảnh báo bắn cả khi đã đặt đúng thì lần sau không ai đọc nó nữa');
  assert.match(r.env, /^CCRC_VAPID_SUBJECT=https:\/\/ccrc\.congty\.vn$/m,
    'không được ghi đè giá trị người vận hành đã tự đặt');
});

// `.env.example` là thứ người ta `cp` rồi điền — một dòng đã comment sẵn là
// một dòng bị lướt qua. CCRC_TOKEN không bị comment vì thiếu nó hub không
// chạy; subject cũng phải nằm cùng hạng đó, vì thiếu nó hub chạy nhưng iPhone
// im lặng — hỏng nặng hơn mà lại khó thấy hơn.
test('.env.example để CCRC_VAPID_SUBJECT ở dạng phải điền, không phải dòng comment', () => {
  const src = read('.env.example');
  assert.match(src, /^CCRC_VAPID_SUBJECT=/m,
    'phải có một dòng CCRC_VAPID_SUBJECT= chưa comment để người ta thấy mà điền');
});

// Chạy hub bằng systemd là đường đi thứ hai, và nó không đọc .env — người theo
// đường này không có gì nhắc họ về subject cả.
test('unit systemd có sẵn dòng CCRC_VAPID_SUBJECT để sửa', () => {
  const src = read('deploy/ccrc-hub.service');
  assert.match(src, /Environment=CCRC_VAPID_SUBJECT=/,
    'unit file là .env của người chạy Node trực tiếp — thiếu dòng này là họ không biết biến tồn tại');
});

// Bảng trục trặc là nơi người dùng cuối đi tới khi im lặng xảy ra. Trước bản
// này nó quy hết cho `/notify off`, nên người đọc kiểm đúng một thứ, thấy nó
// đang bật, rồi hết đường.
test('bảng trục trặc nêu cả nguyên nhân phía hub cho "không nhận thông báo"', () => {
  const src = read('docs/huong-dan.md');
  const hang = src.split('\n').filter((l) => /không nhận (được )?thông báo/i.test(l)).join('\n');
  assert.ok(hang, 'không tìm thấy hàng nào nói về việc không nhận được thông báo');
  assert.match(hang, /iPhone|VAPID/,
    'phải nêu khả năng hub thiếu CCRC_VAPID_SUBJECT — im lặng riêng với iPhone, /notify vẫn báo ok');
});

// --- Task 13: điện thoại thôi quyết định, tài liệu phải nói đúng nghi thức
// mới -------------------------------------------------------------------
//
// Sau spec §12.2, máy dev là bên quyết định — không phải điện thoại và không
// phải "hai màn hình trùng số". Câu cũ ("nếu hub tráo chuỗi nào thì hai màn
// hình sẽ hiện hai số khác nhau và bạn thấy ngay") đúng chữ cho một hub TRÁO
// nhưng vô nghĩa cho một hub CHUYỂN HƯỚNG sang điện thoại khác — đúng cuộc
// tấn công spec §12.2 mô tả, nơi cả hai màn hình đều tự nhất quán và không
// hề lệch nhau. Tài liệu phải mô tả đúng nghi thức hai lệnh đã ship, không
// phải nghi thức so-số-rồi-bấm-nút mà nó đã thay thế.
// Task 15 review: hai bài lint dưới đây từng chỉ đọc docs/huong-dan.md, nên
// README.md — nơi bị bỏ sót — vẫn để nguyên câu "so một mã 6 chữ số trên hai
// màn hình" (nghi thức cũ, đã bị thay từ 2026-07-29) trót lọt qua mọi lint.
// Chạy cả hai bài trên MỌI file mô tả nghi thức ghép cặp, không chỉ một.
//
// Mở repo (2026-07-30): README.md thành bản tiếng ANH và bản Việt chuyển sang
// README.vi.md. Cùng một cái bẫy lại mở ra — một file MỚI mô tả nghi thức, và
// một lint chỉ biết cụm từ tiếng Việt sẽ pass VÔ ĐIỀU KIỆN trên file tiếng Anh
// (không có "gõ" nào để tìm, cũng không có "chữ số" nào để cấm). Nên mỗi file
// mang theo bộ mẫu của đúng ngôn ngữ nó viết: `phaiCo` là thứ bắt buộc phải
// nói, `khongDuocCo` là nghi thức cũ không được sót lại.
const TAI_LIEU_GHEP_CAP = [
  { rel: 'docs/huong-dan.md', vi: true },
  { rel: 'README.vi.md', vi: true },
  { rel: 'README.md', vi: false },
];

// Lệnh thì giống nhau ở mọi ngôn ngữ — tên lệnh không dịch.
const LENH_XAC_NHAN = /\/remote pair xac-nhan/;
// "GÕ số vào máy dev", nói bằng hai thứ tiếng.
const PHAI_NOI_VIEC_GO = {
  vi: /gõ.{0,40}(số|nó).{0,60}(máy dev|máy)/is,
  en: /type\b.{0,60}(into|on) the dev machine/is,
};
// Nghi thức cũ "so mã N chữ số trên hai màn hình" — cấm ở cả hai thứ tiếng.
// Không cấm MỌI câu nhắc "hai màn hình": tài liệu hợp lệ vẫn phải giải thích
// TẠI SAO hai màn hình trùng số không còn đủ tin cậy.
const NGHI_THUC_CU = {
  vi: /\d+\s*chữ số[^.]{0,40}(trên|tren) hai (màn hình|man hinh)/i,
  en: /\d+[-\s]?digit[^.]{0,40}on (both|two) screens/i,
};

test('hướng dẫn mô tả đúng nghi thức hai lệnh: gõ số đọc trên điện thoại vào máy dev', () => {
  for (const { rel, vi } of TAI_LIEU_GHEP_CAP) {
    const src = read(rel);
    assert.match(src, LENH_XAC_NHAN,
      `${rel}: phải nêu đúng lệnh máy dev dùng để nhận số — không chỉ nói chung chung "so số"`);
    assert.match(src, vi ? PHAI_NOI_VIEC_GO.vi : PHAI_NOI_VIEC_GO.en,
      `${rel}: phải nói rõ việc GÕ số vào máy dev, không chỉ "so hai màn hình"`);
  }
});

test('hướng dẫn KHÔNG còn nói "hai màn hình khác số là thấy ngay" — câu đó sai khi hub chuyển hướng', () => {
  for (const { rel, vi } of TAI_LIEU_GHEP_CAP) {
    const src = read(rel);
    assert.ok(!/tráo chuỗi nào.{0,20}hai màn hình.{0,20}hiện hai số khác nhau/is.test(src),
      `${rel}: câu này chỉ đúng cho hub TRÁO, sai cho hub CHUYỂN HƯỚNG (spec §12.2) — không được để lại nguyên văn`);
    // Câu cũ (README.md:138, trước bản sửa Task 15) là "xác nhận bằng cách so
    // một mã 6 chữ số trên hai màn hình" — mô tả đúng nghi thức đã bị thay:
    // người đọc theo nó sẽ đi tìm số của MÁY, thứ mà thiết kế hiện tại cấm in
    // ra.
    assert.ok(!(vi ? NGHI_THUC_CU.vi : NGHI_THUC_CU.en).test(src),
      `${rel}: không được còn mô tả việc so mã N-chữ-số TRÊN HAI MÀN HÌNH — nghi thức hiện tại là MỘT CHIỀU, chỉ điện thoại hiện số`);
  }
});

// --- Task 10: setup-notify.sh lấy token bằng device-code -------------------
//
// Device-code chạy trên máy người khác, nên cái sai ở đây không phải test đỏ
// mà là một người ngồi nhìn terminal treo.
test('setup-notify.sh có luồng device-code và DỪNG khi hub trả 410', () => {
  const src = read('setup-notify.sh');
  assert.match(src, /\/api\/device\/start/, 'phải xin được mã');
  assert.match(src, /\/api\/device\/poll/, 'phải poll được');
  // Không chỉ tìm chuỗi "410)" — chuỗi đó có thể nằm trong comment trong khi
  // nhánh thật đã đổi thành "chờ tiếp". Bắt đúng NỘI DUNG của arm case 410),
  // tới dấu ";;" kế tiếp, và đòi trong đó có return 1.
  const m = /410\)([\s\S]*?);;/.exec(src);
  assert.ok(m, 'không bắt 410 thì mã hết hạn xong script poll mãi tới hết deadline');
  assert.match(m[1], /return 1/,
    '410 phải DỪNG vòng lặp (return 1) — không chỉ được nhắc tới đâu đó trong file');
  assert.match(src, /428\|429\)/, 'chưa duyệt và poll nhanh quá đều là "chờ tiếp", không phải lỗi');
});

test('setup-notify.sh vẫn cho dán token tay khi device-code hỏng', () => {
  const src = read('setup-notify.sh');
  assert.match(src, /ask TOKEN/,
    'hub cũ hoặc mạng hỏng thì vẫn phải cài được — đừng bỏ đường lui');
});

// Bài trên chỉ soát HÌNH DẠNG của source text. Bài này chạy THẬT hàm
// device_code_login (trích thẳng từ setup-notify.sh, không chép tay) chống
// lại một hub giả trả 410, và đo thời gian: nếu 410 không còn dừng vòng lặp,
// hub giả đặt ttl=30s nên test này sẽ chờ gần hết 30 giây rồi mới xong hoặc
// bị kill bởi timeout — thấy ngay bằng thời gian chạy, không cần đọc log.
test('device_code_login THẬT SỰ dừng ngay khi hub trả 410, không đợi hết ttl', async () => {
  const src = read('setup-notify.sh');
  const fnStart = src.indexOf('json_field() {');
  const fnEnd = src.indexOf('\nHUB_URL=');
  assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart,
    'không trích được json_field/device_code_login từ setup-notify.sh — vị trí trong file đã đổi?');
  const funcs = src.slice(fnStart, fnEnd);

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 30, interval: 1,
      }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'expired' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // `if device_code_login; then ...` là đúng cách setup-notify.sh gọi hàm này
  // thật (chỗ TOKEN=... trong file chính) — điều kiện của if được set -e miễn
  // trừ, nên bài test dùng đúng ngữ cảnh mà code thật chạy trong đó.
  const script = `
set -euo pipefail
say() { :; }
${funcs}
HUB_URL="http://127.0.0.1:${port}"
if device_code_login; then
  echo "RC=0"
else
  echo "RC=$?"
fi
`;
  // spawnSync ở đây từng làm test TREO CHẾT: nó khoá cứng event loop của
  // chính tiến trình node đang chạy server giả, nên server không bao giờ kịp
  // trả lời request của curl từ tiến trình con — cả hai đứng chờ nhau mãi.
  // Đo được bằng thực nghiệm (mọi lần đều timeout, stdout/stderr rỗng dù
  // curl gọi thủ công tới cùng server thành công tức thì). spawn() bất đồng
  // bộ giữ event loop chạy nên server vẫn phục vụ được trong lúc chờ.
  const child = spawn('bash', ['-c', script]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const startedAt = Date.now();
  const { code, signal } = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 10000);
    child.on('exit', (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  const elapsedMs = Date.now() - startedAt;
  server.close();

  assert.ok(!signal, `bị kill bởi timeout (signal=${signal}) — 410 không dừng vòng lặp. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `bash -c bọc ngoài phải thoát 0 (chỉ nhánh if/else in RC ra). stdout=${stdout} stderr=${stderr}`);
  // Neo cả hai đầu dòng: /RC=1/ không neo cũng khớp "RC=127" (command not
  // found nếu hàm bị thiếu/đổi tên) — bài test khi đó xanh dù device_code_login
  // không hề chạy đúng.
  assert.match(stdout, /^RC=1$/m, `device_code_login phải trả 1 khi hub trả 410. stdout=${stdout} stderr=${stderr}`);
  assert.ok(elapsedMs < 8000,
    `mất ${elapsedMs}ms — nếu 410 không dừng vòng lặp, test này phải đợi gần hết ttl=30s thay vì dừng ở lần poll đầu`);
});

// Duyệt nhầm mã là chuyện xảy ra được: userCode được đọc to trong phòng hoặc
// dán vào chat. Nếu nhầm, máy dev vừa ghi token VĨNH VIỄN của người khác vào
// ~/.ccrc/config, và mọi thông báo từ máy này chảy sang tài khoản họ — im
// lặng. Dòng in tên là chỗ DUY NHẤT bắt được việc đó ngay lúc nó xảy ra, nên
// nó được kiểm bằng cách chạy thật hàm trích từ chính script, không phải bằng
// một phép so chuỗi trên source.
async function runDeviceCodeLogin(pollBody) {
  const src = read('setup-notify.sh');
  const fnStart = src.indexOf('json_field() {');
  const fnEnd = src.indexOf('\nHUB_URL=');
  assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart,
    'không trích được json_field/device_code_login từ setup-notify.sh — vị trí trong file đã đổi?');
  const funcs = src.slice(fnStart, fnEnd);

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 30, interval: 1,
      }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pollBody));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // say() in thật ở đây (khác bài 410 ở trên, nơi nó bị nuốt): thứ đang được
  // kiểm CHÍNH LÀ dòng chữ người dùng đọc được.
  const script = `
set -euo pipefail
say() { printf '%s\\n' "$*"; }
${funcs}
HUB_URL="http://127.0.0.1:${port}"
if device_code_login; then echo "RC=0"; else echo "RC=$?"; fi
echo "TOKEN=\${DEVICE_TOKEN}"
`;
  const child = spawn('bash', ['-c', script]);
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  server.close();
  return stdout;
}

test('nhận token xong thì IN TÊN người đã duyệt — duyệt nhầm phải thấy được ngay', async () => {
  const out = await runDeviceCodeLogin({ ok: true, token: 'tok-abc', displayName: 'huy' });
  assert.match(out, /RC=0/, `device_code_login phải thành công. stdout=${out}`);
  assert.match(out, /TOKEN=tok-abc/, `token phải được nhận. stdout=${out}`);
  assert.match(out, /Đã nhận token của huy\./,
    `phải in tên người duyệt, nếu không thì duyệt nhầm người là lỗi im lặng. stdout=${out}`);
});

test('hub không trả displayName → vẫn báo xong, KHÔNG in "undefined"', async () => {
  const out = await runDeviceCodeLogin({ ok: true, token: 'tok-abc' });
  assert.match(out, /RC=0/, `stdout=${out}`);
  assert.match(out, /Đã nhận token\./, `phải rơi về câu cũ. stdout=${out}`);
  assert.doesNotMatch(out, /undefined|null|của \./,
    `stdout=${out}`);
});

// Hub (saveSlackUser) ghi đúng file này qua temp+rename. Một tên tạm DÙNG
// CHUNG nghĩa là hai tiến trình đạp lên nhau ngay trong file tạm và rename ra
// một nội dung lai của cả hai — một mối nguy thứ hai chồng lên cuộc đua
// đọc-sửa-ghi vốn có, và là mối nguy DUY NHẤT trong hai cái mà tầng này xoá
// được.
// interval=0 lọt qua bộ lọc chữ số, và `sleep 0` biến vòng poll thành một
// vòng quay không nghỉ suốt 600 giây — nhánh 428|429 chỉ "chờ tiếp", nó không
// giãn nhịp. Chạy THẬT với một hub trả interval=0 và đếm số lần poll: nếu
// guard hỏng, con số này là hàng nghìn thay vì một nhúm.
test('hub trả interval=0 KHÔNG biến vòng poll thành vòng quay không nghỉ', async () => {
  const src = read('setup-notify.sh');
  const fnStart = src.indexOf('json_field() {');
  const fnEnd = src.indexOf('\nHUB_URL=');
  const funcs = src.slice(fnStart, fnEnd);

  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // ttl 3 giây để bài kiểm kết thúc nhanh; interval 0 là thứ đang bị kiểm.
      res.end(JSON.stringify({
        ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 3, interval: 0,
      }));
      return;
    }
    if (req.url === '/api/device/poll') {
      polls += 1;
      res.writeHead(428, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'chưa duyệt' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -euo pipefail
say() { :; }
${funcs}
HUB_URL="http://127.0.0.1:${port}"
if device_code_login; then echo "RC=0"; else echo "RC=$?"; fi
`;
  const child = spawn('bash', ['-c', script]);
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  server.close();

  assert.match(stdout, /^RC=1$/m, `hết ttl mà chưa duyệt thì phải trả 1. stdout=${stdout}`);
  // Với interval rơi về 5 và ttl=3 thì đúng 1 lượt poll. Cho rộng tay: bất cứ
  // con số nhỏ nào cũng nghĩa là có ngủ thật giữa hai lượt.
  assert.ok(polls <= 5,
    `poll ${polls} lần trong 3 giây — interval=0 đã lọt qua guard và vòng lặp đang quay không nghỉ`);
});

// --- install.sh: cùng luồng device-code, nhưng là POSIX sh, không phải bash -
//
// Đây là đường cài chính mà docs/huong-dan.md đưa cho thành viên mới — thứ mà
// setup-notify.sh có nhưng install.sh (trước sửa này) không có, nên tính năng
// không tới được đúng người nó được xây cho. Cùng lý luận với bộ test phía
// trên cho setup-notify.sh, áp lại cho install.sh.
//
// install.sh chạy dưới /bin/sh, và các bài runtime bên dưới ƯU TIÊN chạy bằng
// dash THẬT, không phải `sh`. Lý do không dùng `sh`: trên macOS /bin/sh là
// bash 3.2 ở chế độ POSIX — nó vẫn hiểu `printf -v`, mảng, `${v:0:3}`, tức là
// KHÔNG chết như dash thật trước những thứ đó (đo được, xem hasBinary/HAS_DASH
// ở đầu file). Máy không có dash thì các bài runtime bên dưới tự skip thay vì
// âm thầm chạy dưới `sh` và xanh vì lý do sai.
test('install.sh có luồng device-code và DỪNG khi hub trả 410', () => {
  const src = read('server/public/install.sh');
  assert.match(src, /\/api\/device\/start/, 'phải xin được mã');
  assert.match(src, /\/api\/device\/poll/, 'phải poll được');
  const m = /410\)([\s\S]*?);;/.exec(src);
  assert.ok(m, 'không bắt 410 thì mã hết hạn xong script poll mãi tới hết deadline');
  assert.match(m[1], /return 1/,
    '410 phải DỪNG vòng lặp (return 1) — không chỉ được nhắc tới đâu đó trong file');
  assert.match(src, /428\|429\)/, 'chưa duyệt và poll nhanh quá đều là "chờ tiếp", không phải lỗi');
});

test('install.sh CHỈ chạy device-code khi thiếu token — có token thì hành vi không đổi', () => {
  const src = read('server/public/install.sh');
  // TOKEN vẫn phải tới từ tham số/biến môi trường trước tiên, không đổi hình
  // dạng — server/test/notify-api.test.js đã khoá đúng chuỗi này ở phía hub.
  assert.match(src, /TOKEN="\$\{1:-\$\{CCRC_TOKEN:-\}\}"/,
    'thứ tự nhận token (tham số rồi tới CCRC_TOKEN) không được đổi — admin và cài lại phụ thuộc vào nó');
  // device_code_login() phải nằm trong nhánh "TOKEN rỗng" — có token thì
  // không được gọi tới, không được chờ mạng vô ích hay in mã ra màn hình.
  const guard = /if \[ -z "\$TOKEN" \]; then\s*\n\s*device_code_login/.exec(src);
  assert.ok(guard, 'device_code_login phải được gói trong `if [ -z "$TOKEN" ]`');
});

test('install.sh KHÔNG còn dead-end im lặng khi thiếu token — die phải nói rõ cả hai đường lui', () => {
  const src = read('server/public/install.sh');
  // Thông điệp "Thiếu token" cũ chết trước khi device-code kịp chạy — đúng
  // hình dạng lỗi mà sửa này phải xoá.
  assert.ok(!/die "Thiếu token\./.test(src),
    'còn thông điệp "Thiếu token" cũ nghĩa là die vẫn chạy trước khi thử device-code');
  // Người dùng phải biết còn cách nào khác khi device-code hỏng (mạng, hub
  // cũ...) — không được dead-end mà không nói gì.
  assert.match(src, /die "[^"]*\n[^"]*<token-cua-ban>/,
    'die khi hết đường phải còn chỉ cách dùng token tay — không được dead-end vô hồn');
});

// install.sh không có dòng `read` nào cả (device-code chỉ dùng curl/sleep),
// nên một bài test lọc theo `read` sẽ luôn thấy mảng rỗng — không có cách nào
// làm nó đỏ. install.sh đã nằm trong PIPED ở bài lint "không được dùng `read`
// từ stdin" phía trên (áp dụng đúng quy tắc này cho mọi script), nên không có
// gì cần khoá thêm ở đây. Không giữ một bài test chỉ có thể pass.

// device_code_login() đọc/ghi $TMP trước cả khi biết token có hợp lệ hay
// không. Reviewer đo được: dời khối `TMP=$(mktemp -d)` + `trap` xuống DƯỚI
// đoạn kiểm tra token (ví dụ khi ai đó "gộp logic liên quan" lại gần nhau) thì
// mọi test tĩnh phía trên vẫn xanh — cả hai đoạn còn nguyên trong file, chỉ
// đổi chỗ — nhưng chạy thật thì chết ngay với "TMP: parameter not set", exit
// 2, không qua die(). Khoá đúng THỨ TỰ, không chỉ sự tồn tại.
test('install.sh: TMP và trap dọn dẹp phải được thiết lập TRƯỚC khi kiểm tra token', () => {
  const src = read('server/public/install.sh');
  const tmpIdx = src.indexOf('TMP=$(mktemp -d)');
  const trapIdx = src.indexOf('trap cleanup EXIT');
  const tokenCheckIdx = src.indexOf('[ -n "$TOKEN" ] || die "Không lấy được token.');
  assert.ok(tmpIdx !== -1, 'không tìm thấy TMP=$(mktemp -d)');
  assert.ok(trapIdx !== -1, 'không tìm thấy trap cleanup EXIT');
  assert.ok(tokenCheckIdx !== -1, 'không tìm thấy đoạn kiểm tra token cuối cùng');
  assert.ok(tmpIdx < tokenCheckIdx && trapIdx < tokenCheckIdx,
    'TMP/trap phải đứng TRƯỚC đoạn kiểm tra token — device_code_login() dùng $TMP, dời preamble xuống dưới làm mọi lần cài không-token chết với "TMP: parameter not set"');
});

// Bài trên chỉ soát HÌNH DẠNG. Bài này chạy THẬT hàm device_code_login (trích
// thẳng từ install.sh) dưới dash — không phải bash, không phải sh trên macOS —
// chống lại một hub giả trả 410, đo thời gian y như bài tương ứng của
// setup-notify.sh ở trên.
function extractInstallShFuncs() {
  const src = read('server/public/install.sh');
  const fnStart = src.indexOf('json_field() {');
  const fnEnd = src.indexOf('\nif [ -z "$TOKEN"');
  assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart,
    'không trích được json_field/device_code_login từ install.sh — vị trí trong file đã đổi?');
  return src.slice(fnStart, fnEnd);
}

// Dùng riêng cho bài Ctrl-C: khác extractInstallShFuncs() ở trên, bài đó CHỦ Ý
// bỏ qua trap thật và hand-write một bản riêng, vì nó không kiểm trap. Bài
// Ctrl-C kiểm CHÍNH cái trap, nên nó phải chạy đúng TMP=.../trap thật của
// install.sh — nếu không, mutate trap trong file thật sẽ không làm bài test
// đỏ, đúng cái lỗ mà reviewer chỉ ra ở chỗ khác trong harness này.
function extractInstallShPreambleAndFuncs() {
  const src = read('server/public/install.sh');
  const start = src.indexOf('TMP=$(mktemp -d)');
  const end = src.indexOf('\nif [ -z "$TOKEN"');
  assert.ok(start !== -1 && end !== -1 && end > start,
    'không trích được preamble (TMP/trap) + json_field/device_code_login từ install.sh — vị trí trong file đã đổi?');
  return src.slice(start, end);
}

function runInstallShDeviceCodeLogin(script) {
  const child = spawn('dash', ['-c', script]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('install.sh: device_code_login THẬT SỰ dừng ngay khi hub trả 410, chạy dưới dash thật', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const funcs = extractInstallShFuncs();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 30, interval: 1,
      }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(410, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'expired' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -eu
say() { :; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
${funcs}
HUB="http://127.0.0.1:${port}"
if device_code_login; then
  echo "RC=0"
else
  echo "RC=$?"
fi
`;
  const startedAt = Date.now();
  const { code, signal, stdout, stderr } = await runInstallShDeviceCodeLogin(script);
  const elapsedMs = Date.now() - startedAt;
  server.close();

  assert.ok(!signal, `bị kill bởi timeout (signal=${signal}) — 410 không dừng vòng lặp. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `dash -c bọc ngoài phải thoát 0. stdout=${stdout} stderr=${stderr}`);
  // Neo cả hai đầu dòng: không neo thì /RC=1/ cũng khớp "RC=127" — thứ dash in
  // ra khi device_code_login KHÔNG TỒN TẠI (vd. install.sh bị sắp lại khiến
  // đoạn trích chỉ còn json_field, không còn device_code_login). Bài test khi
  // đó xanh dù hàm cần kiểm chưa từng chạy.
  assert.match(stdout, /^RC=1$/m, `device_code_login phải trả 1 khi hub trả 410. stdout=${stdout} stderr=${stderr}`);
  assert.ok(elapsedMs < 8000,
    `mất ${elapsedMs}ms — nếu 410 không dừng vòng lặp, test này phải đợi gần hết ttl=30s. stdout=${stdout} stderr=${stderr}`);
});

test('install.sh: device_code_login THẬT SỰ lấy được token khi hub duyệt, chạy dưới dash thật', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const funcs = extractInstallShFuncs();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 30, interval: 1,
      }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: 'tok-from-device-code', displayName: 'huy' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -eu
say() { printf '%s\\n' "$*"; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
${funcs}
HUB="http://127.0.0.1:${port}"
if device_code_login; then TOKEN="$DEVICE_TOKEN"; echo "RC=0"; else echo "RC=$?"; fi
echo "TOKEN=${'$'}{TOKEN:-}"
`;
  const { code, signal, stdout, stderr } = await runInstallShDeviceCodeLogin(script);
  server.close();

  assert.ok(!signal, `bị kill bởi timeout. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /RC=0/, `stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /TOKEN=tok-from-device-code/,
    `TOKEN phải được gán từ DEVICE_TOKEN đúng như install.sh thật làm. stdout=${stdout}`);
  assert.match(stdout, /Đã nhận token của huy\./, `phải in tên người duyệt. stdout=${stdout}`);
});

// Guard ttl/interval ở trên (case + [ -gt 0 ]) không có bài runtime nào canh —
// bài tĩnh "có luồng device-code..." chỉ khoá 410/428/429, không đụng tới
// mấy dòng case/[ -gt 0 ]. Xoá cả ba guard đó đi, 42/42 bài cũ vẫn xanh; chạy
// dưới dash thật với ttl:"oops" thì "Illegal number: oops", exit 2, xuyên qua
// die() — đúng lớp lỗi mà setup-notify.sh đã từng vá, chưa có coverage ở đây.
// $ttl/$interval không có "local" nên còn sống sau khi hàm return — đọc lại
// được ngay trong script bọc ngoài để khẳng định ĐÚNG giá trị fallback, không
// chỉ "không chết".
test('install.sh: ttl/interval không phải số → rơi về mặc định, không abort giữa chừng (dash thật)', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const funcs = extractInstallShFuncs();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 'oops', interval: 'oops' }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: 'tok-fallback' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -eu
say() { :; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
${funcs}
HUB="http://127.0.0.1:${port}"
if device_code_login; then echo "RC=0"; else echo "RC=$?"; fi
echo "TTL=$ttl"
echo "INTERVAL=$interval"
`;
  const { code, signal, stdout, stderr } = await runInstallShDeviceCodeLogin(script);
  server.close();

  assert.ok(!signal, `bị kill bởi timeout — ttl/interval không phải số làm script treo thay vì rơi về mặc định. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `dash -c bọc ngoài phải thoát 0, không phải "Illegal number"/"unbound variable". stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /^RC=0$/m, `stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /^TTL=600$/m, `ttl không phải số phải rơi về mặc định 600. stdout=${stdout}`);
  assert.match(stdout, /^INTERVAL=5$/m, `interval không phải số phải rơi về mặc định 5. stdout=${stdout}`);
});

// ttl=0/interval=0 lọt qua bộ lọc CHỮ SỐ (case) — chỉ [ -gt 0 ] mới bắt được.
// Xoá riêng hai dòng [ -gt 0 ] (giữ nguyên case), 42/42 bài cũ vẫn xanh; chạy
// thật thì ttl=0 in "chờ duyệt tối đa 0 giây" rồi thoát vòng while ngay lập
// tức — 0 lượt poll, mã hub vừa cấp bị bỏ phí dù còn hạn — và interval=0 biến
// vòng poll thành vòng quay không nghỉ.
test('install.sh: ttl=0/interval=0 → rơi về mặc định, không bỏ qua vòng poll và không quay vòng không nghỉ (dash thật)', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const funcs = extractInstallShFuncs();

  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 0, interval: 0 }));
      return;
    }
    if (req.url === '/api/device/poll') {
      polls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: 'tok-zero' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -eu
say() { :; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
${funcs}
HUB="http://127.0.0.1:${port}"
if device_code_login; then echo "RC=0"; else echo "RC=$?"; fi
echo "TTL=$ttl"
echo "INTERVAL=$interval"
`;
  const { code, signal, stdout, stderr } = await runInstallShDeviceCodeLogin(script);
  server.close();

  assert.ok(!signal, `bị kill bởi timeout. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /^RC=0$/m,
    `ttl=0 phải vẫn poll được ít nhất một lần — nếu không rơi về mặc định, vòng while thoát ngay ở lần kiểm đầu. stdout=${stdout}`);
  assert.match(stdout, /^TTL=600$/m, `ttl=0 phải rơi về mặc định 600, không phải "chờ duyệt tối đa 0 giây". stdout=${stdout}`);
  assert.match(stdout, /^INTERVAL=5$/m, `interval=0 phải rơi về mặc định 5. stdout=${stdout}`);
  assert.ok(polls >= 1 && polls <= 3,
    `poll ${polls} lần — nên đúng 1 (không phải 0 vì ttl=0, không phải hàng nghìn vì interval=0 quay không nghỉ). stdout=${stdout}`);
});

// --- Ctrl-C trong lúc chờ duyệt phải DỪNG script NGAY, không "chạy tiếp" ---
//
// Bug thật (reviewer đo bằng pty thật): `trap 'rm -rf "$TMP"' EXIT INT TERM`
// chỉ dọn $TMP rồi TRẢ ĐIỀU KHIỂN LẠI đúng chỗ vừa bị ngắt — /bin/sh không tự
// exit sau khi chạy xong lệnh trong trap trừ khi chính lệnh đó gọi exit.
// Script sống sót qua 4 lần Ctrl-C liên tiếp và chạy hết ttl; tệ hơn, $TMP đã
// bị xoá trong khi vòng poll còn tiếp tục, nên mọi `curl -o "$TMP/..."` sau
// đó thất bại và mã hub vừa duyệt (dùng một lần) bị bỏ phí.
//
// Bài dưới gửi Ctrl-C THẬT qua một pty (byte 0x03 đi qua line discipline của
// terminal — không phải kill -INT gửi thẳng tín hiệu vào tiến trình, để đúng
// với cách người dùng thật ngắt script) trong lúc device_code_login() đang
// `sleep` giữa hai lượt poll, chống lại một hub không bao giờ duyệt (poll
// luôn 428), rồi đo xem dash có thoát ngay bằng mã quy ước 130 (128+SIGINT)
// không, thay vì sống sót.
//
// spawn() BẤT ĐỒNG BỘ, không phải spawnSync(): hub giả ở dưới chạy TRONG CÙNG
// tiến trình node đang chạy bài test này. spawnSync khoá cứng event loop của
// chính process đó trong lúc chờ — thấy lại đúng cái bẫy đã ghi ở
// runDeviceCodeLogin() phía trên cho setup-notify.sh — nên request đầu tiên
// (POST /api/device/start) treo mãi không ai trả lời, curl bị Ctrl-C giết
// giữa chừng, device_code_login return 1 vì lý do hoàn toàn khác, và bài test
// xanh dù không hề đo được thứ nó tưởng đang đo (bắt được bằng cách chạy thử
// với spawnSync trước khi đổi sang spawn — assert 130 thất bại, elapsed quá
// nhanh, không có network round-trip thật).
function runInstallShCtrlCViaPty(script) {
  const py = `
import pty, os, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('dash', ['dash', '-c', sys.argv[1]])
else:
    time.sleep(0.6)
    os.write(fd, b'\\x03')
    start = time.time()
    deadline = start + 5
    while time.time() < deadline:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            elapsed = time.time() - start
            if os.WIFEXITED(status):
                print(f"PTYRESULT exited code={os.WEXITSTATUS(status)} elapsed={elapsed:.2f}")
            elif os.WIFSIGNALED(status):
                print(f"PTYRESULT killed signal={os.WTERMSIG(status)} elapsed={elapsed:.2f}")
            sys.exit(0)
        time.sleep(0.05)
    print("PTYRESULT survived elapsed=5.00+")
    os.kill(pid, 9)
    os.waitpid(pid, 0)
`;
  const child = spawn('python3', ['-c', py, script]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('install.sh: Ctrl-C THẬT (qua pty) trong lúc chờ duyệt phải dừng script ngay, không sống sót tới hết ttl', async (t) => {
  if (!HAS_DASH || !HAS_PYTHON3) { t.skip('cần cả dash và python3 để dựng pty thật'); return; }
  // Trích CẢ preamble (TMP=.../trap) THẬT từ install.sh — không hand-write lại
  // như extractInstallShFuncs() ở các bài khác. Bài này kiểm chính cái trap;
  // hand-write một bản trap riêng ở đây sẽ khiến test không bao giờ thấy được
  // một cú mutate trap trong file thật (verified: xoá `exit 130`/`exit 143`
  // khỏi install.sh mà không đổi bản hand-write thì test vẫn xanh).
  const block = extractInstallShPreambleAndFuncs();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 30, interval: 2 }));
      return;
    }
    if (req.url === '/api/device/poll') {
      res.writeHead(428, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const script = `
set -eu
say() { :; }
${block}
HUB="http://127.0.0.1:${port}"
if device_code_login; then echo "RC=0"; else echo "RC=$?"; fi
`;
  const { code, signal, stdout, stderr } = await runInstallShCtrlCViaPty(script);
  server.close();

  assert.ok(!signal, `python3 harness bị kill bởi timeout — pty không thoát trong 15s. stdout=${stdout} stderr=${stderr}`);
  assert.equal(code, 0, `python3 harness tự nó phải thoát 0. stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /PTYRESULT exited code=130/,
    `Ctrl-C phải khiến dash thoát mã 130 (128+SIGINT) NGAY LẬP TỨC, không "survived" tới hết ttl. stdout=${stdout} stderr=${stderr}`);
});

test('deploy.sh dùng tên file tạm riêng cho users.json, không đụng tên của hub', () => {
  const src = read('deploy.sh');
  assert.doesNotMatch(src, /f \+ "\.tmp"/,
    'tên tạm cố định ".tmp" là tên hub cũng dùng — hai tiến trình ghi đè lên nhau trong chính file tạm');
  const uses = src.match(/f \+ "\.tmp\." \+ process\.pid/g) || [];
  assert.equal(uses.length, 2, 'cả adduser lẫn deluser đều phải có tên tạm riêng');
});

// --- deploy.sh phải tự đóng cặp trust-proxy / bind ---------------------------
//
// Khi có CCRC_TUNNEL_TOKEN, chính script chọn `--profile cloudflare`: đó là
// lúc nó BIẾT CHẮC có proxy đứng trước. Không ghi CCRC_TRUST_PROXY=1 thì mọi
// request mang địa chỉ container cloudflared, cả team dùng chung MỘT rổ
// rate-limit của /api/device/start, và người thứ 6 chạy ./setup-notify.sh
// trong 10 phút ăn 429 rồi âm thầm rơi về dán token tay. Không ghi kèm
// CCRC_BIND=127.0.0.1 thì cổng 8720 vẫn publish ra 0.0.0.0 (compose làm thế ở
// MỌI profile) và đường đi thẳng đó biến CCRC_TRUST_PROXY=1 thành lỗ hổng.
// Hai biến này chỉ đúng khi đi CÙNG NHAU.
//
// Chạy script thật trong một thư mục tạm — deploy.sh `cd "$(dirname "$0")"`
// nên bản sao chỉ đụng .env của chính nó, không đụng .env của repo.
function runDeployInSandbox(envContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-deploy-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fakebin-'));
  try {
    fs.copyFileSync(path.join(root, 'deploy.sh'), path.join(dir, 'deploy.sh'));
    fs.chmodSync(path.join(dir, 'deploy.sh'), 0o755);
    fs.writeFileSync(path.join(dir, '.env'), envContent);
    // `docker compose version` phải qua để script đi tiếp; mọi lời gọi khác
    // (tức `up -d --build`) hỏng — chuẩn bị .env đã xong trước đó rồi.
    fs.writeFileSync(path.join(bin, 'docker'),
      '#!/bin/sh\n[ "$1" = compose ] && [ "$2" = version ] && exit 0\nexit 1\n');
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    spawnSync('bash', [path.join(dir, 'deploy.sh'), 'deploy'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return fs.readFileSync(path.join(dir, '.env'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test('deploy.sh có tunnel token thì tự ghi CẢ CẶP CCRC_TRUST_PROXY=1 và CCRC_BIND=127.0.0.1', () => {
  const env = runDeployInSandbox('CCRC_TOKEN=abc123\nCCRC_TUNNEL_TOKEN=eyJgia\n');
  assert.match(env, /^CCRC_TRUST_PROXY=1$/m,
    'biết chắc có cloudflared mà không bật thì cả internet chung một rổ rate-limit');
  assert.match(env, /^CCRC_BIND=127\.0\.0\.1$/m,
    'trust proxy mà cổng vẫn mở ra 0.0.0.0 là mở lại đúng cái lỗ nó sinh ra để bịt');
});

test('deploy.sh KHÔNG ghi hai biến đó khi không có tunnel token', () => {
  const env = runDeployInSandbox('CCRC_TOKEN=abc123\nCCRC_TUNNEL_TOKEN=\n');
  assert.doesNotMatch(env, /^CCRC_TRUST_PROXY=1$/m,
    'không có proxy mà bật trust proxy là tự cho client bịa X-Forwarded-For');
  assert.doesNotMatch(env, /^CCRC_BIND=/m,
    'không tunnel thì hub được với tới thẳng — đóng về localhost là phá cài đặt LAN/tailnet');
});

test('deploy.sh KHÔNG ghi đè giá trị người vận hành đã tự đặt', () => {
  const env = runDeployInSandbox(
    'CCRC_TOKEN=abc123\nCCRC_TUNNEL_TOKEN=eyJgia\nCCRC_TRUST_PROXY=\nCCRC_BIND=10.0.0.5\n');
  assert.doesNotMatch(env, /^CCRC_TRUST_PROXY=1$/m,
    'đặt rỗng là cố ý TẮT — script không được cãi lại người vận hành');
  assert.match(env, /^CCRC_BIND=10\.0\.0\.5$/m);
  assert.equal((env.match(/^CCRC_BIND=/gm) || []).length, 1, 'không được thêm dòng thứ hai');
});

test('deploy.sh có deluser và nó KHÔNG đoán khi khớp nhiều người', () => {
  const src = read('deploy.sh');
  assert.match(src, /cmd_deluser/);
  assert.match(src, /deluser\)/, 'phải có nhánh dispatch, không thì lệnh không gọi được');
  assert.match(src, /removeUser/, 'dùng lại luật trong users.js chứ không viết lại trong shell');
  assert.match(src, /matches\.length > 1/,
    'xoá nhầm người là mất push subs, lịch sử và phiên đang mở của họ');
});

// --- cài lại trên máy ĐÃ cài: đừng bắt đăng nhập lại ------------------------
//
// install.sh ghi ra ~/.ccrc/config (hub + token) và KHÔNG xoá nó khi cài lại —
// `rm -rf "$DEST"` chỉ đụng thư mục code. Nhưng nó lại không đọc lại file đó,
// nên máy đã cài vẫn bị hỏi mã ngắn từ đầu, và người dùng còn phải gõ tay cả
// CCRC_HUB_URL. Huy nêu 2026-08-17: ghép nối chỉ nên cần ở lần đầu.
//
// Lưu ý cái KHÔNG mất: ~/.ccrc/devices.json (khoá công khai của điện thoại đã
// ghép) nằm ngoài $DEST nên vẫn nguyên — thứ phải làm lại chỉ là đăng nhập.

test('install.sh đọc lại hub và token đã lưu, nhưng SAU tham số và biến môi trường', () => {
  const src = read('server/public/install.sh');
  assert.match(src, /TOKEN="\$\{1:-\$\{CCRC_TOKEN:-\}\}"/,
    'thứ tự ưu tiên cũ không được đổi — admin truyền token tay vẫn phải thắng');
  assert.match(src, /\.ccrc\/config/,
    'phải đọc lại config đã lưu, nếu không máy đã cài vẫn bị hỏi mã ngắn mỗi lần');
  // Token cũ có thể đã bị thu hồi. Tin bừa thì cài xong mới hỏng, im lặng —
  // đúng kiểu hỏng mà cả nhánh này đang đi dẹp.
  assert.match(src, /api\/me/,
    'token lấy từ config phải được kiểm còn dùng được trước khi tin');
  // Hub cũng lấy từ config khi thiếu — đó là thứ làm lệnh cài lại ngắn lại
  // còn `curl … | sh`. Kiểm tĩnh vì bản private có hub mặc định viết cứng, nên
  // nhánh này không chạy tới ở đây; bản public (không có mặc định) mới dùng.
  assert.match(src, /\[ -n "\$HUB" \] \|\| HUB="\$CFG_HUB"/,
    'thiếu hub thì phải lấy từ config đã lưu');
});

test('install.sh: token đã lưu còn dùng được thì KHÔNG hỏi mã ngắn, chạy dưới dash thật', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const goiDeviceStart = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/device/start') goiDeviceStart.push(1);
    if (req.url === '/api/me') {
      res.writeHead(req.headers.authorization === 'Bearer token-cu-con-song' ? 200 : 401,
        { 'content-type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  fs.mkdirSync(path.join(home, '.ccrc'));
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=token-cu-con-song\nCCRC_MACHINE_NAME=may\n`);

  const { stdout } = await chayInstallToiBuocToken(home, port);
  server.close();
  fs.rmSync(home, { recursive: true, force: true });

  assert.match(stdout, /TOKEN=token-cu-con-song/, `phải dùng lại token đã lưu. stdout=${stdout}`);
  assert.deepEqual(goiDeviceStart, [], 'không được hỏi mã ngắn khi token cũ còn dùng được');
});

test('install.sh: token đã lưu bị thu hồi thì QUAY VỀ mã ngắn', async (t) => {
  if (!HAS_DASH) { t.skip('không có dash trên máy này'); return; }
  const goiDeviceStart = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/me') { res.writeHead(401).end('{}'); return; }
    if (req.url === '/api/device/start') {
      goiDeviceStart.push(1);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, deviceCode: 'd'.repeat(32), userCode: 'AB12', ttl: 1, interval: 1 }));
    }
    if (req.url === '/api/device/poll') { res.writeHead(410).end('{}'); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  fs.mkdirSync(path.join(home, '.ccrc'));
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=http://127.0.0.1:${port}\nCCRC_TOKEN=token-da-bi-thu-hoi\n`);

  const { stdout } = await chayInstallToiBuocToken(home, port);
  server.close();
  fs.rmSync(home, { recursive: true, force: true });

  assert.doesNotMatch(stdout, /TOKEN=token-da-bi-thu-hoi/,
    'token chết mà vẫn dùng thì cài xong mới hỏng, và hỏng im lặng');
  assert.equal(goiDeviceStart.length, 1, 'phải quay về hỏi mã ngắn');
});

// Chạy phần ĐẦU của install.sh — từ dòng HUB/TOKEN tới ngay trước khi nó bắt
// đầu tải gói cài — rồi in TOKEN ra. Cắt ở đó vì phần sau `rm -rf "$DEST"` và
// gọi setup-notify.sh, những thứ không thuộc bài này.
function chayInstallToiBuocToken(home, port) {
  const src = read('server/public/install.sh');
  const end = src.indexOf('say "== CC Remote Control');
  assert.ok(end !== -1, 'không tìm được mốc cắt trong install.sh — cấu trúc file đã đổi?');
  const phanDau = src.slice(0, end);
  return new Promise((resolve) => {
    // CCRC_HUB_URL trỏ thẳng stub: bản private có hub mặc định viết cứng, nên
    // để trống là script đi gọi hub THẬT trên internet — đo được, và nó làm
    // bài test này xanh/đỏ vì một lý do chẳng liên quan gì tới thứ đang kiểm.
    const env = { ...process.env, HOME: home, CCRC_HUB_URL: `http://127.0.0.1:${port}` };
    delete env.CCRC_TOKEN;
    const child = spawn('dash', ['-c', `${phanDau}\necho "TOKEN=$TOKEN"\necho "HUB=$HUB"`], { env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const treo = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', () => { clearTimeout(treo); resolve({ stdout, stderr }); });
  });
}
