// Static file serving for the daemon's HTTP server: the browser page, its
// CSS, and the vendored xterm.js build. This module has no side effects at
// import time (no env reads, no process.exit) so it can be unit-tested
// directly, unlike bin/ccrc-term.js which is a script.
//
// The only property that matters here is that a request can never read a
// file outside the public/vendor root it was given, and that nothing in
// this path can crash the process — both are unauthenticated: any request,
// with no ticket and no key, reaches this code before either is checked.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // The vendored terminal font. Served with the wrong type a browser refuses
  // to use the font at all — it downloads, then silently falls back — which
  // would show up only as Vietnamese and box-drawing glyphs quietly coming
  // from somewhere else, the exact defect the font is here to fix.
  '.woff2': 'font/woff2',
  // The Nerd Font icon set ships as TrueType only — no woff2 build exists
  // upstream (checked: jsDelivr, fontsource, the nerd-fonts repo itself).
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Fonts are content-addressed by their filename here — a different font means
// a different name, as DejaVu → JetBrains showed — so they can be cached hard
// and never revalidated. Everything else must be revalidated (see
// cacheControlFor).
const IMMUTABLE_EXTENSIONS = new Set(['.woff2', '.ttf']);

// Below this, compressing costs more than it saves. Above it, the two files
// that matter are the icon font (2.4 MB, ~40% off) and the xterm build.
const GZIP_MIN_BYTES = 64 * 1024;

// Compressed bodies, keyed by resolved path. A daemon serves one pane for one
// session and its files never change underneath it, so this can be a plain
// memoisation with no invalidation — and the alternative, gzipping 2.4 MB on
// every request, would be worse than not compressing at all.
const gzipCache = new Map();

export function clientAcceptsGzip(req) {
  const h = req && req.headers && req.headers['accept-encoding'];
  return typeof h === 'string' && /(^|[\s,])gzip($|[\s,;])/.test(h);
}

export function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
}

// Without any cache header a browser applies its own heuristic and holds on to
// these files — which meant a phone kept running the term.js it first
// downloaded, silently, after the daemon had been updated and restarted. It
// cost a real debugging session here: a scroll gesture did nothing in the
// browser while the same code passed its daemon tests, because the page was
// running yesterday's script.
//
// `no-cache` does not mean "do not store" — it means "revalidate before
// using", so an unchanged file still costs a 304 rather than a re-download.
// The font is the exception: its contents are pinned by its filename (swapping
// fonts changes the name, as DejaVu → JetBrains just did), so it can be cached
// hard and never revalidated.
export function cacheControlFor(filePath) {
  return IMMUTABLE_EXTENSIONS.has(path.extname(filePath))
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

// Resolves `reqPath` under `root` and returns the resolved absolute path —
// but ONLY if it is still contained in `root`; otherwise returns null.
//
// `path.normalize` collapses `..` segments syntactically, and on POSIX
// `path.join` never lets an absolute second argument override `root` (unlike
// `path.resolve`), so in the one real caller of this function — HTTP request
// paths, which `URL.pathname` guarantees always start with `/` — neither of
// those alone can produce something outside `root`. That is exactly why a
// test asserting "traversal is blocked" against real HTTP requests does NOT
// exercise this check: it never has anything left to catch. This function is
// exported specifically so a test can call it directly with an input that
// bypasses that guarantee — e.g. a RELATIVE path (no leading `/`), which
// `path.normalize` does not clamp and which `path.join` will walk upward out
// of `root` — proving this check, not the caller's path shape, is what
// stops that case.
export function resolveWithinRoot(root, reqPath) {
  const rootResolved = path.resolve(root);
  const candidate = path.join(rootResolved, path.normalize(reqPath));
  const resolved = path.resolve(candidate);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

// Serves `reqPath` from under `root`. Never lets a synchronous throw escape:
// `fs.readFile` throws SYNCHRONOUSLY (before ever invoking its callback) for
// some malformed paths — a NUL byte is the one this daemon was actually
// caught by (`ERR_INVALID_ARG_VALUE`, from `%00` surviving decode) — and an
// exception thrown inside an `http.Server` request listener has no built-in
// recovery: it propagates out of `Server.emit('request')` as an uncaught
// exception and kills the whole process. That is unacceptable here
// specifically because this handler runs before any authentication at all —
// an anonymous request on the tailnet must not be able to end the daemon.
// The explicit `\0` check below is the primary fix (reject before ever
// touching the filesystem); the try/catch is the second layer, so no other
// filesystem call added here in the future gets a free pass to crash the
// process just because nobody thought to guard it too.
export function serveStatic(res, root, reqPath, opts = {}) {
  try {
    if (reqPath.includes('\0')) {
      res.writeHead(400);
      res.end();
      return;
    }
    const resolved = resolveWithinRoot(root, reqPath);
    if (!resolved) {
      res.writeHead(404);
      res.end();
      return;
    }
    fs.readFile(resolved, (err, data) => {
      try {
        if (err) { res.writeHead(404); res.end(); return; }
        // Compression is best-effort and must never cost the response: any
        // failure here falls straight back to sending the file as it is.
        let body = data;
        const headers = {
          'content-type': contentTypeFor(resolved),
          'cache-control': cacheControlFor(resolved),
        };
        if (opts.gzip && data.length >= GZIP_MIN_BYTES) {
          try {
            let packed = gzipCache.get(resolved);
            if (!packed) {
              packed = zlib.gzipSync(data, { level: 9 });
              gzipCache.set(resolved, packed);
            }
            body = packed;
            headers['content-encoding'] = 'gzip';
            // Told to caches that a gzipped and a plain body are different
            // answers to the same URL — without it, a shared cache could hand
            // a gzipped font to a client that never asked for one.
            headers.vary = 'accept-encoding';
          } catch {
            body = data; // compression failed — send the original
          }
        }
        headers['content-length'] = body.length;
        res.writeHead(200, headers);
        res.end(body);
      } catch {
        try { res.writeHead(500); res.end(); } catch {}
      }
    });
  } catch {
    try { res.writeHead(500); res.end(); } catch {}
  }
}

// Routes a request to the public or vendor root and serves it. `publicDir`
// and `vendorDir` must already be absolute, resolved paths (the caller owns
// locating them relative to its own module, since this module has no
// knowledge of where it is installed).
export function handleStatic(req, res, { publicDir, vendorDir }) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      // Decoded twice on purpose: `URL` itself already turns simple escapes
      // like %2e into literal characters (and folds any resulting `..`
      // before we ever see it), but leaves %2f encoded since it is a path
      // delimiter. This decode surfaces that last case as a real `/` so the
      // containment check sees the path an attacker actually intended,
      // instead of being fooled by leftover encoding.
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400); res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(404); res.end();
      return;
    }

    const opts = { gzip: clientAcceptsGzip(req) };
    if (pathname === '/') {
      serveStatic(res, publicDir, '/index.html', opts);
    } else if (pathname.startsWith('/vendor/')) {
      serveStatic(res, vendorDir, pathname.slice('/vendor'.length), opts);
    } else {
      serveStatic(res, publicDir, pathname, opts);
    }
  } catch {
    // See serveStatic's own try/catch: this outer one exists so that a
    // synchronous throw ANYWHERE in request handling — not just inside
    // serveStatic — still can't take the process down. Cheap insurance for
    // a handler that runs on every unauthenticated request this daemon ever
    // receives.
    try { res.writeHead(500); res.end(); } catch {}
  }
}
