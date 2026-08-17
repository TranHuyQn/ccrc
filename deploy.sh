#!/usr/bin/env bash
# =============================================================================
# CC Remote Control — triển khai home server bằng 1 lệnh (Cloudflare Tunnel)
#
# CAM KẾT PHẠM VI: script này CHỈ
#   - đọc/ghi trong thư mục chứa repo này (tạo file .env)
#   - dùng Docker qua `docker compose` với project name "cc-remote-control"
#     (image ccrc-hub, volume ccrc-data, container cc-remote-control-*)
# KHÔNG cài gói hệ thống, KHÔNG sửa file ngoài thư mục này, KHÔNG đụng
# container/volume/network Docker nào khác trên máy.
#
# Cách dùng:
#   ./deploy.sh                  # triển khai / cập nhật (hỏi token lần đầu)
#   ./deploy.sh adduser <tên>    # cấp token cho thành viên mới
#   ./deploy.sh deluser <tên>    # thu hồi token của một người
#   ./deploy.sh status           # trạng thái + log gần nhất
#   ./deploy.sh down             # dừng (giữ nguyên dữ liệu cấu hình)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=cc-remote-control
compose() { docker compose -p "$PROJECT" "$@"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ Thiếu lệnh '$1' — cài trước rồi chạy lại."; exit 1; }; }
gen_token() { (openssl rand -hex 24 2>/dev/null) || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }

need docker
docker compose version >/dev/null 2>&1 || { echo "✗ Cần Docker Compose v2 (lệnh: docker compose)"; exit 1; }

# ----------------------------------------------------------------------------
cmd_adduser() {
  local name="${1:-}"
  [ -n "$name" ] || { echo "Dùng: ./deploy.sh adduser <tên>"; exit 1; }
  # "admin" là tên hub tự gán cho CCRC_TOKEN, và mọi dữ liệu trên hub khoá
  # theo TÊN chứ không theo token: thông báo, thiết bị đẩy, và các phiên
  # terminal đang mở kèm bí mật ký vé của chúng. Một entry thứ hai mang tên
  # này là một chiếc chìa thứ hai vào đúng cái hộp đó.
  # Hub đã bỏ qua entry như vậy khi nạp (server/src/users.js) — chặn ở đây để
  # không ai phát ra một token mà đầu bên kia không bao giờ dùng được.
  if [ "$name" = "admin" ]; then
    echo "✗ 'admin' là tên dành riêng cho token hub (CCRC_TOKEN) — hub sẽ bỏ qua entry này."
    echo "  Đặt tên khác, ví dụ: ./deploy.sh adduser admin-$(whoami 2>/dev/null || echo ten)"
    exit 1
  fi
  local token; token=$(gen_token)
  compose exec -T hub node -e '
    const fs = require("fs");
    const f = "/data/users.json";
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      // ENOENT (chưa ai adduser bao giờ) là bình thường, ra mảng rỗng. Mọi
      // lỗi khác nghĩa là file CÓ tồn tại nhưng đọc/parse hỏng — coi đó là
      // rỗng thì lệnh dưới sẽ ghi đè lên một file hỏng như thể nó chưa từng
      // hỏng, xoá sạch mọi user còn lại. Phải dừng và nói rõ.
      if (e.code !== "ENOENT") {
        console.error("Không đọc được users.json — file có thể hỏng, chưa đổi gì: " + e.message);
        process.exit(1);
      }
    }
    const name = process.argv[1], token = process.argv[2];
    if (arr.some(u => u.name === name)) { console.error("User đã tồn tại: " + name); process.exit(1); }
    arr.push({ name, token });
    // Ghi qua temp + rename như saveSlackUser (server/src/index.js): một
    // users.json cụt vì mất điện giữa chừng là cả team mất quyền cùng lúc.
    // Tên tạm mang pid: hub cũng ghi đúng file này, và một tên tạm DÙNG CHUNG
    // nghĩa là hai tiến trình đạp lên nhau ngay trong file tạm rồi rename ra
    // một nội dung lai. (Cuộc đua đọc-sửa-ghi giữa hai tiến trình thì tên
    // riêng không xoá được — lệnh này chạy tay lúc có sự cố nhân sự, và cách
    // đúng vẫn là đừng chạy nó cùng lúc với một lượt đăng nhập.)
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, f);
    console.log("OK");
  ' "$name" "$token" >/dev/null
  echo "✅ Đã tạo user '$name'. Token (gửi riêng cho người đó, hub tự nạp trong ~5s):"
  echo "   $token"
}

