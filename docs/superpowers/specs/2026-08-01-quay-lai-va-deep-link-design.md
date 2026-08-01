# Quay lại từ terminal, và bấm thông báo mở thẳng terminal

Ngày 2026-08-01. Hai việc nằm chung một spec vì cả hai đều là về đường đi
giữa PWA (hub) và trang terminal (daemon), và cùng đụng vào `app.js`.

## 1. Bối cảnh: hai origin, một cửa sổ phụ

PWA cài ra màn hình chính có `scope: "/"` trên origin của hub (https). Trang
terminal nằm ở origin **khác**: `http://<ip-tailnet>:<port>`. iOS mở mọi điều
hướng ra ngoài scope trong một **cửa sổ trình duyệt phụ** (in-app browser) —
nhận ra được bằng thanh công cụ back / forward / share / la bàn ở đáy, thứ mà
PWA standalone không bao giờ có.

Đây không phải khiếm khuyết cấu hình sửa được: daemon chạy HTTP thuần trên IP
tailnet là quyết định có chủ đích (không dùng TLS để tránh lộ tên máy qua
Certificate Transparency log), và một trang https không mở nổi `ws://` tới IP
đó vì mixed content. Hai origin là điều kiện của bài toán, không phải biến số.

## 2. Việc 1 — màn hình trắng khi quay lại

### 2.1 Triệu chứng

Thỉnh thoảng, quay lại từ trang terminal thì được một trang trắng hoàn toàn,
thanh địa chỉ rỗng, back/forward đều xám. Nạp lại không cứu được; phải thoát
hẳn PWA.

### 2.2 Nguyên nhân

Cửa sổ phụ có lịch sử **riêng**, gần như rỗng — nó không nối vào lịch sử của
PWA. Mọi đường dẫn tới `history.back()` trong cửa sổ đó đều rơi vào khoảng
trống:

- người dùng vuốt cạnh trái hoặc bấm mũi tên Back trên thanh công cụ;
- `term.js` tự gọi `goBack()` 1.5 giây sau khi phiên đóng (`term.js:322`);
- `canGoBack()` (`term.js:78`) đoán "quay lại được" bằng `history.length > 1`,
  mà cửa sổ phụ thường khởi tạo sẵn một mục trống nên phép đoán này trả về
  `true` một cách sai lệch.

PWA thật vẫn sống ở dưới cửa sổ phụ, nên chỉ thoát app mới thoát ra được.
Không liên quan tới bộ nhớ máy.

### 2.3 Thiết kế

> **ĐÃ BỊ GỠ HẲN** (đo trên iPhone thật ngày 2026-08-01,
> `.superpowers/sdd/2026-08-01-quay-lai-va-deep-link/revert-back-nav-brief.md`).
> Toàn bộ thiết kế dưới đây — `validHubOrigin`, `sessionStorage`, mục lịch sử
> đệm, và cả route `GET /hub` phía daemon (nhắc tới ở cuối mục này) — đã bị xoá
> khỏi cả hai phía. Đo trên máy thật cho ba kết quả bác bỏ nó:
>
> 1. Màn hình trắng vẫn còn, và xảy ra cả khi bấm nút **Done** của cửa sổ
>    trình duyệt phụ — nơi không một dòng JS nào của dự án chạy. Cơ chế này
>    đang bảo vệ khỏi một lỗi mà nó không gây ra; nguyên nhân thật (nghi iOS
>    huỷ web view vì thiếu bộ nhớ) vẫn chưa rõ, đang hoãn để điều tra riêng
>    bằng Web Inspector.
> 2. Back lần đầu mất trắng, do chính đợt sửa cuối sinh ra: nguồn hub origin
>    đổi từ fragment sang `GET /hub` bằng `fetch` — bất đồng bộ — nhưng mục
>    đệm vẫn cài ngay lúc tải trang. Cử chỉ back đầu tiên pop mục đệm trước
>    khi `GET /hub` kịp trả lời, `goBack()` chạy với `currentHub()` còn
>    `null`, và hàm trả về im lặng — người dùng mất một thao tác, màn hình
>    không đổi gì.
> 3. Ngay cả khi chạy đúng, nó đưa người dùng vào một **bản sao hub bên trong
>    cửa sổ phụ** — không phải PWA thật. Chủ dự án đã nêu chuyện này hai lần
>    như một phiền toái, không phải tính năng.
>
> Quyết định: back từ terminal phải thoát hẳn về PWA trong một thao tác, bằng
> nút **Done** mà cửa sổ phụ đã tự có sẵn — không JS nào làm việc đó tốt hơn
> việc đứng yên và để iOS làm. Phần còn lại của §2.3/§2.4 giữ nguyên làm hồ sơ
> lịch sử của thiết kế đã thử và bị bác bỏ, không mô tả code hiện tại.

