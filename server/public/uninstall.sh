#!/bin/sh
# CC Remote Control — gỡ phần máy dev bằng một lệnh.
#
#   curl -fsSL https://<hub-cua-ban>/uninstall.sh | sh
#
# Needs no token: it only ever deletes things on this machine, and refusing to
# uninstall without credentials would be a poor trade — someone who wants this
# off their laptop should not have to find a token first.
set -eu

DEST="${CCRC_APP_DIR:-$HOME/.local/share/ccrc}"
say() { printf '%s\n' "$*"; }

# The bundled uninstaller knows what it installed — the hook entry, the slash
# commands, ~/.ccrc — so it does that part. Reused rather than reimplemented:
# a second copy of "what to delete" is how the two drift and something gets
# left behind.
if [ -x "$DEST/remove-notify.sh" ] || [ -f "$DEST/remove-notify.sh" ]; then
  # -y because stdin here is the script itself, coming down a pipe; the
  # bundled script would have no terminal to ask on and would refuse.
  sh "$DEST/remove-notify.sh" -y || say "⚠ Phần gỡ cấu hình báo lỗi — xem ở trên."
else
  say "⚠ Không thấy $DEST — có vẻ chưa cài bằng lệnh một dòng."
  say "  Nếu bạn cài từ bản git clone, chạy ./remove-notify.sh trong thư mục đó."
fi

# Done last: this is the directory the script above lives in, so removing it
# earlier would pull the ground out from under it.
if [ -d "$DEST" ]; then
  rm -rf "$DEST" && say "✓ Xoá $DEST"
fi

say "✅ Đã gỡ xong."
