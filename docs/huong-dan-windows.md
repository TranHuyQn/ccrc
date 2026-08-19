# CC Remote Control trên Windows — hướng dẫn dùng

Phần chung — hệ thống này làm gì, cài trên điện thoại, quyền riêng tư, gỡ ra —
nằm ở [huong-dan.md](huong-dan.md). File này chỉ nói phần **khác trên Windows**,
và nói hết những chỗ khác.

Cài đặt: [cai-thu-cong-windows.md](cai-thu-cong-windows.md), hoặc một lệnh:

```powershell
irm https://<hub-cua-ban>/install.ps1 | iex
```

---

## 1. Khác biệt lớn nhất: `ccrc` **sở hữu** phiên, không gắn vào phiên có sẵn

Trên macOS/Linux, `/remote` gắn vào một pane `tmux` đang chạy. Bạn có thể mở
Claude Code trước, làm việc một lúc, rồi mới nghĩ ra là muốn bật remote — vẫn
bật được, và điện thoại thấy cả lịch sử từ trước đó.

Windows không có tmux, và cũng không có thứ gì tương đương. Nên hướng đi lật
ngược lại: **`ccrc` tự dựng terminal riêng (ConPTY) rồi chạy Claude Code bên
trong nó.**

Hệ quả bạn cần biết trước:

| | macOS/Linux | Windows |
|---|---|---|
| Bật remote cho phiên đang chạy sẵn | được | **không** — phải mở bằng `ccrc` từ đầu |
| Cuộn ngược | cả scrollback của tmux | chỉ từ lúc phiên bắt đầu |
| Cần cài thêm | `tmux` | không |
| Đóng cửa sổ | phiên vẫn sống | phiên vẫn sống |

**Thói quen cần đổi:** trên Windows, gõ `ccrc` thay cho `claude` **ngay từ
đầu**, kể cả khi chưa định bật remote. Mở bằng `claude` rồi mới muốn bật thì
phải thoát và mở lại.

## 2. Lệnh `ccrc`

Đúng ba cách dùng:

| Lệnh | Làm gì |
|---|---|
| `ccrc` | mở một phiên Claude Code mới |
| `ccrc list` | liệt kê các phiên đang chạy |
| `ccrc attach <id>` | mở lại cửa sổ vào một phiên đang chạy |

### `ccrc`

Mở phiên mới. Nó in ra một dòng như:

```
[ccrc] phiên k7m2 — đóng cửa sổ không làm phiên chết; `ccrc attach k7m2` để vào lại.
```

`k7m2` là **nhãn** của phiên, không phải bí mật — bạn sẽ đọc nó trên màn hình
rồi gõ lại. Bảng chữ cố ý bỏ `i l o 0 1` để khỏi nhìn nhầm.

Từ lúc này bạn đang ở trong Claude Code như bình thường.

> **Cờ của Claude Code không đi qua `ccrc`.** `ccrc -p ...`, `ccrc --help`,
> `ccrc --model ...` đều không chạy — gõ thẳng `claude ...` cho những việc đó
> (nhưng phiên ấy sẽ không dùng được `/remote`). Lý do: host chạy `claude`
> không tham số, và chuyển tiếp thẳng thì Node từ chối spawn một file `.cmd`
> nếu không mượn shell — tự dựng dòng lệnh `cmd.exe` cho tham số tuỳ ý là đúng
> hạng lỗi dự án tránh ở mọi chỗ khác.

### `ccrc list`

```
k7m2    13212   C:\Users\dev\du-an-a
p9wx    14880   C:\Users\dev\du-an-b
```

Ba cột cách nhau bằng **Tab**: id phiên, pid, thư mục làm việc. Sắp theo thứ tự
tạo, cũ trước.

Không có phiên nào thì **stdout rỗng** và dòng này đi ra stderr:

```
[ccrc] Không có phiên nào đang chạy.
```

Tách như vậy để bạn nối lệnh này vào lệnh khác mà không phải lọc bỏ câu tiếng
Việt — và `ccrc list` vẫn thoát 0 khi rỗng, vì "không có phiên nào" là một câu
trả lời hợp lệ, không phải lỗi.

### `ccrc attach <id>`

