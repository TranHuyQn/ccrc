import test, { coTmuxDungDuoc } from './can-tmux.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmuxBin, hasSession, GROUP_MARKER_OPTION } from '../src/tmux.js';
import { createTmuxPaneSource } from '../src/pane-source.js';

const T = coTmuxDungDuoc ? tmuxBin() : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// tmux.test.js's multiLinePane documents this same machine characteristic:
// the shell in this environment can take well over a second to start
// accepting/running input. A fixed sleep(300) after send-keys is therefore
// not reliable here — poll for the command's OWN OUTPUT as an exact row
// instead. Exact match (not substring) matters: send-keys places the
// literal, not-yet-executed command text on the pane immediately, and that
// text already contains the marker substring before Enter is even
// processed.
async function waitForLine(pane, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = execFileSync(T, ['capture-pane', '-p', '-e', '-J', '-t', pane], { encoding: 'utf8' });
    if (raw.split('\n').some((l) => stripAnsi(l).trimEnd() === marker)) return;
    if (Date.now() > deadline) throw new Error(`waitForLine: hết giờ chờ dòng "${marker}"`);
    await sleep(100);
  }
}

// Nhân bản có chủ ý của withSession trong tmux.test.js. Không rút ra dùng chung
// vì làm thế là sửa một file test đang xanh, mà cả kế hoạch này dựng trên việc
// 482 bài hiện có giữ nguyên làm mốc so sánh. Sáu dòng trùng rẻ hơn rủi ro đó.
//
// Khác một chỗ so với bản gốc: `async` + `await fn(...)`. Bản trong
// tmux.test.js chỉ từng được gọi với callback đồng bộ nên không lộ ra; ở đây
// vài bài truyền callback async, và thiếu `await` thì `finally` (kill-session)
// chạy ngay khi callback vừa gặp `await` đầu tiên — tức là phiên bị giết gần
// như lập tức, trước khi shell kịp xử lý bất cứ phím nào gửi vào.
async function withSession(fn) {
  const s = `ccrc-ps-${process.pid}-${Math.floor(process.uptime() * 1000)}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  try {
    const pane = execFileSync(T, ['list-panes', '-t', s, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();
    return await fn({ session: s, pane });
  } finally {
    try { execFileSync(T, ['kill-session', '-t', `=${s}`]); } catch {}
  }
}

test('alive() đúng cho pane sống và pane không tồn tại', async () => {
  await withSession(({ pane }) => {
    assert.equal(createTmuxPaneSource({ pane }).alive(), true);
    assert.equal(createTmuxPaneSource({ pane: '%999999' }).alive(), false);
  });
});

test('snapshot() chứa chữ đang hiện trên pane', async () => {
  await withSession(async ({ pane }) => {
    execFileSync(T, ['send-keys', '-t', pane, 'echo MOC-SNAPSHOT', 'Enter']);
    await waitForLine(pane, 'MOC-SNAPSHOT');
    const out = createTmuxPaneSource({ pane }).snapshot();
    assert.match(out, /MOC-SNAPSHOT/);
    // snapshotPane bọc bằng clear+home và đóng bằng SGR reset — hợp đồng này
    // là thứ trình duyệt dựa vào, không phải chi tiết trang trí.
    assert.ok(out.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
    assert.ok(out.endsWith('\x1b[0m'), 'phải đóng bằng SGR reset');
  });
});

test('historySize() tăng sau khi pane in nhiều dòng', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    execFileSync(T, ['send-keys', '-t', pane, 'for i in $(seq 1 60); do echo dong-$i; done', 'Enter']);
    await waitForLine(pane, 'dong-60');
    assert.ok(src.historySize() > 0, 'lịch sử phải khác 0 sau 60 dòng');
  });
});

test('history() trả về màn hình đã đóng khung, rỗng khi tham số vô lý', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    execFileSync(T, ['send-keys', '-t', pane, 'for i in $(seq 1 60); do echo dong-$i; done', 'Enter']);
    await waitForLine(pane, 'dong-60');
    const screen = src.history(10, 5);
    assert.ok(screen.startsWith('\x1b[2J\x1b[H'), 'phải mở bằng clear + home');
    // Số 0 và số âm là "không có gì để hỏi", không phải lỗi — trả chuỗi rỗng.
    assert.equal(src.history(0, 5), '');
    assert.equal(src.history(10, 0), '');
  });
});

test('mouseMode() báo không có chuột cho shell thường', async () => {
  await withSession(({ pane }) => {
    assert.deepEqual(createTmuxPaneSource({ pane }).mouseMode(), { mouse: false, sgr: false });
  });
});

test('mouseMode() trả về mặc định an toàn cho pane đã chết', () => {
  // Không biết thì KHÔNG gửi byte chuột — gửi nhầm là gõ rác vào shell người
  // dùng. Hướng an toàn duy nhất.
  assert.deepEqual(createTmuxPaneSource({ pane: '%999999' }).mouseMode(), { mouse: false, sgr: false });
});

test('cwd() và socket() trả về khoá đối chiếu của sổ tra phiên', async () => {
  await withSession(({ pane }) => {
    const src = createTmuxPaneSource({ pane });
    assert.ok(path.isAbsolute(src.cwd()), 'cwd phải là đường dẫn tuyệt đối');
    assert.ok(src.socket().length > 0, 'socket phải cho biết pane này thuộc server tmux nào');
  });
});

test('cwd() và socket() trả chuỗi rỗng cho pane đã chết, không ném', () => {
  // Pane chết là chuyện thường ngày (người dùng đóng Claude). Ném ở đây sẽ nổ
  // trong vòng poll 2 giây của daemon, ở một chỗ không ai bắt.
  const src = createTmuxPaneSource({ pane: '%999999' });
  assert.equal(src.cwd(), '');
  assert.equal(src.socket(), '');
});

test('attach() dựng phiên nhóm mang dấu của mình, conn cuối đóng thì dọn đi', async () => {
  await withSession(async ({ pane }) => {
    const runId = `${process.pid}-t2a`;
    const src = createTmuxPaneSource({ pane, runId });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    assert.equal(r.ok, true, r.message);
    await sleep(400);

    // Lọc theo runId của CHÍNH lần chạy này. `npm test` chạy
    // --test-concurrency=4 và tmux.test.js cũng tạo phiên mang dấu trên cùng
    // một tmux server — đếm tổng là bài đỏ ngẫu nhiên đang chờ xảy ra.
    const nhom = () => execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}\t#{session_name}`],
      { encoding: 'utf8' }).trim().split('\n')
      .filter((l) => l.split('\t')[0] === runId)
      .map((l) => l.split('\t')[1]);

    assert.equal(nhom().length, 1, 'đúng một phiên nhóm mang runId này');
    const ten = nhom()[0];

    r.conn.close();
    await sleep(400);
    assert.equal(hasSession(ten), false, 'conn cuối đóng thì phiên nhóm phải được dọn');
    // Pane của người dùng KHÔNG được chết theo. Giết phiên nhóm chỉ gỡ liên
    // kết, không phá cửa sổ — đây là chỗ dự án đã từng giết nhầm phiên sống.
    assert.equal(src.alive(), true, 'pane gốc phải còn nguyên');
  });
});

