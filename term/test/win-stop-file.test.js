// Cờ dừng của Windows: luật đặt tên file, luật CHỈ-Windows, và luật "thấy cờ
// thì gọi đúng một lần".
//
// Cả bộ này chạy trên MỌI nền tảng, và đó là điểm chính. `platform` là tham số
// của `theoDoiFileDung`, y như `chonNguonPane` (src/pane-source-chon.js) đã
// làm, nên cái nhánh nguy hiểm nhất — "macOS/Linux không được mọc thêm thứ
// gì" — sai được ngay trên máy macOS của bộ test, chứ không đợi tới lúc có
// một cái máy Windows.
//
// Cô lập: mọi bài dựng nhà giả bằng mkdtemp và truyền `home` tường minh. Không
// bài nào đọc `ccrcHome()`, nên không bài nào chạm được vào hồ sơ thật — kể cả
// khi ai đó chạy bộ này với CCRC_HOME chưa đặt.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duongDanFileDung, theoDoiFileDung } from '../src/win-stop-file.js';

const daDung = [];
function nhaTam() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-co-'));
  daDung.push(home);
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  return home;
}
after(() => {
  for (const d of daDung) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác thì thôi */ }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nhịp poll rất ngắn cho test: bài kiểm "thấy cờ" phải kết thúc bằng ĐIỀU KIỆN
// (vòng chờ dưới đây), không bằng một lần ngủ đoán bừa.
const NHIP_TEST_MS = 20;

async function choToi(dieuKien, hanMs = 5000) {
  const het = Date.now() + hanMs;
  while (Date.now() < het) {
    if (dieuKien()) return true;
    await sleep(10);
  }
  return false;
}

// --- tên file ---------------------------------------------------------------

test('cờ dừng nằm cạnh file pid, cùng một quy ước tên', () => {
  const home = nhaTam();
  assert.equal(
    duongDanFileDung('phien-x', home),
    path.join(home, '.ccrc', 'term-pane-phien-x.stop'),
  );
});

test('id không an toàn thì KHÔNG có đường dẫn — từ chối, không ghép bừa', () => {
  const home = nhaTam();
  // Dấu gạch chéo, `..`, chuỗi rỗng: mỗi cái đều ghép được thành một đường dẫn
  // nằm ngoài `.ccrc` nếu cứ nối chuỗi. Trả `null` là "không biết", và người
  // gọi rơi về đúng hành vi cũ (TerminateProcess), không phải ghi bừa một file
  // ở chỗ khác.
  assert.equal(duongDanFileDung('a/b', home), null);
  assert.equal(duongDanFileDung('..', home), null);
  assert.equal(duongDanFileDung('a\\b', home), null);
  assert.equal(duongDanFileDung('', home), null);
  assert.equal(duongDanFileDung('phien-x', ''), null);
});

// --- luật CHỈ-Windows -------------------------------------------------------

test('trên macOS/Linux không dựng người theo dõi nào', async () => {
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'darwin', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  assert.equal(td, null, 'đã dựng người theo dõi trên một nền tảng không phải Windows');
  // Và cờ có được ghi ra thì cũng không ai đọc: đường SIGTERM của macOS phải
  // nguyên vẹn, không mọc thêm một đường dừng thứ hai.
  fs.writeFileSync(path.join(home, '.ccrc', 'term-pane-phien-x.stop'), '1');
  await sleep(NHIP_TEST_MS * 5);
  assert.equal(goi, 0);
});

// --- thấy cờ thì dừng -------------------------------------------------------

test('ghi cờ thì gọi khiThay, đúng một lần', async () => {
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  assert.ok(td, 'không dựng được người theo dõi trên nhánh Windows');
  try {
    assert.equal(goi, 0, 'gọi khi chưa có cờ nào');
    fs.writeFileSync(td.file, '1');
    assert.ok(await choToi(() => goi > 0), 'ghi cờ rồi mà không ai thấy');
    // Cờ vẫn nằm đó (người gọi mới là bên dọn), nhưng không được gọi thêm lần
    // nữa: `shutdown()` có chốt riêng, nhưng một người theo dõi bắn lặp là thứ
    // sẽ lộ ra ở chỗ khác, muộn hơn và khó lần hơn.
    await sleep(NHIP_TEST_MS * 5);
    assert.equal(goi, 1);
  } finally {
    td.dung();
  }
});

test('cờ cũ còn sót lại từ lượt trước bị dọn, và KHÔNG làm daemon mới tự tắt', async () => {
  const home = nhaTam();
  const cu = path.join(home, '.ccrc', 'term-pane-phien-x.stop');
  // Đúng cái xảy ra thật: một lượt `off` ghi cờ rồi daemon chết bằng lưới cuối
  // trước khi kịp dọn — hoặc máy mất điện. Lượt `on` sau đó dựng daemon mới,
  // và nếu cờ cũ vẫn nằm đấy thì daemon mới tự tắt ngay giây đầu tiên.
  fs.writeFileSync(cu, '1');
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  try {
    assert.equal(fs.existsSync(cu), false, 'cờ cũ không bị dọn lúc dựng');
    await sleep(NHIP_TEST_MS * 5);
    assert.equal(goi, 0, 'cờ cũ làm daemon mới tự tắt');
    // Và người theo dõi vẫn còn làm việc sau khi dọn cờ cũ.
    fs.writeFileSync(cu, '1');
    assert.ok(await choToi(() => goi > 0), 'dọn cờ cũ xong thì thôi không theo dõi nữa');
  } finally {
    td.dung();
  }
});

test('id không an toàn thì không dựng người theo dõi', () => {
  const home = nhaTam();
  assert.equal(theoDoiFileDung({
    paneId: 'a/b', home, platform: 'win32', khiThay: () => {},
  }), null);
});

test('tắt tường minh thì không dựng người theo dõi', async () => {
  // Cái van này tồn tại để bộ test CHỨNG MINH được lưới cuối (TerminateProcess)
  // vẫn còn: không có nó thì không có cách nào dựng một daemon "điếc" mà vẫn là
  // daemon thật để `off` phải rơi về lưới cuối.
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, tat: true, khiThay: () => { goi += 1; },
  });
  assert.equal(td, null);
  fs.writeFileSync(path.join(home, '.ccrc', 'term-pane-phien-x.stop'), '1');
  await sleep(NHIP_TEST_MS * 5);
  assert.equal(goi, 0);
});

