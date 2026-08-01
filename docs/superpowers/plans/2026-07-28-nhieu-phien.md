# Nhiều phiên cùng lúc — kế hoạch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Bật `/remote on` ở nhiều phiên Claude cùng lúc; PWA hiện danh sách, bấm cái nào mở cái đó.

**Spec:** `docs/superpowers/specs/2026-07-27-web-terminal-design.md` — quyết định D5c (đảo D5).

**Vì sao:** cổng cố định 8730 làm daemon thứ hai không bind được. Huy gặp thật khi chạy song song `workspace` và `cc-remote-control`.

## Global Constraints

- Node 22 ESM. Không thêm dependency. Comment **tiếng Anh**; chữ người dùng đọc **tiếng Việt**.
- Test: `npm test` ở gốc. Hiện **server 36, hook 35, term 164**. **KHÔNG** dùng `node --test test/`.
- Test không được rò phiên tmux hay tiến trình daemon — đếm bằng `ps`, không tin `tmux ls`.
- **Không** `tmux kill-server`, **không** `tailscale serve`, không đụng `~/.claude/settings.json`.
- ⚠️ **Huy đang dùng thật**: phiên tmux `test` và có thể một daemon trên cổng động. Dùng socket `-L` riêng, đừng đụng.

---

### Task 1: Daemon tự chọn cổng trống

**Files:** `term/bin/ccrc-term.js`, `term/test/daemon.test.js`, `term/test/helpers.mjs`

Cổng đang cố định 8730. Đổi: mặc định **`0`** (để OS cấp), đọc lại cổng thật bằng `server.address().port` **sau khi** `listen` thành công, rồi mới dựng URL báo lên hub. `CCRC_TERM_PORT` vẫn ghi đè được (test cần).

**Cái bẫy:** URL hiện được dựng **trước** khi `listen` chạy. Với cổng 0 thì lúc đó chưa biết cổng — phải dời việc dựng URL vào callback của `listen`, và chỉ báo hub sau đó.

Test: hai daemon cùng chạy trên hai pane khác nhau, cả hai lên được, cổng khác nhau, mỗi cái phục vụ đúng pane của mình. Mutation: đặt lại cổng cố định → test hai-daemon phải đỏ.

---

### Task 2: Hub nhớ nhiều phiên mỗi người

**Files:** `server/src/terminal-sessions.js`, `server/src/index.js`, `server/test/terminal-api.test.js`

Hiện `byUser` là `Map<userName, session>` — phiên sau **đè** phiên trước. Đổi thành nhiều phiên mỗi người, khoá theo `sessionId`.

Hợp đồng API đổi:
- `GET /api/terminal` → `{sessions: [...]}` thay cho `{session}` (mảng rỗng khi không có gì)
- `POST /api/terminal/ticket` `{sessionId}` — tra trong đúng danh sách của user đó, giữ nguyên mọi ràng buộc
- `POST /api/terminal/unregister` `{sessionId}` — xoá đúng một phiên
- Nhịp tim quá hạn: phiên nào hết nhịp thì `alive: false`, **không** xoá phiên khác

**Giữ nguyên bằng mọi giá:** người này không thấy và không xin được vé cho phiên của người kia. Test hiện có đã ghim điều đó — phải còn xanh.

---

### Task 3: Nhãn phân biệt phiên

**Files:** `term/bin/ccrc-term.js`, `server/src/terminal-sessions.js`, test tương ứng

Hai thẻ "Terminal đang mở · may-dev" thì không phân biệt được. Daemon gửi thêm `label` — **tên thư mục** của pane (`#{pane_current_path}` → basename), giống cách hệ thống thông báo lấy tên dự án từ `cwd`.

Hub lưu và trả lại nguyên văn. **Không** gửi đường dẫn đầy đủ — chỉ basename, cùng lý do với thông báo: không rò nội dung công việc.

---

### Task 4: PWA hiện danh sách

**Files:** `server/public/app.js`, `server/public/index.html`, `server/public/style.css`, `server/test/app-terminal.test.js`

Đổi từ một thẻ sang **danh sách**. Mỗi thẻ: `label · machine`, trạng thái, nút mở riêng.

Giữ nguyên mọi hành vi đã sửa hôm nay:
- `pageshow`/`visibilitychange` làm mới, gộp request (đừng bắn N lần cho N thẻ)
- `alive: false` thì **không** hiện nút mở
- Vé hỏng → làm mới danh sách rồi báo, không điều hướng vào chỗ trống
- Tên máy và nhãn đặt bằng `textContent`, không `innerHTML`

Bump `?v=` của `app.js` trong `index.html` — PWA đã cài giữ bản cũ.

---

### Task 5: `/remote off` biết tắt đúng phiên nào

**Files:** `term/bin/ccrc-term-cli.js`, `term/test/remote-cli.test.js`

Hiện chỉ có **một** file PID `~/.ccrc/term.pid`. Với nhiều daemon thì nó chỉ nhớ được cái cuối.

Đổi sang một file mỗi pane: `~/.ccrc/term-pane-<paneId>.pid`. CLI chạy trong pane nào thì thao tác lên đúng daemon của pane đó.

- `/remote on` trong pane đã có daemon → báo đã bật, không mở thêm
- `/remote off` → chỉ tắt daemon của pane hiện tại, **không** đụng phiên khác
- `/remote` không tham số → liệt kê **mọi** phiên đang mở của user (từ hub), đánh dấu cái nào là pane hiện tại

**Giữ nguyên:** phép nhận diện tiến trình theo `@ccrc_group`/argv đã sửa — không được quay lại đoán theo tên hay theo PID trần.

---

### Task 6: Nghiệm thu

Chạy thật hai phiên tmux, mỗi phiên một Claude Code, `/remote on` cả hai. Kiểm:

| Kiểm | Kỳ vọng |
|---|---|
| Hai daemon cùng sống | Hai cổng khác nhau |
| PWA | Hai thẻ, nhãn khác nhau theo tên thư mục |
| Mở thẻ 1 | Vào đúng pane 1 |
| Mở thẻ 2 | Vào đúng pane 2 |
| `/remote off` ở phiên 1 | Chỉ thẻ 1 biến mất, phiên 2 nguyên vẹn |
| Phiên nhóm | Mỗi phiên một nhóm riêng, không đụng nhau |
| Không rò | Đếm `ps` trước/sau |
