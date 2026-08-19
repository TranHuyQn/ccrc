# Kế hoạch D (đợt 2/4): client mỏng + khởi chạy sống sót

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`.

**Mục tiêu:** gõ `ccrc` trên Windows là có Claude Code chạy trong ConPTY, và đóng
cửa sổ terminal không giết phiên. Đây là bước làm cho hai kế hoạch trước thành
một thứ dùng được.

**Spec:** [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md) §6

## Ràng buộc toàn cục

- **Không đổi hành vi trên macOS/Linux.** Huy nhấn mạnh ba lần. Bộ test hiện có
  phải xanh, **không sửa một bài cũ nào**. Mọi thứ trong kế hoạch này là code
  chỉ Windows; test tự bỏ qua ở nơi khác.
- Không thêm dependency nào — `node-pty` đã có từ kế hoạch C.
- **Định danh tiếng Anh, comment tiếng Việt.**
- Commit tiếng Anh, kết thúc bằng `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Máy Windows: `ssh dev@100.101.102.103`, repo `C:\Users\dev\ccrc-src`,
  PowerShell mặc định, dùng `npm.cmd` không phải `npm`. Đưa nhánh lên bằng
  `git bundle` + `scp` + `git fetch`; **xoá file bundle sau khi xong**.
- **Trước VÀ sau mỗi lần chạy trên Windows**, ghi lại
  `(Get-Item "$env:USERPROFILE\.claude\settings.json").LastWriteTime` và
  `Get-ChildItem -Force "$env:USERPROFILE\.ccrc"`, nguyên văn, vào báo cáo.
- Tiến trình node `9232` là của Huy — không bao giờ giết. Giết mọi tiến trình
  test mình tạo.

## Bảy điều đã ĐO, đừng đo lại

| Câu hỏi | Kết quả |
|---|---|
| `pty.spawn('cmd.exe', …)` — tên có đuôi | ✓ chạy |
| **`pty.spawn('cmd', …)` — tên KHÔNG đuôi** | ✗ **ném `File not found`** — pty KHÔNG dò PATHEXT |
| `pty.spawn('<đường dẫn>.cmd')` gọi thẳng | ✓ chạy — **không cần** bọc `cmd.exe /c` |
| Lệnh không tồn tại | ✗ ném ngay, thông báo rõ, bắt được |
| `claude` trên máy Huy | `C:\Users\dev\.local\bin\claude.exe` (Application) |
| `spawn(detached)` sống qua phiên đóng | ✗ — Job Object của phiên giết cả cây |
| WMI `Win32_Process.Create` | ✓ sống qua phiên đóng |

**Hệ quả thiết kế, và nó bác một giả định cũ:** phải phân giải đường dẫn đầy đủ
trước khi spawn. Giả định "phải bọc `cmd.exe /c` cho bản cài npm" — mang từ kế
hoạch C sang — **là sai**: `.cmd` chạy thẳng được. Đừng thêm lớp bọc đó.

---

### Task 1: phân giải lệnh + khởi chạy sống sót

**Files:**
- Create: `term/src/win-launch.js`
- Create: `term/test/win-launch.test.js` (tự skip ngoài Windows)

**Interfaces:**
- `resolveCommand(name): string` — trả đường dẫn đầy đủ, hoặc ném lỗi có câu
  tiếng Việt nói rõ phải làm gì. Dùng `where.exe`, lấy dòng đầu.
- `launchSurviving({ command, args, cwd, env }): number` — khởi chạy qua WMI
  `Win32_Process.Create`, trả pid. Ném nếu `ReturnValue !== 0`.

**Vì sao không dùng `spawn(detached)`:** đo được — Windows nhốt phiên vào Job
Object và Node không có cờ breakaway, nên tiến trình chết theo phiên. Triệu
chứng đánh lừa: nó chết **trước cả dòng lệnh đầu tiên**, nên log không được tạo
và stderr rỗng — trông y hệt "script crash lúc nạp".

- [ ] **Bước 1: Viết test đỏ** — `term/test/win-launch.test.js`, mọi bài
  `{ skip: process.platform !== 'win32' }`. Phải phủ:
  1. `resolveCommand('cmd')` trả đường dẫn tuyệt đối, tận cùng `.exe`.
  2. `resolveCommand('khong-co-lenh-nay-dau')` **ném**, và thông điệp có nhắc
     tên lệnh — người dùng phải biết thiếu cái gì.
  3. `launchSurviving` chạy được một lệnh ghi ra file, trả pid > 0, và file
     xuất hiện (chờ theo điều kiện + hạn chót, không `sleep` cố định).
  4. **Tiến trình khởi chạy như vậy KHÔNG phải con của tiến trình test** —
     đọc `ParentProcessId` qua CIM và khẳng định nó khác `process.pid`. Đây
     chính là tính chất làm nó sống sót, nên phải khẳng định thẳng.
  5. Lệnh không tồn tại → ném, không trả pid rác.

- [ ] **Bước 2: Chạy test trên Windows, xác nhận đỏ.** Trên macOS: skip sạch.

