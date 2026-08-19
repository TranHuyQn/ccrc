// Một "nguồn pane" là mọi thứ ccrc-term cần biết về cái terminal nó đang phục
// vụ — đọc màn hình, gõ vào, đổi kích thước, biết khi nào nó mất.
//
// Tách ra khỏi ccrc-term.js vì trên Windows không có tmux, và cũng không có gì
// thay thế: kiến trúc ở đó phải lật từ "gắn vào pane có sẵn" sang "sở hữu
// ConPTY". Interface này là ranh giới giữa hai câu trả lời đó. Xem
// docs/superpowers/specs/2026-08-17-windows-native-design.md §5.
//
// Bản tmux dưới đây KHÔNG chứa logic mới. Nó gói lại các hàm đã có trong
// tmux.js, đúng nguyên trạng — mọi hành vi, mọi bài học đã trả giá vẫn nằm
// nguyên ở đó. Đây là điều kiện để 482 bài test hiện có còn dùng được làm mốc
// "không đổi gì".

import { spawn } from 'node:child_process';
import {
  paneAlive, snapshotPane, paneHistorySize, captureHistory, paneMouseMode,
  paneCwd, paneSocket,
  tmuxBin, hasSession, reclaimPaneSession, claimGroupName, createGroupSession,
  killGroupSession, makeRunId,
} from './tmux.js';
import { attachControlOutput } from './control-stream.js';
import { splitForSendKeys } from './key-chunks.js';

// Nhịp nghỉ giữa nội dung dán và cú Enter kết thúc nó. Đủ để TUI phía kia đọc
// xong đoạn dán trong một lượt riêng, đủ nhỏ để không ai nhận ra.
const COMMIT_DELAY_MS = 30;

// Bao lâu thì coi như `tmux load-buffer` treo. Nó ghi vào một tiến trình con,
// và hàng đợi gõ phím của kết nối đó ĐANG chờ nó xong — treo mà không có trần
// thì không chỉ tin nhắn ấy mất, mà mọi phím bấm sau đó của cái điện thoại ấy
// cũng chết câm, không một lời báo.
const PASTE_LOAD_TIMEOUT_MS = 5000;

