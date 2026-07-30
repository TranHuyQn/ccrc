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

> 📖 **Người dùng mới bắt đầu từ đây:** [`docs/huong-dan.md`](docs/huong-dan.md) — cài đặt
> từng bước, cách dùng hằng ngày, và bảng tra khi trục trặc. README này thiên về kiến trúc
> và vận hành.

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
git clone <repo-này> cc-remote-control && cd cc-remote-control
cp .env.example .env             # sửa CCRC_TOKEN (openssl rand -hex 24)
docker compose --profile cloudflare up -d --build
./deploy.sh adduser ten-nguoi     # cấp token riêng cho từng thành viên
```

`deploy.sh` (dùng cùng Docker Compose ở trên) tự sinh `CCRC_TOKEN`, hỏi Cloudflare
Tunnel token, build và kiểm tra hub. Tiện ích kèm theo: `./deploy.sh status` · `down`.
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
| `CCRC_BIND` | `0.0.0.0` | Địa chỉ bind cổng trên host (Docker); đặt `127.0.0.1` khi đã có tunnel/reverse proxy đứng trước |
| `CCRC_DATA_DIR` | `server/data` (Docker: volume `ccrc-data`) | Nơi lưu `users.json`, khoá VAPID, push subscriptions |
| `CCRC_VAPID_SUBJECT` | `mailto:admin@localhost` | Contact cho Web Push |
| `CCRC_TUNNEL_TOKEN` | (trống) | Token Cloudflare Tunnel (profile `cloudflare`) |
| `CCRC_DOMAIN` | (trống) | Domain cho Caddy TLS (profile `tls`) |

**Máy dev** — `./setup-notify.sh` hỏi và ghi vào `~/.ccrc/config` (không cần đặt tay):
`CCRC_HUB_URL`, `CCRC_TOKEN` (token cá nhân), `CCRC_MACHINE_NAME`. `/remote pair` ghi thêm
`~/.ccrc/devices.json` — khoá **công khai** của mỗi điện thoại đã ghép với máy này; khoá
riêng không bao giờ rời điện thoại và không nằm trong file này.

### Tài khoản riêng cho từng thành viên

Dùng `./deploy.sh adduser <tên>` (Docker), hoặc tự sửa `CCRC_DATA_DIR/users.json` (hub
tự nạp lại trong ~5s):

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
- Hub không lưu nội dung phiên Claude Code — chỉ lưu tiêu đề/nội dung thông báo ngắn
  (tối đa 200 ký tự mỗi trường) trong RAM, cộng danh sách user và push subscription trên
  đĩa. Nó cũng không giữ khoá nào mở được terminal của ai — xem mục ghép cặp ở trên.

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
