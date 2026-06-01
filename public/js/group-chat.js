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
  //                        2000-char-per-message * 50 ceiling is
  //                        ~100KB which is fine to hold in RAM).
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
  _reactBar: null,
  _reactBarDismiss: null,
  _reactBarOpenedAt: 0,
  QUICK_REACTIONS: ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'],
  GRID_REACTIONS: [
    '\u{1F44D}', '\u{1F44E}', '\u2764\uFE0F', '\u{1F525}', '\u{1F389}', '\u{1F44F}',
    '\u{1F602}', '\u{1F923}', '\u{1F60A}', '\u{1F60D}', '\u{1F60E}', '\u{1F914}',
    '\u{1F62E}', '\u{1F632}', '\u{1F622}', '\u{1F62D}', '\u{1F621}', '\u{1F644}',
    '\u{1F64F}', '\u{1F4AF}', '\u{1F680}', '\u{1F44C}', '\u{1F440}', '\u{1F9E0}',
    '\u{1F389}', '\u2705', '\u274C', '\u26A0\uFE0F', '\u{1F41B}', '\u{1F4A1}',
    '\u{1F44B}', '\u{1F913}', '\u{1F525}', '\u{1F31F}', '\u{1F926}', '\u{1F937}',
  ],

  // In-progress draft helpers — preserved across tab switches *and* page
  // refreshes (via localStorage). Keyed by app slug so each app has its
  // own draft. Cleared on send.
  _draftKey(slug) {
    return `usernode:gc-draft:${slug}`;
  },
  getDraft(slug) {
    if (!slug) return '';
    try { return localStorage.getItem(GroupChat._draftKey(slug)) || ''; }
    catch { return ''; }
  },
  setDraft(slug, value) {
    if (!slug) return;
    try {
      if (value) localStorage.setItem(GroupChat._draftKey(slug), value);
      else localStorage.removeItem(GroupChat._draftKey(slug));
    } catch {}
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
    GroupChat.oldestMessageId = null;
    GroupChat.hasMore = true;
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
    GroupChat._reconnectAttempts = 0;
    GroupChat.replyDraft = null;
    GroupChat._longPressed = false;
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
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${appSlug}`);
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

    ws.onclose = () => {
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
      case 'typing': {
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
  send(content) {
    // #15: consume the pending reply quote (if any) for this message and
    // clear it so it only attaches once. We send a minimal reference; the
    // server re-derives author/snippet from the source row.
    const quote = GroupChat.replyDraft;
    GroupChat.replyDraft = null;
    GroupChat._renderQuotePreview();
    const payload = { type: 'chat', content };
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

  sendTyping() {
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    if (GroupChat.typingTimeout) return;
    GroupChat.ws.send(JSON.stringify({ type: 'typing' }));
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

  // ── #15: reply / quote ──────────────────────────────────────────────

  // Stage a quote to attach to the next message and focus the composer.
  // Called by the tap handler (chat rows) and by AppView (PR titles).
  setQuote(quote) {
    if (!quote) return;
    GroupChat.replyDraft = quote;
    GroupChat._renderQuotePreview();
    const input = document.getElementById('gc-input');
    if (input) input.focus();
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

  // Render (or clear) the composer's "Replying to …" preview chip.
  _renderQuotePreview() {
    const el = document.getElementById('gc-reply-preview');
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
    const snippet = (q.snippet || '').slice(0, 120);
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
      return { source: 'event', refMsgId: id, author: null, snippet: text.trim() };
    }
    const body = row.querySelector('.gc-msg-content');
    return {
      source: 'message', refMsgId: id,
      author: row.dataset.username || null,
      snippet: (body ? body.textContent : '').trim(),
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
    const container = document.getElementById('gc-messages');
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
      GroupChat._clearPressTimer();
      // Don't arm long-press on interactive children (links, buttons,
      // pills, the quote block) — those have their own click semantics.
      if (e.target.closest('a, button, .gc-quoted')) return;
      const row = e.target.closest(ROW_SEL);
      if (!row || !container.contains(row)) return;
      GroupChat._pressTimer = setTimeout(() => {
        GroupChat._pressTimer = null;
        GroupChat._longPressed = true;
        GroupChat._openReactionBar(row);
      }, 450);
    }, true);

    const cancelPress = (e) => {
      if (!GroupChat._pressTimer) return;
      if (e && GroupChat._tap &&
          Math.abs(e.clientX - GroupChat._tap.x) + Math.abs(e.clientY - GroupChat._tap.y) <= 8 &&
          e.type === 'pointermove') {
        return; // tiny jitter — keep the timer alive
      }
      GroupChat._clearPressTimer();
    };
    container.addEventListener('pointermove', cancelPress, true);
    container.addEventListener('pointerup', () => GroupChat._clearPressTimer(), true);
    container.addEventListener('pointercancel', () => GroupChat._clearPressTimer(), true);

    container.addEventListener('click', (e) => {
      // Reaction pill → toggle that emoji for the viewer.
      const pill = e.target.closest('.gc-react-pill');
      if (pill) {
        const row = pill.closest('[data-msg-id]');
        const id = row && parseInt(row.dataset.msgId || '', 10);
        if (id) GroupChat.sendReact(id, pill.dataset.emoji);
        return;
      }
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
      const quoted = e.target.closest('.gc-quoted');
      if (quoted) { GroupChat._handleQuotedClick(quoted); return; }
      // Real links/buttons (PR link, "View full spec", mentions) win.
      if (e.target.closest('a, button')) return;
      if (!GroupChat._isCleanTap(e)) return;
      const row = e.target.closest(ROW_SEL);
      if (!row || !container.contains(row)) return;
      const quote = GroupChat._quoteFromRow(row);
      if (quote) GroupChat.setQuote(quote);
    });
  },

  _clearPressTimer() {
    if (GroupChat._pressTimer) {
      clearTimeout(GroupChat._pressTimer);
      GroupChat._pressTimer = null;
    }
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
    return `<button class="gc-react-add" title="React" aria-label="Add reaction" tabindex="-1">\u{1F642}</button>`;
  },

  // Apply a fresh reaction aggregate (from the WS 'reaction' broadcast or
  // history) to a message — update state + patch just its pill row.
  _updateMessageReactions(messageId, reactions) {
    const msg = GroupChat.messages.find((m) => String(m.id) === String(messageId));
    if (msg) msg.reactions = reactions || [];
    const el = document.getElementById(`gc-react-${messageId}`);
    if (el) el.innerHTML = GroupChat._renderReactionPills(msg || { reactions: reactions || [] });
  },

  // Toggle an emoji on a message for the current user (server decides
  // add-vs-remove). Fire-and-forget over the chat socket; the authoritative
  // aggregate comes back via the 'reaction' broadcast.
  sendReact(messageId, emoji) {
    if (!messageId || !emoji) return;
    if (GroupChat.ws && GroupChat.ws.readyState === 1) {
      GroupChat.ws.send(JSON.stringify({ type: 'react', messageId, emoji }));
    }
    GroupChat._closeReactionBar();
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
      `</div>` +
      `<div class="gc-react-bar-grid hidden">${grid}</div>`;
    bar.addEventListener('click', (e) => {
      const em = e.target.closest('.gc-react-bar-emoji');
      if (em) { GroupChat._reactFromBar(em.dataset.emoji); return; }
      if (e.target.closest('.gc-react-bar-more')) {
        bar.querySelector('.gc-react-bar-grid').classList.toggle('hidden');
      }
    });
    document.body.appendChild(bar);
    GroupChat._reactBar = bar;
    return bar;
  },

  _openReactionBar(row) {
    const id = row && parseInt(row.dataset.msgId || '', 10);
    if (!id) return;
    const bar = GroupChat._ensureReactionBar();
    bar.dataset.msgId = String(id);
    bar.querySelector('.gc-react-bar-grid').classList.add('hidden');
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
      const msgs = document.getElementById('gc-messages');
      if (msgs) msgs.addEventListener('scroll', GroupChat._reactBarDismiss, true);
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
    }
  },

  _reactFromBar(emoji) {
    const bar = GroupChat._reactBar;
    const id = bar && parseInt(bar.dataset.msgId || '', 10);
    if (id && emoji) GroupChat.sendReact(id, emoji);
    GroupChat._closeReactionBar();
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
      return `<div class="gc-msg-system ${isVote ? 'gc-msg-vote' : ''}" data-msg-id="${msg.id || ''}">` +
        `<span class="gc-msg-system-text">${escapeHtml(msg.content)}</span>` +
        GroupChat._renderReactAddBtn(msg) +
        GroupChat._renderReactionsHtml(msg) +
        `</div>`;
    }

    // #15: a user message may carry a quote (reply) in metadata. Render the
    // quoted block above the content; data-msg-id lets a reply elsewhere
    // scroll back to this row. #25: reactions + the hover react button.
    const quotedHtml = GroupChat._renderQuotedBlock(msg.metadata || msg.meta);
    return `
      <div class="gc-msg ${isSelf ? 'gc-msg-self' : ''}" data-msg-id="${msg.id || ''}" data-username="${escapeHtml(username)}">
        <div class="gc-msg-header">
          <span class="gc-msg-username ${isSelf ? 'gc-msg-username-self' : ''}">${escapeHtml(username)}</span>
          <span class="gc-msg-time">${time}</span>
        </div>
        ${quotedHtml}
        <div class="gc-msg-content">${renderWithMentions(msg.content)}</div>
        ${GroupChat._renderReactionsHtml(msg)}
        ${GroupChat._renderReactAddBtn(msg)}
      </div>`;
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
    const snippet = escapeHtml((q.snippet || '').slice(0, 160));
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
// stand out more than someone else's.
function renderWithMentions(raw) {
  const escaped = escapeHtml(raw || '');
  const me = (App.user?.username || '').toLowerCase();
  return escaped.replace(/(^|[^\w])@([A-Za-z0-9_]{1,32})/g, (_m, pre, name) => {
    const isMe = name.toLowerCase() === me;
    const cls = isMe ? 'gc-mention gc-mention-self' : 'gc-mention';
    return `${pre}<span class="${cls}">@${name}</span>`;
  });
}
