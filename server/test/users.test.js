// Unit tests cho src/users.js — luật "admin là tên dành riêng".
//
// terminal-api.test.js chứng minh luật này có hiệu lực qua HTTP thật (kẻ mang
// tên admin không xin được vé vào phiên terminal của chủ hub). File này chốt
// hành vi của chính hàm nạp: bỏ đúng cái gì, giữ đúng cái gì, và có nói ra
// lý do không.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_USER_NAME, parseUsers } from '../src/users.js';

const HUB_TOKEN = 'tok-cua-hub';

test('entry tên "admin" bị loại, và nói rõ lý do', () => {
  const { users, rejected } = parseUsers([{ name: 'admin', token: 'tok-gia-mao' }], HUB_TOKEN);
  assert.equal(users.size, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'admin');
  assert.match(rejected[0].why, /dành riêng/,
    'token ngừng chạy mà không có dòng nào giải thích là kiểu hỏng tệ nhất');
});

test('loại "admin" KHÔNG kéo theo các entry hợp lệ đứng cạnh nó', () => {
  const { users } = parseUsers([
    { name: 'huy', token: 'tok-huy' },
    { name: 'admin', token: 'tok-gia-mao' },
    { name: 'kien', token: 'tok-kien' },
  ], HUB_TOKEN);
  assert.deepEqual([...users.keys()].sort(), ['tok-huy', 'tok-kien']);
  assert.equal(users.get('tok-huy').name, 'huy');
});

test('entry dùng lại đúng CCRC_TOKEN vẫn bị loại như trước', () => {
  // Hành vi cũ, giữ nguyên: trước khi tách module, loadUsers() lọc
  // `u.token !== TOKEN`. Nếu để lọt, tên trong file sẽ ghi đè danh tính
  // 'admin' mà token hub tự nhận.
  const { users, rejected } = parseUsers([{ name: 'ai-do', token: HUB_TOKEN }], HUB_TOKEN);
  assert.equal(users.size, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].why, /CCRC_TOKEN/);
});

test('tên dành riêng so khớp CHÍNH XÁC, không chặn nhầm tên gần giống', () => {
  // Chặn quá tay cũng là một kiểu hỏng: một người thật tên "admin-huy" phải
  // dùng được bình thường.
  //
  // Review toàn nhánh (item 5): khẳng định `users.size === 3` không canh
  // được ĐÚNG thứ này bảo vệ — luật "tên dành riêng" là một `===` trên chuỗi
  // thô (src/users.js), nên chỉ CỠ mảng thì không phân biệt được với một
  // phiên bản đã thêm chuẩn hoá (`toLowerCase`, `trim`, NFKC…): thêm chuẩn
  // hoá đó sẽ khiến "Admin" cũng bị coi là trùng "admin" và bị loại — mảng
  // co lại còn 2 phần tử, một khẳng định về SỐ LƯỢNG bắt được điều đó, nhưng
  // không bắt được trường hợp ngược: nếu code đổi để loại một tên KHÁC (bug
  // ở đâu đó), size vẫn có thể tình cờ ra đúng 3. Phải khẳng định ĐÚNG những
  // TÊN nào sống sót — "Admin" (viết hoa) phải còn trong danh sách, vì đó
  // chính xác là ca chuẩn hoá sẽ giết nhầm.
  const { users } = parseUsers([
    { name: 'admin-huy', token: 'a' },
    { name: 'quan-tri', token: 'b' },
    { name: 'Admin', token: 'c' },
  ], HUB_TOKEN);
  assert.deepEqual(
    [...users.values()].map((u) => u.name).sort(),
    ['Admin', 'admin-huy', 'quan-tri'],
    'phải giữ đúng BA tên này — "Admin" viết hoa đặc biệt phải sống sót, vì một chuẩn hoá không-phân-biệt-hoa-thường sẽ loại nhầm nó',
  );
});

test('entry thiếu name hoặc token bị bỏ qua lặng lẽ, không làm hỏng cả file', () => {
  const { users } = parseUsers([
    { name: 'huy', token: 'tok-huy' },
    { name: 'thieu-token' },
    { token: 'thieu-ten' },
    null,
    'khong-phai-object',
  ], HUB_TOKEN);
  assert.deepEqual([...users.keys()], ['tok-huy']);
});

test('users.json không phải mảng → không có user nào, không ném lỗi', () => {
  // File hỏng không được làm sập hub lúc khởi động, cũng không được biến
  // thành "cho qua hết".
  for (const x of [null, {}, 'abc', 42]) {
    const { users } = parseUsers(x, HUB_TOKEN);
    assert.equal(users.size, 0, `${JSON.stringify(x)} phải cho Map rỗng`);
  }
});

test('cờ admin:true trong file vẫn đọc được cho một tên hợp lệ', () => {
  const { users } = parseUsers([{ name: 'huy', token: 'tok-huy', admin: true }], HUB_TOKEN);
  assert.equal(users.get('tok-huy').admin, true);
});

test('HUB_USER_NAME là đúng cái tên resolveUser() gán cho token hub', () => {
  // Hai chỗ này phải khớp nhau, nếu không thì luật "tên dành riêng" đang bảo
  // vệ một cái tên chẳng ai dùng. index.js import hằng số này cho cả hai chỗ.
  assert.equal(HUB_USER_NAME, 'admin');
});
