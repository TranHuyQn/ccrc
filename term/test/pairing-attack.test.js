// Chứng minh vì sao có bước cam kết — bằng cách cho một hub ác thử tấn công
// thật, ở cả hai phiên bản giao thức.
//
// Chạy ở 3 chữ số (không gian 10^3) để việc dò xong tức thì. Tính chất được
// chứng minh không phụ thuộc độ dài SAS; ở 6 chữ số kẻ tấn công chỉ tốn thêm
// thời gian, không có thêm khả năng nào.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomNonce, commitFor, commitMatches, shortAuthString } from '../src/pairing.js';

const DIGITS = 3;
const KHOA_THAT = 'khoa-cong-khai-cua-dien-thoai-that';
const KHOA_AC = 'khoa-cong-khai-cua-hub-ac';

// Giao thức NGÂY THƠ, không có cam kết: SAS chỉ tính trên khoá + nonce máy.
// Giữ ở đây, trong test, đúng bằng vai trò của nó: một thứ để chứng minh là sai.
const sasNgayTho = (pubKey, nonceMachine) =>
  shortAuthString({ pubKey, noncePhone: '', nonceMachine, digits: DIGITS });

test('ĐỐI CHỨNG: không có cam kết thì hub tráo được khoá và ép hai màn hình trùng số', () => {
  // Hub tráo khoá gửi cho máy dev. Máy dev sinh nonce và hiện số của nó.
  const nonceMachine = randomNonce();
  const sasTrenMayDev = sasNgayTho(KHOA_AC, nonceMachine);

  // Hub THẤY nonce của máy rồi mới đi dò một nonce khác để gửi cho điện thoại.
  let nonceGia = null;
  for (let i = 0; i < 200_000 && nonceGia === null; i += 1) {
    const thu = `n-${i}`;
    if (sasNgayTho(KHOA_THAT, thu) === sasTrenMayDev) nonceGia = thu;
  }

  assert.notEqual(nonceGia, null,
    'dò được — đúng như dự đoán. Đây là lý do giao thức thật KHÔNG được ngây thơ');
  assert.equal(sasNgayTho(KHOA_THAT, nonceGia), sasTrenMayDev,
    'hai màn hình hiện cùng một số trong khi khoá đã bị tráo: người dùng bấm Khớp và hub thắng');
});

test('GIAO THỨC THẬT: có cam kết thì cùng cuộc tấn công đó thất bại', () => {
  // Điện thoại cam kết TRƯỚC, chưa mở.
  const noncePhone = randomNonce();
  const commit = commitFor(noncePhone);

  // Hub tráo khoá gửi cho máy dev, kèm cam kết thật (nó không tạo nổi cam kết
  // khác có ích: muốn mở ra một nonce khác thì phải tìm tiền ảnh SHA-256).
  const nonceMachine = randomNonce();
  const sasTrenMayDev = shortAuthString({
    pubKey: KHOA_AC, noncePhone, nonceMachine, digits: DIGITS,
  });

  // Hub thấy nonceMachine rồi mới dò. Nhưng nonce nó gửi lên phải MỞ ĐÚNG cam
  // kết đã nộp, nếu không máy dev từ chối ngay ở bước kiểm cam kết.
  let thanhCong = false;
  for (let i = 0; i < 200_000; i += 1) {
    const thu = `n-${i}`;
    if (!commitMatches(commit, thu)) continue; // không mở được cam kết → vô dụng
    if (shortAuthString({ pubKey: KHOA_THAT, noncePhone: thu, nonceMachine, digits: DIGITS })
        === sasTrenMayDev) {
      thanhCong = true;
      break;
    }
  }

  assert.equal(thanhCong, false,
    'không có nonce nào vừa mở được cam kết vừa ép hai SAS trùng — đúng thứ cam kết sinh ra để làm');
});

// Task 15 review, mục 3: đây KHÔNG phải một test dò (không có vòng lặp brute
// force nào ở đây, không như hai test trên) nên không cần thu hẹp không gian
// SAS về DIGITS=3 — và thu hẹp lại có giá: ở 3 chữ số, hai pubKey KHÁC NHAU
// trên cùng một cặp nonce trùng SAS ngẫu nhiên khoảng 0,085% số lần (đo được
// 17/20.000), làm test này TỰ FLAKE dù giao thức không hề sai. Chạy đúng ở
// SAS_DIGITS thật (mặc định của shortAuthString) để không gian đủ lớn, xác
// suất trùng ngẫu nhiên không đáng kể.
test('GIAO THỨC THẬT: chuyển tiếp nonce thật thì SAS lệch, người dùng thấy', () => {
  // Đường duy nhất còn lại cho hub: chuyển tiếp đúng nonce thật. Khi đó cam
  // kết khớp, nhưng SAS tính trên hai khoá khác nhau nên hai số khác nhau.
  const noncePhone = randomNonce();
  const nonceMachine = randomNonce();

  assert.equal(commitMatches(commitFor(noncePhone), noncePhone), true, 'cam kết khớp');

  const sasDienThoai = shortAuthString({ pubKey: KHOA_THAT, noncePhone, nonceMachine });
  const sasMayDev = shortAuthString({ pubKey: KHOA_AC, noncePhone, nonceMachine });

  assert.notEqual(sasDienThoai, sasMayDev,
    'hai màn hình phải hiện số khác nhau — đó là toàn bộ tín hiệu người dùng nhận được');
});
