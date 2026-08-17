#!/bin/sh
# Gỡ sạch phần máy dev. Repo giữ nguyên.
#
# POSIX sh, không phải bash, cho cùng lý do setup-notify.sh nêu ở đầu file nó:
# uninstall.sh gọi file này bằng `sh "$DEST/remove-notify.sh" -y`, nên shebang
# bị bỏ qua và /bin/sh mới là thứ chạy nó — dash trên Debian/Ubuntu.
set -eu
cd "$(dirname "$0")"
REPO_DIR=$(pwd)
CFG_DIR="$HOME/.ccrc"
CMD_FILE="$HOME/.claude/commands/notify.md"
# Tìm ccrc, nhưng chỉ xoá nếu đúng là file của chúng ta.
#
# PATH thôi là KHÔNG đủ: setup-notify.sh cài vào thư mục chứa `claude`, và nếu
# thư mục đó không ghi được thì rơi về ~/.local/bin — nơi chính nó cảnh báo là
# có thể chưa nằm trên PATH. Đo được: cài trong trường hợp đó rồi gỡ thì
# `command -v ccrc` không thấy gì và file ở lại, không ai nhắc tới.
# Thứ tự tìm phải khớp với thứ tự cài trong setup-notify.sh.
CCRC_BIN=$(command -v ccrc 2>/dev/null || true)
if [ -z "$CCRC_BIN" ]; then
  CLAUDE_PATH=$(command -v claude 2>/dev/null || true)
  for d in ${CLAUDE_PATH:+"$(dirname "$CLAUDE_PATH")"} "$HOME/.local/bin"; do
    if [ -f "$d/ccrc" ]; then CCRC_BIN="$d/ccrc"; break; fi
  done
fi
RCMD_FILE="$HOME/.claude/commands/remote.md"
say() { printf '%s\n' "$*"; }

say "== Sẽ gỡ =="
[ -d "$CFG_DIR" ] && say "  • $CFG_DIR (config, notify)"
[ -f "$CMD_FILE" ] && say "  • slash command /notify"
[ -f "$RCMD_FILE" ] && say "  • slash command /remote"
say "  • hook ccrc trong ~/.claude/settings.json (chỉ entry của ccrc)"
[ -n "$CCRC_BIN" ] && say "  • lệnh ccrc ($CCRC_BIN)"
say "  • mọi phiên /remote đang chạy trên máy này"

# Same reason as setup-notify.sh: under `curl … | bash` stdin is the script
# itself, so the confirmation is read from the terminal directly. With no
# terminal and no -y, refuse rather than assume yes — this deletes things.
# Phải khởi tạo trước: nếu lệnh đọc phía dưới thất bại thì `case "$a"` gặp một
# biến chưa đặt, và dưới `set -u` đó là lỗi thoát chứ không phải chuỗi rỗng.
a=''
if [ "${1:-}" != "-y" ] && [ "${CCRC_YES:-}" != "1" ]; then
  # Opened rather than tested: see setup-notify.sh's have_tty for why `-r` lies,
  # and why the open must sit inside a SUBSHELL — `:` is a special built-in, so
  # a failed redirect on it takes a POSIX shell down instead of answering "no".
  # Without the parentheses this branch never runs on dash: the script exits 2
  # and the sentence below, the one telling the user to pass -y, never prints.
  if ( : < /dev/tty ) 2>/dev/null; then
    printf 'Tiếp tục? [y/N] ' > /dev/tty
    IFS= read -r a < /dev/tty || true
  else
    say "✗ Không có terminal để hỏi. Chạy lại với -y nếu chắc chắn muốn gỡ."
    exit 1
  fi
  case "$a" in y|Y|yes|YES) ;; *) say "Đã huỷ."; exit 0 ;; esac
fi

# TRƯỚC khi xoá $CFG_DIR, vì file pid nằm trong đó và là thứ DUY NHẤT ghi lại
# daemon nào đang chạy. Xoá thư mục trước là để lại tiến trình vẫn phục vụ một
# shell trên tailnet, mà không còn cách nào tìm ra nó — người dùng thì tưởng đã
# gỡ sạch. Việc kiểm tra pid có đúng của mình không nằm trong CLI, không viết
# lại ở đây.
node "$REPO_DIR/term/bin/ccrc-term-cli.js" off-all \
  || say "⚠ Không dừng được phiên remote — kiểm tra bằng: ps ax | grep ccrc-term"

node "$REPO_DIR/hook/bin/install-hook.mjs" uninstall || say "⚠ Không gỡ được hook — kiểm tra ~/.claude/settings.json bằng tay"
[ -d "$CFG_DIR" ] && rm -rf "$CFG_DIR" && say "✓ Xoá $CFG_DIR"
if [ -f "$CMD_FILE" ] && grep -qs "ccrc-notify-cli.js" "$CMD_FILE"; then
  rm -f "$CMD_FILE" && say "✓ Xoá slash command /notify"
fi
if [ -f "$RCMD_FILE" ] && grep -qs "ccrc-term-cli.js" "$RCMD_FILE"; then
  rm -f "$RCMD_FILE" && say "✓ Xoá slash command /remote"
fi
# Nhận diện bằng nội dung, không bằng tên: một file tên `ccrc` mà chúng ta
# không tạo ra thì không phải của mình để xoá.
if [ -n "$CCRC_BIN" ] && grep -qs 'chạy Claude Code y hệt lệnh' "$CCRC_BIN"; then
  rm -f "$CCRC_BIN" && say "✓ Xoá lệnh ccrc"
elif [ -n "$CCRC_BIN" ]; then
  say "⚠ Có $CCRC_BIN nhưng không phải file do lệnh cài này tạo — để nguyên."
fi
# settings.json do install-hook tạo ra khi máy chưa có file này. Gỡ entry hook
# xong mà để lại một file rỗng thì máy KHÔNG trở về đúng trạng thái cũ. Chỉ xoá
# khi nội dung đúng là một object rỗng — có chữ nào khác thì đó là của người
# dùng, không phải của mình.
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && [ "$(tr -d ' \t\n\r' < "$SETTINGS")" = "{}" ]; then
  rm -f "$SETTINGS" && say "✓ Xoá ~/.claude/settings.json (rỗng, do lệnh cài tạo)"
fi

# rmdir chứ không rm -rf: thư mục còn thứ gì khác là của người dùng, và lệnh
# này sẽ tự thất bại chứ không xoá nhầm.
rmdir "$HOME/.claude/commands" 2>/dev/null && say "✓ Xoá thư mục ~/.claude/commands (đã rỗng)" || true
if [ -n "$CCRC_BIN" ]; then
  rmdir "$(dirname "$CCRC_BIN")" 2>/dev/null && say "✓ Xoá thư mục $(dirname "$CCRC_BIN") (đã rỗng)" || true
fi
# Thư mục cha, cũng chỉ khi rỗng. Trên máy dùng thật hai chỗ này luôn còn thứ
# khác nên rmdir sẽ tự thất bại; chỉ máy chưa từng có chúng trước khi cài mới
# thật sự được dọn.
rmdir "$HOME/.claude" 2>/dev/null && say "✓ Xoá thư mục ~/.claude (đã rỗng)" || true
rmdir "$HOME/.local" 2>/dev/null && say "✓ Xoá thư mục ~/.local (đã rỗng)" || true

say "✅ Đã gỡ xong. Repo vẫn ở: $REPO_DIR"
