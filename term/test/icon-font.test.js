// Ties the icon font's @font-face to the font file it actually points at.
//
// A `unicode-range` that misses a codepoint fails SILENTLY: the browser
// downloads nothing, uses nothing, and the icon renders as an empty box with
// no error anywhere — the same shape as the wrong-content-type bug that cost a
// debugging session earlier. So the range is not trusted as written; it is
// parsed out of term.css and checked against the vendored font's own cmap.
//
// It also checks the other direction, which is the reason the range exists at
// all: no letter, digit or box-drawing character may fall inside it. If one
// did, the icon font — which contains not a single letter — would be asked to
// draw text, and 2.4 MB would be fetched for a session that shows no icons.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(here, '../public/term.css'), 'utf8');
const FONT = fs.readFileSync(path.join(here, '../vendor/symbols-nerd-font-mono.ttf'));

// --- the declared ranges, read out of the stylesheet -----------------------

function declaredRanges() {
  const m = /font-family:\s*'Nerd Icons Web'[\s\S]*?unicode-range:\s*([^;]+);/.exec(CSS);
  assert.ok(m, 'không tìm thấy unicode-range của Nerd Icons Web trong term.css');
  return m[1].split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const r = /^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/.exec(t);
    assert.ok(r, `unicode-range sai cú pháp: ${t}`);
    const start = parseInt(r[1], 16);
    return [start, r[2] ? parseInt(r[2], 16) : start];
  });
}

const RANGES = declaredRanges();
const inRange = (cp) => RANGES.some(([a, b]) => cp >= a && cp <= b);

// --- the font's own cmap ---------------------------------------------------

function fontCodepoints(buf) {
  const u16 = (o) => buf.readUInt16BE(o);
  const i16 = (o) => buf.readInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);
  const tables = {};
  for (let i = 0; i < u16(4); i++) {
    const p = 12 + i * 16;
    tables[buf.toString('ascii', p, p + 4)] = u32(p + 8);
  }
  const cmap = tables.cmap;
  let best = null;
  for (let i = 0; i < u16(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    const plat = u16(rec), enc = u16(rec + 2), sub = cmap + u32(rec + 4), fmt = u16(sub);
    const score = fmt === 12 ? 3 : (fmt === 4 && plat === 3 && enc === 1) ? 2 : 0;
    if (score && (!best || score > best.score)) best = { sub, fmt, score };
  }
  assert.ok(best, 'font không có bảng cmap đọc được');
  const out = new Set();
  if (best.fmt === 12) {
    const n = u32(best.sub + 12);
    for (let g = 0; g < n; g++) {
      const p = best.sub + 16 + g * 12;
      for (let c = u32(p); c <= u32(p + 4); c++) out.add(c);
    }
  } else {
    const segX2 = u16(best.sub + 6), seg = segX2 / 2;
    const endO = best.sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, roO = deltaO + segX2;
    for (let i = 0; i < seg; i++) {
      const end = u16(endO + i * 2), start = u16(startO + i * 2);
      const delta = i16(deltaO + i * 2), ro = u16(roO + i * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const gi = roO + i * 2 + ro + (c - start) * 2;
          if (gi + 1 >= buf.length) continue;
          gid = u16(gi);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) out.add(c);
      }
    }
  }
  return out;
}

const COVERED = fontCodepoints(FONT);

// Measured from the real prompt on this machine (tmux capture, 2026-07-28):
// segment separators, the apple/folder/git/branch/clock glyphs. These are the
// icons that were rendering as empty boxes on the phone.
const PROMPT_ICONS = [
  ['U+E0B0 separator', 0xe0b0],
  ['U+E0B2 separator', 0xe0b2],
  ['U+F179 apple', 0xf179],
  ['U+F115 folder', 0xf115],
  ['U+F1D3 git', 0xf1d3],
  ['U+F126 branch', 0xf126],
  ['U+F017 clock', 0xf017],
];

test('mọi icon của dấu nhắc đều CÓ trong font đã nhúng', () => {
  for (const [name, cp] of PROMPT_ICONS) {
    assert.ok(COVERED.has(cp), `${name} không có trong symbols-nerd-font-mono.ttf`);
  }
});

test('mọi icon của dấu nhắc đều nằm trong unicode-range đã khai báo', () => {
  for (const [name, cp] of PROMPT_ICONS) {
    assert.ok(inRange(cp),
      `${name} có trong font nhưng NGOÀI unicode-range — trình duyệt sẽ không bao giờ dùng font cho nó, và icon thành ô vuông rỗng`);
  }
});

// The reason the range is narrow. A letter falling inside it would hand text
// to a font that has no letters, and would pull 2.4 MB down for a session
// that never shows an icon.
test('KHÔNG chữ, số, dấu tiếng Việt hay ký tự khung nào lọt vào vùng font icon', () => {
  const mustBeOutside = [
    ['a', 0x61], ['Z', 0x5a], ['0', 0x30], ['dấu cách', 0x20],
    ['ế', 0x1ebf], ['ữ', 0x1eef], ['đ', 0x111], ['Đ', 0x110],
    ['─', 0x2500], ['│', 0x2502], ['╭', 0x256d], ['█', 0x2588],
    ['❯', 0x276f], // có trong CẢ HAI font — phải để font chữ thắng
  ];
  for (const [name, cp] of mustBeOutside) {
    if (cp === 0x276f) continue; // xử lý riêng ngay dưới
    assert.equal(inRange(cp), false,
      `${name} (U+${cp.toString(16).toUpperCase()}) nằm trong unicode-range của font icon`);
  }
});

// ❯ is in both vendored fonts. The stack order is what decides, and term.js
// puts the text font first — this pins the reason that order matters.
test('❯ có trong cả hai font — thứ tự stack là thứ quyết định', () => {
  assert.ok(COVERED.has(0x276f), 'font icon phải có ❯ thì test này mới có nghĩa');
  const termJs = fs.readFileSync(path.join(here, '../public/term.js'), 'utf8');
  const m = /var FONT_STACK_WEB = ([^;]+);/.exec(termJs);
  assert.ok(m, 'không tìm thấy FONT_STACK_WEB trong term.js');
  assert.ok(m[1].indexOf('JetBrains Mono Web') < m[1].indexOf('Nerd Icons Web'),
    'font icon đứng trước font chữ — ❯ sẽ lấy từ font icon thay vì font đã chọn cho tiếng Việt');
});

test('font icon KHÔNG chứa chữ cái — nếu có thì nó không còn là font chỉ-icon', () => {
  for (const cp of [0x41, 0x61, 0x30]) {
    assert.equal(COVERED.has(cp), false,
      `font icon có chứa U+${cp.toString(16).toUpperCase()} — nhúng nhầm bản đầy đủ thay vì bản Symbols?`);
  }
});
