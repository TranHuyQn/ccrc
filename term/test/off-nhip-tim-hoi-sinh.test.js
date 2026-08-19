// Một nhịp tim SAU khi đã đóng dựng lại đúng thứ `shutdown()` vừa dọn.
//
// Bộ này chạy trên macOS/Linux, và nó tồn tại vì một kết luận SAI của tôi ở
// vòng trước: tôi báo cáo rằng cuộc đua này "chưa từng thắng trên macOS, nên
// không đổi hành vi ở đó". Sai. Nó không thắng chỉ vì cái hub giả trong tiến
// trình đo trả lời `/unregister` trong 0ms. Người soát đo lại với hub trả lời
// CHẬM — tức là mọi hub thật, qua Tailscale hay qua internet:
//
//   độ trễ hub trả lời   chưa có chốt                           có chốt
//   0ms                  sạch (đúng cái tôi đo, và tôi tin nó)  sạch
//   5ms                  FILE SỔ PHIÊN CÒN LẠI                  sạch
//   30ms                 còn lại + hub nhận `register` SAU      sạch
//                        `unregister`
//
// Nên đây là một lỗi có THẬT trên macOS, không phải chuyện riêng của Windows:
// `/remote off` để lại file sổ phiên, và với RTT ≥30ms còn đăng ký lại một phiên
// đã chết lên hub — điện thoại tiếp tục thấy nó trong danh sách cho tới khi hub
// đánh dấu `alive:false` ở giây thứ 60.
//
// Đường đi: `shutdown()` đóng mọi client bằng 4001 rồi gọi `removeSession()`
// NGAY trong cùng một lượt. Sự kiện `close` của WebSocket tới ở lượt sau, và
// handler của nó gọi `watchingChanged()` → `sendHeartbeat()` → `beat()` →
// `writeSession()`. Cái quyết định ai xong trước là `tellHub('/unregister')`:
// nó nhanh thì `process.exit(0)` chạy trước cả cuộc đua; nó chậm thì nhịp tim
// kịp ghi lại.
//
// Vì thế bài test dưới đây GIỮ `/unregister` lại 500ms. Đó không phải "làm cho
// dễ đỏ" — đó là mô phỏng một hub thật, và là điều kiện duy nhất khiến bài test
// nói lên sự thật thay vì nói lên tốc độ của localhost.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { tmuxBin } from '../src/tmux.js';
import { taoThietBiTest, ghiDevices } from './helpers.mjs';

// Windows không có tmux, và nhánh cần đo ở đây là nhánh DÙNG CHUNG — đo nó ở
// đâu cũng được, miễn là đo. Nửa Windows của cùng chuyện này nằm ở
// test/win-off-tu-te.test.js.
const KHONG_TMUX = process.platform === 'win32';
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term.js');

// Hub trả lời CHẬM đúng ở `/unregister`, và chỉ ở đó: `register` phải nhanh,
// nếu không thì chính độ trễ ấy che mất cái nhịp tim ta đang rình.
const TRE_UNREGISTER_MS = 500;

const daDung = [];
const donDep = [];
after(() => {
  for (const f of donDep) { try { f(); } catch { /* dọn không được thì thôi */ } }
  for (const d of daDung) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác thì thôi */ }
  }
});

const ngu = (ms) => new Promise((r) => setTimeout(r, ms));

async function choToi(dieuKien, hanMs = 20_000) {
  const het = Date.now() + hanMs;
  while (Date.now() < het) {
    if (dieuKien()) return true;
    await ngu(25);
  }
  return false;
}

