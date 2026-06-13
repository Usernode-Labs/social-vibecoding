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
  // Pending collaborator invites (authoritative, from the first-page
  // /api/notifications payload). Rendered as a pinned section above the
  // grouped list with Accept / Decline actions.
  invites: [],
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
      Notifications.invites = Array.isArray(data.pendingInvites) ? data.pendingInvites : [];
      Notifications.unread = data.unread || 0;
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      if (Notifications.open) {
        Notifications._renderInvites();
        Notifications._renderList();
      }
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
    // #161: a completion arriving while the user is away from the
    // browser tab sets the dedicated tab-title marker (the replacement
    // for the old streaming-driven "✅ Done"). If they're actively
    // looking at the page, the badge + drawer suffice.
    if ((notif.kind === 'session_done' || notif.kind === 'auto_solve_done')
        && !notif.readAt
        && window.DevChat && DevChat.setCompletionTitle
        && DevChat._userIsAway && DevChat._userIsAway()) {
      DevChat.setCompletionTitle(notif.kind === 'session_done'
        ? 'sessionDone'
        : (notif.detail === 'failed' ? 'autoSolveFailed' : 'autoSolveDone'));
    }
    // A live collab invite needs the authoritative pendingInvites list
    // (the notification row alone can't drive the actionable section) —
    // refresh re-pulls it along with the first page.
    if (notif.kind === 'collab_invite') {
      Notifications.refresh();
      return;
    }
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
    Notifications._renderInvites();
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
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markAllRead failed', err);
    }
  },

  // #161: drop the tab-title completion marker once no unread completion
  // notification remains (drawer click, group/app mark-read, mark-all,
  // or a cross-tab notifications_changed refresh). The visibility/focus
  // return handler in dev-chat.js is the other clearing path.
  _reconcileCompletionTitle() {
    if (!window.DevChat || !DevChat.setCompletionTitle || !DevChat._titleCompletion) return;
    if (!Notifications.items.some(isPriorityNotif)) DevChat.setCompletionTitle(null);
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
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
    } catch (err) {
      console.warn('[notifications] markGroupRead failed', err);
    }
  },

  async _markOneRead(id) {
    // Optimistically mark read in-memory and re-render the open drawer
    // right away: the unread dot disappears and unread-first sorting
    // updates live, instead of waiting for the network round-trip (which
    // is why a clicked item used to stay unread until close/reopen).
    const item = Notifications.items.find((n) => n.id === id);
    if (item && !item.readAt) {
      item.readAt = new Date().toISOString();
      if (Notifications.unread > 0) Notifications.unread -= 1;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      if (Notifications.open) Notifications._renderList();
    }
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
      const data = await res.json();
      // Reconcile with the server's authoritative unread count.
      Notifications.unread = data.unread || 0;
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
    // #161/#194: completion notifications deep-link to their dev
    // sub-tab. session_done opens the dev session itself;
    // auto_solve_done opens the Issues tab with that issue's accordion
    // expanded.
    if (item.kind === 'session_done' && item.appSlug && item.sessionId) {
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(item.appSlug, 'dev', { subTab: 'sessions', sessionId: item.sessionId });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/sessions/${item.sessionId}`;
      }
      return;
    }
    // (#86) Private spec share: persist the spec-panel open state for
    // the app, then land on Dev → Chat — GroupChat's mount path
    // (_restoreSpecPanelIfSaved) opens the read-only panel and fetches
    // the version through the share-widened access check. GroupChat is
    // a same-script-scope global (const-declared, so not on window) —
    // hence the bare reference behind a typeof guard.
    if (item.kind === 'spec_shared' && item.appSlug && item.sessionId) {
      const version = parseInt(item.detail, 10);
      if (Number.isInteger(version) && version > 0
          && typeof GroupChat !== 'undefined' && GroupChat._writeSpecPanelOpen) {
        GroupChat._writeSpecPanelOpen(item.appSlug, {
          sessionId: item.sessionId,
          version,
          title: `Spec v${version}`,
        });
      }
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(item.appSlug, 'dev', { subTab: 'chat' });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/chat`;
      }
      return;
    }
    if (item.kind === 'auto_solve_done' && item.appSlug) {
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(item.appSlug, 'dev', {
          subTab: 'issues',
          ref: item.headlessIssueNumber || null,
        });
      } else {
        window.location.hash = item.headlessIssueNumber
          ? `#app/${item.appSlug}/dev/issues/${item.headlessIssueNumber}`
          : `#app/${item.appSlug}/dev/issues`;
      }
      return;
    }
    if (item.appSlug) {
      // Mentions/replies/reactions land on the app's Dev → Chat — unless
      // the message lives in a topic thread (#194 parity), in which case
      // the click opens that issue/proposal/governance discussion where
      // the message is actually visible. Vote nudges and kudos land on
      // the Proposals tab where their PR card lives (deep-linked when we
      // know the session).
      //
      // Navigate via App.openAppTab rather than assigning location.hash:
      // a same-value hash assignment fires no `hashchange`, so clicking a
      // notification for the app/tab already on screen wouldn't re-render.
      // openAppTab always renders (and keeps the URL in sync internally).
      const chatKinds = new Set(['mention', 'reply', 'reaction']);
      if (chatKinds.has(item.kind) && item.threadType && item.threadRef != null) {
        const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
        const topicKind = kindMap[item.threadType];
        const topicId = parseInt(item.threadRef, 10);
        if (topicKind && Number.isInteger(topicId) && topicId > 0) {
          if (typeof App !== 'undefined' && App.openAppTab) {
            App.openAppTab(item.appSlug, 'dev', {
              subTab: 'topic',
              ref: { kind: topicKind, id: topicId },
            });
          } else {
            const seg = topicKind === 'issue' ? 'issues'
              : topicKind === 'proposal' ? 'proposals' : 'governance';
            window.location.hash = `#app/${item.appSlug}/dev/${seg}/${topicId}`;
          }
          return;
        }
      }
      const voteKinds = new Set(['pr_proposed', 'stale_pr', 'kudos']);
      const toProposals = voteKinds.has(item.kind);
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(item.appSlug, 'dev', toProposals
          ? { subTab: 'proposals', ref: item.sessionId || null }
          : { subTab: 'chat' });
      } else {
        window.location.hash = toProposals
          ? `#app/${item.appSlug}/dev/proposals${item.sessionId ? `/${item.sessionId}` : ''}`
          : `#app/${item.appSlug}/dev/chat`;
      }
    }
  },

  _toggleGroup(groupKey) {
    if (Notifications.expanded.has(groupKey)) Notifications.expanded.delete(groupKey);
    else Notifications.expanded.add(groupKey);
    Notifications._saveExpanded();
    Notifications._renderList();
  },

  // --- rendering -------------------------------------------------------

  // Badge total folds in pending invites so an invite is as loud as an
  // unread notification (its underlying collab_invite row may already
  // be read while the invite is still actionable).
  _badgeTotal() {
    return Notifications.unread + Notifications.invites.length;
  },

  _renderBadge() {
    const badge = document.getElementById('notifications-badge');
    if (!badge) return;
    const total = Notifications._badgeTotal();
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
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
    const total = Notifications._badgeTotal();
    if (total > 0) document.title = `(${total}) ${base}`;
    else document.title = base;
  },

  // --- pinned invites section -------------------------------------------

  _renderInvites() {
    const box = document.getElementById('notifications-invites');
    if (!box) return;
    if (!Notifications.invites.length) {
      box.innerHTML = '';
      return;
    }
    const rows = Notifications.invites.map((inv) => {
      const who = inv.invitedBy ? `@${escapeHtml(inv.invitedBy)}` : 'Someone';
      return `<div class="px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-violet-500/5 border-l-2 border-l-violet-500" data-invite-app="${inv.appId}">
        <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
          <span aria-hidden="true">✉️</span>
          <span class="font-medium text-zinc-800 dark:text-zinc-200">${who}</span>
          invited you to collaborate on
          <span class="font-medium text-zinc-700 dark:text-zinc-300">${escapeHtml(inv.appName || inv.appSlug || 'an app')}</span>
          <span class="text-zinc-500">· ${relativeTime(inv.createdAt)}</span>
        </div>
        <div class="flex gap-2">
          <button data-invite-accept="${inv.appId}" data-invite-slug="${escapeHtml(inv.appSlug || '')}"
            class="rounded-md bg-violet-600 hover:bg-violet-500 px-3 py-1 text-xs font-medium text-white transition-colors">Accept</button>
          <button data-invite-decline="${inv.appId}"
            class="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">Decline</button>
        </div>
      </div>`;
    });
    const header = `<div class="px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">Invites</div>`;
    box.innerHTML = header + rows.join('');

    // stopPropagation on both buttons: the handlers re-render this
    // section (detaching the clicked node), after which the bubbled
    // click's target is outside the panel and the document-level
    // outside-click handler would wrongly dismiss the drawer.
    box.querySelectorAll('[data-invite-accept]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._acceptInvite(Number(el.getAttribute('data-invite-accept')), el.getAttribute('data-invite-slug'));
      });
    });
    box.querySelectorAll('[data-invite-decline]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._declineInvite(Number(el.getAttribute('data-invite-decline')));
      });
    });
  },

  _removeInviteLocal(appId) {
    Notifications.invites = Notifications.invites.filter((i) => i.appId !== appId);
    Notifications._renderBadge();
    Notifications._renderInvites();
  },

  async _acceptInvite(appId, slug) {
    try {
      const res = await fetch(`/api/invites/${appId}/accept`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || `Accept failed (HTTP ${res.status})`);
        // The invite may have been revoked — re-sync.
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId);
      // Pull the fresh state (the collab_invite row is now read) and
      // refresh the home grid — a view-private app just became visible.
      Notifications.refresh();
      if (typeof Home !== 'undefined' && document.getElementById('home-screen') &&
          !document.getElementById('home-screen').classList.contains('hidden')) {
        Home.load();
      }
      const target = data.appSlug || slug;
      if (target && typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(target, 'group-chat');
      }
    } catch (err) {
      console.warn('[notifications] acceptInvite failed', err);
    }
  },

  async _declineInvite(appId) {
    try {
      const res = await fetch(`/api/invites/${appId}/decline`, { method: 'POST' });
      if (!res.ok) {
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId);
      Notifications.refresh();
    } catch (err) {
      console.warn('[notifications] declineInvite failed', err);
    }
  },

  // Pure transform: items (newest-first) -> ordered groups, in two tiers
  // (#161). Base tier: the first time an app is seen is its newest
  // notification, so insertion order yields most-recent-activity-first
  // group ordering, and each group's items stay newest-first. Priority
  // tier: UNREAD completion notifications (session_done /
  // auto_solve_done) pin to the top — their group floats above the
  // others and the pinned items lead within their group (so they also
  // become the collapsed header's preview). Both re-sorts are stable
  // partitions, so ordering inside each tier is unchanged; once a
  // completion is read it drops back to its chronological spot.
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
          hasUnreadPriority: false,
        };
        byKey.set(key, g);
      }
      g.items.push(n);
      if (!n.readAt) g.unreadCount += 1;
      if (isPriorityNotif(n)) g.hasUnreadPriority = true;
    }
    const groups = [...byKey.values()];
    for (const g of groups) {
      if (!g.hasUnreadPriority) continue;
      // Array.prototype.sort is spec-stable, so this is a stable
      // partition: priority items first, newest-first inside each half.
      g.items.sort((a, b) => (isPriorityNotif(a) ? 0 : 1) - (isPriorityNotif(b) ? 0 : 1));
    }
    groups.sort((a, b) => (a.hasUnreadPriority ? 0 : 1) - (b.hasUnreadPriority ? 0 : 1));
    return groups;
  },

  _renderList() {
    const list = document.getElementById('notifications-list');
    const empty = document.getElementById('notifications-empty');
    if (!list || !empty) return;

    if (Notifications.items.length === 0) {
      list.innerHTML = '';
      // The pinned invites section may still have content — only show
      // the empty hint when there's truly nothing in the drawer.
      empty.classList.toggle('hidden', Notifications.invites.length > 0);
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
      // App-associated notifications ALWAYS render under their app group
      // header (header + dot + expand/pagination chrome), even when the
      // app only has one notification — so the layout is consistent
      // regardless of count. Only app-less ("general") notifications fall
      // back to a plain leaf row when there's a single one.
      if (g.items.length === 1 && g.appId == null) {
        entries.push(renderRow(g.items[0]));
        continue;
      }
      entries.push(renderGroup(g, Notifications.expanded.has(g.key)));
    }
    const APP_DIVIDER = '<div role="separator" class="border-t-2 border-zinc-200 dark:border-zinc-700"></div>';
    list.innerHTML = entries.join(APP_DIVIDER) + renderLoadMore();

    // Leaf-row clicks (standalone single-item rows + leaves inside an
    // expanded group). stopPropagation so the document-level outside-click
    // handler doesn't see this click: _onItemClick marks the item read and
    // re-renders the list (detaching this row), after which the bubbled
    // click's target is no longer inside the panel and the drawer would
    // otherwise be wrongly dismissed.
    list.querySelectorAll('[data-notif-id]').forEach((el) => {
      const id = Number(el.getAttribute('data-notif-id'));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        Notifications._onItemClick(id);
      });
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

// #161: completion notifications pin to the top of the drawer while
// UNREAD — a finished session demands attention; once read it returns
// to its natural chronological position. Deliberately limited to these
// two kinds; grow this set rather than adding a server-side priority
// column if more "priority" kinds emerge.
const PRIORITY_KINDS = new Set(['session_done', 'auto_solve_done']);
function isPriorityNotif(n) {
  return !!n && PRIORITY_KINDS.has(n.kind) && !n.readAt;
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

  const latest = g.items[0];
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
  const shown = g.items.slice(0, visible);
  const leaves = shown.map((n) => renderRow(n)).join('');
  let more = '';
  const localRemaining = g.items.length - shown.length;
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
    case 'spec_shared': return `\u{1F4CB} ${who} shared a spec with you`;
    case 'collab_invite':          return `✉️ ${who} invited you to collaborate`;
    case 'collab_invite_accepted': return `✅ ${who} accepted your invite`;
    case 'session_done':           return `✅ Your dev session finished`;
    case 'auto_solve_done':
      return n.detail === 'failed'
        ? `⚠️ Proposal for issue #${n.headlessIssueNumber || '?'} failed`
        : n.detail === 'question'
          ? `🤖 Proposal for issue #${n.headlessIssueNumber || '?'} has questions for you`
          : `🤖 Proposal for issue #${n.headlessIssueNumber || '?'} is ready`;
    default:            return who;
  }
}

