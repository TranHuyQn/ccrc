import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  tmuxBin, currentPane, paneAlive, paneSession, capturePane, snapshotPane,
  createGroupSession, killGroupSession, hasSession,
  isOurGroupSession, claimGroupName, reclaimPaneSession, GROUP_MARKER_OPTION,
  paneCwd, listPanes,
  makeRunId, isReclaimableMarker,
} from '../src/tmux.js';

const T = tmuxBin();
const tmux = (...args) => execFileSync(T, args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A run id whose creating process is provably GONE — exactly what a daemon
// that crashed or was SIGKILLed leaves stamped on the group it abandoned.
// spawnSync waits for the child to exit, so its pid is dead by the time we
// read it; the loop only re-rolls in the rare case the OS handed that number
// straight back out to somebody else.
function deadRunId() {
  for (let i = 0; i < 20; i++) {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    if (!pid) continue;
    try { process.kill(pid, 0); } catch { return `${pid}-cheroi`; }
  }
  throw new Error('không dựng được run id của một tiến trình đã chết');
}

// A run id belonging to a process that is unquestionably alive: this one.
function liveRunId(tag) {
  return `${process.pid}-${tag}`;
}

function withSession(fn) {
  const s = `ccrc-t-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  try { return fn(s); } finally {
    try { execFileSync(T, ['kill-session', '-t', s]); } catch {}
  }
}

test('tmuxBin trả về đường dẫn chạy được', () => {
  assert.ok(tmuxBin().length > 0);
  assert.match(execFileSync(tmuxBin(), ['-V'], { encoding: 'utf8' }), /^tmux /);
});

test('currentPane đọc từ TMUX_PANE', () => {
  assert.equal(currentPane({ TMUX_PANE: '%7' }), '%7');
  assert.equal(currentPane({}), null);
  assert.equal(currentPane({ TMUX_PANE: '' }), null);
});

test('paneAlive đúng với pane đang sống', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    assert.equal(paneAlive(pane), true);
  });
});

test('paneAlive FALSE với pane đã chết — cái bẫy exit 0 output rỗng', () => {
  // Cái bẫy thật chỉ lộ ra khi tmux SERVER còn sống sau khi phiên đích bị
  // huỷ: lúc đó `display-message -t <pane chết>` thoát mã 0 kèm output rỗng.
  // Nếu đây là phiên tmux DUY NHẤT, huỷ nó làm cả server tắt luôn, và
  // `display-message` sẽ thoát mã 1 ("no server running") — che mất đúng cái
  // bẫy mà test này được đặt tên để bắt. Nên phải giữ một phiên khác sống.
  const keep = `ccrc-t-keep-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', keep, '-x', '80', '-y', '24']);
  try {
    let pane;
    withSession((s) => { pane = tmux('display-message', '-p', '-t', s, '#{pane_id}'); });
    // phiên đích đã bị huỷ ở đây, nhưng server vẫn sống nhờ `keep`
    assert.equal(paneAlive(pane), false, 'pane chết mà báo sống là lỗi đã từng mất cả ngày');
  } finally {
    try { execFileSync(T, ['kill-session', '-t', keep]); } catch {}
  }
});

test('paneAlive FALSE với id bịa', () => {
  assert.equal(paneAlive('%999999'), false);
  assert.equal(paneAlive('khong-phai-id'), false);
  assert.equal(paneAlive(''), false);
});

test('paneSession trả tên phiên chứa pane', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    assert.equal(paneSession(pane), s);
  });
});

test('capturePane lấy được nội dung đang hiển thị', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    execFileSync(T, ['send-keys', '-t', pane, 'echo CCRC_HELLO_MARKER', 'Enter']);
    execFileSync(T, ['run-shell', 'sleep 0.5']);
    assert.match(capturePane(pane), /CCRC_HELLO_MARKER/);
  });
});

// --- Task 7 fix round: nghiệm thu trình duyệt tìm ra hai lỗi ở đường gửi ---
// snapshot ban đầu (docs/superpowers/specs/2026-07-27-nghiem-thu-trinh-duyet.md).
// capture-pane trả về ĐÚNG CHIỀU CAO PANE (đo được 50 dòng khi trình duyệt
// chỉ có 39) — ghi thẳng vào terminal ngắn hơn cuộn mất đúng phần có nội
// dung. Dựng lại đúng hình dạng đó: pane cao (50), nội dung chỉ nằm ở vài
// dòng đầu, phần còn lại gần như trống — đúng như log thật mô tả.

