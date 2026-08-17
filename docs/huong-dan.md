# CC Remote Control — hướng dẫn sử dụng

Dành cho người dùng mới. Đọc hết mất khoảng 10 phút; cài đặt mất khoảng 15 phút.

Bạn tự dựng hub? Đọc [`self-hosting.md`](self-hosting.md) (tiếng Anh) thay vì file này.

> 🇬🇧 English version: [`user-guide.md`](user-guide.md)

> **`<hub-cua-ban>` trong tài liệu này là một chỗ trống, không phải địa chỉ có thật.**
> Thay bằng domain hub của đội bạn — người dựng hub sẽ đưa cho bạn, dạng
> `ccrc.congty.vn`. Mỗi đội một hub riêng: dự án này không vận hành hub dùng chung
> nào cả, nên không có địa chỉ mặc định nào để điền sẵn.
>
> Gõ nguyên cả dấu ngoặc nhọn vào terminal thì lệnh sẽ hỏng — bỏ chúng đi luôn.

---

## 1. Hệ thống này làm gì

Bạn chạy Claude Code trên máy tính. Claude làm việc một lúc rồi **dừng lại chờ bạn** —
hỏi một câu, hoặc xin phép chạy một lệnh. Nếu lúc đó bạn đang đi pha cà phê, nó cứ đứng đó.

Hệ thống làm hai việc, độc lập nhau:

**1. Báo.** Claude dừng lại chờ → điện thoại bạn rung.

**2. Trả lời ngay từ điện thoại.** Mở một terminal web trỏ đúng vào phiên Claude đang chạy.
Đọc được, gõ được, trả lời được — rồi cất điện thoại đi.

Nó **không** phải là mirror màn hình, cũng **không** phải chat bot. Mỗi terminal web gắn đúng
một pane tmux, không tự mở thêm cửa sổ nào.

### Hai phần này cần điều kiện khác nhau

| | Báo (phần 1) | Terminal web (phần 2) |
|---|---|---|
| Cần Tailscale | ❌ không | ✅ **bắt buộc**, cả máy tính lẫn điện thoại |
| Cần tmux | ❌ không | ✅ **bắt buộc** |
| Đi qua đâu | máy bạn → hub → điện thoại | máy bạn → **thẳng** điện thoại |

Nghĩa là: **bạn có thể dùng phần 1 ngay hôm nay** dù chưa cài Tailscale, chưa quen tmux.
Phần 2 cài sau cũng được.

---

## 2. Cần chuẩn bị

- **Node.js** (bất kỳ bản nào còn được hỗ trợ)
- **Claude Code** đang chạy được trên máy
- **Tài khoản Slack công ty** — bạn tự đăng nhập, không phải xin ai cấp token
- **Điện thoại** iPhone hoặc Android
- *(chỉ cho phần 2)* **tmux**, và **Tailscale** — **tài khoản riêng của bạn**, không dùng
  chung với ai. Xem mục 6 để hiểu vì sao.

---

## 3. Cài trên máy tính

### Cách nhanh — một lệnh

```bash
curl -fsSL https://<hub-cua-ban>/install.sh | CCRC_HUB_URL=https://<hub-cua-ban> sh
```

Không cần token, không cần git, không cần quyền truy cập repo — lệnh tự tải code về.

**Vì sao địa chỉ hub phải viết hai lần:** lần đầu là để tải script, lần sau là để nói cho
script biết nó phục vụ hub nào. Nghe thừa, nhưng script chạy trên máy bạn thì không có cách
nào biết nó vừa được tải về từ đâu. Bỏ `CCRC_HUB_URL=` đi thì nó dừng ngay với
`✗ Thiếu URL hub.` — cố ý, vì đoán bừa một hub là gửi token của bạn tới nhầm chỗ.

Nó sẽ in ra một **mã 8 ký tự** rồi đứng chờ:

```
  Duyệt mã này trong app CC Notify trên điện thoại:
  thẻ "Duyệt máy dev" → Mở → nhập mã.
  Chưa cài app thì mở https://<hub-cua-ban>/link trên trình duyệt đã đăng nhập.

      K7M2-QX9F

  Đang chờ duyệt (tối đa 600 giây)…
```

**Cách nhanh nhất là duyệt ngay trong app trên điện thoại** — không cần mở trình duyệt:

1. Mở app CC Notify
2. Thẻ **Duyệt máy dev** → bấm **Mở**
3. Gõ mã, bấm **Duyệt**

Terminal tự nhận token trong vài giây và in tên người vừa duyệt:

```
  ✓ Đã nhận token của nguyen-van-a.
```

**Đọc dòng tên đó.** Nếu nó không phải bạn thì có người khác vừa duyệt nhầm mã của bạn — máy
này vừa ghi token của họ. Chạy `curl -fsSL https://<hub-cua-ban>/uninstall.sh | sh` rồi cài
lại.

