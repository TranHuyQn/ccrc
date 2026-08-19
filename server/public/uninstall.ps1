# CC Remote Control — gỡ phần máy dev trên Windows bằng một lệnh.
#
#   irm https://<hub-cua-ban>/uninstall.ps1 | iex
#
# Không cần token: nó chỉ xoá thứ trên chính máy này, và bắt người ta đi tìm
# token trước khi được gỡ phần mềm khỏi máy mình là một cái giá vô lý.
#
# Chạy thẳng không hỏi (dùng trong script):
#   $env:CCRC_YES='1'; irm https://<hub-cua-ban>/uninstall.ps1 | iex

$ErrorActionPreference = 'Stop'
function Noi($m) { Write-Host $m }

$DEST = if ($env:CCRC_APP_DIR) { $env:CCRC_APP_DIR } else { Join-Path $env:USERPROFILE '.local\share\ccrc' }
$goBundle = Join-Path $DEST 'tools\remove-notify-win.mjs'

# Trình gỡ đi kèm gói biết chính xác nó đã cài gì — entry hook, slash command,
# ~/.ccrc, lệnh ccrc. Dùng lại chứ không viết lại: một bản sao thứ hai của
# "phải xoá những gì" là cách hai bên trôi khỏi nhau rồi bỏ sót thứ gì đó.
if (Test-Path $goBundle) {
  $doiSo = @($goBundle)
  if ($env:CCRC_YES -eq '1') { $doiSo += '-y' }
  & node.exe @doiSo
  if ($LASTEXITCODE -ne 0) {
    Noi '⚠ Phần gỡ cấu hình báo lỗi — xem ở trên. KHÔNG xoá thư mục mã nguồn.'
    Noi "  Thư mục vẫn ở: $DEST"
    # Dừng hẳn. Xoá mã nguồn sau khi phần gỡ thất bại là vứt mất chính công cụ
    # cần dùng để thử lại — và nếu nó thất bại ở bước `off-all` thì còn bỏ lại
    # một daemon đang phục vụ mà không còn gì để tắt nó.
    return
  }
} else {
  Noi "⚠ Không thấy $goBundle — có vẻ chưa cài bằng lệnh một dòng."
  Noi '  Nếu bạn cài từ bản git clone, chạy tools\remove-notify-win.mjs trong thư mục đó.'
}

# Làm cuối cùng: đây là thư mục chứa chính script vừa chạy ở trên, xoá sớm hơn
# là rút đất dưới chân nó.
#
# Đổi thư mục hiện tại ra ngoài trước khi xoá: trên Windows, một tiến trình
# đang đứng trong thư mục nào thì thư mục đó KHÔNG xoá được — khác POSIX, nơi
# rmdir vẫn thành công.
if (Test-Path $DEST) {
  Set-Location $env:USERPROFILE
  try {
    Remove-Item -Recurse -Force $DEST
    Noi "✓ Xoá $DEST"
  } catch {
    Noi "⚠ Không xoá được $DEST — có thể còn tiến trình đang dùng nó."
    Noi '  Đóng mọi cửa sổ ccrc rồi thử lại, hoặc xoá tay.'
    return
  }
}

Noi '✅ Đã gỡ xong.'