function tallPaneWithMarkerNearTop(fn) {
  const s = `ccrc-t-tall-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '50']);
  try {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    execFileSync(T, ['send-keys', '-t', pane, 'echo CCRC_SNAP_MARKER', 'Enter']);
    execFileSync(T, ['run-shell', 'sleep 0.5']);
    return fn(pane);
  } finally {
    try { execFileSync(T, ['kill-session', '-t', s]); } catch {}
  }
}

test('snapshotPane cắt dòng trống thừa ở cuối — nội dung không bị đẩy khỏi terminal ngắn hơn pane', () => {
  tallPaneWithMarkerNearTop((pane) => {
    const raw = capturePane(pane);
    // capture-pane's output ends with a trailing '\n', so split('\n') yields
    // one more element (a trailing '') than the pane's 50 actual rows.
    const rawLines = raw.split('\n').length;
    assert.equal(rawLines, 51, 'điều kiện đầu vào: pane test phải cao đúng 50 dòng (51 phần tử sau split, do \\n cuối), giống log thật');

    const snap = snapshotPane(pane);
    const snapLines = snap.split('\n');
    assert.ok(snapLines.length < 39,
      `snapshot đã cắt phải ngắn hơn 39 dòng (chiều cao terminal trình duyệt trong log thật) — thấy ${snapLines.length} dòng, vẫn sẽ cuộn mất nội dung`);

    const markerLineIdx = snapLines.findIndex((l) => l.includes('CCRC_SNAP_MARKER'));
    assert.ok(markerLineIdx >= 0, 'marker phải còn trong snapshot đã cắt');
    assert.ok(markerLineIdx < 5,
      `marker phải nằm gần đầu snapshot đã cắt (thấy ở dòng ${markerLineIdx}) — nằm gần cuối vẫn cuộn mất khi ghi vào terminal ngắn`);
  });
});

test('snapshotPane mở đầu bằng xoá màn hình + đưa con trỏ về đầu', () => {
  tallPaneWithMarkerNearTop((pane) => {
    const snap = snapshotPane(pane);
    assert.ok(snap.startsWith('\x1b[2J\x1b[H'),
      'snapshot phải mở đầu bằng ESC[2J ESC[H, để không vẽ chồng lên bất cứ gì đã có trong buffer terminal trình duyệt');
  });
});

test('snapshotPane kết thúc bằng reset SGR — không rò màu nền ra output sau đó', () => {
  tallPaneWithMarkerNearTop((pane) => {
    const snap = snapshotPane(pane);
    assert.ok(snap.endsWith('\x1b[0m'),
      'snapshot phải kết thúc bằng ESC[0m — thiếu nó thì màu/nền cuối cùng của capture-pane (vd nền trắng của thanh trạng thái tmux) sẽ rò ra mọi dòng ghi sau, đúng dải xám thấy trong ảnh chụp nghiệm thu');
  });
});

test('snapshotPane trả rỗng khi capturePane thất bại (không tự bịa ra khung bao quanh nội dung rỗng)', () => {
  assert.equal(snapshotPane('%khong-ton-tai-999999'), '');
});

// --- Task 7 fix round 3: '\r\n' thay vì '\n' khi nối các dòng snapshot -----
//
// A previous attempt at this same fix wrote a test that asserted the right
// PROPERTY (every line starts at column 0) but against the wrong fixture:
// tallPaneWithMarkerNearTop's captured content, after trailing-blank
// trimming, collapses to a SINGLE line — zero '\n' separators — so a test
// about how lines are JOINED cannot fail no matter how they are joined.
// This needs a fixture with genuinely distinct, multi-line output. Rather
// than touch tallPaneWithMarkerNearTop (which 'snapshotPane cắt dòng trống
// thừa ở cuối…' above asserts exact line counts and marker position
// against), this is a separate, purpose-built fixture.

const stripAnsi = (s) => s.replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, '');

// The index (within capturePane's raw, pre-join lines) of the row whose
// content is EXACTLY `marker` — not merely containing it. A plain substring
// search is not safe here: send-keys places the LITERAL, not-yet-executed
// command text onto the pane immediately (before Enter is even processed),
// and that text contains the exact same marker substring as one of its own
// arguments. Exact-match after stripping SGR codes picks out only the real
// OUTPUT row, never the still-unexecuted (or just-echoed) command line it is
// embedded in.
function rowIndexOf(rawLines, marker) {
  return rawLines.findIndex((l) => stripAnsi(l).trimEnd() === marker);
}

async function multiLinePane(fn) {
  const s = `ccrc-t-multi-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  try {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    // Three markers of DIFFERENT lengths, on three distinct rows via printf's
    // own '\n' (which the pty turns into real new rows in the pane, so the
    // fixture's raw rows are already correctly separated — the bug under
    // test is not in how this fixture is drawn, it's in how snapshotPane
    // re-joins the rows it later reads back out).
    execFileSync(T, ['send-keys', '-t', pane,
      "printf 'CCRC_L1_AAAAAAAAAA\\nCCRC_L2_BB\\nCCRC_L3_CCCC\\n'", 'Enter']);
    // Poll rather than a fixed sleep — this shell can take well over a
    // second to actually start accepting/running input (seen locally). Must
    // check for the marker as an EXACT row (rowIndexOf), not a substring
    // (.includes): the unexecuted command text sitting on the prompt line
    // ALSO contains the marker substring the instant send-keys places it,
    // long before Enter is processed, so `.includes` would report "done"
    // immediately and never actually wait for real execution.
    const deadline = Date.now() + 8000;
    for (;;) {
      if (rowIndexOf(capturePane(pane).split('\n'), 'CCRC_L3_CCCC') >= 0) break;
      if (Date.now() > deadline) throw new Error('multiLinePane: hết giờ chờ lệnh printf chạy xong');
      await sleep(100);
    }
    return fn(pane);
  } finally {
    try { execFileSync(T, ['kill-session', '-t', s]); } catch {}
  }
}

