# Thiết kế: terminal trên web, nối vào phiên tmux đang chạy Claude Code

- **Ngày:** 2026-07-27
- **Trạng thái:** đã chốt với Huy, chưa triển khai
- **Xây trên:** hệ thống thông báo đã chạy (`docs/superpowers/specs/2026-07-26-notify-only-design.md`)
- **Không thay thế gì** — thông báo giữ nguyên, terminal là lớp bổ sung

## 1. Vấn đề

Hệ thống thông báo đã giải quyết việc *biết* Claude Code đang chờ. Nhưng biết rồi thì
vẫn phải ra máy tính. Yêu cầu mới: từ điện thoại, **trả lời được** Claude.

Đây là lần thứ hai dự án chạm vào bài toán này. Lần đầu (hướng remote-control, đã xoá)
thất bại vì đọc transcript rồi đoán layout màn hình để chèn phím — nguồn dữ liệu sai,
mọi tầng bên trên đều phải suy diễn. Lần này khác về bản chất: **PTY thật**. tmux tự vẽ
giao diện của nó, không ai phải parse gì. Toàn bộ họ lỗi cũ không áp dụng.

## 2. Sự thật đã đo — nền của thiết kế

**Trên máy Huy, 2026-07-27:**

| Đo | Kết quả | Hệ quả |
|---|---|---|
| `tmux ls` | không có server nào | Claude Code hiện KHÔNG chạy trong tmux → điều kiện tiên quyết chưa có |
| `Tailscale.app` | đã cài, v1.98.8, **đang dừng** | **Là đường vào của thiết kế này** (D2). Phải bật trước khi dùng |
| `tailscale status --json` | `Self.TailscaleIPs` = `100.86.78.80`, `BackendState`, `Self.DNSName` | IP là đường vào; `BackendState` là điều kiện tiên quyết kiểm được (§4.4) |
| `tailscale cert <tên máy>` | `500: your Tailscale account does not support getting TLS certs` | Tailnet chưa bật HTTPS Certificates. Huy **từ chối bật** (D2c) ⇒ mọi phương án cần chứng chỉ bị loại |
| Tailnet | 10 máy, suffix `tailnet-example.ts.net`, cấu hình serve = `{}` | Bật chứng chỉ sẽ đưa tên máy vào CT log **vĩnh viễn** — đó là lý do D2c |
| `pmset -g` | `standby 1`, `powernap 1`, `sleep 0` (do caffeinate/Chrome giữ) | Máy đang thức nhờ ăn may; ngủ là mất kết nối |
| `tmux -V` | 3.7b | Có `new-session -t` (session group) |

**Hỗ trợ trình duyệt cho bàn phím ảo** (caniuse, MDN):

| API | iOS Safari | Chrome Android | Samsung Internet | Firefox |
|---|---|---|---|---|
| VirtualKeyboard API | **Không, mọi bản đến 26.5** | Có (150+) | Có (17.0+) | Không |
| VisualViewport API | Có | Có | Có | Có |

⇒ Bắt buộc hai nhánh code, feature-detect. Viết một đường là hỏng một nền tảng.

**Lỗi bàn phím di động đã được ghi nhận trong xterm.js:**

| Vấn đề | Nguồn |
|---|---|
| Safari iOS + bàn phím cứng: Ctrl-C trả về keyCode 13 (= Enter) | xterm.js #5721 |
| Không có xử lý sự kiện chạm | xterm.js #5377 |
| Copy/paste không chạy trên thiết bị cảm ứng | xterm.js #3727 |
| Bàn phím đoán chữ làm phím xoá loạn, ký tự trễ nhịp | xterm.js #2403, #273 |
| Web terminal chuyên dụng vẫn vấp: iOS Chrome không gõ được cho tới khi bấm tay | VibeTunnel #491 (đã sửa bằng PR #660) |

Bài học rút ra và dùng làm nguyên tắc thiết kế: **đừng để terminal nhận phím trực tiếp
trên di động.** Xem §5.

**Từ dữ liệu hook đã đo hôm 2026-07-26** (8.868 payload thật): `SessionEnd` chỉ bắn
**6 lần**. Quá hiếm để làm trụ chính cho việc đóng phiên — chỉ dùng làm tín hiệu phụ.

## 3. Quyết định đã chốt

| # | Quyết định | Ai chốt |
|---|---|---|
| D1 | Tự viết, nhúng vào hub và PWA sẵn có (không dùng VibeTunnel/ttyd) | Huy |
| D2 | Terminal chạy trên máy dev, daemon **nghe thẳng trên IP Tailscale**. **Không** `tailscale serve`, **không** xin chứng chỉ TLS, **không** Cloudflare Tunnel. Hub không chuyển tiếp byte shell | Huy |
| D2c | **Không được để lộ bất cứ thứ gì ra ngoài tailnet** — kể cả tên máy trong Certificate Transparency log. Đây là ràng buộc cứng, mọi phương án cần chứng chỉ đều bị loại | Huy |
| D2b | **Mỗi người một tailnet riêng.** Không có tailnet dùng chung ⇒ không có truy cập chéo giữa các thành viên | Huy |
| D3 | ~~Terminal nhúng thẳng trong PWA~~ → **ĐÃ ĐỔI** (do D2c): terminal là **trang riêng do chính daemon phục vụ** qua HTTP trong tailnet. PWA hiện thẻ kèm link, bấm là chuyển sang | Huy |
| D4 | Gõ tiếng Việt/tiếng Anh bình thường như app chat — **điện thoại tự quyết**, không ép chế độ | Huy |
| D5 | Phạm vi: trả lời Claude, chọn 1/2/3, duyệt quyền, lệnh shell lắt nhắt. **Không** vim/htop | Huy |
| D5c | ~~Không quản lý nhiều phiên~~ → **ĐÃ ĐẢO 2026-07-28.** Hỗ trợ **nhiều phiên Claude cùng lúc**. Lý do: D5 giả định một máy một phiên; thực tế Huy chạy `workspace` và `cc-remote-control` song song, và cổng cố định 8730 làm daemon thứ hai không bind được — gặp thật khi dùng | Huy |
| D5b | Chỉ attach **đúng một pane** — pane đang chạy Claude Code. Lệnh shell lắt nhắt vì thế chạy *trong chính pane đó*: nhờ Claude chạy hộ, hoặc sau khi Claude thoát. Không mở pane/cửa sổ thứ hai | Huy (làm rõ) |
| D6 | Phiên mở bằng slash command `/remote` từ trong Claude CLI; PWA tự hiện thẻ | Huy |
| D7 | Đóng khi **pane tmux chết** (trụ chính) hoặc **hook `SessionEnd`** (phụ). Không tự tắt theo thời gian, không tắt khi detach | Huy |
| D8 | **Không dùng `caffeinate`** — trung lập hệ điều hành; người dùng tự đặt máy không ngủ | Huy |
| D9 | Có cả iPhone và Android để nghiệm thu → cả hai nền tảng đều phải đo thật | Huy |

## 4. Kiến trúc

### 4.1 Bốn mảnh

> **Đã bị thay bởi 2026-07-29** (`docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md`):
> hàng "Bí mật HMAC" dưới đây, và câu "còn phải biết bí mật HMAC nằm trên máy dev" ở dưới,
> mô tả v1. Từ v2, thiết bị tự ký ECDSA bằng khoá riêng không rời điện thoại; hub và daemon
> không giữ bí mật ký vé nào nữa (xem term/src/ticket.js). Spec trôi đúng chỗ này từng sinh
> ra lỗ hổng Critical đầu tiên của review cuối — giữ nguyên văn bên dưới làm hồ sơ, không xoá.

```
Claude Code (chạy trong tmux)
   │ /remote on
   ▼
ccrc-term  (daemon trên máy dev)
   ├─ ghi nhớ đúng pane đã gọi lệnh
   ├─ nghe trên IP Tailscale, cổng do OS cấp (bind cổng 0)
   │     →  http://100.x.x.x:<cổng>/     (trang terminal + WebSocket)
   └─ báo hub: {máy, sessionId, URL}            ← chỉ metadata

hub  (192.168.1.10 — giữ nguyên vai trò cũ)
   ├─ lưu thẻ phiên đang mở
   └─ cấp VÉ khi PWA xin                        ← không thấy byte shell nào

PWA  (ccrc.example.com — app đã có)
   └─ thẻ "Terminal đang mở · <máy>" kèm link sang trang terminal
```

