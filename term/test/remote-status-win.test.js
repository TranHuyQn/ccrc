// `/remote` (không tham số) không được nói về tmux trên Windows.
//
// Trước bản vá, đầu ra trên Windows là:
//
//     Remote (phiên này): không xác định — không chạy trong tmux.
//     Hub: https://... — OK (915ms)
//     Phiên: chưa mở phiên nào — gõ `/remote on` trong tmux để mở.
//
// Hai lỗi trong ba dòng: nó khuyên người dùng đi mở tmux, thứ không tồn tại
// trên Windows; và dòng đầu nói "không xác định" NGAY CẢ KHI remote đang bật,
// vì nó hỏi `currentPane()` — một khái niệm của tmux — thay vì
// `phienHostHienTai()`, đúng thứ mà `on` và `off` đã dùng.
//
// Đo lại sau bản vá, trên máy Windows thật: ngoài phiên `ccrc` nó nói đúng là
// chưa ở trong phiên nào kèm cách vào; trong phiên `ccrc` nó nói `ĐANG TẮT`;
// và chữ "tmux" xuất hiện 0 lần.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js'),
  'utf8',
);

// Lấy đúng thân cmdStatus, để bài test không bị nhiễu bởi phần còn lại của file.
function thanCmdStatus() {
  const i = src.indexOf('async function cmdStatus()');
  assert.ok(i !== -1, 'không tìm thấy cmdStatus — bài test này cần được cập nhật');
  const j = src.indexOf('\nasync function ', i + 10);
  return src.slice(i, j === -1 ? undefined : j);
}

test('cmdStatus dùng phienHostHienTai trên Windows, không phải currentPane', () => {
  const than = thanCmdStatus();
  assert.match(than, /LA_WINDOWS \? phienHostHienTai\(\) : currentPane\(\)/,
    'cmdStatus không còn rẽ nhánh theo nền tảng — trên Windows nó sẽ luôn báo '
    + '"không xác định" dù remote đang bật');
});

test('mọi câu nhắc tới tmux đều nằm sau một nhánh không-Windows', () => {
  // Quét CẢ FILE: một câu "trong tmux" lọt ra ngoài nhánh nào đó là người dùng
  // Windows được khuyên đi cài một thứ không tồn tại trên máy họ.
  //
  // Tầm nhìn ngược là TỪ ĐẦU HÀM CHỨA NÓ, không phải một số dòng cố định. Bản
  // đầu của bài này nhìn ngược 12 dòng và báo nhầm ba dòng hợp lệ: `if
  // (LA_WINDOWS)` của chúng nằm cách tới 38 dòng, vì nhánh Windows ở giữa dài.
  // Một con số cố định là phỏng đoán về hình dạng code, và nó sai ngay lần đầu.
  const dong = src.split('\n');
  const dauHam = dong
    .map((d, i) => (/^(async )?function |^const \w+ = (async )?\(/.test(d) ? i : -1))
    .filter((i) => i !== -1);
  const pham = [];
  dong.forEach((d, i) => {
    if (!/trong tmux/.test(d)) return;
    if (/^\s*\/\//.test(d)) return; // comment thì không ai đọc trên màn hình
    const bd = dauHam.filter((j) => j <= i).pop() ?? 0;
    if (/LA_WINDOWS/.test(dong.slice(bd, i + 1).join('\n'))) return;
    pham.push(`dòng ${i + 1}: ${d.trim()}`);
  });
  assert.deepEqual(pham, [], `câu nhắc tmux không được rào theo nền tảng:\n  ${pham.join('\n  ')}`);
});

test('nhánh macOS vẫn giữ nguyên câu chữ tmux của nó', () => {
  // Chiều ngược lại: "sửa" bằng cách xoá sạch chữ tmux là làm hỏng thông báo
  // trên chính nền tảng dùng tmux.
  assert.match(src, /không chạy trong tmux/,
    'đã xoá mất câu thông báo tmux của macOS — nó vẫn đúng ở đó');
});
