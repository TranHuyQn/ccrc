// Device-code cho máy dev, theo tinh thần RFC 8628.
//
// Máy dev chưa có gì để xác thực, nên nó không thể tự chứng minh mình là ai.
// Cách giải: nó xin một cặp mã, in cái NGẮN ra màn hình, và một thiết bị ĐÃ
// đăng nhập gõ mã đó để bảo hub "cấp token của tôi cho cái máy đang cầm mã
// này".
//
// Bất đối xứng là toàn bộ thiết kế:
//
//   userCode   8 ký tự  — để người gõ. KHÔNG đổi ra token được.
//   deviceCode 32 byte  — thứ duy nhất đổi ra token.
//
// Để userCode đổi được token thì tám ký tự đó là toàn bộ hàng rào, và
// brute-force xong trong vài phút. Cùng tinh thần cặp `pairId`/`sas` mà hub
// đã dùng cho ghép cặp thiết bị.
//
// Trong RAM như pairing.js: thứ sống lâu nhất là mười phút.

import crypto from 'node:crypto';

export const DEVICE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 5;
export const MAX_WRONG = 5;

// Trần phiên pending. `/api/device/start` không có auth — đúng bản chất, máy
// dev chưa có gì để xác thực — nên không có trần thì một kẻ gọi liên tục vừa
// ngốn RAM vừa làm loãng không gian userCode tới mức gõ trúng mã người khác
// trở thành chuyện có thật.
export const MAX_PENDING = 50;

// Crockford base32 bỏ I, L, O, U. Mã này được đọc từ màn hình laptop rồi gõ
// sang điện thoại; `0`/`O` và `1`/`I` lẫn nhau ở đó là một lần thử sai vô cớ.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

/**
 * Chuẩn hoá thứ người dùng gõ vào: chấp nhận chữ thường, gạch nối, khoảng
 * trắng. Người gõ lại đúng thứ họ nhìn thấy đã đủ khó rồi.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUserCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function format(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * @param {{now?: () => number, randomInt?: (n: number) => number}} [opts]
 */
export function createDeviceCodes(opts) {
  const {
    now = () => Date.now(),
    randomInt = (n) => crypto.randomInt(n),
  } = opts || {};

  /** @type {Map<string, {userCode: string, grant: object|null, lastPollAt: number, at: number}>} */
  const byDevice = new Map();
  /** @type {Map<string, string>} userCode đã chuẩn hoá -> deviceCode */
  const byUserCode = new Map();
  /** @type {Map<string, {count: number, at: number}>} tên người duyệt -> số lần gõ sai */
  const wrongByApprover = new Map();

  function prune() {
    const t = now();
    for (const [dc, e] of byDevice) {
      if (t - e.at > DEVICE_TTL_MS) {
        byDevice.delete(dc);
        byUserCode.delete(e.userCode);
      }
    }
    for (const [who, w] of wrongByApprover) {
      if (t - w.at > DEVICE_TTL_MS) wrongByApprover.delete(who);
    }
  }

  function mintUserCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let s = '';
      for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
      if (!byUserCode.has(s)) return s;
    }
    return null;
  }

  return {
    start() {
      prune();
      if (byDevice.size >= MAX_PENDING) {
        return { ok: false, reason: 'Đang có quá nhiều máy chờ duyệt — thử lại sau vài phút' };
      }
      const userCode = mintUserCode();
      if (userCode === null) {
        return { ok: false, reason: 'Đang có quá nhiều máy chờ duyệt — thử lại sau vài phút' };
      }
      const deviceCode = crypto.randomBytes(32).toString('base64url');
      // lastPollAt bắt đầu ở -Infinity chứ không phải 0: nếu đồng hồ tiêm vào
      // (như test) bắt đầu từ t=0 thật, dùng 0 làm "chưa poll lần nào" sẽ bị
      // coi là falsy và bỏ qua luôn bước chặn nhịp ở lần poll thứ hai.
      byDevice.set(deviceCode, { userCode, grant: null, lastPollAt: -Infinity, at: now() });
      byUserCode.set(userCode, deviceCode);
      return {
        ok: true,
        deviceCode,
        userCode: format(userCode),
        ttl: Math.floor(DEVICE_TTL_MS / 1000),
        interval: POLL_INTERVAL_S,
      };
    },

    /**
     * @param {string} approverName  tên người đang đăng nhập bấm duyệt
     * @param {unknown} rawUserCode  thứ họ gõ vào
     * @param {{name: string, displayName: string, token: string}} grant
     */
    approve(approverName, rawUserCode, grant) {
      prune();

      // Đếm sai theo NGƯỜI DUYỆT, không theo phiên: một mã sai không trỏ tới
      // phiên nào cả, nên không có phiên nào để đếm vào. Người duyệt thì đã
      // xác thực, nên đó là thứ duy nhất bám được.
      const w = wrongByApprover.get(approverName);
      if (w && w.count >= MAX_WRONG) {
        return { ok: false, reason: 'Sai quá nhiều lần — chờ vài phút rồi thử lại', remaining: 0 };
      }

      const code = normalizeUserCode(rawUserCode);
      const deviceCode = code ? byUserCode.get(code) : undefined;
      const entry = deviceCode ? byDevice.get(deviceCode) : undefined;

      if (!entry || entry.grant !== null) {
        const count = (w?.count || 0) + 1;
        wrongByApprover.set(approverName, { count, at: now() });
        const remaining = Math.max(0, MAX_WRONG - count);
        return {
          ok: false,
          reason: remaining > 0 ? `Sai mã (còn ${remaining} lần)` : 'Sai quá nhiều lần — chờ vài phút rồi thử lại',
          remaining,
        };
      }

      wrongByApprover.delete(approverName);
      entry.grant = grant;
      return { ok: true };
    },

    poll(deviceCode) {
      prune();
      if (typeof deviceCode !== 'string' || !deviceCode) return { status: 'gone' };
      const e = byDevice.get(deviceCode);
      if (!e) return { status: 'gone' };

      const t = now();
      if (t - e.lastPollAt < POLL_INTERVAL_S * 1000) {
        return { status: 'throttled', retryIn: Math.ceil((POLL_INTERVAL_S * 1000 - (t - e.lastPollAt)) / 1000) };
      }
      e.lastPollAt = t;

      if (e.grant === null) return { status: 'pending' };

      // Đổi xong là phiên chết: token đã ra khỏi hub, giữ lại chỉ là một bản
      // sao nữa của cùng một secret.
      byDevice.delete(deviceCode);
      byUserCode.delete(e.userCode);
      return { status: 'ready', grant: e.grant };
    },
  };
}
