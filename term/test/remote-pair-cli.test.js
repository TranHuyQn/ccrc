// Chạy CLI thật với HOME tạm và một hub GIẢ cục bộ, để nghi thức ghép cặp
// được kiểm từ đầu tới cuối mà không cần điện thoại — vai điện thoại do
// chính test đóng, đúng như một điện thoại thật sẽ làm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomNonce, commitFor, shortAuthString } from '../src/pairing.js';
import { listDevices } from '../src/devices.js';
import { readPending } from '../src/pending-pair.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ccrc-term-cli.js');
const PUB = 'khoa-cong-khai-gia-cua-dien-thoai';

// Hub giả: giữ đúng máy trạng thái mà server/src/pairing.js giữ, ở mức tối
// thiểu CLI cần. Vai điện thoại do test điều khiển qua `state`.
//
// `soYeuCau` cho phép dựng tình huống hai điện thoại xin ghép cùng lúc —
// dựng nó ở HUB GIẢ chứ không phải bằng một cờ trong CLI: mã sản xuất không
// được mang nhánh nào chỉ tồn tại vì test.
function hubGia(soYeuCau = 1) {
  const state = {
    pairId: 'pair-1', pubKey: PUB, commit: null, label: 'iPhone · Safari',
    state: 'started', nonceMachine: null, noncePhone: null,
    // Task 13 review (spec §12.3): máy dev giờ là bên gọi
    // POST /api/pair/finish sau khi cmdPairConfirm quyết định xong — vai của
    // endpoint đó đảo lại so với trước. Ghi lại MỌI lần gọi (không chỉ lần
    // cuối) để test khẳng định được đúng thứ gì đã được báo, với đúng pairId.
    finishCalls: [],
  };
  const srv = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/api/pair/pending') {
        if (state.state !== 'started') return send(200, { pairs: [] });
        // `pubKey` ở đây phải khớp NGUYÊN VĂN `state.pubKey` — đúng như hub
        // thật (server/src/pairing.js `pending()` trả thẳng `p.pubKey` đã
        // lưu, không bịa thêm hậu tố nào). CLI giờ chốt ảnh chụp ngay từ bản
        // ghi này (§12.1); một hậu tố giả ở đây sẽ bị chính cơ chế chống
        // tráo đổi (so khớp với bước 3) coi là dấu hiệu có người đứng giữa —
        // đúng, vì với hub thật đó CHÍNH LÀ dấu hiệu đó, chỉ là ở đây do hub
        // giả tự bịa ra chứ không phải một cuộc tấn công.
        const pairs = [];
        for (let i = 0; i < soYeuCau; i += 1) {
          pairs.push({ ...state, pairId: `pair-${i + 1}` });
        }
        return send(200, { pairs });
      }
      if (req.url === '/api/pair/challenge') {
        state.nonceMachine = body.nonceMachine; state.state = 'challenged';
        return send(200, { ok: true });
      }
      if (req.url === '/api/pair/finish') {
        state.finishCalls.push({ pairId: body.pairId, ok: body.ok });
        return send(200, { ok: true });
      }
      if (req.url.startsWith('/api/pair/')) return send(200, { ...state });
      return send(404, {});
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      state,
      base: `http://127.0.0.1:${srv.address().port}`,
      stop: () => srv.close(),
    }));
  });
}

function homeTam(hubUrl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'),
    `CCRC_HUB_URL=${hubUrl}\nCCRC_TOKEN=tok\nCCRC_MACHINE_NAME=may-test\n`);
  return home;
}