test('hai attach() dùng CHUNG một phiên nhóm, mỗi cái một ctl riêng', async () => {
  // Đây là bài canh đúng cái mà bản kế hoạch đầu tiên làm hỏng: phiên nhóm dựng
  // một lần, nhưng mỗi kết nối phải có ống ctl của riêng nó.
  await withSession(async ({ pane }) => {
    const runId = `${process.pid}-t2e`;
    const src = createTmuxPaneSource({ pane, runId });
    const a = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    const b = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(a.ok, true, a.message);
      assert.equal(b.ok, true, b.message);
      assert.notEqual(a.conn, b.conn, 'mỗi kết nối một handle riêng');
      await sleep(400);
      const dem = execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}`],
        { encoding: 'utf8' }).trim().split('\n').filter((l) => l === runId).length;
      assert.equal(dem, 1, 'hai kết nối vẫn chỉ MỘT phiên nhóm');

      // Đóng một cái không được kéo cái kia xuống theo.
      a.conn.close();
      await sleep(300);
      assert.equal(src.alive(), true, 'pane còn sống sau khi một kết nối đóng');
      const conNhom = execFileSync(T, ['list-sessions', '-F', `#{${GROUP_MARKER_OPTION}}`],
        { encoding: 'utf8' }).trim().split('\n').filter((l) => l === runId).length;
      assert.equal(conNhom, 1, 'phiên nhóm phải sống tiếp khi vẫn còn kết nối khác');
    } finally {
      try { a.conn && a.conn.close(); } catch {}
      try { b.conn && b.conn.close(); } catch {}
    }
  });
});

