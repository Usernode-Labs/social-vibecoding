// #328: max characters in a single group-chat message. Raised from 2000 to
// 8000 to give room for markdown-formatted messages (code samples, lists).
// Kept in sync with the server-side cap in src/services/ws.js — both ends
// must agree or a message that passes the composer would be silently
// truncated on insert. Drives every composer/edit `maxlength` below.
const GC_MAX_MESSAGE_LEN = 8000;

const GroupChat = {
  ws: null,
  appSlug: null,
  messages: [],
  typingUsers: new Map(),
  typingTimeout: null,
  oldestMessageId: null,
  hasMore: true,
  // Scroll-position memory. `_lockedToBottom` drives "should new incoming
  // messages auto-scroll?". `_savedScrollTop` is the last observed scroll
  // offset so we can restore it when the tab is re-mounted (group-chat DOM
  // is destroyed on every tab switch, but GroupChat state persists for as
  // long as we stay inside the same app).
  _lockedToBottom: true,
  _savedScrollTop: null,
  _didInitialScroll: false,

  // Reconnect bookkeeping (#7). The WS connection is the canonical
  // send path for chat messages; if it's down we have to either
  // queue or drop. We queue.
  //   _reconnectAttempts — exponent for backoff (1s,2s,4s,…30s).
  //                        Reset to 0 on every successful onopen.
  //   _reconnectTimer    — pending setTimeout handle; null if no
  //                        reconnect is scheduled. Guards against
  //                        double-scheduling.
  //   _pendingOutgoing   — chat texts the user submitted while the
  //                        socket was down. Flushed in order on the
  //                        next onopen. Capped at PENDING_LIMIT so
  //                        a long-offline session can't grow
  //                        unbounded; oldest entries are dropped
  //                        first when full (rare in practice; the
  //                        8000-char-per-message * 50 ceiling is
  //                        ~400KB which is fine to hold in RAM).
  _reconnectAttempts: 0,
  _reconnectTimer: null,
  _pendingOutgoing: [],

  // #15: Signal-style reply. `replyDraft` is the quote to attach to the
  // NEXT outgoing message (or null). `_tap` records the last pointerdown
  // position so the tap-to-quote handler can distinguish a clean tap from
  // a drag/text-selection (mobile-first: tap quotes, drag selects).
  replyDraft: null,
  _tap: null,

  // #25: emoji reactions. Long-press (or hover button) opens the reaction
  // bar; `_pressTimer` arms the long-press, `_longPressed` swallows the
  // trailing click so it doesn't also quote. `_reactBar` is the lazily
  // built floating picker.
  _pressTimer: null,
  _longPressed: false,
  // True while a pointer is held down on a message row. Used to gate the
  // drag-vs-hold decision that toggles native text selection (hold =
  // react bar + no selection; drag = re-enable selection).
  _pressActive: false,
  _reactBar: null,
  _reactBarDismiss: null,
  _reactBarOpenedAt: 0,
  // Shell-injected staging iframe token, captured at script load so SPA
  // history rewrites can't lose it before a (re)connect needs it.
  _bootToken: new URLSearchParams(location.search).get('token'),
  QUICK_REACTIONS: ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'],
  // Full picker grid, ordered by category (smileys \u2192 gestures \u2192 hearts \u2192
  // animals \u2192 food \u2192 activities \u2192 objects \u2192 symbols) so related emoji sit
  // together while scrolling. Rendered flat; the CSS grid handles layout.
  GRID_REACTIONS: [
    // Smileys & emotion
    '\uD83D\uDE00', '\uD83D\uDE01', '\uD83D\uDE02', '\uD83E\uDD23', '\uD83D\uDE0A', '\uD83D\uDE07', '\uD83D\uDE42', '\uD83D\uDE09',
    '\uD83D\uDE0D', '\uD83E\uDD70', '\uD83D\uDE18', '\uD83D\uDE0B', '\uD83D\uDE1C', '\uD83E\uDD2A', '\uD83D\uDE0E', '\uD83E\uDD13',
    '\uD83E\uDD73', '\uD83E\uDD29', '\uD83D\uDE0F', '\uD83D\uDE05', '\uD83D\uDE2C', '\uD83D\uDE43', '\uD83D\uDE0C', '\uD83D\uDE34',
    '\uD83E\uDD24', '\uD83D\uDE2A', '\uD83D\uDE2E', '\uD83D\uDE32', '\uD83D\uDE33', '\uD83E\uDD7A', '\uD83D\uDE22', '\uD83D\uDE2D',
    '\uD83D\uDE24', '\uD83D\uDE20', '\uD83D\uDE21', '\uD83E\uDD2C', '\uD83E\uDD2F', '\uD83E\uDD75', '\uD83E\uDD76', '\uD83D\uDE31',
    '\uD83D\uDE28', '\uD83D\uDE30', '\uD83E\uDD17', '\uD83E\uDD14', '\uD83E\uDD2D', '\uD83E\uDD2B', '\uD83D\uDE44', '\uD83D\uDE12',
    '\uD83D\uDE1E', '\uD83D\uDE14', '\uD83D\uDE1F', '\uD83D\uDE15', '\uD83D\uDE16', '\uD83D\uDE2B', '\uD83D\uDE29', '\uD83E\uDD22',
    '\uD83E\uDD2E', '\uD83E\uDD27', '\uD83D\uDE37', '\uD83E\uDD12', '\uD83E\uDD20', '\uD83E\uDD11', '\uD83D\uDE08', '\uD83D\uDC80',
    '\uD83D\uDC7B', '\uD83D\uDC7D', '\uD83E\uDD16', '\uD83D\uDCA9', '\uD83E\uDD21', '\uD83D\uDE3A', '\uD83D\uDE48', '\uD83D\uDE49',
    '\uD83D\uDE4A', '\uD83D\uDE36', '\uD83D\uDE10', '\uD83E\uDD74',
    // Gestures & hands
    '\uD83D\uDC4D', '\uD83D\uDC4E', '\uD83D\uDC4C', '\uD83E\uDD0C', '\u270C\uFE0F', '\uD83E\uDD1E', '\uD83E\uDD1F', '\uD83E\uDD18',
    '\uD83E\uDD19', '\uD83D\uDC4B', '\uD83D\uDD90\uFE0F', '\u270B', '\uD83D\uDC4A', '\u270A', '\uD83E\uDD1B', '\uD83E\uDD1C',
    '\uD83D\uDC4F', '\uD83D\uDE4C', '\uD83E\uDD1D', '\uD83D\uDE4F', '\uD83D\uDCAA', '\uD83D\uDD95', '\u261D\uFE0F', '\uD83D\uDC46',
    '\uD83D\uDC47', '\uD83D\uDC48', '\uD83D\uDC49', '\u270D\uFE0F', '\uD83E\uDD32', '\uD83D\uDC40', '\uD83E\uDDE0', '\uD83D\uDDE3\uFE0F',
    '\uD83D\uDC81', '\uD83D\uDE45', '\uD83D\uDE46', '\uD83E\uDD37', '\uD83E\uDD26', '\uD83E\uDDCE', '\uD83C\uDFC3', '\uD83D\uDC83',
    // Hearts
    '\u2764\uFE0F', '\uD83E\uDDE1', '\uD83D\uDC9B', '\uD83D\uDC9A', '\uD83D\uDC99', '\uD83D\uDC9C', '\uD83D\uDDA4', '\uD83E\uDD0D',
    '\uD83E\uDD0E', '\uD83D\uDC95', '\uD83D\uDC9E', '\uD83D\uDC93', '\uD83D\uDC97', '\uD83D\uDC96', '\uD83D\uDC98', '\uD83D\uDC9D',
    '\uD83D\uDC94', '\u2763\uFE0F', '\uD83D\uDC9F', '\uD83D\uDC8C',
    // Animals & nature
    '\uD83D\uDC36', '\uD83D\uDC31', '\uD83D\uDC2D', '\uD83D\uDC39', '\uD83D\uDC30', '\uD83E\uDD8A', '\uD83D\uDC3B', '\uD83D\uDC3C',
    '\uD83D\uDC28', '\uD83D\uDC2F', '\uD83E\uDD81', '\uD83D\uDC2E', '\uD83D\uDC37', '\uD83D\uDC38', '\uD83D\uDC35', '\uD83D\uDC14',
    '\uD83D\uDC27', '\uD83D\uDC26', '\uD83E\uDD86', '\uD83E\uDD85', '\uD83E\uDD89', '\uD83D\uDC22', '\uD83D\uDC0D', '\uD83D\uDC19',
    '\uD83E\uDD80', '\uD83D\uDC2C', '\uD83D\uDC33', '\uD83E\uDD88', '\uD83E\uDD8B', '\uD83D\uDC1D', '\uD83D\uDC1E', '\uD83D\uDC0C',
    '\uD83C\uDF38', '\uD83C\uDF39', '\uD83C\uDF3B', '\uD83C\uDF35', '\uD83C\uDF32', '\uD83C\uDF40', '\uD83C\uDF08', '\u2B50',
    '\uD83C\uDF1F', '\u2728', '\u26A1', '\u2600\uFE0F', '\uD83C\uDF19', '\u2601\uFE0F', '\uD83C\uDF27\uFE0F', '\u2744\uFE0F',
    '\uD83C\uDF0A', '\uD83C\uDF0D',
    // Food & drink
    '\uD83C\uDF4E', '\uD83C\uDF4C', '\uD83C\uDF49', '\uD83C\uDF47', '\uD83C\uDF53', '\uD83C\uDF52', '\uD83C\uDF51', '\uD83E\uDD6D',
    '\uD83C\uDF4D', '\uD83E\uDD51', '\uD83C\uDF45', '\uD83E\uDD55', '\uD83C\uDF3D', '\uD83C\uDF5E', '\uD83E\uDDC0', '\uD83E\uDD5A',
    '\uD83E\uDD53', '\uD83C\uDF54', '\uD83C\uDF5F', '\uD83C\uDF55', '\uD83C\uDF2D', '\uD83C\uDF2E', '\uD83C\uDF2F', '\uD83C\uDF63',
    '\uD83C\uDF5C', '\uD83C\uDF5D', '\uD83C\uDF7F', '\uD83C\uDF69', '\uD83C\uDF6A', '\uD83C\uDF82', '\uD83C\uDF70', '\uD83E\uDDC1',
    '\uD83C\uDF6B', '\uD83C\uDF6C', '\uD83C\uDF6D', '\u2615', '\uD83C\uDF75', '\uD83E\uDD64', '\uD83C\uDF7A', '\uD83C\uDF7B',
    '\uD83E\uDD42', '\uD83C\uDF77', '\uD83C\uDF78', '\uD83E\uDD43',
    // Activities & sports
    '\u26BD', '\uD83C\uDFC0', '\uD83C\uDFC8', '\u26BE', '\uD83C\uDFBE', '\uD83C\uDFD0', '\uD83C\uDFB1', '\uD83C\uDFD3',
    '\uD83C\uDFF8', '\uD83E\uDD4A', '\u26F3', '\uD83C\uDFA3', '\uD83C\uDFBD', '\u26F7\uFE0F', '\uD83C\uDFC2', '\uD83C\uDFC6',
    '\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49', '\uD83C\uDFC5', '\uD83C\uDFAE', '\uD83D\uDD79\uFE0F', '\uD83C\uDFB2', '\uD83E\uDDE9',
    '\u265F\uFE0F', '\uD83C\uDFAF', '\uD83C\uDFB3', '\uD83C\uDFA4', '\uD83C\uDFA7', '\uD83C\uDFB8', '\uD83E\uDD41', '\uD83C\uDFB9',
    '\uD83C\uDFBA', '\uD83C\uDFBB', '\uD83C\uDFAC', '\uD83C\uDFA8', '\uD83C\uDFAD', '\uD83C\uDFAA', '\uD83C\uDF9F\uFE0F', '\uD83C\uDFB0',
    // Travel & objects
    '\uD83D\uDE80', '\u2708\uFE0F', '\uD83D\uDE97', '\uD83D\uDE95', '\uD83D\uDE8C', '\uD83D\uDEB2', '\uD83D\uDEF4', '\uD83C\uDFCD\uFE0F',
    '\uD83D\uDE82', '\uD83D\uDEA2', '\u26F5', '\uD83D\uDDFA\uFE0F', '\uD83C\uDFE0', '\uD83C\uDFD6\uFE0F', '\uD83C\uDFD4\uFE0F', '\uD83D\uDDFD',
    '\uD83D\uDCBB', '\uD83D\uDDA5\uFE0F', '\u2328\uFE0F', '\uD83D\uDDB1\uFE0F', '\uD83D\uDCF1', '\uD83D\uDCF7', '\uD83C\uDFA5', '\uD83D\uDCFA',
    '\uD83D\uDCFB', '\u23F0', '\u231A', '\uD83D\uDD0B', '\uD83D\uDD0C', '\uD83D\uDCA1', '\uD83D\uDD26', '\uD83D\uDD6F\uFE0F',
    '\uD83D\uDEE0\uFE0F', '\uD83D\uDD27', '\uD83D\uDD28', '\u2699\uFE0F', '\uD83E\uDDF2', '\uD83D\uDD11', '\uD83D\uDD12', '\uD83D\uDD13',
    '\uD83D\uDCCC', '\uD83D\uDCCE', '\u2702\uFE0F', '\uD83D\uDCCF', '\uD83D\uDCDA', '\uD83D\uDCD6', '\uD83D\uDCDD', '\u270F\uFE0F',
    '\uD83D\uDCE6', '\uD83C\uDF81', '\uD83C\uDF88', '\uD83C\uDF89', '\uD83C\uDF8A', '\uD83D\uDED2', '\uD83D\uDCB0', '\uD83D\uDCB5',
    '\uD83D\uDCB3', '\uD83D\uDC8E',
    // Symbols
    '\u2705', '\u2611\uFE0F', '\u274C', '\u274E', '\u26A0\uFE0F', '\uD83D\uDEAB', '\u2757', '\u2753',
    '\u203C\uFE0F', '\u2049\uFE0F', '\uD83D\uDCAF', '\uD83D\uDD25', '\uD83D\uDCA5', '\uD83D\uDCAB', '\uD83D\uDCA2', '\uD83D\uDCA4',
    '\uD83D\uDCAC', '\uD83D\uDCAD', '\uD83D\uDDE8\uFE0F', '\uD83D\uDD14', '\uD83D\uDD15', '\uD83C\uDFB5', '\uD83C\uDFB6', '\u2795',
    '\u2796', '\u2797', '\u2716\uFE0F', '\u267E\uFE0F', '\uD83D\uDCB2', '\u00A9\uFE0F', '\u00AE\uFE0F', '\u2122\uFE0F',
    '\uD83D\uDD34', '\uD83D\uDFE0', '\uD83D\uDFE1', '\uD83D\uDFE2', '\uD83D\uDD35', '\uD83D\uDFE3', '\u26AB', '\u26AA',
    '\uD83D\uDD3A', '\uD83D\uDD3B', '\uD83D\uDD04', '\uD83D\uDD01', '\u25B6\uFE0F', '\u23F8\uFE0F', '\u23E9', '\u23EA',
    '\uD83C\uDD97', '\uD83C\uDD92', '\uD83C\uDD95', '\uD83C\uDD93', '\uD83D\uDD1D', '\uD83D\uDD1A', '\uD83D\uDD1C', '\uD83C\uDFC1',
    '\uD83D\uDEA9', '\uD83C\uDFF3\uFE0F', '\uD83C\uDFF4', '\uD83D\uDC1B',
  ],

  // In-progress draft helpers — preserved across tab switches *and* page
  // refreshes (via localStorage). Keyed by app slug (plus the thread key
  // for thread composers, #194) so each surface has its own draft.
  // Cleared on send.
  _draftKey(slug, threadKey) {
    return threadKey
      ? `usernode:gc-draft:${slug}:${threadKey}`
      : `usernode:gc-draft:${slug}`;
  },
  getDraft(slug, threadKey) {
    if (!slug) return '';
    try { return localStorage.getItem(GroupChat._draftKey(slug, threadKey)) || ''; }
    catch { return ''; }
  },
  setDraft(slug, value, threadKey) {
    if (!slug) return;
    try {
      if (value) localStorage.setItem(GroupChat._draftKey(slug, threadKey), value);
      else localStorage.removeItem(GroupChat._draftKey(slug, threadKey));
    } catch {}
  },

  // ── #194: thread-scoped chat state ──────────────────────────────────
  // One WS connection, multiple render targets: the general stream
  // (#gc-messages) plus at most one mounted thread (#gc-thread-messages,
  // inside an Issues/Proposals accordion). Per-thread history caches
  // live in `threads`, keyed by `${type}:${ref}`.
  threads: new Map(),       // key -> { messages, oldestId, hasMore, loaded }
  activeThread: null,       // { type, ref } | null — the mounted thread
  _threadTypingTimer: null,

  threadKey(type, ref) {
    return `${type}:${ref}`;
  },

  _threadState(type, ref) {
    const key = GroupChat.threadKey(type, ref);
    if (!GroupChat.threads.has(key)) {
      GroupChat.threads.set(key, { messages: [], oldestId: null, hasMore: true, loaded: false });
    }
    return GroupChat.threads.get(key);
  },

  // Called by AppView.renderGroupChatTab on every tab (re-)entry. On first
  // entry for an app we open the WS and lazy-load history; on subsequent
  // re-entries we reuse the existing connection + cached messages and just
  // restore scroll.
  mount(appSlug) {
    // Side-panel hooks: bind the draggable divider on every mount
    // (the handle DOM element is recreated on each tab render, so
    // there's no stale binding to worry about) and restore any
    // saved open state so a refresh re-opens the same spec the user
    // was last viewing in this app. Both are no-ops when nothing's
    // saved or the slot doesn't exist yet.
    GroupChat._initSpecPanelResizer();
    GroupChat._restoreSpecPanelIfSaved(appSlug);

    // Reuse the existing connection only if it's actually usable
    // (CONNECTING or OPEN). A CLOSING/CLOSED socket sitting in
    // GroupChat.ws was the silent-drop trap behind #7: mount would
    // short-circuit here and subsequent send()s would no-op on the
    // dead socket until the user refreshed. Treat anything past
    // OPEN as "no socket" and reconnect.
    const liveWs = GroupChat.ws && GroupChat.ws.readyState <= 1; // CONNECTING(0) or OPEN(1)
    if (GroupChat.appSlug === appSlug && liveWs) {
      GroupChat.render();
      GroupChat.attachScrollHandlers();
      GroupChat.restoreScroll();
      return;
    }
    GroupChat.connect(appSlug);
  },

  connect(appSlug) {
    GroupChat.disconnect();
    GroupChat.appSlug = appSlug;
    GroupChat.messages = [];
    GroupChat.threads = new Map();
    GroupChat.activeThread = null;
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._reconnectAttempts = 0;
    GroupChat.replyDraft = null;
    GroupChat._longPressed = false;
    GroupChat._pressActive = false;
    GroupChat._clearPressTimer();
    GroupChat._closeReactionBar();

    GroupChat._openSocket();
    GroupChat.attachScrollHandlers();
  },

  // Open (or re-open) the WS for the currently-mounted appSlug.
  // Split out from connect() so the reconnect path can reuse the
  // socket-construction without resetting message history, draft,
  // scroll, etc. Reads GroupChat.appSlug rather than taking it as
  // an arg so a reconnect that fires after disconnect() has nulled
  // appSlug is a clean no-op.
  _openSocket() {
    const appSlug = GroupChat.appSlug;
    if (!appSlug) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Staging previews run in an iframe and authenticate via the
    // shell-injected ?token= JWT; the session cookie may be orphaned by a
    // redeploy (sessions is staging:private). Forward the token on the WS
    // URL so the handshake has the same fallback HTTP requests do. In
    // prod there is no token param and this is a no-op. Prefer the live
    // URL, fall back to the boot-time capture (SPA history rewrites may
    // have stripped the query by now).
    const token = new URLSearchParams(location.search).get('token') || GroupChat._bootToken;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${appSlug}${qs}`);
    GroupChat.ws = ws;

    ws.onopen = () => {
      // Successful handshake → backoff resets, queued messages
      // flush in order, history loads (refreshes the cache in case
      // we missed broadcasts while disconnected).
      GroupChat._reconnectAttempts = 0;
      GroupChat._flushPendingOutgoing();
      GroupChat._renderStatusLine();
      GroupChat.loadHistory();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        GroupChat.handleIncoming(msg);
      } catch {}
    };

    ws.onclose = (ev) => {
      // Surface the close code in the dev console — a clean reconnect
      // cycle logs 1006s, while e.g. 4004 (access denied) pinpoints a
      // server-side rejection that retrying will never fix.
      console.warn(`[gc] chat socket closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`);
      // Bail if disconnect() ran (we changed apps / left the
      // surface entirely); the existing socket reference is stale.
      if (GroupChat.ws !== ws) return;
      GroupChat._renderStatusLine();
      GroupChat._scheduleReconnect();
    };

    // onerror typically fires immediately before onclose; leave
    // rescheduling to onclose so we don't double-schedule. We just
    // want the early UI signal that something went wrong.
    ws.onerror = () => {
      if (GroupChat.ws !== ws) return;
      GroupChat._renderStatusLine();
    };
  },

  _scheduleReconnect() {
    if (GroupChat._reconnectTimer) return;
    if (!GroupChat.appSlug) return;
    // 1s, 2s, 4s, 8s, 16s, capped at 30s. Plus 0–500ms jitter so a
    // server restart doesn't get a thundering herd from every open
    // tab waking up in lockstep.
    const n = GroupChat._reconnectAttempts;
    const base = Math.min(30_000, 1000 * Math.pow(2, n));
    const delay = base + Math.floor(Math.random() * 500);
    GroupChat._reconnectTimer = setTimeout(() => {
      GroupChat._reconnectTimer = null;
      GroupChat._reconnectAttempts++;
      if (GroupChat.appSlug) GroupChat._openSocket();
    }, delay);
  },

  // Drain the offline-typed messages onto the freshly-open socket.
  // Slice + reset before sending so a synchronous re-entry (e.g. if
  // ws.send throws and we somehow re-enter) doesn't double-send.
  _flushPendingOutgoing() {
    if (!GroupChat._pendingOutgoing.length) return;
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    const queue = GroupChat._pendingOutgoing.slice();
    GroupChat._pendingOutgoing.length = 0;
    for (const payload of queue) {
      try {
        GroupChat.ws.send(JSON.stringify(payload));
      } catch {
        // Socket closed mid-flush — re-queue whatever didn't go
        // and let the next reconnect try again.
        GroupChat._pendingOutgoing.unshift(payload);
        break;
      }
    }
  },

  disconnect() {
    if (GroupChat._reconnectTimer) {
      clearTimeout(GroupChat._reconnectTimer);
      GroupChat._reconnectTimer = null;
    }
    if (GroupChat.ws) {
      GroupChat.ws.onopen = null;
      GroupChat.ws.onmessage = null;
      GroupChat.ws.onclose = null;
      GroupChat.ws.onerror = null;
      GroupChat.ws.close();
      GroupChat.ws = null;
    }
    GroupChat.appSlug = null;
    GroupChat.threads = new Map();
    GroupChat.activeThread = null;
    GroupChat.typingUsers.clear();
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._reconnectAttempts = 0;
    // Pending messages are tied to *this* app's chat room — when
    // we switch apps, drop them rather than silently sending them
    // to whatever room reconnects next.
    GroupChat._pendingOutgoing.length = 0;
  },

  async loadHistory() {
    if (!GroupChat.appSlug) return;
    try {
      const isFirstLoad = !GroupChat.oldestMessageId;
      const url = GroupChat.oldestMessageId
        ? `/api/apps/${GroupChat.appSlug}/messages?before=${GroupChat.oldestMessageId}&limit=50`
        : `/api/apps/${GroupChat.appSlug}/messages?limit=50`;

      // Preserve scroll anchor when prepending older history so the viewport
      // doesn't jump to the top.
      const container = document.getElementById('gc-messages');
      const prevScrollHeight = container?.scrollHeight || 0;
      const prevScrollTop = container?.scrollTop || 0;

      const res = await fetch(url);
      if (!res.ok) return;
      const { messages } = await res.json();

      if (messages.length < 50) GroupChat.hasMore = false;

      if (messages.length > 0) {
        GroupChat.messages = [...messages, ...GroupChat.messages];
        GroupChat.oldestMessageId = messages[0].id;
      }

      GroupChat.render();

      if (isFirstLoad && !GroupChat._didInitialScroll) {
        GroupChat.scrollToBottom();
        GroupChat._didInitialScroll = true;
      } else if (container) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
      }
    } catch {}
  },

  handleIncoming(msg) {
    switch (msg.type) {
      case 'chat': {
        // #194: thread messages never land in the general stream — they
        // route to the mounted thread (if it matches) or bump the
        // chat-count badge on their issue/proposal row.
        if (msg.thread && msg.thread.type) {
          GroupChat._handleThreadIncoming(msg);
          break;
        }
        const shouldStick = GroupChat._lockedToBottom;
        GroupChat.messages.push(msg);
        GroupChat.appendMessage(msg);
        if (shouldStick) GroupChat.scrollToBottom();
        break;
      }
      case 'reaction': {
        // #25: authoritative reaction aggregate for one message.
        GroupChat._updateMessageReactions(msg.messageId, msg.reactions || []);
        break;
      }
      case 'chat_edit': {
        // Author edited a message — patch content + the "edited" marker in
        // place (preserves scroll, reactions, and the row's quote block).
        GroupChat._applyEdit(msg);
        break;
      }
      case 'typing': {
        // #194: thread typing renders inside the mounted thread only;
        // general typing keeps the original #gc-typing slot.
        if (msg.thread && msg.thread.type) {
          const a = GroupChat.activeThread;
          if (a && a.type === msg.thread.type && Number(a.ref) === Number(msg.thread.ref)) {
            GroupChat._renderThreadTyping(msg.username);
          }
          break;
        }
        GroupChat.typingUsers.set(msg.userId, msg.username);
        GroupChat.renderTyping();
        setTimeout(() => {
          GroupChat.typingUsers.delete(msg.userId);
          GroupChat.renderTyping();
        }, 3000);
        break;
      }
    }
  },

  // Incoming message scoped to a thread: store it, and either append it
  // to the mounted thread's DOM or bump the row badge.
  _handleThreadIncoming(msg) {
    const { type, ref } = msg.thread;
    const st = GroupChat._threadState(type, ref);
    st.messages.push(msg);
    const a = GroupChat.activeThread;
    if (a && a.type === type && Number(a.ref) === Number(ref)) {
      const el = document.getElementById('gc-thread-messages');
      const scroll = GroupChat._threadScrollEl();
      if (el && scroll) {
        // #363: only stick to the newest message when the reader is already
        // near the bottom — otherwise a live message would yank someone who
        // has scrolled up to read the topic body or older replies.
        const nearBottom =
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
        el.insertAdjacentHTML('beforeend', GroupChat.renderMessageHtml(msg));
        if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
        return;
      }
    }
    // Only human messages bump the 💬 badge — dual-posted lifecycle
    // system rows would otherwise inflate a count that the server now
    // computes from msg_type='message' rows only.
    if (msg.msgType === 'message'
        && typeof AppView !== 'undefined' && AppView.bumpThreadBadge) {
      AppView.bumpThreadBadge(type, Number(ref));
    }
  },

  _renderThreadTyping(username) {
    const el = document.getElementById('gc-thread-typing');
    if (!el || username === App.user?.username) return;
    el.textContent = `${username} is typing...`;
    clearTimeout(GroupChat._threadTypingTimer);
    GroupChat._threadTypingTimer = setTimeout(() => {
      if (el.isConnected) el.textContent = '';
    }, 3000);
  },

  // Hard cap on the offline queue. Picked to be large enough that
  // a transient drop never bites (a fast typer at ~5 msgs/sec for
  // 10s is 50 msgs) and small enough that a genuinely-offline
  // session can't balloon RAM. When full, we drop the oldest to
  // preserve the user's most recent intent.
  PENDING_LIMIT: 50,

  // Submit a chat message. Either ships it now (socket OPEN) or
  // queues it for the next reconnect. Never silently drops — that
  // was the visible half of #7 ("messages fail to send without
  // page refresh"). The caller can clear the input as soon as we
  // return without losing user-typed content.
  // #621: true when the open app is in read-only dev mode for this
  // viewer (non-collaborator on an invite-only-build app). Writes are
  // suppressed client-side here; the WS server drops them regardless.
  _readOnly() {
    return typeof AppView !== 'undefined' && !!AppView.readOnly;
  },

  send(content, thread) {
    if (GroupChat._readOnly()) return;
    // #194: thread sends carry their scope.
    const payload = { type: 'chat', content };
    if (thread && thread.type && thread.ref) {
      payload.thread = { type: thread.type, ref: Number(thread.ref) };
    }
    // #15: consume the pending reply quote (if any) for this message and
    // clear it so it only attaches once. Both composers stage into the
    // same replyDraft, and mount/unmount of a thread clears it, so the
    // quote always belongs to the surface doing the send. We send a
    // minimal reference; the server re-derives author/snippet.
    const quote = GroupChat.replyDraft;
    GroupChat.replyDraft = null;
    GroupChat._renderQuotePreview();
    if (quote) payload.quote = GroupChat._wireQuote(quote);

    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      GroupChat.ws.send(JSON.stringify(payload));
      return;
    }
    // Drop oldest if at cap — better to lose the message someone
    // typed 3 minutes ago than the one they just typed.
    if (GroupChat._pendingOutgoing.length >= GroupChat.PENDING_LIMIT) {
      GroupChat._pendingOutgoing.shift();
    }
    GroupChat._pendingOutgoing.push(payload);
    // Kick a reconnect if one isn't already in flight. Covers the
    // edge case where send() is called between onclose firing and
    // the next reconnect being scheduled (shouldn't happen in
    // practice — onclose schedules synchronously — but cheap
    // insurance).
    if (!GroupChat._reconnectTimer && (!GroupChat.ws || GroupChat.ws.readyState >= 2)) {
      GroupChat._scheduleReconnect();
    }
    GroupChat._renderStatusLine();
  },

  sendTyping(thread) {
    if (GroupChat._readOnly()) return;
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    if (GroupChat.typingTimeout) return;
    const payload = { type: 'typing' };
    if (thread && thread.type && thread.ref) {
      payload.thread = { type: thread.type, ref: Number(thread.ref) };
    }
    GroupChat.ws.send(JSON.stringify(payload));
    GroupChat.typingTimeout = setTimeout(() => { GroupChat.typingTimeout = null; }, 2000);
  },

  render() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    container.innerHTML = GroupChat.messages.map(GroupChat.renderMessageHtml).join('');
  },

  appendMessage(msg) {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', GroupChat.renderMessageHtml(msg));
  },

  // ── #194: thread chat (mounted inside Issues / Proposals accordions) ─

  // Render a thread chat (scoped message list + composer) into
  // `container` and make it the active thread render target. Reuses the
  // same renderMessageHtml pipeline and the one per-app WS connection —
  // which is opened on demand here, since the user can land on the
  // Issues/Proposals tabs without ever mounting the Chat sub-tab.
  // opts: { type, ref, container, readOnly?, notice?, placeholder? }
  mountThread(opts) {
    const { type, ref, container } = opts || {};
    if (!type || !ref || !container) return;
    const slug = (typeof AppView !== 'undefined' && AppView.appData && AppView.appData.slug)
      || GroupChat.appSlug;
    if (!slug) return;

    const liveWs = GroupChat.ws && GroupChat.ws.readyState <= 1;
    if (!(GroupChat.appSlug === slug && liveWs)) {
      GroupChat.connect(slug);
    }
    GroupChat.activeThread = { type, ref: Number(ref) };

    const threadKey = GroupChat.threadKey(type, ref);
    // A quote staged in the general composer must not ride along into a
    // thread send (and vice versa — see unmountThread): entering a thread
    // is a fresh composer context.
    GroupChat.clearQuote();
    // fullHeight (#194 card-list revision): the topic sub-view's thread
    // fills its flex container and mirrors the general chat pane's look —
    // full-width message list, h-5 typing slot, bordered-top composer with
    // the same input/Send sizing — instead of the boxed inline 40vh layout
    // kept for any legacy (non-fullHeight) caller.
    const fill = !!opts.fullHeight;
    // #363: in fill (topic) mode, the caller can ask for an in-scroll header
    // slot so the topic card/body and the discussion share ONE scroll region
    // (the topic sub-view paints into #gc-thread-head after mount). Off by
    // default, so the general-chat path and any legacy caller are unaffected.
    const withHeader = fill && !!opts.withHeader;
    const composerHtml = opts.readOnly
      ? `<div class="px-3 py-2 text-xs text-zinc-500 border-t border-zinc-200 dark:border-zinc-800 shrink-0">${escapeHtml(opts.notice || 'This thread is read-only.')}</div>`
      : `<div class="shrink-0 border-t border-zinc-200 dark:border-zinc-800 p-2">
          <div id="gc-thread-reply-preview" class="hidden"></div>
          <form id="gc-thread-form" class="flex gap-2 items-end">
            <textarea id="gc-thread-input" maxlength="${GC_MAX_MESSAGE_LEN}" rows="1" autocomplete="off"
              placeholder="${escapeHtml(opts.placeholder || 'Reply in thread…')}"
              class="gc-composer-input flex-1 min-w-0 resize-none overflow-y-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 ${fill ? 'py-2' : 'py-1.5'} text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"></textarea>
            <button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 ${fill ? 'px-4 py-2' : 'px-3 py-1.5'} text-sm font-medium text-white transition-colors shrink-0">Send</button>
          </form>
        </div>`;
    // #363: fill mode wraps an optional header slot + the messages list in a
    // SINGLE scroll container (#gc-thread-scroll), so a topic's card/body and
    // its discussion scroll as one area (matching the general chat, where only
    // the composer is pinned). The messages list itself no longer scrolls; the
    // typing slot and composer stay as pinned shrink-0 siblings outside the
    // scroller. The legacy (non-fill) boxed layout keeps the messages list as
    // its own 40vh scroller.
    const headSlot = withHeader ? '<div id="gc-thread-head"></div>' : '';
    container.innerHTML = fill
      ? `<div class="dev-thread flex flex-col h-full min-h-0">
          <div id="gc-thread-scroll" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3">
            ${headSlot}
            <div id="gc-thread-messages" class="py-2 space-y-0.5"></div>
          </div>
          <div id="gc-thread-typing" class="px-3 text-xs text-zinc-500 h-5 shrink-0"></div>
          ${composerHtml}
        </div>`
      : `<div class="dev-thread border border-zinc-200 dark:border-zinc-800 rounded-xl flex flex-col bg-zinc-50/50 dark:bg-zinc-900/40">
          <div id="gc-thread-messages" class="overflow-y-auto px-2 py-1 space-y-0.5" style="max-height:40vh;min-height:60px"></div>
          <div id="gc-thread-typing" class="px-3 text-xs text-zinc-500 h-4 shrink-0"></div>
          ${composerHtml}
        </div>`;

    // Full general-chat interaction set on the thread list: tap-to-quote,
    // long-press / hover reactions, quote-jump, reference chips.
    const msgsEl = container.querySelector('#gc-thread-messages');
    if (msgsEl) GroupChat._attachQuoteHandlers(msgsEl);

    const form = container.querySelector('#gc-thread-form');
    const input = container.querySelector('#gc-thread-input');
    if (form && input) {
      const saved = GroupChat.getDraft(slug, threadKey);
      if (saved) input.value = saved;
      GroupChat._autoGrowTextarea(input);
      const submitThread = () => {
        const content = input.value.trim();
        if (!content) return;
        GroupChat.send(content, { type, ref });
        input.value = '';
        GroupChat.setDraft(slug, '', threadKey);
        GroupChat._autoGrowTextarea(input);
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitThread();
      });
      input.addEventListener('input', () => {
        GroupChat.setDraft(slug, input.value, threadKey);
        GroupChat._autoGrowTextarea(input);
        GroupChat.sendTyping({ type, ref });
      });
      // Multi-line submit semantics, same as the general composer: Enter
      // sends, Shift+Enter inserts a newline, touch keyboards always insert
      // a newline (Send button sends). Bubble phase so the autocomplete's
      // capture-phase Enter handling wins while its dropdown is open.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !GroupChat._isTouch()) {
          e.preventDefault();
          submitThread();
        }
      });
      // #87/#130 parity with the general composer: @mention and #/PR#
      // reference autocomplete on the thread input.
      if (typeof MentionAutocomplete !== 'undefined') {
        MentionAutocomplete.attach(input, slug);
      }
      if (typeof RefAutocomplete !== 'undefined') {
        RefAutocomplete.attach(input, slug);
      }
      // #15 parity: Escape clears a staged reply quote (when the input is
      // empty so we don't fight other Escape semantics mid-typing).
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && GroupChat.replyDraft && !input.value) {
          e.preventDefault();
          GroupChat.clearQuote();
        }
      });
    }

    GroupChat.renderThread();
    // Only fetch on first open — the per-thread cache stays current
    // while connected (incoming WS messages are stored even when the
    // thread isn't mounted), and loadThreadHistory with an oldestId set
    // pages BACKWARD (that's the "Load earlier" button's job).
    const st = GroupChat._threadState(type, ref);
    if (!st.loaded) GroupChat.loadThreadHistory(type, ref);
  },

  // Drop the active thread render target (its history cache survives in
  // `threads` for instant re-open). Called when an accordion collapses
  // or the user leaves the sub-tab.
  unmountThread() {
    // A quote staged in the thread composer must not leak into the
    // general composer (replyDraft is global).
    if (GroupChat.activeThread && GroupChat.replyDraft) GroupChat.clearQuote();
    GroupChat.activeThread = null;
    clearTimeout(GroupChat._threadTypingTimer);
  },

  async loadThreadHistory(type, ref) {
    const slug = GroupChat.appSlug;
    if (!slug) return;
    const st = GroupChat._threadState(type, ref);
    const beforeParam = st.oldestId ? `&before=${st.oldestId}` : '';
    try {
      const res = await fetch(
        `/api/apps/${slug}/messages?thread_type=${encodeURIComponent(type)}&thread_ref=${encodeURIComponent(ref)}&limit=50${beforeParam}`
      );
      if (!res.ok) return;
      const { messages } = await res.json();
      if (messages.length < 50) st.hasMore = false;
      if (messages.length > 0) {
        st.messages = [...messages, ...st.messages];
        st.oldestId = messages[0].id;
      }
      st.loaded = true;
      const a = GroupChat.activeThread;
      if (a && a.type === type && Number(a.ref) === Number(ref)) {
        GroupChat.renderThread();
      }
    } catch { /* transient — re-open retries */ }
  },

  // #363: the element that actually scrolls a mounted thread. In the unified
  // topic layout it's the wrapper holding the header + messages; in the legacy
  // boxed layout the messages list is itself the scroller.
  _threadScrollEl() {
    return document.getElementById('gc-thread-scroll')
      || document.getElementById('gc-thread-messages');
  },

  // Paint the active thread's cached messages into #gc-thread-messages.
  renderThread() {
    const a = GroupChat.activeThread;
    const el = document.getElementById('gc-thread-messages');
    if (!a || !el) return;
    const scroll = GroupChat._threadScrollEl();
    // Unified topic layout: header + messages share #gc-thread-scroll.
    const unified = !!scroll && scroll.id === 'gc-thread-scroll';
    const st = GroupChat._threadState(a.type, a.ref);
    // Preserve the reading position across "Load earlier" prepends. Read/write
    // scroll on the scroll container, not the (now non-scrolling) message list.
    const prevHeight = scroll ? scroll.scrollHeight : 0;
    const prevTop = scroll ? scroll.scrollTop : 0;
    const wasLoaded = el.dataset.loaded === '1';

    const earlier = (st.loaded && st.hasMore && st.messages.length)
      ? '<div class="text-center py-1"><button id="gc-thread-earlier" class="gc-vote-btn">Load earlier</button></div>'
      : '';
    const empty = (st.loaded && !st.messages.length)
      ? '<div class="text-xs text-zinc-500 px-2 py-2">No messages yet — start the thread.</div>'
      : (!st.loaded ? '<div class="text-xs text-zinc-500 px-2 py-2">Loading…</div>' : '');
    el.innerHTML = earlier + empty + st.messages.map(GroupChat.renderMessageHtml).join('');
    el.dataset.loaded = st.loaded ? '1' : '';

    const btn = document.getElementById('gc-thread-earlier');
    if (btn) btn.addEventListener('click', () => GroupChat.loadThreadHistory(a.type, a.ref));

    if (!scroll) return;
    if (wasLoaded) {
      scroll.scrollTop = prevTop + (scroll.scrollHeight - prevHeight);
    } else if (unified) {
      // #363: open a topic at the TOP so its card/body reads first; the user
      // scrolls down into the discussion (general chat lands at the bottom).
      scroll.scrollTop = 0;
    } else {
      scroll.scrollTop = scroll.scrollHeight;
    }
  },

  // ── #15: reply / quote ──────────────────────────────────────────────

  // Stage a quote to attach to the next message and focus whichever
  // composer is mounted — the thread composer when a topic is open, the
  // general one otherwise. Called by the tap handler (chat + thread rows)
  // and by AppView (PR titles). No-op when no composer exists (read-only
  // merged-proposal thread): staging an invisible quote would silently
  // attach to a later message elsewhere.
  setQuote(quote) {
    if (!quote) return;
    const input = document.getElementById('gc-thread-input')
      || document.getElementById('gc-input');
    if (!input) return;
    GroupChat.replyDraft = quote;
    GroupChat._renderQuotePreview();
    input.focus();
  },

  clearQuote() {
    GroupChat.replyDraft = null;
    GroupChat._renderQuotePreview();
  },

  // Minimal wire form — server re-derives author/snippet from the source.
  _wireQuote(q) {
    if (q.source === 'pr') return { source: 'pr', sessionId: q.sessionId };
    return { source: q.source, refMsgId: q.refMsgId };
  },

  // Render (or clear) the composer's "Replying to …" preview chip —
  // into the thread composer's slot when a topic is open, else the
  // general composer's (only one of the two is ever in the DOM).
  _renderQuotePreview() {
    const el = document.getElementById('gc-thread-reply-preview')
      || document.getElementById('gc-reply-preview');
    if (!el) return;
    const q = GroupChat.replyDraft;
    if (!q) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const label = q.source === 'pr'
      ? `PR #${q.prNumber || ''}`.trim()
      : (q.author ? `@${q.author}` : 'message');
    const snippet = GroupChat._collapseSnippet(q.snippet).slice(0, 120);
    el.classList.remove('hidden');
    el.innerHTML =
      `<div class="gc-reply-preview-inner">` +
        `<div class="gc-reply-preview-body">` +
          `<span class="gc-reply-preview-label">\u21A9 Replying to ${escapeHtml(label)}</span>` +
          `<span class="gc-reply-preview-snippet">${escapeHtml(snippet)}</span>` +
        `</div>` +
        `<button type="button" id="gc-reply-cancel" class="gc-reply-preview-x" aria-label="Cancel reply">\u2715</button>` +
      `</div>`;
    const x = document.getElementById('gc-reply-cancel');
    if (x) x.onclick = () => GroupChat.clearQuote();
  },

  // True only for a clean tap: pointer barely moved AND no text is
  // selected. Lets drag-to-select / long-press-select coexist with
  // tap-to-quote (mobile-first, per #15).
  _isCleanTap(e) {
    const t = GroupChat._tap || { x: e.clientX, y: e.clientY };
    if (Math.abs(e.clientX - t.x) + Math.abs(e.clientY - t.y) > 8) return false;
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim() !== '') return false;
    return true;
  },

  // Collapse all whitespace runs (including the newlines of a multi-line
  // message) to single spaces, so quote snippets stay tidy and single-line.
  _collapseSnippet(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  },

  // Build a quote object from a tapped chat row (message / event / spec).
  _quoteFromRow(row) {
    const id = parseInt(row.dataset.msgId || '', 10) || null;
    if (!id) return null;
    if (row.classList.contains('gc-spec-card')) {
      return {
        source: 'spec', refMsgId: id,
        author: row.dataset.sharedBy || null,
        snippet: row.dataset.specTitle || 'Spec',
      };
    }
    if (row.classList.contains('gc-msg-system')) {
      const textEl = row.querySelector('.gc-msg-system-text');
      const text = (textEl ? textEl.textContent : row.textContent) || '';
      return { source: 'event', refMsgId: id, author: null, snippet: GroupChat._collapseSnippet(text) };
    }
    const body = row.querySelector('.gc-msg-content');
    return {
      source: 'message', refMsgId: id,
      author: row.dataset.username || null,
      // Collapse newlines (multi-line messages render with pre-wrap) so the
      // quote chip stays single-line.
      snippet: GroupChat._collapseSnippet(body ? body.textContent : ''),
    };
  },

  // Click on a rendered quote block → open the PR, or scroll to & flash
  // the original message if it's in the loaded window.
  _handleQuotedClick(quoted) {
    if (quoted.dataset.quoteSource === 'pr') {
      const href = quoted.dataset.quoteHref;
      if (href) window.open(href, '_blank', 'noopener');
      return;
    }
    const ref = parseInt(quoted.dataset.quoteRef || '', 10);
    if (!ref) return;
    // Jump within whichever message list the quote block lives in
    // (general chat or a mounted thread).
    const container = quoted.closest('#gc-messages, #gc-thread-messages')
      || document.getElementById('gc-messages');
    const target = container && container.querySelector(`[data-msg-id="${ref}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('gc-msg-flash');
    setTimeout(() => target.classList.remove('gc-msg-flash'), 1500);
  },

  // Delegated tap-to-quote + quote-jump + reactions on the messages
  // container. Bound once (idempotent), mirroring _attachSpecCardHandlers.
  //
  // Interaction model (#15 + #25, mobile-first):
  //   • quick tap         → quote the row (#15)
  //   • long-press (hold) → open the reaction bar (#25, WhatsApp-style)
  //   • hover react button→ open the reaction bar (desktop)
  //   • tap a reaction pill → toggle that emoji for you
  //   • drag / text-select → neither (handled by the move threshold)
  _attachQuoteHandlers(container) {
    if (container._gcQuoteBound) return;
    container._gcQuoteBound = true;

    const ROW_SEL = '.gc-msg, .gc-msg-system, .gc-spec-card';

    container.addEventListener('pointerdown', (e) => {
      GroupChat._tap = { x: e.clientX, y: e.clientY };
      GroupChat._longPressed = false;
      GroupChat._pressActive = false;
      GroupChat._clearPressTimer();
      // Don't arm long-press on interactive children (links, buttons,
      // pills, the quote block) — those have their own click semantics.
      if (e.target.closest('a, button, .gc-quoted, .gc-ref')) return;
      const row = e.target.closest(ROW_SEL);
      if (!row || !container.contains(row)) return;
      // Suppress native text selection while the press is stationary, so a
      // long-press opens the reaction bar cleanly instead of highlighting
      // the message text (and popping the iOS selection magnifier). If the
      // user drags past the threshold (pointermove below) we hand selection
      // back so a deliberate drag still selects text.
      GroupChat._pressActive = true;
      GroupChat._setMsgSelect(container, false);
      GroupChat._pressTimer = setTimeout(() => {
        GroupChat._pressTimer = null;
        GroupChat._longPressed = true;
        GroupChat._openReactionBar(row);
      }, 450);
    }, true);

    container.addEventListener('pointermove', (e) => {
      if (!GroupChat._pressActive || !GroupChat._tap) return;
      const dist = Math.abs(e.clientX - GroupChat._tap.x) + Math.abs(e.clientY - GroupChat._tap.y);
      if (dist <= 8) return; // tiny jitter — keep the timer + selection suppressed
      // Real drag: the user is selecting text (desktop) or scrolling
      // (touch), not long-pressing. Cancel the reaction timer and re-enable
      // selection so the drag highlights text.
      GroupChat._clearPressTimer();
      GroupChat._setMsgSelect(container, true);
    }, true);

    const endPress = () => {
      GroupChat._clearPressTimer();
      GroupChat._pressActive = false;
      // Restore the default (selectable) state for the next gesture.
      GroupChat._setMsgSelect(container, true);
    };
    container.addEventListener('pointerup', endPress, true);
    container.addEventListener('pointercancel', endPress, true);

    container.addEventListener('click', (e) => {
      // Reaction pill → toggle that emoji for the viewer.
      const pill = e.target.closest('.gc-react-pill');
      if (pill) {
        const row = pill.closest('[data-msg-id]');
        const id = row && parseInt(row.dataset.msgId || '', 10);
        if (id) GroupChat.sendReact(id, pill.dataset.emoji);
        return;
      }
      // Edit button (own ordinary messages) → swap the row into an inline
      // editor. Handled before tap-to-quote so the click doesn't also stage
      // a reply.
      const editBtn = e.target.closest('.gc-msg-edit');
      if (editBtn) {
        const row = editBtn.closest('[data-msg-id]');
        const id = row && parseInt(row.dataset.msgId || '', 10);
        if (id) GroupChat._startEdit(id);
        return;
      }
      // Clicks inside an open inline editor (textarea, notice span, or any
      // other non-button descendant) belong to the editor — it manages its
      // own behaviour through the listeners attached in _startEdit. Handled
      // before tap-to-quote so the click doesn't also stage a reply.
      if (e.target.closest('.gc-edit')) return;
      // Hover react button (desktop) → open the bar for this row.
      const addBtn = e.target.closest('.gc-react-add');
      if (addBtn) {
        const row = addBtn.closest(ROW_SEL);
        if (row) GroupChat._openReactionBar(row);
        return;
      }
      // A long-press already opened the bar — swallow the trailing click
      // so it doesn't also quote the row.
      if (GroupChat._longPressed) { GroupChat._longPressed = false; return; }
      // #130: PR / issue reference chips reveal the matching row in the
      // activity drawer (GitHub fallback when it isn't there). Handled
      // before tap-to-quote so a chip click doesn't also stage a reply.
      const ref = e.target.closest('.gc-ref');
      if (ref) {
        if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
          AppView.revealInDrawer(ref.dataset.refType, ref.dataset.refNumber);
        }
        return;
      }
      // #130: the spec-share card's "PR #N" anchor previously rendered
      // dead — route it through the same drawer reveal as the chips.
      const specPr = e.target.closest('.gc-spec-pr');
      if (specPr) {
        e.preventDefault();
        if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
          AppView.revealInDrawer('pr', specPr.dataset.pr);
        }
        return;
      }
      const quoted = e.target.closest('.gc-quoted');
      if (quoted) { GroupChat._handleQuotedClick(quoted); return; }
      // Real links/buttons (PR link, "View full spec", mentions) win.
      if (e.target.closest('a, button')) return;
      if (!GroupChat._isCleanTap(e)) return;
      const row = e.target.closest(ROW_SEL);
      if (!row || !container.contains(row)) return;
      // Clicking a dotted message clears just that message's unread
      // mention/reply/reaction notification.
      const rowId = parseInt(row.dataset.msgId || '', 10);
      if (rowId) GroupChat._clearMessageDot(rowId);
      const quote = GroupChat._quoteFromRow(row);
      if (quote) GroupChat.setQuote(quote);
    });

    // #130: chips are spans with role="link" tabindex="0" — give keyboard
    // users the same drawer reveal a click gets.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const ref = e.target.closest && e.target.closest('.gc-ref');
      if (!ref) return;
      e.preventDefault();
      if (typeof AppView !== 'undefined' && AppView.revealInDrawer) {
        AppView.revealInDrawer(ref.dataset.refType, ref.dataset.refNumber);
      }
    });
  },

  _clearPressTimer() {
    if (GroupChat._pressTimer) {
      clearTimeout(GroupChat._pressTimer);
      GroupChat._pressTimer = null;
    }
  },

  // Toggle native text selection on the messages list. Disabled at the
  // start of a press so a stationary long-press reacts (instead of
  // selecting/highlighting text); re-enabled as soon as a drag is detected
  // so drag-to-select still works.
  _setMsgSelect(container, enabled) {
    const c = container || document.getElementById('gc-messages');
    if (!c) return;
    const v = enabled ? '' : 'none';
    c.style.userSelect = v;
    c.style.webkitUserSelect = v;
  },

  // ── #25: reaction rendering ─────────────────────────────────────────

  _renderReactionPills(msg) {
    const rx = (msg && msg.reactions) || [];
    if (!rx.length) return '';
    const me = App.user && App.user.username;
    return rx.map((r) => {
      const users = Array.isArray(r.users) ? r.users : [];
      const mine = me && users.includes(me);
      return `<button class="gc-react-pill${mine ? ' gc-react-mine' : ''}" data-emoji="${escapeHtml(r.emoji)}" title="${escapeHtml(users.join(', '))}">` +
        `<span class="gc-react-emoji">${escapeHtml(r.emoji)}</span>` +
        `<span class="gc-react-count">${r.count}</span>` +
        `</button>`;
    }).join('');
  },

  // Always render the (possibly empty) container so live updates have a
  // stable target to patch without re-rendering the whole row.
  _renderReactionsHtml(msg) {
    return `<div class="gc-reactions" id="gc-react-${msg.id || ''}">${GroupChat._renderReactionPills(msg)}</div>`;
  },

  // Desktop hover affordance to open the reaction bar. tabindex -1 keeps it
  // out of the tab order; touch devices use long-press instead (CSS hides
  // it where there's no hover).
  _renderReactAddBtn(_msg) {
    if (GroupChat._readOnly()) return ''; // #621: no reactions read-only
    return `<button class="gc-react-add" title="React" aria-label="Add reaction" tabindex="-1">\u{1F642}</button>`;
  },

  // Apply a fresh reaction aggregate (from the WS 'reaction' broadcast or
  // history) to a message — update state + patch just its pill row. The
  // message may live in the general stream or any cached thread (#194).
  _updateMessageReactions(messageId, reactions) {
    let msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (!msg) {
      for (const st of GroupChat.threads.values()) {
        msg = st.messages.find((m) => String(m.id) === String(messageId));
        if (msg) break;
      }
    }
    if (msg) msg.reactions = reactions || [];
    const el = document.getElementById(`gc-react-${messageId}`);
    if (el) el.innerHTML = GroupChat._renderReactionPills(msg || { reactions: reactions || [] });
  },

  // Toggle an emoji on a message for the current user (server decides
  // add-vs-remove). Fire-and-forget over the chat socket; the authoritative
  // aggregate comes back via the 'reaction' broadcast.
  sendReact(messageId, emoji) {
    if (GroupChat._readOnly()) return;
    if (!messageId || !emoji) return;
    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      GroupChat.ws.send(JSON.stringify({ type: 'react', messageId, emoji }));
    }
    GroupChat._closeReactionBar();
  },

  // ── message editing ─────────────────────────────────────────────────

  // Auto-grow a composer / inline-editor <textarea>: reset to one row then
  // expand to fit its content, capped at MAX so it scrolls internally
  // instead of taking over the screen. Idempotent — safe to call on every
  // input event, draft restore, and after a send (value='' shrinks back).
  _COMPOSER_MAX_PX: 140, // ~5–6 lines before it scrolls
  _autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, GroupChat._COMPOSER_MAX_PX)}px`;
  },

  // Touch devices have no Shift+Enter chord, so Enter inserts a newline and
  // the Send button is the send action (composer) / Save button (editor).
  _isTouch() {
    return !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
  },

  // Full-precision timestamp for the "edited" marker's tooltip, e.g.
  // "edited Jun 16, 2026, 2:41 PM". Reuses the same locale approach as the
  // per-message time.
  _editedTitle(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'edited';
    const date = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `edited ${date}, ${time}`;
  },

  // Hover affordance (desktop) to edit own message. Hidden on touch via CSS
  // (long-press bar carries the Edit action there), mirroring gc-react-add.
  _renderEditBtn(_msg) {
    if (GroupChat._readOnly()) return ''; // #621: no edits read-only
    return `<button class="gc-msg-edit" title="Edit" aria-label="Edit message" tabindex="-1">✏️</button>`;
  },

  // Locate a message (and its containing thread state, if any) by id across
  // the general stream and every cached thread.
  _findMessage(id) {
    let msg = GroupChat.messages.find((m) => String(m.id) === String(id));
    if (msg) return msg;
    for (const st of GroupChat.threads.values()) {
      msg = st.messages.find((m) => String(m.id) === String(id));
      if (msg) return msg;
    }
    return null;
  },

  // Find the rendered row for a message in whichever list it's shown in.
  _findRow(id) {
    return document.querySelector(
      `#gc-messages .gc-msg[data-msg-id="${id}"], #gc-thread-messages .gc-msg[data-msg-id="${id}"]`
    );
  },

  // Send an edit over the WS (fire-and-forget; the authoritative update
  // arrives via the 'chat_edit' broadcast — mirrors sendReact). Returns
  // false when the socket isn't open so the caller can keep the editor up.
  // Edits are deliberately NOT queued like sends: a stale edit replayed
  // after a reconnect is more surprising than a no-op.
  sendEdit(messageId, content) {
    if (!(GroupChat.ws && GroupChat.ws.readyState === 1)) return false;
    GroupChat.ws.send(JSON.stringify({ type: 'edit', messageId, content }));
    return true;
  },

  // Turn a message row into an inline editor pre-filled with its raw
  // content. No-op for rows already being edited (just refocus).
  _startEdit(id) {
    const row = GroupChat._findRow(id);
    if (!row) return;
    if (row.dataset.editing === '1') {
      const ta = row.querySelector('.gc-edit-textarea');
      if (ta) ta.focus();
      return;
    }
    const msg = GroupChat._findMessage(id);
    const contentEl = row.querySelector('.gc-msg-content');
    if (!msg || !contentEl) return;

    const editor = document.createElement('div');
    editor.className = 'gc-edit';
    editor.innerHTML =
      `<textarea class="gc-edit-textarea gc-composer-input" maxlength="${GC_MAX_MESSAGE_LEN}" rows="1"></textarea>` +
      `<div class="gc-edit-actions">` +
        `<button type="button" class="gc-edit-save">Save</button>` +
        `<button type="button" class="gc-edit-cancel">Cancel</button>` +
        `<span class="gc-edit-notice" hidden></span>` +
      `</div>`;
    const ta = editor.querySelector('.gc-edit-textarea');
    ta.value = msg.content || '';
    contentEl.style.display = 'none';
    contentEl.insertAdjacentElement('afterend', editor);
    row.dataset.editing = '1';

    GroupChat._autoGrowTextarea(ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}

    ta.addEventListener('input', () => GroupChat._autoGrowTextarea(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); GroupChat._cancelEdit(row); return; }
      // Enter saves, Shift+Enter adds a newline (touch: newline only — Save
      // button saves).
      if (e.key === 'Enter' && !e.shiftKey && !GroupChat._isTouch()) {
        e.preventDefault();
        GroupChat._saveEdit(id, row, ta);
      }
    });
    editor.querySelector('.gc-edit-save').addEventListener('click', () => GroupChat._saveEdit(id, row, ta));
    editor.querySelector('.gc-edit-cancel').addEventListener('click', () => GroupChat._cancelEdit(row));
  },

  // Tear down the inline editor and restore the (possibly already-patched)
  // content node.
  _cancelEdit(row) {
    if (!row || row.dataset.editing !== '1') return;
    const editor = row.querySelector('.gc-edit');
    if (editor) editor.remove();
    const contentEl = row.querySelector('.gc-msg-content');
    if (contentEl) contentEl.style.display = '';
    delete row.dataset.editing;
  },

  // Commit an inline edit. Empty content cancels (editing is not a delete
  // path). If the socket is down, surface a notice and keep the editor open
  // rather than dropping or queueing the edit.
  _saveEdit(id, row, ta) {
    const content = ta.value.trim();
    if (!content) { GroupChat._cancelEdit(row); return; }
    if (!GroupChat.sendEdit(id, content)) {
      const notice = row.querySelector('.gc-edit-notice');
      if (notice) {
        notice.hidden = false;
        notice.textContent = 'Not connected — your edit wasn’t sent. Try again in a moment.';
      }
      return;
    }
    // Optimistically paint the new content so there's no flash; the
    // authoritative content + "edited" marker arrive via the broadcast.
    const contentEl = row.querySelector('.gc-msg-content');
    if (contentEl) contentEl.innerHTML = renderMessageBody(content);
    GroupChat._cancelEdit(row);
  },

  // Apply an incoming 'chat_edit' broadcast: update cached state and patch
  // the row in place (content + "edited" marker) without re-rendering the
  // list, so scroll position and reaction pills are preserved.
  _applyEdit(data) {
    const { messageId, content, editedAt } = data || {};
    if (messageId == null) return;
    const msg = GroupChat._findMessage(messageId);
    if (msg) { msg.content = content; msg.editedAt = editedAt; }
    const row = GroupChat._findRow(messageId);
    if (!row) return;
    // If the author had this open in an editor, close it — the broadcast is
    // authoritative.
    GroupChat._cancelEdit(row);
    const contentEl = row.querySelector('.gc-msg-content');
    if (contentEl) contentEl.innerHTML = renderMessageBody(content);
    GroupChat._patchEditedMarker(row, editedAt);
  },

  // Insert or refresh the "edited" marker after a row's timestamp.
  _patchEditedMarker(row, editedAt) {
    if (!editedAt) return;
    const timeEl = row.querySelector('.gc-msg-header .gc-msg-time');
    if (!timeEl) return;
    const title = GroupChat._editedTitle(editedAt);
    let marker = row.querySelector('.gc-msg-header .gc-msg-edited');
    if (marker) {
      marker.title = title;
    } else {
      timeEl.insertAdjacentHTML(
        'afterend',
        `<span class="gc-msg-edited" title="${escapeHtml(title)}">edited</span>`
      );
    }
  },

  // ── #25: reaction bar (WhatsApp-style quick row + curated grid) ──────

  _ensureReactionBar() {
    if (GroupChat._reactBar) return GroupChat._reactBar;
    const bar = document.createElement('div');
    bar.id = 'gc-react-bar';
    bar.className = 'gc-react-bar hidden';
    const quick = GroupChat.QUICK_REACTIONS
      .map((e) => `<button class="gc-react-bar-emoji" data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`)
      .join('');
    const grid = GroupChat.GRID_REACTIONS
      .map((e) => `<button class="gc-react-bar-emoji" data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`)
      .join('');
    bar.innerHTML =
      `<div class="gc-react-bar-quick">${quick}` +
        `<button class="gc-react-bar-more" aria-label="More emoji">\uFF0B</button>` +
        // Touch-only Edit action for own ordinary messages (desktop uses the
        // hover pencil). Visibility is toggled per-row in _openReactionBar.
        `<button class="gc-react-bar-edit hidden" aria-label="Edit message">\u270F\uFE0F</button>` +
      `</div>` +
      `<div class="gc-react-bar-grid hidden">${grid}</div>`;
    bar.addEventListener('click', (e) => {
      const em = e.target.closest('.gc-react-bar-emoji');
      if (em) { GroupChat._reactFromBar(em.dataset.emoji); return; }
      if (e.target.closest('.gc-react-bar-edit')) {
        const id = parseInt(bar.dataset.msgId || '', 10);
        GroupChat._closeReactionBar();
        if (id) GroupChat._startEdit(id);
        return;
      }
      if (e.target.closest('.gc-react-bar-more')) {
        bar.querySelector('.gc-react-bar-grid').classList.toggle('hidden');
      }
    });
    document.body.appendChild(bar);
    GroupChat._reactBar = bar;
    return bar;
  },

  _openReactionBar(row) {
    if (GroupChat._readOnly()) return; // #621: long-press bar is write-only
    const id = row && parseInt(row.dataset.msgId || '', 10);
    if (!id) return;
    const bar = GroupChat._ensureReactionBar();
    bar.dataset.msgId = String(id);
    bar.querySelector('.gc-react-bar-grid').classList.add('hidden');
    // Offer Edit only on the viewer's own ordinary messages.
    const editable = row.classList.contains('gc-msg') && row.classList.contains('gc-msg-self');
    const editBtn = bar.querySelector('.gc-react-bar-edit');
    if (editBtn) editBtn.classList.toggle('hidden', !editable);
    bar.classList.remove('hidden');
    GroupChat._reactBarOpenedAt = Date.now();

    // Position above the row (fall back to below if it would clip the top).
    const r = row.getBoundingClientRect();
    const bw = bar.offsetWidth || 280;
    const bh = bar.offsetHeight || 44;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - bw - 8);
    let top = r.top - bh - 6;
    if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - bh - 8);
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;

    if (!GroupChat._reactBarDismiss) {
      GroupChat._reactBarDismiss = (ev) => {
        if (ev.type === 'keydown') { if (ev.key === 'Escape') GroupChat._closeReactionBar(); return; }
        if (ev.type === 'click') {
          // Ignore the click that opened the bar (long-press release or the
          // hover button's own click).
          if (Date.now() - (GroupChat._reactBarOpenedAt || 0) < 350) return;
          if (GroupChat._reactBar && GroupChat._reactBar.contains(ev.target)) return;
          GroupChat._closeReactionBar();
          return;
        }
        GroupChat._closeReactionBar(); // scroll
      };
    }
    setTimeout(() => {
      document.addEventListener('click', GroupChat._reactBarDismiss, true);
      document.addEventListener('keydown', GroupChat._reactBarDismiss, true);
      // #363: dismiss on scroll of whichever stream is mounted — the general
      // chat (#gc-messages) or a topic thread's unified scroller
      // (#gc-thread-scroll).
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.addEventListener('scroll', GroupChat._reactBarDismiss, true);
      const tscroll = document.getElementById('gc-thread-scroll');
      if (tscroll) tscroll.addEventListener('scroll', GroupChat._reactBarDismiss, true);
    }, 0);
  },

  _closeReactionBar() {
    const bar = GroupChat._reactBar;
    if (bar) { bar.classList.add('hidden'); bar.removeAttribute('data-msg-id'); }
    if (GroupChat._reactBarDismiss) {
      document.removeEventListener('click', GroupChat._reactBarDismiss, true);
      document.removeEventListener('keydown', GroupChat._reactBarDismiss, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', GroupChat._reactBarDismiss, true);
      const tscroll = document.getElementById('gc-thread-scroll');
      if (tscroll) tscroll.removeEventListener('scroll', GroupChat._reactBarDismiss, true);
    }
  },

  _reactFromBar(emoji) {
    const bar = GroupChat._reactBar;
    const id = bar && parseInt(bar.dataset.msgId || '', 10);
    if (id && emoji) GroupChat.sendReact(id, emoji);
    GroupChat._closeReactionBar();
  },

  // ── per-message unread dot ──────────────────────────────────────────

  // Dot markup for a message this user has an unread mention/reply/
  // reaction notification for. Driven by the server's
  // has_unread_notification flag on loaded history; live messages never
  // carry it (a brand-new message can't yet have a notification for you).
  _unreadDotHtml(msg) {
    if (!msg || !msg.has_unread_notification) return '';
    return `<span class="gc-unread-dot" data-unread-dot="${msg.id || ''}" aria-label="Unread mention"></span>`;
  },

  // Clear the dot for one message (the "click a dotted message" path):
  // optimistically drop it locally, then confirm read on the server by
  // chat_message_id. Other tabs reconcile via the notifications_changed
  // broadcast the server fans out. No-op if the message has no dot.
  _clearMessageDot(messageId) {
    const msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (!msg || !msg.has_unread_notification) return;
    msg.has_unread_notification = false;
    const dot = document.querySelector(`[data-unread-dot="${messageId}"]`);
    if (dot) dot.remove();
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_message_id: Number(messageId) }),
    }).then((res) => {
      // Only sync the bell badge once the backend confirms — never
      // optimistically. The dot is already gone locally above.
      if (res.ok) window.Notifications?.refresh?.();
    }).catch(() => {});
  },

  // Reconcile dots from the current notifications list (window.Notifications
  // .items). Called on notification_new (a mention arrived while viewing)
  // and notifications_changed (something was cleared — e.g. this user sent
  // a message and the reply-clears-all fired, or another tab cleared one).
  // Operates only over messages the list actually references, so older
  // dotted messages outside the capped list aren't wrongly touched: a
  // referenced message's dot becomes (readAt == null).
  reconcileDotsFromNotifications() {
    const items = (window.Notifications && Notifications.items) || [];
    if (!Array.isArray(items)) return;
    const KINDS = new Set(['mention', 'reply', 'reaction']);
    const state = new Map(); // chatMessageId -> isUnread
    for (const n of items) {
      if (!n || !KINDS.has(n.kind) || n.chatMessageId == null) continue;
      // A later (newer) item wins; items are newest-first, so only set if
      // not already seen.
      if (!state.has(n.chatMessageId)) state.set(n.chatMessageId, !n.readAt);
    }
    for (const msg of GroupChat.messages) {
      if (!state.has(msg.id)) continue;
      const unread = state.get(msg.id);
      if (!!msg.has_unread_notification === unread) continue;
      msg.has_unread_notification = unread;
      const existing = document.querySelector(`[data-unread-dot="${msg.id}"]`);
      if (unread && !existing) {
        const row = document.querySelector(`.gc-msg[data-msg-id="${msg.id}"] .gc-msg-header`);
        if (row) row.insertAdjacentHTML('afterbegin', GroupChat._unreadDotHtml(msg));
      } else if (!unread && existing) {
        existing.remove();
      }
    }
  },

  renderMessageHtml(msg) {
    const time = new Date(msg.createdAt || msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const username = msg.username || 'System';
    const isSystem = msg.msgType === 'system' || msg.msg_type === 'system';
    const isVote = msg.msgType === 'vote' || msg.msg_type === 'vote';
    const isSpecShare = msg.msgType === 'spec_share' || msg.msg_type === 'spec_share';
    const isSelf = msg.userId === App.user?.id || msg.user_id === App.user?.id;

    if (isSpecShare) {
      // Server attaches the full snapshot context in `metadata.specShare`.
      // Older browsers (or older servers) might miss the metadata —
      // fall back to a plain system line in that case so the row still
      // renders rather than vanishing.
      const meta = (msg.metadata || msg.meta || {}).specShare;
      if (!meta) {
        return `<div class="gc-msg-system">${escapeHtml(msg.content)}</div>`;
      }
      return GroupChat.renderSpecShareCard(msg, meta, time);
    }

    if (isSystem || isVote) {
      // Vote-activity rows (promote / vote cast) render live vote buttons
      // inline next to the text — wired to the same AppView.castVote /
      // castAdminMerge / swapToStaging the vote panel uses. We always emit
      // the wrapper (carrying the precise metadata session id when present
      // AND the "PR #N" parsed from the text) so refreshVoteControls() can
      // fill it once AppView.voteState is ready — even when the chat
      // renders before the vote panel finishes its first fetch.
      const inlineControls = isVote ? GroupChat._voteControlsHtml(msg) : '';
      // Tint the row text by the viewer's vote status on this PR: faded
      // (--accent-light) once they've voted, full-strength (--accent) while
      // their vote is still outstanding, so unvoted rows draw the eye.
      const voteRowClass = isVote ? GroupChat._rowVoteClass(GroupChat._resolvePr(...GroupChat._voteRef(msg))) : '';
      return `<div class="gc-msg-system ${isVote ? 'gc-msg-vote' : ''}${voteRowClass ? ' ' + voteRowClass : ''}" data-msg-id="${msg.id || ''}">` +
        `<span class="gc-msg-system-text">${escapeHtml(msg.content)}</span>` +
        inlineControls +
        GroupChat._renderReactAddBtn(msg) +
        GroupChat._renderReactionsHtml(msg) +
        `</div>`;
    }

    // #15: a user message may carry a quote (reply) in metadata. Render the
    // quoted block above the content; data-msg-id lets a reply elsewhere
    // scroll back to this row. #25: reactions + the hover react button.
    const quotedHtml = GroupChat._renderQuotedBlock(msg.metadata || msg.meta);
    // Editing: an "edited" marker (with the full edit timestamp in its
    // tooltip) once edited_at is set, and an Edit affordance on the user's
    // OWN ordinary messages (hover on desktop; long-press bar on touch).
    const editedAt = msg.editedAt || msg.edited_at;
    const editedMarker = editedAt
      ? `<span class="gc-msg-edited" title="${escapeHtml(GroupChat._editedTitle(editedAt))}">edited</span>`
      : '';
    const editBtn = isSelf ? GroupChat._renderEditBtn(msg) : '';
    return `
      <div class="gc-msg ${isSelf ? 'gc-msg-self' : ''}" data-msg-id="${msg.id || ''}" data-username="${escapeHtml(username)}">
        <div class="gc-msg-header">
          ${GroupChat._unreadDotHtml(msg)}
          <span class="gc-msg-username ${isSelf ? 'gc-msg-username-self' : ''}">${escapeHtml(username)}</span>
          <span class="gc-msg-time">${time}</span>
          ${editedMarker}
          ${editBtn}
          ${GroupChat._renderReactAddBtn(msg)}
        </div>
        ${quotedHtml}
        <div class="gc-msg-content">${renderMessageBody(msg.content)}</div>
        ${GroupChat._renderReactionsHtml(msg)}
      </div>`;
  },

  // Inline vote buttons for a "promoted / voted" activity row. State comes
  // from AppView.voteState (populated by AppView.loadVotePanel), so the
  // buttons reflect live counts / my_vote and collapse to nothing once the
  // PR leaves the votable set (merged / closed). The wrapper carries
  // data-session-id so refreshVoteControls() can re-fill it in place when
  // votes change, without re-rendering the whole chat.
  // Wrapper for a vote-activity row. Carries the precise metadata session
  // id (new server) when present AND the "PR #N" parsed from the row text,
  // so the buttons can be (re)resolved against AppView.voteState at fill
  // time. data-session-id / data-pr-number let refreshVoteControls() patch
  // it in place without re-rendering the chat.
  _voteControlsHtml(msg) {
    const [sid, prNum] = GroupChat._voteRef(msg);
    if (sid === '' && prNum === '') return '';
    return `<span class="gc-vote-inline" data-vote-controls data-session-id="${sid}" data-pr-number="${prNum}">`
      + GroupChat._voteInnerHtml(GroupChat._resolvePr(sid, prNum))
      + `</span>`;
  },

  // [sessionId, prNumber] ref for a vote-activity row: the precise metadata
  // session id (new server) when present, plus the "PR #N" parsed from the
  // row text (works for older rows that predate the metadata tag).
  _voteRef(msg) {
    const meta = (msg.metadata || msg.meta || {}).vote;
    const sid = meta && meta.sessionId != null ? String(meta.sessionId) : '';
    const m = /PR #(\d+)/.exec(msg.content || '');
    return [sid, m ? m[1] : ''];
  },

  // Resolve a (sessionId, prNumber) ref to the live PR in AppView.voteState,
  // or null when it isn't currently votable ('merging'/merged/closed → no
  // longer in the promoted set, mirroring the vote panel). Prefers the
  // session id; falls back to PR number, then to treating the parsed number
  // as a session id (the label uses pr_number || session.id when no PR
  // number exists yet).
  _resolvePr(sid, prNum) {
    const st = (typeof AppView !== 'undefined' && AppView.voteState) || null;
    if (!st) return null;
    let pr = sid ? (st.bySession && st.bySession[sid]) : null;
    if (!pr && prNum) pr = (st.byPrNumber && st.byPrNumber[prNum]) || (st.bySession && st.bySession[prNum]);
    // 'merging' AND 'merged' rows stay resolvable so the tally pill + "You
    // voted X" don't vanish during or after a merge — a "Merging…"/"Merged"
    // badge is appended alongside instead.
    return pr && (pr.status === 'promoted' || pr.status === 'merging' || pr.status === 'merged') ? pr : null;
  },

  // Inner HTML for a resolved votable PR: the live "yes / majority" count
  // followed by the vote buttons. Empty when the PR isn't votable, so the
  // wrapper collapses and the row falls back to a plain activity line.
  _voteInnerHtml(pr) {
    if (!pr || typeof AppView.voteButtonsHtml !== 'function') return '';
    const st = (typeof AppView !== 'undefined' && AppView.voteState) || {};
    // collapseVoted: in the chat, a cast vote collapses to a "You voted X"
    // box (the drawer keeps the full set so it stays re-castable there).
    // A "Merging…"/"Merged" badge is appended (not substituted) once the PR
    // crosses the threshold, so the pill + "You voted X" survive the merge.
    let badge = '';
    if (pr.status === 'merging') badge = AppView.mergingBadgeHtml();
    else if (pr.status === 'merged') badge = AppView.mergedBadgeHtml();
    return AppView.voteCountPill(pr, st.majority) + AppView.voteButtonsHtml(pr, { collapseVoted: true }) + badge;
  },

  // Row text-color class from the viewer's vote status: faded once voted,
  // full-strength while their vote is outstanding. '' for non-votable rows
  // (keeps the default --accent vote-line color).
  _rowVoteClass(pr) {
    if (!pr) return '';
    return pr.my_vote === 'yes' || pr.my_vote === 'no' ? 'gc-vote-voted' : 'gc-vote-unvoted';
  },

  // Re-fill every inline vote-control wrapper from the current
  // AppView.voteState. Called by AppView.loadVotePanel after it reloads on
  // a vote/session update (and on first open, covering the race where the
  // chat renders before the panel finishes fetching), so the inline
  // buttons + count + row tint track the panel. A PR no longer in the
  // votable set yields empty controls and the row falls back to a plain
  // activity line.
  refreshVoteControls() {
    document.querySelectorAll('#gc-messages [data-vote-controls], #gc-thread-messages [data-vote-controls]').forEach((el) => {
      const pr = GroupChat._resolvePr(
        el.getAttribute('data-session-id') || '',
        el.getAttribute('data-pr-number') || ''
      );
      el.innerHTML = GroupChat._voteInnerHtml(pr);
      const row = el.closest('.gc-msg-vote');
      if (row) {
        row.classList.remove('gc-vote-voted', 'gc-vote-unvoted');
        const cls = GroupChat._rowVoteClass(pr);
        if (cls) row.classList.add(cls);
      }
    });
  },

  // #15: the quote block shown on a message that is itself a reply. Click
  // handling (jump-to-original / open PR) is delegated in
  // _attachQuoteHandlers.
  _renderQuotedBlock(metadata) {
    const q = (metadata || {}).quote;
    if (!q) return '';
    const who = q.author
      ? escapeHtml(q.author)
      : (q.source === 'pr' ? `PR #${q.prNumber || ''}`.trim() : 'system');
    const snippet = escapeHtml(GroupChat._collapseSnippet(q.snippet).slice(0, 160));
    const icon = q.source === 'pr' ? '\u{1F500}' : (q.source === 'spec' ? '\u{1F4CB}' : '\u21A9');
    const data = q.source === 'pr'
      ? `data-quote-source="pr" data-quote-href="${escapeHtml(q.href || '')}"`
      : `data-quote-source="${escapeHtml(q.source || '')}" data-quote-ref="${q.refMsgId || ''}"`;
    return `<div class="gc-quoted" ${data}>` +
      `<span class="gc-quoted-author">${icon} ${who}</span>` +
      `<span class="gc-quoted-snippet">${snippet}</span>` +
      `</div>`;
  },

  renderSpecShareCard(msg, meta, time) {
    const sharedBy = meta.sharedBy?.username || msg.username || 'Someone';
    const built = meta.builtAt ? new Date(meta.builtAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const prLink = meta.prNumber
      ? `<a class="gc-spec-pr" href="#" data-pr="${meta.prNumber}">PR #${meta.prNumber}</a>`
      : '';
    // `meta.title` is set by the share endpoint when the spec content
    // starts with an H1; older shares predate that field and fall
    // back to "Spec v<n>". The snippet is rendered as markdown so the
    // preview matches what the user sees in the dev-chat spec viewer
    // (shared markdown helper from DevChat).
    //
    // Reach DevChat via a bare reference and `typeof` guard rather
    // than `window.DevChat` — DevChat is declared with `const` at
    // dev-chat.js's top level, which does NOT install it as a
    // property on `window` (only `var` / function declarations do).
    // It IS visible as a global identifier across <script> tags
    // because both files share the same script-scope, so a bare
    // `DevChat.renderMarkdown(...)` works; the `typeof` keeps things
    // safe if dev-chat.js ever fails to load.
    const title = meta.title || `Spec v${meta.version}`;
    const renderMd = typeof DevChat !== 'undefined' && DevChat.renderMarkdown
      ? (s) => DevChat.renderMarkdown(s)
      : (s) => escapeHtml(s);
    const snippetHtml = meta.snippet ? renderMd(meta.snippet) : '';
    const titleAttr = meta.title || `spec v${meta.version}`;
    return `
      <div class="gc-spec-card" data-msg-id="${msg.id || ''}" data-spec-title="${escapeHtml(titleAttr)}" data-session-id="${meta.sessionId || ''}" data-shared-by="${escapeHtml(sharedBy)}">
        <div class="gc-spec-card-header">
          <span class="gc-spec-card-icon">📋</span>
          <span class="gc-spec-card-title">${escapeHtml(title)}</span>
          <span class="gc-msg-time">${time}</span>
        </div>
        <div class="gc-spec-card-attribution">
          Shared by <strong>${escapeHtml(sharedBy)}</strong> · v${meta.version}${built ? ' · ' + escapeHtml(built) : ''}${prLink ? ' · ' + prLink : ''}
        </div>
        ${snippetHtml ? `<div class="gc-spec-card-snippet">${snippetHtml}</div>` : ''}
        <div class="gc-spec-card-actions">
          <button class="gc-spec-card-view" data-session-id="${meta.sessionId}" data-version="${meta.version}">View full spec</button>
        </div>
        ${GroupChat._renderReactionsHtml(msg)}
        ${GroupChat._renderReactAddBtn(msg)}
      </div>`;
  },

  // Click delegate: View full spec → modal with the frozen content.
  // Bound once to the messages container in attachScrollHandlers; idempotent.
  _attachSpecCardHandlers(container) {
    if (container._gcSpecHandlersBound) return;
    container._gcSpecHandlersBound = true;
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('.gc-spec-card-view');
      if (!btn) return;
      e.preventDefault();
      const sessionId = btn.dataset.sessionId;
      const version = btn.dataset.version;
      if (!sessionId || !version) return;
      btn.disabled = true;
      btn.textContent = 'Loading…';
      // Title preview from the card so the modal header isn't empty
      // while the network request is in flight. Falls back to the
      // version label if the card's data attribute is missing (older
      // shares, or unusual DOM states).
      const card = btn.closest('.gc-spec-card');
      const previewTitle = (card && card.dataset.specTitle) || `Spec v${version}`;
      // Persist the open state so a refresh re-opens this same
      // spec automatically. Per-app keying ensures switching apps
      // doesn't drag this open state along with you.
      GroupChat._writeSpecPanelOpen(GroupChat.appSlug, {
        sessionId: parseInt(sessionId, 10),
        version: parseInt(version, 10),
        title: previewTitle,
      });
      try {
        const resp = await fetch(`/api/sessions/${sessionId}/specs/${version}`);
        // After #6, the server allows any authed user to read a spec
        // version that was explicitly shared into the group chat. A
        // 404 here therefore means the share was withdrawn or the
        // version row is gone (rare — would require manual DB edits
        // or a session DELETE CASCADE) rather than the routine
        // "not the owner" case it used to mean.
        if (!resp.ok) {
          GroupChat._showSpecPanel({
            title: previewTitle,
            version,
            content: resp.status === 404
              ? 'This spec is no longer available. The sharer may have deleted the session.'
              : `Failed to load spec (HTTP ${resp.status}).`,
            isError: true,
          });
          return;
        }
        const data = await resp.json();
        GroupChat._showSpecPanel({
          title: previewTitle,
          version,
          content: data.spec.content || '(empty spec)',
          builtAt: data.spec.built_at,
          prNumber: data.spec.pr_number,
        });
      } catch (err) {
        GroupChat._showSpecPanel({
          title: previewTitle,
          version,
          content: `Error: ${err.message}`,
          isError: true,
        });
      } finally {
        btn.disabled = false;
        btn.textContent = 'View full spec';
      }
    });
  },

  _showSpecPanel({ title, version, content, builtAt, prNumber, isError }) {
    // Populates the side-panel slot rendered inside the group-chat
    // tab body (see app-view.js renderGroupChatTab). The same panel
    // markup serves both responsive layouts — CSS switches between
    //   ≥ 1024px → inline side panel beside the chat (does NOT cover
    //              the app header or vote panel, slots into the
    //              gc-tab-body row alongside gc-chat-pane)
    //   < 1024px → fullscreen modal covering only the gc-tab-body
    //              area (still does NOT cover the app header or
    //              vote/issue panel, since the slot is constrained
    //              to that flex row).
    // Esc closes; the panel persists across re-renders of the chat
    // tab because the slot lives in the layout, not in body.
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;

    if (!panel._gcKeyHandler) {
      const onKey = (e) => {
        if (e.key === 'Escape' && panel.classList.contains('gc-spec-side-panel-open')) {
          GroupChat._closeSpecPanel();
        }
      };
      document.addEventListener('keydown', onKey);
      panel._gcKeyHandler = onKey;
    }

    const builtStr = builtAt ? new Date(builtAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const subtitleParts = [];
    if (version != null) subtitleParts.push(`v${version}`);
    if (builtStr) subtitleParts.push(builtStr);
    if (prNumber) subtitleParts.push(`PR #${prNumber}`);
    const subtitle = subtitleParts.join(' · ');

    // Render markdown for normal content; error / 404 messages are
    // plain text so we don't accidentally turn an error into a
    // misleadingly-formatted bit of markup. See the renderSpecShareCard
    // comment for why we use a bare `DevChat` reference + `typeof`
    // guard rather than `window.DevChat` (const-declared globals don't
    // attach to window).
    const bodyHtml = isError
      ? `<div class="gc-spec-panel-error">${escapeHtml(content)}</div>`
      : (typeof DevChat !== 'undefined' && DevChat.renderMarkdown
          ? DevChat.renderMarkdown(content)
          : escapeHtml(content));

    panel.innerHTML = `
      <div class="gc-spec-panel-header">
        <div class="gc-spec-panel-titlewrap">
          <div class="gc-spec-panel-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="gc-spec-panel-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button class="gc-spec-panel-close" aria-label="Close spec panel">×</button>
      </div>
      <div class="gc-spec-panel-body">${bodyHtml}</div>`;
    panel.classList.add('gc-spec-side-panel-open');
    GroupChat._applySavedSpecPanelWidth();

    const handle = document.getElementById('gc-spec-resizer');
    if (handle) handle.classList.add('gc-spec-resizer-open');

    panel.querySelector('.gc-spec-panel-close').addEventListener('click', () => GroupChat._closeSpecPanel());
  },

  _closeSpecPanel() {
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;
    panel.classList.remove('gc-spec-side-panel-open');
    panel.innerHTML = '';
    if (panel._gcKeyHandler) {
      document.removeEventListener('keydown', panel._gcKeyHandler);
      panel._gcKeyHandler = null;
    }
    const handle = document.getElementById('gc-spec-resizer');
    if (handle) handle.classList.remove('gc-spec-resizer-open');
    GroupChat._writeSpecPanelOpen(GroupChat.appSlug, null);
  },

  // ===== Spec panel: draggable divider + open/width persistence =====
  //
  // Mirrors DevChat's spec-viewer pattern. Width is a global user
  // preference (one value across all apps). Open state is per-app —
  // when you're viewing app A with a panel open and switch to app B,
  // B opens with its own remembered state, not A's leftover.
  //
  // Open state shape: { sessionId, version, title } so we can paint
  // the panel header instantly on refresh while the spec content
  // request is in flight.

  _SPEC_PANEL_WIDTH_KEY: 'gc-spec-panel-width-v1',
  _SPEC_PANEL_OPEN_KEY_PREFIX: 'gc-spec-panel-open-v1:',

  _readSpecPanelWidth() {
    try {
      const v = parseInt(localStorage.getItem(GroupChat._SPEC_PANEL_WIDTH_KEY) || '', 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  },

  _writeSpecPanelWidth(px) {
    try { localStorage.setItem(GroupChat._SPEC_PANEL_WIDTH_KEY, String(Math.round(px))); }
    catch {}
  },

  _readSpecPanelOpen(appSlug) {
    if (!appSlug) return null;
    try {
      const raw = localStorage.getItem(GroupChat._SPEC_PANEL_OPEN_KEY_PREFIX + appSlug);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sessionId && parsed.version) return parsed;
      return null;
    } catch { return null; }
  },

  _writeSpecPanelOpen(appSlug, state) {
    if (!appSlug) return;
    try {
      const key = GroupChat._SPEC_PANEL_OPEN_KEY_PREFIX + appSlug;
      if (state) localStorage.setItem(key, JSON.stringify(state));
      else localStorage.removeItem(key);
    } catch {}
  },

  // Apply the persisted width as inline style on the panel. Called
  // by _showSpecPanel when opening; CSS clamps via min-width /
  // max-width so a stale value can't strand the chat too narrow.
  _applySavedSpecPanelWidth() {
    const panel = document.getElementById('gc-spec-side-panel');
    if (!panel) return;
    const w = GroupChat._readSpecPanelWidth();
    if (w) panel.style.width = `${w}px`;
  },

  // Bind the resizer's drag handler. Idempotent: re-binding on
  // every group-chat mount is fine because the handle element gets
  // recreated whenever the tab re-renders, and we tag the handle
  // so we don't double-bind on the same element.
  _initSpecPanelResizer() {
    const handle = document.getElementById('gc-spec-resizer');
    const panel = document.getElementById('gc-spec-side-panel');
    if (!handle || !panel) return;
    if (handle._gcResizerBound) return;
    handle._gcResizerBound = true;

    handle.addEventListener('pointerdown', (e) => {
      // Drag only matters when the panel is actually showing in
      // side-panel layout. CSS hides the handle (display: none)
      // outside that condition, so a pointerdown reaching this
      // listener already implies the layout is correct — but the
      // `.gc-spec-side-panel-open` class is the authoritative
      // signal so we double-check it.
      if (!panel.classList.contains('gc-spec-side-panel-open')) return;
      e.preventDefault();

      const tabBody = handle.parentElement;
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const bodyRect = tabBody.getBoundingClientRect();
      const minWidth = 280;
      // Leave at least 320px for the chat pane on the left, even on
      // tiny laptop screens where 50vw might breach that.
      const maxWidth = Math.max(minWidth + 1, bodyRect.width - 320);

      handle.setPointerCapture(e.pointerId);
      handle.classList.add('gc-spec-resizer-active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev) => {
        // Dragging right shrinks the panel (its left edge moves right).
        const delta = ev.clientX - startX;
        const next = Math.max(minWidth, Math.min(maxWidth, startWidth - delta));
        panel.style.width = `${next}px`;
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        handle.classList.remove('gc-spec-resizer-active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const finalWidth = panel.getBoundingClientRect().width;
        GroupChat._writeSpecPanelWidth(finalWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  },

  // Restore the panel from localStorage on group-chat tab mount /
  // page refresh. The header paints immediately from the saved
  // {title, version}; the spec content fetches in the background
  // and replaces the body when it lands. If the request 404s (e.g.
  // the user no longer has access), we surface the same error
  // message the click-handler does — keeps the panel visible
  // instead of vanishing silently.
  async _restoreSpecPanelIfSaved(appSlug) {
    if (!appSlug) return;
    const saved = GroupChat._readSpecPanelOpen(appSlug);
    if (!saved) return;

    const { sessionId, version, title } = saved;
    const previewTitle = title || `Spec v${version}`;

    // Show the panel header right away (skeleton body) so the user
    // sees something immediately while the spec content loads.
    GroupChat._showSpecPanel({
      title: previewTitle,
      version,
      content: 'Loading…',
    });

    try {
      const resp = await fetch(`/api/sessions/${sessionId}/specs/${version}`);
      // If the user navigated away during the fetch, don't clobber
      // whatever's on screen.
      if (GroupChat.appSlug !== appSlug) return;
      if (!resp.ok) {
        GroupChat._showSpecPanel({
          title: previewTitle,
          version,
          content: resp.status === 404
            ? 'This spec is no longer available. The sharer may have deleted the session.'
            : `Failed to load spec (HTTP ${resp.status}).`,
          isError: true,
        });
        return;
      }
      const data = await resp.json();
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: data.spec.content || '(empty spec)',
        builtAt: data.spec.built_at,
        prNumber: data.spec.pr_number,
      });
    } catch (err) {
      if (GroupChat.appSlug !== appSlug) return;
      GroupChat._showSpecPanel({
        title: previewTitle,
        version,
        content: `Error: ${err.message}`,
        isError: true,
      });
    }
  },

  renderTyping() {
    GroupChat._renderStatusLine();
  },

  // Single writer for #gc-typing. Two pieces of state compete for
  // this slot: the connection-state indicator (#7 reconnect / queued
  // messages) and the typing-users line. Connection-state wins when
  // we're offline because it's actionable ("your message is waiting,
  // here's why") and a typing notice from a stale state would be
  // misleading. When connected, the typing-users line owns the slot
  // exactly as before.
  _renderStatusLine() {
    const el = document.getElementById('gc-typing');
    if (!el) return;

    const wsOpen = GroupChat.ws && GroupChat.ws.readyState === 1;
    if (!wsOpen && GroupChat.appSlug) {
      const queued = GroupChat._pendingOutgoing.length;
      el.textContent = queued > 0
        ? `Reconnecting… (${queued} queued)`
        : 'Reconnecting…';
      return;
    }

    const names = [...GroupChat.typingUsers.values()].filter((n) => n !== App.user?.username);
    if (names.length === 0) {
      el.textContent = '';
      return;
    }
    el.textContent = names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(', ')} are typing...`;
  },

  scrollToBottom() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = container.scrollTop;
  },

  // Attached after every render of the group-chat tab (the DOM element is
  // re-created each time the user switches back in). Handles:
  //   1. Load-more when the user scrolls to the top.
  //   2. Tracking `_lockedToBottom` + `_savedScrollTop` so new messages only
  //      auto-scroll when the user is already near the bottom, and the
  //      previous scroll offset is restored on tab re-entry.
  //   3. A ResizeObserver that re-pins the view to the bottom when locked
  //      and the viewport height changes under us. The vote/issue panel
  //      above the messages loads asynchronously and grows after our
  //      initial scroll-to-bottom — without this, the user sees the chat
  //      "land slightly above the bottom" every time they come back.
  attachScrollHandlers() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    GroupChat._attachSpecCardHandlers(container);
    GroupChat._attachQuoteHandlers(container);
    if (container._gcScrollBound) return;
    container._gcScrollBound = true;
    container.addEventListener('scroll', () => {
      if (container.scrollTop === 0 && GroupChat.hasMore) {
        GroupChat.loadHistory();
      }
      // 50px slack: if the user is within ~one message of the bottom we
      // still treat them as "following the conversation".
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      GroupChat._lockedToBottom = atBottom;
      GroupChat._savedScrollTop = container.scrollTop;
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (GroupChat._lockedToBottom) {
          container.scrollTop = container.scrollHeight;
        }
      });
      ro.observe(container);
      // Also watch the whole tab pane so panel height changes above the
      // messages list (e.g. vote panel finishing its async fetch) re-pin
      // the scroll position.
      const tabPane = container.closest('.flex.flex-col.h-full') || container.parentElement;
      if (tabPane) ro.observe(tabPane);
    }
  },

  restoreScroll() {
    const container = document.getElementById('gc-messages');
    if (!container) return;
    if (!GroupChat._didInitialScroll) {
      // History hasn't loaded yet for this connection — defer; loadHistory
      // will scroll to bottom itself on completion.
      return;
    }
    if (GroupChat._lockedToBottom || GroupChat._savedScrollTop == null) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = GroupChat._savedScrollTop;
    }
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Render chat content with @mention highlighting. Mentions that match the
// current viewer's username get the `-self` variant so their own mentions
// stand out more than someone else's. A second pass (#130) chips PR#N / #N
// references so they read as navigable tokens.
function renderWithMentions(raw) {
  const escaped = escapeHtml(raw || '');
  const me = (App.user?.username || '').toLowerCase();
  const withMentions = escaped.replace(/(^|[^\w])@([A-Za-z0-9_]{1,32})/g, (_m, pre, name) => {
    const isMe = name.toLowerCase() === me;
    const cls = isMe ? 'gc-mention gc-mention-self' : 'gc-mention';
    return `${pre}<span class="${cls}">@${name}</span>`;
  });
  return renderRefChips(withMentions);
}

// #130: second replacement pass over the (already escaped, mention-marked)
// content — `PR#N` / `PR #N` render as violet PR chips and bare `#N` as
// emerald issue chips. One combined regex so `PR#12` is never double-matched
// by the issue pattern. The `&` exclusion in the boundary keeps escaped
// entities from chipping; the trailing lookahead keeps `#12abc` plain.
// Clicking / Enter / Space on a chip routes to AppView.revealInDrawer (see
// _attachQuoteHandlers) — refs are a pure display convention, so message
// content stays plain text on the wire and in the DB.
function renderRefChips(html) {
  return html.replace(/(^|[^\w&])(pr ?#|#)(\d{1,7})(?!\w)/gi, (_m, pre, prefix, num) => {
    const isPr = prefix.length > 1; // `PR#` / `PR #` vs bare `#`
    const cls = isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
    const type = isPr ? 'pr' : 'issue';
    const label = isPr ? `PR#${num}` : `#${num}`;
    return `${pre}<span class="${cls}" data-ref-type="${type}" data-ref-number="${num}" role="link" tabindex="0">${label}</span>`;
  });
}

// #328: the authoritative renderer for a USER message body. Renders a safe
// markdown subset via the shared DevChat.renderMarkdown (marked + DOMPurify,
// strict allowlist, https-only links, raw HTML escaped) and then layers the
// existing @mention + PR/issue-ref decoration on top. All three message
// surfaces (main chat, thread replies, inline edit) funnel through here so
// they format identically — keep new call sites pointed at this function.
//
// Why a DOM walk and not another regex pass: renderWithMentions runs its
// regexes over *escaped text*. After markdown the body is *sanitized HTML*,
// so a string regex could match inside an <a href> attribute, inside a
// <code>/<pre> literal, or straddle a tag — reintroducing exactly the
// injection the sanitizer just removed. Instead we parse the sanitized HTML
// and walk TEXT NODES ONLY, skipping anything inside <a>/<code>/<pre>, and
// build the mention/ref <span>s via DOM APIs (textContent / setAttribute) so
// no unsanitized HTML is ever re-created. Message content stays plain
// markdown source on the wire and in the DB — this is display-only.
//
// Falls back to the plain renderWithMentions path when the markdown libs /
// DevChat aren't available (CDN blocked, native shell, the test sandbox).
function renderMessageBody(raw) {
  const text = raw == null ? '' : String(raw);
  const renderMd = typeof DevChat !== 'undefined' && DevChat.renderMarkdown;
  if (!renderMd || typeof document === 'undefined' || !document.createElement) {
    return renderWithMentions(text);
  }
  let html;
  try {
    html = DevChat.renderMarkdown(text, { breaks: true });
  } catch {
    return renderWithMentions(text);
  }
  const root = document.createElement('div');
  root.innerHTML = html;
  decorateMentionsAndRefs(root);
  return root.innerHTML;
}

// Tags whose text content must stay literal: links (don't rewrite hrefs or
// double-link), and code spans/blocks (a `@name` or `#5` in code is source,
// not a mention/ref).
const GC_DECORATE_SKIP = new Set(['A', 'CODE', 'PRE']);

// Recursively walk `node`'s subtree, decorating eligible text nodes in place.
// Snapshots childNodes first because decorateTextNode mutates the list.
function decorateMentionsAndRefs(node) {
  const children = node.childNodes ? Array.prototype.slice.call(node.childNodes) : [];
  for (const child of children) {
    if (child.nodeType === 3) { // text node
      decorateTextNode(child);
    } else if (child.nodeType === 1) { // element
      const tag = (child.tagName || '').toUpperCase();
      if (GC_DECORATE_SKIP.has(tag)) continue;
      decorateMentionsAndRefs(child);
    }
  }
}

// Replace one text node with [text, <span class="gc-mention">…</span>,
// <span class="gc-ref">…</span>, …] when it contains mentions/refs.
function decorateTextNode(textNode) {
  const value = textNode.nodeValue != null ? textNode.nodeValue : (textNode.textContent || '');
  const me = (typeof App !== 'undefined' && App.user && App.user.username
    ? App.user.username : '').toLowerCase();
  const segs = tokenizeMentionsAndRefs(value, me);
  if (segs.length === 1 && segs[0].type === 'text') return; // nothing to decorate
  const parent = textNode.parentNode;
  if (!parent) return;
  const frag = document.createDocumentFragment();
  for (const seg of segs) {
    if (seg.type === 'text') {
      frag.appendChild(document.createTextNode(seg.value));
    } else if (seg.type === 'mention') {
      const span = document.createElement('span');
      span.className = seg.isSelf ? 'gc-mention gc-mention-self' : 'gc-mention';
      span.textContent = `@${seg.name}`;
      frag.appendChild(span);
    } else { // ref
      const span = document.createElement('span');
      span.className = seg.isPr ? 'gc-ref gc-ref-pr' : 'gc-ref gc-ref-issue';
      span.setAttribute('data-ref-type', seg.isPr ? 'pr' : 'issue');
      span.setAttribute('data-ref-number', seg.num);
      span.setAttribute('role', 'link');
      span.setAttribute('tabindex', '0');
      span.textContent = seg.isPr ? `PR#${seg.num}` : `#${seg.num}`;
      frag.appendChild(span);
    }
  }
  parent.replaceChild(frag, textNode);
}

// Pure tokenizer (no DOM): split a raw text run into ordered segments of
// plain text, @mentions, and PR/issue refs. Mirrors the boundary + char-class
// rules of renderWithMentions/renderRefChips so behaviour matches the string
// path and the server-side mention parser (MENTION_CHARS, length 1..32). The
// leading boundary char each pattern requires is preserved as text. One
// combined regex so `PR#12` is never half-consumed by the bare `#N` pattern.
function tokenizeMentionsAndRefs(text, me) {
  const RE = /(^|[^\w])(@([A-Za-z0-9_]{1,32})|(pr ?#|#)(\d{1,7})(?!\w))/gi;
  const segs = [];
  let pos = 0;
  let m;
  const pushText = (s) => {
    if (!s) return;
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') last.value += s;
    else segs.push({ type: 'text', value: s });
  };
  while ((m = RE.exec(text)) !== null) {
    pushText(text.slice(pos, m.index));
    pushText(m[1]); // boundary char (start-of-string is '')
    if (m[3] != null) {
      segs.push({ type: 'mention', name: m[3], isSelf: m[3].toLowerCase() === me });
    } else {
      segs.push({ type: 'ref', isPr: m[4].trim().length > 1, num: m[5] });
    }
    pos = m.index + m[0].length;
  }
  pushText(text.slice(pos));
  if (segs.length === 0) segs.push({ type: 'text', value: '' });
  return segs;
}

// ── #87: @mention autocomplete ─────────────────────────────────────────
//
// Composer dropdown that opens when the user types `@` in #gc-input and
// suggests usernames participating in this app's chat. Self-contained:
// the only integration points are MentionAutocomplete.attach() (called
// from AppView.renderGroupChatTab when the input is (re)created) and the
// shared `escapeHtml` helper above.
//
// Matching parity is the whole game (see spec): the trigger regex and the
// inserted text MUST use the same character class the server's MENTION_RE
// (`src/services/notifications.js`) recognizes — `[A-Za-z0-9_]`, length
// 1..32, only when the `@` is preceded by a non-word char or start. A
// suggestion that inserts a string the server won't parse as a mention is
// worse than no autocomplete, so both ends derive from MENTION_CHARS.
const MentionAutocomplete = {
  // Character class shared with the server-side mention parser.
  MENTION_CHARS: 'A-Za-z0-9_',
  MAX_LEN: 32,
  // How many filtered names to keep (the menu scrolls; CSS caps the
  // visible height). Plenty for prefix-filtered participant lists.
  MAX_RESULTS: 50,
  // Cache freshness: a stale list only means a just-joined user isn't
  // suggested yet, which is fine. Re-fetch when older than this.
  CACHE_TTL_MS: 2 * 60 * 1000,

  _cacheBySlug: new Map(), // slug -> { users: [username...], fetchedAt }
  _input: null,
  _slug: null,
  _menu: null,
  _items: [],     // currently-shown usernames
  _active: -1,    // highlighted index into _items
  _open: false,
  _tokenStart: -1, // index of the `@` in input.value for the active token
  _composing: false,
  _dismissBound: null,

  get _triggerRe() {
    // Anchored to the caret: boundary (start or non-word char), `@`, then
    // up to MAX_LEN mention chars, end-of-substring.
    return new RegExp(
      `(^|[^${this.MENTION_CHARS}])@([${this.MENTION_CHARS}]{0,${this.MAX_LEN}})$`
    );
  },

  // Wire (or re-wire) the controller onto a freshly-rendered composer.
  // Idempotent per element; called on every group-chat tab mount.
  attach(input, slug) {
    if (!input) return;
    MentionAutocomplete._input = input;
    MentionAutocomplete._slug = slug;
    MentionAutocomplete._loadCandidates(slug);

    if (input._gcMentionBound) return;
    input._gcMentionBound = true;

    input.addEventListener('compositionstart', () => { MentionAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      MentionAutocomplete._composing = false;
      MentionAutocomplete._sync();
    });
    input.addEventListener('input', () => MentionAutocomplete._sync());
    input.addEventListener('click', () => MentionAutocomplete._sync());
    input.addEventListener('keyup', (e) => {
      // The keys we manage in the capture-phase keydown handler don't
      // change the token; skip re-detecting on their keyup.
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      MentionAutocomplete._sync();
    });
    // Capture phase so we win over the composer's own keydown handler and
    // the form's implicit Enter-submit while the menu is open.
    input.addEventListener('keydown', (e) => MentionAutocomplete._onKeydown(e), true);
    input.addEventListener('blur', () => {
      // Defer so a mousedown on a menu option (which we preventDefault to
      // keep focus) can run first.
      setTimeout(() => { if (document.activeElement !== input) MentionAutocomplete.close(); }, 0);
    });
  },

  async _loadCandidates(slug) {
    if (!slug) return;
    const cached = MentionAutocomplete._cacheBySlug.get(slug);
    if (cached && (Date.now() - cached.fetchedAt) < MentionAutocomplete.CACHE_TTL_MS) return;
    try {
      const res = await fetch(`/api/apps/${slug}/mention-suggestions`);
      if (!res.ok) return;
      const { users } = await res.json();
      const names = Array.isArray(users)
        ? users.map((u) => (u && u.username) || '').filter(Boolean)
        : [];
      MentionAutocomplete._cacheBySlug.set(slug, { users: names, fetchedAt: Date.now() });
      // If the user already has an open `@token` while we were fetching,
      // refresh the menu now that we have data.
      if (MentionAutocomplete._input === document.activeElement) MentionAutocomplete._sync();
    } catch { /* offline / transient — next keystroke retries via TTL */ }
  },

  _candidates() {
    const c = MentionAutocomplete._cacheBySlug.get(MentionAutocomplete._slug);
    return (c && c.users) || [];
  },

  // Detect an active mention token immediately before the caret.
  // Returns { start, query } or null.
  _detectToken() {
    const input = MentionAutocomplete._input;
    if (!input) return null;
    const caret = input.selectionStart;
    if (caret == null || caret !== input.selectionEnd) return null; // ignore ranges
    const before = input.value.slice(0, caret);
    const m = before.match(MentionAutocomplete._triggerRe);
    if (!m) return null;
    const query = m[2];
    const start = m.index + m[1].length; // index of the `@`
    return { start, query };
  },

  _filter(query) {
    const q = query.toLowerCase();
    const out = [];
    for (const name of MentionAutocomplete._candidates()) {
      if (!q || name.toLowerCase().startsWith(q)) {
        out.push(name);
        if (out.length >= MentionAutocomplete.MAX_RESULTS) break;
      }
    }
    return out;
  },

  // Re-evaluate the token under the caret and open/close/refresh the menu.
  _sync() {
    if (MentionAutocomplete._composing) return;
    const token = MentionAutocomplete._detectToken();
    if (!token) { MentionAutocomplete.close(); return; }
    const items = MentionAutocomplete._filter(token.query);
    if (!items.length) { MentionAutocomplete.close(); return; }
    MentionAutocomplete._tokenStart = token.start;
    MentionAutocomplete._items = items;
    // Keep a valid highlighted row; reset to the top when the set changes.
    MentionAutocomplete._active = 0;
    MentionAutocomplete._render();
  },

  _ensureMenu() {
    if (MentionAutocomplete._menu) return MentionAutocomplete._menu;
    const menu = document.createElement('div');
    menu.id = 'gc-mention-menu';
    menu.className = 'gc-mention-menu hidden';
    menu.setAttribute('role', 'listbox');
    // mousedown (not click) so we can preventDefault and keep the input
    // focused — a blur-then-click would close the menu before the click.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.gc-mention-option');
      if (!opt) return;
      e.preventDefault();
      MentionAutocomplete.accept(opt.dataset.username);
    });
    document.body.appendChild(menu);
    MentionAutocomplete._menu = menu;
    return menu;
  },

  _render() {
    const menu = MentionAutocomplete._ensureMenu();
    const me = (App.user?.username || '').toLowerCase();
    menu.innerHTML = MentionAutocomplete._items.map((name, i) => {
      const isMe = name.toLowerCase() === me;
      const active = i === MentionAutocomplete._active ? ' gc-mention-option-active' : '';
      return `<div class="gc-mention-option${active}" role="option" data-username="${escapeHtml(name)}" data-index="${i}">` +
        `<span class="gc-mention-option-at">@</span>${escapeHtml(name)}` +
        (isMe ? `<span class="gc-mention-option-you">you</span>` : '') +
        `</div>`;
    }).join('');

    if (!MentionAutocomplete._open) {
      menu.classList.remove('hidden');
      MentionAutocomplete._open = true;
      MentionAutocomplete._bindDismiss();
    }
    MentionAutocomplete._position();
  },

  // Anchor above the composer (input lives at the bottom of the pane),
  // flipping below if it would clip the top. Matches the input width.
  _position() {
    const input = MentionAutocomplete._input;
    const menu = MentionAutocomplete._menu;
    if (!input || !menu) return;
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    const h = menu.offsetHeight || 0;
    let top = r.top - h - 4;
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
    menu.style.top = `${top}px`;
  },

  _bindDismiss() {
    if (MentionAutocomplete._dismissBound) return;
    MentionAutocomplete._dismissBound = (e) => {
      if (e.type === 'scroll') { MentionAutocomplete.close(); return; }
      if (MentionAutocomplete._menu && MentionAutocomplete._menu.contains(e.target)) return;
      if (e.target === MentionAutocomplete._input) return;
      MentionAutocomplete.close();
    };
    document.addEventListener('mousedown', MentionAutocomplete._dismissBound, true);
    const msgs = document.getElementById('gc-messages');
    if (msgs) msgs.addEventListener('scroll', MentionAutocomplete._dismissBound, true);
  },

  close() {
    if (!MentionAutocomplete._open) return;
    MentionAutocomplete._open = false;
    MentionAutocomplete._active = -1;
    MentionAutocomplete._items = [];
    MentionAutocomplete._tokenStart = -1;
    if (MentionAutocomplete._menu) {
      MentionAutocomplete._menu.classList.add('hidden');
      MentionAutocomplete._menu.innerHTML = '';
    }
    if (MentionAutocomplete._dismissBound) {
      document.removeEventListener('mousedown', MentionAutocomplete._dismissBound, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', MentionAutocomplete._dismissBound, true);
      MentionAutocomplete._dismissBound = null;
    }
  },

  _move(delta) {
    const n = MentionAutocomplete._items.length;
    if (!n) return;
    MentionAutocomplete._active = (MentionAutocomplete._active + delta + n) % n;
    const menu = MentionAutocomplete._menu;
    if (!menu) return;
    menu.querySelectorAll('.gc-mention-option').forEach((el, i) => {
      el.classList.toggle('gc-mention-option-active', i === MentionAutocomplete._active);
      if (i === MentionAutocomplete._active) el.scrollIntoView({ block: 'nearest' });
    });
  },

  // Capture-phase keydown. Consumes the event (preventing the composer's
  // own handler + the form's Enter-submit) only when the menu is open and
  // the key is one we own.
  _onKeydown(e) {
    if (!MentionAutocomplete._open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete._move(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete._move(-1); break;
      case 'Enter':
      case 'Tab': {
        const name = MentionAutocomplete._items[MentionAutocomplete._active];
        if (name) {
          e.preventDefault(); e.stopPropagation();
          MentionAutocomplete.accept(name);
        }
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); MentionAutocomplete.close(); break;
      default:
        break;
    }
  },

  // Replace the active `@token` with `@username ` (trailing space), keep
  // within maxlength, restore the caret, and fire a synthetic `input`
  // event so the composer's own handlers (draft persistence + typing
  // indicator) run exactly as if the user typed it.
  accept(username) {
    const input = MentionAutocomplete._input;
    if (!input || !username || MentionAutocomplete._tokenStart < 0) { MentionAutocomplete.close(); return; }
    const caret = input.selectionStart;
    const value = input.value;
    const before = value.slice(0, MentionAutocomplete._tokenStart);
    const after = value.slice(caret);
    const insert = `@${username} `;
    const next = before + insert + after;

    const max = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (max && next.length > max) {
      // Wouldn't fit — leave the user's text untouched rather than
      // silently truncating their message.
      MentionAutocomplete.close();
      return;
    }

    input.value = next;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    MentionAutocomplete.close();
    input.focus();
    // Run the existing #gc-input `input` listener (draft save + sendTyping).
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

// ── #130: PR / issue reference autocomplete ─────────────────────────────
//
// Composer dropdown that opens when the user types `PR#` (open PRs only)
// or a bare `#` (open issues first, then open PRs) in #gc-input. Modeled
// directly on MentionAutocomplete above: same menu element pattern,
// capture-phase keydown, _detectToken/_sync/accept lifecycle, blur/dismiss
// handling, and positioning anchored above the composer. Candidates come
// from the endpoints the activity panel already uses (/promoted +
// /github-issues) — no new API.
//
// Unlike @mentions there is no server-side parser to stay in sync with:
// refs are a pure display convention (renderRefChips above), so the only
// contract is that accept() inserts the canonical `PR#N` / `#N` forms the
// renderer chips. Selecting a PR from the bare-`#` combined menu inserts
// the canonical `PR#N`, not `#N`.
const RefAutocomplete = {
  MAX_RESULTS: 50,
  // Stale list only means a just-opened PR/issue isn't suggested for a
  // couple of minutes (the issues endpoint is itself cached server-side
  // for 5) — users can still type the number manually and it chips fine.
  CACHE_TTL_MS: 2 * 60 * 1000,

  _cacheBySlug: new Map(), // slug -> { prs: [...], issues: [...], fetchedAt }
  _input: null,
  _slug: null,
  _menu: null,
  _items: [],      // currently-shown { number, title, kind: 'pr'|'issue' }
  _active: -1,
  _open: false,
  _tokenStart: -1, // index of the token start (the `P` or `#`) in input.value
  _composing: false,
  _dismissBound: null,

  // Anchored at the caret: boundary (start or non-word, non-& char), then
  // `PR#` / `PR #` (PR mode) or bare `#` (combined mode), then a
  // digits-only query, end of substring. Typing a non-digit after the `#`
  // stops matching and the menu closes. The `&` exclusion mirrors
  // renderRefChips' boundary so the dropdown never triggers where the
  // renderer wouldn't chip. The `@` vs `#` triggers are mutually exclusive
  // at one caret position, so this menu and MentionAutocomplete's can't
  // both be open at once.
  _triggerRe: /(^|[^\w&])(pr ?#|#)(\d{0,7})$/i,

  // Wire (or re-wire) the controller onto a freshly-rendered composer.
  // Idempotent per element; called on every group-chat tab mount. Kicks
  // off the candidate load so the list is warm by the first keystroke.
  attach(input, slug) {
    if (!input) return;
    RefAutocomplete._input = input;
    RefAutocomplete._slug = slug;
    RefAutocomplete._loadCandidates(slug);

    if (input._gcRefBound) return;
    input._gcRefBound = true;

    input.addEventListener('compositionstart', () => { RefAutocomplete._composing = true; });
    input.addEventListener('compositionend', () => {
      RefAutocomplete._composing = false;
      RefAutocomplete._sync();
    });
    input.addEventListener('input', () => RefAutocomplete._sync());
    input.addEventListener('click', () => RefAutocomplete._sync());
    input.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
      RefAutocomplete._sync();
    });
    // Capture phase so we win over the composer's own keydown handler and
    // the form's implicit Enter-submit while the menu is open. Only
    // consumes keys while this menu is open, so it can't fight
    // MentionAutocomplete's identical handler.
    input.addEventListener('keydown', (e) => RefAutocomplete._onKeydown(e), true);
    input.addEventListener('blur', () => {
      setTimeout(() => { if (document.activeElement !== input) RefAutocomplete.close(); }, 0);
    });
  },

  async _loadCandidates(slug) {
    if (!slug) return;
    const cached = RefAutocomplete._cacheBySlug.get(slug);
    if (cached && (Date.now() - cached.fetchedAt) < RefAutocomplete.CACHE_TTL_MS) return;
    try {
      const [prRes, issueRes] = await Promise.all([
        fetch(`/api/apps/${slug}/promoted`),
        fetch(`/api/apps/${slug}/github-issues`),
      ]);
      const prData = prRes.ok ? await prRes.json() : {};
      const issueData = issueRes.ok ? await issueRes.json() : {};
      // Open (promoted/merging) PRs — the same set the drawer's "Open PRs"
      // section shows. Merged PRs are intentionally not suggested; they're
      // still clickable once rendered as chips.
      const prs = (Array.isArray(prData.promoted) ? prData.promoted : [])
        .filter((pr) => pr.pr_number != null)
        .map((pr) => ({ number: pr.pr_number, title: pr.pr_title || `by ${pr.username || ''}`, kind: 'pr' }));
      const issues = (Array.isArray(issueData.issues) ? issueData.issues : [])
        .map((i) => ({ number: i.number, title: i.title || '', kind: 'issue' }));
      RefAutocomplete._cacheBySlug.set(slug, { prs, issues, fetchedAt: Date.now() });
      // If the user already has an open token while we were fetching,
      // refresh the menu now that we have data.
      if (RefAutocomplete._input === document.activeElement) RefAutocomplete._sync();
    } catch { /* offline / transient — next keystroke retries via TTL */ }
  },

  // Detect an active ref token immediately before the caret.
  // Returns { start, query, mode: 'pr'|'combined' } or null.
  _detectToken() {
    const input = RefAutocomplete._input;
    if (!input) return null;
    const caret = input.selectionStart;
    if (caret == null || caret !== input.selectionEnd) return null; // ignore ranges
    const before = input.value.slice(0, caret);
    const m = before.match(RefAutocomplete._triggerRe);
    if (!m) return null;
    return {
      start: m.index + m[1].length,
      query: m[3],
      mode: m[2].length > 1 ? 'pr' : 'combined',
    };
  },

  // Prefix-match on the stringified number ("1" matches #1, #12, #130).
  // Combined mode lists the issues block first, then PRs.
  _filter(query, mode) {
    const c = RefAutocomplete._cacheBySlug.get(RefAutocomplete._slug) || {};
    const pool = mode === 'pr'
      ? (c.prs || [])
      : [...(c.issues || []), ...(c.prs || [])];
    const out = [];
    for (const item of pool) {
      if (!query || String(item.number).startsWith(query)) {
        out.push(item);
        if (out.length >= RefAutocomplete.MAX_RESULTS) break;
      }
    }
    return out;
  },

  // Re-evaluate the token under the caret and open/close/refresh the menu.
  _sync() {
    if (RefAutocomplete._composing) return;
    const token = RefAutocomplete._detectToken();
    if (!token) { RefAutocomplete.close(); return; }
    const items = RefAutocomplete._filter(token.query, token.mode);
    if (!items.length) { RefAutocomplete.close(); return; }
    RefAutocomplete._tokenStart = token.start;
    RefAutocomplete._items = items;
    RefAutocomplete._active = 0;
    RefAutocomplete._render();
  },

  _ensureMenu() {
    if (RefAutocomplete._menu) return RefAutocomplete._menu;
    const menu = document.createElement('div');
    menu.id = 'gc-ref-menu';
    // Reuse the mention menu/option styling so positioning + theming come
    // for free; gc-ref-option only widens the row gap for the badge.
    menu.className = 'gc-mention-menu hidden';
    menu.setAttribute('role', 'listbox');
    // mousedown (not click) so we can preventDefault and keep the input
    // focused — a blur-then-click would close the menu before the click.
    menu.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.gc-mention-option');
      if (!opt) return;
      e.preventDefault();
      RefAutocomplete.accept(opt.dataset.kind, opt.dataset.number);
    });
    document.body.appendChild(menu);
    RefAutocomplete._menu = menu;
    return menu;
  },

  _render() {
    const menu = RefAutocomplete._ensureMenu();
    menu.innerHTML = RefAutocomplete._items.map((item, i) => {
      const active = i === RefAutocomplete._active ? ' gc-mention-option-active' : '';
      // The badge reuses the message-chip classes so the dropdown teaches
      // the rendering: violet PR#N, emerald #N.
      const badge = item.kind === 'pr'
        ? `<span class="gc-ref gc-ref-pr">PR#${item.number}</span>`
        : `<span class="gc-ref gc-ref-issue">#${item.number}</span>`;
      return `<div class="gc-mention-option gc-ref-option${active}" role="option" data-kind="${item.kind}" data-number="${item.number}" data-index="${i}">`
        + badge
        + `<span class="gc-ref-option-title">${escapeHtml(item.title || '')}</span>`
        + `</div>`;
    }).join('');

    if (!RefAutocomplete._open) {
      menu.classList.remove('hidden');
      RefAutocomplete._open = true;
      RefAutocomplete._bindDismiss();
    }
    RefAutocomplete._position();
  },

  // Anchor above the composer, flipping below if it would clip the top.
  // Matches the input width — same mechanics as MentionAutocomplete.
  _position() {
    const input = RefAutocomplete._input;
    const menu = RefAutocomplete._menu;
    if (!input || !menu) return;
    const r = input.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.width = `${r.width}px`;
    const h = menu.offsetHeight || 0;
    let top = r.top - h - 4;
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
    menu.style.top = `${top}px`;
  },

  _bindDismiss() {
    if (RefAutocomplete._dismissBound) return;
    RefAutocomplete._dismissBound = (e) => {
      if (e.type === 'scroll') { RefAutocomplete.close(); return; }
      if (RefAutocomplete._menu && RefAutocomplete._menu.contains(e.target)) return;
      if (e.target === RefAutocomplete._input) return;
      RefAutocomplete.close();
    };
    document.addEventListener('mousedown', RefAutocomplete._dismissBound, true);
    const msgs = document.getElementById('gc-messages');
    if (msgs) msgs.addEventListener('scroll', RefAutocomplete._dismissBound, true);
  },

  close() {
    if (!RefAutocomplete._open) return;
    RefAutocomplete._open = false;
    RefAutocomplete._active = -1;
    RefAutocomplete._items = [];
    RefAutocomplete._tokenStart = -1;
    if (RefAutocomplete._menu) {
      RefAutocomplete._menu.classList.add('hidden');
      RefAutocomplete._menu.innerHTML = '';
    }
    if (RefAutocomplete._dismissBound) {
      document.removeEventListener('mousedown', RefAutocomplete._dismissBound, true);
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.removeEventListener('scroll', RefAutocomplete._dismissBound, true);
      RefAutocomplete._dismissBound = null;
    }
  },

  _move(delta) {
    const n = RefAutocomplete._items.length;
    if (!n) return;
    RefAutocomplete._active = (RefAutocomplete._active + delta + n) % n;
    const menu = RefAutocomplete._menu;
    if (!menu) return;
    menu.querySelectorAll('.gc-mention-option').forEach((el, i) => {
      el.classList.toggle('gc-mention-option-active', i === RefAutocomplete._active);
      if (i === RefAutocomplete._active) el.scrollIntoView({ block: 'nearest' });
    });
  },

  // Capture-phase keydown. Consumes the event only when the menu is open
  // and the key is one we own.
  _onKeydown(e) {
    if (!RefAutocomplete._open) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete._move(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete._move(-1); break;
      case 'Enter':
      case 'Tab': {
        const item = RefAutocomplete._items[RefAutocomplete._active];
        if (item) {
          e.preventDefault(); e.stopPropagation();
          RefAutocomplete.accept(item.kind, item.number);
        }
        break;
      }
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); RefAutocomplete.close(); break;
      default:
        break;
    }
  },

  // Replace the active token with the canonical form — `PR#N ` for a PR,
  // `#N ` for an issue (trailing space) — keep within maxlength, restore
  // the caret, and fire a synthetic `input` event so draft persistence and
  // the typing indicator run exactly as if the user typed it.
  accept(kind, number) {
    const input = RefAutocomplete._input;
    if (!input || !number || RefAutocomplete._tokenStart < 0) { RefAutocomplete.close(); return; }
    const caret = input.selectionStart;
    const value = input.value;
    const before = value.slice(0, RefAutocomplete._tokenStart);
    const after = value.slice(caret);
    const insert = kind === 'pr' ? `PR#${number} ` : `#${number} `;
    const next = before + insert + after;

    const max = parseInt(input.getAttribute('maxlength') || '0', 10);
    if (max && next.length > max) {
      // Wouldn't fit — leave the user's text untouched rather than
      // silently truncating their message.
      RefAutocomplete.close();
      return;
    }

    input.value = next;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    RefAutocomplete.close();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

// Expose on window so app.js's WS dispatcher can reconcile the in-chat
// unread dots on notification events. (A top-level `const` is a lexical
// global accessible by bare name within the realm, but is NOT a property
// of `window` — mirror the `window.Notifications` pattern explicitly.)
window.GroupChat = GroupChat;
window.MentionAutocomplete = MentionAutocomplete;
window.RefAutocomplete = RefAutocomplete;
