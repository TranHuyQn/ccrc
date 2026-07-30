// Nghi thức so số khi ghép một điện thoại với máy này.
//
// Ba hàm nhỏ, thuần tuý, không I/O — vì chúng phải được viết LẠI y hệt trong
// trình duyệt (server/public/app.js). Hai bản cài đặt cho ra hai số khác nhau
// thì người dùng thấy lệch và không ghép được: một lỗi cắt ngang hai ngôn ngữ,
// nên phần đúng-sai phải nằm ở nơi test được trực tiếp.
//
// Vì sao có `commit`: xem docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md §5.2.
// Tóm tắt: SAS ngây thơ thì hub tráo được khoá rồi dò nonce cho hai màn hình
// trùng số — sáu chữ số là 10^6 phép băm, vài mili giây.

import crypto from 'node:crypto';

export const SAS_DIGITS = 6;
export const NONCE_BYTES = 32;

export function randomNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('base64url');
}

export function commitFor(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('base64url');
}

// Tổng: mọi đầu vào dị dạng là `false`, không bao giờ ném. Hàm này chạy trên
// dữ liệu tới từ hub.
export function commitMatches(commit, nonce) {
  if (typeof commit !== 'string' || !commit) return false;
  if (typeof nonce !== 'string' || !nonce) return false;
  const a = Buffer.from(commit);
  const b = Buffer.from(commitFor(nonce));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Ba thành phần nối bằng dấu chấm. An toàn vì cả ba đều là base64url, mà bảng
// chữ base64url KHÔNG có dấu chấm — nên không có cách nào ghép hai bộ đầu vào
// khác nhau ra cùng một chuỗi. Nối trần không dấu phân tách thì có.
//
// `digits` tiêm được vì test đối chứng (pairing-attack.test.js) phải DÒ RA
// được va chạm để chứng minh cam kết là thứ chặn nó; ở 6 chữ số việc dò mất
// vài giây mỗi lần chạy suite, ở 3 chữ số là tức thì. Tính chất mật mã cần
// chứng minh không phụ thuộc độ dài — chỉ độ khó mới phụ thuộc.
// `opts || {}` chứ không phải destructure thẳng trong tham số: `= {}` mặc
// định chỉ đỡ được `shortAuthString()` (thiếu hẳn tham số), KHÔNG đỡ được
// `shortAuthString(null)` — `null` không phải `undefined` nên default không
// kích hoạt, và "Cannot destructure property 'pubKey' of 'object null'" vẫn
// ném y hệt (Task 15 review; cùng lỗi `f({a} = {})` mà bản trình duyệt,
// server/public/app.js's sasFor, đã sửa).
export function shortAuthString(opts) {
  const { pubKey, noncePhone, nonceMachine, digits = SAS_DIGITS } = opts || {};
  const material = [pubKey, noncePhone, nonceMachine].join('.');
  const h = crypto.createHash('sha256').update(material).digest();
  const n = h.readUInt32BE(0) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
