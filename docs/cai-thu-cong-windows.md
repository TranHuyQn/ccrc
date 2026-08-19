# Cài thủ công trên Windows

Dành cho ai không muốn chạy `irm ... | iex`, hoặc muốn biết chính xác từng bước
đụng vào đâu.

Cách tự động vẫn tồn tại song song và làm đúng những việc dưới đây:

```powershell
irm https://<hub-cua-ban>/install.ps1 | iex
```

> **Vì sao cách tự động dùng `irm | iex` chứ không phải một file `.ps1`**
>
> Đo trên Windows 11 (PowerShell 5.1.26100): `Get-ExecutionPolicy` trả về
> **`Restricted`** — chính sách mặc định. Ở mức đó, **chạy một file `.ps1` bị
> chặn thẳng**, nhưng `Invoke-Expression` trên một chuỗi thì không. Nên đường
> một lệnh chạy được mà **không bắt bạn hạ chính sách bảo mật của máy mình**.
>
> Cũng vì thế bước cấu hình dưới đây là một file `.mjs` chạy bằng `node.exe`,
> không phải `.ps1` — nếu là `.ps1` thì bản cài thủ công sẽ có một file không
> chạy nổi.

## Bản cài đụng vào đúng những chỗ này

| Đường dẫn | Là gì |
|---|---|
| `%USERPROFILE%\.local\share\ccrc` | mã nguồn |
| `%USERPROFILE%\.ccrc\config` | hub, token, tên máy — siết ACL chỉ chủ máy đọc |
| `%USERPROFILE%\.ccrc\hosts` | hồ sơ phiên ConPTY, chứa bí mật của named pipe |
| `%USERPROFILE%\.claude\commands\` | slash command `/notify` và `/remote` |
| `%USERPROFILE%\.claude\settings.json` | **thêm một** mục hook, không ghi đè file |
| `<thư mục chứa claude.exe>\ccrc.cmd` | lệnh `ccrc` |

Không đụng gì khác. Không cài service, không sửa registry, không đổi PATH hệ thống.

---

## Bước 1 — kiểm tra máy có đủ thứ cần

```powershell
node.exe --version
curl.exe --version
tar.exe --version
npm.cmd --version
```

Cả bốn phải chạy được.

- `curl.exe` và `tar.exe` **có sẵn** trong `C:\Windows\System32` từ Windows 10
  1803 trở đi — không phải cài gì thêm.
- Node.js thì phải tự cài nếu chưa có: <https://nodejs.org>.

> **Bẫy `npm` — đây là lỗi hay gặp nhất**
>
> Trong PowerShell, gõ `npm` trần sẽ phân giải sang **`npm.ps1`**, và
> ExecutionPolicy `Restricted` chặn nó:
>
> ```
> npm.ps1 cannot be loaded because running scripts is disabled on this system.
> ```
>
> **Luôn gõ `npm.cmd`**, đừng gõ `npm`. Trong `cmd.exe` thì `npm` bình thường.

## Bước 2 — lấy token

Token gắn với **từng hub**. Token của hub này không dùng được cho hub kia.

Cách dễ nhất: mở `https://<hub-cua-ban>/link` trên một thiết bị đã đăng
nhập, rồi lấy token trong phần cài đặt. Hoặc xin người quản trị hub.

```powershell
$env:CCRC_HUB_URL = 'https://<hub-cua-ban>'
$env:CCRC_TOKEN   = '<token-cua-ban>'
```

