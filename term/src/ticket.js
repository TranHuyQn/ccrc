// Kiểm token mà ĐIỆN THOẠI tự ký để mở WebSocket terminal. Đây là thứ duy
// nhất đứng giữa một URL bị lộ và một shell trên máy dev, nên nó cố tình
// nhỏ, thuần tuý, và tổng: mọi đầu vào dị dạng trả về LÝ DO chứ không ném.
//
// v1 (bỏ) ký bằng HMAC với một bí mật hub giữ hộ. Nghĩa là chủ hub ký được
// vé vào phiên của bất kỳ ai. v2 ký bằng ECDSA P-256 với khoá riêng nằm
// trên chính điện thoại, non-extractable; máy dev xác minh bằng khoá công
// khai học được một lần lúc ghép cặp. Hub không còn gì để ký.
// Xem docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md.

import crypto from 'node:crypto';

export const TOKEN_VERSION = 'v2';

// Chữ ký phủ CẢ phiên bản lẫn payload. Nếu chỉ ký payload thì một chữ ký v2
// hợp lệ dán được sang một token khai phiên bản khác — và bất cứ phiên bản
// nào thêm sau này với luật lỏng hơn sẽ nhận nó.
export function signingInputFor(payloadB64) {
  return `${TOKEN_VERSION}.${payloadB64}`;
}

function verifySignature(pubKeyB64, payloadB64, sigB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubKeyB64, 'base64url'), format: 'der', type: 'spki',
    });
    return crypto.verify(
      'sha256',
      Buffer.from(signingInputFor(payloadB64)),
      // WebCrypto ký ra raw r‖s. node:crypto mặc định chờ DER, và không đặt
      // cờ này thì MỌI chữ ký hợp lệ đều bị từ chối — triệu chứng nhìn y hệt
      // "khoá sai". Xem term/test/ticket-interop.test.js.
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64, 'base64url'),
    );
  } catch {
    // Khoá công khai hỏng trong devices.json, chữ ký sai độ dài, v.v. —
    // tất cả là "không xác minh được", không phải một tiến trình chết.
    return false;
  }
}

/**
 * @param {string} token
 * @param {{findDevice: (id: string) => ({pubKey: string}|null), sessionId: string, expectedHost: string, now?: number}} o
 *   `findDevice` được TIÊM chứ không import từ devices.js: giữ module này
 *   thuần tuý và test được mà không đụng tới đĩa.
 *   `expectedHost` là BẮT BUỘC, không có giá trị mặc định: host của chính
 *   daemon đang xác minh (spec §13, C3). Cố tình KHÔNG mặc định hoá — một
 *   người gọi quên truyền nó phải khiến MỌI token hỏng (`data.h` luôn là một
 *   chuỗi khác `undefined`), không phải âm thầm bỏ qua phép kiểm. Đây đúng là
 *   loại mặc định lặng lẽ đã gây ra lỗ hổng C1.
 */
// `o || {}` chứ không phải destructure thẳng trong tham số: một tham số
// thứ hai bị QUÊN (Task 15 review — lần thứ năm hình dạng `f({a} = {})` xuất
// hiện trong dự án này) hoặc lỡ truyền `null` đều phải trả `{ok:false,...}`
// qua các phép kiểm `typeof` bên dưới, không phải ném "Cannot destructure
// property 'findDevice' of 'undefined'" ngay tại chỗ gọi.
export function verifyAttachToken(token, o) {
  const { findDevice, sessionId, expectedHost, now = Date.now() } = o || {};
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, b64, sig] = parts;

  let data;
  try {
    data = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'malformed' };
  }
  // Mọi trường bắt buộc, không trường nào được mặc định hoá âm thầm: một
  // mặc định lặng lẽ ở đây là vô hiệu hoá kiểm tra của người gọi.
  if (typeof data.k !== 'string' || !data.k) return { ok: false, reason: 'malformed' };
  if (typeof data.n !== 'string' || !data.n) return { ok: false, reason: 'malformed' };
  if (typeof data.sid !== 'string' || !data.sid) return { ok: false, reason: 'malformed' };
  if (typeof data.m !== 'string' || !data.m) return { ok: false, reason: 'malformed' };
  if (typeof data.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (typeof data.iat !== 'number') return { ok: false, reason: 'malformed' };
  if (typeof data.h !== 'string' || !data.h) return { ok: false, reason: 'malformed' };

  // Tra thiết bị TRƯỚC khi xác minh, để phân biệt được "đã bị gỡ" với "ký
  // sai" — hai chuyện hoàn toàn khác nhau với người đang gỡ rối.
  const device = findDevice(data.k);
  if (!device || typeof device.pubKey !== 'string') {
    return { ok: false, reason: 'unknown_device' };
  }
  if (!verifySignature(device.pubKey, b64, sig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Chỉ kiểm nội dung SAU khi chữ ký đã đúng: trước đó payload là dữ liệu
  // của kẻ lạ, và một token giả không được đốt nonce nó chưa từng có.
  if (data.sid !== sessionId) return { ok: false, reason: 'wrong_session' };
  // Token phải nói rõ nó dành cho máy nào, và đây phải là máy đó.
  //
  // Không có phép kiểm này, một hub sửa mã server chỉ cần trả về một `url` trỏ
  // sang địa chỉ tailnet của nó mà giữ nguyên sessionId: điện thoại ký một
  // token hoàn toàn hợp lệ rồi trao cho trang của kẻ tấn công, trang đó chuyển
  // tiếp tới daemon thật và vào được. Xem spec §13.
  //
  // So host, không so cả URL: cổng do OS cấp và đổi mỗi lần /remote on, còn
  // đường dẫn không mang thông tin gì.
  // `gotHost` đi kèm kết quả (chứ không chỉ `reason`) để người gọi ghi log
  // được CẢ HAI host — cái token khai và cái daemon chấp nhận. Một wrong_host
  // là 401 câm phía trình duyệt; không có gotHost thì nhật ký daemon chỉ nói
  // "bị từ chối", không nói được lệch ở đâu.
  if (data.h !== expectedHost) return { ok: false, reason: 'wrong_host', gotHost: data.h };
  if (now > data.exp) return { ok: false, reason: 'expired' };

  // exp và iat đi kèm kết quả để người gọi buộc phần ghi sổ của mình (nhớ
  // nonce bao lâu, chấp nhận tuổi đúc tối đa bao nhiêu) vào chính vòng đời
  // của token, thay vì đoán bằng một hằng số rời hay đo bằng đồng hồ đang xem.
  return { ok: true, nonce: data.n, exp: data.exp, iat: data.iat, deviceId: data.k };
}
