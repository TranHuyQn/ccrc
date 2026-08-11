#!/usr/bin/env bash
# Cài phần máy dev: cấu hình, slash command /notify, hook Notification.
# KHÔNG cài service, KHÔNG đụng tmux — hệ thống này chỉ gửi thông báo.
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR=$(pwd)
CFG_DIR="$HOME/.ccrc"
say() { printf '%s\n' "$*"; }

command -v node >/dev/null 2>&1 || { say "✗ Cần Node.js"; exit 1; }

say "== CC Notify — cài trên máy dev =="
OLD_URL=$(grep -s '^CCRC_HUB_URL=' "$CFG_DIR/config" | cut -d= -f2- || true)
OLD_TOK=$(grep -s '^CCRC_TOKEN=' "$CFG_DIR/config" | cut -d= -f2- || true)

# Prompts read from /dev/tty, not stdin.
#
# Under the one-command installer this script is reached from a pipe
# (`curl … | bash`), where stdin IS the script being executed — a `read` there
# swallows the rest of the script instead of waiting for the user. Reading the
# terminal directly is what makes the same file work both ways.
#
# Any answer already supplied through the environment skips its prompt
# outright, which is how the installer passes the token it was given.
# `[ -r /dev/tty ]` is NOT enough: on macOS the node exists and tests readable
# even for a process with no controlling terminal, and the failure only shows
# up on use, as "Device not configured" — which is how the first run of the
# installer died. Actually opening it is the only honest check.
have_tty() { { : < /dev/tty; } 2>/dev/null; }

ask() { # ask VAR "câu hỏi" "mặc định"
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if have_tty; then
    printf '%s' "$__q" > /dev/tty
    IFS= read -r __ans < /dev/tty || true
  fi
  __ans="${__ans:-$__def}"
  printf -v "$__var" '%s' "$__ans"
}

# Đọc một trường của JSON bằng node (script này đã đòi node ở trên).
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try {
        const v = JSON.parse(s)[process.argv[1]];
        process.stdout.write(v == null ? "" : String(v));
      } catch { /* JSON hỏng = trường rỗng, người gọi tự xử */ }
    });
  ' "$1"
}

