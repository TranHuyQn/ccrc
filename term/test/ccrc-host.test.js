import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';
import { readHost } from '../src/host-registry.js';

const CHI_WINDOWS = process.platform !== 'win32';
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dựng một host thật trong một CCRC_HOME riêng, chạy `cmd.exe` thay cho
// `claude` — cùng hình dạng, không tốn một phiên Claude thật.
async function dungHost(themEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-host-'));
  const sessionId = 'test' + crypto.randomBytes(4).toString('hex');
  const proc = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      CCRC_HOME: home,
      CCRC_HOST_SESSION_ID: sessionId,
      CCRC_HOST_COMMAND: 'cmd.exe',
      CCRC_HOST_CWD: home,
      ...themEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Chờ ĐIỀU KIỆN: hồ sơ xuất hiện. Không chờ một con số mili giây.
  const hetGio = Date.now() + 15000;
  let ho = null;
  while (!ho && Date.now() < hetGio) { ho = readHost(sessionId, { home }); if (!ho) await sleep(100); }
  if (!ho) { proc.kill(); throw new Error('host không ghi hồ sơ kịp'); }
  return { proc, home, sessionId, ho };
}

// Nối vào pipe và gửi bí mật ngay, như một client thật.
function noi(ho, { secret = ho.secret } = {}) {
  const c = net.createConnection(ho.pipe);
  const dec = createFrameDecoder();
  const khung = [];
  c.on('data', (d) => { for (const f of dec.push(d)) khung.push(f); });
  c.on('connect', () => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret }))));
  return { c, khung };
}

test('host ghi hồ sơ rồi phục vụ pipe', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  try {
    assert.ok(h.ho.pipe.startsWith('\\\\.\\pipe\\'), 'hồ sơ phải nói tên pipe');
    assert.ok(h.ho.secret && h.ho.secret.length >= 16, 'bí mật phải đủ dài');
    assert.equal(h.ho.pid > 0, true);
  } finally { h.proc.kill(); }
});

test('client gửi đúng bí mật thì nhận được byte của pty', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho);
  try {
    const hetGio = Date.now() + 15000;
    while (khung.length === 0 && Date.now() < hetGio) await sleep(100);
    assert.ok(khung.length > 0, 'phải nhận được gì đó từ pty');
    assert.equal(khung[0].kind, FRAME.PANE, 'byte pty phải đi bằng khung PANE');
  } finally { c.destroy(); h.proc.kill(); }
});

test('sai bí mật thì bị đóng ngay, không nhận được gì', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho, { secret: 'sai-be-bet' });
  try {
    let dongRoi = false;
    c.on('close', () => { dongRoi = true; });
    const hetGio = Date.now() + 10000;
    while (!dongRoi && Date.now() < hetGio) await sleep(100);
    assert.equal(dongRoi, true, 'phải bị đóng');
    assert.equal(khung.length, 0, 'không được gửi một byte pty nào cho client chưa xác thực');
  } finally { c.destroy(); h.proc.kill(); }
});

test('gõ vào pty thì thấy chữ vọng lại', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c, khung } = noi(h.ho);
  try {
    await sleep(1500); // để cmd.exe kịp khởi động
    c.write(encodeFrame(FRAME.PANE, 'echo MOC-HOST\r'));
    const hetGio = Date.now() + 15000;
    const thay = () => khung.map((f) => f.payload.toString('utf8')).join('');
    while (!/MOC-HOST/.test(thay()) && Date.now() < hetGio) await sleep(100);
    assert.match(thay(), /MOC-HOST/);
  } finally { c.destroy(); h.proc.kill(); }
});

test('một client ngắt không làm chết host', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const a = noi(h.ho);
  await sleep(1000);
  a.c.destroy();
  await sleep(1000);
  const b = noi(h.ho);
  try {
    const hetGio = Date.now() + 15000;
    while (b.khung.length === 0 && Date.now() < hetGio) await sleep(100);
    assert.ok(b.khung.length > 0, 'host phải còn sống và phục vụ client mới');
  } finally { b.c.destroy(); h.proc.kill(); }
});

test('pty thoát thì host dọn hồ sơ rồi tự thoát', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const { c } = noi(h.ho);
  // Bắt sự kiện thoát TRƯỚC khi bảo pty chết, nếu không nó bắn xong rồi mới có
  // người nghe. Hành vi 7 là hai việc — dọn hồ sơ VÀ tự thoát — nên phải khẳng
  // định cả hai: một host dọn hồ sơ rồi sống tiếp là một tiến trình giữ ConPTY
  // mà không ai còn tìm ra để tắt.
  const daThoat = new Promise((r) => h.proc.on('exit', () => r(true)));
  await sleep(1500);
  c.write(encodeFrame(FRAME.PANE, 'exit\r'));
  const hetGio = Date.now() + 20000;
  while (readHost(h.sessionId, { home: h.home }) && Date.now() < hetGio) await sleep(200);
  c.destroy();
  assert.equal(readHost(h.sessionId, { home: h.home }), null, 'hồ sơ phải bị dọn');
  const thoat = await Promise.race([daThoat, sleep(10000).then(() => false)]);
  assert.equal(thoat, true, 'host phải tự thoát chứ không chỉ dọn hồ sơ');
});

