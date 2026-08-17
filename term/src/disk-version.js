// Phiên bản hợp đồng ĐANG NẰM TRÊN ĐĨA, đọc lại mỗi lần được hỏi.
//
// Khác hẳn với `import { PROTOCOL_VERSION }`: cái import là ảnh chụp lúc tiến
// trình khởi động và không bao giờ đổi nữa, kể cả khi bản cài trên đĩa đã được
// thay dưới chân nó. So hai số là cách duy nhất một daemon đang chạy tự biết
// mình đã lỗi thời — và đó chính xác là tình trạng đã âm thầm kéo dài hai ngày
// trước 2026-08-17: daemon nạp code lúc 11:56, đĩa cập nhật lúc 14:54, trang
// web thì đọc thẳng từ đĩa nên nói một hợp đồng mà daemon không biết.
//
// Đọc bằng regex chứ không `import()`: một `import()` động sẽ bị Node ghi nhớ
// trong module cache, nên lần hỏi thứ hai trở đi lại trả về đúng cái ảnh chụp
// cũ — tức là hỏng đúng ở chỗ hàm này sinh ra để tránh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAC_DINH_GOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} [goc] thư mục gốc của bản cài; mặc định là cây nguồn chứa
 *   chính file này.
 * @returns {number|null} null khi không đọc được — KHÔNG đoán, vì một con số
 *   bịa sẽ hoặc kết tội oan một daemon đang chạy đúng, hoặc bỏ qua một daemon
 *   thật sự đã lỗi thời.
 */
export function phienBanTrenDia(goc) {
  try {
    const p = path.join(goc || MAC_DINH_GOC, 'shared', 'protocol-version.js');
    const m = fs.readFileSync(p, 'utf8').match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}