**Địa chỉ `/link` vẫn còn** cho ai muốn duyệt từ trình duyệt trên máy tính. Nhưng nếu bạn đã
cài app vào màn hình chính thì đừng đi đường đó: app và trình duyệt là **hai phiên đăng nhập
riêng biệt** (iOS giữ cookie tách hẳn), nên mở `/link` trong Safari sẽ bắt bạn đăng nhập lại
từ đầu. Duyệt trong app là xong.

Sau đó nó hỏi **tên máy** (hiện trong thông báo). Có tên gợi ý trong ngoặc vuông thì Enter là
lấy tên đó. **Không phải máy nào cũng có gợi ý:** máy lấy IP làm hostname (`hostname` ra
`192.168.x.x`) thì script bỏ gợi ý đi — một cái tên toàn số chẳng phân biệt được máy nào với
máy nào — và Enter suông sẽ bị hỏi lại. Cứ gõ tên bạn nhận ra được, ví dụ `MacBook của Kiên`.

Muốn đọc script trước khi chạy — hoàn toàn hợp lý, vì nó chạy trên máy bạn:

```bash
curl -fsSL https://<hub-cua-ban>/install.sh -o install.sh
less install.sh
CCRC_HUB_URL=https://<hub-cua-ban> sh install.sh
```

**Chưa đăng nhập được Slack?** Người quản trị hub cấp cho bạn một token tay, rồi:

```bash
curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token-cua-ban> https://<hub-cua-ban>
```

Có token thì script bỏ qua hẳn bước mã ngắn. Địa chỉ hub đứng sau token — cùng lý do đã nói ở
trên, script không tự biết nó được tải về từ đâu.

**Lệnh này đụng vào đúng năm chỗ, không gì khác:**

| Chỗ | Nội dung |
|---|---|
| `~/.local/share/ccrc` | Code |
| `~/.ccrc/config` | URL hub, token, tên máy (chmod 600) |
| `~/.claude/commands/` | Hai slash command `/notify` và `/remote` |
| `~/.claude/settings.json` | **Thêm một** entry hook — các hook sẵn có của bạn giữ nguyên |
| cạnh lệnh `claude` | Lệnh `ccrc` (xem mục 6) |

Gỡ sạch bất cứ lúc nào:

```bash
curl -fsSL https://<hub-cua-ban>/uninstall.sh | sh
```

### Cách còn lại — từ bản git clone

Nếu bạn có repo trên máy, vào thư mục đó rồi chạy:

```bash
./setup-notify.sh
```

Nó hỏi:

| Hỏi | Trả lời |
|---|---|
| URL hub | `https://<hub-cua-ban>` |
| Tên máy hiện trong thông báo | tên bạn nhận ra được, ví dụ `MacBook của Kiên` |

Phần token nó **không hỏi** — cũng in mã 8 ký tự và chờ bạn duyệt trong app (hoặc ở `/link`)
như cách nhanh bên trên. Máy nào đã cài trước đó thì nó dùng lại token cũ, không bắt duyệt lại.

Xong nó sẽ:

- ghi `~/.ccrc/config` (chmod 600 — chỉ bạn đọc được)
- cài slash command `/notify` và `/remote`
- cài hook `Notification` vào Claude Code
- đặt thông báo ở trạng thái **TẮT** (cố ý — bạn tự bật khi sắp rời máy)

**Tên máy dùng để làm gì:** nó xuất hiện trên thông báo và trên thẻ terminal. Chạy nhiều máy
thì đây là cách phân biệt.

---

## 4. Cài trên điện thoại

### iPhone

1. Mở **Safari** (phải là Safari, không dùng Chrome), vào `https://<hub-cua-ban>`
2. Nút Chia sẻ → **Thêm vào màn hình chính**
3. **Mở app từ icon vừa thêm** — không mở lại bằng Safari
4. Bấm **Đăng nhập bằng Slack**
5. Bấm **Bật thông báo trên thiết bị này**, cho phép khi iOS hỏi

⚠️ **Bước 2 và 3 là bắt buộc, không phải gợi ý.** iOS chỉ cho phép thông báo đẩy với web app
đã thêm vào màn hình chính và mở từ đó. Mở bằng Safari thì nút bật thông báo sẽ không hoạt
động.

### Android

Chrome → vào `https://<hub-cua-ban>` → Chrome tự mời cài app → **Đăng nhập bằng Slack** →
bật thông báo. Không bắt buộc cài, nhưng cài thì tiện hơn.

### Đăng nhập bằng Slack làm gì

Hub hỏi Slack xem bạn là ai, rồi tự cấp cho bạn một token riêng của nó. **Hub không bao giờ
giữ mật khẩu Slack hay bất cứ thứ gì mở được tài khoản Slack của bạn** — nó chỉ nhận về một
cái tên.

Đăng nhập lại trên máy khác vẫn ra **đúng token cũ**, nên điện thoại và các máy dev của bạn
không đá nhau. Đổi tên hiển thị trên Slack cũng không mất gì: hub khoá theo id Slack, không
khoá theo tên.

### App và trình duyệt là hai phiên đăng nhập riêng

