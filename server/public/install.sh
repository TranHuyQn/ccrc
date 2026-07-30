#!/bin/sh
# CC Remote Control — cài phần máy dev bằng một lệnh.
#
#   curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token> https://<hub-cua-ban>
#
# This file is served publicly and contains no secrets. The SOURCE it fetches
# sits behind the same token everything else uses — the bundle is served by the
# hub, not fetched from a code host, so a dev machine needs neither git nor an
# account anywhere. That is also why the token is an argument: it is needed
# twice, once to download and once to write the config.
#
# The hub URL has NO DEFAULT, on purpose. This project is open source and every
# operator runs their own hub; baking one deployment's hostname in here would
# point every reader's install straight at a stranger's server. A script that
# refuses to guess is better than one that guesses wrong and silently sends a
# token somewhere unintended.
#
# What this touches, and nothing else:
#   ~/.local/share/ccrc        the code
#   ~/.ccrc/config             hub URL, token, machine name (chmod 600)
#   ~/.claude/commands/        the /notify and /remote slash commands
#   ~/.claude/settings.json    one hook entry
set -eu

# Env var first so `CCRC_HUB_URL=… | sh -s -- <token>` keeps working; second
# positional argument is the form that survives a bare `curl | sh` with nothing
# else set up.
HUB="${CCRC_HUB_URL:-${2:-}}"
TOKEN="${1:-${CCRC_TOKEN:-}}"
# Deliberately NOT inside ~/.ccrc: the uninstaller deletes that directory, and
# a script cannot delete the tree it is running from and still finish.
DEST="${CCRC_APP_DIR:-$HOME/.local/share/ccrc}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "Cần curl."
command -v tar  >/dev/null 2>&1 || die "Cần tar."
command -v node >/dev/null 2>&1 || die "Cần Node.js. Cài rồi chạy lại."

# Checked BEFORE the token: with no hub there is nowhere to send one, and the
# error that names the missing piece first is the one that gets fixed in a
# single try. `$HUB` cannot appear in this message — it is the empty string.
[ -n "$HUB" ] || die "Thiếu URL hub.
  Dùng: curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token-cua-ban> https://<hub-cua-ban>
  Hoặc: CCRC_HUB_URL=https://<hub-cua-ban> sh install.sh <token-cua-ban>
  Chưa có hub? Xem README — mỗi người tự dựng hub riêng của mình."

[ -n "$TOKEN" ] || die "Thiếu token.
  Dùng: curl -fsSL $HUB/install.sh | sh -s -- <token-cua-ban> $HUB
  Token do người quản trị hub gửi riêng cho bạn."

say "== CC Remote Control — cài trên máy dev =="
say "  hub:  $HUB"
say "  code: $DEST"

TMP=$(mktemp -d)
# Runs on every exit path, so a failed download leaves nothing behind.
trap 'rm -rf "$TMP"' EXIT INT TERM

say "• Tải gói cài…"
# Fails loudly on 401 rather than saving the error page as a tarball: without
# --fail curl writes the body and exits 0, and the next line reports a corrupt
# archive instead of "your token is wrong".
curl -fsSL --max-time 300 \
  -H "Authorization: Bearer $TOKEN" \
  "$HUB/api/install/bundle.tar.gz" -o "$TMP/bundle.tar.gz" \
  || die "Không tải được gói cài. Kiểm tra token, và kiểm tra $HUB có truy cập được không."

# A gzip file starts with 1f 8b. Anything else means the hub answered with
# something that is not the bundle.
head -c 2 "$TMP/bundle.tar.gz" | od -An -tx1 | tr -d ' \n' | grep -q '^1f8b$' \
  || die "Gói tải về không phải file nén hợp lệ — hub trả về thứ khác."

say "• Bung vào ${DEST}…"
# Replaced wholesale, so an upgrade cannot leave a file from the previous
# version behind to be picked up by mistake.
rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf "$TMP/bundle.tar.gz" -C "$DEST" || die "Không bung được gói cài."

# `ws` is the only runtime dependency, and only the terminal daemon needs it.
# Notifications are pure Node, so a failure here costs `/remote` and nothing
# else — said plainly rather than aborting an install that mostly worked.
if command -v npm >/dev/null 2>&1; then
  say "• Cài phụ thuộc cho terminal…"
  ( cd "$DEST/term" && npm install --omit=dev --silent --no-audit --no-fund ) >/dev/null 2>&1 \
    || say "⚠ Không cài được phụ thuộc — thông báo vẫn chạy, nhưng /remote sẽ không bật được."
else
  say "⚠ Không có npm — thông báo vẫn chạy, nhưng /remote sẽ không bật được."
fi

say "• Cấu hình…"
# The bundled setup script does the rest, and does it the same way it does for
# someone working from a git checkout — one code path, not two. It reads the
# answers it needs from the environment and asks on /dev/tty for the rest,
# which is what lets it work through a pipe.
CCRC_HUB_URL="$HUB" CCRC_TOKEN="$TOKEN" sh "$DEST/setup-notify.sh"

say ""
say "Gỡ bất cứ lúc nào:"
say "  curl -fsSL $HUB/uninstall.sh | sh"
