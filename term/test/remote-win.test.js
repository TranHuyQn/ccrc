// `/remote on` và `/remote off` trên Windows.
//
// Bộ này có HAI tầng, và sự tách đôi ấy là cố ý:
//
//  • Tầng thuần (chạy trên MỌI nền tảng): luật nhận diện "pid này có phải
//    daemon của ta không" nằm trong src/win-daemon-id.js, không gọi hệ điều
//    hành, nên nó sai được ngay trên máy macOS của bộ test. Đây là phần dễ sai
//    nhất của cả task — nó quyết định một tiến trình sống hay chết — nên nó
//    phải là phần được canh chặt nhất, chứ không phải phần chỉ đo được trên
//    đúng một cái máy.
//
//  • Tầng chạy thật (CHỈ Windows): gọi thẳng CLI. Không giả lập được
//    `process.platform` trong một tiến trình con, và cũng không nên: nhánh
//    Windows đọc sổ host thật, spawn daemon thật.
//
// Cô lập: MỌI test ở đây đặt CCRC_HOME vào thư mục tạm. Đặt HOME là vô dụng
// trên Windows (os.homedir() đọc USERPROFILE) — đã có một lần bộ test ghi thẳng
// vào ~/.claude/settings.json thật của người dùng vì tưởng mình ở trong hộp
// cát. Xem shared/home.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tachArgvWindows, laNodeWindows, laDaemonWindows } from '../src/win-daemon-id.js';
import { writeHost } from '../src/host-registry.js';

const CHI_WINDOWS = process.platform !== 'win32';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const CLI = path.join(BIN, 'ccrc-term-cli.js');
const DAEMON = path.join(BIN, 'ccrc-term.js');

// Mọi nhà giả đã dựng trong lượt chạy này, dọn ở `after` bên dưới.
//
// Vì sao phải có: `mkdtempSync` không tự dọn, và bộ này dựng 10 thư mục mỗi
// lượt. Đo được trên máy Windows thử: 110 thư mục `ccrc-win-*` đã tích lại
// trong %TEMP%. Rác tạm thì vô hại, nhưng một bộ test bẩn hơn sau mỗi lần chạy
// là thứ không ai nhận ra cho tới lúc nó đã to.
const daDung = [];

function nhaTam(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-win-'));
  daDung.push(home);
  fs.mkdirSync(path.join(home, '.ccrc'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(home, '.ccrc', 'config'), cfg);
  return home;
}

// Dọn KHÔNG được ném: một thư mục còn bị giữ (trên Windows chuyện thường, một
// tiến trình vừa chết vẫn giữ handle thêm một nhịp) không được phép làm cả lượt
// chạy đỏ. Rác còn lại là rác, không phải hỏng.
after(() => {
  for (const d of daDung) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* để lại thì thôi */ }
  }
});

const CONFIG_GIA = 'CCRC_HUB_URL=http://127.0.0.1:1\nCCRC_TOKEN=x\nCCRC_MACHINE_NAME=may-thu\n';

// Một pid CHẮC CHẮN đã chết: dựng một tiến trình, đợi nó thoát, rồi trả lại số
// pid cũ của nó.
function pidDaChet() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = p.pid;
    p.on('exit', () => resolve(pid));
  });
}

