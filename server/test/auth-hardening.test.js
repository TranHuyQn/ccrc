// Ba chốt mà SECURITY.md tự khai là còn thiếu, kiểm qua HTTP thật. Cùng khuôn
// startHub với device-api.test.js — cùng lý do: mấy chốt này chỉ có nghĩa khi
// đi hết đường thật (Express, header, req.ip), không phải khi gọi hàm trần.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenAddr } from '../src/listen-addr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(HERE, '..', 'src', 'index.js');

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

async function startHub(extraEnv, host = '127.0.0.1') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hard-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'),
    JSON.stringify([{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok-huy' }]));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: {
      ...process.env,
      CCRC_DATA_DIR: dataDir,
      CCRC_PORT: String(port),
      CCRC_TOKEN: 'admin-tok',
      CCRC_TRUST_PROXY: '',
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const base = `http://${host}:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, port, stop: () => proc.kill(), stderr: () => stderr };
}

const me = (base, token) => fetch(base + '/api/me', {
  headers: token === null ? {} : { authorization: 'Bearer ' + token },
});

// --- 1. Dò token bị chặn ---------------------------------------------------

// Gộp mã trả về và dòng log vào MỘT bài: cả hai đọc cùng một lần vượt trần, và
// mỗi bài ở đây tốn một tiến trình hub thật — tách ra chỉ để đọc cho đẹp là trả
// giá bằng thời gian chạy của cả bộ test, thứ đã từng làm các bài khác chập chờn.
test('token sai lặp lại từ một IP → 429 kèm retry-after, và log đúng MỘT dòng', async () => {
  const h = await startHub();
  try {
    const codes = [];
    for (let i = 0; i < 30; i += 1) codes.push((await me(h.base, `sai-${i}`)).status);
    assert.deepEqual(codes.slice(0, 20), Array(20).fill(401), `20 lượt đầu phải là 401: ${codes}`);
    assert.equal(codes[20], 429, `lượt 21 phải bị chặn, nhận ${codes[20]}`);
    const r = await me(h.base, 'sai-lan-nua');
    assert.ok(Number(r.headers.get('retry-after')) > 0, 'phải nói khi nào thử lại được');
    const dong = h.stderr().split('\n').filter((l) => /token sai/i.test(l));
    assert.equal(dong.length, 1,
      `log phải đúng một dòng cho mỗi cửa sổ, thấy ${dong.length} — chính kẻ tấn công điều khiển độ dài log`);
  } finally { h.stop(); }
});

// Chốt quan trọng nhất của thiết kế này: người dùng thật KHÔNG bao giờ bị khoá
// theo lây. Đếm ở nhánh hỏng, và token đúng đi thẳng qua — nếu không, một hub
// sau proxy mà quên CCRC_TRUST_PROXY sẽ gộp cả nhóm vào một rổ và một kẻ dò
// token có thể khoá cả team ra khỏi hub của họ.
test('bị chặn rồi thì token ĐÚNG từ cùng IP vẫn vào được', async () => {
  const h = await startHub();
  try {
    for (let i = 0; i < 25; i += 1) await me(h.base, `sai-${i}`);
    assert.equal((await me(h.base, 'sai-nua')).status, 429, 'chưa chặn thì test này vô nghĩa');
    const r = await me(h.base, 'tok-huy');
    assert.equal(r.status, 200, 'người dùng hợp lệ bị khoá lây — tệ hơn cả lỗ hổng đang vá');
    assert.equal((await r.json()).user, 'huy');
  } finally { h.stop(); }
});

// --- 2. So sánh token của admin ------------------------------------------

// timingSafeEqual NÉM khi hai buffer khác độ dài. Một bản vá ngây thơ thay
// `===` bằng nó là biến mọi token sai độ dài thành 500 — tức là vá một chỗ
// không khai thác được và mở ra một chỗ khai thác được.
test('token admin sai ĐỘ DÀI vẫn là 401, không phải 500', async () => {
  const h = await startHub();
  try {
    for (const bad of ['x', 'admin-tok-dai-hon-han', '', 'admin-to']) {
      const r = await me(h.base, bad);
      assert.equal(r.status, 401, `token "${bad}" phải bị từ chối gọn gàng, nhận ${r.status}`);
    }
    // Không header thì không có gì để so — nhánh này phải dừng TRƯỚC chỗ so sánh.
    assert.equal((await me(h.base, null)).status, 401, 'thiếu Authorization phải là 401, không nổ');
    assert.equal((await me(h.base, 'admin-tok')).status, 200, 'token admin đúng phải vào được');
  } finally { h.stop(); }
});

// --- 3. Địa chỉ bind ------------------------------------------------------

test('mặc định vẫn nghe mọi interface — Docker sống nhờ điều đó', () => {
  assert.equal(listenAddr({}), '0.0.0.0');
  assert.equal(listenAddr({ CCRC_BIND: '' }), '0.0.0.0');
  assert.equal(listenAddr({ CCRC_BIND: '   ' }), '0.0.0.0');
});

test('CCRC_BIND được tôn trọng khi chạy Node trực tiếp', () => {
  assert.equal(listenAddr({ CCRC_BIND: '127.0.0.1' }), '127.0.0.1');
  assert.equal(listenAddr({ CCRC_BIND: ' 10.0.0.5 ' }), '10.0.0.5');
});

// Địa chỉ ngoài loopback đầu tiên của máy này, hoặc null. Cần một địa chỉ THẬT
// KHÁC vì phép đo duy nhất chứng minh được bản vá là "gọi vào địa chỉ khác thì
// KHÔNG tới" — còn "gọi được ở địa chỉ đã bind" thì đúng cả khi app nghe mọi
// interface, tức là không phân biệt được vá hay chưa.
//
// Không dùng 127.0.0.2 (loopback thứ hai): Linux có, macOS đo được là KHÔNG
// (EADDRNOTAVAIL), và máy chính của dự án này chạy macOS.
function diaChiNgoaiLoopback() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

test('CCRC_BIND thật sự đóng các địa chỉ khác, không chỉ mở địa chỉ được chọn', async (t) => {
  const lan = diaChiNgoaiLoopback();
  // Nói thẳng là chưa đo, thay vì để một bài test luôn xanh đứng thay cho bằng
  // chứng: máy không có interface nào ngoài loopback thì không có cách nào
  // phân biệt "đã bind loopback" với "nghe mọi thứ".
  if (!lan) return t.skip('máy này không có địa chỉ ngoài loopback — không đo được');
  const h = await startHub({ CCRC_BIND: '127.0.0.1' });
  try {
    assert.ok((await fetch(`http://127.0.0.1:${h.port}/healthz`)).ok, 'địa chỉ đã bind phải vào được');
    let reached = false;
    try {
      await fetch(`http://${lan}:${h.port}/healthz`, { signal: AbortSignal.timeout(2000) });
      reached = true;
    } catch { /* đúng như mong đợi: không ai nghe ở đây */ }
    assert.equal(reached, false,
      `vẫn nghe trên ${lan} dù đã bind 127.0.0.1 — CCRC_BIND chỉ là trang trí, và cổng vẫn mở ra cả LAN`);
  } finally { h.stop(); }
});

// Cái bẫy khiến bản vá này có thể tự bắn vào chân: trong container, app PHẢI
// nghe 0.0.0.0 để cloudflared ở network khác gọi tới `http://hub:8720`. Biến
// CCRC_BIND của compose chỉ dành cho vế `ports:` của HOST. Truyền nó vào
// `environment:` là hub chết câm sau lần deploy kế tiếp, và triệu chứng (530
// từ Cloudflare) trông y hệt lỗi tunnel đã từng mất 24 giờ để tìm ra.
test('compose KHÔNG được truyền CCRC_BIND vào environment của hub', () => {
  const yml = fs.readFileSync(path.join(HERE, '..', '..', 'docker-compose.yml'), 'utf8');
  const hubBlock = yml.slice(yml.indexOf('  hub:'), yml.indexOf('  caddy:') >= 0 ? yml.indexOf('  caddy:') : undefined);
  const env = hubBlock.slice(hubBlock.indexOf('environment:'), hubBlock.indexOf('volumes:'));
  assert.ok(!/CCRC_BIND/.test(env),
    'CCRC_BIND trong environment của hub sẽ bắt app nghe loopback BÊN TRONG container — tunnel mất origin');
});
