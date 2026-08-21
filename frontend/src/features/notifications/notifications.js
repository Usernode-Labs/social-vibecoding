// Top-right notifications dropdown.
//
// MOVED, NOT REWRITTEN (#1079 chunk B). This was public/js/notifications.js —
// a classic <script> — until #notifications-panel became a React island. The
// body is unchanged so the rendered rows stay byte-identical (dapp.json
// selects against them); only the two window publications at the bottom and
// the init() trigger moved. It is plain .js rather than .ts deliberately: a
// mechanical retype of 1,300 lines of untyped DOM code would hide the "this is
// the same module" property that makes the move reviewable, and the tests that
// load this file in a vm keep working unchanged.
//
// The panel's chassis (root, header row, the three leaf containers) is
// rendered by ./index.tsx. This module owns everything INSIDE those
// containers — it is now the only writer, since no public/js/** module
// reaches into them.
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
const NATIVE_INVALIDATION_TIMEOUT_MS = 10000;
const NATIVE_INVALIDATION_REFRESH_VERSION = 1;

const Notifications = {
  // #1191 slice 6: the drawer's two innerHTML hosts are React now. This module
  // still owns the fetches, the mark-read discipline, the click routing and
  // the badges; what it no longer does is build DOM. `_renderList` and
  // `_renderInvites` compute a descriptor tree and push it here, and
  // ./notifications-list.tsx renders it.
  //
  // Planted by ./mount.ts, which is the only module in this feature that may
  // import React. It stays null in the vm harnesses that evaluate this file as
  // a classic script (see ./notifications-store.js for why that matters), and
  // both render methods no-op when it is — exactly as they used to when
  // getElementById came back null.
  _store: null,
  // social-push.js is cached independently from the React shell bundle. It
  // must not trust the older refreshAfterInvalidation implementation, which
  // reported success even when its ordinary cacheable refresh failed.
  nativeInvalidationRefreshVersion: NATIVE_INVALIDATION_REFRESH_VERSION,
  items: [],   // newest-first; the single source of truth
  // Pending collaborator invites (authoritative, from the first-page
  // /api/notifications payload). Rendered as a pinned section above the
  // grouped list with Accept / Decline actions.
  invites: [],
  // #1280: messages this user saved with the bookmark button in group
  // chat, newest save first (also from the first-page payload). Rendered
  // as the TOP pinned section — above the invites and the grouped list —
  // and they stay there until unsaved, from the message or from here.
  //
  // Deliberately NOT folded into `items`: a save is not a notification. It
  // has no unread state, so it must not touch the badge, the mark-all
  // path, the grouping transform or the pagination cursor — all of which
  // operate on `items` alone.
  saved: [],
  unread: 0,
  // `open` is a GETTER now, defined beside show()/hide() below — the drawer
  // owns the presentation, so this module derives the state rather than
  // storing a flag that would disagree with the screen during the drawer's
  // deferred exit. A plain `open: false` here would shadow it.
  // Pagination cursor for the per-group "Show more →" pager.
  nextBefore: null,  // { createdAt, id } | null
  hasMore: false,
  loading: false,
  // Set<string> of expanded group keys (appId as string, or 'general').
  expanded: new Set(),
  // Map<string, number> of group key -> how many leaves to reveal for
  // that group. Ephemeral (not persisted): resets on reload so the
  // drawer opens compact. An absent key means the default GROUP_LEAF_CAP.
  revealed: new Map(),
  // Only the newest first-page refresh may replace the authoritative feed.
  // This prevents an older boot/bell request from completing after a native
  // network-only invalidation and overwriting its fresher result.
  _refreshGeneration: 0,
  // Once a native invalidation starts, this document must never replace its
  // feed with the service worker's older API-cache fallback. Raise the floor
  // before the request awaits so a later overlapping ordinary refresh is also
  // network-only. Failed reads preserve the last rendered snapshot while the
  // Social coordinator retains and retries the invalidation.
  _networkFreshnessFloor: false,

  init() {
    Notifications._loadExpanded();

    // THE UI OVERHAUL merged the bell into the hamburger, so #notifications-btn
    // is gone and so is the outside-click dismissal that used to live here:
    // opening, closing and dismissing this list are all the drawer's business
    // now (features/header/header-menu-controller.js). What is left is the
    // "Mark all read" control, which is still this module's.
    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.addEventListener('click', Notifications.markAllRead);

    // Anonymous SPA boot (fold-auth-pages-into-SPA): the initial fetch
    // waits for the authed boot stage instead of firing a guaranteed 401
    // on a sessionless document. `sv:authed` fires at most once.
    if (window.App && App.user) Notifications.refresh();
    else document.addEventListener('sv:authed',
      () => Notifications.refresh(), { once: true });
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

  async refresh(options) {
    const generation = ++Notifications._refreshGeneration;
    try {
      // ?demo=1 forwarding (preserved on the page URL): staging injects
      // mock session-related rows on the first page so the cog drawer's
      // pinned section is reviewable (routes/notifications.js
      // stagingMockNotifications). No-op in production.
      const demo = new URLSearchParams(location.search).get('demo') === '1' ? '&demo=1' : '';
      const explicitlyNetworkOnly = options && options.networkOnly === true;
      if (explicitlyNetworkOnly) Notifications._networkFreshnessFloor = true;
      const networkOnly = explicitlyNetworkOnly ||
        Notifications._networkFreshnessFloor;
      // The previous service worker classifies this request as an ordinary
      // cacheable API read. A per-attempt URL prevents that worker from
      // replaying an earlier invalidation response while a new page is waiting
      // for the updated worker to take control.
      const invalidationNonce = networkOnly
        ? (typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${generation.toString(36)}-` +
            Math.random().toString(36).slice(2))
        : null;
      const invalidation = networkOnly
        ? `&native_invalidation=1&native_invalidation_nonce=${encodeURIComponent(invalidationNonce)}`
        : '';
      let timeout = null;
      let controller = null;
      if (networkOnly && typeof AbortController === 'function') {
        controller = new AbortController();
        timeout = setTimeout(
          () => controller.abort(),
          NATIVE_INVALIDATION_TIMEOUT_MS
        );
      }
      let res;
      let data;
      try {
        res = await fetch(
          `/api/notifications?limit=100${demo}${invalidation}`,
          networkOnly ? {
            credentials: 'same-origin',
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          } : undefined
        );
        if (!res.ok) return false;
        data = await res.json();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (generation !== Notifications._refreshGeneration) return false;
      Notifications.items = Array.isArray(data.notifications) ? data.notifications : [];
      Notifications.invites = Array.isArray(data.pendingInvites) ? data.pendingInvites : [];
      Notifications.saved = Array.isArray(data.savedMessages) ? data.savedMessages : [];
      Notifications.unread = data.unread || 0;
      Notifications.hasMore = !!data.hasMore;
      Notifications.nextBefore = data.nextBefore || null;
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      // Rendered UNCONDITIONALLY now, where this was gated on `open`.
      //
      // The gate existed because the bell's panel was presented on demand and
      // filled at that moment: show() rendered the three sections before
      // handing the node to the kit, precisely so the sheet measured the right
      // height. THE UI OVERHAUL moved the list into the hamburger, which is
      // always mounted — translated off-screen rather than built on open — so
      // there is no "before presenting" to render at, and no cost to keeping
      // the store current. The payoff is that the drawer opens onto CURRENT
      // rows instead of last-open's.
      Notifications._renderSaved();
      Notifications._renderInvites();
      Notifications._renderList();
      // After the first populated refresh, so a deep-linked drawer opens
      // onto real rows rather than an empty-state flash.
      Notifications._maybeShotOpen();
      return true;
    } catch (err) {
      console.warn('[notifications] refresh failed', err);
      return false;
    }
  },

  // Native foreground push is only an invalidation signal. Re-read the
  // authenticated notification feed; no notification copy crosses the
  // WebView bridge.
  async refreshAfterInvalidation() {
    if (!window.App || !App.user) return false;
    return Notifications.refresh({ networkOnly: true });
  },

  // Resolve a native push's opaque id through the current Social session,
  // then reuse the existing click router and mark-read behavior. The exact
  // endpoint is ownership-scoped and intentionally returns no route from the
  // untrusted push payload.
  async openById(rawId) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return false;
    let item = Notifications.items.find((candidate) => candidate.id === id);
    if (!item) {
      try {
        const res = await fetch(`/api/notifications/${id}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return false;
        const data = await res.json();
        item = data && data.notification;
        if (!item || item.id !== id) return false;
        Notifications.items.unshift(item);
      } catch (err) {
        console.warn('[notifications] exact lookup failed', err);
        return false;
      }
    }
    Notifications._onItemClick(id);
    return true;
  },

  async loadMore() {
    if (Notifications.loading || !Notifications.hasMore || !Notifications.nextBefore) return;
    Notifications.loading = true;
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
      Notifications._renderList();
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
    // #138: route an arriving completion through the alert channels — a
    // chime when the app is visible, an OS notification when it's hidden.
    // The visible/hidden split lives in DevAlerts.onCompletion. This is the
    // "user is elsewhere in the app, or backgrounded" path (notify_on_done
    // was armed, so a notification_new arrives); the "watching the same dev
    // chat" path is handled by DevChat._finishStreaming's direct tone.
    if ((notif.kind === 'session_done' || notif.kind === 'auto_solve_done')
        && !notif.readAt
        && window.DevAlerts && typeof DevAlerts.onCompletion === 'function') {
      DevAlerts.onCompletion(completionAlertInfo(notif));
    }
    // A live collab invite needs the authoritative pendingInvites list
    // (the notification row alone can't drive the actionable section) —
    // refresh re-pulls it along with the first page.
    if (notif.kind === 'collab_invite' || notif.kind === 'approver_invite') {
      Notifications.refresh();
      return;
    }
    Notifications._renderBadge();
    Notifications._renderList();
  },

  // ── Presentation: the hamburger drawer ──────────────────────────
  //
  // This module used to own a surface of its own — #notifications-panel, an
  // anchored dropdown on desktop and a kit bottom sheet on touch, both
  // presented from here. THE UI OVERHAUL merged the bell into the hamburger,
  // so the list is rendered inside #header-menu-panel and the DRAWER owns the
  // presentation, including the kit adoption. These three forward to it so
  // every existing caller — a notification click, a screenshot deep link, the
  // native Social coordinator — keeps working unchanged.
  //
  // `open` is derived rather than stored for the same reason: the drawer's
  // exit is deferred behind a spring (see HeaderMenu.isPresenting), so a flag
  // set here would disagree with what is on screen for ~200ms after a close.
  get open() {
    return !!window.HeaderMenu?.isPresenting?.();
  },

  toggle() {
    if (Notifications.open) Notifications.hide();
    else Notifications.show();
  },

  show() {
    window.HeaderMenu?.open?.();
  },

  hide() {
    window.HeaderMenu?.close?.();
  },

  // Screenshot-state deep link (`?shot=notifications`): the list only exists
  // behind a click on the hamburger, so the capture pipeline and any dapp.json
  // test would otherwise never see it — and #1280's saved section lives
  // nowhere else. Pair it with ?demo=1 in staging so the pinned sections have
  // mock rows to render. Once per page load — reopening after a manual
  // dismiss would fight the user, and refresh() runs again on live events.
  _shotOpened: false,
  _maybeShotOpen() {
    if (Notifications._shotOpened || Notifications.open) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch { /* ignore */ }
    if (shot !== 'notifications') return;
    Notifications._shotOpened = true;
    Notifications.show();
  },

  // #1329: a presented drawer is MODAL on touch — it covers the screen the
  // action navigates to, so leaving it up strands the user under a stuck,
  // mostly-empty sheet over a dimmed backdrop. Every action below that
  // actually routes calls this first.
  //
  // It closes the drawer at EVERY width now. The rule used to be sheet-gated,
  // so the desktop anchored dropdown could keep its documented keep-open
  // behaviour; there is no anchored dropdown any more, and a side drawer left
  // open over the screen you just navigated to is the same problem the touch
  // sheet had.
  _dismissSheetForNav() {
    if (Notifications.open) Notifications.hide();
  },

  // --- mark read -------------------------------------------------------

  async markAllRead() {
    // Only the bell's own (non-session) kinds count here — the cog
    // drawer's session-related notifications have their own mark-all
    // and must not be cleared by the bell's button.
    if (Notifications._bellUnread() === 0) return;
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, exclude_kinds: [...SESSION_NOTIF_KINDS] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      Notifications.unread = data.unread || 0;
      const now = new Date().toISOString();
      Notifications.items = Notifications.items.map((n) => (
        isSessionNotif(n) ? n : { ...n, readAt: n.readAt || now }
      ));
      Notifications._reconcileCompletionTitle();
      Notifications._renderBadge();
      Notifications._renderList();
      // #449: an open group chat may be showing unread dots for the
      // mentions/replies/reactions that were just cleared — reconcile
      // them from the now-read items list right away, instead of relying
      // solely on the server's notifications_changed round-trip.
      window.GroupChat?.reconcileDotsFromNotifications?.();
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

  // Per-group "Mark read": app groups and platform-conversation groups use
  // separate backend scopes so equal integer ids can never clear each other.
  async _markGroupRead(groupKey, appId, conversationId) {
    const numericAppId = (appId != null && appId !== '') ? Number(appId) : null;
    const numericConversationId = (conversationId != null && conversationId !== '')
      ? Number(conversationId) : null;
    // No backend scope for the synthetic "general" (null-app) bucket —
    // fall back to clearing its leaves by id.
    if ((numericAppId == null || Number.isNaN(numericAppId))
        && (numericConversationId == null || Number.isNaN(numericConversationId))) {
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
        body: JSON.stringify(numericConversationId != null
          ? { conversation_id: numericConversationId }
          : { app_id: numericAppId }),
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
      Notifications._renderList();
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
    // Desktop: deliberately do NOT hide the anchored panel here — it stays
    // open over the navigated-to view so the user can keep clicking through
    // other notifications, and only dismisses via outside-click or the
    // explicit close button. Touch is the opposite contract (#1329): the kit
    // bottom sheet is modal and would COVER the destination screen, so each
    // branch below that actually routes calls _dismissSheetForNav() first —
    // a no-op when no sheet is presented.
    Notifications._markOneRead(id);
    // Platform conversations are never routed through an app tab. Prefer the
    // React bridge because it re-renders even when this is the current hash;
    // the hash fallback keeps native exact-notification opens functional
    // during shell startup before the island publishes its controller.
    if (CONVERSATION_NOTIF_KINDS.has(item.kind)) {
      const conversationId = Number(item.conversationId);
      if (Number.isSafeInteger(conversationId) && conversationId > 0
          && conversationId <= 2147483647) {
        Notifications._dismissSheetForNav();
        const messages = window.UsernodeReact?.messages;
        if (messages?.open) messages.open(conversationId);
        else window.location.hash = `#messages/${conversationId}`;
      }
      return;
    }
    // #161/#194: completion notifications deep-link to their dev
    // sub-tab. session_done opens the dev session itself;
    // auto_solve_done opens the Issues tab with that issue's accordion
    // expanded.
    if (item.kind === 'session_done' && item.appSlug && item.sessionId) {
      Notifications._dismissSheetForNav();
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
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(item.appSlug, 'dev', { subTab: 'chat' });
      } else {
        window.location.hash = `#app/${item.appSlug}/dev/chat`;
      }
      return;
    }
    if (item.kind === 'auto_solve_done' && item.appSlug) {
      Notifications._dismissSheetForNav();
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
      // Every path below navigates (the topic sub-branch returns after
      // routing; an invalid topic ref falls through to the chat/proposals
      // navigation), so one dismiss covers the whole block.
      Notifications._dismissSheetForNav();
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
      // session_comment routes exactly like a thread-scoped mention: its
      // chat_message_id lives in the session's discussion thread, so
      // threadType/threadRef point straight at the topic to open (the
      // proposal page once promoted; _loadTopicView reroutes a
      // not-promoted id to the shared-session topic).
      const chatKinds = new Set(['mention', 'reply', 'reaction', 'session_comment']);
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
      const voteKinds = new Set(['pr_proposed', 'stale_pr', 'kudos', 'check_failed']);
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

  // Count of unread session-related items (session_done / auto_solve_done /
  // stale_pr / check_failed) currently loaded — the GREEN badge, which the
  // hamburger carries now that the cog is retired. Counted from the loaded
  // items page; the
  // unread-dedup keeps completions to one-per-session and they're recent,
  // so they sit within the first page in practice.
  _sessionUnread() {
    return Notifications.items.filter((n) => isSessionNotif(n) && !n.readAt).length;
  },

  // Of those, the ones that are a finished dev session specifically. Only
  // used to publish the count on the badge as `data-session-done`, so a
  // route check can assert the green badge is showing BECAUSE a session
  // finished rather than because some other session kind is unread.
  _sessionDoneUnread() {
    return Notifications.items.filter((n) => n && n.kind === 'session_done' && !n.readAt).length;
  },

  // The bell's own unread count: everything except the session-related
  // kinds that live in the cog drawer now.
  _bellUnread() {
    return Math.max(0, Notifications.unread - Notifications._sessionUnread());
  },

  _renderBadge() {
    // Two badges, BOTH on the hamburger since the bell and the cog merged
    // into it. Green = the viewer's unread session-related notifications;
    // red = everything else (mentions/replies/reactions/kudos/votes) +
    // pending invites. The green count is split OUT of the red one so the two
    // never double-count, and each hides at zero. Keeping them distinct is
    // what lets one icon say "there are two different reasons to open me".
    const aiUnread = Notifications._sessionUnread();
    const redCount = Notifications._bellUnread() + Notifications.invites.length;

    const badge = document.getElementById('notifications-badge');
    if (badge) {
      if (redCount > 0) {
        badge.textContent = redCount > 99 ? '99+' : String(redCount);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    const aiBadge = document.getElementById('notifications-badge-ai');
    if (aiBadge) {
      aiBadge.dataset.sessionDone = String(Notifications._sessionDoneUnread());
      if (aiUnread > 0) {
        aiBadge.textContent = aiUnread > 99 ? '99+' : String(aiUnread);
        aiBadge.classList.remove('hidden');
      } else {
        aiBadge.classList.add('hidden');
      }
    }

    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.disabled = Notifications._bellUnread() === 0;
    Notifications._updateTitle();
    // The cog drawer used to render a pinned section from this same items
    // store and was nudged here whenever the store changed. It is retired;
    // the list in the hamburger is React-rendered from the store directly,
    // so it re-renders on its own.
  },

  _updateTitle() {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    const total = Notifications._badgeTotal();
    if (total > 0) document.title = `(${total}) ${base}`;
    else document.title = base;
  },

  // --- pinned saved-messages section (#1280) ----------------------------

  // Same contract as _renderInvites below: compute descriptors, push them
  // into the store, let ./notifications-list.tsx render them. Empty stays
  // empty — nothing saved renders no "Saved" header at all.
  _renderSaved() {
    const store = Notifications._store;
    if (!store) return;
    store.set({
      saved: Notifications.saved.map(savedView),
      touch: isTouchNow(),
    });
  },

  // Clicking a saved row opens the message where it actually lives: the
  // topic discussion when it was posted in one (#194 parity with the
  // mention/reply rows), otherwise the app's Dev → Chat. Deliberately does
  // NOT unsave — a save is not a to-do item, and a row that vanished the
  // moment you looked at it would make the section unusable.
  _onSavedClick(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved || !saved.appSlug) return;
    // Both branches below navigate — see _onItemClick for the touch-sheet
    // contract (#1329).
    Notifications._dismissSheetForNav();
    const kindMap = { issue: 'issue', session: 'proposal', governance: 'gov' };
    const topicKind = kindMap[saved.threadType];
    const topicId = parseInt(saved.threadRef, 10);
    if (topicKind && Number.isInteger(topicId) && topicId > 0) {
      if (typeof App !== 'undefined' && App.openAppTab) {
        App.openAppTab(saved.appSlug, 'dev', {
          subTab: 'topic',
          ref: { kind: topicKind, id: topicId },
        });
      } else {
        const seg = topicKind === 'issue' ? 'issues'
          : topicKind === 'proposal' ? 'proposals' : 'governance';
        window.location.hash = `#app/${saved.appSlug}/dev/${seg}/${topicId}`;
      }
      return;
    }
    if (typeof App !== 'undefined' && App.openAppTab) {
      App.openAppTab(saved.appSlug, 'dev', { subTab: 'chat' });
    } else {
      window.location.hash = `#app/${saved.appSlug}/dev/chat`;
    }
  },

  // Unsave from the drawer — the "or there" half of "until unsaved in the
  // message / there". Optimistic like the message-side toggle, and it
  // repaints the message's own button when that chat happens to be on
  // screen (GroupChat is a classic-script global lexical binding, so it is
  // reachable by a bare reference behind a typeof guard, not on window).
  async _unsave(messageId) {
    const saved = Notifications.saved.find((s) => s.messageId === messageId);
    if (!saved || !saved.appSlug) return;
    const previous = Notifications.saved;
    Notifications.saved = Notifications.saved.filter((s) => s.messageId !== messageId);
    Notifications._renderSaved();
    if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
      GroupChat._paintBookmark(messageId, false);
      const msg = GroupChat._findMessage && GroupChat._findMessage(messageId);
      if (msg) msg.bookmarked = false;
    }
    try {
      const res = await fetch(
        `/api/apps/${saved.appSlug}/messages/${messageId}/bookmark`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Put it back rather than leaving the drawer disagreeing with the
      // server about what is saved.
      Notifications.saved = previous;
      Notifications._renderSaved();
      if (typeof GroupChat !== 'undefined' && GroupChat._paintBookmark) {
        GroupChat._paintBookmark(messageId, true);
      }
      console.warn('[notifications] unsave failed', err);
    }
  },

  // --- pinned invites section -------------------------------------------

  // The pinned section is a descriptor list now; ./notifications-list.tsx
  // renders it and owns the stopPropagation, the swipe tray and the header.
  // Empty stays empty — an invite-less drawer renders no "Invites" header,
  // exactly as `box.innerHTML = ''` did.
  _renderInvites() {
    const store = Notifications._store;
    if (!store) return;
    store.set({
      invites: Notifications.invites.map(inviteView),
      touch: isTouchNow(),
    });
  },

  _removeInviteLocal(appId, kind) {
    Notifications.invites = Notifications.invites.filter(
      (i) => !(i.appId === appId && (i.kind || 'collab') === (kind || 'collab'))
    );
    Notifications._renderBadge();
    Notifications._renderInvites();
  },

  async _acceptInvite(appId, slug, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    try {
      const res = await fetch(`${base}/${appId}/accept`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        PlatformUI.toast(data.error || `Accept failed (HTTP ${res.status})`);
        // The invite may have been revoked — re-sync.
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
      // Pull the fresh state (the invite row is now read) and refresh
      // the home grid — a view-private app just became visible.
      Notifications.refresh();
      if (typeof Home !== 'undefined' && App._isScreenVisible('home-screen')) {
        Home.load();
      }
      const target = data.appSlug || slug;
      if (target && typeof App !== 'undefined' && App.openAppTab) {
        // About to navigate — on touch the sheet would otherwise stay
        // presented over the app screen this opens (#1329).
        Notifications._dismissSheetForNav();
        App.openAppTab(target, 'group-chat');
      }
    } catch (err) {
      console.warn('[notifications] acceptInvite failed', err);
    }
  },

  async _declineInvite(appId, kind) {
    const base = kind === 'approver' ? '/api/approver-invites' : '/api/invites';
    try {
      const res = await fetch(`${base}/${appId}/decline`, { method: 'POST' });
      if (!res.ok) {
        Notifications.refresh();
        return;
      }
      Notifications._removeInviteLocal(appId, kind);
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
  // Items the list renders: ALL of them.
  //
  // This used to exclude the session-related kinds (session_done,
  // auto_solve_done, stale_pr, check_failed), because those rendered in the
  // header cog's pinned "Needs attention" section instead. THE UI OVERHAUL
  // retired the cog, so keeping the filter would make four notification kinds
  // invisible everywhere — the one thing a drawer merge must not do.
  //
  // The BADGE split survives, and is why isSessionNotif is still here: the
  // hamburger carries two counts (green = your work in flight, red =
  // everything else + invites) and they must not double-count. What changed is
  // only which of them decides what is RENDERED.
  _bellItems() {
    return Notifications.items;
  },

  _groupByApp() {
    const byKey = new Map();
    for (const n of Notifications._bellItems()) {
      const key = groupKeyFor(n);
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          appId: n.appId != null ? n.appId : null,
          appName: n.conversationId != null
            ? (n.conversationTitle || 'Messages')
            : (n.appName || 'General'),
          appSlug: n.appSlug || null,
          conversationId: n.conversationId != null ? n.conversationId : null,
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

  // One descriptor per top-level entry (an app group or a single-notif leaf
  // row). The list component joins them with the stronger between-apps
  // divider — never before the first or after the last — and owns every
  // handler this method used to attach by querySelectorAll: the leaf clicks,
  // the group toggle, per-group "Mark read", inline "Show more" and the touch
  // swipe tray. All of them still stopPropagation, for the reason they always
  // did: a re-render detaches the clicked node, and the document-level
  // outside-click handler would then see a target outside the panel and
  // wrongly dismiss the drawer.
  _renderList() {
    const store = Notifications._store;
    if (!store) return;
    const touch = isTouchNow();

    if (Notifications._bellItems().length === 0) {
      // The pinned sections may still have content — only show the empty
      // hint when there's truly nothing in the drawer. #1280 added the
      // saved section to that "truly nothing" test: a drawer showing your
      // saved messages while telling you nothing has arrived yet reads as
      // a bug.
      store.set({
        list: [],
        empty: Notifications.invites.length === 0 && Notifications.saved.length === 0,
        touch,
      });
      return;
    }

    const groups = Notifications._groupByApp();
    // Keep persisted expansion tidy: drop apps that have no notifs now.
    Notifications._pruneExpanded(new Set(groups.map((g) => g.key)));

    const entries = [];
    for (const g of groups) {
      // App-associated notifications ALWAYS render under their app group
      // header (header + dot + expand/pagination chrome), even when the
      // app only has one notification — so the layout is consistent
      // regardless of count. Only app-less ("general") notifications fall
      // back to a plain leaf row when there's a single one.
      if (g.items.length === 1 && g.appId == null) {
        entries.push({ type: 'row', row: rowView(g.items[0]) });
        continue;
      }
      entries.push({ type: 'group', group: groupView(g, Notifications.expanded.has(g.key)) });
    }
    store.set({ list: entries, empty: false, touch });
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

};

// Stable group key for a notification: the app id when present, else a
// synthetic 'general' bucket so app-less notifications are never dropped.
function groupKeyFor(n) {
  if (n && n.conversationId != null) return `conversation:${n.conversationId}`;
  return n && n.appId != null ? String(n.appId) : 'general';
}

const CONVERSATION_NOTIF_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
]);

// #161: completion notifications pin to the top of the drawer while
// UNREAD — a finished session demands attention; once read it returns
// to its natural chronological position. Deliberately limited to these
// two kinds; grow this set rather than adding a server-side priority
// column if more "priority" kinds emerge.
const PRIORITY_KINDS = new Set(['session_done', 'auto_solve_done']);
function isPriorityNotif(n) {
  return !!n && PRIORITY_KINDS.has(n.kind) && !n.readAt;
}

// The four system-generated (source-user-less) notifications about the
// viewer's OWN sessions and proposals. Everything social — mentions,
// replies, reactions, kudos, vote nudges, invites, spec shares — is
// everything else.
//
// These used to render in the header cog's drawer INSTEAD of the bell, and
// this set was the filter that kept the two apart. THE UI OVERHAUL merged
// both into the hamburger, so all of it renders in one list now and the set
// survives for the BADGES alone: green counts these, red counts everything
// else, and the split is what stops one icon double-counting.
const SESSION_NOTIF_KINDS = new Set([
  'session_done', 'auto_solve_done', 'stale_pr', 'check_failed',
]);
function isSessionNotif(n) {
  return !!n && SESSION_NOTIF_KINDS.has(n.kind);
}
if (typeof window !== 'undefined') window.SESSION_NOTIF_KINDS = SESSION_NOTIF_KINDS;

// PlatformUI is a classic-script global. The vm harnesses that evaluate this
// file don't define it, and neither does the SSG prerender pass.
function isTouchNow() {
  return typeof PlatformUI !== 'undefined' && !!PlatformUI.isTouch && PlatformUI.isTouch();
}

// #1280: one saved message, as data. The row reads "@author in AppName ·
// 2h ago" over a two-line snippet of the message, which is the same shape
// the mention/reply rows use — a saved message and a message you were
// mentioned in are the same object, and looking different for no reason
// would just make the drawer harder to read.
//
// `time` is the age of the SAVE, not of the message: the section is
// ordered by when you saved things, so a timestamp measuring anything else
// would contradict the order the rows are in.
function savedView(s) {
  return {
    messageId: s.messageId,
    slug: s.appSlug || '',
    who: s.author ? `@${s.author}` : 'System',
    appName: s.appName || s.appSlug || 'an app',
    time: relativeTime(s.savedAt),
    text: (s.content || '').slice(0, 140),
  };
}

// #646: approver invites share the pinned section, with distinct copy and
// their own accept/decline endpoints. The descriptor carries the endpoint
// discriminator (`kind`) as well as the copy, because the component's
// buttons and its swipe tray both need it.
function inviteView(inv) {
  const isApprover = inv.kind === 'approver';
  return {
    appId: inv.appId,
    slug: inv.appSlug || '',
    kind: isApprover ? 'approver' : 'collab',
    icon: isApprover ? '🗳️' : '✉️',
    who: inv.invitedBy ? `@${inv.invitedBy}` : 'Someone',
    verb: isApprover ? 'invited you to be an approver on' : 'invited you to collaborate on',
    appName: inv.appName || inv.appSlug || 'an app',
    time: relativeTime(inv.createdAt),
  };
}

// Collapsed/expanded group header + (when expanded) its leaf rows, as data.
// `count` is the unread count on an unread group and the total on a fully
// read one — two different pills, which is why `hasUnread` travels with it.
function groupView(g, isExpanded) {
  const hasUnread = g.unreadCount > 0;
  const latest = g.items[0];

  // Expanded: reveal up to `visible` leaves (default GROUP_LEAF_CAP, grown
  // by inline "Show more" clicks), then an inline pagination button.
  const visible = Notifications.revealed.get(g.key) || GROUP_LEAF_CAP;
  const shown = isExpanded ? g.items.slice(0, visible) : [];
  const localRemaining = g.items.length - shown.length;
  let more = null;
  if (isExpanded) {
    if (localRemaining > 0) {
      // More already-loaded leaves to reveal in place.
      more = { key: g.key, label: `Show ${Math.min(GROUP_LEAF_CAP, localRemaining)} more →` };
    } else if (Notifications.hasMore) {
      // All loaded leaves shown, but older pages may add more to this group.
      more = { key: g.key, label: 'Show more →' };
    }
  }

  return {
    key: g.key,
    appId: g.appId != null ? g.appId : '',
    conversationId: g.conversationId != null ? g.conversationId : '',
    expanded: isExpanded,
    hasUnread,
    accent: hasUnread
      ? 'bg-violet-500/5 border-l-2 border-violet-500'
      : 'border-l-2 border-transparent',
    chevron: isExpanded ? '▾' : '▸', // ▾ / ▸
    appName: g.appName || 'General',
    count: hasUnread ? g.unreadCount : g.items.length,
    preview: `${previewText(latest)} · ${relativeTime(latest.createdAt)}`,
    leaves: shown.map(rowView),
    more,
  };
}

// #138: derive the title/body + deep-link fields for a completion alert
// (chime/OS notification) from a notification row. Mirrors the per-kind
// copy in previewText / the row renderers so the OS notification reads the
// same as the bell-menu entry.
function completionAlertInfo(n) {
  const appName = n.appName || 'your app';
  if (n.kind === 'auto_solve_done') {
    const issue = n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue';
    let title;
    let body;
    if (n.detail === 'failed') {
      title = 'Proposal failed';
      body = `Proposal for ${issue} in ${appName} failed — you can retry`;
    } else if (n.detail === 'question') {
      title = 'Proposal has a question';
      body = `Proposal for ${issue} in ${appName} is waiting for your input`;
    } else {
      title = 'Proposal ready';
      body = `Proposal for ${issue} in ${appName} is ready`;
    }
    return {
      kind: n.kind,
      appSlug: n.appSlug || null,
      sessionId: n.sessionId || null,
      headlessIssueNumber: n.headlessIssueNumber || null,
      title,
      body,
    };
  }
  // session_done — #971: the session's own title first, then the PR title,
  // and only then the machine-generated branch name.
  const label = n.sessionTitle || n.prTitle || n.branchName || 'your session';
  return {
    kind: 'session_done',
    appSlug: n.appSlug || null,
    sessionId: n.sessionId || null,
    headlessIssueNumber: null,
    title: 'Dev session finished',
    body: `Your dev session in ${appName} finished — ${label}`,
  };
}

// One-line summary used in a collapsed group header. Mirrors the per-kind
// verbs used by renderRow's full rows.
function previewText(n) {
  const who = n.sourceUsername ? `@${n.sourceUsername}` : 'someone';
  switch (n.kind) {
    case 'conversation_invite':   return `✉️ ${who} invited you to a conversation`;
    case 'conversation_message':  return `💬 ${who} sent a message`;
    case 'conversation_mention':  return `${who} mentioned you`;
    case 'conversation_reply':    return `${who} replied to you`;
    case 'conversation_reaction': return `${n.detail || '❤️'} ${who} reacted to your message`;
    case 'kudos':       return `\u{1F44F} ${who} gave kudos to your PR`;
    case 'reaction':    return `${n.detail || '❤️'} ${who} reacted to your message`;
    case 'stale_pr':    return `⏳ Your PR is going stale`;
    case 'check_failed': return `⚠️ Your proposal's preview won't boot`;
    case 'pr_proposed': return `\u{1F5F3}️ ${who} proposed a PR to vote on`;
    case 'reply':       return `${who} replied to you`;
    case 'mention':     return `${who} mentioned you`;
    case 'session_comment': return `\u{1F4AC} ${who} commented on your dev session`;
    case 'spec_shared': return `\u{1F4CB} ${who} shared a spec with you`;
    case 'collab_invite':          return `✉️ ${who} invited you to collaborate`;
    case 'collab_invite_accepted': return `✅ ${who} accepted your invite`;
    case 'approver_invite':          return `🗳️ ${who} invited you to be an approver`;
    case 'approver_invite_accepted': return `✅ ${who} accepted your approver invite`;
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

// One notification row, as data. It has ONE renderer again — NotificationRow in
// ./notifications-list.tsx — which both drawers use: the bell's own list, and
// the cog drawer's pinned "Needs attention" section, which reaches this builder
// through `Notifications._rowView` (see the publication at the bottom). Until
// #1191 slice 6's fourth conversion there was a second, HTML-string renderer
// here for the cog, because that host was still built by `innerHTML`.
//
// `segments` is the meta line after the leading unread dot, in order:
//   { t: 'who' }    → @username, in the strong ink
//   { t: 'strong' } → an app name / issue label, in the slightly softer strong
//   { t: 'text' }   → ordinary copy
// Every value is RAW text. Escaping is the renderer's job, and React does it
// by construction — which is the point of moving the rows there.
function rowView(n) {
  // #103: keep the violet left line on every row, read or unread, so a
  // notification never "loses its line" when read. Only the background
  // tint stays unread-conditional (the unread dot below is the other cue).
  const unreadCls = n.readAt
    ? 'border-l-2 border-violet-500'
    : 'bg-violet-500/5 border-l-2 border-violet-500';
  const appLine = n.appName ? n.appName : 'app';
  const who = n.sourceUsername ? n.sourceUsername : 'someone';
  const base = {
    id: n.id,
    unread: !n.readAt,
    unreadCls,
    time: relativeTime(n.createdAt),
    // The meta line's own layout. `mb` and `wrap` differ per kind, and the
    // plain mention/reply row is the only one that is not a flex row at all.
    mb: true,
    metaFlex: true,
    wrap: false,
    icon: null,
    segments: [],
    body: null,
  };

  if (CONVERSATION_NOTIF_KINDS.has(n.kind)) {
    const conversation = n.conversationTitle || 'Messages';
    const snippet = (n.messageContent || '').slice(0, 140);
    const labels = {
      conversation_invite: ['✉️', 'invited you to'],
      conversation_message: ['💬', 'sent a message in'],
      conversation_mention: ['@', 'mentioned you in'],
      conversation_reply: ['↩️', 'replied to you in'],
      conversation_reaction: [n.detail || '❤️', 'reacted to your message in'],
    };
    const [icon, verb] = labels[n.kind];
    const body = n.kind === 'conversation_invite'
      ? { text: 'Open Messages to accept or decline', medium: false, mention: false }
      : (snippet ? { text: snippet, medium: false, mention: true } : null);
    return {
      ...base,
      wrap: true,
      icon,
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: verb },
        { t: 'strong', v: conversation },
      ],
      body,
    };
  }

  // Kudos rows have no chat-message body; they show the PR title (or
  // "PR #N" if the PR has no LLM-generated title yet) and a small 👏
  // icon to distinguish from mention rows at a glance.
  if (n.kind === 'kudos') {
    return {
      ...base,
      icon: '\u{1F44F}',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: 'gave kudos to your PR in' },
        { t: 'strong', v: appLine },
      ],
      body: {
        text: n.prTitle || (n.prNumber ? `PR #${n.prNumber}` : 'your PR'),
        medium: true,
        mention: false,
      },
    };
  }

  // Reaction rows lead with the emoji someone reacted with, then preview
  // the message they reacted to.
  if (n.kind === 'reaction') {
    return {
      ...base,
      icon: n.detail || '❤️',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: 'reacted to your message in' },
        { t: 'strong', v: appLine },
      ],
      body: { text: (n.messageContent || '').slice(0, 140), medium: false, mention: true },
    };
  }

  // Stale-PR rows are system warnings (no source user): the author's
  // promoted PR has gone quiet and is heading for auto-archive. Lead with
  // a ⏳ and show the PR title so it's actionable at a glance. #971: these
  // rows are about a PROPOSAL, so the PR title still leads; the session
  // title is only a fallback ahead of the bare "PR #N".
  if (n.kind === 'stale_pr') {
    return {
      ...base,
      icon: '⏳',
      segments: [
        { t: 'text', v: 'Your PR in' },
        { t: 'strong', v: appLine },
        { t: 'text', v: "is going stale — it'll auto-archive soon without votes" },
      ],
      body: {
        text: n.prTitle || n.sessionTitle || (n.prNumber ? `PR #${n.prNumber}` : 'your PR'),
        medium: true,
        mention: false,
      },
    };
  }

  // Check-failed rows are system warnings (no source user): the owner's
  // promoted proposal can't merge because its staging preview failed to
  // boot, so automated checks never ran. Lead with ⚠️ and show the PR
  // title; clicking lands on the proposal so they can push a fix. #971: PR
  // title leads (this is a proposal row); the session title is a fallback
  // ahead of the bare "PR #N".
  if (n.kind === 'check_failed') {
    return {
      ...base,
      icon: '⚠️',
      segments: [
        { t: 'text', v: 'Your proposal in' },
        { t: 'strong', v: appLine },
        { t: 'text', v: "can't merge — its preview won't boot, so checks can't run" },
      ],
      body: {
        text: n.prTitle || n.sessionTitle || (n.prNumber ? `PR #${n.prNumber}` : 'your proposal'),
        medium: true,
        mention: false,
      },
    };
  }

  // PR-proposed (vote-request) rows: someone promoted a PR and we're
  // nudging this user to come vote. Lead with a ballot box and show the
  // PR title; clicking lands on the app's group-chat vote panel.
  if (n.kind === 'pr_proposed') {
    return {
      ...base,
      icon: '\u{1F5F3}️',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: 'proposed a PR to vote on in' },
        { t: 'strong', v: appLine },
      ],
      body: {
        text: n.prTitle || (n.prNumber ? `PR #${n.prNumber}` : 'a PR'),
        medium: true,
        mention: false,
      },
    };
  }

  // #161: dev-session completion — the owner left mid-turn and it
  // finished. Clicking deep-links straight into the dev session.
  // #971: label precedence is sessionTitle → prTitle → branchName. The
  // session title is the canonical display name (schema.sql #249) and is
  // mirrored from pr_title once a PR exists, so a promoted session reads
  // exactly as it did before; a pre-PR session now shows its real title
  // instead of `dev/<user>-<epoch>`.
  if (n.kind === 'session_done') {
    return {
      ...base,
      wrap: true,
      icon: '✅',
      segments: [
        { t: 'text', v: 'Your dev session in' },
        { t: 'strong', v: appLine },
        { t: 'text', v: 'finished' },
      ],
      body: {
        text: n.sessionTitle || n.prTitle || n.branchName || 'your session',
        medium: true,
        mention: false,
      },
    };
  }

  // #161: headless proposal-run completion. Clicking lands on the app's
  // group chat and reveals the issue row (where "Start session from
  // proposal" lives).
  if (n.kind === 'auto_solve_done') {
    const failed = n.detail === 'failed';
    // #150: a question outcome isn't "ready" work product — it's the run
    // asking the reporter for input, so say so in the headline.
    const verb = failed ? 'failed'
      : (n.detail === 'question' ? 'has questions for you' : 'is ready');
    const outcomeText = {
      spec: 'drafted a spec',
      code: 'pushed code',
      spec_code: 'drafted a spec and pushed code',
      question: 'replied with a question',
      failed: 'failed — you can retry',
    }[n.detail] || 'finished';
    return {
      ...base,
      wrap: true,
      icon: failed ? '⚠️' : '\u{1F916}',
      segments: [
        { t: 'text', v: 'Proposal for' },
        { t: 'strong', v: n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue' },
        { t: 'text', v: 'in' },
        { t: 'strong', v: appLine },
        { t: 'text', v: verb },
      ],
      body: { text: outcomeText, medium: true, mention: false },
    };
  }

  // Someone commented in this user's dev session's public discussion —
  // before or after promotion. Second line previews the comment; the meta
  // line names the session (title ladder mirrors the other session-scoped
  // rows: sessionTitle → prTitle → branchName). Clicking opens the
  // discussion thread where the comment lives (see _onItemClick).
  if (n.kind === 'session_comment') {
    const sessionLabel = n.sessionTitle || n.prTitle || n.branchName || 'your dev session';
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4AC}',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: 'commented on' },
        { t: 'strong', v: sessionLabel },
        { t: 'text', v: 'in' },
        { t: 'strong', v: appLine },
      ],
      body: { text: (n.messageContent || '').slice(0, 140), medium: false, mention: true },
    };
  }

  // (#86) Private spec share: someone sent this user a spec version.
  // Clicking opens the app's group chat with the read-only spec panel
  // showing that exact version (see _onItemClick). Second line prefers
  // the session's title / PR title / branch name (already joined
  // server-side); the spec's own H1 appears as soon as the panel loads.
  if (n.kind === 'spec_shared') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4CB}',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: 'shared a spec with you in' },
        { t: 'strong', v: appLine },
      ],
      body: {
        text: n.sessionTitle || n.prTitle || n.branchName || `Spec v${n.detail || '?'}`,
        medium: true,
        mention: false,
      },
    };
  }

  // Collab-invite history rows (the actionable Accept/Decline buttons
  // live ONLY in the pinned Invites section, driven by pendingInvites —
  // once resolved this is just a plain history row).
  if (n.kind === 'collab_invite' || n.kind === 'collab_invite_accepted'
    || n.kind === 'approver_invite' || n.kind === 'approver_invite_accepted') {
    const verb = n.kind === 'collab_invite'
      ? 'invited you to collaborate on'
      : n.kind === 'collab_invite_accepted'
        ? 'accepted your invite to collaborate on'
        : n.kind === 'approver_invite'
          ? 'invited you to be an approver on'
          : 'accepted your approver invite on';
    return {
      ...base,
      mb: false,
      wrap: true,
      icon: n.kind === 'collab_invite' ? '✉️'
        : n.kind === 'approver_invite' ? '🗳️' : '✅',
      segments: [
        { t: 'who', v: who },
        { t: 'text', v: verb },
        { t: 'strong', v: appLine },
      ],
      body: null,
    };
  }

  // Mentions and replies. The only row whose meta line is NOT a flex row,
  // so its copy sits inline between the spans rather than in one.
  return {
    ...base,
    metaFlex: false,
    segments: [
      { t: 'who', v: who },
      {
        t: 'text',
        v: n.kind === 'mention' ? 'mentioned you in'
          : (n.kind === 'reply' ? 'replied to you in' : 'in'),
      },
      { t: 'strong', v: appLine },
    ],
    body: { text: (n.messageContent || '').slice(0, 140), medium: false, mention: true },
  };
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

// #1079 chunk B published this row builder on the object rather than leaving
// it in file scope: the cog drawer's "Needs attention" section rendered these
// very same per-kind rows, and once each module had its own scope inside the
// bundle it could no longer just call a neighbour's function.
//
// #1191 slice 6 conversion 4 then made what crosses here a DESCRIPTOR rather
// than an HTML string, so both drawers rendered the rows with one React
// component (NotificationRow in ./notifications-list.tsx).
//
// THE UI OVERHAUL retired the cog drawer and merged its pinned rows into this
// list, so there is one caller again. The seam stays as it is: the descriptor
// is what keeps ./notifications-list.tsx presentational, and it is what let the
// list be lifted wholesale into the hamburger without this module noticing.
Notifications._rowView = rowView;

// Published exactly where the classic <script> published it: at module
// evaluation, which for the React entry is still before DOMContentLoaded. The
// guard is for the SSG prerender pass, which evaluates this module in node.
// init() is called by the island's layout effect (see ./index.tsx) rather than
// from a DOMContentLoaded handler — that runs during hydration, i.e. EARLIER
// than the old handler did, so it still lands before app.js's init.
if (typeof window !== 'undefined') window.Notifications = Notifications;
