// Turn a raw Claude Code `Notification` hook payload into the push notification
// the phone shows. Pure: no I/O, no config reading — everything it needs is an
// argument, so it can be tested against the real payload shapes.

// Whitelist, deliberately. Claude Code emits exactly two notification types
// today (measured: idle_prompt 131, permission_prompt 70). A type we do not
// recognise must stay silent rather than guess a wording for it.
const KINDS = {
  idle_prompt: { icon: '🔔', body: 'Claude đang chờ bạn nhập' },
  // `permission_prompt` covers BOTH a permission request and an
  // AskUserQuestion (measured: 63 of 65 questions emit this type), so the
  // wording must not say "duyệt quyền" — it would be wrong about half the time.
  permission_prompt: { icon: '🔐', body: 'Claude cần bạn xác nhận' },
};

export function buildNotification(payload, opts = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.hook_event_name !== 'Notification') return null;
  const kind = KINDS[payload.notification_type];
  if (!kind) return null;

  const machine = opts.machineName || 'máy dev';
  // The directory basename used to go here. It named the project on a lock
  // screen and in every screenshot — a leak, and one the user cannot undo
  // after the fact. What appears now is the session's own name: an opaque id
  // unless they chose one with `/remote on <tên>`.
  //
  // That name comes from the local session registry, which only has an entry
  // while a terminal daemon is running for this directory. No entry means no
  // name — the machine alone. Falling back to the directory here would
  // reintroduce the leak precisely when `/remote` is off, i.e. most of the
  // time.
  const session = opts.session || null;
  const label = session && typeof session.name === 'string' ? session.name : '';
  const where = label ? `${machine} · ${label}` : machine;

  return {
    type: payload.notification_type,
    title: `${kind.icon} ${where}`,
    body: kind.body,
    // Lets the hub recognise a notification for a session the user already
    // has open on their phone, and hold the push back. Absent when no
    // terminal is running for this directory, which is the common case.
    sessionId: session && typeof session.sessionId === 'string' ? session.sessionId : undefined,
    // Per-type tag so a "waiting" notification does not replace a pending
    // "needs you" one on the phone.
    tag: `ccrc-${payload.notification_type}`,
  };
}
