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
import { readHost, writeHost, removeHost } from '../src/host-registry.js';
import { createConptyPaneSource } from '../src/pane-source-conpty.js';

// Cả file chỉ có nghĩa trên Windows: nó dựng `ccrc-host` thật (host tự chặn
// nền tảng và thoát ngay ở nơi khác) và mở named pipe. Skip sạch ở nơi khác,
// đúng như ccrc-host.test.js.
const CHI_WINDOWS = process.platform !== 'win32';
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chờ ĐIỀU KIỆN, không chờ một con số mili giây. Máy Windows trong bộ test này
// mất hơn một giây chỉ để cmd.exe chịu nhận phím.
async function cho(dieuKien, ms = 20000) {
  const hetGio = Date.now() + ms;
  for (;;) {
    if (dieuKien()) return true;
    if (Date.now() > hetGio) return false;
    await sleep(100);
  }
}

// Bỏ khung mà screen-buffer đóng quanh mỗi ảnh chụp, để đếm dòng cho đúng.
function boKhung(s) {
  return s.replace(/^\x1b\[2J\x1b\[H/, '').replace(/\x1b\[0m$/, '');
}

// --- host thật ---------------------------------------------------------------

// Nhân bản có chủ ý của dungHost trong ccrc-host.test.js — cùng lý do
// pane-source.test.js nhân bản withSession: sửa một file test đang xanh để
// dùng chung vài dòng là đánh đổi sai.
//
// `cmd.exe` chứ KHÔNG BAO GIỜ `claude`: một bài test không được phép chạm vào
// ~/.claude của người dùng.
async function dungHost(themEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-conpty-'));
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
  const hetGio = Date.now() + 20000;
  let ho = null;
  while (!ho && Date.now() < hetGio) { ho = readHost(sessionId, { home }); if (!ho) await sleep(100); }
  if (!ho) { proc.kill(); throw new Error('host không ghi hồ sơ kịp'); }
  return { proc, home, sessionId, ho };
}

// Một client thô nối thẳng vào pipe, như ccrc-client. Dùng để dựng trạng thái
// màn hình TRƯỚC khi nguồn pane ra đời (bài "mồi"), và để chứng minh host còn
// phục vụ được người mới.
function noiTho(ho) {
  const c = net.createConnection(ho.pipe);
  const dec = createFrameDecoder();
  const khung = [];
  c.on('error', () => {});
  c.on('data', (d) => { for (const f of dec.push(d)) khung.push(f); });
  c.on('connect', () => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret: ho.secret }))));
  return { c, khung, chu: () => khung.filter((f) => f.kind === FRAME.PANE).map((f) => f.payload.toString('utf8')).join('') };
}

// --- host giả ----------------------------------------------------------------

// Vì sao cần: ba thứ dưới đây không dựng lại được qua một ConPTY thật một cách
// tin cậy — byte mà ứng dụng in ra ĐÚNG NHƯ Ý (ESC[?1000h qua cmd.exe phải đi
// vòng qua một biến môi trường rồi vẫn còn tuỳ conhost có chuyển tiếp hay
// không), thời điểm ống đứt trong khi phiên vẫn sống, và nội dung byte mà một
// lượt dán thật sự đẩy ra ống. Hợp đồng của module này là với GIAO THỨC PIPE,
// nên dựng đúng đầu kia của giao thức là đo đúng thứ cần đo.
async function dungHostGia() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-gia-'));
  const sessionId = 'gia' + crypto.randomBytes(4).toString('hex');
  const pipe = `\\\\.\\pipe\\ccrc-gia-${crypto.randomBytes(8).toString('hex')}`;
  const secret = crypto.randomBytes(16).toString('hex');
  const nhan = [];
  const socks = new Set();
  const server = net.createServer((s) => {
    socks.add(s);
    const dec = createFrameDecoder();
    s.on('error', () => s.destroy());
    s.on('data', (d) => { for (const f of dec.push(d)) nhan.push(f); });
    s.on('close', () => socks.delete(s));
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(pipe, r); });
  // pid của CHÍNH tiến trình test: hồ sơ vì thế luôn trỏ vào một pid còn sống,
  // đúng điều kiện của nhánh fatal:false.
  writeHost({ sessionId, pid: process.pid, pipe, secret, cwd: home, createdAt: Date.now() }, { home });
  return {
    home, sessionId, pipe, secret, nhan, socks,
    guiPane(text) { for (const s of socks) s.write(encodeFrame(FRAME.PANE, text)); },
    cat() { for (const s of socks) s.destroy(); },
    dep() { try { server.close(); } catch {} for (const s of socks) { try { s.destroy(); } catch {} } },
    chuNhan() {
      return nhan.filter((f) => f.kind === FRAME.PANE).map((f) => f.payload.toString('utf8')).join('');
    },
  };
}

