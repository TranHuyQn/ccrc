// Task 9's client-side login/link logic in server/public/app.js:
// consumeLoginCode() (the ?login=<claimCode> exchange), the bootstrap that
// routes to showLink() on /link, and the Slack-config probe. Nothing here
// was covered before — this file closes that gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage, makeFetch } from './dom-harness.mjs';

// Neither loadAppPage() nor its auto-run bootstrap IIFE (the last lines of
// app.js) is directly awaitable from a test — the IIFE is fire-and-forget,
// exactly like a real page load. When a test's fetch mocks all resolve
// without an artificial hang, a single macrotask boundary is enough: Node
// fully drains the microtask queue (repeatedly, including microtasks freshly
// queued while draining) before running any timer callback, no matter how
// many `await`s are chained. This is NOT `await Promise.resolve()` (one
// microtask tick) — that would be too shallow for a chain as deep as
// consumeLoginCode() → showMain() → refreshPushState() → refreshList() →
// refreshTerminal().
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- 1. the ordering guarantee ---------------------------------------------
//
// The whole reason consumeLoginCode() exists is: whoever holds the URL after
// the exchange started must not be holding a still-valid code. That means
// history.replaceState() must run BEFORE the /api/auth/claim response is
// awaited — not merely "by the time everything settles". Proving that needs
// the exchange request to still be in flight at the moment we check, so this
// test holds /api/auth/claim open with a promise the test controls, and
// inspects replaceCalls while it is still pending. If replaceState() were
// ever moved to after the `await fetch(...)`, replaceCalls would still be
// empty at this point and the assertion below would fail.
test('consumeLoginCode(): xoá mã khỏi URL TRƯỚC khi đợi /api/auth/claim trả lời, không phải sau', async () => {
  let resolveClaim;
  const claimPending = new Promise((resolve) => { resolveClaim = resolve; });
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') {
      // Treo ở đây — mô phỏng request đang bay, chưa có phản hồi.
      await claimPending;
      return { status: 200, body: { ok: true, token: 'tok-x', displayName: 'huy' } };
    }
    return { status: 404, body: {} };
  });

  const page = loadAppPage({ fetchImpl, search: '?login=abc123' });

  // loadAppPage() chỉ trả về sau khi phần đồng bộ của bootstrap đã chạy hết —
  // và phần đồng bộ đó BAO GỒM history.replaceState() (nó đứng trước dòng
  // `await fetch(...)` trong consumeLoginCode()). Request /api/auth/claim vẫn
  // đang treo (claimPending chưa resolve) tại đúng thời điểm này.
  assert.equal(page.replaceCalls.length, 1,
    'phải xoá mã khỏi thanh địa chỉ trước khi request đổi mã kịp trả lời');
  assert.equal(page.replaceCalls[0].url, page.location.pathname);

  resolveClaim();
  await flush();
});

// --- 2. claim thành công ----------------------------------------------------

test('claim mã thành công: lưu token thật, đưa thẳng vào màn hình chính', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') return { status: 200, body: { ok: true, token: 'tok-slack', displayName: 'huy' } };
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 0 } };
    if (url === '/api/terminal') return { status: 200, body: { sessions: [] } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, search: '?login=abc123' });
  // Khớp trạng thái ban đầu thật của trang: #main bắt đầu ẩn (harness dựng
  // phần tử trần, không có class nào — xem app-pull-refresh.test.js cho cùng
  // ghi chú), nên phải tự đặt để phép so sánh dưới đây có ý nghĩa.
  page.byId.main.classList.add('hidden');

  await flush();

  assert.equal(page.localStorage.getItem('ccrc_token'), 'tok-slack');
  assert.equal(page.byId.main.classList.contains('hidden'), false, 'phải vào được màn hình chính');
  assert.equal(page.byId.login.classList.contains('hidden'), true, 'phải rời khỏi màn hình đăng nhập');
});

