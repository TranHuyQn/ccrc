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
import { readHost, writeHost } from '../src/host-registry.js';

const CHI_WINDOWS = process.platform !== 'win32';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const HOST = path.join(BIN, 'ccrc-host.js');
const CLIENT = path.join(BIN, 'ccrc-client.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dựng một host thật, cùng lối với ccrc-host.test.js: một CCRC_HOME riêng,
// `cmd.exe` thay cho `claude`. Chép chứ không import, vì import một file test
// là chạy lại toàn bộ bài của nó.
async function dungHost(themEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-client-'));
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
  const hetGio = Date.now() + 15000;
  let ho = null;
  while (!ho && Date.now() < hetGio) { ho = readHost(sessionId, { home }); if (!ho) await sleep(100); }
  if (!ho) { proc.kill(); throw new Error('host không ghi hồ sơ kịp'); }
  return { proc, home, sessionId, ho };
}

// Một client THÔ, nói thẳng giao thức — để quan sát host từ bên ngoài trong khi
// client thật đang chạy. Cố ý KHÔNG khai kích thước: host chỉ tính min trên
// những ai đã khai, nên client thô không được phép làm nhiễu phép đo ấy.
function noiTho(ho) {
  const c = net.createConnection(ho.pipe);
  const dec = createFrameDecoder();
  const khung = [];
  c.on('data', (d) => { for (const f of dec.push(d)) khung.push(f); });
  c.on('error', () => {});
  c.on('connect', () => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret: ho.secret }))));
  return { c, khung };
}

// Chạy client như một tiến trình con với stdin/stdout là ỐNG — tức là không
// phải terminal. Đây chính là ca mà raw mode không tồn tại, và client vẫn phải
// chuyển byte đúng.
function chayClient(sessionId, home) {
  const proc = spawn(process.execPath, [CLIENT, sessionId], {
    env: { ...process.env, CCRC_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let ra = '';
  let loi = '';
  proc.stdout.on('data', (d) => { ra += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { loi += d.toString('utf8'); });
  // Client thoát trước khi ta ngừng gõ là chuyện bình thường ở bài đua bên
  // dưới; không có listener thì lỗi ghi vào stdin của nó làm chết bộ test.
  proc.stdin.on('error', () => { /* client đã đi */ });
  const daThoat = new Promise((r) => proc.on('exit', (code) => r(code === null ? -1 : code)));
  return { proc, thay: () => ra, loiThay: () => loi, daThoat };
}

// Chờ một promise trong hạn; hết hạn thì trả về `TRE`.
const TRE = Symbol('quá hạn');
const trongHan = (p, ms) => Promise.race([p, sleep(ms).then(() => TRE)]);

async function choChu(thay, moc, ms = 15000) {
  const hetGio = Date.now() + ms;
  while (!moc.test(thay()) && Date.now() < hetGio) await sleep(100);
  return moc.test(thay());
}

test('không có hồ sơ thì nói rõ và thoát khác 0', { skip: CHI_WINDOWS }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-client-trong-'));
  const c = chayClient('khongcophien', home);
  const ma = await trongHan(c.daThoat, 15000);
  assert.notEqual(ma, TRE, 'không được treo');
  assert.notEqual(ma, 0, 'thiếu hồ sơ là thất bại, phải thoát khác 0');
  assert.match(c.loiThay(), /khongcophien/, 'câu báo phải nêu tên phiên');
  assert.match(c.loiThay(), /Không tìm thấy/, 'câu báo phải nói rõ chuyện gì');
});

test('bí mật sai thì thoát khác 0, không treo', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  try {
    // Hồ sơ trỏ đúng pipe nhưng mang bí mật cũ — đúng hình dạng của một hồ sơ
    // sót lại từ một host trước. Host sẽ đóng ngay và không nói một lời.
    assert.equal(writeHost({ ...h.ho, secret: 'sai-be-bet' }, { home: h.home }), true);
    const c = chayClient(h.sessionId, h.home);
    const ma = await trongHan(c.daThoat, 15000);
    assert.notEqual(ma, TRE, 'không được treo');
    assert.notEqual(ma, 0, 'bị từ chối là thất bại, phải thoát khác 0');
  } finally { h.proc.kill(); }
});

test('gõ vào stdin thì chữ hiện ra ở stdout', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const c = chayClient(h.sessionId, h.home);
  try {
    // Chờ ĐIỀU KIỆN: có byte của pty đã ra tới stdout, nghĩa là đã gắn xong.
    assert.equal(await choChu(c.thay, /\S/), true, 'phải thấy byte của pty trước đã');
    await sleep(800); // để cmd.exe kịp tới dấu nhắc
    c.proc.stdin.write('echo MOC-CLIENT\r');
    assert.equal(await choChu(c.thay, /MOC-CLIENT/), true, 'chữ gõ vào phải vọng ra stdout');
  } finally { c.proc.kill(); h.proc.kill(); }
});

test('host chết thì client thoát mã 0, không kêu ca', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const c = chayClient(h.sessionId, h.home);
  try {
    assert.equal(await choChu(c.thay, /\S/), true, 'phải gắn được trước đã');
    h.proc.kill();
    const ma = await trongHan(c.daThoat, 15000);
    assert.notEqual(ma, TRE, 'phải thoát trong hạn khi pipe đóng');
    assert.equal(ma, 0, 'pipe đóng là phiên hết, không phải lỗi');
  } finally { c.proc.kill(); h.proc.kill(); }
});

