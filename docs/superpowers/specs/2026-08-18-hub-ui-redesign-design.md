# Làm lại giao diện hub (`server/public`)

Ngày: 2026-08-18 · Nhánh: `feat/hub-ui-redesign` · Phạm vi: chỉ `server/public` + test của nó

## 1. Vấn đề

Trang hub hôm nay xếp theo thứ tự lịch sử chứ không theo thứ tự người ta dùng.
Mở app ra, thứ đập vào mắt là thẻ "Thông báo đẩy" cao gần nửa màn hình, rồi thẻ
"Duyệt máy dev" — một việc làm đúng một lần khi cài máy mới. Danh sách terminal,
tức là lý do người ta mở app, bị đẩy xuống dưới cả hai và thường phải cuộn mới
thấy. Nút "Mở terminal" thì bé và nhạt, trong khi nó là nút được bấm nhiều nhất.

## 2. Mục tiêu

- Màn hình đầu chỉ còn hai thứ: **công tắc thông báo** và **danh sách terminal**.
- Nút "Mở terminal" trở thành thứ nổi nhất trên thẻ, bấm được bằng ngón cái mà
  không phải nhìn.
- Giao diện hiện đại và dịu mắt hơn, có chế độ sáng.
- **Không mất một chức năng nào** đang có.

Không nằm trong phạm vi: `term/public` (trang terminal), API của hub, service
worker, `sw.js`, và mọi thứ ngoài `server/public`.

## 3. Quyết định đã chốt

| Chuyện | Chốt |
|---|---|
| Bố cục | Phương án A — Terminal là màn hình chính, mọi thứ phụ vào trang Cài đặt |
| Bảng màu | "Đất nung" — cùng họ với màu hiện tại, nền ấm và sáng hơn một nấc, cam nhạt đi |
| Sáng/tối | Dropdown 3 lựa chọn trong Cài đặt: Sáng / Tối / Theo thiết bị |
| Ghi chú iPhone | Nằm ngay dưới khối tên + Đăng xuất, **chỉ hiện khi mở bằng trình duyệt** |
| Nút Back của điện thoại | Đóng trang Cài đặt, quay về danh sách |
| Cách làm | Viết lại `index.html` + `style.css`; `app.js` chỉ sửa chỗ dựng DOM và chỗ chuyển màn hình |

### Vì sao không viết lại `app.js`

`app.js` dày chú thích giải thích *tại sao*, và phần lớn trong đó là những cái
bẫy đã trả giá mới biết: `isTailnetTerminalUrl()` là chốt chặn thứ hai chống một
URL phiên bị đổi sang host lạ để moi token; TTL vé 60s phải nhỏ hơn clamp của
daemon, có test canh bằng regex trên chính file nguồn; nhánh bfcache/`pageshow`
sinh ra từ một nút kẹt chữ "Đang mở…"; `startMessages()` được gọi tường minh chỉ
để một ngày nào đó thêm `async` vào thẻ `<script>` không âm thầm làm chết deep-link
từ thông báo. Viết lại là mời tất cả chúng quay lại, đổi lấy code trông sạch hơn.

## 4. Màn hình chính (`#main`)

```
┌─────────────────────────────────┐
│ Terminal                    ⚙   │  ← header
├─────────────────────────────────┤
│ Thông báo đẩy          [====O]  │  ← 1 thẻ, 1 hàng, công tắc gạt
│ bật trên thiết bị này           │
├─────────────────────────────────┤
│ ● ccrc-ui                       │
│ macbook · thông báo lúc 21:47   │
│ [      Mở terminal      ]       │  ← nút đặc, cao 46px, hết bề ngang
├─────────────────────────────────┤
│ api                             │
│ vps-01                          │
│ [      Mở terminal      ]       │
├─────────────────────────────────┤
│ cron                            │
│ vps-01 · máy không phản hồi     │  ← không có nút
└─────────────────────────────────┘
```

### 4.1 Header

Tiêu đề **Terminal** + nút ⚙ mở Cài đặt. Tên người dùng và nút Đăng xuất rời khỏi
đây, chuyển vào Cài đặt.

`#who` vẫn tồn tại, chỉ đổi chỗ — nó nằm trong `#settings`. Ba chỗ trong `app.js`
gán `$('who').textContent` (`consumeLoginCode`, `showMain`, `refreshWho`) giữ
nguyên không sửa.

### 4.2 Thẻ thông báo

- `#enable-push` **vẫn là `<button>`**, giữ nguyên id và handler `onclick`, chỉ
  đổi cách vẽ thành công tắc gạt. Thêm `role="switch"` và `aria-checked`, cập nhật
  cùng chỗ đang đổi `textContent` trong `refreshPushState()`.