// --- bài test ----------------------------------------------------------------

test('attach() xong thì bản sao đã được mồi bằng màn hình đang có', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const truoc = noiTho(h.ho);
  let ng = null;
  try {
    // Dựng chữ trên màn hình TRƯỚC khi nguồn pane tồn tại. Chữ này vì thế chỉ
    // có thể tới bằng ảnh chụp lúc gắn — không phải bằng dòng chảy trực tiếp.
    assert.equal(await cho(() => truoc.chu().length > 0), true, 'client thô phải thấy byte của pty');
    await sleep(1500);
    truoc.c.write(encodeFrame(FRAME.PANE, 'echo MOC-MOI\r'));
    assert.equal(await cho(() => /MOC-MOI/.test(truoc.chu())), true, 'phải chạy được lệnh mồi');
    truoc.c.destroy();
    await sleep(500);

    ng = createConptyPaneSource({ sessionId: h.sessionId, home: h.home });
    assert.equal(ng.alive(), true);
    const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    assert.equal(gan.ok, true, gan.message);
    assert.equal(await cho(() => /MOC-MOI/.test(ng.snapshot())), true,
      'snapshot() phải chứa chữ đã có trên màn hình từ trước khi gắn');
    gan.conn.close();
  } finally { truoc.c.destroy(); h.proc.kill(); }
});

test('type() gõ vào phiên thật và chữ hiện ra trong snapshot() cục bộ', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const ng = createConptyPaneSource({ sessionId: h.sessionId, home: h.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  try {
    assert.equal(gan.ok, true, gan.message);
    await sleep(1500); // để cmd.exe kịp nhận phím
    gan.conn.type(Buffer.from('echo MOC-TYPE\r', 'utf8'));
    assert.equal(await cho(() => /MOC-TYPE/.test(ng.snapshot())), true,
      'chữ gõ vào phải quay lại trong bản sao màn hình');
  } finally { gan.conn.close(); h.proc.kill(); }
});

test('historySize() tăng khi màn hình cuộn, history() trả đúng số dòng', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const ng = createConptyPaneSource({ sessionId: h.sessionId, home: h.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  try {
    assert.equal(gan.ok, true, gan.message);
    await sleep(1500);
    assert.equal(ng.historySize(), 0, 'chưa cuộn thì chưa có dòng nào ở trên');
    gan.conn.type(Buffer.from('for /L %i in (1,1,60) do @echo DONG-%i\r', 'utf8'));
    assert.equal(await cho(() => ng.historySize() >= 30), true,
      `phải cuộn được ít nhất 30 dòng lên trên (thấy ${ng.historySize()})`);
    const man = ng.history(5, 10);
    assert.ok(man.startsWith('\x1b[2J\x1b[H'), 'history() phải đóng khung y như bản tmux');
    assert.equal(boKhung(man).split('\r\n').length, 10, 'phải trả đúng 10 dòng');
    assert.equal(ng.history(0, 10), '', 'offset 0 không phải lịch sử');
  } finally { gan.conn.close(); h.proc.kill(); }
});

test('host chết thì onGone({fatal:true}) — phiên hết, không phải mất đường tiếp sức', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const ng = createConptyPaneSource({ sessionId: h.sessionId, home: h.home });
  const bao = [];
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (g) => bao.push(g) });
  try {
    assert.equal(gan.ok, true, gan.message);
    await sleep(1500);
    // proc.kill() trên Windows là TerminateProcess: host KHÔNG kịp dọn hồ sơ,
    // nên đây đo đúng nhánh "hồ sơ còn nhưng pid đã chết" — nhánh dễ trả lời
    // sai nhất, vì hồ sơ vẫn nằm đó trông như một phiên sống.
    h.proc.kill();
    assert.equal(await cho(() => bao.length > 0), true, 'phải báo mất phiên');
    assert.equal(bao[0].fatal, true, 'host chết là fatal — trình duyệt không được nối lại vô hạn');
    assert.notEqual(readHost(h.sessionId, { home: h.home }), null,
      'hồ sơ vẫn còn sau TerminateProcess — quyết định phải dựa vào pid, không dựa vào sự tồn tại của hồ sơ');
  } finally { gan.conn.close(); h.proc.kill(); }
});

