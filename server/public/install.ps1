# CC Remote Control — cài phần máy dev trên Windows bằng một lệnh.
#
#   irm https://<hub-cua-ban>/install.ps1 | iex
#
# Có token thì đặt trước vào biến môi trường:
#   $env:CCRC_TOKEN='...'; irm https://<hub-cua-ban>/install.ps1 | iex
#
# VÌ SAO `irm | iex` CHỨ KHÔNG PHẢI MỘT FILE .ps1: đo trên máy Windows 11
# (PowerShell 5.1.26100), ExecutionPolicy mặc định là **Restricted** — chạy một
# file .ps1 bị chặn thẳng, nhưng `Invoke-Expression` một chuỗi thì không. Nên
# đường một lệnh này chạy được mà KHÔNG bắt người dùng hạ chính sách bảo mật
# của máy họ xuống. Ai muốn cài thủ công thì xem docs/cai-thu-cong-windows.md.
#
# Chỉ đụng vào đúng những chỗ này:
#   %USERPROFILE%\.local\share\ccrc   mã nguồn
#   %USERPROFILE%\.ccrc\config        hub, token, tên máy (ACL: chỉ chủ máy)
#   %USERPROFILE%\.claude\commands\   slash command /notify và /remote
#   %USERPROFILE%\.claude\settings.json  thêm MỘT mục hook
#   <thư mục chứa claude.exe>\ccrc.cmd   lệnh `ccrc`

$ErrorActionPreference = 'Stop'

function Noi($m)   { Write-Host $m }
function Chet($m)  { Write-Host "✗ $m" -ForegroundColor Red; throw $m }

# KHONG co hub mac dinh, cung ly do voi install.sh: du an nay khong van hanh mot
# hub dung chung nao ca, nen moi doi tu dung hub rieng. Mot dia chi mac dinh o
# day la tro nguoi dung toi ha tang cua nguoi khac.
$HUB = if ($env:CCRC_HUB_URL) { $env:CCRC_HUB_URL } else { '' }
$NHA = $env:USERPROFILE
$DEST = if ($env:CCRC_APP_DIR) { $env:CCRC_APP_DIR } else { Join-Path $NHA '.local\share\ccrc' }
$CFG_DIR = Join-Path $NHA '.ccrc'
$CFG_FILE = Join-Path $CFG_DIR 'config'

# --- đọc lại thứ máy này đã lưu từ lần cài trước ---------------------------
# Giống install.sh: người truyền token tay vẫn thắng, config chỉ lấp chỗ trống.
$CFG_HUB = ''
$CFG_TOKEN = ''
if (Test-Path $CFG_FILE) {
  foreach ($d in Get-Content $CFG_FILE) {
    if ($d -match '^CCRC_HUB_URL=(.*)$') { $CFG_HUB = $Matches[1] }
    if ($d -match '^CCRC_TOKEN=(.*)$')   { $CFG_TOKEN = $Matches[1] }
  }
}
if (-not $env:CCRC_HUB_URL -and $CFG_HUB) { $HUB = $CFG_HUB }