// Replays a snapshotPane() string the way a REAL terminal (the browser's
// xterm.js) would interpret it, tracking only cursor row/column: '\r' resets
// the column to 0, '\n' moves to the next row WITHOUT touching the column
// (real terminal semantics — this is exactly the behaviour that makes a bare
// '\n' join produce a staircase), CSI escape sequences are consumed without
// producing visible characters (ESC[H additionally re-homes the cursor, the
// same way the leading clear-screen in snapshotPane does), and any other
// character is written at the current cursor position and advances the
// column by one. This tests the OBSERVABLE PROPERTY — where does content end
// up on a downstream terminal — rather than grepping the string for '\r\n',
// so a future rewrite that fixes the bug some other way still passes, and
// one that reintroduces it under a different disguise still fails.
function replayOntoGrid(text) {
  const rows = [[]];
  let row = 0;
  let col = 0;
  let i = 0;
  // Pads a row with explicit spaces up to `col` before a write. This matters
  // more than it looks: without it, jumping straight to column 18 on a
  // brand-new row (which is exactly what the bug under test does) leaves
  // columns 0..17 as unset ARRAY HOLES, and Array.prototype.join('') treats
  // holes as empty string — i.e. it silently COMPACTS them away, so the
  // written character would end up looking like it's at index 0 after all.
  // That defeats the entire test (this was caught by the mutation check
  // below going green when it should have gone red — see task report).
  const padTo = (arr, upTo) => { while (arr.length < upTo) arr.push(' '); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b') {
      // General CSI matcher: ESC '[' then parameter bytes (0-9 : ; < = > ?),
      // then intermediate bytes (space through '/'), then one final byte
      // ('@' through '~'). Real captures from an interactive zsh session
      // include private-mode toggles like bracketed-paste (ESC[?2004l) that
      // a plain [0-9;]* pattern does NOT match — under-matching here would
      // leak the sequence's own characters into the grid as if they were
      // visible text, silently corrupting the very columns this test reads.
      const m = /^\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (m) {
        if (m[0] === '\x1b[H') { row = 0; col = 0; }
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '\r') { col = 0; i += 1; continue; }
    if (ch === '\n') { row += 1; while (rows.length <= row) rows.push([]); i += 1; continue; }
    while (rows.length <= row) rows.push([]);
    padTo(rows[row], col);
    rows[row][col] = ch;
    col += 1;
    i += 1;
  }
  return rows.map((r) => r.join(''));
}

test('snapshotPane: mỗi dòng nội dung bắt đầu ở cột 0 khi phát lại trên một terminal khác (không xếp bậc thang)', async () => {
  await multiLinePane((pane) => {
    const raw = capturePane(pane);
    const rawLines = raw.split('\n');

    // Locate the three OUTPUT rows by exact content, not substring search —
    // see rowIndexOf's comment: the echoed command line above them contains
    // the same marker text as a literal argument, which a plain `.includes`
    // would happily (and wrongly) match instead.
    const row1 = rowIndexOf(rawLines, 'CCRC_L1_AAAAAAAAAA');
    const row2 = rowIndexOf(rawLines, 'CCRC_L2_BB');
    const row3 = rowIndexOf(rawLines, 'CCRC_L3_CCCC');
    assert.ok(row1 >= 0 && row2 >= 0 && row3 >= 0,
      `điều kiện đầu vào: cả 3 dòng kết quả phải có mặt nguyên vẹn trong capture-pane thô — thấy chỉ số dòng ${row1}, ${row2}, ${row3}`);
    assert.ok(row1 < row2 && row2 < row3, 'điều kiện đầu vào: 3 dòng kết quả phải theo đúng thứ tự, trên 3 dòng riêng biệt');

    // snapshotPane trims trailing blank rows but never reorders or drops
    // rows before the trim point, so lines[N] in snapshotPane's own join
    // (see src/tmux.js) is the exact same logical row as rawLines[N] here —
    // row1/row2/row3 index straight into the replayed grid below too.
    const snap = snapshotPane(pane);
    const grid = replayOntoGrid(snap);

    // The staircase bug this guards against: joining raw capture-pane rows
    // with a bare '\n' means each row starts wherever the PREVIOUS row's
    // content ended, not at column 0. L1 is 19 chars long, so under the bug
    // L2 would land at column 19, and L3 — after L2's own 10 chars — even
    // further right still. A correct join resets every row to column 0
    // regardless of how long its predecessor was.
    assert.equal(grid[row1]?.indexOf('CCRC_L1_AAAAAAAAAA'), 0, `dòng 1 phải bắt đầu ở cột 0, thấy: ${JSON.stringify(grid[row1])}`);
    assert.equal(grid[row2]?.indexOf('CCRC_L2_BB'), 0, `dòng 2 phải bắt đầu ở cột 0 (không phải ngay sau chỗ dòng 1 kết thúc), thấy: ${JSON.stringify(grid[row2])}`);
    assert.equal(grid[row3]?.indexOf('CCRC_L3_CCCC'), 0, `dòng 3 phải bắt đầu ở cột 0, thấy: ${JSON.stringify(grid[row3])}`);
  });
});

