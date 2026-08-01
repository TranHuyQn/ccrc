// A small node:vm + fake-DOM harness for loading server/public/app.js — a
// classic browser script, no bundler, no modules — so its terminal-card
// logic can be exercised without a real browser. Mirrors the approach in
// term/test/dom-harness.mjs (same idea: run the real script in a sandboxed
// vm context, observe it through a fake DOM) but is its own file, tailored
// to app.js's own DOM footprint. Not imported across workspaces on purpose —
// the two scripts have almost nothing in common beyond the technique.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

export const APP_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'),
  'utf8',
);

// --- a bare-bones fake DOM — just enough for app.js's own DOM usage --------

export class FakeClassList {
  constructor(el) { this.el = el; }
  add(name) { if (!this.contains(name)) this.el._classes.push(name); }
  remove(name) { this.el._classes = this.el._classes.filter((c) => c !== name); }
  contains(name) { return this.el._classes.includes(name); }
  // Matches the real two-argument form: `toggle(name, force)` adds when force
  // is true and removes when it is false, rather than flipping.
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this._classes = [];
    this.classList = new FakeClassList(this);
    this.children = [];
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.onclick = null;
    // The pull-to-refresh indicator is positioned by writing to .style; a
    // plain object is enough since nothing here computes layout.
    this.style = {};
  }
  appendChild(child) { child._parent = this; this.children.push(child); return child; }
  // app.js gỡ chấm "chưa đọc" tại chỗ khi người dùng chạm vào thẻ, thay vì
  // dựng lại cả danh sách. Không có remove() thì đường đó nổ trong test dù
  // trình duyệt thật chạy tốt.
  remove() {
    const p = this._parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this._parent = null;
  }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  // app.js gắn aria-label lên chấm "chưa đọc" — chấm là thông tin, không phải
  // trang trí. Không cần đọc lại trong test, nhưng thiếu hẳn phương thức thì
  // script nổ ngay lúc dựng thẻ.
  setAttribute(name, value) { this._attrs = this._attrs || {}; this._attrs[name] = String(value); }
  getAttribute(name) { return (this._attrs && this._attrs[name]) ?? null; }
  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
  get textContent() { return this._text; }
  // Matches real DOM behavior: assigning textContent removes all existing
  // child nodes (it replaces the element's whole content with a single text
  // node), not just a label string sitting alongside untouched children.
  // app.js's list-rendering code (both #list for notifications and
  // #terminal-list here) relies on `list.textContent = '';` to clear out
  // previously appended cards before re-appending a fresh set on every
  // refresh — without this, stale nodes from earlier renders never left
  // `.children`, and `list.children[0]` kept resolving to the first card
  // ever rendered instead of the current one.
  set textContent(v) { this._text = v; this.children = []; }
}

