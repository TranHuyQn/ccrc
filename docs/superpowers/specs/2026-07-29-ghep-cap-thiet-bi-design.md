# Thiết kế: ghép cặp thiết bị — lấy hub ra khỏi vai trò ký vé

Ngày: 2026-07-29
Trạng thái: đã chốt qua brainstorm, chờ lập kế hoạch thực thi
Thay thế: §4.3 và §4.3b của `2026-07-27-web-terminal-design.md` (phần vé HMAC do hub ký)

---

## 1. Vấn đề

Hôm nay hub giữ khoá HMAC của mọi daemon — daemon gửi nó lên trong từng nhịp tim — và
dùng khoá đó ký vé cho điện thoại. Kèm theo, `data/users.json` giữ token của mọi thành
viên ở dạng thô.

Hai thứ đó cộng lại nghĩa là: **chủ hub ký được một tấm vé vào phiên terminal của bất kỳ
thành viên nào.** Vé đó mở ra phiên Claude Code đang chạy — tức toàn bộ nội dung hội thoại,
mã nguồn, prompt.

Thứ đang chặn lại không phải hệ thống, mà là mạng: địa chỉ `100.x.x.x` không định tuyến ra
ngoài tailnet đã cấp nó. Đó là một rào chắn thật, nhưng nó nằm ngoài tầm kiểm soát của mã
này và phụ thuộc vào việc mỗi thành viên dùng một tài khoản Tailscale riêng — một quy ước
vận hành, không phải một bảo đảm kỹ thuật.

Yêu cầu đặt ra: **chỉ thành viên đó biết về dự án và nội dung phiên của mình; không ai được
xem của nhau, kể cả chủ hệ thống; và bản thân hệ thống cũng không được lưu.** Hub chỉ là
trung gian để điều khiển từ xa một phiên trên máy cá nhân.

## 2. Mô hình đe doạ và mức bảo đảm

Có một sự thật không vá được bằng mật mã, phải ghi ra trước: **hub chính là nơi phục vụ mã
PWA.** `app.js` tải từ hub. Ai kiểm soát hub thì kiểm soát JavaScript chạy trên điện thoại
thành viên. Không giao thức nào cứu được điều đó chừng nào client còn đến từ hub.

Nên phải chọn mức bảo đảm. **Đã chốt: mức 1 — chặn đọc lén thụ động.**

| | Mức 1 (đã chọn) | Mức 2 (bác) |
|---|---|---|
| Hub giữ bí mật ký được vé | không | không |
| Chủ hub đọc lén từ đĩa/RAM của hub | không được | không được |
| Chủ hub đẩy `app.js` độc để lấy khoá | **làm được** | không được |
| Chi phí | vừa phải, giữ nguyên trải nghiệm PWA | phải viết app di động thật, hoặc phục vụ PWA từ chính máy dev |

Vì sao mức 1 là đủ: tấn công chủ động **để lại dấu vết** — mã PWA là thứ kiểm tra được, tải
về so sánh được — và nó **không hồi tố**: dữ liệu cũ đã không còn gì để lấy. Khác hẳn tình
trạng hôm nay, nơi chủ hub chỉ cần đọc RAM của tiến trình mình đang chạy.

Ngoài ra, khoá riêng trên điện thoại đặt **non-extractable** (§4), nên ngay cả `app.js` độc
cũng chỉ *ký hộ* được trong lúc trang đang mở — không bê được khoá đi dùng về sau.

**Nằm ngoài phạm vi spec này** (là việc riêng, đã ghi nhận): băm token trong `users.json`;
quyết định về Cloudflare Tunnel trong mô hình tin cậy; bỏ lịch sử 50 thông báo.

## 3. Quyết định đã chốt

1. **Mức bảo đảm: 1** — chặn đọc lén thụ động (§2).
2. **Nghi thức ghép cặp: so số kiểu Bluetooth** — 6 chữ số hiện trên cả hai màn hình, người
   dùng so bằng mắt. Không gõ bí mật nào.
3. **Hub vẫn biết siêu dữ liệu như hiện nay, trừ khoá** — `sessionId`, tên máy, nhãn, URL
   (IP Tailscale + cổng), nhịp tim. Đã cân nhắc và **bác** phương án giấu địa chỉ máy: lợi
   ích biên (IP tailnet vô dụng với người ngoài tailnet) không bù được độ phức tạp.
4. **Cắt dứt điểm** — bỏ hẳn `/api/terminal/ticket` và trường `secret` trong cùng một lần.
   Không chạy song song hai đường xác thực: đường cũ **chính là** lỗ hổng đang vá, để nó
   sống thêm vài tuần là vá mà chưa vá.
5. **Ghép cặp đi qua hub như một người đưa thư mù** — vì trang `https` không `fetch()` sang
   `http` được, và origin `http://100.x.x.x` không có `crypto.subtle`. So số là thứ làm cho
   việc tin hub trở nên không cần thiết (§5.2).