test('close() không giết host: phiên sống tiếp và phục vụ được client mới', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const ng = createConptyPaneSource({ sessionId: h.sessionId, home: h.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  let sau = null;
  try {
    assert.equal(gan.ok, true, gan.message);
    await sleep(1500);
    gan.conn.close();
    await sleep(500);
    assert.equal(ng.alive(), true, 'phiên phải còn sống sau khi đóng kết nối');
    sau = noiTho(h.ho);
    assert.equal(await cho(() => sau.chu().length > 0), true, 'host phải phục vụ được client mới');
    sau.c.write(encodeFrame(FRAME.PANE, 'echo MOC-SAU\r'));
    assert.equal(await cho(() => /MOC-SAU/.test(sau.chu())), true, 'và phiên vẫn nhận phím');
  } finally { if (sau) sau.c.destroy(); h.proc.kill(); }
});

test('mouseMode() mặc định tắt, bật theo đúng byte ứng dụng in ra', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  try {
    assert.equal(gan.ok, true, gan.message);
    assert.deepEqual(ng.mouseMode(), { mouse: false, sgr: false });
    assert.equal(await cho(() => g.socks.size > 0), true, 'adapter phải nối vào');
    g.guiPane('\x1b[?1000h\x1b[?1006h');
    assert.equal(await cho(() => ng.mouseMode().mouse === true), true, 'ESC[?1000h phải bật chuột');
    assert.deepEqual(ng.mouseMode(), { mouse: true, sgr: true });
  } finally { gan.conn.close(); g.dep(); }
});

test('khung đầu tiên gửi cho host là bí mật, trước mọi thứ khác', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  try {
    assert.equal(gan.ok, true, gan.message);
    // Gõ NGAY, trước khi ống kịp nối xong: lời chào vẫn phải đi trước. Sai thứ
    // tự ở đây thì host đóng câm và không ai biết vì sao.
    gan.conn.type(Buffer.from('x', 'utf8'));
    assert.equal(await cho(() => g.nhan.length >= 2), true, 'host giả phải nhận được hai khung');
    assert.equal(g.nhan[0].kind, FRAME.CONTROL);
    assert.deepEqual(JSON.parse(g.nhan[0].payload.toString('utf8')), { type: 'auth', secret: g.secret });
    assert.equal(g.nhan[1].kind, FRAME.PANE);
  } finally { gan.conn.close(); g.dep(); }
});

test('paste(): byte thật đi ra ống rồi mới onAck, và có cú Enter kết thúc', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  try {
    assert.equal(gan.ok, true, gan.message);
    const loi = [];
    let ack = 0;
    gan.conn.paste('xin chào', { onAck: () => { ack += 1; }, onErr: (m) => loi.push(m) });
    assert.equal(await cho(() => ack > 0), true, 'phải có ack');
    assert.deepEqual(loi, [], 'không được báo lỗi');
    assert.equal(await cho(() => /xin chào\r/.test(g.chuNhan())), true,
      'host phải nhận đúng nội dung dán, kết thúc bằng CR');
    assert.equal(ack, 1, 'ack đúng một lần');
  } finally { gan.conn.close(); g.dep(); }
});

