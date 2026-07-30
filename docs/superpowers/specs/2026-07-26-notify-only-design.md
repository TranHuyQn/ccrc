# Thiết kế: chỉ gửi thông báo

- **Ngày:** 2026-07-26
- **Trạng thái:** đã chốt với Huy, chưa triển khai
- **Nhánh:** `claude/notify-only`
- **Thay thế:** toàn bộ hướng điều khiển từ xa trước đó (GĐ1 thanh trạng thái, GĐ2 cây subagent, bridge/tmux, banner câu hỏi)

## 1. Vấn đề với hướng cũ

Hệ thống cũ cố mirror và điều khiển phiên Claude Code từ điện thoại. Một ngày làm việc
cho thấy phần lớn độ phức tạp và gần như toàn bộ lỗi đến từ **bridge** — lớp chèn phím vào
tmux để điều khiển terminal đang sống:

- `tmux` không có trong PATH tối giản của launchd → bridge âm thầm tụt về watch
- `tmux display-message` trả exit 0 cho pane đã chết → mọi pane chết bị coi là sống
- Bridge chết tích luỹ mỗi lần đăng ký lại → event gửi tới hub session đã chết
- Transcript chỉ hiện thực hoá câu hỏi **sau khi** đã trả lời (đo được trễ 187 giây)
- Trả lời câu hỏi từ web phải gõ phím vào TUI, phụ thuộc layout, cần khoá chống bấm nhầm
  hộp xin quyền

Huy đặt câu hỏi đúng: nếu 2 chiều phức tạp vậy, 1 chiều có đủ không. Đo ra: **đủ, trừ việc
bấm chọn**. Và rồi kết luận xa hơn — ngay cả việc xem cũng không cần thiết.

**Yêu cầu mới, do Huy phát biểu:** khi Claude Code dừng lại chờ người dùng, hoặc khi xong
việc, gửi thông báo đẩy. Người dùng nhận thông báo rồi tự ra máy tính, hoặc SSH vào dùng
tmux. Hệ thống chỉ gửi thông báo.

## 2. Sự thật đã đo — nền của thiết kế

Đọc từ 8.868 payload hook thật trên máy Huy (`~/.config/token_slayer/captured_outgoing.jsonl`):

| Sự kiện | Số lần | Kết luận |
|---|---|---|
| `SubagentStop` | 781 | **Không được báo** — gấp 4 lần `Stop`, báo là rung liên tục |
| `Stop` | 189 | Lượt kết thúc, nhưng ≠ đang chờ người |
| `Notification/idle_prompt` | 131 | "Claude is waiting for your input" |
| `Notification/permission_prompt` | 70 | "Claude needs your permission" |
| `SessionEnd` | 6 | Quá hiếm, không đáng làm |

**`Stop` (189) không trùng `idle_prompt` (131)** — có ~58 lần lượt kết thúc mà Claude tự đi
tiếp chứ không chờ ai. Nên "xong việc" và "đang chờ" là hai thứ khác nhau; chỉ cái sau mới
đáng gọi người.

**`AskUserQuestion` phát `Notification` trong lúc đang chờ: 63/65 lần, và loại là
`permission_prompt`** (không phải `idle_prompt`). Nghĩa là Claude Code coi câu hỏi cũng là
"cần người xác nhận". Tình huống khởi nguồn — Claude hỏi mà điện thoại im — nằm trọn trong
phạm vi hai loại đã chọn, không cần xử lý riêng.

**Payload `Notification` mang đủ thứ cần dùng: 208/208 có `cwd`, `session_id` và
`message`.** Nên tên dự án lấy thẳng từ `cwd`, không phải suy ra từ nguồn khác.

**Ràng buộc nền tảng:** Web Push trên iOS chỉ hoạt động với **PWA đã cài vào màn hình
chính**. Không có cách gửi thông báo tới iPhone mà không có một web app. Nên hub không biến
mất được — nhưng teo lại rất nhiều.