// Cuộc đua giữa "người dùng đang gõ" và "host vừa biến mất", và vì sao bài này
// nhồi dữ liệu chứ không gõ vài phím.
//
// `sock.writable` chỉ thành false khi đầu NÀY biết đầu kia đã đi, mà nó biết
// muộn hơn lúc đầu kia thật sự đóng. Một lượt ghi rơi vào khe ấy hỏng, và
// 'error' bắn TRƯỚC 'close' — nên một client coi mọi lỗi socket là thất bại sẽ
// thoát 1 và in đè `lỗi pipe: ...` lên khung cuối của phiên, trong khi hành vi
// 6 nói pipe đóng là thoát 0.
//
// Gõ nhẹ vài phím KHÔNG tái hiện được: đã đo, 15/15 lượt thoát 0 kể cả trên bản
// chưa vá, vì mỗi lượt ghi xong ngay trước khi có gì kịp đứt. Thứ tái hiện được
// là những lượt ghi CÒN ĐANG XẾP HÀNG lúc đầu kia biến mất — nhồi cho ống tắc
// rồi mới giết host. Đo lại: 15/15 thoát 1 trên bản chưa vá (`lỗi pipe: write
// EOF`), 15/15 thoát 0 trên bản đã vá. Đủ chắc để làm một bài test, không phải
// một cú may về thời điểm.
test('gõ đúng lúc host biến mất: phiên hết vẫn là phiên hết, không phải lỗi', { skip: CHI_WINDOWS }, async () => {
  const h = await dungHost();
  const c = chayClient(h.sessionId, h.home);
  try {
    assert.equal(await choChu(c.thay, /\S/), true, 'phải gắn được trước đã');
    const cuc = 'x'.repeat(64 * 1024);
    for (let k = 0; k < 40; k++) { try { c.proc.stdin.write(cuc); } catch { break; } }
    await sleep(20);
    h.proc.kill();
    const hetGo = Date.now() + 1500;
    while (Date.now() < hetGo) {
      try { c.proc.stdin.write(cuc); } catch { break; }
      await sleep(0);
    }
    const ma = await trongHan(c.daThoat, 20000);
    assert.notEqual(ma, TRE, 'không được treo');
    assert.equal(ma, 0, 'pipe đóng sau khi đã gắn là phiên hết, dù có phím nào lạc vào khe ấy hay không');
    assert.doesNotMatch(c.loiThay(), /lỗi pipe/,
      'và không được in một câu lỗi đè lên khung cuối cùng người dùng nhìn thấy');
  } finally { c.proc.kill(); h.proc.kill(); }
});

// --- những bài cần một terminal THẬT -----------------------------------------
//
// Raw mode, Ctrl+C và kích thước cửa sổ đều không tồn tại sau một cái ống. Ba
// hành vi ấy chỉ đo được khi client ngồi trong một ConPTY thật, nên ở đây ta
// dựng đúng thứ đó bằng node-pty — cùng gói mà host dùng.