test('ống đứt mà phiên còn sống → onGone({fatal:false}), trình duyệt được nối lại', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
  const bao = [];
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (x) => bao.push(x) });
  try {
    assert.equal(gan.ok, true, gan.message);
    assert.equal(await cho(() => g.socks.size > 0), true);
    // Hồ sơ còn nguyên và pid (tiến trình test này) còn sống — chỉ đường tiếp
    // sức mất. Trả fatal:true ở đây là giết một phiên vẫn đang chạy.
    g.cat();
    assert.equal(await cho(() => bao.length > 0), true, 'phải báo');
    assert.equal(bao[0].fatal, false, 'pipe đứt mà host còn sống KHÔNG phải hết phiên');
  } finally { gan.conn.close(); g.dep(); }
});

test('hồ sơ biến mất thì cùng cái đứt ấy thành fatal:true', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
  const bao = [];
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (x) => bao.push(x) });
  try {
    assert.equal(gan.ok, true, gan.message);
    assert.equal(await cho(() => g.socks.size > 0), true);
    // Đúng thứ ccrc-host làm khi đóng đàng hoàng: xoá hồ sơ TRƯỚC, rồi mới bỏ
    // các socket. Quyết định phải đọc trạng thái ấy, chứ không đọc trạng thái
    // của socket.
    removeHost(g.sessionId, { home: g.home });
    g.cat();
    assert.equal(await cho(() => bao.length > 0), true, 'phải báo');
    assert.equal(bao[0].fatal, true, 'không còn hồ sơ nghĩa là phiên đã hết');
  } finally { gan.conn.close(); g.dep(); }
});

test('kích thước khai với host là nhỏ nhất trên các kết nối, và trả lại khi một kết nối rời', { skip: CHI_WINDOWS }, async () => {
  // Gộp một ống cho cả nguồn có cái giá của nó: host chỉ còn thấy MỘT client
  // nên phép "màn nhỏ nhất thắng" của nó không phân biệt được hai trình duyệt
  // của ta nữa. Phép ấy được dựng lại trong adapter — và đây là chỗ canh nó.
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    const c1 = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} }).conn;
    const c2 = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} }).conn;
    const dk = () => g.nhan.filter((f) => f.kind === FRAME.CONTROL)
      .map((f) => JSON.parse(f.payload.toString('utf8'))).filter((m) => m.type === 'resize');
    c1.resize(100, 40);
    c2.resize(40, 20);
    assert.equal(await cho(() => dk().some((m) => m.cols === 40 && m.rows === 20)), true,
      `phải khai màn nhỏ nhất (${JSON.stringify(dk())})`);
    c2.close();
    assert.equal(await cho(() => dk().some((m) => m.cols === 100 && m.rows === 40)), true,
      `màn hẹp rời đi thì phải khai lại màn của người còn lại (${JSON.stringify(dk())})`);
    c1.close();
  } finally { g.dep(); }
});

test('một mảng byte tới được MỌI kết nối đang gắn', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    const x = []; const y = [];
    const c1 = ng.attach({ onData: (d) => x.push(d), onCtlReply: () => {}, onGone: () => {} }).conn;
    const c2 = ng.attach({ onData: (d) => y.push(d), onCtlReply: () => {}, onGone: () => {} }).conn;
    assert.equal(await cho(() => g.socks.size > 0), true);
    g.guiPane('CHAO-CA-HAI');
    assert.equal(await cho(() => x.join('').includes('CHAO-CA-HAI') && y.join('').includes('CHAO-CA-HAI')), true,
      'ống dùng chung phải phát cho cả hai kết nối');
    c1.close(); c2.close();
  } finally { g.dep(); }
});

