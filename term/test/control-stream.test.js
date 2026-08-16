import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { attachControlOutput } from '../src/control-stream.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Final fix wave, item 7: a multi-byte UTF-8 character split across two
// 'data' events on ctl.stdout used to decode to U+FFFD, because the old code
// called `chunk.toString()` on each raw Buffer independently — with no
// memory of a dangling lead byte from the previous chunk. The fix is
// `stdout.setEncoding('utf8')` (now inside attachControlOutput), which wires
// in Node's own StringDecoder to hold an incomplete trailing sequence over
// to the next chunk instead.
//
// This spawns a REAL child process and writes to a REAL OS pipe — the same
// mechanism ctl.stdout uses in production — with two separate write() calls
// deliberately cut inside a multi-byte character's bytes, so the split this
// test observes is the genuine article, not a simulation of one.
test('attachControlOutput ghép đúng ký tự UTF-8 đa byte bị cắt giữa hai lần write() trên stdout', async () => {
  const paneId = '%3';
  const text = 'xin chào các bạn 你好世界';
  const line = `%output ${paneId} ${text}\n`;
  const buf = Buffer.from(line, 'utf8');

  // Cut strictly inside a multi-byte UTF-8 sequence (a continuation byte,
  // 0b10xxxxxx) — this is the exact shape of split that corrupts a naive
  // per-chunk `.toString()`.
  let mid = -1;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i] & 0xc0) === 0x80) { mid = i; break; }
  }
  assert.ok(mid > 0, 'điều kiện đầu vào: dòng test phải chứa một ký tự đa byte để cắt giữa chừng');

  const child = spawn(process.execPath, ['-e', `
    const buf = Buffer.from(${JSON.stringify(line)}, 'utf8');
    process.stdout.write(buf.subarray(0, ${mid}));
    setTimeout(() => { process.stdout.write(buf.subarray(${mid})); }, 80);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });

  try {
    const received = [];
    attachControlOutput(child.stdout, paneId, (data) => received.push(data));

    await sleep(400);

    assert.equal(received.join(''), text,
      'chunk bị cắt giữa ký tự đa byte phải được ghép lại đúng, không sinh U+FFFD hay mất byte');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});

test('attachControlOutput bỏ qua dòng của pane khác', async () => {
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('%output %9 khong-phai-pane-nay\\n');
    process.stdout.write('%output %3 dung-pane-nay\\n');
  `], { stdio: ['ignore', 'pipe', 'ignore'] });

  try {
    const received = [];
    attachControlOutput(child.stdout, '%3', (data) => received.push(data));
    await sleep(300);
    assert.deepEqual(received, ['dung-pane-nay']);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});

// --- ghép lời đáp của tmux với đúng lệnh đã gửi ----------------------------
//
// tmux control mode trả lời MỖI lệnh bằng đúng một khối `%begin`…`%end` (xuôi)
// hoặc `%begin`…`%error` (bị từ chối), theo đúng thứ tự lệnh được gửi đi. Đó
// là thứ duy nhất cho phép daemon biết `paste-buffer` có thật sự được nhận hay
// không — trước đây nó chỉ đợi 30ms rồi tự tuyên bố là xong, tức là lại để một
// tín hiệu rẻ đứng thay thứ cần biết.

import { Readable } from 'node:stream';

// Các sự kiện 'data' tới bất đồng bộ, nên phải đợi stream cạn mới đọc được
// kết quả — đọc ngay sau push() thì lúc nào cũng thấy mảng rỗng.
function feed(chunks, paneId = '%1') {
  const replies = [];
  const output = [];
  const stream = new Readable({ read() {} });
  attachControlOutput(stream, paneId, (d) => output.push(d),
    (ok, message) => replies.push({ ok, message }));
  for (const c of chunks) stream.push(c);
  stream.push(null);
  return new Promise((resolve) => stream.on('end', () => resolve({ replies, output })));
}

test('mỗi khối trả lời gọi callback đúng một lần, theo đúng thứ tự lệnh', async () => {
  const { replies } = await feed([
    '%begin 1 100 1\n%end 1 100 1\n',
    '%begin 1 101 1\nno buffer ccrc-9\n%error 1 101 1\n',
    '%begin 1 102 1\n%end 1 102 1\n',
  ]);

  assert.deepEqual(replies.map((r) => r.ok), [true, false, true]);
  assert.match(replies[1].message, /no buffer/);
});

test('%output xen giữa các khối không làm lệch thứ tự trả lời', async () => {
  // Đây là hình dạng thật: pane vẫn đang in ra trong lúc daemon chờ tmux trả
  // lời. Một byte output bị đếm nhầm thành lời đáp là lệch cả hàng đợi, và từ
  // đó mọi lượt dán sau đều được ghép với lời đáp của lệnh khác.
  const { replies, output } = await feed([
    '%begin 1 100 1\n%end 1 100 1\n',
    '%output %1 xin chao\n',
    '%begin 1 101 1\nkhong dan duoc\n%error 1 101 1\n',
  ]);

  assert.deepEqual(replies.map((r) => r.ok), [true, false]);
  assert.deepEqual(output, ['xin chao']);
});
