# Thiết kế: đăng nhập hub bằng Slack, danh tính lấy qua token-slayer

Ngày: 2026-08-10
Trạng thái: đã chốt qua brainstorm, chờ lập kế hoạch thực thi
Liên quan: `deploy.sh adduser`, `server/src/users.js`, `setup-notify.sh`

---

## 1. Vấn đề

Hub sắp deploy song song với **token-slayer** (Laravel, đăng nhập bằng Slack OAuth) trên
cùng một server, cùng docker network. Cả team đã có tài khoản ở đó.

Hôm nay hub cấp token bằng tay: `./deploy.sh adduser ten-nguoi` sinh một chuỗi ngẫu nhiên,
ghi vào `data/users.json`, chủ hub gửi riêng cho từng người, người đó dán vào PWA và vào
`setup-notify.sh`. Với vài người thì được; với cả team thì mỗi lần có người mới là một
vòng nhắn tin thủ công, và chuỗi token đi qua kênh chat.

Yêu cầu: **ai đăng nhập được Slack thì tự dùng được hub, không cần ai cấp phát.**

## 2. Khảo sát token-slayer — cái gì dùng được, cái gì không

### 2.1 `TOKEN_SLAYER_TOKEN` là gì

Sinh **đúng một lần**, ở lần Slack OAuth đầu tiên (`SlackController::callback()`):

```php
$plainToken = Str::random(48);
User::create([... 'hook_token' => hash('sha256', $plainToken)]);
session()->put('hook_token_plain', $plainToken);   // hiện 1 lần ở /profile
```

- Server **chỉ giữ sha256**, không giữ bản rõ.
- Một token / một user. Không hạn dùng, không scope, **không có bảng revoke** — chỉ có
  `Profile::regenerate()` do chính chủ bấm, và nó *ghi đè* chứ không phải cấp thêm.
- Xác thực qua `AuthenticateHookToken`: `Bearer` → tra `users.hook_token = sha256(token)`.
- Trên máy dev nằm ở `~/.config/token_slayer/token` (chmod 600); biến env
  `TOKEN_SLAYER_TOKEN` chỉ dùng lúc cài để ghi ra file đó.

### 2.2 Vì sao KHÔNG dùng chung token này

1. **Regenerate là chung số phận.** Bấm regenerate vì lý do hub → hook tracking chết im
   lặng trên mọi máy dev, và ngược lại. Không thu hồi riêng lẻ được.
2. **Blast radius gộp.** Một file `~/.config/token_slayer/token` lộ = vừa ghi được usage
   events, vừa có danh tính trên hub. Shell vẫn an toàn (phiên terminal do khoá ECDSA trong
   điện thoại ký, hub không giữ khoá mở được phiên) nhưng metadata thì mất: lịch sử thông
   báo, danh sách phiên đang mở, push devices.
3. **Phụ thuộc vận hành.** Dùng chung thật sự thì hub phải hỏi token-slayer mỗi khi gặp
   token lạ → token-slayer chết là hub không xác thực được.

### 2.3 token-slayer không có off-boarding — và đó là chủ ý

Đã tra và xác nhận:

- `users` **không có** `deleted_at` / `is_active` / cột trạng thái nhân sự nào.
- `UserResource.php:183`: *"self-register via Slack OAuth, so there is no create/delete
  page here"* — panel admin không có trang tạo/xoá user; trang Edit chỉ sửa **roles**.
- Không scheduled command nào rà thành viên Slack. `accounts:sync-profiles` đồng bộ profile
  của **Account Anthropic**, không phải nhân sự.
- `MembershipStatus` (untracked/tracked/pending) là trạng thái user **trên một account
  Anthropic**, không liên quan nhân sự.

Hệ quả: người rời công ty bị disable Slack thì **không login lại được**, nhưng `hook_token`
cũ trên laptop họ **vẫn chạy vĩnh viễn**.

**Kết luận cho thiết kế này: hub không thể thừa hưởng off-boarding từ token-slayer vì không
có cái nào để thừa hưởng.** Đã chốt hub đứng ngang mức đó (§3, mục 5) chứ không tự đặt tiêu
chuẩn cao hơn.

### 2.4 Cái dùng được: `ide_access_tokens`