function chayCLI(home, args) {
  return new Promise((resolve) => {
    // CCRC_HOME bên cạnh HOME — xem ghi chú cùng nội dung ở remote-cli.test.js.
    const p = spawn('node', [CLI, ...args],
      { env: { ...process.env, HOME: home, CCRC_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

test('pair: tính đúng SAS mà điện thoại tính được, KHÔNG in ra, rồi DỪNG mà không ghi gì', async () => {
  // Nghi thức mới (§12.3): `/remote pair` không còn hỏi hub xem người dùng
  // đã đồng ý chưa — nó chỉ tính SAS, lưu vào pairing-pending.json, rồi
  // dừng. Ghi devices.json là việc của lệnh THỨ HAI, `/remote pair
  // xac-nhan <số>`, sau khi người dùng gõ đúng số đọc được TRÊN ĐIỆN THOẠI —
  // xem test riêng cho lệnh đó bên dưới.
  //
  // Máy KHÔNG được in số nó tính ra (bản sửa sau review của §12.3 — bản đầu
  // bảo in, sai): in nó ngay trên dòng "gõ số trên điện thoại vào đây" biến
  // việc gõ thành chép lại đúng số vừa hiện, máy so với chính nó luôn khớp,
  // và quyền phủ quyết C2 bốc hơi. Nên test này khẳng định NGƯỢC LẠI — số đó
  // không xuất hiện trên output — và đọc giá trị đã tính từ nơi nó thực sự
  // sống: file pending.
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const noncePhone = randomNonce();
  hub.state.commit = commitFor(noncePhone);

  const chay = chayCLI(home, ['pair']);

  // Vai điện thoại: chờ máy dev gửi nonce của nó, rồi mở cam kết.
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub.state.nonceMachine, 'CLI phải gửi nonce của máy lên hub');
  hub.state.noncePhone = noncePhone;
  hub.state.state = 'revealed';
  const sasDienThoai = shortAuthString({ pubKey: PUB, noncePhone, nonceMachine: hub.state.nonceMachine });

  const { code, out } = await chay;
  hub.stop();

  assert.equal(code, 0, out);
  assert.ok(!out.includes(sasDienThoai),
    `máy KHÔNG được in số của nó ra; thấy nó lộ trong output:\n${out}`);
  assert.deepEqual(listDevices({ home }), [],
    '/remote pair KHÔNG được ghi gì — nó chỉ tính số rồi dừng, chờ /remote pair xac-nhan');
  assert.equal(readPending({ home }).sas, sasDienThoai,
    'phải lưu đúng số đã tính vào file pending, để lệnh xác nhận so với nó');
});

test('hub đổi commit SAU khi nhận nonceMachine → máy dev TỪ CHỐI, không ghi gì', async () => {
  // C1: cam kết chỉ có nghĩa nếu nó được chốt TRƯỚC khi máy công bố nonce của
  // mình. Hub giả ở đây làm đúng thứ một hub ác làm được: nó phục vụ một
  // commit ở /pending, rồi SAU KHI thấy nonceMachine mới bịa ra một cặp
  // (commit', noncePhone') khớp nhau và trả về ở bước 3.
  //
  // Nếu CLI chốt commit ở bước 3 (lỗi cũ), cặp bịa đó qua được commitMatches
  // và máy ghi khoá của hub. Nếu CLI chốt ở bước 1 (đúng), commit không khớp
  // và máy từ chối.
  const hub = await hubGia();
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce()); // commit thật ở /pending

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub.state.nonceMachine, 'CLI phải gửi nonce của máy trước');

  // Hub ác: giờ mới bịa cặp khớp nhau, và tráo cả khoá.
  const nonceBia = randomNonce();
  hub.state.commit = commitFor(nonceBia);
  hub.state.noncePhone = nonceBia;
  hub.state.pubKey = 'khoa-cua-hub-ac';
  hub.state.state = 'revealed';

  // Rồi hub tự đánh dấu "done" — dù là vì nó dò trúng SAS và người dùng lỡ
  // bấm [Khớp], hay đơn giản là hub nói dối, không quan trọng: cái test này
  // canh là CLI có tự phát hiện commit bị tráo TRƯỚC khi tin bất kỳ 'done'
  // nào hay không. Không đợi tới 'done' thì test này chỉ đo được thời gian
  // hết hạn (120 giây) của CLI, xanh vì lý do sai, không canh đúng C1.
  await new Promise((r) => setTimeout(r, 300));
  hub.state.state = 'done';

  const { code, out } = await chay;
  hub.stop();

  assert.notEqual(code, 0, `phải từ chối; thấy:\n${out}`);
  assert.match(out, /đứng giữa|không khớp|✗/i);
  assert.deepEqual(listDevices({ home }), [],
    'ghi được khoá của hub vào devices.json là lỗ hổng còn nguyên');
});

test('pair: hub đổi pubKey ở bước 3 so với ảnh chụp đã chốt ở bước 1 → máy TỪ CHỐI, không ghi gì', async () => {
  // Test này TỪNG khẳng định điều ngược lại — rằng CLI phải ghi đúng khoá đã
  // chốt "lúc tính SAS", tức khoá đọc được ở BƯỚC 3. Đó chính là hình dạng
  // của C1 (spec §12.1): khẳng định ấy chỉ đúng nếu bước 3 được TIN, mà bước
  // 3 đến sau khi hub đã biết `nonceMachine` — đúng chỗ hub được phép bịa.
  //
  // Sau khi sửa C1, ảnh chụp chốt ở BƯỚC 1 (`/api/pair/pending`), trước khi
  // gửi nonceMachine. Bước 3 giờ chỉ còn tác dụng MỞ cam kết, không còn được
  // phép cung cấp `pubKey`/`commit` mới — một khác biệt ở đây không phải
  // "hai lần gọi HTTP rời nhau, chuyện thường", mà LÀ tráo đổi, vì hub là
  // bên duy nhất có thể tạo ra khác biệt đó. Nên khẳng định đúng bây giờ là
  // CLI từ chối, không phải "vẫn ghi đúng khoá cũ".
  //
  // Cô lập đúng một biến: giữ nguyên commit/noncePhone hợp lệ (cam kết vẫn
  // mở đúng), chỉ đổi pubKey — để chắc chắn đây là bẫy cho NHÁNH kiểm lệch
  // ảnh chụp, không phải nhánh commitMatches (đã có test riêng bên dưới).
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const noncePhone = randomNonce();
  hub.state.commit = commitFor(noncePhone); // cam kết hợp lệ, mở đúng noncePhone

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hub.state.nonceMachine, 'CLI phải chốt ảnh chụp (bước 1) và gửi nonce của máy trước');

  hub.state.pubKey = 'khoa-da-bi-doi-sau-khi-chot-anh-chup';
  hub.state.noncePhone = noncePhone;
  hub.state.state = 'revealed';
  // Hub tự đi tiếp sang 'done' sau đó — nếu không, một hồi quy nào đó khiến
  // CLI quay lại tin `state === 'done'` từ hub sẽ khiến test này KHÔNG BAO
  // GIỜ tới nhánh cần canh: nó chỉ đo được thời gian chờ (PAIR_WAIT_MS) của
  // CLI rồi xanh vì lý do sai, giống hệt lỗ hổng bị bắt ở test C1 phía trên.
  setTimeout(() => { hub.state.state = 'done'; }, 300);

  const { code, out } = await chay;
  hub.stop();

  assert.notEqual(code, 0, `phải từ chối; thấy:\n${out}`);
  assert.match(out, /đứng giữa|không khớp|✗/i, `phải cảnh báo; thấy:\n${out}`);
  assert.deepEqual(listDevices({ home }), [],
    'ghi khoá khi pubKey lệch ảnh chụp đã chốt là lỗ hổng còn nguyên');
});

test('pair: cam kết không mở đúng → CẢNH BÁO và KHÔNG ghi gì', async () => {
  const hub = await hubGia();
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce()); // cam kết của một nonce KHÁC

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.state.noncePhone = randomNonce(); // không mở được cam kết trên
  hub.state.state = 'revealed';
  // Cùng lý do như test trên: hub tự tiến sang 'done' để test này canh đúng
  // nhánh từ chối, không đo giờ chờ của CLI.
  setTimeout(() => { hub.state.state = 'done'; }, 300);

  const { code, out } = await chay;
  hub.stop();

  assert.notEqual(code, 0);
  assert.match(out, /đứng giữa|không khớp|✗/i, `phải cảnh báo; thấy:\n${out}`);
  assert.deepEqual(listDevices({ home }), [], 'tuyệt đối không ghi gì khi cam kết sai');
});

// Task 15 review, mục 5: vòng lặp bước 3 thoát ở CẢ BA state
// revealed|done|aborted, nhưng bản cũ chỉ kiểm `st.noncePhone` sau đó — một
// `aborted` (hàng đợi đã bị đóng) vẫn giữ nguyên `noncePhone` rơi rớt từ lần
// 'revealed' trước đó (hub thật không xoá trường này khi chuyển state), nên
// lọt qua y hệt một cuộc mở cam kết còn hợp lệ. Dựng thẳng tình huống đó,
// không phụ thuộc thời điểm poll: đặt state = 'aborted' kèm noncePhone NGAY
// từ lần đầu CLI hỏi, để test không đo may rủi giữa hai state.
test('hub báo "aborted" nhưng noncePhone cũ vẫn còn → máy KHÔNG được coi là cam kết vừa mở hợp lệ', async () => {
  const hub = await hubGia();
  try {
    const home = homeTam(hub.base);
    const noncePhone = randomNonce();
    hub.state.commit = commitFor(noncePhone); // cam kết lẽ ra mở đúng

    const chay = chayCLI(home, ['pair']);
    for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    hub.state.noncePhone = noncePhone; // rơi rớt từ lần 'revealed' — hub không xoá khi đóng hàng đợi
    hub.state.state = 'aborted';

    const { code, out } = await chay;

    assert.notEqual(code, 0, out);
    assert.match(out, /không trả lời kịp|✗/i, `phải từ chối, không được đi tiếp; thấy:\n${out}`);
    assert.deepEqual(listDevices({ home }), []);
  } finally {
    hub.stop();
  }
});

test('hub chuyển hướng sang điện thoại khác → gõ số của MÌNH vào thì máy từ chối', async () => {
  // C2 (spec §12.2): hub phục vụ yêu cầu của kẻ tấn công làm pending duy
  // nhất và tự hoàn tất handshake TRUNG THỰC — mọi chuỗi đều thật,
  // commitMatches qua, SAS nội bộ nhất quán. Trước sửa này, CLI thấy
  // `state === 'done'` là ghi — cái hub chọn nói chuyện với ai không nằm
  // trong tầm với của người dùng. Giờ `/remote pair` không còn hỏi hub gì
  // về việc người dùng đã đồng ý chưa; nó chỉ tính số của MÌNH, giữ lại
  // (không in ra), rồi dừng. Người dùng gõ số ĐỌC TRÊN ĐIỆN THOẠI CỦA HỌ
  // vào — số đó tính trên khoá thật của họ, khác với số CLI vừa tính (trên
  // khoá kẻ tấn công) —
  // nên gõ vào phải bị từ chối.
  const hub = await hubGia();
  try {
    const home = homeTam(hub.base);
    const nonceKeAc = randomNonce();
    hub.state.commit = commitFor(nonceKeAc);
    hub.state.pubKey = 'khoa-cua-ke-tan-cong';

    const chay = chayCLI(home, ['pair']);
    for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    hub.state.noncePhone = nonceKeAc;
    hub.state.state = 'revealed';
    // Hub tự đi tiếp sang 'done' — mô phỏng phần còn lại của cuộc chuyển
    // hướng: hub hoàn tất TRUNG THỰC với điện thoại kẻ tấn công. Thiếu bước
    // này, cái test đây từng ĐO ĐƯỢC MÀ KHÔNG NHẬN RA: hub giả không bao giờ
    // qua khỏi 'revealed' nên nước đi cuối của cuộc tấn công (hub tự báo
    // 'done') chưa từng được diễn; một CLI hồi quy trả quyền quyết định cho
    // hub (C2 tái xuất) khi đó chỉ bị bắt vì CLI tự time-out sau
    // PAIR_WAIT_MS — `assert.deepEqual(listDevices(...), [])` xanh MIỄN PHÍ,
    // không phải vì cơ chế phòng thủ hoạt động. Có 'done', CLI hồi quy đó
    // rớt đúng NGAY chỗ cần rớt, trong ~1 giây thay vì 122 giây.
    setTimeout(() => { hub.state.state = 'done'; }, 300);

    const { code, out } = await chay;
    assert.equal(code, 0, out);
    assert.deepEqual(listDevices({ home }), [],
      '`/remote pair` KHÔNG được ghi gì — nó chỉ tính số rồi dừng');

    // Số điện thoại THẬT của người dùng hiện ra là số khác (tính trên khoá
    // của họ, không phải khoá kẻ tấn công).
    const sasThat = shortAuthString({
      pubKey: 'khoa-that-cua-dien-thoai-nguoi-dung',
      noncePhone: nonceKeAc,
      nonceMachine: hub.state.nonceMachine,
    });

    const xn = await chayCLI(home, ['pair', 'xac-nhan', sasThat]);

    assert.notEqual(xn.code, 0);
    assert.match(xn.out, /không khớp|đứng giữa|✗/i);
    assert.deepEqual(listDevices({ home }), [],
      'gõ số không khớp mà vẫn ghi là lỗ hổng còn nguyên');
    // Task 13 review (spec §12.3): máy giờ báo LẠI cho hub sau khi quyết
    // định, kể cả khi từ chối — đây chính là nửa còn lại của "vai của
    // /api/pair/finish đã đảo" mà bản đầu của việc này chưa cài.
    assert.deepEqual(hub.state.finishCalls, [{ pairId: 'pair-1', ok: false }],
      'máy phải gọi finish(ok:false) khi số không khớp, để hub dọn hàng đợi và điện thoại biết máy đã từ chối');
  } finally {
    // Một assertion phía trên rớt KHÔNG ĐƯỢC để hub sống — nó là HTTP server
    // giữ event loop mở, và test-runner treo vô thời hạn thay vì báo `not ok`
    // rồi dừng lại. `finally` chạy dù thân test ném ở bất kỳ dòng nào.
    hub.stop();
  }
});

// Task 15 review, mục 1: câu cũ ở nhánh lệch số nói "/remote pair vẫn còn dở
// để xem lại số của máy" — người dùng vừa được báo có kẻ đứng giữa, và cách
// DUY NHẤT làm theo gợi ý đó là `cat ~/.ccrc/pairing-pending.json`, đọc SAS
// (chính là số của máy, hoặc tệ hơn — số suy ra từ khoá kẻ tấn công) rồi gõ
// lại. Bài test này khẳng định câu đó biến mất, VÀ pending bị xoá ngay khi
// lệch — giữ nó lại là để khoá của kẻ tấn công nằm cách đúng một lần gõ.
test('gõ SAI số → cảnh báo đứng giữa, KHÔNG gợi ý cách xem lại số của máy, và xoá pending ngay', async () => {
  const hub = await hubGia();
  try {
    const home = homeTam(hub.base);
    const noncePhone = randomNonce();
    hub.state.commit = commitFor(noncePhone);

    const chay = chayCLI(home, ['pair']);
    for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    hub.state.noncePhone = noncePhone;
    hub.state.state = 'revealed';
    const { code, out: outPair } = await chay;
    assert.equal(code, 0, outPair);

    const real = readPending({ home })?.sas;
    assert.ok(real, 'điều kiện đầu vào: phải có pending trước khi gõ sai số');
    const sai = real === '111111' ? '222222' : '111111'; // chắc chắn khác `real`

    const xn = await chayCLI(home, ['pair', 'xac-nhan', sai]);

    assert.notEqual(xn.code, 0, xn.out);
    assert.match(xn.out, /đứng giữa/i, `phải cảnh báo có người đứng giữa; thấy:\n${xn.out}`);
    assert.doesNotMatch(xn.out, /xem lại|còn dở/i,
      `không được gợi ý cách xem lại số của máy — cách duy nhất làm theo là đọc pairing-pending.json; thấy:\n${xn.out}`);
    assert.equal(readPending({ home }), null,
      'lệch số nghĩa là có MITM — pending phải bị xoá ngay, không để khoá của kẻ tấn công nằm cách đúng một lần gõ');
    assert.deepEqual(listDevices({ home }), [], 'tuyệt đối không ghi gì khi số lệch nhau');
  } finally {
    hub.stop();
  }
});

test('gõ đúng số → ghi devices.json, xoá file pending', async () => {
  const hub = await hubGia();
  try {
    const home = homeTam(hub.base);
    const noncePhone = randomNonce();
    hub.state.commit = commitFor(noncePhone);

    const chay = chayCLI(home, ['pair']);
    for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    hub.state.noncePhone = noncePhone;
    hub.state.state = 'revealed';
    const { code, out } = await chay;

    assert.equal(code, 0, out);
    const sas = readPending({ home }).sas;
    assert.ok(sas, `phải lưu số đã tính vào file pending; thấy:\n${out}`);

    const xn = await chayCLI(home, ['pair', 'xac-nhan', sas]);
    assert.equal(xn.code, 0, xn.out);
    assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB]);
    assert.equal(readPending({ home }), null, 'ghép xong phải xoá file pending');
    // Task 13 review (spec §12.3): máy phải BÁO LẠI cho hub sau khi ghi xong
    // — đây là nửa còn lại của "vai của /api/pair/finish đã đảo", thứ mà
    // điện thoại (server/public/app.js's waitForPairVerdict()) đang chờ để
    // biết ghép cặp đã xong và đổi thẻ "Ghép máy này" sang "Mở terminal".
    assert.deepEqual(hub.state.finishCalls, [{ pairId: 'pair-1', ok: true }],
      'máy phải gọi finish(ok:true) SAU KHI đã ghi devices.json cục bộ, không phải trước');
  } finally {
    // Cùng lý do như test trên: một assertion rớt không được để hub treo.
    hub.stop();
  }
});

