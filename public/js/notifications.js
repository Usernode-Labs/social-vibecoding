// Top-right notifications dropdown.
//
// Lifecycle:
//  - init() wires the bell button + dropdown controls, does the initial
//    /api/notifications fetch (so the badge is correct on page load even
//    if all pending notifs were queued while the user was offline).
//  - handleIncoming() is called by app.js when a `notification_new`
//    WS event arrives — updates the in-memory list, badge, and dropdown
//    if open.
//  - clicking a leaf item navigates to the app's group-chat tab and
//    marks that one read.
//
// #84 grouping: `items` stays the single newest-first source of truth.
// The dropdown renders a PURE TRANSFORM of it (_groupByApp) — one
// collapsed header row per app with a count + latest-notification
// preview, expandable to reveal the per-kind leaf rows. Single-item
// apps render as a plain leaf row (no group chrome). Expansion state is
// persisted to localStorage and survives refreshes. Scrolling near the
// bottom loads older pages via the keyset cursor (nextBefore/hasMore).

const EXPANDED_STORAGE_KEY = 'notif_expanded_groups_v1';
// Per-expanded-group leaf cap — initial number of leaves shown for an
// expanded group, and the increment for each inline "Show more" click.
// Beyond this the group renders an inline pagination button that reveals
// the next page of already-loaded leaves in place (no navigation away).
const GROUP_LEAF_CAP = 10;
// How close to the bottom (px) before we prefetch the next page.
const LOAD_MORE_THRESHOLD = 64;

