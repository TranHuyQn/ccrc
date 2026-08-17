# CC Remote Control

> 🇬🇧 English version: [`README.md`](README.md) · Threat model: [`SECURITY.md`](SECURITY.md)
> · Giấy phép: [MIT](LICENSE)

Hệ thống làm hai việc, đều bắt đầu từ lúc Claude Code trên máy dev dừng lại chờ bạn:

1. **Báo** — gửi thông báo đẩy tới điện thoại khi Claude cần bạn nhập tiếp hoặc xác
   nhận (câu hỏi hoặc xin quyền chạy tool), để bạn biết lúc nào cần quay lại.
2. **Trả lời ngay từ điện thoại** — `/remote on` trong Claude Code mở một **terminal
   web** cho đúng pane tmux đó. Trang terminal do chính máy dev phục vụ và **chỉ với
   tới được trong tailnet Tailscale riêng của bạn**. Điện thoại tự ký yêu cầu mở
   terminal bằng một khoá riêng không xuất được nằm trong chính nó (sinh ra lúc
   ghép cặp — `/remote pair`); máy dev xác minh bằng khoá công khai nó học được lúc
   đó. Hub chỉ giữ metadata (không giữ khoá nào mở được phiên của ai), không có byte
   shell nào đi qua nó. Chạy được **nhiều phiên cùng lúc** — PWA hiện thành danh
   sách, mỗi pane một thẻ.

**Tên thư mục không bao giờ rời khỏi máy dev.** Mỗi phiên hiện ra dưới một id ngẫu
nhiên (`k7m2`); muốn dễ nhận thì tự đặt: `/remote on tên-bạn-muốn`. Thông báo đẩy cũng
dùng đúng tên đó, và khi không có phiên nào đang chạy thì chỉ hiện tên máy. Lý do:
nhãn này nằm trên màn hình khoá và trong mọi ảnh chụp màn hình, mà thứ đã bị nhìn thấy
thì không thu hồi được.

Đang mở terminal của phiên nào trên điện thoại thì **phiên đó không bắn thông báo** —
khoá màn hình hoặc chuyển sang app khác là thông báo trở lại ngay.

Vẫn **không** mirror phiên và **không** chat từ xa: mỗi daemon gắn đúng một pane, không
mở thêm pane hay cửa sổ nào.

> 📖 **Đi tiếp từ đâu**
>
> | Bạn muốn | Đọc |
> |---|---|
> | Tự dựng hub cho mình hoặc cho nhóm | [`docs/self-hosting.md`](docs/self-hosting.md) (tiếng Anh) |
> | Cài máy và điện thoại, khi đã được cấp token | [`docs/huong-dan.md`](docs/huong-dan.md) |
> | Biết hệ thống chống được gì và KHÔNG chống được gì | [`SECURITY.md`](SECURITY.md) (tiếng Anh) |
>
> README này thiên về kiến trúc và vận hành.

## Ba mảnh

```
 Máy dev                          Hub server                    Điện thoại
┌──────────────────┐   HTTP POST ┌──────────────────┐  Web Push ┌──────────────┐
│ hook Notification │────────────►│  /notify → lưu +  │──────────►│  PWA cài trên │
│ (hook/)            │  /notify   │  bắn Web Push     │           │  màn hình chính│
└──────────────────┘             └──────────────────┘           └──────────────┘
```

- **Hook** (`hook/`): script chạy khi Claude Code bắn sự kiện `Notification`. Đọc công
  tắc bật/tắt cục bộ (`~/.ccrc/notify`); nếu bật thì POST thẳng lên hub kèm token cá
  nhân. Không có tiến trình nền, không WebSocket.
- **Hub** (`server/`): Node.js — nhận `/notify`, xác thực token, bắn Web Push tới điện
  thoại của đúng người. Không giữ session, không transcript, không relay.
- **PWA** (`server/public/`): trang tĩnh do hub phục vụ, cài lên màn hình chính điện
  thoại để nhận thông báo.

## Cài đặt

### 1. Hub trên server

```bash
git clone https://github.com/TranHuyQn/ccrc && cd ccrc
cp .env.example .env             # điền CCRC_TOKEN (openssl rand -hex 24)
                                 # và CCRC_VAPID_SUBJECT nếu có người dùng iPhone
docker compose -p cc-remote-control --profile cloudflare up -d --build
./deploy.sh adduser ten-nguoi     # cấp token riêng cho từng thành viên
```