// --- Task 5, REVERSED: phiên nhóm — điện thoại quyết định kích cỡ --------
//
// tmux gives a shared window exactly ONE size — there is no way for the
// phone and the desktop to each see their own. The original fix here pinned
// `window-size` to `largest`, so the window followed the widest attached
// client (the Mac). Verified on a real phone: the window stayed at the
// Mac's ~200 columns, so the phone received lines five times wider than its
// screen — wrapped, overlapping, unreadable. The user hit that and chose
// the other trade-off: `window-size` is now `smallest`, so the window
// follows the NARROWEST attached client — the phone, whenever one is
// attached — and returns to the desktop's own size the instant the phone
// disconnects (tmux recalculates window size on every client attach/detach;
// measured directly below, no explicit desktop-side refresh needed). The
// desktop is unattended while the phone is in use, so a temporarily
// narrower Mac terminal is a cost nobody is looking at; a permanently mushy
// phone screen was a cost someone was always looking at.

const window_size = (target) => tmux('display-message', '-p', '-t', target, '#{window_width}x#{window_height}');

test('điện thoại (phiên nhóm) làm co phiên gốc — và phiên gốc trả lại kích cỡ khi điện thoại rời đi', async () => {
  // This reproduces the actual danger, not just Đo 1's version of it: Đo 1
  // (docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md) only ever created
  // the grouped session DETACHED (`-d`, no live client ever attaches to
  // it), which trivially cannot disturb anything — a session with no live
  // client never drives a resize. The real daemon spawns a REAL,
  // live-attached `tmux -C` control client. A live "desktop" client is
  // simulated here too, at the original size, because that is the exact
  // scenario spec §5.5 is about: someone actually sitting in front of their
  // real, live terminal.
  const orig = `ccrc-t-grp-orig-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  const group = `${orig}-ccrc-web`;
  execFileSync(T, ['new-session', '-d', '-s', orig, '-x', '200', '-y', '50']);
  let desktop, phone;
  try {
    createGroupSession(orig, group);

    desktop = spawn(T, ['-C', 'attach-session', '-t', orig], { stdio: ['pipe', 'pipe', 'ignore'] });
    await sleep(400);
    desktop.stdin.write('refresh-client -C 200x50\n');
    await sleep(400);
    assert.equal(window_size(orig), '200x50', 'điều kiện đầu vào: client desktop thật phải đang xem ở 200x50');

    phone = spawn(T, ['-C', 'attach-session', '-t', group], { stdio: ['pipe', 'pipe', 'ignore'] });
    await sleep(400);
    phone.stdin.write('refresh-client -C 40x30\n');
    await sleep(700);

    assert.equal(window_size(orig), '40x30',
      'với window-size=smallest, cửa sổ CHIA SẺ phải theo client điện thoại (40x30) — đây là đánh đổi Huy đã chọn: điện thoại quyết định kích cỡ, không phải máy tính');

    // The phone disconnects — this is the READABILITY half of the trade:
    // the desktop's real, live terminal must get its columns back on its
    // own, with no action required from the person sitting at it.
    phone.kill('SIGKILL');
    phone = null;
    await sleep(700); // để tmux -C thoát hẳn — xem ghi chú ở helpers.mjs

    assert.equal(window_size(orig), '200x50',
      'sau khi điện thoại rời đi, phiên gốc phải TỰ trả lại kích cỡ 200x50 của client desktop thật, không cần desktop tự resize lại');
  } finally {
    try { desktop?.kill('SIGKILL'); } catch {}
    try { phone?.kill('SIGKILL'); } catch {}
    await sleep(200); // để tmux -C thoát hẳn trước khi kill-session — xem ghi chú ở helpers.mjs
    try { execFileSync(T, ['kill-session', '-t', group]); } catch {}
    try { execFileSync(T, ['kill-session', '-t', orig]); } catch {}
  }
});

test('createGroupSession đặt window-size=smallest và aggressive-resize=on', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    try {
      createGroupSession(s, group);
      assert.equal(tmux('show-options', '-t', group, 'window-size'), 'window-size smallest',
        'window-size=smallest là quyết định đã đảo ngược: điện thoại (client nhỏ nhất) quyết định kích cỡ cửa sổ chia sẻ — xem ghi chú trong tmux.js');
      assert.equal(tmux('show-window-options', '-t', group, 'aggressive-resize'), 'aggressive-resize on');
    } finally {
      try { execFileSync(T, ['kill-session', '-t', group]); } catch {}
    }
  });
});

test('phiên nhóm bị dọn khi client rời đi', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    createGroupSession(s, group);
    assert.equal(hasSession(group), true, 'phải tạo được phiên nhóm');
    killGroupSession(group);
    assert.equal(hasSession(group), false, 'phiên nhóm phải bị dọn khi client cuối rời đi');
    assert.equal(hasSession(s), true, 'phiên gốc không được đụng tới khi dọn phiên nhóm');
    assert.equal(paneAlive(currentPaneOf(s)), true, 'pane trong phiên gốc phải vẫn sống sau khi dọn phiên nhóm');
  });
});

test('killGroupSession dọn hai lần vẫn an toàn, không ném lỗi', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    createGroupSession(s, group);
    killGroupSession(group);
    assert.doesNotThrow(() => killGroupSession(group), 'dọn phiên nhóm đã dọn rồi phải là no-op, không phải lỗi');
    assert.doesNotThrow(() => killGroupSession('ccrc-t-khong-ton-tai-luon'), 'dọn phiên nhóm chưa từng tồn tại phải là no-op');
  });
});

function currentPaneOf(sessionName) {
  return tmux('display-message', '-p', '-t', sessionName, '#{pane_id}');
}

// --- Critical: nhận diện phiên nhóm bằng DẤU, không bao giờ bằng hình dạng ---
// --- của cái tên. Xem GROUP_MARKER_OPTION trong src/tmux.js. ----------------
//
// The defect these cover: an earlier fix recovered the "original" session by
// stripping a trailing `-ccrc-web` off any name, then killed the derived
// name before creating. For a user whose REAL session is called
// `myproj-ccrc-web` the derived name came back out as their own session, and
// it was killed — taking the whole tmux server down with it when it was the
// last session. Everything below exists so that no string can ever again be
// mistaken for a licence to destroy.

// A session created by tmux directly, never through createGroupSession, so
// it carries no marker — i.e. exactly what a bystander session of the user's
// looks like, whatever its name.
function withPlainSession(name, fn) {
  execFileSync(T, ['new-session', '-d', '-s', name, '-x', '80', '-y', '24']);
  try { return fn(name); } finally {
    try { execFileSync(T, ['kill-session', '-t', `=${name}`]); } catch {}
  }
}

test('killGroupSession KHÔNG giết phiên tên đuôi -ccrc-web mà chúng ta không tạo ra', () => {
  withSession((s) => {
    // The user's own real session, which merely happens to be named this way.
    withPlainSession(`${s}-ccrc-web`, (victim) => {
      assert.equal(isOurGroupSession(victim), false,
        'phiên do người dùng tự tạo KHÔNG được coi là của chúng ta chỉ vì cái tên');
      killGroupSession(victim);
      assert.equal(hasSession(victim), true,
        'phiên người dùng tên đuôi -ccrc-web phải SỐNG SÓT — đây chính là lỗi Critical đã giết phiên thật của người dùng');
    });
  });
});

test('createGroupSession đóng dấu lên phiên nhóm, KHÔNG lan sang phiên gốc', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    try {
      createGroupSession(s, group, 'runid-test');
      assert.equal(isOurGroupSession(group), true, 'phiên nhóm ta tạo ra phải mang dấu');
      // If tmux shared session options across a group, the marker would also
      // land on the user's real session and hand us permission to kill it.
      // Measured on tmux 3.7: user options are strictly per-session.
      assert.equal(isOurGroupSession(s), false,
        'dấu KHÔNG được lan sang phiên gốc của người dùng — nếu lan, ta sẽ tự cho mình quyền giết nó');
      assert.equal(tmux('show-options', '-v', '-t', group, GROUP_MARKER_OPTION), 'runid-test',
        'giá trị dấu phải là run id của lần chạy đã tạo ra nó, để một phiên nhóm rò rỉ còn đọc được là của ai');
    } finally {
      try { execFileSync(T, ['kill-session', '-t', `=${group}`]); } catch {}
    }
  });
});

test('createGroupSession NÉM LỖI khi phiên gốc đã biến mất, không âm thầm dựng một terminal rỗng', () => {
  // Measured on tmux 3.7: `new-session -t <phiên không tồn tại>` KHÔNG lỗi —
  // nó exit 0 và lặng lẽ tạo một phiên thường, shell mới toanh. Nếu không
  // kiểm tra, daemon sẽ báo thành công rồi gắn trình duyệt vào một terminal
  // rỗng KHÔNG phải pane của người dùng.
  const ghost = `ccrc-t-ma-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  const group = `${ghost}-ccrc-web`;
  try {
    assert.throws(() => createGroupSession(ghost, group, 'runid-test'),
      'phải ném lỗi khi không gắn nhóm được vào phiên gốc');
    assert.equal(hasSession(group), false,
      'phiên rỗng vừa lỡ tạo ra phải được dọn đi, không để lại rác giả dạng phiên nhóm');
  } finally {
    try { execFileSync(T, ['kill-session', '-t', `=${group}`]); } catch {}
  }
});

