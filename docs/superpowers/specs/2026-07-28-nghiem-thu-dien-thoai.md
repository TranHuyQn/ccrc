# Nghiệm thu trên điện thoại thật — 2026-07-28

Huy chạy trên iPhone, PWA cài từ màn hình chính, qua tailnet Tailscale riêng.

Đây là những thứ **không dựng lại được bằng test**: chúng cần một chiếc điện thoại thật,
một ngón tay thật, và Claude Code thật.

## ĐẠT

| Kiểm | Ghi chú |
|---|---|
| Mở terminal từ thẻ trên PWA | Vé một lần, `#t=` bị xoá khỏi thanh địa chỉ |
| **Cuộn xem lại lịch sử hội thoại** | Sau khi đổi sang gửi sự kiện lăn chuột cho ứng dụng — xem §5D.2b |
| **Chạm vào nút Claude Code vẽ trong terminal** | `Jump to bottom (click) ↓` — bấm được thật |
| Gõ tiếng Việt có dấu qua ô soạn | |
| Thanh phím `Esc ↑ ↓ ← → ⏎ Tab ⇧Tab ^C` | |
| Icon Nerd Font trong dấu nhắc | Hết ô vuông rỗng |
| Danh sách thiết bị nhận thông báo | Xem được, xoá được |
| Cài bằng một lệnh từ hub | `curl … /install.sh \| sh -s -- <token>` |

## Hai lần sửa hụt trước khi cuộn chạy được

Ghi lại vì cùng một khuôn, và khuôn đó lặp lại suốt dự án này.

**Lần 1 — phân trang lịch sử tmux.** Test xanh, thực tế vô dụng. Test dựng pane bằng `echo`
trong shell trần (`alternate_on=0`, lịch sử tmux thật). Pane thật là Claude Code:
`alternate_on=1`, `history_size=2` — **tmux không giữ gì cả**. Màn hình đầy dòng dấu nhắc lặp
lại mà Huy chụp được chính là `capture-pane` cào vào vùng trống.

**Lần 2 — copy-mode của tmux.** Chọn xong mới đo ra là sai: `pane_in_mode=1`,
`scroll_position=30` — **màn hình Mac cuộn, điện thoại không thấy gì**, vì `tmux -C` chuyển
`%output` của pane chứ không chuyển màn hình tmux dựng.

**Cách đúng:** hỏi pane trước (`mouse_any_flag`), rồi gửi sự kiện chuột cho chính ứng dụng.

Bài học, viết lại cho lần sau: **dựng test sai hình dạng thì nó trả lời một câu khác với câu
mình tưởng mình đang hỏi.** Cùng họ với "hai phiên tmux tách rời" ở §12 và với "đo bề rộng
font thay vì nhìn nét chữ" ở §5A.1.

## Vẫn chưa kiểm được

- Nhánh `visualViewport` của iOS khi bàn phím ảo bật/tắt — không có cách nào ép nó chạy từ máy
- Độ ổn định qua nhiều giờ, và khi chuyển mạng wifi ↔ 4G
- PWA vào nền rất lâu rồi quay lại
