// `/remote off` phải dừng daemon TỬ TẾ trên Windows — bài đo đầu-cuối.
//
// Đo trên bản CHƯA vá (2026-08-18, máy Windows thật, cùng kịch bản chạy song
// song trên macOS để so):
//
//   nền     mã đóng WebSocket   hub nhận unregister   file sổ phiên
//   macOS   4001 sau 113ms      có                    đã xoá
//   Windows 1006 sau 500ms      KHÔNG                 CÒN NGUYÊN
//
// Cả ba sai vì cùng một lý do: `process.kill(pid, 'SIGTERM')` trên Windows là
// `TerminateProcess`, không handler nào chạy, nên `shutdown()` bị bỏ qua trọn
// vẹn. Và 1006 là "đứt bất thường" — cùng mã mà rớt wifi sinh ra — nên trang
// web không phân biệt được và nối lại mãi mãi vào một phiên đã chết.
//
// Ba thứ ấy đo trong CÙNG một lượt chạy, không tách thành ba bài: chúng là ba
// biểu hiện của đúng MỘT câu hỏi — `shutdown()` có chạy không — và tách ra thì
// mỗi bài lại phải dựng lại nguyên bộ máy (host ConPTY + daemon + hub + trình
// duyệt).
//
// Bộ này nằm riêng khỏi remote-win.test.js để không sửa một file test đã có.
// Nó CHỈ chạy trên Windows: nhánh cần đo đọc sổ host thật và spawn daemon thật,
// và `process.platform` không giả lập được trong một tiến trình con. Phần lý lẽ
// chạy được trên MỌI nền tảng — luật cờ dừng — nằm ở test/win-stop-file.test.js.
//
// Cô lập: mọi thứ dưới đây sống dưới một CCRC_HOME tạm. Đặt HOME là vô dụng
// trên Windows (os.homedir() đọc USERPROFILE), và một lần bộ test đã ghi thẳng
// vào ~/.claude/settings.json thật của người dùng vì tưởng mình ở trong hộp cát.
// Xem shared/home.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { taoThietBiTest, ghiDevices } from './helpers.mjs';

const CHI_WINDOWS = process.platform !== 'win32';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const CLI = path.join(BIN, 'ccrc-term-cli.js');
const HOST = path.join(BIN, 'ccrc-host.js');

const daDung = [];
after(() => {
  for (const d of daDung) {
    // Dọn KHÔNG được ném: trên Windows một tiến trình vừa chết còn giữ handle
    // thêm một nhịp. Rác còn lại là rác, không phải hỏng.
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* để lại thì thôi */ }
  }
});