test('hasSession khớp tên CHÍNH XÁC, không khớp tiền tố', () => {
  // `tmux has-session -t foo` returns success for a session named `foobar`:
  // tmux target resolution falls back to a start-of-name match. Anything
  // that decides whether to create or destroy on top of that answer is
  // deciding about the wrong session.
  withSession((s) => {
    assert.equal(hasSession(s), true);
    assert.equal(hasSession(s.slice(0, -1)), false,
      'tiền tố của một tên phiên đang tồn tại KHÔNG được báo là đã tồn tại');
  });
});

test('claimGroupName tránh cái tên đã bị phiên lạ chiếm, không giết nó', () => {
  withSession((s) => {
    withPlainSession(`${s}-ccrc-web`, (bystander) => {
      const name = claimGroupName(s);
      assert.notEqual(name, bystander,
        'không được chọn cái tên đang thuộc về một phiên ta không tạo ra');
      assert.equal(name, `${s}-ccrc-web-2`, 'phải lùi sang tên kế tiếp');
      assert.equal(hasSession(bystander), true, 'phiên lạ phải còn nguyên');
    });
  });
});

test('claimGroupName thu hồi tên từ phiên nhóm RÒ RỈ của chính chúng ta', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    try {
      // Marked with a run whose process is GONE — như thể daemon trước crash
      // để lại. Đây mới là thứ chứng minh phiên nhóm đã bị bỏ rơi; chỉ có dấu
      // thôi thì chưa (xem isReclaimableMarker).
      createGroupSession(s, group, deadRunId());
      const name = claimGroupName(s, liveRunId('claim'));
      assert.equal(name, group, 'tên phải được thu hồi, không lùi sang tên khác — nếu lùi thì mỗi lần crash lại chồng thêm một phiên');
      assert.equal(hasSession(group), false, 'phiên nhóm rò rỉ phải bị dọn đi để nhường tên');
    } finally {
      try { execFileSync(T, ['kill-session', '-t', `=${group}`]); } catch {}
    }
  });
});