**Ranh giới quan trọng nhất:** hub **cấp vé nhưng không nằm trên đường đi**. Byte terminal
chạy thẳng từ trình duyệt tới máy dev qua tailnet. Chiếm được hub cũng không đọc được
phiên — còn phải biết bí mật HMAC nằm trên máy dev.

**Vì sao HTTP chứ không HTTPS:** Tailscale là WireGuard, nên mọi byte giữa hai thiết bị
**đã được mã hoá ở tầng dưới**. Thêm TLS lên trên chỉ để thoả trình duyệt sẽ phải xin
chứng chỉ, mà chứng chỉ nào cũng vào Certificate Transparency log công khai — vi phạm D2c.
Trang terminal và WebSocket của nó **cùng một origin `http://`**, nên không có vấn đề nội
dung hỗn hợp. Cái giá là nó không nhúng được vào PWA (https), và đó chính là lý do D3 đổi.

**Các đại lượng, định nghĩa một lần:**

| Tên | Là gì |
|---|---|
| `sessionId` | Chuỗi ngẫu nhiên do daemon sinh **mỗi lần `/remote on`**. **Không** phải tên phiên tmux — tên thật không rời khỏi máy dev |
| Đường vào | Daemon `listen()` trên `Self.TailscaleIPs[0]` (đo thật trên máy Huy: `100.86.78.80`), **cổng 0 — để OS cấp** (đảo 2026-07-28 theo D5c: cổng cố định 8730 làm daemon thứ hai chết EADDRINUSE). Cổng thật chỉ biết được sau khi `listen` xong (`server.address().port`), và URL báo lên hub được dựng từ đó. `CCRC_TERM_PORT` vẫn ghim được, chỉ dùng cho test. **Chỉ** bind địa chỉ Tailscale — không `0.0.0.0`, để cổng không hở ra wifi/LAN |
| Nhịp tim | Daemon POST lên hub mỗi **20 giây**. Hub coi thẻ là "không phản hồi" sau **60 giây** không nhịp |
| Kho nonce | Daemon giữ trong RAM, xoá mục quá hạn. Daemon khởi động lại ⇒ vé cũ vô hiệu (đúng ý muốn — xem thêm hàng "Bí mật HMAC" ngay dưới, thứ thực sự làm điều này đúng) |
| Cấu hình daemon | Dùng lại `~/.ccrc/config` sẵn có (`CCRC_HUB_URL`, `CCRC_TOKEN`, `CCRC_MACHINE_NAME`) |
| Bí mật HMAC | Sinh **mới, chỉ trong RAM**, mỗi lần daemon khởi động (`/remote on`) — **không** ghi ra đĩa. Gửi hub qua **mỗi nhịp tim** (`POST /api/terminal/register`, trường `secret`), không phải một lần lúc cài. Hub chỉ giữ bí mật mới nhất trong RAM (`server/src/terminal-sessions.js`), nên nó tự sửa trong vòng một nhịp tim dù hub hay daemon khởi động lại trước. Đây là cơ chế THỰC SỰ làm cho "daemon khởi động lại ⇒ vé cũ vô hiệu" đúng: một vé chỉ kiểm được bằng đúng bí mật đã ký nó, và bí mật đổi mỗi lần chạy |

**Về tên lệnh `/remote`:** hướng cũ đã xoá từng có một `deploy/commands/remote.md`. Đây là
lệnh **mới hoàn toàn**, trùng tên chứ không phải hồi sinh — không dùng lại dòng code nào.

### 4.2 Vòng đời

| Sự kiện | Hệ quả |
|---|---|
| `/remote on` | Đăng ký pane, mở cổng nghe trên IP Tailscale, hiện thẻ trong PWA, in URL và dòng nhắc về việc máy ngủ |
| `/remote off` | Đóng cổng nghe, xoá thẻ |
| `/remote` | Báo trạng thái từng lớp (như `/notify` đã làm) |
| **Pane tmux chết** | Đóng tất cả. **Trụ chính, ĐÃ triển khai.** Kiểm bằng cách bắt pane tự khai id của nó |
| **Hook `SessionEnd`** | ~~Đóng tất cả. Tín hiệu phụ~~ — **CHƯA triển khai.** Xem ghi chú ngay dưới bảng |
| Máy ngủ hoặc tắt | Không ai nối vào được; hub dọn thẻ khi daemon ngừng gửi nhịp |
| Đóng cửa sổ terminal (detach) | **Không làm gì** — gập máy rồi đi là kịch bản chính |

Mặc định **TẮT**. Không gõ lệnh thì không có cổng nào mở.

**Đính chính (final fix wave, item 3):** hàng `SessionEnd` ở trên từng đọc như một tín hiệu
đang hoạt động ("Tín hiệu phụ — đo được chỉ 6/8.868 lần"). Không có dòng code nào triển khai
nó — không hook nào lắng nghe `SessionEnd` để gọi `/remote off` hay đóng daemon. D7 (§3) vẫn
đứng như quyết định đã chốt (pane chết là trụ chính, `SessionEnd` là phụ), nhưng phần "phụ"
đó chưa từng được xây, và việc này bị hoãn có chủ đích chứ không phải bỏ sót — **không** được
triển khai trong đợt sửa lỗi này. Hệ quả trực tiếp: nếu Claude Code thoát (Ctrl-D, đóng cửa
sổ, crash) trong khi PANE vẫn còn sống — ví dụ shell mẹ vẫn chạy — daemon không nhận được tín
hiệu nào và tiếp tục phục vụ y nguyên phiên shell đó qua terminal web, không có gì báo cho
người dùng biết Claude Code đã thoát. Hai cách đóng phiên còn lại (pane chết thật, hoặc gõ tay
`/remote off`) vẫn hoạt động bình thường và là cách duy nhất đáng tin cậy để đóng phiên trong
tình huống này.

**Vì sao `paneAlive` phải bắt pane tự khai id:** `tmux display-message` trả exit 0 kèm
output rỗng cho pane đã chết. Bài học này đã trả giá ở hướng cũ; không lặp lại.

### 4.3 Xác thực

> **Đã bị thay bởi 2026-07-29** (`docs/superpowers/specs/2026-07-29-ghep-cap-thiet-bi-design.md`):
> sơ đồ và "Bốn ràng buộc cứng" dưới đây khẳng định hub ký vé bằng HMAC (v1). Từ v2, hub
> ra rìa khỏi việc ký hoàn toàn — điện thoại tự ký token ECDSA bằng khoá riêng không xuất
> được, daemon xác minh bằng khoá công khai học lúc ghép cặp (xem §4.3b bên dưới cho phần
> còn đúng — sessionKey — và term/src/ticket.js cho cơ chế thật). Giữ nguyên văn làm hồ sơ.

```
PWA    --(token cá nhân)-->   hub      : "cho tôi vé vào sessionId X"
hub    --(ký HMAC)-->                  : vé = {sessionId, máy, hết hạn, nonce}
trang   --(vé trong URL)-->   daemon   : ws://100.x.x.x:8730/attach?ticket=…
daemon                                 : kiểm chữ ký, hạn 60s, nonce chưa dùng
                                         → attach ĐÚNG pane đã đăng ký
```

Bốn ràng buộc cứng:

1. Daemon **chỉ attach đúng pane đã đăng ký**. Không tạo shell mới, không chọn pane khác.
   Vé hợp lệ cũng không mở được gì ngoài phiên đó.
2. Vé **dùng một lần**, sống **60 giây**. Lộ trong log hay lịch sử URL thì đã vô dụng.
3. Bí mật HMAC sinh **mới trong RAM mỗi lần daemon chạy** (`/remote on`), **không** ghi ra
   đĩa — gửi hub qua mỗi nhịp tim, không phải một lần lúc cài (xem bảng ở §4.1). Daemon
   khởi động lại ⇒ bí mật đổi ⇒ mọi vé ký bằng bí mật cũ hỏng theo, kể cả vé còn hạn.
4. Tunnel chỉ tồn tại trong lúc `/remote` bật.

### 4.3b Từ vé một lần sang phiên trình duyệt

Đổi sang HTTP làm lộ ra một khoảng trống: trang terminal nằm trên origin của máy dev, nên
nó **không có token cá nhân**. Vé thì dùng một lần, sống 60 giây. Đứt kết nối một cái là
trang không tự xin lại vé được — mà đứt kết nối là trạng thái bình thường trên di động (§6).

