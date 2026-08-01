# Đánh dấu phiên có thông báo chưa đọc — thiết kế

Ngày: 2026-07-30

## 1. Vấn đề

Điện thoại nhận thông báo đẩy, người dùng chạm vào, PWA mở ra — và không có
cách nào biết thông báo đó thuộc phiên nào. Mục "Terminal" liệt kê mọi phiên
đang chạy với vẻ ngoài giống hệt nhau; mục "Gần đây" thì có nội dung thông báo
nhưng lại không nối được về thẻ nào. Với một phiên thì đoán được, với ba phiên
thì phải mở lần lượt từng cái để tìm.

Kết quả mong muốn: nhìn vào danh sách Terminal là thấy ngay phiên nào đang có
việc chờ mình. Mở phiên đó ra thì dấu tắt.

## 2. Phạm vi

Có:

- Hub giữ lại `sessionId` khi ghi thông báo vào lịch sử.
- Chấm tròn màu accent trên thẻ terminal có thông báo chưa đọc.
- Ba đường đánh dấu đã đọc: bấm mở, quay về từ phiên đó, chạm vào thẻ.

Không có (cố ý để ngoài):

- Số đếm trên badge — người dùng chọn "chỉ chấm tròn".
- Đổi màu viền thẻ hay tô nền thẻ.
- Đánh dấu chưa đọc trong danh sách "Gần đây".
- Cập nhật badge tức thời khi PWA đang mở sẵn (service worker báo cho trang).
  Cơ chế `pageshow`/`visibilitychange` sẵn có đã phủ đúng luồng thực tế.

## 3. Quyết định nền tảng

**Trạng thái "đã đọc" nằm trên điện thoại, trong `localStorage`.** Không có
endpoint mới, không có state mới trên hub, không có gì phải persist qua lần
restart hub. Đánh đổi: mở PWA trên hai thiết bị thì mỗi thiết bị đếm riêng —
chấp nhận được, và có khi còn đúng hơn (mỗi người tự biết mình đã xem gì).

Lịch sử thông báo trên hub vốn đã chỉ nằm trong RAM (`server/src/index.js`,
`HISTORY_MAX = 50`), nên trạng thái đọc cũng không cần bền hơn nó.

## 4. Thay đổi phía hub

Một chỗ duy nhất: `server/src/index.js`, hàm dựng `note` trong route `/notify`
(quanh dòng 172). Hook **đã** gửi `sessionId` từ trước
(`hook/src/notify-payload.js:44`) và hub **đã** dùng nó để quyết định có nén
push hay không (`terminals.isViewing`), nhưng lại bỏ nó đi khi ghi vào lịch sử.
Giữ lại:

```js
const note = {
  type: String(n.type || ''),
  title: n.title.slice(0, 200),
  body: n.body.slice(0, 200),
  tag: String(n.tag || 'ccrc'),
  ...(typeof n.sessionId === 'string' && n.sessionId
    ? { sessionId: n.sessionId.slice(0, 200) }
    : {}),
};
```

Vắng mặt trường này khi thông báo không thuộc phiên nào (không chạy `/remote`
cho thư mục đó) — đúng như hành vi hiện tại, và là trường hợp phổ biến.
`GET /api/notifications` trả thẳng `note` nên tự động có kèm.

Cắt 200 ký tự cho đồng bộ với `title`/`body` ngay bên cạnh: `/notify` mở cho
bất cứ ai cầm token, nên không nhận chuỗi dài tuỳ ý vào một mảng nằm trong RAM.

## 5. Thay đổi phía PWA (`server/public/app.js`)

### 5.1 Nguồn dữ liệu

Thêm biến cấp module `recentNotes`, do `refreshList()` ghi lại sau mỗi lần
GET `/api/notifications`.

Hàm phụ, gom thành một khối có chú thích riêng:

- `readKey(sessionId)` → `'ccrc_read_' + sessionId`
- `lastReadAt(sessionId)` → `Number(localStorage.getItem(readKey(id))) || 0`
- `markRead(sessionId)` → ghi `String(Date.now())`
- `hasUnread(sessionId)` → có note nào `note.sessionId === sessionId &&
  note.at > lastReadAt(sessionId)` không