test('claimGroupName thu hồi tên từ phiên nhóm của CHÍNH lần chạy này', () => {
  withSession((s) => {
    const group = `${s}-ccrc-web`;
    const run = liveRunId('tudon');
    try {
      createGroupSession(s, group, run);
      assert.equal(claimGroupName(s, run), group,
        'phiên nhóm do chính lần chạy này tạo ra thì lần chạy này được phép thu hồi');
      assert.equal(hasSession(group), false);
    } finally {
      try { execFileSync(T, ['kill-session', '-t', `=${group}`]); } catch {}
    }
  });
});

// --- HIGH (đợt sửa cuối, mục 1): hai daemon trong hai pane của CÙNG một -----
// --- phiên tmux không được huỷ diệt lẫn nhau. --------------------------------
//
// Cả hai daemon suy ra cùng một phiên gốc, nên cùng một tên phiên nhóm ứng
// viên. Trước bản sửa này, dấu @ccrc_group chỉ chứng minh "ccrc-term tạo ra
// cái này", chưa bao giờ chứng minh "lần chạy NÀY tạo ra, và nó đã bị bỏ
// rơi": daemon B giết phiên nhóm ĐANG SỐNG của daemon A rồi chiếm tên, trình
// duyệt của A rơi với `tmux control mode đã đóng bất ngờ` và dấu của phiên
// nhóm lật từ run id này sang run id kia. Lần nghiệm thu trước dùng HAI phiên
// tmux riêng nên không bao giờ đụng tên — đó là lý do nó lọt lưới.

