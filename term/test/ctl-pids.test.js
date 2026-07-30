// Điều kiện chờ "đường tiếp sức đã dựng xong" phải nhận ĐÚNG tiến trình
// `tmux -C attach-session`, không phải bất kỳ con nào của daemon.
//
// Vì sao có file này: ba chỗ trong daemon.test.js chờ bằng
// `childPids(daemon.pid).length > 0` và tự mô tả là chờ "tiến trình tmux -C",
// nhưng daemon sinh RẤT NHIỀU tiến trình `tmux` ngắn hạn trước đó — mọi hàm
// trong src/tmux.js đều đi qua execFileSync, và đường dựng kết nối gọi
// snapshotPane, reclaimPaneSession, claimGroupName, createGroupSession trước
// khi spawn ctl (ccrc-term.js: 348, 362, 373, 379 rồi mới 392). `pgrep -P`
// không phân biệt được.
//
// Hệ quả đo được: máy rảnh, mỗi execFileSync sống vài ms nên pgrep (bản thân
// là một tiến trình phải spawn + đọc output, ~10-20ms) gần như luôn bỏ sót
// chúng và chỉ bắt được ctl → test pass. Máy tải, chúng sống lâu hơn, pgrep
// bắt gặp → test tưởng đã dựng xong, giết pane khi daemon còn đang ở giữa
// khối dựng, và nhận mã đóng 1011 ('pane đã chết', ccrc-term.js:364) thay vì
// 4001. Đo: rảnh 8/8 lần bắt đúng ctl, tải cao 13/14 lần bắt một pid đã thoát
// ngay — thứ không thể là ctl, vì ctl sống suốt kết nối.
//
// Test dưới đây không cần tải để chứng minh điều đó: nó dựng thẳng hình dạng
// gây lỗi — một tiến trình tmux con SỐNG LÂU mà không phải ctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { tmuxBin } from '../src/tmux.js';
import { childPids, ctlPids, waitCtlPids, sleep } from './helpers.mjs';

// Một tiến trình cha có đúng một con tmux, để so childPids với ctlPids trên
// cùng một cha. `args` là mảng tham số tmux mà con sẽ chạy.
//
// `detached: true` là bắt buộc, không phải tuỳ chọn: nó làm `parent` thành
// trưởng nhóm tiến trình CỦA CHÍNH NÓ, và chỉ khi đó `process.kill(-pid)` mới
// với tới đứa con. Không có nó, `-pid` không trỏ vào nhóm nào của ta cả, cú
// group-kill lặng lẽ trượt, `parent` chết một mình và đứa con tmux — vốn chờ
// vô hạn — được init nhận nuôi rồi sống mãi, mỗi con giữ một pty. Bản đầu của
// file này thiếu đúng dòng này và bỏ lại 8 tiến trình `tmux wait-for` orphan
// chỉ sau vài lần chạy; giới hạn của máy là 511 pty (kern.tty.ptmx_max), nên
// một leak cỡ đó không phải chuyện gọn gàng mà là thứ làm cả suite gãy với
// "fork failed: Device not configured".
async function withTmuxChild(args, fn) {
  const T = tmuxBin();
  // Cha là node, không phải shell: shell có thể exec-thay-thế chính nó bằng
  // tmux và khi đó không còn quan hệ cha-con nào để đo.
  const parent = spawn(process.execPath, [
    '-e',
    `const { spawn } = require('node:child_process');
     const c = spawn(${JSON.stringify(T)}, ${JSON.stringify(args)}, { stdio: ['pipe', 'ignore', 'ignore'] });
     // Chốt an toàn cuối: nếu cú group-kill phía test có trượt vì lý do nào
     // đi nữa, tiến trình này vẫn tự dọn con rồi thoát thay vì để nó ở lại
     // giữ một pty vĩnh viễn.
     setTimeout(() => { try { c.kill('SIGKILL'); } catch {} process.exit(0); }, 20000);`,
  ], { stdio: 'ignore', detached: true });
  try {
    // Chờ con xuất hiện thật, không ngủ một khoảng cố định rồi hy vọng.
    for (let i = 0; i < 200 && childPids(parent.pid).length === 0; i += 1) await sleep(20);
    await fn(parent);
  } finally {
    // Giết con TRƯỚC, theo pid đọc được, rồi mới tới nhóm và cha. Thứ tự này
    // để việc dọn không phụ thuộc vào đúng một cơ chế: nếu group-kill trượt
    // thì vòng lặp này đã xử lý xong, và ngược lại.
    for (const pid of childPids(parent.pid)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* đã thoát */ }
    }
    try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
    try { parent.kill('SIGKILL'); } catch {}
  }
}

test('ctlPids nhận ra tiến trình `tmux -C attach-session` thật', async () => {
  const T = tmuxBin();
  const sess = `ctlpids-yes-${process.pid}`;
  execFileSync(T, ['new-session', '-d', '-s', sess, '-x', '80', '-y', '24']);
  try {
    await withTmuxChild(['-C', 'attach-session', '-t', sess], async (parent) => {
      const pids = await waitCtlPids(parent, 10_000);
      assert.ok(pids.length > 0, 'phải thấy đúng tiến trình ctl');
      assert.deepEqual(ctlPids(parent.pid), pids, 'ctlPids và waitCtlPids phải nói cùng một điều');
    });
  } finally {
    try { execFileSync(T, ['kill-session', '-t', sess]); } catch {}
  }
});

// Đây là bài bắt đúng lỗi. `tmux wait-for` là một tiến trình tmux SỐNG LÂU
// (nó chặn tới khi có ai đó signal cùng channel) nhưng KHÔNG phải ctl — đúng
// vai của những tiến trình tmux mà daemon sinh ra trong lúc dựng kết nối, chỉ
// khác là nó sống lâu nên không cần tải để bắt gặp.
test('ctlPids KHÔNG nhận tiến trình tmux khác, dù childPids vẫn thấy nó', async () => {
  await withTmuxChild(['wait-for', `ctlpids-kenh-${process.pid}`], async (parent) => {
    assert.ok(childPids(parent.pid).length > 0,
      'điều kiện đầu vào: childPids PHẢI thấy tiến trình này — nếu không thì bài test chưa dựng được hình dạng gây lỗi');
    assert.deepEqual(ctlPids(parent.pid), [],
      'một tiến trình tmux không phải ctl không được tính là "đường tiếp sức đã dựng xong" — đây chính là thứ làm test PANE CHẾT giết pane quá sớm');
  });
});

test('waitCtlPids hết hạn thì ném lỗi nói rõ, không trả về mảng rỗng lặng lẽ', async () => {
  await withTmuxChild(['wait-for', `ctlpids-hethan-${process.pid}`], async (parent) => {
    await assert.rejects(
      () => waitCtlPids(parent, 300),
      // Một điều kiện chờ hết hạn mà trả về "không có gì" thì chỗ gọi sẽ đi
      // tiếp như thể mọi thứ ổn — đúng cái làm hỏng test PANE CHẾT. Phải ném.
      /không thấy tiến trình `tmux -C`/,
      'hết hạn phải là lỗi ồn ào, không phải một mảng rỗng trông như hợp lệ',
    );
  });
});
