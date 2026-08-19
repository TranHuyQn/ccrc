# Thiết kế: ccrc chạy trên Windows native

Ngày 2026-08-17 · nhánh `test/windows-compat`
Nghiên cứu nền: [`2026-08-17-windows-native-research.md`](./2026-08-17-windows-native-research.md)

---

## 1. Mục tiêu và phạm vi

Cho `/remote` (web terminal) và `/notify` (thông báo đẩy) chạy được trên máy dev
**Windows native** — `node.exe` + PowerShell, KHÔNG qua WSL.

Không thuộc phạm vi: WSL2, hub (`server/`, chạy Docker/Linux, không đụng).

## 2. Ràng buộc bất di bất dịch

> **macOS và Linux đã ổn định. Không được ảnh hưởng.**

Cụ thể hoá thành hai điều kiểm chứng được:

1. 482 test hiện có phải xanh, không sửa một bài nào để cho nó xanh.
2. Hành vi `/remote` trên Mac phải y hệt trước — verify bằng tay, không chỉ dựa
   vào test.

Đợt refactor adapter (§5) là **commit riêng, không lẫn một dòng Windows nào**, để
lệch thì revert đúng một commit.

Ràng buộc thứ hai, từ `preferences.md` (2026-08-16): **không cài phần mềm lên máy
Mac để tự kiểm chứng** — kể cả PowerShell để syntax-check `.ps1`. Kiểm trên máy
Windows thật.

## 3. Bằng chứng — bốn phép đo đã chạy

Đo ngày 2026-08-17 trên máy Windows 11 build 26100.9168, AMD64, Node v22.23.1.

| # | Câu hỏi | Kết quả |
|---|---|---|
| 1 | `node-pty` cài được không? | ✓ 11 giây. **Có prebuilds `win32-x64`** — không biên dịch, **không cần Visual Studio Build Tools** |
| 2 | ConPTY chạy thật không? | ✓ mở được, chạy lệnh, trả escape sequence đầy đủ (`ESC[?9001h`, `ESC[2J`, `ESC[m ESC[H`) |
| 3 | Host nền sống sau khi tiến trình cha thoát? | ✓ sống, pty vẫn nhận lệnh sau đó |
| 4 | Host nền sống sau khi **phiên đóng**? | ✗ với `spawn detached`; ✓ khi khởi chạy qua WMI `Win32_Process.Create` |

Phép đo 1 gỡ rủi ro lớn nhất của cả phương án. Phép đo 4 đổi cách khởi chạy host
— phát hiện sớm, thay vì phát hiện lúc đã viết xong nửa host.

**Hai giả định trong bản nghiên cứu bị bác bỏ bởi số đo:**

- `install.ps1` tải về chạy sẽ bị chặn: ExecutionPolicy mặc định là `Restricted`
  (cả 5 scope `Undefined`), chính `npm.ps1` cũng chết vì nó. Phải dùng
  `irm <url> | iex` — chuỗi trong bộ nhớ, ExecutionPolicy không đụng tới.
- `spawn(..., {detached:true})` không đủ để host sống qua phiên: Windows nhốt
  phiên vào Job Object và Node không có cờ breakaway.

## 4. Kiến trúc

### Hôm nay (macOS/Linux) — giữ nguyên

```
Terminal trên bàn ──> tmux server ──> pane: claude
                          ▲
                          │ tmux -C attach-session
                          │
                   ccrc-term.js (daemon)  ──HTTP/WS──> điện thoại
```

`tmux server` là tiến trình riêng, luôn sống, giữ pane. Daemon chỉ sinh ra khi
`/remote on` và chết khi `/remote off` — tắt remote là không còn cổng nào mở.

### Windows

```
Windows Terminal ──> ccrc.cmd (client mỏng)
                          │ named pipe
                          ▼
                   ccrc-host.js (nền, khởi chạy qua WMI)
                          └─ ConPTY ──> claude.exe
                          ▲
                          │ named pipe
                          │
                   ccrc-term.js (daemon)  ──HTTP/WS──> điện thoại
                          ▲
                          │ named pipe điều khiển (§7.1)
                          │
                   ccrc-term-cli.js  (`/remote off`)
```

