import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeHost, hostsDir } from '../src/host-registry.js';

// Toàn bộ file này CHỈ có nghĩa trên Windows: ccrc-win.js gọi `where.exe` và
// WMI, và trên macOS/Linux lối vào là `deploy/ccrc` (tmux). Mọi bài
// `{ skip }` ngoài Windows, không ngoại lệ — cùng lối win-launch.test.js và
// ccrc-host.test.js.
const CHI_WINDOWS = process.platform !== 'win32';
const CCRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-win.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taoNha() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-win-'));
}

function don(nha) {
  try { fs.rmSync(nha, { recursive: true, force: true }); } catch { /* máy đang giữ file — kệ */ }
}

function giet(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
  } catch { /* có thể đã tự thoát */ }
}

// Chạy `ccrc ...` và đợi nó xong. Chỉ dùng cho những lệnh KHÔNG mở phiên —
// lệnh mở phiên biến tiến trình này thành client và không bao giờ tự thoát.
function chay(thamSo, { nha, cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CCRC, ...thamSo], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    env: { ...process.env, CCRC_HOME: nha, ...env },
  });
}

function duongHoSo(nha, sessionId) {
  return path.join(hostsDir(nha), `${sessionId}.json`);
}

// Một hồ sơ đầy đủ hình dạng, trỏ vào pid ta chỉ định.
function dungHoSoGia(nha, pid) {
  const sessionId = 'gia' + crypto.randomBytes(3).toString('hex');
  const ok = writeHost({
    sessionId,
    pid,
    pipe: `\\\\.\\pipe\\ccrc-${sessionId}`,
    secret: crypto.randomBytes(32).toString('hex'),
    cwd: nha,
    createdAt: Date.now(),
  }, { home: nha });
  assert.equal(ok, true, 'không ghi nổi hồ sơ giả');
  return sessionId;
}

// Một pid CHẮC CHẮN đã chết: chạy một tiến trình rồi đợi nó xong hẳn.
// spawnSync trả về pid của tiến trình đã kết thúc.
function pidDaChet() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(r.pid > 0, 'không lấy nổi một pid để giết');
  return r.pid;
}

async function choDenKhi(dieuKien, { timeoutMs = 30_000, buocMs = 100 } = {}) {
  const hetGio = Date.now() + timeoutMs;
  while (Date.now() < hetGio) {
    const v = await dieuKien();
    if (v) return v;
    await sleep(buocMs);
  }
  return null;
}

