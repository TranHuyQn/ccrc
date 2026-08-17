// Phiên bản hợp đồng mà hub khai trong thân trả lời của nhịp heartbeat.
//
// Ba nguồn phiên bản trong hệ này, đừng lẫn:
//   • code daemon đang chạy trong RAM  → `import { PROTOCOL_VERSION }`
//   • code đang nằm trên đĩa máy đó    → src/disk-version.js
//   • gói cài hub đang phục vụ         → chỗ này
//
// Cái thứ ba trả lời đúng một câu: "có nên chạy lại install.sh không". Máy đã
// cài không tự cập nhật, nên biết là có bản mới chính là tất cả những gì nó
// làm được — và trước 2026-08-17 thì ngay cả điều đó cũng không.

/**
 * @param {unknown} body thân JSON hub trả về
 * @returns {number|null} null khi hub không khai (bản hub cũ) hoặc khai bậy.
 *   KHÔNG bao giờ trả 0 thay cho "không biết": 0 sẽ nhỏ hơn mọi phiên bản
 *   thật và biến lời nhắc cài lại thành thứ hiện ra mãi mãi vì một chuyện
 *   không có thật.
 */
export function docPhienBanHub(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.protocolVersion;
  if (!Number.isInteger(v) || v < 0) return null;
  return v;
}

/**
 * Dấu vân tay gói cài mà hub đang phục vụ, cũng từ thân trả lời heartbeat.
 *
 * @param {unknown} body
 * @returns {string|null} null khi hub cũ không khai, hoặc khai thứ không phải
 *   một sha256 hex. Cùng lý do như docPhienBanHub: "chưa biết" phải khác hẳn
 *   "khác với của tôi", nếu không lời nhắc cài lại sẽ hiện vì một chuyện
 *   không có thật.
 */
export function docDauVanTayHub(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.bundleFingerprint;
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
}
