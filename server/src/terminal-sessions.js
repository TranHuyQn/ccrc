// Toàn bộ phần việc của hub với terminal: nhớ người dùng đang mở phiên nào.
// Byte không đi qua đây, và từ 2026-07-29 thì KHOÁ cũng không: điện thoại tự
// ký token mở phiên bằng khoá riêng của nó, máy dev xác minh bằng khoá công
// khai đã ghép. Hub không còn giữ gì mở được một phiên.

// After this long without a heartbeat a session is reported `alive:false` —
// still listed, but flagged. Exported so the eviction threshold below can be
// asserted to sit well clear of it: the gap between the two is the window in
// which the user is TOLD their machine stopped answering, and collapsing that
// window would replace a warning with a silent disappearance.
export const HEARTBEAT_DEAD_MS = 60_000;

// How long a session may go without a heartbeat before it is REMOVED, not
// merely shown as not responding.
//
// Why this exists at all. Before multi-session, a `/remote on` overwrote the
// user's single entry, so a daemon that died without unregistering was erased
// by the next one that started: crashes self-healed as a side effect of the
// data structure. Now every `/remote on` mints a fresh sessionId, so nothing
// ever overwrites anything, and a daemon killed without a clean shutdown —
// SIGKILL, a crash, the hub unreachable at the moment it exits — leaves an
// entry behind forever. The reviewer found 41 of them accumulated, with the
// `alive:false` ones never going away.
//
// Why 30 minutes. The decisive fact is that eviction is SELF-HEALING for any
// daemon that is actually still alive: it re-registers under its own,
// unchanged sessionId on every heartbeat (20s — term/bin/ccrc-term.js's
// HEARTBEAT_MS), so a laptop that wakes, or a network that comes back, puts
// its card straight back within one beat. Eviction therefore cannot destroy a
// session the user still has; it can only hide one while the machine holding
// it is genuinely unreachable, which is a true statement about the world.
//
// That argues for a short margin, and the counterweight is what argues
// against a very short one: between HEARTBEAT_DEAD_MS and this, a session is
// listed with `alive:false`, which the PWA and `/remote` render as "⚠ KHÔNG
// phản hồi — máy có thể đã ngủ". That warning is the only way a user away
// from their desk learns their machine went to sleep rather than their
// session having never existed. Evicting after a couple of minutes would make
// that state almost unobservable and turn every sleeping laptop into a silent
// disappearance.
//
// 30 minutes = 90 missed heartbeats. Long enough that a coffee-break sleep, a
// train tunnel, or a wifi change never removes a card, and that the "not
// responding" warning is on screen for a good half hour before anything
// vanishes; short enough that a genuinely dead daemon is gone well within one
// working session instead of silting the list up run after run.
export const SESSION_EVICT_MS = 30 * 60_000;

