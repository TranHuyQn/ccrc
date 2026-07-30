import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';

function tmpHome(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cfg-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

test('đọc đủ ba khoá từ ~/.ccrc/config', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\nCCRC_TOKEN=tok123\nCCRC_MACHINE_NAME=may-dev\n');
  assert.deepEqual(readConfig(home), { hubUrl: 'https://h.example', token: 'tok123', machine: 'may-dev' });
});

test('giá trị có dấu = bên trong không bị cắt', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\nCCRC_TOKEN=a=b=c\nCCRC_MACHINE_NAME=m\n');
  assert.equal(readConfig(home).token, 'a=b=c');
});

test('thiếu file trả về null, không ném', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cfg-'));
  assert.equal(readConfig(home), null);
});

test('thiếu khoá bắt buộc trả về null', () => {
  const home = tmpHome('CCRC_HUB_URL=https://h.example\n');
  assert.equal(readConfig(home), null);
});

// ensureSecret/readSecret and the persisted ~/.ccrc/term-secret file they
// managed are gone (final fix wave, item 2) — the daemon now generates its
// HMAC secret fresh in memory every run instead of reusing one from disk,
// which is what makes a restart actually invalidate outstanding tickets.
// See term/bin/ccrc-term.js and config.js's own comment.
