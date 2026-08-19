// `attach-queue` — hàng đợi ghi của một terminal trong bộ nhớ, cộng với nghi
// thức gắn một người xem mới vào giữa dòng chảy mà không để rơi byte nào.
//
// Đây là ruột của `ccrc-host.js` (vai `tmux server` trên Windows), tách ra
// thành một module vì một lý do rất cụ thể: cái bug "client vừa gắn mất hẳn
// output" đã SỐNG SÓT QUA TRỌN MỘT VÒNG REVIEW, và chỉ lộ ra nhờ một probe viết
// ở tầng module. Hàng phòng thủ hôm ấy là một câu comment. Ở đây nó là test.
//
// Vì sao tách CẢ CHUỖI chứ không tách riêng phần số học: đo được rồi — một
// module chỉ giữ `seq`/`written`/`pending` thì bản HỎNG cũng pass (48 kiểu đan
// xen cộng 9 ca hai client gắn chồng nhau, kết quả y hệt khi xoá phép so).
// Bất biến thật sự bảo vệ dữ liệu là HÌNH DẠNG CỦA CHUỖI PROMISE, nên chính nó
// phải là thứ test chạm được. Tách nửa vời còn tệ hơn không tách: nó tạo ra một
// niềm tin không có cơ sở.
//
// Bất biến của cả file: MỖI CLIENT TÁI DỰNG ĐÚNG LUỒNG BYTE KỂ TỪ ĐIỂM NÓ GẮN —
// không sót, không lặp.
//
// Người gọi đưa vào:
//   `write(text)`    → Promise, ghi byte vào terminal (bất đồng bộ, xem dưới)
//   `snapshot()`     → KHUNG để gửi cho client mới, hoặc giá trị falsy nếu màn
//                      hình còn trống. Trả về khung chứ không phải chuỗi, vì
//                      việc mã hoá phải nằm TRONG mắt xích chụp — hoãn nó ra
//                      ngoài là mở lại đúng cửa sổ mà file này bịt.
// Client là một object bất kỳ có `send(frame)`; `send` KHÔNG được ném (host bọc
// `sock.write` trong try/catch), vì một client hỏng không được cắt ngang lượt
// phát của những người còn lại.
export function createAttachQueue({ write, snapshot }) {
  // MỘT TẬP CLIENT DUY NHẤT. Queue sở hữu, host mượn để tính kích thước nhỏ
  // nhất. Hai tập song song phải-cập-nhật-cùng-một-lượt chính là hạng lỗi vừa
  // vá — đừng dựng lại nó dưới cái tên khác.
  //
  // Chỉ những kết nối ĐÃ xác thực mới được host đưa vào đây, và tập này là thứ
  // duy nhất nhận byte của pty. Không có "thêm vào rồi lọc lúc phát": một cái
  // lọc chỉ cách một lệnh return sớm là rò cả phiên của người dùng ra ngoài.
  const clients = new Set();

  // Hàng giữ khung cho những client ĐÃ xác thực nhưng còn đang chờ ảnh chụp.
  // Mỗi client một mảng; mảng biến mất ngay khi nó vào `clients`. Xem attach().
  const pendingAttachers = new Set();

  // Chuỗi việc trên buffer, để MỌI câu hỏi VÀ MỌI thay đổi trên màn hình xếp
  // hàng đúng thứ tự byte đã tới. `write()` bất đồng bộ: hỏi `snapshot()` trước
  // khi nó xong là đọc một trạng thái dở dang, và một lần resize chen ngang là
  // đem byte viết ở bề rộng cũ trải lại theo bề rộng mới. Ai thêm câu hỏi mới
  // (history, historySize) sau này phải nối vào chuỗi này, y như attach() và
  // enqueue() bên dưới.
  let chain = Promise.resolve();

  // Đánh số từng mảng byte, để biết một khung đã nằm trong ảnh chụp hay chưa.
  //
  // `seq` là mảng thứ mấy đã NHẬN; `written` là mảng thứ mấy đã GHI XONG vào
  // buffer. Hai số này luôn lệch nhau trong lúc chuỗi ghi đang chạy, và chính
  // chỗ lệch ấy là cửa sổ mà một client vừa gắn có thể mất byte (xem attach()).
  let seq = 0;
  let written = 0;

  // Nối một việc vào hàng ghi. Resize đi đường này: `resize()` của buffer đổi
  // lưới NGAY và đồng bộ, trong khi những lượt ghi trước nó còn đang xếp hàng —
  // gọi thẳng nghĩa là byte sinh ra ở bề rộng cũ sẽ được trải lại theo bề rộng
  // mới. Kỷ luật mà hàng đợi này đòi cho phép ĐỌC còn đúng hơn cho phép SỬA.
  //
  // Lỗi bị nuốt có chủ đích: một lượt việc hỏng không được làm đứt hàng ghi của
  // cả phiên.
  function enqueue(fn) {
    chain = chain.then(fn).catch(() => {});
    return chain;
  }

  // Nạp một mảng byte của pty. `frame` là chính đoạn byte ấy đã mã hoá sẵn —
  // người gọi mã hoá vì việc mã hoá là chuyện của giao thức, không phải của
  // hàng đợi. `frame` falsy (host: `encodeFrame` ném vì vượt MAX_FRAME) thì byte
  // VẪN vào buffer, chỉ là không ai phát nó đi được; giữ đúng như vậy để màn
  // hình không lệch khỏi những gì pty đã in.
  function feed(text, frame) {
    const mySeq = ++seq;
    chain = chain
      .then(() => write(text))
      // Chỉ ghi mốc SAU khi lượt ghi ấy xong. `written` vì thế luôn là "ảnh
      // chụp lúc này đã thấy tới mảng số mấy".
      .then(() => { written = mySeq; })
      .catch(() => {});
    if (!frame) return;
    for (const c of clients) c.send(frame);
    // Client đang chờ ảnh chụp chưa nằm trong `clients`, nên nó KHÔNG nhận được
    // khung vừa phát. Giữ hộ nó ở đây, kèm số thứ tự, để lát nữa gửi bù đúng
    // những khung mà ảnh chụp chưa kịp thấy.
    for (const held of pendingAttachers) held.push({ seq: mySeq, frame });
  }

  // Gắn một client đã xác thực vào luồng ra: gửi màn hình hiện tại trước, rồi
  // mới cho byte trực tiếp chảy tới.
  //
  // ĐÂY LÀ CHỖ CÓ MỘT CỬA SỔ MẤT BYTE, và nó phải được bịt bằng tay.
  //
  // `write()` bất đồng bộ, nên phải chờ nó xong rồi mới chụp — chụp sớm là chụp
  // một màn hình dở dang. Nhưng cái chờ ấy mở ra một khoảng thời gian thật:
  // lượt phát trong `feed()` chạy đồng bộ, còn client này thì chưa nằm trong
  // `clients`. Một mảng byte tới đúng khoảng ấy sẽ KHÔNG được phát cho nó, và
  // cũng CHƯA nằm trong ảnh chụp (lượt ghi của nó còn xếp hàng sau mắt xích ta
  // đang chờ). Mất hẳn, im lặng — và cửa sổ này mở đúng vào lúc terminal đang
  // chảy chữ: banner khởi động, một câu trả lời đang in. Tức là ca thường gặp,
  // không phải ca hiếm.
  //
  // Lối so sánh với ccrc-term.js không cứu được ở đây: bên đó
  // `paneChung.snapshot()` đồng bộ và việc gắn chạy ngay trong cùng một lượt,
  // nên không có cửa sổ nào. Chính cái `await` sinh ra nó.
  //
  // Nên: giữ khung lại trong `pending` suốt lúc chờ, ghi mốc `snapSeq` NGAY
  // TRONG mắt xích chụp (nó thấy chính xác những gì đã ghi xong), rồi gửi bù
  // những khung `seq > snapSeq`.
  //
  // Nói thẳng về phép so ấy, vì dễ đọc nhầm thành thứ nó không phải: HÔM NAY nó
  // LUÔN đúng, và bỏ đi thì hành vi không đổi (đã thử: 48 kiểu đan xen cộng 9 ca
  // hai client gắn chồng nhau, kết quả y hệt khi xoá phép so). Lý do là kỷ luật
  // xếp hàng, không phải phép so: mọi mảng byte vào được `pending` đều có lượt
  // ghi xếp SAU mắt xích chụp, nên không mảng nào vừa nằm trong ảnh chụp vừa
  // nằm trong `pending`.
  //
  // Giữ nó lại làm cái chốt cho tương lai: chừng nào việc chụp còn được chèn
  // vào ĐÚNG hàng đợi ghi, và `pending` còn mở ra trong CÙNG một lượt đồng bộ
  // với mắt xích ấy, thì nó vô hại. Ngày ai đó tách hai điều kiện ấy ra, phép
  // so này biến hỏng thành "chữ vẽ hai lần" — thứ nhìn thấy ngay — thay vì
  // "chữ mất im lặng", thứ đã ngốn cả một vòng review để tìm ra.
  //
  // Nửa sau — ảnh chụp đi ra, gửi bù, vào tập phát — nằm trong
  // `joinBroadcast()`, một hàm KHÔNG `async`. Đó không phải chuyện chia nhỏ cho
  // gọn: nó biến "không được `await` ở đây" từ một câu dặn thành một lỗi cú
  // pháp. Đọc comment của hàm ấy trước khi động vào.
  //
  // `stillWanted()` — false nghĩa là client đã chết trong lúc chờ; đăng ký một
  // client đã chết vào tập phát là giữ nó ở đó mãi.
  // `onAttached()`  — chạy NGAY SAU khi client vào tập, cùng lượt đồng bộ (host
  //                   dùng để tính lại kích thước).
  // `onError(e)`    — một lần gắn hỏng chỉ giết đúng client ấy.
  //
  // Promise trả về KHÔNG BAO GIỜ reject: host gọi hàm này mà không ai chờ, và
  // trên Node 22 một rejection không ai bắt là chết cả tiến trình — tức là một
  // client làm chết host. Đường ném thật có sẵn: `serialize()` trong snapshot(),
  // và việc mã hoá khung ném khi vượt MAX_FRAME (16MB) — ngay trong biên
  // cols/rows mà host cho phép (1000×500), một màn hình nhiều màu serialize ra
  // đã cùng bậc độ lớn với cái trần ấy.
  async function attach(client, { stillWanted, onAttached, onError } = {}) {
    const pending = [];
    pendingAttachers.add(pending);
    let snapSeq = 0;
    let frame = null;
    try {
      const link = chain.then(() => {
        snapSeq = written;
        frame = snapshot();
      });
      // Chuỗi chung không được đứt vì một lần chụp hỏng; lỗi thuộc về riêng
      // `link` bên dưới.
      chain = link.catch(() => {});
      await link;
      if (stillWanted && !stillWanted()) return false;
      joinBroadcast(client, frame, pending, snapSeq, onAttached);
      return true;
    } catch (e) {
      if (onError) onError(e);
      return false;
    } finally {
      pendingAttachers.delete(pending);
    }
  }

  // Lượt đồng bộ khép lại việc gắn: ảnh chụp đi ra, những khung giữ lại được
  // gửi bù, client vào tập phát. Cả ba PHẢI nằm gọn trong một lượt, nếu không
  // lại mở ra đúng cái cửa sổ mất byte vừa bịt.
  //
  // HÀM NÀY KHÔNG `async`, VÀ ĐÓ LÀ TOÀN BỘ ĐIỂM CỦA NÓ. Trước đây cái ràng
  // buộc ấy là một câu comment viết hoa nằm giữa thân `attach()` — và một câu
  // comment thì không chặn được ai. Đo được: chèn `await Promise.resolve()`
  // giữa vòng gửi bù và `clients.add` làm rơi im lặng một mảng byte mà CẢ 9 bài
  // test lúc ấy vẫn xanh. Ở đây một `await` là LỖI CÚ PHÁP.
  //
  // Nên nếu bạn đang định thêm `async` vào dòng dưới: đấy chính là việc mà chỗ
  // này tồn tại để bắt bạn dừng lại. Byte đến trong khe microtask ấy sẽ không
  // được phát (client chưa vào tập) và cũng không được gửi bù (vòng lặp đã chạy
  // xong) — mất hẳn, không một tiếng động. Bài test "chunk rơi vào khe microtask
  // NGAY SAU lượt gửi bù" trong attach-queue.test.js canh đúng điều đó.
  function joinBroadcast(client, frame, pending, snapSeq, onAttached) {
    // Falsy nghĩa là chưa có gì trên màn hình; gửi một khung rỗng chỉ tổ làm
    // đầu kia xoá màn hình mà không được gì.
    if (frame) client.send(frame);
    for (const item of pending) {
      if (item.seq > snapSeq) client.send(item.frame);
    }
    clients.add(client);
    if (onAttached) onAttached();
  }

  function detach(client) {
    clients.delete(client);
  }

  return {
    clients,
    enqueue,
    feed,
    attach,
    detach,
    // Chỉ để test và chẩn đoán: một mảng giữ khung bị bỏ quên là một chỗ rò
    // trong một tiến trình sống nhiều ngày, và không có cách nào khác để thấy.
    pendingCount() { return pendingAttachers.size; },
  };
}
