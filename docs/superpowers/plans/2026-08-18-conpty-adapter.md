# Kế hoạch E (đợt 2/5): adapter ConPTY — điện thoại vào được

> **Cho người thực thi:** BẮT BUỘC dùng skill `superpowers:subagent-driven-development`.

**Mục tiêu:** cho `/remote on` chạy trên Windows, để điện thoại mở web terminal
và điều khiển phiên Claude Code — đúng như trên macOS.

**Spec:** [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md) §5–6

## Quyết định kiến trúc: adapter tự soi gương, KHÔNG hỏi host

Interface adapter là **đồng bộ**: `snapshot()` trả thẳng chuỗi, `historySize()`
trả thẳng số. Qua pipe thì mọi câu hỏi đều bất đồng bộ — và đổi interface thành
async nghĩa là sửa `ccrc-term.js`, tức đụng vào macOS. Không chấp nhận được.

**Nên adapter tự nuôi bản sao màn hình của riêng nó**, bằng chính
`createScreenBuffer` và `createMouseMode` của kế hoạch B, nạp từ luồng byte mà
nó vốn đã nhận qua pipe. Khi đó:

| Phương thức | Trên tmux | Trên ConPTY |
|---|---|---|
| `snapshot()` | hỏi tmux | đọc buffer **cục bộ** — đồng bộ |
| `historySize()` / `history()` | hỏi tmux | đọc buffer **cục bộ** — đồng bộ |
| `mouseMode()` | hỏi tmux | đọc parser **cục bộ** — đồng bộ |
| `type()` / `paste()` / `resize()` | lệnh tmux | khung ra pipe |

**Hệ quả, đều tốt:**
- Host **không cần thêm một lệnh nào** — đó chính là lý do người viết host cố ý
  không bịa `snapshot`/`history`/`mouseMode`; bên tiêu thụ là đây.
- `ccrc-term.js` không đổi một dòng → macOS an toàn theo cấu trúc.
- Không có vòng hỏi-đáp nào trên đường cuộn — nhanh hơn hỏi host.

**Giá phải trả, chấp nhận:** buffer bị giữ hai nơi (host và daemon), mỗi nơi
10.000 dòng. Và adapter chỉ thấy từ lúc nó gắn vào — nhưng host **gửi ảnh chụp
màn hình ngay khi gắn**, nên bản sao được mồi đúng trạng thái hiện tại.

## Ràng buộc toàn cục

- **Không đổi hành vi macOS/Linux.** Huy nhấn mạnh ba lần. `term/src/pane-source.js`
  và `term/bin/ccrc-term.js` **không được sửa** trừ đúng một chỗ: điểm rẽ nhánh
  chọn adapter theo nền tảng. Mọi bài test cũ phải xanh, không sửa bài nào.
- Không thêm dependency.
- Định danh theo phong cách file xung quanh; comment tiếng Việt giải thích *vì sao*.
- Commit tiếng Anh + trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Windows: `ssh dev@100.101.102.103`. **Máy đã được dọn sạch** — không còn
  `ccrc-src` hay `~/.ccrc`. Clone lại bằng `git bundle` + `scp` + `git fetch`
  (dùng `git bundle create f HEAD ^<base>`; hai hash trần sẽ báo "empty bundle").
  **Xoá bundle khi xong.**
- **Trước VÀ sau mỗi lần chạy trên Windows**, ghi
  `(Get-Item "$env:USERPROFILE\.claude\settings.json").LastWriteTime` và
  `Get-ChildItem -Force "$env:USERPROFILE\.ccrc"` nguyên văn vào báo cáo.
- Tiến trình node `9232` là của Huy — không bao giờ giết.
- **KHÔNG chạy Claude Code thật trong test** — nó ghi vào `~/.claude` của Huy.
  Dùng `cmd.exe`. Bẫy đã cắn một lần: `{ ...process.env, PATH: x }` trên Windows
  **không đè được** `Path` cũ, nên test tưởng chạy binary giả mà chạy binary
  thật. Lọc khoá không phân biệt hoa thường, và đặt cửa kiểm dừng hẳn nếu
  `where.exe` không trả về bản giả.
- `npm test` **không chạy trọn được** trên Windows. Chạy đích danh từng file và
  **nói rõ file nào** trong báo cáo — "xanh trên Windows" không được nghe như
  "cả bộ test đã pass".

---

### Task 1: adapter ConPTY

**Files:**
- Create: `term/src/pane-source-conpty.js`
- Create: `term/test/pane-source-conpty.test.js` (skip ngoài Windows)

**Interfaces:** `createConptyPaneSource({ sessionId, home })` trả về object
**cùng hình dạng** `createTmuxPaneSource` — đây là hợp đồng, không phải gợi ý:

- đọc, đồng bộ: `alive()`, `snapshot()`, `historySize()`, `history(offset, rows)`,
  `mouseMode()`, `cwd()`, `socket()`
- `attach({ onData, onCtlReply, onGone })` → `{ ok: true, conn } | { ok: false, message }`
- trên `conn`: `close()`, `type(bytes)`, `paste(text, {onAck, onErr})`, `resize(cols, rows)`