Có **hai** named pipe, đừng nhầm: một của host (dữ liệu pane, host là server), một
của daemon (chỉ nhận lệnh `shutdown`, daemon là server). Cùng cơ chế secret.

### Quyết định: `ccrc-host` TÁCH KHỎI `ccrc-term`

`ccrc-host` đóng đúng vai tmux server — luôn sống, giữ pty, **không mở cổng mạng
nào**. `ccrc-term` vẫn là daemon web như hiện nay, chỉ đổi chỗ lấy dữ liệu.

Vì sao tách chứ không gộp:

- `ccrc-term.js` không phải đổi cấu trúc. Nó vẫn là "nối vào một nguồn pane, đẩy
  ra WebSocket"; chỉ định nghĩa "nguồn pane" là thay. Đó chính là ranh giới
  adapter — có sẵn trong bài toán, không phải bịa ra.
- Giữ nguyên tính chất bảo mật hiện có: tắt remote = daemon chết = không cổng nào
  mở. Gộp thì host phải luôn sống, kéo phần web luôn sống theo — đổi mô hình phơi
  bày mà không ai yêu cầu.
- Phiên Claude sống độc lập với remote: bật/tắt remote nhiều lần không đụng phiên
  đang chạy, y như tmux.

Giá phải trả: thêm một tiến trình, và một giao thức pipe phải tự định nghĩa —
thứ tmux cho không.

### Đảo chiều bắt buộc: "gắn vào" → "sở hữu"

Windows không có API đọc nội dung màn hình console của tiến trình đang chạy, và
không có tmux native. Nên daemon buộc phải là **cha** của Claude.

Hệ quả với người dùng — nêu rõ vì đây là khác biệt hành vi thật:

- Phải khởi động bằng `ccrc` thay vì `claude`. (Đã là đường khuyến nghị sẵn của
  dự án.) **Không** phải quyết định bật remote từ đầu — `/remote on` vẫn bật lúc
  nào cũng được.
- Phiên lỡ khởi động bằng `claude` trần **không cứu được**. macOS/Linux cứu được.
  Đau nhất khi Claude được khởi động từ chỗ không kiểm soát: VS Code terminal,
  shortcut, profile Windows Terminal.

## 5. Tầng adapter

### Interface

Rút ra từ đúng những gì khối `wss.on('connection')` (`ccrc-term.js:429-955`) đang
hỏi tmux hôm nay. Không thêm phương thức cho tương lai.

| Phương thức | tmux (macOS/Linux) | ConPTY (Windows) |
|---|---|---|
| `type(bytes)` | `send-keys -H`, cắt nhỏ theo `splitForSendKeys` | `pty.write` |
| `paste(text, {onAck, onErr})` | `load-buffer` + `paste-buffer -p -r -d` | `pty.write`, tự quyết bracketed paste |
| `onData(cb)` | `tmux -C` → `%output` | `pty.onData` |
| `snapshot()` | `capture-pane -p -e -J` | buffer tự nuôi |
| `historySize()` | `#{history_size}` | buffer tự nuôi |
| `history(offset, rows)` | `capture-pane -S/-E` | buffer tự nuôi |
| `mouseMode()` | `#{mouse_any_flag}` `#{mouse_sgr_flag}` | tự parse DECSET 1000/1002/1003/1006 |
| `resize(cols, rows)` | tmux tự lo qua grouped session | `pty.resize` |
| `alive()` | `paneAlive()` | host còn giữ pty không |
| `onGone(cb)` | `ctl.on('exit')` + phân biệt nhóm/pane | pipe đứt |
| `close()` | `killGroupSession()` | đóng pipe (pty vẫn sống) |

Thêm ba thành viên nữa, phát hiện lúc lập kế hoạch (2026-08-17) khi rà từng lời
gọi tmux thật trong `ccrc-term.js` thay vì chỉ đọc khối connection:

