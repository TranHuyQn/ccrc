import test from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon } from './helpers.mjs';

test('GET / trả về HTML', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /<div id="term"/);
  } finally { d.stop(); }
});

test('phục vụ được xterm.js đóng gói kèm', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/xterm.js`);
    assert.equal(r.status, 200);
    assert.ok(Number(r.headers.get('content-length')) > 100000, 'phải là file xterm thật, không phải trang lỗi');
  } finally { d.stop(); }
});

// The font is useless if the browser refuses it, and a browser refuses a font
// served with the wrong content-type — silently, falling back to another font
// with no error anywhere. That failure would look exactly like the bug the
// font was added to fix, so the type is asserted here rather than assumed.
test('phục vụ font terminal kèm đúng content-type font/woff2', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/jetbrains-mono.woff2`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'font/woff2');
    const body = Buffer.from(await r.arrayBuffer());
    assert.ok(body.length > 50000, 'file font quá nhỏ — có thể là trang lỗi, hoặc một bản subset đã bị cắt mất ký tự khung');
    // wOF2 magic — proves a real font came back, not an HTML error page that
    // happened to be labelled as one.
    assert.equal(body.subarray(0, 4).toString('hex'), '774f4632');
  } finally { d.stop(); }
});

test('KHÔNG thoát ra ngoài thư mục public bằng ..', async () => {
  const d = await startDaemon();
  try {
    for (const p of ['/../src/ticket.js', '/..%2fsrc%2fticket.js', '/vendor/../../src/ticket.js', '/%2e%2e/package.json']) {
      const r = await fetch(`http://127.0.0.1:${d.port}${p}`);
      assert.notEqual(r.status, 200, `đường dẫn phải bị chặn: ${p}`);
    }
  } finally { d.stop(); }
});

test('file không tồn tại trả 404, không lộ đường dẫn hệ thống', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/khong-co-dau.js`);
    assert.equal(r.status, 404);
    assert.ok(!(await r.text()).includes('/Volumes'), 'không được lộ đường dẫn tuyệt đối');
  } finally { d.stop(); }
});

// --- Round 2 review: `%00` giải mã thành byte NUL thật, fs.readFile ném lỗi
// ĐỒNG BỘ (trước khi kịp gọi callback) — nếu không có gì bắt, exception đó
// thoát khỏi Server.emit('request') và giết cả tiến trình daemon. Request
// này KHÔNG cần vé, không cần khoá — bất kỳ ai trên tailnet cũng gọi được.
test('%00 không làm sập daemon — trả lỗi thay vì crash', async () => {
  const d = await startDaemon();
  try {
    for (const p of ['/%00', '/vendor/%00', '/foo%00bar.js', '/vendor/foo%00bar.css', '/tap%00']) {
      const r = await fetch(`http://127.0.0.1:${d.port}${p}`);
      assert.notEqual(r.status, 200, `phải bị từ chối, không được đọc file: ${p}`);
      assert.ok(d.proc.exitCode === null && d.proc.signalCode === null,
        `daemon phải còn sống sau request: ${p}`);
    }
  } finally { d.stop(); }
});

test('sau một loạt request %00, daemon VẪN phục vụ được GET / bình thường (cùng tiến trình)', async () => {
  const d = await startDaemon();
  try {
    for (const p of ['/%00', '/vendor/%00']) {
      await fetch(`http://127.0.0.1:${d.port}${p}`);
    }
    const r = await fetch(`http://127.0.0.1:${d.port}/`);
    assert.equal(r.status, 200, 'daemon vẫn phải phục vụ bình thường sau request %00');
    assert.match(await r.text(), /<div id="term"/);
    assert.ok(d.proc.exitCode === null && d.proc.signalCode === null,
      'phải vẫn là CÙNG tiến trình daemon, không phải một tiến trình mới');
  } finally { d.stop(); }
});

