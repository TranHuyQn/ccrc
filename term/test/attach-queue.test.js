import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachQueue } from '../src/attach-queue.js';

// Bất biến DUY NHẤT mà cả file này đo, viết ra một lần cho khỏi lạc:
//
//   mỗi client tái dựng ĐÚNG luồng byte kể từ điểm nó gắn — không sót, không lặp.
//
// Nên "màn hình" giả ở đây chỉ là phép nối chuỗi: ảnh chụp là toàn bộ byte đã
// ghi xong, khung phát đi là chính đoạn byte ấy. Vì vậy `got.join('')` của một
// client phải bằng đúng luồng byte tính từ lúc nó bắt đầu gắn. Một khung mất đi
// làm chuỗi ngắn lại, một khung lặp làm nó dài ra — cả hai kiểu hỏng đều lộ ra
// trong đúng một phép so.

// Màn hình giả: `write()` KHÔNG tự xong, nó dừng lại chờ test thả. Đó là toàn bộ
// lý do file này dựng được mọi kiểu đan xen một cách tất định — cửa sổ mất byte
// mà module này canh chỉ mở ra trong lúc một lượt ghi còn đang bay.
function makeScreen() {
  let buf = '';
  const gates = []; // các lượt ghi đã bắt đầu mà chưa xong
  const order = []; // thứ tự việc THẬT SỰ chạy trên hàng ghi
  let snapshotError = null;
  return {
    order,
    write(text) {
      return new Promise((resolve) => {
        gates.push(() => {
          buf += text;
          order.push(`write:${text}`);
          resolve();
        });
      });
    },
    snapshot() {
      if (snapshotError) throw snapshotError;
      return buf;
    },
    breakSnapshot(err) { snapshotError = err; },
    fixSnapshot() { snapshotError = null; },
    text() { return buf; },
    pending() { return gates.length; },
    releaseAll() { while (gates.length) gates.shift()(); },
  };
}

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// Cho hàng ghi chạy tới cạn: xoay microtask, thả mọi lượt ghi đang chờ, lặp lại
// cho tới khi không còn gì mới sinh ra.
async function settle(scr) {
  for (let round = 0; round < 100; round++) {
    await tick();
    if (scr.pending() === 0) return;
    scr.releaseAll();
  }
  throw new Error('hàng ghi không rút hết');
}

function makeQueue(scr) {
  return createAttachQueue({
    write: (text) => scr.write(text),
    // Trong host thật, snapshot() trả về một KHUNG đã mã hoá (hoặc null khi màn
    // hình còn trống). Ở đây khung chính là chuỗi byte, cho phép so trực tiếp.
    snapshot: () => scr.snapshot(),
  });
}

function makeClient(name = 'c') {
  return {
    name,
    got: [],
    send(frame) { this.got.push(frame); },
  };
}

test('không có gì đang bay: attach nhận đúng ảnh chụp, không nhận thừa', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('xin chao', 'xin chao');
  await settle(scr);

  const c = makeClient();
  const attached = q.attach(c, {});
  await settle(scr);

  assert.equal(await attached, true);
  assert.deepEqual(c.got, ['xin chao']);
  assert.equal(q.clients.size, 1);
  assert.equal(q.pendingCount(), 0);
});

// BÀI QUAN TRỌNG NHẤT CỦA FILE NÀY.
//
// Nó phải ĐỎ trên phiên bản đặt `clients.add` trước `await`: lúc ấy client nhận
// khung 'B' qua đường phát trực tiếp RỒI nhận lại nó trong lượt gửi bù — thấy
// hai lần. Và nó cũng đỏ trên bản không gửi bù, khi client không thấy 'B' lần
// nào. Đúng một lần là khoảng hẹp duy nhất giữa hai kiểu hỏng ấy.
test('chunk rơi đúng cửa sổ attach: client thấy nó ĐÚNG MỘT LẦN', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  await settle(scr);

  const c = makeClient();
  const attached = q.attach(c, {});
  // Chưa xoay microtask nào: mắt xích chụp còn xếp hàng, và client chưa nằm
  // trong tập phát. Đây đúng là cửa sổ đã từng nuốt mất byte.
  q.feed('B', 'B');

  await settle(scr);
  assert.equal(await attached, true);

  assert.equal(scr.text(), 'AB');
  assert.equal(c.got.join(''), 'AB', 'client phải tái dựng đủ luồng byte');
  assert.deepEqual(c.got, ['A', 'B'], 'ảnh chụp trước, rồi đúng một khung bù');
});

// Bài trên chỉ dựng được cửa sổ TRƯỚC `await link`. Còn một cửa sổ thứ hai mà
// nó KHÔNG với tới, và chỗ ấy đã đo được là mù: chèn `await Promise.resolve()`
// giữa vòng gửi bù và `clients.add` làm rơi im lặng một mảng byte trong khi cả
// 9 bài lúc ấy vẫn xanh. Đây là bài bịt chỗ mù đó.
//
// Cách dựng khe: bắn 'B' bằng một microtask hẹn từ ĐÚNG lúc client nhận ảnh
// chụp. Ở bản đúng, `joinBroadcast()` chạy trọn vẹn (gửi bù xong, `clients.add`
// xong) rồi microtask ấy mới tới lượt — client đã live, nhận 'B' qua đường
// phát. Ở bản có `await` chen vào, microtask ấy chạy đúng trong khe: client
// chưa vào tập nên không được phát, mà vòng gửi bù thì đã chạy xong — 'B' vào
// `pending` rồi nằm đó tới lúc `pending` bị xoá. Mất hẳn.
test('chunk rơi vào khe microtask NGAY SAU lượt gửi bù: vẫn đúng một lần', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  await settle(scr);

  const c = makeClient();
  const nhanGoc = c.send.bind(c);
  let daHen = false;
  c.send = (frame) => {
    nhanGoc(frame);
    if (daHen) return;
    daHen = true;
    Promise.resolve().then(() => q.feed('B', 'B'));
  };

  const attached = q.attach(c, {});
  await settle(scr);
  assert.equal(await attached, true);

  assert.equal(scr.text(), 'AB');
  assert.equal(c.got.join(''), 'AB', 'byte đến ngay sau lượt gửi bù không được rơi');
  assert.equal(q.clients.size, 1);
  assert.equal(q.pendingCount(), 0);
});