`-p cc-remote-control` đừng bỏ nếu bạn còn định dùng `deploy.sh`: đó là tên project
nó dùng, còn Compose mặc định lấy tên thư mục. Lệch nhau thì `./deploy.sh status` báo
trống trơn trong khi hub vẫn chạy ngon lành — đơn giản vì hai bên đang nhìn hai project
khác nhau.

**Tuỳ chọn — đăng nhập bằng Slack.** Chạy token-slayer (một dịch vụ định danh
Slack-OAuth) cạnh hub thì đặt `CCRC_TS_PUBLIC_URL` và `CCRC_TS_INTERNAL_URL` trong
`.env` (kèm `CCRC_CALLBACK_URL` bên token-slayer) là cả team tự đăng nhập — không cần
`adduser` cho từng người. Máy dev khi đó chạy lệnh cài không kèm token: nó in một mã
ngắn, ai đó đã đăng nhập bấm duyệt, máy tự nhận token của mình.

Thu hồi vẫn là việc tay và sẽ mãi là việc tay: `./deploy.sh deluser <tên>`. **Hub không
bao giờ hỏi lại Slack**, nên người đã rời team vẫn dùng được cho tới khi có người chạy
lệnh đó. Cho nó vào checklist off-boarding — vô hiệu hoá tài khoản Slack của họ chỉ
chặn đăng nhập mới, không đụng gì tới token đã nằm trên máy.

⚠ **Có người dùng iPhone thì `CCRC_VAPID_SUBJECT` là bắt buộc**, không phải tuỳ chọn.
Bỏ trống là hub rơi về `mailto:admin@localhost`, Apple trả `403 BadJwtToken` cho mọi
push, và iPhone không nhận được gì — trong khi `/notify` vẫn báo thành công, thiết bị
vẫn hiện là đã đăng ký, còn Android và Firefox vẫn chạy đúng. Nghĩa là kiểm thử bằng
máy Android sẽ không bao giờ phát hiện ra. Đặt bằng domain công khai của hub
(`https://<hub-của-bạn>`) rồi **tạo lại** container — `docker restart` không nạp biến
mới. Đổi giá trị này không ảnh hưởng đăng ký cũ: không ai phải cài lại app.

`deploy.sh` (dùng cùng Docker Compose ở trên) tự sinh `CCRC_TOKEN`, hỏi Cloudflare
Tunnel token và `CCRC_VAPID_SUBJECT` (nhắc lại ở cuối nếu còn thiếu), build và kiểm
tra hub. Có tunnel token thì nó ghi thêm
`CCRC_TRUST_PROXY=1` và `CCRC_BIND=127.0.0.1` — hai cái đi liền nhau, xem bảng biến
bên dưới. Tiện ích kèm theo: `./deploy.sh status` · `down`.
Không dùng Cloudflare Tunnel thì dùng `--profile tls` (Caddy, cần domain) hoặc chạy
Node trực tiếp: `npm install && CCRC_TOKEN=<token> npm run server`.

### 2. Máy dev

Từ bản git clone:

```bash
./setup-notify.sh        # hỏi URL hub + token cá nhân, cài hook + /notify
```

Máy không có bản clone thì cài từ chính hub của bạn — URL hub **bắt buộc**, không có mặc
định, vì mỗi người tự dựng hub riêng:

```bash
curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token> https://<hub-cua-ban>
```

Gỡ bằng `./remove-notify.sh` (hoặc `https://<hub-cua-ban>/uninstall.sh`). Không cài
service nền, không đụng tmux.

## Bật / tắt

**Mặc định TẮT** — mỗi máy dev phải chủ động bật:

```
/notify on       # bật thông báo từ máy này
/notify off      # tắt
/notify          # kiểm tra trạng thái + thử gọi hub
```

Khi tắt, hook thoát ngay, không có request nào rời máy — không dữ liệu nào gửi đi.

## Trên điện thoại

Mở URL của hub, đăng nhập bằng token cá nhân. **iPhone bắt buộc**: Safari → Chia sẻ →
*Thêm vào Màn hình chính* → mở app từ icon vừa thêm rồi mới bật thông báo — mở từ tab
Safari thường sẽ **không** nhận được push (giới hạn của iOS, không phải lỗi).

