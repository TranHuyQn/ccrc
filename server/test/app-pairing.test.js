import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadAppPage, makeFetch } from './dom-harness.mjs';
import { shortAuthString, commitFor } from '../../term/src/pairing.js';

test('sinh khoá một lần rồi dùng lại — mở app lần hai không sinh khoá mới', async () => {
  const idb = (await import('./dom-harness.mjs')).makeFakeIndexedDB();
  const fetchImpl = makeFetch(async () => ({ status: 200, body: {} }));

  const a = loadAppPage({ fetchImpl, indexedDBImpl: idb });
  const k1 = await a.context.ensureDeviceKey();
  const b = loadAppPage({ fetchImpl, indexedDBImpl: idb });
  const k2 = await b.context.ensureDeviceKey();

  assert.equal(k1.pubKey, k2.pubKey, 'khoá phải sống qua lần mở app sau — nếu không, ghép cặp vô nghĩa');
  assert.equal(k1.deviceId, k2.deviceId);
  assert.ok(k1.pubKey.length > 40);
});

test('khoá riêng KHÔNG xuất được — kể cả mã trên chính trang này', async () => {
  const { context } = loadAppPage({
    fetchImpl: makeFetch(async () => ({ status: 200, body: {} })),
  });
  // `keyPair` là một phần giá trị trả về thật của ensureDeviceKey, không phải
  // cửa sau mở riêng cho test.
  const { keyPair } = await context.ensureDeviceKey();
  assert.equal(keyPair.privateKey.extractable, false,
    'extractable:true là app.js độc bê được khoá đi — mất toàn bộ điểm của thiết kế');
  await assert.rejects(() => webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  // Khoá công khai thì PHẢI xuất được, nếu không chẳng gửi đi ghép cặp được.
  // Đặc tả WebCrypto: với cặp khoá, cờ extractable chỉ áp cho khoá riêng.
  assert.ok(await webcrypto.subtle.exportKey('spki', keyPair.publicKey));
});

test('SAS bản trình duyệt cho ĐÚNG số mà bản Node cho', async () => {
  // Hai bản cài đặt của cùng một công thức, ở hai ngôn ngữ. Lệch nhau là
  // người dùng thấy hai số khác nhau và không ghép được máy nào — mà triệu
  // chứng đó nhìn y hệt "có người đứng giữa".
  const { context } = loadAppPage({ fetchImpl: makeFetch(async () => ({ status: 200, body: {} })) });
  for (const [pubKey, noncePhone, nonceMachine] of [
    ['k1', 'np1', 'nm1'], ['k2', 'np2', 'nm2'], ['a'.repeat(120), 'b'.repeat(43), 'c'.repeat(43)],
  ]) {
    assert.equal(
      await context.sasFor({ pubKey, noncePhone, nonceMachine }),
      shortAuthString({ pubKey, noncePhone, nonceMachine }),
      `lệch ở ${pubKey.slice(0, 8)}`,
    );
  }
});

test('ghép cặp: gửi cam kết TRƯỚC, chỉ mở nonce SAU khi nhận nonce của máy', async () => {
  // Thứ tự này CHÍNH LÀ tính chất bảo vệ. Mở sớm là quay về giao thức ngây
  // thơ mà term/test/pairing-attack.test.js chứng minh là bẻ được.
  const goi = [];
  let thanRevealSom = false;
  const fetchImpl = makeFetch(async (url, opts) => {
    goi.push(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url === '/api/pair/start') {
      assert.ok(body.commit, 'phải gửi cam kết ngay từ bước đầu');
      assert.equal(body.noncePhone, undefined, 'KHÔNG được gửi nonce ở bước đầu');
      return { status: 200, body: { ok: true, pairId: 'p1' } };
    }
    if (url === '/api/pair/p1') {
      // Máy dev đã gửi nonce của nó.
      return { status: 200, body: { state: 'challenged', nonceMachine: 'nm-cua-may' } };
    }
    if (url === '/api/pair/reveal') {
      if (!goi.includes('/api/pair/p1')) thanRevealSom = true;
      assert.ok(body.noncePhone, 'reveal phải mang nonce');
      return { status: 200, body: { ok: true } };
    }
    if (url === '/api/pair/finish') return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });

  const { context, byId } = loadAppPage({ fetchImpl });
  // startPairing() giờ tự khởi một vòng chờ verdict CHẠY NỀN (không await)
  // sau khi hiện SAS — xem waitForPairVerdict(). Mock ở trên trả cùng một
  // trạng thái 'challenged' mãi mãi cho GET /api/pair/p1, nên vòng nền đó
  // không bao giờ thấy 'done'/'aborted' và sẽ ngủ thật 1 giây mỗi vòng nếu
  // không ghi đè setTimeout — bài kiểm này không nói về vòng chờ đó, nên chỉ
  // cần nó chạy hết NGAY, không cần thật.
  context.setTimeout = (fn) => fn();
  await context.startPairing();

  assert.equal(thanRevealSom, false, 'mở nonce trước khi biết nonce của máy là bỏ mất cam kết');
  assert.match(byId['pair-sas'].textContent, /^\d{6}$/, 'phải hiện đúng 6 chữ số cho người dùng so');
});

// Task 13 (spec §12.2/§12.3): máy dev — không hub, không điện thoại — mới là
// bên phán quyết. Hub có thể chuyển hướng sang điện thoại của kẻ tấn công một
// cách TRUNG THỰC (mọi chuỗi thật, commit khớp, SAS nội bộ nhất quán), nên
// [Khớp]/[Không khớp] trên điện thoại không bao giờ là bằng chứng đáng tin —
// chúng đã bị bỏ. Điện thoại giờ chỉ hiện số và bảo người dùng gõ nó vào máy
// dev bằng `/remote pair xac-nhan <số>`; nút còn lại (Huỷ) chỉ dọn hàng đợi
// hub, không quyết định gì.
test('sau khi có SAS: không còn nút quyết định, chỉ còn số và câu "gõ vào máy dev"', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/pair/start') return { status: 200, body: { ok: true, pairId: 'p1' } };
    if (url === '/api/pair/p1') return { status: 200, body: { state: 'challenged', nonceMachine: 'nm' } };
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  // Xem comment tương tự ở bài kiểm cam kết-trước-nonce phía trên: vòng chờ
  // verdict chạy nền của startPairing() không liên quan gì tới bài kiểm này.
  context.setTimeout = (fn) => fn();
  await context.startPairing();

  assert.match(byId['pair-sas'].textContent, /^\d{6}$/, 'vẫn phải hiện đúng 6 chữ số');
  assert.equal(byId['pair-match'], undefined,
    'nút [Khớp] phải biến mất — điện thoại không còn quyền phán quyết (spec §12.2)');
  assert.equal(byId['pair-mismatch'], undefined,
    'nút [Không khớp] phải biến mất cùng lý do — quyết định giờ ở máy dev');
  const huongDan = `${byId['pair-step'].textContent} ${byId['pair-help'].textContent}`;
  assert.match(huongDan, /máy dev/i, 'phải nói rõ số này gõ vào ĐÂU');
  assert.match(huongDan, /\/remote pair xac-nhan/,
    'phải nêu đúng lệnh máy dev cần chạy, không chỉ nói chung chung "gõ vào máy"');
});