## 3. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| D1 | Cắt trụi web UI: chỉ còn trang cài PWA, bật thông báo, xem lịch sử thông báo | Huy |
| D2 | Chỉ báo `idle_prompt` + `permission_prompt`. Không báo `Stop`, `SubagentStop`, `SessionEnd` | Huy |
| D3 | Kiến trúc A: hook gọi thẳng hub, **xoá hẳn agent daemon** | Huy |
| D4 | Có công tắc `/notify on\|off`, trạng thái ở file local | Huy |
| D5 | **Mặc định TẮT** | Huy |
| D6 | Thay thẳng hub production; Kiên cũng chỉ còn thông báo | Huy |
| D7 | Xoá cả code lẫn tài liệu của hướng cũ | Huy |

## 4. Kiến trúc

```
Claude Code
   │ hook Notification  (idle_prompt | permission_prompt)
   ▼
agent/bin/ccrc-notify.js         ← script hook duy nhất
   │ ① đọc ~/.ccrc/notify — TẮT thì dừng, KHÔNG có gì rời khỏi máy
   │ ② dựng payload gọn
   │ ③ HTTPS POST /notify kèm token cá nhân, timeout ngắn, LUÔN exit 0
   ▼
hub
   ├─ xác thực token → biết báo cho ai
   ├─ Web Push (VAPID) ──────────► điện thoại
   └─ lưu 50 thông báo gần nhất mỗi người cho PWA xem lại
```

Ba mảnh: script hook, hub, PWA tối thiểu. Không WebSocket, không phiên, không agent daemon.

### 4.1 Công tắc — và vì sao nó nằm ở local

`/notify on` · `/notify off` · `/notify` (trạng thái)

Trạng thái ở `~/.ccrc/notify`, **mặc định TẮT**. Hook đọc file này **trước mọi việc khác**,
nên lúc tắt không một byte nào rời khỏi máy. Vừa nhanh vừa riêng tư — khác hẳn phương án
gửi lên rồi để hub lọc.

Kiểu hỏng của "mặc định TẮT" là kiểu đúng: quên bật thì không nhận được thông báo, nhưng
lúc đó đang ngồi trước máy nên nhìn thấy ngay. Ngược lại, quên tắt thì điện thoại rung
trong lúc người dùng ngồi ngay đó — phiền mà vô ích.

### 4.2 Nội dung thông báo

```
🔔 dev · cc-remote-control        ← idle_prompt
Claude đang chờ bạn nhập

🔐 dev · demo-app-sdk            ← permission_prompt
Claude cần bạn xác nhận
```

Tên máy + thư mục (từ `cwd` trong payload hook) để phân biệt khi chạy nhiều dự án.
**Không kèm nội dung công việc** — tránh rò rỉ, và người dùng sắp mở máy xem tận nơi rồi.

Câu chữ cho `permission_prompt` cố tình là **"cần bạn xác nhận"** chứ không phải "duyệt
quyền": theo dữ liệu đo, loại này bao gồm cả câu hỏi `AskUserQuestion`, nên nói "duyệt
quyền" sẽ sai gần một nửa số lần.

### 4.3 Cấu hình và xác thực

Hai file, tách riêng có chủ đích:

| File | Nội dung | Vì sao tách |
|---|---|---|
| `~/.ccrc/config` | `CCRC_HUB_URL=` và `CCRC_TOKEN=` (token cá nhân), chmod 600 | Đọc mỗi lần bắn, hiếm khi đổi |
| `~/.ccrc/notify` | đúng một từ: `on` hoặc `off` | `/notify` ghi liên tục; một từ thì đọc/ghi nguyên tử, không cần parse, hỏng cũng không kéo theo cấu hình |

Token cá nhân xác định *báo cho ai*. Không còn token agent/admin — không còn agent.

