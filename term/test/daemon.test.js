import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { tmuxBin, paneAlive, hasSession } from '../src/tmux.js';
import { checkPrereqs } from '../src/tailscale.js';
import {
  DAEMON, startDaemon, waitExit, childPids, waitCtlPids, EVENT_TIMEOUT_MS, sleep,
  taoThietBiTest, ghiDevices,
} from './helpers.mjs';

function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const data = [];
    ws.on('message', (m) => data.push(m.toString()));
    ws.on('open', () => resolve({
      ws,
      data,
      ok: true,
      // Reads the `ccrc_session` control frame, which the daemon guarantees is
      // the socket's very first message (ccrc-term.js sends it at line 339,
      // ahead of the pane snapshot at 348).
      //
      // Reads it out of `data`, which has been collecting from before 'open',
      // rather than waiting for the NEXT message. That distinction is the whole
      // fix: `ws.once('message')` subscribes at the moment it is CALLED, so if
      // the control frame and the snapshot have both already arrived by then,
      // it skips the frame this function exists to read and hands back whatever
      // comes third. On an idle machine the caller always got here first and it
      // worked; under load it did not, and four tests failed with
      // `Unexpected token '\x1B' ... is not valid JSON` — the pane snapshot,
      // caught in the control frame's place. What matters is "has the first
      // frame arrived", not "what is the next frame", and only the buffer can
      // answer the first question.
      sessionKey: async () => {
        const t0 = Date.now();
        while (data.length === 0) {
          if (Date.now() - t0 > EVENT_TIMEOUT_MS) {
            throw new Error(`không nhận được sessionKey kịp lúc (sau ${Date.now() - t0}ms)`);
          }
          await sleep(10);
        }
        let msg;
        try {
          msg = JSON.parse(data[0]);
        } catch (e) {
          throw new Error(`khung đầu tiên không phải JSON — daemon phải gửi ccrc_session trước ảnh chụp pane. Nhận được: ${JSON.stringify(data[0].slice(0, 60))}`);
        }
        // Nói rõ khi gọi sai chỗ: một kết nối không mint khoá (mintKey=false)
        // thì khung đầu là ảnh chụp pane, và trước bản này lỗi đó hiện ra dưới
        // dạng `msg.key === undefined` trôi xuống tận assertion ở xa.
        assert.equal(msg.type, 'ccrc_session',
          `khung đầu phải là ccrc_session, nhận được type=${msg.type} — sessionKey() chỉ dùng được ngay sau một kết nối bằng vé`);
        return msg.key;
      },
    }));
    ws.on('error', () => resolve({ ws: null, data, ok: false }));
    ws.on('unexpected-response', () => resolve({ ws: null, data, ok: false }));
  });
}

// Đợi sự kiện close và trả về nguyên sự kiện, để test đọc được `code`.
// connect() chỉ trả ok/không-ok nên không đủ cho mã đóng.
function waitClose(ws, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('hết giờ chờ close')), timeoutMs);
    ws.on('close', (code, reason) => { clearTimeout(t); res({ code, reason: String(reason) }); });
  });
}

// Chia sẻ MỘT bản, thay vì lặp lại định nghĩa này ở từng test cần một cổng
// trống — vốn là cách file này đã làm trước Task 8 (xem các test dùng daemon
// spawn tay bên dưới). `dungCanh()` cần một bản dùng chung ở top-level vì bản
// thân nó không nằm trong một test nào để tự khai báo lấy.
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

test('vé hợp lệ nối được và nhận nội dung màn hình ban đầu', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true, 'vé hợp lệ phải nối được');
    await sleep(600);
    assert.ok(c.data.length > 0, 'phải gửi nội dung màn hình hiện tại ngay khi nối');
    c.ws.close();
  } finally { d.stop(); }
});

// --- Task 7 fix round: hai lỗi tìm thấy khi nghiệm thu bằng trình duyệt thật
// (docs/superpowers/specs/2026-07-27-nghiem-thu-trinh-duyet.md) — đọc đúng
// byte của khung snapshot ĐẦU TIÊN gửi qua WebSocket, không cần trình duyệt
// thật để quan sát.

test('snapshot ban đầu qua WebSocket: cắt dòng trống thừa và kết thúc bằng reset SGR', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    await sleep(600);
    // data[0] là khung ccrc_session (JSON, luôn gửi trước — xem ccrc-term.js);
    // data[1] là khung snapshot màn hình, khung dữ liệu ĐẦU TIÊN theo đúng
    // nghĩa "byte đầu tiên client nhận được ngoài phần bootstrap sessionKey".
    assert.ok(c.data.length >= 2, 'phải nhận được cả khung sessionKey lẫn khung snapshot màn hình');
    const snapshot = c.data[1];

    assert.ok(snapshot.startsWith('\x1b[2J\x1b[H'),
      'snapshot phải mở đầu bằng xoá màn hình + đưa con trỏ về đầu');
    assert.ok(snapshot.endsWith('\x1b[0m'),
      'snapshot phải kết thúc bằng reset SGR — thiếu nó thì màu nền cuối cùng của capture-pane rò ra mọi dòng output streamed sau đó, đúng dải xám thấy trong ảnh chụp nghiệm thu thật');

    // Pane test được dựng ở -y 24 trong helpers.mjs, gần như trống (chỉ một
    // dấu nhắc shell) — snapshot đã cắt dòng trống thừa phải ngắn hơn hẳn
    // chiều cao đầy đủ đó.
    const snapshotLines = snapshot.split('\n').length;
    assert.ok(snapshotLines < 24,
      `snapshot đã cắt (${snapshotLines} dòng) phải ngắn hơn hẳn chiều cao đầy đủ của pane (24 dòng) — nếu không thì ghi vào một terminal trình duyệt ngắn hơn sẽ cuộn mất nội dung, đúng lỗi nghiệm thu tìm thấy`);
    c.ws.close();
  } finally { d.stop(); }
});

test('không có vé bị từ chối', async () => {
  const d = await startDaemon();
  try {
    assert.equal((await connect(`ws://127.0.0.1:${d.port}/attach`)).ok, false);
  } finally { d.stop(); }
});

test('token sai chữ ký bị từ chối', async () => {
  const d = await startDaemon();
  try {
    // Payload thật, nhưng chữ ký bị làm hỏng — khác với "thiết bị chưa ghép"
    // (đã có test riêng): đây là đúng thiết bị, đúng payload, chỉ mỗi chữ ký
    // là giả — phải rơi đúng vào nhánh bad_signature, không phải unknown_device.
    //
    // Lật một BYTE đã GIẢI MÃ ở giữa chữ ký, không phải ký tự cuối của chuỗi
    // base64url: ký tự cuối cùng của base64url thường chỉ mã hoá vài bit đệm
    // (chữ ký ECDSA raw dài 64 byte, 64 mod 3 = 1, nên ký tự cuối chỉ mang 2
    // bit dữ liệu thật) — đổi nó có thể KHÔNG đổi byte thực sự nào, khiến
    // test này thoảng lúc đậu nhầm. Lật một byte GIỮA chuỗi luôn đổi đúng nội
    // dung chữ ký, bất kể giá trị ngẫu nhiên của nó.
    const t = await d.token();
    const parts = t.split('.');
    const sig = Buffer.from(parts[2], 'base64url');
    sig[Math.floor(sig.length / 2)] ^= 0xff;
    parts[2] = sig.toString('base64url');
    const gia = parts.join('.');
    assert.equal((await connect(d.url(gia))).ok, false);
  } finally { d.stop(); }
});

test('vé hết hạn bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const cu = await d.token({ now: Date.now() - 120_000 });
    assert.equal((await connect(d.url(cu))).ok, false);
  } finally { d.stop(); }
});

test('vé dùng lần thứ hai bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const t = await d.token();
    const a = await connect(d.url(t));
    assert.equal(a.ok, true);
    a.ws.close();
    await sleep(200);
    assert.equal((await connect(d.url(t))).ok, false, 'vé phải dùng một lần');
  } finally { d.stop(); }
});

test('vé của sessionId khác bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const t = await d.token({ sessionId: 's-khac' });
    assert.equal((await connect(d.url(t))).ok, false);
  } finally { d.stop(); }
});

test('gõ vào WebSocket (khung nhị phân) thì chữ hiện ra trong pane', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    // BINARY frame = keystrokes. `ws` autodetects text/binary from the JS
    // type of `data`, so a plain string needs `{binary:true}` to force the
    // same frame type a real browser's `sendInput()` (term.js) sends.
    c.ws.send('echo CCRC_WS_MARKER\r', { binary: true });
    await sleep(1000);
    const man = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.match(man, /CCRC_WS_MARKER/, 'byte gửi qua WS (khung nhị phân) phải tới đúng pane — hành vi cũ không được hồi quy');
    c.ws.close();
  } finally { d.stop(); }
});

// --- Task 4 fix round: khung điều khiển (text frame) vs khung phím (binary) —
// coi một khối JSON là bàn phím từng khiến nó bị GÕ THẲNG vào phiên Claude
// Code đang sống của người dùng mỗi khi xoay máy hay bật bàn phím ảo. Frame
// type là điểm phân biệt DUY NHẤT — không được soi nội dung theo cả hai
// hướng (đối xứng với nguyên tắc đã áp dụng cho khung ccrc_session ở
// term.js, hướng server→client).

test('khung điều khiển (text frame) hợp lệ KHÔNG BAO GIỜ được gõ vào pane', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    // A plain string send() is a TEXT frame by default in `ws` — exactly
    // what a real browser's sendControl() (term.js) produces.
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 91, rows: 29 }));
    await sleep(600);
    const man = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.doesNotMatch(man, /ccrc_resize/, 'khung điều khiển JSON không được xuất hiện trong pane như thể là phím gõ');
    c.ws.close();
  } finally { d.stop(); }
});

test('resize hợp lệ thực sự tới được tmux qua refresh-client -C (phiên nhóm, không phải phiên gốc)', async () => {
  // Task 5: ctl attaches to the GROUPED session, never d.sess directly (see
  // spec §5.5) — so the effect of a resize must now be observed on
  // `${d.sess}-ccrc-web`, not on d.sess itself. Whether d.sess stays
  // genuinely unaffected while someone REAL is watching it is covered by
  // the dedicated isolation test below; this one just proves the resize
  // still actually reaches tmux at all through the new path.
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 111, rows: 33 }));
    await sleep(600);
    // Measured directly: for a `tmux -C` (headless) client, list-clients'
    // #{client_height} comes back EMPTY even after a successful resize —
    // #{client_width} alone is populated. The window itself is the
    // reliable place to observe the effect of `refresh-client -C`.
    const out = execFileSync(tmuxBin(), ['list-windows', '-t', `${d.sess}-ccrc-web`, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' });
    assert.match(out, /111x33/, 'kích thước cửa sổ của phiên nhóm phải đổi đúng theo resize hợp lệ');
    c.ws.close();
  } finally { d.stop(); }
});

// --- Task 5, REVERSED: phiên nhóm tmux — điện thoại quyết định kích cỡ ----
//
// tmux gives a shared window exactly ONE size. The original fix pinned
// `window-size` to `largest`, so the window followed the desktop and the
// phone was left reading lines five times wider than its own screen —
// unreadable on a real device. Huy chose the other trade-off: the window
// now follows the SMALLEST attached client, i.e. the phone, for as long as
// one is attached, and returns to the desktop's size the moment it leaves.

test('resize từ client web (điện thoại) LÀM CO phiên gốc trong lúc đang xem — và trả lại kích cỡ khi điện thoại rời đi', async () => {
  const d = await startDaemon();
  let desktop;
  try {
    // Simulate the actual danger spec §5.5 describes: a REAL, live-attached
    // tmux client sitting at a normal desktop size on the ORIGINAL session
    // — not the grouped one. This is what a real Terminal.app/iTerm2
    // window attached via plain `tmux attach` looks like from tmux's side.
    desktop = spawn(tmuxBin(), ['-C', 'attach-session', '-t', d.sess], { stdio: ['pipe', 'pipe', 'ignore'] });
    await sleep(400);
    desktop.stdin.write('refresh-client -C 200x50\n');
    await sleep(400);
    const truoc = execFileSync(tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' }).trim();
    assert.equal(truoc, '200x50', 'điều kiện đầu vào: phiên gốc phải thật sự lớn với client thật đang xem');

    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    // Phone-sized resize, over the real WS/daemon path — this is what
    // exercises the actual production code in ccrc-term.js, not just the
    // tmux.js helper in isolation.
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 40, rows: 20 }));
    await sleep(700);

    const trongLucXem = execFileSync(tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' }).trim();
    assert.equal(trongLucXem, '40x20',
      'với window-size=smallest, cửa sổ chia sẻ phải theo client điện thoại (40x20) trong lúc điện thoại đang xem — đây là đánh đổi Huy đã chọn, không còn là lỗi cần sửa');

    // What tmux records per-client also confirms the resize itself really
    // reached the group and was not swallowed somewhere on the way
    // (measured directly: #{client_width} is populated for a `tmux -C`
    // client, #{client_height} comes back empty even after a successful
    // resize).
    const client = execFileSync(tmuxBin(), ['list-clients', '-t', `${d.sess}-ccrc-web`, '-F', '#{client_width}'], { encoding: 'utf8' }).trim();
    assert.equal(client, '40', 'resize phải thực sự tới được phiên nhóm, không bị nuốt mất');

    // The phone leaves — production teardown path (close() in ccrc-term.js
    // kills the grouped session once the last browser client is gone), not
    // just a bare client detach. The desktop's real, live terminal must get
    // its columns back with no action required from the person at it.
    c.ws.close();
    await sleep(700);

    const sauKhiRoiDi = execFileSync(tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' }).trim();
    assert.equal(sauKhiRoiDi, '200x50',
      'sau khi điện thoại ngắt kết nối, phiên gốc phải TỰ trả lại 200x50 cho client desktop thật đang xem — không cần desktop tự resize lại');
  } finally {
    try { desktop?.kill('SIGKILL'); } catch {}
    await sleep(200);
    d.stop();
  }
});