test('attach() báo lỗi thay vì ném khi pane không tồn tại', () => {
  const src = createTmuxPaneSource({ pane: '%999999', runId: `${process.pid}-t2b` });
  const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
  assert.equal(r.ok, false);
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0, 'phải nói được vì sao');
});

test('onData nhận byte pane in ra', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t2c` });
    let thay = '';
    const r = src.attach({ onData: (d) => { thay += d; }, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      execFileSync(T, ['send-keys', '-t', pane, 'echo MOC-ONDATA', 'Enter']);
      // Chờ ĐIỀU KIỆN, không chờ một con số mili giây.
      const hetGio = Date.now() + 8000;
      while (!/MOC-ONDATA/.test(thay) && Date.now() < hetGio) await sleep(100);
      assert.match(thay, /MOC-ONDATA/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('onGone báo fatal:true khi pane chết hẳn', async () => {
  const s = `ccrc-ps-gone-${process.pid}`;
  execFileSync(T, ['new-session', '-d', '-s', s, '-x', '80', '-y', '24']);
  const pane = execFileSync(T, ['list-panes', '-t', s, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();
  const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t2d` });
  let bao = null;
  let r = null;
  try {
    r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: (e) => { bao = e; } });
    assert.equal(r.ok, true, r.message);
    await sleep(400);
    // `kill-pane`, KHÔNG phải `kill-session`. Đo được trên tmux của máy này:
    // giết phiên GỐC trong khi phiên nhóm vẫn giữ cùng cửa sổ thì PANE VẪN
    // SỐNG — nên `fatal:true` không bao giờ đạt tới theo đường đó, client
    // control-mode cũng không thoát, và bài test đứng chờ một sự kiện không
    // đến. Chỉ kill-pane mới thật sự huỷ pane ở mọi phiên đang giữ nó.
    execFileSync(T, ['kill-pane', '-t', pane]);
    const hetGio = Date.now() + 8000;
    while (bao === null && Date.now() < hetGio) await sleep(100);
    assert.ok(bao, 'phải gọi onGone');
    assert.equal(bao.fatal, true, 'pane chết là hết phiên, không phải trục trặc tạm');
  } finally {
    if (r && r.conn) r.conn.close();
    try { execFileSync(T, ['kill-session', '-t', `=${s}`]); } catch {}
  }
});