export class FakeDocument {
  constructor(byId) {
    this._byId = byId;
    this.visibilityState = 'visible';
    this._listeners = {};
    // app.js appends the pull-to-refresh indicator to document.body, and
    // reads document.scrollingElement.scrollTop to decide whether the page
    // is at the top. scrollTop is writable so a test can put the page
    // mid-scroll and prove the gesture is NOT claimed there.
    this.body = new FakeElement('body');
    this.scrollingElement = new FakeElement('html');
    this.scrollingElement.scrollTop = 0;
  }
  getElementById(id) { return this._byId[id]; }
  createElement(tag) { return new FakeElement(tag); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  // Fires synchronously, like a real dispatchEvent — lets tests reproduce a
  // burst of same-tick events (e.g. pageshow + visibilitychange landing
  // together on a bfcache restore) without any timer machinery. Returns the
  // listeners' return values (app.js's handlers return their refresh promise
  // for exactly this reason) so a test can `await Promise.all(...)` the
  // effects of a dispatch instead of racing them.
  dispatch(type, extra) { return (this._listeners[type] || []).map((fn) => fn(extra || {})); }
}

// A fake `window` — just enough to carry 'pageshow', the event app.js
// listens for to catch a bfcache restore (see app.js's refreshOnReturn).
export class FakeWindow {
  constructor() { this._listeners = {}; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, extra) { return (this._listeners[type] || []).map((fn) => fn(extra || {})); }
}

// The full set of ids app.js reaches for via `$(id)` at SCRIPT LOAD time
// (top-level `.onclick = …` assignments) — these must exist in the fake DOM
// before the script runs at all, or those assignments throw on a `null`.
const REQUIRED_IDS = [
  'login', 'main', 'who', 'list',
  'push-state', 'enable-push',
  'token', 'login-btn', 'login-err', 'logout',
  'terminal-list', 'terminal-err', 'terminal-empty',
  'devices-wrap', 'devices', 'devices-toggle', 'devices-err',
  'pair-panel', 'pair-title', 'pair-step', 'pair-sas', 'pair-help',
  'pair-cancel', 'pair-err',
];

// --- fake IndexedDB, minimal — just enough for one key store ---------------
//
// Only `open/transaction/objectStore/get/put`, exactly what app.js uses.
// Building a full IndexedDB here would be a second harness in disguise —
// but building nothing at all would leave the key-persistence path (the one
// that decides whether the phone can pair at all) untested.
//
// `crypto` is injected as Node's REAL webcrypto: a signature in a test must
// be a real signature, or the test only proves the fake works.
export class FakeIDBRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; }
  _done(result) {
    this.result = result;
    queueMicrotask(() => { if (this.onsuccess) this.onsuccess({ target: this }); });
  }
}

export function makeFakeIndexedDB() {
  const stores = new Map(); // store name -> Map(key -> value)
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    _stores: stores,
    open(/* name, version */) {
      const req = new FakeIDBRequest();
      req.onupgradeneeded = null;
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => { storeOf(n); return {}; },
        transaction: (n) => ({
          objectStore: () => ({
            get(key) { const r = new FakeIDBRequest(); r._done(storeOf(n).get(key)); return r; },
            put(value, key) { storeOf(n).set(key, value); const r = new FakeIDBRequest(); r._done(undefined); return r; },
          }),
        }),
      };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        req._done(db);
      });
      return req;
    },
  };
}

// --- fake fetch, driven by hand from the test ------------------------------

// `impl(url, opts)` returns `{status, body}` (body will be JSON.stringify'd)
// or a full fake-Response-shaped object directly. Every call is recorded so
// tests can assert on method/headers/body, not just the outcome.
export function makeFetch(impl) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const r = await impl(url, opts, calls.length - 1);
    if (r && typeof r.json === 'function') return r;
    const status = r.status;
    const body = r.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

// --- build a fresh sandbox, load app.js into it, run it once --------------

