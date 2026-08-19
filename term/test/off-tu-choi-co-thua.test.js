// `off` phải TỪ CHỐI mọi tham số thừa, trên MỌI nền tảng.
//
// Đây là lỗi đã xảy ra thật, không phải giả định: bộ phân nhánh ở cuối
// ccrc-term-cli.js chỉ đọc `--pane` khi lệnh là `on`. Với `off`, mọi thứ sau
// tên lệnh bị bỏ qua sạch — nên `/remote off --pane %9` in "✓ Remote ĐÃ TẮT"
// sau khi tắt phiên HIỆN TẠI thay vì phiên được chỉ. Nó đã tắt nhầm phiên của
// người dùng một lần, ngay giữa phiên làm việc thêm tính năng này.
//
// Bản vá áp cho cả macOS lẫn Windows. Đó LÀ một thay đổi hành vi trên macOS,
// và nó chỉ chạm được vào một lệnh vốn đã sai — `off` trần không đổi gì.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js');

function nhaTam() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-offco-'));
  fs.mkdirSync(path.join(d, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(d, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=x\nCCRC_MACHINE_NAME=may-thu\n');
  return d;
}

function chay(args, home, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    // HOME cho POSIX, CCRC_HOME cho mọi nền tảng — trên Windows os.homedir()
    // đọc USERPROFILE nên HOME một mình không cô lập được gì.
    env: { ...process.env, HOME: home, CCRC_HOME: home, TMUX_PANE: '', ...env },
  });
}

test('`off` kèm cờ thì BÁO LỖI và không làm gì', () => {
  const home = nhaTam();
  try {
    const r = chay(['off', '--pane', '%9'], home);
    assert.equal(r.status, 1, 'phải thoát khác 0');
    assert.match(r.stdout, /`off` không nhận tham số nào/);
    assert.match(r.stdout, /--pane %9/, 'phải nhắc lại đúng thứ người dùng đã gõ');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('bất kỳ tham số thừa nào cũng bị từ chối, không riêng --pane', () => {
  const home = nhaTam();
  try {
    const r = chay(['off', 'linh-tinh'], home);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /linh-tinh/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`off` trần KHÔNG đổi hành vi — vẫn báo không biết tắt phiên nào', () => {
  // Nửa quan trọng của bản vá: nó không được đụng vào lệnh dùng đúng. Không có
  // pane/phiên nào thì `off` vẫn phải nói câu cũ và thoát 1, chứ không phải
  // rơi vào nhánh "tham số thừa".
  const home = nhaTam();
  try {
    const r = chay(['off'], home);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /không nhận tham số nào/,
      '`off` trần bị nhận nhầm là có tham số thừa');
    assert.match(r.stdout, /không biết phiên nào để tắt/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`on` vẫn nhận --pane như cũ — bản vá không lan sang lệnh khác', () => {
  const home = nhaTam();
  try {
    // Trên macOS `on --pane <id>` là đường có thật (deploy/ccrc dùng), nên nó
    // phải đi tới bước kiểm pane chứ không bị chặn ở tầng tham số.
    const r = chay(['on', '--pane', '%999999'], home);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /không nhận tham số nào/,
      '`on --pane` bị chặn nhầm — bản vá đã lan sang lệnh khác');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