test('client web ngắt kết nối thì phiên nhóm bị dọn, không để lại rác tmux', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    await sleep(300);
    const group = `${d.sess}-ccrc-web`;
    assert.equal(hasSession(group), true, 'phiên nhóm phải tồn tại trong lúc còn client đang xem');

    c.ws.close();
    await sleep(600);
    assert.equal(hasSession(group), false, 'phiên nhóm phải bị dọn khi client cuối rời đi — không được để rác tmux lại');
    assert.equal(paneAlive(d.pane), true, 'dọn phiên nhóm không được đụng tới pane gốc');
  } finally { d.stop(); }
});

test('phiên nhóm bị giết ngoài luồng không làm daemon tắt — pane gốc vẫn sống', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    await sleep(300); // để phiên nhóm + ctl thực sự attach xong

    // Giết THẲNG phiên nhóm bằng tay, ngoài luồng dọn dẹp bình thường của
    // daemon — mô phỏng bất cứ tác nhân nào (kể cả một race) xoá mất phiên
    // nhóm trong khi client vẫn còn nối. Điều này chắc chắn làm ctl (đang
    // attach vào phiên nhóm) thoát theo — nhưng KHÔNG được bị hiểu nhầm là
    // pane đã chết, vì phiên gốc và pane hoàn toàn không bị đụng tới.
    execFileSync(tmuxBin(), ['kill-session', '-t', `${d.sess}-ccrc-web`]);
    await sleep(1200);

    assert.equal(d.proc.exitCode, null, 'daemon không được tự tắt chỉ vì phiên nhóm (không phải pane) bị giết');
    assert.equal(d.proc.signalCode, null, 'daemon không được tự tắt chỉ vì phiên nhóm (không phải pane) bị giết');
    assert.equal(paneAlive(d.pane), true, 'pane gốc phải vẫn còn sống nguyên vẹn');
    assert.equal((() => { try { execFileSync(tmuxBin(), ['has-session', '-t', d.sess]); return true; } catch { return false; } })(), true,
      'phiên gốc phải vẫn còn nguyên');
  } finally { d.stop(); }
});