// displayName của /api/auth/claim là khoảnh khắc ĐẦU TIÊN trang biết mình vừa
// đăng nhập thành ai — và đăng nhập bằng Slack GHI ĐÈ token đang có trong
// localStorage, nên đó cũng là chỗ duy nhất người dùng nhận ra "đây không
// phải tài khoản của tôi". Trước bản này nó bị đọc rồi vứt đi.
test('claim mã: displayName được vẽ ngay lên header, không bị vứt đi', async () => {
  let resolveMe;
  const mePending = new Promise((resolve) => { resolveMe = resolve; });
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') return { status: 200, body: { ok: true, token: 'tok-slack', displayName: 'huy' } };
    if (url === '/api/me') {
      // Treo /api/me lại: nếu header CHỈ được vẽ bởi showMain(), thì tại thời
      // điểm kiểm bên dưới nó vẫn rỗng và bài kiểm đỏ. Đây là điều phân biệt
      // "consumeLoginCode dùng displayName" với "showMain vẽ hộ sau đó".
      await mePending;
      return { status: 200, body: { user: 'huy', pushDevices: 0 } };
    }
    if (url === '/api/terminal') return { status: 200, body: { sessions: [] } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, search: '?login=abc123' });

  await flush();
  assert.equal(page.byId.who.textContent, 'huy',
    'phải nói ngay mình vừa đăng nhập thành ai, không đợi /api/me');

  resolveMe();
  await flush();
});

// --- 3. claim thất bại (410 / ok:false) -------------------------------------

// `/api/me` và `/api/terminal` trả lời TỐT (không phải
// 404 trần) dù bài kiểm này mong showMain() không hề được gọi tới. Lý do:
// nếu bootstrap có bug gọi showMain() bất chấp consumeLoginCode() thất bại,
// và ba endpoint này vẫn trả 404/{} như macro cũ, refreshList() sẽ ném
// TypeError trên `items.length` (items === undefined) → showMain() reject →
// `.catch(() => logout())` chạy — mà logout() lại ADD hidden vào #main và
// REMOVE hidden khỏi #login, tình cờ ra ĐÚNG cùng trạng thái DOM như khi
// showMain() không hề chạy. Bài kiểm khi đó xanh vì một lý do sai, không
// phải vì consumeLoginCode() đã chặn đúng. Cho ba endpoint trả dữ liệu hợp
// lệ thì nếu showMain() lỡ chạy, nó sẽ CHẠY TRÓT LỌT và thật sự lộ #main —
// lúc đó assertion bên dưới mới bắt được. Đã tự kiểm: xoá điều kiện gate
// (`if (await consumeLoginCode())`) làm bootstrap luôn gọi showMain() —
// không có ba handler này thì test vẫn xanh (bị che); có rồi thì test đỏ
// đúng như kỳ vọng.
function mocksForUnreachedShowMain(url) {
  if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 0 } };
  if (url === '/api/terminal') return { status: 200, body: { sessions: [] } };
  return null;
}

test('claim mã thất bại (410): không lưu token nào, ở lại màn hình đăng nhập', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') return { status: 410, body: { error: 'code hết hạn hoặc đã dùng' } };
    return mocksForUnreachedShowMain(url) || { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, search: '?login=xyz' });
  page.byId.main.classList.add('hidden'); // trạng thái ban đầu thật: #main ẩn

  await flush();

  assert.equal(page.localStorage.getItem('ccrc_token'), null,
    'claim hỏng thì không được đăng nhập nửa vời — không token nào được lưu');
  assert.equal(page.byId.main.classList.contains('hidden'), true,
    'không được lộ màn hình chính khi claim thất bại');
  assert.equal(page.byId.login.classList.contains('hidden'), false,
    'phải ở lại màn hình đăng nhập');
});

