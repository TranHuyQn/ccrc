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
    let arr = []; try { arr = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const name = process.argv[1], token = process.argv[2];
    if (arr.some(u => u.name === name)) { console.error("User đã tồn tại: " + name); process.exit(1); }
    arr.push({ name, token });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2));
    console.log("OK");
  ' "$name" "$token" >/dev/null
  echo "✅ Đã tạo user '$name'. Token (gửi riêng cho người đó, hub tự nạp trong ~5s):"
  echo "   $token"
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
  status)  cmd_status; exit 0 ;;
  down)    cmd_down; exit 0 ;;
  deploy)  ;;
  *) echo "Lệnh không hợp lệ: $1 (dùng: deploy | adduser <tên> | status | down)"; exit 1 ;;
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
echo ""
echo "Bước tiếp theo:"
echo "  1. Tạo token cho từng thành viên:   ./deploy.sh adduser ten-nguoi"
echo "  2. Mở https://<hostname-tunnel> trên trình duyệt, đăng nhập bằng token đó"
echo "  3. Trên mỗi máy dev, cài hook:       ./setup-notify.sh"
echo "  (chi tiết: README.md)"
