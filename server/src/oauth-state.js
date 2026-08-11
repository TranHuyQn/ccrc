// Kho "cấp một mã, đổi đúng một lần, hết hạn thì thôi".
//
// Dùng cho hai thứ trong luồng đăng nhập Slack, cùng hình dạng nên cùng một
// module:
//
//   - `state` của OAuth (TTL 5 phút) — buộc callback phải thuộc về đúng lần
//     bấm "Đăng nhập" này, không phải một link ai đó gửi tới.
//   - `claimCode` (TTL 60 giây) — thứ đi qua `?login=` trên thanh địa chỉ để
//     trao token cho PWA. Token của hub sống mãi, mà URL thì đi vào history
//     trình duyệt, vào Referer, và vào access log của reverse proxy đứng
//     trước hub. Một secret vĩnh viễn không được đi qua ba chỗ đó; một mã
//     sống 60 giây và dùng một lần thì lọt ra ngoài cũng đã chết.
//
// Trong RAM, hệt như pairing.js và terminal-sessions.js: thứ sống lâu nhất ở
// đây là năm phút, nên hub khởi động lại chỉ có nghĩa là bấm lại.

import crypto from 'node:crypto';

/**
 * @param {{ttlMs: number, now?: () => number, bytes?: number}} opts
 */
export function createOneShotStore(opts) {
  const { ttlMs, now = () => Date.now(), bytes = 32 } = opts || {};
  /** @type {Map<string, {payload: any, at: number}>} */
  const byCode = new Map();

  // Dọn lười từ mọi lối vào, cùng khuôn mẫu với pairing.js: một entry hết hạn
  // chỉ quan trọng vào lúc có người nhìn nó, và nhìn chính là lúc này. Nhờ vậy
  // toàn bộ thời gian bị `now` tiêm điều khiển và test không phải chờ thật.
  function prune() {
    const t = now();
    for (const [c, e] of byCode) if (t - e.at > ttlMs) byCode.delete(c);
  }

  return {
    issue(payload) {
      prune();
      const code = crypto.randomBytes(bytes).toString('base64url');
      byCode.set(code, { payload, at: now() });
      return code;
    },

    consume(code) {
      prune();
      if (typeof code !== 'string' || !code) return null;
      const e = byCode.get(code);
      if (!e) return null;
      // Xoá TRƯỚC khi trả: giữa hai lời gọi này không được có await nào, và
      // cách chắc chắn nhất là không có gì nằm giữa.
      byCode.delete(code);
      return e.payload;
    },

    size() {
      prune();
      return byCode.size;
    },
  };
}
