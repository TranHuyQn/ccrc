// Encoding a scroll-wheel event the way a terminal application expects it.
//
// Why this exists: the pane the phone attaches to is usually Claude Code, and
// Claude Code is a full-screen TUI on the ALTERNATE SCREEN. tmux keeps no
// scrollback for an alternate-screen pane — measured on the live session:
// `alternate_on=1`, `history_size=2`. So the conversation the user wants to
// scroll back through is not in tmux at all; it is inside the application,
// and the only way to move it is to send the application a wheel event.
//
// The same measurement showed the application asking for exactly that:
// `mouse_any_flag=1`, `mouse_sgr_flag=1` — it has mouse reporting switched on.

// Wheel buttons in the X11 encoding every terminal inherited: 64 is wheel up,
// 65 is wheel down.
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

// The legacy encoding puts coordinates in single bytes offset by 32, so it
// cannot express anything past 223. Clamped rather than wrapped: a wrapped
// coordinate would land somewhere else entirely.
const LEGACY_MAX = 223;

/**
 * One wheel event, as the bytes to write into the pane.
 *
 * `sgr` selects the encoding the application asked for:
 *   · SGR (mode 1006) — `ESC [ < button ; col ; row M`, coordinates in
 *     decimal, so no ceiling. This is what modern TUIs request.
 *   · legacy X10 — `ESC [ M Cb Cx Cy`, one byte each, all offset by 32.
 *
 * `col`/`row` are 1-based, as both encodings define them. They matter for
 * applications that scroll the region under the pointer; a full-screen TUI
 * ignores them, but sending 0 or a negative would be malformed either way.
 */
export function wheelEvent({ up = true, sgr = true, col = 1, row = 1 } = {}) {
  const button = up ? WHEEL_UP : WHEEL_DOWN;
  const c = Math.max(1, Math.floor(col) || 1);
  const r = Math.max(1, Math.floor(row) || 1);

  if (sgr) return `\x1b[<${button};${c};${r}M`;

  // Legacy: every field is a byte at value + 32, and a coordinate past 223
  // has no representation at all.
  const cb = String.fromCharCode(32 + button);
  const cx = String.fromCharCode(32 + Math.min(c, LEGACY_MAX));
  const cy = String.fromCharCode(32 + Math.min(r, LEGACY_MAX));
  return `\x1b[M${cb}${cx}${cy}`;
}

// Applications move about three lines per wheel notch, so a request phrased in
// LINES (which is what a finger drag measures) becomes roughly that many
// notches. At least one, so a small drag still does something.
export const LINES_PER_NOTCH = 3;

// A hard ceiling on one gesture. Without it a single flick could ask for
// hundreds of events, each one a `send-keys` to tmux.
export const MAX_NOTCHES = 40;

export function notchesForLines(lines) {
  const n = Math.round(Math.abs(lines) / LINES_PER_NOTCH);
  return Math.min(Math.max(n, 1), MAX_NOTCHES);
}

// Left button, in the same X11 numbering the wheel uses (0 = left, 1 = middle,
// 2 = right). The legacy encoding has no separate "which button was let go",
// so 3 is its way of saying "released".
const BUTTON_LEFT = 0;
const LEGACY_RELEASE = 3;

/**
 * A left click at one cell, as the bytes to write into the pane.
 *
 * Both halves are sent: an application that draws a button waits for the
 * RELEASE before acting, so a press on its own looks like a finger still held
 * down and nothing happens.
 *
 * SGR distinguishes them by the final character — `M` for press, `m` for
 * release — and keeps the button number on both. The legacy encoding cannot
 * say which button was released, so it sends 3.
 */
export function clickBytes({ sgr = true, col = 1, row = 1 } = {}) {
  const c = Math.max(1, Math.floor(col) || 1);
  const r = Math.max(1, Math.floor(row) || 1);

  if (sgr) {
    return `\x1b[<${BUTTON_LEFT};${c};${r}M\x1b[<${BUTTON_LEFT};${c};${r}m`;
  }

  const cx = String.fromCharCode(32 + Math.min(c, LEGACY_MAX));
  const cy = String.fromCharCode(32 + Math.min(r, LEGACY_MAX));
  const press = `\x1b[M${String.fromCharCode(32 + BUTTON_LEFT)}${cx}${cy}`;
  const release = `\x1b[M${String.fromCharCode(32 + LEGACY_RELEASE)}${cx}${cy}`;
  return press + release;
}

/** The full byte string for a scroll gesture: `notches` copies of one event. */
export function wheelBytes({ up, sgr, col, row, notches }) {
  const one = wheelEvent({ up, sgr, col, row });
  return one.repeat(Math.min(Math.max(Math.floor(notches) || 1, 1), MAX_NOTCHES));
}
