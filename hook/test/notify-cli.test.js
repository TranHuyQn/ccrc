import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-notify-cli.js');

function tmpHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-home-'));
  fs.mkdirSync(path.join(home, '.ccrc'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(home, '.ccrc', n), c);
  return home;
}

function run(args, home) {
  return new Promise((r) => execFile('node', [CLI, ...args], { env: { ...process.env, HOME: home }, timeout: 15000 },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('`on` ghi đúng chữ on vào file', async () => {
  const home = tmpHome();
  const r = await run(['on'], home);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(home, '.ccrc', 'notify'), 'utf8').trim(), 'on');
  assert.match(r.stdout, /BẬT/);
});

test('`off` ghi đúng chữ off', async () => {
  const home = tmpHome({ notify: 'on\n' });
  await run(['off'], home);
  assert.equal(fs.readFileSync(path.join(home, '.ccrc', 'notify'), 'utf8').trim(), 'off');
});

test('không tham số thì in trạng thái, chưa cấu hình vẫn không sập', async () => {
  const home = tmpHome();
  const r = await run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TẮT/);
  assert.match(r.stdout, /chưa cấu hình|Hub/);
});

test('trạng thái GỌI THẬT lên hub và báo kết quả', async () => {
  let hit = 0;
  const srv = http.createServer((req, res) => {
    hit++;
    assert.equal(req.headers.authorization, 'Bearer tok-abc');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: 'huy', pushDevices: 2 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=tok-abc\n` });
  const r = await run([], home);
  srv.close();
  assert.equal(hit, 1, 'phải gọi thật lên hub, không được đoán từ file');
  assert.match(r.stdout, /huy/);
  assert.match(r.stdout, /2 thiết bị/);
});

test('hub sập thì BÁO RÕ chứ không im lặng', async () => {
  const home = tmpHome({ notify: 'on\n', config: 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\n' });
  const r = await run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /không gọi được|lỗi/i, 'hỏng im lặng là thứ lệnh này sinh ra để chống');
});

test('token sai thì báo token sai', async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=sai\n` });
  const r = await run([], home);
  srv.close();
  assert.match(r.stdout, /token/i);
});

test('cảnh báo khi BẬT mà chưa có thiết bị nào đăng ký push', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: 'huy', pushDevices: 0 }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = tmpHome({ notify: 'on\n', config: `CCRC_HUB_URL=http://127.0.0.1:${srv.address().port}\nCCRC_TOKEN=t\n` });
  const r = await run([], home);
  srv.close();
  assert.match(r.stdout, /chưa có thiết bị|⚠/, 'bật mà không có thiết bị thì thông báo bay vào hư không');
});