**File `notify` thiếu hoặc nội dung lạ ⇒ coi như `off`.** Mặc định phải là im lặng, kể cả
khi cấu hình hỏng.

## 5. Chịu lỗi

Hook **luôn `exit 0`** ở mọi nhánh: mất mạng, hub sập, token sai, file cấu hình hỏng.
Claude Code không bao giờ bị ảnh hưởng. Đổi lại, thông báo đó mất luôn — chấp nhận được,
vì một thông báo "Claude đang chờ" gửi lại sau 5 phút gần như vô dụng.

**Vấn đề thật là hỏng im lặng.** Người dùng ngồi chờ một thông báo không bao giờ tới mà
không biết vì sao. Nên `/notify` (không tham số) **không chỉ đọc file local** — nó gọi thật
lên hub và báo kết quả từng lớp:

```
Thông báo: ĐANG BẬT
Hub: ccrc.example.com — OK (142ms)
Token: hợp lệ, sẽ báo cho huy
Push: điện thoại đã đăng ký (2 thiết bị)
```

Đây là chỗ **duy nhất** phát hiện được hỏng hóc, nên nó phải kiểm thật từng lớp chứ không
suy đoán từ file cấu hình.

## 6. Test

- **Hàm thuần** `buildNotification(payload)`: loại nào → tiêu đề, thân, biểu tượng nào;
  thiếu trường thì không ném. Test bằng hình dạng payload thật đã đo.
- **Script hook** chạy thật với HTTP server giả: mọi nhánh `exit 0`; **tắt thì không gửi
  gì** (server giả không nhận được request nào); thiếu token; hub trả 401/500; hub treo.
- **Hub** `POST /notify`: token đúng/sai/thiếu; payload dị dạng không làm sập tiến trình.
- Dùng lại khuôn test đã hoạt động tốt trong ngày (`node --test`, không thêm dependency).

## 7. Chuyển đổi

- **Hub production thay thẳng.** Kiên cũng chỉ còn thông báo; Huy tự báo anh ấy.
- **Xoá cả code lẫn tài liệu** của hướng cũ: `agent/src/index.js`, `hook-events.js`,
  `tui-answer.js`, `ccrc-hook*.js`, `ccrc-claude`, `ccrc-remote.js`, phần lớn
  `server/src/index.js`, `server/public/{app,activity}.js`, spec và plan của GĐ1/GĐ2.
  Git history vẫn giữ tất cả nếu cần đào lại.
- **PWA trên điện thoại giữ nguyên** — hướng mới vẫn cần đúng nó để nhận push.
  ⚠️ PWA đã cài giữ `index.html` cũ; phải gỡ khỏi màn hình chính rồi cài lại, vì bump
  `?v=` chỉ cứu được asset chứ không cứu `index.html`.
- **Máy local đã dọn sạch** bằng `remove-agent.sh` trước khi bắt đầu.

## 8. Điểm chưa kiểm chứng

1. **`Notification` khi máy ngủ hoặc mất mạng.** Hook chạy đồng bộ với Claude Code nên về
   nguyên tắc vẫn bắn, nhưng POST sẽ hỏng và thông báo mất. Chưa đo tần suất thực tế.
2. **Trần 50 thông báo mỗi người** là con số chọn theo cảm tính, chưa đo xem người dùng
   thực sự cuộn lại bao xa. Dễ đổi, không ảnh hưởng kiến trúc.

## 9. Cố ý KHÔNG làm

Ghi lại để lần sau không ai tưởng là bỏ sót:

- **Không** báo `Stop`, `SubagentStop`, `SessionEnd` — xem §2 để biết vì sao.
- **Không** gửi nội dung công việc trong thông báo.
- **Không** có hàng đợi gửi lại khi mất mạng.
- **Không** điều khiển gì từ điện thoại: không chat, không duyệt quyền, không chọn đáp án.
  Người dùng ra máy hoặc SSH + tmux, đúng như yêu cầu.
