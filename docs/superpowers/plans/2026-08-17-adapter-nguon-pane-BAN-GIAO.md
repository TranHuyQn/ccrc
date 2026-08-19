# Bàn giao đợt 1: tầng adapter "nguồn pane"

Nhánh `test/windows-compat`, 18 commit từ `1fec301`. **Chờ Huy nghiệm thu tay.**

Kế hoạch: [`2026-08-17-adapter-nguon-pane.md`](./2026-08-17-adapter-nguon-pane.md)
Spec: [`../specs/2026-08-17-windows-native-design.md`](../specs/2026-08-17-windows-native-design.md)

---

## 1. Kết quả

| | |
|---|---|
| Test | **482 → 506**, không sửa một bài cũ nào |
| Task 1 — nhóm đọc | ✓ `d3d92ad..18c7d84` |
| Task 2 — vòng đời | ✓ `0829a03..dbc987e` |
| Task 3 — nhóm ghi | ✓ `dbc987e..7c6f5ce` |
| Task 4 — hàng rào | ✓ `7c6f5ce..5157c2a` |
| Sửa sau soát toàn nhánh | ✓ `5157c2a..7db07a0` |
| Task 5 — nghiệm thu tay | **chờ Huy** |

Không một dòng code Windows nào trong nhánh này. Không thêm dependency nào.

## 2. Hình dạng cuối

```
createTmuxPaneSource({ pane, runId })        // MỘT cho cả daemon
  .alive() .snapshot() .historySize() .history() .mouseMode() .cwd() .socket()
  .attach({ onData, onCtlReply, onGone }) -> { ok, conn }
       conn.close() .type() .paste() .resize() .mouse()
```

Phiên nhóm tmux dựng một lần và dùng chung; mỗi trình duyệt có ống `tmux -C`
riêng và hàng đợi lời đáp riêng. `ccrc-term.js` không còn gọi tmux ở đâu cả, và
có test canh điều đó.

## 3. Mười ba quyết định mình tự chốt thay Huy

Đọc kỹ mục này. Đây là chỗ duy nhất chúng tới được Huy — cái nào sai thì sửa.

| # | Quyết định | Sai thì mất gì |
|---|---|---|
| A | Bài test hàng rào lột comment trước khi soi từ cấm — vì `ccrc-term.js:76` là comment đang đúng việc, có chữ `refresh-client`, và nó phải ở lại | Test có thể bỏ sót lệnh tmux giấu trong chuỗi khác thường |
| B | Test đếm phiên nhóm lọc theo `runId` của chính lần chạy, không đếm cả tmux server — vì `npm test` chạy 4 file song song trên cùng một server | Test canh hẹp hơn một chút, đổi lấy sự tin cậy |
| C | Sửa khối Files của Task 1 cho đúng phạm vi thật | Không có rủi ro |
| D | `onCtlReply` ở Task 2 là interface quá độ, ghi rõ để không ai "sửa cho gọn" | Thừa một đoạn ghi chú |
| E | Task 2–3 không chờ chữ pane in ra bằng `sleep()` cố định — máy này shell mất 1,15–1,75 giây mới nhận lệnh | Test chờ lâu hơn cần thiết vài trăm ms |
| F | Bài test `onGone` phải `kill-pane`, không `kill-session`; mọi test có `attach()` phải `close()` trong `finally` | Test giết pane mạnh hơn cần thiết; không đụng code sản phẩm |
| G | Đổi implementer cho Task 2 thay vì resume lần nữa | Tốn thêm một lượt dispatch |
| H | **Adapter hai tầng** — nguồn một cho cả daemon, `attach()` cho từng kết nối | Task 3 phải nắn lại lần nữa |
| I | Bỏ chỉ dẫn `--test-timeout` cho `daemon.test.js` — Node áp nó cho cả file, mà file đó vốn chạy ~81 giây | Một lần treo thật sẽ khó thấy hơn |
| J | `pasteSeq` ở scope factory, không trong `attach()` | Không — lỗi này đã được test chứng minh |
| K | **Khôi phục đường cũ cho byte chuột** (`conn.mouse()`), không chấp nhận việc chúng bị xếp hàng sau lượt dán | Thêm một phương thức mà đợt 2 có thể gộp lại |
| L | Bịt hàng rào bằng cách khẳng định `ccrc-term.js` **không import `node:child_process`**, thay vì nối dài danh sách đen subcommand | Nếu sau này daemon có lý do chính đáng để spawn, phải nới test một cách có ý thức — đúng hướng |
| M | Cho phép sửa **comment** trong `tmux.js` dù ràng buộc nói "không sửa" | Revert một dòng comment |

**Một thứ cố ý KHÔNG sửa:** lượt dán có thể vừa báo lỗi vừa báo thành công —
đồng hồ 5 giây canh cả lượt dán chứ không riêng `load-buffer`, nên tmux trả lời
chậm hơn 5 giây sẽ khiến trình duyệt nhận cả `ccrc_loi` lẫn `ccrc_ack`. **Giống
hệt code trước refactor**, nên giữ nguyên mới là đúng ràng buộc "không đổi hành
vi". Ghi lại cho đợt 2 (`pane-source.js`: chuyển `onAck()` vào chỗ chỉ chạy khi
`finish()` thành công).

