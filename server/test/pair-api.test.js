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
  for (let i = 0; i < 100; i += 1) {
    if (died) throw new Error(`${died}\n${stderr}`);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (died) throw new Error(`${died}\n${stderr}`);
  return { base, stop: () => proc.kill() };
}

async function withHub(fn, users) {
  const h = await startHub(users);
  try { await fn(h); } finally { h.stop(); }
}

const post = (h, p, tok, body, headers = {}) => fetch(h.base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...headers },
  body: JSON.stringify(body),
});
const get = (h, p, tok) => fetch(h.base + p, { headers: { authorization: `Bearer ${tok}` } });

const REQ = { pubKey: 'khoa-cong-khai-cua-dien-thoai', commit: 'cam-ket-cua-dien-thoai' };

test('luồng đầy đủ qua HTTP thật', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.ok(pairId);

    const { pairs } = await (await get(h, '/api/pair/pending', 'tok-huy')).json();
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].pubKey, REQ.pubKey);
    assert.equal(pairs[0].commit, REQ.commit);

    assert.equal((await post(h, '/api/pair/challenge', 'tok-huy', { pairId, nonceMachine: 'nm' })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).nonceMachine, 'nm');

    assert.equal((await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).noncePhone, 'np');

    assert.equal((await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: true })).status, 200);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'done');
  });
});

test('nhãn do hub dẫn xuất từ User-Agent, KHÔNG nhận từ thân request', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy',
      { ...REQ, label: 'NHÃN NGƯỜI GỬI TỰ ĐẶT' },
      { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari/604.1' },
    )).json();
    const { pairs } = await (await get(h, '/api/pair/pending', 'tok-huy')).json();
    assert.equal(pairs[0].label, 'iPhone · Safari');
    assert.ok(pairId);
  });
});

test('người này KHÔNG thấy, KHÔNG đụng được yêu cầu ghép cặp của người kia', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.deepEqual((await (await get(h, '/api/pair/pending', 'tok-kien')).json()).pairs, []);
    assert.equal((await get(h, `/api/pair/${pairId}`, 'tok-kien')).status, 404);
    assert.equal((await post(h, '/api/pair/challenge', 'tok-kien', { pairId, nonceMachine: 'nm' })).status, 400);
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'started',
      'kien không được làm gì thay đổi cuộc ghép cặp của huy');
  });
});

test('bước sai thứ tự bị từ chối 400', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    assert.equal((await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' })).status, 400);
    assert.equal((await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: true })).status, 400);
  });
});

test('thân request dị dạng bị từ chối 400, hub vẫn sống', async () => {
  await withHub(async (h) => {
    assert.equal((await post(h, '/api/pair/start', 'tok-huy', { commit: 'c' })).status, 400);
    assert.equal((await post(h, '/api/pair/start', 'tok-huy', null)).status, 400);
    assert.equal((await post(h, '/api/pair/challenge', 'tok-huy', {})).status, 400);
    assert.equal((await fetch(`${h.base}/healthz`)).status, 200, 'hub phải còn sống');
  });
});

test('không token thì cả sáu route đều 401', async () => {
  await withHub(async (h) => {
    const noAuth = (m, p) => fetch(h.base + p, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: m === 'POST' ? '{}' : undefined,
    });
    assert.equal((await noAuth('POST', '/api/pair/start')).status, 401);
    assert.equal((await noAuth('GET', '/api/pair/pending')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/challenge')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/reveal')).status, 401);
    assert.equal((await noAuth('POST', '/api/pair/finish')).status, 401);
    assert.equal((await noAuth('GET', '/api/pair/bat-ky')).status, 401);
  });
});

test('finish(false) cho trạng thái aborted — người dùng bấm [Không khớp]', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    await post(h, '/api/pair/challenge', 'tok-huy', { pairId, nonceMachine: 'nm' });
    await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' });
    await post(h, '/api/pair/finish', 'tok-huy', { pairId, ok: false });
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'aborted');
  });
});

// Review toàn nhánh (item 5): `index.js` đọc `b.ok === true` rồi truyền
// xuống `pairings.finish()` — "chỉ đúng `true` là đồng ý, thân request dị
// dạng phải nghĩa là HUỶ" (comment ngay tại chỗ đọc). Test cũ ("thân request
// dị dạng bị từ chối 400") chỉ phủ những thân THIẾU `pairId` — chưa từng
// dựng đúng ca `pairId` hợp lệ nhưng THIẾU hẳn trường `ok`, tức chính ca mà
// một tái cấu trúc `b.ok !== false` (thay vì `=== true`) sẽ lật sai:
// `undefined !== false` là `true`, biến một thân thiếu sót thành một lần
// ĐỒNG Ý. Route vẫn trả 200 trong cả hai trường hợp (pairings.finish() luôn
// `{ok:true}` — chuyện thành/huỷ không phải lỗi HTTP) nên khẳng định phải
// nằm ở STATE cuối cùng, không phải ở status code.
test('finish thiếu hẳn trường ok (thân {"pairId":…} trơ trụi) → HUỶ, không được coi là đồng ý', async () => {
  await withHub(async (h) => {
    const { pairId } = await (await post(h, '/api/pair/start', 'tok-huy', REQ)).json();
    await post(h, '/api/pair/challenge', 'tok-huy', { pairId, nonceMachine: 'nm' });
    await post(h, '/api/pair/reveal', 'tok-huy', { pairId, noncePhone: 'np' });

    const r = await post(h, '/api/pair/finish', 'tok-huy', { pairId });
    assert.equal(r.status, 200, 'route vẫn 200 — huỷ không phải một lỗi HTTP');
    assert.equal((await (await get(h, `/api/pair/${pairId}`, 'tok-huy')).json()).state, 'aborted',
      'thân thiếu trường "ok" phải mặc định nghiêng về HUỶ, không phải ghép cặp thành công');
  });
});