test('claim mã thất bại (ok:false ở body dù status 200) cũng không lưu token', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') return { status: 200, body: { ok: false } };
    return mocksForUnreachedShowMain(url) || { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, search: '?login=xyz' });
  page.byId.main.classList.add('hidden');

  await flush();

  assert.equal(page.localStorage.getItem('ccrc_token'), null);
  assert.equal(page.byId.main.classList.contains('hidden'), true);
});

// --- 4. /link định tuyến vào thẻ duyệt máy dev ------------------------------

test("location.pathname === '/link' và đã đăng nhập → hiện thẳng thẻ duyệt, không phải màn hình chính", async () => {
  // Cần flush(): bootstrap gọi consumeLoginCode() TRƯỚC nhánh /link (để một
  // ngày nào đó hub redirect về `/link?login=` thì mã vẫn được đổi thay vì
  // nằm phơi trên thanh địa chỉ), nên showLink() rơi sau một nhịp microtask
  // dù bản thân nó vẫn không await gì.
  const page = loadAppPage({ pathname: '/link', token: 'tok-x' });
  await flush();
  assert.equal(page.byId.main.classList.contains('hidden'), true);
  assert.equal(page.byId.login.classList.contains('hidden'), true);

  // #link-card của harness không có class 'hidden' ngay từ đầu (khác markup
  // thật, luôn có class="hidden") — kiểm tra "không hidden" ngay sau lúc nạp
  // trang không chứng minh được gì: xoá hẳn dòng
  // `$('link-card').classList.remove('hidden')` trong showLink() vẫn cho
  // cùng kết quả, vì mặc định của harness với "đã bị gỡ hidden" trông y hệt
  // nhau. Tự đặt lại đúng trạng thái ban đầu thật rồi gọi lại showLink() qua
  // context (hàm không giữ state riêng, gọi lại vô hại) để quan sát một
  // chuyển trạng thái thật — điều đúng ra bootstrap ở trên đã làm nhưng
  // harness không cho thấy được.
  page.byId['link-card'].classList.add('hidden');
  page.context.showLink();
  assert.equal(page.byId['link-card'].classList.contains('hidden'), false,
    'showLink() phải lộ thẻ duyệt khi đã đăng nhập');
});

test("location.pathname === '/link' nhưng CHƯA đăng nhập → quay về màn hình đăng nhập, không hiện thẻ duyệt", async () => {
  // showLink() chạy trọn vẹn ĐỒNG BỘ (không await gì) — không có khe hở nào
  // giữa lúc loadAppPage() trả về và lúc code đã chạy xong để tự đặt lại
  // class ban đầu cho #link-card (khác với các test Slack bên dưới, nơi
  // request /api/auth/config còn treo qua một nhịp async). Vì #link-card của
  // harness vốn dĩ không có class 'hidden' (mặc định trần), kiểm tra nó
  // KHÔNG bao giờ được remove('hidden') ở đây sẽ không phân biệt được đúng/
  // sai — bỏ qua, chỉ kiểm phần có ý nghĩa: nhánh `if (!token)` phải THỰC SỰ
  // chạy `classList.remove('hidden')` trên #login sau khi đã add('hidden') ở
  // trên nó. Nếu nhánh đó bị xoá mất, #login sẽ dừng ở hidden=true — khác
  // với mặc định false — nên vẫn bắt được lỗi.
  const page = loadAppPage({ pathname: '/link' }); // token mặc định rỗng
  await flush();
  assert.equal(page.byId.login.classList.contains('hidden'), false,
    'chưa có token thì phải quay lại màn hình đăng nhập, không được kẹt ở trạng thái ẩn');
  assert.equal(page.byId.main.classList.contains('hidden'), true);
});

// --- 5. link-btn: duyệt một máy dev đang chờ --------------------------------
//
// $('link-btn').onclick được gán đồng bộ ngay lúc script nạp — gọi thẳng
// page.byId['link-btn'].onclick() và await nó, đúng idiom app-devices.test.js
// đã dùng cho 'devices-toggle'. Không cần flush(): onclick tự nó là hàm async,
// await trực tiếp promise nó trả về là đủ.

