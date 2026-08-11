// Cửa sổ cố định, đếm theo khoá (ở đây là IP). Nhỏ đúng bằng thứ cần dùng.
//
// Vì sao tồn tại: `/api/device/start` KHÔNG có auth — đúng bản chất, máy dev
// chưa có gì để xác thực — và nó với tới được từ internet qua Cloudflare
// Tunnel. Trần `MAX_PENDING = 50` trong device-code.js một mình là không đủ:
// 50 lời gọi ẩn danh mỗi 10 phút giữ kín mọi chỗ pending mãi mãi, và mọi
// `./setup-notify.sh` từ đó rơi về hỏi token tay — im lặng, không ai biết vì
// sao. Spec §5.2 nói rõ HAI chốt: rate-limit theo IP, và trần phiên pending.
// Đây là chốt còn thiếu.
//
// Khuôn mẫu giống pairing.js và oauth-state.js: factory, `now` tiêm được, dọn
// lười từ mọi lối vào. Nhờ vậy test đẩy được thời gian tới mà không phải chờ
// thật, và không có timer nào phải dọn khi hub tắt.

/**
 * @param {{limit: number, windowMs: number, now?: () => number, maxKeys?: number}} opts
 */
export function createRateLimit(opts) {
  const {
    limit,
    windowMs,
    now = () => Date.now(),
    // Trần số khoá đang theo dõi. Bản thân bộ đếm cũng là RAM mà một người
    // lạ điều khiển được lượng, nên nó cần trần của chính nó — cùng lý do
    // MAX_PENDING tồn tại. Map giữ thứ tự chèn, nên đá từ đầu là đá đúng
    // những cửa sổ mở lâu nhất.
    maxKeys = 10_000,
  } = opts || {};

  /** @type {Map<string, {count: number, windowStart: number, warned: boolean}>} */
  const byKey = new Map();

  function prune() {
    const t = now();
    for (const [k, e] of byKey) if (t - e.windowStart >= windowMs) byKey.delete(k);
    while (byKey.size > maxKeys) byKey.delete(byKey.keys().next().value);
  }

  return {
    /**
     * Đếm một lượt cho `key`.
     *
     * `firstTrip` là true ĐÚNG một lần cho mỗi cửa sổ bị chạm trần — để người
     * gọi ghi log một dòng thay vì một dòng cho mỗi request bị chặn, vốn biến
     * chính cái log thành thứ kẻ tấn công điều khiển được.
     *
     * @param {unknown} key
     * @returns {{ok: true, remaining: number} | {ok: false, retryIn: number, count: number, firstTrip: boolean}}
     */
    hit(key) {
      prune();
      const t = now();
      // Không có khoá thì gộp hết vào một rổ, KHÔNG phải miễn trừ: một
      // request không đọc được IP vẫn phải nằm dưới một cái trần nào đó.
      const k = typeof key === 'string' && key ? key : 'khong-ro';

      let e = byKey.get(k);
      if (!e) {
        e = { count: 0, windowStart: t, warned: false };
        byKey.set(k, e);
      }
      e.count += 1;
      if (e.count <= limit) return { ok: true, remaining: limit - e.count };

      const firstTrip = !e.warned;
      e.warned = true;
      return {
        ok: false,
        // Cửa sổ CỐ ĐỊNH: một lượt bị chặn không đẩy hạn xa thêm. Trần đã là
        // trần rồi; kéo dài thêm mỗi lần gõ cửa chỉ phạt người bấm nhầm hai
        // lần nặng hơn kẻ đang tấn công.
        retryIn: Math.max(1, Math.ceil((e.windowStart + windowMs - t) / 1000)),
        count: e.count,
        firstTrip,
      };
    },

    size() {
      prune();
      return byKey.size;
    },
  };
}