// Task 13 review (spec §12.3): "fire-and-forget" nghĩa là một hub không tới
// được ở bước báo verdict không được phép biến một lần ghép cặp CỤC BỘ đã
// THÀNH CÔNG thành một dòng lệnh báo lỗi. `devices.json` được ghi TRƯỚC khi
// finish từng được gọi (xem cmdPairConfirm trong ccrc-term-cli.js) — một hub
// chết ở đúng bước cuối chỉ có nghĩa điện thoại không nghe lại được kết quả,
// không có nghĩa máy phải coi cuộc ghép là thất bại.
test('gõ đúng số nhưng hub đã ngừng phục vụ ở bước báo lại → vẫn ghép được, mã thoát vẫn 0', async () => {
  const hub = await hubGia();
  const home = homeTam(hub.base);
  const noncePhone = randomNonce();
  hub.state.commit = commitFor(noncePhone);

  const chay = chayCLI(home, ['pair']);
  for (let i = 0; i < 100 && !hub.state.nonceMachine; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  hub.state.noncePhone = noncePhone;
  hub.state.state = 'revealed';
  const { code, out } = await chay;
  assert.equal(code, 0, out);
  const sas = readPending({ home }).sas;
  assert.ok(sas, `phải lưu số đã tính vào file pending; thấy:\n${out}`);

  // Hub biến mất NGAY TRƯỚC bước báo verdict — trước khi chạy xac-nhan, chứ
  // không phải trong lúc /remote pair (đoạn đó đã có test riêng ở trên).
  hub.stop();

  const xn = await chayCLI(home, ['pair', 'xac-nhan', sas]);
  assert.equal(xn.code, 0, xn.out,
    'hub không tới được ở bước báo lại KHÔNG được đổi mã thoát của một lần ghép cặp cục bộ đã thành công');
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), [PUB],
    'devices.json phải vẫn giữ thiết bị — nó được ghi CỤC BỘ trước khi finish từng được gọi tới');
  assert.equal(readPending({ home }), null, 'ghép xong vẫn phải xoá pending dù không báo lại được cho hub');
});