test('link-btn: duyệt thành công → hiện thông báo, xoá trắng ô nhập mã', async () => {
  let approveBody = null;
  const fetchImpl = makeFetch(async (url, opts) => {
    if (url === '/api/device/approve') {
      approveBody = JSON.parse(opts.body);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link', token: 'tok-x' });
  // #link-msg thật bắt đầu ẩn (class="dim hidden" trong index.html) — harness
  // dựng phần tử trần nên phải tự đặt lại, cùng lý do đã áp dụng cho #main/
  // #slack-login/#link-card ở trên: không seed thì "hiện thông báo" và "chưa
  // từng bị đụng tới" lẫn lộn nhau.
  page.byId['link-msg'].classList.add('hidden');
  page.byId['link-code'].value = '  ABCD-1234  ';

  await page.byId['link-btn'].onclick();

  assert.deepEqual(approveBody, { userCode: 'ABCD-1234' }, 'phải trim khoảng trắng trước khi gửi lên hub');
  assert.equal(page.byId['link-msg'].classList.contains('hidden'), false, 'phải hiện thông báo thành công');
  assert.match(page.byId['link-msg'].textContent, /Đã duyệt/);
  assert.equal(page.byId['link-code'].value, '', 'phải xoá trắng ô nhập sau khi duyệt xong');
});

test('link-btn: mã sai (400) → hiện đúng lỗi máy chủ trả về, không phải câu cố định', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/device/approve') {
      // `remaining` là phần hub cố ý gửi kèm để người dùng biết còn mấy lần
      // thử — nếu client bỏ qua body.error và tự bịa một câu chung chung,
      // thông tin đó biến mất mà không assertion nào ở đây phát hiện được
      // nếu chỉ kiểm "có hiện lỗi hay không". Phải kiểm ĐÚNG NGUYÊN VĂN.
      return { status: 400, body: { error: 'Mã không đúng, còn 2 lần thử', remaining: 2 } };
    }
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link', token: 'tok-x' });
  page.byId['link-err'].classList.add('hidden'); // #link-err thật bắt đầu ẩn
  page.byId['link-code'].value = 'WRONG';

  await page.byId['link-btn'].onclick();

  assert.equal(page.byId['link-err'].classList.contains('hidden'), false, 'phải hiện lỗi');
  assert.equal(page.byId['link-err'].textContent, 'Mã không đúng, còn 2 lần thử',
    'phải hiện đúng nguyên văn lỗi server trả về, không phải câu cố định phía client');
});

test('link-btn: ô mã trống (hoặc chỉ khoảng trắng) → không gửi request nào cả', async () => {
  let called = false;
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/device/approve') called = true;
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link', token: 'tok-x' });
  page.byId['link-code'].value = '   '; // chỉ khoảng trắng — coi như trống sau trim()

  await page.byId['link-btn'].onclick();

  assert.equal(called, false, 'không được gọi hub khi chưa nhập mã gì');
});

// --- bonus: nút Slack chỉ hiện khi hub thật sự cấu hình được ---------------
//
// Không nằm trong 4 mục coordinator liệt kê, nhưng cùng file test IIFE hỏi
// /api/auth/config ở đầu app.js — giữ nó có test luôn để không lặp lại đúng
// finding "logic mới không có test nào" cho khối này.

// `/api/auth/config` chỉ được đọc SAU một `await`, nên (khác với showLink() ở
// trên) có đúng một khe hở giữa lúc loadAppPage() trả về (script đã chạy tới
// điểm treo ở await fetch) và lúc code chạm vào #slack-login. Tận dụng khe đó
// để tự đặt lại class 'hidden' ban đầu cho #slack-login — đúng như markup
// thật (`class="hidden"` trong index.html) — trước khi flush() cho IIFE chạy
// tiếp. Không làm vậy thì assertion "phải hiện/ẩn" không có ý nghĩa: harness
// dựng phần tử trần, không class nào, nên "ẩn" và "chưa từng bị đụng tới" lẫn
// lộn với nhau.
function seedSlackButtonHidden(page) {
  page.byId['slack-login'].classList.add('hidden');
  return page;
}

test('hub có cấu hình Slack → nút Slack hiện ra, còn "hoặc" vẫn còn (đường dán token cũ vẫn sống)', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/config') return { status: 200, body: { slackLogin: true } };
    return { status: 404, body: {} };
  });
  const page = seedSlackButtonHidden(loadAppPage({ fetchImpl }));
  await flush();
  assert.equal(page.byId['slack-login'].classList.contains('hidden'), false, 'phải hiện nút Slack');
  assert.equal(page.byId['login-or'].classList.contains('hidden'), false,
    '"hoặc" vẫn phải còn — đường dán token cũ không được rút đi');
});