test('Huỷ gửi finish(ok:false) để dọn hàng đợi hub — housekeeping, không phải phán quyết', async () => {
  let finishBody = null;
  let finishCalled = false;
  const fetchImpl = makeFetch(async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url === '/api/pair/start') return { status: 200, body: { ok: true, pairId: 'p1' } };
    if (url === '/api/pair/p1') return { status: 200, body: { state: 'challenged', nonceMachine: 'nm' } };
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    if (url === '/api/pair/finish') { finishCalled = true; finishBody = body; return { status: 200, body: { ok: true } }; }
    return { status: 404, body: {} };
  });
  const { context, byId } = loadAppPage({ fetchImpl });
  // Cùng lý do như hai bài kiểm phía trên.
  context.setTimeout = (fn) => fn();
  await context.startPairing();

  assert.equal(finishCalled, false, 'chỉ hiện số thôi không được tự gọi finish — phải đợi người dùng bấm Huỷ');
  await byId['pair-cancel'].onclick();

  assert.equal(finishCalled, true);
  assert.equal(finishBody.ok, false, 'Huỷ luôn gửi ok:false — nó không còn là đường "Khớp" cũ');
  assert.equal(byId['pair-panel'].classList.contains('hidden'), true,
    'Huỷ phải đóng bảng ghép cặp lại, không đứng chờ tiếp');
});