test('dung() gỡ hẳn: ghi cờ sau đó không gọi ai nữa', async () => {
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  td.dung();
  fs.writeFileSync(td.file, '1');
  await sleep(NHIP_TEST_MS * 5);
  assert.equal(goi, 0);
});

test('thiếu thư mục .ccrc thì vẫn theo dõi được (poll gánh phần fs.watch không làm nổi)', async () => {
  // `fs.watch` cần thư mục có thật; nếu nó ném thì cả cơ chế không được phép
  // chết theo. Vòng poll là lưới đỡ, và đây là bài đo nó.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-co-'));
  daDung.push(home); // KHÔNG mkdir .ccrc
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  assert.ok(td);
  try {
    fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
    fs.writeFileSync(td.file, '1');
    assert.ok(await choToi(() => goi > 0), 'poll không gánh được khi fs.watch hỏng');
  } finally {
    td.dung();
  }
});

test('thư mục biến mất thì ĐÓNG watcher, và vòng poll vẫn gánh tiếp', async () => {
  // Đo được trên máy Windows thật: xoá `~/.ccrc` khi đang theo dõi thì
  // `fs.watch` bắn khoảng 166.000 sự kiện `rename` mỗi giây và không bao giờ
  // dứt — `cpu_ms 2000 / elapsed_ms 2299`, gần trọn một lõi, vĩnh viễn, trong
  // một tiến trình sống nhiều ngày. Tính đúng đắn không việc gì (poll vẫn thấy
  // cờ), nên cái phải canh ở đây là watcher CÓ ĐÓNG hay không — và đó là thứ
  // duy nhất `dangXem()` tồn tại để đo.
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => { goi += 1; },
  });
  try {
    assert.equal(td.dangXem(), true, 'chưa dựng được watcher — bài này không đo được gì cả');
    fs.rmSync(path.join(home, '.ccrc'), { recursive: true, force: true });
    assert.ok(await choToi(() => td.dangXem() === false),
      'thư mục biến mất mà watcher vẫn mở — đó chính là cơn bão đốt một lõi CPU');
    // Và bỏ watcher đi KHÔNG được phép làm mất khả năng dừng daemon: poll gánh.
    fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
    fs.writeFileSync(td.file, '1');
    assert.ok(await choToi(() => goi > 0), 'đóng watcher xong thì không ai thấy cờ nữa');
  } finally {
    td.dung();
  }
});