test('hub KHÔNG có cấu hình Slack → nút Slack ẩn, "hoặc" cũng ẩn, ô dán token vẫn dùng được', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/config') return { status: 200, body: { slackLogin: false } };
    return { status: 404, body: {} };
  });
  const page = seedSlackButtonHidden(loadAppPage({ fetchImpl }));
  await flush();
  assert.equal(page.byId['slack-login'].classList.contains('hidden'), true, 'không cấu hình thì nút phải ẩn');
  assert.equal(page.byId['login-or'].classList.contains('hidden'), true);
});

test('GET /api/auth/config lỗi mạng → im lặng, ẩn "hoặc" và để nguyên ô dán token', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/config') throw new Error('network down');
    return { status: 404, body: {} };
  });
  const page = seedSlackButtonHidden(loadAppPage({ fetchImpl }));
  await flush();
  assert.equal(page.byId['slack-login'].classList.contains('hidden'), true, 'lỗi mạng thì không được hiện nút Slack');
  assert.equal(page.byId['login-or'].classList.contains('hidden'), true);
  // Không kiểm `token.disabled` ở đây: không dòng nào trong app.js từng đụng
  // tới thuộc tính đó — assertion kiểu vậy đúng (`false`) bất kể code có bug
  // hay không, cùng dạng "harness mặc định trùng khớp kết quả mong đợi" mà
  // #link-card từng dính. Việc thật cần chứng minh — nhánh lỗi mạng không
  // ném lỗi ra ngoài, không làm hỏng phần còn lại của trang — đã được chứng
  // minh gián tiếp: hai assertion phía trên chạy được nghĩa là IIFE không
  // crash và các phần tử khác vẫn cập nhật đúng.
});

// --- /link không được là ngõ cụt --------------------------------------------
//
// showLink() đã đúng khi đẩy người chưa đăng nhập về thẻ đăng nhập. Cái sai
// nằm ở bước SAU đó: mọi lối đăng nhập đều gọi showMain(), nên người dùng
// đứng ở URL /link mà nhìn màn hình thông báo — không còn ô nhập mã, không có
// gì bảo họ nạp lại trang, trong khi máy dev vẫn đang đếm giây chờ được duyệt.

test('/link + dán token tay: đăng nhập xong quay lại ĐÚNG thẻ duyệt, không phải màn hình chính', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 0 } };
    if (url === '/api/terminal') return { status: 200, body: { sessions: [] } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link' });   // chưa đăng nhập
  await flush();
  // Trạng thái ban đầu thật của markup: cả #main lẫn #link-card đều hidden.
  page.byId.main.classList.add('hidden');
  page.byId['link-card'].classList.add('hidden');

  page.byId.token.value = 'tok-x';
  await page.byId['login-btn'].onclick();

  assert.equal(page.byId['link-card'].classList.contains('hidden'), false,
    'phải quay lại thẻ duyệt — họ vào /link vì có một máy dev đang chờ');
  assert.equal(page.byId.main.classList.contains('hidden'), true,
    'không được ném sang màn hình thông báo với URL vẫn là /link');
  assert.equal(page.byId.login.classList.contains('hidden'), true);
  assert.equal(page.localStorage.getItem('ccrc_token'), 'tok-x');
});