test('kết nối gắn vào GIỮA LÚC một mảng byte đang bay vẫn nhận được nó', { skip: CHI_WINDOWS }, async () => {
  // Cửa sổ này rộng trọn một lượt macrotask (xem đầu pane-source-conpty.js), và
  // sự kiện `connection` của WebSocket rơi vào đúng đó mỗi khi terminal đang
  // chảy chữ. Dựng lại nó cho chắc chắn bằng cách gắn kết nối thứ hai NGAY
  // TRONG lượt phát của kết nối thứ nhất.
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    const sau = [];
    let c2 = null;
    let anhChup = null;
    const c1 = ng.attach({
      onData: (d) => {
        if (c2 || !d.includes('BAY-QUA-KHE')) return;
        // Ảnh chụp lúc này CHƯA có chữ ấy — người gọi (ccrc-term.js) hỏi
        // snapshot() rồi mới attach(), đúng thứ tự này.
        anhChup = ng.snapshot();
        c2 = ng.attach({ onData: (x) => sau.push(x), onCtlReply: () => {}, onGone: () => {} }).conn;
      },
      onCtlReply: () => {},
      onGone: () => {},
    }).conn;
    assert.equal(await cho(() => g.socks.size > 0), true);
    g.guiPane('BAY-QUA-KHE');
    assert.equal(await cho(() => c2 !== null), true, 'kết nối thứ hai phải gắn được');
    // Nếu ảnh chụp ĐÃ có chữ ấy thì bài này không còn đo cái nó định đo — lượt
    // ghi đã kịp xong, và cửa sổ mất chữ không mở ra. Khẳng định để bài không
    // âm thầm biến thành một bài luôn xanh.
    assert.ok(!anhChup.includes('BAY-QUA-KHE'),
      'ảnh chụp lấy trong khe phải CHƯA có mảng đang bay');
    assert.equal(sau.join('').includes('BAY-QUA-KHE'), true,
      'kết nối gắn trong khe phải được gửi bù mảng đang bay, nếu không nó mất hẳn');
    c1.close();
    if (c2) c2.close();
  } finally { g.dep(); }
});

test('mouse() gửi byte thô bằng khung PANE', { skip: CHI_WINDOWS }, async () => {
  // Sai kiểu khung ở đây KHÔNG báo lỗi ở đâu cả: host bỏ im lặng mọi khung
  // CONTROL nó chưa hiểu, nên một cú chạm ngón tay biến mất không dấu vết.
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    const conn = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} }).conn;
    const byte = Buffer.from('\x1b[<64;10;5M', 'binary');
    conn.mouse(byte);
    assert.equal(await cho(() => g.nhan.filter((f) => f.kind === FRAME.PANE).length > 0), true,
      'byte chuột phải tới host');
    const pane = g.nhan.filter((f) => f.kind === FRAME.PANE);
    assert.equal(pane.length, 1);
    assert.equal(pane[0].payload.toString('binary'), byte.toString('binary'),
      'byte phải đi nguyên vẹn — một vòng qua chuỗi là toạ độ sai âm thầm');
    assert.equal(g.nhan.filter((f) => f.kind === FRAME.CONTROL).length, 1,
      'chỉ có đúng lời chào là khung điều khiển');
    conn.close();
  } finally { g.dep(); }
});