// Without a cache header the browser applies its own heuristic and keeps
// these files. That is how a phone ends up running the term.js it first
// downloaded even after `/remote off && /remote on` with new code — silently,
// with no error anywhere. It cost a real debugging session: a scroll gesture
// did nothing in the browser while the same code passed its daemon tests,
// because the page was running the previous script.
test('trang và script gửi kèm cache-control: no-cache', async () => {
  const d = await startDaemon();
  try {
    for (const p of ['/', '/term.js', '/term.css', '/vendor/xterm.js']) {
      const r = await fetch(`http://127.0.0.1:${d.port}${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache',
        `${p} thiếu no-cache — điện thoại sẽ chạy bản cũ sau khi cập nhật`);
    }
  } finally { d.stop(); }
});

// The font is the one thing that may be cached hard: its contents are pinned
// by its filename, so a different font means a different URL.
test('font được cache lâu — tên file đã ghim nội dung', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/jetbrains-mono.woff2`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /immutable/);
  } finally { d.stop(); }
});

// --- Font icon Nerd Font ---------------------------------------------------
//
// A shell prompt draws its separators and its folder/git/clock glyphs from the
// Nerd Font private-use area. Without this file the phone shows a row of empty
// boxes where the prompt should be.

test('phục vụ font icon kèm đúng content-type font/ttf', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/symbols-nerd-font-mono.ttf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'font/ttf');
    const body = Buffer.from(await r.arrayBuffer());
    // 0x00010000 is the TrueType version tag — proves a real font came back
    // rather than an HTML error page wearing a font's content-type.
    assert.equal(body.subarray(0, 4).toString('hex'), '00010000');
    assert.ok(body.length > 1_000_000, `font icon quá nhỏ: ${body.length} byte`);
  } finally { d.stop(); }
});

test('font icon được cache vĩnh viễn — tên file đã ghim nội dung', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/symbols-nerd-font-mono.ttf`);
    assert.match(r.headers.get('cache-control') || '', /immutable/);
  } finally { d.stop(); }
});

// 2.4 MB is worth compressing; the daemon caches the compressed copy so the
// cost is paid once, not per request.
test('file lớn được nén gzip khi trình duyệt chấp nhận', async () => {
  const d = await startDaemon();
  try {
    const url = `http://127.0.0.1:${d.port}/vendor/symbols-nerd-font-mono.ttf`;
    const packed = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(packed.status, 200);
    assert.equal(packed.headers.get('content-encoding'), 'gzip');
    assert.match(packed.headers.get('vary') || '', /accept-encoding/i,
      'thiếu Vary thì cache dùng chung có thể trả bản nén cho client không xin nén');
    const packedLen = Number(packed.headers.get('content-length'));
    assert.ok(packedLen > 0 && packedLen < 2_000_000, `nén không ăn thua: ${packedLen}`);

    // fetch() decompresses transparently, so the bytes must still be the font.
    const body = Buffer.from(await packed.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString('hex'), '00010000');
    assert.ok(body.length > packedLen, 'giải nén ra phải lớn hơn phần đã nén');
  } finally { d.stop(); }
});

test('client KHÔNG xin nén thì nhận nguyên bản, không có content-encoding', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/vendor/symbols-nerd-font-mono.ttf`,
      { headers: { 'accept-encoding': 'identity' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-encoding'), null);
  } finally { d.stop(); }
});

// "gzipped" or "notgzip" in an Accept-Encoding must not read as gzip.
test('Accept-Encoding chỉ CHỨA chữ gzip nhưng không phải gzip → không nén', async () => {
  const d = await startDaemon();
  try {
    for (const h of ['xgzip', 'gzipped', 'notgzip']) {
      const r = await fetch(`http://127.0.0.1:${d.port}/vendor/symbols-nerd-font-mono.ttf`,
        { headers: { 'accept-encoding': h } });
      assert.equal(r.headers.get('content-encoding'), null, `"${h}" bị hiểu nhầm thành gzip`);
    }
  } finally { d.stop(); }
});

test('file nhỏ không bị nén — nén dưới ngưỡng còn tốn hơn', async () => {
  const d = await startDaemon();
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/term.js`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-encoding'), null);
  } finally { d.stop(); }
});