**Cách làm:**
- `alive()` = hồ sơ host còn và pid còn sống (`readHost` + `process.kill(pid,0)`).
- `cwd()` / `socket()` = đọc từ hồ sơ host (`cwd`, `pipe`).
- `attach()` nối pipe, gửi bí mật, rồi **mỗi khung PANE nhận được vừa đẩy sang
  `onData` vừa nạp vào screen-buffer và mouse-mode cục bộ.**
- `type()` = khung PANE ra pipe. `resize()` = khung CONTROL `resize`.
- **`paste()` phải gọi `onAck` chỉ sau khi byte thật sự đã đi.** Trên tmux, ack
  đến từ lời đáp của tmux. Ở đây không có lời đáp — dùng callback của
  `socket.write`, tức "hệ điều hành đã nhận". Yếu hơn tmux, và **phải ghi rõ
  trong comment** là yếu hơn: ô soạn của người dùng sẽ trống đi sớm hơn một
  nhịp so với macOS. Đừng giả vờ hai bên tương đương.
- `onGone({ fatal })`: pipe đứt mà hồ sơ host còn + pid còn sống → `fatal:false`
  (mất đường tiếp sức, trình duyệt nối lại). Hồ sơ mất hoặc pid chết →
  `fatal:true`. **Quyết định phải xong TRƯỚC khi đóng socket** — sai thứ tự là
  trình duyệt nối lại vô hạn, dự án đã ship lỗi đó một lần.

**Test tối thiểu** (dựng host thật chạy `cmd.exe`, như `ccrc-host.test.js` làm):
1. `attach()` xong thì `snapshot()` trả về màn hình có chữ — bản sao được mồi.
2. `type()` gõ chữ → chữ xuất hiện trong `snapshot()` cục bộ.
3. In nhiều dòng → `historySize()` tăng; `history(offset, rows)` trả đúng số dòng.
4. `mouseMode()` mặc định `{mouse:false,sgr:false}`; sau khi ứng dụng gửi
   `ESC[?1000h` thì thành `true`.
5. Host chết → `onGone({fatal:true})`.
6. `close()` không giết host; host phục vụ được client mới.

- [ ] Bước 1: viết test đỏ → 2: xác nhận đỏ trên Windows, skip sạch macOS →
      3: viết module → 4: xanh trên Windows → 5: `npm test` macOS không đỏ →
      6: commit.

---

### Task 2: rẽ nhánh trong daemon

**Files:**
- Modify: `term/bin/ccrc-term.js` — **đúng một chỗ**: nơi tạo nguồn pane
- Create: `term/test/pane-source-chon.test.js`

Chỗ rẽ duy nhất:

```js
const paneChung = process.platform === 'win32'
  ? createConptyPaneSource({ sessionId: PANE })
  : createTmuxPaneSource({ pane: PANE, runId: RUN_ID });
```

`CCRC_TERM_PANE` trên Windows mang **sessionId của host**, không phải pane id.

**Test:** trên macOS phải chọn bản tmux; trên Windows phải chọn bản ConPTY.
Viết sao cho chạy được ở cả hai nền tảng (kiểm hàm chọn, không kiểm daemon).

**Cảnh báo:** đây là lần đầu `ccrc-term.js` bị sửa kể từ đợt 1. Bài test canh
ranh giới (`pane-source-boundary.test.js`) đang cấm nó nhắc tên lệnh tmux —
thêm `process.platform` **không** vi phạm, nhưng chạy lại bài đó để chắc.

- [ ] Bước 1–6 như trên. Bắt buộc chạy `pane-source-boundary.test.js`.

---

### Task 3: `/remote on` trên Windows

**Files:** Modify `term/bin/ccrc-term-cli.js`; Create `term/test/remote-win.test.js`

`ccrc-term-cli.js` hiện đòi `TMUX_PANE`. Trên Windows nó phải lấy sessionId từ
hồ sơ host — người dùng đang ngồi trong một phiên `ccrc`, và biến môi trường
`CCRC_HOST_SESSION_ID` do host đặt khi spawn Claude.

- `on`: lấy sessionId từ env; không có → báo "chạy `ccrc` trước" và thoát khác 0.
- `off`: **`--pane` bị bỏ qua** trên đường hiện tại — lỗi có thật đã ghi trong
  trí nhớ, đã tắt nhầm phiên một lần. Trên Windows phải nhận diện theo
  sessionId, và nếu người dùng truyền cờ không được hỗ trợ thì **báo lỗi**,
  không im lặng làm việc khác.

- [ ] Bước 1–6 như trên.

## Định nghĩa "xong"

- [ ] `npm test` macOS xanh, không sửa bài cũ nào
- [ ] Trên Windows: `ccrc` → `/remote on` → mở web trên điện thoại → thấy màn
      hình, gõ được, cuộn được, `/remote off` không nối lại vô hạn
- [ ] Hồ sơ thật trên Windows không bị đụng