Bảng token thứ hai của token-slayer, phục vụ extension VSCode/JetBrains, **có đủ thứ mà
`hook_token` thiếu**: `kind` (one_time / bearer / session_url), `expires_at`, `consumed_at`,
`revoked_at`, `last_used_at`, và `atomicConsume()` tiêu thụ nguyên tử.

Kèm sẵn luồng OAuth: `/auth/slack?return=ide&state=…` → `IdeAccessToken::issueOneTime()` →
`POST /api/ide/auth/exchange` → bearer → `GET /api/ide/me` / `POST /api/ide/auth/revoke`.

Thiết kế này đi nhờ **nửa đầu** đường ray đó — cấp `one_time` gắn với `state`. Nửa sau
(bearer) **cố ý không dùng**, vì lý do ở §2.5.

### 2.5 Vì sao không dùng bearer của luồng IDE

Bearer của luồng IDE **sống lâu hơn và với xa hơn** thứ luồng này cần. Đã đọc code
token-slayer và xác nhận điều đó ở mức đủ để loại nó khỏi thiết kế; chi tiết kỹ thuật đã
**báo riêng cho team token-slayer qua kênh bảo mật của họ**, và cố ý không chép vào tài liệu
này — đây là repo công khai, còn thứ được báo thì tại thời điểm viết vẫn chưa vá.

Điều cần giữ lại ở đây là kết luận và hệ quả thiết kế:

- Nếu hub đổi token lấy bearer thì **mỗi lần có người đăng nhập, hub lại cầm một credential
  mạnh hơn hẳn thứ nó cần**. Revoke ngay sau đó thu hẹp cửa sổ nhưng không đóng được: hub
  crash giữa hai lời gọi là để lại một chìa khoá không ai biết.
- Hub **chỉ cần một cái tên**. Nguyên tắc: không cầm thứ mạnh hơn việc mình làm — không
  trong RAM, không trong log, không trong URL.

**Vì thế thiết kế này xin một endpoint riêng, không cấp bearer** (§7). Nó cũng giữ được
tính chất quan trọng hơn: quan hệ hub ↔ token-slayer **một chiều** — hub hỏi, token-slayer
trả lời. Đi đường bearer là bắt token-slayer phải *tin* hub với quyền tạo session cho bất
kỳ ai.

> **Ghi chú quy trình:** phần chi tiết bị lược ở trên không mất đi — nó nằm trong báo cáo
> gửi kênh bảo mật của token-slayer. Chép một chuỗi khai thác chưa vá vào repo công khai là
> việc không thu hồi được, nên tài liệu này dừng ở mức "vì sao không đi đường đó".

## 3. Quyết định đã chốt

1. **Token riêng cho hub, token-slayer làm identity provider.** Hub giữ token của chính nó
   trong `data/users.json`; token-slayer chỉ trả lời "người này là ai".
2. **Self-service cho cả team** — ai login Slack được là dùng được, không cần ai duyệt.
3. **PWA đăng nhập bằng nút "Đăng nhập bằng Slack"**, không copy chuỗi nào.
4. **Máy dev dùng device-code** — script in mã ngắn, duyệt trên thiết bị đã login, script
   tự nhận token.
5. **Một token / một user**, mọi thiết bị dùng chung. Token **sống mãi**; thu hồi bằng lệnh
   tay `./deploy.sh deluser <tên>`.
6. **Khoá là `slack_user_id`** (bất biến), kèm `displayName` riêng để hiển thị.
7. **Cách nối: hub làm client của token-slayer**, tái dụng pattern `return=ide` **cho tới
   bước cấp `one_time`**, rồi đổi qua một endpoint riêng không cấp bearer (§2.5, §7).

### 3.1 Phương án đã cân nhắc và bác

**Hub nói thẳng với Slack (không qua token-slayer).** Hub tự chạy Slack OAuth, tự lấy
`slack_user_id`. Ưu: sửa token-slayer **0 dòng**, không phụ thuộc uptime của nó kể cả lúc
login, ít mắt xích hơn hẳn (① đi 6 chặng, 3 trong đó là token-slayer, chỉ để lấy về một
chuỗi mà Slack sẵn sàng trả thẳng).

**Bác vì lý do tổ chức, không phải kỹ thuật:** cần quyền thêm redirect URL vào Slack app
của workspace (hoặc tạo app thứ hai), và hub phải giữ Slack client secret.

