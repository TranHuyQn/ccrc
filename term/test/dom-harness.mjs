// Shared node:vm + fake-DOM harness for loading term.js — a classic browser
// script, no bundler, no modules — the same way in every test file that
// needs it. Originally built for term-page.test.js (Task 3); extended here
// (Task 4) with the compose box (#soan/#oto), key bar (#phim), and
// navigator/visualViewport fakes so term-input.test.js can reuse it rather
// than growing a second, drifting copy of the same machinery.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const TERM_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/term.js'),
  'utf8',
);

// --- a bare-bones fake DOM — just enough for term.js's own DOM usage ------

export class FakeElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this._text = '';
    this.className = '';
    this.tabIndex = 0;
    this._blurred = false;
    this.value = '';
    this.style = {};
    this._listeners = {};
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  querySelector(selector) { return findInTree(this, selector); }
  blur() { this._blurred = true; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
  // Fires `type` at THIS element and bubbles up through ancestors — enough
  // to support the click-delegation pattern term.js uses on #phim, and
  // plain direct listeners (submit on #soan, and anything on document).
  dispatch(type, extra) {
    const event = Object.assign({ target: this, preventDefault() {} }, extra || {});
    let node = this;
    while (node) {
      for (const fn of (node._listeners[type] || [])) fn(event);
      node = node.parent;
    }
    return event;
  }
}

