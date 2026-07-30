#!/usr/bin/env node
// Add or remove the ccrc notification hook in ~/.claude/settings.json WITHOUT
// disturbing anything else in it. That file is shared: on a real machine it
// already holds hooks belonging to other tools, and clobbering it breaks them.
// Parse, splice, write back — idempotently, and refuse outright on a file we
// cannot parse rather than "fixing" it.
//
// Usage: install-hook.mjs install <absolute-path-to-ccrc-notify.js>
//        install-hook.mjs uninstall

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, hookPath] = process.argv.slice(2);
if (mode !== 'install' && mode !== 'uninstall') {
  console.error('Dùng: install-hook.mjs <install|uninstall> [đường-dẫn-hook]');
  process.exit(1);
}
if (mode === 'install') {
  if (!hookPath) { console.error('Thiếu đường dẫn tới ccrc-notify.js'); process.exit(1); }
  if (!fs.existsSync(hookPath)) {
    console.error(`✗ Không thấy ${hookPath} — không đăng ký một lệnh sẽ lỗi mỗi lần chạy.`);
    process.exit(1);
  }
}

const file = path.join(os.homedir(), '.claude', 'settings.json');
const EVENT = 'Notification';
const MARKER = 'ccrc-notify.js';

// Cách file đang được thụt đầu dòng, đọc từ chính nó.
//
// settings.json là file CỦA NGƯỜI DÙNG; ghi lại nó theo kiểu của mình là sửa
// một file mình chỉ được phép thêm vào. Đo được: cài rồi gỡ trên một file
// viết liền một dòng thì nội dung không đổi nhưng cả file bị dàn ra 2 dấu
// cách — và lệnh gỡ không cách nào hoàn tác, vì bản gốc đã mất từ lúc cài.
//
// Trả về đúng thứ JSON.stringify nhận làm tham số thứ ba: chuỗi thụt đầu
// dòng, hoặc 0 nghĩa là viết liền không xuống dòng.
function detectIndent(raw) {
  // Dòng đầu tiên có thụt đầu dòng quyết định tất cả. Không có dòng nào như
  // vậy nghĩa là file viết liền.
  const m = raw.match(/\n([ \t]+)\S/);
  return m ? m[1] : 0;
}

let settings = {};
let existed = false;
let indent = 2;      // file mới do mình tạo: 2 dấu cách, như cũ
let trailingNewline = true;
if (fs.existsSync(file)) {
  existed = true;
  const raw = fs.readFileSync(file, 'utf8');
  indent = detectIndent(raw);
  trailingNewline = raw.endsWith('\n');
  try {
    settings = JSON.parse(raw);
  } catch {
    console.error(`✗ ${file} không phải JSON hợp lệ — KHÔNG sửa gì cả. Sửa tay rồi chạy lại.`);
    process.exit(1);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`✗ ${file} không phải một object JSON — KHÔNG sửa gì cả.`);
    process.exit(1);
  }
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);
const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
  ? settings.hooks : {};
if (EVENT in hooks && !Array.isArray(hooks[EVENT])) {
  console.error(`✗ ${file} có hooks.${EVENT} nhưng không phải mảng — KHÔNG sửa gì cả.`);
  process.exit(1);
}
const groups = Array.isArray(hooks[EVENT]) ? hooks[EVENT] : [];

let changed = 0;
const kept = [];
for (const g of groups) {
  if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; } // shape we do not understand: leave it
  const before = g.hooks.length;
  const rest = g.hooks.filter((h) => !isOurs(h));
  changed += before - rest.length;
  if (rest.length) kept.push({ ...g, hooks: rest });
  else if (before === 0) kept.push(g); // was already empty; not ours to delete
}

if (mode === 'install') {
  kept.push({ hooks: [{ type: 'command', command: `"${hookPath}"`, timeout: 10 }] });
  changed++;
}

if (!changed) {
  console.log(mode === 'install' ? '✓ Hook đã ở đúng trạng thái' : '✓ Không có hook nào của ccrc để gỡ');
  process.exit(0);
}

if (kept.length) hooks[EVENT] = kept;
else delete hooks[EVENT];
if (Object.keys(hooks).length) settings.hooks = hooks;
else delete settings.hooks;

// Atomic replace: a crash mid-write must not leave a truncated shared config.
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, indent) + (trailingNewline ? '\n' : ''));
fs.renameSync(tmp, file);
console.log(`✓ ${mode === 'install' ? 'Đã cài' : 'Đã gỡ'} hook thông báo${existed ? '' : ' (tạo settings.json mới)'}`);