| Phương thức | tmux | ConPTY |
|---|---|---|
| `attach({onData, onGone})` | dựng phiên nhóm + `tmux -C attach-session` | nối vào pipe của host |
| `cwd()` | `#{pane_current_path}` | host khai |
| `socket()` | `#{socket_path}` | tên pipe của host |

`cwd()`/`socket()` là khoá đối chiếu của sổ tra phiên
(`shared/session-registry.js`) — thứ cho hook thông báo gắn đúng tên vào đúng
thẻ. Bốn lời gọi này nằm **ngoài** khối connection (`ccrc-term.js:146, 422,
1084-1085, 1111`), nên đọc mỗi khối 429–955 là bỏ sót. **`cwd()` không bao giờ
rời khỏi máy** — gửi nó đi là mở lại đúng lỗ rò riêng tư mà sổ tra phiên sinh ra
để bịt.

### Adapter có HAI TẦNG, không phải một danh sách phẳng

Sửa 2026-08-17 sau khi thực thi Task 2 lộ ra một lỗi kiến trúc trong bản đầu.

| Tầng | Số lượng | Thành viên |
|---|---|---|
| **Nguồn** | MỘT cho cả daemon | 7 phương thức đọc + `attach({onData, onCtlReply, onGone}) → {ok, conn}` |
| **Kết nối** (`conn`) | MỘT cho mỗi trình duyệt đang xem | `close`, `type`, `paste`, `resize` |

**Vì sao hai tầng — đo được, không phải sở thích thiết kế.** Bản đang chạy dựng
phiên nhóm tmux MỘT lần (`ccrc-term.js:479-509`) nhưng dựng client `tmux -C` cho
TỪNG kết nối (`:517`, nằm ngoài khối `if`). Đó là cách hai tab trình duyệt mỗi
cái có một đường đọc/ghi riêng vào cùng phiên nhóm. Bản spec đầu gộp cả hai làm
một, và kết nối thứ hai sẽ không có ống nào — bài test có sẵn
`daemon.test.js` → `'hai client cùng gửi: không ai nuốt tin nhắn của ai'` đỏ
ngay, với tin nhắn của client A cũng biến mất (ghi vào `null.stdin` là TypeError
không ai bắt, chết cả daemon).

**Hàng đợi lời đáp thuộc tầng dưới.** Nó ghép lời đáp với lệnh bằng VỊ TRÍ trên
MỘT ống control-mode; dùng chung giữa các kết nối là hai trình duyệt ăn lời đáp
của nhau — hỏng âm thầm.

**Ánh xạ sang Windows sạch hơn bản phẳng:** nguồn = host giữ ConPTY, `attach` =
mở một pipe tới host, `conn` = cái pipe ấy. Vòng đời phiên nhóm (Windows: vòng
đời host) do chính nguồn đếm, daemon không giữ sổ sách nữa.

Cả hai bản phải trả lời đủ hai tầng. Đó là định nghĩa của "xong".

**`type` và `paste` KHÔNG gộp được thành một `write`** (phát hiện lúc lập kế
hoạch, 2026-08-17). Chúng khác nhau về bản chất, không phải về cách gọi: ứng dụng
trong pane có thể hiểu bracketed paste hoặc không, và chỉ tmux biết điều đó —
`paste-buffer -p` bọc dấu KHI VÀ CHỈ KHI ứng dụng đã xin chế độ ấy. Claude Code
không bật (`?2004h` xuất hiện 0 lần trong bản 2.1.233), zsh thì có. Gộp lại là
phải đoán hộ, và đoán sai theo hướng nào cũng có giá: bọc dấu cho Claude Code làm
cả cụm chữ bị vứt trong hộp thoại AskUserQuestion, còn gửi chữ thô nhiều dòng vào
zsh thì mỗi dòng chạy thành một lệnh. `paste` cũng mang `seq` để báo `ccrc_ack`,
thứ `type` không có.

