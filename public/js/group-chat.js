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
    const isSelf = msg.userId === App.user?.id || msg.user_id === App.user?.id;

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
    if (!container || container._gcScrollBound) return;
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
