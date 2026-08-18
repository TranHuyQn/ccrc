// Một biến CSS gõ sai tên không báo lỗi ở đâu cả: trình duyệt lặng lẽ bỏ qua
// khai báo đó và phần tử rơi về màu kế thừa — thường là chữ đen trên nền đen.
// Không có gì trong repo bắt được chuyện này, nên file này làm việc đó: mọi
// var(--x) được dùng đều phải có một khai báo --x ở đâu đó trong cùng file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CSS = fs.readFileSync(path.join(here, '..', 'public', 'style.css'), 'utf8');

const dungTrongVar = () =>
  new Set(Array.from(CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/g), (m) => m[1]));
const daKhaiBao = () =>
  new Set(Array.from(CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (m) => m[1]));

test('mọi var(--x) trong style.css đều có khai báo --x', () => {
  const khaiBao = daKhaiBao();
  const thieu = [...dungTrongVar()].filter((v) => !khaiBao.has(v)).sort();
  assert.deepEqual(thieu, [], `style.css dùng biến chưa khai báo: ${thieu.join(', ')}`);
});

test('bảng màu tối khai báo đủ bộ biến bắt buộc', () => {
  const khaiBao = daKhaiBao();
  const batBuoc = ['--bg', '--card', '--surface-2', '--border', '--text',
    '--dim', '--accent', '--accent-soft', '--on-accent', '--err', '--mono'];
  const thieu = batBuoc.filter((v) => !khaiBao.has(v));
  assert.deepEqual(thieu, [], `thiếu biến: ${thieu.join(', ')}`);
});
