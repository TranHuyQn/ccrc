// Chỗ DUY NHẤT trong hub biết token-slayer tồn tại.
//
// Hub đổi một token dùng-một-lần lấy DANH TÍNH, và không gì khác. Cố ý không
// đi qua `/api/ide/auth/exchange`: cái đó trả về một bearer sống lâu hơn và
// với xa hơn nhiều so với thứ luồng này cần. Hub chỉ cần biết TÊN, nên nó
// không được cầm thứ mạnh hơn thế — không trong RAM, không trong log, không
// trong URL. Nhờ vậy quan hệ hub ↔ token-slayer giữ được MỘT CHIỀU: hub hỏi,
// token-slayer trả lời.
//
// Token-slayer cấp cho luồng này một `kind` riêng, nên thứ hub nhận được
// không đổi được ở endpoint IDE. Chi tiết vì sao ranh giới đó cần thiết đã
// báo riêng cho team token-slayer, không chép vào đây.
//
// Biên giới này cũng là điểm cắt: chọn đi qua token-slayer thay vì nói thẳng
// với Slack là ràng buộc tổ chức (quyền sửa Slack app của workspace), không
// phải ràng buộc kiến trúc. Đổi ý thì chỉ file này bị thay.

const PATH = '/api/ccrc/auth/exchange';

/**
 * @param {{internalUrl: string, fetchImpl?: Function, timeoutMs?: number}} opts
 */
export function createIdentity(opts) {
  const { internalUrl, fetchImpl = fetch, timeoutMs = 5000 } = opts || {};

  return {
    /**
     * @returns {Promise<{ok: true, slackUserId: string, handle: string}
     *                 | {ok: false, status: number, reason: string}>}
     */
    async exchange(token, state) {
      let res;
      try {
        // URL nội bộ trong docker network. Đi ra internet là phơi luồng đăng
        // nhập của cả team ra ngoài một cách vô cớ. Việc dựng URL nằm TRONG
        // try: một internalUrl thiếu scheme (vd. quên "http://") làm `new URL`
        // ném đồng bộ, và với caller thì thiếu URL để gọi cũng chính là
        // không với tới được token-slayer — cùng một reason, cùng một xử lý.
        const url = new URL(PATH, internalUrl).toString();
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ token, state }),
          // Không có timeout thì một token-slayer treo làm treo luôn request
          // đăng nhập của hub, và Express không có gì cứu nó.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, status: 0, reason: 'unreachable' };
      }

      if (!res.ok) return { ok: false, status: res.status, reason: 'rejected' };

      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, status: res.status, reason: 'bad_json' };
      }

      const slackUserId = typeof body?.slackUserId === 'string' ? body.slackUserId.trim() : '';
      // Không đoán. Tạo user từ một danh tính rỗng là gắn một token hợp lệ vào
      // sai người — hỏng tệ hơn hẳn một lần đăng nhập thất bại.
      if (!slackUserId) return { ok: false, status: res.status, reason: 'no_identity' };

      const rawHandle = typeof body?.handle === 'string' ? body.handle.trim() : '';
      return { ok: true, slackUserId, handle: rawHandle || slackUserId };
    },
  };
}
