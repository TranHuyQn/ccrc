// Một quy tắc duy nhất, viết dưới dạng test chứ không dưới dạng lời hứa:
//
//   `os.homedir()` chỉ được gọi ở shared/home.js. Mọi nơi khác hỏi `ccrcHome()`.
//
// Vì sao phải là một hàng rào. Cùng một lỗi đã nổi lên BA lần trong đúng một
// phiên làm việc:
//   1. bộ test hook ghi thẳng vào `~/.claude/settings.json` THẬT của người dùng
//      và tạo `~/.ccrc/notify`, vì mọi bài tưởng mình đang ở trong hộp cát;
//   2. `cmdOffAll` quét `os.homedir()` trong khi file pid được ghi theo
//      `ccrcHome()` — vô hại cho tới lúc phép nhận diện daemon trên Windows
//      được sửa, rồi thành "đọc file pid THẬT rồi SIGTERM phiên thật";
//   3. `devices.js` / `pending-pair.js` ghi và xoá dữ liệu ghép cặp THẬT dưới
//      một HOME chỉ cô lập một nửa.
//
// Cả ba lần quy tắc đều đã được viết ra bằng chữ, trong comment, trong báo cáo
// — và cả ba lần nó vẫn lọt qua. Vá từng chỗ gọi thì cái bẫy vẫn nằm đó cho
// người gọi tiếp theo. Chỉ có dạng ĐỎ ĐƯỢC mới giữ nổi.
//
// Lý do gốc vì sao `os.homedir()` không cô lập được: trên Windows nó đọc
// USERPROFILE, không đọc HOME, nên đặt HOME cho tiến trình con là vô nghĩa ở
// đó. Xem shared/home.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devicesPath } from '../src/devices.js';
import { pendingPairPath } from '../src/pending-pair.js';
import { readConfig } from '../src/config.js';
import { registryDir } from '../../shared/session-registry.js';

const GOC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(GOC, '..', '..');

const daDung = [];
function nhaTam() {
  // Tiền tố riêng, KHÔNG dùng chung `ccrc-home-`: bốn chỗ gọi trong BA file test
  // có sẵn — hook/test/notify-cli.test.js:13, hook/test/ccrc-notify.test.js:14,
  // và server/test/shell-scripts.test.js ở cả :1300 lẫn :1328 — cũng dựng thư
  // mục tạm với đúng tiền tố ấy và không dọn cái nào; 2945 cái đã đọng lại trên
  // máy này. Trùng tiền tố nghĩa là không đo được phần dọn của CHÍNH bài này
  // còn chạy hay không.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fence-'));
  daDung.push(d);
  return d;
}

// Đặt/gỡ CCRC_HOME quanh một lượt đo. Các bài trong CÙNG một file chạy tuần tự
// nên không giẫm lên nhau; mỗi file test là một tiến trình riêng nên cũng không
// rò sang file khác.
function voiCcrcHome(gia, viec) {
  const cu = process.env.CCRC_HOME;
  if (gia === undefined) delete process.env.CCRC_HOME;
  else process.env.CCRC_HOME = gia;
  try {
    return viec();
  } finally {
    if (cu === undefined) delete process.env.CCRC_HOME;
    else process.env.CCRC_HOME = cu;
  }
}

test.after(() => {
  for (const d of daDung) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* rác là rác */ }
  }
});

// --- CCRC_HOME phải lái được đường mặc định --------------------------------

test('CCRC_HOME lái đường mặc định của cả bốn nơi cất dữ liệu', () => {
  const nha = nhaTam();
  voiCcrcHome(nha, () => {
    assert.equal(devicesPath(), path.join(nha, '.ccrc', 'devices.json'));
    assert.equal(pendingPairPath(), path.join(nha, '.ccrc', 'pairing-pending.json'));
    assert.equal(registryDir(), path.join(nha, '.ccrc', 'sessions'));
  });
});