function elMatches(el, selector) {
  if (selector[0] === '.') return (el.className || '').split(/\s+/).includes(selector.slice(1));
  if (selector[0] === '#') return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

function findInTree(root, selector) {
  for (const child of root.children) {
    if (elMatches(child, selector)) return child;
    const found = findInTree(child, selector);
    if (found) return found;
  }
  return null;
}

export class FakeDocument {
  constructor(byId, fonts) {
    this._byId = byId;
    this.visibilityState = 'visible';
    this._listeners = {};
    // `document.fonts` is absent in older browsers, so it stays undefined
    // unless a test asks for it — the "no font loading API at all" path has
    // to keep working, and a harness that always supplies one would hide it.
    if (fonts !== undefined) this.fonts = fonts;
  }
  getElementById(id) { return this._byId[id]; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  // `extra` is merged into the event object handed to each listener, so a
  // test can observe what a handler does with it — e.g. whether the
  // pinch-zoom blocker actually calls preventDefault().
  dispatch(type, extra) { for (const fn of (this._listeners[type] || [])) fn(Object.assign({}, extra || {})); }
}

// A fake `window` — just enough to carry innerHeight (already used by
// adjustTermHeight()) and now also 'hashchange', which term.js listens for
// so a ticket that arrives via a second tap on the PWA card (same
// origin+path, only the fragment differs — no page reload, no re-run of the
// script) still gets picked up. Real browsers fire 'hashchange' on `window`,
// never on `document`.
export class FakeWindow {
  constructor(innerHeight) {
    this.innerHeight = innerHeight;
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type) { for (const fn of (this._listeners[type] || [])) fn({}); }
}

// --- fake xterm.js + addon-fit, matching the real UMD globals -------------

export class FakeTerminal {
  constructor(opts) {
    this.opts = opts;
    this.writes = [];
    this.cols = 80;
    this.rows = 24;
    // Real xterm.js exposes a live `options` object; assigning to it is what
    // makes the terminal drop its cached character measurements and re-read
    // the font. term.js uses that to switch to the vendored font once it has
    // loaded, so the fake has to carry it too — and record every value it is
    // given, since "did it actually switch, and in what order" is the thing
    // worth asserting.
    this.options = { fontFamily: opts && opts.fontFamily };
    this.fontFamilyHistory = [this.options.fontFamily];
    const self = this;
    Object.defineProperty(this.options, 'fontFamily', {
      get() { return self._fontFamily; },
      set(v) { self._fontFamily = v; self.fontFamilyHistory.push(v); },
    });
    this._fontFamily = opts && opts.fontFamily;
    FakeTerminal.instances.push(this);
  }
  open(container) {
    // Real xterm.js builds a `.xterm-helper-textarea` inside whatever
    // container it's given — reproduce just enough of that so the
    // neutralize-it-on-open code under test has something real to find.
    const wrapper = new FakeElement('div');
    wrapper.className = 'xterm';
    const helper = new FakeElement('textarea');
    helper.className = 'xterm-helper-textarea';
    wrapper.appendChild(helper);
    container.appendChild(wrapper);
    this.helper = helper;
  }
  loadAddon() {}
  write(data) { this.writes.push(data); }
}
FakeTerminal.instances = [];

export class FakeFitAddon {
  constructor() { FakeFitAddon.instances.push(this); }
  fit() { this.fitted = true; this.fitCount = (this.fitCount || 0) + 1; }
}
FakeFitAddon.instances = [];

// Simulates `/vendor/xterm.js` having failed to load, or the global being
// otherwise unusable — the real Terminal constructor throwing.
export class ThrowingTerminal {
  constructor() { throw new Error('xterm.js chưa tải được (mô phỏng)'); }
}

// Simulates Safari private-mode-style sessionStorage: reads throw, writes
// are harmless no-ops (never actually persist to `store`, on purpose — a
// throwing setItem must not silently claim success).
export class GetThrowsStorage {
  getItem() { throw new Error('sessionStorage.getItem bị chặn (mô phỏng)'); }
  setItem() { /* not exercised by the tests that use this */ }
  removeItem() {}
}

export class SetThrowsStorage {
  getItem() { return null; }
  setItem() { throw new Error('sessionStorage.setItem bị chặn (mô phỏng)'); }
  removeItem() {}
}

// --- fake WebSocket, driven by hand from the test -------------------------

export class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  open() { this.readyState = FakeWebSocket.OPEN; if (this.onopen) this.onopen({}); }
  receive(data) { if (this.onmessage) this.onmessage({ data }); }
  // `code` is what tells a deliberate session close apart from a network
  // drop; term.js reconnects for one and stops for the other.
  dropped(code) {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose(code === undefined ? {} : { code });
  }
  // Real WebSocket#close() does NOT synchronously fire 'close' — that event
  // is queued asynchronously. term.js always detaches handlers before
  // calling this (see closeSocket()), so not firing onclose here matches
  // real behaviour closely enough for this harness.
  close() { this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.instances = [];
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

// --- fake clock — timers advanced by hand, no real waiting -----------------

export function makeClock() {
  let nextId = 1;
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      const i = pending.findIndex((t) => t.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    // Fires the oldest still-pending timer and returns the delay it was
    // scheduled with, so a test can assert on the backoff sequence itself.
    fireNext() {
      const t = pending.shift();
      if (!t) throw new Error('không có timer nào đang chờ để bắn');
      t.fn();
      return t.ms;
    },
  };
}

// --- the key bar, matching public/index.html's #phim exactly --------------
//
// Same labels, and the same LITERAL (unescaped) data-seq attribute text the
// real HTML carries — term.js has to unescape `\x1b` etc. itself, so the
// fixture must hand it the same raw text a browser parsing index.html would.
// Must stay in step with the buttons declared in term/public/index.html —
// term-input.test.js walks this list to prove every button sends the right
// bytes, so a button added there and forgotten here is simply untested.
export const KEY_BUTTONS = [
  ['Esc', '\\x1b'],
  ['↑', '\\x1b[A'],
  ['↓', '\\x1b[B'],
  ['←', '\\x1b[D'],
  ['→', '\\x1b[C'],
  ['⏎', '\\r'],
  ['Tab', '\\t'],
  ['⇧Tab', '\\x1b[Z'],
  ['^C', '\\x03'],
];

// --- build a fresh sandbox, load term.js into it, run it once -------------

export function loadTermPage({
  hash = '',
  storedKey = null,
  sessionStorageImpl = null,
  TerminalCtor = FakeTerminal,
  navigatorImpl = {},
  visualViewportImpl = undefined,
  windowInnerHeight = 800,
  fontsImpl = undefined,
  // Whether a text selection is currently active. term.js checks this before
  // treating a drag as a scroll — a drag that is extending a selection
  // belongs to copy, not to scrolling.
  selectionCollapsed = true,
  // How many entries the session history holds. 1 means "this tab has been
  // nowhere else" — the shape you get from a typed URL or a bookmark, where
  // there is nothing to go back to. Default 2: arrived from the session list.
  historyLength = 2,
} = {}) {
  FakeTerminal.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  FakeFitAddon.instances.length = 0;

  const trangthai = new FakeElement('div'); trangthai.id = 'trangthai';
  const quaylai = new FakeElement('button'); quaylai.id = 'quaylai'; quaylai.hidden = true;
  const termContainer = new FakeElement('div'); termContainer.id = 'term';

  const phim = new FakeElement('div'); phim.id = 'phim';
  const phimButtons = KEY_BUTTONS.map(([label, seq]) => {
    const b = new FakeElement('button');
    b.textContent = label;
    b.setAttribute('data-seq', seq);
    phim.appendChild(b);
    return { label, seq, el: b };
  });

  const soan = new FakeElement('form'); soan.id = 'soan';
  const oto = new FakeElement('textarea'); oto.id = 'oto';
  soan.appendChild(oto);
  const submitBtn = new FakeElement('button');
  submitBtn.setAttribute('type', 'submit');
  soan.appendChild(submitBtn);

  const document_ = new FakeDocument({ trangthai, quaylai, term: termContainer, phim, soan, oto }, fontsImpl);

  let sessionStorage;
  if (sessionStorageImpl) {
    sessionStorage = sessionStorageImpl;
  } else {
    const store = new Map();
    if (storedKey) store.set('ccrc_session_key', storedKey);
    sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    };
  }

  const location = { hash, pathname: '/', search: '', host: 'localhost:8730', protocol: 'http:' };
  const historyCalls = [];
  const backCalls = [];
  const history = {
    length: historyLength,
    back() { backCalls.push(true); },
    replaceState(state, title, url) {
      historyCalls.push({ state, title, url });
      const i = url.indexOf('#');
      location.hash = i === -1 ? '' : url.slice(i);
    },
  };

  const clock = makeClock();
  const window_ = new FakeWindow(windowInnerHeight);
  window_.getSelection = () => ({ isCollapsed: selectionCollapsed });

  const contextObj = {
    document: document_,
    location,
    history,
    sessionStorage,
    Terminal: TerminalCtor,
    FitAddon: { FitAddon: FakeFitAddon },
    WebSocket: FakeWebSocket,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    navigator: navigatorImpl,
    window: window_,
    console,
    // A fresh vm context gets NOTHING beyond bare V8 intrinsics — not even
    // Node's own globals — so this has to be handed in explicitly, same as
    // setTimeout/console above. term.js uses it to send keystrokes as
    // binary WebSocket frames (see sendInput() — real browsers have this
    // as a standard global with no setup needed).
    TextEncoder,
  };
  if (visualViewportImpl !== undefined) contextObj.visualViewport = visualViewportImpl;

  const context = vm.createContext(contextObj);

  vm.runInContext(TERM_JS, context, { filename: 'term.js' });

  return {
    term: FakeTerminal.instances[0],
    fitAddon: FakeFitAddon.instances[0],
    trangthai,
    termContainer,
    phim,
    phimButtons,
    soan,
    oto,
    document: document_,
    window: window_,
    location,
    historyCalls,
    backCalls,
    quaylai,
    sessionStorage,
    clock,
    navigator: navigatorImpl,
    ws: () => FakeWebSocket.instances,
  };
}