## 4. Kiến trúc — ai giữ gì

| Nơi | Giữ gì | Tính chất |
|---|---|---|
| **Điện thoại** (origin PWA, `https`) | Một cặp khoá ECDSA P-256. Khoá riêng **non-extractable**, trong IndexedDB. Một khoá cho cả người, dùng với mọi máy dev. Kèm danh sách tên những máy đã ghép — chỉ để vẽ đúng nút trên thẻ (§7), không tham gia xác thực. | JS không đọc ra được, kể cả JS độc — chỉ *dùng* được khi trang đang mở |
| **Máy dev** (`~/.ccrc/devices.json`, chmod 600) | Khoá **công khai** đã ghép + nhãn + ngày ghép | Công khai. Trộm được file cũng không mở được gì. Nằm ngoài daemon nên sống qua mọi `/remote on/off` |
| **Hub** (RAM) | `sessionId`, tên máy, nhãn, URL, nhịp tim. **Không còn `secret`.** Thêm hàng đợi ghép cặp, sống 5 phút. | Không còn gì ký được vé |

Khoá riêng phải là **P-256 với `extractable: false`**. Theo đặc tả WebCrypto, với cặp khoá
thì cờ `extractable` chỉ áp cho khoá riêng — khoá công khai luôn xuất được, nên vẫn lấy
được SPKI để gửi đi. Đây là điều làm cho câu "kể cả app.js độc cũng không bê khoá đi được"
là sự thật chứ không phải khẩu hiệu.

### 4.1 `~/.ccrc/devices.json`

```json
{
  "version": 1,
  "devices": [
    {
      "id": "3f9a2c81b40d7e55",
      "pubKey": "<base64url SPKI>",
      "label": "iPhone · Safari",
      "pairedAt": 1785000000000
    }
  ]
}
```

`id` = 8 byte đầu của `SHA-256(pubKey)`, viết hex. Nó đi kèm trong token (§6) để daemon tra
thẳng thay vì thử lần lượt, và để thông điệp lỗi nói được "thiết bị này đã bị gỡ" thay vì
"chữ ký sai" — hai chuyện khác hẳn nhau với người đang gỡ rối.

Tối đa **20 thiết bị**. Không phải vì ai cần 20, mà để một file bị nhét phình không làm
daemon ì trên đường đi của mọi kết nối.

## 5. Ghép cặp

### 5.1 Vì sao phải đi qua hub

Điện thoại không gửi thẳng khoá công khai sang máy dev được. Hai luật cứng của trình duyệt:

- Trang `https` (PWA trên hub) không `fetch()` sang `http` (daemon trên tailnet) — mixed
  content, chặn thẳng. Điều hướng cấp trang thì được, đó là lý do luồng mở terminal hiện
  tại chạy được.
- Origin `http://100.x.x.x` không phải secure context, nên **không có `crypto.subtle`** ở
  đó. Ghép cặp ngay trên trang terminal sẽ phải nhúng thư viện crypto thuần JS và mất luôn
  tính non-extractable.

Đã cân nhắc và bác: bật HTTPS cho daemon — xin chứng chỉ là ghi tên máy vào Certificate
Transparency log, sổ công khai vĩnh viễn không xoá được (quyết định D2c của thiết kế cũ,
giữ nguyên).

Nên hub làm người đưa thư. Việc tin hay không tin nó được giải quyết ở §5.2.

### 5.2 Vì sao phải cam kết trước, mở sau

**So số ngây thơ thì hub bẻ được.** Nếu SAS chỉ là `H(pubKey ‖ nonce_M)`:

1. Hub nhận `pubKey_P` từ điện thoại, chuyển cho máy dev một `pubKey_E` của chính nó.
2. Máy dev sinh `nonce_M`, tính `SAS_M = H(pubKey_E ‖ nonce_M)`, hiện lên màn hình.
3. Hub thấy `nonce_M`, và bây giờ chỉ cần **dò** một `nonce_M'` sao cho
   `H(pubKey_P ‖ nonce_M') == SAS_M`, rồi gửi `nonce_M'` cho điện thoại.
4. Sáu chữ số ⇒ khoảng 10⁶ phép băm ⇒ vài mili giây. Hai màn hình hiện **cùng một số**,
   người dùng bấm Khớp, và hub vừa cài được khoá của nó vào máy dev.

Chặn bằng **cam kết trước, mở sau**: điện thoại gửi `commit = SHA-256(nonce_P)` cùng lúc
với khoá công khai, và chỉ tiết lộ `nonce_P` **sau khi** đã nhận `nonce_M`.

```
SAS = 6 chữ số dẫn xuất từ  SHA-256( pubKey_SPKI ‖ nonce_P ‖ nonce_M )
```