// node-pty là `optionalDependency`, và nó là thế có lý do: `npm ci` bỏ qua nó
// khi máy không có prebuild hợp với phiên bản Node đang dùng. Thiếu nó thì hai
// bài dưới đây phải SKIP, không phải ĐỎ — đỏ ở đây là đổ lỗi cho client vì một
// gói mã máy không cài được. `ccrc-host.js` cũng bắt đúng ca này, chỉ khác là
// nó có một câu chỉ cách sửa.
//
// Trả về null nghĩa là đã skip; người gọi phải return ngay.
async function napPty(t) {
  try {
    const mod = await import('node-pty');
    return mod.default || mod;
  } catch (e) {
    t.skip(`node-pty chưa cài nên không dựng được ConPTY thật: ${e && e.message ? e.message : e}`);
    return null;
  }
}

// Đặt client vào một ConPTY có kích thước biết trước.
function chayClientTrongPty(pty, sessionId, home, { cols, rows }) {
  const term = pty.spawn(process.execPath, [CLIENT, sessionId], {
    cols,
    rows,
    cwd: home,
    env: { ...process.env, CCRC_HOME: home },
  });
  let ra = '';
  let song = true;
  let ma = null;
  term.onData((d) => { ra += typeof d === 'string' ? d : d.toString('utf8'); });
  term.onExit(({ exitCode }) => { song = false; ma = exitCode; });
  return { term, thay: () => ra, conSong: () => song, maThoat: () => ma };
}

// Hỏi chính cmd.exe xem pty đang RỘNG và CAO bao nhiêu. Đọc cả hai chứ không
// riêng cột: client khai cả `cols` lẫn `rows`, nên một bài chỉ soi cột sẽ vẫn
// xanh trên một client quên mất nửa kia.
//
// `cls` đi trước vì đổi kích thước làm ConPTY vẽ lại cả màn hình: một dòng
// "Columns:" CŨ sẽ được phát lại và đọc nhầm thành kết quả mới. Lấy khớp CUỐI
// CÙNG, cùng lý do.
async function doKichThuoc(tho) {
  const truoc = tho.khung.length;
  tho.c.write(encodeFrame(FRAME.PANE, 'cls & mode con\r'));
  const hetGio = Date.now() + 15000;
  let cot = null;
  let dong = null;
  while (Date.now() < hetGio) {
    const moi = tho.khung.slice(truoc).map((f) => f.payload.toString('utf8')).join('');
    // Neo vào hết dòng, không chỉ `\d+`: con số có thể tới làm hai khung —
    // "...Columns:        10" rồi mới tới "0" — và một khớp không neo sẽ đọc ra
    // 10 một cách im lặng, đúng kiểu sai mà phép đo này sinh ra để bắt.
    for (const m of moi.matchAll(/Columns:\s+(\d+)\s*\r?\n/g)) cot = Number(m[1]);
    for (const m of moi.matchAll(/Lines:\s+(\d+)\s*\r?\n/g)) dong = Number(m[1]);
    if (cot !== null && dong !== null) return { cot, dong };
    await sleep(100);
  }
  throw new Error(`không đọc được kích thước từ \`mode con\` (cot=${cot}, dong=${dong})`);
}

test('khai kích thước lúc nối, và khai lại mỗi lần cửa sổ đổi', { skip: CHI_WINDOWS }, async (t) => {
  const pty = await napPty(t);
  if (!pty) return;
  const h = await dungHost();
  const tho = noiTho(h.ho);
  const c = chayClientTrongPty(pty, h.sessionId, h.home, { cols: 57, rows: 19 });
  try {
    assert.equal(await choChu(c.thay, /\S/), true, 'client phải gắn được');
    await sleep(1200);
    // Cả hai chiều, và cả hai đều KHÁC mặc định 80×24 của host — nếu chúng
    // trùng mặc định thì bài này xanh cả trên một client không khai gì cả.
    assert.deepEqual(await doKichThuoc(tho), { cot: 57, dong: 19 },
      'host phải nhận được kích thước client khai lúc nối');

    c.term.resize(63, 21);
    await sleep(1500);
    assert.deepEqual(await doKichThuoc(tho), { cot: 63, dong: 21 },
      'đổi kích thước cửa sổ thì phải khai lại, cả cột lẫn dòng');
  } finally { tho.c.destroy(); try { c.term.kill(); } catch { /* đã chết */ } h.proc.kill(); }
});

