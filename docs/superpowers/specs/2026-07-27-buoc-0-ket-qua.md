# Bước 0 — kết quả đo (2026-07-27)

## Đo 1: phiên nhóm tmux giữ kích thước độc lập
Lệnh: `./tools/measure-tmux-group.sh`
Output nguyên văn:
```
phiên gốc: 200x50
sau khi phone nối vào — gốc: 200x50 | phone: 200x50
KẾT LUẬN: ĐẠT — kích thước độc lập, thiết kế §5.5 dùng được
```
Kết luận: ĐẠT
Hệ quả: spec §5.5 dùng được — phiên gốc (200x50) không bị co lại khi một client thứ hai
(giả lập điện thoại, 40x30) nối vào cùng phiên nhóm, kể cả khi bật
`aggressive-resize on`.

## Đo 2: tmux control mode
Lệnh: `node tools/measure-tmux-control.mjs`
Output nguyên văn:
```
có dòng trueutput:
thấy chuỗi nhận dạng: true
KẾT LUẬN: ĐẠT — dùng control mode, KHÔNG cần node-pty
--- 600 ký tự đầu của stdout ---
%begin 1785132941 306 0
%end 1785132941 306 0
%session-changed $0 ccrc-ctl-50510
%begin 1785132942 311 1
%end 1785132942 311 1
%output %0 echo CCRC_MARKER_OK\015
%output %0 \012
%output %0 \033[1m\033[3m%\033[23m\033[1m\033[
%output %0 0m                                      
%output %0                     
%output %0                     
%output %0  \015 \015
%output %0 \033k..emote-control\033\134
%output %0 \033]7;file://192.168.1
%output %0 .10/Users/dev/projects/per
%output %0 sonal/cc-remote-cont
%output %0 rol\033\134
%output %0 \015\033[0m\033[23m\033[24m\033[J\033[0m\033
```
Ghi chú: dòng đầu tiên in ra là `có dòng trueutput:` thay vì `có dòng %output: true` —
đây là hiệu ứng phụ của `console.log('có dòng %output:', hasOutput)` trong chính script
đo (đúng nguyên văn theo brief): Node.js diễn giải `%o` trong chuỗi định dạng như một
format specifier và thay bằng giá trị `hasOutput` (`true`), phần `utput:` còn lại bị dính
vào sau. Đây là lỗi hiển thị vô hại của script đo, không ảnh hưởng tới kết quả đo: biến
`hasOutput` và `hasMarker` bên dưới đều là `true`, control mode có phát dòng `%output`
chứa chuỗi nhận dạng `CCRC_MARKER_OK`.

Kết luận: ĐẠT
**Quyết định dependency:** chỉ `ws` — `tmux -C` (control mode) stream được output của
pane qua stdio (thấy dòng `%output %0 ...` chứa `CCRC_MARKER_OK` sau khi gửi
`send-keys`), nên daemon không cần `node-pty` (native module, phải build).

## Đo 3: cú pháp TẮT của tailscale serve
**CHƯA ĐO — chặn bởi: tailnet chưa bật HTTPS Certificates.**

Bằng chứng (chạy trên máy này, không sửa cấu hình gì):
```
$ /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json | python3 -c "..."
BackendState: Running
Self.DNSName: may-dev.tailnet-example.ts.net.

$ /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status --json
{}

$ /Applications/Tailscale.app/Contents/MacOS/Tailscale cert may-dev.tailnet-example.ts.net
500 Internal Server Error: your Tailscale account does not support getting TLS certs
```

`tailscale serve` cần cấp chứng chỉ TLS qua HTTPS Certificates của tailnet; tài khoản này
chưa bật tính năng đó trong admin console (một cài đặt tài khoản/quản trị, không sửa được
từ máy này). Vì lệnh `serve` sẽ thất bại ngay ở bước cấp chứng chỉ, và vì rủi ro của
`serve reset` xoá mất cấu hình serve khác của người dùng, **không chạy `tailscale serve`
ở bước đo này** — kể cả không thử nghiệm cú pháp bật/tắt.

