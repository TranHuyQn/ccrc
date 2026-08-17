// Phiên bản HỢP ĐỒNG giữa trang terminal và daemon — không phải phiên bản
// phần mềm. Tăng lên MỘT khi và chỉ khi hai bên phải hiểu nhau khác đi:
// thêm/bỏ một loại khung, đổi ý nghĩa một trường, đổi kiểu khung của một
// đường dữ liệu. Sửa lỗi hay đổi giao diện thì KHÔNG tăng.
//
// Vì sao cần: daemon nạp code vào RAM lúc khởi động, nhưng phục vụ term.js
// đọc THẲNG TỪ ĐĨA mỗi lần điện thoại xin. Cập nhật bản cài trong lúc một
// daemon đang chạy là để lại đúng tình trạng đó — trang mới nói chuyện với
// daemon cũ. Đo được 2026-08-17: phiên `miniapp` chạy code từ 11:56 trong khi
// đĩa đã cập nhật lúc 14:54, nên ô soạn gửi `ccrc_paste` (khung mới) vào một
// daemon chỉ biết `ccrc_resize` — nó rơi thẳng vào nhánh `return` cuối
// handleControlMessage. Chữ của người dùng biến mất, không một lời báo, suốt
// hai ngày.
//
// Số này để hai bên tự nhận ra chuyện đó thay vì im lặng làm sai.
export const PROTOCOL_VERSION = 1;
