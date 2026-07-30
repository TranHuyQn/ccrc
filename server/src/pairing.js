// Toàn bộ phần việc của hub trong nghi thức ghép cặp: giữ hộ mấy chuỗi trong
// đúng năm phút, theo đúng thứ tự, và không để yêu cầu của người này trả lời
// câu hỏi hỏi nhân danh người khác.
//
// Hub cố tình KHÔNG hiểu gì về mật mã ở đây. Nó không tính SAS, không kiểm
// cam kết, không biết cam kết mở ra cái gì. Nhưng "không hiểu mật mã" không
// có nghĩa "không làm hại được gì": hub vẫn CHỌN nó đang phục vụ pairId nào
// cho ai — nó có thể chuyển hướng cả cuộc ghép sang điện thoại của kẻ tấn
// công một cách trung thực, không tráo chuỗi nào cả, và mọi kiểm tra ở đây
// vẫn qua (spec §12.2, C2). Thứ chặn được đó không phải "hai màn hình lệch
// số" (chúng không lệch trong cuộc tấn công này) mà là: máy dev là bên quyết
// định, qua `/remote pair xac-nhan <số>` gõ tay từ điện thoại — xem spec
// §5.2 (nguyên uỷ) và §12.2/§12.3 (bản đã sửa).
//
// Trong RAM, hệt như terminal-sessions.js: một cuộc ghép cặp dở dang sống
// được năm phút, và một hub khởi động lại chỉ có nghĩa là làm lại từ đầu.

import crypto from 'node:crypto';

export const PAIR_TTL_MS = 5 * 60_000;

export function createPairings(opts) {
  const { now = () => Date.now() } = opts || {};
  /** @type {Map<string, {userName, pubKey, commit, label, state, nonceMachine, noncePhone, at}>} */
  const byId = new Map();

  // Dọn lười, từ mọi lối vào — cùng lý do như terminal-sessions.js: một entry
  // không còn tồn tại chỉ quan trọng vào đúng lúc có người nhìn nó, mà nhìn
  // chính là lúc này. Cũng nhờ vậy toàn bộ bị `now` tiêm điều khiển, và test
  // đẩy được thời gian tới mà không phải chờ thật.
  function prune() {
    const t = now();
    for (const [id, p] of byId) if (t - p.at > PAIR_TTL_MS) byId.delete(id);
  }

  // Tra theo id RỒI mới đối chiếu chủ sở hữu — không bao giờ quét theo người
  // dùng rồi tìm id. Cùng kỷ luật với terminal-sessions.js: một người không
  // được chạm tới thứ của người khác kể cả khi đoán trúng id.
  function own(userName, pairId) {
    prune();
    const p = byId.get(pairId);
    if (!p || p.userName !== userName) return null;
    return p;
  }

  const no = (reason) => ({ ok: false, reason });

  return {
    start(userName, req) {
      prune();
      if (!req || typeof req !== 'object') return no('thiếu thông tin ghép cặp');
      const { pubKey, commit, label } = req;
      if (typeof pubKey !== 'string' || !pubKey) return no('thiếu khoá công khai');
      if (typeof commit !== 'string' || !commit) return no('thiếu cam kết');
      // 24 byte: một pairId đoán được là một cách chen ngang vào cuộc ghép
      // cặp của người khác trong đúng cửa sổ năm phút đó.
      const pairId = crypto.randomBytes(24).toString('base64url');
      byId.set(pairId, {
        userName,
        pubKey,
        commit,
        label: typeof label === 'string' ? label : '',
        state: 'started',
        nonceMachine: null,
        noncePhone: null,
        at: now(),
      });
      return { ok: true, pairId };
    },

    pending(userName) {
      prune();
      const out = [];
      for (const [pairId, p] of byId) {
        if (p.userName !== userName || p.state !== 'started') continue;
        out.push({ pairId, pubKey: p.pubKey, commit: p.commit, label: p.label, at: p.at });
      }
      return out;
    },

    challenge(userName, pairId, nonceMachine) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'started') return no(`sai thứ tự: đang ở ${p.state}`);
      if (typeof nonceMachine !== 'string' || !nonceMachine) return no('thiếu nonce của máy');
      p.nonceMachine = nonceMachine;
      p.state = 'challenged';
      return { ok: true };
    },

    reveal(userName, pairId, noncePhone) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'challenged') return no(`sai thứ tự: đang ở ${p.state}`);
      if (typeof noncePhone !== 'string' || !noncePhone) return no('thiếu nonce của điện thoại');
      p.noncePhone = noncePhone;
      p.state = 'revealed';
      return { ok: true };
    },

    finish(userName, pairId, ok) {
      const p = own(userName, pairId);
      if (!p) return no('không có yêu cầu ghép cặp nào như vậy');
      if (p.state !== 'revealed') return no(`sai thứ tự: đang ở ${p.state}`);
      p.state = ok === true ? 'done' : 'aborted';
      return { ok: true };
    },

    get(userName, pairId) {
      const p = own(userName, pairId);
      if (!p) return null;
      return {
        state: p.state,
        pubKey: p.pubKey,
        commit: p.commit,
        label: p.label,
        nonceMachine: p.nonceMachine,
        noncePhone: p.noncePhone,
      };
    },
  };
}