test('pair xac-nhan: thiếu số hoặc chưa có cuộc ghép nào đang chờ → báo lỗi, không ném', async () => {
  // `soNhap` (process.argv[4]) có thể HOÀN TOÀN VẮNG MẶT khi người dùng gõ
  // thiếu — `/remote pair xac-nhan` không kèm số nào. Đây là đúng loại lỗi
  // ("destructuring default chỉ thay khi undefined") đã lặp lại bốn lần
  // trong kế hoạch này; bài test này exercising đường CLI thật, không chỉ
  // gọi hàm trực tiếp.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');

  // Chưa từng chạy /remote pair — không có pending nào.
  const khongCoPending = await chayCLI(home, ['pair', 'xac-nhan', '123456']);
  assert.notEqual(khongCoPending.code, 0);
  assert.match(khongCoPending.out, /không có|hết hạn/i, khongCoPending.out);

  // Thiếu hẳn số (argv[4] === undefined).
  const thieuSo = await chayCLI(home, ['pair', 'xac-nhan']);
  assert.notEqual(thieuSo.code, 0);
  assert.match(thieuSo.out, /thiếu|✗/i, thieuSo.out);
});

test('pair: hai điện thoại xin ghép cùng lúc → từ chối cả hai, không đoán bừa', async () => {
  const hub = await hubGia(2);
  const home = homeTam(hub.base);
  hub.state.commit = commitFor(randomNonce());

  const { code, out } = await chayCLI(home, ['pair']);
  hub.stop();

  assert.notEqual(code, 0);
  assert.match(out, /từng cái|nhiều hơn một/i, `phải nói rõ vì sao; thấy:\n${out}`);
  assert.equal(hub.state.nonceMachine, null,
    'không được bắt tay với cái nào — chọn bừa một trong hai là phá đúng tính chất so số bảo vệ');
  assert.deepEqual(listDevices({ home }), []);
});

