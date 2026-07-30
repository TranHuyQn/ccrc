// Wires a tmux -C control-mode child's stdout to a per-connection output
// callback: buffers partial lines across 'data' events, and hands the
// callback only fully-formed `%output %<pane> <bytes>` payloads for the pane
// it cares about, already un-escaped.
//
// `stdout.setEncoding('utf8')` matters specifically here: without it, each
// 'data' event delivers a raw Buffer, and a naive per-chunk `.toString()`
// corrupts any multi-byte UTF-8 character whose bytes happen to fall across
// a chunk boundary — the decoder has no memory of the previous chunk, so the
// dangling lead byte(s) decode to U+FFFD instead of waiting for the rest.
// `setEncoding('utf8')` wires in Node's own StringDecoder, which buffers an
// incomplete trailing multi-byte sequence until the remaining bytes arrive
// in a later chunk.
export function attachControlOutput(stdout, paneId, onOutput) {
  stdout.setEncoding('utf8');
  // %output lines can split across two 'data' events (e.g. mid-escape-code
  // under load). Carry any trailing partial line over to the next chunk
  // instead of dropping it.
  let buf = '';
  stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      // %output %<pane> <octal-escaped bytes>
      if (!line.startsWith('%output ')) continue;
      const sp = line.indexOf(' ', 8);
      if (sp < 0) continue;
      if (line.slice(8, sp) !== paneId) continue;
      onOutput(unescapeOctal(line.slice(sp + 1)));
    }
  });
}

function unescapeOctal(s) {
  return s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}
