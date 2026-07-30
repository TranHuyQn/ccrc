import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification } from '../src/notify-payload.js';

const OPTS = { machineName: 'dev' };
const base = (extra) => ({
  hook_event_name: 'Notification',
  session_id: '8be17c1b-8ead-4ceb-8029-177cf4dc4fbf',
  cwd: '/Users/dev/projects/cc-remote-control',
  ...extra,
});

test('idle_prompt thành thông báo đang chờ nhập', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), OPTS);
  assert.equal(n.type, 'idle_prompt');
  assert.match(n.title, /dev/);
  assert.match(n.body, /đang chờ bạn nhập/);
});

test('permission_prompt nói "cần bạn xác nhận", KHÔNG nói "duyệt quyền"', () => {
  // Đo được: AskUserQuestion cũng phát permission_prompt (63/65 lần), nên nói
  // "duyệt quyền" sẽ sai gần một nửa số lần.
  const n = buildNotification(base({ notification_type: 'permission_prompt', message: 'Claude needs your permission' }), OPTS);
  assert.equal(n.type, 'permission_prompt');
  assert.match(n.body, /cần bạn xác nhận/);
  assert.ok(!/duyệt quyền/.test(n.body), 'không được nói "duyệt quyền"');
});

// The title used to carry the cwd's basename. It named the project on the
// lock screen and in every screenshot, and there is no taking that back once
// it has been seen — so it is gone, and no fallback anywhere may bring it
// back.
test('KHÔNG có phiên terminal → chỉ hiện tên máy, TUYỆT ĐỐI không tên thư mục', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', cwd: '/Users/dev/projects/acme/demo-app' }), OPTS);
  assert.equal(n.title, '🔔 dev');
  assert.ok(!/demo-app/.test(n.title), 'tên thư mục bị lộ lại');
  assert.ok(!/acme/.test(n.title));
  assert.equal(n.sessionId, undefined, 'không có phiên thì không được bịa ra sessionId');
});

test('CÓ phiên terminal → hiện đúng tên phiên, kèm sessionId để hub ghép', () => {
  const n = buildNotification(
    base({ notification_type: 'idle_prompt', cwd: '/Users/dev/projects/acme/demo-app' }),
    { ...OPTS, session: { sessionId: 'sess-9', name: 'k7m2' } });
  assert.equal(n.title, '🔔 dev · k7m2');
  assert.equal(n.sessionId, 'sess-9');
  assert.ok(!/demo-app/.test(JSON.stringify(n)));
});

test('phiên có tên do người dùng đặt thì hiện đúng tên đó', () => {
  const n = buildNotification(
    base({ notification_type: 'idle_prompt', cwd: '/x/y' }),
    { ...OPTS, session: { sessionId: 's', name: 'test' } });
  assert.equal(n.title, '🔔 dev · test');
});

// A registry entry with a broken shape must not be able to put anything odd
// in the title — it is read off disk, and disk contents are not a contract.
test('mục sổ tra hỏng → bỏ qua, quay về chỉ tên máy', () => {
  for (const bad of [{}, { name: 123 }, { name: null }, { sessionId: 5 }]) {
    const n = buildNotification(base({ notification_type: 'idle_prompt', cwd: '/x/y' }), { ...OPTS, session: bad });
    assert.equal(n.title, '🔔 dev', `mục hỏng vẫn lọt: ${JSON.stringify(bad)}`);
  }
});

test('KHÔNG mang nội dung công việc sang thông báo', () => {
  const n = buildNotification(base({ notification_type: 'idle_prompt', message: 'BÍ MẬT KHÔNG ĐƯỢC LỘ' }), OPTS);
  const all = JSON.stringify(n);
  assert.ok(!/BÍ MẬT/.test(all), 'message của Claude Code không được lọt vào thông báo');
  assert.ok(!/8be17c1b/.test(all), 'session id không được lọt vào');
  assert.ok(!/\/Volumes\//.test(all), 'đường dẫn đầy đủ không được lọt vào');
});

test('loại Notification lạ thì trả null — whitelist chứ không phải blacklist', () => {
  assert.equal(buildNotification(base({ notification_type: 'loai_moi_nao_do' }), OPTS), null);
  assert.equal(buildNotification(base({ notification_type: undefined }), OPTS), null);
});

test('hook khác Notification thì trả null', () => {
  assert.equal(buildNotification({ hook_event_name: 'Stop' }, OPTS), null);
  assert.equal(buildNotification({ hook_event_name: 'SubagentStop', notification_type: 'idle_prompt' }, OPTS), null);
});

test('payload rác thì trả null, không ném', () => {
  for (const bad of [null, undefined, 'chuỗi', 42, [], true]) {
    assert.equal(buildNotification(bad, OPTS), null);
  }
});

test('thiếu cwd vẫn dựng được, chỉ mất tên dự án', () => {
  const n = buildNotification({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, OPTS);
  assert.ok(n, 'không được trả null chỉ vì thiếu cwd');
  assert.match(n.title, /dev/);
});

test('tag khác nhau theo loại để thông báo không đè nhau', () => {
  const a = buildNotification(base({ notification_type: 'idle_prompt' }), OPTS);
  const b = buildNotification(base({ notification_type: 'permission_prompt' }), OPTS);
  assert.notEqual(a.tag, b.tag);
});