Vì đây là ràng buộc tổ chức chứ không phải kiến trúc, thiết kế dưới đây **cô lập toàn bộ
phần biết về token-slayer vào đúng một file** (`server/src/identity.js`) — đổi ý sau này
thì chỉ file đó bị thay.

**token-slayer đẩy sang hub** (nút trên `/profile` gọi `POST hub/admin/users`). Ít trạng
thái nhất, nhưng PWA không có nút Slack và user vẫn phải copy — mâu thuẫn với quyết định 3.

## 4. Kiến trúc

### 4.1 Module mới

| Module | Việc duy nhất | Phụ thuộc |
|---|---|---|
| `server/src/identity.js` | Một lời gọi: đổi `one_time` lấy `{slackUserId, handle}`. **Chỗ duy nhất trong hub biết token-slayer tồn tại.** | `fetch`, 2 env URL |
| `server/src/device-code.js` | Vòng đời `deviceCode`/`userCode`: cấp, duyệt, đổi, hết hạn, khoá khi gõ sai | không |
| `server/src/oauth-state.js` | `state` và `claimCode` — hai kho one-shot có TTL | không |

**Cả hai kho đều nằm trong RAM, mất khi hub khởi động lại** — cùng lựa chọn với lịch sử
thông báo hiện nay. Thứ sống trong đó lâu nhất là 10 phút, nên hub restart chỉ làm hỏng
những luồng đang dở: người dùng bấm lại là xong. Không đáng ghi ra đĩa một thứ tự hết hạn
nhanh hơn thời gian giữa hai lần deploy.

### 4.2 File bị sửa

- `server/src/users.js` — shape mới + `upsertBySlackId()` + `removeUser()`
- `server/src/index.js` — 6 route mới, cộng trang tĩnh `/link` (§5.3)
- `server/public/index.html` + `app.js` — nút Slack, xử lý `?login=`, trang `/link`
- `setup-notify.sh` — device-code thay vì hỏi token
- `deploy.sh` — thêm `deluser`

### 4.3 Cấu hình

Hai URL **tách bạch, không dùng lẫn**:

| Biến | Dùng ở đâu |
|---|---|
| `CCRC_TS_PUBLIC_URL` | Dán vào redirect cho **trình duyệt** đi |
| `CCRC_TS_INTERNAL_URL` | Hub gọi **nội bộ** trong docker network (`http://token-slayer`), không ra internet |

Bên token-slayer: `CCRC_CALLBACK_URL` — URL callback của hub, **cố định trong `.env`**.

### 4.4 Shape `users.json`

```json
[
  { "name": "U01ABCDEF", "displayName": "huy", "token": "..." },
  { "name": "huy-cu", "token": "..." }
]
```

`name` = `slack_user_id`. Entry cũ do `deploy.sh adduser` tạo **không có** `displayName` →
đọc thành `displayName = name`. Không cần migration file.

`parseUsers` giữ nguyên hai chốt chặn đang có: loại entry tên `admin`, loại entry trùng
`CCRC_TOKEN`. Với khoá là `slack_user_id` thì va chạm `admin` gần như không xảy ra
(`U01ABCDEF` ≠ `admin`), nhưng chốt vẫn phải còn vì `adduser` thủ công vẫn tồn tại.

### 4.5 `deploy.sh deluser`

Khoá giờ là `U01ABCDEF` — không ai nhớ được. Nên `deluser` nhận **hoặc** `displayName`
**hoặc** `name`, và:

- Khớp đúng một entry → xoá, in ra cả hai trường để người chạy thấy mình vừa xoá ai.
- Khớp nhiều entry (hai người trùng `displayName`) → **không xoá gì**, liệt kê ra và bắt
  gõ lại bằng `name`. Xoá nhầm người ở đây là mất push subs và phiên đang mở của họ.
- Không khớp → báo không tìm thấy, liệt kê các tên đang có.

Cùng lý do với `adduser`: lệnh này chạy lúc có sự cố nhân sự, không phải lúc rảnh rang.

**Chấp nhận có mất mát một lần:** ai đang có entry thủ công tên `huy`, sau khi login Slack
sẽ thành một user **khác** (`U01ABCDEF`) — mất push subs, lịch sử, phiên đang mở của entry
cũ. Cách xử lý: báo mọi người đăng ký lại push trên điện thoại một lần, rồi xoá entry cũ.
**Không** viết cơ chế gộp tự động cho một lần dùng duy nhất.

