// Task 3's brief calls out, by name, "a pane that has died between
// registration and the tmux query" as an edge case that must not throw.
// Real tmux gives no way to land exactly in that gap on demand — the two
// tmux calls paneCwd() makes (paneAlive's #{pane_id} check, then the
// #{pane_current_path} query) are each a few milliseconds and nothing this
// test controls can reliably land a real pane's death between them.
//
// So this simulates the race deterministically with a fake `tmux` binary
// (CCRC_TMUX_BIN): it answers the alive-check honestly (pane exists), then
// fails the very next call (pane gone) — exactly the sequence a real crash
// between the two calls would produce.
//
// This file is deliberately separate from tmux.test.js: tmux.js's own
// tmuxBin() resolves and CACHES a binary on its first call, and every other
// test file in this suite already runs against the REAL tmux — sharing a
// process with them would either poison their cache with this fake binary
// or (if they ran first) make CCRC_TMUX_BIN here arrive too late to matter.
// node's test runner gives each test FILE its own process, so setting the
// env var before this file's first tmux.js call is enough.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-fake-tmux-'));
const bin = path.join(dir, 'fake-tmux');
// Reads the -t target and the trailing format argument itself, rather than
// assuming a fixed argv shape, so it keeps working if paneAlive/paneCwd's
// call shape ever changes slightly.
fs.writeFileSync(bin, `#!/bin/sh
target=""
prev=""
last=""
for arg in "$@"; do
  if [ "$prev" = "-t" ]; then target="$arg"; fi
  prev="$arg"
  last="$arg"
done
case "$last" in
  '#{pane_id}')
    # Honest alive-check: the pane exists and reports its own id back.
    echo "$target"
    exit 0
    ;;
  '#{pane_current_path}')
    # The pane died in the gap right after the alive-check above returned —
    # the exact race the brief describes.
    echo "phien da chet giua luc kiem tra va luc hoi duong dan" >&2
    exit 1
    ;;
esac
exit 1
`, { mode: 0o755 });
process.env.CCRC_TMUX_BIN = bin;

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const { paneCwd } = await import('../src/tmux.js');

test('paneCwd không ném lỗi khi pane chết ĐÚNG giữa lúc kiểm tra còn sống và lúc hỏi #{pane_current_path}', () => {
  assert.doesNotThrow(() => paneCwd('%42'));
  assert.equal(paneCwd('%42'), '',
    'phải trả về rỗng, không được ném lỗi làm hỏng cả nhịp tim đăng ký');
});