**`onGone(cb)` phải trả về `{ fatal }`, không phải chỉ "đã mất".** `fatal:false`
= mất đường tiếp sức của một kết nối, đóng WebSocket `1011`, phiên còn sống.
`fatal:true` = phiên hết thật, `4001`. Xem §7.3 — phân biệt sai ở đây làm trình
duyệt nối lại vô hạn.

### Đợt 1 — chỉ macOS/Linux

Bản tmux của adapter **là code hiện có được gói lại**, không viết mới:

- `tmux.js` giữ nguyên gần hết — vốn đã là các hàm rời đúng hình dạng cần.
- Khối 429–955 là chỗ bị mổ: thay lời gọi tmux trực tiếp bằng lời gọi adapter.
- ~400 dòng grouped-session/marker/reclaim (`GROUP_MARKER_OPTION`,
  `isReclaimableMarker`, `claimGroupName`, `reclaimPaneSession`) **không đụng
  tới**, chui vào bản tmux nguyên vẹn.

### Hai chỗ test canh mỏng — động vào phải cẩn thận

Nêu đích danh để không lẫn vào đám đông lúc verify:

1. **Thứ tự lời đáp control-mode** — hàng đợi `choLoiDap`. Mọi lệnh phải qua
   `ctlCmd`; lọt một cái là lệch cả hàng.
2. **Thời điểm gửi mã đóng 4001 vs 1011** — xem §7.3.

Cả hai đều là chỗ dự án đã từng đau.

## 6. Host, client, giao thức

### `ccrc-host.js`

Một tiến trình cho **một phiên Claude**. Giữ ConPTY, nuôi buffer cuộn, mở named
pipe. Không mở cổng mạng.

Khởi chạy qua WMI `Win32_Process.Create` (phép đo 4). Ghi hồ sơ ra
`%LOCALAPPDATA%\ccrc\hosts\<sessionId>.json`: pid, tên pipe, secret, cwd, thời
điểm tạo.

**Vòng đời:**

- `claude.exe` thoát → host thoát. Giống tmux: phiên chỉ chạy một lệnh thì lệnh
  xong là hết, không để rác cho lần sau gắn nhầm.
- Đóng cửa sổ terminal → host **sống tiếp**; `ccrc attach` vào lại. Đây là thứ
  thiết kế này mua về.
- Host chết bất thường → hồ sơ mồ côi, dọn theo §7.2.

### `ccrc` — client mỏng

Nối vào pipe, đặt stdin raw, đẩy phím vào, vẽ byte ra stdout. Gần như không có
logic riêng — mọi trạng thái ở host. Đóng client không ảnh hưởng phiên.

### Giao thức pipe

**Dùng lại quy ước sẵn có của dự án: nhị phân = dữ liệu pane, text = điều khiển.**

Không phải tiện tay. Quy ước "khung đầu tiên là điều khiển" mà dự án từng dùng đã
làm kênh báo lỗi chết câm một thời gian dài; bài học đó đã trả giá rồi, không trả
lần nữa bằng một quy ước thứ ba.

### Kích thước màn hình khi desktop và điện thoại cùng xem

**Màn nhỏ nhất thắng** — giữ nguyên chính sách `window-size smallest` hiện tại.
Desktop hẹp lại trong lúc điện thoại xem, trả về như cũ khi điện thoại ngắt.

Dự án đã từng chọn ngược (`largest`) và hỏng trên máy thật: điện thoại nhận dòng
rộng gấp năm màn hình, xuống dòng loạn, không đọc nổi. Không lặp lại.

**HOST tính, không phải client.** Mỗi client (cửa sổ terminal, daemon web) khai
kích thước của mình khi gắn vào và mỗi lần đổi; host lấy `min` trên các client
đang gắn rồi gọi `pty.resize` một lần. Client tự resize pty là đường dẫn tới hai
client giẫm lên nhau — trên tmux thì tmux chặn hộ, ở đây không ai chặn.

### Buffer cuộn