## 5. Luồng dữ liệu

### 5.1 Luồng A — PWA đăng nhập bằng Slack

```
PWA  ─ bấm "Đăng nhập bằng Slack"
  │
  ├─► GET <hub>/auth/start
  │      sinh state (32 byte), lưu one-shot TTL 5'
  │      302 → <TS_PUBLIC>/auth/slack?return=ccrc&state=<state>
  │
  ├─► Slack OAuth ──► TS SlackController::callback()
  │      IdeAccessToken::issueOneTime($user, $state, 120)
  │      302 → <config('services.ccrc.callback_url')>?token=…&state=…
  │
  ├─► GET <hub>/auth/callback?token&state
  │      ① state còn sống & khớp? → tiêu huỷ ngay (one-shot)
  │      ② POST <TS_INTERNAL>/api/ccrc/auth/exchange {token,state}
  │             → {slackUserId, handle}     ← KHÔNG cấp bearer, không gì để revoke
  │      ③ upsertBySlackId(slackUserId, handle) → hubToken
  │      ④ claimCode (32 byte, TTL 60s, one-shot)
  │      302 → /?login=<claimCode>
  │
  └─► app.js thấy ?login= → POST /api/auth/claim {code}
         → {token, displayName} → localStorage
         → history.replaceState('/')      ← xoá code khỏi thanh địa chỉ
```

**Vì sao có `claimCode` thay vì nhét token vào URL.** Token hub sống mãi (quyết định 5).
URL thì đi vào history trình duyệt, vào header `Referer` của mọi request kế tiếp, và vào
access log của reverse proxy đứng trước hub. Một secret vĩnh viễn không được phép đi qua ba
chỗ đó. `claimCode` sống 60 giây và dùng đúng một lần — lọt ra ngoài cũng đã chết.

**Vì sao chỉ một lời gọi ở bước ②.** Xem §2.5: đi qua `/api/ide/auth/exchange` là đúc ra
một bearer chiếm được tài khoản token-slayer và không bao giờ hết hạn. Endpoint riêng trả
thẳng danh tính nên **hub không bao giờ cầm thứ gì mạnh hơn một cái tên** — không có gì để
revoke, không có cửa sổ nào để crash vào giữa.

### 5.2 Luồng B — máy dev lấy token (device-code)

```
setup-notify.sh                    hub                       PWA (đã login)
 POST /api/device/start ─────────►  cấp deviceCode(32B) + userCode(K7M2-QX9F)
      ◄──── {deviceCode, userCode, ttl:600, interval:5}
 in: "Mở <hub>/link, nhập K7M2-QX9F"
 poll /api/device/poll ──────────►  428 pending
   (mỗi 5s)                                     ◄─── POST /api/device/approve
                                                     {userCode} + Bearer
                                    gắn deviceCode ↔ user
      ◄──── 200 {token, displayName}
 ghi ~/.ccrc/token (chmod 600)
```

**Bất đối xứng cố ý:** `userCode` ngắn để người gõ được, nhưng thứ **đổi ra token** là
`deviceCode` 32 byte. Nếu để `userCode` đổi được token thì tám ký tự đó là toàn bộ hàng
rào. Đây đúng là điều RFC 8628 tách ra, và cùng tinh thần cặp `pairId`/`sas` hub đang dùng
cho pairing.

