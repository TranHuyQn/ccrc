// Chỗ DUY NHẤT trong hub biết token-slayer tồn tại.
//
// Biên giới này có chủ đích: chọn đi qua token-slayer là ràng buộc tổ chức
// (quyền sửa Slack app), không phải ràng buộc kiến trúc. Đổi ý sau này thì
// chỉ file này bị thay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../src/identity.js';

const INTERNAL = 'http://token-slayer';

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
}

const ok = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('đổi được token lấy danh tính', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01ABCDEF', handle: 'huy' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.deepEqual(await id.exchange('tok', 'st'), { ok: true, slackUserId: 'U01ABCDEF', handle: 'huy' });
});

test('gọi vào URL NỘI BỘ, không phải URL công khai', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01', handle: 'h' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  await id.exchange('tok', 'st');
  assert.equal(f.calls[0].url, 'http://token-slayer/api/ccrc/auth/exchange',
    'đi ra internet là lộ luồng đăng nhập nội bộ ra ngoài một cách vô cớ');
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { token: 'tok', state: 'st' });
});

test('410 → rejected, không phải unreachable', async () => {
  const f = fakeFetch(() => new Response('{"error":"token_invalid_or_expired"}', { status: 410 }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  const r = await id.exchange('tok', 'st');
  assert.equal(r.ok, false);
  assert.equal(r.status, 410);
  assert.equal(r.reason, 'rejected');
});

test('token-slayer không với tới được → unreachable', async () => {
  const f = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  const r = await id.exchange('tok', 'st');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.status, 0);
});

test('trả JSON hỏng → bad_json, không ném', async () => {
  const f = fakeFetch(() => new Response('<html>502</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  const r = await id.exchange('tok', 'st');
  assert.equal(r.reason, 'bad_json');
  assert.equal(r.status, 200);
});

test('internalUrl thiếu scheme (quên "http://") → unreachable, không ném ra ngoài', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01', handle: 'h' }));
  const id = createIdentity({ internalUrl: 'token-slayer:3000', fetchImpl: f });
  // `new URL('/api/ccrc/auth/exchange', 'token-slayer:3000')` ném đồng bộ vì
  // thiếu scheme hợp lệ. exchange() không được để lộ throw đó ra caller — hợp
  // đồng "không bao giờ ném" áp dụng ngay cả khi lỗi nằm ở việc dựng URL, chứ
  // không chỉ ở lúc gọi mạng.
  const r = await id.exchange('tok', 'st');
  assert.deepEqual(r, { ok: false, status: 0, reason: 'unreachable' });
  assert.equal(f.calls.length, 0, 'không có URL để gọi thì không được gọi fetchImpl');
});

test('thiếu slackUserId → no_identity, TUYỆT ĐỐI không đoán', async () => {
  const f = fakeFetch(() => ok({ handle: 'huy' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.equal((await id.exchange('tok', 'st')).reason, 'no_identity',
    'tạo user từ một danh tính rỗng là gắn token hợp lệ vào sai người');
});

test('slackUserId rỗng hoặc toàn khoảng trắng cũng là no_identity', async () => {
  for (const bad of ['', '   ', null, 42]) {
    const f = fakeFetch(() => ok({ slackUserId: bad, handle: 'huy' }));
    const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
    assert.equal((await id.exchange('tok', 'st')).reason, 'no_identity', `với ${JSON.stringify(bad)}`);
  }
});

test('thiếu handle thì lấy slackUserId làm nhãn, không chết', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01ABCDEF' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.deepEqual(await id.exchange('tok', 'st'),
    { ok: true, slackUserId: 'U01ABCDEF', handle: 'U01ABCDEF' });
});

test('có đặt timeout', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01', handle: 'h' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f, timeoutMs: 5000 });
  await id.exchange('tok', 'st');
  assert.ok(f.calls[0].opts.signal, 'không có timeout thì một token-slayer treo làm treo luôn hub');
});
