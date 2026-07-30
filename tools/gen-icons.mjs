#!/usr/bin/env node
// Sinh bộ icon PWA cho web UI — không cần thư viện ngoài.
//   node tools/gen-icons.mjs
// Ghi vào server/public/icons/. Chạy lại khi muốn đổi màu/hình.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'public', 'icons');

const ACCENT = [0xd9, 0x77, 0x57]; // --accent của style.css
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // số mẫu mỗi trục khi khử răng cưa

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {Buffer} rgba pixel RGBA không nhân sẵn alpha */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  // 10..12 = compression / filter / interlace = 0

  // Mỗi scanline có 1 byte filter (0 = None) ở đầu.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- hình học (toạ độ đơn vị 0..1) -------------------------------------------

/** Khoảng cách có dấu tới hình chữ nhật bo góc tâm (0.5, 0.5). */
function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x - 0.5) - (half - r);
  const qy = Math.abs(y - 0.5) - (half - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Khoảng cách có dấu tới đoạn thẳng dày (capsule) từ a tới b, bán kính r. */
function sdSegment(x, y, ax, ay, bx, by, r) {
  const pax = x - ax, pay = y - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Glyph `>_` — chevron bên trái, gạch dưới bên phải. */
function inGlyph(x, y, scale) {
  // Thu/phóng quanh tâm để chừa vùng an toàn cho icon maskable.
  const gx = 0.5 + (x - 0.5) / scale;
  const gy = 0.5 + (y - 0.5) / scale;
  const w = 0.055; // nửa bề dày nét
  return (
    sdSegment(gx, gy, 0.30, 0.32, 0.50, 0.50, w) < 0 || // nét trên của ">"
    sdSegment(gx, gy, 0.30, 0.68, 0.50, 0.50, w) < 0 || // nét dưới của ">"
    sdSegment(gx, gy, 0.57, 0.68, 0.76, 0.68, w) < 0    // "_"
  );
}

// --- render ------------------------------------------------------------------

/**
 * @param {number} size cạnh ảnh (px)
 * @param {{rounded: boolean, glyphScale: number}} opts
 *   rounded: bo góc + nền trong suốt ngoài góc (icon "any").
 *            false = tràn viền, dùng cho maskable và apple-touch-icon.
 */
function render(size, { rounded, glyphScale }) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  const radius = 0.22; // bán kính bo góc theo đơn vị

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, glyphHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          const inBg = rounded ? sdRoundRect(x, y, 0.5, radius) < 0 : true;
          if (!inBg) continue;
          bgHits++;
          if (inGlyph(x, y, glyphScale)) glyphHits++;
        }
      }
      const n = SS * SS;
      const alpha = bgHits / n;
      // Tỉ lệ glyph tính trong phần nền để không rỉ màu ra mép bo góc.
      const g = bgHits ? glyphHits / bgHits : 0;
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = Math.round(ACCENT[c] + (WHITE[c] - ACCENT[c]) * g);
      }
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

// --- xuất file ---------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const FILES = [
  // purpose "any": bo góc, nền trong suốt ngoài góc
  ['icon-192.png', 192, { rounded: true, glyphScale: 1 }],
  ['icon-512.png', 512, { rounded: true, glyphScale: 1 }],
  // purpose "maskable": tràn viền, glyph co vào vùng an toàn (hệ điều hành tự cắt)
  ['icon-512-maskable.png', 512, { rounded: false, glyphScale: 0.62 }],
  // iOS tự bo góc, nên icon phải tràn viền và KHÔNG có alpha ở mép
  ['apple-touch-icon-180.png', 180, { rounded: false, glyphScale: 0.86 }],
];

for (const [name, size, opts] of FILES) {
  const png = render(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