test('pane chết thật thì daemon vẫn tắt dù đang có phiên nhóm đang phục vụ client', async () => {
  const d = await startDaemon();
  // Bystander session kept alive on the SAME tmux server so killing the
  // pane below does not also take the whole server down — a target that is
  // the ONLY session on the server exits with a different failure mode
  // ("no server running") than the one this test is actually checking, per
  // the trap documented in tmux.test.js's own "cái bẫy exit 0" test and
  // called out explicitly for Task 5 in task-5-brief.md.
  const keep = `ccrc-t-keep5-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(tmuxBin(), ['new-session', '-d', '-s', keep]);
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    await sleep(300); // để phiên nhóm + ctl thực sự attach xong

    // kill-pane, không phải kill-session: phải diệt đúng cái PANE, bất kể
    // có bao nhiêu phiên (gốc lẫn phiên nhóm) đang cùng tham chiếu tới nó.
    execFileSync(tmuxBin(), ['kill-pane', '-t', d.pane]);

    assert.equal(await waitExit(d.proc), true,
      'pane thật sự chết vẫn phải tắt daemon, dù đang có phiên nhóm phục vụ một client web');
    c.ws.close();
  } finally {
    try { execFileSync(tmuxBin(), ['kill-session', '-t', keep]); } catch {}
    d.stop();
  }
});

test('text frame JSON hỏng bị bỏ qua âm thầm — không gõ gì, daemon không chết', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send('{ đây không phải JSON hợp lệ');
    await sleep(600);
    assert.equal(c.ws.readyState, c.ws.OPEN, 'daemon không được đóng kết nối vì một text frame hỏng');
    const man = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.doesNotMatch(man, /không phải JSON/, 'JSON hỏng không được gõ vào pane');
    c.ws.close();
  } finally { d.stop(); }
});

test('text frame có type lạ bị bỏ qua âm thầm — không gõ, và không âm thầm bị hiểu thành resize', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    const truoc = execFileSync(tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' });

    // cols/rows here are deliberately valid-LOOKING (would pass every
    // cols/rows check) — the only thing that should stop this from
    // resizing the window is the unrecognised `type`. A test that only
    // checked "not typed into the pane" would pass even if the `type`
    // check were deleted entirely, since resize messages are never typed
    // into the pane either way — that used to be true here until this
    // window-size assertion was added.
    c.ws.send(JSON.stringify({ type: 'ccrc_khong_ton_tai', cols: 123, rows: 45 }));
    await sleep(600);

    const man = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.doesNotMatch(man, /ccrc_khong_ton_tai/, 'type lạ không được gõ vào pane');

    const sau = execFileSync(tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' });
    assert.equal(sau, truoc, 'type lạ không được âm thầm được hiểu thành lệnh resize');
    c.ws.close();
  } finally { d.stop(); }
});

// --- Đóng phiên: trang phải BIẾT là hết, không quay vòng nối lại -----------
//
// Rớt mạng và "phiên đã đóng" trông y hệt nhau ở phía trình duyệt nếu daemon
// không nói rõ. Khác biệt lại rất lớn với người dùng: một bên phải nối lại,
// một bên nối lại mãi mãi cũng vô ích, và họ ngồi nhìn "đang nối lại…" quay
// vòng cho một phiên không còn tồn tại.
// Đường THẬT của đời thường, khác với SIGTERM ở test dưới: đóng Claude thì
// phiên tmux do `ccrc` mở kết thúc, pane chết theo. Tiến trình `tmux -C` của
// kết nối này chết trước, và nếu nó kịp đóng socket bằng mã "lỗi máy chủ" thì
// mã 4001 của shutdown() không bao giờ được gửi — trình duyệt đọc thành rớt
// mạng và nối lại mãi. Đo được trên máy Huy: điện thoại báo "vé đã dùng",
// đúng hành vi của nhánh rớt mạng.
test('PANE CHẾT (đóng Claude) → vẫn là mã 4001, không phải mã lỗi', async () => {
  const d = await startDaemon();
  // Giữ lời của daemon lại: lần gỡ rối này, thứ chỉ ra thủ phạm chính là
  // "daemon không nói gì cả" — shutdown() chưa hề chạy, nên mã đóng đến từ
  // chỗ khác. Không có nó thì chỉ thấy một con số sai và không biết của ai.
  let dbg = '';
  d.proc.stdout.on('data', (x) => { dbg += x; });
  d.proc.stderr.on('data', (x) => { dbg += x; });
  let closed = null;
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    const seen = new Promise((resolve) => {
      c.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
      setTimeout(() => resolve(null), EVENT_TIMEOUT_MS);
    });

    // Đợi kết nối dựng XONG rồi mới giết. `connect()` trả về ngay khi HTTP
    // upgrade xong, tức TRƯỚC khi daemon kịp tạo phiên nhóm và bật đường tiếp
    // sức. Giết vào đúng khoảng đó thì cái đo được là đường "dựng kết nối
    // hỏng", không phải đường "phiên đang chạy thì kết thúc" — hai chuyện khác
    // nhau, và người dùng luôn ở chuyện thứ hai. (Đo bằng tên phiên nhóm thì
    // vẫn trượt lúc máy bận: đó là tín hiệu gián tiếp.)
    //
    // Tiến trình `tmux -C` là bằng chứng trực tiếp: daemon sinh đúng một cái
    // cho mỗi kết nối, và chỉ sau khi mọi bước dựng đã xong.
    //
    // Phải là ctlPids, KHÔNG phải childPids: mọi bước dựng phía trước đều shell
    // ra tmux qua execFileSync và cũng là con của daemon trong khoảnh khắc đó,
    // nên `childPids().length > 0` trả lời "có con nào không", không phải "đường
    // tiếp sức dựng xong chưa". Máy rảnh hai câu đó tình cờ cùng đáp án; máy
    // tải thì không, và bài test này giết pane giữa lúc daemon còn đang dựng
    // rồi nhận mã 1011 ở ccrc-term.js:364. Xem ctlPids trong helpers.mjs.
    await waitCtlPids(d.proc);

    // Giết chính PANE, không phải phiên. `kill-session` ở đây không mô phỏng
    // được gì: phiên nhóm của daemon vẫn liên kết cùng window nên pane sống
    // tiếp, daemon không thấy có chuyện gì xảy ra. Claude thoát thì pane đóng
    // thật — đó mới là thứ cần dựng lại.
    execFileSync(tmuxBin(), ['kill-pane', '-t', d.pane]);
    closed = await seen;

    assert.ok(closed, 'không nhận được sự kiện đóng nào');
    assert.equal(closed.code, 4001,
      `mã ${closed && closed.code} (${closed && closed.reason}) nghĩa là "có trục trặc, thử lại đi" — trang sẽ nối lại vô tận\n--- daemon nói ---\n${dbg}`);
  } finally {
    d.stop();
  }
});

test('daemon tắt hẳn → gửi mã đóng RIÊNG, không phải mã rớt mạng', async () => {
  const d = await startDaemon();
  let closed = null;
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    const seen = new Promise((resolve) => {
      c.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
      setTimeout(() => resolve(null), EVENT_TIMEOUT_MS);
    });

    // SIGTERM đi qua đúng đường shutdown() thật, khác với SIGKILL của d.stop().
    process.kill(d.proc.pid, 'SIGTERM');
    closed = await seen;

    assert.ok(closed, 'không nhận được sự kiện đóng nào');
    assert.equal(closed.code, 4001,
      `phải là mã "phiên đã đóng", nhận được ${closed.code} — trang sẽ tưởng là rớt mạng và nối lại mãi`);
    assert.match(closed.reason, /phiên đã đóng/);
  } finally { d.stop(); }
});

// --- Cuộn trong ứng dụng MÀN HÌNH PHỤ (hình dạng thật) --------------------
//
// The shape the first implementation was never tested against, and the reason
// it did not work where it mattered. Measured on the live Claude Code session:
//
//     alternate_on = 1        tmux keeps NO scrollback for this pane
//     history_size = 2        …and indeed there is none
//     mouse_any_flag = 1      the app is listening for the wheel
//     mouse_sgr_flag = 1      in SGR encoding
//
// So the conversation the user wants to scroll back through is inside the
// application, and the way to move it is to send the application a wheel
// event. Paging tmux history there returns junk — a screenful of repeated
// prompt lines is what the user saw on their phone.
//
// `less --mouse` stands in for Claude Code: same alternate screen, same mouse
// reporting, and unlike Claude Code it can be started and driven in a test.

async function startMouseAppDaemon() {
  const T = tmuxBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-mouse-'));
  const file = path.join(dir, 'dai.txt');
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `dong-${i + 1}`).join('\n') + '\n');

  const sess = `ccrc-mouse-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24', `less --mouse ${file}`]);

  // Task 15 review: everything below can throw (fixture-readiness wait times
  // out; waitPortListening throws if the daemon never binds) — before this
  // fix, a throw here left `sess`'s tmux session (and its pty) orphaned
  // forever, since the caller never gets a `stop()` to call. Same shape as
  // helpers.mjs's startDaemon: wrap setup in try/catch, reap on failure.
  let pane, home, proc, port, phone;
  try {
    pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

    // Wait for less to actually take the alternate screen and switch mouse
    // reporting on — asserting against a pane that has not got there yet
    // would test nothing.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const flags = execFileSync(T, ['display-message', '-p', '-t', pane, '#{alternate_on}#{mouse_any_flag}'],
        { encoding: 'utf8' }).trim();
      if (flags === '11') break;
      if (Date.now() > deadline) throw new Error(`less chưa vào màn hình phụ + bật chuột (flags=${flags})`);
      await sleep(100);
    }

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-mouse-home-'));
    fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ccrc', 'config'),
      'CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n');
    phone = await taoThietBiTest();
    ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

    port = await freePort();
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env, HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-mouse',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);
  } catch (e) {
    if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} try { proc.kill('SIGKILL'); } catch {} }
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
    throw e;
  }

  const firstLine = () => (execFileSync(T, ['capture-pane', '-p', '-t', pane], { encoding: 'utf8' })
    .split('\n').find((l) => l.trim()) || '');

  return {
    pane, port, proc, firstLine,
    token: (over = {}) => phone.ky({ sessionId: 's-mouse', host: `127.0.0.1:${port}`, ...over }),
    url: (t) => `ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(t)}`,
    stop() {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      try {
        const names = execFileSync(T, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
          .split('\n').filter((n) => n.startsWith(sess));
        for (const n of names) { try { execFileSync(T, ['kill-session', '-t', n]); } catch {} }
      } catch { /* no server left */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

// A fixture application instead of a real one: `less` proves an app REACTS,
// which is a proxy. This one prints what it decoded, so the test can assert
// the bytes arrived correctly encoded — button, column and row.
async function startEchoAppDaemon() {
  const T = tmuxBin();
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mouse-echo.mjs');
  const sess = `ccrc-echo-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24', `node ${fixture}`]);

  // Task 15 review: same reasoning as startMouseAppDaemon just above — a
  // throw anywhere below (fixture-readiness wait timing out, waitPortListening
  // throwing) used to leak `sess`'s tmux session forever, since the caller
  // never gets a `stop()` to call it with.
  let pane, home, proc, port, phone;
  try {
    pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

    const deadline = Date.now() + 10_000;
    for (;;) {
      const flags = execFileSync(T, ['display-message', '-p', '-t', pane, '#{alternate_on}#{mouse_any_flag}#{mouse_sgr_flag}'],
        { encoding: 'utf8' }).trim();
      if (flags === '111') break;
      if (Date.now() > deadline) throw new Error(`fixture chưa sẵn sàng (flags=${flags})`);
      await sleep(100);
    }

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-echo-home-'));
    fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ccrc', 'config'),
      'CCRC_HUB_URL=http://127.0.0.1:9\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n');
    phone = await taoThietBiTest();
    ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

    port = await freePort();
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env, HOME: home,
        CCRC_TERM_PANE: pane, CCRC_TERM_SESSION_ID: 's-echo',
        CCRC_TERM_PORT: String(port), CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);
  } catch (e) {
    if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} try { proc.kill('SIGKILL'); } catch {} }
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
    throw e;
  }

  return {
    pane, port, proc,
    screen: () => execFileSync(T, ['capture-pane', '-p', '-t', pane], { encoding: 'utf8' }),
    token: (over = {}) => phone.ky({ sessionId: 's-echo', host: `127.0.0.1:${port}`, ...over }),
    url: (t) => `ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(t)}`,
    stop() {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      try {
        const names = execFileSync(T, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
          .split('\n').filter((n) => n.startsWith(sess));
        for (const n of names) { try { execFileSync(T, ['kill-session', '-t', n]); } catch {} }
      } catch { /* no server left */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

// The user's report, in its exact shape: a button drawn INSIDE the terminal
// ("Jump to bottom") that a tap on the phone must be able to press.
test('chạm trên điện thoại tới ứng dụng thành CLICK đúng ô', async () => {
  const d = await startEchoAppDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await sleep(400);

    c.ws.send(JSON.stringify({ type: 'ccrc_click', col: 37, row: 11 }));
    await sleep(700);

    const screen = d.screen();
    assert.match(screen, /PRESS btn=0 col=37 row=11/,
      `ứng dụng không nhận được cú bấm:\n${screen}`);
    // The release is the half that makes a button fire — a press on its own
    // reads as a finger still held down.
    assert.match(screen, /RELEASE btn=0 col=37 row=11/,
      'thiếu sự kiện NHẢ — nút vẽ trong ứng dụng sẽ không kích hoạt');
  } finally { d.stop(); }
});

test('cuộn tới ứng dụng đúng nút bánh xe, đúng chiều', async () => {
  const d = await startEchoAppDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await sleep(400);

    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 6 }));   // dương = về quá khứ
    await sleep(600);
    assert.match(d.screen(), /WHEEL-UP/, 'cuộn ngược không thành lăn LÊN');

    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: -6 }));
    await sleep(600);
    assert.match(d.screen(), /WHEEL-DOWN/, 'cuộn xuôi không thành lăn XUỐNG');
  } finally { d.stop(); }
});

test('toạ độ bấm vô lý bị từ chối — không gửi gì tới ứng dụng', async () => {
  const d = await startEchoAppDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    for (const bad of [
      { type: 'ccrc_click', col: 0, row: 5 },
      { type: 'ccrc_click', col: 5, row: 0 },
      { type: 'ccrc_click', col: -3, row: 5 },
      { type: 'ccrc_click', col: 5.5, row: 5 },
      { type: 'ccrc_click', col: '5', row: '5' },
      { type: 'ccrc_click', col: 99999, row: 5 },
      { type: 'ccrc_click' },
    ]) {
      c.ws.send(JSON.stringify(bad));
    }
    await sleep(700);
    assert.ok(!/PRESS/.test(d.screen()), `một giá trị hỏng đã lọt tới ứng dụng:\n${d.screen()}`);
    assert.equal(c.ws.readyState, 1, 'daemon phải còn sống');
  } finally { d.stop(); }
});

// Same reasoning as the wheel: with mouse reporting off these bytes are not
// ignored, they are typed in. And unlike scrolling there is no fallback worth
// having, so a click simply does nothing.
test('shell thường: chạm KHÔNG gõ byte chuột nào vào dòng lệnh', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_click', col: 10, row: 5 }));
    await sleep(700);
    const screen = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.ok(!screen.includes('[<0;'), `chuỗi bấm chuột bị gõ vào shell:\n${screen.slice(-200)}`);
    assert.ok(!/\[M/.test(screen), 'chuỗi bấm kiểu cũ bị gõ vào shell');
  } finally { d.stop(); }
});

test('ứng dụng màn hình phụ: cuộn của điện thoại LÀM CUỘN chính ứng dụng đó', async () => {
  const d = await startMouseAppDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await sleep(400);

    const before = d.firstLine();
    assert.match(before, /dong-1\b/, 'điều kiện đầu vào: less phải đang ở đầu file');

    // Negative = towards the present = wheel DOWN, which in a pager moves
    // forward through the file.
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: -15 }));
    await sleep(800);
    const after = d.firstLine();
    assert.notEqual(after, before,
      'ứng dụng không cuộn — cử chỉ của điện thoại không tới được nó');
    assert.match(after, /dong-\d+/);

    // …and back.
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 15 }));
    await sleep(800);
    assert.match(d.firstLine(), /dong-1\b/, 'cuộn ngược lại không về được đầu');
  } finally { d.stop(); }
});

// The failure this guards against is not cosmetic: with mouse reporting OFF,
// wheel bytes are not "ignored", they are TYPED into whatever is at the
// prompt.
test('shell thường (KHÔNG bật chuột): không gõ byte chuột nào vào dòng lệnh', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await sleep(300);

    assert.equal(
      execFileSync(tmuxBin(), ['display-message', '-p', '-t', d.pane, '#{mouse_any_flag}'], { encoding: 'utf8' }).trim(),
      '0', 'điều kiện đầu vào: shell thường không bật chuột');

    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 20 }));
    await sleep(800);

    const screen = execFileSync(tmuxBin(), ['capture-pane', '-p', '-t', d.pane], { encoding: 'utf8' });
    assert.ok(!screen.includes('[<64;'), `chuỗi thoát chuột bị gõ vào shell:\n${screen.slice(-200)}`);
    assert.ok(!screen.includes('[<65;'), 'chuỗi thoát chuột bị gõ vào shell');
    assert.ok(!/\[M/.test(screen), 'chuỗi chuột kiểu cũ bị gõ vào shell');
  } finally { d.stop(); }
});

// --- Cuộn: daemon gửi màn hình lịch sử ------------------------------------
//
// Why it works this way, recorded because the obvious approach was tried and
// measured to fail: `tmux -C` forwards a pane's OUTPUT, never the screen tmux
// renders. Driving tmux's copy mode put the PANE into copy mode — the desktop
// view scrolled, pane_in_mode went to 1, scroll_position to 30 — and the
// browser went on showing the live tail, because no rendered screen ever
// reaches a control-mode client. So the daemon fetches the history itself and
// ships it as a screen.

// Fills the pane with numbered lines, then WAITS until tmux actually reports
// that much history.
//
// A flat sleep is not enough: under load the shell had not finished printing,
// tmux's history was still shallow, the daemon clamped the scroll request down
// to 0 — which means "back to the present" — and the test that asserted live
// output is held back failed for a reason that had nothing to do with the
// behaviour it was testing.
async function fillPane(d, count, needHistory = 40) {
  execFileSync(tmuxBin(), ['send-keys', '-t', d.pane,
    `for i in $(seq 1 ${count}); do echo dong-$i; done`, 'Enter']);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const size = Number(execFileSync(
      tmuxBin(), ['display-message', '-p', '-t', d.pane, '#{history_size}'], { encoding: 'utf8' }).trim());
    if (size >= needHistory) return size;
    if (Date.now() > deadline) {
      throw new Error(`pane chỉ có ${size} dòng lịch sử, cần ít nhất ${needHistory} thì test mới có nghĩa`);
    }
    await sleep(100);
  }
}

test('cuộn lên → nhận màn hình LỊCH SỬ, thấy dòng đã trôi khỏi màn hình', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await fillPane(d, 120);

    const seen = [];
    c.ws.on('message', (m) => seen.push(String(m)));
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 40 }));
    await sleep(800);

    const all = seen.join('');
    assert.ok(all.includes('dong-'), `không nhận được màn hình lịch sử nào:\n${all.slice(0, 300)}`);
    // dong-120 is on the live screen; something from further back is the
    // proof that history actually came down the wire.
    assert.ok(/dong-(6|7|8)\d/.test(all),
      `màn hình lịch sử không chứa dòng đã trôi đi:\n${all.slice(0, 400)}`);
    // And the pane itself must be untouched — this is the whole reason for
    // not using copy mode.
    assert.equal(
      execFileSync(tmuxBin(), ['display-message', '-p', '-t', d.pane, '#{pane_in_mode}'], { encoding: 'utf8' }).trim(),
      '0', 'pane KHÔNG được vào copy-mode — màn hình máy Mac không được đụng tới');
  } finally { d.stop(); }
});

test('trong lúc xem lịch sử, output trực tiếp KHÔNG đè lên màn hình đang đọc', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await fillPane(d, 120);
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 40 }));
    await sleep(800);

    const seen = [];
    c.ws.on('message', (m) => seen.push(String(m)));
    execFileSync(tmuxBin(), ['send-keys', '-t', d.pane, 'echo DANG-DOC-LICH-SU', 'Enter']);
    await sleep(800);
    assert.ok(!seen.join('').includes('DANG-DOC-LICH-SU'),
      'output mới đè lên phần đang đọc — người dùng mất chỗ đang xem');
  } finally { d.stop(); }
});

test('cuộn hết xuống → về hiện tại, và thấy lại những gì đã xảy ra trong lúc đọc', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await fillPane(d, 120);
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 40 }));
    await sleep(800);
    execFileSync(tmuxBin(), ['send-keys', '-t', d.pane, 'echo TRONG-LUC-DOC', 'Enter']);
    await sleep(600);

    const seen = [];
    c.ws.on('message', (m) => seen.push(String(m)));
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: -500 }));
    await sleep(900);
    // Nothing is lost by muting: coming back re-sends the whole current
    // screen, which already contains everything that arrived meanwhile.
    assert.ok(seen.join('').includes('TRONG-LUC-DOC'),
      'về hiện tại mà không thấy những gì đã chạy trong lúc đọc — output bị mất thật');
  } finally { d.stop(); }
});

test('gõ phím trong lúc đọc lịch sử → tự nhảy về hiện tại', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    c.ws.send(JSON.stringify({ type: 'ccrc_resize', cols: 80, rows: 24 }));
    await fillPane(d, 120);
    c.ws.send(JSON.stringify({ type: 'ccrc_scroll', lines: 40 }));
    await sleep(800);

    const seen = [];
    c.ws.on('message', (m) => seen.push(String(m)));
    c.ws.send(Buffer.from('echo GO-PHIM\r'), { binary: true });
    await sleep(1000);
    assert.ok(seen.join('').includes('GO-PHIM'),
      'gõ phím mà màn hình vẫn kẹt ở quá khứ — người dùng thấy chữ mình gõ biến mất');
  } finally { d.stop(); }
});

test('xin cuộn với số vô lý bị từ chối — không đụng tới tmux, daemon vẫn sống', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    for (const bad of [
      { type: 'ccrc_scroll', lines: 0 },
      { type: 'ccrc_scroll', lines: 1.5 },
      { type: 'ccrc_scroll', lines: '10' },
      { type: 'ccrc_scroll', lines: 100000 },
      { type: 'ccrc_scroll', lines: -100000 },
      { type: 'ccrc_scroll', lines: NaN },
      { type: 'ccrc_scroll' },
    ]) {
      c.ws.send(JSON.stringify(bad));
    }
    await sleep(600);
    assert.equal(c.ws.readyState, 1, 'daemon phải còn sống');
    assert.equal(
      execFileSync(tmuxBin(), ['display-message', '-p', '-t', d.pane, '#{pane_in_mode}'], { encoding: 'utf8' }).trim(),
      '0');
  } finally { d.stop(); }
});

test('cols/rows không phải số nguyên hoặc vượt biên bị từ chối, không đụng tới tmux', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);

    const truocKhiGui = execFileSync(
      tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' },
    );

    // Measured directly against a real tmux -C client (see task-4-report.md):
    // tmux itself happily accepts `refresh-client -C 2000x24` and
    // `-C 80x2` — its OWN size floor/ceiling is far looser than what a
    // phone-driven resize should ever need. So these values are chosen to
    // be valid AS FAR AS TMUX IS CONCERNED — the only thing standing
    // between them and the pane is OUR guard. (999999 and negative rows
    // were tried too, and tmux itself refuses those with "size too small
    // or too big" — that's tmux's own defense, not evidence of ours, so
    // they don't belong in a test whose job is to prove OUR guard fires.)
    for (const bad of [
      { type: 'ccrc_resize', cols: 80.5, rows: 24 }, // non-integer
      { type: 'ccrc_resize', cols: 2000, rows: 24 }, // above MAX_TERM_COLS, tmux itself would allow it
      { type: 'ccrc_resize', cols: 80, rows: 2 }, // below MIN_TERM_ROWS, tmux itself would allow it
      { type: 'ccrc_resize', cols: '200', rows: '50' }, // strings, not integers — would coerce into a valid tmux size string if unchecked
    ]) {
      c.ws.send(JSON.stringify(bad));
    }
    await sleep(600);

    const sauKhiGui = execFileSync(
      tmuxBin(), ['list-windows', '-t', d.sess, '-F', '#{window_width}x#{window_height}'], { encoding: 'utf8' },
    );
    assert.equal(sauKhiGui, truocKhiGui, 'cols/rows sai kiểu hoặc vượt biên không được đổi kích thước cửa sổ');
    c.ws.close();
  } finally { d.stop(); }
});

test('pane chết thì daemon tự thoát', async () => {
  const d = await startDaemon();
  try {
    execFileSync(tmuxBin(), ['kill-session', '-t', d.sess]);
    assert.equal(await waitExit(d.proc), true,
      'pane chết là không còn gì để phơi ra — daemon phải tự đóng');
  } finally { d.stop(); }
});

// --- Finding 1 (review round 2): one-time use phải gắn với exp của CHÍNH vé,
// không phải một cửa sổ cố định trùng hợp bằng đúng con số hôm nay. ---------

test('vé có exp xa trong tương lai (vượt vòng đời tối đa) bị từ chối', async () => {
  const d = await startDaemon();
  try {
    // ttlMs lớn hơn nhiều MAX_TICKET_LIFETIME_MS mặc định (60s) — mô phỏng
    // hub bị lệch giờ hoặc hub độc hại ký vé "sống" rất lâu.
    const t = await d.token({ ttlMs: 10 * 60 * 1000 });
    assert.equal((await connect(d.url(t))).ok, false, 'vé claim sống quá lâu phải bị chặn ngay ở cổng');
  } finally { d.stop(); }
});

// CCRC_TERM_NONCE_TTL_MS (the fixed retention window this test used to fake
// down to 2s to avoid a real 60s+ wait) is gone — final fix wave, item 8: it
// never actually controlled real nonce retention on any live path (the
// daemon always ties retention to the ticket's OWN exp, passed explicitly to
// nonces.use() below), so it was dead configuration that only looked like a
// working knob. The property itself — retention tracks the ticket's own exp,
// not some unrelated fixed window — is still worth a real test: a short-lived
// (8s) ticket must still be refused as "already used" once actually replayed
// within its own lifetime, without needing to fake anything.
test('vé đã dùng bị chặn khi phát lại còn trong hạn riêng của chính vé (không phụ thuộc bất kỳ cửa sổ cố định nào)', async () => {
  const d = await startDaemon();
  try {
    const t = await d.token({ ttlMs: 8000 });
    const a = await connect(d.url(t));
    assert.equal(a.ok, true);
    a.ws.close();
    await sleep(2500); // vẫn còn trong hạn riêng của vé (8s)
    assert.equal((await connect(d.url(t))).ok, false,
      'nonce phải được giữ tới đúng exp của vé, không phải một cửa sổ cố định không liên quan');
  } finally { d.stop(); }
});

// --- Round 3: env override rác âm thầm vô hiệu hoá clamp -------------------

test('CCRC_TERM_MAX_TICKET_MS rác (NaN) không được làm biến mất giới hạn vòng đời vé', async () => {
  // Number('not-a-number') là NaN, và x > NaN luôn là false — nếu daemon
  // parse thô bằng Number(env || default), một giá trị rác sẽ âm thầm vô
  // hiệu hoá clamp thay vì rơi về mặc định an toàn.
  const d = await startDaemon({ CCRC_TERM_MAX_TICKET_MS: 'not-a-number' });
  try {
    const t = await d.token({ ttlMs: 10 * 60 * 1000 });
    assert.equal((await connect(d.url(t))).ok, false,
      'biến môi trường rác phải rơi về mặc định 60s, không phải NaN vô hiệu hoá clamp');
  } finally { d.stop(); }
});

// --- Round 3: clamp phải đo vòng đời MINTED (exp - iat), không phải --------
// --- khoảng cách tới exp nhìn từ đồng hồ daemon lúc kiểm ------------------

test('vé minted quá lâu (exp - iat vượt vòng đời tối đa) bị từ chối', async () => {
  const d = await startDaemon();
  try {
    // now mặc định = Date.now() thật, nên iat ≈ Date.now() và exp - iat =
    // ttlMs đúng nghĩa "vòng đời minted", không lệ thuộc đồng hồ verify.
    const t = await d.token({ ttlMs: 10 * 60 * 1000 });
    assert.equal((await connect(d.url(t))).ok, false, 'vé minted sống quá lâu phải bị chặn');
  } finally { d.stop(); }
});

test('vé thường (60s) từ hub bị lệch giờ 40s được chấp nhận NGAY, không đợi lệch giờ trôi qua', async () => {
  const d = await startDaemon();
  try {
    // Giả lập hub lệch giờ 40s về phía trước: now dùng để ký lệch 40s so với
    // đồng hồ thật của daemon. exp - iat vẫn đúng 60s (vòng đời minted thật
    // sự của vé), nên phải được CHẤP NHẬN ngay — dù (exp - Date.now() thật)
    // lúc này xấp xỉ 100s, vượt quá 60s nếu tính sai theo đồng hồ verify.
    const t = await d.token({ now: Date.now() + 40_000 });
    const a = await connect(d.url(t));
    assert.equal(a.ok, true,
      'vé minted đúng 60s không được bị từ chối chỉ vì hub lệch giờ — đó là lỗi robustness, không phải bảo mật');
    a.ws.close();
    await sleep(200);
    assert.equal((await connect(d.url(t))).ok, false, 'vé đã dùng vẫn phải bị chặn khi phát lại, lệch giờ hay không');
  } finally { d.stop(); }
});

// --- Finding 2 (review round 2): control-mode child chết mà không ai biết --

test('control-mode child (tmux -C) chết bất ngờ thì socket đóng và daemon tự tắt', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    // Wait for the ctl child to actually appear rather than assume a fixed
    // sleep outran the spawn — on a loaded machine it does not. The budget is
    // the same one every other wait here uses: the previous 5s went marginal
    // once the suite grew and this test started failing only in full runs,
    // never on its own.
    // ctlPids, không phải childPids: bài này SIGKILL thứ nó tìm được, nên nhận
    // nhầm một tiến trình tmux dựng-kết-nối nghĩa là giết sai mục tiêu và đo
    // sai chuyện — xem ctlPids trong helpers.mjs.
    const kids = await waitCtlPids(d.proc);

    const closed = new Promise((resolve) => {
      c.ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), EVENT_TIMEOUT_MS);
    });
    for (const pid of kids) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }

    assert.equal(await closed, true,
      'control child chết bất ngờ thì socket phải đóng, không được nằm im trông như còn sống');
    assert.equal(await waitExit(d.proc), true,
      'không còn gì phía sau socket — daemon phải tự tắt, không phải chờ ticket mới');
  } finally { d.stop(); }
});

// --- Finding 3 (review round 2): cửa sổ phục vụ một pane đã chết ----------

test('pane vừa chết thì vé còn hợp lệ cũng bị từ chối, không đợi tới vòng kiểm 2s', async () => {
  const d = await startDaemon();
  try {
    const t = await d.token();
    execFileSync(tmuxBin(), ['kill-session', '-t', d.sess]);
    const c = await connect(d.url(t));
    assert.equal(c.ok, false, 'không được nối vào một pane đã chết dù vé hợp lệ và chưa dùng');
  } finally { d.stop(); }
});

// --- Task 9: bind thẳng vào IP Tailscale, không qua tailscale serve --------

test('daemon KHÔNG nghe trên 0.0.0.0 — cổng không được hở ra wifi/LAN', async () => {
  const d = await startDaemon();
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    const dong = out.split('\n').filter((l) => l.includes(`:${d.port}`));
    assert.ok(dong.length > 0, 'phải có tiến trình nghe cổng này');
    for (const l of dong) {
      assert.ok(!l.includes('*:'), `nghe trên mọi giao diện là hở ra LAN: ${l}`);
    }
  } finally { d.stop(); }
});

// --- Task 1 (web terminal UI): sessionKey bootstrap từ vé ------------------

test('nối bằng vé thì nhận được sessionKey', async () => {
  const d = await startDaemon();
  try {
    const c = await connect(d.url(await d.token()));
    assert.equal(c.ok, true);
    const key = await c.sessionKey();
    assert.ok(typeof key === 'string' && key.length >= 32, 'phải cấp sessionKey ngay sau khi vé được nhận');
    c.ws.close();
  } finally { d.stop(); }
});

test('nối lại bằng sessionKey KHÔNG cần vé mới', async () => {
  const d = await startDaemon();
  try {
    const a = await connect(d.url(await d.token()));
    const key = await a.sessionKey();
    a.ws.close();
    const b = await connect(`ws://127.0.0.1:${d.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(b.ok, true, 'đây là toàn bộ lý do sessionKey tồn tại');
    b.ws.close();
  } finally { d.stop(); }
});

test('sessionKey bịa bị từ chối', async () => {
  const d = await startDaemon();
  try {
    const r = await connect(`ws://127.0.0.1:${d.port}/attach?key=khong-phai-khoa-that-dau-nhe`);
    assert.equal(r.ok, false);
  } finally { d.stop(); }
});

test('khoá của daemon này KHÔNG dùng được cho daemon khác', async () => {
  const d1 = await startDaemon();
  const d2 = await startDaemon();
  try {
    const a = await connect(d1.url(await d1.token()));
    const key = await a.sessionKey();
    a.ws.close();
    const r = await connect(`ws://127.0.0.1:${d2.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(r.ok, false, 'khoá giữ trong RAM từng daemon, không được dùng chéo');
  } finally { d1.stop(); d2.stop(); }
});

// Item 4, review toàn nhánh — năm tính chất bảo mật ĐÃ ĐÚNG trong mã nhưng
// chưa có test canh, sống sót qua xoá và suite vẫn xanh.
//
// (1) `if (mintKey)` (ccrc-term.js) là điều DUY NHẤT ngăn một kết nối `?key=`
// nhận thêm một `ccrc_session` frame — đổi thành `if (true)` thì mọi kết nối
// đều qua được test hiện có (chúng chỉ kiểm ok/không-ok, không kiểm khung
// ĐẦU TIÊN là gì). Khung snapshot màn hình (bắt đầu bằng \x1b[2J\x1b[H — xem
// test "snapshot ban đầu…" ở trên) phải là khung ĐẦU TIÊN của một kết nối
// `?key=`, không phải một `ccrc_session` JSON.
//
// (2) Đốt nonce chỉ xảy ra trong nhánh `token !== null` (ccrc-term.js) —
// nhánh `?key=` không chạm `nonces.use()` ở bất kỳ đâu. Nối lại NHIỀU LẦN
// bằng CÙNG một khoá (không phải một tài nguyên dùng-một-lần) phải luôn
// thành công — nếu một khoá bị lỡ đi qua nonce store (vd `nonces.use(key,…)`
// bị thêm nhầm vào nhánh này), lần nối lại thứ hai sẽ chết dù khoá vẫn y hệt
// và còn hạn.
test('nối lại bằng sessionKey: KHÔNG mint khoá mới, và không phải tài nguyên dùng-một-lần (không đốt nonce)', async () => {
  const d = await startDaemon();
  try {
    const a = await connect(d.url(await d.token()));
    const key = await a.sessionKey();
    a.ws.close();
    await sleep(100);

    const b = await connect(`ws://127.0.0.1:${d.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(b.ok, true);
    await sleep(300);
    // Khung ĐẦU TIÊN của một kết nối `?key=` phải là snapshot màn hình
    // (\x1b[2J\x1b[H…), KHÔNG PHẢI một khung ccrc_session JSON — mintKey
    // phải là false trên nhánh này.
    assert.ok(b.data.length > 0, 'phải nhận được ít nhất khung snapshot');
    assert.ok(b.data[0].startsWith('\x1b[2J\x1b[H'),
      `khung đầu tiên của một kết nối ?key= phải là snapshot màn hình, không phải mint thêm một ccrc_session — nhận được: ${JSON.stringify(b.data[0].slice(0, 80))}`);
    b.ws.close();
    await sleep(100);

    // Nối lại LẦN NỮA bằng ĐÚNG khoá đó — nếu nhánh ?key= lỡ đốt một nonce
    // (hay coi khoá như một thứ dùng-một-lần), lần thứ hai này sẽ 401.
    const c = await connect(`ws://127.0.0.1:${d.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(c.ok, true, 'sessionKey không phải tài nguyên dùng-một-lần — nối lại nhiều lần vẫn phải được');
    c.ws.close();
  } finally { d.stop(); }
});

// (3) Một `?token=` HỎNG đi kèm một `?key=` HỢP LỆ phải 401 — không được rơi
// xuống nhánh key. `if (token !== null) { … return 401 nếu !v.ok … } else if
// (!sessionKeys.valid(key)) { 401 }` (ccrc-term.js:248-252, chú thích nói rõ
// điều này): sự có mặt của `token` chiếm trọn quyền quyết định, `key` không
// bao giờ được xét tới nếu `token` có mặt. Một tái cấu trúc gộp hai nhánh lại
// (vd `if (tokenOk || keyOk)`) sẽ để một token giả "núp" sau một khoá phiên
// còn hạn lọt qua.
test('?token= hỏng đi kèm ?key= hợp lệ: 401, không rơi xuống nhánh khoá phiên', async () => {
  const d = await startDaemon();
  try {
    const a = await connect(d.url(await d.token()));
    const key = await a.sessionKey();
    a.ws.close();
    await sleep(100);

    const tokenHong = 'v2.khong-phai-token-that.chu-ky-gia';
    const url = `ws://127.0.0.1:${d.port}/attach?token=${encodeURIComponent(tokenHong)}&key=${encodeURIComponent(key)}`;
    const r = await connect(url);
    assert.equal(r.ok, false,
      'có mặt tham số token (dù hỏng) phải chiếm trọn quyền quyết định — key hợp lệ đi kèm không được cứu nó');

    // Khoá vẫn phải còn dùng được RIÊNG, không bị tác dụng phụ bởi lần thử trên.
    const b = await connect(`ws://127.0.0.1:${d.port}/attach?key=${encodeURIComponent(key)}`);
    assert.equal(b.ok, true, 'khoá phiên không được bị vô hiệu hoá bởi một token hỏng đi kèm ở lần thử trước');
    b.ws.close();
  } finally { d.stop(); }
});

// (5) Một upgrade WebSocket trên đường dẫn khác `/attach` phải bị huỷ ngay
// (`socket.destroy()`, ccrc-term.js), bất kể token/key có hợp lệ hay không —
// daemon chỉ phục vụ đúng MỘT endpoint. Test dùng một TOKEN THẬT HỢP LỆ để
// phép thử có ý nghĩa: nếu phép kiểm đường dẫn từng bị bỏ qua, đúng token này
// sẽ mở được kết nối bình thường — khác một token bịa, thứ sẽ luôn thất bại
// dù đường dẫn có đúng hay không.
test('upgrade trên đường dẫn khác /attach bị huỷ, dù token hợp lệ', async () => {
  const d = await startDaemon();
  try {
    const token = await d.token();
    const r = await connect(`ws://127.0.0.1:${d.port}/khong-phai-attach?token=${encodeURIComponent(token)}`);
    assert.equal(r.ok, false, 'chỉ /attach mới được phục vụ — mọi đường dẫn khác phải bị huỷ ngay ở upgrade');
  } finally { d.stop(); }
});

// --- Task 1 (nhiều phiên): cổng cố định làm daemon thứ hai chết ------------
//
// The bug this fixes: `/remote on` a second time (a second project, a second
// pane) always failed with EADDRINUSE because the port was hard-coded. Both
// daemons here are started with opts.autoPort — CCRC_TERM_PORT deliberately
// left UNSET, exercising the real production default (0, OS-assigned) —
// which is the only way this test can actually catch a regression back to a
// fixed port: startDaemon()'s normal path pins each daemon to its own
// pre-discovered free port regardless of what the daemon's own default is,
// so it would never notice that default breaking.
//
// "mỗi cái phục vụ đúng pane của mình" is checked by CONTENT (a marker
// stamped into each pane before connecting, read back from the initial
// snapshot each daemon sends on connect — see 'gõ vào WebSocket' above for
// the same content-not-status-code discipline), never merely by a
// successful connection or a 101 status, either of which a daemon silently
// serving the WRONG pane would still produce.
test('hai daemon cùng lúc trên hai pane khác nhau: cổng do OS cấp khác nhau, mỗi cái phục vụ đúng pane của mình', async () => {
  const T = tmuxBin();
  const d1 = await startDaemon({ CCRC_TERM_SESSION_ID: 's-multi-a' }, { autoPort: true });
  const d2 = await startDaemon({ CCRC_TERM_SESSION_ID: 's-multi-b' }, { autoPort: true });
  try {
    assert.notEqual(d1.port, d2.port,
      'hai daemon chạy cùng lúc phải nhận được HAI cổng khác nhau từ OS — cổng cố định làm daemon thứ hai chết EADDRINUSE');

    const marker1 = `CCRC-MULTI-MOT-${process.pid}`;
    const marker2 = `CCRC-MULTI-HAI-${process.pid}`;
    execFileSync(T, ['send-keys', '-t', d1.pane, `echo ${marker1}`, 'Enter']);
    execFileSync(T, ['send-keys', '-t', d2.pane, `echo ${marker2}`, 'Enter']);
    await sleep(400);

    const t1 = await d1.token();
    const t2 = await d2.token();
    const c1 = await connect(d1.url(t1));
    const c2 = await connect(d2.url(t2));
    assert.equal(c1.ok, true, 'daemon thứ nhất phải nối được trên cổng OS cấp cho nó');
    assert.equal(c2.ok, true, 'daemon thứ hai phải nối được trên cổng OS cấp cho nó');
    await sleep(600);

    const snap1 = c1.data.join('');
    const snap2 = c2.data.join('');
    assert.match(snap1, new RegExp(marker1), 'daemon 1 phải phục vụ đúng pane của chính nó');
    assert.doesNotMatch(snap1, new RegExp(marker2), 'daemon 1 không được lẫn nội dung pane của daemon kia');
    assert.match(snap2, new RegExp(marker2), 'daemon 2 phải phục vụ đúng pane của chính nó');
    assert.doesNotMatch(snap2, new RegExp(marker1), 'daemon 2 không được lẫn nội dung pane của daemon kia');

    c1.ws.close();
    c2.ws.close();
  } finally { d1.stop(); d2.stop(); }
});

// --- Final fix wave, item 1: phiên nhóm rò rỉ khi daemon bị crash, và cứ ----
// --- crash lần nữa là chồng thêm một lớp tên. ------------------------------
//
// Reproduction: SIGKILL only the daemon PROCESS (not its process group) —
// this is what a real crash looks like, and it never touches the daemon's
// `tmux -C attach-session` child, which survives as an orphan still
// attached to the grouped session. Restarting the daemon for the SAME pane
// and connecting a client again must produce exactly ONE grouped session,
// named exactly `<sess>-ccrc-web` — never `<sess>-ccrc-web-ccrc-web`.

function waitPortListening(port, proc, timeoutMs = EVENT_TIMEOUT_MS) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect({ port, host: '127.0.0.1' });
      const fail = () => {
        s.destroy();
        if (proc.exitCode !== null || proc.signalCode !== null) {
          reject(new Error(`daemon thoát trước khi lắng nghe cổng ${port}`));
          return;
        }
        if (Date.now() - t0 > timeoutMs) { reject(new Error(`hết giờ chờ cổng ${port}`)); return; }
        setTimeout(tryOnce, 25);
      };
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', fail);
    };
    tryOnce();
  });
}

// Every session name currently on the tmux server that begins with `prefix`.
// Used to assert on the WHOLE population a test could have created — "there
// is exactly one group" is only a real claim if nothing else is lying around
// beside it under some other derived name.
function sessionNamesStartingWith(prefix) {
  let out;
  try {
    out = execFileSync(tmuxBin(), ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  } catch { return []; }
  return out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(prefix)).sort();
}

const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

// Task 15 review: several tests below create a tmux session (sometimes a
// whole family of derived names, e.g. `-ccrc-web` group sessions) BEFORE
// entering their own try/finally — a throw in the gap (a fixture wait timing
// out, waitPortListening throwing when a daemon never binds) used to leak
// that session, and its pty, permanently. That compounding leak is exactly
// what took the machine to 511/511 ptys with 508 orphaned shells in one run
// (task-15-brief.md item 2). Registering this the INSTANT the name is known
// closes the gap: `t.after()` runs no matter how the test ends. The test's
// own finally-block cleanup still runs first and is more precise (kills the
// daemon, waits for `tmux -C` to exit before the session kill); this is only
// a backstop for whatever that cleanup never gets to run.
function safeguardSessionsAfter(t, prefix) {
  t.after(() => {
    for (const n of sessionNamesStartingWith(prefix)) {
      try { execFileSync(tmuxBin(), ['kill-session', '-t', `=${n}`]); } catch {}
    }
  });
}

test('daemon bị SIGKILL rồi khởi động lại HAI lần: vẫn đúng MỘT phiên nhóm, không lồng tên, không bỏ lại orphan', async (t) => {
  // The original defect COMPOUNDED — one extra `-ccrc-web` layer per crash —
  // so a single restart is not enough to prove it is gone. This crashes and
  // restarts twice, checking the full session population after each round.
  const T = tmuxBin();
  const sess = `ccrc-leak-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  const group = `${sess}-ccrc-web`;
  const nested = `${group}-ccrc-web`;

  // MỘT thiết bị, dùng xuyên suốt cả ba vòng daemon — đúng hình dạng thật:
  // điện thoại ghép một lần, và mỗi HOME mới (mỗi vòng khởi động lại có HOME
  // riêng của nó, xem chú thích spawnRawDaemon) phải được ghi lại devices.json
  // cho cùng thiết bị đó, vì daemon đọc devices.json từ HOME riêng của chính
  // nó, không có bộ nhớ nào chung giữa các vòng.
  const phone = await taoThietBiTest();

  const spawnRawDaemon = (port) => {
    // A daemon writes its session into `$HOME/.ccrc/sessions/`. Without an
    // isolated HOME a test daemon writes into the developer's REAL registry
    // and leaves an entry behind when the test kills it — found by looking
    // at ~/.ccrc/sessions after a run.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-leak-home-'));
    ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);
    return spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-leak',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  };

  const token = (over = {}) => phone.ky({ sessionId: 's-leak', ...over });

  const daemons = [];
  const clients = [];
  // Counts live `tmux -C` control-mode processes on this machine. What must
  // not accumulate across crash/restart rounds: every round spawns one, and
  // a round that ends without reaping it leaves an orphan holding the tmux
  // server up.
  const ctlProcCount = () => {
    try {
      return execFileSync('bash', ['-c', 'ps -eo pid,command | grep -c "[t]mux -C"'], { encoding: 'utf8' }).trim();
    } catch { return '0'; }
  };
  // Starts a daemon, connects a browser client, and returns the pids of the
  // `tmux -C` child it spawned.
  const startRound = async () => {
    const port = await freePort();
    const d = spawnRawDaemon(port);
    daemons.push(d);
    await waitPortListening(port, d);
    const c = await connect(`ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(await token({ host: `127.0.0.1:${port}` }))}`);
    clients.push(c);
    assert.equal(c.ok, true, 'phải nối được để tạo phiên nhóm');
    // Trước đây: `await sleep(400)` rồi `childPids(d.pid)`. Hai lỗi cùng lớp
    // trong hai dòng — một khoảng ngủ cố định phải đủ cho máy chậm nhất, và
    // childPids không phân biệt ctl với những tiến trình tmux mà daemon sinh
    // ra khi dựng kết nối. waitCtlPids chờ đúng điều kiện thật và về ngay khi
    // nó tới. Xem ctlPids trong helpers.mjs.
    return { d, c, ctlPids: await waitCtlPids(d) };
  };

  const ctlBefore = ctlProcCount();
  try {
    const r1 = await startRound();
    assert.equal(hasSession(group), true, 'điều kiện đầu vào: phiên nhóm phải tồn tại trước khi mô phỏng crash');
    assert.ok(r1.ctlPids.length > 0, 'điều kiện đầu vào: phải có tiến trình `tmux -C` con');

    // Crash 1: SIGKILL đúng tiến trình daemon, KHÔNG phải cả nhóm tiến
    // trình — đó mới là hình dạng của một cú crash thật: daemon không kịp
    // chạy dọn dẹp, nên PHIÊN NHÓM ở lại trên tmux server (một phiên tmux
    // không cần client nào để tiếp tục tồn tại). Đo trực tiếp: tiến trình
    // `tmux -C` con thì KHÔNG sống lâu hơn cha — nó thoát vì stdin EOF
    // trong khoảng 50ms — nên thứ rò rỉ thật sự là cái phiên, không phải
    // tiến trình. Đó cũng chính là thứ đầu độc paneSession() ở lần sau.
    process.kill(r1.d.pid, 'SIGKILL');
    await sleep(300);
    assert.equal(hasSession(group), true,
      'điều kiện đầu vào: phiên nhóm phải SỐNG SÓT qua cú crash — đó là cái rò rỉ mà lần khởi động sau phải xử lý');
    assert.equal(r1.ctlPids.some(alive), false,
      'đo được: `tmux -C` con chết theo cha (stdin EOF) — nếu một ngày nó sống sót thì giả định trong ghi chú ở tmux.js đã sai và phải xem lại');

    const r2 = await startRound();
    assert.equal(r2.c.ws.readyState, r2.c.ws.OPEN,
      'kết nối sau khi khởi động lại lần 1 phải tạo được phiên nhóm, không vỡ vì tên bị phiên rò rỉ chiếm');
    assert.equal(hasSession(nested), false, 'không được có phiên nhóm LỒNG sau lần khởi động lại thứ nhất');
    assert.deepEqual(sessionNamesStartingWith(sess), [sess, group].sort(),
      'sau lần khởi động lại thứ nhất: đúng phiên gốc + đúng MỘT phiên nhóm, không có gì khác');

    // Crash 2 — cùng một kịch bản, lần thứ hai, vì lỗi gốc CỘNG DỒN: sửa
    // đúng thì lần thứ hai phải giống hệt lần thứ nhất.
    process.kill(r2.d.pid, 'SIGKILL');
    await sleep(300);

    const r3 = await startRound();
    assert.equal(r3.c.ws.readyState, r3.c.ws.OPEN, 'kết nối sau khi khởi động lại lần 2 cũng phải tạo được phiên nhóm');
    assert.equal(hasSession(nested), false, 'sau HAI lần crash vẫn không được có phiên nhóm lồng tên');
    assert.equal(hasSession(`${nested}-ccrc-web`), false, 'và tuyệt đối không có lớp lồng thứ hai');
    assert.deepEqual(sessionNamesStartingWith(sess), [sess, group].sort(),
      'sau HAI lần khởi động lại: vẫn đúng phiên gốc + đúng MỘT phiên nhóm — lỗi cũ cộng dồn một lớp mỗi lần crash');
    assert.equal(r2.ctlPids.some(alive), false, 'không được còn `tmux -C` sót lại từ vòng crash thứ hai');
    assert.equal(paneAlive(pane), true, 'pane gốc phải sống nguyên vẹn qua cả hai vòng');
    // Ba vòng daemon, hai cú crash: số tiến trình `tmux -C` đang sống phải
    // đúng bằng lúc đầu cộng ĐÚNG MỘT (vòng thứ ba vẫn đang phục vụ client).
    assert.equal(ctlProcCount(), String(Number(ctlBefore) + 1),
      'không được cộng dồn tiến trình `tmux -C` qua mỗi vòng crash — mỗi orphan còn sống là một tmux server bị giữ lại');
  } finally {
    for (const c of clients) { try { c?.ws.close(); } catch {} }
    for (const d of daemons) {
      if (!d) continue;
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { process.kill(d.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(d.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(300);
    for (const name of sessionNamesStartingWith(sess)) {
      try { execFileSync(T, ['kill-session', '-t', `=${name}`]); } catch {}
    }
  }
});

// --- Critical: một phiên THẬT của người dùng trùng hình dạng tên ----------
//
// The regression that must never come back. An earlier fix recovered the
// "original" session by stripping a trailing `-ccrc-web` off whatever name
// tmux reported. For a user whose real session is genuinely called
// `myproj-ccrc-web` that produced base `myproj`, derived the group name
// straight back onto `myproj-ccrc-web` — the user's own live session — and
// killed it before creating. It was the last session on that server, so the
// tmux server went down with it and the daemon then reported "pane tmux đã
// chết". Nothing here may be decided by the shape of a name.

test('phiên THẬT của người dùng tên đuôi -ccrc-web sống sót nguyên vẹn qua trọn một vòng daemon', async (t) => {
  const T = tmuxBin();
  // The user's own session — created by plain tmux, never by the daemon, and
  // named exactly like the thing the daemon builds for itself.
  const sess = `ccrc-nan-${process.pid}-${Math.floor(process.uptime() * 1000)}-ccrc-web`;
  safeguardSessionsAfter(t, 'ccrc-nan-'); // covers `sess`, `keep` (below) and any derived group session
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();
  // A bystander kept on the SAME tmux server so that, if the daemon ever
  // again kills `sess`, the server does not go down with it and the failure
  // shows up as this test's own assertion rather than as every later test
  // mysteriously breaking.
  const keep = `ccrc-nan-keep-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', keep, '-x', '80', '-y', '24']);

  let d, c;
  try {
    const port = await freePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-nan-home-'));
    const phone = await taoThietBiTest();
    ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);
    d = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-nan',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, d);

    const token = await phone.ky({ sessionId: 's-nan', host: `127.0.0.1:${port}` });
    c = await connect(`ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c.ok, true, 'phải phục vụ được pane nằm trong phiên tên đuôi -ccrc-web');
    await sleep(500);

    assert.equal(hasSession(sess), true,
      'phiên THẬT của người dùng phải còn sống — đây chính là lỗi Critical: nó bị giết vì cái tên trùng hình dạng');
    // The load-bearing assertion. hasSession() alone would NOT catch the
    // regression: measured under the mutation, after the user's session was
    // killed, `new-session -t <đã chết>` silently created a fresh ordinary
    // session under the SAME name, so the name came back while the user's
    // actual shell was gone. Only the pane id — which nothing can resurrect
    // — tells the truth about whether their terminal survived.
    assert.equal(paneAlive(pane), true, 'pane của người dùng phải còn sống');
    assert.equal(c.ws.readyState, c.ws.OPEN, 'kết nối phải còn mở, không bị đóng vì "pane tmux đã chết"');
    assert.equal(d.exitCode, null, 'daemon không được tự tắt');
    // The group it built for itself is a DIFFERENT session, derived from the
    // user's full name — never mistaken for the user's own.
    assert.equal(hasSession(`${sess}-ccrc-web`), true,
      'phiên nhóm phải được tạo riêng, tên dẫn xuất từ TRỌN tên phiên người dùng');

    c.ws.close();
    await sleep(700);
    assert.equal(hasSession(sess), true, 'phiên người dùng vẫn phải còn sau khi client rời đi');
    assert.equal(hasSession(`${sess}-ccrc-web`), false, 'phiên nhóm của daemon phải được dọn, không để lại rác');
    assert.equal(paneAlive(pane), true, 'pane người dùng vẫn sống sau trọn một vòng');
  } finally {
    try { c?.ws.close(); } catch {}
    if (d) {
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { process.kill(d.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(d.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(300);
    for (const name of sessionNamesStartingWith(`ccrc-nan-`)) {
      try { execFileSync(T, ['kill-session', '-t', `=${name}`]); } catch {}
    }
  }
});

// --- Final fix wave, item 2 (v1) — XOÁ ở Task 8, không viết lại -----------
//
// Test này (và captureSecretHub, cùng bị xoá) từng chứng minh "daemon khởi
// động lại làm mọi vé cũ vô hiệu": v1 ký bằng một bí mật HMAC sinh MỚI mỗi
// lần chạy, nên một vé ký cho lần chạy trước không còn xác minh được với
// lần chạy sau — cả tính chất lẫn cơ chế đứng sau nó (bí mật riêng theo
// tiến trình) không còn tồn tại kể từ token v2.
//
// v2 KHÔNG có tính chất tương đương. Chữ ký của một token v2 xác minh bằng
// khoá công khai trong devices.json — thứ sống trên đĩa, NGOÀI vòng đời của
// daemon — nên một token còn hạn (`exp` chưa qua) và chưa dùng vẫn xác minh
// được y hệt sau khi daemon khởi động lại. Cái duy nhất một lần khởi động
// lại xoá mất là NONCE STORE (chỉ ở RAM) — nghĩa là, về lý thuyết, một token
// đã dùng rồi có thể phát lại được đúng MỘT lần nữa sau một lần restart,
// trong lúc token đó còn hạn. Đây là một đánh đổi thật của kiến trúc mới,
// không phải một lỗi bỏ sót — cửa sổ đó bị chặn bởi TTL ngắn của token (mặc
// định 60s) và bởi việc restart daemon không phải chuyện xảy ra giữa chừng
// một phiên đang mở. Ghi lại ở đây để không ai viết lại một test khẳng định
// "restart vô hiệu hoá token" — khẳng định đó SAI cho v2.

// --- Task 3: nhãn phân biệt phiên thực sự tới được hub qua nhịp tim thật ---
//
// paneLabel() itself (tmux.js, unit-tested in tmux.test.js) is only useful
// if ccrc-term.js's heartbeat actually SENDS what it computes. This starts a
// REAL daemon (no CCRC_TERM_NO_HUB, no CCRC_TERM_URL override) against a
// local stub hub and inspects the exact JSON body its first heartbeat POSTs
// to /api/terminal/register.
function captureRegisterHub() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/terminal/register') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { bodies.push(JSON.parse(raw)); } catch { /* ignore malformed */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${srv.address().port}`,
      bodies,
      stop: () => srv.close(),
      waitForCount(n, timeoutMs = EVENT_TIMEOUT_MS) {
        const t0 = Date.now();
        return new Promise((res, rej) => {
          const tick = () => {
            if (bodies.length >= n) return res(bodies[n - 1]);
            if (Date.now() - t0 > timeoutMs) return rej(new Error(`hết giờ chờ nhịp tim thứ ${n}`));
            setTimeout(tick, 25);
          };
          tick();
        });
      },
    }));
  });
}

