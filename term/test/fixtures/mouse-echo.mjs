// A tiny terminal application that does exactly what Claude Code does at the
// level this project cares about: takes the alternate screen, switches mouse
// reporting on, and reacts to what it is sent.
//
// It exists so a test can assert the bytes ARRIVE and are decodable, rather
// than assert that some real application happened to change its screen — which
// is a proxy, and a flaky one.
//
// Prints one line per event it understands, so `capture-pane` shows it.
process.stdout.write('\x1b[?1049h'); // alternate screen — the shape that has no tmux scrollback
process.stdout.write('\x1b[?1000h'); // report button presses
process.stdout.write('\x1b[?1002h'); // …and drags
process.stdout.write('\x1b[?1006h'); // SGR encoding
process.stdout.write('\x1b[2J\x1b[H');
process.stdout.write('SAN SANG\r\n');

let buf = '';
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('binary');
  // SGR: ESC [ < btn ; col ; row (M|m)
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m;
  let last = 0;
  while ((m = re.exec(buf)) !== null) {
    const [, btn, col, row, kind] = m;
    const name = btn === '64' ? 'WHEEL-UP'
      : btn === '65' ? 'WHEEL-DOWN'
      : kind === 'M' ? 'PRESS'
      : 'RELEASE';
    process.stdout.write(`${name} btn=${btn} col=${col} row=${row}\r\n`);
    last = re.lastIndex;
  }
  if (last) buf = buf.slice(last);
  // Never let a partial or unrecognised sequence accumulate forever.
  if (buf.length > 256) buf = '';
});