export function loadAppPage({
  token = '', fetchImpl = null, navigatorImpl = null, indexedDBImpl = null, cryptoImpl = null,
  search = '',
} = {}) {
  const byId = {};
  const BUTTON_IDS = new Set([
    'login-btn', 'logout', 'enable-push', 'devices-toggle',
    'pair-cancel',
  ]);
  for (const id of REQUIRED_IDS) byId[id] = new FakeElement(BUTTON_IDS.has(id) ? 'button' : 'div');
  byId.token.value = '';

  const document_ = new FakeDocument(byId);

  const store = new Map();
  if (token) store.set('ccrc_token', token);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    // Web Storage API thật có length/key(i); app.js dùng chúng để dọn mốc
    // "đã đọc" của những phiên không còn tồn tại. Map giữ thứ tự chèn, đúng
    // như trình duyệt.
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };

  // sessionStorage là một kho RIÊNG, không phải bí danh của localStorage:
  // app.js cố ý chọn nó cho dấu "vừa mở phiên nào" vì nó chết khi đóng app.
  // Gộp chung hai kho ở đây sẽ làm test "mở lại app sau khi đóng" xanh sai.
  const sessionStore = new Map();
  const sessionStorage = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  };

  const fetchFn = fetchImpl || makeFetch(async () => ({ status: 404, body: {} }));
  // `reload` counts calls instead of navigating — the pull-to-refresh tests
  // assert on whether it fired, and how many times.
  // `pathname`/`search` là thứ app.js đọc `?open=` ra rồi xoá đi. `origin`
  // KHÔNG được app.js đọc ở đâu cả — nó từng bị ghép vào fragment để trang
  // terminal biết đường quay về, cơ chế đó đã bị gỡ hẳn (xem term.js). Giữ
  // lại vì `location` thật luôn có nó: một trang chạy thiếu thuộc tính chuẩn
  // là bộ khung nói dối, không phải bộ khung tối giản.
  const location = {
    href: '',
    origin: 'https://hub.example.com',
    pathname: '/',
    search,
    reloads: 0,
    reload() { this.reloads += 1; },
  };
  const window_ = new FakeWindow();
  window_.scrollY = 0;

  // app.js xoá `?open=` khỏi thanh địa chỉ ngay sau khi đọc, để một lần nạp
  // lại trang (kéo xuống để nạp lại, chẳng hạn) không được mở lại terminal
  // lần nữa. Test đọc `replaceCalls` để chứng minh việc xoá đó có xảy ra.
  const replaceCalls = [];
  const history = {
    replaceState(state, title, url) {
      replaceCalls.push({ state, title, url });
      location.search = '';
    },
  };

  const contextObj = {
    document: document_,
    localStorage,
    sessionStorage,
    location,
    history,
    fetch: fetchFn,
    // No serviceWorker/PushManager on purpose: keeps refreshPushState() on
    // its "trình duyệt không hỗ trợ" branch, and skips the bottom-of-file
    // `navigator.serviceWorker.register(...)` call — neither is what these
    // tests are about, and faking a full ServiceWorker/Push stack just to
    // load the script would be a second harness in disguise.
    // The device list needs a push subscription to say "this is the device
    // you are holding". Supplied only when a test asks for one — the default
    // stays bare so refreshPushState() keeps taking its "trình duyệt không hỗ
    // trợ" branch, as the terminal tests rely on.
    navigator: navigatorImpl || {},
    window: window_,
    atob,
    // Real browser globals app.js's key/pairing code needs: btoa to build the
    // base64url key/nonce encoding, TextEncoder to turn strings into the byte
    // buffers WebCrypto's digest()/sign() take.
    btoa,
    TextEncoder,
    // startPairing() polls GET /api/pair/<id> once a second while it waits for
    // the dev machine's nonce. Without these, that retry path throws
    // "setTimeout is not defined" the first time a test's fake nonce isn't
    // there on the very first poll — a real browser always has these, so
    // their absence here would be a harness gap, not a fact about app.js.
    setTimeout,
    clearTimeout,
    // A real browser global, and app.js uses it to decide whether a session's
    // url is one this page is willing to navigate to (isTailnetTerminalUrl).
    // Left out of the sandbox, `new URL(...)` throws ReferenceError, that
    // check's catch turns every url — including good ones — into "not
    // allowed", and the page silently refuses to open any terminal at all.
    URL,
    URLSearchParams,
    console,
    // Real Node webcrypto by default — a signature made in a test must be a
    // real signature. `cryptoImpl` lets a test swap in a partial wrapper
    // (e.g. one whose subtle.sign() throws) to exercise signAttachToken()'s
    // failure path without mutating the shared webcrypto singleton itself,
    // which every OTHER test in this file also reaches through this same
    // import.
    crypto: cryptoImpl || webcrypto,
    indexedDB: indexedDBImpl || makeFakeIndexedDB(),
  };
  const context = vm.createContext(contextObj);
  vm.runInContext(APP_JS, context, { filename: 'app.js' });

  return {
    context,
    byId,
    document: document_,
    window: window_,
    location,
    replaceCalls,
    localStorage,
    sessionStorage,
    fetch: fetchFn,
  };
}
