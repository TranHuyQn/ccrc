// Cửa sổ trên máy phải RỘNG TRỞ LẠI khi điện thoại rời đi.
//
// Lỗi người dùng gặp thật: nối từ điện thoại thì PowerShell co lại theo màn
// hình điện thoại — đúng như thiết kế, vì "màn nhỏ nhất thắng". Nhưng đóng
// trình duyệt xong thì nó **không bao giờ rộng lại**, và người dùng ngồi trước
// một cửa sổ to với chữ dồn vào một cột hẹp cho tới khi tắt hẳn phiên.
//
// Nguyên nhân có hai nửa, và cả hai đều là "giữ nguyên kích thước cũ" — một lý
// lẽ ĐÚNG ở host nhưng SAI ở adapter:
//
//   - `applySize()` của host bỏ qua client chưa khai kích thước, và giữ nguyên
//     khi không còn ai khai. Đúng: phiên vẫn chạy.
//   - adapter của daemon sao chép đúng lý lẽ ấy. SAI: adapter không phải người
//     cuối cùng — nó là một client của host, bên cạnh cửa sổ người dùng đang
//     ngồi trước. Giữ con số cũ là ép pty theo một chiếc điện thoại đã đóng
//     trình duyệt từ lâu.
//
// Bản vá thêm verb `0×0` = "rút lại ràng buộc" cho host, và adapter gửi nó khi
// kết nối cuối cùng rời đi.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FRAME, encodeFrame, createFrameDecoder } from '../src/pipe-frame.js';
import { readHost } from '../src/host-registry.js';

const CHI_WINDOWS = process.platform !== 'win32';
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dungHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-kt-'));
  const sessionId = 'kt' + crypto.randomBytes(4).toString('hex');
  const proc = spawn(process.execPath, [HOST], {
    env: {
      ...process.env,
      CCRC_HOME: home,
      CCRC_HOST_SESSION_ID: sessionId,
      CCRC_HOST_COMMAND: 'cmd.exe',
      CCRC_HOST_CWD: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hetGio = Date.now() + 15000;
  let ho = null;
  while (!ho && Date.now() < hetGio) { ho = readHost(sessionId, { home }); if (!ho) await sleep(100); }
  if (!ho) { proc.kill(); throw new Error('host không ghi hồ sơ kịp'); }
  return { proc, home, ho };
}

function noi(ho) {
  const c = net.createConnection(ho.pipe);
  const dec = createFrameDecoder();
  const byte = [];
  c.on('data', (d) => { for (const f of dec.push(d)) if (f.kind === FRAME.PANE) byte.push(f.payload); });
  c.on('connect', () => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'auth', secret: ho.secret }))));
  const khai = (cols, rows) => c.write(encodeFrame(FRAME.CONTROL, JSON.stringify({ type: 'resize', cols, rows })));
  return { c, byte, khai };
}

// Hỏi CHÍNH pty nó rộng bao nhiêu, thay vì tin một con số ta tự tính. `mode con`
// in ra kích thước console thật mà tiến trình bên trong nhìn thấy — đúng thứ
// người dùng phàn nàn là sai.
async function hoiBeRong(k) {
  k.byte.length = 0;
  k.c.write(encodeFrame(FRAME.PANE, Buffer.from('mode con\r\n', 'utf8')));
  const hetGio = Date.now() + 12000;
  while (Date.now() < hetGio) {
    const ra = Buffer.concat(k.byte).toString('utf8');
    const m = ra.match(/Columns:\s*(\d+)/i);
    if (m) return Number(m[1]);
    await sleep(150);
  }
  return null;
}

test('điện thoại rời đi thì pty rộng trở lại theo cửa sổ còn lại',
  { skip: CHI_WINDOWS }, async () => {
    const h = await dungHost();
    const may = noi(h.ho);      // cửa sổ trên máy
    const dt = noi(h.ho);       // "điện thoại"
    try {
      await sleep(1200);
      may.khai(160, 40);
      await sleep(600);
      const rongBanDau = await hoiBeRong(may);
      assert.equal(rongBanDau, 160, 'trước khi điện thoại nối, pty phải theo cửa sổ máy');

      dt.khai(50, 20);
      await sleep(800);
      const rongKhiCoDienThoai = await hoiBeRong(may);
      assert.equal(rongKhiCoDienThoai, 50, 'màn nhỏ nhất phải thắng khi cả hai cùng xem');

      // Điện thoại đóng trình duyệt: adapter rút lại ràng buộc bằng 0×0.
      dt.khai(0, 0);
      await sleep(800);
      const rongSauKhiRoi = await hoiBeRong(may);
      assert.equal(rongSauKhiRoi, 160,
        'pty phải rộng TRỞ LẠI theo cửa sổ máy — đây chính là lỗi người dùng gặp');
    } finally { may.c.destroy(); dt.c.destroy(); h.proc.kill(); }
  });

test('0×0 chỉ rút ràng buộc của CHÍNH client gửi, không đụng client khác',
  { skip: CHI_WINDOWS }, async () => {
    // Nếu `0×0` bị hiểu thành "bỏ mọi ràng buộc", một người xem rời đi sẽ kéo
    // pty ra khỏi kích thước của người còn ngồi đó.
    const h = await dungHost();
    const a = noi(h.ho);
    const b = noi(h.ho);
    try {
      await sleep(1200);
      a.khai(100, 30);
      b.khai(70, 25);
      await sleep(800);
      assert.equal(await hoiBeRong(a), 70, 'min của hai bên');
      b.khai(0, 0);
      await sleep(800);
      assert.equal(await hoiBeRong(a), 100, 'còn lại đúng ràng buộc của A');
    } finally { a.c.destroy(); b.c.destroy(); h.proc.kill(); }
  });

test('client rớt socket (không kịp gửi 0×0) vẫn được gỡ ràng buộc',
  { skip: CHI_WINDOWS }, async () => {
    // Đường thật hay gặp hơn cả: điện thoại mất sóng, socket đứt, không có lời
    // chào tạm biệt nào. Host đã gọi applySize() trong `sock.on('close')` từ
    // trước — bài này canh để nó không bị gỡ đi.
    const h = await dungHost();
    const may = noi(h.ho);
    const dt = noi(h.ho);
    try {
      await sleep(1200);
      may.khai(140, 40);
      dt.khai(45, 18);
      await sleep(800);
      assert.equal(await hoiBeRong(may), 45);
      dt.c.destroy();
      await sleep(1000);
      assert.equal(await hoiBeRong(may), 140, 'socket đứt cũng phải trả lại bề rộng');
    } finally { may.c.destroy(); h.proc.kill(); }
  });