## Loại thông báo

Chỉ hai loại, đúng theo hook `Notification` của Claude Code:

- **Đang chờ nhập** — Claude dừng, chờ bạn gõ tiếp.
- **Cần xác nhận** — Claude hỏi một câu, hoặc xin quyền chạy tool (Bash, ghi file...).

## Biến môi trường

**Hub** (đặt trong `.env` hoặc khi chạy Node trực tiếp):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CCRC_TOKEN` | (bắt buộc) | Token admin của hub |
| `CCRC_PORT` | `8720` | Cổng HTTP |
| `CCRC_BIND` | `0.0.0.0` | Địa chỉ bind: vế publish `ports:` trên host khi chạy bằng Docker, và địa chỉ `app.listen()` khi chạy hub bằng Node trực tiếp. Đặt `127.0.0.1` khi đã có tunnel/reverse proxy đứng trước. Đừng đưa vào `environment:` của container — hub bên trong container phải nghe `0.0.0.0` thì tunnel mới tới được |
| `CCRC_TRUST_PROXY` | (trống = tắt) | Đặt `1` khi có tunnel/reverse proxy đứng trước, để rate-limit đếm đúng IP client. **Phải đi kèm `CCRC_BIND=127.0.0.1`** — cổng còn vào thẳng được thì cờ này vô nghĩa, vì client tự viết được `X-Forwarded-For`. Quên bật khi CÓ proxy thì hỏng chiều ngược lại: mọi request trông như đến từ proxy, một người gọi nhiều là cả team ăn 429 |
| `CCRC_DATA_DIR` | `server/data` (Docker: volume `ccrc-data`) | Nơi lưu `users.json`, khoá VAPID, push subscriptions |
| `CCRC_VAPID_SUBJECT` | `mailto:admin@localhost` | Contact cho Web Push — **bắt buộc đặt thật nếu có người dùng iPhone**. Apple từ chối gửi push tới subject mặc định (403 `BadJwtToken`); hub vẫn báo `/notify` thành công, nhưng iPhone không bao giờ nhận được gì. Android (FCM) và Firefox không bị ảnh hưởng nên lỗi này dễ lọt qua test thủ công trên máy Android. Hub tự cảnh báo ra log lúc khởi động nếu subject còn là mặc định hoặc trỏ về localhost — đặt thành `https://<domain-hub-của-bạn>` hoặc một `mailto:` liên hệ thật để tắt cảnh báo |
| `CCRC_TUNNEL_TOKEN` | (trống) | Token Cloudflare Tunnel (profile `cloudflare`) |
| `CCRC_DOMAIN` | (trống) | Domain cho Caddy TLS (profile `tls`) |
| `CCRC_TS_PUBLIC_URL` | (trống) | URL dịch vụ định danh cho trình duyệt redirect tới — đi cùng cặp với biến dưới, thiếu một trong hai thì đăng nhập Slack tắt hẳn |
| `CCRC_TS_INTERNAL_URL` | (trống) | URL dịch vụ định danh hub tự gọi trong mạng nội bộ — đảo hai cái thì đăng nhập trông ổn trên trình duyệt nhưng hỏng ở phía hub |

**Máy dev** — `./setup-notify.sh` hỏi và ghi vào `~/.ccrc/config` (không cần đặt tay):
`CCRC_HUB_URL`, `CCRC_TOKEN` (token cá nhân), `CCRC_MACHINE_NAME`. `/remote pair` ghi thêm
`~/.ccrc/devices.json` — khoá **công khai** của mỗi điện thoại đã ghép với máy này; khoá
riêng không bao giờ rời điện thoại và không nằm trong file này.

### Tài khoản riêng cho từng thành viên

Có đăng nhập Slack rồi thì họ tự tạo, bạn không phải làm gì. Còn lại, dùng
`./deploy.sh adduser <tên>` (Docker), hoặc tự sửa `CCRC_DATA_DIR/users.json` (hub tự
nạp lại trong ~5s):

```json
[
  { "name": "huy", "token": "token-rieng-cua-huy" },
  { "name": "lan", "token": "token-rieng-cua-lan" }
]
```

Mỗi người một token riêng — thông báo chỉ tới đúng chủ token.

## Bảo mật

- **Token cá nhân**: ai có token nào thì nhận được thông báo của người đó. Thu hồi bằng
  cách xoá dòng trong `users.json`.