// Việc 5: nhãn KHÔNG còn là tên thư mục.
//
// The old version of this test asserted the opposite — that the label WAS the
// pane's directory basename. That was the leak: on a lock screen, and in the
// screenshot the user sent, it named the project. What goes to the hub now is
// an opaque id, or a name the user typed themselves.
//
// Run against a real daemon and a real tmux pane on purpose: the directory
// name is right there in `#{pane_current_path}`, and the only convincing
// evidence that it no longer escapes is watching a real heartbeat leave.
test('nhãn phiên gửi lên hub là id ngẫu nhiên — KHÔNG có tên thư mục ở bất kỳ đâu', async (t) => {
  const T = tmuxBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-label-hub-'));
  const sess = `ccrc-label-hub-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-c', dir, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-label-home-'));
  const hub = await captureRegisterHub();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);

  let d;
  try {
    const port = await freePort();
    d = spawn('node', [DAEMON], {
      env: {
        ...process.env, HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-label-hub',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, d);
    const body = await hub.waitForCount(1);

    const dirName = path.basename(dir);
    assert.match(body.label, /^[a-z2-9]{4}$/, `nhãn phải là id ngẫu nhiên 4 ký tự, nhận được: ${body.label}`);
    assert.notEqual(body.label, dirName, 'tên thư mục vẫn đang bị dùng làm nhãn');
    // The whole heartbeat, not just the label: the directory name must not
    // ride along in any other field either.
    const whole = JSON.stringify(body);
    assert.ok(!whole.includes(dirName), `tên thư mục lọt vào nhịp tim: ${whole}`);
    assert.ok(!whole.includes(dir), 'đường dẫn đầy đủ lọt vào nhịp tim');
    // Nothing is watching yet — no browser has connected.
    assert.equal(body.viewing, false);
  } finally {
    if (d) {
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { process.kill(d.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(d.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(300);
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    hub.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// Việc 1: daemon báo lên hub ai đang THỰC SỰ nhìn màn hình.
//
// The tempting signal was "a WebSocket is open". It is the wrong one: a phone
// that locks its screen keeps the socket alive, and the user would simply
// stop receiving notifications with no way to tell why. So the page reports
// its own visibility, and this test drives that end to end — real daemon,
// real WebSocket, real heartbeats — rather than trusting the flag in
// isolation.
test('trạng thái ĐANG XEM tới hub ngay khi đổi, không phải chờ nhịp 20 giây', async (t) => {
  const T = tmuxBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-view-'));
  const sess = `ccrc-view-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-c', dir, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-view-home-'));
  const hub = await captureRegisterHub();
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);
  const phone = await taoThietBiTest();
  ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

  // Waits for a heartbeat whose `viewing` reaches `want`. The bound is what
  // makes this meaningful: HEARTBEAT_MS is 20s, so anything arriving inside
  // a couple of seconds can only have come from the immediate beat the
  // daemon fires on a change — not from the periodic one.
  const waitViewing = async (want, timeoutMs = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const seen = hub.bodies.filter((b) => b.viewing === want);
      if (seen.length) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(50);
    }
  };

  let d, c;
  try {
    const port = await freePort();
    d = spawn('node', [DAEMON], {
      env: {
        ...process.env, HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-view',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, d);
    const first = await hub.waitForCount(1);
    assert.equal(first.viewing, false, 'chưa ai nối mà đã báo đang xem');

    const token = await phone.ky({ sessionId: 's-view', host: `127.0.0.1:${port}` });
    c = await connect(`ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c.ok, true);
    assert.equal(await waitViewing(true), true,
      'nối vào rồi mà hub vẫn không biết là đang xem — thông báo sẽ vẫn nổ trong lúc người dùng đang nhìn');

    // The half that actually matters: hidden must travel too, or a phone left
    // with the tab open never gets a notification again.
    c.ws.send(JSON.stringify({ type: 'ccrc_visibility', visible: false }));
    assert.equal(await waitViewing(false), true,
      'trang ẩn đi mà hub vẫn tưởng đang xem — người dùng mất thông báo mà không hiểu vì sao');

    c.ws.send(JSON.stringify({ type: 'ccrc_visibility', visible: true }));
    assert.equal(await waitViewing(true), true);

    // Closing the page is the other way to stop watching.
    const before = hub.bodies.length;
    c.ws.close();
    const t0 = Date.now();
    for (;;) {
      if (hub.bodies.slice(before).some((b) => b.viewing === false)) break;
      assert.ok(Date.now() - t0 < 4000, 'đóng trang mà hub vẫn tưởng đang xem');
      await sleep(50);
    }
  } finally {
    if (d) {
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { process.kill(d.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(d.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(300);
    // The GROUP session the daemon created is a session of its own — killing
    // the daemon with SIGKILL skips its cleanup, so it outlives the test and
    // holds a pty. Enough of those accumulating is what exhausted this
    // machine's ptys once already, so sweep by name.
    try {
      const names = execFileSync(T, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
        .split('\n').filter((n) => n.startsWith(sess));
      for (const n of names) { try { execFileSync(T, ['kill-session', '-t', n]); } catch {} }
    } catch { /* no server left at all — nothing to sweep */ }
    hub.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// --- Đợt sửa cuối, mục 1: HAI daemon trong HAI PANE của CÙNG một phiên tmux --
//
// Đây là bản dựng lại đầy đủ của lỗi, ở tầng daemon thật với trình duyệt thật
// — không phải chỉ ở tầng hàm tmux (xem tmux.test.js cho phần đó).
//
// Vì sao hai phiên tmux RIÊNG thì không lộ: mỗi phiên suy ra một tên phiên
// nhóm khác nhau nên không bao giờ đụng nhau, và lần nghiệm thu trước chạy
// đúng như vậy. Hai PANE trong CÙNG MỘT phiên thì cả hai daemon suy ra cùng
// một phiên gốc ⇒ cùng một tên phiên nhóm ứng viên. Dấu `@ccrc_group` chỉ
// chứng minh "ccrc-term tạo ra cái này", nên daemon B giết phiên nhóm ĐANG
// SỐNG của daemon A rồi chiếm tên: trình duyệt của A rơi với
// `tmux control mode đã đóng bất ngờ`. Hai pane một phiên là cách làm việc
// hoàn toàn bình thường, nên đây là đường chính, không phải ca biên.
test('hai daemon ở hai pane của CÙNG một phiên tmux: cả hai trình duyệt cùng sống, mỗi bên một phiên nhóm riêng', async (t) => {
  const T = tmuxBin();
  const sess = `ccrc-2pane-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  execFileSync(T, ['new-window', '-t', `=${sess}`]);
  const panes = execFileSync(T, ['list-panes', '-s', '-t', `=${sess}`, '-F', '#{pane_id}'], { encoding: 'utf8' })
    .trim().split('\n');
  assert.equal(panes.length, 2, 'điều kiện đầu vào: đúng hai pane trong MỘT phiên tmux');

  // Mỗi daemon một HOME riêng, nên mỗi daemon cũng cần thiết bị (và
  // devices.json) riêng của chính nó.
  const spawnFor = async (pane, sessionId, port) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-2pane-home-'));
    const phone = await taoThietBiTest();
    ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);
    const proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: sessionId,
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    return { proc, phone };
  };

  const groupA = `${sess}-ccrc-web`;
  const groupB = `${sess}-ccrc-web-2`;
  let dA, dB, cA, cB;
  try {
    const [portA, portB] = [await freePort(), await freePort()];
    const a = await spawnFor(panes[0], 's-2pane-a', portA);
    const b = await spawnFor(panes[1], 's-2pane-b', portB);
    dA = a.proc;
    dB = b.proc;
    await waitPortListening(portA, dA);
    await waitPortListening(portB, dB);

    // Trình duyệt A nối trước — đây là cái phải SỐNG SÓT qua việc B bật lên.
    const tokenA = await a.phone.ky({ sessionId: 's-2pane-a', host: `127.0.0.1:${portA}` });
    cA = await connect(`ws://127.0.0.1:${portA}/attach?token=${encodeURIComponent(tokenA)}`);
    assert.equal(cA.ok, true, 'trình duyệt A phải nối được');
    await sleep(500);
    assert.equal(hasSession(groupA), true, 'điều kiện đầu vào: A phải đã tạo phiên nhóm của mình');

    const tokenB = await b.phone.ky({ sessionId: 's-2pane-b', host: `127.0.0.1:${portB}` });
    cB = await connect(`ws://127.0.0.1:${portB}/attach?token=${encodeURIComponent(tokenB)}`);
    assert.equal(cB.ok, true, 'trình duyệt B phải nối được');
    await sleep(800);

    // Đây là lỗi, nói thẳng: trước bản sửa, A rơi ngay lúc B nối vào.
    assert.equal(cA.ws.readyState, WebSocket.OPEN,
      'trình duyệt A phải VẪN mở sau khi B nối — trước bản sửa nó rơi với "tmux control mode đã đóng bất ngờ"');
    assert.equal(cB.ws.readyState, WebSocket.OPEN, 'trình duyệt B cũng phải mở');
    assert.equal(hasSession(groupA), true, 'phiên nhóm của A không được bị B giết để chiếm tên');
    assert.equal(hasSession(groupB), true, 'B phải lùi sang tên ứng viên kế tiếp và tạo phiên nhóm riêng');

    const markerA = execFileSync(T, ['show-options', '-v', '-t', groupA, '@ccrc_group'], { encoding: 'utf8' }).trim();
    const markerB = execFileSync(T, ['show-options', '-v', '-t', groupB, '@ccrc_group'], { encoding: 'utf8' }).trim();
    assert.notEqual(markerA, markerB, 'hai phiên nhóm phải mang dấu của hai lần chạy khác nhau');
    assert.ok(markerA && markerB, 'cả hai phiên nhóm đều phải có dấu');

    // Mỗi daemon chỉ được chuyển tiếp pane CỦA MÌNH, dù hai phiên nhóm cùng
    // chứa cả hai cửa sổ (phiên nhóm chia sẻ toàn bộ danh sách cửa sổ của
    // phiên gốc). Kiểm bằng NỘI DUNG, không phải bằng việc nối thành công.
    const mA = `CCRC-2PANE-A-${process.pid}`;
    const mB = `CCRC-2PANE-B-${process.pid}`;
    cA.data.length = 0;
    cB.data.length = 0;
    execFileSync(T, ['send-keys', '-t', panes[0], `echo ${mA}`, 'Enter']);
    execFileSync(T, ['send-keys', '-t', panes[1], `echo ${mB}`, 'Enter']);
    await sleep(800);
    assert.match(cA.data.join(''), new RegExp(mA), 'A phải nhận được nội dung pane của chính nó');
    assert.doesNotMatch(cA.data.join(''), new RegExp(mB), 'A không được nhận nội dung pane của B');
    assert.match(cB.data.join(''), new RegExp(mB), 'B phải nhận được nội dung pane của chính nó');
    assert.doesNotMatch(cB.data.join(''), new RegExp(mA), 'B không được nhận nội dung pane của A');

    // Tắt A một cách bình thường (SIGTERM ⇒ shutdown dọn phiên nhóm của
    // chính nó): B phải không hề hấn gì.
    process.kill(-dA.pid, 'SIGTERM');
    await sleep(1000);
    assert.equal(hasSession(groupA), false, 'A tắt thì phiên nhóm của A phải được dọn');
    assert.equal(hasSession(groupB), true, 'tắt A KHÔNG được kéo theo phiên nhóm của B');
    assert.equal(cB.ws.readyState, WebSocket.OPEN, 'trình duyệt B phải vẫn mở sau khi A tắt');
    assert.equal(paneAlive(panes[1]), true, 'pane của B phải còn sống');
    assert.equal(hasSession(sess), true, 'phiên gốc của người dùng không được đụng tới');
  } finally {
    for (const c of [cA, cB]) { try { c?.ws?.close(); } catch {} }
    await sleep(200);
    for (const d of [dA, dB]) {
      if (!d) continue;
      try { process.kill(-d.pid, 'SIGKILL'); } catch {}
      try { process.kill(d.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(d.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(400); // để tmux -C thoát hẳn trước khi kill-session
    for (const g of [groupA, groupB]) { try { execFileSync(T, ['kill-session', '-t', `=${g}`]); } catch {} }
    try { execFileSync(T, ['kill-session', '-t', `=${sess}`]); } catch {}
  }
});

// --- Task 8: daemon xác minh token v2, không còn phụ thuộc bí mật hub ký ----
//
// Dựng: một tmux session thật, một HOME tạm có devices.json, và một daemon
// trỏ vào pane đó. Trả về mọi thứ cần cho test + hàm dọn.
//
// `devices` là mảng ghi vào devices.json; `rawDevices` ghi thẳng chuỗi (để
// dựng ca file hỏng). CCRC_TERM_NO_HUB=1 vì mấy test này không nói gì tới hub.
async function dungCanh({ devices = [], rawDevices } = {}) {
  const T = tmuxBin();
  const sess = `ccrc-pair-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);

  // Task 15 review: waitPortListening (below) throws when the daemon never
  // binds — before this fix, a throw here left `sess`'s tmux session (and
  // the home tmp dir) leaked forever, since callers only get a `dong()` to
  // clean up with once this function RETURNS. Same shape as helpers.mjs's
  // startDaemon: wrap setup in try/catch, reap on failure, rethrow.
  let pane, home, proc, port;
  try {
    pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'],
      { encoding: 'utf8' }).trim();

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-pair-'));
    ghiDevices(home, devices, rawDevices);

    port = await freePort();
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-pair',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);
  } catch (e) {
    if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} try { proc.kill('SIGKILL'); } catch {} }
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
    throw e;
  }

  return {
    port,
    home,
    proc,
    async dong() {
      // `proc` was spawned `detached: true` (leader of its own process
      // group), exactly like helpers.mjs's startDaemon — group-kill it in
      // ONE call instead of killing `proc.pid` and only THEN pgrep-ing for
      // its children, which races: pgrep is a separate process this has to
      // spawn and wait for, and by the time it runs the daemon may already
      // be dead, reparenting its `tmux -C` child to init before pgrep -P
      // <dead pid> ever sees it. See helpers.mjs's stop() for the full
      // measurement behind this fix.
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* đã chết */ }
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* đã chết */ } }
      try { proc.kill('SIGKILL'); } catch { /* đã chết */ }
      await sleep(200);
      try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch { /* không có */ }
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* không có */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* thôi */ }
    },
  };
}

test('token ký bởi thiết bị ĐÃ GHÉP mở được WebSocket', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }],
  });
  try {
    const token = await phone.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'thiết bị đã ghép phải mở được');
    ws.ws.close();
  } finally { await c.dong(); }
});

// Task 9b: một khoá lạ (không nằm trong devices.json) rơi vào reason
// 'unknown_device' — kể từ Task 9b daemon bắt tay xong rồi mới đóng bằng mã
// 4003 riêng (xem test "thiết bị CHƯA GHÉP" ở trên), KHÔNG còn là 401 câm.
// Trước Task 9b test này khẳng định `ws.ok === false`; đó chính là hành vi cũ
// mà Task 9b cố tình thay đổi, nên assertion phải đổi theo.
test('token ký bởi thiết bị CHƯA ghép: bắt tay xong rồi đóng bằng 4003, không mở kết nối thật', async () => {
  const daGhep = await taoThietBiTest();
  const la = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: daGhep.pubKey, label: 'da-ghep', pairedAt: 1 }],
  });
  try {
    const token = await la.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'phải bắt tay được thì trình duyệt mới đọc được mã đóng (Task 9b)');
    const ev = await waitClose(ws.ws);
    assert.equal(ev.code, 4003, 'khoá lạ (không nằm trong devices.json) phải bị đóng bằng mã riêng, không phải mở kết nối thật');
  } finally { await c.dong(); }
});

// Cũng là 'unknown_device' — file hỏng đọc thành "chưa ghép thiết bị nào"
// (src/devices.js), nên từ Task 9b nó cũng bắt tay rồi mới đóng bằng 4003,
// không còn là 401 câm. Điều bất biến thật sự của test này — cái không được
// đổi — là daemon không được sập vì một file hỏng.
test('devices.json hỏng → bắt tay rồi đóng bằng 4003, daemon KHÔNG sập', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({ rawDevices: '{ day khong phai json' });
  try {
    const token = await phone.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'phải bắt tay được thì trình duyệt mới đọc được mã đóng (Task 9b)');
    const ev = await waitClose(ws.ws);
    assert.equal(ev.code, 4003, 'file devices.json hỏng đọc thành "chưa ghép" — cùng nhánh unknown_device');
    // Daemon phải còn sống: một file cấu hình hỏng nghĩa là "chưa ghép thiết
    // bị nào", không phải một tiến trình chết.
    const r = await fetch(`http://127.0.0.1:${c.port}/`);
    assert.equal(r.status, 200, 'một file hỏng không được giết daemon');
  } finally { await c.dong(); }
});

test('token dùng lại lần hai bị từ chối — nonce một lần vẫn còn hiệu lực', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }],
  });
  try {
    const token = await phone.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const c1 = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c1.ok, true);
    c1.ws.close();
    await sleep(200);
    const c2 = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(c2.ok, false, 'token một lần là một lần — dù chữ ký vẫn còn hợp lệ');
  } finally { await c.dong(); }
});