test('/link + token SAI: vẫn báo lỗi ngay, không lặng lẽ hiện thẻ duyệt', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/me') return { status: 401, body: { ok: false } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link' });
  await flush();
  page.byId['link-card'].classList.add('hidden');
  page.byId['login-err'].classList.add('hidden');

  page.byId.token.value = 'tok-sai';
  await page.byId['login-btn'].onclick();

  assert.equal(page.byId['login-err'].classList.contains('hidden'), false,
    'showLink() không gọi hub, nên nếu không tự thử token thì lỗi chỉ lộ ra ở lần bấm Duyệt');
  assert.equal(page.byId['link-card'].classList.contains('hidden'), true);
  assert.equal(page.localStorage.getItem('ccrc_token'), null, 'token sai thì không được lưu');
});

test('/link kèm ?login=<claimCode>: đổi mã rồi ở lại thẻ duyệt', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/auth/claim') return { status: 200, body: { ok: true, token: 'tok-slack', displayName: 'huy' } };
    if (url === '/api/me') return { status: 200, body: { user: 'huy', pushDevices: 0 } };
    if (url === '/api/terminal') return { status: 200, body: { sessions: [] } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link', search: '?login=abc123' });
  page.byId.main.classList.add('hidden');
  page.byId['link-card'].classList.add('hidden');

  await flush();

  assert.equal(page.localStorage.getItem('ccrc_token'), 'tok-slack',
    'mã phải được đổi — bỏ qua nó là để một claimCode còn sống nằm phơi trên thanh địa chỉ');
  assert.equal(page.byId['link-card'].classList.contains('hidden'), false);
  assert.equal(page.byId.main.classList.contains('hidden'), true);
});

// 401 trong lúc bấm Duyệt gọi thẳng logout(). Thiếu phần ẩn #link-card thì hai
// thẻ nằm chồng lên nhau và người dùng thấy cả ô nhập mã lẫn ô dán token.
test('401 khi duyệt → logout() ẩn CẢ thẻ duyệt, không để hai thẻ chồng nhau', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/device/approve') return { status: 401, body: { ok: false } };
    return { status: 404, body: {} };
  });
  const page = loadAppPage({ fetchImpl, pathname: '/link', token: 'tok-cu' });
  await flush();
  assert.equal(page.byId['link-card'].classList.contains('hidden'), false, 'tiền đề: đang ở thẻ duyệt');

  page.byId['link-code'].value = 'ABCD-1234';
  await page.byId['link-btn'].onclick().catch(() => { /* api() ném sau khi logout() */ });

  assert.equal(page.byId['link-card'].classList.contains('hidden'), true,
    'thẻ duyệt phải biến mất cùng phiên đăng nhập');
  assert.equal(page.byId.login.classList.contains('hidden'), false, 'và thẻ đăng nhập phải hiện ra');
  assert.equal(page.localStorage.getItem('ccrc_token'), null);
});

// --- thẻ "Duyệt máy dev" trong app ------------------------------------------
//
// Trang /link ở trên chỉ với tới được người mở bằng trình duyệt. Người đã cài
// PWA — đúng đối tượng hướng dẫn nhắm tới — không gõ được URL trong app
// standalone, và iOS không deep-link vào web app đã cài, nên với họ /link là
// ngõ cụt. Thẻ gập trong màn hình chính là chỗ vào duy nhất của họ.

function seedApproveCollapsed(page) {
  // Giống #link-msg ở trên: harness dựng phần tử trần nên "đang gập" và "chưa
  // ai đụng tới" lẫn vào nhau. Markup thật mở đầu bằng class="hidden".
  page.byId['approve-body'].classList.add('hidden');
  page.byId['approve-msg'].classList.add('hidden');
  page.byId['approve-err'].classList.add('hidden');
  return page;
}