Nguyên tắc: **trang terminal không bao giờ được gọi `history.back()`**. Nó
điều hướng tường minh về hub, hoặc không đi đâu cả và nói rõ vì sao.

Hub origin đi kèm token, trong fragment:

```
http://<ip>:<port>/#t=<token>&h=https%3A%2F%2Fhub.example.com
```

- `app.js openTerminal()` ghép thêm `&h=` + `encodeURIComponent(location.origin)`.
- `term.js readAndClearTicket()` đọc cả hai tham số, xoá cả fragment như hiện
  nay, và cất hub origin vào `sessionStorage` (khoá `ccrc_hub`) để còn dùng
  sau khi nối lại hay tải lại trang. Đi qua `safeStorageGet/Set` đã có sẵn —
  Safari riêng tư làm sessionStorage ném, và việc này không được làm vỡ trang.
- **Kiểm tra trước khi nhận `h`**: phải parse được bằng `new URL`, protocol là
  `https:`, không có username/password, và `pathname` là `/` — tức một origin
  thuần. Không hợp lệ thì coi như không có. Đây là lối duy nhất một giá trị
  ngoài quyết định được trang này điều hướng đi đâu, nên nó bị siết y như
  `isTailnetTerminalUrl()` siết chiều ngược lại.
- `goBack()` đổi thành `location.href = hubOrigin`. `canGoBack()` đổi thành
  "có hub origin hợp lệ hay không" — bỏ hẳn `history.length`.
- Nhánh phiên đã đóng (`CLOSE_SESSION_ENDED`) giữ nguyên cấu trúc: có hub
  origin thì hiện nút và tự quay về sau 1.5s; không có thì giữ câu "mở lại
  bằng `/remote on` rồi vào lại từ ứng dụng" và không hứa gì thêm.

**Chặn nút Back của cửa sổ phụ.** Sửa `goBack()` chưa đủ: nút Back và cử chỉ
vuốt cạnh trái là của trình duyệt, không đi qua code này. Khi — và chỉ khi —
có hub origin (nghĩa là trang được mở từ PWA), lúc tải trang đẩy một mục lịch
sử đệm bằng `history.pushState`, rồi nghe `popstate`: cử chỉ back pop mục đệm
đó, `popstate` bắn, và handler điều hướng về hub. Người dùng bấm Back thì về
danh sách phiên — đúng thứ họ muốn — thay vì trang trống.

Mở trang trực tiếp bằng URL gõ tay hay bookmark thì **không** có `h`, nên
không cài mục đệm: back giữ nguyên hành vi gốc của trình duyệt, không bị một
trang lạ giam lại.

### 2.4 Ẩn số phải đo trước

Cửa sổ phụ có dùng chung `localStorage` với PWA hay không — chưa ai biết chắc.
Nếu **có**, hub mở trong đó vẫn đăng nhập và danh sách phiên hiện ra bình
thường. Nếu **không**, nó sẽ hỏi token, và điều hướng về hub là một trải
nghiệm tệ hơn cả trang trắng.

