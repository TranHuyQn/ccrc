// Lần chạy đầu tiên trên một bản clone sạch.
//
// Mọi test hub khác dựng CCRC_DATA_DIR bằng mkdtempSync, nên thư mục dữ liệu
// LUÔN tồn tại trước khi hub khởi động — và vì thế không bài nào trong số đó
// có thể bắt được điều kiện thật của một người vừa clone repo về: `server/data/`
// nằm trong .gitignore (nó chứa khoá VAPID và token của mọi người), git không
// track thư mục rỗng, nên bản clone KHÔNG có thư mục đó.
//
// Đo trên bản clone thật từ GitHub, chạy đúng lệnh README nêu
// (`CCRC_TOKEN=... npm run server`):
//
//   Error: ENOENT: no such file or directory, open '.../server/data/vapid.json'
//
// Hub chết ngay lúc khởi động, trước khi phục vụ được request nào. Docker
// không dính vì Dockerfile.hub có sẵn `RUN mkdir -p /data`, nên lỗi này chỉ
// hiện ra ở đúng con đường mà người thử nhanh hay chọn nhất.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

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

// Khởi động hub với một CCRC_DATA_DIR CHƯA TỒN TẠI — điều kiện của bản clone
// sạch. Không mkdir gì trước: đó chính là thứ đang được kiểm.
async function startHubWithMissingDataDir() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-first-run-'));
  // Lồng hai cấp để chắc chắn recursive:true là thứ thực sự cần, chứ không
  // phải một mkdir một cấp tình cờ đủ.
  const dataDir = path.join(parent, 'chua-ton-tai', 'data');
  assert.equal(fs.existsSync(dataDir), false, 'điều kiện đầu vào: thư mục PHẢI chưa tồn tại');

  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: { ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let died = null;
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  proc.once('exit', (code, signal) => { died = `hub thoát sớm (code=${code}, signal=${signal})`; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (died) throw new Error(`${died}\n${stderr}`);
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) break;
    } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (died) throw new Error(`${died}\n${stderr}`);
  return { proc, base, dataDir, parent, stop: () => { try { proc.kill(); } catch {} try { fs.rmSync(parent, { recursive: true, force: true }); } catch {} } };
}

test('hub khởi động được khi thư mục dữ liệu CHƯA tồn tại (bản clone sạch)', async () => {
  const hub = await startHubWithMissingDataDir();
  try {
    const r = await fetch(hub.base + '/healthz');
    assert.equal(r.ok, true, 'hub phải phục vụ được /healthz ngay lần chạy đầu');
    assert.deepEqual(await r.json(), { ok: true });
  } finally {
    hub.stop();
  }
});

test('lần chạy đầu tự sinh khoá VAPID vào thư mục nó vừa tạo', async () => {
  const hub = await startHubWithMissingDataDir();
  try {
    assert.equal(fs.existsSync(hub.dataDir), true, 'hub phải tự tạo thư mục dữ liệu');
    const vapid = JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'vapid.json'), 'utf8'));
    assert.equal(typeof vapid.publicKey, 'string');
    assert.equal(typeof vapid.privateKey, 'string');
    // Khoá công khai phải ra được tới PWA, nếu không thì trình duyệt không
    // đăng ký push được — tức "khởi động xong" vẫn chưa đủ để dùng.
    const r = await fetch(hub.base + '/api/vapid-key');
    assert.deepEqual(await r.json(), { publicKey: vapid.publicKey });
  } finally {
    hub.stop();
  }
});

test('lần chạy đầu KHÔNG có users.json vẫn phục vụ được, và token admin vẫn đăng nhập', async () => {
  const hub = await startHubWithMissingDataDir();
  try {
    // Không ai ghi users.json cả — đúng trạng thái ngay sau khi clone. Hub
    // phải coi đó là "chưa có thành viên nào", không phải một lỗi.
    const r = await fetch(hub.base + '/api/me', { headers: { authorization: 'Bearer admin-tok' } });
    assert.equal(r.status, 200);
    const me = await r.json();
    assert.equal(me.user, 'admin');
    const bad = await fetch(hub.base + '/api/me', { headers: { authorization: 'Bearer sai-token' } });
    assert.equal(bad.status, 401);
  } finally {
    hub.stop();
  }
});