Luồng đã chốt:

```
PWA (có token)  --> hub            : xin vé
PWA             --> điều hướng     : http://100.x.x.x:8730/#t=<vé>
trang terminal  --> daemon (ws)    : attach?ticket=<vé>        ← vé cháy ở đây
daemon          --> trang          : {sessionKey: <ngẫu nhiên 32 byte>}
trang           --> sessionStorage : lưu sessionKey
[đứt] trang     --> daemon (ws)    : attach?key=<sessionKey>   ← nối lại, không cần vé mới
```

**Vé bootstrap một phiên trình duyệt.** `sessionKey` do daemon sinh, giữ **trong RAM**,
chết cùng daemon và cùng `/remote off`. Nó không bao giờ đi qua hub.

**Đánh đổi, nói thẳng:** `sessionKey` **dùng lại được** trong suốt đời daemon — khác với vé
một lần. Ai lấy được nó thì nối lại được. Chấp nhận vì: nó chỉ tồn tại trong
`sessionStorage` của một origin chỉ với tới được từ trong tailnet, nó chết theo daemon, và
phương án thay thế — bắt người dùng dán token cá nhân vào trang terminal — đưa một bí mật
**mạnh hơn** (mở được hub) sang một origin thứ hai. Đổi một bí mật yếu, ngắn hạn, cục bộ
lấy một bí mật mạnh, dài hạn là đi đúng hướng.

**Vé vẫn giữ nguyên mọi ràng buộc cũ** — một lần, 60 giây, ràng buộc `sessionId` + máy.
`sessionKey` không thay thế vé; nó chỉ tiếp quản sau khi vé đã làm xong việc.

**Ba vòng đời khác nhau, không được gộp:**

| Thứ | Sống bao lâu | Vai trò |
|---|---|---|
| Vé | 60 giây, một lần | Chỉ để bắt tay mở WebSocket |
| Kết nối WebSocket | Đứt liên tục | Khoá màn hình, đổi mạng, vào nền — đứt là bình thường |
| Phiên remote | Đến khi pane chết / `SessionEnd` / `/remote off` | Không hết hạn theo thời gian |

Vé ngắn **không** giới hạn thời gian dùng: PWA tự xin vé mới mỗi lần nối lại, tự động,
người dùng không thấy gì.

### 4.4 Điều kiện tiên quyết

Cả hai điều kiện dưới đây, nếu thiếu, `/remote` phải **báo lỗi rõ ràng và không bật gì** —
tuyệt đối không im lặng bật một nửa.

**1. Claude Code phải chạy trong tmux.** Hiện máy Huy không có phiên tmux nào.

**2. Tailscale phải đang chạy và có địa chỉ.** Đo được: `tailscale status --json` trả
`BackendState: "Stopped"` khi tắt, và `Self.TailscaleIPs` rỗng khi chưa đăng nhập — daemon
phát hiện được cả hai, không treo.

**KHÔNG còn điều kiện về chứng chỉ.** Bản thiết kế trước yêu cầu tailnet bật HTTPS
Certificates; Huy từ chối (D2c) vì việc đó đưa tên máy vào Certificate Transparency log
vĩnh viễn, không xoá lại được. Bỏ chứng chỉ đồng nghĩa bỏ luôn `tailscale serve`,
`serveStart`/`serveStop`, và rủi ro `serve reset` xoá nhầm cấu hình serve của người dùng.

**Vì sao bind đúng IP Tailscale chứ không `0.0.0.0`:** bind `0.0.0.0` sẽ mở cổng 8730 ra
**mọi mạng máy đang nối** — quán cà phê, wifi khách sạn, LAN công ty. Bind đúng
`Self.TailscaleIPs[0]` thì chỉ thiết bị trong tailnet chạm tới được, và hệ điều hành từ
chối phần còn lại thay vì dựa vào tường lửa.

**Hệ quả cho PWA:** PWA (https) **không** nhúng được terminal (http) — trình duyệt chặn
nội dung hỗn hợp. PWA chỉ hiện thẻ kèm link; bấm vào là điều hướng cấp trang, việc này
được phép. Điện thoại **không** ở trong tailnet thì link không mở được — xem §7.

## 5. Nhập liệu trên di động

### 5.1 Quyết định gốc: tắt hẳn đường nhập của xterm.js

xterm.js nhận phím qua một `<textarea>` ẩn (`.xterm-helper-textarea`). Đó chính là nơi sinh
ra cả bốn nhóm lỗi ở §2. Khởi tạo với `disableStdin: true` và vô hiệu hoá textarea đó, nên
nó **không bao giờ giành focus, không bao giờ tự bật bàn phím**.

Terminal trở thành **màn hình hiển thị thuần**. Mọi input đi qua hai đường ta tự kiểm soát.
Nhóm vấn đề "bàn phím có bật không" và "ký tự vào có đúng không" **không phải khắc phục —
chúng không tồn tại nữa**.

### 5.2 Đường 1 — ô soạn kiểu chat

```html
<textarea autocapitalize="none" autocorrect="off"
          autocomplete="off" spellcheck="false"
          enterkeyhint="send"></textarea>
```

**Giữ IME** ⇒ bàn phím tiếng Việt hoạt động bình thường, điện thoại tự quyết Việt hay Anh
(D4). Tắt ba thứ kia vì chúng phá lệnh shell: `autocapitalize` biến `git` thành `Git`,
`autocorrect` sửa tên biến thành từ tiếng Anh.

Gõ đoán chữ không còn nguy hiểm vì **chỉ gửi khi bấm Gửi**, không gửi từng phím — vùng đệm
chữ chưa chốt của bàn phím đã chốt xong từ lâu trước đó.

**Gửi bằng bracketed paste:**

```
ESC[200~   <nội dung>   ESC[201~   \r
```

Nếu bắn thô, mỗi ký tự xuống dòng trong đoạn text thành một lần Enter và **gửi câu trả lời
dở dang** cho Claude. Bọc trong bracketed paste thì TUI hiểu là một lần dán, giữ nguyên khối.

**Enter xuống dòng, nút Gửi mới gửi.** Trên di động bấm nhầm Enter là mất câu đang viết.

### 5.3 Đường 2 — thanh phím điều khiển

Một hàng cố định ngay trên ô soạn:

| Phím | Việc |
|---|---|
| `Esc` | Ngắt Claude đang chạy — dùng nhiều nhất |
| `↑` `↓` | Di chuyển trong AskUserQuestion và hộp xin quyền |
| `⏎` | Enter trần, xác nhận lựa chọn mà không gửi text |
| `Tab` | Hoàn thành |
| `^C` | Ctrl-C |

**Không làm phím Ctrl dính đa dụng.** `^C` một nút phủ gần hết nhu cầu; Ctrl tổng quát kéo
theo cả cơ chế modifier dính, tốn công mà không dùng tới (D5 đã loại vim/htop).

**Không cần prefix `Ctrl-B` của tmux** vì chỉ attach đúng một pane ⇒ lỗi Ctrl-C ra keyCode
13 trên Safari (§2) không chạm tới thiết kế này.

### 5.4 Bàn phím ảo — hai nhánh code

```js
if ('virtualKeyboard' in navigator) {
  navigator.virtualKeyboard.overlaysContent = true;      // Android
} else {
  visualViewport.addEventListener('resize', relayout);   // iOS
}
```

Cả hai nhánh cùng gọi một hàm `relayout()`: tính lại chiều cao vùng terminal, `fit()`, rồi
báo kích thước mới xuống PTY.

### 5.5 Bẫy: kích thước tmux dùng chung

**Sự thật không đổi qua mọi lần sửa mục này:** tmux chỉ cho **một cửa sổ (window) đúng một
kích thước** tại một thời điểm — không có cách nào cho điện thoại và máy tính mỗi bên thấy
kích thước riêng của mình khi cả hai cùng gắn vào một cửa sổ dùng chung. Mọi bản của §5.5 là
cùng một câu hỏi: kích thước đó theo AI. Câu trả lời đã đổi.

Vẫn giữ **phiên nhóm** (grouped session) — điện thoại không bao giờ gắn thẳng vào phiên gốc,
mà tạo một phiên riêng dùng chung cửa sổ/pane:

```bash
tmux new-session -t <phiên-gốc>
tmux set-option -t <phiên-nhóm> window-size smallest       # ← điện thoại quyết định, xem đính chính dưới
tmux setw -t <phiên-nhóm> aggressive-resize on             # giữ, vô hại
```