test('thẻ duyệt trong app: bấm Mở thì bung ra, đổi nhãn, và đưa con trỏ vào ô nhập', () => {
  const page = seedApproveCollapsed(loadAppPage({ token: 'tok-x' }));

  assert.equal(page.byId['approve-body'].classList.contains('hidden'), true, 'mặc định phải gập');

  page.byId['approve-toggle'].onclick();
  assert.equal(page.byId['approve-body'].classList.contains('hidden'), false, 'bấm Mở phải bung ra');
  assert.equal(page.byId['approve-toggle'].textContent, 'Đóng');
  assert.equal(page.byId['approve-code'].focused, true,
    'phải focus ô nhập — mở xong còn phải chạm thêm lần nữa là mất đúng cái tiện của thẻ này');

  page.byId['approve-toggle'].onclick();
  assert.equal(page.byId['approve-body'].classList.contains('hidden'), true, 'bấm lần nữa phải gập lại');
  assert.equal(page.byId['approve-toggle'].textContent, 'Mở');
});

test('thẻ duyệt trong app: duyệt thành công gọi đúng API và dọn ô nhập', async () => {
  let approveBody = null;
  const fetchImpl = makeFetch(async (url, opts) => {
    if (url === '/api/device/approve') {
      approveBody = JSON.parse(opts.body);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: {} };
  });
  const page = seedApproveCollapsed(loadAppPage({ fetchImpl, token: 'tok-x' }));
  page.byId['approve-code'].value = '  ABCD-1234  ';

  await page.byId['approve-btn'].onclick();

  assert.deepEqual(approveBody, { userCode: 'ABCD-1234' }, 'phải trim khoảng trắng như đường /link');
  assert.equal(page.byId['approve-msg'].classList.contains('hidden'), false, 'phải hiện thông báo thành công');
  assert.match(page.byId['approve-msg'].textContent, /Đã duyệt/);
  assert.equal(page.byId['approve-code'].value, '', 'phải xoá trắng ô nhập sau khi duyệt xong');
  assert.equal(page.byId['approve-err'].classList.contains('hidden'), true, 'không được hiện lỗi');
});

test('thẻ duyệt trong app: mã sai thì hiện lỗi của hub và GIỮ NGUYÊN mã để sửa', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/device/approve') return { status: 400, body: { error: 'Mã không đúng hoặc đã hết hạn.' } };
    return { status: 404, body: {} };
  });
  const page = seedApproveCollapsed(loadAppPage({ fetchImpl, token: 'tok-x' }));
  page.byId['approve-code'].value = 'WRNG-0000';

  await page.byId['approve-btn'].onclick();

  assert.equal(page.byId['approve-err'].classList.contains('hidden'), false);
  assert.match(page.byId['approve-err'].textContent, /hết hạn/);
  assert.equal(page.byId['approve-code'].value, 'WRNG-0000',
    'gõ nhầm một ký tự mà bị xoá sạch là bắt gõ lại cả mã');
  assert.equal(page.byId['approve-msg'].classList.contains('hidden'), true);
});

test('hai đường duyệt độc lập: bấm ở thẻ trong app không đụng tới phần tử của trang /link', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url === '/api/device/approve') return { status: 200, body: { ok: true } };
    return { status: 404, body: {} };
  });
  const page = seedApproveCollapsed(loadAppPage({ fetchImpl, token: 'tok-x' }));
  page.byId['link-msg'].classList.add('hidden');
  page.byId['approve-code'].value = 'ABCD-1234';

  await page.byId['approve-btn'].onclick();

  assert.equal(page.byId['link-msg'].classList.contains('hidden'), true,
    'thông báo của /link không được sáng lên vì một cú bấm ở thẻ trong app');
  assert.equal(page.byId['approve-msg'].classList.contains('hidden'), false);
});
