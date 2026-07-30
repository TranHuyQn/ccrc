// The browser side of the one-pane terminal. This file is display and
// connection lifecycle ONLY — the compose box and key bar are Task 4.
//
// Core rule (spec §5.1): xterm.js takes keyboard input through a hidden
// `.xterm-helper-textarea`. On mobile that textarea is the direct cause of
// every keyboard defect this project researched (predictive text corruption,
// backspace misbehaving, the soft keyboard opening unbidden or refusing to
// open at all). So this terminal never takes keyboard input at all:
// `disableStdin: true` plus explicitly neutralizing that textarea. It must
// never take focus and never raise the on-screen keyboard.
//
// Core rule (overrides the plan text, not a detail): the two connection
// kinds are told apart by WHICH query param the client itself chose to send,
// never by sniffing the first byte of a message. A `?token=` connection
// (Task 9: was `?ticket=` — the phone signs its own attach token now, the
// hub never mints one) reads exactly one message as the `ccrc_session`
// control frame, then every later message is terminal data, unconditionally.
// A `?key=` connection never gets a control frame — every message is
// terminal data from byte one. Sniffing "does this start with `{`" would
// swallow real pane output that happens to start with a brace.
'use strict';

(function () {
  var STORAGE_KEY = 'ccrc_session_key';
  // Khớp với CLOSE_SESSION_ENDED bên daemon: "phiên chấm dứt hẳn", khác với
  // rớt mạng. Xem bin/ccrc-term.js.
  var CLOSE_SESSION_ENDED = 4001;
  // Khớp với CLOSE_DEVICE_NOT_PAIRED bên daemon: "thiết bị chưa được ghép với
  // máy này". Xem bin/ccrc-term.js — vì sao phải bắt tay xong rồi mới đóng
  // bằng mã riêng, thay vì 401 câm mà JS không đọc được.
  var CLOSE_DEVICE_NOT_PAIRED = 4003;
  // Sau khi phiên đóng hẳn: đủ lâu để đọc xong câu giải thích, đủ ngắn để
  // không thành ra đứng hình. Có nút bấm cho ai không muốn đợi.
  var BACK_DELAY_MS = 1500;
  var BACKOFF_START_MS = 1000;
  var BACKOFF_MAX_MS = 30000;

  // The system stack, always available: `ui-monospace` resolves to SF Mono on
  // iOS and macOS, Menlo covers what it doesn't. Measured in a browser — both
  // draw every Vietnamese letter and every box-drawing character at one
  // advance width, which is the property the grid depends on.
  var FONT_STACK_SYSTEM = 'ui-monospace, SFMono-Regular, Menlo, "Courier New", monospace';
  // Two vendored fonts, in this order on purpose (see term.css for what each
  // covers, measured from their cmap tables):
  //   JetBrains Mono Web — every letter, digit and box-drawing character,
  //     including all 134 Vietnamese ones. All TEXT comes from here.
  //   Nerd Icons Web    — icons only, not a single letter. A shell prompt's
  //     separators and its folder/git/clock glyphs live in the private-use
  //     area; without this they are empty boxes on the phone.
  // Icons second, and its @font-face carries a `unicode-range`, so it can
  // never supply a letter and its 2.4 MB is fetched only when an icon is
  // actually on screen.
  var VENDORED_FONTS = ['JetBrains Mono Web', 'Nerd Icons Web'];
  var FONT_STACK_WEB = '"JetBrains Mono Web", "Nerd Icons Web", ' + FONT_STACK_SYSTEM;

  var trangthaiEl = document.getElementById('trangthai');
  var termEl = document.getElementById('term');

  function setStatus(text, cls) {
    trangthaiEl.textContent = text;
    trangthaiEl.className = cls || '';
  }

  // --- quay lại danh sách phiên khi phiên đã đóng hẳn ----------------------
  //
  // Đóng tab thì KHÔNG làm được: `window.close()` chỉ chạy với cửa sổ do
  // script mở ra, mà trang này được mở bằng `location.href` từ danh sách
  // phiên — cùng một tab. Với PWA cài ra màn hình chính lại còn không có tab
  // nào để đóng. Nhưng vì terminal nằm ĐÈ LÊN danh sách trong cùng tab, quay
  // lại chính là thứ tương đương, và làm được ở mọi trình duyệt.

  var quaylaiEl = document.getElementById('quaylai');

  // `document.referrer` KHÔNG dùng được ở đây: hub chạy https còn trang này
  // chạy http trên IP tailnet, và chính sách referrer mặc định không gửi gì
  // khi hạ cấp https → http. Còn lại history.length: tab mới tinh là 1, còn
  // đi từ danh sách phiên sang thì ít nhất là 2.
  function canGoBack() {
    try {
      return !!(history && history.length > 1);
    } catch (e) {
      return false;
    }
  }

  function goBack() {
    try {
      history.back();
    } catch (e) {
      /* không quay lại được thì câu thông báo vẫn còn nguyên trên màn hình */
    }
  }

  // Gắn MỘT lần ở đây, không gắn trong onclose: nút đang ẩn nên không ai bấm
  // được, còn gắn trong onclose thì mỗi lần đóng lại chồng thêm một listener —
  // bấm một cái sẽ lùi lịch sử nhiều bước.
  if (quaylaiEl) quaylaiEl.addEventListener('click', goBack);

  // --- ticket from the URL fragment, wiped immediately (spec §6) ----------
  //
  // Done first, before anything else — including terminal setup below — so
  // a ticket never lingers in the address bar or history regardless of
  // whether the rest of the page manages to come up.

  var ticket = readAndClearTicket();

  function readAndClearTicket() {
    var m = /^#t=(.+)$/.exec(location.hash || '');
    var t = m ? decodeURIComponent(m[1]) : null;
    // Only replace when there was actually a ticket to strip — but when
    // there WAS one, it must never survive as a history entry or in the
    // visible address bar. replaceState (not setting location.hash) is what
    // avoids adding a new history entry.
    if (m) {
      history.replaceState(null, '', location.pathname + (location.search || ''));
    }
    return t;
  }

  // --- giữ trang ở 1×, không cho phóng to ---------------------------------
  //
  // iOS Safari ignores the viewport meta's `user-scalable=no` on purpose, so
  // on iPhone cancelling Safari's own `gesturestart` is the only way to
  // refuse pinch-zoom; Chrome and Android are covered by `touch-action` in
  // term.css. This matters more here than on the notification page: xterm
  // sizes its grid to the viewport and reports that size to tmux, so a zoomed
  // page would be showing a grid that no longer matches what tmux was told.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
    document.addEventListener(name, function (e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
    }, { passive: false });
  });

  // --- xterm setup — display only, never takes input ----------------------
  //
  // Guarded: `new Terminal(...)` throws if /vendor/xterm.js failed to load
  // (stale cache, daemon restarted mid-request, etc.), and `term.open()`
  // can fail for the same reason. There is nothing useful this page can do
  // without a place to draw the pane, so fail loudly in the status line
  // instead of leaving an uncaught exception and a silently blank page.

  var term;
  var fit;
  try {
    // Built on the system stack, NOT the vendored one: xterm measures its
    // cell size from whatever font is resolvable at construction time, and
    // that measurement decides the column count this page reports to tmux.
    // Naming a font that is still downloading would have it measure the
    // fallback and report a size derived from the wrong metrics.
    // useVendoredFont() below switches over once the file has actually loaded.
    term = new Terminal({ disableStdin: true, fontFamily: FONT_STACK_SYSTEM });
    term.open(termEl);
    neutralizeHelperTextarea();
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    fit.fit();
  } catch (e) {
    setStatus('Không khởi tạo được terminal (thiếu xterm.js?) — tải lại trang để thử lại.', 'err');
    return; // no display, so no point opening a WebSocket either
  }

  function neutralizeHelperTextarea() {
    var ta = termEl.querySelector && termEl.querySelector('.xterm-helper-textarea');
    if (!ta) return;
    // Belt and braces on top of disableStdin: this textarea is the one DOM
    // element xterm.js would otherwise let grab focus, and focus is what
    // pops the on-screen keyboard. Disable it outright so that can't happen.
    ta.setAttribute('disabled', 'disabled');
    ta.setAttribute('readonly', 'readonly');
    ta.tabIndex = -1;
    if (typeof ta.blur === 'function') ta.blur();
  }

  // --- sessionStorage, guarded ----------------------------------------------
  //
  // Safari private mode (and some locked-down browser configurations) can
  // make sessionStorage throw on every call instead of just being empty.
  // Neither a read nor a write here may be allowed to crash the page —
  // degrade to "no stored key" and say so, instead of an uncaught exception.

  var storageBroken = false;

  function safeStorageGet(key) {
    try { return sessionStorage.getItem(key); }
    catch (e) { storageBroken = true; return null; }
  }

  function safeStorageSet(key, value) {
    try { sessionStorage.setItem(key, value); }
    catch (e) { storageBroken = true; }
  }

  function safeStorageRemove(key) {
    try { sessionStorage.removeItem(key); }
    catch (e) { storageBroken = true; }
  }

  // --- connection lifecycle ------------------------------------------------

  var backoffMs = BACKOFF_START_MS;
  var reconnectTimer = null;
  var ws = null;

  function wsUrl(query) {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/attach?' + query;
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    var key = safeStorageGet(STORAGE_KEY);
    var url;
    var expectControlFrame;
    var usingTicket = false;
    var usingKey = false;
    if (ticket) {
      // A ticket sitting in the URL fragment wins over a stored key, even
      // when one exists. It is an explicit act by the user — they just
      // tapped the card in the PWA — and unlike a stored key it cannot be
      // stale: session keys live in RAM on the daemon only, so a daemon
      // restart (`/remote off` then `/remote on`, a crash, the machine
      // sleeping — all ordinary) kills every key it had issued while a
      // freshly minted ticket keeps working. Trying the key first would
      // mean refusing a perfectly good ticket in favour of a credential
      // that is, in the common case that matters, already dead.
      // `token=`, không phải `ticket=`: giá trị này giờ là token v2 điện
      // thoại tự ký (term/src/ticket.js), daemon đọc bằng
      // url.searchParams.get('token') — xem bin/ccrc-term.js. Biến cục bộ
      // vẫn tên `ticket` để đỡ phải đổi cả file, chỉ tham số trên dây đổi.
      url = wsUrl('token=' + encodeURIComponent(ticket));
      expectControlFrame = true;
      usingTicket = true;
    } else if (key) {
      url = wsUrl('key=' + encodeURIComponent(key));
      expectControlFrame = false;
      usingKey = true;
    } else {
      // No stored key, and no ticket left either. Two ways to get here: the
      // ticket (if there ever was one) was already spent by a connection
      // that opened and then died before handing back a session key, or the
      // stored key was just discarded above (onclose) because the daemon
      // refused it outright. Either way, no amount of retrying here can
      // possibly succeed without a fresh ticket from the app, so this
      // message REPLACES an endless silent retry loop — it does not omit
      // one. No timer is scheduled on purpose.
      // Không còn nói riêng "vé đã dùng": dưới mô hình ký trên điện thoại
      // (Task 9), nguyên nhân thường gặp hơn là máy này chưa được ghép với
      // máy dev đó, hoặc đã bị gỡ. Giữ "hết hạn" trong câu vì trường hợp
      // token vừa dùng xong (đã mở, rồi rớt trước khi kịp nhận sessionKey)
      // vẫn xảy ra thật, và cách xử lý — quay lại lấy link mới — là như nhau.
      setStatus('Phiên đã hết hạn, hoặc điện thoại này chưa được ghép với máy đó (hay đã bị gỡ) — '
        + 'quay lại danh sách, ghép máy nếu cần, rồi mở lại thẻ Terminal.', 'err');
      return;
    }

    setStatus(storageBroken
      ? 'đang nối… (bộ nhớ phiên trình duyệt bị chặn — nối lại sau có thể cần vé mới)'
      : 'đang nối…', 'dim');
    // True until the first message on THIS socket arrives; consumed exactly
    // once, then never consulted again for the lifetime of this socket.
    var controlFramePending = expectControlFrame;

    var socket = new WebSocket(url);
    ws = socket;
    // True once THIS socket's upgrade actually completes. Distinguishes a
    // key that the daemon flat-out refused (never opened at all — the 401
    // is written straight to the raw socket, before any WebSocket upgrade)
    // from an ordinary drop of a connection that had been working fine.
    var openedThisSocket = false;

    socket.onopen = function () {
      openedThisSocket = true;
      // The ticket is only ACTUALLY spent once the daemon accepts the
      // upgrade — not the instant this attempt started. Nulling it here,
      // not before creating the socket, means a connection that never even
      // opens (daemon down, network unreachable) leaves the ticket intact
      // for the next retry instead of throwing away a still-valid
      // credential over nothing more than a network blip.
      if (usingTicket) ticket = null;
      backoffMs = BACKOFF_START_MS;
      setStatus('đã nối', 'ok');
      // The daemon needs SOME size before the user ever touches the
      // keyboard — waiting for the first relayout() would leave it
      // guessing at connect time. reportSize() is defined further down
      // this file but hoisted (function declaration), so it already
      // exists by the time this fires.
      reportSize();
      // Same reason, for the other thing the daemon assumes at connect time:
      // it counts a fresh client as watching, which is right for a normal
      // open and wrong for a page restored from bfcache while still hidden.
      reportVisibility();
    };

    socket.onmessage = function (ev) {
      if (controlFramePending) {
        controlFramePending = false;
        handleControlFrame(ev.data);
        return;
      }
      term.write(ev.data);
    };

    socket.onclose = function (ev) {
      // The daemon says this session is over — `/remote off`, Claude exited,
      // the pane died. Retrying cannot bring it back, and a spinner that
      // never resolves is worse than a sentence saying what happened. No
      // timer is scheduled on purpose.
      if (ev && ev.code === CLOSE_SESSION_ENDED) {
        // The key belonged to a daemon that is gone; keeping it would only
        // have the next visit try a credential already known to be dead.
        safeStorageRemove(STORAGE_KEY);
        if (!canGoBack()) {
          // Mở thẳng URL này (gõ tay, hoặc bookmark) thì không có chỗ nào để
          // quay về — `history.back()` sẽ im lặng không làm gì. Giữ nguyên câu
          // thông báo, đừng hứa một việc không xảy ra.
          setStatus('Phiên đã đóng trên máy — mở lại bằng /remote on rồi vào lại từ ứng dụng.', 'err');
          return;
        }
        setStatus('Phiên đã đóng trên máy — đang quay lại danh sách…', 'err');
        if (quaylaiEl) quaylaiEl.hidden = false;
        setTimeout(goBack, BACK_DELAY_MS);
        return;
      }
      if (ev && ev.code === CLOSE_DEVICE_NOT_PAIRED) {
        // Nối lại mãi cũng vô ích: máy này chưa có khoá công khai của điện
        // thoại. Dừng hẳn và chỉ đúng việc cần làm.
        setStatus('Điện thoại này chưa được ghép với máy đó. Quay lại danh sách và bấm "Ghép máy này".', 'err');
        return;
      }
      if (usingKey && !openedThisSocket) {
        // The daemon refused this key outright — most commonly because it
        // restarted and every key it had issued died with it (session keys
        // live in RAM only, on purpose). Retrying the SAME key would just
        // be refused again, forever — the exact bug observed live: status
        // stuck on "đang nối lại…" while a valid ticket sat unused. Discard
        // it here so the next connect() (scheduled below, same as any
        // other drop) re-decides from scratch: a ticket if one has since
        // become available (e.g. the user tapped the card again — see the
        // hashchange handler below), otherwise the unrecoverable branch
        // above, which stops instead of looping on a credential already
        // known to be dead.
        safeStorageRemove(STORAGE_KEY);
      }
      setStatus('mất kết nối — đang nối lại…', 'err');
      scheduleReconnect();
    };

    socket.onerror = function () {
      // A real WebSocket fires 'close' right after 'error'; onclose above
      // already drives the reconnect, so there is nothing extra to do here
      // besides not letting an unhandled listener throw.
    };
  }

  function handleControlFrame(raw) {
    var msg = null;
    try { msg = JSON.parse(raw); } catch (e) { /* malformed control frame */ }
    if (msg && msg.type === 'ccrc_session' && typeof msg.key === 'string') {
      safeStorageSet(STORAGE_KEY, msg.key);
    }
    // Whatever this frame was — valid session key, malformed JSON, anything
    // else — it is never written to the terminal. It was consumed as THE
    // control frame for this connection, not as pane data.
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function closeSocket(s) {
    if (!s) return;
    // Detach handlers first: this socket is being discarded on purpose (a
    // fresher connect() is about to replace it), so any close/error it
    // still fires must not also trigger a second, redundant reconnect.
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try { s.close(); } catch (e) { /* already closed/closing — fine */ }
  }

  // On a phone the app is backgrounded constantly, and each return to the
  // foreground fires this. If the current socket is still OPEN or still
  // CONNECTING there is nothing to do — connecting again would leave two
  // live sockets both writing to the same terminal.
  document.addEventListener('visibilitychange', function () {
    // Told to the daemon on EVERY change, not only when becoming visible:
    // "hidden" is the half that matters, because it is what makes push
    // notifications resume for this session. Sent before the reconnect
    // check below, which returns early in the common case.
    reportVisibility();
    if (document.visibilityState !== 'visible') return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    closeSocket(ws);
    backoffMs = BACKOFF_START_MS;
    connect();
  });

  // A second tap on the terminal card in the PWA navigates to the SAME
  // origin+path with only the fragment changed (a fresh `#t=<ticket>`).
  // That does not reload the page — the browser fires 'hashchange' and
  // nothing else re-runs — so without this listener the new ticket would
  // sit untouched in location.hash forever while the page (already open,
  // possibly stuck on a dead key — see the onclose refusal handling above)
  // does nothing with it.
  window.addEventListener('hashchange', function () {
    var fresh = readAndClearTicket();
    if (!fresh) return; // fragment changed to something with no ticket in it
    ticket = fresh;
    // A fresh ticket is a deliberate act — the user re-opened the card on
    // purpose — so it supersedes any stored key outright, not merely
    // outranks it: discard the key now rather than leaving it as a fallback
    // that could win a later race (e.g. this very ticket's connection
    // failing before a new key is minted).
    safeStorageRemove(STORAGE_KEY);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    closeSocket(ws);
    backoffMs = BACKOFF_START_MS;
    connect();
  });

  // --- compose box + key bar (Task 4, spec §5.2 §5.3) -----------------------
  //
  // Everything term.js ever sends to the daemon over the WebSocket goes
  // through one of the two functions below — nothing else may call
  // ws.send(), and neither may fire while the socket is not actually open.
  //
  // The WIRE FRAME TYPE is what tells the daemon (bin/ccrc-term.js) apart
  // keystrokes from control messages — never the content. Binary frames are
  // typed into the pane verbatim via `tmux send-keys -H`; text frames are
  // parsed as JSON control messages (currently just `ccrc_resize`) and are
  // NEVER typed. Sending the resize report as plain text through the same
  // path as keystrokes used to mean a JSON blob got typed into the user's
  // live Claude Code session on every rotate/keyboard event — see
  // task-4-report.md. Keep these two paths separate.

  var otoEl = document.getElementById('oto');
  var soanEl = document.getElementById('soan');
  var phimEl = document.getElementById('phim');

  // Keystrokes — always a BINARY frame. TextEncoder is a standard browser
  // global; the test harness supplies it explicitly in the vm sandbox the
  // same way it already does for setTimeout/console.
  function sendInput(text) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(text));
  }

  // Control messages — always a TEXT frame, always JSON, never typed.
  function sendControl(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // --- Đường 1: ô soạn kiểu chat, bracketed paste (spec §5.2) ---------------
  //
  // Sending raw text would turn every '\n' the user typed into its own
  // Enter once it reaches the pane — for multi-line input that submits the
  // first line to Claude as a finished answer and feeds the rest in as
  // further prompts. Wrapping it as bracketed paste (ESC[200~ ... ESC[201~)
  // makes the TUI treat the whole block as one paste instead, then a plain
  // \r commits it.
  //
  // Enter inside the textarea is deliberately left alone: a <textarea>
  // does not implicitly submit its form on Enter the way a text <input>
  // does, so this needs NO keydown handling at all. Only the Gửi button
  // (the form's submit) ever sends.
  if (soanEl && otoEl) {
    soanEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = otoEl.value;
      if (text.length === 0) return; // nothing typed — nothing to send
      sendInput('\x1b[200~' + text + '\x1b[201~\r');
      otoEl.value = '';
    });
  }

  // --- Đường 2: thanh phím điều khiển (spec §5.3) ---------------------------
  //
  // One click listener on the container (event delegation), matching how
  // the buttons are declared in index.html: plain `<button data-seq="…">`,
  // nothing per-button to keep in sync here.

  function unescapeSeq(s) {
    return String(s)
      .replace(/\\x([0-9a-fA-F]{2})/g, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }

  if (phimEl) {
    phimEl.addEventListener('click', function (e) {
      var target = e.target;
      var seq = target && target.getAttribute ? target.getAttribute('data-seq') : null;
      if (seq == null) return;
      sendInput(unescapeSeq(seq));
    });
  }

  // --- Bàn phím ảo — hai nhánh code (spec §5.4) ------------------------------
  //
  // Measured support (spec §2): the VirtualKeyboard API exists on
  // Chrome/Android and Samsung Internet, and nowhere on iOS Safari in any
  // version. VisualViewport exists everywhere. Feature-detect ONLY — never
  // sniff the user agent, since the one platform a UA sniff gets wrong is
  // reliably the one nobody in this project can test locally (spec §9/§10).

  function reportSize() {
    if (!term) return;
    sendControl({ type: 'ccrc_resize', cols: term.cols, rows: term.rows });
  }

  // --- cuộn: điều khiển copy-mode của tmux --------------------------------
  //
  // The scrollback is not here. tmux drives the client's screen directly, so
  // lines that scroll off never enter xterm's own buffer — measured: after
  // 140 lines of output, xterm's scroll area was still exactly one screen
  // tall and a wheel event changed nothing on screen. CSS could not have
  // fixed this; there was nothing to scroll.
  //
  // So a scroll gesture here is a REQUEST, sent to the daemon, which puts the
  // pane into tmux's copy mode and scrolls it there. That is live, unlimited
  // history. The cost, accepted deliberately: copy mode belongs to the pane,
  // so the desktop view follows along — consistent with this design already
  // letting the phone decide the pane's size.
  var SCROLL_MAX_LINES = 500;
  // Set the moment a drag actually moves a row, cleared at the start of each
  // touch. It is what stops the `click` that follows a scroll from being sent
  // to the application as a press.
  var dragMoved = false;
  var DEFAULT_ROW_PX = 17; // only until a row has been rendered to measure

  function rowHeightPx() {
    var row = termEl.querySelector && termEl.querySelector('.xterm-rows > div');
    var h = row && row.offsetHeight;
    return h > 0 ? h : DEFAULT_ROW_PX;
  }

  // Positive = back into history, negative = towards the present.
  function sendScroll(lines) {
    var n = Math.round(lines);
    if (!n) return;
    if (n > SCROLL_MAX_LINES) n = SCROLL_MAX_LINES;
    if (n < -SCROLL_MAX_LINES) n = -SCROLL_MAX_LINES;
    sendControl({ type: 'ccrc_scroll', lines: n });
  }

  // A drag that is extending a text selection is NOT a scroll — selecting to
  // copy is the other thing this surface has to support, and stealing the
  // gesture would break it.
  function selecting() {
    try {
      var sel = window.getSelection && window.getSelection();
      return !!(sel && !sel.isCollapsed);
    } catch (e) { return false; }
  }

  if (termEl && termEl.addEventListener) {
    termEl.addEventListener('wheel', function (e) {
      if (!e || typeof e.deltaY !== 'number') return;
      if (e.preventDefault) e.preventDefault();
      // deltaY < 0 is "wheel away from me" = back into history.
      sendScroll(-e.deltaY / rowHeightPx());
    }, { passive: false });

    var dragY = null;
    termEl.addEventListener('touchstart', function (e) {
      dragY = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
      // Reset per gesture: the click handler above uses this to tell a tap
      // from the end of a scroll, and a stale `true` would swallow the next
      // real tap.
      dragMoved = false;
    }, { passive: true });

    termEl.addEventListener('touchmove', function (e) {
      if (dragY === null) return;
      if (selecting()) { dragY = null; return; }
      var y = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
      if (y === null) return;
      var dy = y - dragY;
      var rows = dy / rowHeightPx();
      // Only act once a whole row's worth of movement has accumulated, so a
      // stationary finger during a long-press does not creep the view.
      if (Math.abs(rows) < 1) return;
      if (e.cancelable !== false && e.preventDefault) e.preventDefault();
      dragMoved = true;
      dragY = y;
      // Dragging DOWN reveals older lines, the same direction as every
      // scrollable surface on a phone.
      sendScroll(rows);
    }, { passive: false });

    var endDrag = function () { dragY = null; };
    termEl.addEventListener('touchend', endDrag, { passive: true });
    termEl.addEventListener('touchcancel', endDrag, { passive: true });
  }

  // --- bấm: chuyển vị trí chạm thành toạ độ ô cho ứng dụng -----------------
  //
  // The buttons a user wants to press — "Jump to bottom", a menu entry — are
  // drawn BY the application inside the terminal. They are not DOM elements
  // and there is nothing here to attach a handler to. The application is
  // already listening for the mouse (that is how scrolling works), so a tap
  // becomes a click at the cell the finger landed on.

  function cellFromPoint(x, y) {
    if (!term) return null;
    var screen = termEl.querySelector && termEl.querySelector('.xterm-screen');
    if (!screen || !screen.getBoundingClientRect) return null;
    var r = screen.getBoundingClientRect();
    if (!r.width || !r.height || !term.cols || !term.rows) return null;
    // Derived from the rendered screen rather than a measured character, so it
    // stays right whatever the font ends up being.
    var col = Math.floor((x - r.left) / (r.width / term.cols)) + 1;
    var row = Math.floor((y - r.top) / (r.height / term.rows)) + 1;
    // A tap on the padding at the edge is still a tap on the nearest cell,
    // never a coordinate the application would reject.
    if (col < 1) col = 1;
    if (col > term.cols) col = term.cols;
    if (row < 1) row = 1;
    if (row > term.rows) row = term.rows;
    return { col: col, row: row };
  }

  // Only real taps. A `click` also arrives at the end of a drag on some
  // browsers, and after a long-press that selected text — neither meant
  // "press the thing under my finger".
  if (termEl && termEl.addEventListener) {
    termEl.addEventListener('click', function (e) {
      if (selecting()) return;
      if (dragMoved) return;
      var cell = cellFromPoint(e.clientX, e.clientY);
      if (!cell) return;
      sendControl({ type: 'ccrc_click', col: cell.col, row: cell.row });
    });
  }

  // Tells the daemon whether this page is actually on screen, which is what
  // decides if push notifications for this session are held back. The daemon
  // treats a newly connected client as watching, so this only ever needs to
  // correct that — but it is sent on connect too, so a page restored from
  // bfcache while hidden does not start out wrongly counted as watching.
  //
  // `document.visibilityState` is the right signal rather than focus: a
  // locked phone screen and a switched app both report 'hidden', and those
  // are exactly the moments the user still wants to be told.
  function reportVisibility() {
    var visible = typeof document.visibilityState === 'string'
      ? document.visibilityState === 'visible'
      : true; // no API to ask — assume watching, i.e. stay quiet
    sendControl({ type: 'ccrc_visibility', visible: visible });
  }

  function adjustTermHeight() {
    // Best-effort only — a layout hiccup here must never block fit()/
    // reportSize() below, so the whole thing is one try/catch.
    try {
      var overlapPx = 0;
      if (typeof navigator !== 'undefined' && navigator && 'virtualKeyboard' in navigator &&
          navigator.virtualKeyboard && navigator.virtualKeyboard.boundingRect) {
        overlapPx = navigator.virtualKeyboard.boundingRect.height || 0;
      } else if (typeof visualViewport !== 'undefined' && visualViewport &&
                 typeof window !== 'undefined' && window) {
        // visualViewport.height already excludes whatever the on-screen
        // keyboard covers; window.innerHeight does not. The difference
        // between them IS the keyboard's on-screen height.
        overlapPx = Math.max(0, window.innerHeight - visualViewport.height);
      }
      // #term is a flex child (see term.css) — an explicit height is what
      // makes it shrink out from under the keyboard instead of being
      // pushed off-screen underneath it.
      if (termEl && termEl.style) {
        termEl.style.height = overlapPx > 0 ? 'calc(100% - ' + overlapPx + 'px)' : '';
      }
    } catch (e) { /* layout is best-effort — never block the rest of relayout() */ }
  }

  function relayout() {
    adjustTermHeight();
    if (fit) { try { fit.fit(); } catch (e) { /* nothing to fit yet, or it failed — not fatal */ } }
    reportSize();
  }

  if (typeof navigator !== 'undefined' && navigator && 'virtualKeyboard' in navigator) {
    navigator.virtualKeyboard.overlaysContent = true;
    navigator.virtualKeyboard.addEventListener('geometrychange', relayout);
  } else if (typeof visualViewport !== 'undefined' && visualViewport) {
    visualViewport.addEventListener('resize', relayout);
  }

  // --- đổi sang font đã nhúng khi nó tải xong -----------------------------
  //
  // Assigning `options.fontFamily` is what makes xterm throw away its cached
  // character dimensions and measure again; relayout() then re-fits the grid
  // and reports the corrected size to tmux. Doing this only after the font
  // has loaded is what keeps the reported column count honest.
  //
  // Every failure here is survivable and none of them may be fatal: no
  // `document.fonts` at all (older browsers), a load that rejects (file
  // missing, served with the wrong content-type, disk error), or an xterm
  // build that refuses the assignment. In each case the page simply keeps the
  // system stack, which already renders Vietnamese correctly on iOS and
  // macOS — the vendored font is an improvement, never a dependency.
  function useVendoredFont() {
    try {
      term.options.fontFamily = FONT_STACK_WEB;
    } catch (e) {
      return; // could not switch — the system stack stays, nothing is broken
    }
    relayout();
  }

  // Waits for BOTH vendored fonts before switching, and switches once either
  // way — a font that fails to load simply is not in the stack, and the ones
  // behind it cover for it. Waiting for both matters because switching resets
  // xterm's cell measurement: doing it twice would re-fit the grid twice and
  // send tmux two resize reports for no reason.
  //
  // The icon font is the slow one (2.4 MB), and `document.fonts.load` for a
  // face with a `unicode-range` resolves without downloading anything unless
  // the sample text falls inside that range — so this does NOT force the
  // download. The browser fetches it when an icon first appears on screen.
  if (document.fonts && typeof document.fonts.load === 'function') {
    var pending = VENDORED_FONTS.length;
    var settled = function () {
      pending -= 1;
      if (pending === 0) useVendoredFont();
    };
    for (var fi = 0; fi < VENDORED_FONTS.length; fi++) {
      try {
        var loading = document.fonts.load('16px "' + VENDORED_FONTS[fi] + '"');
        if (loading && typeof loading.then === 'function') loading.then(settled, settled);
        else settled();
      } catch (e) {
        settled(); // this face is unusable — the rest of the stack covers it
      }
    }
  }

  connect();
})();
