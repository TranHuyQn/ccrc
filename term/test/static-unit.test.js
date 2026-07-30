// Unit tests against ../src/static.js directly — no daemon, no tmux, no
// network. These exist because a black-box test that only ever sends real
// HTTP requests cannot exercise the containment check in resolveWithinRoot:
// `URL.pathname` always starts with `/`, and on POSIX `path.normalize` +
// `path.join` on an absolute-looking input already keep the result under
// `root` regardless of that check — see static.test.js's traversal test and
// task-2-report.md for the measurement proving that. Calling
// resolveWithinRoot directly, with a RELATIVE path no real HTTP request can
// ever produce, is the only way to make the check itself the thing under
// test.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithinRoot } from '../src/static.js';

const ROOT = '/tmp/ccrc-static-unit-root';

test('resolveWithinRoot: đường dẫn thường bên trong root được trả về', () => {
  assert.equal(resolveWithinRoot(ROOT, '/index.html'), path.join(ROOT, 'index.html'));
});

test('resolveWithinRoot: chính root (rỗng/`/`) được trả về, không bị coi là ngoài', () => {
  assert.equal(resolveWithinRoot(ROOT, '/'), ROOT);
});

// The case a real HTTP request can never produce: `path.normalize` does NOT
// clamp a RELATIVE `..` (it only clamps when the input already starts with
// `/`), so `path.join(root, '../../etc/passwd')` walks straight out of
// `root`. This is the exact shape of input the startsWith(root) check exists
// to catch — see the mutation below.
test('resolveWithinRoot: đường dẫn TƯƠNG ĐỐI với .. đi ra ngoài root bị chặn (trả về null)', () => {
  assert.equal(resolveWithinRoot(ROOT, '../../etc/passwd'), null);
  assert.equal(resolveWithinRoot(ROOT, '../../../../../../etc/passwd'), null);
});

test('resolveWithinRoot: thư mục anh em (không phải con) của root bị chặn', () => {
  // "/tmp/ccrc-static-unit-root-evil" starts with the same string prefix as
  // ROOT but is NOT a subdirectory of it — a naive `resolved.startsWith(root)`
  // WITHOUT the `+ path.sep` would wrongly let this through.
  const evilRoot = ROOT + '-evil';
  assert.equal(resolveWithinRoot(ROOT, path.relative(ROOT, path.join(evilRoot, 'secret.txt'))), null);
});