test('type() gõ chữ vào pane thật', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3a` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      r.conn.type(Buffer.from('echo MOC-TYPE\r', 'utf8'));
      await waitForLine(pane, 'MOC-TYPE');
      assert.match(src.snapshot(), /MOC-TYPE/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('paste() chỉ báo ack sau khi tmux xác nhận cả nội dung lẫn Enter', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3b` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      const ack = await new Promise((resolve, reject) => {
        const treo = setTimeout(() => reject(new Error('không nhận được ack')), 15000);
        r.conn.paste('echo MOC-PASTE', {
          onAck: () => { clearTimeout(treo); resolve(true); },
          onErr: (m) => { clearTimeout(treo); reject(new Error(m)); },
        });
      });
      assert.equal(ack, true);
      await waitForLine(pane, 'MOC-PASTE');
      assert.match(src.snapshot(), /MOC-PASTE/);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('mouse() không bị chặn sau một paste đang treo trong hàng đợi', async () => {
  // Chứng minh bằng THỨ TỰ GHI vào ống ctl.stdin, không bằng đua thời gian.
  // paste() xếp việc của nó vào typeQueue bằng .then() trên một promise ĐÃ
  // resolve — callback đó chỉ chạy ở microtask kế tiếp, và bên trong nó còn
  // phải spawn một tiến trình con (`load-buffer`) rồi đợi nó thoát trước khi
  // viết lệnh tmux đầu tiên. mouse(), nếu sửa đúng, viết lệnh của nó vào
  // ctl.stdin NGAY LẬP TỨC, TRONG CÙNG LƯỢT ĐỒNG BỘ gọi paste() — tức là
  // trước cả khi microtask của paste() kịp chạy. tmux xử lý lệnh trên một
  // ống điều khiển theo ĐÚNG thứ tự nhận, nên hai dòng lệnh gõ vào cùng một
  // pane phải hiện ra theo đúng thứ tự đó — không phụ thuộc máy nhanh hay
  // chậm. Nếu mouse() bị đổi lại thành đi qua typeQueue (conn.type), thứ tự
  // này đảo ngược và bài test đỏ chắc chắn, không phải thỉnh thoảng.
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t4a` });
    let thay = '';
    const r = src.attach({ onData: (d) => { thay += d; }, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);

      const pasteDone = new Promise((resolve, reject) => {
        const treo = setTimeout(() => reject(new Error('không nhận được ack cho paste')), 15000);
        r.conn.paste('echo MOC-PASTE-SAU-CHUOT', {
          onAck: () => { clearTimeout(treo); resolve(); },
          onErr: (m) => { clearTimeout(treo); reject(new Error(m)); },
        });
      });
      // Gọi NGAY sau, cùng lượt đồng bộ với paste() ở trên — đây chính là
      // điều kiện đua mà mouse() phải thắng nếu nó thật sự đi tắt.
      r.conn.mouse(Buffer.from('echo MOC-CHUOT-TRUOC\r', 'utf8'));

      await waitForLine(pane, 'MOC-CHUOT-TRUOC');
      await pasteDone;
      await waitForLine(pane, 'MOC-PASTE-SAU-CHUOT');

      const iChuot = thay.indexOf('MOC-CHUOT-TRUOC');
      const iPaste = thay.indexOf('MOC-PASTE-SAU-CHUOT');
      assert.ok(iChuot >= 0, 'byte chuột phải tới pane');
      assert.ok(iPaste >= 0, 'nội dung dán phải tới pane');
      assert.ok(iChuot < iPaste,
        'byte chuột phải tới pane TRƯỚC nội dung dán — nếu mouse() bị xếp ' +
        'vào typeQueue, nó sẽ tới SAU vì phải chờ paste xong trước.');
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});

test('resize() không giết gì cả', async () => {
  await withSession(async ({ pane }) => {
    const src = createTmuxPaneSource({ pane, runId: `${process.pid}-t3c` });
    const r = src.attach({ onData: () => {}, onCtlReply: () => {}, onGone: () => {} });
    try {
      assert.equal(r.ok, true, r.message);
      await sleep(300);
      r.conn.resize(60, 20);
      await sleep(500);
      // Không khẳng định con số cụ thể của pane: tmux quyết kích thước theo mọi
      // client đang gắn, và trong test không có client thật nào ngồi trước
      // phiên gốc. Chỉ khẳng định điều thật sự quan trọng.
      assert.equal(src.alive(), true);
    } finally {
      if (r.conn) r.conn.close();
    }
  });
});