test('isReclaimableMarker: chỉ đúng với dấu của chính ta hoặc của lần chạy đã chết', () => {
  const mine = liveRunId('cua-toi');
  assert.equal(isReclaimableMarker(mine, mine), true, 'dấu của chính lần chạy này: được phép dọn');
  assert.equal(isReclaimableMarker(deadRunId(), mine), true, 'dấu của lần chạy đã chết: được phép dọn');
  assert.equal(isReclaimableMarker(liveRunId('cua-nguoi-khac'), mine), false,
    'dấu của một tiến trình ĐANG SỐNG khác: TUYỆT ĐỐI không được dọn — đây chính là lỗi hai daemon giết nhau');
  assert.equal(isReclaimableMarker('', mine), false, 'không có dấu thì không phải của ta');
  assert.equal(isReclaimableMarker('hinh-dang-la', mine), false,
    'dấu không đọc được thì không chứng minh được chủ đã chết — phải từ chối');
  assert.equal(isReclaimableMarker(mine, ''), false, 'không biết mình là ai thì không được nhận vơ');
});

test('hai daemon trong hai pane của CÙNG một phiên tmux: mỗi bên giữ phiên nhóm của mình', () => {
  withSession((s) => {
    // Hai pane trong cùng MỘT phiên tmux — cách làm việc hoàn toàn bình
    // thường, và là đúng kịch bản đã tái hiện được lỗi.
    execFileSync(T, ['new-window', '-t', `=${s}`]);
    const panes = tmux('list-panes', '-s', '-t', `=${s}`, '-F', '#{pane_id}').split('\n');
    assert.equal(panes.length, 2, 'điều kiện đầu vào: phải có đúng hai pane trong một phiên');

    const runA = liveRunId('daemonA');
    const runB = liveRunId('daemonB');
    let nameA = null, nameB = null;
    try {
      // daemon A bật trước
      const baseA = reclaimPaneSession(panes[0], runA);
      assert.equal(baseA, s);
      nameA = claimGroupName(baseA, runA);
      assert.equal(nameA, `${s}-ccrc-web`);
      createGroupSession(baseA, nameA, runA);

      // daemon B bật sau, ở pane kia của cùng phiên đó
      const baseB = reclaimPaneSession(panes[1], runB);
      assert.equal(hasSession(nameA), true,
        'reclaimPaneSession của B KHÔNG được giết phiên nhóm đang sống của A');
      assert.equal(baseB, s,
        'B phải lần ra phiên THẬT của người dùng, không phải phiên nhóm của A');

      nameB = claimGroupName(baseB, runB);
      assert.notEqual(nameB, nameA, 'B không được chiếm tên phiên nhóm đang sống của A');
      assert.equal(nameB, `${s}-ccrc-web-2`, 'B phải lùi sang tên ứng viên kế tiếp');
      createGroupSession(baseB, nameB, runB);

      assert.equal(hasSession(nameA), true, 'phiên nhóm của A phải còn sống nguyên vẹn');
      // `show-options` không nhận tiền tố `=` (đo trực tiếp: "no such
      // session: =..."), khác với kill-session/new-session — nên ở đây dùng
      // tên trần. Tên phiên trong test là duy nhất nên không có rủi ro khớp
      // tiền tố.
      assert.equal(tmux('show-options', '-v', '-t', nameA, GROUP_MARKER_OPTION), runA,
        'dấu của phiên nhóm A không được lật sang run id của B');

      // A tắt: phiên nhóm của B phải không hề hấn gì.
      killGroupSession(nameA);
      assert.equal(hasSession(nameA), false);
      assert.equal(hasSession(nameB), true, 'A tắt không được kéo theo phiên nhóm của B');
      assert.equal(paneAlive(panes[0]), true, 'pane của A vẫn phải sống');
      assert.equal(paneAlive(panes[1]), true, 'pane của B vẫn phải sống');
      assert.equal(hasSession(s), true, 'phiên gốc của người dùng không được đụng tới');
    } finally {
      for (const n of [nameA, nameB]) {
        if (n) { try { execFileSync(T, ['kill-session', '-t', `=${n}`]); } catch {} }
      }
    }
  });
});

test('reclaimPaneSession trả về phiên THẬT và dọn phiên nhóm rò rỉ đang che nó', () => {
  withSession((s) => {
    const pane = currentPaneOf(s);
    const group = `${s}-ccrc-web`;
    try {
      createGroupSession(s, group, deadRunId());
      // Measured: tmux reports the newest session referencing the shared
      // window, so paneSession() now answers with the GROUP, not the user's
      // session. Deriving a new group name from that answer is what used to
      // produce `<sess>-ccrc-web-ccrc-web`.
      assert.equal(paneSession(pane), group,
        'điều kiện đầu vào: tmux phải đang báo nhầm phiên nhóm là phiên của pane');
      assert.equal(reclaimPaneSession(pane, liveRunId('reclaim')), s,
        'phải lần ra được phiên THẬT của người dùng, không phải phiên nhóm rò rỉ');
      assert.equal(hasSession(group), false, 'phiên nhóm rò rỉ phải được dọn luôn');
      assert.equal(paneAlive(pane), true, 'pane không được hề hấn gì');
    } finally {
      try { execFileSync(T, ['kill-session', '-t', `=${group}`]); } catch {}
    }
  });
});

