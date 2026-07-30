#!/usr/bin/env node
// Copies the pre-built xterm.js / xterm.css / addon-fit.js from node_modules
// into term/vendor so the daemon can serve them itself — no CDN, ever, per
// the brief. Run after `npm install` at the repo root:
//
//   cd term && npm run vendor
//
// This does not run at server start or in tests: term/vendor is committed
// build output, refreshed manually whenever the xterm dependency bumps.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const termRoot = path.join(here, '..');
const nodeModules = path.join(termRoot, '..', 'node_modules');
const vendorDir = path.join(termRoot, 'vendor');

const files = [
  { src: path.join(nodeModules, '@xterm', 'xterm', 'lib', 'xterm.js'), dest: 'xterm.js' },
  { src: path.join(nodeModules, '@xterm', 'xterm', 'css', 'xterm.css'), dest: 'xterm.css' },
  { src: path.join(nodeModules, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), dest: 'addon-fit.js' },
  // The licences travel WITH the code, copied by the same loop that copies it.
  // xterm.js and addon-fit are MIT, and MIT requires the copyright notice to be
  // included in "all copies or substantial portions of the Software" — vendoring
  // a minified bundle into a repository is exactly such a copy. The minified
  // `lib/*.js` carries no header comment, so without these two files this
  // repository redistributes MIT code with the notice stripped. Kept in this
  // list rather than committed once by hand for the reason the notice went
  // missing the first time: whoever bumps the xterm dependency runs this script
  // and nothing else, so anything not in this loop silently goes stale.
  { src: path.join(nodeModules, '@xterm', 'xterm', 'LICENSE'), dest: 'xterm.LICENSE.txt' },
  { src: path.join(nodeModules, '@xterm', 'addon-fit', 'LICENSE'), dest: 'addon-fit.LICENSE.txt' },
];

fs.mkdirSync(vendorDir, { recursive: true });

for (const { src, dest } of files) {
  const destPath = path.join(vendorDir, dest);
  fs.copyFileSync(src, destPath);
  const { size } = fs.statSync(destPath);
  console.log(`${dest}: ${size} bytes`);
}