Kiểm tra token dùng được:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $env:CCRC_TOKEN" "$env:CCRC_HUB_URL/api/me"
```

Phải ra `200`. Ra `401` là token sai hoặc sai hub.

## Bước 3 — tải gói cài

```powershell
$goi = "$env:TEMP\ccrc-bundle.tar.gz"
curl.exe -fsSL --max-time 300 -H "Authorization: Bearer $env:CCRC_TOKEN" "$env:CCRC_HUB_URL/api/install/bundle.tar.gz" -o $goi
```

`-f` (fail) quan trọng: thiếu nó thì khi hub trả 401, `curl` **lưu trang lỗi
thành file** và thoát 0 — bước sau sẽ báo "file nén hỏng" thay vì "token sai".

Kiểm tra đúng là file nén:

```powershell
$b = [System.IO.File]::ReadAllBytes($goi)[0..1]
if ($b[0] -eq 0x1f -and $b[1] -eq 0x8b) { "OK" } else { "HONG - hub tra ve thu khac" }
```

File gzip luôn bắt đầu bằng `1f 8b`.

## Bước 4 — bung gói

```powershell
$dest = "$env:USERPROFILE\.local\share\ccrc"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
tar.exe -xzf $goi -C $dest
```

Xoá sạch rồi bung lại chứ không bung đè: nâng cấp mà để sót file của bản cũ thì
nó vẫn nằm đó chờ bị nạp nhầm.

Bung xong phải thấy đúng bảy mục — thiếu `tools` là bước 6 sẽ chết:

```powershell
Get-ChildItem $dest | Select-Object -ExpandProperty Name
# deploy, hook, shared, term, tools, remove-notify.sh, setup-notify.sh
```

## Bước 5 — cài phụ thuộc cho terminal

```powershell
Push-Location "$env:USERPROFILE\.local\share\ccrc\term"
npm.cmd install --omit=dev --no-audit --no-fund
Pop-Location
```

Bảy gói, trong đó hai gói đáng kể: `ws` và `node-pty`.

`node-pty` là mã native, nhưng **không cần Visual Studio Build Tools**. Đo trên
máy thật (Windows 11, Node 22.23.1, node-pty 1.1.0): máy **không hề cài** Visual
Studio, mà `npm.cmd install` vẫn xong — **14 giây** lần đầu, **2 giây** khi npm
đã có cache. Lý do: gói mang sẵn bản dựng trước trong `prebuilds/` cho cả
`win32-x64` lẫn `win32-arm64` (`pty.node`, `conpty.node`, kèm `conpty.dll` và
`OpenConsole.exe`), nên không có bước biên dịch nào.

Kiểm tra nó nạp được thật, không chỉ tải về được:

```powershell
Push-Location "$env:USERPROFILE\.local\share\ccrc\term"
node.exe -e "const p=require('node-pty'); const t=p.spawn('cmd.exe',[],{cols:80,rows:24}); t.onData(d=>{console.log('OK, ConPTY chay duoc'); t.kill(); process.exit(0)});"
Pop-Location
```

Bước này hỏng thì thông báo vẫn chạy, chỉ mất `/remote`.

## Bước 6 — cấu hình

```powershell
node.exe "$env:USERPROFILE\.local\share\ccrc\tools\setup-notify-win.mjs"
```

Nó tự làm nốt: ghi `~/.ccrc/config` (siết ACL), tạo `~/.ccrc/hosts`, đặt thông
báo mặc định **TẮT**, cài hai slash command, sinh `ccrc.cmd`, và thêm mục hook
vào `settings.json`.

Muốn đổi tên máy hiện trong thông báo thì đặt trước khi chạy:

```powershell
$env:CCRC_MACHINE_NAME = 'May ban lam viec'
```

Mặc định lấy `%COMPUTERNAME%` — trên Windows **không có** `hostname -s` như
macOS/Linux.

### `ccrc.cmd` được đặt ở đâu

Cạnh chính `claude.exe`, vì thư mục đó chắc chắn đã nằm trên PATH — bạn vẫn
đang gọi được `claude`. Xem nó ở đâu:

```powershell
where.exe claude
```

Muốn đặt chỗ khác thì đặt `$env:CCRC_BIN_DIR` trước khi chạy bước 6. Nếu thư
mục đó chưa có trên PATH, script sẽ in ra đúng lệnh `setx` cần chạy — nó
**không tự sửa PATH** của bạn.

---

## Kiểm tra

```powershell
ccrc list
```

Chưa có phiên nào thì nó nói vậy — thế là đúng. Nếu `ccrc` chưa nhận, mở **cửa
sổ PowerShell mới** (PATH chỉ nạp lúc mở).

`ccrc` có đúng ba cách dùng:

| Lệnh | Làm gì |
|---|---|
| `ccrc` | mở một phiên Claude Code mới, sống sót qua lúc đóng cửa sổ |
| `ccrc list` | liệt kê các phiên đang chạy |
| `ccrc attach <id>` | mở lại cửa sổ vào một phiên đang chạy |

> **Cờ của Claude Code không đi qua `ccrc` trên Windows.** `ccrc -p ...` hay
> `ccrc --help` không chạy — gõ thẳng `claude ...` cho những việc đó. Lý do:
> host chạy `claude` không tham số, và chuyển tiếp thẳng thì Node từ chối spawn
> một file `.cmd` nếu không mượn shell, mà tự dựng dòng lệnh `cmd.exe` cho tham
> số tuỳ ý là đúng hạng lỗi dự án tránh ở mọi chỗ khác.

Rồi thử thật: gõ `ccrc` thay cho `claude`. Nó tự dựng một terminal riêng
(ConPTY), nên `/remote` dùng được ngay.

```
/remote on ten-phien
```

Mở địa chỉ nó in ra trên điện thoại — cùng mạng Tailscale.

## Gỡ

```powershell
node.exe "$env:USERPROFILE\.local\share\ccrc\hook\bin\install-hook.mjs" uninstall
Remove-Item -Recurse -Force "$env:USERPROFILE\.local\share\ccrc"
Remove-Item -Recurse -Force "$env:USERPROFILE\.ccrc"
Remove-Item "$env:USERPROFILE\.claude\commands\notify.md","$env:USERPROFILE\.claude\commands\remote.md" -EA SilentlyContinue
Remove-Item (Join-Path (Split-Path (where.exe claude)) 'ccrc.cmd') -EA SilentlyContinue
```

Gỡ hook **trước** khi xoá thư mục code: lệnh gỡ nằm trong chính thư mục đó.

---

## Khác gì so với macOS/Linux

| | macOS/Linux | Windows |
|---|---|---|
| Gắn vào phiên nào | pane `tmux` đang chạy sẵn | `ccrc` **tự sở hữu** một ConPTY |
| Lệnh mở phiên | `ccrc` (bọc `tmux`) | `ccrc.cmd` (bọc ConPTY) |
| Cần cài thêm | `tmux` | không |
| Lịch sử cuộn ngược | tmux giao cả scrollback cũ | chỉ từ lúc phiên bắt đầu |

Hệ quả thật của dòng cuối: gắn điện thoại vào một phiên đã chạy vài tiếng thì
trên Windows **chỉ cuộn ngược được tới lúc phiên bắt đầu**, không thấy phần
trước đó. Trên macOS/Linux thì tmux giữ cả scrollback nên thấy hết.