**10.000 dòng**, bằng mặc định tmux của dự án. Nuôi bằng `@xterm/headless` — cùng
bộ xterm dự án đã dùng ở trình duyệt, nên cách diễn giải escape sequence giống
hệt hai đầu.

**HOST nuôi buffer, không phải `ccrc-term`.** Adapter Windows nằm trong
`ccrc-term` nhưng không giữ trạng thái nào — `snapshot()`, `historySize()`,
`history()` đều là câu hỏi gửi qua pipe cho host trả lời. Đây là điều kiện để
đóng cửa sổ rồi attach lại vẫn thấy nguyên lịch sử, và để daemon bật/tắt nhiều
lần không mất gì.

### Bảo mật pipe

Named pipe trên Windows **không tự động chỉ dành cho chủ máy**, và Node không cho
đặt ACL khi tạo pipe. Để trần thì một tài khoản khác trên cùng máy có thể nối vào
và gõ thẳng vào phiên Claude.

Giải: host sinh **secret ngẫu nhiên trong bộ nhớ**, ghi vào hồ sơ; client phải
gửi đúng secret ở khung đầu tiên, sai thì đóng ngay. Bảo vệ thật nằm ở **ACL của
thư mục hồ sơ**, đặt bằng `icacls` lúc cài — bịt luôn vấn đề `mode: 0o600` là
no-op trên Windows (`devices.js:87-89`, `pending-pair.js:48-58`).

**Nói thẳng:** yếu hơn quyền file POSIX trên macOS, vì dựa vào một thư mục được
đặt ACL đúng thay vì hệ điều hành ép sẵn. Đủ với mô hình tin cậy hiện tại (máy
dev của một người), nhưng là khác biệt thật giữa hai nền tảng, không phải chi
tiết vặt.

## 7. Đường hỏng

### 7.1 `/remote off` — thay thế SIGTERM

Windows không có signal thật: `process.kill(pid,'SIGTERM')`
(`ccrc-term-cli.js:680,757`) bị dịch thành `TerminateProcess`, nên `shutdown()`
(`ccrc-term.js:1114`) **không bao giờ chạy** — không gửi mã đóng 4001, không huỷ
đăng ký hub, không dọn hồ sơ. Điện thoại treo ở "đang nối lại".

Giải: daemon mở thêm **một named pipe điều khiển**, cùng cơ chế secret. `/remote
off` gửi lệnh `shutdown`; daemon chạy đúng `shutdown()` hiện có, không viết lại
đường dọn dẹp.

**Đường lùi** (chốt: thà cưỡng chế còn hơn để người dùng kẹt với daemon không tắt
nổi): pipe không trả lời trong 3 giây → `Stop-Process -Force`, rồi CLI **tự làm
phần dọn** mà daemon đáng lẽ phải làm (huỷ đăng ký hub, xoá hồ sơ). **Báo cho
người dùng biết đã phải cưỡng chế** — không im lặng.

### 7.2 Host chết bất thường

Hồ sơ thành mồ côi. Dọn theo đúng lối nghĩ `isReclaimableMarker`: **chỉ dọn cái
chứng minh được là đã chết** (pid không còn, hoặc pid còn nhưng không phải tiến
trình của mình). Pid không đọc được → từ chối dọn.

Bỏ sót hồ sơ rác thì vô hại; dọn nhầm phiên đang sống thì mất việc người dùng —
dự án đã hai lần trả giá cho hướng ngược lại.

### 7.3 Pipe đứt khi đang dùng

Phân biệt đúng hai ca, như `onCtlGone` hôm nay:

- **Pipe đứt, host còn sống** → mất đường tiếp sức của một kết nối. Đóng
  WebSocket `1011`, trình duyệt nối lại. Phiên không sao.
- **Host chết thật** → phiên hết. Đóng `4001`.

Giữ nguyên bài học: **quyết định "hỏng tạm" hay "hết phiên" phải xong TRƯỚC khi
đóng socket.** Đóng 1011 trước rồi mới gọi `shutdown()` thì 1011 thắng, 4001 vô
hiệu, trình duyệt nối lại mãi.