Đăng nhập trong app **không tính** cho Safari, và ngược lại — iOS giữ cookie của web app đã
cài tách hẳn khỏi trình duyệt. Nên đừng ngạc nhiên khi mở `https://<hub-cua-ban>` bằng
Safari lại thấy màn hình đăng nhập dù trong app bạn đang đăng nhập sẵn.

Đăng nhập ở cả hai chỗ cũng **không sao**: hub khoá theo id Slack nên nó trả lại **đúng token
cũ**, không cấp token mới. Chỉ là bạn không cần làm vậy — mọi việc thường ngày, kể cả duyệt
máy dev, đều làm được trong app.

### Kiểm tra

Về máy tính, chạy `/notify`. Phải thấy **1 thiết bị**. Nếu thấy cảnh báo "chưa có thiết bị nào
đăng ký" thì bước bật thông báo trên điện thoại chưa thành công — làm lại mục 4.

---

## 5. Dùng hằng ngày — phần Báo

Gõ trong Claude Code:

| Lệnh | Việc |
|---|---|
| `/notify on` | Bật báo. Làm việc này khi bạn sắp rời máy. |
| `/notify off` | Tắt. |
| `/notify` | Xem trạng thái: đang bật hay tắt, hub có sống không, mấy thiết bị đã đăng ký. |

**Mặc định TẮT là cố ý.** Ngồi ngay trước máy mà điện thoại cứ rung thì phiền hơn là hữu ích.

Bạn sẽ nhận được thông báo khi:

- 🔔 Claude đang chờ bạn nhập
- 🔐 Claude cần bạn xác nhận (một câu hỏi, hoặc xin quyền chạy tool)

**Nội dung công việc không bao giờ được gửi đi.** Thông báo chỉ có tên máy, tên phiên, và một
trong hai câu trên. Nó nói *"có việc cần bạn"*, không nói *việc gì*.

---

## 6. Dùng hằng ngày — phần Terminal web

### Điều kiện

Claude Code phải **đang chạy bên trong tmux**. Bạn không cần biết tmux là gì — lệnh cài đã
tạo sẵn `ccrc`:

```bash
ccrc            # thay cho `claude`
```

`ccrc` dùng **y hệt** `claude`: mọi tham số như nhau (`ccrc --continue`, `ccrc -p "..."`, …),
chỉ khác là nó tự mở tmux. Đóng Claude thì phiên tmux tự đóng theo, không để lại gì.

Máy chưa có tmux thì lần đầu chạy `ccrc` sẽ hỏi có cài không. Từ chối cũng được — Claude vẫn
mở bình thường, chỉ là phiên đó không dùng `/remote` được.

Đã quen tmux rồi thì cách cũ vẫn chạy:

```bash
tmux
claude
```

Đang ở sẵn trong một phiên tmux mà gõ `ccrc` cũng được: nó chạy thẳng trong pane đó, không lồng
thêm phiên nào. Đóng Claude thì nó **tự tắt `/remote` của pane đó** — terminal trên điện thoại
đóng theo, không ai gõ được vào cái shell vừa hiện ra.

### Tailscale — mỗi người một tài khoản riêng

**Bạn tạo tài khoản Tailscale của riêng bạn** (gói cá nhân miễn phí là đủ), rồi cài lên
**máy tính của bạn** và **điện thoại của bạn**. Chỉ hai thiết bị đó. Không tham gia tailnet
của người quản trị, không mời ai vào tailnet của bạn.

Nghe có vẻ ngược — cùng một hệ thống mà mỗi người một mạng riêng thì nối vào nhau kiểu gì?
Câu trả lời: **không cần nối vào nhau**. Nội dung terminal chỉ đi từ máy bạn tới điện thoại
bạn. Không có luồng nào cần chạy giữa máy bạn và máy người quản trị. Thứ duy nhất dùng chung là hub
(`<hub-cua-ban>`) — nó nằm trên Internet công cộng và **không cần Tailscale**.

**Vì sao tách riêng lại quan trọng, chứ không chỉ là gọn:**

Từ 2026-07-29, hub không giữ khoá nào mở được phiên của bạn nữa — điện thoại tự ký yêu cầu,
máy dev tự xác minh bằng khoá học được lúc ghép cặp (chi tiết ở mục 8). Nhưng lý do dùng tài
khoản Tailscale riêng vẫn còn nguyên, chỉ đổi chỗ: đó là **công tắc ngắt của riêng bạn**. Gỡ
điện thoại khỏi tailnet của bạn là gỡ đường duy nhất nó dùng để chạm tới địa chỉ `100.x.x.x`
của máy bạn — có hiệu lực ngay lập tức, trên mọi máy dev bạn từng ghép cùng lúc.

Dùng chung một tailnet thì công tắc đó không còn của riêng bạn nữa: gỡ một thiết bị khỏi
tailnet chung nghĩa là đụng tới đường đi của mọi người trong đó, không chỉ của bạn, và phải
qua người quản trị tailnet đó thay vì tự làm ngay được.

*(Đây là quyết định D2b trong bản thiết kế, chốt từ đầu dự án — lý do ban đầu đã đổi cùng
việc hub thôi giữ khoá, nhưng kết luận vẫn giữ nguyên.)*

