# Nghiên cứu: chạy ccrc trên Windows native (không WSL)

Ngày 2026-08-17 · nhánh `test/windows-compat` · **read-only, chưa sửa dòng code nào**

Phạm vi Huy chốt: máy dev là **Windows native**, chạy `node.exe` + PowerShell,
KHÔNG dùng WSL2.

---

## 1. Kết luận một câu

Dự án chia làm hai nửa độc lập, và độ khó chênh nhau rất xa:

| Nửa | Nội dung | Độ khó trên Windows native |
|---|---|---|
| **notify** (`hook/`) | hook Notification → hub → push điện thoại | **Dễ.** 2 chỗ vướng nhỏ, đều sửa được trong ngày |
| **terminal** (`term/`) | `/remote on`, web terminal, ghép cặp | **Viết lại tầng lõi.** tmux không tồn tại trên Windows và không có thứ thay thế tương đương |
| **hub** (`server/`) | server, chạy Docker/Linux | **Không đụng gì** |

Nói thẳng: đây **không phải việc sửa tương thích**, mà là **thay tầng
multiplexer** của nửa terminal. Nửa notify thì đúng là sửa tương thích thật.

---

## 2. Nửa notify — chỗ vướng (ít, dễ)

| # | Chỗ | File | Vấn đề | Sửa thế nào |
|---|---|---|---|---|
| N1 | Lệnh hook ghi vào `settings.json` | `hook/bin/install-hook.mjs:92` | Ghi `"C:\...\ccrc-notify.js"` trần. Windows không có shebang, không có bit execute → hook chết mỗi lần chạy | Ghi `node "<path>"` thay vì `"<path>"` |
| N2 | Script cài | `server/public/install.sh`, `setup-notify.sh`, `remove-notify.sh`, `server/public/uninstall.sh` | POSIX `sh`, dùng `curl`/`tar`/`sed` | Viết bản `.ps1` song song |
| N3 | Thư mục cài | `install.sh:32` `$HOME/.local/share/ccrc` | Quy ước Linux | `%LOCALAPPDATA%\ccrc` |
| N4 | Quyền file | `~/.ccrc/config` chmod 600 | `chmod` là no-op trên Windows → token đọc được bởi user khác trên cùng máy | `icacls` hoặc ghi nhận là hạn chế đã biết |

Phần code JS của hook (`ccrc-notify.js`, `notify-payload.js`, `ccrc-notify-cli.js`)
chỉ dùng `os.homedir()` + `fetch` → **chạy được ngay trên Windows, không cần sửa**.

---

## 3. Nửa terminal — vấn đề gốc

### 3.1 tmux không có bản Windows native

Không phải "chưa port", mà là không thể: tmux dựng trên pty POSIX + Unix socket.
Các bản có thật đều là môi trường giả lập POSIX (Cygwin/MSYS2), và trong đó
`node.exe`/`claude` bản Windows không nói chuyện được với pty của Cygwin nếu
không có `winpty` chen giữa — chắp vá, không đáng để dựa vào.

Đối thủ cũng không cứu được: `screen`, `dtach`, `abduco` đều POSIX; `zellij`
không có bản Windows chính thức.

### 3.2 Cái tmux đang gánh mà phải viết lại

Đây mới là phần đắt. `term/src/tmux.js` (690 dòng) + `ccrc-term.js` không chỉ
dùng tmux làm ống dẫn — nó dựa vào tmux cho **8 khả năng riêng biệt**:

| # | Khả năng tmux đang gánh | Gọi ở đâu | Thay bằng gì trên Windows |
|---|---|---|---|
| T1 | Luồng output realtime (`tmux -C` control mode, `%output`) | `ccrc-term.js:505` | `node-pty` (ConPTY) `onData` |
| T2 | Gõ phím vào pane (`send-keys`, `load-buffer`+`paste-buffer` cho chuỗi dài) | `ccrc-term.js:715` | `pty.write` — **đơn giản hơn**, mất luôn trần ~12000 byte của `send-keys` |
| T3 | Ảnh chụp màn hình lúc client vừa nối (`capture-pane -p -e -J`) | `tmux.js:196` | Tự nuôi buffer: `@xterm/headless` + `SerializeAddon`, hoặc ring buffer raw |
| T4 | Cuộn lại lịch sử (`capture-pane -S/-E`, `#{history_size}`) | `tmux.js:208,229` | Cùng buffer trên |
| T5 | App có muốn nhận chuột không (`#{mouse_any_flag}`, `#{mouse_sgr_flag}`) | `tmux.js:182` | **Tự parse** DECSET 1000/1002/1003/1006 trong luồng output |
| T6 | Đường dẫn làm việc của pane (`#{pane_current_path}`) — khớp phiên cho hook notify | `tmux.js:79` | Hook tự khai `cwd` của nó vào session registry (hook đã biết cwd của chính nó) |
| T7 | Chia sẻ màn hình desktop ↔ điện thoại (grouped session, `window-size smallest`) | `tmux.js:534` | **Không có tương đương.** Xem 3.3 |
| T8 | Tìm pane nào đang chạy claude (`list-panes` + `ps` subtree + khớp tty) | `ccrc-term-cli.js:523-599` | Bỏ hẳn — xem 3.3 |

Điểm sáng: **T7 và T8 biến mất chứ không phải phải viết lại** — nhưng chỉ khi
đổi kiến trúc theo 3.3. Riêng `tmux.js` sẽ mất khoảng 400 dòng logic
grouped-session/marker/reclaim (`GROUP_MARKER_OPTION`, `isReclaimableMarker`,
`claimGroupName`, `reclaimPaneSession`) — toàn bộ thứ đó tồn tại chỉ vì tmux có
khái niệm session dùng chung.

### 3.3 Đảo kiến trúc bắt buộc: "gắn vào" → "sở hữu"

Hôm nay: Claude Code chạy trong pane tmux của người dùng; daemon **gắn vào** một
pane đã có sẵn. Đó là lý do có `/remote on` gõ từ bên trong Claude, và có
`ccrc remote` chọn pane từ danh sách.

Trên Windows không có cách nào gắn vào console của một tiến trình đang chạy và
đọc được nội dung màn hình nó. Bắt buộc lật ngược:

> **`ccrc` khởi động Claude Code bên trong một ConPTY do daemon sở hữu.**

Tin tốt: đường này **đã là đường khuyến nghị sẵn** của dự án — `deploy/ccrc` đang
làm đúng chuyện đó với tmux ("gõ `ccrc` thay cho `claude`").

Cái mất, phải nói rõ:

- Phiên khởi động bằng `claude` trần (không qua `ccrc`) **không bật remote được
  về sau**. Trên macOS/Linux thì được.
- Terminal trên bàn và điện thoại cùng nhìn một pty → daemon phải **tee** output
  ra cả hai, và tranh chấp kích thước (bài toán `window-size smallest` ở
  `tmux.js:305-360`) quay lại nguyên vẹn, chỉ khác là giờ mình phải tự giải.

### 3.4 Chỗ vướng POSIX còn lại trong `term/`

| # | Chỗ | File:dòng | Vấn đề |
|---|---|---|---|
| P1 | Dò binary bằng `command -v` | `tmux.js:29` | `command` không tồn tại trên Windows → phải dùng `where.exe` |
| P2 | Đường dẫn tmux viết cứng | `tmux.js:15-21` | `/opt/homebrew`, `/usr/local/bin`… (moot nếu bỏ tmux) |
| P3 | Đường dẫn Tailscale viết cứng | `tailscale.js:12-17` | Thiếu `C:\Program Files\Tailscale\tailscale.exe` |
| P4 | `lsof -a -p <pid> -d cwd` | `ccrc-term-cli.js:124` | Không có trên Windows. Không có lệnh Windows nào trả cwd của tiến trình khác một cách gọn |
| P5 | `ps -ww -p <pid> -o command=` | `ccrc-term-cli.js:191` | Thay bằng `Get-CimInstance Win32_Process` (có `CommandLine`, `ParentProcessId`) |
| P6 | `ps -ww -eo pid=,ppid=,tty=,command=` | `ccrc-term-cli.js:526` | Như trên, nhưng **không có cột tty** → mất luôn phép lọc tty ở `subtreeHasClaude` (moot nếu theo 3.3) |
| P7 | `process.kill(pid,'SIGTERM')` cho `/remote off` | `ccrc-term-cli.js:680,757` | **Nguy hiểm nhất trong nhóm này.** Windows không có signal thật: Node dịch SIGTERM thành `TerminateProcess` → `shutdown()` ở `ccrc-term.js:1114` **không bao giờ chạy**. Hậu quả: không gửi được mã đóng 4001, không huỷ đăng ký với hub, không dọn file pid → điện thoại treo ở "đang nối lại" |
| P8 | `process.kill(pid, 0)` để dò sống/chết | `ccrc-term-cli.js:257`, `tmux.js:430` | Cái này **chạy đúng** trên Windows |
| P9 | `mode: 0o600 / 0o700` cho `devices.json`, `pairing-pending.json` | `devices.js:87-89`, `pending-pair.js:48-58` | No-op trên Windows → **khoá thiết bị đã ghép cặp đọc được bởi user khác cùng máy**. Đây là vấn đề bảo mật thật, không phải chi tiết vặt |
| P10 | `deploy/ccrc` là `#!/bin/sh` | `deploy/ccrc` | Cần bản `.ps1`/`.cmd` |