// Item 4, review toàn nhánh (4): "một token GIẢ MẠO không được đốt một nonce
// nó chưa từng nắm giữ". Tính chất này dựa TRỌN VẸN vào THỨ TỰ kiểm trong
// ticket.js: `verifySignature()` chạy TRƯỚC mọi phép kiểm sid/host/exp, và
// `nonces.use()` (ccrc-term.js) chỉ chạy khi `v.ok === true` — tức chỉ SAU
// khi chữ ký đã đúng. Nếu thứ tự đó bị đảo (hay, nghiêm trọng hơn, phép kiểm
// chữ ký bị bỏ qua trong lúc "đơn giản hoá"), một token bị GIẢ MẠO (chữ ký
// sai) nhưng mang đúng sid/host/nonce của một token thật sẽ được `ok:true`
// và ĐỐT nonce đó — khiến token THẬT mang cùng nonce, ký ĐÚNG, chưa từng
// dùng, bị từ chối vì "đã dùng rồi". Test dưới đây bắt đúng hệ quả đó, không
// chỉ so sánh chuỗi "reason" trả về (thứ một refactor vô hại vẫn có thể đổi
// mà không phá tính chất bảo mật).
test('token GIẢ MẠO (sai chữ ký) không được đốt nonce nó mang — một token THẬT dùng lại đúng nonce đó vẫn phải mở được', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({
    devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }],
  });
  try {
    const nonceChung = 'nonce-dung-chung-cho-ca-hai-token';
    const host = `127.0.0.1:${c.port}`;

    // 1) Token GIẢ MẠO: ký hợp lệ rồi lật một byte GIỮA chữ ký (không phải
    // ký tự cuối — xem chú thích ở test "token sai chữ ký bị từ chối" cho lý
    // do), giữ nguyên payload — cùng sid, cùng host, cùng nonceChung, chưa
    // hết hạn.
    const gocToken = await phone.ky({ sessionId: 's-pair', host, nonce: nonceChung });
    const [v, b64, sig] = gocToken.split('.');
    const sigBuf = Buffer.from(sig, 'base64url');
    sigBuf[Math.floor(sigBuf.length / 2)] ^= 0xff;
    const tokenGia = `${v}.${b64}.${sigBuf.toString('base64url')}`;

    const wsGia = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(tokenGia)}`);
    assert.equal(wsGia.ok, false, 'token giả mạo phải bị từ chối');

    // 2) Token THẬT, ký LẠI từ đầu nhưng CỐ Ý mang ĐÚNG nonceChung — nếu
    // bước 1 (giả mạo) đã lỡ đốt nonce này, token thật này sẽ bị từ chối như
    // thể đã dùng rồi, dù nó chưa từng đi qua daemon.
    const tokenThat = await phone.ky({ sessionId: 's-pair', host, nonce: nonceChung });
    const wsThat = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(tokenThat)}`);
    assert.equal(wsThat.ok, true,
      'token giả mạo không được đốt nonce nó mang — token THẬT dùng lại đúng nonce đó vẫn phải mở được bình thường');
  } finally { await c.dong(); }
});