# Lấy token bằng device-code: in một mã ngắn, chờ người duyệt trên thiết bị đã
# đăng nhập, rồi đổi lấy token. Đặt DEVICE_TOKEN khi thành công.
#
# Mã ngắn CHỈ để người gõ; thứ đổi ra token là deviceCode 32 byte mà script
# này giữ. Không in deviceCode ra màn hình.
DEVICE_TOKEN=""
device_code_login() {
  local start dcode ucode ttl interval body code deadline dname
  start=$(curl -fsS -X POST "$HUB_URL/api/device/start" \
            -H 'content-type: application/json' -d '{}' 2>/dev/null) || return 1
  dcode=$(printf '%s' "$start" | json_field deviceCode)
  ucode=$(printf '%s' "$start" | json_field userCode)
  ttl=$(printf '%s' "$start" | json_field ttl)
  interval=$(printf '%s' "$start" | json_field interval)
  [ -n "$dcode" ] && [ -n "$ucode" ] || return 1
  # ttl/interval đi thẳng vào $(( )) và vào `sleep`, không phải vào một lệnh có
  # exit status để `&&`/if bắt lỗi. Một giá trị không phải số ở đây không phải
  # lệnh thất bại — dưới `set -u` bash đọc nó như TÊN BIẾN trong $(( )) và báo
  # "unbound variable", một lỗi thoát thẳng cả script, xuyên qua cả
  # `device_code_login && TOKEN=...` đang gọi hàm này. Ép về số trước khi dùng,
  # y như DEF_NAME ở dưới, để một hub trả sai kiểu không đánh sập cả installer.
  case "$ttl" in ''|*[!0-9]*) ttl=600 ;; esac
  case "$interval" in ''|*[!0-9]*) interval=5 ;; esac
  # ...và phải LỚN HƠN 0. "0" lọt qua bộ lọc chữ số ở trên, và `sleep 0` biến
  # vòng lặp dưới thành một vòng quay không nghỉ suốt cả ttl (600 giây), đập
  # vào /api/device/poll hết sức máy — nhánh 428|429 không hề giãn nhịp, nó
  # chỉ "chờ tiếp". Dùng `test` chứ không thêm `0` vào case: `00`, `000` cũng
  # là sleep 0 mà không khớp mẫu nào ở trên.
  [ "$interval" -gt 0 ] 2>/dev/null || interval=5

  say ""
  say "  Mở ${HUB_URL}/link trên thiết bị đã đăng nhập, rồi nhập mã:"
  say ""
  say "      ${ucode}"
  say ""
  say "  Đang chờ duyệt (tối đa ${ttl} giây)…"

  body=$(mktemp)
  deadline=$(( $(date +%s) + ttl ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$interval"
    code=$(curl -s -o "$body" -w '%{http_code}' -X POST "$HUB_URL/api/device/poll" \
             -H 'content-type: application/json' \
             -d "{\"deviceCode\":\"${dcode}\"}" 2>/dev/null) || code=000
    case "$code" in
      200)
        DEVICE_TOKEN=$(json_field token < "$body")
        dname=$(json_field displayName < "$body")
        rm -f "$body"
        [ -n "$DEVICE_TOKEN" ] || return 1
        # In TÊN người vừa duyệt, không chỉ "đã xong". Mã ngắn được đọc to
        # trong phòng hoặc dán vào chat, nên người duyệt nhầm là chuyện xảy
        # ra được — và nếu nhầm thì máy này vừa ghi token VĨNH VIỄN của người
        # khác, rồi mọi thông báo từ đây chảy sang tài khoản họ mà không ai
        # thấy gì. Một dòng tên là chỗ duy nhất bắt được việc đó ngay lúc nó
        # xảy ra. Hub cũ (hoặc user chưa có displayName) thì rơi về câu cũ,
        # không in "undefined".
        if [ -n "$dname" ]; then
          say "  ✓ Đã nhận token của ${dname}."
        else
          say "  ✓ Đã nhận token."
        fi
        return 0
        ;;
      410)
        rm -f "$body"
        say "  ✗ Mã đã hết hạn."
        return 1
        ;;
      428|429) ;;   # chưa duyệt, hoặc poll nhanh quá — chờ tiếp
      *) ;;         # lỗi mạng tạm thời — chờ tiếp, deadline sẽ dừng vòng lặp
    esac
  done
  rm -f "$body"
  say "  ✗ Hết thời gian chờ duyệt."
  return 1
}

HUB_URL="${CCRC_HUB_URL:-}"
[ -n "$HUB_URL" ] || ask HUB_URL "URL hub${OLD_URL:+ [$OLD_URL]}: " "$OLD_URL"
while [ -z "$HUB_URL" ]; do ask HUB_URL "URL hub (vd https://ccrc.example.com): " ""; done
case "$HUB_URL" in http://*|https://*) ;; *) HUB_URL="https://$HUB_URL" ;; esac

# Thứ tự: biến môi trường (installer truyền vào) → token đã cài lần trước →
# device-code → dán tay. Đường lui cuối cùng phải còn, vì một hub cũ chưa có
# /api/device/start vẫn phải cài được.
TOKEN="${CCRC_TOKEN:-$OLD_TOK}"
if [ -z "$TOKEN" ]; then
  device_code_login && TOKEN="$DEVICE_TOKEN"
fi
while [ -z "$TOKEN" ]; do ask TOKEN "Token cá nhân: " ""; done

# On macOS the DHCP-assigned hostname is often the IP address, so `hostname -s`
# yields a bare octet like "192" — useless in a notification. Prefer the name
# the user actually sees, and refuse a default that is only digits.
DEF_NAME=$(scutil --get ComputerName 2>/dev/null || true)
[ -z "$DEF_NAME" ] && DEF_NAME=$(hostname -s 2>/dev/null || hostname || true)
case "$DEF_NAME" in ''|*[!0-9]*) ;; *) DEF_NAME='' ;; esac

