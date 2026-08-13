#!/bin/sh
# CC Remote Control — cài phần máy dev bằng một lệnh.
#
# Có token (người quản trị hub gửi riêng cho bạn):
#   curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token> https://<hub-cua-ban>
#
# Không có token: bỏ trống, script tự xin bằng device-code — in một mã ngắn,
# chờ bạn duyệt trong app (hoặc <hub>/link trên trình duyệt), rồi tự đổi ra
# token. Không cần người quản trị phát tay.
#
#   curl -fsSL https://<hub-cua-ban>/install.sh | CCRC_HUB_URL=https://<hub-cua-ban> sh
#
# This file is served publicly and contains no secrets. The SOURCE it fetches
# sits behind the same token everything else uses — the bundle is served by the
# hub, not fetched from a code host, so a dev machine needs neither git nor an
# account anywhere. A token is needed twice, once to download the bundle and
# once to write the config, whether it arrives as an argument or is obtained
# via device-code first.
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

# Checked BEFORE anything reaches for the hub — device-code included: with no
# hub there is nowhere to ask, and the error that names the missing piece first
# is the one that gets fixed in a single try. `$HUB` cannot appear in this
# message — it is the empty string.
[ -n "$HUB" ] || die "Thiếu URL hub.
  Dùng: curl -fsSL https://<hub-cua-ban>/install.sh | sh -s -- <token-cua-ban> https://<hub-cua-ban>
  Hoặc: CCRC_HUB_URL=https://<hub-cua-ban> sh install.sh
  Chưa có hub? Xem README — mỗi người tự dựng hub riêng của mình."

