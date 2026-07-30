# Nghiệm thu bằng trình duyệt trên máy tính — 2026-07-27

Chạy thật bởi controller, Chrome trên macOS, tmux trên **socket riêng** `-L ccrc-e2e`
(không đụng phiên làm việc thật).

## Cách dựng

- Phiên gốc `orig` 200x50, có **client control-mode thật gắn ở 200 cột** — mô phỏng người
  dùng đang ngồi trước máy. Đây là điểm quan trọng: lần dựng đầu tiên **không** có client
  nào gắn vào phiên gốc, và kết quả sai lệch (xem "Sai lầm khi dựng test" bên dưới).
- Daemon chạy với `CCRC_TMUX_BIN` trỏ vào wrapper thêm `-L ccrc-e2e`, `CCRC_TERM_BIND=127.0.0.1`,
  `CCRC_TERM_NO_HUB=1`, cổng 8789.
- Vé ký tay bằng `signTicket` với bí mật thật ở `~/.ccrc/term-secret`.

## ĐẠT

| Kiểm | Bằng chứng |
|---|---|
| Trang mở được, nối được | `trangthai` = `"đã nối"`, xterm dựng xong |
| **Vé bị xoá khỏi thanh địa chỉ** | `location.hash` = `""`, `href` = `http://127.0.0.1:8789/` |
| **Gõ tiếng Việt có dấu** | Pane nhận đúng `Chào Claude, tiếng Việt có dấu` |
| **Đoạn nhiều dòng vào nguyên khối** | Cả hai dòng tới đúng thứ tự, không cắt, không mất ký tự |
| Ô soạn được xoá sau khi gửi | `oto.value` = `""` |
| `^C` tới pane | Thanh trạng thái tmux hiện `INT ✘` |
| `↑` tới pane | Lệnh cũ được gọi lại từ lịch sử |
| **Nối lại bằng `sessionKey`** | Tải lại trang không có vé trong URL → vẫn `"đã nối"` |
| **Phiên gốc KHÔNG bị co** | `orig` giữ `200x50` trong khi client trình duyệt ở 165 cột |

Mục cuối là mục quan trọng nhất — nó là toàn bộ lý do Task 5 tồn tại, và đây là lần đầu
được kiểm trong hình dạng thật (hai client control-mode gắn cùng lúc, kích thước khác nhau).

## HỎNG — hai lỗi ở đường gửi ảnh chụp màn hình ban đầu

**1. Nội dung pane cuộn mất, người dùng mở ra thấy màn hình trống.**

`capture-pane` trả về **đúng chiều cao pane** — đo được **50 dòng**. Trình duyệt lúc đó chỉ
có **39 dòng**. Ghi 50 dòng vào terminal 39 dòng ⇒ 11 dòng đầu cuộn mất, mà nội dung nằm
đúng ở đó. Kết quả: mở terminal ra thấy gần như trống, trái đúng lời hứa trong code
(*"Send what is on screen right now, so the phone opens onto the current state instead of an
empty rectangle"*).

**2. Không reset SGR ⇒ cả màn hình bị nhuộm nền sáng.**

200 byte cuối của capture, đọc bằng `od -c`:

```
033 [ 3 0 m 033 [ 4 7 m   2 1 : 4 0 : 5 1     \n \n \n \n \n ... (30 dòng trống)
```

Chuỗi cuối đặt chữ đen (`ESC[30m`) trên **nền trắng** (`ESC[47m`) rồi xuống dòng 30 lần
**không có `ESC[0m`**. Mọi dòng sau thừa hưởng nền trắng — đúng dải xám nhìn thấy trên ảnh
chụp màn hình.

## Sai lầm khi dựng test — ghi lại vì nó suýt cho kết luận sai

Lần dựng đầu tiên tạo phiên tmux **detached**, không client nào gắn vào phiên gốc. Khi
trình duyệt nối vào, phiên gốc co từ `200x50` xuống `165x39` và trông như Task 5 hỏng.

Thực ra `window-size largest` lấy kích thước client **lớn nhất đang gắn**; không có client
nào khác thì client duy nhất là trình duyệt. Dựng lại có client thật gắn ở 200 cột thì phiên
gốc giữ nguyên.

Cùng một bài học đã ghi ở Đo 1: **phải dựng đúng hình dạng lúc chạy thật**, không thì phép
đo trả lời một câu hỏi khác với câu mình tưởng mình đang hỏi.

## Chưa kiểm được ở đây

- Nhánh `visualViewport` của iOS (không có thiết bị)
- Bàn phím ảo thật, gõ tiếng Việt bằng bàn phím iOS/Android
- Hành vi khi trang vào nền lâu rồi quay lại
- Độ ổn định qua nhiều giờ và qua chuyển mạng wifi ↔ 4G