export function createTmuxPaneSource({ pane, runId = makeRunId() }) {
  // MỘT nguồn cho cả daemon. Phiên nhóm dựng một lần và dùng chung; mỗi kết
  // nối trình duyệt có ống `tmux -C` của riêng nó. Đó đúng là hình dạng bản
  // đang chạy — xem ghi chú đầu Task 2 để biết vì sao gộp lại là hỏng.
  let groupName = null;
  let soKetNoi = 0;
  // Đếm chung cho cả nguồn (một nguồn = một tiến trình daemon), KHÔNG phải
  // cho từng kết nối: tên buffer sinh ra từ nó phải là duy nhất trên toàn bộ
  // tmux server, mà một nguồn phục vụ nhiều kết nối trình duyệt cùng lúc. Để
  // trong phạm vi một attach() thì hai điện thoại đều bắt đầu đếm từ 0, đặt
  // trùng tên buffer nhau (cùng runId), và người này dán đè nội dung người
  // kia trước khi paste-buffer kịp đọc — đo được bằng
  // daemon.test.js 'hai client cùng gửi: không ai nuốt tin nhắn của ai'.
  let pasteSeq = 0;

  const doc = {
    alive: () => paneAlive(pane),
    snapshot: () => snapshotPane(pane),
    historySize: () => paneHistorySize(pane),
    history: (offset, rows) => captureHistory(pane, offset, rows),
    mouseMode: () => paneMouseMode(pane),

    // Hai thứ này KHÔNG phải để vẽ ra màn hình — chúng là cách sổ tra phiên
    // (shared/session-registry.js) nhận ra phiên nào là phiên nào, để hook
    // thông báo gắn đúng tên vào đúng thẻ. cwd() không bao giờ rời khỏi máy;
    // nó là khoá đối chiếu cục bộ, và gửi nó đi là mở lại đúng lỗ rò riêng tư
    // mà cái sổ ấy sinh ra để bịt.
    cwd: () => paneCwd(pane),
    socket: () => paneSocket(pane),
  };

  // Dựng phiên nhóm nếu chưa có. Idempotent: kết nối thứ hai dùng lại phiên
  // nhóm đã có, KHÔNG đi qua claimGroupName lần nữa — `isReclaimableMarker`
  // coi dấu mang đúng runId của mình là "được phép thu hồi", nên gọi lại sẽ
  // GIẾT chính phiên nhóm đang phục vụ những kết nối khác.
  function baoDamNhom() {
    if (groupName) return { ok: true };
    // reclaimPaneSession trả null khi pane đã chết, và cả khi thứ duy nhất còn
    // giữ pane là phiên nhóm của chính mình — dọn nó đi là giết luôn cái pane
    // đang định phục vụ. Cả hai đều nghĩa là "không phục vụ được".
    const base = reclaimPaneSession(pane, runId);
    if (!base) return { ok: false, message: 'pane đã chết' };
    const name = claimGroupName(base, runId);
    if (!name) return { ok: false, message: 'không đặt được tên cho phiên nhóm terminal' };
    try {
      createGroupSession(base, name, runId);
    } catch {
      return { ok: false, message: 'không tạo được phiên nhóm cho terminal' };
    }
    groupName = name;
    return { ok: true };
  }

  return {
    ...doc,

    attach({ onData, onCtlReply, onGone }) {
      const g = baoDamNhom();
      if (!g.ok) return g;

      // Gắn vào PHIÊN NHÓM, không bao giờ vào phiên thật của người dùng: tmux
      // co cửa sổ dùng chung về client nhỏ nhất, nên gắn thẳng nghĩa là điện
      // thoại vừa nối là màn hình trên bàn tụt còn 40 cột.
      const ctl = spawn(tmuxBin(), ['-C', 'attach-session', '-t', groupName], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      soKetNoi += 1;
      let dangTuDong = false;

      // Ghi vào stdin của tiến trình đã chết bắn 'error' (EPIPE); không có
      // handler là ngoại lệ không ai bắt. Con chết đã có bao() lo.
      ctl.stdin.on('error', () => {});

      // Client control-mode thoát KHÔNG đồng nghĩa pane chết. Nó cũng xảy ra
      // khi chỉ riêng phiên nhóm bị gỡ (một `tmux kill-session` từ bên ngoài,
      // một cuộc đua) trong khi pane và phiên thật của người dùng nguyên vẹn.
      // Phân biệt hai ca là việc của hàm này — và phải xong TRƯỚC khi ai đó
      // đóng socket, vì đóng nhầm mã là trình duyệt nối lại vô hạn.
      const bao = (reason) => {
        if (dangTuDong) return;
        const nhomMat = groupName !== null && !hasSession(groupName);
        onGone({ fatal: !(nhomMat && paneAlive(pane)), reason });
      };
      ctl.on('exit', () => bao('tmux -C thoát bất ngờ'));
      ctl.on('error', (err) => bao(`tmux -C lỗi: ${err.message}`));

      // Hàng đợi lời đáp thuộc về ĐÚNG ống này, không dùng chung giữa các kết
      // nối. tmux control mode trả lời mỗi lệnh bằng đúng một khối theo đúng
      // thứ tự nhận, nên ghép theo VỊ TRÍ chỉ đúng khi hàng đợi và ống là
      // một-một. Dùng chung là hai trình duyệt ăn lời đáp của nhau.
      //
      // Và MỌI lệnh phải đi qua ctlCmd, không ngoại lệ: một `ctl.stdin.write`
      // viết thẳng ở đâu đó là lệch cả hàng từ điểm ấy trở đi.
      const choLoiDap = [];
      function ctlCmd(cmd, cb) {
        choLoiDap.push(cb || null);
        ctl.stdin.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
      }

      // send-keys -H nhận hex, nên không còn câu hỏi trích dẫn nào để trả lời
      // sai — ký tự điều khiển, xuống dòng, UTF-8 đều đi qua nguyên vẹn.
      function sendKeysHex(bytes, cb) {
        const hex = Buffer.from(bytes).toString('hex').match(/../g) || [];
        if (hex.length === 0) return;
        ctlCmd(`send-keys -t ${pane} -H ${hex.join(' ')}`, cb);
      }

      // Nối tiếp, không song song, và DÙNG CHUNG giữa type và paste: một cú
      // Enter của thanh phím chen vào giữa đoạn dán sẽ gửi đi nửa tin nhắn.
      let typeQueue = Promise.resolve();

      attachControlOutput(ctl.stdout, pane, onData, (ok, message) => {
        const cb = choLoiDap.shift();
        if (cb) { cb(ok, String(message || '').slice(0, 200)); return; }
        onCtlReply(ok, message);
      });

      const conn = {
        type(data) {
          const { chunks, commit } = splitForSendKeys(data);
          if (chunks.length === 0 && !commit) return;
          typeQueue = typeQueue.then(async () => {
            for (const chunk of chunks) sendKeysHex(chunk);
            if (commit) {
              await new Promise((r) => setTimeout(r, COMMIT_DELAY_MS));
              sendKeysHex(commit);
            }
          }).catch(() => { /* một lượt hỏng không được làm nghẽn những lượt sau */ });
        },

        // Dán KHÁC hẳn gõ, và khác vì một lý do đo được: ứng dụng trong pane có
        // thể hiểu bracketed paste, hoặc không. Claude Code KHÔNG bật (`?2004h`
        // xuất hiện 0 lần trong bản 2.1.233) — trang tự bọc dấu là cả cụm bị
        // vứt trong hộp thoại AskUserQuestion. zsh thì ngược lại: gửi chữ thô
        // nhiều dòng vào đấy là mỗi dòng chạy thành một lệnh.
        //
        // Không đoán hộ ai: `paste-buffer -p` bọc dấu KHI VÀ CHỈ KHI ứng dụng
        // đã xin chế độ đó, và tmux là bên duy nhất biết. `-r` giữ nguyên LF
        // (mặc định tmux đổi thành CR, tức gửi dòng đầu đi như một câu hoàn
        // chỉnh). `-d` xoá buffer ngay sau khi dán để không bỏ rác vào danh
        // sách buffer của người dùng.
        paste(text, { onAck, onErr }) {
          const bytes = Buffer.from(text, 'utf8');
          if (bytes.length === 0) return;
          // Tên buffer riêng từng lượt: hai client dán cùng lúc mà dùng chung
          // một tên thì lượt sau đè nội dung lượt trước ngay trước khi nó kịp
          // được dán.
          const name = `ccrc-${runId}-${pasteSeq += 1}`.replace(/[^A-Za-z0-9_-]/g, '');
          typeQueue = typeQueue.then(() => new Promise((resolve) => {
            const loader = spawn(tmuxBin(), ['load-buffer', '-b', name, '-'], {
              stdio: ['pipe', 'ignore', 'ignore'],
            });
            // Một lượt dán chỉ được kết thúc ĐÚNG MỘT LẦN. Khi spawn hỏng, Node
            // bắn 'error' rồi bắn tiếp 'close' với mã null — không chốt lại thì
            // người dùng nhận hai thông báo, cái thứ hai vô nghĩa.
            let done = false;
            let treo = null;
            const finish = () => { if (done) return false; done = true; clearTimeout(treo); resolve(); return true; };
            const fail = (why) => {
              // Im lặng ở đây nghĩa là ô soạn phía người dùng vẫn trống đi như
              // đã gửi, còn tin nhắn thì chưa từng tồn tại.
              if (!finish()) return;
              onErr(`không dán được: ${why}`);
            };
            treo = setTimeout(() => {
              try { loader.kill('SIGKILL'); } catch {}
              fail('tmux không phản hồi');
            }, PASTE_LOAD_TIMEOUT_MS);
            loader.on('error', (e) => fail(String(e && e.message).slice(0, 120)));
            loader.on('close', (code) => {
              if (done) return;
              if (code !== 0) return fail(`load-buffer trả mã ${code}`);
              // load-buffer xong mới chỉ chứng minh cái BUFFER đã có. Nó không
              // nói gì về việc pane có nhận được hay không — pane có thể vừa
              // chết trong đúng khoảnh khắc này.
              ctlCmd(`paste-buffer -d -p -r -b ${name} -t ${pane}`, (ok, message) => {
                if (!ok) return fail(message || 'tmux từ chối paste-buffer');
                setTimeout(() => {
                  sendKeysHex(Buffer.from([0x0d]), (okEnter, loiEnter) => {
                    if (!okEnter) return fail(loiEnter || 'tmux từ chối cú Enter');
                    // ĐÃ dán VÀ đã chốt bằng Enter, cả hai đều được tmux xác
                    // nhận — chỉ tới đây điện thoại mới được phép quên chữ đó.
                    onAck();
                    finish();
                  });
                }, COMMIT_DELAY_MS);
              });
            });
            loader.stdin.on('error', () => { /* 'close' ở trên lo nốt */ });
            loader.stdin.end(bytes);
          })).catch(() => {});
        },

        // Chuột đi TẮT qua typeQueue — đúng như trước khi file này tách ra
        // khỏi ccrc-term.js. Trước bản refactor, ccrc_click và nhánh chuột
        // của ccrc_scroll gọi thẳng ctlCmd(send-keys -H ...), không qua hàng
        // đợi gõ phím nào cả. Nếu một cú tap hay cuộn xếp sau một paste đang
        // treo trong typeQueue, nó phải chờ tới PASTE_LOAD_TIMEOUT_MS trong
        // ca xấu nhất — một cái chạm ngón tay bị trễ 5 giây là hành vi khác,
        // không được phép trên nhánh này. Vì vậy KHÔNG đi qua splitForSendKeys:
        // payload chuột luôn nằm sâu dưới MAX_KEY_BYTES (cuộn dài nhất là
        // MAX_NOTCHES=40 nấc × ~14 byte/nấc ≈ 560 byte, so với trần cắt 1024).
        // type() vẫn xếp hàng — đó là hành vi cũ, đúng ý, không đổi.
        mouse(bytes) {
          sendKeysHex(bytes);
        },

        resize(cols, rows) {
          ctlCmd(`refresh-client -C ${cols}x${rows}`);
        },

        close() {
          if (dangTuDong) return;
          dangTuDong = true;
          try { ctl.kill(); } catch {}
          soKetNoi = Math.max(0, soKetNoi - 1);
          // Kết nối cuối cùng rời đi thì phiên nhóm không còn lý do tồn tại,
          // và bỏ lại là rò vĩnh viễn. killGroupSession chỉ giết thứ mang dấu
          // của mình, nên một phiên trùng tên do người dùng đặt vẫn an toàn.
          if (soKetNoi === 0 && groupName) { killGroupSession(groupName); groupName = null; }
        },
      };
      return { ok: true, conn };
    },
  };
}