Giờ hub muốn tráo khoá thì kẹt: nó đã phải nộp một `commit` cho máy dev **trước khi** biết
`nonce_M`. Sau đó muốn ép SAS trùng, nó phải tìm một `nonce_P'` băm ra đúng `commit` đã
nộp — tức tìm tiền ảnh của SHA-256. Không làm được. Còn nếu nó chuyển tiếp `commit` thật
thì nó chỉ mở được đúng `nonce_P` thật, mà cái đó cho ra SAS tính trên `pubKey_P`, khác với
SAS máy dev tính trên `pubKey_E`. Lệch số, người dùng thấy.

`nonce_P` và `nonce_M` mỗi cái 32 byte ngẫu nhiên. Sáu chữ số lấy bằng 4 byte đầu của bản
băm đọc thành uint32 rồi `% 1_000_000`, đệm số 0 cho đủ 6 chữ. Có lệch phân phối ở mức
2⁻²², không đáng kể so với chính độ mạnh 10⁻⁶ của một SAS 6 chữ số.

### 5.3 Luồng

```
ĐIỆN THOẠI (PWA)              HUB                    MÁY DEV (/remote pair)

1. sinh cặp khoá (lần đầu)
   nonce_P, commit=H(nonce_P)
   POST /api/pair/start ─────▶ giữ 5 phút
   ◀───────────────────────── {pairId}
   "Đang chờ máy dev…"
                                        ◀─────────── 2. GET /api/pair/pending
                                        ───────────▶    {pairId, pubKey, commit, label}
                                        ◀─────────── 3. POST /api/pair/challenge
                                                        {pairId, nonceM}
4. poll ──▶ nhận nonce_M
   POST /api/pair/reveal ────▶
   {pairId, nonceP}
   tính SAS, hiện 6 số
   ┌────────────────┐                                5. poll ──▶ nhận nonce_P
   │  4 7 2 9 1 5   │                                   kiểm H(nonce_P)==commit
   │ [Khớp][Không]  │                                   tính SAS
   └────────────────┘                                   ┌──────────────────┐
                                                        │ Mã:  4 7 2 9 1 5 │
6. bấm Khớp                                             │ So với điện thoại│
   POST /api/pair/finish ───▶ đánh dấu                  └──────────────────┘
   {pairId, ok:true}
                                        ◀─────────── 7. poll ──▶ thấy done
                                                        ghi devices.json
                                                        "✓ Đã ghép iPhone · Safari"
```

Ba tính chất của luồng này:

- **Xác nhận nằm ở điện thoại, máy dev chỉ hiện số.** Nhờ vậy `/remote pair` không cần đọc
  phím — nó chỉ hỏi hub và in, chạy gọn trong một slash command của Claude Code.
- **`/remote pair` không cần daemon nào đang chạy.** Khoá công khai vào `devices.json`,
  không vào daemon. Ghép một lần cho mỗi máy, dùng cho mọi phiên về sau.