const Notifications = {
  items: [],   // newest-first; the single source of truth
  unread: 0,
  open: false,
  // Pagination cursor for scroll-to-load-more.
  nextBefore: null,  // { createdAt, id } | null
  hasMore: false,
  loading: false,
  // Set<string> of expanded group keys (appId as string, or 'general').
  expanded: new Set(),
  // Map<string, number> of group key -> how many leaves to reveal for
  // that group. Ephemeral (not persisted): resets on reload so the
  // drawer opens compact. An absent key means the default GROUP_LEAF_CAP.
  revealed: new Map(),
  _scrollWired: false,

  init() {
    Notifications._loadExpanded();

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

    Notifications._wireScroll();
    Notifications.refresh();
  },

  // --- expansion persistence -------------------------------------------

  _loadExpanded() {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      Notifications.expanded = new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      Notifications.expanded = new Set();
    }
  },

  _saveExpanded() {
    try {
      localStorage.setItem(
        EXPANDED_STORAGE_KEY,
        JSON.stringify([...Notifications.expanded])
      );
    } catch { /* storage may be unavailable; non-fatal */ }
  },

  // Drop persisted expansion entries for apps that no longer have any
  // notifications, so the store doesn't grow unbounded over time.
  _pruneExpanded(liveKeys) {
    let changed = false;
    for (const key of [...Notifications.expanded]) {
      if (!liveKeys.has(key)) {
        Notifications.expanded.delete(key);
        changed = true;
      }
    }
    if (changed) Notifications._saveExpanded();
    // Reveal counts are ephemeral, but still drop entries for apps with
    // no notifications so the map doesn't grow unbounded over a session.
    for (const key of [...Notifications.revealed.keys()]) {
      if (!liveKeys.has(key)) Notifications.revealed.delete(key);
    }
  },

  // --- fetching --------------------------------------------------------

  async refresh() {
    try {
      const res = await fetch('/api/notifications?limit=100');
      if (!res.ok) return;
      const data = await res.json();
      Notifications.items = Array.isArray(data.notifications) ? data.notifications : [];
      Notifications.unread = data.unread || 0;
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._renderBadge();
      if (Notifications.open) Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] refresh failed', err);
    }
  },

  async loadMore() {
    if (Notifications.loading || !Notifications.hasMore || !Notifications.nextBefore) return;
    Notifications.loading = true;
    Notifications._renderLoadingState();
    try {
      const { createdAt, id } = Notifications.nextBefore;
      const params = new URLSearchParams({
        limit: '100',
        before: String(createdAt),
        before_id: String(id),
      });
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const incoming = Array.isArray(data.notifications) ? data.notifications : [];
      // Append, deduping on id (a concurrent prepend could overlap).
      const seen = new Set(Notifications.items.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          Notifications.items.push(n);
          seen.add(n.id);
        }
      }
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      if (Notifications.open) Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] loadMore failed', err);
    } finally {
      Notifications.loading = false;
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
    }
    if (!notif.readAt) Notifications.unread += 1;
    Notifications._renderBadge();
    if (Notifications.open) Notifications._renderList();
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

  // --- mark read -------------------------------------------------------

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

  // Per-group "Mark read": clears every unread notification for one app
  // in a single round-trip via the /read { app_id } branch.
  async _markGroupRead(groupKey, appId) {
    const numericAppId = (appId != null && appId !== '') ? Number(appId) : null;
    // No backend scope for the synthetic "general" (null-app) bucket —
    // fall back to clearing its leaves by id.
    if (numericAppId == null || Number.isNaN(numericAppId)) {
      const ids = Notifications.items
        .filter((n) => groupKeyFor(n) === groupKey && !n.readAt)
        .map((n) => n.id);
      for (const id of ids) await Notifications._markOneRead(id);
      Notifications._renderList();
      return;
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: numericAppId }),
      });
      if (!res.ok) return;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      const now = new Date().toISOString();
      Notifications.items = Notifications.items.map((n) =>
        (groupKeyFor(n) === groupKey && !n.readAt) ? { ...n, readAt: now } : n
      );
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markGroupRead failed', err);
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
    // Deliberately do NOT hide the drawer here: it stays open over the
    // navigated-to view so the user can keep clicking through other
    // notifications. The drawer only dismisses via outside-click or the
    // explicit close button.
    Notifications._markOneRead(id);
    if (item.appSlug) {
      // Both mention and kudos notifications land on the app's group
      // chat. Mentions originate there; kudos's PR is rendered in the
      // group-chat tab's vote panel (Open PRs / Merged), where the
      // user can scroll to it and reciprocate if they want.
      window.location.hash = `#app/${item.appSlug}/group-chat`;
    }
  },

  _toggleGroup(groupKey) {
    if (Notifications.expanded.has(groupKey)) Notifications.expanded.delete(groupKey);
    else Notifications.expanded.add(groupKey);
    Notifications._saveExpanded();
    Notifications._renderList();
  },

  // --- rendering -------------------------------------------------------

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

  // Pure transform: items (newest-first) -> ordered groups. The first
  // time an app is seen is its newest notification, so insertion order
  // already yields most-recent-activity-first group ordering.
  _groupByApp() {
    const byKey = new Map();
    for (const n of Notifications.items) {
      const key = groupKeyFor(n);
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          appId: n.appId != null ? n.appId : null,
          appName: n.appName || 'General',
          appSlug: n.appSlug || null,
          items: [],
          unreadCount: 0,
        };
        byKey.set(key, g);
      }
      g.items.push(n);
      if (!n.readAt) g.unreadCount += 1;
    }
    // Unread-first: groups with any unread float to the top, preserving
    // the most-recent-activity-first order within each bucket (stable
    // partition). This is a pure view ordering — `items` stays
    // newest-first so the keyset pagination cursor is unaffected.
    const groups = [...byKey.values()];
    const withUnread = groups.filter((g) => g.unreadCount > 0);
    const allRead = groups.filter((g) => g.unreadCount === 0);
    return [...withUnread, ...allRead];
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

    const groups = Notifications._groupByApp();
    // Keep persisted expansion tidy: drop apps that have no notifs now.
    Notifications._pruneExpanded(new Set(groups.map((g) => g.key)));

    // One HTML chunk per top-level entry (an app group or a single-notif
    // leaf row), joined by a stronger divider so apps are easy to tell
    // apart. The divider only goes *between* entries — never before the
    // first or after the last.
    const entries = [];
    for (const g of groups) {
      if (g.items.length === 1) {
        // Single-notification app: plain leaf row, no group chrome.
        entries.push(renderRow(g.items[0]));
        continue;
      }
      entries.push(renderGroup(g, Notifications.expanded.has(g.key)));
    }
    const APP_DIVIDER = '<div role="separator" class="border-t-2 border-zinc-200 dark:border-zinc-700"></div>';
    list.innerHTML = entries.join(APP_DIVIDER) + renderLoadMore();

    // Leaf-row clicks (standalone single-item rows + leaves inside an
    // expanded group).
    list.querySelectorAll('[data-notif-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-notif-id'));
      el.addEventListener('click', () => Notifications._onItemClick(id));
    });
    // Group header expand/collapse toggles. stopPropagation so the
    // document-level outside-click handler doesn't see this click: the
    // toggle re-renders the list (detaching this button), after which the
    // bubbled click's target is no longer inside the panel and the panel
    // would otherwise be wrongly dismissed.
    list.querySelectorAll('[data-group-toggle]').forEach((el) => {
      const key = el.getAttribute('data-group-toggle');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._toggleGroup(key);
      });
    });
    // Per-group "Mark read".
    list.querySelectorAll('[data-group-markread]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._markGroupRead(
          el.getAttribute('data-group-markread'),
          el.getAttribute('data-app-id')
        );
      });
    });
    // Inline "Show more" → reveal the next page of leaves for this group
    // in place (no navigation away). stopPropagation so the outside-click
    // dismiss doesn't fire when the re-render detaches this button.
    list.querySelectorAll('[data-group-showmore]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._showMoreGroup(el.getAttribute('data-group-showmore'));
      });
    });
  },

  // Reveal one more page (GROUP_LEAF_CAP) of leaves for a group. If every
  // already-loaded leaf is shown but more pages exist server-side, bump
  // the intended reveal and pull the next cross-app page; loadMore()
  // re-renders on completion, so the freshly-arrived leaves appear.
  _showMoreGroup(key) {
    if (!key) return;
    const g = Notifications._groupByApp().find((x) => x.key === key);
    const current = Notifications.revealed.get(key) || GROUP_LEAF_CAP;
    const loaded = g ? g.items.length : 0;
    if (current < loaded) {
      Notifications.revealed.set(key, current + GROUP_LEAF_CAP);
      Notifications._renderList();
    } else if (Notifications.hasMore) {
      Notifications.revealed.set(key, current + GROUP_LEAF_CAP);
      Notifications.loadMore();
    }
  },

  // Re-render just the load-more footer's spinner without rebuilding the
  // whole list (called when a fetch starts).
  _renderLoadingState() {
    const footer = document.getElementById('notifications-loadmore');
    if (footer) footer.textContent = 'Loading…';
  },

  _wireScroll() {
    if (Notifications._scrollWired) return;
    const list = document.getElementById('notifications-list');
    if (!list) return;
    list.addEventListener('scroll', () => {
      if (!Notifications.hasMore || Notifications.loading) return;
      const nearBottom =
        list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MORE_THRESHOLD;
      if (nearBottom) Notifications.loadMore();
    });
    Notifications._scrollWired = true;
  },

};

