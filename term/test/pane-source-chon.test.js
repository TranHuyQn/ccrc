import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chonNguonPane } from '../src/pane-source-chon.js';

const GOC = path.dirname(fileURLToPath(import.meta.url));

// Cả bài test này chạy được trên CẢ HAI nền tảng, và đó là điều kiện duy nhất
// khiến nó có giá trị: một nhánh bị đảo (win32 lấy tmux, macOS lấy ConPTY) chỉ
// lộ ra nếu máy đang chạy test kiểm được cả nhánh KHÔNG phải của mình. `platform`
// vì thế là tham số, không phải `process.platform` đọc thẳng.

function xuong() {
  const goi = [];
  return {
    goi,
    taoTmux(opts) { goi.push(['tmux', opts]); return { ten: 'tmux' }; },
    taoConpty(opts) { goi.push(['conpty', opts]); return { ten: 'conpty' }; },
  };
}

test('win32 chọn nguồn ConPTY', () => {
  const x = xuong();
  const nguon = chonNguonPane({ pane: 'abc123', platform: 'win32', taoTmux: x.taoTmux, taoConpty: x.taoConpty });
  assert.equal(nguon.ten, 'conpty');
  assert.deepEqual(x.goi, [['conpty', { sessionId: 'abc123' }]]);
});

// Trên Windows, CCRC_TERM_PANE mang sessionId của host chứ không phải pane id
// — daemon chuyển tiếp nguyên vẹn thứ nó nhận được, dưới ĐÚNG cái tên tham số
// mà createConptyPaneSource đọc. Truyền nhầm tên là nguồn im lặng coi như
// "không có phiên nào" chứ không nổ.
test('win32 chuyển CCRC_TERM_PANE vào đúng tham số sessionId', () => {
  const x = xuong();
  chonNguonPane({ pane: 'phien-cua-host', platform: 'win32', taoTmux: x.taoTmux, taoConpty: x.taoConpty });
  const [, opts] = x.goi[0];
  assert.equal(opts.sessionId, 'phien-cua-host');
  assert.equal('pane' in opts, false);
});

for (const platform of ['darwin', 'linux', 'freebsd']) {
  test(`${platform} chọn nguồn tmux, với đúng đối số cũ`, () => {
    const x = xuong();
    const nguon = chonNguonPane({ pane: '%15267', platform, taoTmux: x.taoTmux, taoConpty: x.taoConpty });
    assert.equal(nguon.ten, 'tmux');
    // deepEqual chứ không chỉ kiểm `pane`: đường macOS phải KHÔNG đổi chút nào,
    // kể cả việc không truyền runId (pane-source.js tự sinh — thêm vào đây là
    // đổi hành vi thu hồi phiên nhóm).
    assert.deepEqual(x.goi, [['tmux', { pane: '%15267' }]]);
  });
}

// Hai bài trên dùng xưởng giả nên KHÔNG bắt được ca "mặc định bị nối ngược".
// Bài này gọi không stub, dùng đúng hai xưởng thật, và phân biệt chúng bằng
// thứ quan sát được mà không cần dựng gì thật: attach() vào một id không tồn
// tại bị từ chối TRƯỚC khi sinh tiến trình con hay mở ống, và hai bản từ chối
// bằng hai câu khác nhau — bản ConPTY nhắc lại chính sessionId được đưa.
const KHONG_CO_THAT = 'ccrc-test-khong-co-that';
const CHU_KY = { onData() {}, onCtlReply() {}, onGone() {} };

test('mặc định (không stub) vẫn nối đúng hai xưởng thật', () => {
  const win = chonNguonPane({ pane: KHONG_CO_THAT, platform: 'win32' }).attach(CHU_KY);
  assert.equal(win.ok, false);
  assert.match(win.message, new RegExp(KHONG_CO_THAT));

  const nix = chonNguonPane({ pane: '%999999', platform: 'darwin' }).attach(CHU_KY);
  assert.equal(nix.ok, false);
  assert.doesNotMatch(nix.message, new RegExp(KHONG_CO_THAT));
});

// Không truyền platform thì phải rơi đúng vào nhánh của máy đang chạy — đây là
// cách daemon gọi nó.
test('thiếu platform thì lấy process.platform', () => {
  const x = xuong();
  chonNguonPane({ pane: 'p', taoTmux: x.taoTmux, taoConpty: x.taoConpty });
  assert.equal(x.goi[0][0], process.platform === 'win32' ? 'conpty' : 'tmux');
});

// Phép chọn chỉ có tác dụng nếu daemon thật sự đi qua nó. Kiểm bằng văn bản vì
// dựng cả một daemon (cổng, token, WebSocket) để hỏi một câu hỏi một dòng thì
// bài test sẽ đo phần lớn những thứ khác.
test('ccrc-term.js dựng nguồn pane qua chonNguonPane, không gọi thẳng xưởng nào', () => {
  const src = fs.readFileSync(path.join(GOC, '..', 'bin', 'ccrc-term.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const paneChung = chonNguonPane\(\{ pane: PANE \}\);/);
  assert.ok(!src.includes('createTmuxPaneSource('), 'ccrc-term.js không được gọi thẳng createTmuxPaneSource');
  assert.ok(!src.includes('createConptyPaneSource('), 'ccrc-term.js không được gọi thẳng createConptyPaneSource');
});