- **Nhãn thiết bị do hub dẫn xuất, điện thoại không gửi.** Hub đọc header `User-Agent` của
  chính request `/api/pair/start` và chạy qua `labelFromUserAgent()` đã có trong
  `server/src/push-devices.js` — "iPhone · Safari" — đúng như nó đang làm cho thiết bị nhận
  thông báo. Không viết hàm thứ hai làm cùng việc, và không bắt PWA mang một bản sao logic
  đoán User-Agent.

  Hệ quả: **nhãn là thứ hub kiểm soát.** Nó chỉ để người dùng nhận ra thiết bị nào trong
  `/remote devices`, không tham gia xác thực gì — hub đặt nhãn sai thì gây nhầm lẫn, không
  mở được cửa nào. Chấp nhận được ở mức bảo đảm 1, nhưng phải ghi ra để không ai sau này
  tưởng nhãn là thứ tin được.

  **Bổ sung (review toàn nhánh, sau khi §1–§13 đã thực thi xong):** đoạn trên chỉ phân
  tích nhãn như một đầu vào XÁC THỰC — đúng, nhưng KHÔNG ĐỦ. Nhãn còn là **nội dung**
  được in thẳng ra terminal máy dev (`cmdPairConfirm`/`cmdDevices`,
  `term/bin/ccrc-term-cli.js`), và `deploy/commands/remote.md` chạy CLI đó qua một agent
  Claude Code có quyền Bash rồi bảo agent THUẬT LẠI đầu ra — tức bên KHÔNG được tin (hub)
  ghi thẳng vào luồng ngữ cảnh của bên ĐƯỢC tin (agent), chưa kể một nhãn dài/mang ký tự
  điều khiển C0/C1 có thể che dòng cảnh báo bằng line-overwrite hoặc mang OSC 52 (ghi vào
  clipboard) mà tmux vẫn tuân theo. `term/src/devices.js` (`sanitizeLabel`, dùng ở cả
  `addDevice` và `pending-pair.js`'s `writePending`) cắt độ dài (64 ký tự) và bỏ mọi ký tự
  điều khiển tại chính hai biên giới tin cậy này — không ai sau này được coi nhãn là vô
  hại chỉ vì nó "không mở được cửa nào".

### 5.4 Sáu route của hub

Máy trạng thái: `started → challenged → revealed → done | aborted | expired`

| Route | Ai gọi | Thân | Ghi chú |
|---|---|---|---|
| `POST /api/pair/start` | điện thoại | `{pubKey, commit}` | → `{pairId}`. Nhãn do hub dẫn xuất từ `User-Agent`, không nhận từ thân request |
| `GET /api/pair/pending` | máy dev | — | danh sách yêu cầu đang chờ **của chính người gọi** |
| `POST /api/pair/challenge` | máy dev | `{pairId, nonceM}` | chỉ hợp lệ ở trạng thái `started` |
| `POST /api/pair/reveal` | điện thoại | `{pairId, nonceP}` | chỉ hợp lệ ở `challenged` |
| `POST /api/pair/finish` | điện thoại | `{pairId, ok}` | `ok:false` là bấm [Không khớp] |
| `GET /api/pair/<pairId>` | cả hai | — | trạng thái hiện có |

Mọi route đều đòi token thành viên và **phân tách theo người dùng** — đúng kỷ luật của mọi
tra cứu khác trên hub: yêu cầu ghép cặp của người này không bao giờ trả lời câu hỏi hỏi
nhân danh người khác. Hàng đợi nằm trong RAM, hết hạn 5 phút, dọn lười như
`terminal-sessions.js` đang làm.

## 6. Mở terminal

```
PWA:    GET /api/terminal → [{sessionId, machine, url, label, alive}]
        (KHÔNG còn bước xin vé — /api/terminal/ticket bị xoá hẳn)

PWA:    ký bằng khoá riêng trong IndexedDB:
          payload = {sid, m, exp: now+60s, iat: now, n: nonce, k: deviceId}
          token   = "v2." + base64url(payload) + "." + base64url(chữ ký)

PWA:    location.href = <url> + "#t=" + token          ← y như hiện nay

trang:  ws://<url>/attach?token=<token>

daemon: tra devices.json theo `k`
        xác minh chữ ký ECDSA bằng khoá công khai đó
        + exp/iat, nonce một lần, sid khớp phiên  ← giữ nguyên mọi ràng buộc cũ
        → mint sessionKey cho việc nối lại        ← giữ nguyên
```

**Phần nối lại bằng `sessionKey` không đụng tới.** Nó vốn không đi qua hub, sinh trong RAM
daemon, chết cùng daemon — đúng như §4.3b của thiết kế cũ. Token tự ký chỉ thay đúng chỗ vé
HMAC đứng trước đó.

**Cái bẫy phải ghi ra:** WebCrypto ký ECDSA ra dạng raw `r‖s` (IEEE P1363), còn
`node:crypto` mặc định chờ DER. Phải đặt `dsaEncoding: 'ieee-p1363'` khi verify. Quên là
mọi chữ ký hợp lệ đều bị từ chối, và triệu chứng nhìn y hệt "khoá sai" — sẽ tốn cả buổi tìm
nếu không có test tương thích chéo ở §10.

Ràng buộc `exp - iat <= MAX_TICKET_LIFETIME_MS` giữ nguyên, kèm nguyên lý cũ: đo theo tuổi
**đúc** chứ không theo đồng hồ người xem, để lệch giờ giữa hai máy không sinh ra vé lúc từ
chối lúc chấp nhận.

## 7. Xử lý lỗi

**Khi ghép cặp**

| Tình huống | Hành vi |
|---|---|
| Không có điện thoại nào xin ghép | `/remote pair` chờ 2 phút rồi bỏ cuộc, chỉ đúng việc cần làm |
| **Hai điện thoại xin ghép cùng lúc** | Từ chối cả hai, bảo làm từng cái. So số chỉ có nghĩa khi biết chắc đang so với ai — đoán bừa là phá hỏng chính cơ chế |
| `H(nonce_P) != commit` | Không ghi gì. Cảnh báo: có người đứng giữa, hoặc hub hỏng |
| Bấm **[Không khớp]** | Huỷ, cảnh báo trên cả hai màn hình |
| Quá 5 phút | Cả hai báo quá hạn. Hàng đợi tự dọn |
| Ghép lại thiết bị đã ghép | Cập nhật `pairedAt`, **không** nhân bản — `pubKey` là khoá định danh |
| Mất mạng giữa chừng | `pairId` hết hạn tự nhiên, không để lại rác |

**Khi mở terminal**

Điện thoại chưa ghép với máy đó thì daemon trả 401. Để người dùng không phải đi tới đó mới
biết, PWA giữ danh sách cục bộ "những máy tôi đã ghép" (ghi cạnh khoá lúc ghép xong); thẻ
của máy chưa ghép hiện nút **"Ghép máy này"** thay cho "Mở terminal".

Danh sách cục bộ vẫn lệch được — máy kia vừa `unpair` chẳng hạn — nên trang terminal vẫn
phải xử lý 401 tử tế: *"Điện thoại này chưa được ghép với máy đó, hoặc đã bị gỡ"*, kèm nút
quay lại danh sách.

**`devices.json` hỏng hoặc không đọc được** → coi như chưa ghép thiết bị nào, mọi kết nối
401, cảnh báo lúc daemon khởi động. Tuyệt đối không sập: file này nằm trên đường đi của mọi
kết nối, và cùng kỷ luật với `static.js` — thứ chạy trước mọi xác thực thì không được phép
ném ra ngoài.

**Đánh đổi phải nằm trong tài liệu người dùng:** khoá non-extractable **không sao lưu
được**. Xoá dữ liệu trang, hay gỡ PWA rồi cài lại, là mất khoá — phải ghép lại từng máy. Đó
là cái giá của việc JS độc không bê được khoá đi. Đáng, nhưng người dùng phải biết trước
chứ không phải tự phát hiện.

## 8. Thu hồi khi mất điện thoại

`/remote devices` liệt kê, `/remote unpair <số thứ tự|nhãn>` gỡ.

Nhưng tài liệu phải nói đúng trọng tâm: **công tắc ngắt thật là gỡ thiết bị khỏi Tailscale.**
Không còn trong tailnet thì khoá đã ghép cũng vô dụng, vì không chạm tới `100.x.x.x` được
nữa. Một thao tác, hiệu lực trên mọi máy dev cùng lúc. `unpair` chỉ là vệ sinh và nó bắt
người ta nhớ chạy trên *từng* máy — để hai thứ ngang hàng trong tài liệu là dụ người ta làm
cái yếu và bỏ cái mạnh.

**Khoá ghép cặp không hết hạn.** Bắt ghép lại định kỳ nghe an toàn hơn nhưng nó dạy người
dùng bấm qua quýt qua màn hình so số — mà so số cẩn thận đúng là toàn bộ giá trị của nghi
thức này. Một nghi thức làm 5 lần một năm sẽ được làm cẩu thả 5 lần.

## 9. Phạm vi thay đổi

**File mới**

| File | Việc |
|---|---|
| `term/src/pairing.js` | SAS, commit/reveal, sinh nonce |
| `term/src/devices.js` | đọc/ghi `devices.json`, giới hạn 20, không bao giờ ném |
| `server/src/pairing.js` | hàng đợi ghép cặp, máy trạng thái, hết hạn 5 phút |

**File sửa**

| File | Việc |
|---|---|
| `term/src/ticket.js` | v2: xác minh ECDSA thay HMAC; bỏ `signTicket` khỏi đường chạy thật |
| `term/bin/ccrc-term.js` | xác minh bằng `devices.json`; **bỏ gửi `secret`** trong nhịp tim |
| `term/bin/ccrc-term-cli.js` | thêm `pair`, `devices`, `unpair` |
| `server/src/terminal-sessions.js` | bỏ `secret`, bỏ `issueTicket` |
| `server/src/index.js` | bỏ `/api/terminal/ticket`, thêm 6 route `/api/pair/*`, bỏ kiểm `secret` |
| `server/public/app.js` | sinh/giữ khoá, ký token, UI ghép cặp, thẻ "chưa ghép" |
| `term/public/term.js` | `?ticket=` → `?token=`, thông điệp 401 mới |
| `deploy/commands/remote.md` | mô tả lệnh mới |
| `docs/huong-dan.md` §8 | viết lại phần riêng tư cho khớp sự thật mới |

Khoảng 3 file mới, 9 file sửa.

## 10. Cách test

Theo TDD, dùng lại hạ tầng test sẵn có.

### 10.1 Test quan trọng nhất — mô phỏng hub ác

Kịch bản đúng như §5.2: hub tráo khoá công khai gửi cho máy dev, rồi *sau khi thấy*
`nonce_M` mới đi dò `nonce_P'` để ép hai SAS trùng nhau.

Kèm **một test đối chứng**: bỏ bước commit đi thì tấn công **thành công**. Không có nó thì
không ai chứng minh được test trên đang canh đúng thứ — và không ai biết vì sao
commit/reveal tồn tại khi có người tới "đơn giản hoá" nó.

**Số chữ số của SAS phải tiêm được vào hàm tính.** Ở đường chạy thật là 6 chữ số, nhưng
test đối chứng phải *dò ra được* trong thời gian một bài test — mà 10⁶ phép băm trong JS là
vài giây, nhân với số lần chạy suite thì không chấp nhận được. Cho test dùng **3 chữ số**
(không gian 10³, dò xong tức thì): tính chất mật mã cần chứng minh — "cam kết trước làm
việc dò trở nên vô ích" — hoàn toàn không phụ thuộc vào độ dài, chỉ độ khó mới phụ thuộc.
Test độ dài thật chỉ cần một khẳng định riêng: mặc định là 6.

### 10.2 Còn lại

| Mức | Nội dung |
|---|---|
| `pairing.js` | SAS xác định; commit sai → từ chối; đổi nonce → đổi SAS |
| `devices.js` | ghi/đọc; ghép lại không nhân bản; file hỏng → mảng rỗng, không ném; quá 20 → từ chối |
| `ticket.js` v2 | **tương thích chéo**: ký bằng `crypto.webcrypto.subtle`, xác minh bằng `node:crypto` — đây là chỗ `ieee-p1363` lộ mặt, và lộ ở test chứ không phải trên điện thoại |
| Hub qua HTTP thật | 6 route pair; người A không thấy yêu cầu của người B; hết hạn 5 phút; máy trạng thái từ chối bước sai thứ tự; **`/api/terminal/ticket` phải 404** (hồi quy cho quyết định cắt dứt điểm) |
| Daemon thật | khoá đã ghép mở được; khoá lạ 401; đã unpair 401; `devices.json` hỏng → 401 chứ không sập |
| PWA (`dom-harness`) | máy chưa ghép hiện nút Ghép; ký và điều hướng đúng; 401 hiện đúng thông điệp |

Cho mức PWA: tách phần lưu khoá sau một interface nhỏ `keystore` (`get/create/sign`) để test
tiêm bản giả. Dựng IndexedDB giả trong `node:vm` là một cái harness thứ hai trá hình.

### 10.3 Nghiệm thu tay — bắt buộc

Ghép thật máy này với điện thoại của Huy, so số, mở terminal. Không test tự động nào thay
được bước đó: cả nghi thức này tồn tại là để **một con người nhìn hai màn hình**.

## 11. Cái KHÔNG làm

- Không đụng `sessionKey` và đường nối lại (§6) — nó vốn đã đúng.
- Không đụng nhập liệu, cuộn, bôi đen, font, thông báo đẩy.
- Không giấu IP tailnet khỏi hub — đã cân nhắc, bác (§3, mục 3).
- Không cho khoá ghép cặp hết hạn — đã cân nhắc, bác (§8).
- Không sao lưu/xuất khoá riêng — mâu thuẫn trực tiếp với non-extractable (§7).
- Không chạy song song hai đường xác thực (§3, mục 4).
- Không băm token `users.json`, không đụng Cloudflare, không bỏ lịch sử thông báo — việc
  riêng, không thuộc spec này (§2).

---

## 12. Sửa sau review cuối (2026-07-29, sau khi §1–§11 đã thực thi xong)

Review toàn nhánh tìm được **hai lỗ hổng Critical** mà mười hai vòng review theo từng
task không thấy — vì mỗi vòng chỉ nhìn một nửa, còn cả hai lỗi đều nằm ở chỗ giá trị đi
qua ranh giới. Mục này ghi lại chúng và ghi đè phần §5.3 tương ứng.

### 12.1 Cam kết không ràng buộc gì (C1)

`term/bin/ccrc-term-cli.js` chốt `snapshot.commit` từ lần đọc `GET /api/pair/<pairId>`
ở **bước 3** — tức là **sau** khi bước 2 đã gửi `nonceMachine` lên hub.

Cả lập luận an toàn ở §5.2 dựa vào đúng một điều: hub phải nộp `commit` **trước khi**
biết `nonce_M`. Cài đặt không ép điều đó. Hub biết `nonce_M` trước, rồi trả về một cặp
`(commit_c, noncePhone_c)` tự nó bịa ra sao cho khớp nhau — `commitMatches()` qua, và
chứng minh rỗng. Từ đó hub tráo khoá rồi dò 10⁶ băm để ép hai màn hình trùng số: đúng
cuộc tấn công mà `term/test/pairing-attack.test.js` chứng minh là bẻ được.

**Nguồn gốc, ghi lại để không lặp:** mã trong kế hoạch gốc dùng `pair.commit` lấy từ
`/api/pair/pending` (bước 1) — **đúng**. Review Task 6 nêu rằng ba giá trị đến từ ba mốc
thời gian khác nhau, và controller chỉ đạo gom về một ảnh chụp duy nhất **mà không nói
rõ ảnh chụp đó phải chốt ở bước 1**. Người thực thi chọn bước 3; controller duyệt; và
còn yêu cầu thêm một test khoá chặt đúng hành vi sai đó. Bài học: khi gom nhiều nguồn về
một, phải nói rõ **mốc thời gian nào** là mốc đúng, không chỉ nói "một nguồn".

**Luật mới:** ảnh chụp `{pairId, pubKey, commit, label}` chốt từ phản hồi
`/api/pair/pending`, **trước khi** gửi challenge. Mọi bước sau dùng đúng ảnh chụp đó.
Nếu bản ghi ở bước 3 trả về `pubKey` hay `commit` khác ảnh chụp thì đó là **tín hiệu bị
tráo**, không phải chuyện đua tranh vô hại — dừng và cảnh báo.

### 12.2 Máy dev không có quyền phủ quyết (C2)

CLI ghi `devices.json` chỉ vì hub báo `state === 'done'`. Nhưng **hub chọn nó đang nói
chuyện với điện thoại nào.**

Hub phục vụ yêu cầu ghép của kẻ tấn công làm pending duy nhất, rồi tự hoàn tất
challenge/reveal/finish **trung thực** — mọi chuỗi đều thật, `commitMatches` qua, SAS nội
bộ nhất quán. CLI thấy `done` và ghi khoá của kẻ tấn công. Điện thoại của người dùng nằm
ở một `pairId` khác, hiện số khác, họ bấm **[Không khớp]** — cú đó huỷ `pairId` của
*họ*, còn CLI đang poll `pairId` kia. **Tiếng "không" của người dùng không bao giờ tới
chỗ ra quyết định.**

Không cần `app.js` độc, không cần phá mật mã. Hub ở đây không *tráo* chuỗi nào — nó
*chuyển hướng*. Nên câu ở §5.3 ("nếu hub tráo chuỗi nào thì hai màn hình hiện hai số
khác nhau và bạn thấy ngay") vẫn đúng chữ mà vô nghĩa về hiệu lực.

Đây không phải lỗi cài đặt. Đó là hệ quả chưa được phân tích của quyết định "xác nhận
nằm ở điện thoại" (§5.3), thứ được chọn để `/remote pair` không phải đọc phím.

### 12.3 Nghi thức mới: chuyển số một chiều

**Ghi đè §5.3.** So-số-hai-bên đổi thành chuyển-số-một-chiều. Người dùng đọc số trên
**điện thoại** và gõ vào **máy dev**. Máy so với số nó tự tính; lệch thì không ghi.

```
MÁY DEV                                    ĐIỆN THOẠI
/remote pair
  chốt ảnh chụp từ /pending  ← C1 sửa ở đây
  gửi nonceMachine
  đợi noncePhone, kiểm cam kết
  tính SAS, LƯU LẠI, rồi DỪNG — KHÔNG in ra
  lưu ~/.ccrc/pairing-pending.json                 hiện SAS của nó
                                                   "gõ số này vào máy dev"
người dùng đọc số TRÊN ĐIỆN THOẠI, gõ vào máy:
/remote pair xac-nhan 472915
  so với SAS đã lưu
  khớp   → addDevice, xoá file pending
  lệch   → KHÔNG ghi, cảnh báo có người đứng giữa
```

Vì sao nó khôi phục quyền phủ quyết: hub chuyển hướng sang điện thoại khác thì máy tính
ra SAS trên khoá của kẻ tấn công, còn số người dùng đọc được là của điện thoại **của
họ**. Hai số khác nhau, người dùng gõ vào số của mình, máy từ chối. Quyết định nằm trên
máy, dựa vào thứ chỉ người dùng mới nhìn thấy.

Không cần nguyên liệu mật mã mới — vẫn chính SAS đó, chỉ đổi hướng đi của nó. Đây là lý
do chọn phương án này thay vì mã bí mật + HMAC: thêm một nguyên liệu mật mã mới phải viết
đúng ở cả hai ngôn ngữ chính là loại việc vừa đẻ ra hai lỗi Critical hôm nay.

**Máy dev KHÔNG được in số của nó ra.** Bản đầu của mục này bảo in — sai, và review bắt
được. Nếu máy in số của nó ngay trên dòng "gõ số trên điện thoại vào đây", thì đường lười
nhất là chép lại đúng con số vừa hiện. Lúc đó phép so là máy so với chính nó, luôn khớp,
và quyền phủ quyết ở 12.2 bốc hơi — kẻ tấn công lại ghi được khoá vào máy.

Máy giữ số trong `pairing-pending.json` và chỉ nói: "nhìn điện thoại, gõ số vào đây".
Người dùng buộc phải đọc điện thoại. Khi lệch, máy cũng **không** hiện số nó mong đợi —
hiện ra là mời người ta "sửa" cho khớp, đúng cái cần chặn.

**Đánh đổi, nói thẳng:** hai lệnh thay vì một, và người dùng phải gõ 6 chữ số.

**`~/.ccrc/pairing-pending.json`** giữ `{pairId, pubKey, label, sas, expiresAt}`, chmod
600, hết hạn theo `PAIR_TTL_MS`. Nó **không** chứa bí mật: `sas` là thứ đã hiện trên màn
hình, `pubKey` là khoá công khai. Trộm được file này không ghép được gì — muốn ghép vẫn
phải gõ đúng số mà chỉ điện thoại thật hiện ra.

**Nút [Khớp]/[Không khớp] trên điện thoại thôi quyết định.** Điện thoại chỉ còn hiện số
và câu "gõ số này vào máy dev". Máy mới là bên gọi `/api/pair/finish` — vai của endpoint
đó đảo lại, và hub vẫn không hiểu gì như cũ.

### 12.4 Tài liệu phải sửa theo

`docs/huong-dan.md` §8 đang nói mọi tráo đổi đều lộ ra bằng hai số khác nhau. Sau 12.2
câu đó không còn đủ: nó đúng cho *tráo chuỗi*, sai cho *chuyển hướng*. Phải nói đúng thứ
bảo vệ người dùng là **việc chính họ gõ số của điện thoại mình vào máy**.

---

## 13. Lỗ hổng thứ ba: token không ràng buộc với nơi nó được trao (C3)

Tìm được ở review toàn nhánh lần 2, sau khi §12 đã thực thi xong. Mười bốn vòng review
không thấy, kể cả review đã tìm ra C1 và C2.

### 13.1 Vấn đề

Payload ký gồm `{sid, m, iat, exp, n, k}` — **không có gì nói token này dành cho máy nào**.
Daemon cũng không kiểm host ở bất kỳ đâu. Còn `session.url` thì do hub cấp, và phía điện
thoại chỉ kiểm **hình dạng** (`isTailnetTerminalUrl`: nằm trong dải 100.64.0.0/10), không
kiểm **là máy nào**.

Nên một hub sửa mã server trả về, cho một phiên thật, một `url` trỏ tới địa chỉ tailnet của
kẻ tấn công **giữ nguyên `sessionId` thật**. Điện thoại thấy địa chỉ hợp lệ về hình dạng,
ký một token hoàn toàn hợp lệ, rồi trao nó cho trang của kẻ tấn công qua fragment. Trang đó
chuyển tiếp token tới daemon thật trong 60 giây và lấy được shell, kèm `sessionKey` để nối
lại không giới hạn.

### 13.2 Vì sao nó phá đúng lập luận nền của §2

§2 chọn mức bảo đảm 1 với lý do: tấn công chủ động **để lại dấu vết**, vì mã PWA là thứ tải
về so sánh được.

C3 **không cần `app.js` độc**. Mã server sửa đổi không phục vụ cho ai và không so sánh được
với gì. Tấn công duy nhất mà §2 nói là phát hiện được, hoá ra không phải tấn công duy nhất
có thể làm. Bảng ở §2 vì thế thiếu một dòng.

Điều kiện tiên quyết, nói sòng phẳng: kẻ tấn công phải chạy được dịch vụ trên một địa chỉ
`100.64.0.0/10` mà điện thoại nạn nhân định tuyến tới được — tức ở trong cùng tailnet. Với
khuyến nghị mỗi người một tailnet riêng thì không với tới được, và C3 tụt xuống mức
Important. Nhưng "mỗi người một tailnet" là **quy ước vận hành** — đúng thứ mà cả thiết kế
này sinh ra để thôi phụ thuộc vào. Nên nó được xử như Critical.

Ghi thêm cho trung thực, và cập nhật sau khi §13.3 đã thực thi: `docs/huong-dan.md`
trong đợt này đã **xoá** dòng cảnh báo "người vận hành hub tự ký vé vào phiên người khác"
khỏi bảng so sánh tailnet chung. Lúc phát hiện C3, dòng đó **vẫn đúng** — qua chính đường
C3. Nhưng sau khi ràng `h` vào token thì đường đó đóng, và khôi phục nguyên văn dòng ấy sẽ
là khẳng định một điều **sai**.

Nên kết luận cuối: để dòng đó đã xoá, ĐÚNG. Không phải vì nó thừa, mà vì mã đã làm cho nó
sai. Ghi lại đây để người đọc sau không nhìn lịch sử git rồi tưởng một cảnh báo bị xoá cho
gọn tài liệu.

Cái vẫn còn đúng, và tài liệu vẫn phải nói: một hub phục vụ **mã PWA sửa đổi** thì ký `h`
bằng host thật rồi tự `fetch` token về — `h` không cứu được ca đó, và cũng chưa bao giờ
hứa cứu. Đó vẫn là ca "để lại dấu vết" của §2.

### 13.3 Cách sửa: ràng token vào đích của nó

Thêm `h` vào payload ký: host của `session.url` mà điện thoại **thật sự sắp đi tới**.

```
payload = { sid, m, iat, exp, n, k, h }        h = new URL(session.url).host
```

Daemon từ chối nếu `h` khác host mà **chính nó** quảng bá (nó đã có `hostIp` và `publicUrl`
khi dựng URL lúc `listen`). Token bị lừa sang trang khác mang host của kẻ tấn công, nên
không xác minh được ở daemon nào cả — kể cả daemon thật.

`h` là **bắt buộc**: token thiếu `h` phải là `malformed`, không được mặc định hoá. Một mặc
định lặng lẽ ở đây vô hiệu hoá đúng phép kiểm vừa thêm — cùng loại lỗi với C1.

Lý do chọn host chứ không phải cả URL: cổng do OS cấp và đổi mỗi lần `/remote on`, còn
đường dẫn thì không mang thông tin gì. Host là thứ định danh máy.