Phiên nhóm vẫn đáng giữ vì lý do khác: cửa sổ hiện tại độc lập, dọn sạch khi ngắt, và dấu
`@ccrc_group` chặn daemon giết nhầm phiên không phải do nó tạo. Chỉ tuỳ chọn kích thước là
thứ đã đổi.

**Đính chính (final fix wave, item 9):** bản trước của đoạn này ghi `tmux setw -g
aggressive-resize on` — cờ `-g` đặt GLOBAL, ảnh hưởng tới mọi phiên trên cả server, không chỉ
phiên nhóm. Code (`term/src/tmux.js`, `createGroupSession`) làm đúng ngay từ đầu — nhắm đúng
`-t <phiên-nhóm>`, không có `-g` — chỉ dòng tài liệu này từng sai và có nguy cơ bị copy-paste
sai theo.

**Đính chính ngày 2026-07-27, đo lúc làm Task 5 Kế hoạch 2:** công thức ban đầu của mục
này chỉ ghi `aggressive-resize on`, và **nó không đủ**. Kiểm tay với client `tmux -C` thật
gắn ở cả hai phía: `aggressive-resize` một mình **không** cô lập kích thước cho client đang
gắn sống. `window-size largest` trên phiên nhóm mới là thiết lập chịu lực — cửa sổ dùng
chung theo client LỚN NHẤT, để điện thoại nhỏ không kéo màn hình máy tính co theo.

Đo 1 ở Bước 0 vẫn đúng với thứ nó đo (tạo phiên nhóm rồi so kích thước), nhưng nó không có
client control-mode sống ở cả hai đầu — mà đó mới là hình dạng lúc chạy thật. Một phép đo
có thể đúng về điều nó đo và vẫn thiếu điều mình cần.

**Hệ quả kèm theo, cũng đo được (lúc đó):** giết phiên nhóm bị nhầm thành "pane đã chết", làm
daemon tự tắt oan. Phải hỏi `paneAlive(PANE)` trước khi kết luận pane chết. Điều này không
đổi khi tuỳ chọn kích thước đổi ở đính chính dưới đây.

**Đính chính ngày 2026-07-28 — đảo ngược quyết định, đo trên điện thoại thật:** `window-size
largest` ở trên làm đúng thứ nó được viết ra để làm — giữ màn hình máy tính khỏi co lại — và
đó chính là vấn đề. Nó bảo vệ đúng thiết bị SAI. Huy dùng thử trên điện thoại thật: cửa sổ
dùng chung vẫn giữ nguyên ~200 cột theo máy Mac, nên điện thoại ~40 cột nhận về những dòng
rộng gấp năm lần màn hình của nó, tự xuống dòng, chữ chồng lên nhau, đọc không nổi — hỏng
hoàn toàn, đúng nghĩa đen "không dùng được". Cái giá `largest` ngăn được (máy tính co lại khi
điện thoại nối vào) chỉ là tạm thời và tự hồi phục: người dùng không ngồi nhìn máy tính lúc
đang cầm điện thoại, và tmux tự trả lại kích thước cũ ngay khi điện thoại ngắt kết nối
(tmux tính lại kích thước cửa sổ mỗi khi có client gắn vào/rời khỏi phiên nhóm — đo trực
tiếp, không cần máy tính tự resize lại), Claude Code vẽ lại màn hình sau đó. Cái giá `largest`
GÂY RA thì không tự hồi phục — nó kéo dài suốt lúc điện thoại là thiết bị đang mở, tức là
toàn bộ mục đích của tính năng.

Quyết định: **điện thoại thắng**. `window-size` đổi từ `largest` sang `smallest` — cửa sổ
dùng chung theo client NHỎ NHẤT đang gắn. Máy tính co lại trong lúc điện thoại đang mở, và
trở lại đủ cỡ ngay khi điện thoại ngắt. `aggressive-resize` giữ nguyên — không phải thứ quyết
định của lần sửa này. Xem `term/src/tmux.js` (`createGroupSession`) và
`term/test/tmux.test.js`, `term/test/daemon.test.js` cho phần đo lại quan hệ kích thước theo
chiều mới.

### 5.6 Hiển thị

- xterm.js **đóng gói kèm** (~300KB) — CSP của PWA cấm nguồn ngoài, không dùng CDN
- Tự cuộn xuống đáy khi có output mới; cuộn lên thì hiện nút `▼ mới`
- Chỉnh cỡ chữ bằng cử chỉ chụm

## 5A. Font terminal và khoá zoom (bổ sung 2026-07-28)

### 5A.1 Font — đo bề rộng là chưa đủ, phải NHÌN

Yêu cầu: tiếng Việt hiển thị đúng, và ký tự vẽ khung (`─ │ ╭ ╮ ╰ ╯ ├ ┤ ┼`) — thứ Claude
Code dùng ở mọi khung giao diện — phải cùng một bề rộng ô với chữ thường. Glyph nào thiếu
thì trình duyệt lấy từ font khác, bề rộng lệch, và **lưới terminal bị xé**.

Đo trong trình duyệt thật, bốn ứng viên:

| Font | Bề rộng đồng nhất | Nét chữ tiếng Việt | Kết |
|---|---|---|---|
| Hack Nerd Font | ❌ thiếu `ế` `ữ` → rơi sang font khác ở **2× bề rộng** | — | loại ngay |
| DejaVu Sans Mono | ✅ đủ 134 chữ Việt + 160 ô khung, một bề rộng | ❌ vẽ `ế` thành `ê´`, dấu thanh lệch sang bên | **loại sau khi đã nhúng** |
| Noto / Roboto Mono | ✅ | ✅ | được, nhưng nặng hơn |
| **JetBrains Mono** | ✅ đủ chữ Việt + 128 ô khung U+2500–U+257F | ✅ dấu thanh đúng chỗ | **chọn** (90 KB, OFL) |

**Bài học ghi lại vì nó lặp lại đúng một khuôn cũ:** DejaVu qua sạch mọi phép đo bề rộng và
đã được nhúng vào repo, rồi bị loại **khi nhìn thấy nó vẽ ra cái gì**. Bề rộng là câu hỏi
DỄ HƠN câu thật sự cần hỏi. Cùng họ với "hai phiên tmux tách rời" ở §12 — phép đo trả lời
một câu khác với câu mình tưởng mình đang hỏi.

Không phủ, cố ý để rơi về font hệ thống: `⏺ ⏵ ⎿` và các khung spinner Braille `⠋⠙⠹`. Không
font monospace nào khảo sát được mang cả nhóm này lẫn tiếng Việt; đây là vài glyph trang trí,
đổi lại là mọi đường khung và mọi chữ có dấu trên màn hình.

### 5A.1b Icon Nerd Font — nhúng thêm font THỨ HAI, chỉ để lấy icon

Dấu nhắc shell vẽ dải phân cách và các glyph thư mục/git/đồng hồ bằng vùng private-use của
Nerd Font. Thiếu chúng thì trên điện thoại hiện một dãy ô vuông rỗng.

Đọc thẳng bảng `cmap` của từng file, không đoán:

| | Hack Nerd Font đầy đủ | Symbols Nerd Font (chỉ icon) | JetBrains Mono |
|---|---|---|---|
| Tiếng Việt | ❌ **thiếu 84/134** | — (không có chữ nào) | ✅ đủ 134 |
| Ký tự khung | ✅ | — | ✅ |
| Icon Nerd Font | ✅ | ✅ 10.410 glyph | ❌ |
| Kích thước | 2,6 MB | 2,4 MB | 90 KB |

**Loại bản Hack đầy đủ:** nó thiếu 84 chữ tiếng Việt nên không làm font chữ được, mà dùng làm
font icon thì vác thừa cả bộ chữ. Chọn bản **Symbols** — không chứa một chữ cái nào.

Stack: `"JetBrains Mono Web", "Nerd Icons Web", <hệ thống>`. Font chữ đứng **trước**, vì mọi
chữ phải đến từ một font duy nhất; font icon chỉ đỡ những gì font chữ không có.