Nên đây là bước đầu tiên của kế hoạch, đo trên chính iPhone của người dùng
trước khi viết phần còn lại. Phương án dự phòng nếu storage không dùng chung:
không điều hướng, mà hiện một câu chỉ dẫn ("vuốt xuống để đóng cửa sổ này và
quay về app") và vẫn dùng mục lịch sử đệm để nuốt cử chỉ back — trang vẫn còn
nội dung thay vì trắng.

**Đã đo (2026-08-01):** đáp án A — cửa sổ phụ **dùng chung** phiên đăng nhập
với PWA thật. Hub mở trong đó vẫn đăng nhập, danh sách phiên hiện ra bình
thường; không cần tới phương án dự phòng ở trên. Sự thật này vẫn đáng giữ dù
cơ chế điều hướng ở §2.3 đã bị gỡ.

Màn hình trắng, ngược lại, **chưa** được sửa: nó xảy ra cả khi bấm nút Done —
nơi không một dòng JS nào của dự án chạy — nên nguyên nhân nằm ngoài phạm vi
cơ chế ở §2.3. Nghi iOS huỷ web view vì thiếu bộ nhớ; chưa xác nhận, đang hoãn
để điều tra riêng bằng Web Inspector.

## 3. Việc 2 — bấm thông báo mở thẳng terminal của phiên đó

### 3.1 Hiện trạng

Push payload **đã** mang `sessionId` (`server/src/index.js:203`, gửi nguyên
vẹn qua `notifyUser`). `sw.js` vứt nó đi: `showNotification` không nhận `data`,
và `notificationclick` chỉ focus cửa sổ bất kỳ hoặc mở `/`.

### 3.2 Thiết kế

**`sw.js`**

- `showNotification` nhận thêm `data: { sessionId }` (vắng mặt khi thông báo
  không thuộc phiên nào — thông báo từ thư mục không chạy `/remote`).
- `notificationclick`:
  - có cửa sổ đang chạy → `focus()` rồi `postMessage({ type: 'ccrc_open',
    sessionId })`;
  - chưa có → `openWindow('/?open=' + encodeURIComponent(sessionId))`.
  - không có `sessionId` → hành vi như hiện nay (focus, hoặc mở `/`).

**`app.js`**

- Lúc tải: đọc `?open=` bằng `URLSearchParams`, cất vào `pendingOpen`, rồi xoá
  tham số khỏi thanh địa chỉ bằng `history.replaceState` ngay — nạp lại trang
  sau đó không được mở lại terminal lần nữa.
- Nghe `navigator.serviceWorker.addEventListener('message', …)`: nhận
  `ccrc_open` thì đặt `pendingOpen` rồi gọi `refreshTerminal()`.
- Sau khi `renderTerminalList()` dựng xong danh sách, nếu có `pendingOpen`:
  **tiêu thụ nó trước** (đặt về `null`) rồi mới hành động, để không có đường
  nào lặp lại. Bốn nhánh kết thúc:

  | Tình huống | Kết quả |
  |---|---|
  | Không thấy phiên trong danh sách | `#terminal-err`: "Phiên đó đã đóng — không mở được." |
  | Thấy nhưng `!alive` | `#terminal-err`: "Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt." |
  | `alive` nhưng máy chưa ghép | `#terminal-err`: "Điện thoại này chưa ghép với máy đó — bấm 'Ghép máy này'." |
  | `alive` và đã ghép | Gọi `openTerminal(session, nút của thẻ đó)` như bấm tay |

  Đặt sau `renderTerminalList()` chứ không trong `doRefreshTerminal()` phần
  đầu, vì `doRefreshTerminal()` xoá `#terminal-err` ở ngay đầu mỗi lượt — set
  trước sẽ bị xoá một nhịp sau.

- Không thêm quyền nào mới: nhánh mở vẫn đi qua `isTailnetTerminalUrl()` và
  vẫn tự ký token trên máy, giống hệt lúc người dùng bấm nút.

### 3.3 Điều không làm

Không ký token trong service worker để mở thẳng trang terminal. Token đăng
nhập hub nằm trong `localStorage`, mà service worker không đọc được
`localStorage`; làm được sẽ phải nhân đôi nơi cất token. Đi vòng qua trang hub
tốn thêm một nhịp tải nhưng dùng lại toàn bộ đường ký và đường kiểm tra đã có.

## 4. Kiểm thử

- `server/test/app-terminal.test.js` đã có khung DOM chạy `app.js` trong `vm`.
  Thêm: `?open=` mở đúng phiên; xoá tham số khỏi URL; bốn nhánh ở §3.2; tiêu
  thụ một lần (refresh lần hai không mở lại).
- `sw.js` chưa có test. Thêm một file test nạp `sw.js` trong `vm` với `self`
  giả, kiểm: `push` gắn `data.sessionId`; `notificationclick` focus + gửi
  `postMessage` khi có cửa sổ, `openWindow('/?open=…')` khi không, và đường
  không có `sessionId`.
- `term/test/term-page.test.js` đã có khung tương tự cho `term.js`. Thêm: đọc
  `h` từ fragment; từ chối `h` không phải origin https thuần; `goBack()` điều
  hướng thay vì `history.back()`; `popstate` điều hướng về hub; không cài mục
  đệm khi không có `h`.
- Một lượt nghiệm thu tay trên iPhone: mở terminal từ PWA → bấm Back → phải
  thấy danh sách phiên, không thấy trang trắng; bấm một thông báo → phải vào
  thẳng terminal của đúng phiên gửi nó.

## 5. Phạm vi

File sản phẩm: `server/public/app.js`, `server/public/sw.js`,
`term/public/term.js`, và `server/public/index.html` — file cuối chỉ để **bump
`?v=`** trên `app.js`/`style.css` từ 9 lên 10. Không bump thì PWA đã cài giữ
nguyên bản `app.js` cũ trong cache và bản sửa không bao giờ tới được máy người
dùng. `term.js` không cần: daemon phục vụ file tươi từ đĩa mỗi lượt.

File test: `server/test/app-terminal.test.js` (sửa), `term/test/term-page.test.js`
(sửa), và một file mới cho `sw.js`.

Không đụng daemon (`term/bin/`), không đụng hub server (`server/src/`), không
đổi giao thức WebSocket, không đổi cách ký token.