TMP=$(mktemp -d)
# EXIT lo dọn dẹp trên MỌI đường ra — kể cả khi INT/TERM bên dưới tự exit.
#
# INT/TERM phải TỰ GỌI exit: mặc định, sau khi lệnh trong trap chạy xong,
# /bin/sh quay lại đúng chỗ vừa bị ngắt (giữa `sleep` trong vòng poll ttl 10
# phút) như chưa có gì xảy ra — không phải vì set -e/&&-list nào tha, mà vì
# bản thân shell coi trap đã "xử lý" tín hiệu xong nhiệm vụ. Không có `exit`
# ở đây, Ctrl-C bị NUỐT: đo được bằng pty thật, script sống sót qua nhiều lần
# Ctrl-C liên tiếp và chạy hết ttl. Tách EXIT khỏi INT/TERM và cho hai cái sau
# tự thoát bằng đúng mã quy ước (128+tín hiệu) là cách duy nhất chặn nó lại.
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT   # 128+2
trap 'cleanup; exit 143' TERM  # 128+15

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
#
# /bin/sh POSIX, không phải bash: không "local" (hàm chỉ được gọi một lần
# trong toàn script nên biến ở mức script không đè lên gì), không mảng, không
# "printf -v". Logic vay nguyên từ setup-notify.sh, chỉ cú pháp là viết lại
# cho POSIX.
DEVICE_TOKEN=""
device_code_login() {
  start=$(curl -fsS -X POST "$HUB/api/device/start" \
    -H 'content-type: application/json' -d '{}' 2>/dev/null) || return 1
  dcode=$(printf '%s' "$start" | json_field deviceCode)
  ucode=$(printf '%s' "$start" | json_field userCode)
  ttl=$(printf '%s' "$start" | json_field ttl)
  interval=$(printf '%s' "$start" | json_field interval)
  [ -n "$dcode" ] && [ -n "$ucode" ] || return 1
  # ttl/interval đi thẳng vào $(( )) và vào `sleep`, không phải vào một lệnh có
  # exit status để `&&`/if bắt lỗi. Dưới `set -u`, một giá trị không phải số ở
  # đây không phải lệnh thất bại — /bin/sh đọc nó như TÊN BIẾN trong $(( )) và
  # báo "unbound variable", một lỗi thoát thẳng cả script, xuyên qua cả
  # `device_code_login && TOKEN=...` đang gọi hàm này. Ép về số trước khi
  # dùng, y như setup-notify.sh.
  case "$ttl" in ''|*[!0-9]*) ttl=600 ;; esac
  case "$interval" in ''|*[!0-9]*) interval=5 ;; esac
  # ...và cả hai phải LỚN HƠN 0.
  # - interval=0 lọt qua bộ lọc chữ số ở trên, và `sleep 0` biến vòng lặp dưới
  #   thành một vòng quay không nghỉ suốt cả ttl, đập vào /api/device/poll hết
  #   sức máy — nhánh 428|429 không hề giãn nhịp, nó chỉ "chờ tiếp".
  # - ttl=0 cũng lọt qua bộ lọc chữ số, in "tối đa 0 giây" rồi vòng `while`
  #   thoát ngay ở lần kiểm đầu — không poll lấy một lần.
  # `[ -gt 0 ]` còn bắt luôn số hợp lệ về CHỮ SỐ nhưng vượt phạm vi số nguyên
  # (vd. hub lỗi trả một chuỗi số rất dài): chính `[` báo "Illegal number" và
  # thoát 2, y hệt lớp lỗi ở trên, xuyên qua `die` nếu không có guard này.
  [ "$ttl" -gt 0 ] 2>/dev/null || ttl=600
  [ "$interval" -gt 0 ] 2>/dev/null || interval=5

  # App trước, /link sau — cố ý theo thứ tự đó. Ai đã cài app vào màn hình
  # chính thì KHÔNG mở được /link: app standalone không có thanh địa chỉ, và
  # iOS không deep-link vào web app đã cài. Dòng này từng chỉ nói mỗi /link,
  # nên nó dẫn đúng nhóm người dùng đông nhất vào ngõ cụt — họ mở Safari, thấy
  # màn hình đăng nhập (app và trình duyệt là hai phiên tách biệt trên iOS) và
  # tưởng mình làm sai bước nào đó.
  say ""
  say "  Duyệt mã này trong app CC Notify trên điện thoại:"
  say "  thẻ \"Duyệt máy dev\" → Mở → nhập mã."
  say "  Chưa cài app thì mở ${HUB}/link trên trình duyệt đã đăng nhập."
  say ""
  say "      ${ucode}"
  say ""
  say "  Đang chờ duyệt (tối đa ${ttl} giây)…"

  # Trong $TMP: đã có trap dọn khi script thoát, không cần rm -f tay ở từng
  # nhánh như setup-notify.sh (nơi body là một mktemp riêng, không có $TMP để
  # gửi gắm).
  body="$TMP/device-poll.json"
  deadline=$(( $(date +%s) + ttl ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$interval"
    code=$(curl -s -o "$body" -w '%{http_code}' -X POST "$HUB/api/device/poll" \
      -H 'content-type: application/json' \
      -d "{\"deviceCode\":\"${dcode}\"}" 2>/dev/null) || code=000
    case "$code" in
      200)
        DEVICE_TOKEN=$(json_field token < "$body")
        dname=$(json_field displayName < "$body")
        [ -n "$DEVICE_TOKEN" ] || return 1
        # In TÊN người vừa duyệt, không chỉ "đã xong". Mã ngắn được đọc to
        # trong phòng hoặc dán vào chat, nên người duyệt nhầm là chuyện xảy
        # ra được — và nếu nhầm thì máy này vừa ghi token VĨNH VIỄN của người
        # khác. Một dòng tên là chỗ duy nhất bắt được việc đó ngay lúc nó
        # xảy ra.
        if [ -n "$dname" ]; then
          say "  ✓ Đã nhận token của ${dname}."
        else
          say "  ✓ Đã nhận token."
        fi
        return 0
        ;;
      410)
        say "  ✗ Mã đã hết hạn."
        return 1
        ;;
      428|429) ;;   # chưa duyệt, hoặc poll nhanh quá — chờ tiếp
      *) ;;         # lỗi mạng tạm thời — chờ tiếp, deadline sẽ dừng vòng lặp
    esac
  done
  say "  ✗ Hết thời gian chờ duyệt."
  return 1
}

if [ -z "$TOKEN" ]; then
  device_code_login && TOKEN="$DEVICE_TOKEN"
fi
[ -n "$TOKEN" ] || die "Không lấy được token.
  Cách khác: curl -fsSL $HUB/install.sh | sh -s -- <token-cua-ban> $HUB
  Token do người quản trị hub gửi riêng cho bạn."

say "== CC Remote Control — cài trên máy dev =="
say "  hub:  $HUB"
say "  code: $DEST"

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
# which is what lets it work through a pipe. Passing CCRC_TOKEN here (now
# always set, whether it came from the argument or from device-code above) is
# what makes it skip its own device-code prompt — this script already ran it.
CCRC_HUB_URL="$HUB" CCRC_TOKEN="$TOKEN" sh "$DEST/setup-notify.sh"

say ""
say "Gỡ bất cứ lúc nào:"
say "  curl -fsSL $HUB/uninstall.sh | sh"
