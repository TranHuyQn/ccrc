// Điện thoại ký bằng WebCrypto; máy dev xác minh bằng node:crypto. Hai thư
// viện, hai định dạng chữ ký mặc định khác nhau:
//
//   WebCrypto  → raw r‖s   (IEEE P1363)
//   node:crypto→ DER       (mặc định)
//
// Quên `dsaEncoding: 'ieee-p1363'` là MỌI chữ ký hợp lệ đều bị từ chối, và
// triệu chứng nhìn y hệt "khoá sai". Test này ký bằng đúng thứ trình duyệt
// dùng, nên cái bẫy lộ ra ở đây chứ không phải trên điện thoại.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyAttachToken, signingInputFor, TOKEN_VERSION } from '../src/ticket.js';
import { deviceIdFor } from '../src/devices.js';

const { subtle } = crypto.webcrypto;

async function taoDienThoai() {
  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
  );
  const spki = Buffer.from(await subtle.exportKey('spki', pair.publicKey));
  const pubKey = spki.toString('base64url');
  return { pair, pubKey, id: deviceIdFor(pubKey) };
}

async function kyToken(phone, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    phone.pair.privateKey,
    Buffer.from(signingInputFor(payloadB64)),
  );
  return `${TOKEN_VERSION}.${payloadB64}.${Buffer.from(sig).toString('base64url')}`;
}

// `h`: host mà điện thoại THẬT SỰ sắp đi tới (spec §13). Mặc định khớp với
// `expectedHost` dùng xuyên suốt file này, để mọi test có sẵn từ trước Task
// 14 tiếp tục kiểm đúng thứ chúng đang kiểm — không phải vô tình rơi vào
// nhánh wrong_host.
const HOST_THAT = '100.86.1.2:8730';
const payloadFor = (phone, over = {}) => ({
  sid: 's-abc', m: 'may-dev', iat: 1_000_000, exp: 1_060_000, n: 'nonce-1', k: phone.id, h: HOST_THAT, ...over,
});

test('chữ ký WebCrypto xác minh được bằng node:crypto', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: (id) => (id === phone.id ? { pubKey: phone.pubKey } : null),
    sessionId: 's-abc',
    expectedHost: HOST_THAT,
    now: 1_030_000,
  });
  assert.equal(r.ok, true, `bị từ chối vì "${r.reason}" — nghi ngờ dsaEncoding chưa đặt ieee-p1363`);
  assert.equal(r.nonce, 'nonce-1');
  assert.equal(r.deviceId, phone.id);
  // exp/iat đi nguyên vẹn từ payload ra kết quả: Task 8 dùng đúng hiệu số
  // exp - iat để chặn vé đúc quá lâu. Đổi, làm rớt, hay tính sai một trong
  // hai trường này qua được mọi test khác trong bộ này nếu không pin ở đây.
  assert.equal(r.exp, 1_060_000);
  assert.equal(r.iat, 1_000_000);
});

test('token ký bởi điện thoại KHÁC bị từ chối, dù nó tự khai id của người khác', async () => {
  const that = await taoDienThoai();
  const gia = await taoDienThoai();
  // Kẻ giả ký bằng khoá riêng của MÌNH nhưng khai `k` của thiết bị thật.
  const token = await kyToken(gia, payloadFor(gia, { k: that.id }));
  const r = verifyAttachToken(token, {
    findDevice: (id) => (id === that.id ? { pubKey: that.pubKey } : null),
    sessionId: 's-abc',
    expectedHost: HOST_THAT,
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('thiết bị đã bị gỡ → unknown_device, phân biệt hẳn với chữ ký sai', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => null, // devices.json không còn nó
    sessionId: 's-abc',
    expectedHost: HOST_THAT,
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_device',
    'hai chuyện khác hẳn nhau với người đang gỡ rối: bị gỡ, hay ký sai');
});

test('sửa một byte trong payload là chữ ký hỏng', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const [v, b64, sig] = token.split('.');
  const doi = JSON.parse(Buffer.from(b64, 'base64url').toString());
  doi.sid = 's-khac';
  const gia = `${v}.${Buffer.from(JSON.stringify(doi)).toString('base64url')}.${sig}`;
  const r = verifyAttachToken(gia, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-khac', expectedHost: HOST_THAT, now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('token hết hạn bị từ chối', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-abc', expectedHost: HOST_THAT, now: 1_060_001,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('token của phiên khác bị từ chối', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-phien-khac', expectedHost: HOST_THAT, now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_session');
});

test('đúng biên hết hạn (now === exp) vẫn còn hiệu lực, qua biên một chút thì hết', async () => {
  // exp trong payloadFor là 1_060_000. Nếu điều kiện ở ticket.js lỡ tay viết
  // `>=` thay vì `>`, đúng biên sẽ bị từ chối oan — test này bắt đúng chỗ đó.
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const dungBien = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-abc', expectedHost: HOST_THAT, now: 1_060_000,
  });
  assert.equal(dungBien.ok, true, `đúng biên hết hạn phải còn hiệu lực, bị từ chối vì "${dungBien.reason}"`);

  const quaBien = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-abc', expectedHost: HOST_THAT, now: 1_060_001,
  });
  assert.equal(quaBien.ok, false);
  assert.equal(quaBien.reason, 'expired');
});