export function createTerminalSessions({ now = () => Date.now() } = {}) {
  /**
   * userName -> sessionId -> session. A user can have several sessions open
   * at once (one per pane/project) — this is exactly the structure that
   * replaces the old one-session-per-user Map, so a second `/remote on` adds
   * a session instead of overwriting the first.
   * @type {Map<string, Map<string, {sessionId, machine, url, label, seenAt}>>}
   */
  const byUser = new Map();

  function toPublic(s) {
    return {
      sessionId: s.sessionId,
      machine: s.machine,
      url: s.url,
      // Stored and handed back exactly as the daemon sent it — the hub never
      // inspects or rewrites it, it only ever passes it through. Deciding
      // what a session is CALLED is the daemon's job (term/src/session-name.js):
      // an opaque id unless the user named it with `/remote on <tên>`.
      label: s.label,
      // Lúc thông báo gần nhất của phiên này tới hub — 0 khi chưa có cái nào.
      // Đây là TẤT CẢ những gì hub còn giữ về thông báo: một con số, đủ để PWA
      // so với mốc "đã xem" của chính nó và vẽ chấm chưa đọc, không đủ để ai
      // đọc ra Claude đã nói gì. Trước bản này chấm ấy được tính bằng cách
      // giao danh sách phiên với 50 thông báo hub nhớ hộ — tức là để vẽ một
      // cái chấm, hub phải giữ nội dung của mọi thông báo.
      lastNotifiedAt: s.lastNotifiedAt,
      alive: now() - s.seenAt <= HEARTBEAT_DEAD_MS,
    };
  }

  /**
   * Drops every session whose heartbeat lapsed by more than SESSION_EVICT_MS,
   * and any user left with none.
   *
   * Run lazily, from every entry point below, rather than on a timer. A timer
   * would have to be created, unref'd and torn down by every caller and every
   * test, and would buy nothing: an entry that no longer exists matters only
   * at the moment somebody looks at it, and looking is exactly when this
   * runs. It also keeps the whole thing driven by the injected `now`, so a
   * test can move time forward without waiting for it.
   *
   * Deleting from a Map while iterating it is well-defined in JS — entries
   * already visited or removed are simply not revisited.
   */
  function prune() {
    const t = now();
    for (const [userName, sessions] of byUser) {
      for (const [sessionId, s] of sessions) {
        if (t - s.seenAt > SESSION_EVICT_MS) sessions.delete(sessionId);
      }
      if (sessions.size === 0) byUser.delete(userName);
    }
  }

  return {
    register(userName, { sessionId, machine, url, label, viewing }) {
      prune();
      let sessions = byUser.get(userName);
      if (!sessions) {
        sessions = new Map();
        byUser.set(userName, sessions);
      }
      // '' when omitted (an older daemon, or a test fixture that predates
      // Task 3) rather than undefined, so toPublic() always hands the PWA a
      // string to render, never `undefined`.
      //
      // PHẢI đọc mốc cũ ra trước: `set` bên dưới thay cả entry, còn hàm này
      // chạy lại ở MỖI nhịp heartbeat (20 giây). Không mang mốc theo thì chấm
      // chưa đọc bị xoá sạch mỗi 20 giây — một thông báo tới lúc người dùng
      // không cầm máy sẽ tắt trước khi họ kịp nhìn, và triệu chứng là "chấm
      // thỉnh thoảng mới hiện", thứ gần như không ai lần ra được.
      const truoc = sessions.get(sessionId);
      sessions.set(sessionId, {
        sessionId, machine, url,
        lastNotifiedAt: truoc ? truoc.lastNotifiedAt : 0,
        label: typeof label === 'string' ? label : '',
        // Whether somebody currently has this terminal ON SCREEN — used to
        // hold back a push for a session the user is already watching.
        // Only an explicit `true` counts: an older daemon that does not send
        // this field must keep receiving notifications, never fall silent.
        viewing: viewing === true,
        seenAt: now(),
      });
    },

    /**
     * Một thông báo vừa tới cho phiên này. Ghi lại ĐÚNG một con số: lúc nó tới.
     *
     * Không tạo entry mới khi phiên không tồn tại, và đó là chủ ý: một thông
     * báo có thể mang sessionId của một phiên vừa đóng, hoặc của một máy chưa
     * bao giờ chạy `/remote on`. Tạo entry cho nó nghĩa là đẻ ra một thẻ phiên
     * ma trên điện thoại — không có URL, không mở được, không tự biến mất cho
     * tới hết hạn eviction. Không có phiên thì không có chấm nào để vẽ, và im
     * lặng ở đây là câu trả lời đúng.
     *
     * Khoá theo NGƯỜI trước, id sau — cùng kỷ luật với mọi hàm khác ở đây: hai
     * người có thể có cùng một sessionId, và thông báo của người này không
     * được làm sáng chấm trên thẻ của người kia.
     */
    noteArrived(userName, sessionId) {
      const sessions = byUser.get(userName);
      const s = sessions && sessions.get(sessionId);
      if (!s) return;
      s.lastNotifiedAt = now();
    },

    /**
     * Is this user currently watching this session's terminal?
     *
     * Scoped to the user FIRST, like every other lookup here: one person's
     * session id must never answer a question asked about another's. A
     * session that is not alive (heartbeat lapsed) is not being watched
     * either, whatever its last beat claimed — otherwise a daemon that died
     * while someone was looking would silence that session's notifications
     * for the full eviction window.
     */
    isViewing(userName, sessionId) {
      prune();
      const sessions = byUser.get(userName);
      const s = sessions && sessions.get(sessionId);
      if (!s) return false;
      if (now() - s.seenAt > HEARTBEAT_DEAD_MS) return false;
      return s.viewing === true;
    },

    unregister(userName, sessionId) {
      const sessions = byUser.get(userName);
      if (sessions) sessions.delete(sessionId);
    },

    /**
     * All of this user's sessions, public shape. Empty array when the user
     * has none — never null, so callers don't need a separate "no sessions"
     * branch.
     */
    list(userName) {
      prune();
      const sessions = byUser.get(userName);
      if (!sessions) return [];
      return Array.from(sessions.values(), toPublic);
    },
  };
}
