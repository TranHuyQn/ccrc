import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveCommand, launchSurviving } from '../src/win-launch.js';

// Toàn bộ file này CHỈ có ý nghĩa trên Windows — win-launch.js dùng where.exe
// và WMI, không có gì tương đương để giả trên macOS/Linux. Mọi bài test
// { skip } ngoài Windows, không có ngoại lệ.
const CHI_WINDOWS = process.platform !== 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ ĐIỀU KIỆN trong một hạn chót, không sleep cố định — cùng lối các test
// khác trong bộ này (xem ccrc-host.test.js).
async function choDenKhi(dieuKien, { timeoutMs = 15_000, buocMs = 100 } = {}) {
  const hetGio = Date.now() + timeoutMs;
  while (Date.now() < hetGio) {
    if (await dieuKien()) return true;
    await sleep(buocMs);
  }
  return false;
}

function taoThuMuc() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-win-launch-'));
}

function giet(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
  } catch { /* có thể tiến trình đã tự thoát */ }
}

// Đọc ParentProcessId của một pid đang sống, qua CIM — không đi qua
// tasklist/wmic để không phụ thuộc công cụ có thể đã bị gỡ (đo được: máy thử
// không có wmic.exe, chỉ có Invoke-CimMethod/Get-CimInstance).
function ppidCua(pid) {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
    { encoding: 'utf8' },
  );
  return Number(stdout.trim());
}

test('resolveCommand("cmd") trả đường dẫn tuyệt đối, tận cùng .exe', { skip: CHI_WINDOWS }, () => {
  const p = resolveCommand('cmd');
  assert.ok(path.isAbsolute(p), `phải là đường dẫn tuyệt đối, nhận "${p}"`);
  assert.equal(p.toLowerCase().slice(-4), '.exe');
  assert.ok(fs.existsSync(p), `đường dẫn phải tồn tại thật: ${p}`);
});

test('resolveCommand ném khi lệnh không tồn tại, thông điệp nhắc tên lệnh', { skip: CHI_WINDOWS }, () => {
  const ten = 'khong-co-lenh-nay-dau-' + crypto.randomBytes(3).toString('hex');
  assert.throws(
    () => resolveCommand(ten),
    (err) => {
      assert.match(err.message, new RegExp(ten.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('launchSurviving chạy lệnh ghi ra file (kể cả đường dẫn có khoảng trắng), trả pid > 0', { skip: CHI_WINDOWS }, async () => {
  const dir = taoThuMuc();
  const thuMucCoKhoangTrang = path.join(dir, 'co khoang trang');
  fs.mkdirSync(thuMucCoKhoangTrang);
  const out = path.join(thuMucCoKhoangTrang, 'out.txt');
  const node = resolveCommand('node');
  let pid;
  try {
    pid = launchSurviving({
      command: node,
      args: ['-e', "require('fs').writeFileSync(process.argv[1], 'hello', 'utf8');", out],
      cwd: dir,
    });
    assert.ok(pid > 0, `pid phải > 0, nhận ${pid}`);
    const xuatHien = await choDenKhi(() => fs.existsSync(out));
    assert.ok(xuatHien, `file phải xuất hiện trong hạn chót: ${out}`);
    assert.equal(fs.readFileSync(out, 'utf8'), 'hello');
  } finally {
    if (pid) giet(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tiến trình khởi chạy KHÔNG phải con của tiến trình test (ParentProcessId qua CIM)', { skip: CHI_WINDOWS }, async () => {
  const dir = taoThuMuc();
  const out = path.join(dir, 'out.txt');
  const node = resolveCommand('node');
  // Giữ tiến trình sống đủ lâu để kịp truy vấn CIM trước khi nó tự thoát —
  // nếu nó thoát ngay, Win32_Process không còn bản ghi để đọc ParentProcessId.
  const script = "require('fs').writeFileSync(process.argv[1], 'hi', 'utf8'); setTimeout(() => {}, 10000);";
  let pid;
  try {
    pid = launchSurviving({ command: node, args: ['-e', script, out], cwd: dir });
    const xuatHien = await choDenKhi(() => fs.existsSync(out));
    assert.ok(xuatHien, `file phải xuất hiện trong hạn chót: ${out}`);
    const ppid = ppidCua(pid);
    assert.notEqual(ppid, process.pid, 'tiến trình khởi chạy không được là con của tiến trình test — đó chính là tính chất làm nó sống sót');
  } finally {
    if (pid) giet(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launchSurviving ném khi lệnh không tồn tại, không trả pid rác', { skip: CHI_WINDOWS }, () => {
  const duongDanGia = 'C:\\khong-ton-tai-o-day\\khong-co-lenh-nay-' + crypto.randomBytes(3).toString('hex') + '.exe';
  assert.throws(() => launchSurviving({ command: duongDanGia, args: [] }));
});