cmd_deluser() {
  local needle="${1:-}"
  [ -n "$needle" ] || { echo "Dùng: ./deploy.sh deluser <tên hiển thị hoặc slack_user_id>"; exit 1; }
  # Luật khớp nằm trong server/src/users.js, không viết lại ở đây: nó đã có
  # test, và hai bản sao của cùng một luật là hai bản sao sẽ lệch nhau.
  compose exec -T hub node --input-type=module -e '
    import fs from "node:fs";
    import { removeUser } from "/app/server/src/users.js";
    const f = "/data/users.json";
    let arr = [];
    try {
      arr = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      // ENOENT là bình thường (chưa ai adduser bao giờ). Mọi lỗi khác nghĩa
      // là file hỏng — im lặng coi nó là rỗng thì "không tìm thấy tên đó" sẽ
      // trông giống một cú tra cứu trượt bình thường, đúng lúc người vận
      // hành cần biết sự thật là file đang cụt, không phải người kia đã bị
      // xoá từ trước.
      if (e.code !== "ENOENT") {
        console.error(`Không đọc được users.json — file có thể hỏng, chưa đổi gì: ${e.message}`);
        process.exit(1);
      }
    }
    if (!Array.isArray(arr)) arr = [];
    const label = (u) => `${u.name}  (${u.displayName ?? u.name})`;
    const { list, removed, matches } = removeUser(arr, process.argv[1]);
    if (removed) {
      // Ghi qua temp + rename như saveSlackUser (server/src/index.js): một
      // users.json cụt vì mất điện giữa chừng là cả team mất quyền cùng lúc.
      // Tên tạm mang pid: hub cũng ghi đúng file này, và một tên tạm DÙNG CHUNG
      // nghĩa là hai tiến trình đạp lên nhau ngay trong file tạm rồi rename ra
      // một nội dung lai. (Cuộc đua đọc-sửa-ghi giữa hai tiến trình thì tên
      // riêng không xoá được — lệnh này chạy tay lúc có sự cố nhân sự, và cách
      // đúng vẫn là đừng chạy nó cùng lúc với một lượt đăng nhập.)
      const tmp = f + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, f);
      console.log("OK " + label(removed));
      process.exit(0);
    }
    if (matches.length > 1) {
      console.error("Khớp nhiều người — gõ lại bằng cột đầu:");
      for (const m of matches) console.error("  " + label(m));
      process.exit(1);
    }
    console.error(`Không tìm thấy "${process.argv[1]}". Đang có:`);
    for (const u of arr) console.error("  " + label(u));
    process.exit(1);
  ' "$needle"
  echo "✅ Đã thu hồi. Hub tự nạp lại trong ~5s."
}

cmd_status() {
  compose ps
  echo "--- log hub (20 dòng cuối) ---"
  compose logs --tail 20 hub
  if compose ps cloudflared >/dev/null 2>&1; then
    echo "--- log cloudflared (10 dòng cuối) ---"
    compose logs --tail 10 cloudflared || true
  fi
}

cmd_down() { compose --profile cloudflare down; echo "Đã dừng. Dữ liệu cấu hình vẫn còn trong volume ccrc-data."; }

case "${1:-deploy}" in
  adduser) shift; cmd_adduser "$@"; exit 0 ;;
  deluser) shift; cmd_deluser "$@"; exit 0 ;;
  status)  cmd_status; exit 0 ;;
  down)    cmd_down; exit 0 ;;
  deploy)  ;;
  *) echo "Lệnh không hợp lệ: $1 (dùng: deploy | adduser <tên> | deluser <tên> | status | down)"; exit 1 ;;
esac

# ----------------------------------------------------------------------------
# 1) Chuẩn bị .env (chỉ tạo/bổ sung, không ghi đè giá trị đã có)
touch .env
grep -q '^CCRC_TOKEN=..*' .env 2>/dev/null || {
  echo "CCRC_TOKEN=$(gen_token)" >> .env
  echo "• Đã sinh CCRC_TOKEN (token admin) trong .env"
}