**`unicode-range` là thứ giữ cho 2,4 MB không thành gánh nặng** — và là phần dễ sai âm thầm
nhất. Trình duyệt chỉ tải file khi màn hình thật sự có ký tự nằm trong khoảng đã khai, và
không bao giờ dùng nó cho thứ khác. Khoảng khai báo được **đo ra**: ba mặt phẳng private-use,
cộng đúng 14 điểm mã ngoài PUA mà font này có (`U+23FB-23FE ⏻⏼⏽⏾`, `U+2630 ☰`, `U+2665 ♥`,
`U+26A1 ⚡`, `U+276C-2771 ❯`, `U+2B58 ⭘`).

Khai thiếu một điểm mã thì **hỏng âm thầm**: không tải gì, không dùng gì, icon thành ô vuông,
không lỗi ở đâu cả — cùng họ với lỗi content-type đã tốn một vòng gỡ rối. Nên có test đọc
thẳng `term.css` và file font, kiểm hai chiều: 7 icon của dấu nhắc thật đều nằm trong khoảng,
và không chữ/số/dấu tiếng Việt/ký tự khung nào lọt vào.

`✔ U+2714` không có trong cả hai font nhúng — để rơi về font hệ thống.

**Nén:** file tĩnh trên 64 KB được gzip khi trình duyệt chấp nhận, bản nén giữ trong bộ nhớ
để không nén lại mỗi request. Font icon 2,4 MB → 1,5 MB trên đường truyền, và với
`immutable` thì mỗi thiết bị chỉ tải một lần.

### 5A.2 Thứ tự nạp font — chỗ dễ sai nhất

xterm đo kích thước ô **tại thời điểm dựng `Terminal`**, và số đo đó quyết định số cột báo
cho tmux. Nên:

1. Dựng terminal bằng **stack hệ thống** (`ui-monospace, SFMono-Regular, Menlo, "Courier New", monospace`)
   — luôn có sẵn, không phải chờ.
2. Chờ `document.fonts.load('16px "JetBrains Mono Web"')`.
3. Chỉ khi tải xong mới gán `term.options.fontFamily` → xterm bỏ số đo cũ, rồi `relayout()`
   đo lại lưới và báo kích thước mới cho tmux.

Đặt tên font đang tải ngay lúc dựng sẽ khiến xterm đo font dự phòng và báo số cột sai — một
phiên bản lệch-một-cột, âm thầm, của lỗi terminal vỡ đã từng xảy ra.

Mọi nhánh hỏng đều không được chí mạng: không có `document.fonts`, tải hỏng, hoặc bản xterm
từ chối gán — trang giữ stack hệ thống và chạy tiếp. Font là cải thiện, **không phải phụ thuộc**.

### 5A.3 Khoá zoom — meta thôi là không đủ

Cả hai trang giữ nguyên 1×. Ba lớp, vì không lớp nào đủ một mình:

| Lớp | Chặn được gì | Vì sao cần |
|---|---|---|
| `maximum-scale=1, user-scalable=no` | Chrome, Android | iOS Safari **cố tình bỏ qua** (lý do trợ năng) |
| `touch-action: pan-x pan-y` (CSS) | pinch + double-tap trên Chrome/Android | không tác dụng với `gesture*` của Safari |
| huỷ `gesturestart/change/end` (JS) | pinch trên iOS Safari | sự kiện riêng của Safari, nơi hai lớp trên thua |

Ở trang terminal việc này quan trọng hơn: xterm dựng lưới theo viewport và đã báo kích thước
đó cho tmux — phóng to là đang xem một lưới không còn khớp với cái tmux được cho biết.

### 5A.4 Kéo xuống để nạp lại (trang thông báo)

PWA đã cài không có thanh địa chỉ nên **không có nút tải lại**, và không nền tảng nào cho sẵn
cử chỉ này: iOS standalone không có, còn trên Android `overscroll-behavior-y: contain` đã tắt
cử chỉ gốc của trình duyệt.

Nạp lại **cả trang** (`location.reload()`), không phải chỉ gọi lại API: PWA đã cài giữ bản
`app.js`/`style.css` cũ, nên làm mới dữ liệu đơn thuần không bao giờ mang được bản build mới
về — mà kẹt ở bản cũ không lối thoát chính là tình huống cử chỉ này sinh ra để cứu.

Chỉ nhận cử chỉ khi **đã đăng nhập** và **đang ở đúng đỉnh trang**; kéo lên thì trả lại cho
trình duyệt cuộn bình thường, và chỉ gọi `preventDefault()` sau khi đã biết chắc là kéo
XUỐNG. Ngưỡng 70px sau hệ số cản 0.5 (tức ngón tay đi ~140px). `touchcancel` cũng phải dọn
chỉ báo — cùng họ với lỗi nút "Đang mở…" kẹt ở §12: nhánh hạnh phúc dọn sạch, nhánh bị ngắt
thì không.

## 5B. Riêng tư: tên phiên thay cho tên thư mục (bổ sung 2026-07-28)

### 5B.1 Cái bị lộ

Nhãn thẻ terminal và tiêu đề thông báo đẩy đều lấy **tên thư mục cuối của cwd**. Trên màn
hình khoá và trong mọi ảnh chụp, thứ đó gọi tên dự án — đôi khi gọi tên cả khách hàng. Huy
phát hiện bằng ảnh chụp thật: `workspace`, `dev`, `cc-remote-control` nằm cả trên thẻ
terminal lẫn danh sách "Gần đây".

Không thể thu hồi thứ đã bị nhìn thấy. Nên tên thư mục **không còn được gửi đi ở bất kỳ đâu**.

### 5B.2 Thay bằng gì

| Trường hợp | Hiện ra |
|---|---|
| `/remote on` | id ngẫu nhiên 4 ký tự, ví dụ `k7m2` |
| `/remote on test` | `test` |
| Thông báo, có phiên terminal đang chạy cho thư mục đó | cùng tên/id với thẻ terminal |
| Thông báo, KHÔNG có phiên nào | **chỉ tên máy** — không bao giờ rơi về tên thư mục |

Bảng chữ cái của id bỏ `i l o 0 1`: id được đọc trên màn hình điện thoại rồi gõ lại vào
terminal, và đó đúng là năm ký tự người ta nhìn nhầm. 31⁴ ≈ 923 nghìn — thừa sức phân biệt
vài phiên chạy cùng lúc. Đây là **nhãn, không phải bí mật**, không dùng để xác thực gì.

Tên do người dùng đặt bị giới hạn ở chữ, số, khoảng trắng, `.` `_` `-`, tối đa 24 ký tự. Tên
hỏng **không phải là lỗi** — daemon rơi về id ngẫu nhiên và CLI nói rõ, vì từ chối mở
terminal chỉ vì cái nhãn là phản ứng lệch hoàn toàn so với việc người dùng đang cần.

### 5B.3 Sổ tra cục bộ — vì sao phải có

Thông báo do **hook** gửi, terminal do **daemon** phục vụ: hai chương trình khác nhau, và
`/remote` có thể đang tắt. Để cả hai gọi cùng một cái tên, daemon ghi
`~/.ccrc/sessions/<sessionId>.json` (`{sessionId, cwd, name, pid}`), hook tra theo **cwd của
chính nó**.

- Khớp **chính xác** đường dẫn. Khớp theo tiền tố là đoán, mà đoán sai ở đây nghĩa là gán
  thông báo cho nhầm phiên — tệ hơn không gán.
- `cwd` **không bao giờ rời khỏi máy**. Nó chỉ là khoá để hai bên gặp nhau.
- Ghi lại mỗi nhịp tim, vì người dùng `cd` thì thư mục đổi.
- Mỗi mục nhớ `pid`. `kill -9` thì daemon không kịp dọn, nên **người đọc** kiểm tiến trình
  còn sống không, và tự xoá mục chết — không có thứ gì khác quét thư mục này.
- Ghi qua file tạm rồi `rename`: hook đọc file này trên đường đi của **mọi** thông báo, không
  bao giờ được vớ phải file đang ghi dở.
- Không bao giờ ném lỗi. Sổ tra hỏng thì thông báo vẫn phải đi, chỉ là không có tên.

`shared/` nằm ngoài cả ba workspace nên cần `package.json` riêng với `"type": "module"` —
thiếu nó Node in cảnh báo `MODULE_TYPELESS_PACKAGE_JSON` ra **stderr**, và stderr của hook
hiện thẳng trong Claude Code. Test stderr sẵn có bắt được ngay.

## 5C. Không báo về phiên đang mở trên điện thoại (bổ sung 2026-07-28)

