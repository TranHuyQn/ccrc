import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lenhHook } from '../bin/install-hook.mjs';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'install-hook.mjs');
// DEVIATION from the brief's literal text: the brief hardcodes '/repo/hook/bin/ccrc-notify.js'
// as the hook path in the happy-path tests below. That absolute path does not exist on this
// machine (no /repo mount) — install-hook.mjs's own existsSync guard (itself verbatim from the
// brief, and exercised on purpose by the last test in this file) then correctly refuses to
// install it, which made those tests fail for a reason unrelated to what they are testing.
// Fixed by pointing at the real sibling ccrc-notify.js instead of a fictional path. No assertions
// or control flow were changed — see task-6-report.md for detail.
const REAL_HOOK = path.join(path.dirname(TOOL), 'ccrc-notify.js');
const NEIGHBOURS = {
  hooks: {
    Notification: [{ hooks: [{ type: 'command', command: '/Applications/Other.app/hook Notification' }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash /other/tool.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bash /other/tool.sh' }] }],
  },
  model: 'opus',
};

function tmpHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-h-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings);
  return home;
}
const read = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const ours = (d) => Object.entries(d.hooks || {}).flatMap(([ev, v]) =>
  v.flatMap((m) => (m.hooks || []).filter((h) => (h.command || '').includes('ccrc-notify.js')).map(() => ev)));
const others = (d) => JSON.stringify(Object.entries(d.hooks || {}).map(([ev, v]) =>
  [ev, v.flatMap((m) => (m.hooks || []).filter((h) => !(h.command || '').includes('ccrc-notify.js')).map((h) => h.command))]));

function run(args, home) {
  return new Promise((r) => execFile('node', [TOOL, ...args], { env: { ...process.env, HOME: home, CCRC_HOME: home } },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('cài đúng MỘT hook, chỉ trên Notification', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  await run(['install', REAL_HOOK], home);
  assert.deepEqual(ours(read(home)), ['Notification']);
});

test('cài 3 lần vẫn chỉ có 1 — idempotent', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  for (let i = 0; i < 3; i++) await run(['install', REAL_HOOK], home);
  assert.equal(ours(read(home)).length, 1);
});

test('KHÔNG đụng hook của tool khác', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const before = others(JSON.parse(JSON.stringify(NEIGHBOURS)));
  await run(['install', REAL_HOOK], home);
  assert.equal(others(read(home)), before, 'hook của tool khác phải nguyên vẹn sau khi cài');
  await run(['uninstall'], home);
  assert.equal(others(read(home)), before, 'và nguyên vẹn sau khi gỡ');
});

test('gỡ xong không còn hook của mình', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  await run(['install', REAL_HOOK], home);
  await run(['uninstall'], home);
  assert.deepEqual(ours(read(home)), []);
});

test('settings.json hỏng thì KHÔNG sửa gì và thoát khác 0', async () => {
  const broken = '{ dòng này không phải JSON';
  const home = tmpHome(broken);
  const r = await run(['install', REAL_HOOK], home);
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), broken,
    'file hỏng phải được để nguyên, không backup cũng không ghi đè');
});

test('chưa có settings.json thì tạo mới được', async () => {
  const home = tmpHome(undefined);
  const r = await run(['install', REAL_HOOK], home);
  assert.equal(r.code, 0);
  assert.deepEqual(ours(read(home)), ['Notification']);
});

test('gỡ khi chưa từng cài thì không ghi gì', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const p = path.join(home, '.claude', 'settings.json');
  const before = fs.readFileSync(p, 'utf8');
  const r = await run(['uninstall'], home);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'không có gì để gỡ thì không được chạm vào file');
});

test('hooks.Notification không phải mảng thì từ chối, không sửa gì', async () => {
  const broken = JSON.stringify({ hooks: { Notification: 'oops' } });
  const home = tmpHome(broken);
  const r = await run(['install', REAL_HOOK], home);
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), broken,
    'hooks.Notification không phải mảng thì phải để nguyên file, không được ghi đè');
});

test('đường dẫn hook không tồn tại thì từ chối cài', async () => {
  const home = tmpHome(JSON.stringify(NEIGHBOURS));
  const r = await run(['install', '/khong/ton/tai/ccrc-notify.js'], home);
  assert.notEqual(r.code, 0);
  assert.deepEqual(ours(read(home)), [], 'không được đăng ký một lệnh chạy sẽ lỗi mỗi lần');
});

// --- settings.json là file CỦA NGƯỜI DÙNG --------------------------------
//
// Ghi lại nó theo kiểu của mình là sửa một file mình chỉ được phép thêm vào.
// Đo được trong một HOME giả: cài rồi gỡ trên một file viết liền một dòng thì
// nội dung không đổi, nhưng cả file bị dàn ra 2 dấu cách — và lệnh gỡ không
// cách nào hoàn tác, vì bản gốc đã mất từ lúc CÀI. Yêu cầu là gỡ xong máy trở
// về đúng trạng thái cũ, nên chỗ phải sửa là ở đây.

const RAW = (home) => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');

for (const [ten, goc] of [
  ['viết liền một dòng', '{"model":"opus"}'],
  ['thụt 2 dấu cách', '{\n  "model": "opus"\n}\n'],
  ['thụt 4 dấu cách', '{\n    "model": "opus"\n}\n'],
  ['thụt bằng tab', '{\n\t"model": "opus"\n}\n'],
]) {
  test(`cài rồi gỡ giữ nguyên định dạng: ${ten}`, async () => {
    const home = tmpHome(goc);
    assert.equal((await run(['install', REAL_HOOK], home)).code, 0);
    assert.equal((await run(['uninstall'], home)).code, 0);
    assert.equal(RAW(home), goc, 'file của người dùng bị viết lại theo kiểu khác');
  });
}

// Giữ định dạng không được phép thành ra giữ luôn cả nội dung cũ: hook vẫn
// phải thực sự được thêm vào.
test('giữ định dạng nhưng vẫn cài được hook vào file viết liền', async () => {
  const home = tmpHome('{"model":"opus"}');
  assert.equal((await run(['install', REAL_HOOK], home)).code, 0);
  const raw = RAW(home);
  assert.ok(!raw.includes('\n'), 'file viết liền mà bị xuống dòng — định dạng đã đổi');
  assert.deepEqual(ours(JSON.parse(raw)), ['Notification']);
  assert.equal(JSON.parse(raw).model, 'opus');
});

test('trên POSIX, lệnh hook là đường dẫn trần — giữ nguyên hành vi cũ', () => {
  assert.equal(lenhHook('/duong/dan/ccrc-notify.js', 'darwin'), '"/duong/dan/ccrc-notify.js"');
  assert.equal(lenhHook('/duong/dan/ccrc-notify.js', 'linux'), '"/duong/dan/ccrc-notify.js"');
});

test('trên Windows phải gọi qua node — không có shebang, không có bit execute', () => {
  // Thiếu chỗ này thì hook lỗi mỗi lần Claude Code bắn Notification, và người
  // dùng không thấy gì cả ngoài việc thông báo không bao giờ tới.
  assert.equal(lenhHook('C:\\d\\ccrc-notify.js', 'win32'), 'node "C:\\d\\ccrc-notify.js"');
});