test('`ccrc list` trên một CCRC_HOME sạch: stdout rỗng, thoát 0', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    const r = chay(['list'], { nha });
    assert.equal(r.status, 0, `phải thoát 0, stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'danh sách rỗng phải in ra RỖNG, không phải một câu văn');
  } finally { don(nha); }
});

test('`ccrc list` in đúng host đang sống', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    // pid của chính bộ test — một tiến trình chắc chắn đang sống.
    const sessionId = dungHoSoGia(nha, process.pid);
    const r = chay(['list'], { nha });
    assert.equal(r.status, 0, `phải thoát 0, stderr: ${r.stderr}`);
    const dong = r.stdout.trim().split(/\r?\n/);
    assert.equal(dong.length, 1, `phải đúng một dòng, nhận: ${JSON.stringify(r.stdout)}`);
    const [id, pid] = dong[0].split('\t');
    assert.equal(id, sessionId);
    assert.equal(Number(pid), process.pid);
  } finally { don(nha); }
});

test('hồ sơ trỏ pid đã chết bị quét đi, không được in ra', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    const sessionId = dungHoSoGia(nha, pidDaChet());
    assert.equal(fs.existsSync(duongHoSo(nha, sessionId)), true, 'hồ sơ giả phải tồn tại trước đã');
    const r = chay(['list'], { nha });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'phiên chết không được xuất hiện trong danh sách');
    assert.equal(fs.existsSync(duongHoSo(nha, sessionId)), false, 'và hồ sơ của nó phải bị xoá khỏi đĩa');
  } finally { don(nha); }
});

// Quét dọn là việc ĐẦU TIÊN của MỌI lệnh, không riêng `list`. Nếu nó nằm trong
// nhánh `list` thì một người chỉ dùng `ccrc` và `ccrc attach` sẽ tích rác mãi.
test('quét dọn chạy cả với lệnh không phải `list`', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    const sessionId = dungHoSoGia(nha, pidDaChet());
    const r = chay(['attach', 'khongcophiennao'], { nha });
    assert.notEqual(r.status, 0, 'attach vào một id không có phải thoát khác 0');
    assert.equal(fs.existsSync(duongHoSo(nha, sessionId)), false,
      'hồ sơ chết vẫn phải bị quét, dù lệnh người dùng gõ là `attach`');
  } finally { don(nha); }
});

test('`ccrc attach <id lạ>` nói rõ id nào không tìm thấy', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    // Bài này cũng là phép đo cho việc GIAO tiến trình cho client: client đọc
    // `process.argv[2]`, nên câu báo có chứa đúng id nghĩa là dòng lệnh đã được
    // dựng lại đúng trước khi nạp client.
    const r = chay(['attach', 'phienkhongco'], { nha });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /phienkhongco/);
  } finally { don(nha); }
});

test('tham số lạ: in cách dùng, thoát 2, và KHÔNG mở phiên nào', { skip: CHI_WINDOWS }, () => {
  const nha = taoNha();
  try {
    const r = chay(['-p', 'xin chào'], { nha });
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /Cách dùng/);
    const thuMuc = hostsDir(nha);
    const soHoSo = fs.existsSync(thuMuc) ? fs.readdirSync(thuMuc).length : 0;
    assert.equal(soHoSo, 0, 'một tham số không hiểu không được phép khởi chạy host nào');
  } finally { don(nha); }
});

// BÀI QUAN TRỌNG NHẤT của file này.
//
// `Win32_Process.Create` KHÔNG thừa hưởng thư mục làm việc của người gọi —
// khác `spawn`, vốn mặc định `process.cwd()`. Không nói tường minh thì host
// khởi động trong thư mục của WMI provider host và Claude Code mở ra ở nhầm
// chỗ: chạy trơn tru, không lỗi, chỉ là sai.
//
// Bài này khẳng định thứ NGƯỜI DÙNG thấy — "phiên mở ra ở đúng thư mục tôi
// đang đứng" — chứ không khẳng định một đường truyền cụ thể nào, và như thế là
// đúng: `ho.cwd` là chính giá trị host đưa cho `pty.spawn`. ccrc truyền thư mục
// ấy bằng HAI đường (cwd của tiến trình host, và CCRC_HOST_CWD cho ConPTY); bỏ
// một đường thì hành vi vẫn đúng và bài này vẫn xanh — đúng, vì lúc đó không có
// gì hỏng cả. Bỏ CẢ HAI thì ConPTY rơi về thư mục của WMI provider và bài đỏ.
// Đã đo cả hai chiều, xem báo cáo task 3.
//
// Thư mục CÓ KHOẢNG TRẮNG trong tên, cố ý: đường dẫn đi qua một dòng lệnh WMI
// và một literal PowerShell, hai lớp trích dẫn, nên "không khoảng trắng" là một
// bài dễ hơn bài thật.
test('`ccrc` mở host trong ĐÚNG thư mục người gọi đang đứng', { skip: CHI_WINDOWS }, async () => {
  const nha = taoNha();
  const noiLamViec = path.join(nha, 'co khoang trang');
  fs.mkdirSync(noiLamViec);
  let tienTrinh = null;
  let ho = null;
  try {
    tienTrinh = spawn(process.execPath, [CCRC], {
      cwd: noiLamViec,
      // `cmd.exe` thay cho `claude`: cùng hình dạng (một chương trình console
      // tương tác trong ConPTY), không tốn một phiên Claude thật.
      env: { ...process.env, CCRC_HOME: nha, CCRC_CLAUDE_BIN: 'cmd.exe' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // PHẢI đọc hết hai ống: từ lúc giao cho client, tiến trình này đổ byte của
    // pty ra stdout không ngừng, và một cái ống không ai đọc sẽ nghẽn.
    let loi = '';
    tienTrinh.stdout.on('data', () => { /* nuốt */ });
    tienTrinh.stderr.on('data', (b) => { loi += b.toString('utf8'); });

    ho = await choDenKhi(() => {
      const thuMuc = hostsDir(nha);
      if (!fs.existsSync(thuMuc)) return null;
      const files = fs.readdirSync(thuMuc).filter((f) => f.endsWith('.json'));
      if (files.length !== 1) return null;
      try { return JSON.parse(fs.readFileSync(path.join(thuMuc, files[0]), 'utf8')); } catch { return null; }
    });
    assert.ok(ho, `host không ghi hồ sơ kịp. stderr của ccrc:\n${loi}`);

    assert.equal(ho.cwd, noiLamViec,
      'host phải chạy trong thư mục người gọi đang đứng, không phải thư mục của WMI provider');
    assert.ok(ho.pid > 0);
    assert.ok(ho.pipe.startsWith('\\\\.\\pipe\\'));

    // Và `ccrc list` phải thấy đúng phiên vừa mở — đường đi trọn vẹn, không chỉ
    // là một file trên đĩa.
    const r = chay(['list'], { nha });
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`^${ho.sessionId}\\t${ho.pid}\\t`, 'm'));

    // Id của phiên phải được nói ra cho người dùng, nếu không không ai biết gõ
    // gì vào `ccrc attach`. Ra stderr, vì stdout là màn hình của phiên.
    //
    // CHỜ, không khẳng định ngay: hồ sơ xuất hiện trên đĩa TRƯỚC khi ccrc kịp
    // thấy nó — ccrc hỏi lại mỗi 100ms — nên đọc stderr đúng lúc bài này vừa
    // thấy file là đọc một chuỗi rỗng. Đã đo: bản đầu tiên của bài này đỏ vì
    // đúng chỗ đó.
    const daNoi = await choDenKhi(() => loi.includes(`ccrc attach ${ho.sessionId}`), { timeoutMs: 10_000 });
    assert.ok(daNoi, `ccrc phải nói ra id để người dùng còn attach lại. stderr:\n${loi}`);
  } finally {
    if (ho && ho.pid) giet(ho.pid);
    if (tienTrinh) { try { tienTrinh.kill(); } catch { /* đã thoát */ } }
    await sleep(300); // để Windows nhả file trước khi xoá thư mục
    don(nha);
  }
});

// Host chạy với stdio KHÔNG nối vào đâu cả (chủ ý: một ống không ai đọc sẽ làm
// host nghẽn). Cái giá là khi nó không khai mình vào sổ thì ta không đọc được
// lý do — nên lệnh phải bỏ cuộc bằng một câu nói rõ pid và cách xử lý, chứ
// không treo mãi.
//
// Bài này ĐÁNG TIN chứ không nhờ may: hạn chót đặt 1ms, còn một tiến trình Node
// nạp node-pty rồi mở ConPTY thì mất hàng trăm ms tới vài giây. Không có cách
// nào để hồ sơ kịp xuất hiện trong 1ms.
test('host chưa kịp khai mình: bỏ cuộc có hạn, nói ra pid', { skip: CHI_WINDOWS }, async () => {
  const nha = taoNha();
  let pidHost = 0;
  try {
    const r = chay([], {
      nha,
      env: { CCRC_CLAUDE_BIN: 'cmd.exe', CCRC_WIN_START_TIMEOUT_MS: '1' },
    });
    assert.equal(r.status, 1, `phải thoát 1, stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /chưa ghi hồ sơ/);
    const khop = r.stderr.match(/host \(pid (\d+)\)/);
    assert.ok(khop, `câu báo phải nêu pid để người dùng còn xử lý được: ${r.stderr}`);
    pidHost = Number(khop[1]);
    assert.ok(pidHost > 0);
  } finally {
    if (pidHost) giet(pidHost);
    await sleep(300);
    don(nha);
  }
});
