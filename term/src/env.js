// Parse a millisecond duration out of an environment variable without ever
// silently disabling whatever the caller uses it for.
//
// `Number('not-a-number')` is `NaN`, and every comparison against `NaN`
// (`x > NaN`, `x < NaN`, ...) is `false`. A bare `Number(process.env.X ||
// fallback)` therefore doesn't throw and doesn't warn on a typo — it just
// makes the clamp it was guarding vanish. This function refuses anything
// that isn't a finite, positive number instead of letting it through.

export function parsePositiveMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// How to NAME, in a message to the user, the port this run asked for.
//
// CCRC_TERM_PORT defaults to 0 since the port became dynamic (Task 1) —
// "give me any free port". Substituting that straight into a sentence
// produces "Cổng 0 đã có tiến trình khác dùng", which is both untrue (nothing
// is ever listening on port 0) and useless (there is no port 0 to go and
// check). Port 0 has no number to report, so it gets described instead of
// numbered.
//
// Shared by the daemon's EADDRINUSE handler (term/bin/ccrc-term.js) and the
// CLI's start-timeout hint (term/bin/ccrc-term-cli.js) so the two can never
// drift into describing the same situation differently — and so both
// branches are unit-testable without having to provoke a bind failure on an
// OS-assigned port, which cannot be provoked at all.
//
// Accepts the raw env string or a number; anything that is not a positive
// integer port is treated as "OS-assigned", the same as 0 — a malformed
// CCRC_TERM_PORT is not a port number we can honestly quote back.
export function requestedPortLabel(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return 'cổng do OS tự cấp';
  return `cổng ${n}`;
}