// Bài Ctrl+C, và hai điều ĐO ĐƯỢC đã quyết định hình dạng của nó. Cả hai đều
// làm một bản viết theo trực giác đỏ oan, nên chúng nằm đây chứ không nằm
// trong đầu ai:
//
//  1. cmd.exe dưới ConPTY KHÔNG in "^C". Nó chỉ xuống dòng và in một dấu nhắc
//     mới, còn dòng đang gõ thì không bao giờ chạy. Tìm chuỗi "^C" là tìm một
//     thứ không tồn tại.
//
//  2. Không được khẳng định trên thứ ConPTY BAO NGOÀI client vẽ ra. Đo được:
//     một dòng kết quả tới nơi dưới dạng "[?25lSAU-CTRLC[9;1H" —
//     ConPTY định vị con trỏ chứ không xuống dòng, nên mọi mẫu kiểu "\nX\n"
//     đều trượt. Bằng chứng phải lấy từ LUỒNG CỦA HOST, qua một người quan
//     sát nói thẳng giao thức; ở đó byte là thứ pty thật sự đã in.
//
// Kịch bản: gõ dở một dòng, bấm Ctrl+C, rồi gõ một lệnh khác và Enter.
//   * 0x03 tới nơi   → dòng dở bị bỏ và dấu nhắc mới hiện ra ngay sau nó, nên
//     lệnh kế tiếp được gõ vào một dòng SẠCH: ">echo SAU-CTRLC".
//   * 0x03 bị nuốt   → dòng dở còn nguyên, lệnh kế tiếp DÍNH vào nó thành
//     ">echo KHONG-DUOC-CHAYecho SAU-CTRLC", và cả hai phép so dưới đây đỏ.
test('Ctrl+C là một byte gõ vào, không phải lệnh giết client', { skip: CHI_WINDOWS }, async (t) => {
  const pty = await napPty(t);
  if (!pty) return;
  // PROMPT=$G rút dấu nhắc của cmd.exe xuống đúng một ký tự ">". Không phải cho
  // gọn mắt: dấu nhắc mặc định là "user@máy <đường dẫn thư mục tạm>" — dài,
  // và dài bao nhiêu thì tuỳ tên thư mục tạm bốc thăm được. Cộng thêm lệnh gõ
  // vào là chạm 80 cột và dòng bị ngắt, khiến bài test đỏ theo cách không liên
  // quan gì tới điều nó đang đo.
  const h = await dungHost({ PROMPT: '$G' });
  const tho = noiTho(h.ho);
  const c = chayClientTrongPty(pty, h.sessionId, h.home, { cols: 80, rows: 24 });
  const thayTho = () => tho.khung.map((f) => f.payload.toString('utf8')).join('');
  try {
    assert.equal(await choChu(c.thay, /\S/), true, 'client phải gắn được');
    await sleep(1500);
    c.term.write('echo KHONG-DUOC-CHAY'); // gõ dở, CHƯA Enter
    assert.equal(await choChu(thayTho, /echo KHONG-DUOC-CHAY/), true, 'chữ gõ vào phải tới được pty');
    c.term.write('\x03');
    await sleep(1500);
    // Hành vi 7, nửa thứ nhất: Ctrl+C không được giết client.
    assert.equal(c.conSong(), true, `client không được chết vì Ctrl+C (mã ${c.maThoat()})`);

    // Hành vi 7, nửa thứ hai: byte ấy phải tới được pty.
    c.term.write('echo SAU-CTRLC\r');
    assert.equal(await choChu(thayTho, />echo SAU-CTRLC\r/), true,
      'lệnh sau Ctrl+C phải nằm trên một dòng SẠCH — dính vào dòng cũ nghĩa là 0x03 đã bị nuốt');
    assert.match(thayTho(), /KHONG-DUOC-CHAY\r\n\r\n>/,
      'dòng gõ dở phải kết thúc bằng một dấu nhắc mới, không phải bằng kết quả của nó');
  } finally { tho.c.destroy(); try { c.term.kill(); } catch { /* đã chết */ } h.proc.kill(); }
});