if ! grep -q '^CCRC_TUNNEL_TOKEN=..*' .env 2>/dev/null; then
  echo ""
  echo "Cần token Cloudflare Tunnel. Lấy tại: Cloudflare Zero Trust -> Networks"
  echo "-> Tunnels -> Create a tunnel (Cloudflared) -> copy chuỗi token (eyJ...)."
  echo "Trong tab Public hostname của tunnel, trỏ:  Service = HTTP : hub:8720"
  read -r -p "Dán CCRC_TUNNEL_TOKEN (Enter để bỏ qua — chạy không tunnel): " tuntok
  if [ -n "$tuntok" ]; then
    echo "CCRC_TUNNEL_TOKEN=$tuntok" >> .env
  fi
fi

# Liên hệ gắn vào JWT của Web Push. Apple kiểm claim `sub` chặt hơn hẳn Google
# và Mozilla: nó trả 403 BadJwtToken — âm thầm, cho MỌI push — khi subject
# không phải một liên hệ định vị được, kể cả giá trị mặc định của compose
# (mailto:admin@localhost). Hỏng theo cách không ai nhìn thấy từ phía người
# dùng: /notify vẫn trả { ok: true, pushed: true }, hook vẫn xanh, thiết bị
# vẫn nằm nguyên trong danh sách đã đăng ký (403 không phải 410 nên hub không
# gỡ nó), chỉ có iPhone là im. Android (FCM) và Firefox nhận bình thường, nên
# ai kiểm thử bằng Android sẽ ship thẳng lỗi này lên production — đúng chuyện
# đã xảy ra ngày 2026-08-17.
#
# Vì sao phải HỎI thay vì tự suy như CCRC_TRUST_PROXY/CCRC_BIND ở dưới: script
# không có cách nào biết domain công khai của hub. Tunnel token không mang
# domain theo, và profile tls thì domain nằm ở CCRC_DOMAIN mà lúc này có thể
# chưa ai đặt. Chỉ hỏi khi .env chưa có — chạy lại deploy.sh phải im lặng đi
# qua, không hỏi lại thứ đã trả lời.
if ! grep -q '^CCRC_VAPID_SUBJECT=..*' .env 2>/dev/null; then
  echo ""
  echo "Thông báo đẩy cần một liên hệ định vị được gắn vào Web Push. Apple TỪ CHỐI"
  echo "giá trị mặc định (mailto:admin@localhost): iPhone sẽ không nhận được thông"
  echo "báo nào, trong khi /notify vẫn báo thành công. Android không bị ảnh hưởng."
  # `|| hub_url=""`: không có stdin (chạy qua ssh không cấp tty, hay trong CI)
  # thì `read` trả mã lỗi và `set -e` giết script GIỮA CHỪNG — sau khi .env đã
  # sửa dở, trước khi hub kịp lên. Bỏ qua câu hỏi là một kết cục hợp lệ; chết
  # vì hỏi thì không.
  read -r -p "Domain công khai của hub (vd https://ccrc.congty.vn — Enter để bỏ qua): " hub_url || hub_url=""
  if [ -n "$hub_url" ]; then
    echo "CCRC_VAPID_SUBJECT=$hub_url" >> .env
    echo "• Đặt CCRC_VAPID_SUBJECT=$hub_url (liên hệ Web Push — Apple kiểm giá trị này)"
  fi
fi

# Có tunnel token = chắc chắn có cloudflared đứng trước hub (bên dưới script tự
# chọn --profile cloudflare). Đây là lúc duy nhất script BIẾT CHẮC hình dạng
# triển khai, nên nó ghi luôn cặp biến đi liền nhau, thay vì để người vận hành
# đọc README rồi tự đoán:
#
#   CCRC_TRUST_PROXY=1  — không có nó thì mọi request đều mang địa chỉ của
#     container cloudflared, cả team dùng CHUNG một rổ rate-limit của
#     /api/device/start, và người thứ 6 chạy ./setup-notify.sh trong 10 phút ăn
#     429 rồi âm thầm rơi về dán token tay.
#   CCRC_BIND=127.0.0.1 — bắt buộc đi kèm. Compose publish 8720 ở
#     ${CCRC_BIND:-0.0.0.0} kể cả trong profile cloudflare, nên nếu không đóng
#     thì vẫn còn một đường đi THẲNG vào hub; trên đường đó, CCRC_TRUST_PROXY=1
#     bảo hub tin header của chính kẻ gọi và rate-limit thành trang trí. Bật
#     một mình cái trên là mở lại đúng cái lỗ nó sinh ra để bịt. (Trên VPS cũng
#     đừng tin mỗi ufw: iptables của Docker chạy trước ufw.)
#
# Cùng quy tắc với CCRC_TOKEN ở trên: chỉ bổ sung khi CHƯA có, không bao giờ
# ghi đè giá trị người vận hành đã tự đặt.
if grep -q '^CCRC_TUNNEL_TOKEN=..*' .env 2>/dev/null; then
  grep -q '^CCRC_TRUST_PROXY=' .env 2>/dev/null || {
    echo "CCRC_TRUST_PROXY=1" >> .env
    echo "• Đặt CCRC_TRUST_PROXY=1 (có cloudflared đứng trước — rate-limit đếm đúng IP client)"
  }
  grep -q '^CCRC_BIND=' .env 2>/dev/null || {
    echo "CCRC_BIND=127.0.0.1" >> .env
    echo "• Đặt CCRC_BIND=127.0.0.1 (cổng 8720 chỉ mở cho localhost — bắt buộc đi cùng CCRC_TRUST_PROXY)"
  }