### 3.5 Hệ quả kéo theo

- **Thêm dependency native đầu tiên.** Hôm nay cả 3 workspace **không có
  dependency native nào** (`ws`, `express`, `web-push`, `xterm` — thuần JS).
  `node-pty` cần prebuild theo phiên bản Node → `install.ps1` phải xử lý ca không
  có prebuild khớp, và bundle tải về từ hub không còn "giải nén là chạy".
- **Bộ test.** `server/test/shell-scripts.test.js` (1242 dòng) đang canh
  `deploy.sh`/`install.sh` như một lớp bảo mật. Bản `.ps1` cần bộ canh tương
  đương. Lưu ý ràng buộc trong `preferences.md` (2026-08-16): **không được cài
  PowerShell lên máy Mac để syntax-check** — phải kiểm trên máy Windows thật.
- **Kiểm thử.** Toàn bộ 482 test hiện chạy trên POSIX. Cần một máy Windows thật
  để nghiệm thu; không giả lập được phần ConPTY.

---

## 4. Ba phương án

### A. Chỉ port nửa notify (nhỏ)
Windows nhận được thông báo đẩy khi Claude Code dừng chờ. Không có web terminal.
- **Việc:** N1–N4. Ước ~1 ngày.
- **Rủi ro:** thấp. Không đụng gì tới `term/`.

### B. Notify + terminal, kiến trúc "ccrc sở hữu pty" (lớn)
- **Việc:** A + T1–T6 + P1,P3,P7,P9,P10 + `install.ps1` + bộ test mới.
  Ước ~2–3 tuần, phải có máy Windows để nghiệm thu.
- **Rủi ro:** cao. T3/T4 (tự nuôi scrollback) và T5 (tự parse chế độ chuột) là hai
  chỗ dễ sinh bug tinh vi nhất — cả hai hôm nay đang được tmux làm hộ miễn phí.
- **Mất:** không gắn được vào phiên `claude` khởi động sẵn.

### C. Tách `term/` theo tầng adapter rồi mới viết bản Windows (lớn, sạch hơn)
Rút `tmux.js` + phần điều khiển trong `ccrc-term.js` ra sau một interface
(`attach/write/snapshot/history/mouseMode/resize/close`), giữ bản tmux hiện tại
nguyên vẹn, rồi thêm bản ConPTY.
- **Việc:** B + một đợt refactor phía trước. Ước thêm ~4–5 ngày.
- **Được:** macOS/Linux không bị bản Windows làm hỏng; 482 test hiện có vẫn canh
  đường tmux suốt quá trình.
- **Đây là phương án mình nghiêng về**, nếu Huy chốt làm nửa terminal.

---

## 5. Cần Huy quyết

1. Làm tới đâu — **A**, **B**, hay **C**?
2. Có máy Windows thật để nghiệm thu không? Nếu không thì B/C không nghiệm thu
   được, và mình không muốn giao hàng thứ chưa từng chạy thật.
3. Chấp nhận mất "gắn vào phiên `claude` đang chạy sẵn" trên Windows chứ?
4. Về P9 (khoá thiết bị không có ACL trên Windows): xử `icacls` hay ghi nhận là
   hạn chế đã biết rồi ghi vào tài liệu?
