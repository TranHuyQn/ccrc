import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_TICKET_LIFETIME_MS } from '../src/ticket-policy.js';

// Final fix wave, item 6: the daemon's clamp used to sit at EXACTLY the same
// value as the hub's mint TTL (both 60_000ms) — zero headroom. Measured on
// this branch before the fix: a ticket minted with exp - iat = 60000 opens,
// 60001 is refused. Raising the minter's lifetime by even one millisecond
// would therefore silently 401 every ticket it mints, forever, with no error
// anywhere pointing at why. The fix gives the clamp real headroom; this test
// pins the RELATIONSHIP, not just the two literals, so it goes red the
// moment the two are ever brought back into lockstep (or the clamp is ever
// set BELOW the mint lifetime, which would 401 tickets outright today).
//
// Task 10 moved WHO mints: the hub's TICKET_TTL_MS is gone along with the
// route it served, and the phone now signs its own token — `signAttachToken`
// in server/public/app.js hardcodes the same 60s the hub used to. The
// property this test guards did not move when the minter did, so it is read
// straight out of app.js's source by regex, the same way this repo's other
// source-reading tests do (see term/test/term-page.test.js's "mã đóng 4001
// khớp giữa daemon và trang").

function mintLifetimeMsFromAppJs() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(dir, '..', '..', 'server', 'public', 'app.js');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/exp:\s*now\s*\+\s*(\d+(?:_\d+)*)/);
  assert.ok(m, 'app.js không còn khai báo exp: now + <ms> trong signAttachToken — test này cần sửa lại theo chỗ mới');
  return Number(m[1].replace(/_/g, ''));
}

test('vòng đời tối đa daemon chấp nhận phải có khoảng trống thật so với thời gian sống PWA ký cho vé', () => {
  const mintLifetimeMs = mintLifetimeMsFromAppJs();

  assert.ok(DEFAULT_MAX_TICKET_LIFETIME_MS > mintLifetimeMs,
    `clamp của daemon (${DEFAULT_MAX_TICKET_LIFETIME_MS}ms) phải LỚN HƠN thời gian sống PWA ký cho vé (${mintLifetimeMs}ms) — bằng nhau là không có khoảng trống, tăng thời gian sống dù chỉ 1ms cũng âm thầm chặn hết mọi vé`);

  const headroomMs = DEFAULT_MAX_TICKET_LIFETIME_MS - mintLifetimeMs;
  assert.ok(headroomMs >= 5000,
    `khoảng trống (${headroomMs}ms) phải đủ lớn để có ý nghĩa thực tế, không phải một mép thừa vài mili-giây coi như không có`);
});
