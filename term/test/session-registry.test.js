// The local session registry: the one place the terminal daemon and the
// notification hook — two separate programs — agree on what a session is
// called.
//
// Two properties carry the weight. It must never throw, because it is read on
// the path of every single notification and a notification must go out even
// when this directory is missing, unreadable, or full of junk. And a stale
// entry must never win: a daemon killed with -9 leaves its file behind, and
// nothing else in the system sweeps this directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeSession, removeSession, listSessions, findByCwd, registryDir,
} from '../../shared/session-registry.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-reg-'));
}

const ALIVE = () => true;
const DEAD = () => false;

test('ghi rồi tra lại được theo cwd', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b', name: 'k7m2', pid: process.pid }, { home });
  const got = findByCwd('/a/b', { home, isAlive: ALIVE });
  assert.equal(got.name, 'k7m2');
  assert.equal(got.sessionId, 's1');
});

test('cwd khác thì KHÔNG khớp — ghép nhầm tệ hơn không ghép', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b', name: 'k7m2', pid: process.pid }, { home });
  assert.equal(findByCwd('/a', { home, isAlive: ALIVE }), null);
  assert.equal(findByCwd('/a/b/c', { home, isAlive: ALIVE }), null, 'thư mục con không được khớp');
  assert.equal(findByCwd('/x', { home, isAlive: ALIVE }), null);
});

test('đường dẫn có dấu / thừa vẫn khớp', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b/', name: 'n', pid: process.pid }, { home });
  assert.ok(findByCwd('/a/b', { home, isAlive: ALIVE }));
});

test('mục của tiến trình đã chết bị bỏ qua VÀ bị dọn', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's-chet', cwd: '/a/b', name: 'ma', pid: 999999 }, { home });
  assert.equal(findByCwd('/a/b', { home, isAlive: DEAD }), null);
  assert.equal(fs.existsSync(path.join(registryDir(home), 's-chet.json')), false,
    'không dọn thì thư mục phình mãi — không có gì khác quét nó');
});

test('nhiều phiên cùng lúc, mỗi thư mục tra ra đúng phiên của nó', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/du/an/mot', name: 'mot', pid: process.pid }, { home });
  writeSession({ sessionId: 's2', cwd: '/du/an/hai', name: 'hai', pid: process.pid }, { home });
  assert.equal(findByCwd('/du/an/mot', { home, isAlive: ALIVE }).name, 'mot');
  assert.equal(findByCwd('/du/an/hai', { home, isAlive: ALIVE }).name, 'hai');
  assert.equal(listSessions({ home, isAlive: ALIVE }).length, 2);
});

test('xoá mục thì tra không ra nữa', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b', name: 'n', pid: process.pid }, { home });
  removeSession('s1', { home });
  assert.equal(findByCwd('/a/b', { home, isAlive: ALIVE }), null);
});

// --- không bao giờ được ném lỗi ------------------------------------------
//
// Every one of these runs on the notification path.

test('thư mục sổ tra chưa tồn tại → trả rỗng, không ném', () => {
  const home = tmpHome();
  assert.deepEqual(listSessions({ home, isAlive: ALIVE }), []);
  assert.equal(findByCwd('/a', { home, isAlive: ALIVE }), null);
});

test('file rác trong thư mục → bỏ qua, không ném', () => {
  const home = tmpHome();
  const dir = registryDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hong.json'), 'không-phải-json{{{');
  fs.writeFileSync(path.join(dir, 'khong-phai.txt'), 'kệ nó');
  fs.writeFileSync(path.join(dir, 'null.json'), 'null');
  writeSession({ sessionId: 'that', cwd: '/a/b', name: 'ok', pid: process.pid }, { home });
  assert.equal(findByCwd('/a/b', { home, isAlive: ALIVE }).name, 'ok');
});

test('cwd rỗng hoặc sai kiểu → null, không ném', () => {
  const home = tmpHome();
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.equal(findByCwd(bad, { home, isAlive: ALIVE }), null);
  }
});

test('mục không có cwd → không bao giờ khớp', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '', name: 'n', pid: process.pid }, { home });
  assert.equal(findByCwd('', { home, isAlive: ALIVE }), null);
  assert.equal(findByCwd('/', { home, isAlive: ALIVE }), null);
});

// A session id becomes a filename. It comes from this project's own code, but
// that is not a reason to hand it to path.join() untested.
test('sessionId hiểm không thoát được ra ngoài thư mục', () => {
  const home = tmpHome();
  for (const bad of ['../escape', 'a/b', '..', '.', '', 'x'.repeat(200), null, 7]) {
    assert.equal(writeSession({ sessionId: bad, cwd: '/a', name: 'n', pid: 1 }, { home }), false,
      `sessionId phải bị từ chối: ${JSON.stringify(bad)}`);
    assert.equal(removeSession(bad, { home }), false);
  }
  assert.equal(fs.existsSync(path.join(home, 'escape.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.ccrc', 'escape.json')), false);
});

test('ghi đè mục cũ của cùng sessionId (cwd đổi khi người dùng cd)', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b', name: 'n', pid: process.pid }, { home });
  writeSession({ sessionId: 's1', cwd: '/c/d', name: 'n', pid: process.pid }, { home });
  assert.equal(findByCwd('/a/b', { home, isAlive: ALIVE }), null, 'thư mục cũ vẫn khớp là sai');
  assert.ok(findByCwd('/c/d', { home, isAlive: ALIVE }));
  assert.equal(listSessions({ home, isAlive: ALIVE }).length, 1, 'không được đẻ ra mục thứ hai');
});

test('không để lại file .tmp sau khi ghi', () => {
  const home = tmpHome();
  writeSession({ sessionId: 's1', cwd: '/a/b', name: 'n', pid: process.pid }, { home });
  const files = fs.readdirSync(registryDir(home));
  assert.deepEqual(files, ['s1.json']);
});

// The daemon writes this on every heartbeat while the hook may read it at any
// instant. A reader must never catch a half-written file.
test('mục luôn đọc được: ghi qua file tạm rồi đổi tên', () => {
  const home = tmpHome();
  for (let i = 0; i < 50; i += 1) {
    writeSession({ sessionId: 's1', cwd: '/a/b', name: 'ten-' + i, pid: process.pid }, { home });
    const got = findByCwd('/a/b', { home, isAlive: ALIVE });
    assert.ok(got, 'đọc phải file đang ghi dở');
    assert.equal(got.name, 'ten-' + i);
  }
});

test('mặc định dùng ~/.ccrc/sessions', () => {
  assert.equal(registryDir('/nha/cua/ai'), path.join('/nha/cua/ai', '.ccrc', 'sessions'));
});