# Kiem HUB TRUOC token, giong install.sh cua ban public: khong co hub thi khong
# co gi de hoi token ca, va bao "thieu token" luc ay la chi sai cho.
if (-not $HUB) {
  Chet @"
Chua biet hub nao. Dat CCRC_HUB_URL roi chay lai:
  `$env:CCRC_HUB_URL='https://<hub-cua-ban>'; irm https://<hub-cua-ban>/install.ps1 | iex
Du an nay khong van hanh hub dung chung — moi doi tu dung hub rieng.
Xem docs/self-hosting.md.
"@
}
$TOKEN = if ($env:CCRC_TOKEN) { $env:CCRC_TOKEN } else { $CFG_TOKEN }

# --- những thứ bắt buộc phải có --------------------------------------------
#
# curl.exe và tar.exe: đã đo, cả hai có sẵn trong C:\Windows\system32 từ
# Windows 10 1803 trở đi — nên đường tải-và-bung không cần cài thêm gì.
#
# npm: PHẢI gọi `npm.cmd`, KHÔNG được gọi `npm` trần. Đo được trên máy thật:
# dưới PowerShell, `npm` phân giải sang `npm.ps1`, và ExecutionPolicy
# Restricted chặn nó — lỗi là "cannot be loaded because running scripts is
# disabled", tức là bước cài phụ thuộc chết câm giữa chừng.
foreach ($c in @('curl.exe','tar.exe','node.exe')) {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
    Chet "Cần $c. Cài rồi chạy lại."
  }
}
$NPM = (Get-Command npm.cmd -ErrorAction SilentlyContinue)

# --- token còn dùng được không ---------------------------------------------
function TokenConDung($tok) {
  if (-not $tok) { return $false }
  try {
    $r = Invoke-WebRequest -Uri "$HUB/api/me" -Headers @{ Authorization = "Bearer $tok" } `
         -TimeoutSec 20 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# --- device-code: xin token mà không cần người quản trị phát tay ------------
function DangNhapDeviceCode {
  try {
    $b = Invoke-RestMethod -Uri "$HUB/api/device/start" -Method Post -TimeoutSec 20 `
         -ContentType 'application/json' -Body '{}'
  } catch { return $null }
  if (-not $b.userCode) { return $null }

  # Nói rõ CHƯA CÀI GÌ: mã này xuất hiện TRƯỚC khi bất cứ file nào được ghi,
  # vì gói cài nằm sau xác thực — phải có token rồi mới tải được. Người dùng
  # dễ tưởng đây là bước "ghép điện thoại", nên phải nói thẳng nó là gì.
  Noi ''
  Noi '  Chưa cài gì lên máy cả — bước này chỉ để cho phép MÁY NÀY tải gói cài.'
  Noi "  Mở $HUB/link trên thiết bị đã đăng nhập, rồi nhập mã:"
  Noi ''
  Noi "      $($b.userCode)"
  Noi ''
  Noi '  (Đang chờ bạn duyệt…)'

  $nhip = if ($b.interval) { [int]$b.interval } else { 5 }
  $han = (Get-Date).AddSeconds($(if ($b.expiresIn) { [int]$b.expiresIn } else { 600 }))
  while ((Get-Date) -lt $han) {
    Start-Sleep -Seconds $nhip
    try {
      $p = Invoke-RestMethod -Uri "$HUB/api/device/poll" -Method Post -TimeoutSec 20 `
           -ContentType 'application/json' `
           -Body (@{ deviceCode = $b.deviceCode } | ConvertTo-Json -Compress)
    } catch {
      # 428 = chưa duyệt, 429 = poll nhanh quá, lỗi mạng tạm = chờ tiếp.
      # 410 = mã hết hạn, dừng hẳn.
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 410) {
        Noi '  ✗ Mã đã hết hạn.'; return $null
      }
      continue
    }
    if ($p.token) {
      # In TÊN người vừa duyệt, không chỉ "xong". Mã ngắn hay bị đọc to hoặc
      # dán vào chat, nên duyệt nhầm là chuyện xảy ra được — và nếu nhầm thì
      # máy này vừa ghi token VĨNH VIỄN của người khác.
      if ($p.displayName) { Noi "  ✓ Đã nhận token của $($p.displayName)." }
      else                { Noi '  ✓ Đã nhận token.' }
      return $p.token
    }
  }
  Noi '  ✗ Hết thời gian chờ duyệt.'
  return $null
}

if (-not (TokenConDung $TOKEN)) {
  if ($TOKEN) { Noi '• Token đã lưu không còn dùng được — xin lại.' }
  $TOKEN = DangNhapDeviceCode
}
if (-not $TOKEN) {
  Chet @"
Không lấy được token.
  Cách khác: `$env:CCRC_TOKEN='<token-cua-ban>'; irm $HUB/install.ps1 | iex
  Token do người quản trị hub gửi riêng cho bạn.
"@
}

Noi '== CC Remote Control — cài trên máy dev (Windows) =='
Noi "  hub:  $HUB"
Noi "  code: $DEST"

# --- tải gói ---------------------------------------------------------------
$TMP = Join-Path $env:TEMP ("ccrc-cai-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $TMP -Force | Out-Null
try {
  $goi = Join-Path $TMP 'bundle.tar.gz'

  Noi '• Tải gói cài…'
  # Dùng curl.exe chứ không Invoke-WebRequest: `--fail` cho lỗi TO khi 401
  # thay vì lưu trang lỗi thành tarball rồi báo "file nén hỏng" ở bước sau.
  & curl.exe -fsSL --max-time 300 -H "Authorization: Bearer $TOKEN" `
      "$HUB/api/install/bundle.tar.gz" -o $goi
  if ($LASTEXITCODE -ne 0) {
    Chet "Không tải được gói cài. Kiểm tra token, và kiểm tra $HUB có truy cập được không."
  }

  # File gzip bắt đầu bằng 1f 8b. Khác đi nghĩa là hub trả về thứ khác.
  $dau = [System.IO.File]::ReadAllBytes($goi)[0..1]
  if ($dau[0] -ne 0x1f -or $dau[1] -ne 0x8b) {
    Chet 'Gói tải về không phải file nén hợp lệ — hub trả về thứ khác.'
  }

  Noi "• Bung vào $DEST…"
  # Thay trọn gói, để bản nâng cấp không bỏ sót file của bản cũ nằm lại rồi bị
  # nạp nhầm. node_modules nằm trong DEST nên cũng đi theo — npm install ở
  # dưới dựng lại.
  if (Test-Path $DEST) { Remove-Item -Recurse -Force $DEST }
  New-Item -ItemType Directory -Path $DEST -Force | Out-Null
  & tar.exe -xzf $goi -C $DEST
  if ($LASTEXITCODE -ne 0) { Chet 'Không bung được gói cài.' }

  # --- phụ thuộc của terminal ----------------------------------------------
  #
  # `ws` và `node-pty` chỉ terminal cần. Hỏng ở đây thì thông báo vẫn chạy,
  # chỉ mất /remote — nói thẳng ra chứ không huỷ cả lần cài gần như đã xong.
  if ($NPM) {
    Noi '• Cài phụ thuộc cho terminal…'
    Push-Location (Join-Path $DEST 'term')
    try {
      & npm.cmd install --omit=dev --silent --no-audit --no-fund 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Noi '⚠ Không cài được phụ thuộc — thông báo vẫn chạy, nhưng /remote sẽ không bật được.'
      }
    } finally { Pop-Location }
  } else {
    Noi '⚠ Không có npm — thông báo vẫn chạy, nhưng /remote sẽ không bật được.'
  }

  # --- cấu hình ------------------------------------------------------------
  Noi '• Cấu hình…'
  $env:CCRC_HUB_URL = $HUB
  $env:CCRC_TOKEN = $TOKEN
  & node.exe (Join-Path $DEST 'tools\setup-notify-win.mjs')
  if ($LASTEXITCODE -ne 0) { Chet 'Bước cấu hình thất bại — xem lỗi ở trên.' }
}
finally {
  Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
}

Noi ''
Noi 'Gỡ bất cứ lúc nào:'
Noi "  irm $HUB/uninstall.ps1 | iex"