test('paste() hỏng: onErr đúng MỘT lần, không bao giờ có ack, và hàng đợi không kẹt', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    const bao = [];
    const conn = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (x) => bao.push(x) }).conn;
    assert.equal(await cho(() => g.socks.size > 0), true);
    g.cat();
    assert.equal(await cho(() => bao.length > 0), true, 'ống phải đứt trước đã');

    const loi = [];
    let ack = 0;
    conn.paste('tin nhắn không bao giờ đi được', { onAck: () => { ack += 1; }, onErr: (m) => loi.push(m) });
    assert.equal(await cho(() => loi.length > 0), true, 'phải báo hỏng');
    // Đây là điều quan trọng nhất cả bài: im lặng ở đây nghĩa là ô soạn phía
    // người dùng trống đi như đã gửi, còn tin nhắn thì chưa từng tồn tại.
    assert.equal(ack, 0, 'KHÔNG được ack một tin nhắn chưa từng ra khỏi máy');

    // Chờ qua cả cái trần 5 giây: đó là chỗ dễ bắn thêm một lời báo thứ hai
    // cho cùng một lượt dán, và lời thứ hai thì vô nghĩa.
    await sleep(5600);
    assert.equal(loi.length, 1, `đúng một lời báo (thấy ${loi.length})`);
    assert.equal(ack, 0, 'và vẫn không có ack');

    // Hàng đợi gõ phím của kết nối ấy không được chết câm sau một lượt hỏng —
    // đúng bài học mà bản tmux ghi ở PASTE_LOAD_TIMEOUT_MS.
    const loi2 = [];
    conn.paste('lượt sau', { onAck: () => { ack += 1; }, onErr: (m) => loi2.push(m) });
    assert.equal(await cho(() => loi2.length > 0), true, 'lượt dán sau vẫn phải chạy tới nơi');
    assert.equal(ack, 0);
    conn.close();
  } finally { g.dep(); }
});

test('attach() từ chối ngay khi phiên không còn', { skip: CHI_WINDOWS }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-vang-'));
  const ng = createConptyPaneSource({ sessionId: 'khongcothat', home });
  assert.equal(ng.alive(), false);
  const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  assert.equal(gan.ok, false);
  assert.equal(typeof gan.message, 'string');
});

test('cwd() và socket() đọc từ hồ sơ host', { skip: CHI_WINDOWS }, async () => {
  const g = await dungHostGia();
  try {
    const ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
    assert.equal(ng.cwd(), g.home);
    assert.equal(ng.socket(), g.pipe);
  } finally { g.dep(); }
});


// Nửa còn lại của bản vá "cửa sổ rộng trở lại": host đã có verb `0×0` = rút lại
// ràng buộc, nhưng phải có ai đó GỬI nó. Người gửi là adapter, và đây là bài
// duy nhất chứng minh nó gửi thật — ba bài trong kich-thuoc-tra-lai.test.js
// kiểm host bằng một client giả tự gửi `0×0`, nên chúng KHÔNG chạm tới đường
// này.
test('kết nối cuối cùng rời đi thì adapter RÚT LẠI ràng buộc kích thước',
  { skip: CHI_WINDOWS }, async () => {
    const g = await dungHostGia();
    let ng;
    try {
      ng = createConptyPaneSource({ sessionId: g.sessionId, home: g.home });
      const gan = ng.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
      assert.equal(gan.ok, true);

      const khungDieuKhien = () => g.nhan
        .filter((f) => f.kind === FRAME.CONTROL)
        .map((f) => { try { return JSON.parse(f.payload.toString('utf8')); } catch { return null; } })
        .filter(Boolean)
        .filter((m) => m.type === 'resize');

      gan.conn.resize(50, 20);
      await new Promise((r) => setTimeout(r, 300));
      const sauKhiKhai = khungDieuKhien();
      assert.deepEqual(sauKhiKhai[sauKhiKhai.length - 1], { type: 'resize', cols: 50, rows: 20 },
        'adapter phải khai kích thước của người xem');

      gan.conn.close();
      await new Promise((r) => setTimeout(r, 300));
      const sauKhiDong = khungDieuKhien();
      assert.deepEqual(sauKhiDong[sauKhiDong.length - 1], { type: 'resize', cols: 0, rows: 0 },
        'không còn ai xem thì phải gửi 0×0; giữ con số cũ là ghim pty theo một '
        + 'chiếc điện thoại đã đóng trình duyệt');
    } finally { if (ng) { try { ng.close(); } catch { /* đã đóng */ } } g.dep(); }
  });