// Cùng luật với host-registry.js: chỉ ESRCH mới là bằng chứng đã chết.
function conSong(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function chay(args, env = {}) {
  return new Promise((r) => execFile(process.execPath, [CLI, ...args],
    { env: { ...process.env, ...env } },
    (err, stdout, stderr) => r({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

// --- Tầng thuần: cô lập bằng CCRC_HOME -------------------------------------

test('CLI đọc cấu hình theo CCRC_HOME, không theo thư mục nhà thật', async () => {
  const home = nhaTam(CONFIG_GIA);
  const rong = nhaTam(null); // có .ccrc nhưng KHÔNG có config
  // HOME trỏ một nhà rỗng: nếu CLI vẫn đi qua os.homedir()/HOME thì nó chết ở
  // dòng "Chưa cấu hình" ngay lúc nạp module, trước cả khi chạm tới lệnh.
  const r = await chay(['off'], { CCRC_HOME: home, HOME: rong, TMUX_PANE: '', CCRC_HOST_SESSION_ID: '' });
  assert.ok(!/Chưa cấu hình/.test(r.stdout), `vẫn đọc nhầm nhà: ${r.stdout}`);
});

// `off-all` KHÔNG nằm trong phạm vi task này, nhưng nó dùng chung `daemonInfo`
// với `off`, và `daemonInfo` giờ nhận diện được daemon trên Windows. Trước bản
// này đường ấy tê liệt (mọi pid đều "không phải của ta"), nên chuyện nó quét
// nhầm thư mục là vô hại. Giờ thì không: một bài test đặt CCRC_HOME rồi gọi
// `off-all` sẽ đọc file pid THẬT của người dùng và SIGTERM phiên remote đang
// chạy của họ. Bài này canh đúng cái đó — hai chỗ phải cùng nhìn một nhà.
test('off-all quét file pid theo CCRC_HOME, không theo thư mục nhà thật', async () => {
  const home = nhaTam(CONFIG_GIA);
  const nhaThat = nhaTam(null); // đóng vai nhà thật: có .ccrc nhưng không có gì
  const chet = await pidDaChet();
  const f = path.join(home, '.ccrc', 'term-pane-phien-x.pid');
  fs.writeFileSync(f, JSON.stringify({ pid: chet, sessionId: 'abc' }));
  const r = await chay(['off-all'],
    { CCRC_HOME: home, HOME: nhaThat, TMUX_PANE: '', CCRC_HOST_SESSION_ID: '' });
  assert.equal(r.code, 0);
  // File pid trỏ một pid đã chết: `daemonInfo` phải thấy nó, phán là rác, và
  // xoá. Nó chỉ thấy được nếu `off-all` quét ĐÚNG nhà mà CCRC_HOME chỉ ra.
  assert.equal(fs.existsSync(f), false,
    'off-all không quét CCRC_HOME — nghĩa là nó đang quét thư mục nhà thật');
});

// Và mặt còn lại của cùng lời hứa, đo chứ không tin: CCRC_HOME không đặt thì
// `ccrcHome()` phải trả đúng `os.homedir()`, nên `off-all` quét y hệt chỗ nó
// vẫn quét trước bản này. Chỉ chạy trên macOS/Linux — lời hứa "không đổi hành
// vi" là lời hứa với hai nền tảng ấy, và cũng chỉ ở đó HOME mới lái được
// os.homedir().
test('CCRC_HOME bỏ trống thì off-all quét đúng thư mục nhà như trước',
  { skip: process.platform === 'win32' }, async () => {
    const home = nhaTam(CONFIG_GIA);
    const chet = await pidDaChet();
    const f = path.join(home, '.ccrc', 'term-pane-phien-y.pid');
    fs.writeFileSync(f, JSON.stringify({ pid: chet, sessionId: 'abc' }));
    const r = await chay(['off-all'],
      { CCRC_HOME: '', HOME: home, TMUX_PANE: '', CCRC_HOST_SESSION_ID: '' });
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(f), false, 'off-all không còn quét thư mục nhà nữa');
  });

// --- Tầng thuần: tách dòng lệnh Windows -------------------------------------

test('argv[0] trong nháy giữ nguyên backslash của đường dẫn Windows', () => {
  const argv = tachArgvWindows('"C:\\Program Files\\nodejs\\node.exe" "C:\\src\\ccrc-term.js"');
  assert.deepEqual(argv, ['C:\\Program Files\\nodejs\\node.exe', 'C:\\src\\ccrc-term.js']);
  // Và backslash NGAY TRƯỚC dấu nháy đóng vẫn chỉ là backslash: luật escape
  // của argv[1..] không áp cho argv[0]. Đem nhầm luật kia sang đây thì `\"` bị
  // đọc là một dấu nháy nguyên văn, đường dẫn nuốt luôn tham số phía sau, và
  // cả dòng lệnh gộp thành MỘT phần tử.
  assert.deepEqual(tachArgvWindows('"C:\\Program Files\\nodejs\\" x'),
    ['C:\\Program Files\\nodejs\\', 'x']);
});

test('argv[0] không nháy kết thúc ở khoảng trắng đầu tiên', () => {
  assert.deepEqual(tachArgvWindows('node.exe C:\\src\\a.js'), ['node.exe', 'C:\\src\\a.js']);
});

test('argv[1..] theo luật CommandLineToArgvW: backslash trước dấu nháy', () => {
  // 2n backslash rồi `"` → n backslash, và dấu nháy ĐÓNG chứ không nguyên văn.
  assert.deepEqual(tachArgvWindows('n.exe "a\\\\" c'), ['n.exe', 'a\\', 'c']);
  // Backslash KHÔNG đứng trước `"` thì là chính nó, không nhân không chia.
  assert.deepEqual(tachArgvWindows('n.exe "a\\\\b" c'), ['n.exe', 'a\\\\b', 'c']);
  // 2n+1 backslash rồi `"` → n backslash rồi một dấu nháy NGUYÊN VĂN.
  assert.deepEqual(tachArgvWindows('n.exe a\\"b'), ['n.exe', 'a"b']);
});

test('khoảng trắng trong nháy không cắt tham số', () => {
  assert.deepEqual(tachArgvWindows('n.exe "C:\\Program Files\\x.js"'),
    ['n.exe', 'C:\\Program Files\\x.js']);
});

test('dòng lệnh rỗng cho argv rỗng, không ném', () => {
  assert.deepEqual(tachArgvWindows(''), []);
  assert.deepEqual(tachArgvWindows(undefined), []);
});

// --- Tầng thuần: ảnh có phải node không -------------------------------------

test('nhận node.exe bất kể hoa thường, từ chối thứ khác', () => {
  assert.equal(laNodeWindows('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(laNodeWindows('C:\\x\\NODE.EXE'), true);
  assert.equal(laNodeWindows('C:\\x\\node22.exe'), true);
  assert.equal(laNodeWindows('C:\\Windows\\System32\\notepad.exe'), false);
  assert.equal(laNodeWindows('C:\\Windows\\System32\\more.com'), false);
  assert.equal(laNodeWindows(''), false);
});

// --- Tầng thuần: luật nhận diện daemon --------------------------------------

const D = 'C:\\Users\\dev\\ccrc\\term\\bin\\ccrc-term.js';

test('dòng lệnh thật của cmdOn được nhận là daemon của ta', () => {
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    commandLine: `"C:\\Program Files\\nodejs\\node.exe" "${D}"`,
    daemonPath: D,
  }), true);
});

test('so đường dẫn không phân biệt hoa thường và dấu gạch thừa', () => {
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\nodejs\\node.exe',
    commandLine: '"C:\\nodejs\\node.exe" "c:\\users\\dev\\ccrc\\term\\\\bin\\ccrc-term.js"',
    daemonPath: D,
  }), true);
});

test('node --eval=<code> <đường dẫn daemon> KHÔNG phải daemon của ta', () => {
  // Bẫy vòng 4 bên macOS, viết lại cho Windows: đường dẫn nằm sau một cờ chạy
  // inline thì nó là dữ liệu, không phải script được chạy.
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\nodejs\\node.exe',
    commandLine: `"C:\\nodejs\\node.exe" --eval=setTimeout(function(){},9e5) "${D}"`,
    daemonPath: D,
  }), false);
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\nodejs\\node.exe',
    commandLine: `"C:\\nodejs\\node.exe" -e setTimeout "${D}"`,
    daemonPath: D,
  }), false);
});