fi

# 2) Build + khởi động (ephemeral mặc định — không lưu nội dung phiên ra đĩa)
PROFILES=()
if grep -q '^CCRC_TUNNEL_TOKEN=..*' .env 2>/dev/null; then PROFILES=(--profile cloudflare); fi
echo "• Build và khởi động..."
compose "${PROFILES[@]}" up -d --build

# 3) Kiểm tra
echo "• Chờ hub sẵn sàng..."
for i in $(seq 1 30); do
  if compose exec -T hub node -e "fetch('http://127.0.0.1:8720/healthz').then(r=>r.json()).then(j=>{if(!j.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1; break
  fi
  sleep 1
done
[ "${ok:-}" = 1 ] || { echo "✗ Hub không phản hồi — xem: ./deploy.sh status"; exit 1; }

echo ""
echo "✅ HUB ĐANG CHẠY (chế độ ephemeral — không lưu nội dung phiên ra đĩa)"
compose logs --tail 3 hub | grep -o '\[hub\].*' || true

# Nói lại một lần nữa ở đây, sau khi hub đã lên, vì câu hỏi phía trên chỉ bắn
# cho .env còn trống: MỌI hub dựng trước bản này đã có .env đầy đủ và sẽ đi
# thẳng qua nó mà không thấy gì. Hub cũng tự cảnh báo chuyện này trong log của
# chính nó, nhưng log là thứ chỉ người có shell trên server đọc được — người
# vận hành hub cho người khác dùng thì có, người dùng thì không, và người dùng
# mới là người phát hiện ra "điện thoại không kêu".
#
# Bắt cả giá trị ĐÃ đặt nhưng vô dụng (localhost, IP loopback, domain mẫu
# copy từ README) — cùng bộ luật với server/src/vapid-subject.js, chỉ khác là
# chỗ này in ra cho đúng người đang cầm bàn phím.
if ! grep -q '^CCRC_VAPID_SUBJECT=..*' .env 2>/dev/null \
  || grep -qE '^CCRC_VAPID_SUBJECT=.*(localhost|127\.0\.0\.1|example\.(com|org|net)|yourdomain|yourhub|changeme)' .env 2>/dev/null; then
  echo ""
  echo "⚠ CCRC_VAPID_SUBJECT chưa có giá trị dùng được trong .env."
  echo "  iPhone sẽ KHÔNG nhận được thông báo nào — Apple trả 403 BadJwtToken cho"
  echo "  mọi push, trong khi /notify vẫn báo thành công và thiết bị vẫn hiện là"
  echo "  đã đăng ký. Android và Firefox không bị ảnh hưởng."
  echo "  Sửa: thêm  CCRC_VAPID_SUBJECT=https://<domain-hub-của-bạn>  vào .env rồi"
  echo "  chạy lại ./deploy.sh — biến mới chỉ vào container khi nó được TẠO LẠI,"
  echo "  'docker restart' không đủ."
fi
echo ""
echo "Bước tiếp theo:"
echo "  1. Tạo token cho từng thành viên:   ./deploy.sh adduser ten-nguoi"
echo "  2. Mở https://<hostname-tunnel> trên trình duyệt, đăng nhập bằng token đó"
echo "  3. Trên mỗi máy dev, cài hook:       ./setup-notify.sh"
echo "  (chi tiết: README.md)"