// Đọc số cột mà pty đang thật sự có, bằng cách hỏi chính cmd.exe.
//
// `cls` đi trước không phải cho gọn: đổi kích thước làm ConPTY vẽ lại cả màn
// hình, nên một dòng "Columns:" CŨ còn nằm trên màn hình sẽ được phát lại và
// đọc nhầm thành kết quả mới. Xoá màn hình trước thì không còn gì cũ để vẽ lại.
// Lấy khớp CUỐI CÙNG, cùng lý do.
async function doSoCot(client) {
  const truoc = client.khung.length;
  client.c.write(encodeFrame(FRAME.PANE, 'cls & mode con\r'));
  const hetGio = Date.now() + 15000;
  let cuoi = null;
  while (Date.now() < hetGio) {
    const moi = client.khung.slice(truoc).map((f) => f.payload.toString('utf8')).join('');
    // Neo vào hết dòng, không chỉ `\d+`: con số có thể tới làm hai khung —
    // "...Columns:        10" rồi mới tới "0" — và một khớp không neo sẽ đọc
    // ra 10 một cách im lặng, đúng kiểu sai mà bài test này sinh ra để bắt.
    for (const m of moi.matchAll(/Columns:\s+(\d+)\s*\r?\n/g)) cuoi = Number(m[1]);
    if (cuoi !== null) return cuoi;
    await sleep(100);
  }
  throw new Error('không đọc được số cột từ `mode con`');
}

// Chờ một dấu mốc hiện ra trong những khung MỚI của một client.
async function choMoc(client, truoc, moc, ms = 15000) {
  const hetGio = Date.now() + ms;
  const thay = () => client.khung.slice(truoc).map((f) => f.payload.toString('utf8')).join('');
  while (!moc.test(thay()) && Date.now() < hetGio) await sleep(100);
  return moc.test(thay());
}

test('kích thước do host tính: min trên các client, và trả lại khi một client rời', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const a = noi(h.ho);
  const b = noi(h.ho);
  try {
    await sleep(1500); // để cmd.exe kịp khởi động
    a.c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'resize', cols: 100, rows: 40 })));
    await sleep(300);
    b.c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'resize', cols: 40, rows: 20 })));
    await sleep(700);
    // Màn nhỏ nhất thắng. Client tự resize là hai client giẫm lên nhau — trên
    // tmux thì tmux chặn hộ, ở đây chính chỗ này là cái chặn.
    assert.equal(await doSoCot(a), 40, 'phải lấy min trên các client đang gắn');

    b.c.destroy();
    await sleep(1000);
    // Và không kẹt ở cái min của một client đã đi mất.
    assert.equal(await doSoCot(a), 100, 'client màn nhỏ rời đi thì bề rộng phải trả về cho người còn lại');
  } finally { a.c.destroy(); b.c.destroy(); h.proc.kill(); }
});

test('khung hỏng chỉ giết đúng kết nối ấy, host và client khác không sao', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const a = noi(h.ho);
  const b = noi(h.ho);
  try {
    await sleep(1500);
    let dongRoi = false;
    a.c.on('close', () => { dongRoi = true; });
    // Header khai độ dài 0xFFFFFFFF — vượt xa MAX_FRAME. pipe-frame.js nói rõ:
    // khung hỏng là hỏng HẲN, không đồng bộ lại, bên gọi phải bỏ kết nối.
    a.c.write(Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff]));
    const hetGio = Date.now() + 10000;
    while (!dongRoi && Date.now() < hetGio) await sleep(100);
    assert.equal(dongRoi, true, 'kết nối gửi khung hỏng phải bị đóng');

    const truoc = b.khung.length;
    b.c.write(encodeFrame(FRAME.PANE, 'echo MOC-CON-SONG\r'));
    assert.equal(await choMoc(b, truoc, /MOC-CON-SONG/), true, 'host phải còn sống và còn phục vụ client kia');
  } finally { a.c.destroy(); b.c.destroy(); h.proc.kill(); }
});

test('kết nối im lặng bị đóng khi hết giờ xác thực', { skip: CHI_WINDOWS }, async () => {
  // Rút cái trần xuống dưới một giây, chỉ để bài này không phải ngồi chờ đủ
  // mười giây thật.
  const h = await dungHost({ CCRC_HOST_AUTH_TIMEOUT_MS: '800' });
  const c = net.createConnection(h.ho.pipe);
  const dec = createFrameDecoder();
  const khung = [];
  c.on('data', (d) => { for (const f of dec.push(d)) khung.push(f); });
  try {
    let dongRoi = false;
    c.on('close', () => { dongRoi = true; });
    const hetGio = Date.now() + 10000;
    while (!dongRoi && Date.now() < hetGio) await sleep(100);
    assert.equal(dongRoi, true, 'kết nối không gửi bí mật phải bị đóng khi hết giờ');
    assert.equal(khung.length, 0, 'và không được nhận một byte pty nào');
  } finally { c.destroy(); h.proc.kill(); }
});