function congTrong() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function hubCham() {
  const nhan = [];
  const srv = http.createServer((req, res) => {
    let than = '';
    req.on('data', (d) => { than += d; });
    req.on('end', () => {
      nhan.push(req.url);
      const traLoi = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      };
      if (/unregister/.test(req.url)) setTimeout(traLoi, TRE_UNREGISTER_MS);
      else traLoi();
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

test('off không để lại sổ phiên, và không đăng ký lại sau khi đã huỷ đăng ký',
  { skip: KHONG_TMUX }, async () => {
    const hub = hubCham();
    const congHub = await hub.mo();
    donDep.push(() => hub.dong());

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hs-'));
    daDung.push(home);
    fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ccrc', 'config'),
      `CCRC_HUB_URL=http://127.0.0.1:${congHub}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-thu\n`);

    const dt = await taoThietBiTest();
    ghiDevices(home, [{ pubKey: dt.pubKey, label: 'test', pairedAt: 1 }]);

    const T = tmuxBin();
    const sess = `ccrc-hs-${process.pid}`;
    execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
    donDep.push(() => {
      try { execFileSync(T, ['kill-session', '-t', sess]); } catch { /* đã chết */ }
      try { execFileSync(T, ['kill-session', '-t', `${sess}-ccrc-web`]); } catch { /* chưa từng có */ }
    });
    const pane = execFileSync(T, ['display-message', '-p', '-t', sess, '#{pane_id}'],
      { encoding: 'utf8' }).trim();

    const cong = await congTrong();
    const sessionId = `hoi-sinh-${process.pid}`;
    // `CCRC_HOME` CẠNH `HOME`, không thay nó: daemon đọc cấu hình bằng
    // `ccrcHome()`, và một CCRC_HOME kế thừa từ môi trường ngoài sẽ THẮNG HOME.
    // Xem test/home-boundary.test.js.
    const proc = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        HOME: home,
        CCRC_HOME: home,
        CCRC_TERM_PANE: pane,
        CCRC_TERM_SESSION_ID: sessionId,
        CCRC_TERM_BIND: '127.0.0.1',
        CCRC_TERM_PORT: String(cong),
        CCRC_TERM_URL: `http://127.0.0.1:${cong}/`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Trưởng nhóm tiến trình của CHÍNH nó, để một cú giết nhóm dọn luôn con
      // `tmux -C attach-session` mà daemon sinh ra cho mỗi kết nối. Cùng lý do
      // đã ghi dài trong test/helpers.mjs.
      detached: true,
    });
    let nhatKy = '';
    proc.stdout.on('data', (d) => { nhatKy += d; });
    proc.stderr.on('data', (d) => { nhatKy += d; });
    donDep.push(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* đã đi */ }
      try { proc.kill('SIGKILL'); } catch { /* đã đi */ }
    });

    assert.ok(await choToi(() => /\[term\] nghe /.test(nhatKy)),
      `daemon không lên được: ${nhatKy}`);

    const token = await dt.ky({ sessionId, machine: 'may-thu', host: `127.0.0.1:${cong}` });
    const ws = new WebSocket(`ws://127.0.0.1:${cong}/attach?token=${encodeURIComponent(token)}`,
      { headers: { Origin: `http://127.0.0.1:${cong}` } });
    donDep.push(() => { try { ws.terminate(); } catch { /* đã đứt */ } });
    const maDong = { ma: null };
    ws.on('close', (ma) => { maDong.ma = ma; });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`WebSocket không mở được: ${nhatKy}`)), 20_000);
      ws.on('open', () => { clearTimeout(t); res(); });
      ws.on('error', (e) => { clearTimeout(t); rej(e); });
    });

    const fileSo = path.join(home, '.ccrc', 'sessions', `${sessionId}.json`);
    assert.ok(await choToi(() => fs.existsSync(fileSo)), 'daemon chưa ghi sổ phiên');
    assert.ok(hub.nhan.some((u) => /\/api\/terminal\/register/.test(u)),
      'hub chưa từng nhận register — mọi khẳng định dưới đây sẽ xanh vì lý do sai');

    // Đúng đường mà `/remote off` đi trên macOS: một SIGTERM thật.
    process.kill(proc.pid, 'SIGTERM');
    assert.ok(await choToi(() => proc.exitCode !== null || proc.signalCode !== null),
      `daemon không thoát: ${nhatKy}`);

    // Trình duyệt vẫn phải được báo tử tế — mã này sai thì cả bài đo dưới đây
    // đang nói về một cuộc dừng khác hẳn.
    assert.ok(await choToi(() => maDong.ma !== null), 'WebSocket không hề đóng');
    assert.equal(maDong.ma, 4001, `mã đóng phải là 4001, nhận được ${maDong.ma}`);

    // 1) Sổ phiên phải SẠCH. Nhịp tim hồi sinh (nếu có) chạy TRƯỚC lúc tiến
    //    trình thoát, nên tới đây file đã có mặt rồi nếu nó từng được ghi lại.
    await ngu(200);
    assert.equal(fs.existsSync(fileSo), false,
      'file sổ phiên bị một nhịp tim ghi lại sau khi shutdown() đã xoá');

    // 2) Và hub không được nhận `register` SAU `unregister` — đó là cách một
    //    phiên đã chết sống lại trong danh sách trên điện thoại.
    const iHuy = hub.nhan.findIndex((u) => /\/api\/terminal\/unregister/.test(u));
    assert.notEqual(iHuy, -1, `hub không nhận unregister; chỉ nhận: ${hub.nhan.join(', ')}`);
    const dangKyMuon = hub.nhan.slice(iHuy + 1).filter((u) => /\/api\/terminal\/register/.test(u));
    assert.deepEqual(dangKyMuon, [],
      `hub nhận register SAU unregister — phiên đã chết vừa sống lại: ${hub.nhan.join(', ')}`);
  });