- Chữ trên nút hiện tại ("Bật/Tắt thông báo trên thiết bị này") không còn hiện ra
  vì công tắc không có chữ. Trạng thái đọc được qua `#push-state` — dòng phụ ngay
  dưới nhãn — và qua chính vị trí cần gạt.
- Trường hợp trình duyệt không hỗ trợ push: `refreshPushState()` đang ẩn
  `#enable-push` và đặt `#push-state` = "trình duyệt không hỗ trợ". Giữ nguyên,
  thẻ còn lại một dòng chữ, không có công tắc.
- Ghi chú "iPhone: phải thêm vào màn hình chính…" **rời khỏi thẻ này**, chuyển sang
  Cài đặt.

### 4.3 Thẻ terminal

Cấu trúc DOM mới của mỗi thẻ (`buildTerminalCard`):

```
div.card.terminal-card
├── div.terminal-title      (hàng tên: [span.unread-dot]? + span tên)
├── div.terminal-meta       (dòng phụ — LUÔN có)
└── button                  (chỉ khi alive)
```

- **Tên** = `session.label` nếu có, không thì `session.machine`. Khác hôm nay:
  hôm nay tên là chuỗi ghép `label · machine`.
- **Dòng phụ** = `session.machine`, nối thêm vế sau chỉ khi có chuyện thật:
  - `· máy không phản hồi` khi `alive === false`
  - `· chưa ghép với máy này` khi `alive` nhưng máy chưa nằm trong `pairedMachines()`
  - `· thông báo lúc HH:MM` khi `hasUnread(session)` — giờ lấy từ `lastNotifiedAt`
  - Khi `label` rỗng, tên đã là `machine` rồi; dòng phụ khi đó bỏ phần lặp lại và
    chỉ giữ vế trạng thái (rỗng thì thẻ không có dòng phụ).
- **Nút**: `alive` → "Mở terminal", nền đặc. Máy chưa ghép → chữ đổi thành
  "Ghép máy này", kiểu nhạt (`--accent-soft`), vẫn do `buildTerminalCardAsync()`
  thay như hôm nay. `alive === false` → **không dựng nút nào**, đúng như hiện tại.
- Chấm chưa đọc, `aria-label`, và `card.onclick` gỡ chấm tại chỗ: giữ nguyên hành vi.

Dòng phụ là phần tử **luôn có mặt**, kể cả rỗng. Đây là điểm làm đỏ test — xem §8.

### 4.4 Những thứ ở lại màn chính, không chuyển đi

- `#pair-panel` (bảng ghép cặp, số so khớp 6 chữ số): nó bật lên từ nút trên chính
  thẻ terminal, nên phải ở cạnh cái thẻ đó.
- `#terminal-empty`, `#terminal-err`.
- Kéo-xuống-để-nạp-lại (`#ptr`): giữ nguyên hoàn toàn.

## 5. Trang Cài đặt (`#settings`)

Màn hình thứ hai **trong cùng một file HTML** — ẩn/hiện `<div>`, không thêm route
mới ở server.

Id mới: `#settings` (cả màn hình), `#settings-open` (nút ⚙ ở header màn chính),
`#settings-close` (nút ‹), `#theme-select` (dropdown giao diện), `#pwa-note`
(khối ghi chú iPhone).

Thứ tự từ trên xuống:

1. **Tên + Đăng xuất** — `#who`, `#logout`
2. **Ghi chú iPhone** — chỉ hiện khi mở bằng trình duyệt (§5.1)
3. **Giao diện** — dropdown Sáng / Tối / Theo thiết bị (§6)
4. **Thiết bị nhận thông báo** — `#devices-wrap`, `#devices`, `#devices-err`
5. **Duyệt máy dev** — `#approve-code`, `#approve-btn`, `#approve-msg`, `#approve-err`

Hai nút gập bị bỏ hẳn: `#devices-toggle` và `#approve-toggle`. Vào tới trang này
là đã cố ý đi tìm chúng rồi, gập thêm một tầng nữa là bắt bấm thừa.

Bỏ `#devices-toggle` kéo theo: `refreshPushState()` đang gọi `refreshDevices()`
ở cuối — giữ nguyên, nhưng danh sách thiết bị giờ luôn hiện chứ không phụ thuộc
biến `devicesOpen` (biến này bị xoá).

Bỏ `#approve-toggle` kéo theo: mất chỗ gọi `$('approve-code').focus()`. Không thay
thế bằng autofocus — ô nhập nằm sẵn trên màn hình, và bật bàn phím lên ngay khi
người ta vừa vào Cài đặt để làm việc khác là quấy rầy.