// Cả 5 test trên đều cho `nonceMachine` ngay ở lần poll ĐẦU TIÊN — nhánh
// "máy dev chưa sẵn sàng" chưa từng được test nào ở trên chạy tới, dù đó mới
// là trường hợp GIỮA (không phải hiếm) của một cái bắt tay hai máy không
// đồng bộ: máy dev thường chưa kịp chạy /remote pair, hoặc trả lời chậm.
//
// `context.setTimeout` bị ghi đè để chạy callback ngay lập tức thay vì đợi
// 1 giây thật — nếu không, hai test dưới sẽ tốn thật hàng chục giây (hoặc
// 120 giây ở test thứ hai) chỉ để chứng minh một vòng lặp chờ vẫn chạy đúng.
test('startPairing: máy dev chưa sẵn sàng vài lần poll đầu, vẫn ghép được khi nonce tới sau', async () => {
  let polls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/pair/start') return { status: 200, body: { ok: true, pairId: 'p1' } };
    if (url === '/api/pair/p1') {
      polls += 1;
      // Ba lần đầu, máy dev CHƯA gửi nonce — mô phỏng đúng cái /remote pair
      // chưa kịp chạy trên máy, hoặc chạy nhưng response tới chậm.
      if (polls < 4) return { status: 200, body: { state: 'started' } };
      return { status: 200, body: { state: 'challenged', nonceMachine: 'nm-den-cham' } };
    }
    if (url === '/api/pair/reveal') return { status: 200, body: { ok: true } };
    if (url === '/api/pair/finish') return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });

  const { context, byId } = loadAppPage({ fetchImpl });
  context.setTimeout = (fn) => fn();

  await context.startPairing();

  assert.ok(polls >= 4, 'phải poll lại nhiều lần, không bỏ cuộc sau lần đầu chưa có nonce');
  assert.match(byId['pair-sas'].textContent, /^\d{6}$/,
    'poll lại thành công thì vẫn phải hiện đúng 6 chữ số để so, y hệt khi nonce tới ngay lần đầu');
});

test('startPairing: máy dev KHÔNG BAO GIỜ trả lời — vòng lặp phải dừng lại, không treo, và nói rõ bằng tiếng Việt', async () => {
  let polls = 0;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/pair/start') return { status: 200, body: { ok: true, pairId: 'p1' } };
    if (url === '/api/pair/p1') { polls += 1; return { status: 200, body: { state: 'started' } }; }
    return { status: 404, body: {} };
  });

  const { context, byId } = loadAppPage({ fetchImpl });
  context.setTimeout = (fn) => fn();

  await context.startPairing();

  assert.equal(polls, 120, 'phải dừng đúng sau số lần poll đã định, không lặp mãi');
  assert.equal(
    byId['pair-step'].textContent,
    'Máy dev không trả lời. Chạy /remote pair trên máy rồi thử lại.',
    'người dùng phải thấy lý do bằng tiếng Việt, không phải màn hình treo im lặng',
  );
  assert.equal(byId['pair-sas'].textContent, '', 'không có nonce của máy thì không được bịa ra số để so');
});
