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

    if (GroupChat.appSlug === appSlug && GroupChat.ws) {
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

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    GroupChat.ws = new WebSocket(`${proto}//${location.host}/ws/chat/${appSlug}`);

    GroupChat.ws.onopen = () => {
      GroupChat.loadHistory();
    };

    GroupChat.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        GroupChat.handleIncoming(msg);
      } catch {}
    };

    GroupChat.ws.onclose = () => {
      setTimeout(() => {
        if (GroupChat.appSlug === appSlug && App.currentTab === 'group-chat') {
          GroupChat.connect(appSlug);
        }
      }, 3000);
    };

    GroupChat.attachScrollHandlers();
  },

  disconnect() {
    if (GroupChat.ws) {
      GroupChat.ws.onclose = null;
      GroupChat.ws.close();
      GroupChat.ws = null;
    }
    GroupChat.appSlug = null;
    GroupChat.typingUsers.clear();
    GroupChat._lockedToBottom = true;
    GroupChat._savedScrollTop = null;
    GroupChat._didInitialScroll = false;
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

  send(content) {
    if (!GroupChat.ws || GroupChat.ws.readyState !== 1) return;
    GroupChat.ws.send(JSON.stringify({ type: 'chat', content }));
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
      return `<div class="gc-msg-system ${isVote ? 'gc-msg-vote' : ''}">${escapeHtml(msg.content)}</div>`;
    }

    return `
      <div class="gc-msg ${isSelf ? 'gc-msg-self' : ''}">
        <div class="gc-msg-header">
          <span class="gc-msg-username ${isSelf ? 'gc-msg-username-self' : ''}">${escapeHtml(username)}</span>
          <span class="gc-msg-time">${time}</span>
        </div>
        <div class="gc-msg-content">${renderWithMentions(msg.content)}</div>
      </div>`;
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
      <div class="gc-spec-card" data-msg-id="${msg.id || ''}" data-spec-title="${escapeHtml(titleAttr)}">
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
    const el = document.getElementById('gc-typing');
    if (!el) return;
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
