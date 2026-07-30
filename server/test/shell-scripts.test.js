// Static checks on the shell scripts, because the one-command installer runs
// on somebody else's laptop where a syntax slip is not a red test — it is a
// half-installed machine and a message they cannot act on.
//
// The first check exists because of a real failure. `say "Bung vào $DEST…"`
// died with `DEST\xe2: unbound variable`: the `…` follows the expansion
// directly, and with `set -u` under /bin/sh the shell read those UTF-8 bytes
// as part of the variable NAME. Every user-facing string here is Vietnamese,
// so this is one careless space away from happening again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SH_SCRIPTS = ['server/public/install.sh', 'server/public/uninstall.sh', 'deploy/ccrc'];
const BASH_SCRIPTS = ['setup-notify.sh', 'remove-notify.sh', 'deploy.sh'];
const ALL = [...SH_SCRIPTS, ...BASH_SCRIPTS];

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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