- **Ghép cặp thiết bị (terminal)**: mở terminal đòi một token ký ECDSA P-256 bằng khoá
  riêng **không xuất được**, sinh ra trên chính điện thoại lúc `/remote pair`. Từ
  2026-07-29 việc xác nhận là **một chiều**: máy dev không in số của chính nó ra, chỉ
  đứng chờ; điện thoại hiện một mã 6 chữ số; bạn đọc mã đó **trên chính điện thoại của
  mình** rồi gõ số đó vào máy dev bằng `/remote pair xac-nhan <số>` — máy dev so với số nó
  tự tính, khớp mới ghi. Lý do: hub là bên chọn nó nói chuyện với ai, và có thể làm điều đó
  một cách hoàn toàn trung thực với điện thoại của kẻ tấn công trong khi điện thoại thật
  của bạn tưởng đang so số với máy dev của mình — nút "Khớp" trên hai màn hình không đủ
  tin cậy để quyết định gì cả. Hub chỉ relay chuỗi trong lúc ghép, và giữ **khoá công
  khai** của điện thoại đúng 5 phút
  rồi xoá — khoá công khai không phải bí mật (không tự ký, không tự mở được gì), và **khoá
  riêng thì không bao giờ rời điện thoại**, kể cả lúc đó. Thu hồi thật là **gỡ điện thoại
  khỏi Tailscale** (có hiệu lực trên mọi máy dev cùng lúc); `/remote unpair <số>` chỉ dọn
  từng máy, không phải công tắc ngắt. Khoá không sao lưu được: xoá dữ liệu trang hoặc cài
  lại PWA là mất khoá, phải ghép lại từng máy.
- **TLS bắt buộc khi ra Internet**: Cloudflare Tunnel (khuyến nghị, không mở port) hoặc
  Caddy (`--profile tls`). Web Push chỉ chạy trên HTTPS.
- Hub không lưu nội dung phiên Claude Code, và **không lưu cả nội dung thông báo**: tiêu
  đề/nội dung đi qua nó để đẩy sang Web Push rồi bị quên ngay. Thứ duy nhất còn lại là một
  mốc thời gian cho mỗi phiên — đủ để điện thoại vẽ chấm "chưa đọc", không đủ để ai đọc ra
  Claude đã hỏi gì. Trên đĩa chỉ có danh sách user và push subscription. Nó cũng không giữ
  khoá nào mở được terminal của ai — xem mục ghép cặp ở trên.
- **Daemon chỉ bắt tay WebSocket với trang do chính nó phục vụ** (`Origin`). Token mở phiên
  do trang PWA ký, mà trang PWA thì do hub phục vụ — nên một hub bị chiếm có thể ký một
  token thật rồi đẩy điện thoại sang trang của kẻ tấn công, và trang đó mở WebSocket từ
  chính điện thoại đang ở trong tailnet. Trình duyệt không cho một trang tự đặt `Origin`
  của mình, nên phép kiểm này đóng đúng đường đó.

## Cấu trúc thư mục

```
deploy.sh             Dựng hub trên server bằng 1 lệnh (Docker + Cloudflare Tunnel)
setup-notify.sh       Cài hook + /notify trên máy dev
remove-notify.sh      Gỡ những gì setup-notify.sh tạo
docker-compose.yml    Hub (+ profile: cloudflare, tls)
docker/               Dockerfile.hub
server/               Hub: nhận /notify, bắn Web Push, phục vụ PWA (public/)
hook/                 Hook Notification chạy trên máy dev + CLI /notify
deploy/               systemd mẫu (ccrc-hub.service), Caddyfile mẫu, commands/notify.md
```

## Troubleshooting

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Không nhận được thông báo trên iPhone | Chưa thêm vào màn hình chính, hoặc mở từ tab Safari thường thay vì icon đã thêm |
| `/notify` báo không gọi được hub | Sai `CCRC_HUB_URL`/token, hoặc hub chưa chạy — chạy lại `./setup-notify.sh` để sửa cấu hình |
| Không bật được Web Push trên trình duyệt | Chưa chạy HTTPS, hoặc trình duyệt chặn thông báo |
| Đổi máy/mất `~/.ccrc/config` | Chạy lại `./setup-notify.sh`, nhập lại URL + token |
