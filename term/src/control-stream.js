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
/**
 * @param {import('node:stream').Readable} stdout
 * @param {string} paneId
 * @param {(data: string) => void} onOutput
 * @param {(ok: boolean, message: string) => void} [onReply] gọi MỘT lần cho
 *   mỗi lệnh daemon đã gửi, theo đúng thứ tự gửi: `ok=true` khi tmux nhận
 *   (`%end`), `ok=false` kèm nguyên văn lời từ chối khi không (`%error`).
 *   Đây là cách duy nhất biết một lệnh có thật sự được thực hiện hay không —
 *   ghi vào stdin của `tmux -C` luôn "thành công", kể cả với lệnh sẽ bị từ
 *   chối ngay sau đó.
 */
export function attachControlOutput(stdout, paneId, onOutput, onReply) {
  stdout.setEncoding('utf8');
  // %output lines can split across two 'data' events (e.g. mid-escape-code
  // under load). Carry any trailing partial line over to the next chunk
  // instead of dropping it.
  let buf = '';
  // Trả lời cho một lệnh là một khối: `%begin` … `%end` khi xuôi, `%error`
  // thay cho `%end` khi tmux từ chối. Trước bản này mọi dòng không phải
  // `%output` đều bị bỏ, nên lời từ chối biến mất — và vì daemon cũng chẳng
  // chờ đợi gì, phía người dùng ô soạn vẫn trống đi như đã gửi thành công.
  // Đó là kiểu hỏng tệ nhất: mất dữ liệu mà không ai biết để mà nghi.
  let block = null;
  stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('%begin')) { block = []; continue; }
      if (line.startsWith('%end')) {
        // Thân khối của một lệnh xuôi là OUTPUT của lệnh đó (vd
        // `display-message -p`), không phải lời báo lỗi.
        if (onReply) onReply(true, (block || []).join('\n'));
        block = null;
        continue;
      }
      if (line.startsWith('%error')) {
        // Nguyên văn của tmux nằm trong THÂN khối, không nằm trên dòng
        // `%error` (dòng đó chỉ có timestamp/số lệnh/cờ).
        if (onReply) onReply(false, (block || []).join(' ').trim() || 'tmux từ chối lệnh');
        block = null;
        continue;
      }
      // %output %<pane> <octal-escaped bytes>
      if (line.startsWith('%output ')) {
        const sp = line.indexOf(' ', 8);
        if (sp < 0) continue;
        if (line.slice(8, sp) !== paneId) continue;
        onOutput(unescapeOctal(line.slice(sp + 1)));
        continue;
      }
      if (block) block.push(line);
    }
  });
}

function unescapeOctal(s) {
  return s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}
