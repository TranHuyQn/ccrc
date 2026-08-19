#!/usr/bin/env node
// Claude Code `Notification` hook -> push notification.
//
// This runs inside Claude Code every time it stops to wait for the user, so it
// must be cheap and it must never fail loudly: every path exits 0, and nothing
// is written to stderr on an expected failure. Claude Code keeps working
// whether or not the hub, the network, or the config exist.
//
// The toggle is read FIRST, before anything else happens. When it is off,
// nothing leaves the machine at all — not a DNS lookup, not a byte.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { buildNotification } from '../src/notify-payload.js';
import { findByCwd, findByPane } from '../../shared/session-registry.js';
import { ccrcHome } from '../../shared/home.js';

const CFG_DIR = path.join(ccrcHome(), '.ccrc');
const REQUEST_TIMEOUT_MS = 3000;

function readToggle() {
  try {
    // Exactly "on" and nothing else. A missing file, an unreadable one, or any
    // other content means off: silence is the safe default when the
    // configuration cannot be trusted.
    return fs.readFileSync(path.join(CFG_DIR, 'notify'), 'utf8').trim() === 'on';
  } catch {
    return false;
  }
}

function readConfig() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(CFG_DIR, 'config'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* handled by the caller: no url or token means nothing to send */ }
  return out;
}

function post(urlStr, token, body) {
  let url;
  try { url = new URL('/notify', urlStr); } catch { return process.exit(0); }
  const mod = url.protocol === 'https:' ? https : http;
  const data = JSON.stringify(body);
  const req = mod.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      authorization: `Bearer ${token}`,
    },
    timeout: REQUEST_TIMEOUT_MS,
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(data);
}

if (!readToggle()) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) { raw = ''; process.exit(0); } });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  const cfg = readConfig();
  if (!cfg.CCRC_HUB_URL || !cfg.CCRC_TOKEN) process.exit(0);
  // The pane comes first. This process is a child of the Claude Code running
  // inside the pane, so $TMUX_PANE is inherited all the way down and names the
  // pane the daemon watches — the one thing that is genuinely the same on both
  // sides. The directory is not: Claude Code reports where the SESSION
  // currently is, which walks into subdirectories as the work goes on, while
  // the registry holds the pane's own path. Matching on it alone missed
  // essentially every notification, and a notification with no session id is
  // one the hub cannot hold back while the user is looking at that terminal.
  //
  // The directory lookup stays as the fallback for a Claude Code that is not
  // running under tmux at all. Both never throw and return null when the
  // registry is missing, unreadable, or has nothing matching — in which case
  // the notification simply carries no name.
  const session = findByPane(process.env.TMUX_PANE, { tmux: process.env.TMUX, home: ccrcHome() })
    || findByCwd(payload && payload.cwd, { home: ccrcHome() });
  const note = buildNotification(payload, {
    machineName: cfg.CCRC_MACHINE_NAME || os.hostname().replace(/\.local$/, ''),
    session,
  });
  if (!note) process.exit(0);
  post(cfg.CCRC_HUB_URL, cfg.CCRC_TOKEN, note);
});
