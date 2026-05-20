// Top-right notifications dropdown.
//
// Lifecycle:
//  - init() wires the bell button + dropdown controls, does the initial
//    /api/notifications fetch (so the badge is correct on page load even
//    if all pending notifs were queued while the user was offline).
//  - handleIncoming() is called by app.js when a `notification_new`
//    WS event arrives — updates the in-memory list, badge, and dropdown
//    if open.
//  - clicking an item navigates to the app's group-chat tab and marks
//    that one read.

const Notifications = {
  items: [],   // newest-first
  unread: 0,
  open: false,
  MAX: 30,

  init() {
    const btn = document.getElementById('notifications-btn');
    if (btn) btn.addEventListener('click', Notifications.toggle);

    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.addEventListener('click', Notifications.markAllRead);

    // Dismiss on outside click.
    document.addEventListener('click', (e) => {
      if (!Notifications.open) return;
      const panel = document.getElementById('notifications-panel');
      const btnEl = document.getElementById('notifications-btn');
      if (!panel || !btnEl) return;
      if (panel.contains(e.target) || btnEl.contains(e.target)) return;
      Notifications.hide();
    });

    Notifications.refresh();
  },

  async refresh() {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const data = await res.json();
      Notifications.items = Array.isArray(data.notifications) ? data.notifications : [];
      Notifications.unread = data.unread || 0;
      Notifications._renderBadge();
      if (Notifications.open) Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] refresh failed', err);
    }
  },

  handleIncoming(notif) {
    if (!notif) return;
    // Dedup on id — a reconnect might replay the same notification that
    // /api/notifications already returned.
    const existing = Notifications.items.findIndex((n) => n.id === notif.id);
    if (existing >= 0) {
      Notifications.items[existing] = notif;
    } else {
      Notifications.items.unshift(notif);
      if (Notifications.items.length > Notifications.MAX) {
        Notifications.items.length = Notifications.MAX;
      }
    }
    if (!notif.readAt) Notifications.unread += 1;
    Notifications._renderBadge();
    if (Notifications.open) Notifications._renderList();

    // Title prefix update happens via _renderBadge above — gives the
    // tab a visible unread count even when the dropdown is closed.
  },

  toggle() {
    if (Notifications.open) Notifications.hide();
    else Notifications.show();
  },

  show() {
    const panel = document.getElementById('notifications-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    Notifications.open = true;
    Notifications._renderList();
  },

  hide() {
    const panel = document.getElementById('notifications-panel');
    if (!panel) return;
    panel.classList.add('hidden');
    Notifications.open = false;
  },

  async markAllRead() {
    if (Notifications.unread === 0) return;
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) return;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      const now = new Date().toISOString();
      Notifications.items = Notifications.items.map((n) => ({
        ...n,
        readAt: n.readAt || now,
      }));
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markAllRead failed', err);
    }
  },

  async _markOneRead(id) {
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      const item = Notifications.items.find((n) => n.id === id);
      if (item && !item.readAt) item.readAt = new Date().toISOString();
      Notifications._renderBadge();
    } catch (err) {
      console.warn('[notifications] markOneRead failed', err);
    }
  },

  _onItemClick(id) {
    const item = Notifications.items.find((n) => n.id === id);
    if (!item) return;
    Notifications.hide();
    Notifications._markOneRead(id);
    if (item.appSlug) {
      // Both mention and kudos notifications land on the app's group
      // chat. Mentions originate there; kudos's PR is rendered in the
      // group-chat tab's vote panel (Open PRs / Merged), where the
      // user can scroll to it and reciprocate if they want.
      window.location.hash = `#app/${item.appSlug}/group-chat`;
    }
  },

  _renderBadge() {
    const badge = document.getElementById('notifications-badge');
    if (!badge) return;
    if (Notifications.unread > 0) {
      badge.textContent = Notifications.unread > 99 ? '99+' : String(Notifications.unread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.disabled = Notifications.unread === 0;
    Notifications._updateTitle();
  },

  _updateTitle() {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    if (Notifications.unread > 0) document.title = `(${Notifications.unread}) ${base}`;
    else document.title = base;
  },

  _renderList() {
    const list = document.getElementById('notifications-list');
    const empty = document.getElementById('notifications-empty');
    if (!list || !empty) return;
    if (Notifications.items.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = Notifications.items.map((n) => renderRow(n)).join('');
    list.querySelectorAll('[data-notif-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-notif-id'));
      el.addEventListener('click', () => Notifications._onItemClick(id));
    });
  },

};

function renderRow(n) {
  const unreadCls = n.readAt ? '' : 'bg-violet-500/5 border-l-2 border-violet-500';
  const appLine = n.appName ? escapeHtml(n.appName) : 'app';
  const who = n.sourceUsername ? escapeHtml(n.sourceUsername) : 'someone';

  // Kudos rows have no chat-message body; they show the PR title (or
  // "PR #N" if the PR has no LLM-generated title yet) and a small 👏
  // icon to distinguish from mention rows at a glance.
  if (n.kind === 'kudos') {
    const prLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.prNumber ? `PR #${n.prNumber}` : 'your PR');
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1">
        <span aria-hidden="true">\u{1F44F}</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>gave kudos to your PR in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${prLabel}</div>
    </button>`;
  }

  const snippet = (n.messageContent || '').slice(0, 140);
  const kindText = n.kind === 'mention' ? 'mentioned you in' : 'in';
  return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
    <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
      <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
      ${kindText}
      <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
      <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
    </div>
    <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">${renderMentionSnippet(snippet)}</div>
  </button>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Highlight @tokens inline even in the notification preview so context
// matches what the user will see when they click through.
function renderMentionSnippet(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(^|[^\w])@([A-Za-z0-9_]{1,32})/g, (_m, pre, name) => {
    return `${pre}<span class="text-violet-400 font-medium">@${name}</span>`;
  });
}

function relativeTime(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

window.Notifications = Notifications;

document.addEventListener('DOMContentLoaded', () => Notifications.init());