test('một chương trình KHÁC đang giữ đường dẫn daemon không phải daemon của ta', () => {
  // `more.com <đường dẫn>` chỉ ĐỌC file — như editor, findstr, copy. Không có
  // luật "argv[0] phải là node" thì mọi thứ như thế đều bị nhận nhầm.
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\Windows\\System32\\more.com',
    commandLine: `more.com "${D}"`,
    daemonPath: D,
  }), false);
});

test('daemon nằm ở vị trí argv của MỘT SCRIPT KHÁC thì không phải của ta', () => {
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\nodejs\\node.exe',
    commandLine: `"C:\\nodejs\\node.exe" "C:\\x\\lint.js" "${D}"`,
    daemonPath: D,
  }), false);
});

test('cờ vô hại trước script không làm mất nhận diện', () => {
  assert.equal(laDaemonWindows({
    executablePath: 'C:\\nodejs\\node.exe',
    commandLine: `"C:\\nodejs\\node.exe" --enable-source-maps "${D}"`,
    daemonPath: D,
  }), true);
});

test('WMI không khai gì thì không phải của ta — không đoán', () => {
  assert.equal(laDaemonWindows({ executablePath: '', commandLine: '', daemonPath: D }), false);
  assert.equal(laDaemonWindows({ commandLine: `"C:\\nodejs\\node.exe"`, daemonPath: D }), false);
  assert.equal(laDaemonWindows({ commandLine: `"C:\\nodejs\\node.exe" "${D}"`, daemonPath: '' }), false);
});

test('ExecutablePath vắng thì rơi về argv[0]', () => {
  assert.equal(laDaemonWindows({
    commandLine: `"C:\\nodejs\\node.exe" "${D}"`,
    daemonPath: D,
  }), true);
});

// --- Tầng chạy thật: CHỈ Windows -------------------------------------------