Cấu hình serve có sẵn trước khi đo (đọc, không sửa): `{}` (rỗng — hiện chưa có gì để làm
mất).

Cú pháp tắt được đúng phần của mình: KHÔNG ĐO ĐƯỢC (bị chặn ở bước trước đó — chưa từng
bật serve nên chưa thử tắt).

**Hệ quả cho Task 4:** chưa xác định được — phải đo lại Đo 3 sau khi Huy bật HTTPS
Certificates trong admin console của tailnet
(https://login.tailscale.com/admin/dns → "HTTPS Certificates"). Task 4 KHÔNG được giả
định cú pháp tắt cho tới khi có kết quả đo thật; nếu buộc phải triển khai trước, Task 4
nên tự lưu lại cấu hình serve cũ (đã biết là rỗng `{}` tính đến thời điểm đo này) và có
kế hoạch khôi phục, phòng khi cách tắt duy nhất là `serve reset`.

## Đo 4: độ ổn định WebSocket qua tailnet
**CHƯA ĐO — chặn bởi: tailnet chưa bật HTTPS Certificates.**

Đo này phụ thuộc `tailscale serve --bg 8731` để lấy URL `wss://` công khai trong tailnet
— cùng một giới hạn tài khoản như Đo 3 (bằng chứng đã dẫn ở trên). Chưa dựng được
echo-server công khai qua tailnet nên chưa thể đo độ ổn định kết nối từ thiết bị khác.

Thời gian giữ kết nối: CHƯA ĐO
Số lần đứt: CHƯA ĐO
Kết luận: CHƯA ĐO — chặn bởi: tailnet chưa bật HTTPS Certificates

## Việc cần Huy làm để mở khoá Đo 3 và Đo 4
Bật "HTTPS Certificates" cho tailnet trong admin console
(https://login.tailscale.com/admin/dns), sau đó chạy lại Đo 3 và Đo 4 theo đúng các bước
trong `task-1-brief.md` (Step 5 và Step 5b).

---

## Đo 3 — BỔ SUNG, đo ngày 2026-07-27 lúc 13:47

Câu hỏi cần trả lời: có cách nào tắt serve **chỉ phần của mình** mà không dùng
`serve reset` (lệnh xoá toàn bộ cấu hình serve, kể cả của người dùng khác)?

Trạng thái trước khi đo: `tailscale serve status --json` → `{}` (trống, không có gì để mất).

Lệnh và output nguyên văn:

```
$ /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off
error: failed to remove web serve: handler does not exist

2026/07/27 13:47:10 try `tailscale serve --help` for usage info

$ /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status --json
{}
```

**Kết luận: ĐẠT.** `serve --https=443 off` **vẫn là cú pháp hợp lệ** trên 1.98.8 — thông báo
lỗi là `handler does not exist`, tức lệnh được nhận và nhắm vào **một handler cụ thể**, chứ
không phải `unknown flag`. Nếu cú pháp đã bị bỏ thì CLI sẽ báo lỗi cờ không hợp lệ.

**Hệ quả cho Task 4:** `serveStop` dùng `serve --https=443 off` và nuốt lỗi — đúng như kế
hoạch viết. **KHÔNG** cần lưu/khôi phục cấu hình cũ, **KHÔNG** cần `serve reset`.

**Chưa chứng minh được:** rằng nó chỉ gỡ đúng mount của mình khi trên máy có nhiều mount
cùng lúc. Muốn dựng nhiều mount thì phải bật serve thật, mà việc đó cần HTTPS Certificates —
vẫn đang chặn. Rủi ro còn lại nhỏ: thông báo `handler does not exist` đã cho thấy lệnh làm
việc ở mức từng handler chứ không phải toàn cục.


---

## ⚠️ ĐÍNH CHÍNH Đo 1 — bổ sung ngày 2026-07-27, sau Task 5 Kế hoạch 2

Đo 1 kết luận ĐẠT, và **đúng với thứ nó đo**: tạo phiên nhóm bằng `new-session -t` rồi so
kích thước hai phiên. Nhưng nó đo trong tình huống **không có client `tmux -C` sống gắn ở
cả hai đầu** — mà đó mới là hình dạng lúc chạy thật.

Đo lại có client thật ở cả hai phía (Task 5, và một reviewer độc lập tái hiện):

- Chỉ `aggressive-resize on` → phiên gốc **CO từ 200x50 xuống 40x30**. Không cô lập được.
- Thêm `window-size largest` trên phiên nhóm → phiên gốc giữ nguyên 200x50.

**Cơ chế:** mặc định của tmux là `window-size latest` (kiểm bằng
`tmux show-options -g window-size`). `aggressive-resize` chỉ chi phối hành vi khi **chuyển
giữa các cửa sổ**, không chi phối việc lan kích thước giữa các client đang gắn. Thiết lập
thực sự chịu lực là `window-size largest`.

**Bài học ghi lại:** một phép đo có thể đúng về điều nó đo và vẫn thiếu điều mình cần. Đo 1
không sai — nó chỉ không dựng đúng hình dạng lúc chạy. Khi thiết kế phép đo, câu hỏi phải
là "tình huống thật trông thế nào" chứ không phải "cơ chế này có tồn tại không".

Xem thêm: spec §5.5 (đã đính chính, commit `78c0712`).

---

## ⚠️ ĐÍNH CHÍNH THỨ HAI Đo 1 — bổ sung ngày 2026-07-28, sau khi dùng thử trên điện thoại thật

Đính chính ở trên (2026-07-27) sửa lại CÁCH đo cho đúng hình dạng lúc chạy, nhưng không ai
hỏi lại CÂU HỎI mà Đo 1 đặt ra ngay từ đầu: "phiên gốc có giữ nguyên kích thước không?" —
tức mặc định coi "giữ nguyên cho máy tính" là mục tiêu đúng, rồi đo xem đạt hay không đạt.
Với `window-size largest`, câu trả lời là ĐẠT, và toàn bộ §5.5 được xây trên đó.

Dùng thử trên điện thoại thật (Huy, ngày 2026-07-28) lộ ra: đó là câu hỏi SAI cần tối ưu.
`window-size largest` giữ đúng như đo — phiên gốc không co — nhưng cái giá của việc giữ đó
là điện thoại nhận cửa sổ theo kích thước máy tính (~200 cột) trong khi màn hình nó chỉ có
~40, chữ tự xuống dòng, chồng lên nhau, không đọc nổi. Đo 1 (và đính chính đầu) đã trả lời
đúng câu hỏi "máy tính có bị co không" — nhưng không có phép đo nào ở giai đoạn Bước 0 từng
hỏi "vậy điện thoại nhìn thấy gì?". Tối ưu đúng một phía của một đánh đổi hai bên,
không đo phía còn lại, thì kết luận ĐẠT vẫn có thể là ĐẠT cho câu hỏi sai.

Quyết định (Huy chốt): đảo `window-size` từ `largest` sang `smallest` — điện thoại quyết
định kích thước cửa sổ dùng chung, máy tính co lại tạm thời trong lúc điện thoại đang mở
(và tmux tự trả lại kích thước khi điện thoại ngắt — đo trực tiếp, xem `term/src/tmux.js`).
Xem spec §5.5 (đính chính ngày 2026-07-28) và `term/test/tmux.test.js`,
`term/test/daemon.test.js` cho phần đo lại theo chiều mới.

**Bài học ghi lại (lần hai):** một phép đo có thể trả lời đúng câu hỏi nó tự đặt ra và vẫn
dẫn tới quyết định sai, nếu câu hỏi đó chỉ nhìn một phía của một đánh đổi. "Phiên gốc có giữ
nguyên kích thước không" là câu hỏi lấy máy tính làm trung tâm, trong khi tính năng này được
xây ra để phục vụ điện thoại — thiết bị người dùng thực sự cầm trên tay lúc dùng nó.