function nhaTam(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-tt-'));
  daDung.push(home);
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

// Cùng luật với src/host-registry.js: chỉ ESRCH mới là bằng chứng đã chết.
function conSong(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function chay(args, env = {}) {
  return new Promise((r) => execFile(process.execPath, [CLI, ...args],
    { env: { ...process.env, ...env } },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

// Hub giả, trong chính tiến trình test. Không phải "mock cho tiện": không có nó
// thì `unregister` — nửa quan trọng nhất của bài đo — không có chỗ nào để mà
// tới, và bài test sẽ chỉ khẳng định được những gì nằm trên đĩa.
function hubGia() {
  const nhan = [];
  const srv = http.createServer((req, res) => {
    let than = '';
    req.on('data', (d) => { than += d; });
    req.on('end', () => {
      nhan.push({ duongDan: req.url, than });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return {
    nhan,
    async mo() {
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      return srv.address().port;
    },
    dong() { try { srv.close(); } catch { /* chưa mở */ } },
  };
}

// Xin hệ điều hành một cổng không ai dùng, thay vì đoán một con số: một con số
// đoán sẽ đụng sớm muộn, và daemon thua cuộc đua ấy chết với EADDRINUSE trong
// khi bài test vẫn nói chuyện với bất kỳ ai đang trả lời ở cổng đó.
function congTrong() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const ngu = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ một ĐIỀU KIỆN, có hạn chót — không phải một lần ngủ đoán bừa. Cùng lý do
// đã ghi trong test/helpers.mjs: một lần ngủ ngắn hơn thực tế làm mọi khẳng
// định ở đây xanh (hoặc đỏ) vì lý do sai.
async function choToi(dieuKien, hanMs = 20_000) {
  const het = Date.now() + hanMs;
  while (Date.now() < het) {
    if (dieuKien()) return true;
    await ngu(50);
  }
  return false;
}

// Dựng nguyên một phiên remote THẬT: host ConPTY (chạy `cmd.exe` — KHÔNG bao
// giờ Claude Code thật), hub giả, `/remote on` qua chính CLI, rồi một WebSocket
// đóng vai trình duyệt.
async function dungPhienThat(themMoiTruong = {}) {
  const hub = hubGia();
  const congHub = await hub.mo();
  const home = nhaTam(`CCRC_HUB_URL=http://127.0.0.1:${congHub}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-thu\n`);

  const dt = await taoThietBiTest();
  ghiDevices(home, [{ pubKey: dt.pubKey, label: 'test', pairedAt: 1 }]);

  // Host ConPTY THẬT. Hồ sơ host giả (đủ cho những bài `on` trong
  // remote-win.test.js) không đủ ở đây: một WebSocket chỉ mở được khi đầu kia
  // có ống pipe thật để nối vào.
  const SID = `e2e-${process.pid}-${Date.now() % 100000}`;
  const host = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      CCRC_HOME: home,
      CCRC_HOST_SESSION_ID: SID,
      CCRC_HOST_COMMAND: 'cmd.exe',
      CCRC_HOST_CWD: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let nhatKyHost = '';
  host.stdout.on('data', (d) => { nhatKyHost += d; });
  host.stderr.on('data', (d) => { nhatKyHost += d; });
  const hoSo = path.join(home, '.ccrc', 'hosts', `${SID}.json`);
  assert.ok(await choToi(() => fs.existsSync(hoSo)), `host không ghi hồ sơ: ${nhatKyHost}`);

  const cong = await congTrong();
  const moiTruong = {
    CCRC_HOME: home,
    CCRC_HOST_SESSION_ID: SID,
    // Thay Tailscale: máy test không có, và không được phép đòi có.
    CCRC_TERM_BIND: '127.0.0.1',
    // Ghim cổng để ký được token cho đúng `h` trước khi daemon nói gì.
    CCRC_TERM_PORT: String(cong),
    CCRC_TERM_URL: `http://127.0.0.1:${cong}/`,
    ...themMoiTruong,
  };
  const rOn = await chay(['on', 'do e2e'], moiTruong);
  assert.equal(rOn.code, 0, `on thất bại: ${rOn.stdout}${rOn.stderr}`);

  const filePid = path.join(home, '.ccrc', `term-pane-${SID}.pid`);
  assert.equal(fs.existsSync(filePid), true, 'on không ghi file pid');
  const { pid: pidDaemon, sessionId } = JSON.parse(fs.readFileSync(filePid, 'utf8'));
  const fileSo = path.join(home, '.ccrc', 'sessions', `${sessionId}.json`);

  // Trình duyệt giả. `Origin` khớp đúng host daemon quảng bá — chốt Origin của
  // daemon (spec §13) từ chối mọi thứ khác.
  const token = await dt.ky({ sessionId, host: `127.0.0.1:${cong}` });
  const ws = new WebSocket(`ws://127.0.0.1:${cong}/attach?token=${encodeURIComponent(token)}`,
    { headers: { Origin: `http://127.0.0.1:${cong}` } });
  const dong = { ma: null };
  ws.on('close', (ma) => { dong.ma = ma; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('WebSocket không mở được')), 20_000);
    ws.on('open', () => { clearTimeout(t); res(); });
    ws.on('error', (e) => { clearTimeout(t); rej(e); });
  });
  assert.ok(await choToi(() => fs.existsSync(fileSo)), 'daemon chưa ghi sổ phiên');

  return {
    home, SID, hub, dong, pidDaemon, fileSo, filePid, moiTruong,
    don() {
      try { ws.terminate(); } catch { /* đã đứt */ }
      if (pidDaemon) { try { process.kill(pidDaemon, 'SIGTERM'); } catch { /* đã thoát */ } }
      try { host.kill(); } catch { /* đã thoát */ }
      hub.dong();
    },
  };
}

test('off dừng TỬ TẾ: hub nhận unregister, sổ phiên biến mất, trình duyệt nhận 4001',
  { skip: CHI_WINDOWS }, async () => {
    const p = await dungPhienThat();
    try {
      // Nếu daemon chưa từng đăng ký được thì mọi khẳng định dưới đây xanh vì
      // lý do sai — nói ra ngay tại đây thay vì để nó trôi xuống.
      assert.ok(p.hub.nhan.some((e) => /\/api\/terminal\/register/.test(e.duongDan)),
        'hub chưa từng nhận register');

      const r = await chay(['off'], p.moiTruong);
      assert.equal(r.code, 0, `off thất bại: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /✓ Remote ĐÃ TẮT/);

      // 1) Trình duyệt được BÁO là phiên đã hết, không phải bị đứt. 4001 là thứ
      //    duy nhất phân biệt được hai chuyện ấy (term/public/term.js): với 1006
      //    trang web quay vòng "đang nối lại…" mãi mãi vào một phiên đã chết.
      assert.ok(await choToi(() => p.dong.ma !== null), 'WebSocket không hề đóng');
      assert.equal(p.dong.ma, 4001,
        `mã đóng phải là 4001 (phiên đã đóng), nhận được ${p.dong.ma}`);

      // 2) Hub biết phiên đã hết NGAY, không phải sau 60 giây mất nhịp tim rồi
      //    30 phút mới evict.
      assert.ok(await choToi(() => p.hub.nhan.some((e) => /\/api\/terminal\/unregister/.test(e.duongDan))),
        `hub không nhận unregister; chỉ nhận: ${p.hub.nhan.map((e) => e.duongDan).join(', ')}`);

      // 3) Sổ tra phiên cục bộ — thứ hook thông báo đọc — đã sạch.
      assert.ok(await choToi(() => !fs.existsSync(p.fileSo)), 'file sổ phiên còn nguyên sau off');

      assert.equal(fs.existsSync(p.filePid), false, 'file pid còn lại sau off');
      // Và cờ dừng đã được dọn: để lại thì lượt `on` sau dựng daemon mới xong
      // nó tự tắt ngay vì đọc phải mệnh lệnh dành cho người tiền nhiệm.
      assert.equal(fs.existsSync(path.join(p.home, '.ccrc', `term-pane-${p.SID}.stop`)), false,
        'cờ dừng còn sót lại sau off');
    } finally {
      p.don();
    }
  });

test('cơ chế cờ hỏng thì off VẪN dừng được daemon — lưới cuối còn nguyên',
  { skip: CHI_WINDOWS }, async () => {
    // Daemon chạy với người theo dõi tắt hẳn: vẫn là daemon thật, đúng đường
    // dẫn, đúng file pid — chỉ điếc với cờ dừng. Đây đúng là ca "cơ chế mới
    // hỏng" mà định nghĩa xong đòi phải vẫn dừng được, và không dựng được nó
    // nếu không có cái van CCRC_TERM_NO_STOP_WATCH.
    const p = await dungPhienThat({ CCRC_TERM_NO_STOP_WATCH: '1' });
    try {
      // Rút hạn chờ để bài test không ngồi đủ ba giây cho một đường đã biết là
      // sẽ hết giờ.
      const r = await chay(['off'], { ...p.moiTruong, CCRC_TERM_STOP_WAIT_MS: '600' });
      assert.equal(r.code, 0, `off thất bại: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /✓ Remote ĐÃ TẮT/);
      assert.ok(await choToi(() => !conSong(p.pidDaemon)),
        'daemon vẫn sống sau off — lưới cuối đã mất');
      assert.equal(fs.existsSync(p.filePid), false);
    } finally {
      p.don();
    }
  });
