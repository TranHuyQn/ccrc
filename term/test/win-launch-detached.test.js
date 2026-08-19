// Host phải chạy NGẦM: không cửa sổ console riêng.
//
// Lỗi người dùng báo: mỗi lần gõ `ccrc` lại hiện thêm một cửa sổ node.exe.
// Nguồn là `Win32_Process.Create` — mặc định nó cấp cho tiến trình con một
// console mới, và trên máy có màn hình console ấy là một cửa sổ.
//
// Đo trên máy Windows thật, đếm conhost con của tiến trình vừa tạo:
//
//     không cờ gì                 -> 1 conhost   (đúng cửa sổ thừa)
//     ShowWindow = 0 (SW_HIDE)    -> 1 conhost   (KHÔNG chặn được)
//     CreateFlags = CREATE_NO_WINDOW -> ReturnValue 21, tham số sai
//     CreateFlags = 8 (DETACHED)  -> 0 conhost   ✅
//
// Và câu hỏi đáng lo hơn — ConPTY có sống nổi khi cha không có console —
// cũng đã đo: node-pty trong một tiến trình DETACHED vẫn spawn được cmd.exe
// và nhận 3 chunk / 261 byte.
//
// Bài này chạy được TRÊN CẢ macOS vì nó đọc mã nguồn chứ không chạy WMI —
// win-launch.test.js skip toàn bộ ngoài Windows, nên nếu chỉ dựa vào file đó
// thì bản vá này không có gì canh trong CI macOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'win-launch.js'),
  'utf8',
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('host được tạo với DETACHED_PROCESS — không console riêng, không cửa sổ', () => {
  assert.match(code, /CreateFlags\s*=\s*\[uint32\]\$\{DETACHED_PROCESS\}/,
    'win-launch.js không còn truyền CreateFlags cho Win32_ProcessStartup');
  assert.match(code, /const DETACHED_PROCESS = 8\b/,
    'DETACHED_PROCESS phải là 8; CREATE_NO_WINDOW (0x08000000) bị WMI từ chối với ReturnValue 21');
});

test('ProcessStartupInformation dựng vô điều kiện — nếu không, cờ cửa sổ không có chỗ bám', () => {
  // Bug cũ: khối $su chỉ tồn tại khi có EnvironmentVariables, nên một lệnh
  // không cần biến môi trường sẽ lặng lẽ chạy lại thành có cửa sổ.
  const i = code.indexOf('New-CimInstance -ClassName Win32_ProcessStartup');
  assert.ok(i !== -1, 'không còn dựng Win32_ProcessStartup');
  const truoc = code.slice(0, i);
  const mo = (truoc.match(/\{/g) || []).length;
  const dong = (truoc.match(/\}/g) || []).length;
  // Nếu dòng $su nằm trong một `if`, độ sâu ngoặc tại đó sẽ sâu hơn thân hàm.
  assert.ok(mo - dong <= 2,
    'New-CimInstance có vẻ nằm trong một nhánh điều kiện — nó phải chạy mọi lần');
});

test('ShowWindow KHÔNG được dùng thay cho CreateFlags', () => {
  // Đã đo: SW_HIDE vẫn tạo conhost. Nếu ai đó "sửa" bằng ShowWindow, bài này
  // đỏ và nói rõ vì sao nó không đủ.
  assert.ok(!/ShowWindow/.test(code),
    'ShowWindow = 0 KHÔNG ngăn được việc tạo console — đo trên máy thật vẫn ra 1 conhost. '
    + 'Dùng CreateFlags = 8 (DETACHED_PROCESS).');
});