// Ba bài dưới đây đều phải khẳng định NÓ DỪNG LẠI Ở ĐÂU, chứ không chỉ "thoát
// khác 0". Đo được: bỏ hẳn phép kiểm sổ host đi thì `on` chạy tiếp, spawn
// daemon, daemon chết vì máy không có Tailscale/hub — và một bài chỉ đòi mã
// thoát khác 0 cộng dấu ✗ vẫn XANH trên đúng cái code đã hỏng. Nên: khớp đúng
// câu từ chối, và đòi rằng câu "không bật được remote" (nghĩa là đã spawn) KHÔNG
// xuất hiện.
const DA_SPAWN = /Không bật được remote/;

test('on ngoài phiên ccrc: báo chạy `ccrc` trước, thoát khác 0', { skip: CHI_WINDOWS }, async () => {
  const home = nhaTam(CONFIG_GIA);
  const r = await chay(['on'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /✗ Không ở trong một phiên `ccrc`/);
  assert.match(r.stdout, /Chạy `ccrc` trước/);
  assert.ok(!DA_SPAWN.test(r.stdout), `đã spawn daemon dù không có phiên: ${r.stdout}`);
});

test('on với sessionId không có hồ sơ host: từ chối, không spawn daemon',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    const r = await chay(['on'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: 'khong-co-that' });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /✗ Không ở trong một phiên `ccrc`/);
    assert.ok(!DA_SPAWN.test(r.stdout), `đã spawn daemon cho một phiên không tồn tại: ${r.stdout}`);
    assert.equal(fs.existsSync(path.join(home, '.ccrc', 'term-pane-khong-co-that.pid')), false);
  });

test('on --pane trên Windows bị từ chối, không im lặng làm việc khác',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    writeHost({ sessionId: 'phien-that', pid: process.pid, pipe: '', secret: '', cwd: home },
      { home });
    const r = await chay(['on', '--pane', 'phien-that'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: 'phien-that' });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /✗ `--pane` là khái niệm của tmux/);
    assert.ok(!DA_SPAWN.test(r.stdout), `nuốt cờ rồi vẫn bật cho phiên hiện tại: ${r.stdout}`);
  });

test('off nhận cờ lạ thì BÁO LỖI thay vì tắt phiên hiện tại',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    // Một daemon "đang chạy" của phiên hiện tại: chính tiến trình test này,
    // được khai là daemon để `off` có cái mà tắt nếu nó bỏ qua cờ.
    const pid = path.join(home, '.ccrc', 'term-pane-phien-that.pid');
    fs.writeFileSync(pid, JSON.stringify({ pid: process.pid, sessionId: 'abc' }));
    const r = await chay(['off', '--pane', 'phien-khac'],
      { CCRC_HOME: home, CCRC_HOST_SESSION_ID: 'phien-that' });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /✗ `off` không nhận tham số nào/);
    assert.ok(!/ĐÃ TẮT/.test(r.stdout), `off vẫn tắt dù có cờ lạ: ${r.stdout}`);
    // File pid còn nguyên: nó không đụng vào gì cả.
    assert.equal(fs.existsSync(pid), true);
  });

test('off ngoài phiên ccrc: báo không biết tắt gì, thoát khác 0',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    const r = await chay(['off'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /✗ Không ở trong một phiên `ccrc`/);
    assert.ok(!/vốn đã tắt/.test(r.stdout), `nhận không biết phiên nào rồi vẫn báo bình thường: ${r.stdout}`);
  });

test('off trong phiên ccrc chưa bật remote: nói vốn đã tắt, thoát 0',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    const r = await chay(['off'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: 'phien-that' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /vốn đã tắt/);
  });

test('off KHÔNG giết một pid vô can chỉ vì con số trùng',
  { skip: CHI_WINDOWS }, async () => {
    const home = nhaTam(CONFIG_GIA);
    // NẠN NHÂN THẬT, đúng hình dạng đã lọt lưới vòng 4 bên macOS: node đang
    // chạy code inline, với đường dẫn daemon nằm sau đó như một tham số thừa
    // chẳng ai chạy. Một phép kiểm chỉ hỏi "pid còn sống không" sẽ giết nó.
    //
    // Không dùng chính tiến trình test làm nạn nhân: bài này chỉ có giá trị
    // khi nó ĐỎ được trên code hỏng, và code hỏng ở đây nghĩa là nạn nhân bị
    // giết — nạn nhân mà là tiến trình test thì cả lượt chạy chết giữa chừng
    // thay vì báo một dòng "not ok".
    const nanNhan = spawn(process.execPath,
      ['--eval=setTimeout(function(){},60000)', DAEMON], { stdio: 'ignore' });
    try {
      const pid = path.join(home, '.ccrc', 'term-pane-phien-that.pid');
      fs.writeFileSync(pid, JSON.stringify({ pid: nanNhan.pid, sessionId: 'abc' }));
      const r = await chay(['off'], { CCRC_HOME: home, CCRC_HOST_SESSION_ID: 'phien-that' });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /vốn đã tắt/);
      assert.equal(conSong(nanNhan.pid), true, 'đã giết một tiến trình vô can');
      // Và file pid lừa đảo đã bị dọn, để lần sau không lừa được nữa.
      assert.equal(fs.existsSync(pid), false);
    } finally {
      nanNhan.kill();
    }
  });

