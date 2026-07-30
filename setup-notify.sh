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

HUB_URL="${CCRC_HUB_URL:-}"
[ -n "$HUB_URL" ] || ask HUB_URL "URL hub${OLD_URL:+ [$OLD_URL]}: " "$OLD_URL"
while [ -z "$HUB_URL" ]; do ask HUB_URL "URL hub (vd https://ccrc.example.com): " ""; done
case "$HUB_URL" in http://*|https://*) ;; *) HUB_URL="https://$HUB_URL" ;; esac

TOKEN="${CCRC_TOKEN:-}"
[ -n "$TOKEN" ] || ask TOKEN "Token cá nhân${OLD_TOK:+ [giữ nguyên]}: " "$OLD_TOK"
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