### Bật

```
/remote on
```

Kết quả:

```
✓ Remote ĐÃ BẬT
  Tên hiện trên web: k7m2
  URL: http://100.x.x.x:53812/
⚠ Máy ngủ là mất kết nối. Hãy đặt máy không ngủ trước khi rời đi.
```

`k7m2` là **id ngẫu nhiên**. Muốn dễ nhìn thì tự đặt tên:

```
/remote on api-thanh-toan
```

→ trên điện thoại hiện `api-thanh-toan` thay vì `k7m2`.

**Vì sao mặc định là id ngẫu nhiên:** nhãn này nằm trên màn hình khoá và trong mọi ảnh chụp
màn hình bạn gửi cho người khác. Trước đây nó là tên thư mục — tức là gọi tên dự án, đôi khi
gọi tên cả khách hàng. Thứ đã bị nhìn thấy thì không thu hồi được, nên tên thư mục **không
bao giờ rời khỏi máy bạn** nữa.

### Các lệnh khác

| Lệnh | Việc |
|---|---|
| `/remote` | Liệt kê mọi phiên đang mở của bạn, đánh dấu phiên hiện tại |
| `/remote off` | Tắt phiên của **pane hiện tại**, không đụng phiên khác |
| `/remote pair` | Bắt đầu ghép một điện thoại với **máy này** — xem mục 8 |
| `/remote pair xac-nhan <số>` | Bước hai: gõ số đọc được TRÊN ĐIỆN THOẠI để máy này ghi thiết bị — xem mục 8 |
| `/remote devices` | Liệt kê điện thoại đã ghép với máy này |
| `/remote unpair <số>` | Gỡ một điện thoại đã ghép — chỉ máy này, xem mục 8 |

Chạy **nhiều phiên cùng lúc** được — mỗi pane Claude một `/remote on`, trên điện thoại hiện
thành danh sách nhiều thẻ.

### Mở trên điện thoại

Mở app → mục **TERMINAL** → bấm **Mở terminal** trên thẻ tương ứng.

---

## 7. Màn hình terminal có gì

```
┌──────────────────────────────────────┐
│ đã nối                               │  ← trạng thái kết nối
│                                      │
│  (nội dung phiên Claude của bạn)     │
│                                      │
├──────────────────────────────────────┤
│ Esc  ↑  ↓  ←  →  ⏎  Tab  ⇧Tab  ^C   │  ← thanh phím
├──────────────────────────────────────┤
│ [ Nhắn cho Claude…            ] Gửi  │  ← ô soạn
└──────────────────────────────────────┘
```

**Ô soạn** để gõ câu trả lời. Gõ tiếng Việt có dấu bình thường, bàn phím dấu chạy đúng —
soạn xong bấm **Gửi**. Enter trong ô soạn là **xuống dòng**, không phải gửi; muốn gửi nhiều
dòng thì cứ gõ nhiều dòng rồi bấm Gửi một lần, cả khối vào nguyên vẹn.

**Thanh phím** để điều khiển:

| Nút | Dùng khi |
|---|---|
| `↑` `↓` | Chọn trong danh sách lựa chọn của Claude |
| `←` `→` | Di chuyển con trỏ |
| `⏎` | Xác nhận lựa chọn |
| `Tab` / `⇧Tab` | Chuyển lựa chọn tới/lui |
| `Esc` | Huỷ |
| `^C` | Dừng việc Claude đang chạy |

**Cuộn xem lại:** kéo ngón tay xuống trong vùng terminal để xem phần đã trôi qua, kéo lên để
về hiện tại. Đang xem quá khứ thì nội dung mới **được giữ lại chứ không mất** — về hiện tại
sẽ thấy đủ. Gõ phím bất kỳ cũng tự nhảy về hiện tại.

**Bấm được vào nút trong terminal:** Claude Code vẽ một số nút ngay trong màn hình
(`Jump to bottom`, các lựa chọn…). Chạm thẳng vào chúng là được — chạm nhanh thì tính là bấm,
còn kéo thì tính là cuộn, giữ lâu thì tính là bôi đen.

**Copy:** giữ lâu vào chữ để bôi đen, rồi Copy như bình thường.

**Icon dấu nhắc** (dải phân cách, thư mục, git, đồng hồ…) hiện đúng như trên máy — hệ thống
nhúng sẵn bộ icon Nerd Font. File này 2,4 MB nhưng **chỉ tải một lần cho mỗi thiết bị** rồi
nằm cache vĩnh viễn, và chỉ tải khi màn hình thật sự có icon. Lần đầu mở terminal qua 4G có
thể thấy icon xuất hiện chậm hơn chữ vài giây — sau đó thì không bao giờ chờ nữa.

Terminal **chỉ hiển thị**, không nhận phím trực tiếp — mọi thứ bạn gõ đều đi qua ô soạn hoặc
thanh phím. Đây là cố ý: bàn phím ảo tự bật lên giữa chừng là lỗi khó chịu nhất trên di động,
và cách này làm nó không tồn tại.