test('devices: liệt kê thiết bị đã ghép; unpair gỡ đúng cái được chỉ', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  fs.writeFileSync(path.join(home, '.ccrc', 'devices.json'), JSON.stringify({
    version: 1,
    devices: [
      { pubKey: 'khoa-A', label: 'iPhone · Safari', pairedAt: 1 },
      { pubKey: 'khoa-B', label: 'Android · Chrome', pairedAt: 2 },
    ],
  }));

  const ds = await chayCLI(home, ['devices']);
  assert.equal(ds.code, 0, ds.out);
  assert.match(ds.out, /iPhone · Safari/);
  assert.match(ds.out, /Android · Chrome/);

  const up = await chayCLI(home, ['unpair', '1']);
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(listDevices({ home }).map((d) => d.label), ['Android · Chrome']);
});

// Item 1, review toàn nhánh: `label` là dữ liệu HUB, một hub có thể đặt cho
// thiết bị của kẻ tấn công đúng nhãn thiết bị thật của người dùng — cố ý,
// để `unpair <nhãn>` gỡ nhầm. `list.find` cũ âm thầm lấy thiết bị ĐẦU TIÊN
// trùng nhãn; người dùng tưởng đã gỡ kẻ lạ, thực ra gỡ mất máy thật của
// chính mình còn kẻ lạ vẫn ở lại. Số thứ tự (đường còn lại) vẫn phải làm
// việc bình thường trong đúng tình huống này.
test('unpair theo nhãn trùng nhau: từ chối, không đoán bừa lấy cái đầu tiên — số thứ tự vẫn gỡ đúng', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  fs.writeFileSync(path.join(home, '.ccrc', 'devices.json'), JSON.stringify({
    version: 1,
    devices: [
      { pubKey: 'khoa-that', label: 'iPhone · Safari', pairedAt: 1 },
      { pubKey: 'khoa-ke-tan-cong', label: 'iPhone · Safari', pairedAt: 2 },
    ],
  }));

  const up = await chayCLI(home, ['unpair', 'iPhone · Safari']);
  assert.notEqual(up.code, 0, up.out);
  assert.match(up.out, /nhiều hơn một|số thứ tự/i, up.out);
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), ['khoa-that', 'khoa-ke-tan-cong'],
    'không được gỡ bừa cái nào khi nhãn còn mơ hồ');

  // Đường còn lại (số thứ tự) vẫn phải gỡ đúng thiết bị #2 trong đúng tình
  // huống hai nhãn trùng nhau này.
  const up2 = await chayCLI(home, ['unpair', '2']);
  assert.equal(up2.code, 0, up2.out);
  assert.deepEqual(listDevices({ home }).map((d) => d.pubKey), ['khoa-that']);
});

test('devices: chưa ghép cái nào thì nói rõ, không in bảng rỗng', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-cli-'));
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ccrc', 'config'), 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  const { code, out } = await chayCLI(home, ['devices']);
  assert.equal(code, 0);
  assert.match(out, /chưa ghép|chưa có/i);
});