test('chữ ký sai độ dài, với thiết bị ghép cặp thật, không làm ném lỗi', async () => {
  // Không phải "thiết bị không tồn tại" (unknown_device) — findDevice ở đây
  // tìm được thiết bị bình thường. LƯU Ý: input này KHÔNG chạy qua nhánh
  // catch của verifySignature — đã kiểm chứng bằng thực nghiệm rằng
  // crypto.verify(..., {dsaEncoding: 'ieee-p1363'}) trả về `false` một cách
  // êm thấm cho MỌI độ dài chữ ký sai trên phiên bản Node này, không ném.
  // Test này vẫn đáng pin (hợp đồng quan sát được: không ném, bad_signature)
  // nhưng không chứng minh nhánh catch còn sống — xem test kế tiếp cho việc
  // đó (pubKey hỏng khiến createPublicKey ném thật).
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const [v, b64, sig] = token.split('.');
  const gia = `${v}.${b64}.${sig.slice(0, -8)}`;
  let r;
  assert.doesNotThrow(() => {
    r = verifyAttachToken(gia, {
      findDevice: () => ({ pubKey: phone.pubKey }), sessionId: 's-abc', expectedHost: HOST_THAT, now: 1_030_000,
    });
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('pubKey hỏng trong devices.json khiến createPublicKey ném — verifyAttachToken vẫn không ném, trả bad_signature', async () => {
  // Đây mới thật sự là input chạm nhánh catch trong verifySignature: pubKey
  // của thiết bị (thứ findDevice trả về, KHÔNG PHẢI chữ ký) không phải DER
  // SPKI hợp lệ, nên crypto.createPublicKey ném lỗi thật
  // ("Failed to read asymmetric key"). Một mục devices.json hỏng — do lỗi
  // ghi đĩa hay ghép cặp dở dang — không được phép biến một request chưa
  // xác thực thành một daemon chết.
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone));
  const pubKeyHong = Buffer.from('day-khong-phai-mot-khoa-DER-SPKI-hop-le').toString('base64url');
  let r;
  assert.doesNotThrow(() => {
    r = verifyAttachToken(token, {
      findDevice: () => ({ pubKey: pubKeyHong }), sessionId: 's-abc', expectedHost: HOST_THAT, now: 1_030_000,
    });
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// --- C3 (spec §13): token phải ràng buộc với MÁY nó được trao cho ----------
//
// Payload trước đây nói token này dành cho phiên nào (`sid`) nhưng KHÔNG BAO
// GIỜ nói dành cho máy nào. Một hub sửa mã server có thể trả về, cho một
// phiên thật, một `url` trỏ sang địa chỉ tailnet của kẻ tấn công nhưng GIỮ
// NGUYÊN sessionId thật — điện thoại thấy địa chỉ hợp lệ về hình dạng nên ký,
// rồi trao token cho trang của kẻ tấn công, trang đó chuyển tiếp tới daemon
// thật và vào được. Không cần một byte app.js nào bị sửa.

test('token ký cho host KHÁC bị từ chối — hub lừa điện thoại trao token cho trang lạ', async () => {
  // C3 (spec §13): hub sửa mã server trả về một `url` trỏ tới địa chỉ tailnet
  // của kẻ tấn công nhưng GIỮ NGUYÊN sessionId thật. Điện thoại thấy địa chỉ
  // hợp lệ về hình dạng nên ký, rồi trao token cho trang của kẻ tấn công.
  // Trang đó chuyển tiếp tới daemon thật. Nếu token không mang theo đích của
  // nó thì daemon không có cách nào biết.
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone, { h: '100.86.66.66:9999' }));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }),
    sessionId: 's-abc',
    expectedHost: '100.86.1.2:8730',   // daemon thật
    now: 1_030_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_host',
    'token chuyển tiếp từ trang khác phải chết ở đây — đó là toàn bộ giá trị của trường h');
  // Review sau Task 14: một wrong_host là 401 câm phía trình duyệt — daemon
  // phải ghi log được CẢ HAI host (host token khai vs host nó chấp nhận) để
  // người gỡ rối trên máy dev nhìn thấy vì sao. gotHost là cái daemon cần để
  // ghi log đó — không phải chỉ để test tự thoả mãn.
  assert.equal(r.gotHost, '100.86.66.66:9999',
    'daemon cần host token khai (gotHost) để ghi log wrong_host có ý nghĩa, không chỉ biết "sai đâu đó"');
});

test('token ký cho đúng host được chấp nhận', async () => {
  const phone = await taoDienThoai();
  const token = await kyToken(phone, payloadFor(phone, { h: '100.86.1.2:8730' }));
  const r = verifyAttachToken(token, {
    findDevice: () => ({ pubKey: phone.pubKey }),
    sessionId: 's-abc', expectedHost: '100.86.1.2:8730', now: 1_030_000,
  });
  assert.equal(r.ok, true, `bị từ chối vì "${r.reason}"`);
});
