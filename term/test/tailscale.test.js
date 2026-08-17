import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrereqs } from '../src/tailscale.js';

// Giả lập CLI tailscale: `status --json` in ra JSON cho sẵn, mọi lệnh khác ghi
// log vào file để test kiểm được đã gọi đúng gì.
function fakeTailscale(statusJson) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-'));
  const log = path.join(d, 'calls.log');
  const bin = path.join(d, 'fake-tailscale');
  fs.writeFileSync(path.join(d, 'status.json'), JSON.stringify(statusJson));
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = "status" ]; then cat ${path.join(d, 'status.json')}; exit 0; fi
exit 0
`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

// Fake binary that sleeps past our timeout before ever responding — used to
// prove a hung `tailscale` gets killed rather than left to block forever.
// The sleep only needs to outlast the production timeout; the process gets
// SIGTERM'd at the timeout, so the test itself doesn't wait out the sleep.
function fakeSleepyTailscale(seconds) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-slow-'));
  const bin = path.join(d, 'fake-tailscale-slow');
  fs.writeFileSync(bin, `#!/bin/sh
sleep ${seconds}
echo '{}'
`, { mode: 0o755 });
  return bin;
}

// Fake binary that behaves like a present-but-unreachable tailscaled: it runs
// and exits non-zero rather than hanging or being missing.
function fakeFailingStatus() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-fail-'));
  const bin = path.join(d, 'fake-tailscale-fail');
  fs.writeFileSync(bin, `#!/bin/sh
echo "tailscaled khong ket noi duoc" >&2
exit 1
`, { mode: 0o755 });
  return bin;
}

// Fake binary that exits 0 but prints something that isn't JSON.
function fakeBadOutput() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-ts-bad-'));
  const bin = path.join(d, 'fake-tailscale-bad');
  fs.writeFileSync(bin, `#!/bin/sh