// --- Task 9b: thiết bị chưa ghép phải BẮT TAY rồi mới đóng, không phải 401 câm
//
// Trình duyệt không đọc được mã trạng thái HTTP của một cú bắt tay WebSocket
// bị từ chối — chỉ thấy `error` rồi `close` mã 1006, y hệt rớt mạng. Muốn nói
// được "bạn chưa ghép máy này" thì phải bắt tay xong rồi mới đóng, bằng một mã
// đóng riêng của ứng dụng (4003) mà trình duyệt đọc được.

test('thiết bị CHƯA GHÉP: daemon bắt tay rồi đóng bằng mã 4003, không phải 401 câm', async () => {
  const la = await taoThietBiTest();
  const c = await dungCanh({ devices: [] }); // chưa ghép cái nào
  try {
    const token = await la.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, true, 'phải bắt tay được thì trình duyệt mới đọc được mã đóng');
    const ev = await waitClose(ws.ws);
    assert.equal(ev.code, 4003,
      'mã riêng là thứ DUY NHẤT phân biệt được "chưa ghép" với "rớt mạng" ở phía trình duyệt');
  } finally { await c.dong(); }
});

test('chữ ký SAI vẫn bị từ chối thẳng ở bắt tay, KHÔNG được giải thích gì', async () => {
  // Chữ ký sai nghĩa là có kẻ đang ký bậy. Không bắt tay với nó, và không nói
  // cho nó biết vì sao — khác hẳn một người dùng thật quên ghép máy.
  const phone = await taoThietBiTest();
  const c = await dungCanh({ devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }] });
  try {
    const token = await phone.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const [v, b64, sig] = token.split('.');
    const buf = Buffer.from(sig, 'base64url');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const gia = `${v}.${b64}.${buf.toString('base64url')}`;
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(gia)}`);
    assert.equal(ws.ok, false, 'chữ ký sai không được bắt tay');
  } finally { await c.dong(); }
});

// --- C3 (spec §13): daemon THẬT từ chối token ký cho MÁY KHÁC -------------
//
// Không phải một test thuần tuý ở tầng ticket.js (xem ticket-interop.test.js
// cho phần đó) — đây là daemon thật, WebSocket thật, đúng đường mà một hub bị
// chiếm sẽ đi qua: token ký cho một host không phải host daemon này quảng bá
// phải chết ở bắt tay bằng 401, KHÔNG PHẢI 4003 — 4003 nghĩa là "chưa ghép
// máy này", còn đây là chuyện hoàn toàn khác: thiết bị ĐÃ ghép, chữ ký ĐÚNG,
// chỉ có host khai trong token là sai.
test('token ký cho host KHÁC daemon này quảng bá bị từ chối bằng 401 (không phải 4003) — token đúng host mở được', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({ devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }] });
  try {
    const saiHost = await phone.ky({ sessionId: 's-pair', host: '100.99.99.99:1' });
    const wsSai = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(saiHost)}`);
    assert.equal(wsSai.ok, false,
      'token ký cho host khác không được bắt tay — đây không phải chuyện chưa ghép máy (4003), nó chết thẳng ở 401');

    const dungHost = await phone.ky({ sessionId: 's-pair', host: `127.0.0.1:${c.port}` });
    const wsDung = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(dungHost)}`);
    assert.equal(wsDung.ok, true, 'token ký đúng host daemon này quảng bá phải mở được bình thường');
    wsDung.ws.close();
  } finally { await c.dong(); }
});

test('nhịp tim KHÔNG còn mang trường secret', async (t) => {
  const T = tmuxBin();
  const sess = `ccrc-nosecret-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'],
    { encoding: 'utf8' }).trim();

  const hub = await captureRegisterHub();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-nosecret-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hub.base}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);

  const port = await freePort();
  let proc;
  try {
    // Cố tình KHÔNG đặt CCRC_TERM_NO_HUB: đây chính là đường nhịp tim thật.
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-nosecret',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_URL: `http://100.86.1.2:${port}/`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);

    const body = await hub.waitForCount(1);
    assert.equal(body.secret, undefined,
      'gửi bí mật lên hub là đúng thứ thiết kế này vừa bỏ đi — còn gửi nghĩa là chưa bỏ');
    assert.ok(body.sessionId && body.machine && body.url,
      'phần còn lại của nhịp tim phải giữ nguyên');
    assert.equal(typeof body.label, 'string');
  } finally {
    try { proc && process.kill(proc.pid, 'SIGKILL'); } catch { /* đã chết */ }
    if (proc) {
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* đã chết */ } }
    }
    await sleep(200);
    try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch { /* không có */ }
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* không có */ }
    hub.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* thôi */ }
  }
});