test('reclaimPaneSession trả nguyên tên phiên người dùng dù tên đó đuôi -ccrc-web', () => {
  withPlainSession(`ccrc-t-nan-${process.pid}-${Math.floor(process.uptime() * 1000)}-ccrc-web`, (s) => {
    const pane = currentPaneOf(s);
    assert.equal(reclaimPaneSession(pane, liveRunId('nan')), s,
      'KHÔNG được cắt đuôi tên phiên thật của người dùng — cắt là ra đúng cái tên đã bị giết trong lỗi Critical');
    assert.equal(hasSession(s), true, 'phiên phải còn sống sau khi lần ra nó');
  });
});

// --- paneCwd: thư mục của pane, KHÔNG bao giờ rời khỏi máy ----------------
//
// This replaces a block of tests for paneLabel(), which turned the same value
// into a basename and shipped it to the hub as the session's label. That was
// the leak; the function is gone. What survives here is the part that was
// always about tmux rather than about labels: this call must never throw, no
// matter what the pane does underneath it.
//
// The full path is deliberate. paneCwd's whole job is to be the key the
// notification hook matches its own cwd against, locally — anything shorter
// would match the wrong directory.

test('paneCwd lấy đúng thư mục THẬT của pane, đủ cả đường dẫn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cwd-'));
  const sess = `ccrc-t-cwd-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-c', dir, '-x', '80', '-y', '24']);
  try {
    const pane = currentPaneOf(sess);
    // fs.realpathSync: macOS resolves /tmp through a symlink to /private/tmp,
    // and tmux reports the resolved form.
    assert.equal(fs.realpathSync(paneCwd(pane)), fs.realpathSync(dir));
  } finally {
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('paneCwd trả về chuỗi rỗng, KHÔNG ném lỗi, khi pane đã chết', () => {
  // Same trap as paneAlive: keep another session alive so the tmux server
  // does not shut down entirely when the target session is killed.
  const keep = `ccrc-t-cwd-keep-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', keep, '-x', '80', '-y', '24']);
  try {
    let pane;
    withSession((s) => { pane = currentPaneOf(s); });
    assert.doesNotThrow(() => paneCwd(pane));
    assert.equal(paneCwd(pane), '');
  } finally {
    try { execFileSync(T, ['kill-session', '-t', keep]); } catch {}
  }
});

test('paneCwd trả về chuỗi rỗng với id bịa, không ném lỗi', () => {
  assert.doesNotThrow(() => paneCwd('%999999'));
  assert.equal(paneCwd('%999999'), '');
});

// --- listPanes: mọi pane trên server ----------------------------------------

test('listPanes liệt kê pane vừa tạo, đúng target và cwd', () => {
  withSession((s) => {
    const pane = tmux('display-message', '-p', '-t', s, '#{pane_id}');
    const rows = listPanes();
    const row = rows.find((r) => r.paneId === pane);
    assert.ok(row, 'phải thấy pane vừa tạo trong danh sách toàn bộ pane trên server');
    // Verify target format matches session name, and pane index is 0 (default for new session)
    assert.ok(row.target.startsWith(`${s}:`), `target phải bắt đầu bằng tên phiên`);
    const [, indexPart] = row.target.split(':');
    const [, paneIndex] = indexPart.split('.');
    assert.equal(paneIndex, '0', 'phiên mới luôn là pane 0');
    assert.equal(typeof row.cmd, 'string');
    assert.ok(row.cmd.length > 0, 'pane vừa tạo luôn đang chạy MỘT shell nào đó');
    assert.equal(typeof row.cwd, 'string');
    // panePid/paneTty are what candidates' subtree+tty match actually reads
    // (see tmux.js's own comment on listPanes) — asserted here so a
    // positional-field regression in the `-F` format string (an inserted or
    // reordered field shifting everything after it) is caught in THIS test,
    // against a real tmux server, rather than showing up indirectly as a
    // mysterious candidates failure in remote-cli.test.js.
    assert.match(row.panePid, /^\d+$/, `panePid phải là một số pid, nhận được: ${row.panePid}`);
    assert.equal(Number(row.panePid) > 0, true);
    assert.match(row.paneTty, /^\/dev\//, `paneTty phải có tiền tố /dev/ (định dạng của tmux), nhận được: ${row.paneTty}`);
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
