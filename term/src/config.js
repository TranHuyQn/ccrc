// Reuse the notification system's ~/.ccrc/config rather than inventing a
// second config file: one place to look when something is wrong.
//
// There used to be a second thing read from here too: a persisted
// `~/.ccrc/term-secret`, generated once and reused across every daemon run.
// That is gone on purpose (final fix wave, item 2) — the ticket-signing
// secret is now generated fresh in memory by each daemon process (see
// ccrc-term.js) and never touches disk, so a daemon restart invalidates
// every outstanding ticket the way the design always claimed it did. See
// docs/superpowers/specs/2026-07-27-web-terminal-design.md §4.1/§4.3.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = (home) => path.join(home, '.ccrc');

export function readConfig(home = os.homedir()) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir(home), 'config'), 'utf8');
  } catch {
    return null;
  }
  const kv = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const hubUrl = kv.CCRC_HUB_URL;
  const token = kv.CCRC_TOKEN;
  const machine = kv.CCRC_MACHINE_NAME;
  if (!hubUrl || !token || !machine) return null;
  return { hubUrl, token, machine };
}