// Stable group key for a notification: the app id when present, else a
// synthetic 'general' bucket so app-less notifications are never dropped.
function groupKeyFor(n) {
  return n && n.appId != null ? String(n.appId) : 'general';
}

// Unread indicator dot. When unread it's a solid violet dot carrying an
// accessible "Unread" label; when read it's an equal-width invisible
// spacer so read/unread rows stay horizontally aligned (no jitter when a
// row is marked read live).
function unreadDot(isUnread) {
  return isUnread
    ? '<span role="img" aria-label="Unread" class="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 align-middle mr-1.5 shrink-0"></span>'
    : '<span aria-hidden="true" class="inline-block w-1.5 h-1.5 align-middle mr-1.5 shrink-0"></span>';
}

// Collapsed/expanded group header + (when expanded) its leaf rows.
function renderGroup(g, isExpanded) {
  const appLine = escapeHtml(g.appName || 'General');
  const hasUnread = g.unreadCount > 0;
  // Unread-first display order within the group (stable: newest-first is
  // preserved inside each bucket). Pure view transform — g.items stays
  // newest-first so the global keyset cursor is unaffected.
  const ordered = hasUnread
    ? g.items.filter((n) => !n.readAt).concat(g.items.filter((n) => n.readAt))
    : g.items;
  const accent = hasUnread ? 'bg-violet-500/5 border-l-2 border-violet-500' : 'border-l-2 border-transparent';
  const chevron = isExpanded ? '▾' : '▸'; // ▾ / ▸
  // Just the number, centered in a fixed-size pill (no "new" wording).
  // Unread groups show the unread count in the violet accent pill; fully
  // read groups show the total in a muted pill.
  const countBadge = hasUnread
    ? `<span class="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[0.65rem] font-bold leading-none text-white bg-violet-500 rounded-full">${g.unreadCount}</span>`
    : `<span class="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[0.65rem] font-medium leading-none text-zinc-500 dark:text-zinc-400 bg-zinc-200 dark:bg-zinc-800 rounded-full">${g.items.length}</span>`;
  // Unread dot next to the app name, matching the per-leaf dot.
  const headerDot = hasUnread ? unreadDot(true) : '';

  // Preview the newest unread item when there is one (it sits first in
  // `ordered`), so the collapsed header surfaces unread content.
  const latest = ordered[0];
  const preview = `${previewText(latest)} · ${relativeTime(latest.createdAt)}`;

  const markReadBtn = hasUnread
    ? `<button data-group-markread="${escapeHtml(g.key)}" data-app-id="${g.appId != null ? g.appId : ''}"
         class="shrink-0 text-[0.7rem] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 px-1.5 py-1">Mark read</button>`
    : '';

  const header = `<div class="flex items-stretch border-b border-zinc-200 dark:border-zinc-800 ${accent}">
    <button data-group-toggle="${escapeHtml(g.key)}" aria-expanded="${isExpanded}"
      class="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors">
      <div class="flex items-center gap-1.5 mb-0.5">
        <span aria-hidden="true" class="text-zinc-400 dark:text-zinc-500">${chevron}</span>
        ${headerDot}
        <span class="font-medium text-zinc-800 dark:text-zinc-200 truncate">${appLine}</span>
        ${countBadge}
      </div>
      <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate pl-5">${escapeHtml(preview)}</div>
    </button>
    ${markReadBtn}
  </div>`;

  if (!isExpanded) return header;

  // Expanded: reveal up to `visible` leaves (default GROUP_LEAF_CAP, grown
  // by inline "Show more" clicks), then an inline pagination button.
  const visible = Notifications.revealed.get(g.key) || GROUP_LEAF_CAP;
  const shown = ordered.slice(0, visible);
  const leaves = shown.map((n) => renderRow(n)).join('');
  let more = '';
  const localRemaining = ordered.length - shown.length;
  const btnCls = 'w-full text-left px-3 py-2 text-xs text-violet-500 hover:text-violet-400 border-b border-zinc-200 dark:border-zinc-800';
  if (localRemaining > 0) {
    // More already-loaded leaves to reveal in place.
    const next = Math.min(GROUP_LEAF_CAP, localRemaining);
    more = `<button data-group-showmore="${escapeHtml(g.key)}" class="${btnCls}">Show ${next} more →</button>`;
  } else if (Notifications.hasMore) {
    // All loaded leaves shown, but older pages may add more to this group.
    more = `<button data-group-showmore="${escapeHtml(g.key)}" class="${btnCls}">Show more →</button>`;
  }
  return `${header}<div class="pl-2 bg-zinc-50/50 dark:bg-zinc-950/30">${leaves}${more}</div>`;
}