### 5.1 Dò PWA đã cài

```js
const dangChayTrongPwa = () =>
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  || navigator.standalone === true;   // iOS Safari không hỗ trợ display-mode
```

Đúng thì thêm `hidden` cho khối ghi chú. Chạy một lần lúc dựng trang là đủ: một
tab trình duyệt không tự biến thành PWA giữa chừng.

### 5.2 Đóng/mở và nút Back

- Mở: `history.pushState({ ccrc: 'settings' }, '', location.pathname)` rồi hiện
  `#settings`, ẩn `#main`.
- Đóng (nút ‹ hoặc `popstate`): ẩn `#settings`, hiện `#main`. Nút ‹ gọi
  `history.back()` để một đường duy nhất dẫn tới việc đóng.
- **Không đổi URL** — `pushState` giữ nguyên `location.pathname`. Lý do: `/link`
  cũng dùng chung file này, và đổi path sẽ làm `showLink()` hiểu sai màn hình.
- Thứ tự với hai đường query sẵn có: `consumeLoginCode()` (`?login=`) và
  `readPendingOpenFromUrl()` (`?open=`) đều gọi `history.replaceState` lúc nạp
  trang, **trước** khi người dùng kịp mở Cài đặt. Không đụng nhau. Cấm dùng
  `replaceState` cho việc mở Cài đặt, vì thế thì Back sẽ rời khỏi trang.
- Khi có `pendingOpen` (bấm thông báo lúc đang mở Cài đặt): đóng Cài đặt trước rồi
  mới để `consumePendingOpen()` chạy, để người dùng không bị điều hướng đi từ một
  màn hình không liên quan.

## 6. Màu và chế độ sáng/tối

### 6.1 Biến

`:root` giữ **đúng tên biến cũ** để không có file nào khác phải đổi:
`--bg --card --border --text --dim --accent --err --mono`. Thêm mới:
`--surface-2` (nền chìm: công tắc tắt, nút tròn header), `--accent-soft` (nền nhạt
cho nút phụ và quầng chấm chưa đọc), `--on-accent` (chữ trên nền nhấn).

| Biến | Tối | Sáng |
|---|---|---|
| `--bg` | `#101318` | `#f6f4f2` |
| `--card` | `#191d24` | `#ffffff` |
| `--surface-2` | `#242932` | `#eee9e5` |
| `--border` | `#262b34` | `#e3dcd6` |
| `--text` | `#edeff2` | `#1b1917` |
| `--dim` | `#98a1b0` | `#6d6660` |
| `--accent` | `#e0805f` | `#c05f3c` |
| `--accent-soft` | `rgba(224,128,95,.16)` | `rgba(192,95,60,.12)` |
| `--on-accent` | `#1a0e08` | `#ffffff` |
| `--err` | `#f87171` | `#c0392b` |

### 6.2 Cách chọn thắng nhau

```css
:root { /* … bảng TỐI … */ }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { /* bảng SÁNG */ } }
:root[data-theme="light"] { /* bảng SÁNG */ }
:root[data-theme="dark"]  { /* bảng TỐI  */ }
```

Mặc định tối, giống hôm nay. Dropdown đặt `data-theme` trên `<html>`:
`light` / `dark` / gỡ hẳn thuộc tính (= theo thiết bị). Lưu vào
`localStorage['ccrc_theme']`, đọc và áp **ngay đầu `app.js`**, trước mọi thứ khác,
để không chớp nền sai màu một nhịp.

Đổi theme cũng phải đổi `<meta name="theme-color">` (`#101318` ↔ `#f6f4f2`), nếu
không thanh trạng thái của PWA trên iPhone sẽ lệch màu với trang.

Khi để "Theo thiết bị", phải nghe `matchMedia('(prefers-color-scheme: dark)')`
đổi để cập nhật `theme-color` — CSS tự đổi, còn thẻ meta thì không.

## 7. Kích thước và khoảng cách

- Thẻ: bo `14px`, đệm `14px`, cách nhau `10px`.
- Nút chính: cao `46px`, bo `11px`, chữ `15px` đậm `600`.
- Vùng bấm nhỏ nhất `44×44` cho ⚙, ‹, công tắc, và nút "Xoá" trong danh sách thiết bị.
- Tên phiên `15px/600`, dòng phụ `12px` màu `--dim`.
- Giữ nguyên toàn bộ phần chống zoom (`touch-action`, `overscroll-behavior`,
  `viewport` meta, `env(safe-area-inset-*)`) — không đụng vào.

## 8. Ảnh hưởng lên test và cách xử lý

