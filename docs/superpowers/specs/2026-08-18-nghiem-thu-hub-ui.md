# Nghiệm thu giao diện hub mới

Ngày: 2026-08-19 · Nhánh: `feat/hub-ui-redesign` · Head: `5d8db0d`
Cách đo: hub chạy local (`CCRC_PORT=8721`, data dir tạm), hai phiên terminal giả đăng ký qua
`POST /api/terminal/register`, trang mở bằng Chrome trên macOS.

## Chạy được

**Bộ test.** 454/454 xanh (`cd server && npm test`), không có test nào bị bỏ qua thêm so với
trước nhánh này. Trong đó có 5 file test mới: `style-tokens`, `app-settings`, `app-pwa-note`,
`app-theme`, `app-push-switch`.

**Màn hình chính.** Header là `Terminal` + nút ⚙. Thẻ thông báo một hàng, cần gạt bên phải.
Danh sách terminal ngay dưới, không phải cuộn. Nút chiếm hết bề ngang thẻ.

**Thẻ phiên — dữ liệu đúng như thiết kế:**

| Phiên | Tên hiện | Dòng phụ |
|---|---|---|
| label `ccrc-ui`, máy `macbook` | `ccrc-ui` | `macbook · chưa ghép với máy này` |
| không có label, máy `vps-01` | `vps-01` | `chưa ghép với máy này` |

Phiên không có label **không** lặp lại tên máy ở dòng phụ — đúng ý đồ. Máy chưa ghép ra nút
`Ghép máy này` kiểu nhạt (`btn-soft`), không phải `Mở terminal`.

**Cần gạt thông báo.** `textContent` rỗng (chữ không đè lên cần gạt), `aria-checked="false"`,
class `switch` không kèm `on`, và `#push-state` nói `chưa bật`. Ba nguồn khớp nhau.

**Trang Cài đặt.** Thứ tự đúng yêu cầu: tên + Đăng xuất → ghi chú iPhone → Giao diện →
Thiết bị nhận thông báo → Duyệt máy dev. Ghi chú iPhone **có** hiện khi mở bằng trình duyệt.

**Ba đường đóng Cài đặt đều đúng:** nút ⚙ mở, nút Back của trình duyệt đóng (không rời trang),
nút ‹ đóng.

**Ba lựa chọn giao diện.** Đo cả bốn thứ mỗi lần đổi:

| Chọn | `data-theme` | `theme-color` | nền `body` thật | `--accent` |
|---|---|---|---|---|
| Theo thiết bị | *(không có)* | `#101318` | `rgb(16,19,24)` | `#e0805f` |
| Sáng | `light` | `#f6f4f2` | `rgb(246,244,242)` | `#c05f3c` |
| Tối | `dark` | `#101318` | `rgb(16,19,24)` | `#e0805f` |

Quay lại "Theo thiết bị" **gỡ hẳn** `data-theme` và xoá khoá `localStorage`, không để lại giá
trị nào — đây là chỗ dễ sai nhất và nó đúng.

**Bản vá đăng xuất (lỗi nghiêm trọng vòng soát cuối tìm ra).** Đo trực tiếp trên trình duyệt:

1. Đang ở Cài đặt → bấm Đăng xuất → chỉ còn `#login`, `#settings` đã ẩn. Không chồng nhau.
2. Đăng nhập lại → chỉ còn `#main`. `#settings` vẫn ẩn.
3. Bấm ⚙ lần nữa → Cài đặt **mở được**. Đây là bằng chứng `settingsOpen` thật sự được reset,
   chứ không chỉ ẩn class DOM một lần.

Bước 3 quan trọng vì bộ test **không** phủ nửa này (xem mục dưới) — nó được đo bằng tay.

## Chưa đo được

**iPhone.** Ba việc bắt buộc phải có máy thật, chưa làm:

1. Mở bằng Safari thường → khối ghi chú iPhone có hiện *(đã đo trên Chrome desktop, còn Safari
   iOS thì chưa)*.
2. Thêm vào màn hình chính, mở từ đó → khối ghi chú **không** hiện. Đường dò là
   `navigator.standalone`, chỉ iOS mới có, nên đây là nhánh code duy nhất chưa ai chạy thật.
3. Trong PWA đã cài: vuốt cạnh để back khi đang ở Cài đặt. `popstate` trong web app đã cài có
   lịch sử hoạt động không đồng đều giữa các bản iOS — rủi ro này spec đã lường trước
   (§10). Nếu hỏng, nút ‹ vẫn là đường đóng chắc chắn.

**Thẻ "máy không phản hồi".** Cần đợi 60 giây không có nhịp tim mới dựng được trạng thái đó
trên hub local. Bộ test đã phủ (`app-terminal.test.js`: máy chết thì không dựng nút nào, và câu
`Máy không phản hồi — có thể đã ngủ, hoặc /remote đã tắt.` giữ nguyên từng chữ).

**Bấm một thông báo đẩy để mở thẳng phiên.** Cần đăng ký push thật với VAPID, chưa làm.

**Trang `/link`.** Chưa mở bằng tay. `app-login.test.js` có phủ đường "vào /link chưa đăng nhập →
hiện thẻ đăng nhập → đăng nhập xong quay lại đúng thẻ duyệt".

## Quyết định và ghi nhận phát sinh

**Test còn thiếu phủ một nửa bản vá đăng xuất.** Vòng soát lại chứng minh: bỏ dòng
`settingsOpen = false;` mà giữ dòng ẩn DOM thì cả hai test mới **vẫn xanh**. Tệ hơn, chú thích
của test thứ hai tự nhận nó chứng minh `settingsOpen` đã được reset — lời đó sai. Code đang
đúng, và mục trên đã đo tay để xác nhận hành vi, nhưng lưới test không bắt được một hồi quy
vào nửa đó. Cách bịt: một test bấm `settings-open` lần nữa sau lượt đăng xuất/đăng nhập lại rồi
assert Cài đặt mở ra.

**Trên màn hình rộng thẻ giãn hết chiều ngang.** Không có `max-width`, nên trên desktop các thẻ
kéo dài cả 1900px trông trống trải. **Không phải hồi quy** — bản CSS cũ cũng không có
`max-width`, và đây là PWA cho điện thoại. Ghi lại vì nếu sau này ai mở trên máy tính thì đây
là thứ đầu tiên họ thấy.

**`?v=` chỉ bump một lần cho cả nhánh** (14 → 15). Ràng buộc "bump mỗi lần đụng vào
`app.js`/`style.css`" tồn tại để chống Cloudflare giữ bản cũ 4 giờ sau khi deploy, mà cả nhánh
này deploy một lần.