test('on bật thật, và đặt tên file pid theo sessionId của host',
  { skip: CHI_WINDOWS }, async () => {
    // Đây là NỬA CÒN LẠI của luật đặt tên file pid. Nửa `off` đã có bài canh
    // (nó tìm đúng file mang tên sessionId). Nửa `on` — ai VIẾT ra cái tên ấy
    // — trước đây không có bài nào, và bài đứng ở chỗ này chỉ khẳng định
    // `on` không kêu "không ở trong phiên ccrc", cộng một file mà chính nó vừa
    // ghi ra bằng `writeHost`. Cả hai đều đúng kể cả khi tên file sai hoàn toàn.
    //
    // Nên: bật daemon THẬT. Ba thứ thay cho hạ tầng thật, không thứ nào đụng
    // vào trạng thái của máy:
    //  • hồ sơ host giả trỏ một pid đang sống — đủ cho `paneChung.alive()` của
    //    nguồn ConPTY, nó chỉ hỏi hồ sơ + pid, không cần ống pipe cho tới lượt
    //    đọc đầu tiên;
    //  • CCRC_TERM_BIND=127.0.0.1 thay Tailscale;
    //  • hub trong CONFIG_GIA là `http://127.0.0.1:1` — một cổng không ai
    //    nghe. Daemon ĐỌC ĐƯỢC cấu hình ấy (ccrc-term.js:144 dùng
    //    `ccrcHome()`, nên dưới CCRC_HOME giả nó thấy đúng file này), rồi mỗi
    //    nhịp tim nó POST lên đó và ăn ECONNREFUSED. `tellHub` nuốt mọi lỗi
    //    hub — không được phép để hub chết kéo cả terminal chết — nên những
    //    lần gõ cửa hỏng ấy không ra tới đâu và không đổi thứ bài này đo.
    //    KHÔNG có hub thật nào bị đụng tới.
    const home = nhaTam(CONFIG_GIA);
    const SID = 'phien-that';
    const hoSoSong = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)'],
      { stdio: 'ignore' });
    writeHost({ sessionId: SID, pid: hoSoSong.pid, pipe: '', secret: '', cwd: home }, { home });
    let daemonPid = 0;
    try {
      const r = await chay(['on', 'ten thu'],
        { CCRC_HOME: home, CCRC_HOST_SESSION_ID: SID, CCRC_TERM_BIND: '127.0.0.1' });
      assert.equal(r.code, 0, `on thất bại: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /✓ Remote ĐÃ BẬT/);

      // ĐÚNG một file pid, và tên nó là sessionId của HOST — không phải id
      // phiên remote ngẫu nhiên nằm bên trong file.
      const dsPid = fs.readdirSync(path.join(home, '.ccrc'))
        .filter((f) => f.startsWith('term-pane-') && f.endsWith('.pid'));
      assert.deepEqual(dsPid, [`term-pane-${SID}.pid`]);

      const ghi = JSON.parse(fs.readFileSync(path.join(home, '.ccrc', dsPid[0]), 'utf8'));
      daemonPid = ghi.pid;
      assert.equal(conSong(daemonPid), true, 'daemon không sống');
      // Hai khái niệm sessionId KHÔNG được trộn: tên file là id phiên ConPTY,
      // còn `sessionId` bên trong là id phiên remote mà hub biết, sinh ngẫu
      // nhiên. Chúng bằng nhau nghĩa là ai đó vừa nhập hai thứ làm một.
      assert.notEqual(ghi.sessionId, SID);
      assert.match(ghi.sessionId, /^[A-Za-z0-9_-]{12}$/);
    } finally {
      if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch { /* đã thoát */ } }
      hoSoSong.kill();
    }
  });

// `DAEMON` chỉ dùng để chắc rằng bộ test và CLI nói về cùng một file — nếu ai
// đổi tên daemon mà quên chỗ này thì luật nhận diện ở trên đang canh một cái
// tên không tồn tại.
test('đường dẫn daemon mà luật nhận diện so vào là file có thật', () => {
  assert.equal(fs.existsSync(DAEMON), true);
});