Đang nhìn terminal mà điện thoại vẫn rung báo "Claude đang chờ bạn" là tiếng ồn.

**Tín hiệu dùng: trang có đang hiển thị không — KHÔNG phải WebSocket còn sống.** Điện thoại
khoá màn hình hoặc chuyển app vẫn giữ socket một lúc; lấy socket làm tín hiệu thì người dùng
lặng lẽ mất thông báo mà không có cách nào biết vì sao. Nên:

```
trang ──ccrc_visibility {visible}──► daemon ──viewing──► hub ──► bỏ qua push
        (visibilitychange + lúc nối)
```

- Client vừa nối được coi là **đang xem** — nếu không, đúng một thông báo sẽ lọt qua trước
  khung `ccrc_visibility` đầu tiên.
- Chỉ `visible` kiểu boolean thật mới được tính. Khung hỏng không được phép tắt thông báo —
  đó là lỗi người dùng sẽ không bao giờ chẩn đoán ra.
- Trạng thái đổi thì **đẩy nhịp tim ngay**, không đợi nhịp 20 giây: đợi thì thông báo vẫn nổ
  vài giây sau khi mở terminal, và vẫn im tới 20 giây sau khi đóng.
- Hub chỉ bỏ qua khi phiên **còn nhịp tim**. Daemon chết trong lúc ai đó đang xem thì thông
  báo phải trở lại ngay, không phải đợi hết vòng đời phiên.
- Ranh giới người dùng giữ nguyên: `sessionId` của người này không trả lời được câu hỏi hỏi
  thay người kia.
- **Vẫn lưu vào "Gần đây" dù không đẩy.** Đúng cái thông báo bị bỏ qua lúc không nhìn lại là
  cái người dùng cần tra lại sau.

## 5D. Cuộn, bôi đen, và thanh phím (bổ sung 2026-07-28)

### 5D.1 Cuộn — hai phương án bị bác bỏ trước khi tìm ra đường đúng

Lịch sử **không nằm ở trình duyệt**. Đo thật: sau 140 dòng output, vùng cuộn của xterm vẫn
đúng bằng một màn hình và sự kiện `wheel` không làm đổi gì trên màn hình. CSS không cứu
được — không có gì để cuộn.

| Phương án | Kết quả đo được |
|---|---|
| Sửa CSS (`touch-action`, `overflow`) | ❌ không có scrollback để cuộn |
| Điều khiển **copy-mode** của tmux | ❌ `pane_in_mode`=1, `scroll_position`=30 — **màn hình Mac cuộn, trình duyệt không thấy gì**. `tmux -C` chuyển `%output` của pane, KHÔNG chuyển màn hình tmux dựng |
| **Daemon tự lấy lịch sử và gửi màn hình** | ✅ offset 0→13→26→39, mỗi bước một màn hình; pane KHÔNG vào copy-mode |

Phương án copy-mode được chọn trước, rồi bị chính phép đo bác bỏ: nó làm đúng cái tệ nhất —
đụng vào máy Mac mà điện thoại chẳng được gì.

### 5D.2 Cách làm cuối

- Trang gửi `{type:'ccrc_scroll', lines:n}` — dương là lùi về quá khứ, âm là về hiện tại.
  Quy đổi pixel sang dòng bằng chiều cao dòng đo trực tiếp trong DOM.
- Daemon giữ `historyOffset` **theo từng kết nối**, lấy màn hình bằng
  `capture-pane -S -offset -E (-offset+rows-1)`, đóng khung y như `snapshotPane` (xoá màn
  hình + về đầu, `\r\n` giữa các dòng, reset SGR ở cuối).
- Trong lúc đang đọc lịch sử, **output trực tiếp bị giữ lại, không bị mất**: quay về hiện tại
  sẽ gửi lại nguyên màn hình hiện tại, vốn đã chứa mọi thứ xảy ra trong lúc đó.
- **Gõ phím là tự về hiện tại.** Phím vẫn đi vào pane sống dù màn hình đang hiện quá khứ, nên
  để nguyên sẽ thành cảnh người dùng gõ mà chữ biến mất.
- `rows` lấy từ báo cáo resize của chính trình duyệt — màn hình lịch sử phải cao đúng bằng
  lưới của nó.
- Số dòng bị chặn biên như `cols/rows`: nó tới từ trình duyệt và đi thẳng vào dòng lệnh tmux.

### 5D.2b Sửa lại: pane thật là TUI màn hình phụ, không có lịch sử tmux nào

Bản 5D.2 chạy đúng trong test và **vô dụng ở chỗ cần dùng**. Đo trên phiên Claude Code thật:

| Đo | Giá trị | Nghĩa |
|---|---|---|
| `alternate_on` | **1** | Claude Code ở màn hình phụ |
| `history_size` | **2** | tmux **không giữ** lịch sử cho pane này |
| `mouse_any_flag` | **1** | ứng dụng đang bật nhận sự kiện chuột |
| `mouse_sgr_flag` | **1** | theo kiểu SGR (mode 1006) |

Lịch sử hội thoại nằm **bên trong Claude Code**, không nằm ở tmux. `capture-pane -S` trên pane
màn hình phụ cào vào vùng không có dữ liệu — đó chính là màn hình đầy dòng dấu nhắc lặp lại
mà Huy chụp được.

**Vì sao lọt lưới:** test dựng bằng `echo` trong shell trần — pane có lịch sử tmux thật,
`alternate_on=0`. Đích thật thì ngược lại hoàn toàn. Cùng một khuôn với "hai phiên tmux tách
rời" ở §12: **dựng test sai hình dạng thì nó trả lời một câu khác**.

**Cách làm đúng:** daemon **hỏi pane trước** rồi mới chọn đường.

```
mouse_any_flag = 1  →  gửi SỰ KIỆN LĂN CHUỘT cho ứng dụng (nó tự cuộn lịch sử của nó)
mouse_any_flag = 0  →  phân trang lịch sử tmux (mục 5D.2 — vẫn đúng cho shell thường)
```

Nhánh thứ hai không phải cho đủ bộ: gửi byte chuột vào shell **không** bật chuột thì chúng bị
**gõ thẳng vào dòng lệnh** của người dùng. Có test ghim đúng điều đó.

Mã hoá (`term/src/mouse.js`): SGR `ESC[<64;col;rowM` cho lăn lên, `65` cho lăn xuống; kiểu cũ
`ESC[M` + ba byte cộng 32, toạ độ bị **kẹp ở 223** chứ không quấn vòng. Khoảng 3 dòng một nấc,
trần 40 nấc mỗi cử chỉ.

**Kiểm chứng thật, không phải chỉ qua test:** `less --mouse` qua tmux — 5 nấc xuống đưa từ
`dòng 1` sang `dòng 6`, 3 nấc lên về `dòng 3`. Và trên chính phiên Claude Code đang chạy: gửi
3 nấc lên, màn hình đổi thật.

### 5D.2c Bấm — nút nằm TRONG ứng dụng, không phải phần tử DOM

Claude Code vẽ nút của nó bằng chữ trong terminal (`Jump to bottom (click) ↓`). Không có phần
tử HTML nào để gắn sự kiện. Nhưng ứng dụng đã bật nhận chuột sẵn — cùng cơ chế phần cuộn dùng
— nên chạm trở thành **một cú bấm tại đúng ô**.

Quy đổi vị trí chạm sang ô: lấy `getBoundingClientRect()` của `.xterm-screen` chia cho
`term.cols`/`term.rows`. Suy từ màn hình đã vẽ chứ không đo một ký tự, nên đổi font vẫn đúng.

**Phải gửi CẢ nhấn lẫn nhả.** Ứng dụng vẽ nút kích hoạt lúc **nhả**; gửi mỗi cú nhấn thì nút
trông như hỏng chứ không phải chưa làm. SGR phân biệt bằng ký tự cuối (`M` nhấn, `m` nhả);
kiểu cũ không nói được nút nào được nhả nên dùng nút 3.

Phân biệt ba cử chỉ dùng chung một ngón tay:

| Cử chỉ | Xử lý |
|---|---|
| Chạm nhanh | gửi nhấn + nhả |
| Kéo để cuộn | `dragMoved` chặn cú `click` sinh ra ở cuối cú kéo |
| Giữ lâu bôi đen | đang có vùng chọn thì nhường, không gửi gì |

