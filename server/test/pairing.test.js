import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairings, PAIR_TTL_MS } from '../src/pairing.js';

const REQ = { pubKey: 'khoa-cong-khai', commit: 'cam-ket', label: 'iPhone · Safari' };

test('createPairings(null) không ném lỗi, trả instance làm việc được', () => {
  const p = createPairings(null);
  const { pairId } = p.start('huy', REQ);
  assert.ok(pairId, 'có thể start và nhận pairId');
  assert.equal(p.get('huy', pairId).state, 'started', 'dùng Date.now() mặc định');
});

test('luồng đầy đủ: start → challenge → reveal → finish(true) → done', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);

  assert.deepEqual(p.pending('huy').map((x) => x.pairId), [pairId]);
  assert.equal(p.get('huy', pairId).state, 'started');
  assert.equal(p.get('huy', pairId).pubKey, 'khoa-cong-khai');

  assert.equal(p.challenge('huy', pairId, 'nonce-may').ok, true);
  assert.equal(p.get('huy', pairId).state, 'challenged');
  assert.equal(p.get('huy', pairId).nonceMachine, 'nonce-may');

  assert.equal(p.reveal('huy', pairId, 'nonce-dien-thoai').ok, true);
  assert.equal(p.get('huy', pairId).state, 'revealed');
  assert.equal(p.get('huy', pairId).noncePhone, 'nonce-dien-thoai');

  assert.equal(p.finish('huy', pairId, true).ok, true);
  assert.equal(p.get('huy', pairId).state, 'done');
});

test('finish(false) — người dùng bấm [Không khớp] — cho trạng thái aborted', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  p.challenge('huy', pairId, 'nm');
  p.reveal('huy', pairId, 'np');
  assert.equal(p.finish('huy', pairId, false).ok, true);
  assert.equal(p.get('huy', pairId).state, 'aborted');
});

test('bước sai thứ tự bị từ chối', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  assert.equal(p.reveal('huy', pairId, 'np').ok, false, 'chưa challenge thì chưa reveal được');
  assert.equal(p.finish('huy', pairId, true).ok, false, 'chưa reveal thì chưa finish được');
  p.challenge('huy', pairId, 'nm');
  assert.equal(p.challenge('huy', pairId, 'nm2').ok, false, 'challenge hai lần bị từ chối');
});

test('người này KHÔNG thấy, KHÔNG đụng được yêu cầu của người kia', () => {
  const p = createPairings();
  const { pairId } = p.start('huy', REQ);
  assert.deepEqual(p.pending('kien'), []);
  assert.equal(p.get('kien', pairId), null);
  assert.equal(p.challenge('kien', pairId, 'nm').ok, false);
  assert.equal(p.reveal('kien', pairId, 'np').ok, false);
  assert.equal(p.finish('kien', pairId, true).ok, false);
  assert.equal(p.get('huy', pairId).state, 'started', 'người khác không được làm gì thay đổi nó');
});

test('pairId không tồn tại → mọi thao tác trả false, get trả null', () => {
  const p = createPairings();
  assert.equal(p.get('huy', 'khong-co'), null);
  assert.equal(p.challenge('huy', 'khong-co', 'nm').ok, false);
});

test('quá hạn 5 phút thì biến mất', () => {
  let t = 0;
  const p = createPairings({ now: () => t });
  const { pairId } = p.start('huy', REQ);

  t = PAIR_TTL_MS;
  assert.equal(p.get('huy', pairId).state, 'started', 'đúng bằng ngưỡng thì chưa hết hạn');

  t = PAIR_TTL_MS + 1;
  assert.equal(p.get('huy', pairId), null);
  assert.deepEqual(p.pending('huy'), []);
  assert.equal(p.challenge('huy', pairId, 'nm').ok, false);
});

test('pairId của hai yêu cầu khác nhau thì khác nhau, và không đoán được', () => {
  const p = createPairings();
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { pairId } = p.start('huy', { ...REQ, pubKey: `k-${i}` });
    assert.ok(pairId.length >= 20, 'pairId ngắn là đoán được, mà đoán được là chen ngang được');
    assert.equal(ids.has(pairId), false);
    ids.add(pairId);
  }
});

test('start từ chối đầu vào dị dạng', () => {
  const p = createPairings();
  assert.equal(p.start('huy', { commit: 'c' }).ok, false, 'thiếu pubKey');
  assert.equal(p.start('huy', { pubKey: 'k' }).ok, false, 'thiếu commit');
  assert.equal(p.start('huy', null).ok, false);
  assert.deepEqual(p.pending('huy'), []);
});

test('pending chỉ trả yêu cầu đang chờ, không trả cái đã xong hay đã huỷ', () => {
  const p = createPairings();
  const a = p.start('huy', REQ).pairId;
  const b = p.start('huy', { ...REQ, pubKey: 'k2' }).pairId;
  p.challenge('huy', a, 'nm');
  assert.deepEqual(p.pending('huy').map((x) => x.pairId), [b],
    'yêu cầu đã bắt tay rồi không còn "đang chờ máy dev nhận" nữa');
});