### 5.2 Đồng bộ hai lần fetch

Badge cần **cả hai** nguồn: `/api/terminal` (có phiên nào) và
`/api/notifications` (phiên nào có việc). Hiện `pageshow`/`visibilitychange`
chỉ gọi `refreshTerminal()`, nên nếu để nguyên thì badge sẽ được tính trên
`recentNotes` cũ và không bao giờ sáng lên đúng lúc.

Sửa: `refreshTerminalOnReturn()` (quanh dòng 570) đổi tên thành
`refreshOnReturn()`, gọi tuần tự `refreshList()` rồi `refreshTerminal()`.
Cơ chế coalescing chống bắn trùng `pageshow` + `visibilitychange` chuyển lên
cấp này (giữ nguyên `terminalRefreshInFlight` bên dưới cho các lối gọi khác,
ví dụ nhánh lỗi của `openTerminal()`). Bọc `.catch(() => {})` vì
`refreshList()` không tự bắt lỗi như `refreshTerminal()`.

Luồng thực tế được phủ bởi đúng cơ chế này: `sw.js` xử lý `notificationclick`
bằng cách focus cửa sổ đang có sẵn (không reload), nên `visibilitychange` bắn
và danh sách được tính lại ngay trước khi người dùng kịp nhìn.

### 5.3 Dựng thẻ

`buildTerminalCard()` (quanh dòng 146), dòng tiêu đề đổi từ một `textContent`
thành hai span:

```html
<div class="row terminal-title">
  <span class="unread-dot"></span>       <!-- chỉ khi có chưa đọc -->
  <span>sdk · may-dev</span>   <!-- tên: LUÔN là span cuối -->
</div>
```

Tên vẫn gán bằng `textContent`, không bao giờ `innerHTML` — `label` và
`machine` đều đến từ máy dev và `label` do người dùng đặt.

Chấm mang `aria-label="có thông báo chưa đọc"` để không phải là thông tin chỉ
tồn tại bằng màu.

Thẻ thêm class `has-unread` khi đang có chấm.

Ràng buộc bố cục: tên **luôn là span cuối** trong hàng. Đây là hợp đồng giữa
code dựng thẻ và test đọc tên (`children.at(-1)`), nên đổi thứ tự là hỏng test
chứ không hỏng ngầm.

### 5.4 CSS (`server/public/style.css`)

```css
.terminal-title { justify-content: flex-start; gap: 8px; }
.unread-dot { width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent); flex: 0 0 auto;
  box-shadow: 0 0 0 3px rgba(217, 119, 87, .20); }
```

`.row` mặc định là `justify-content: space-between`, để nguyên thì chấm bị đẩy
sang tận mép phải — nên phải ghi đè bằng `.terminal-title`.

Quầng sáng mờ quanh chấm là thứ làm nó nổi trên nền `--card` tối mà không phải
tô cả thẻ.

## 6. Ba đường đánh dấu đã đọc

1. **Bấm "Mở terminal"** — `markRead(session.sessionId)` trong
   `openTerminal()`, đặt **sau** cả `isTailnetTerminalUrl()` lẫn
   `signAttachToken()`, ngay trước `location.href`. Đặt cuối là có chủ ý: một
   thẻ bị từ chối vì URL lạ, hay một lần ký hỏng vì điện thoại chưa ghép, đều
   kết thúc bằng "không mở được gì cả" — và không được vì thế mà mất dấu chưa
   đọc.