Pane **không** bật chuột thì bấm **không làm gì cả** — khác với cuộn, ở đây không có đường lùi
nào đáng dùng, và gửi byte vào shell thì chúng bị gõ thẳng vào dòng lệnh.

**Kiểm bằng một TUI tự khai báo** (`term/test/fixtures/mouse-echo.mjs`): chiếm màn hình phụ,
bật chuột SGR, rồi in ra thứ nó giải mã được. Test khẳng định `PRESS btn=0 col=37 row=11` và
`RELEASE` cùng toạ độ **thật sự tới nơi** — chứ không chỉ khẳng định một ứng dụng nào đó có
đổi màn hình, vốn chỉ là dấu hiệu gián tiếp.

**Đã xác nhận trên thiết bị thật** (2026-07-28): Huy chạm vào `Jump to bottom` trên iPhone và
nút kích hoạt. Phần này trước đó ghi là chưa kiểm được — bấm mò vào một phiên đang chạy có thể
trúng thứ khác, nên nó phải chờ một ngón tay thật. Xem
`docs/superpowers/specs/2026-07-28-nghiem-thu-dien-thoai.md`.

### 5D.3 Bôi đen để copy

`xterm.css` đặt `user-select: none` trên `.xterm`. Với terminal nhận bàn phím thì đúng, nhưng
terminal này **không bao giờ nhận bàn phím**, và trên điện thoại chính dòng đó làm giữ-lâu
không ra gì. Mở lại trên `.xterm-screen` và `.xterm-rows`; **KHÔNG** mở trên
`.xterm-helper-textarea` — chọn trúng nó là trao focus, và focus là thứ bật bàn phím ảo.

Cử chỉ kéo và cử chỉ bôi đen dùng chung một ngón tay, nên khi đã có vùng chọn thì trang
**nhường** — không cướp thành lệnh cuộn.

### 5D.4 Thanh phím

Thêm `←` `→` cạnh `↑` `↓`, và `⇧Tab` (CSI Z — chuỗi lùi lựa chọn trong danh sách của Claude
Code) đứng trước `^C`.

Harness test **tự dựng** thanh phím từ `KEY_BUTTONS`, nên nó có thể mô tả nút không tồn tại.
Một test đọc thẳng `index.html` và so khớp danh sách — nếu không có, mọi test nút khác vẫn
xanh cho một nút chỉ sống trong harness.

### 5D.5 Header cache — lỗi phát hiện khi gỡ rối chính việc cuộn

Daemon trước đây không gửi header cache nào, nên trình duyệt tự đặt hạn và **giữ `term.js` cũ
sau khi daemon đã cập nhật và khởi động lại**. Nó ngốn trọn một vòng gỡ rối: cử chỉ cuộn không
làm gì trên trình duyệt trong khi cùng đoạn code đó xanh ở test daemon — vì trang đang chạy
bản script hôm trước.

Nay: `no-cache` cho HTML/JS/CSS (vẫn được lưu, chỉ phải hỏi lại trước khi dùng), và
`immutable` cho font — nội dung font đã bị ghim bởi chính tên file.

## 6. Kết nối lại

Trên di động, đứt kết nối là **trạng thái bình thường**, không phải lỗi. iOS còn đóng băng
hẳn JS khi PWA xuống nền.

```
đứt                              →  xin vé mới  →  nối lại   (backoff 1s, 2s, 4s… tối đa 30s)
quay lại từ nền (visibilitychange) →  nối lại NGAY, bỏ qua backoff
```

Nối lại xong, client tmux mới vẽ lại toàn màn hình — thấy đúng chỗ cũ vì tmux giữ trạng
thái. Trong lúc đó PWA hiện rõ **"đang nối lại…"**, không im lặng.


### 6.1 Phiên đóng hẳn — phân biệt với đứt mạng (bổ sung 2026-07-28)

Đứt mạng và phiên đóng nhìn từ trình duyệt là **giống hệt nhau**: socket rớt, hết. Nhưng với
người cầm điện thoại thì trái ngược — một cái nên thử lại, một cái không bao giờ nối lại được.
Không phân biệt thì trang quay vòng backoff vĩnh viễn với một daemon đã chết.

Cách phân biệt: daemon đóng client bằng **mã 4001** (dải 4000–4999 dành cho ứng dụng) kèm lý do
`phiên đã đóng`. Trang thấy mã đó thì:

- **không** hẹn nối lại
- xoá khoá phiên trong `sessionStorage` — nó thuộc về một daemon không còn tồn tại
- hiện: *"Phiên đã đóng trên máy — mở lại bằng /remote on rồi vào lại từ ứng dụng."*

Mã 4001 được viết ở **hai chỗ**, hai ngôn ngữ, không trình biên dịch nào đối chiếu: có một test
đọc cả hai file và so — lệch nhau là im lặng, trang lại quay về nối lại vô tận.



**Sai lần đầu: 1011 thắng 4001.** Khi tiến trình `tmux -C` của một kết nối chết, `onCtlGone`
đóng socket bằng 1011 *rồi mới* gọi `shutdown()`. Socket đã ở trạng thái đang đóng nên lệnh
`close(4001)` trong `shutdown()` thành vô hiệu — trình duyệt đọc 1011 là "trục trặc, thử lại đi"
và nối lại đúng như trước khi có mã 4001.

Phải quyết định "hỏng tạm" hay "hết phiên" **trước** khi đóng: group session biến mất mà pane
vẫn sống thì mới là 1011; pane không còn thì để `shutdown()` nói bằng 4001.

Test cũ không thấy vì nó bắn SIGTERM — đường của `/remote off`, ở đó `shutdown()` chạy trước và
4001 kịp đi. Đường thường ngày là **pane chết**, và ở đó thứ tự ngược lại.

Dựng lại được đường đó cũng mất hai lần sai, cùng một khuôn với §5D.2b:

- `kill-session` phiên chứa pane: **không mô phỏng được gì**. Phiên nhóm của daemon vẫn liên kết
  cùng window nên pane sống tiếp, daemon không thấy có chuyện gì. Phải `kill-pane`.
- Giết ngay sau khi socket mở: đo trúng đường *dựng kết nối hỏng* (`ws.close(1011, 'pane đã
  chết')` lúc thiết lập), không phải đường *phiên đang chạy thì kết thúc*. Phải đợi phiên nhóm
  dựng xong đã.
**Không đóng được tab, nên quay lại danh sách.** `window.close()` chỉ chạy với cửa sổ *do script
mở ra*; trang này được mở bằng `location.href` từ danh sách phiên (`server/public/app.js:164`) —
cùng một tab. Với PWA cài ra màn hình chính lại còn không có tab nào để đóng, và đóng được cũng
chỉ ra màn hình trắng.

Vì terminal nằm **đè lên** danh sách trong cùng tab, thứ tương đương là quay lại: hiện lý do,
1,5 giây sau `history.back()`, kèm nút *"← Quay lại danh sách"* cho ai không muốn đợi.

Điều kiện: phải có chỗ để quay về. `document.referrer` **không dùng được** — hub chạy https còn
trang này chạy http trên IP tailnet, và chính sách referrer mặc định không gửi gì khi hạ cấp
https → http. Dùng `history.length > 1`: mở thẳng URL (gõ tay, bookmark) thì bằng 1, lúc đó giữ
nguyên câu hướng dẫn thay vì hứa một việc `history.back()` sẽ im lặng không làm.
### 6.2 `ccrc` trong một phiên tmux có sẵn

`ccrc` mở phiên tmux riêng thì lời hứa "đóng Claude là đóng terminal web" tự đúng: phiên tmux
chỉ chạy một lệnh, lệnh thoát là phiên chấm dứt, daemon thấy pane chết và tắt.

Chạy `ccrc` khi **đã ở trong tmux** thì không. Đo trên máy thật: Claude thoát, `pane_current_command`
thành `zsh`, pane vẫn sống, daemon vẫn chạy — nghĩa là điện thoại nhìn thấy, và **gõ được vào**,
shell trần của người dùng.

Phiên tmux đó là của người dùng, có thể còn cửa sổ khác đang làm việc, nên đóng nó là sai. Thứ
đóng được và đúng thứ cần đóng là **remote của chính pane này**: nhánh đó chạy claude (không
`exec` — `exec` thay tiến trình thì phần dọn dẹp không bao giờ chạy), giữ mã thoát, rồi gọi
`ccrc-term-cli off`. Im lặng khi vốn đã tắt; chỉ lên tiếng khi **không** tắt được, vì lúc đó
điện thoại vẫn còn với tới được cái shell vừa hiện ra.

