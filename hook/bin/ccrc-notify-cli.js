#!/usr/bin/env node
// `/notify on|off` toggles push notifications; `/notify` reports status.
//
// The status path deliberately calls the hub for real instead of describing the
// local config. Everything else in this system fails silently by design — the
// hook swallows every error so it can never disturb Claude Code — so this is
// the only place a broken setup can be noticed at all. Reading a file and
// declaring "looks fine" would defeat the one diagnostic the user has.

import fs from 'node:fs';
import path from 'node:path';
import { ccrcHome } from '../../shared/home.js';

const CFG_DIR = path.join(ccrcHome(), '.ccrc');
const NOTIFY_FILE = path.join(CFG_DIR, 'notify');

function readConfig() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(CFG_DIR, 'config'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

function isOn() {
  try { return fs.readFileSync(NOTIFY_FILE, 'utf8').trim() === 'on'; } catch { return false; }
}

function setState(on) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(NOTIFY_FILE, on ? 'on\n' : 'off\n');
}

async function status() {
  const on = isOn();
  console.log(`Thông báo: ${on ? 'ĐANG BẬT' : 'ĐANG TẮT'}`);
  const cfg = readConfig();
  if (!cfg.CCRC_HUB_URL || !cfg.CCRC_TOKEN) {
    console.log('Hub: chưa cấu hình — chạy ./setup-notify.sh');
    return;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(new URL('/api/me', cfg.CCRC_HUB_URL), {
      headers: { authorization: `Bearer ${cfg.CCRC_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - t0;
    if (res.status === 401) {
      console.log(`Hub: ${cfg.CCRC_HUB_URL} — OK (${ms}ms)`);
      console.log('Token: KHÔNG hợp lệ — hub từ chối. Xin token mới rồi chạy lại ./setup-notify.sh');
      return;
    }
    if (!res.ok) {
      console.log(`Hub: ${cfg.CCRC_HUB_URL} — lỗi HTTP ${res.status}`);
      return;
    }
    const me = await res.json();
    console.log(`Hub: ${cfg.CCRC_HUB_URL} — OK (${ms}ms)`);
    console.log(`Token: hợp lệ, sẽ báo cho ${me.user}`);
    if (me.pushDevices > 0) {
      console.log(`Push: đã đăng ký ${me.pushDevices} thiết bị`);
    } else {
      console.log('Push: ⚠ chưa có thiết bị nào đăng ký — mở web UI trên điện thoại và bật thông báo,');
      console.log('      nếu không thì thông báo gửi đi sẽ không tới đâu cả.');
    }
    if (!on) console.log('\n(Đang TẮT nên sẽ không có thông báo nào được gửi. Bật bằng: /notify on)');
  } catch (err) {
    console.log(`Hub: ${cfg.CCRC_HUB_URL} — không gọi được (${err.name === 'TimeoutError' ? 'quá hạn' : err.message})`);
  }
}

const arg = (process.argv[2] || '').toLowerCase();
if (arg === 'on' || arg === 'off') {
  setState(arg === 'on');
  console.log(`Thông báo: ${arg === 'on' ? 'ĐÃ BẬT' : 'ĐÃ TẮT'}`);
  if (arg === 'on') await status();
} else {
  await status();
}
