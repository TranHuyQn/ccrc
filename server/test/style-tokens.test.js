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

// Bảng sáng thiếu một biến thì biến đó rơi về giá trị của bảng tối — chữ tối
// trên nền tối, hoặc ngược lại, chỉ với một dòng bị quên.
function bienTrongKhoi(dauKhoi) {
  const i = CSS.indexOf(dauKhoi);
  assert.notEqual(i, -1, `không tìm thấy khối ${dauKhoi}`);
  const mo = CSS.indexOf('{', i);
  const dong = CSS.indexOf('}', mo);
  return new Set(Array.from(CSS.slice(mo, dong).matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

test('mỗi khối theme khai báo đủ đúng bộ biến như :root', () => {
  const goc = bienTrongKhoi(':root {');
  for (const khoi of [':root:not([data-theme="dark"])', ':root[data-theme="light"]',
    ':root[data-theme="dark"]']) {
    const co = bienTrongKhoi(khoi);
    const thieu = [...goc].filter((v) => !co.has(v) && v !== '--mono').sort();
    assert.deepEqual(thieu, [], `${khoi} thiếu: ${thieu.join(', ')}`);
  }
});
