import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = path.dirname(fileURLToPath(import.meta.url));
const doc = (p) => fs.readFileSync(path.join(GOC, '..', p), 'utf8');

// Ranh giới này là toàn bộ lý do đợt refactor tồn tại. Nếu ccrc-term.js được
// phép gọi thẳng tmux lần nữa thì bản ConPTY cho Windows sẽ thiếu đúng chỗ ấy
// — và thiếu một cách âm thầm, chỉ lộ ra trên máy Windows của người dùng.
// Nên nó được canh bằng test, không bằng lời hứa trong tài liệu.
test('ccrc-term.js không import gì từ tmux.js', () => {
  const src = doc('bin/ccrc-term.js');
  // [^;]*? thay vì [\s\S]*?: một vi phạm thật phải in ra ĐÚNG dòng import của
  // nó làm chẩn đoán, không phải toàn bộ đám import không liên quan nằm giữa
  // đầu file và chỗ tmux.js bị import.
  const m = src.match(/^import[^;]*?from '\.\.\/src\/tmux\.js';/m);
  assert.equal(m, null, `ccrc-term.js vẫn còn import từ tmux.js:\n${m && m[0]}`);
});

// Lột comment trước khi soi. `ccrc-term.js:76` là một comment đang đúng việc —
// nó giải thích vì sao cols/rows phải chặn khoảng, và có nhắc `refresh-client`.
// Comment ấy ở lại (phần validate cols/rows ở lại), nên soi cả file là bài test
// không bao giờ xanh được trừ khi xoá một comment không có gì sai.
function chiCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// attach-session là cửa quan trọng nhất — nó là thứ dựng cả cái pipe control
// mode. kill-session, new-session, set-option, list-sessions cũng bị chặn ở
// đây dù hôm nay chỉ tmux.js gọi chúng (nên test 1 đã bắt được đường thật).
//
// Danh sách con lệnh này KHÔNG đóng được đường "hardcode 'tmux', không import
// gì từ tmux.js": một `execFileSync('tmux', ['display-message', '-p', ...])`
// lọt qua sạch — display-message vắng mặt ở đây, cùng list-panes,
// show-options, has-session, kill-pane, select-pane, resize-pane,
// split-window, run-shell, if-shell, pipe-pane — và một danh sách chỉ có thể
// theo sau, không bao giờ đi trước, mọi cách người ta nghĩ ra để gọi tmux.
// Đường đó được đóng ở bài test ngay dưới đây (import node:child_process),
// không phải ở đây.
test('ccrc-term.js không tự chạy binary tmux', () => {
  const src = chiCode(doc('bin/ccrc-term.js'));
  assert.ok(!src.includes('tmuxBin('), 'ccrc-term.js không được tự gọi tmuxBin()');
  assert.ok(!/send-keys|paste-buffer|load-buffer|capture-pane|refresh-client|attach-session|kill-session|new-session|set-option|list-sessions/.test(src),
    'ccrc-term.js không được dựng lệnh tmux nào');
});

// Đóng đường mà bài test trên không đóng được: MỌI cách sinh tiến trình con —
// hardcode 'tmux', gọi 'ps', gọi bất cứ binary nào — đều phải đi qua
// node:child_process trước khi làm được việc đó. Cấm import này đóng CẢ HỌ
// bypass "hardcode tên binary, không đụng tmux.js", bất kể con lệnh được viết
// thế nào, và không rot theo thời gian như một danh sách con lệnh — không ai
// phải nhớ thêm một cái tên mới vào đây mỗi khi tmux có thêm subcommand.
test('ccrc-term.js không import node:child_process', () => {
  const src = chiCode(doc('bin/ccrc-term.js'));
  assert.ok(!src.includes('child_process'),
    'ccrc-term.js không được import child_process (dưới bất kỳ tên nào) — mọi ' +
    'việc sinh tiến trình con phải đi qua src/pane-source.js, để bản ConPTY ' +
    'cho Windows chỉ có đúng MỘT chỗ cần thay.');
});

// Rộng hơn bài kiểm tra '-C', 'attach-session' cũ: một lệnh tmux lọt vào một
// module KHÁC trong src/ (vd. src/static.js gọi thẳng `capture-pane`) phá vỡ
// ranh giới Windows y hệt việc dựng thẳng client control-mode, chỉ là không
// ai để ý vì bài test cũ chỉ soi đúng một literal. tmux.js và pane-source.js
// bị loại khỏi vòng soi vì đó CHÍNH LÀ hai nơi được phép — tmux.js là bản gói
// binary tmux, pane-source.js là nơi duy nhất được phép gọi nó (xem test
// 'ccrc-term.js không import gì từ tmux.js' và ghi chú đầu pane-source.js).
//
// Hôm nay ranh giới này sạch — không file nào khác trong src/ đụng tới tmux —
// nên bài test này canh một bất biến, không sửa một chỗ đang hỏng. Nếu mở
// rộng nó ra mà có file nào bật đỏ, đó là một vi phạm THẬT cần báo cáo, không
// phải lý do để làm yếu bài test.
test('pane-source.js (và tmux.js) là những module DUY NHẤT trong src/ chạm vào tmux', () => {
  const TMUX_SUBCOMMAND_RE = /send-keys|paste-buffer|load-buffer|capture-pane|refresh-client|attach-session|kill-session|new-session|set-option|set-window-option|list-sessions|list-panes|display-message|show-options|has-session|kill-pane|select-pane|resize-pane|split-window|run-shell|if-shell|pipe-pane/;
  const srcDir = path.join(GOC, '..', 'src');
  const files = fs.readdirSync(srcDir)
    .filter((f) => f.endsWith('.js') && f !== 'pane-source.js' && f !== 'tmux.js')
    .map((f) => path.join('src', f));
  const dinhLiu = files.filter((p) => TMUX_SUBCOMMAND_RE.test(chiCode(doc(p))));
  assert.deepEqual(dinhLiu, [], `Các file này trong src/ đang chạm vào con lệnh tmux, phá vỡ ranh giới ConPTY: ${dinhLiu.join(', ')}`);
});

// control-stream.js là bản dịch riêng cho luồng %begin/%end/%output của tmux
// control mode — không có gì trên Windows để dịch. Không có gì chặn
// ccrc-term.js import thẳng nó (nó không phải tmux.js, nên test đầu file
// không bắt được), mà làm vậy phá ranh giới Windows y hệt một lệnh tmux trần.
test('ccrc-term.js không import control-stream.js', () => {
  const src = doc('bin/ccrc-term.js');
  assert.ok(!src.includes('control-stream.js'),
    'ccrc-term.js không được import src/control-stream.js — nó đặc thù tmux control mode, chỉ pane-source.js được đụng vào');
});

// Soi cả bin/ccrc-term.js, không chỉ term/src — file bị canh chính là nó, nên
// nó phải nằm TRONG danh sách bị soi, không phải ngoài.
test('pane-source.js là nơi duy nhất dựng client control-mode', () => {
  const srcFiles = fs.readdirSync(path.join(GOC, '..', 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('src', f));
  const candidates = [...srcFiles, path.join('bin', 'ccrc-term.js')];
  const coCtl = candidates.filter((p) => doc(p).includes("'-C', 'attach-session'"));
  assert.deepEqual(coCtl, [path.join('src', 'pane-source.js')]);
});