- [ ] **Bước 3: Viết `term/src/win-launch.js`.** Đặc tả ở trên là hợp đồng.
  Ba điều bắt buộc:
  - `where.exe` trả **nhiều dòng** khi có nhiều bản; lấy dòng đầu, cắt khoảng trắng.
  - Escape dấu nháy trong dòng lệnh WMI — `Win32_Process.Create` nhận MỘT chuỗi.
  - `ReturnValue` khác 0 phải ném kèm con số; nuốt nó là để người dùng nhìn một
    tiến trình không bao giờ khởi động mà không có lời giải thích.

- [ ] **Bước 4: xanh trên Windows, skip sạch trên macOS.**

- [ ] **Bước 5: `npm test` trên macOS** — không bài cũ nào đỏ.

- [ ] **Bước 6: Commit.**

---

### Task 2: client mỏng

**Files:**
- Create: `term/bin/ccrc-client.js`
- Create: `term/test/ccrc-client.test.js` (tự skip ngoài Windows)

**Hành vi bắt buộc:**

1. Đọc hồ sơ host bằng `readHost(sessionId)`; không có thì báo rõ và thoát khác 0.
2. Nối vào pipe, gửi bí mật ở khung điều khiển đầu tiên.
3. `process.stdin` **raw mode**, mọi byte gõ vào đi ra khung `FRAME.PANE`.
4. Khung `FRAME.PANE` nhận về ghi thẳng ra `process.stdout`.
5. **Khai kích thước lúc nối và mỗi lần `process.stdout` đổi kích thước.**
   Host tính `min`; client chỉ khai, không tự quyết.
6. Pipe đóng → khôi phục stdin, thoát mã 0. **Không** giết host.
7. Ctrl+C **không** được giết client — nó là một byte gõ vào terminal, phải đi
   tới Claude. Đây là khác biệt dễ sai nhất so với một CLI thường.

**Chỗ dễ sai:** raw mode phải được khôi phục trên **mọi** đường thoát, kể cả khi
ném. Terminal bị bỏ lại ở raw mode là người dùng phải đóng cửa sổ.

- [ ] **Bước 1: Viết test đỏ.** Dựng host thật (như `ccrc-host.test.js` làm),
  chạy client như tiến trình con với stdin/stdout là pipe, rồi khẳng định:
  1. Gõ `echo MOC-CLIENT\r` vào stdin của client → chữ hiện ra ở stdout.
  2. Bí mật sai → client thoát khác 0, không treo.
  3. Host chết → client thoát mã 0 trong hạn.
  4. Không có hồ sơ → thoát khác 0 kèm câu nói rõ.

- [ ] **Bước 2–6:** đỏ → viết → xanh → `npm test` macOS → commit.

---

### Task 3: lệnh `ccrc` trên Windows

**Files:**
- Create: `deploy/ccrc.cmd`
- Create: `term/bin/ccrc-win.js`
- Create: `term/test/ccrc-win.test.js`

`ccrc.cmd` chỉ là vỏ gọi `node ccrc-win.js %*`. Toàn bộ quyết định nằm trong JS.

**Hành vi:**

1. **Quét dọn hồ sơ mồ côi trước tiên** bằng `listHosts()`. Giết host theo pid
   trên Windows là `TerminateProcess` nên `stop()` không chạy và hồ sơ ở lại —
   đo được ở kế hoạch C. Không quét thì rác tích mãi.
2. Không tham số → sinh `sessionId`, phân giải `claude` bằng `resolveCommand`,
   khởi chạy `ccrc-host.js` bằng `launchSurviving` với env mang
   `CCRC_HOST_SESSION_ID`/`CCRC_HOST_COMMAND`/`CCRC_HOST_CWD`, chờ hồ sơ xuất
   hiện (điều kiện + hạn chót), rồi `exec` client.
3. `ccrc attach <id>` → nối vào host đang chạy.
4. `ccrc list` → in các host còn sống từ `listHosts()`.
5. **Host phải được khởi chạy với stdio không nối vào đâu cả.** Nó `console.log`
   vài dòng; nếu stdout nối vào một pipe không ai đọc, host sẽ nghẽn khi bộ đệm
   đầy — nêu ở kế hoạch C.

- [ ] **Bước 1: Viết test đỏ** — `ccrc list` trên một `CCRC_HOME` sạch in ra
  rỗng và thoát 0; sau khi dựng một host giả thì in ra đúng nó; hồ sơ trỏ pid
  chết thì bị quét đi.
- [ ] **Bước 2–6:** đỏ → viết → xanh → `npm test` macOS → commit.

---

## Định nghĩa "xong" của kế hoạch D

- [ ] `npm test` trên macOS xanh, không sửa một bài cũ nào
- [ ] Ba file test mới đều **skip sạch** trên macOS, xanh trên Windows
- [ ] Hồ sơ thật trên Windows không bị đụng — chứng minh bằng mốc thời gian
- [ ] Trên Windows: gõ `ccrc` ra Claude Code thật trong ConPTY; đóng cửa sổ rồi
      `ccrc attach <id>` vào lại thấy nguyên phiên
