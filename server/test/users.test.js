// Unit tests cho src/users.js — luật "admin là tên dành riêng".
//
// terminal-api.test.js chứng minh luật này có hiệu lực qua HTTP thật (kẻ mang
// tên admin không xin được vé vào phiên terminal của chủ hub). File này chốt
// hành vi của chính hàm nạp: bỏ đúng cái gì, giữ đúng cái gì, và có nói ra
// lý do không.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_USER_NAME, isValidSlackUserId, parseUsers, removeUser, upsertBySlackId } from '../src/users.js';

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

// Tương thích ngược đứng TRƯỚC mọi thứ khác: users.json trên hub đang chạy
// toàn entry cũ, và một bản deploy làm chúng ngừng nạp là cả team mất
// thông báo cùng lúc.
test('entry cũ không có displayName vẫn nạp được, displayName lấy chính name', () => {
  const { users } = parseUsers([{ name: 'huy', token: 'tok-huy' }], HUB_TOKEN);
  assert.deepEqual(users.get('tok-huy'), { name: 'huy', displayName: 'huy', admin: false });
});

test('entry mới giữ nguyên displayName riêng', () => {
  const { users } = parseUsers([{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok' }], HUB_TOKEN);
  assert.deepEqual(users.get('tok'), { name: 'U01ABCDEF', displayName: 'huy', admin: false });
});

test('upsert lần đầu tạo entry mới với token được đưa vào', () => {
  const { list, token, created } = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-moi');
  assert.equal(created, true);
  assert.equal(token, 'tok-moi');
  assert.deepEqual(list, [{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok-moi' }]);
});

test('upsert lần hai GIỮ NGUYÊN token cũ', () => {
  const first = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-cu');
  const second = upsertBySlackId(first.list, 'U01ABCDEF', 'huy', 'tok-moi');
  assert.equal(second.created, false);
  assert.equal(second.token, 'tok-cu',
    'đổi token lúc đăng nhập lại là đá văng mọi thiết bị khác của chính người đó');
  assert.equal(second.list.length, 1, 'không được đẻ entry thứ hai');
});

test('đổi handle trên Slack chỉ đổi displayName, khoá và token đứng yên', () => {
  const first = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-cu');
  const { list } = upsertBySlackId(first.list, 'U01ABCDEF', 'huy-moi', 'tok-khac');
  assert.deepEqual(list, [{ name: 'U01ABCDEF', displayName: 'huy-moi', token: 'tok-cu' }]);
});

test('upsert không đụng tới entry của người khác', () => {
  const base = [{ name: 'kien-cu', token: 'tok-kien' }];
  const { list } = upsertBySlackId(base, 'U01ABCDEF', 'huy', 'tok-huy');
  assert.deepEqual(list[0], { name: 'kien-cu', token: 'tok-kien' });
  assert.equal(list.length, 2);
});

test('removeUser xoá được bằng displayName', () => {
  const base = [{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok' }];
  const { list, removed } = removeUser(base, 'huy');
  assert.equal(removed.name, 'U01ABCDEF');
  assert.deepEqual(list, []);
});

test('removeUser xoá được bằng name (kể cả entry cũ)', () => {
  const base = [{ name: 'huy-cu', token: 'tok' }];
  const { list, removed } = removeUser(base, 'huy-cu');
  assert.equal(removed.name, 'huy-cu');
  assert.deepEqual(list, []);
});

test('trùng displayName thì KHÔNG xoá gì, trả về cả hai để người chạy tự chọn', () => {
  const base = [
    { name: 'U01', displayName: 'huy', token: 'a' },
    { name: 'U02', displayName: 'huy', token: 'b' },
  ];
  const { list, removed, matches } = removeUser(base, 'huy');
  assert.equal(removed, null, 'xoá nhầm người là mất push subs và phiên đang mở của họ');
  assert.equal(matches.length, 2);
  assert.equal(list.length, 2);
});

test('không khớp ai thì không xoá gì', () => {
  const base = [{ name: 'U01', displayName: 'huy', token: 'a' }];
  const { list, removed, matches } = removeUser(base, 'khong-co');
  assert.equal(removed, null);
  assert.equal(matches.length, 0);
  assert.equal(list.length, 1);
});

// --- hình dạng của slack_user_id -------------------------------------------
//
// `name` là khoá của pushSubs (một object THƯỜNG), của lịch sử thông báo và
// của danh sách phiên. Chặn riêng 'admin' là chặn đúng một cái tên trong một
// họ; mô tả hình dạng đúng thì cả họ rơi ra ngoài một lượt.
test('isValidSlackUserId nhận id Slack thật', () => {
  for (const ok of ['U01ABCDEF', 'U08K3QZ1X4M', 'W12345678', 'B0123456789']) {
    assert.equal(isValidSlackUserId(ok), true, `phải nhận ${ok}`);
  }
});

test('isValidSlackUserId loại khoá ma thuật của JS', () => {
  // __proto__ là cái có răng: pushSubs['__proto__'] trả về Object.prototype —
  // truthy, không có .some() — nên MỌI lần đăng ký push của người đó thành
  // 500. constructor/prototype/toString cùng họ.
  for (const bad of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    assert.equal(isValidSlackUserId(bad), false, `phải loại ${bad}`);
  }
});

test('isValidSlackUserId vẫn loại tên dành riêng của hub', () => {
  // Không còn một nhánh `=== 'admin'` riêng trong index.js nữa — luật hình
  // dạng gánh cả việc đó (chữ thường). Bài kiểm này giữ cho việc nới luật sau
  // này không âm thầm mở lại cái tên đó.
  assert.equal(isValidSlackUserId(HUB_USER_NAME), false,
    `'${HUB_USER_NAME}' là chìa thứ hai vào hộp của chủ hub`);
});

test('isValidSlackUserId loại rỗng, không phải chuỗi, và ký tự lạ', () => {
  for (const bad of ['', ' ', 'U01 ABC', 'u01abcdef', '1ABCDEF', 'U01-ABC', 'U/../x', null, undefined, 42, {}, ['U01ABCDEF']]) {
    assert.equal(isValidSlackUserId(bad), false, `phải loại ${JSON.stringify(bad)}`);
  }
});
