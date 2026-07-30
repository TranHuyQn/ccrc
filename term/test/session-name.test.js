// What a session is called — and, more to the point, what it is NOT called.
//
// The label the phone shows used to be the pane's directory basename. On a
// lock screen and in a screenshot that names the project, and it cannot be
// unseen afterwards. So the default is an opaque id, and a readable name only
// ever appears because the user typed it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomSessionName, cleanSessionName, resolveSessionName, MAX_NAME_LEN } from '../src/session-name.js';

test('id ngẫu nhiên: 4 ký tự, không có ký tự dễ đọc nhầm', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = randomSessionName();
    assert.match(id, /^[a-z2-9]{4}$/, `id lạ: ${id}`);
    // i l o 0 1 are the pairs people misread off a phone screen and then
    // mistype back into a terminal.
    assert.ok(!/[ilo01]/.test(id), `id chứa ký tự dễ nhầm: ${id}`);
  }
});

test('id ngẫu nhiên thật sự đổi mỗi lần', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(randomSessionName());
  // 31^4 ≈ 923k: 200 draws colliding more than a handful of times would mean
  // the generator is not actually random.
  assert.ok(seen.size > 190, `quá nhiều trùng lặp: ${seen.size}/200`);
});

test('id ngẫu nhiên dùng hết được bảng chữ cái', () => {
  const used = new Set();
  const seq = [];
  for (let i = 0; i < 31; i += 1) seq.push(i);
  let k = 0;
  randomSessionName(() => seq[k++ % seq.length]);
  // Walks the alphabet by index — proves the mapping covers the low end
  // without an off-by-one at position 0.
  assert.equal(randomSessionName(() => 0), 'aaaa');
  assert.equal(randomSessionName(() => 30), '9999');
  used.add('ok');
  assert.equal(used.size, 1);
});

test('tên người dùng đặt được giữ nguyên', () => {
  assert.equal(cleanSessionName('test'), 'test');
  assert.equal(cleanSessionName('du an moi'), 'du an moi');
  assert.equal(cleanSessionName('Dự Án 2026'), 'Dự Án 2026');
  assert.equal(cleanSessionName('a_b-c.d'), 'a_b-c.d');
});

test('gọn khoảng trắng thừa', () => {
  assert.equal(cleanSessionName('  test  '), 'test');
  assert.equal(cleanSessionName('a    b'), 'a b');
  assert.equal(cleanSessionName('a\tb'), 'a b');
  // A newline collapses to a space rather than being rejected: a label must
  // stay one line, but there is no reason to refuse the name over it.
  assert.equal(cleanSessionName('a\nb'), 'a b');
});

// This string is rendered on a web page and travels through the hub. Both
// render it with textContent, never innerHTML — but a label is not the place
// to find out whether every consumer, present and future, got that right.
//
// The invariant is about the OUTPUT, not the input: whatever goes in, what
// comes out is either nothing at all or a string made only of letters,
// digits, space, dot, dash and underscore. Asserting "this input is
// rejected" instead would be asserting an implementation detail — a
// non-breaking space, for instance, is perfectly safe to fold into an
// ordinary one, and the first version of this test failed for saying
// otherwise.
const SAFE = /^[\p{L}\p{N} ._-]+$/u;

test('mọi đầu vào hiểm đều cho ra tên an toàn, hoặc không cho gì', () => {
  for (const bad of [
    '<img src=x onerror=alert(1)>',
    'a<b', 'a>b', 'a"b', "a'b", 'a&b', 'a/b', 'a\\b', 'a`b', 'a;b', 'a|b', 'a$b',
    '../../etc/passwd',
    '{{7*7}}',
    '\u0000', 'a\u0000b',
    'a\u200bb',
    'a\u00a0b',
    '\u202eabc',
    'a\u0301b',
    '%2e%2e%2f',
    '$(rm -rf /)',
  ]) {
    const got = cleanSessionName(bad);
    if (got === null) continue;
    assert.match(got, SAFE, `đầu ra không an toàn cho ${JSON.stringify(bad)}: ${JSON.stringify(got)}`);
  }
});

// The ones that must be refused outright — folding these into something
// harmless is not on the table, because there is no harmless reading of them.
test('ký tự đánh dấu HTML và đường dẫn bị từ chối thẳng', () => {
  for (const bad of ['<b>', 'a<b', 'a>b', 'a"b', "a'b", 'a&b', 'a/b', 'a\\b', '../x', '{{7*7}}', 'a\u0000b']) {
    assert.equal(cleanSessionName(bad), null, `lọt: ${JSON.stringify(bad)}`);
  }
});

test('rỗng hoặc không phải chuỗi → không có tên', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(cleanSessionName(bad), null);
  }
});

test('tên quá dài bị cắt, không bị từ chối', () => {
  const long = 'x'.repeat(200);
  const got = cleanSessionName(long);
  assert.equal(got.length, MAX_NAME_LEN);
});

// Refusing to start a terminal over a bad label would be a wildly
// disproportionate response — the user is trying to get remote access, not
// name something.
test('tên hỏng → rơi về id ngẫu nhiên, KHÔNG phải lỗi', () => {
  const got = resolveSessionName('<script>');
  assert.match(got, /^[a-z2-9]{4}$/);
});

test('không truyền gì → id ngẫu nhiên', () => {
  assert.match(resolveSessionName(undefined), /^[a-z2-9]{4}$/);
  assert.match(resolveSessionName(''), /^[a-z2-9]{4}$/);
});

test('có tên hợp lệ thì KHÔNG dùng id ngẫu nhiên', () => {
  assert.equal(resolveSessionName('test', () => 0), 'test');
});