---

## 8. Riêng tư — cái gì đi đâu

| Thứ | Có rời khỏi máy bạn không |
|---|---|
| Nội dung terminal | ✅ nhưng **thẳng tới điện thoại bạn** qua Tailscale, hub không thấy một byte nào |
| Tên thư mục / đường dẫn | ❌ **không bao giờ** |
| Nội dung câu hỏi của Claude | ❌ không — thông báo chỉ nói "có việc cần bạn" |
| Tên máy, tên phiên bạn đặt | ✅ có, hiện trên thông báo và thẻ terminal |
| Khoá riêng — thứ duy nhất mở được phiên | ❌ **không rời điện thoại bạn**, kể cả lúc ghép cặp |

Hub chỉ giữ: bạn là ai, có những phiên nào đang mở, và — đúng 5 phút lúc bạn ghép cặp một
điện thoại — **khoá công khai** của điện thoại đó, rồi xoá. Khoá công khai không phải bí mật:
đúng bản chất mật mã bất đối xứng, nó chỉ dùng để xác minh chữ ký chứ không tự ký được gì, nên
một mình nó không mở được phiên nào. Thứ mở được phiên là khoá riêng, và khoá riêng thì không
bao giờ rời điện thoại bạn. Hub **không** giữ lịch sử hội thoại. Hub khởi động lại là mất hết
danh sách phiên — `/remote on` lại là xong.

Terminal chạy **HTTP thuần** trên IP Tailscale, không có HTTPS. Đây là **cố ý**: đường truyền
đã được Tailscale mã hoá sẵn, còn xin chứng chỉ HTTPS sẽ ghi tên máy bạn vào Certificate
Transparency log — một sổ công khai, vĩnh viễn, **không xoá được**.

Đang mở terminal của phiên nào trên điện thoại thì phiên đó **không bắn thông báo** (bạn đang
nhìn rồi, rung nữa là ồn). Khoá màn hình hoặc chuyển sang app khác là thông báo trở lại ngay.

### Người khác dùng chung hub có thấy gì của bạn không

Không. Hub tách theo người dùng: danh sách phiên, cuộc ghép cặp đang mở dở, thiết bị nhận thông
báo — mỗi thứ đều gắn với token của bạn, và token người khác không hỏi ra được.

### Người vận hành hub có xem được phiên của bạn không

Không — và từ 2026-07-29 thì đó là một sự thật kỹ thuật, không còn là một lời hứa.

Hub **không giữ khoá nào mở được phiên của bạn.** Điện thoại bạn tự ký yêu cầu mở terminal
bằng một khoá riêng nằm trong chính nó, và máy dev xác minh bằng khoá công khai nó học được
một lần duy nhất — lúc bạn ghép cặp. Hub chỉ chuyển tiếp mấy chuỗi trong lúc ghép, và nó
**chọn nó đang nói chuyện với điện thoại nào** — đó là lý do thứ bảo vệ bạn không phải là
"tráo chuỗi sẽ lộ ra" (một hub có thể chuyển hướng cả cuộc ghép sang điện thoại của kẻ tấn
công một cách trung thực, không tráo gì cả), mà là: **chính bạn đọc số trên điện thoại của
mình rồi gõ nó vào máy dev, và máy dev từ chối bất cứ số nào khác.** Xem cách làm ở mục
"Ghép cặp điện thoại với một máy" ngay dưới đây.

Cái hub còn biết: máy nào của bạn đang mở phiên nào, tên phiên bạn đặt, địa chỉ Tailscale,
và thời điểm mỗi lần Claude dừng chờ bạn.

Một điều còn lại phải nói thẳng: **hub là nơi phục vụ chính trang web này.** Ai chiếm được
hub thì đẩy được một bản mã độc xuống điện thoại bạn. Khoá riêng đặt ở chế độ không xuất
được nên bản độc đó cũng không bê khoá đi được — nó chỉ ký hộ được trong lúc trang đang mở,
và việc đó để lại dấu vết kiểm tra được. Đây là ranh giới của thiết kế, biết trước thì hơn.

### Ghép cặp điện thoại với một máy

Làm một lần cho mỗi máy. Không cần `/remote` đang bật.

Từ 2026-07-29, đây là **hai lệnh**, không phải một cú so-số-rồi-bấm-nút như trước. Lý do:
**máy dev mới là bên quyết định**, không phải điện thoại. Điện thoại của bạn có thể đang so
số với một điện thoại khác của kẻ tấn công mà không hề biết — hub là bên chọn nó nói chuyện
với ai, và nó có thể làm việc đó một cách hoàn toàn trung thực. Nút "Khớp"/"Không khớp" trên
điện thoại không còn đủ tin cậy để quyết định gì cả, nên chúng đã bị bỏ.

1. Trên máy dev, trong Claude Code: `/remote pair`. Máy dev sẽ đứng chờ, và **không in ra
   số nào của chính nó** — cố tình, để bạn không lỡ chép lại đúng con số vừa hiện thay vì
   thật sự đọc điện thoại.