Bộ test bám khá chặt vào DOM, nhưng chỗ bám nằm gọn ở vài hàm helper.

| File | Phải sửa gì |
|---|---|
| `test/dom-harness.mjs` | `REQUIRED_IDS`: bỏ `devices-toggle`, `approve-toggle`; thêm `settings`, `settings-open`, `settings-close`, `theme-select`, `pwa-note` |
| `test/app-markup.test.js` | Không sửa logic — nó tự canh id và `?v=`. Nhưng nó **sẽ đỏ** nếu quên bump `?v=` |
| `test/app-terminal.test.js` | 4 helper ở dòng 64–67: `titleOf`, `dotOf`, `openButtonOf`, `noteOf`. `noteOf` hiện tìm "phần tử không phải hàng tên và không phải button" — giờ dòng phụ luôn có nên nó sẽ bắt nhầm; phải đổi sang tìm theo class. Kèm các assertion so chuỗi `'label · machine'` |
| `test/app-devices.test.js` | Dòng 50, 130, 179, 187 bấm `devices-toggle` để mở danh sách — bỏ bước bấm, danh sách đã mở sẵn. Assertion ở dòng 60 và 189 kiểm chữ "Ẩn"/"Xem" của chính nút gập: **xoá**, vì thứ nó kiểm không còn tồn tại |
| `test/app-login.test.js` | Dòng 447–455 là một test dành riêng cho hành vi gập/mở của `approve-toggle`: **xoá cả test**. Dòng 104 kiểm `who.textContent === 'huy'` — giữ nguyên, `#who` chỉ đổi chỗ chứ không đổi nội dung |
| `test/app-pairing.test.js`, `test/app-pull-refresh.test.js` | Kiểm lại, dự kiến không đụng |

Nguyên tắc khi sửa test: test nào kiểm **hành vi bị bỏ đi** (gập/mở) thì xoá hẳn,
đừng nới lỏng nó thành một assertion vô nghĩa để giữ bảng xanh. Test nào kiểm
**hành vi còn giữ** (xoá thiết bị, duyệt mã) thì chỉ bỏ bước bấm nút gập ở đầu.

**Bắt buộc: bump `?v=14` → `?v=15`** cho cả `app.js` và `style.css` trong
`index.html`. Cloudflare đè `no-cache` của hub bằng TTL 4 giờ cho `.js`/`.css`;
`?v=` mới là thứ duy nhất tới được trình duyệt đã từng mở trang. Quên là deploy vô
hình. `index.html` thì `no-cache` thật đầu-cuối nên markup mới về ngay lần mở sau,
và PWA đã cài cũng thấy `?v=` mới ngay — không phải cài lại.

## 9. Nghiệm thu

1. `cd server && npm test` — xanh hết, không có test nào bị bỏ qua thêm so với trước.
2. Chạy hub local, mở bằng Chrome:
   - Ba lựa chọn giao diện đều đổi màu đúng, đổi cả màu thanh trạng thái.
   - Bật rồi tắt thông báo; `#push-state` và cần gạt khớp nhau.
   - Thẻ terminal: máy sống có nút, máy chết không có nút, máy chưa ghép ra nút
     "Ghép máy này".
   - Vào Cài đặt rồi bấm Back → về danh sách, không rời trang.
   - Xoá một thiết bị, xoá "các thiết bị khác".
   - Nhập mã duyệt máy dev.
   - Kéo xuống để nạp lại.
   - Trang `/link` vẫn dùng được.
3. Mở bằng iPhone ở chế độ PWA đã cài: khối ghi chú iPhone **không** hiện.
   Mở cùng trang bằng Safari thường: khối đó **có** hiện.
4. Bấm một thông báo đẩy để mở thẳng một phiên — vẫn đúng phiên.

## 10. Rủi ro đã biết

- **Công tắc thay nút chữ.** Nút hôm nay nói rõ nó sẽ làm gì ("Tắt thông báo trên
  thiết bị này"); công tắc thì không. Bù bằng `#push-state` ngay dưới nhãn và
  `role="switch"` + `aria-checked` cho trình đọc màn hình.
- **`popstate` trên iOS PWA.** Vuốt cạnh để back trong web app đã cài có lịch sử
  hoạt động không đồng đều giữa các bản iOS. Phải thử thật ở bước nghiệm thu; nếu
  hỏng, nút ‹ vẫn là đường đóng chắc chắn.
- **Test bắt nhầm dòng phụ.** `noteOf` trong `app-terminal.test.js` đang định nghĩa
  theo kiểu loại trừ. Sửa sang tìm theo class chứ đừng nới lỏng assertion, nếu
  không nó sẽ xanh mà không còn kiểm gì.