test('hai attach chồng nhau: cả hai đều đủ, không ai thấy hai lần', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  await settle(scr);

  const c1 = makeClient('c1');
  const a1 = q.attach(c1, {});
  q.feed('B', 'B');
  const c2 = makeClient('c2');
  const a2 = q.attach(c2, {});
  q.feed('C', 'C');

  await settle(scr);
  assert.equal(await a1, true);
  assert.equal(await a2, true);

  // c1 gắn trước 'B', c2 gắn trước 'C' — nhưng ảnh chụp của c2 chỉ chắc chắn
  // thấy tới 'A' hoặc 'AB' tuỳ hàng ghi. Bất biến không phụ thuộc chi tiết ấy:
  // cả hai đều phải dựng lại đủ 'ABC', mỗi byte một lần.
  assert.equal(c1.got.join(''), 'ABC');
  assert.equal(c2.got.join(''), 'ABC');

  // Đã live thì nhận thẳng, vẫn đúng một lần mỗi người.
  q.feed('D', 'D');
  await settle(scr);
  assert.equal(c1.got.join(''), 'ABCD');
  assert.equal(c2.got.join(''), 'ABCD');
  assert.equal(q.pendingCount(), 0);
});

test('snapshot() ném: chỉ client ấy hỏng, tập client sạch, hàng ghi vẫn sống', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  await settle(scr);

  const loi = [];
  scr.breakSnapshot(new Error('serialize vo'));
  const xau = makeClient('xau');
  const a = q.attach(xau, { onError: (e) => loi.push(e) });
  await settle(scr);

  assert.equal(await a, false);
  assert.equal(loi.length, 1);
  assert.match(loi[0].message, /serialize vo/);
  assert.deepEqual(xau.got, []);
  assert.equal(q.clients.size, 0);
  assert.equal(q.pendingCount(), 0, 'mảng giữ khung phải được dọn cả khi hỏng');

  // Hàng ghi không được đứt vì một lần chụp hỏng.
  scr.fixSnapshot();
  q.feed('B', 'B');
  const tot = makeClient('tot');
  const b = q.attach(tot, {});
  await settle(scr);
  assert.equal(await b, true);
  assert.equal(scr.text(), 'AB');
  assert.equal(tot.got.join(''), 'AB');
});

test('stillWanted() thành false giữa chừng: không vào tập client, không rò pending', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  await settle(scr);

  let muon = true;
  let daGan = 0;
  const c = makeClient();
  const a = q.attach(c, { stillWanted: () => muon, onAttached: () => { daGan += 1; } });
  muon = false; // socket đứt trong lúc chờ ảnh chụp
  q.feed('B', 'B');

  await settle(scr);
  assert.equal(await a, false);
  assert.deepEqual(c.got, [], 'client đã chết thì không gửi gì cho nó nữa');
  assert.equal(daGan, 0);
  assert.equal(q.clients.size, 0);
  assert.equal(q.pendingCount(), 0);

  // Và nó thật sự không còn nhận gì.
  q.feed('C', 'C');
  await settle(scr);
  assert.deepEqual(c.got, []);
});

test('enqueue (resize) giữ đúng thứ tự với feed', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  q.enqueue(() => { scr.order.push('resize'); });
  q.feed('B', 'B');

  await settle(scr);
  assert.deepEqual(scr.order, ['write:A', 'resize', 'write:B']);
  assert.equal(scr.text(), 'AB');
});

test('enqueue ném thì hàng ghi vẫn chạy tiếp', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  q.feed('A', 'A');
  q.enqueue(() => { throw new Error('resize vo'); });
  q.feed('B', 'B');

  await settle(scr);
  assert.deepEqual(scr.order, ['write:A', 'write:B']);
});

test('detach: client rời rồi thì không nhận byte nữa', async () => {
  const scr = makeScreen();
  const q = makeQueue(scr);
  const c = makeClient();
  const a = q.attach(c, {});
  await settle(scr);
  await a;

  q.feed('A', 'A');
  await settle(scr);
  assert.deepEqual(c.got, ['A']);

  q.detach(c);
  q.feed('B', 'B');
  await settle(scr);
  assert.deepEqual(c.got, ['A']);
  assert.equal(q.clients.size, 0);
});

test('feed không có khung vẫn ghi vào buffer', async () => {
  // Host gọi đường này khi encodeFrame ném (vượt MAX_FRAME): byte vẫn phải vào
  // màn hình, chỉ là không ai phát được nó đi.
  const scr = makeScreen();
  const q = makeQueue(scr);
  const c = makeClient();
  const a = q.attach(c, {});
  await settle(scr);
  await a;

  q.feed('A', null);
  await settle(scr);
  assert.equal(scr.text(), 'A');
  assert.deepEqual(c.got, []);
});
