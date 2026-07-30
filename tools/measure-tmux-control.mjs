// Đo: `tmux -C` (control mode) có stream được output của pane qua stdio không.
// Nếu ĐƯỢC, daemon không cần node-pty — không thêm native dependency nào.
// Nếu KHÔNG, phải dùng node-pty (native module, phải build).
import { spawn } from 'node:child_process';

const S = `ccrc-ctl-${process.pid}`;
const run = (args) => new Promise((r) => spawn('tmux', args, { stdio: 'ignore' }).on('exit', r));

await run(['kill-session', '-t', S]);
await run(['new-session', '-d', '-s', S, '-x', '80', '-y', '24']);

const ctl = spawn('tmux', ['-C', 'attach-session', '-t', S], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let saw = '';
ctl.stdout.on('data', (b) => { saw += b.toString(); });

// Gõ một chuỗi nhận dạng vào pane rồi xem control mode có phát lại không.
setTimeout(() => {
  ctl.stdin.write('send-keys -t %0 "echo CCRC_MARKER_OK" Enter\n');
}, 500);

setTimeout(async () => {
  ctl.kill();
  await run(['kill-session', '-t', S]);
  const hasOutput = saw.includes('%output');
  const hasMarker = saw.includes('CCRC_MARKER_OK');
  console.log('có dòng %output:', hasOutput);
  console.log('thấy chuỗi nhận dạng:', hasMarker);
  console.log(hasOutput && hasMarker
    ? 'KẾT LUẬN: ĐẠT — dùng control mode, KHÔNG cần node-pty'
    : 'KẾT LUẬN: HỎNG — phải dùng node-pty');
  console.log('--- 600 ký tự đầu của stdout ---');
  console.log(saw.slice(0, 600));
  process.exit(0);
}, 2500);