**Bảng chữ của `userCode`:** 8 ký tự chia `XXXX-XXXX`, lấy từ **Crockford base32 bỏ
`I`, `L`, `O`, `U`** (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`). Bỏ ký tự dễ
đọc nhầm vì mã này được đọc từ màn hình laptop rồi gõ sang điện thoại; `0`/`O` và `1`/`I`
lẫn nhau ở đó là một lần thử sai vô cớ. Chấp nhận cả chữ thường và bỏ qua dấu gạch khi so.

**Chống lạm dụng `/api/device/start`** — endpoint này không có auth (đúng bản chất: máy dev
chưa có gì để xác thực). Hai chốt: rate-limit theo IP, và **trần số phiên pending đồng
thời** trên toàn hub. Không có trần thì một kẻ gọi liên tục sẽ vừa ngốn RAM vừa làm loãng
không gian `userCode` tới mức gõ đúng mã người khác trở thành chuyện có thật.

### 5.3 Route mới trên hub

| Route | Auth | Việc |
|---|---|---|
| `GET /link` | tĩnh | Trang nhập `userCode` (phục vụ từ `public/`, tự chuyển về đăng nhập nếu chưa có token) |
| `GET /auth/start` | không | Sinh state, redirect sang token-slayer |
| `GET /auth/callback` | không (state) | Đổi one-time → danh tính → upsert → claimCode |
| `POST /api/auth/claim` | không (claimCode) | Đổi claimCode lấy `{token, displayName}` |
| `POST /api/device/start` | không | Cấp `deviceCode` + `userCode` |
| `POST /api/device/poll` | không (deviceCode) | 428 pending / 200 token / 410 chết |
| `POST /api/device/approve` | **Bearer** | Gắn `userCode` với user đang đăng nhập |

## 6. Xử lý lỗi

| Tình huống | Hub làm gì | Người dùng thấy |
|---|---|---|
| `state` sai / hết hạn / dùng lại | Trang lỗi tĩnh, **không** tự redirect lại | "Phiên đăng nhập hết hạn — bấm đăng nhập lại" |
| token-slayer không phản hồi (timeout 5s) ở ② | 503, không tạo user | "Không liên lạc được token-slayer. Token đã cài trên máy vẫn dùng bình thường — chỉ đăng nhập mới hỏng." |
| ② trả 410 (`token_invalid_or_expired`) | 400, không tạo user | "Link đăng nhập đã dùng rồi hoặc quá 2 phút — thử lại" |
| ② trả `slackUserId` rỗng/thiếu | **Từ chối tạo user**, log lỗi | "Không lấy được danh tính Slack" |
| `/api/auth/claim` code sai/hết hạn | 410 | "Đăng nhập hết hạn, thử lại" |
| device poll trước hạn `interval` | 429 | script tự giãn nhịp |
| device poll khi đã hết hạn / bị huỷ | 410 | script **dừng**, in "Mã đã hết hạn, chạy lại" |
| `approve` gõ sai `userCode` | Đếm lần sai theo phiên duyệt, 5 lần → huỷ | "Sai mã (còn N lần)" |

**Bài học mượn thẳng từ token-slayer:** `SlackController` phải thêm `RETRY_FLAG` vì callback
hỏng từng tự redirect lại `/auth/slack`, và một session hỏng vĩnh viễn thì ping-pong vô
hạn. Hub không lặp lại: **mọi lỗi trong luồng OAuth dừng ở một trang tĩnh có nút bấm**,
không tự động đi tiếp.

**Bất biến quan trọng nhất:** hub **không ghi `users.json`** khi bước ② thất bại dưới bất
kỳ dạng nào. Ghi nửa vời ở đây nghĩa là một entry có token hợp lệ nhưng gắn sai danh tính —
tệ hơn hẳn một lần đăng nhập hỏng.

## 6b. Góc nhìn hệ thống

### 6b.1 Kiểm kê bí mật

| Bí mật | Ai giữ | Sống bao lâu | Mở được gì | Lộ thì sao |
|---|---|---|---|---|
| `CCRC_TOKEN` | hub `.env` | vĩnh viễn | user `admin` trên hub | Toàn bộ metadata hub |
| `users.json` (thô) | đĩa hub | vĩnh viễn | mọi user trên hub | Metadata cả team |
| Token hub / user | PWA + máy dev | vĩnh viễn | 1 user | Metadata 1 người, **không mở được shell** |
| `TOKEN_SLAYER_TOKEN` | máy dev | vĩnh viễn | ghi events | Rác bảng xếp hạng |
| ECDSA privkey | điện thoại | tới khi xoá app | **shell thật** | non-extractable — không bê đi được |
| `state` / `claimCode` / `deviceCode` | RAM hub | 5' / 60s / 10' | một bước trong luồng | Hết hạn là chết |

Đọc theo cột "mở được gì": **không dòng nào trong luồng auth này chạm tới shell.** Toàn bộ
thiết kế chỉ di chuyển quyền đọc *metadata* — lịch sử thông báo, danh sách phiên, push
devices. Đó là mức rủi ro cần cân, không phải "ai chiếm được token là vào được máy dev".

### 6b.2 Trần bảo đảm không đổi

`2026-07-29-ghep-cap-thiet-bi-design.md` §2 đã chốt mức 1: hub phục vụ `app.js`, nên ai
kiểm soát hub thì kiểm soát JavaScript chạy trên điện thoại. Đăng nhập bằng Slack **không
nâng trần đó, cũng không hạ**. Trước đây token do người dùng gõ vào, giờ hub tự đúc — nghe
như hub có thêm quyền, nhưng hub vốn đã đọc được `users.json`. Luồng auth này *trung tính*
với mô hình đe doạ đã chốt.

### 6b.3 Chế độ hỏng

| Ai chết | Hỏng gì | Vẫn chạy gì |
|---|---|---|
| token-slayer | Đăng nhập mới, device-code mới | **Mọi token đã cài — thông báo, terminal, tất cả** |
| Slack | Đăng nhập mới | như trên |
| hub | Thông báo, danh sách phiên | Terminal *đang mở* (không đi qua hub) |
| Tailscale | Terminal | Thông báo |

Dòng đầu là điều đáng giá nhất của thiết kế: token-slayer nằm trên đường **kết nạp**, không
nằm trên đường **vận hành**. Đây chính là thứ mua được so với việc dùng chung
`TOKEN_SLAYER_TOKEN` (§2.2) — ở đó token-slayer chết là hub tê liệt hoàn toàn.

### 6b.4 Khớp nối cứng còn lại

`slack_user_id` là khoá cho mọi state trên hub. Nếu team **đổi workspace Slack**, mọi id
đổi theo → toàn bộ user hub thành người mới, mất push subs / lịch sử / phiên. Rất hiếm, và
**không có đường vá** ngoài việc map tay `users.json`. Ghi ra đây để sau này không ai phải
đi tìm lại nguyên nhân.

## 7. Phạm vi sửa token-slayer

**4 file, ~45 dòng, không migration, không đụng schema.**

| File | Sửa gì | Cỡ |
|---|---|---|
| `config/services.php` | Thêm `'ccrc' => ['callback_url' => env('CCRC_CALLBACK_URL')]` | 4 dòng |
| `SlackController::redirect()` | Nhánh `return === 'ccrc'` → `session()->put('ccrc_oauth', ['state' => …])` | ~6 dòng |
| `SlackController::callback()` | `consumeCcrcFlowState()` + `redirectToCcrc()`, đặt **sau** nhánh IDE | ~20 dòng |
| `routes/api.php` + `Api/Ccrc/ExchangeController` *(mới)* | `POST /api/ccrc/auth/exchange` — `consumeOneTime($token,$state)` → `{slackUserId, handle}`, **không cấp token nào** | ~15 dòng |

Luồng IDE hiện có **không đổi một dòng nào**: nhánh `ccrc` đứng cạnh (không sửa
`redirectToIde()`), và endpoint mới chỉ *đọc* `IdeAccessToken::consumeOneTime()` — không
động vào `MeController`, `AuthController`, hay `AuthenticateIdeBearer`.

Endpoint mới đi cùng `throttle:30,1` như nhóm `/api/ide`, và **không** nằm sau
`ide.bearer` — nó là đầu vào của luồng, giống `exchange` của IDE.

### 7.1 Chỗ reviewer sẽ soi kỹ nhất

Câu hỏi chắc chắn bị hỏi: *"thêm một đích redirect nữa là mở open redirect à?"* Câu trả lời
phải nằm sẵn trong diff:

```php
// KHÔNG nhận `redirect` từ query như nhánh IDE. Đích đến đọc từ config,
// nên không tồn tại tham số nào để bẻ hướng. isLoopbackUrl() không áp
// dụng được ở đây (hub không chạy trên loopback), nên thay vì nới lỏng
// nó, nhánh này bỏ hẳn đầu vào động.
$callback = config('services.ccrc.callback_url');
if (! is_string($callback) || $callback === '') {
    return null;   // chưa cấu hình → không có nhánh ccrc, đi luồng thường
}
```

Hai tính chất: **đích đến không nhận đầu vào từ người dùng**, và **chưa cấu hình thì
fail-closed**.

Đây cũng là lý do đọc từ config chứ **không nới `isLoopbackUrl()`**: hàm đó đang bịt đúng
lỗ hổng này, sửa nó là mở lại cho cả nhánh IDE.

### 7.2 Câu hỏi thứ hai: "sao không dùng lại `/api/ide/auth/exchange`?"

Trả lời bằng §2.5, một câu: *dùng lại nó là trao cho CCRC một credential sống lâu hơn và
với xa hơn nhiều so với việc nó làm; endpoint này chỉ trao một cái tên.*

Endpoint mới **không cấp token nào**, nên nó không mở rộng bề mặt tấn công của
`ide_access_tokens` — nó chỉ thêm một người tiêu thụ `one_time`, đúng thứ vốn đã hết hạn
sau 120 giây và tiêu thụ nguyên tử một lần.

## 8. Testing

### 8.1 Hub — `node:test`, đúng phong cách repo (tên tiếng Việt, assert kèm lý do)

| File | Chốt điều gì |
|---|---|
| `users.test.js` *(mở rộng)* | Entry cũ thiếu `displayName` vẫn nạp được; upsert hai lần cùng `slack_user_id` không đẻ entry thứ hai; đổi handle chỉ đổi `displayName`, **giữ nguyên token và khoá** |
| `device-code.test.js` | Happy path; TTL; đổi một lần rồi chết; **`userCode` không đổi ra token được**; 5 lần sai thì huỷ; chạm trần phiên pending thì từ chối cấp thêm; bảng chữ không sinh ra `I`/`L`/`O`/`U` |
| `oauth-state.test.js` | `state` và `claimCode` one-shot, hết hạn đúng |
| `identity.test.js` | Mock `fetch`: exchange 410 → không tạo user; trả thiếu `slackUserId` → từ chối; timeout 5s → 503; **hub gọi đúng `TS_INTERNAL` chứ không phải `TS_PUBLIC`** |
| `auth-flow.test.js` | Qua HTTP thật (khuôn `terminal-api.test.js`): dùng lại `state` bị chặn; **token không bao giờ xuất hiện trong URL**; lỗi giữa chừng thì `users.json` không bị ghi |
| `shell-scripts.test.js` *(mở rộng)* | `setup-notify.sh` đi device-code, và **dừng** khi gặp 410 thay vì poll mãi |

### 8.2 token-slayer — Pest, `tests/Feature/Auth/`

- `return=ccrc` lưu state vào session rồi đi Slack
- Callback trả về đúng `callback_url` kèm `token` + `state`
- **`?redirect=https://evil.com` không ảnh hưởng nhánh ccrc** ← test chống open redirect
- Chưa cấu hình `CCRC_CALLBACK_URL` → không redirect ra ngoài
- Regression: luồng IDE cũ vẫn nguyên
- `POST /api/ccrc/auth/exchange`: đúng `token`+`state` → `{slackUserId, handle}`; sai
  `state` → 410; gọi lại lần hai → 410 (`consumeOneTime` nguyên tử); quá 120s → 410
- **Endpoint mới KHÔNG tạo dòng nào trong `ide_access_tokens`** ← chốt "không cấp bearer"
  thành test, để một refactor sau này không lặng lẽ thêm lại

### 8.3 Ràng buộc thứ tự

Hub hiện có **694 test đang xanh**. Thiết kế này đụng `users.js`/`parseUsers` — thứ mà
`terminal-api.test.js` đang dựa vào — nên phần đổi shape phải làm TDD thật sự: **viết test
tương thích ngược trước, rồi mới đổi**.

## 9. Nằm ngoài phạm vi

- **Off-boarding tự động.** Đã chốt đứng ngang token-slayer (§2.3): token sống mãi, thu hồi
  bằng `./deploy.sh deluser <tên>`.
- **Băm token trong `users.json`.** Vẫn lưu thô như hôm nay; đây là món nợ có sẵn, không
  phải do thiết kế này tạo ra.
- **Nhiều token / một user** (mỗi thiết bị một token, thu hồi từng cái). Đã cân nhắc, bác
  để giữ shape `users.json` đơn giản.
- **Gộp entry thủ công cũ vào entry Slack mới** (§4.4).
- **Vá off-boarding cho chính token-slayer.** Là lỗ hổng thật (§2.3) nhưng ngoài phạm vi, và
  làm thế thì phần sửa token-slayer không còn "nhỏ để dễ review" nữa.
- **Vá phần yếu của luồng bearer bên token-slayer** (§2.5). Thiết kế này *tránh* nó chứ
  không sửa nó. Đã báo riêng cho team token-slayer qua kênh bảo mật của họ; chi tiết không
  chép vào đây.
- **Đổi workspace Slack** (§6b.4) — không có đường vá tự động, chấp nhận map tay.