// --- Review sau Task 14: ownHost và CCRC_TERM_URL -------------------------
//
// ownHost (expectedHost của verifyAttachToken) và publicUrl (URL daemon báo
// lên hub) từng có thể LỆCH NHAU khi CCRC_TERM_BIND được set nhưng
// CCRC_TERM_URL trỏ tới một host khác: publicUrl ưu tiên CCRC_TERM_URL (vì
// hostIp là null trong đường CCRC_TERM_BIND), và ownHost đọc thẳng biến môi
// trường — nên hai giá trị NÊN khớp nhau trong tổ hợp này, nhưng chỉ vì
// chúng tình cờ đọc cùng một nguồn theo hai cách khác nhau. Test này pin hợp
// đồng thật sự: ownHost phải là host của đúng CÁI URL daemon đã báo cho hub
// (publicUrl), không phải một phép đọc env riêng có thể trôi khỏi nó.
test('CCRC_TERM_URL: token ký cho đúng host trong CCRC_TERM_URL được chấp nhận, ký cho bind address thì không', async (t) => {
  const T = tmuxBin();
  const sess = `ccrc-turl-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-turl-home-'));
  const phone = await taoThietBiTest();
  ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

  let proc;
  try {
    const port = await freePort();
    const hostThat = `100.86.1.2:${port}`; // host CCRC_TERM_URL khai — cái phone thực sự được bảo đi tới
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-turl',
        CCRC_TERM_PORT: String(port),
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_URL: `http://${hostThat}/`,
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitPortListening(port, proc);

    const tokenDung = await phone.ky({ sessionId: 's-turl', host: hostThat });
    const okDung = await connect(`ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(tokenDung)}`);
    assert.equal(okDung.ok, true,
      `token ký cho host trong CCRC_TERM_URL (${hostThat}) phải mở được — daemon phải chấp nhận đúng cái nó báo cho hub, bị từ chối vì cấu hình lệch`);
    okDung.ws.close();

    // Host của chính bind address (127.0.0.1:port) KHÔNG phải cái phone được
    // bảo đi tới trong tổ hợp này — nếu ownHost lỡ đọc nhầm nguồn (bindAddr
    // thay vì publicUrl/CCRC_TERM_URL), test trên đã không bắt được, nhưng
    // test này thì có: một token ký cho địa chỉ SAI vẫn phải chết.
    const tokenSai = await phone.ky({ sessionId: 's-turl', host: `127.0.0.1:${port}` });
    const saiKet = await connect(`ws://127.0.0.1:${port}/attach?token=${encodeURIComponent(tokenSai)}`);
    assert.equal(saiKet.ok, false,
      'token ký cho bind address (không phải CCRC_TERM_URL) phải bị từ chối — đó không phải host daemon báo cho hub');
  } finally {
    if (proc) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(200);
    try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch {}
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// CCRC_TERM_URL hỏng từng khiến `new URL()` ném BÊN TRONG callback bất đồng
// bộ của server.listen() — SAU khi cổng đã bind thật, TRƯỚC dòng log
// "[term] nghe…" mà `/remote on` chờ để biết daemon đã lên. Kết quả đo được:
// tiến trình chết với một stack trace thô, và phía CLI chỉ thấy im lặng cho
// tới khi hết giờ chờ của chính nó — không một câu nào nói "CCRC_TERM_URL sai
// định dạng". Phải chết NGAY, ở đầu tiến trình, với một câu đặt tên đúng biến.
test('CCRC_TERM_URL hỏng định dạng: daemon thoát ngay với một câu gọi tên biến, không đợi tới lúc bind cổng rồi chết câm', async (t) => {
  const T = tmuxBin();
  const sess = `ccrc-turl-hong-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  let proc;
  let log = '';
  try {
    proc = spawn('node', [DAEMON], {
      env: {
        ...process.env,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-turl-hong',
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_URL: 'khong-phai-mot-url',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    proc.stdout.on('data', (d) => { log += d; });
    proc.stderr.on('data', (d) => { log += d; });

    const exited = await waitExit(proc, EVENT_TIMEOUT_MS);
    assert.equal(exited, true, 'CCRC_TERM_URL hỏng phải khiến daemon thoát — không được treo chờ /remote on hết giờ');
    assert.notEqual(proc.exitCode, 0, 'phải thoát với mã lỗi, không phải 0');
    assert.match(log, /CCRC_TERM_URL/,
      `thông báo lỗi phải gọi tên đúng biến hỏng, không phải một stack trace chung chung. Log thực tế:\n${log}`);
    assert.doesNotMatch(log, /\[term\] nghe/,
      'phải chết TRƯỚC khi báo đang nghe cổng — nếu dòng này xuất hiện thì việc validate đã tới quá muộn');
  } finally {
    if (proc) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(200);
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
  }
});

// Item 3, review toàn nhánh: bản vá ownHost/publicUrl (ec9fbae, "Fix
// ownHost/publicUrl divergence…") trước đó không có hồi quy — một người
// triển khai từng cho rằng không TEST được vì phải tái tạo `hostIp` sự thật
// (checkPrereqs() trả `ok:true`) nghĩa là cần Tailscale THẬT. SAI: checkPrereqs()
// tôn trọng CCRC_TAILSCALE_BIN (src/tailscale.js), và term/test/tailscale.test.js
// đã có sẵn `fakeTailscale()`. Chỉ cần spawn daemon với CCRC_TERM_BIND KHÔNG đặt
// (rỗng/falsy → nhánh production chạy) và một `tailscale status --json` giả báo
// một IP CGNAT — `hostIp` vừa có giá trị THẬT (đi qua checkPrereqs()) vừa BIND
// ĐƯỢC, không cần đăng nhập Tailscale, không cần máy này có tailnet.
//
// IP dùng để bind THẬT phải vừa qua được phép kiểm CGNAT (item 2, cùng
// review) vừa BIND ĐƯỢC — một IP CGNAT bịa (vd 100.99.9.9) không bind được
// trên macOS/Linux nếu không phải một interface thật (không có quyền tạo
// alias loopback mà không cần sudo, và tự ý sudo không phải việc của test
// này). Điểm DUY NHẤT vừa thật vừa bind được mà không cần bịa gì là chính
// địa chỉ Tailscale THẬT của máy đang chạy test — nên test gọi thẳng
// `checkPrereqs()` (KHÔNG đối số, tức tự tìm `tailscale` thật trên máy) để
// HỎI máy đang chạy test đang có địa chỉ gì, rồi lấy đúng số đó feed lại vào
// script `fake-tailscale` của DAEMON. Daemon vẫn không bao giờ gọi tailscale
// thật (nó chỉ thấy CCRC_TAILSCALE_BIN trỏ tới script giả) — chỉ riêng phép
// đo "máy này có địa chỉ Tailscale thật nào không" mới chạm tới tailscale
// thật, và chỉ để tránh phải hardcode một chuỗi chỉ đúng trên một máy.
//
// Máy không cài/không đăng nhập Tailscale (một máy CI, máy của một người
// đóng góp khác) là một trạng thái HỢP LỆ — không phải lỗi test. Khi đó
// `checkPrereqs()` trả `ok:false` và test tự bỏ qua (`t.skip`) kèm lý do rõ
// ràng, thay vì fail vì lý do không liên quan gì tới điều đang được canh.
//
// Trước bản vá ec9fbae: `ownHost = process.env.CCRC_TERM_URL ? new
// URL(...).host : ...` — đọc THẲNG biến môi trường, bỏ qua hostIp hoàn toàn.
// Tổ hợp "hostIp thật + CCRC_TERM_URL cũng đặt" khi đó đảo ngược y hệt mô tả:
// token ký cho hostIp:port bị từ chối, token ký cho CCRC_TERM_URL lại mở
// được — dù publicUrl báo lên hub (và mọi client thật sẽ ký theo) luôn là
// hostIp:port trong tổ hợp này (dòng `if (hostIp) { publicUrl = ... }` chạy
// TRƯỚC, ghi đè CCRC_TERM_URL). Nghĩa là daemon chấp nhận đúng cái KHÔNG được
// báo cho hub, và từ chối đúng cái ĐÃ báo — một hub (hoặc CCRC_TERM_URL cấu
// hình lệch) khi đó ký được token cho một host khác host thật đang bind.
function fakeTailscaleReportingIp(ip) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-fake-'));
  const bin = path.join(d, 'fake-tailscale');
  const statusJson = JSON.stringify({
    BackendState: 'Running',
    Self: { TailscaleIPs: [ip] },
  });
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${statusJson}\nJSON\n`, { mode: 0o755 });
  return bin;
}

function waitListeningOn(host, port, proc, timeoutMs = EVENT_TIMEOUT_MS) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect({ port, host });
      const fail = () => {
        s.destroy();
        if (proc.exitCode !== null || proc.signalCode !== null) {
          reject(new Error(`daemon thoát trước khi lắng nghe ${host}:${port}`));
          return;
        }
        if (Date.now() - t0 > timeoutMs) { reject(new Error(`hết giờ chờ ${host}:${port}`)); return; }
        setTimeout(tryOnce, 25);
      };
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', fail);
    };
    tryOnce();
  });
}

test('CCRC_TERM_URL cùng lúc với hostIp THẬT (checkPrereqs(), không CCRC_TERM_BIND): hostIp:port mở được, CCRC_TERM_URL bị từ chối', async (t) => {
  // Hỏi Tailscale THẬT của máy đang chạy test — không hardcode IP nào, vì
  // một chuỗi cố định chỉ đúng trên đúng một máy (xem chú thích ở trên).
  // Không có Tailscale/chưa đăng nhập là một trạng thái HỢP LỆ của máy chạy
  // test (CI, máy một người đóng góp khác) — bỏ qua rõ ràng, không fail vì
  // lý do không liên quan.
  const pre = checkPrereqs();
  if (!pre.ok) {
    t.skip(`không có Tailscale thật trên máy này để lấy IP CGNAT hợp lệ (reason: ${pre.reason}) — bỏ qua, đây không phải lỗi của code đang được canh`);
    return;
  }
  const REAL_HOST_IP = pre.ip;

  const T = tmuxBin();
  const sess = `ccrc-hostip-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  safeguardSessionsAfter(t, sess);
  const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'], { encoding: 'utf8' }).trim();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hostip-home-'));
  const phone = await taoThietBiTest();
  ghiDevices(home, [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }]);

  const fakeBin = fakeTailscaleReportingIp(REAL_HOST_IP);

  let proc;
  try {
    const port = await freePort();
    const env = { ...process.env, HOME: home };
    delete env.CCRC_TERM_BIND; // rỗng/vắng mặt → nhánh checkPrereqs() thật chạy (ccrc-term.js)
    proc = spawn('node', [DAEMON], {
      env: {
        ...env,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: 's-hostip',
        CCRC_TERM_PORT: String(port),
        CCRC_TAILSCALE_BIN: fakeBin,
        // Một host CGNAT-shaped KHÁC hẳn REAL_HOST_IP — không cần bind được,
        // daemon không bao giờ listen() trên nó, chỉ khai nó ra (và, đúng
        // hành vi ĐÃ SỬA, bị bỏ qua vì hostIp thật thắng).
        CCRC_TERM_URL: 'http://100.77.1.2:1234/',
        CCRC_TERM_NO_HUB: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitListeningOn(REAL_HOST_IP, port, proc);

    const tokenHostIp = await phone.ky({ sessionId: 's-hostip', host: `${REAL_HOST_IP}:${port}` });
    const okHostIp = await connect(`ws://${REAL_HOST_IP}:${port}/attach?token=${encodeURIComponent(tokenHostIp)}`);
    assert.equal(okHostIp.ok, true,
      'token ký cho hostIp:port (đúng cái publicUrl báo lên hub trong tổ hợp này) phải mở được');
    okHostIp.ws.close();

    const tokenTermUrl = await phone.ky({ sessionId: 's-hostip', host: '100.77.1.2:1234' });
    const okTermUrl = await connect(`ws://${REAL_HOST_IP}:${port}/attach?token=${encodeURIComponent(tokenTermUrl)}`);
    assert.equal(okTermUrl.ok, false,
      'token ký cho host của CCRC_TERM_URL phải bị từ chối — hostIp thật LUÔN thắng khi checkPrereqs() thành công, CCRC_TERM_URL bị bỏ qua trong tổ hợp này');
  } finally {
    if (proc) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      try { process.kill(proc.pid, 'SIGKILL'); } catch {}
      for (const pid of childPids(proc.pid)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    await sleep(200);
    try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch {}
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// Một wrong_host là 401 câm phía trình duyệt (xem test C3 ở trên) — không có
// mã đóng riêng nào giải thích, khác hẳn unknown_device/4003. Nếu daemon
// không ghi gì ra log thì người gỡ rối trên máy dev không có cách nào biết
// VÌ SAO "Mở terminal" không hoạt động. Test này khẳng định daemon ghi được cả
// hai host — cái token khai và cái daemon chấp nhận — không chỉ một chữ
// "rejected" trống rỗng.
test('token wrong_host: daemon ghi log lý do kèm CẢ HAI host, không phải một 401 câm không dấu vết', async () => {
  const phone = await taoThietBiTest();
  const c = await dungCanh({ devices: [{ pubKey: phone.pubKey, label: 'test', pairedAt: 1 }] });
  try {
    let log = '';
    c.proc.stdout.on('data', (d) => { log += d; });
    c.proc.stderr.on('data', (d) => { log += d; });

    const hostSai = '100.55.55.55:1';
    const token = await phone.ky({ sessionId: 's-pair', host: hostSai });
    const ws = await connect(`ws://127.0.0.1:${c.port}/attach?token=${encodeURIComponent(token)}`);
    assert.equal(ws.ok, false, 'token ký cho host khác vẫn phải bị từ chối');

    await sleep(200); // để dòng log kịp bay qua pipe
    assert.match(log, /wrong_host/, `daemon phải ghi lý do wrong_host ra log. Log thực tế:\n${log}`);
    assert.match(log, new RegExp(hostSai.replace(/\./g, '\\.')),
      `daemon phải ghi host TOKEN khai (${hostSai}) ra log. Log thực tế:\n${log}`);
    assert.match(log, new RegExp(`127\\.0\\.0\\.1:${c.port}`),
      `daemon phải ghi host CHÍNH NÓ chấp nhận (127.0.0.1:${c.port}) ra log. Log thực tế:\n${log}`);
  } finally { await c.dong(); }
});