echo "khong phai json"
exit 0
`, { mode: 0o755 });
  return bin;
}

const RUNNING = {
  BackendState: 'Running',
  Self: { DNSName: 'may-dev.tailnet-example.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
};

test('đủ điều kiện: trả về IPv4 Tailscale', () => {
  const { bin } = fakeTailscale(RUNNING);
  const r = checkPrereqs(bin);
  assert.equal(r.ok, true);
  assert.equal(r.ip, '100.101.102.103');
});

test('bỏ qua IPv6, lấy đúng IPv4', () => {
  const { bin } = fakeTailscale({ ...RUNNING,
    Self: { TailscaleIPs: ['fd7a:115c:a1e0::1', '100.101.102.103'] } });
  assert.equal(checkPrereqs(bin).ip, '100.101.102.103');
});

test('chưa có IP nào: báo stopped, không ném', () => {
  const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: [] } });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
});

test('TailscaleIPs là string thay vì mảng: báo stopped, không ném', () => {
  const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: '100.101.102.103' } });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped', 'hình dạng sai không được làm ips.find() ném ra ngoài');
});

test('TailscaleIPs là object thay vì mảng: báo stopped, không ném', () => {
  const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: { 0: '100.101.102.103' } } });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
});

test('KHÔNG còn reason no_certs — chứng chỉ không còn là điều kiện', () => {
  const { bin } = fakeTailscale(RUNNING);
  assert.equal(checkPrereqs(bin).ok, true, 'thiếu CertDomains không được làm hỏng nữa');
});

test('Tailscale đang dừng: báo reason stopped kèm việc cần làm', () => {
  const { bin } = fakeTailscale({ ...RUNNING, BackendState: 'Stopped' });
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
  assert.match(r.message, /Tailscale/i);
});

test('không có binary: báo no_binary chứ không ném', () => {
  const r = checkPrereqs('/khong/ton/tai/tailscale');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_binary');
  assert.match(r.message, /không tìm thấy/i, 'thiếu binary phải nói rõ là KHÔNG TÌM THẤY, khác với daemon không phản hồi');
});

test('binary có nhưng thoát khác 0: cùng họ "stopped" với thông báo hành động rõ ràng, không lẫn vào no_binary', () => {
  const bin = fakeFailingStatus();
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stopped');
  assert.notEqual(r.reason, 'no_binary');
  assert.match(r.message, /mở app Tailscale|bật lên/i);
});

test('binary trả dữ liệu không phải JSON: reason riêng, không lẫn với no_binary', () => {
  const bin = fakeBadOutput();
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_output');
  assert.notEqual(r.reason, 'no_binary');
  assert.match(r.message, /Tailscale/i);
});

test('checkPrereqs không treo khi tailscale không phản hồi — trả lời trong thời gian giới hạn với thông báo hữu ích', () => {
  const bin = fakeSleepyTailscale(10);
  const start = Date.now();
  const r = checkPrereqs(bin);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `checkPrereqs phải trả lời trong vài giây, không treo (mất ${elapsed}ms)`);
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, 'no_binary', 'daemon không phản hồi không phải là "không có binary"');
  assert.match(r.message, /Tailscale/i);
});

// `JSON.parse('null')` succeeds (it's valid JSON) but yields null, which
// reading .BackendState off of would throw if not guarded.
test('binary trả về JSON hợp lệ nhưng là null: reason bad_output, không ném', () => {
  const { bin } = fakeTailscale(null);
  const r = checkPrereqs(bin);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_output');
});

// Round 2 review finding: checkPrereqs(), called with no argument the way
// the daemon calls it at startup, used to resolve its own bin via a default
// parameter `bin = tailscaleBin()`, evaluated BEFORE the function's try/catch
// ever runs. If Tailscale isn't installed at any known path and
// CCRC_TAILSCALE_BIN isn't set, tailscaleBin() throws, and that throw used to
// escape checkPrereqs() uncaught. Proven here by forcing every known install
// path to look absent (fs.existsSync stubbed to false) and asserting
// checkPrereqs() still returns rather than throws.
// Item 2, review toàn nhánh: checkPrereqs() chỉ kiểm HÌNH DẠNG của địa chỉ
// (`/^\d+\.\d+\.\d+\.\d+$/`) — `0.0.0.0` và `192.168.1.50` đều khớp hình
// dạng đó. `ip` trả về từ đây trở thành `bindAddr` ở nơi gọi duy nhất
// (ccrc-term.js), ngay dưới một chú thích cảnh báo: bind mọi giao diện biến
// một terminal riêng tư thành một terminal công khai. Phải từ chối chứ
// không bind khi Tailscale (hỏng, hoặc bị cấu hình sai) trả về một địa chỉ
// không thuộc CGNAT — session-url.js và app.js đã có đúng phép kiểm này,
// đây là bản thứ ba, ở đúng nơi thực sự bind socket.
test('IP không thuộc dải CGNAT (100.64.0.0/10): từ chối, không bind', () => {
  for (const ip of ['0.0.0.0', '192.168.1.50', '10.0.0.5', '127.0.0.1', '100.63.255.255', '100.128.0.0']) {
    const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: [ip] } });
    const r = checkPrereqs(bin);
    assert.equal(r.ok, false, `${ip} không thuộc 100.64.0.0/10, không được ok:true`);
    assert.notEqual(r.reason, 'stopped', `${ip}: lý do phải khác "stopped" — đây là địa chỉ SAI, không phải thiếu địa chỉ`);
    assert.match(r.message, /Tailscale/i);
  }
});

test('IP ở biên của dải CGNAT (100.64.0.0 và 100.127.255.255) được chấp nhận', () => {
  for (const ip of ['100.64.0.0', '100.127.255.255', '100.101.102.103']) {
    const { bin } = fakeTailscale({ ...RUNNING, Self: { TailscaleIPs: [ip] } });
    const r = checkPrereqs(bin);
    assert.equal(r.ok, true, `${ip} thuộc 100.64.0.0/10, phải được chấp nhận`);
    assert.equal(r.ip, ip);
  }
});

test('checkPrereqs() không đối số không tự ném khi không tìm thấy Tailscale ở đường dẫn nào', () => {
  const savedBin = process.env.CCRC_TAILSCALE_BIN;
  const savedExists = fs.existsSync;
  delete process.env.CCRC_TAILSCALE_BIN;
  fs.existsSync = () => false;
  try {
    const r = checkPrereqs();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_binary');
  } finally {
    fs.existsSync = savedExists;
    if (savedBin === undefined) delete process.env.CCRC_TAILSCALE_BIN;
    else process.env.CCRC_TAILSCALE_BIN = savedBin;
  }
});

