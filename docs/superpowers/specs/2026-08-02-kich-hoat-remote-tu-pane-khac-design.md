# Thiết kế: bật /remote từ một pane khác, không cần Claude rảnh

- **Ngày:** 2026-08-02
- **Trạng thái:** đã triển khai (`ccrc remote`) — xem
  `docs/superpowers/plans/2026-08-02-kich-hoat-remote-tu-pane-khac.md`
- **Không thay thế gì** — thêm một đường kích hoạt mới, song song với `/remote` hiện có

## 1. Vấn đề

`/remote on` hiện chỉ chạy được như một slash command bên trong phiên Claude Code. Khi
Claude đang bận (đang chạy tool/task), tin nhắn `/remote on` bị xếp hàng và chỉ được xử lý
sau khi **tool đang chạy** kết thúc — nếu tool đó chạy lâu, Huy phải đợi lâu mới bật được
remote để vào xem điện thoại.

**Đã xác nhận qua tài liệu Claude Code chính thức (không phải giả định):** đây là giới hạn
cứng của bản thân Claude Code CLI, không sửa được từ phía `cc-remote-control`:

- Input (kể cả slash command) chỉ được đọc **giữa các lần gọi tool**, không có cách nào chen
  ngang một tool đang chạy.
- Không có hook, keybinding hay control socket nào cho external trigger bơm lệnh vào phiên
  đang chạy mà bỏ qua hàng đợi này.
- Tính năng Remote Control chính thức của Anthropic (dùng làm chuẩn so sánh, gọi là
  "remote-control gốc" trong các ghi chú trước của dự án) chạy qua API relay — không có gì
  cho thấy nó phá vỡ được hàng đợi này; cảm giác "tức thì" của nó nhiều khả năng đến từ việc
  nó bắt đúng lúc Claude tự dừng xin quyền, không phải từ việc chen ngang một tool call.

**Kết luận:** không thể sửa `/remote on` để tự chen ngang. Cách duy nhất để Huy không phải
chờ là **không phụ thuộc vào việc gõ lệnh vào phiên đang bận nữa** — bật từ một pane khác,
nhắm thẳng vào pane đang chạy Claude bằng địa chỉ tmux, không đi qua hàng đợi input của
Claude ở pane đó.

## 2. Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Không đổi `/remote` hiện có — giữ nguyên `on/off/pair/devices/unpair` | Đường cũ vẫn đúng khi Claude rảnh, không có lý do bỏ |
| D2 | Chỉ cho phép nhắm vào pane đang chạy **claude** | Huy chốt rõ: không được bật nhầm vào một shell thường |
| D3 | Xác định pane đích bằng danh sách có đánh số, Huy gõ số + Enter | Không cần nhớ cú pháp địa chỉ tmux |
| D4 | Dùng lệnh `ccrc` sẵn có (đã nằm trên PATH), thêm subcommand — không phải chạy thẳng file `.js` | `ccrc` là lệnh Huy đã quen gõ hằng ngày |
| D5 | Không đụng `.tmux.conf` — chỉ làm ở tầng CLI | Không ràng buộc vào cấu hình tmux cá nhân, dễ verify độc lập |

## 3. Kiến trúc

```
ccrc-term-cli.js (Node — logic thuần, có test, không tương tác)
  ├─ mode `on`: thêm flag --pane <id> (tuỳ chọn)
  │   → khi có flag này, dùng thẳng pane đó thay vì đọc $TMUX_PANE kế thừa
  │   → hành vi còn lại giống hệt `on` hiện tại (kiểm tra pane sống, kiểm tra
  │     đã bật sẵn chưa, spawn daemon, ghi pidfile)
  │
  └─ mode mới `candidates`: in ra JSON, mỗi phần tử là một pane đang chạy
     tiến trình `claude`:
       { pane, target, cwd, on }
     - pane:  pane_id tmux (vd "%12")
     - target: "session:window.pane" — để hiện cho người đọc
     - cwd:    thư mục làm việc hiện tại của pane
     - on:     true/false — tái dùng daemonInfo() đã có, để Huy biết pane nào
               đã bật remote sẵn, tránh chọn nhầm
     (Triển khai thực tế: tab-separated `pane\ton\tcwd\ttarget`, không phải
     JSON — lý do ở phần Global Constraints của plan triển khai.)

deploy/ccrc (shell — nơi duy nhất trong repo đọc /dev/tty tương tác, đã có
  tiền lệ ở setup-notify.sh)
  └─ subcommand mới: `ccrc remote`
     1. gọi `ccrc-term-cli.js candidates`
     2. nếu rỗng: in "Không có phiên Claude Code nào đang chạy trong tmux." rồi thoát
     3. in danh sách có số thứ tự, kèm cwd (rút gọn) và trạng thái ON/OFF
     4. đọc /dev/tty: "Nhập số: "
     5. số không hợp lệ / rỗng / ngoài khoảng → báo lỗi, thoát mã khác 0
     6. gọi lại `candidates`, xác nhận pane đã chọn **vẫn** còn trong danh sách
        (phòng trường hợp Claude ở pane đó vừa thoát giữa lúc Huy đang gõ số)
     7. đọc /dev/tty: "Tên hiện trên điện thoại (bỏ trống = ngẫu nhiên): "
     8. gọi `ccrc-term-cli.js on --pane <pane> [tên]`, in thẳng kết quả
```

