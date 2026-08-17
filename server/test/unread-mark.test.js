// Chấm "chưa đọc" sau khi hub thôi giữ lịch sử thông báo.
//
// Trước bản này hub nhớ 50 thông báo gần nhất mỗi người — tiêu đề và nội dung
// thật, thứ Claude Code đang hỏi — và PWA tính chấm chưa đọc bằng cách giao
// danh sách ấy với danh sách phiên. Nghĩa là để vẽ được một cái chấm, hub phải
// giữ nội dung của mọi thông báo.
//
// Nó không cần. Thứ duy nhất cái chấm hỏi là "phiên này có thông báo nào sau
// lần tôi xem cuối không" — một câu hỏi trả lời được bằng MỘT con số cho mỗi
// phiên. Nên hub giữ đúng con số đó và quên phần còn lại.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
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

const USERS = [{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }];

async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(USERS));
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
  return { base, stop: () => proc.kill() };
}

async function withHub(fn) {
  const h = await startHub();
  try { await fn(h); } finally { h.stop(); }
}

const auth = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' });

function dangKyPhien(h, tok, sessionId) {
  return fetch(h.base + '/api/terminal/register', {
    method: 'POST',
    headers: auth(tok),
    body: JSON.stringify({
      sessionId, machine: 'may-test', url: 'http://100.64.0.1:1234/', label: 'nhan',
    }),
  });
}

function guiThongBao(h, tok, sessionId) {
  return fetch(h.base + '/notify', {
    method: 'POST',
    headers: auth(tok),
    body: JSON.stringify({ title: 'Claude hỏi', body: 'cho chạy lệnh này chứ?', sessionId }),
  });
}

const dsPhien = async (h, tok) => (await (await fetch(h.base + '/api/terminal', { headers: auth(tok) })).json()).sessions;

test('một thông báo đặt mốc lastNotifiedAt lên đúng phiên của nó', async () => {
  await withHub(async (h) => {
    await dangKyPhien(h, 'tok-huy', 'k7m2');
    const truoc = (await dsPhien(h, 'tok-huy'))[0];
    assert.equal(truoc.lastNotifiedAt, 0, 'phiên chưa có thông báo nào phải là 0, không phải undefined');

    const t0 = Date.now();
    await guiThongBao(h, 'tok-huy', 'k7m2');

    const sau = (await dsPhien(h, 'tok-huy'))[0];
    assert.ok(sau.lastNotifiedAt >= t0, `mốc phải là lúc thông báo tới, nhận được ${sau.lastNotifiedAt}`);
  });
});

test('mốc sống qua nhịp heartbeat — đăng ký lại không xoá chấm chưa đọc', async () => {
  await withHub(async (h) => {
    await dangKyPhien(h, 'tok-huy', 'k7m2');
    await guiThongBao(h, 'tok-huy', 'k7m2');
    const moc = (await dsPhien(h, 'tok-huy'))[0].lastNotifiedAt;
    assert.ok(moc > 0);

    // Daemon gọi /api/terminal/register lại mỗi 20 giây suốt vòng đời phiên.
    // Nếu lần đăng ký lại nào cũng thay cả entry thì mốc bị xoá mỗi 20 giây,
    // và chấm chưa đọc tắt trước khi người dùng kịp nhìn — triệu chứng là
    // "chấm thỉnh thoảng mới hiện", thứ gần như không ai lần ra được.
    await dangKyPhien(h, 'tok-huy', 'k7m2');

    assert.equal((await dsPhien(h, 'tok-huy'))[0].lastNotifiedAt, moc,
      'nhịp heartbeat không được xoá mốc thông báo');
  });
});

test('hub không còn phục vụ /api/notifications', async () => {
  await withHub(async (h) => {
    const r = await fetch(h.base + '/api/notifications', { headers: auth('tok-huy') });
    assert.equal(r.status, 404, 'endpoint lịch sử thông báo phải biến mất hẳn, không phải trả về mảng rỗng');
  });
});

test('mốc của người này không đặt lên phiên trùng tên của người khác', async () => {
  await withHub(async (h) => {
    // Cùng một sessionId, hai người khác nhau — hub khoá theo người trước, id
    // sau, nên đây phải là hai phiên hoàn toàn riêng.
    await dangKyPhien(h, 'tok-huy', 'trung-id');
    await dangKyPhien(h, 'tok-kien', 'trung-id');

    await guiThongBao(h, 'tok-huy', 'trung-id');

    assert.ok((await dsPhien(h, 'tok-huy'))[0].lastNotifiedAt > 0, 'phiên của chính người gửi phải được đánh mốc');
    assert.equal((await dsPhien(h, 'tok-kien'))[0].lastNotifiedAt, 0,
      'thông báo của người khác không được làm sáng chấm trên thẻ của mình');
  });
});

test('thông báo mang sessionId không thuộc phiên nào: nhận bình thường, không đẻ ra phiên ma', async () => {
  await withHub(async (h) => {
    const r = await guiThongBao(h, 'tok-huy', 'khong-ton-tai');
    assert.equal(r.status, 200, 'thông báo ngoài phiên vẫn phải được nhận và đẩy đi');
    assert.deepEqual(await dsPhien(h, 'tok-huy'), [], 'không được tạo phiên từ một sessionId lạ');
  });
});