2. Trên điện thoại: mở app, bấm **Ghép máy này**. Điện thoại hiện một số 6 chữ số và một
   dòng nhắc gõ số đó vào máy dev.
3. Đọc số **trên chính điện thoại của bạn**, rồi gõ vào máy dev:
   ```
   /remote pair xac-nhan <số trên điện thoại>
   ```
4. Máy dev so số bạn gõ với số nó tự tính. Khớp → ghi thiết bị, xong. Lệch → **không ghi gì
   cả**, và máy dev cũng không tiết lộ số nó mong đợi.

**Số lệch nghĩa là có người đứng giữa** — đừng gõ lại cho khớp, và đừng thử ghép lại cho tới
khi hiểu vì sao. Đây không phải thủ tục cho có: chính việc bạn tự tay đọc số từ điện thoại
mình và gõ nó vào máy — chứ không phải việc "hai màn hình trông giống nhau" — là thứ duy
nhất bảo vệ bạn khỏi chính cái hub. Trên điện thoại vẫn còn nút **Huỷ**, nhưng nó chỉ dọn
hàng đợi ghép cặp trên hub cho gọn — bấm hay không cũng không đổi máy dev sẽ ghi gì.

### Mất điện thoại

Gỡ nó khỏi Tailscale ngay — đó mới là **công tắc ngắt thật**, và nó có hiệu lực trên **mọi máy
dev cùng lúc**: không còn trong tailnet thì khoá đã ghép cũng vô dụng, vì không chạm tới địa
chỉ `100.x.x.x` được nữa.

Sau đó dọn cho sạch: `/remote unpair <số>` trên **từng máy** (`/remote devices` để xem danh
sách). Đây chỉ là dọn dẹp, không phải công tắc ngắt — nó không lan tới máy nào khác, nên đừng
coi nó ngang hàng với việc gỡ khỏi Tailscale ở trên.

### Xoá dữ liệu trang là mất khoá

Khoá riêng cố tình **không sao lưu được** — đó là lý do mã độc cũng không bê nó đi được. Nên
xoá dữ liệu trang web, hay gỡ app khỏi màn hình chính rồi cài lại, là **mất khoá và phải
ghép lại từng máy**. Vài phút, nhưng biết trước thì đỡ hoảng.

---

## 9. Khi có trục trặc

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Lệnh cài in mã rồi báo **"Mã đã hết hạn"** | Mã sống 10 phút. Cũng xảy ra nếu bạn bấm Ctrl-C giữa chừng rồi duyệt sau — lượt duyệt đó bị tiêu mất. Chạy lại lệnh cài để lấy mã mới |
| Lệnh cài in **"Hết thời gian chờ duyệt"** | Không ai bấm Duyệt trong 10 phút. Chạy lại, và mở sẵn thẻ **Duyệt máy dev** trong app trước khi chạy |
| Duyệt xong nhưng tên in ra **không phải bạn** | Có người khác vừa nhập trúng mã của bạn. Gỡ cài đặt rồi cài lại — máy này đang giữ token của họ |
| Mở `/link` mà thấy màn hình đăng nhập | Trình duyệt đó chưa đăng nhập — app đã cài và trình duyệt là hai phiên riêng. Duyệt trong app cho nhanh, hoặc đăng nhập Slack ngay tại đó (nó quay lại đúng ô nhập mã) |
| Không thấy nút **Đăng nhập bằng Slack** | Hub chưa cấu hình đăng nhập Slack — dùng ô dán token, và báo người quản trị hub (mục 12) |
| Bấm nút Slack rồi báo **"Phiên đăng nhập hết hạn"** | Link callback bị mở lại, hoặc quá 5 phút giữa lúc bấm và lúc Slack trả về. Bấm đăng nhập lại từ đầu |
| `/notify` báo "chưa có thiết bị nào đăng ký" | Chưa bật thông báo trên điện thoại, hoặc iPhone mở bằng Safari thay vì từ icon màn hình chính |
| Điện thoại không nhận thông báo | Trước hết: `/notify` đang **off**? Bật bằng `/notify on`. Vẫn im, mà máy khác hoặc điện thoại Android thì nhận được, **riêng iPhone không** → lỗi phía hub: người vận hành chưa đặt `CCRC_VAPID_SUBJECT` (mục 12). Đây là kiểu hỏng không có dấu hiệu nào cả — `/notify` vẫn báo gửi thành công, app vẫn hiện là đã đăng ký thiết bị — nên đừng gỡ app cài lại, không sửa được gì mà mất khoá ghép cặp |
| `/remote on` báo không tìm thấy tmux | Claude Code đang chạy ngoài tmux. Thoát, chạy `tmux`, rồi chạy `claude` bên trong |
| `/remote on` báo lỗi Tailscale | Tailscale chưa chạy hoặc chưa đăng nhập. Mở app Tailscale lên |
| Thẻ hiện "Máy không phản hồi — có thể đã ngủ" | Máy tính ngủ hoặc mất mạng. **Đặt máy không ngủ trước khi rời đi** |
| Bấm "Mở terminal" mà không vào được | Điện thoại chưa bật Tailscale, hoặc điện thoại và máy tính **không cùng tài khoản Tailscale của bạn** (ví dụ đăng nhập nhầm hai tài khoản khác nhau) |
| Báo thẳng "chưa được ghép với máy đó" rồi đứng yên, không tự nối lại | Điện thoại này **chưa ghép** với máy đó, hoặc vừa bị `/remote unpair` gỡ — ghép lại bằng `/remote pair` (mục 8) |
| Web hiện bản cũ sau khi cập nhật | Vuốt tắt hẳn app khỏi app switcher rồi mở lại. **Đừng gỡ app cài lại** — không sửa được gì mà mất luôn khoá ghép cặp. Còn cũ nữa thì là lỗi phía hub: người vận hành quên bump `?v=` khi deploy |