### 7.4 Khớp phiên cho thông báo

Hôm nay hook khớp bằng `TMUX_PANE` + socket path (đường cwd đã bị loại vì trôi
theo `cd`). Trên Windows: host set `CCRC_SESSION_ID` vào môi trường lúc spawn
`claude.exe`; hook thừa hưởng và khớp thẳng.

Sạch hơn bản macOS: không phải hỏi tmux, không có ca "pane thuộc nhiều session",
không có `#{pane_current_path}` để lỡ tay gửi lên hub.

### 7.5 Cài đặt

- **Không dùng `install.ps1` tải về chạy** — ExecutionPolicy chặn (đo được). Dùng
  `irm <hub>/install.ps1 | iex`.
- **Hook trong `settings.json` phải là `node "<path>"`** (`install-hook.mjs:92`),
  không phải đường dẫn trần — Windows không có shebang.
- **`icacls` cho `%LOCALAPPDATA%\ccrc`** ngay lúc cài, trước khi ghi secret nào.
- **Tailscale**: thêm `C:\Program Files\Tailscale\tailscale.exe` vào danh sách dò
  (`tailscale.js:12-17`).
- **Dò binary**: `command -v` (`tmux.js:29`) không tồn tại trên Windows →
  `where.exe`.
- Thư mục cài: `%LOCALAPPDATA%\ccrc` thay cho `$HOME/.local/share/ccrc`.

### 7.6 `ccrc remote` — chọn phiên từ cửa sổ khác

Vẫn có, nhưng đọc từ thư mục hồ sơ thay vì dò `ps`. Bỏ được phép đoán bằng cây
tiến trình + khớp tty (`ccrc-term-cli.js:523-599`) đã sai hai lần — trong đó có
ca bắt nhầm `claude` headless của một plugin worker.

## 8. Kiểm thử

Dự án chạy test **thật, không mô phỏng** (CI cài tmux thật, `tmux -C` thật,
daemon thật). Phần Windows theo đúng triết lý đó: **ConPTY thật, không mock
`node-pty`**.

### Ba tầng

**Tầng 1 — chạy ở mọi nơi, kể cả CI Ubuntu hiện tại.**
Buffer cuộn (nạp byte, hỏi `snapshot()`/`history()`), parse chế độ chuột (đưa
`ESC[?1006h`, hỏi `mouseMode()`), **đóng gói/phân tích khung** giao thức pipe,
quét hồ sơ mồ côi.

Chú ý ranh giới: tầng này test phần **thuần hàm** — byte vào, kết quả ra. Named
pipe thật là thứ Windows-only và thuộc tầng 2. Viết test tầng 1 mà phải dựng pipe
thật là dấu hiệu logic đã dính vào I/O và cần tách lại.

Đây là chỗ đáng đầu tư nhất: **hai thứ nguy hiểm nhất — buffer cuộn và parse
chuột — nằm trọn ở tầng này.** Sai ở đây là sai âm thầm; người dùng chỉ thấy "màn
hình lạ".

**Tầng 2 — bắt buộc Windows.** ConPTY, host, pipe, client thật: mở phiên, gõ,
đóng cửa sổ, attach lại, `/remote off`, cưỡng chế khi pipe câm, host mồ côi.

**Tầng 3 — 482 test hiện có.** Không đỏ một bài. Đây là hợp đồng với macOS/Linux.

### CI

- Job `ubuntu-latest` hiện tại **giữ nguyên không sửa** — tầng 1 và 3 chạy ở đó.
- Thêm job `windows-latest`, **chạy mọi PR** (chốt 2026-08-17).

Lưu ý chi phí: Actions miễn phí chỉ áp dụng cho **repo public**. Nhánh này đang ở
repo private, nơi phút runner Windows tính **gấp đôi** Linux.

### Trong lúc phát triển

