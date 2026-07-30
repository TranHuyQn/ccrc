// Everything this project knows about Tailscale lives here.
//
// The daemon listens directly on the machine's Tailscale IP — no certificate,
// no public DNS record, no `tailscale serve`. A stopped daemon (no IP to bind
// to) produces a URL that resolves to nothing, which from the phone is
// indistinguishable from a sleeping machine. Checking up front turns that
// mystery into a sentence telling the user what to do.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];

let cached = null;

// Tailscale's own CGNAT block, 100.64.0.0/10 — every real Tailscale IPv4
// address lives here. The shape check below (`\d+\.\d+\.\d+\.\d+`) accepts
// ANY dotted-quad, including `0.0.0.0` or a LAN address like `192.168.1.50`
// — both would still pass it. Range-checking here is what stands between a
// corrupted/misbehaving `tailscale status --json` and this daemon actually
// calling listen() on one of those: binding `0.0.0.0` opens the terminal on
// every network the machine joins, exactly the mistake the comment at this
// function's only caller (ccrc-term.js) warns about — see also
// server/src/session-url.js and server/public/app.js, which duplicate this
// SAME range check on the two other places a Tailscale-shaped host string
// crosses a trust boundary (deliberately duplicated, not shared — see their
// own comments for why).
function isCgnatIp(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// checkPrereqs runs synchronously before answering a request that came from
// the phone, so a `tailscale` that hangs must not hang the answer: 2s is
// generous for a daemon reporting its own state, but still short enough that
// the user isn't left staring at a spinner.
const STATUS_TIMEOUT_MS = 2000;

export function tailscaleBin() {
  if (cached) return cached;
  if (process.env.CCRC_TAILSCALE_BIN) return (cached = process.env.CCRC_TAILSCALE_BIN);
  for (const p of CANDIDATES) if (fs.existsSync(p)) return (cached = p);
  throw new Error('Không tìm thấy Tailscale. Đặt CCRC_TAILSCALE_BIN trỏ tới nó.');
}

export function checkPrereqs(bin) {
  if (bin === undefined) {
    // tailscaleBin() throws when it can't find the binary anywhere — fine as
    // its own contract, but checkPrereqs's whole job is to turn "can't reach
    // Tailscale" into a return value the caller can act on, not an uncaught
    // exception at daemon startup. Catch it here and fold it into the same
    // no_binary shape the ENOENT branch below produces.
    try {
      bin = tailscaleBin();
    } catch {
      return { ok: false, reason: 'no_binary', message: 'Không tìm thấy Tailscale trên máy này.' };
    }
  }
  let out;
  try {
    out = execFileSync(bin, ['status', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: STATUS_TIMEOUT_MS });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, reason: 'no_binary', message: 'Không tìm thấy Tailscale trên máy này.' };
    }
    if (e && (e.signal || e.code === 'ETIMEDOUT')) {
      // Killed by our own timeout: the daemon is present but not answering.
      // Same family as a stopped daemon — the fix is the same.
      return {
        ok: false, reason: 'stopped',
        message: 'Tailscale không phản hồi kịp — mở app Tailscale và bật lên.',
      };
    }
    // Binary ran and exited non-zero: this is the same underlying situation
    // as BackendState === 'Stopped' below (the daemon isn't reachable), so it
    // gets the same actionable message rather than the generic "no binary"
    // one — the user needs to open Tailscale either way.
    return { ok: false, reason: 'stopped', message: 'Tailscale đang tắt — mở app Tailscale và bật lên.' };
  }

  let status;
  try {
    status = JSON.parse(out);
  } catch {
    return {
      ok: false, reason: 'bad_output',
      message: 'Tailscale trả về dữ liệu không đọc được — thử khởi động lại Tailscale.',
    };
  }
  // `JSON.parse('null')` succeeds and returns null — valid JSON, but not a
  // status object. Reading .BackendState off it below would throw. Same
  // family as the unparseable case above: the binary answered, but not with
  // something we can read a status out of.
  if (status === null || typeof status !== 'object') {
    return {
      ok: false, reason: 'bad_output',
      message: 'Tailscale trả về dữ liệu không đọc được — thử khởi động lại Tailscale.',
    };
  }

  if (status.BackendState === 'Stopped' || !status.BackendState) {
    return { ok: false, reason: 'stopped', message: 'Tailscale đang tắt — mở app Tailscale và bật lên.' };
  }
  const rawIps = status.Self && status.Self.TailscaleIPs;
  // TailscaleIPs is expected to be an array, but the daemon must never trust
  // that shape blindly: a string or object here would make ips.find throw,
  // turning "the phone cannot connect" into an uncaught TypeError instead of
  // the clean message this function exists to produce. Treat any non-array
  // shape the same as no addresses at all.
  const ips = Array.isArray(rawIps) ? rawIps : [];
  // Bind to the IPv4 address: Node's listen() on an IPv6 literal needs bracket
  // handling the rest of the code would have to learn, for no gain here.
  const ip = ips.find((a) => typeof a === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) {
    return { ok: false, reason: 'stopped', message: 'Tailscale chưa có địa chỉ — mở app Tailscale và đăng nhập.' };
  }
  // Shape-valid (four dotted numbers) is not the same as a REAL Tailscale
  // address. Refuse to hand back anything outside 100.64.0.0/10 rather than
  // bind on it — see the comment on isCgnatIp for why this matters more here
  // than almost anywhere else in the codebase: `ip` becomes `bindAddr` at
  // this function's only call site.
  if (!isCgnatIp(ip)) {
    return {
      ok: false,
      reason: 'bad_ip',
      message: `Tailscale trả về một địa chỉ không thuộc dải Tailscale (100.64.0.0/10): "${ip}" — từ chối lắng nghe trên nó. Thử khởi động lại Tailscale.`,
    };
  }
  return { ok: true, ip };
}