// Footer row used both as the scroll sentinel and the empty/has-more hint.
function renderLoadMore() {
  if (!Notifications.hasMore) return '';
  return `<div id="notifications-loadmore" class="px-3 py-2.5 text-center text-xs text-zinc-500 dark:text-zinc-400">Scroll for older…</div>`;
}

// One-line summary used in a collapsed group header. Mirrors the per-kind
// verbs used by renderRow's full rows.
function previewText(n) {
  const who = n.sourceUsername ? `@${n.sourceUsername}` : 'someone';
  switch (n.kind) {
    case 'kudos':       return `\u{1F44F} ${who} gave kudos to your PR`;
    case 'reaction':    return `${n.detail || '❤️'} ${who} reacted to your message`;
    case 'stale_pr':    return `⏳ Your PR is going stale`;
    case 'pr_proposed': return `\u{1F5F3}️ ${who} proposed a PR to vote on`;
    case 'reply':       return `${who} replied to you`;
    case 'mention':     return `${who} mentioned you`;
    default:            return who;
  }
}

function renderRow(n) {
  const unreadCls = n.readAt ? '' : 'bg-violet-500/5 border-l-2 border-violet-500';
  const appLine = n.appName ? escapeHtml(n.appName) : 'app';
  const who = n.sourceUsername ? escapeHtml(n.sourceUsername) : 'someone';
  // Leading unread dot (or an equal-width spacer when read) on the meta
  // line, so unread rows are unmistakable beyond the background accent.
  const dot = unreadDot(!n.readAt);

  // Kudos rows have no chat-message body; they show the PR title (or
  // "PR #N" if the PR has no LLM-generated title yet) and a small 👏
  // icon to distinguish from mention rows at a glance.
  if (n.kind === 'kudos') {
    const prLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.prNumber ? `PR #${n.prNumber}` : 'your PR');
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1">
        ${dot}
        <span aria-hidden="true">\u{1F44F}</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>gave kudos to your PR in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${prLabel}</div>
    </button>`;
  }

  // Reaction rows lead with the emoji someone reacted with, then preview
  // the message they reacted to.
  if (n.kind === 'reaction') {
    const emoji = n.detail || '❤️';
    const reactSnippet = (n.messageContent || '').slice(0, 140);
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1">
        ${dot}
        <span aria-hidden="true">${escapeHtml(emoji)}</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>reacted to your message in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">${renderMentionSnippet(reactSnippet)}</div>
    </button>`;
  }

  // Stale-PR rows are system warnings (no source user): the author's
  // promoted PR has gone quiet and is heading for auto-archive. Lead with
  // a ⏳ and show the PR title so it's actionable at a glance.
  if (n.kind === 'stale_pr') {
    const prLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.prNumber ? `PR #${n.prNumber}` : 'your PR');
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1">
        ${dot}
        <span aria-hidden="true">⏳</span>
        <span>Your PR in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span>is going stale — it'll auto-archive soon without votes</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${prLabel}</div>
    </button>`;
  }

  // PR-proposed (vote-request) rows: someone promoted a PR and we're
  // nudging this user to come vote. Lead with a ballot box and show the
  // PR title; clicking lands on the app's group-chat vote panel.
  if (n.kind === 'pr_proposed') {
    const prLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.prNumber ? `PR #${n.prNumber}` : 'a PR');
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1">
        ${dot}
        <span aria-hidden="true">\u{1F5F3}️</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>proposed a PR to vote on in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${prLabel}</div>
    </button>`;
  }

  const snippet = (n.messageContent || '').slice(0, 140);
  const kindText = n.kind === 'mention'
    ? 'mentioned you in'
    : (n.kind === 'reply' ? 'replied to you in' : 'in');
  return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
    <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
      ${dot}
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
