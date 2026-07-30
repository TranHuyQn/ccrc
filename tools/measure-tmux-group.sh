#!/usr/bin/env bash
# Đo: phiên nhóm (tmux new-session -t) có giữ kích thước ĐỘC LẬP không.
# Nếu KHÔNG, màn hình máy tính sẽ co lại khi điện thoại nối vào — spec §5.5.
set -uo pipefail
T=$(command -v tmux) || { echo "KHÔNG có tmux"; exit 1; }
S="ccrc-measure-$$"

"$T" kill-session -t "$S" 2>/dev/null || true
"$T" new-session -d -s "$S" -x 200 -y 50
echo "phiên gốc: $("$T" display-message -p -t "$S" '#{window_width}x#{window_height}')"

# Client thứ hai, phiên nhóm, màn hình hẹp như điện thoại
"$T" new-session -d -t "$S" -s "${S}-phone" -x 40 -y 30
"$T" set-window-option -t "$S" aggressive-resize on

sleep 1
GOC=$("$T" display-message -p -t "$S" '#{window_width}x#{window_height}')
PHONE=$("$T" display-message -p -t "${S}-phone" '#{window_width}x#{window_height}')
echo "sau khi phone nối vào — gốc: $GOC | phone: $PHONE"

"$T" kill-session -t "${S}-phone" 2>/dev/null || true
"$T" kill-session -t "$S" 2>/dev/null || true

case "$GOC" in
  200x50) echo "KẾT LUẬN: ĐẠT — kích thước độc lập, thiết kế §5.5 dùng được" ;;
  *)      echo "KẾT LUẬN: HỎNG — gốc bị co còn $GOC. Phải thiết kế lại phần bố cục." ;;
esac