Không có phiên nào hiện lên mà bạn chắc đã bật: chạy `/remote` trên máy để xem hub thấy gì.

---

## 10. Thói quen dùng cho quen tay

Trước khi rời máy:

```
/notify on          ← để được báo
/remote on <tên>    ← để trả lời được từ điện thoại
```

Nhớ **đặt máy không ngủ**. Trên macOS: System Settings → Lock Screen → mục "Turn display off
on power adapter when inactive" đặt là *Never*; hoặc đơn giản hơn, mở một cửa sổ Terminal và
chạy `caffeinate -dimsu` rồi để đó.

Hệ thống **cố ý không tự đụng vào cài đặt máy bạn** — máy Mac, Linux hay Windows đều xử lý
như nhau, và việc tự ý giữ máy thức là thứ bạn nên tự quyết. Máy ngủ là mất kết nối, thẻ trên
điện thoại sẽ chuyển thành "Máy không phản hồi".

Về tới bàn:

```
/remote off
/notify off
```

---

## 11. Gỡ ra

Cài bằng lệnh một dòng thì gỡ cũng bằng một lệnh:

```bash
curl -fsSL https://<hub-cua-ban>/uninstall.sh | sh
```

Cài từ bản git clone thì chạy trong thư mục repo:

```bash
./remove-notify.sh
```

Gỡ xong máy trở về **đúng trạng thái trước khi cài**: mọi phiên `/remote` đang chạy bị dừng,
mọi file do lệnh cài tạo ra bị xoá, và những thư mục nó tạo ra cũng bị dọn nếu đã rỗng. File
`settings.json` của bạn giữ nguyên từng byte — chỉ entry hook của ccrc bị lấy ra.

Cả hai đều liệt kê những gì sắp xoá và **hỏi xác nhận** trước: `~/.ccrc`, hai slash command, và entry
hook trong `~/.claude/settings.json` (chỉ entry của ccrc, các hook khác của bạn giữ nguyên).
Không đụng gì khác trên máy, repo vẫn ở nguyên chỗ cũ.

`~/.ccrc` cũng là nơi chứa `devices.json` — danh sách điện thoại đã ghép với **máy này**. Gỡ
xong là mất danh sách đó; cài lại thì phải `/remote pair` lại từng điện thoại, kể cả những cái
đã ghép trước đây.

---

## 12. Thêm người dùng mới (dành cho người quản trị hub)

**Bạn không phải phát token nữa.** Ai đăng nhập được Slack công ty thì tự cài được: mở
`https://<hub-cua-ban>`, bấm Đăng nhập bằng Slack, rồi chạy lệnh cài một dòng ở mục 3. Hub
tự tạo tài khoản cho họ ở lần đăng nhập đầu.

Việc còn lại của người mới, và bạn không làm hộ được: **tài khoản Tailscale của riêng họ.**
Không mời vào tailnet của bạn, không xin họ mời bạn vào tailnet của họ. Gói cá nhân miễn phí
là đủ.

### Khi có người rời team

⚠️ **Hub không tự biết ai đã nghỉ.** Nó không hỏi lại Slack sau lần đăng nhập đầu, nên token
của người đã rời **vẫn dùng được cho tới khi bạn thu hồi tay**:

```bash
./deploy.sh deluser ten-hien-thi        # hoặc id Slack
```

Khớp nhiều người thì lệnh **không xoá gì cả** và liệt kê ra để bạn gõ lại bằng id Slack — xoá
nhầm là người đó mất push, mất lịch sử và mất các phiên đang mở.

Việc này nên nằm trong checklist off-boarding. Bảo Slack vô hiệu hoá tài khoản là chặn được
**đăng nhập mới**, nhưng không đụng gì tới token đã nằm trên máy họ.

### Người không dùng Slack

Vẫn cấp tay được — script tự động, người ngoài, tài khoản dùng chung:

```bash
./deploy.sh adduser ten-nguoi-do
```

In ra một token — gửi **riêng** cho người đó, đừng dán vào chat nhóm. Hub tự nạp trong khoảng
5 giây, không cần khởi động lại. Họ cài bằng dạng có token ở mục 3.