test('readConfig() không tham số đọc cấu hình dưới CCRC_HOME', () => {
  const nha = nhaTam();
  fs.mkdirSync(path.join(nha, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(nha, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://vi-du\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  voiCcrcHome(nha, () => {
    assert.deepEqual(readConfig(), { hubUrl: 'http://vi-du', token: 't', machine: 'm' });
  });
});

// Nhánh phòng thủ riêng của devices.js/pending-pair.js: `home` khác null nhưng
// không phải chuỗi thì bỏ qua nó và về mặc định. Nhánh ấy cũng phải về
// ccrcHome(), không về os.homedir() — nó là đúng cái đường mà một lời gọi sai
// kiểu sẽ đi qua.
test('home sai kiểu vẫn rơi về CCRC_HOME, không rơi về thư mục nhà thật', () => {
  const nha = nhaTam();
  voiCcrcHome(nha, () => {
    assert.equal(devicesPath(123), path.join(nha, '.ccrc', 'devices.json'));
    assert.equal(pendingPairPath({}), path.join(nha, '.ccrc', 'pairing-pending.json'));
  });
});

// --- tham số tường minh phải LUÔN thắng ------------------------------------

test('home truyền tường minh thắng CCRC_HOME', () => {
  const nha = nhaTam();
  const noiKhac = nhaTam();
  voiCcrcHome(nha, () => {
    assert.equal(devicesPath(noiKhac), path.join(noiKhac, '.ccrc', 'devices.json'));
    assert.equal(pendingPairPath(noiKhac), path.join(noiKhac, '.ccrc', 'pairing-pending.json'));
    assert.equal(registryDir(noiKhac), path.join(noiKhac, '.ccrc', 'sessions'));
  });
});

test('readConfig(home) tường minh thắng CCRC_HOME', () => {
  const nha = nhaTam();     // có cấu hình
  const noiKhac = nhaTam(); // KHÔNG có cấu hình
  fs.mkdirSync(path.join(nha, '.ccrc'), { recursive: true });
  fs.writeFileSync(path.join(nha, '.ccrc', 'config'),
    'CCRC_HUB_URL=http://vi-du\nCCRC_TOKEN=t\nCCRC_MACHINE_NAME=m\n');
  voiCcrcHome(nha, () => {
    // Đảo chiều ưu tiên (mặc định thắng tham số) sẽ trả về cấu hình của `nha`
    // thay vì null — nên bài này đỏ đúng lúc thứ tự bị lộn.
    assert.equal(readConfig(noiKhac), null);
  });
});

// --- và lời hứa "macOS/Linux không đổi hành vi", ĐO chứ không tin ----------

test('CCRC_HOME không đặt / bỏ trống thì mặc định đúng bằng os.homedir()', () => {
  for (const gia of [undefined, '', '   ']) {
    voiCcrcHome(gia, () => {
      assert.equal(devicesPath(), path.join(os.homedir(), '.ccrc', 'devices.json'));
      assert.equal(pendingPairPath(), path.join(os.homedir(), '.ccrc', 'pairing-pending.json'));
      assert.equal(registryDir(), path.join(os.homedir(), '.ccrc', 'sessions'));
    });
  }
});

// --- HÀNG RÀO --------------------------------------------------------------

// Lột comment trước khi soi, cùng mẹo với pane-source-boundary.test.js: mấy
// comment giải thích VÌ SAO không được gọi os.homedir() đều phải nhắc tên nó,
// và một hàng rào bắt luôn cả những comment ấy là một hàng rào không bao giờ
// xanh được trừ khi xoá đúng phần lời giải thích cần giữ nhất.
function chiCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Nơi DUY NHẤT được phép đọc thư mục nhà thật. Danh sách này không được nới ra
// để một bài test xanh lại — mỗi ngoại lệ mới là một chỗ nữa mà bộ test không
// cô lập được, tức là một chỗ nữa có thể ghi vào hồ sơ thật của người dùng.
const DUOC_PHEP = new Set([path.join('shared', 'home.js')]);

// `.mjs` và `.cjs` cũng bị soi, không chỉ `.js`. Bỏ `.mjs` ra ngoài là miễn trừ
// đúng `hook/bin/install-hook.mjs` — CHÍNH LÀ file đã ghi vào
// `~/.claude/settings.json` thật của người dùng trong sự cố sinh ra hàng rào
// này. Một hàng rào không phủ được hiện trường vụ án thì không phải hàng rào.
const DUOI = ['.js', '.mjs', '.cjs'];

// `hook/src` có mặt vì cùng lý do: một thư mục không được liệt kê là một thư
// mục được miễn trừ, và không ai nhận ra điều đó cho tới lúc có file mới ở đó.
const VUNG = [
  path.join('term', 'src'),
  path.join('term', 'bin'),
  'shared',
  path.join('hook', 'bin'),
  path.join('hook', 'src'),
];

function moiFileJs(thuMuc) {
  const goc = path.join(REPO, thuMuc);
  let ten;
  try {
    ten = fs.readdirSync(goc, { withFileTypes: true });
  } catch {
    return [];
  }
  return ten
    .filter((e) => e.isFile() && DUOI.some((d) => e.name.endsWith(d)))
    .map((e) => path.join(thuMuc, e.name));
}

function biSoi() {
  return VUNG.flatMap(moiFileJs).filter((f) => !DUOC_PHEP.has(f));
}

const doc = (f) => chiCode(fs.readFileSync(path.join(REPO, f), 'utf8'));

// Sàn phải là TỪNG THƯ MỤC, không phải tổng.
//
// `term/src` một mình đã 28 file, nên một cái sàn tính trên tổng vẫn qua được
// dù `shared`, `term/bin`, `hook/bin`, `hook/src` cùng trả rỗng — tức là hàng
// rào soi đúng một thư mục và báo xanh. Mà "trả rỗng" chính là ca hỏng cái sàn
// sinh ra để bắt: đường dẫn sai, thư mục bị đổi tên, `readdirSync` ném và bị
// nuốt ở trên.
test('mọi thư mục trong vùng soi đều thật sự có file để soi', () => {
  const rong = VUNG.filter((v) => moiFileJs(v).length === 0);
  assert.deepEqual(rong, [], `Vùng soi này không thấy file nào — đường dẫn hỏng? ${rong.join(', ')}`);
});

// Bắt theo ĐỊNH DANH `homedir`, không theo chuỗi `os.homedir(`.
//
// Đã chứng minh bằng cách chạy thật: chuỗi `os.homedir(` bỏ lọt cả
// `import { homedir } from "node:os"` (nháy đôi) lẫn
// `import * as os2 from 'node:os'` rồi `os2.homedir()`. Cả hai đều là cùng một
// lời gọi, chỉ khác cách đánh vần, và một hàng rào thua ở khâu đánh vần thì chỉ
// canh được người không định vượt qua nó. Định danh thì chỉ có một cách viết.
test('không file nào ngoài shared/home.js đọc thư mục nhà của hệ điều hành', () => {
  const viPham = biSoi().filter((f) => /\bhomedir\b/.test(doc(f)));
  assert.deepEqual(viPham, [],
    'Những file này đọc homedir của hệ điều hành. Dùng ccrcHome() từ shared/home.js:\n'
    + viPham.map((f) => `  ${f}`).join('\n'));
});

// Và đường vòng không đi qua `node:os` chút nào.
//
// `process.env.USERPROFILE || process.env.HOME` cho ra ĐÚNG cái thư mục nhà
// thật mà hai bài trên chặn, chỉ là viết bằng tay. Đây không phải mối lo giả
// định: nó là đúng thứ một người đang "sửa lỗi đường dẫn trên Windows" sẽ với
// tay lấy, vì USERPROFILE chính là biến Windows dùng.
//
// Luật này canh BỐN biến — USERPROFILE, HOMEDRIVE, HOMEPATH, HOME — và cả hai
// cách viết, chấm lẫn ngoặc vuông. Xem `BIEN_NHA` ngay dưới.
//
// Hôm nay không file nào trong vùng soi chạm vào bốn biến ấy (mọi lần xuất hiện
// đều nằm trong comment, và comment đã bị lột trước khi soi), nên bài này canh
// một bất biến đang sạch chứ không vá một chỗ đang hỏng.
// HOMEDRIVE + HOMEPATH, và cách viết bằng ngoặc vuông, cũng phải bị bắt.
//
// `process.env.HOMEDRIVE + process.env.HOMEPATH` là cách chính thống THỨ HAI để
// dựng thư mục nhà trên Windows — cùng kết quả, cùng hậu quả, chỉ khác hai cái
// tên biến. Và `process.env['USERPROFILE']` là đúng lời đọc ấy viết bằng ngoặc
// vuông. Một luật chỉ nêu tên một nửa số biến và một nửa số cú pháp thì chỉ canh
// được người không định vượt qua nó — đúng bài học của lượt trước, khi chuỗi
// `os.homedir(` bỏ lọt bốn cách đánh vần.
const BIEN_NHA = 'USERPROFILE|HOMEDRIVE|HOMEPATH|HOME';
const DOC_BIEN_NHA = new RegExp(
  'process\\.env\\s*(?:\\.\\s*(?:' + BIEN_NHA + ')\\b'
  + '|\\[\\s*[\'"`](?:' + BIEN_NHA + ')[\'"`]\\s*\\])');

test('không file nào tự dựng thư mục nhà từ USERPROFILE/HOMEDRIVE/HOMEPATH/HOME', () => {
  const viPham = biSoi().filter((f) => DOC_BIEN_NHA.test(doc(f)));
  assert.deepEqual(viPham, [],
    'Những file này tự đọc USERPROFILE/HOMEDRIVE/HOMEPATH/HOME. Dùng ccrcHome()\n'
    + 'từ shared/home.js:\n'
    + viPham.map((f) => `  ${f}`).join('\n'));
});

// Và lỗ cuối: gọi `ccrcHome` KÈM THAM SỐ.
//
// `ccrcHome({})` đọc `{}.CCRC_HOME` → undefined → rơi thẳng về `os.homedir()`.
// Nó không sai theo hợp đồng của hàm — tham số `env` nghĩa là "đọc trong cái
// môi trường này", và một môi trường không có CCRC_HOME thật sự là "chưa đặt".
// Nên hợp đồng ở lại nguyên vẹn: đổi nó thành ném hay trả rỗng sẽ phá luôn
// `ccrcHome(process.env)`, một cách gọi hoàn toàn hợp lệ.
//
// Cái bịt được là TẦNG GỌI. Tham số ấy tồn tại để chính `shared/home.js` và bộ
// test của nó dùng; mọi người gọi trong sản phẩm phải gọi `ccrcHome()` trần,
// vì chỉ bản trần mới đọc môi trường THẬT của tiến trình — tức là mới nghe lời
// CCRC_HOME mà bộ test đặt. Truyền vào một object tự chế là lặng lẽ quay về
// đúng thư mục nhà thật mà cả hàng rào này sinh ra để chặn.
//
// Hôm nay luật này bắt 0 file: nó canh một bất biến đang sạch.
test('không file nào gọi ccrcHome kèm tham số', () => {
  const viPham = biSoi().filter((f) => /\bccrcHome\(\s*[^)\s]/.test(doc(f)));
  assert.deepEqual(viPham, [],
    'Những file này gọi ccrcHome() kèm tham số — chỉ `ccrcHome()` trần mới đọc\n'
    + 'môi trường thật của tiến trình, nên chỉ nó mới cô lập được:\n'
    + viPham.map((f) => `  ${f}`).join('\n'));
});