MACHINE="${CCRC_MACHINE_NAME:-}"
[ -n "$MACHINE" ] || ask MACHINE "Tên máy hiện trong thông báo${DEF_NAME:+ [$DEF_NAME]}: " "$DEF_NAME"
# No terminal to ask on AND nothing to fall back to — better a usable default
# than an install that stalls forever on a prompt nobody can see.
[ -n "$MACHINE" ] || MACHINE=$(hostname 2>/dev/null || echo "máy dev")
while [ -z "$MACHINE" ]; do ask MACHINE "Tên máy (không đoán được, cần bạn đặt): " ""; done

mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/config" <<EOF
CCRC_HUB_URL=$HUB_URL
CCRC_TOKEN=$TOKEN
CCRC_MACHINE_NAME=$MACHINE
EOF
chmod 600 "$CFG_DIR/config"
say "• Đã ghi $CFG_DIR/config (chmod 600)"

# Mặc định TẮT: người dùng chủ động bật khi sắp rời máy.
[ -f "$CFG_DIR/notify" ] || { printf 'off\n' > "$CFG_DIR/notify"; say "• Thông báo mặc định TẮT — bật bằng /notify on"; }

mkdir -p "$HOME/.claude/commands"
sed "s|{{CCRC_REPO}}|$REPO_DIR|g" deploy/commands/notify.md > "$HOME/.claude/commands/notify.md"
say "• Đã cài slash command /notify"
sed "s|{{CCRC_REPO}}|$REPO_DIR|g" deploy/commands/remote.md > "$HOME/.claude/commands/remote.md"
say "• Đã cài slash command /remote"

# --- lệnh `ccrc` -----------------------------------------------------------
#
# `/remote` cần một pane tmux, và nhớ chạy `tmux` trước mỗi lần là thứ người ta
# sẽ quên. `ccrc` dùng y hệt `claude`, chỉ khác là nó tự mở tmux — nên không ai
# phải biết tmux là gì.
#
# Đặt cạnh chính `claude` khi có thể: thư mục đó chắc chắn đã nằm trên PATH,
# vì người dùng vẫn đang gọi được `claude`.
CLAUDE_PATH=$(command -v claude 2>/dev/null || true)
BIN_DIR=""
if [ -n "$CLAUDE_PATH" ]; then
  CAND=$(dirname "$CLAUDE_PATH")
  [ -w "$CAND" ] && BIN_DIR="$CAND"
fi
[ -n "$BIN_DIR" ] || BIN_DIR="$HOME/.local/bin"

mkdir -p "$BIN_DIR"
if sed "s|{{CCRC_REPO}}|$REPO_DIR|g" deploy/ccrc > "$BIN_DIR/ccrc" && chmod 755 "$BIN_DIR/ccrc"; then
  say "• Đã cài lệnh ccrc vào $BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      # Không tự sửa file cấu hình shell của người dùng — đó là file của họ.
      # Nói đúng dòng cần thêm là đủ.
      say "⚠ $BIN_DIR chưa nằm trên PATH. Thêm dòng này vào ~/.zshrc (hoặc ~/.bashrc):"
      say "    export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
else
  say "⚠ Không cài được lệnh ccrc vào $BIN_DIR — vẫn dùng được bằng cách chạy tmux rồi claude."
fi

if node "$REPO_DIR/hook/bin/install-hook.mjs" install "$REPO_DIR/hook/bin/ccrc-notify.js"; then
  say "• Đã cài hook Notification"
else
  say "⚠ KHÔNG cài được hook — sẽ không có thông báo nào. Xem lỗi ở trên."
  exit 1
fi

say ""
say "== XONG =="
say "Từ giờ gõ 'ccrc' thay cho 'claude' — nó tự mở tmux, nên /remote dùng được ngay."
say "Bước tiếp: mở $HUB_URL trên điện thoại, đăng nhập bằng token, bật thông báo."
say "iPhone: phải thêm vào màn hình chính rồi mở từ đó thì mới nhận được push."
say "Kiểm tra bất cứ lúc nào bằng: /notify"