## 4. Bảy lỗi trong kế hoạch bị bắt trong lúc thực thi

Nêu ra vì nó cho biết chỗ nào của bản thiết kế còn mỏng:

1. `withSession` thiếu `await` — chép từ `tmux.test.js`, ở đó không lộ vì chỉ dùng callback đồng bộ
2. `sleep()` cố định quá ngắn cho shell máy này
3. Test `onGone` giết phiên gốc, nhưng phiên nhóm vẫn giữ pane sống → điều kiện không bao giờ đạt tới
4. Test không `close()` → `node --test` **treo** chứ không đỏ
5. **Lỗi kiến trúc:** gộp "dựng phiên nhóm" với "dựng ống ctl" — kết nối thứ hai không có ống nào
6. `pasteSeq` sai scope → hai điện thoại dán cùng lúc đè tên buffer của nhau
7. Hàng rào hở `attach-session`, rồi hở tiếp `display-message` qua đường hardcode

Lỗi 5 và 6 đều bị bắt bởi **một bài test có sẵn từ trước** —
`daemon.test.js` → `'hai client cùng gửi: không ai nuốt tin nhắn của ai'`. Đó là
lý do ràng buộc "không được sửa test cũ cho nó xanh" đáng giá.

## 5. Việc Huy cần làm

### Bước 1 — cho phép chép bản mới sang chỗ daemon thật chạy

Daemon chạy bản **đã cài** (`~/.local/share/ccrc`), không phải bản trong repo.
Muốn đo thì phải chép sang, và đó là **thay đổi cấu hình máy** nên mình chờ Huy
đồng ý:

```
rsync -a --delete --exclude node_modules term/ ~/.local/share/ccrc/term/
rsync -a --delete shared/ ~/.local/share/ccrc/shared/
```

⚠️ `--exclude node_modules` là bắt buộc, không phải cẩn thận thừa. Bản cài giữ
`term/node_modules` (có `ws` và `@xterm`) mà worktree không có — npm gom hết về
gốc repo. Thiếu cờ đó thì `--delete` xoá sạch chúng và `/remote on` chết vì
không nạp được `ws`. Đo được, không phải suy đoán: mình đã dính đúng lần đầu và
phải khôi phục từ bản sao lưu.

Muốn quay lại bản cũ: chạy lại `install.sh` như trong README.

### Bước 2 — đi tám nhánh

Trong một pane tmux đang chạy Claude Code:

1. `/remote on ktra` → thấy `✓ Remote ĐÃ BẬT`, có tên và URL
2. Mở URL trên trình duyệt → **màn hình hiện ra ngay**, không phải ô trống
3. Gõ vài phím → chữ hiện đúng ở cả trình duyệt lẫn màn hình trên bàn
4. Gửi tin nhắn dài (>2000 ký tự) qua ô soạn → ô soạn **chỉ trống đi sau khi Claude thật sự nhận**
5. Cuộn chuột trong Claude Code → nội dung hội thoại cuộn (KHÔNG phải màn hình lặp dòng prompt)
6. Thoát Claude, về shell trần, cuộn chuột → lịch sử tmux được lật, **không byte rác nào bị gõ vào dòng lệnh**
7. Mở trình duyệt thứ hai vào cùng URL → cả hai cùng xem được; đóng một cái, cái kia vẫn chạy
8. `/remote off` → trình duyệt báo hết phiên và **không nối lại vô hạn**

### Bước 3 — nhánh pane chết (quan trọng nhất)

`/remote on` lại, mở trình duyệt, rồi **đóng Claude Code** (không phải
`/remote off`). Trình duyệt phải báo hết phiên — biểu hiện là "phiên đã kết
thúc", KHÔNG phải "vé đã dùng" và KHÔNG nối lại vòng vòng.

Đây chính là ca mà mã 1011 từng thắng 4001. Thấy triệu chứng đó là `onGone`
đang trả sai chiều.

### Bước 4 — nhánh chạm/cuộn khi đang dán (mới, do quyết định K)

Gửi một tin nhắn dài qua ô soạn rồi **chạm ngay** vào màn hình trong lúc nó đang
gửi. Cú chạm phải tới nơi ngay, không đợi tin nhắn gửi xong.

## 6. Ghi chú

- Lần chạy `npm test` đầu của đợt sửa cuối có **1 bài đỏ trong `ccrc-server`**.
  Workspace `server/` **không có một dòng diff nào** trong cả nhánh này, và mọi
  lần chạy sau đều 423/423. Kết luận: flake có sẵn, không do nhánh này. Nêu ra
  để không ai tưởng nó liên quan.
- Hai phiên tmux `ccrc-6576` và `ccrc-98598` là phiên làm việc thật của Huy —
  mọi agent đều được dặn không đụng vào, và `tmux ls` sau mỗi lượt đều xác nhận
  chúng còn nguyên.