## 7. Xử lý lỗi

Phần thông báo cố tình **hỏng im lặng** (hook nuốt mọi lỗi để không quấy Claude Code).
Terminal **ngược lại hoàn toàn** — người dùng đang ngồi nhìn và chờ, nên im lặng là tệ nhất.

| Hỏng | PWA hiện gì |
|---|---|
| Vé hết hạn / sai | Tự xin vé mới một lần. Vẫn hỏng → *"Phiên đã đóng — gõ `/remote on` trên máy"* |
| Daemon chết, cổng đã đóng | *"Máy không phản hồi — có thể đã ngủ, hoặc `/remote` đã tắt"* |
| **Điện thoại không ở trong tailnet** | *"Không vào được mạng Tailscale — mở app Tailscale trên điện thoại và bật lên"*. Đây là lỗi mới do D2 sinh ra và sẽ gặp thường xuyên, nên phải phân biệt được với "máy đã ngủ" |
| Pane tmux chết | Hub xoá thẻ → *"Phiên đã kết thúc"* |
| Máy ngủ hoặc tắt | Nhịp tim ngừng → thẻ chuyển *"không phản hồi"* sau 60 giây |
| Token cá nhân sai | Về màn đăng nhập |
| Chạy `/remote` ngoài tmux | Báo lỗi rõ ngay trên CLI, **không bật gì cả** |

## 8. Kiểm thử

**Tầng 1 — hàm thuần** (`node:test`, không thêm dependency): ký vé, kiểm hết hạn, nonce đã
dùng, chữ ký sai, dựng chuỗi bracketed paste.

**Tầng 2 — tích hợp**: daemon với tmux thật — đăng ký pane, giết pane rồi xác nhận tunnel
đóng; hub cấp vé đúng/sai; vé của phiên này **không** mở được phiên khác.

**Tầng 3 — nghiệm thu tay trên thiết bị thật** (Huy có cả hai máy, D9):

| Kiểm | iPhone | Android |
|---|---|---|
| Gõ tiếng Việt có dấu → tới Claude nguyên vẹn | ☐ | ☐ |
| Lệnh shell không bị viết hoa / tự sửa | ☐ | ☐ |
| Bàn phím bật lên **không che** ô soạn | ☐ | ☐ |
| Bàn phím tắt → terminal trở lại đầy màn | ☐ | ☐ |
| `Esc` ngắt được Claude đang chạy | ☐ | ☐ |
| `↑` `↓` `⏎` chọn được phương án trong AskUserQuestion | ☐ | ☐ |
| Đoạn nhiều dòng gửi **nguyên khối**, không cắt giữa chừng | ☐ | ☐ |
| Khoá màn hình 5 phút → mở lại tự nối, đúng chỗ cũ | ☐ | ☐ |
| Đổi wifi ↔ 4G → tự nối lại | ☐ | ☐ |
| **Chữ trên điện thoại đọc được, không xuống dòng chồng chữ** — xem đính chính §5.5 ngày 2026-07-28: hàng này trước đó ghi "màn hình máy tính không bị co khi điện thoại nối vào", đúng theo `window-size largest` nhưng lại là chính lỗi khiến điện thoại không đọc được; máy tính co lại trong lúc điện thoại đang mở giờ là HÀNH VI ĐÚNG, không phải điều cần kiểm | ☐ | ☐ |
| `/remote off` → PWA báo phiên đã đóng | ☐ | ☐ |

## 9. Bước 0 — đo trước khi viết dòng code nào

**Đã đo xong, kết quả ở `docs/superpowers/specs/2026-07-27-buoc-0-ket-qua.md`:**

1. **Phiên nhóm tmux** (`new-session -t`) giữ kích thước độc lập — **ĐẠT**. Phiên gốc giữ
   nguyên 200x50 sau khi client 40 cột nối vào, nên §5.5 dùng được.
2. **`tmux -C` control mode** stream được output qua stdio — **ĐẠT**. Không cần `node-pty`.
3. ~~Cú pháp tắt `tailscale serve`~~ — **KHÔNG CÒN LIÊN QUAN**. D2c bỏ hẳn `serve`.

**Còn phải đo, cần điện thoại đã cài Tailscale:**

4. **Độ ổn định WebSocket qua tailnet** qua nhiều giờ, và **PWA/trang terminal trên iOS**
   có nối lại được sau khi vào nền lâu không.

## 10. Điểm chưa kiểm chứng khác

1. **Claude Code TUI trên màn hình ~390px** — số thứ tự lựa chọn và hộp xin quyền có vỡ
   không. Chưa đo.
2. **Hao pin và dung lượng 4G** khi giữ phiên lâu. Chưa đo.
3. **Hook `SessionEnd`** có thật sự bắn khi người dùng thoát Claude Code bằng Ctrl-D hay
   đóng cửa sổ không — dữ liệu cũ chỉ cho biết nó hiếm, không cho biết điều kiện.

## 11. Cố ý KHÔNG làm

Ghi lại để lần sau không ai tưởng là bỏ sót:

- **Không** chế độ gõ trực tiếp từng phím ⇒ không dùng được vim, htop, lazygit (D5)
- ~~**Không** quản lý nhiều phiên — đúng một phiên, do `/remote` chỉ định (D5)~~ →
  **ĐÃ ĐẢO 2026-07-28, xem D5c.** Nay chạy được **nhiều phiên cùng lúc**: mỗi pane một
  daemon, mỗi daemon một cổng do OS cấp và một `sessionId` riêng, PWA hiện thành danh
  sách thẻ. Vẫn giữ nguyên D5b — mỗi daemon chỉ attach **đúng một pane**
- **Không** tự tắt theo thời gian (D7)
- **Không** truyền file
- **Không** dùng `caffeinate` hay bất cứ lệnh riêng hệ điều hành nào (D8)
- **Không** `tailscale serve`, **không** xin chứng chỉ TLS, **không** Funnel — mọi thứ đưa dữ liệu ra ngoài tailnet đều bị loại (D2c)
- **Không** nhúng terminal trong PWA — hệ quả trực tiếp của D2c, không phải bỏ sót (D3)
- **Thiết kế trung lập hệ điều hành**, nhưng **chỉ macOS được kiểm chứng**. Linux về nguyên
  tắc chạy được; Windows cần WSL vì tmux không có bản Windows thuần. **Không được ghi "hỗ
  trợ Linux/Windows"** cho tới khi có người chạy thật.

## 12. Đã biết, chưa xử lý

Ghi lại để không ai tưởng là bỏ sót.

**1. `window-size largest` lan sang phiên gốc và ở lại sau khi tắt.** Daemon đặt tuỳ chọn
này trên phiên nhóm, nhưng tmux **chia sẻ nó cho cả nhóm**, nên phiên thật của người dùng
giữ `largest` cả sau khi `/remote off`. Đây là một thay đổi âm thầm lên cấu hình tmux của
họ mà hệ thống không hề báo. Chưa sửa. Muốn sạch thì phải lưu giá trị cũ lúc bật và khôi
phục lúc tắt.

**2. ~~Một phiên nhóm có dấu bị thu hồi kể cả khi một daemon khác đang sở hữu nó.~~ ĐÃ
SỬA 2026-07-28.** Không còn "chỉ tiềm ẩn" nữa: khi cổng thành động, hai pane của **cùng
một** phiên tmux suy ra cùng một tên phiên nhóm ứng viên, và daemon thứ hai giết phiên
nhóm **đang sống** của daemon thứ nhất rồi chiếm tên. `claimGroupName` và
`reclaimPaneSession` nay so `RUN_ID` trong dấu `@ccrc_group`: chỉ thu hồi phiên nhóm của
**chính lần chạy này**, hoặc của một lần chạy mà tiến trình đã chết; gặp phiên nhóm của
một daemon còn sống thì lùi sang tên kế tiếp (`-2`, …). Xem `isReclaimableMarker` trong
`term/src/tmux.js`.

**3. Không có ping/pong WebSocket.** Điện thoại mất sóng mà không kịp gửi FIN sẽ ghim tiến
trình `tmux -C` con và giữ phiên nhóm sống tới khi `/remote off`.

**4. `SessionEnd` không được cài đặt** — xem §4.2. Claude thoát mà pane còn sống thì daemon
vẫn phục vụ, không có tín hiệu nào.