2. **Quay về từ chính phiên đó** — cùng chỗ với đường 1, ghi thêm
   `sessionStorage.setItem('ccrc_opened', sessionId)`.

   Tiêu thụ dấu này ở **đầu `doRefreshTerminal()`**, trước khi fetch và dựng
   lại danh sách: `markRead()` lần nữa (mốc = lúc quay về) rồi `removeItem`.
   Đặt ở đó chứ không đặt trong `refreshOnReturn()` để mọi lối vào đều được
   phủ — kể cả lần `showMain()` chạy lại từ đầu, vốn không đi qua
   `refreshOnReturn()`.

   Giải quyết: hub **vẫn ghi** thông báo vào lịch sử trong lúc người dùng đang
   xem terminal (chỉ nén push, xem chú thích ở `/notify`), nên nếu không có
   bước này thì vừa xem xong quay ra vẫn thấy chấm cam.

   Dùng `sessionStorage` chứ **không** `localStorage`: nó sống qua lần điều
   hướng sang máy dev và quay lại trong cùng một tab, nhưng chết khi đóng app.
   Nhờ vậy "mở lại app sau ba tiếng" không âm thầm nuốt mất đống thông báo đến
   trong lúc đó — đó đúng là những thông báo cần sáng chấm nhất.

3. **Chạm vào thẻ** — `card.onclick` chỉ gắn khi thẻ đang có chấm: `markRead()`
   rồi gỡ chấm và class `has-unread` tại chỗ (không fetch lại). Đây là lối
   thoát duy nhất cho phiên "máy không phản hồi", vốn không dựng nút nào để
   bấm — thiếu nó thì chấm kẹt vĩnh viễn cho tới khi hub evict phiên sau 30
   phút.

   Click vào nút "Mở terminal" cũng nổi bọt lên `card.onclick`; vô hại vì
   đường 1 đã đánh dấu đã đọc rồi.

## 7. Dọn khoá `localStorage`

Mỗi lần `renderTerminalList()` chạy, xoá mọi khoá `ccrc_read_*` có sessionId
**không** nằm trong danh sách phiên vừa nhận **và** **không** được note nào
trong `recentNotes` nhắc tới. An toàn: khi cả hai điều kiện đúng thì dấu đã đọc
đó không còn ảnh hưởng tới bất cứ thứ gì hiển thị được.

Không dọn thì mỗi lần `/remote on` để lại một khoá vĩnh viễn.

## 8. Kiểm thử

### 8.1 Bộ khung (`server/test/dom-harness.mjs`)

- Thêm `sessionStorage` giả, chép đúng cách `localStorage` giả đang làm
  (`getItem`/`setItem`/`removeItem` trên một `Map`), và đưa vào `contextObj`.
  Trả về từ `loadAppPage()` để test đọc được.

### 8.2 `server/test/app-terminal.test.js`

- Sửa helper `titleOf` (dòng 61) → `card.children[0].children.at(-1).textContent`.
- Test mới:
  - Note mới hơn mốc đã đọc, đúng `sessionId` → thẻ có `.unread-dot`.
  - Note cũ hơn mốc đã đọc → không có chấm.
  - Note của phiên KHÁC → phiên này không sáng chấm.
  - Note không có `sessionId` → không phiên nào sáng chấm.
  - Bấm "Mở terminal" → `localStorage` có mốc mới; render lại thì hết chấm.
  - Mở rồi quay về (`pageshow`), trong lúc đi có note mới → vẫn hết chấm.
  - Mở, đóng app (xoá `sessionStorage`), mở lại, có note mới → **có** chấm.
  - Phiên `alive:false` có note mới → có chấm và không có nút; `card.onclick()`
    → hết chấm.
  - Render với phiên A còn sống → khoá `ccrc_read_` của phiên đã biến mất khỏi
    cả danh sách lẫn notes bị xoá; khoá của A giữ nguyên.

### 8.3 `server/test/notify-api.test.js`

- `/notify` kèm `sessionId` → `GET /api/notifications` trả về note có
  `sessionId` đúng.
- `/notify` không kèm → note không có trường `sessionId`.
- `/notify` với `sessionId` không phải chuỗi → không có trường, không nổ
  (đã có test cho nhánh push, thêm nhánh lịch sử).

## 9. Triển khai

`server/public/index.html`: bump `?v=8` → `?v=9` trên cả `app.js` và
`style.css`.

Không đụng tới `term/` (nửa máy dev) và `hook/` — hook đã gửi đủ dữ liệu từ
trước.
