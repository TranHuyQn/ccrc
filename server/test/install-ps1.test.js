// `install.ps1` giữ tiếng Việt CÓ DẤU, và hub phải khai charset cho nó.
//
// Chuyện đã xảy ra: người dùng chạy `irm <hub>/install.ps1 | iex` và dòng đầu
// tiên họ thấy là rác —
//
//     Má» https://<hub-cua-ban>/link trÃªn thiáº¿t bá»‹ ÄÃ£ ÄÄƒng nháº­p
//
// Chẩn đoán đầu tiên của controller SAI: tưởng PowerShell không vẽ nổi chữ
// Việt, và định sửa bằng cách bỏ dấu. Phép đo qua SSH ủng hộ kết luận sai đó,
// vì SSH thêm một tầng hỏng RIÊNG (ra `?`, khác hẳn mojibake trong ảnh).
//
// Đo lại bằng cách ghi ra FILE thay vì qua ống SSH thì lộ nguyên nhân thật:
//
//     irm            -> mã ký tự 226,128,162   (ba byte UTF-8 thô của `•`)
//     curl + UTF-8   -> mã ký tự 8226          (đúng)
//
// `Invoke-RestMethod` giải mã body bằng ISO-8859-1 khi Content-Type KHÔNG khai
// charset — đúng mặc định của HTTP, sai với file này. Chuỗi hỏng NGAY LÚC TẢI,
// nên không script nào tự cứu được. Express suy mime từ đuôi file, mà `.ps1`
// không có trong bảng nên rơi vào `application/octet-stream`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(root, 'server', 'public', 'install.ps1');
const INDEX = path.join(root, 'server', 'src', 'index.js');

test('hub khai charset=utf-8 cho .ps1 — thiếu nó là irm giải mã bằng ISO-8859-1', () => {
  const src = fs.readFileSync(INDEX, 'utf8');
  assert.match(
    src,
    /\.ps1['"]\)\)\s*\{\s*[\s\S]{0,200}?text\/plain;\s*charset=utf-8/,
    "server/src/index.js không còn đặt Content-Type 'text/plain; charset=utf-8' cho .ps1. "
    + 'Bỏ dòng đó là mọi chữ tiếng Việt trong install.ps1 hiện ra thành mojibake trên '
    + 'máy người dùng, trong khi file trên đĩa vẫn hoàn toàn đúng.',
  );
});

test('install.ps1 là UTF-8 hợp lệ', () => {
  const bytes = fs.readFileSync(FILE);
  // Buffer.toString('utf8') thay ký tự hỏng bằng U+FFFD thay vì ném, nên phép
  // thử phải là đi vòng lại: giải mã rồi mã hoá lại phải ra đúng byte cũ.
  const lai = Buffer.from(bytes.toString('utf8'), 'utf8');
  assert.ok(bytes.equals(lai), 'install.ps1 không phải UTF-8 hợp lệ — có byte hỏng.');
});

test('install.ps1 không có BOM — `irm | iex` sẽ nuốt nó thành ký tự lạ', () => {
  const b = fs.readFileSync(FILE).subarray(0, 3);
  assert.notDeepEqual([...b], [0xef, 0xbb, 0xbf], 'install.ps1 bắt đầu bằng BOM UTF-8');
});

// Canh chính cái kết luận sai mà controller suýt commit. Nếu ai đó gặp lại
// mojibake rồi "sửa" bằng cách bỏ dấu, bài này đỏ và chỉ sang chỗ sửa đúng.
test('install.ps1 vẫn giữ tiếng Việt có dấu — bỏ dấu là chữa triệu chứng', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(
    /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(src),
    'install.ps1 đã bị bỏ dấu. Mojibake KHÔNG phải do PowerShell không vẽ được — '
    + 'nguyên nhân là hub thiếu charset=utf-8 nên Invoke-RestMethod giải mã bằng '
    + 'ISO-8859-1. Sửa ở server/src/index.js, đừng bỏ dấu.',
  );
});
