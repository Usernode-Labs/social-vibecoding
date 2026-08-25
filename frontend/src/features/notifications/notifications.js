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
// #1385 flat list: `items` stays the single newest-first source of truth, and
// the dropdown renders ONE ROW PER NOTIFICATION in that order — no per-app
// headers, no expand/collapse, no per-group leaf pager.
//
// It used to nest (#84): a collapsed header row per app carrying a count and
// the newest item's preview, expandable to reveal per-kind leaves, with the
// expansion set persisted to localStorage. That earned its keep when the
// drawer showed everything ever received, where one busy app could bury
// another's single row. Two later changes took the premise away —
// notifications arrive newest-first, and #1367's follow-up moved the READ ones
// behind "See older notifications", so the default list is only what is new.
// Grouping a short unread list by app costs a tap to read anything and buys
// nothing back. Every row also NAMES its own app in its text already (see
// rowView, which builds every kind's segments around `appLine`), so the header
// was repeating the row directly beneath it.
//
// Older pages still load through the keyset cursor (nextBefore/hasMore). The
// control that pulls them is now ONE button at the foot of the list instead of
// one inside each expanded group, and that relocation is load-bearing rather
// than cosmetic: `_showMoreGroup` was the only caller of `loadMore()` in the
// codebase, so removing the group chrome without replacing it would have
// stranded server pagination on page one.
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
  // Pagination cursor for the list's foot "Load older notifications" pager.
  nextBefore: null,  // { createdAt, id } | null
  hasMore: false,
  loading: false,
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
    // THE UI OVERHAUL merged the bell into the hamburger, so #notifications-btn
    // is gone and so is the outside-click dismissal that used to live here:
    // opening, closing and dismissing this list are all the drawer's business
    // now (features/header/header-menu-controller.js). What is left is the
    // "Mark all read" control, which is still this module's.
    const markAll = document.getElementById('notifications-mark-all');
    if (markAll) markAll.addEventListener('click', Notifications.markAllRead);

    // Every drawer open starts on the "new" list rather than wherever the last
    // visit left it: the drawer opens on what is NEW. This used to re-fold the
    // app groups on the same announcement; #1385 removed them, so the show-older
    // reset is all that is left of that pair.
    document.addEventListener('sv:drawer-open', () => {
      Notifications._setShowOlder(false);
    });

    // Anonymous SPA boot (fold-auth-pages-into-SPA): the initial fetch
    // waits for the authed boot stage instead of firing a guaranteed 401
    // on a sessionless document. `sv:authed` fires at most once.
    if (window.App && App.user) Notifications.refresh();
    else document.addEventListener('sv:authed',
      () => Notifications.refresh(), { once: true });
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
  //
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
    if (item.kind === 'openrouter_key_created' || item.kind === 'openrouter_key_review') {
      Notifications._dismissSheetForNav();
      if (typeof App !== 'undefined' && App.navigateToAdminConsole) {
        App.navigateToAdminConsole('users');
      } else {
        window.location.hash = '#admin/users';
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
    // TWO COUNTS, ONE SPLIT, TWO CONTROLS NOW.
    //
    // Green = the viewer's unread session-related notifications; red =
    // everything else (mentions/replies/reactions/kudos/votes) + pending
    // invites. The green count is split OUT of the red one so the two never
    // double-count, and each hides at zero — unchanged.
    //
    // What changed is where each lands. Both used to be spans on the
    // hamburger, which is what let one icon say "there are two different
    // reasons to open me". Sessions are not notifications and the drawer is
    // not where you go to look at one, so the green half moved onto
    // #improve-btn — where the sessions themselves are. The red half stays
    // here on the bell's drawer.
    //
    // It PUBLISHES rather than paints: that button is React-owned end to end,
    // and this module cannot import the store (two test files load it as a
    // classic script in a vm, where a top-level `import` is a syntax error —
    // the same constraint dev-chat.js documents). window.Improve is the seam.
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

    if (typeof window !== 'undefined' && window.Improve
      && typeof window.Improve.setSessionBadge === 'function') {
      window.Improve.setSessionBadge(aiUnread, Notifications._sessionDoneUnread());
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
  // ── New vs older (#1367 follow-up) ───────────────────────────────
  //
  // The drawer shows what is NEW. A notification you have already read has
  // done its job — it told you a thing — and leaving it in the list means the
  // one that arrived this morning is buried under three weeks of things you
  // have already dealt with. So the default list is the UNREAD ones, and the
  // read ones are one tap away behind "See older notifications".
  //
  // `readAt` is the existing server-side field and the existing meaning of
  // "viewed": it is set when you click a notification, when you use a group's
  // "Mark read", and by "Mark all read". Nothing new is stored, and nothing is
  // deleted — "go away" here means "leave the new list", which is why the
  // older view can always bring them back.
  //
  // Per drawer OPEN, not persisted: `sv:drawer-open` resets it to false (see
  // init), so a visit always starts on what is new.
  showOlder: false,

  _setShowOlder(next) {
    const value = !!next;
    if (Notifications.showOlder === value) return;
    Notifications.showOlder = value;
    if (Notifications.items.length) Notifications._renderList();
  },

  /** The controller entry point behind the footer button. */
  toggleOlder() {
    Notifications._setShowOlder(!Notifications.showOlder);
  },

  /** Every notification the bell owns, read or not. */
  _allBellItems() {
    return Notifications.items;
  },

  /** What the list actually renders: unread only, unless older is revealed. */
  _bellItems() {
    if (Notifications.showOlder) return Notifications.items;
    return Notifications.items.filter((n) => !n.readAt);
  },

  // One descriptor per notification, newest-first — the whole list, flat
  // (#1385). The list component owns every handler this method used to attach
  // by querySelectorAll: the row clicks, the foot pager and the touch swipe
  // tray. All of them still stopPropagation, for the reason they always did: a
  // re-render detaches the clicked node, and the document-level outside-click
  // handler would then see a target outside the panel and wrongly dismiss the
  // drawer.
  _renderList() {
    const store = Notifications._store;
    if (!store) return;
    const touch = isTouchNow();

    // How many read notifications the older view would add. Drives the footer
    // button's presence AND its count, and separates the two empty states
    // below: "nothing has ever arrived" is not the same as "you are caught
    // up", and telling a viewer the first when the second is true reads as
    // the drawer having lost their history.
    const olderCount = Notifications._allBellItems().filter((n) => n.readAt).length;

    if (Notifications._bellItems().length === 0) {
      // The pinned sections may still have content — only show the empty
      // hint when there's truly nothing in the drawer. #1280 added the
      // saved section to that "truly nothing" test: a drawer showing your
      // saved messages while telling you nothing has arrived yet reads as
      // a bug.
      store.set({
        list: [],
        // `empty` is still the ORIGINAL "you have never had a notification"
        // hint, so it now also requires that there be no older ones to
        // reveal — otherwise a fully-read drawer would claim nothing had
        // ever arrived while offering to show you what had.
        empty: Notifications.invites.length === 0
          && Notifications.saved.length === 0
          && olderCount === 0,
        // …and this is the new one: caught up, with history behind it.
        caughtUp: olderCount > 0 && !Notifications.showOlder,
        olderCount,
        showOlder: Notifications.showOlder,
        // Nothing to append a pager to — see the note in the populated branch.
        canLoadMore: false,
        loadingMore: false,
        touch,
      });
      return;
    }

    // Straight through, in `items` order. No partition and no re-sort: the
    // feed is already newest-first, and a flat list that reorders itself is
    // exactly the thing #1385 asked to stop. (Unread completion notifications
    // used to float to the top of the grouped list; see PRIORITY_KINDS.)
    store.set({
      list: Notifications._bellItems().map(rowView),
      empty: false,
      caughtUp: false,
      olderCount,
      showOlder: Notifications.showOlder,
      // The foot pager, and whether a page is already in flight. Offered only
      // when there are rows to append to — with none, the empty/caught-up hint
      // owns that space and the older-toggle is the affordance that belongs
      // there.
      canLoadMore: Notifications.hasMore,
      loadingMore: Notifications.loading,
      touch,
    });
  },

  /**
   * The list's foot pager: pull the next page of older notifications.
   *
   * This is the flat-list replacement for `_showMoreGroup`, which #1385
   * retired along with the group chrome it lived in. It is deliberately a
   * method rather than a direct `loadMore` binding on the button, because the
   * two are not the same thing: `loadMore()` is the transport (it no-ops while
   * a page is in flight, or once the cursor is exhausted) and this is the
   * user-facing action, which the drawer may later want to guard differently.
   *
   * There is NO client-side reveal cap any more. The old one existed to keep
   * an expanded group from unrolling thirty rows inside a collapsed list; a
   * flat list already shows what it has loaded, so a second cap on top of the
   * server's page size would only hide rows the viewer had already paid to
   * fetch. `loadMore()` re-renders on completion, so the arriving page simply
   * appears at the bottom.
   */
  loadOlder() {
    if (!Notifications.hasMore || Notifications.loading) return;
    Notifications.loadMore();
  },

};

const CONVERSATION_NOTIF_KINDS = new Set([
  'conversation_invite',
  'conversation_message',
  'conversation_mention',
  'conversation_reply',
  'conversation_reaction',
]);

// #161 defined these as the kinds that "demand attention": a finished dev
// session or headless run, while still unread.
//
// #1385 stopped the DRAWER acting on it. The pin was a grouped-list device — it
// floated an app's group above the others and led within it, which is also what
// made it the collapsed header's preview — and a flat list the request asked to
// be chronological cannot also reorder itself. Nothing was deleted: the set
// still drives DevChat's completion title through isPriorityNotif() below, and
// restoring a top-of-list pin is one stable partition in _renderList if the
// group decides it wants one.
//
// Deliberately limited to these two kinds; grow this set rather than adding a
// server-side priority column if more "priority" kinds emerge.
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


// #138: derive the title/body + deep-link fields for a completion alert
// (chime/OS notification) from a notification row. Mirrors the per-kind copy in
// rowView so the OS notification reads the same as the bell-menu entry. (It
// used to name previewText too — that was the collapsed group header's
// one-liner, which #1385 retired with the rest of the group chrome.)
function completionAlertInfo(n) {
  const appName = n.appName || 'your app';
  if (n.kind === 'auto_solve_done') {
    const issue = n.headlessIssueNumber ? `issue #${n.headlessIssueNumber}` : 'an issue';
    let title;
    let body;
    if (n.detail === 'failed') {
      title = 'Proposal failed';
      body = `Proposal for ${issue} in ${appName} failed. You can retry`;
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
    body: `Your dev session in ${appName} finished: ${label}`,
  };
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

  if (n.kind === 'openrouter_key_created' || n.kind === 'openrouter_key_review') {
    const review = n.kind === 'openrouter_key_review';
    return {
      ...base,
      wrap: true,
      icon: review ? '⚠️' : '🔑',
      segments: [
        { t: 'strong', v: who },
        { t: 'text', v: review
          ? 'has a company OpenRouter key that needs manual review'
          : 'received a company OpenRouter key' },
      ],
      body: {
        text: review
          ? 'Open Admin → Users to block or remove it if needed.'
          : 'Ownership, daily limit, status, and controls are in Admin → Users.',
        medium: false,
        mention: false,
      },
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
        { t: 'text', v: "is going stale, it'll auto-archive soon without votes" },
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
        { t: 'text', v: "can't merge, because its preview won't boot, so checks can't run" },
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

  // #1405 path A: your agent put work somewhere while you were away. The row
  // leads with the DESTINATION, because that is the part you cannot infer —
  // "submitted" is at a vote with checks running, "shared" is visible on the
  // Dev board with nobody being asked to decide anything.
  if (n.kind === 'connector_submitted') {
    const shared = n.detail === 'shared';
    return {
      ...base,
      wrap: true,
      icon: shared ? '\u{1F441}\uFE0F' : '\u{1F4E4}',
      segments: [
        { t: 'text', v: 'Your agent' },
        { t: 'text', v: shared ? 'shared work in progress in' : 'submitted work in' },
        { t: 'strong', v: appLine },
      ],
      body: {
        text: n.sessionTitle || n.prTitle || (n.prNumber ? `PR #${n.prNumber}` : 'your change'),
        medium: true,
        mention: false,
      },
    };
  }

  // #1405 path B: the agent asked you something and you have not answered.
  //
  // The copy says WHEN it was asked, never that you are currently being waited
  // on. Clearing depends on the agent calling back and it may forget, so "is
  // waiting on you" would be FALSE on the row you see after already replying —
  // and a notification making a false claim reads as broken. This phrasing
  // stays true either way, which is what makes a stale one merely redundant.
  if (n.kind === 'agent_awaiting_input') {
    return {
      ...base,
      wrap: true,
      icon: '\u{1F4AC}',
      segments: [
        { t: 'text', v: 'Claude asked you something' },
        ...(n.appName ? [{ t: 'text', v: 'in' }, { t: 'strong', v: appLine }] : []),
      ],
      body: { text: 'It is holding for your answer', medium: false, mention: false },
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
      failed: 'failed, you can retry',
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