Chạy tầng 2 qua SSH lên máy Windows: đẩy nhánh lên, `npm.cmd ci`, chạy suite, đọc
kết quả. Vòng lặp ~1 phút, không cần người dùng thao tác.

Máy Windows đã dựng sẵn (2026-08-17): OpenSSH Server bằng khoá, tường lửa giới
hạn `100.64.0.0/10`, shell mặc định PowerShell, IP Tailscale `100.101.102.103`.

### Nghiệm thu của người dùng — đúng hai lần

1. **Sau đợt refactor adapter** — trên Mac, xác nhận `/remote` không đổi gì.
2. **Khi Windows chạy được** — trên máy Windows: mở `ccrc`, `/remote on`, mở web
   trên điện thoại, gõ qua lại, cuộn lịch sử, đóng cửa sổ terminal rồi `ccrc
   attach` vào lại, `/remote off`.

### Không test được

- **Điện thoại thật** — push và cách Safari/iOS xử lý. Không đổi so với hiện tại.
- **Máy Windows khác cấu hình** — tài khoản không phải admin, ExecutionPolicy bị
  group policy khoá, Windows 10 cũ hơn. Ghi rõ trong tài liệu là **chưa kiểm**,
  không nói bừa là chạy được.

## 9. Ngoài phạm vi

- **WSL2.**
- **Claude treo nhưng host còn sống** — không phát hiện được từ ngoài, tmux hôm
  nay cũng không làm. Người dùng tự Ctrl+C.
- **Nhiều phiên Claude trong một cửa sổ** — tmux làm được nhờ pane; ConPTY một
  host một pty. Muốn hai phiên thì mở hai cửa sổ.
- **Gắn vào phiên `claude` khởi động sẵn trên Windows** — xem §4.

## 10. Quyết định đã chốt

| # | Quyết định | Ngày |
|---|---|---|
| 1 | Windows native, không WSL | 2026-08-17 |
| 2 | Phương án C — rút adapter trước, rồi mới viết bản ConPTY | 2026-08-17 |
| 3 | Thiết kế 2 — host chạy nền + client, không gắn liền cửa sổ | 2026-08-17 |
| 4 | Được mổ code macOS/Linux miễn hành vi không đổi; refactor là commit riêng | 2026-08-17 |
| 5 | `ccrc-host` tách khỏi `ccrc-term` | 2026-08-17 |
| 6 | Giao thức pipe dùng lại quy ước nhị phân/text sẵn có | 2026-08-17 |
| 7 | Màn nhỏ nhất thắng; buffer 10.000 dòng | 2026-08-17 |
| 8 | `/remote off` qua pipe, có đường lùi cưỡng chế + báo rõ | 2026-08-17 |
| 9 | CI: thêm job `windows-latest` chạy mọi PR | 2026-08-17 |
| 10 | KHÔNG nới ExecutionPolicy trên máy test | 2026-08-17 |

Quyết định 10 có lý do riêng: giữ mặc định thì mới thiết kế ra thứ chạy được trên
máy người dùng thật. Nới ra là làm ra thứ chỉ chạy trên máy đã nới rồi không biết.

## 11. Rủi ro còn lại

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Buffer cuộn tự nuôi lệch so với tmux | Cao | Tầng 1 test kỹ; dùng chung `@xterm/headless` với trình duyệt |
| Parse chế độ chuột sai → gõ rác vào shell | Cao | Tầng 1 test; mặc định an toàn là "không gửi byte chuột", như `paneMouseMode` hiện có |
| Refactor adapter làm lệch hành vi macOS | Trung bình | Commit riêng + 482 test + verify tay + revert 1 commit |
| Đóng cửa sổ Windows Terminal có giết host không | Thấp | Chưa đo (SSH thì có). Luôn khởi chạy qua WMI thì miễn nhiễm cả hai — sẽ xác nhận lúc thực thi |
| `node-pty` đổi API/bỏ prebuild ở bản sau | Thấp | Ghim phiên bản; prebuild là bằng chứng đã đo, không phải lời hứa |
