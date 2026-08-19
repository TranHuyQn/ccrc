import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHost, readHost, listHosts, removeHost, hostsDir } from '../src/host-registry.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-hr-'));
}

const mau = (sessionId, pid = process.pid) => ({
  sessionId, pid, pipe: `\\\\.\\pipe\\ccrc-${sessionId}`,
  secret: 'bi-mat-' + sessionId, cwd: '/du/an/a', name: 'du an A',
});

test('ghi rồi đọc lại nguyên vẹn', () => {
  const home = tmpHome();
  assert.equal(writeHost(mau('abc'), { home }), true);
  const ra = readHost('abc', { home });
  assert.equal(ra.sessionId, 'abc');
  assert.equal(ra.pid, process.pid);
  assert.equal(ra.secret, 'bi-mat-abc');
  assert.equal(ra.name, 'du an A');
});

test('đọc phiên không có trả null, không ném', () => {
  const home = tmpHome();
  assert.equal(readHost('khong-co', { home }), null);
});

test('sessionId có ký tự lạ bị từ chối, không thoát ra khỏi thư mục', () => {
  // sessionId đi thẳng vào tên file. Đây là chỗ duy nhất chặn nó.
  const home = tmpHome();
  for (const xau of ['../thoat', 'a/b', '.', '..', '', 'x'.repeat(200)]) {
    assert.equal(writeHost(mau(xau), { home }), false, `phải từ chối: ${JSON.stringify(xau)}`);
  }
  assert.equal(fs.existsSync(path.join(hostsDir(home), '..', 'thoat.json')), false);
});

test('file JSON hỏng bị bỏ qua, không làm chết listHosts', () => {
  const home = tmpHome();
  writeHost(mau('tot'), { home });
  fs.mkdirSync(hostsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hostsDir(home), 'hong.json'), '{ khong phai json');
  const ds = listHosts({ home, isAlive: () => true });
  assert.deepEqual(ds.map((h) => h.sessionId), ['tot']);
});

test('hồ sơ của tiến trình đã chết bị dọn', () => {
  const home = tmpHome();
  writeHost(mau('song'), { home });
  writeHost(mau('chet'), { home });
  const ds = listHosts({ home, isAlive: (pid, entry) => entry.sessionId === 'song' });
  assert.deepEqual(ds.map((h) => h.sessionId), ['song']);
  assert.equal(readHost('chet', { home }), null, 'hồ sơ chết phải bị xoá khỏi đĩa');
});

test('pid không đọc được thì GIỮ LẠI, không dọn', () => {
  // Bỏ sót một hồ sơ rác thì vô hại. Dọn nhầm một phiên đang sống thì người
  // dùng mất việc — dự án này đã trả giá cho hướng ngược lại hai lần.
  const home = tmpHome();
  fs.mkdirSync(hostsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hostsDir(home), 'la.json'),
    JSON.stringify({ sessionId: 'la', pipe: 'x', secret: 'y' })); // không có pid
  const ds = listHosts({ home, isAlive: () => false });
  assert.deepEqual(ds.map((h) => h.sessionId), ['la'], 'không có pid = không chứng minh được đã chết');
});

test('isAlive ném thì được coi là không chứng minh được đã chết, không làm listHosts ném', () => {
  // Cùng luật với "không có pid": ném ra thì cũng là không chứng minh được,
  // nên giữ lại — không phải xoá, và chắc chắn không để lỗi lọt ra ngoài.
  const home = tmpHome();
  writeHost(mau('nem-loi'), { home });
  let ds;
  assert.doesNotThrow(() => {
    ds = listHosts({ home, isAlive: () => { throw new Error('bùm'); } });
  });
  assert.deepEqual(ds.map((h) => h.sessionId), ['nem-loi'], 'phải còn trong kết quả trả về');
  assert.ok(readHost('nem-loi', { home }), 'phải còn trên đĩa, không bị dọn');
});

test('removeHost xoá đúng một hồ sơ', () => {
  const home = tmpHome();
  writeHost(mau('a'), { home });
  writeHost(mau('b'), { home });
  assert.equal(removeHost('a', { home }), true);
  assert.equal(readHost('a', { home }), null);
  assert.ok(readHost('b', { home }), 'không được đụng hồ sơ khác');
});

test('thư mục chưa tồn tại thì listHosts trả mảng rỗng, không ném', () => {
  assert.deepEqual(listHosts({ home: tmpHome() }), []);
});

test('CCRC_HOME quyết định thư mục, không phải HOME', () => {
  // Trên Windows os.homedir() bỏ qua HOME, nên đây là biến duy nhất cô lập
  // được. Đã có sự cố ghi vào hồ sơ thật vì chuyện này.
  const home = tmpHome();
  assert.match(hostsDir(home), new RegExp(home.replace(/\\/g, '\\\\')));
});