test('bão sự kiện thì ĐÓNG watcher, kể cả khi thư mục vẫn còn nguyên', async () => {
  // Bài này canh đúng chỗ vòng trước bỏ lọt. Phép kiểm cũ hỏi "thư mục còn
  // không?" — gián tiếp — nên ca hay xảy ra nhất lọt lưới: xoá `.ccrc` rồi dựng
  // lại ngay. Thư mục có mặt ở mọi lần hỏi, watcher không bao giờ đóng, một lõi
  // CPU cháy mãi. Đo trên máy Windows thật, 2 giây: 1985ms CPU.
  //
  // Nên ở đây thư mục KHÔNG bị xoá lần nào — chỉ có sự kiện, thật nhiều. Bản có
  // phép kiểm thư mục mà không có bộ đếm sẽ giữ watcher mở và bài này đỏ.
  const home = nhaTam();
  let goi = 0;
  const td = theoDoiFileDung({
    paneId: 'phien-x',
    home,
    platform: 'win32',
    nhipMs: NHIP_TEST_MS,
    // Ngưỡng nhỏ để dựng "bão" bằng vài chục sự kiện thay vì hàng trăm nghìn.
    nguongSuKien: 5,
    khiThay: () => { goi += 1; },
  });
  try {
    assert.equal(td.dangXem(), true, 'chưa dựng được watcher — bài này không đo được gì cả');
    // 60 file KHÁC NHAU, không phải ghi/xoá đi ghi/xoá lại MỘT file.
    //
    // Đo được, và nó là lý do bản đầu của bài này ĐỎ trên Windows: churn một
    // file bị hệ điều hành gộp lại còn 2 sự kiện ở đó (macOS thì cho 61). Cùng
    // một vòng lặp, hai nền tảng trả lời khác hẳn nhau. 60 file khác nhau thì cả
    // hai đều bắn thật: macOS 61, Windows 120 — đều vượt ngưỡng 5 đặt ở trên.
    for (let i = 0; i < 60; i += 1) {
      fs.writeFileSync(path.join(home, '.ccrc', `on-ao-${i}`), 'x');
    }
    assert.ok(await choToi(() => td.dangXem() === false),
      'sự kiện bắn liên hồi mà watcher vẫn mở — đó chính là cơn bão đốt một lõi CPU');
    assert.equal(fs.existsSync(path.join(home, '.ccrc')), true,
      'bài test tự xoá mất thư mục — thế thì nó đang đo phép kiểm cũ, không phải bộ đếm');
    // Và bỏ watcher đi KHÔNG được phép làm mất khả năng dừng daemon: poll gánh.
    fs.writeFileSync(td.file, '1');
    assert.ok(await choToi(() => goi > 0), 'đóng watcher xong thì không ai thấy cờ nữa');
  } finally {
    td.dung();
  }
});

test('yên ắng thì KHÔNG đóng nhầm watcher', async () => {
  // Mặt còn lại của bộ đếm: một `~/.ccrc` bình thường (nhịp tim ghi
  // `sessions/*.json` mỗi 20 giây) không được phép bị coi là bão.
  const home = nhaTam();
  const td = theoDoiFileDung({
    paneId: 'phien-x', home, platform: 'win32', nhipMs: NHIP_TEST_MS, khiThay: () => {},
  });
  try {
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(path.join(home, '.ccrc', `yen-ang-${i}`), 'x');
      await sleep(NHIP_TEST_MS);
    }
    assert.equal(td.dangXem(), true, 'đóng nhầm watcher trong một thư mục yên ắng');
  } finally {
    td.dung();
  }
});