### ⚠ Có người dùng iPhone: phải đặt `CCRC_VAPID_SUBJECT`

Đây là biến duy nhất mà đặt sai thì **không ai trong đội thấy được gì bất thường**, kể cả bạn.
Hub gắn giá trị này làm liên hệ trên mỗi lượt đẩy. Apple kiểm nó chặt hơn hẳn Google: liên hệ
không định vị được — kể cả mặc định `mailto:admin@localhost` của hub — bị trả `403
BadJwtToken` cho **mọi** push, vĩnh viễn. Còn phía người dùng thì:

- `/notify` vẫn báo gửi thành công
- app vẫn hiện iPhone là **đã đăng ký nhận thông báo**
- Android và Firefox trong cùng đội vẫn nhận bình thường — nên nếu bạn kiểm thử bằng Android,
  bạn sẽ kết luận hub chạy tốt

Đặt trong `.env`, giá trị là domain công khai của hub:

```
CCRC_VAPID_SUBJECT=https://<hub-cua-ban>
```

rồi **tạo lại** container (`./deploy.sh` — `docker restart` không nạp biến mới). Kiểm lại:

```bash
docker compose -p cc-remote-control exec hub printenv CCRC_VAPID_SUBJECT
docker compose -p cc-remote-control logs --tail=50 hub | grep -i vapid
```

Lệnh đầu phải in đúng domain của bạn; lệnh sau không còn dòng cảnh báo nào là đạt. Đổi giá trị
này không ảnh hưởng đăng ký cũ — **không ai phải cài lại app hay bật lại thông báo.**

Chạy hub bằng systemd thay vì Docker thì `.env` không được đọc: đặt biến trong unit file
(`deploy/ccrc-hub.service` đã có sẵn dòng để sửa).

### Bật đăng nhập Slack trên hub

Cần **cả hai** biến trong `.env`; thiếu một là tính năng tắt hẳn và PWA quay về ô dán token:

| Biến | Giá trị |
|---|---|
| `CCRC_TS_PUBLIC_URL` | URL công khai của token-slayer — trình duyệt đi theo |
| `CCRC_TS_INTERNAL_URL` | URL nội bộ trong docker network — hub tự gọi, không ra internet |

Bên token-slayer đặt `CCRC_CALLBACK_URL` trỏ ngược về hub, ví dụ
`https://<hub-cua-ban>/auth/callback`.

### Vì sao không dùng tailnet chung — dù nghe tiện hơn

| | Tailnet riêng từng người | Một tailnet dùng chung |
|---|---|---|
| Điện thoại A mở terminal máy A | ✅ | ✅ |
| Máy A chạm được tới máy B | ❌ không có đường | ✅ **chạm được** |
| Mất điện thoại: tự thu hồi ngay, một mình bạn quyết | ✅ gỡ khỏi tailnet của bạn, xong | ❌ phải nhờ người quản trị tailnet chung |
| Cần cấu hình ACL trên Tailscale | ❌ không | ✅ phải làm, và làm đúng |

Cột phải không phải là "kém an toàn hơn một chút" — nó **lấy mất công tắc ngắt của riêng
bạn**. Mất điện thoại trong một tailnet riêng là việc của một mình bạn, xong trong một phút.
Mất điện thoại trong một tailnet chung nghĩa là phải nhờ vả và chờ đợi người khác xử lý, với
một khoảng hở ở giữa.

Tailnet riêng thì không phải tin ai cả, và **không tốn công cấu hình gì thêm** — mỗi người cài
Tailscale lên máy họ và điện thoại họ là xong.

### Hub thấy gì và không thấy gì

| Hub giữ | Hub KHÔNG giữ |
|---|---|
| Danh sách người dùng và token | Nội dung terminal (không một byte) |
| Phiên nào đang mở, tên máy, tên phiên | Tên thư mục, đường dẫn |
| Khoá công khai của điện thoại — đúng 5 phút lúc ghép cặp, rồi xoá (không phải bí mật) | Khoá riêng của bất kỳ điện thoại nào — thứ duy nhất mở được phiên |
| Mốc thời gian thông báo gần nhất của mỗi phiên — một con số | **Nội dung thông báo.** Tiêu đề và nội dung đi qua hub để đẩy đi rồi bị quên ngay, không lưu lại ở đâu |

Dòng cuối từng ngược lại: hub nhớ 50 thông báo gần nhất của mỗi người, tiêu đề và nội dung
thật, để PWA vẽ được chấm "chưa đọc" trên thẻ phiên. Cái chấm ấy chỉ hỏi đúng một câu — "phiên
này có việc gì sau lần tôi xem cuối không" — nên giờ hub giữ đúng câu trả lời đó, một con số
cho mỗi phiên, và quên phần còn lại. Ai đọc được dữ liệu của hub cũng không đọc ra được Claude
đã hỏi gì.

Hub chạy ở chế độ **ephemeral** — khởi động lại là mất danh sách phiên. Đúng thiết kế, không
phải lỗi: mỗi người chỉ cần `/remote on` lại.