Mở lại cửa sổ vào phiên đang chạy. Dùng khi bạn đã đóng cửa sổ, hoặc máy vừa
khoá màn hình rồi mở lại.

## 3. Đóng cửa sổ **không** làm phiên chết

Đây là điểm dễ ngạc nhiên nhất, và nó là cố ý.

Phiên do một tiến trình **host** giữ, và host được khởi động tách hẳn khỏi cửa
sổ gọi nó. Đóng cửa sổ chỉ đóng phần hiển thị; Claude Code bên trong vẫn chạy
tiếp, vẫn làm việc, và điện thoại vẫn xem được.

Muốn vào lại: `ccrc list` để lấy id, rồi `ccrc attach <id>`.

**Muốn kết thúc phiên thật sự** thì thoát Claude Code từ bên trong như bình
thường (`/exit`, hoặc Ctrl-C tuỳ ngữ cảnh). Đóng cửa sổ không phải cách kết
thúc.

Hệ quả cần nhớ: một phiên bị bỏ quên sẽ sống mãi. `ccrc list` là chỗ nhìn ra
điều đó.

### Host chạy ngầm, không có cửa sổ riêng

Bản đầu có một cửa sổ `node.exe` hiện thêm mỗi lần gõ `ccrc`. Giờ không còn:
host được tạo với cờ `DETACHED_PROCESS` nên không nhận console nào.

Trong Task Manager bạn vẫn thấy `node.exe` và một `conhost.exe` cho mỗi phiên —
đó là bình thường. `conhost` ấy chạy chế độ `--headless`, nó là pseudoconsole
của terminal chứ không phải một cửa sổ bị ẩn.

## 4. Bật remote cho điện thoại

Trong một phiên `ccrc`:

```
/remote on ten-phien
```

`ten-phien` là tên hiện trên điện thoại. Bỏ trống cũng được, khi đó nó dùng một
id ngẫu nhiên — nhưng đặt tên thì dễ nhìn hơn nhiều khi có vài phiên.

Nó in ra URL dạng `http://100.x.y.z:<cổng>/` — mở trên điện thoại **cùng mạng
Tailscale**.

Tắt:

```
/remote off
```

> `/remote off` trên Windows **báo lỗi** nếu bạn truyền cờ không hỗ trợ, thay
> vì im lặng làm việc khác:
>
> ```
> ✗ `off` không nhận tham số nào — nhận được: --pane xxx
>   Nó luôn tắt đúng phiên bạn đang ngồi trong, không tắt hộ phiên khác.
> ```
>
> Đây là chủ ý: cùng lỗi ấy trên macOS từng tắt nhầm một phiên khác với phiên
> người dùng đang ngồi, nên bên này không nhân bản hình dạng đó.

Gõ `/remote off` khi không ở trong phiên `ccrc` nào thì nó nói thẳng và thoát
khác 0, chứ không đoán bừa:

```
✗ Không ở trong một phiên `ccrc` — không biết phiên nào để tắt.
```

Xem mọi phiên đang mở, kể cả của máy khác:

```
/remote
```

Trên Windows nó in ra thế này:

```
Remote (phiên này): không xác định — không chạy trong tmux.
Hub: https://<hub-cua-ban> — OK (915ms)
Phiên: chưa mở phiên nào — gõ `/remote on` trong tmux để mở.
```

Hai dòng nhắc tới **tmux** là câu chữ còn sót lại của macOS — bỏ qua chúng.
Phần có nghĩa là dòng `Hub:` và dòng `Phiên:`, và cả hai chạy đúng. Dòng đầu
("không xác định") chỉ nghĩa là lệnh này chưa biết cách nhận ra phiên `ccrc`
của Windows, **không** nghĩa là remote đang tắt — muốn biết phiên này có đang
bật hay không thì nhìn dòng `Phiên:`.

## 5. Tên máy hiện trên điện thoại

Đặt lúc cài. Đổi bất cứ lúc nào mà không cần cài lại:

```powershell
node "$env:USERPROFILE\.local\share\ccrc\tools\setup-notify-win.mjs"
```

Nó hỏi `Tên máy hiện trong thông báo [tên-hiện-tại]:` — Enter để giữ nguyên.

Hoặc đặt thẳng, không hỏi:

```powershell
$env:CCRC_MACHINE_NAME='May Window'; node "$env:USERPROFILE\.local\share\ccrc\tools\setup-notify-win.mjs"
```

Mặc định là `%COMPUTERNAME%`, thường có dạng `DESKTOP-A1B2C3D` — vô dụng khi
bạn có từ hai máy trở lên, nên đáng đổi.

## 6. Khi có trục trặc

### `npm.ps1 cannot be loaded because running scripts is disabled`

Bạn đang gõ `npm`. Trong PowerShell, `npm` phân giải sang `npm.ps1`, mà
ExecutionPolicy mặc định (`Restricted`) chặn file script.

Gõ **`npm.cmd`**. Trong `cmd.exe` thì `npm` bình thường.

Đây cũng là lý do lệnh cài dùng `irm | iex` chứ không phải một file `.ps1`:
`Invoke-Expression` trên một chuỗi không dính chính sách ấy, nên bạn **không
phải hạ ExecutionPolicy của máy mình** để cài.

### `[term] Không tìm thấy Tailscale trên máy này`

Máy chưa cài Tailscale, hoặc `tailscale.exe` không nằm trên PATH của tiến trình
daemon — daemon được Claude Code spawn ra nên PATH của nó có thể khác PATH bạn
thấy trong PowerShell.

Kiểm tra:

```powershell
where.exe tailscale
tailscale status
```

Không thấy thì chỉ thẳng đường dẫn cho nó:

```powershell
$env:CCRC_TAILSCALE_BIN='C:\Program Files\Tailscale\tailscale.exe'
```

### `Tailscale đang tắt — mở app Tailscale và bật lên`

Đúng như câu chữ: Tailscale cài rồi nhưng chưa chạy hoặc chưa đăng nhập. Mở app
lên, đăng nhập, rồi `/remote on` lại.

### `ccrc` không nhận sau khi cài

PATH chỉ nạp lúc mở cửa sổ. **Mở một cửa sổ PowerShell mới.**

Vẫn không được thì xem `ccrc.cmd` nằm đâu:

```powershell
where.exe ccrc
where.exe claude
```

Bản cài đặt `ccrc.cmd` cạnh `claude.exe`. Nếu thư mục đó không trên PATH, lệnh
cài đã in ra đúng dòng `setx` cần chạy.

### Điện thoại ngồi mãi ở "đang nối lại…"

Kiểm theo thứ tự:

1. Điện thoại có đang trong cùng mạng Tailscale không
2. Máy tính có đang ngủ không — **máy ngủ là mất kết nối**
3. Phiên còn sống không: `ccrc list`

### Đóng cửa sổ rồi, giờ tìm phiên ở đâu

```powershell
ccrc list
ccrc attach <id>
```

## 7. Những gì Windows chưa có

Nói thẳng để bạn khỏi mất công tìm:

- **Không gắn được vào phiên Claude Code đang chạy sẵn.** Phải mở bằng `ccrc`
  từ đầu.
- **Cuộn ngược chỉ tới lúc phiên bắt đầu.** Gắn điện thoại vào một phiên đã
  chạy vài tiếng thì không thấy phần trước lúc bạn gắn vào.
- **Cờ của Claude Code không đi qua `ccrc`.**
- **Chưa có `uninstall.ps1`.** Gỡ theo các bước tay trong
  [cai-thu-cong-windows.md](cai-thu-cong-windows.md#gỡ).
- **Thông báo đẩy trên Windows chưa được thử từ đầu đến cuối.** Hook cài được
  và bộ test của nó xanh trên Windows, nhưng chưa ai xác nhận một thông báo
  thật đi từ máy Windows tới điện thoại.

## 8. Thói quen dùng cho quen tay

- Gõ `ccrc` thay `claude`, **mọi lúc** — kể cả khi chưa định bật remote. Đổi ý
  giữa chừng thì không quay lại được.
- Đặt tên phiên khi bật: `/remote on sua-bug-thanh-toan`. Trên điện thoại, ba
  phiên không tên trông giống hệt nhau.
- Trước khi rời máy: đặt máy **không ngủ**. Đây là nguyên nhân số một của
  "điện thoại không nối được".
- Thỉnh thoảng `ccrc list` để xem có phiên nào bị bỏ quên đang chạy không.
