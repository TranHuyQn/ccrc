# Nghiệm thu nhiều phiên — 2026-07-28

Chạy thật bởi controller: hai phiên tmux, hai daemon, PWA production, Chrome.

## Cách dựng

Hai phiên `proj-alpha` (`/tmp/du-an-alpha`) và `proj-beta` (`/tmp/du-an-beta`), mỗi phiên
gõ `ccrc-term-cli.js on` **bên trong pane** — đúng đường `/remote on` đi qua, không phải
khởi động daemon bằng tay.

## Kết quả

| Kiểm | Kết quả |
|---|---|
| Hai daemon cùng sống | ✅ cổng **59155** và **59160**, OS tự cấp, không đụng nhau |
| File PID theo pane | ✅ `term-pane-%0.pid`, `term-pane-%1.pid` |
| Hub nhớ cả hai | ✅ `GET /api/terminal` trả 2 phiên, `alive: true` cả hai |
| Nhãn phân biệt | ✅ `du-an-alpha`, `du-an-beta` — basename, không phải đường dẫn đầy đủ |
| PWA hiện danh sách | ✅ 2 thẻ, nhãn đúng |
| Mở thẻ alpha | ✅ vào cổng 59155, thấy `DAY LA ALPHA`, tmux ghi `/tmp/du-an-alpha` |
| Mở thẻ beta | ✅ vào cổng 59160, thấy `DAY LA BETA`, tmux ghi `/tmp/du-an-beta` |
| Nút không kẹt sau khi quay lại | ✅ cả hai nút "Mở terminal", bấm được — bản sửa bfcache đúng cả với nhiều thẻ |
| `/remote off` ở alpha | ✅ 2 daemon → 1, 2 file PID → 1 |
| Beta sống sót | ✅ `/remote` ở beta: "ĐANG BẬT", liệt kê 1 phiên, đánh dấu `← phiên này` |
| Hiển thị | ✅ không bậc thang, không dải xám, mọi dòng ở cột 0 |

## Chưa kiểm được ở đây

- Nhánh `visualViewport` của iOS (không có thiết bị)
- Bàn phím tiếng Việt thật trên iPhone/Android
- Hành vi khi PWA vào nền lâu rồi quay lại
- Độ ổn định qua nhiều giờ, chuyển wifi ↔ 4G