### Vì sao chia Node/shell như vậy

Toàn bộ input tương tác trong repo này từ trước đến giờ nằm ở shell — `setup-notify.sh`
đọc `/dev/tty` để hỏi cấu hình, không có tiền lệ đọc stdin trong file `.js`. Giữ đúng
convention đó: `ccrc-term-cli.js` tiếp tục là logic thuần, JSON in/out, test được bằng
`node --test` như 283 test hiện có; phần hỏi/đáp với người dùng nằm trong `ccrc` — nơi vốn
đã làm việc này.

### Nhận diện "pane đang chạy claude"

`tmux list-panes -a -F '#{pane_id} #{pane_current_command} ...'`, lọc theo
`pane_current_command`. Trên macOS, `claude` là một executable Mach-O chạy trực tiếp (không
qua `node`/`bun` làm tiến trình cha), nên tên tiến trình đúng là `claude` — đã kiểm tra thực
tế trên máy Huy. Nếu sau này gặp máy cài `claude` qua trình bao khác (ví dụ `node` chạy
thẳng script), việc nhận diện cần nới thêm — không nằm trong phạm vi bản này, chỉ ghi chú để
biết đường mở rộng.

## 4. Xử lý lỗi / trường hợp biên

| Tình huống | Xử lý |
|---|---|
| Không chạy `ccrc remote` trong tmux | Không bắt buộc — lệnh này SINH RA để chạy từ pane khác, kể cả pane không thuộc cùng session |
| Không pane nào đang chạy claude | Báo rõ, thoát, không hỏi số |
| Gõ số ngoài khoảng / không phải số | Báo lỗi cụ thể, thoát mã khác 0, không đoán |
| Pane đã chọn đổi trạng thái giữa lúc list và lúc chọn (Claude thoát, hoặc ai đó vừa bật remote cho nó) | Xác nhận lại trước khi gọi `on`; nếu không còn hợp lệ, báo lại và dừng — không tự chọn pane khác thay |
| Pane đã bật remote sẵn | `on --pane` dùng lại logic `cmdOn` hiện có — báo "✓ Remote đã bật sẵn cho phiên này", không bật trùng |
| Tên phiên không hợp lệ (ký tự lạ) | Giống `/remote on` hiện tại — báo cảnh báo, dùng id ngẫu nhiên |

## 5. Kiểm thử

- **`ccrc-term-cli.js candidates`**: test bằng tmux thật (theo đúng pattern integration test
  hiện có trong `term/test/`) — dựng nhiều pane giả (một chạy lệnh giả lập tên `claude`, một
  chạy `sleep`/shell thường), xác nhận chỉ pane "claude" xuất hiện, và cờ `on` đúng khi có/
  không có pidfile hợp lệ.
- **`on --pane <id>`**: test rằng truyền `--pane` cho kết quả giống hệt khi `$TMUX_PANE` trỏ
  đúng pane đó (không có hành vi lệch giữa hai đường).
- **`ccrc remote` (shell)**: test thủ công theo checklist (repo này không có test tự động
  cho phần tương tác `/dev/tty` — đúng theo tiền lệ `setup-notify.sh`), tối thiểu:
  1. Không pane nào chạy claude → đúng thông báo, exit khác 0
  2. Một pane chạy claude, gõ đúng số → remote bật, đúng pane
  3. Gõ số sai / rỗng → báo lỗi, không bật gì
  4. Nhiều pane, chọn đúng pane thứ 2 → remote bật đúng pane đã chọn (không nhầm sang pane 1)

## 6. Không đổi

- `deploy/commands/remote.md`, hành vi `/remote on|off|pair|devices|unpair` bên trong Claude
  Code — nguyên vẹn.
- Cách điện thoại kết nối vào daemon sau khi đã bật — không đổi (đã tức thời, không phụ
  thuộc Claude bận hay rảnh; vấn đề của bản này chỉ nằm ở bước BẬT).
- `.tmux.conf` của Huy — không đụng tới.