function renderRow(n) {
  // #103: keep the violet left line on every row, read or unread, so a
  // notification never "loses its line" when read. Only the background
  // tint stays unread-conditional (the unread dot below is the other cue).
  const unreadCls = n.readAt ? 'border-l-2 border-violet-500' : 'bg-violet-500/5 border-l-2 border-violet-500';
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

  // #161: dev-session completion — the owner left mid-turn and it
  // finished. Clicking deep-links straight into the dev session.
  if (n.kind === 'session_done') {
    const sessionLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.branchName ? escapeHtml(n.branchName) : 'your session');
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1 flex-wrap">
        ${dot}
        <span aria-hidden="true">✅</span>
        <span>Your dev session in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span>finished</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${sessionLabel}</div>
    </button>`;
  }

  // #161: headless proposal-run completion. Clicking lands on the app's
  // group chat and reveals the issue row (where "Start session from
  // proposal" lives).
  if (n.kind === 'auto_solve_done') {
    const failed = n.detail === 'failed';
    const icon = failed ? '⚠️' : '\u{1F916}';
    // #150: a question outcome isn't "ready" work product — it's the run
    // asking the reporter for input, so say so in the headline.
    const verb = failed ? 'failed'
      : (n.detail === 'question' ? 'has questions for you' : 'is ready');
    const issueLabel = n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue';
    const outcomeText = {
      spec: 'drafted a spec',
      code: 'pushed code',
      spec_code: 'drafted a spec and pushed code',
      question: 'replied with a question',
      failed: 'failed — you can retry',
    }[n.detail] || 'finished';
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1 flex-wrap">
        ${dot}
        <span aria-hidden="true">${icon}</span>
        <span>Proposal for</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${escapeHtml(issueLabel)}</span>
        <span>in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span>${verb}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${escapeHtml(outcomeText)}</div>
    </button>`;
  }

  // (#86) Private spec share: someone sent this user a spec version.
  // Clicking opens the app's group chat with the read-only spec panel
  // showing that exact version (see _onItemClick). Second line prefers
  // the session's PR title / branch name (already joined server-side);
  // the spec's own H1 appears as soon as the panel loads.
  if (n.kind === 'spec_shared') {
    const specLabel = n.prTitle
      ? escapeHtml(n.prTitle)
      : (n.branchName ? escapeHtml(n.branchName) : `Spec v${escapeHtml(n.detail || '?')}`);
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 mb-1 flex items-center gap-1 flex-wrap">
        ${dot}
        <span aria-hidden="true">\u{1F4CB}</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>shared a spec with you in</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
      <div class="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2 font-medium">${specLabel}</div>
    </button>`;
  }

  // Collab-invite history rows (the actionable Accept/Decline buttons
  // live ONLY in the pinned Invites section, driven by pendingInvites —
  // once resolved this is just a plain history row).
  if (n.kind === 'collab_invite' || n.kind === 'collab_invite_accepted') {
    const verb = n.kind === 'collab_invite'
      ? 'invited you to collaborate on'
      : 'accepted your invite to collaborate on';
    const icon = n.kind === 'collab_invite' ? '✉️' : '✅';
    return `<button data-notif-id="${n.id}" class="w-full text-left px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors ${unreadCls}">
      <div class="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1 flex-wrap">
        ${dot}
        <span aria-hidden="true">${icon}</span>
        <span class="font-medium text-zinc-800 dark:text-zinc-200">@${who}</span>
        <span>${verb}</span>
        <span class="font-medium text-zinc-700 dark:text-zinc-300">${appLine}</span>
        <span class="text-zinc-500">· ${relativeTime(n.createdAt)}</span>
      </div>
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
