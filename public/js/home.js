const Home = {
  canCreate() {
    return !!App.user?.canCreateApps;
  },

  async load() {
    // Re-render guard: Home.load() is invoked from many WS/event paths
    // (app_status / app_update in app.js, notifications.js), any of
    // which would wholesale-replace the grid mid-drag and yank the
    // card out from under the user's pointer. Defer instead; the drag
    // handlers re-run load() when the gesture ends.
    if (Home._dragActive) {
      Home._reloadPending = true;
      return;
    }
    Home._probeShortcutSupport();
    const listEl = document.getElementById('app-list');

    try {
      // #194: the viewer's own open proposals ride along with the app
      // grid, and the viewer's own active dev sessions ride along the
      // same way. Both non-fatal — a failure just hides the section.
      // #405: forward ?demo=1 (preserved on the page URL) so the "Your
      // proposals" strip's canonical merge-lifecycle chips populate from the
      // staging demo fixtures. No-op outside a ?demo=1 staging preview.
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const [res, proposalsRes, sessionsRes] = await Promise.all([
        // ?demo=1 also rides on /api/apps: staging injects the icon-demo
        // tiles there (routes/apps.js demoIconApps). No-op in production.
        fetch(`/api/apps${demoQS}`),
        fetch(`/api/me/proposals${demoQS}`).catch(() => null),
        fetch('/api/me/active-sessions').catch(() => null),
      ]);
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      let myProposals = { proposals: [], governance: [] };
      try {
        if (proposalsRes && proposalsRes.ok) myProposals = await proposalsRes.json();
      } catch { /* section stays hidden */ }
      Home._myProposals = myProposals;
      let mySessions = [];
      try {
        if (sessionsRes && sessionsRes.ok) {
          const data = await sessionsRes.json();
          if (Array.isArray(data.sessions)) mySessions = data.sessions;
        }
      } catch { /* section stays hidden */ }
      Home._activeSessions = mySessions;
      // Busy spinners flip on turn start/finish, which doesn't broadcast
      // a session_update — keep them fresh with a slow poll while the
      // section has rows to show (see _syncSessionPolling).
      if (mySessions.some((s) => s.status === 'active')) Home._syncSessionPolling();

      Home._apps = apps;
      Home.render();
    } catch (err) {
      listEl.innerHTML = `<div class="p-4 text-red-400 text-sm">Failed to load apps</div>`;
    }
  },

  // ===== Rendering (from the Home._apps cache) =====
  //
  // load() fetches then renders; search keystrokes call render() alone,
  // re-deriving the grid from the cached list + Home._query with no
  // network round trip. The search input itself lives OUTSIDE #app-list
  // (see index.html) so these wholesale innerHTML re-renders never
  // destroy its focus/caret.
  _apps: [],
  _query: '',

  // "Your apps" = apps the viewer is a member of (creator or accepted
  // invite — the server's is_collaborator flag, see app_collaborators
  // in schema.sql) OR apps they manually added (a favorite row; the
  // old "star", now the menu's "Add to Your apps").
  isYours(app) {
    return !!(app && (app.is_collaborator || app.is_favorited));
  },

  // Split the full list into { yours, rest }. Personal ordering
  // (issue #128) inside "Your apps": explicit favorite_order first
  // (ascending), NULLs after. Array.prototype.sort is stable, so
  // returning 0 for two NULLs preserves the server's activity order
  // among un-ordered entries (member apps that were never dragged).
  partitionApps(apps) {
    const yours = (apps || []).filter(Home.isYours);
    const rest = (apps || []).filter((a) => !Home.isYours(a));
    yours.sort((x, y) => {
      if (x.favorite_order == null && y.favorite_order == null) return 0;
      if (x.favorite_order == null) return 1;
      if (y.favorite_order == null) return -1;
      return x.favorite_order - y.favorite_order;
    });
    return { yours, rest };
  },

  // Case-insensitive substring match on name and slug. An empty /
  // whitespace-only query matches everything (the default view).
  matchesQuery(app, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return String(app?.name || '').toLowerCase().includes(q)
      || String(app?.slug || '').toLowerCase().includes(q);
  },

  filterApps(apps, query) {
    return (apps || []).filter((a) => Home.matchesQuery(a, query));
  },

  render() {
    // Same deferral as load(): a search keystroke must not yank the
    // grid out from under an in-flight drag either.
    if (Home._dragActive) {
      Home._reloadPending = true;
      return;
    }
    const listEl = document.getElementById('app-list');
    const emptyEl = document.getElementById('empty-state');
    if (!listEl || !emptyEl) return;
    const canCreate = Home.canCreate();
    const apps = Home._apps || [];
    Home._wireSearch();
    // Nothing to search through with zero apps — hide the bar so the
    // empty state stays centered and uncluttered.
    const searchBar = document.getElementById('home-search-bar');
    if (searchBar) searchBar.classList.toggle('hidden', apps.length === 0);

    if (apps.length === 0) {
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      // Toggle the empty-state CTA vs. a "ask an admin" hint based on
      // whether this user is allowed to create. The static HTML in
      // index.html holds both children — we just flip visibility.
      Home.applyEmptyStateForPermissions(canCreate);
      // Only wire the create button when it's actually visible.
      // Wiring it for non-permitted users would do nothing because
      // the button is hidden, but skipping the call keeps the DOM
      // free of dangling listeners.
      if (canCreate) Home.wireCreateButtons();
      return;
    }

    emptyEl.classList.add('hidden');
    const query = (Home._query || '').trim();
    let html = '';
    let canDragYours = false;

    if (query) {
      // Active search: one flat grid of matches. The proposals /
      // sessions strips, section headers, create tile and drag
      // affordance all step aside until the query clears — reorder
      // is only meaningful against the sectioned view.
      const matches = Home.filterApps(apps, query);
      if (!matches.length) {
        html = `<div class="col-span-full py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No apps match &ldquo;${escapeHtml(query)}&rdquo;</div>`;
      } else {
        html = `<div class="home-section-header col-span-full">${matches.length} result${matches.length === 1 ? '' : 's'}</div>`;
        html += matches.map(Home.renderAppCard).join('');
      }
    } else {
      const { yours, rest } = Home.partitionApps(apps);
      // Reordering is meaningless with a single card — skip the grab
      // affordance and the drag wiring when there's only one.
      canDragYours = yours.length >= 2;
      html = Home.renderMyProposalsSection();
      html += Home.renderActiveSessionsSection();
      // iOS-in-app only: mirror of the homescreen widget's pinned grid,
      // manageable in place (drag in / reorder / ✕). Empty string
      // everywhere else — see _widgetUiActive.
      html += Home.renderWidgetSection();
      if (yours.length) {
        html += '<div class="home-section-header col-span-full">Your apps</div>';
        // Tag the cards at render time: data-yours drives both the
        // drag wiring's selector and the long-press menu→drag
        // promotion; cursor-grab replaces cursor-pointer as the
        // discoverability hint when reordering is possible.
        html += yours.map((a) => {
          let card = Home.renderAppCard(a);
          card = card.replace('class="app-card ', 'data-yours="true" class="app-card ');
          if (canDragYours) card = card.replace('cursor-pointer', 'cursor-grab');
          return card;
        }).join('');
        html += '<div class="home-section-header col-span-full mt-2">All Apps</div>';
      }
      html += rest.map(Home.renderAppCard).join('');
      html += canCreate ? Home.renderCreateTile() : '';
    }

    listEl.innerHTML = html;
    if (!query && canCreate) Home.wireCreateButtons();
    Home._wireCards(listEl, canDragYours);
    Home._wireWidgetStrip(listEl);
  },

  // ===== Search bar =====
  //
  // Bound once, lazily, from render() — the input is static markup in
  // index.html so there's no per-render listener churn and no focus
  // loss. ~100ms debounce is plenty; the list is small and filtering
  // is a pure client-side re-render.
  _searchWired: false,
  _searchDebounce: null,

  _wireSearch() {
    if (Home._searchWired) return;
    const input = document.getElementById('home-search-input');
    const clearBtn = document.getElementById('home-search-clear');
    if (!input) return;
    Home._searchWired = true;
    const apply = () => {
      Home._query = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
      Home.render();
    };
    input.addEventListener('input', () => {
      clearTimeout(Home._searchDebounce);
      Home._searchDebounce = setTimeout(apply, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        clearTimeout(Home._searchDebounce);
        apply();
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearTimeout(Home._searchDebounce);
        apply();
        input.focus();
      });
    }
  },

  // ===== Per-render card wiring =====

  _wireCards(listEl, canDragYours) {
    // Cards already in the widget aren't drag-into-widget candidates —
    // computed once per render, not per card.
    const widgetSlugs = Home._widgetUiActive() ? Home._widgetSlugs() : null;
    listEl.querySelectorAll('.app-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        // A completed drag (or a long-press that opened the menu) ends
        // with the pointer still on the card, so the browser fires a
        // click right after pointerup — eat it so the gesture doesn't
        // also open the app.
        if (Home._suppressClick) {
          Home._suppressClick = false;
          return;
        }
        if (
          e.target.closest('.retry-btn') ||
          e.target.closest('.card-menu-btn')
        ) return;
        // Disabled while spinning up / errored — there's no iframe or
        // chat history to render and the WS `app_status` handler will
        // re-bind the card as soon as the container goes live.
        if (card.dataset.status !== 'running' && card.dataset.status !== 'awaiting_secrets') return;
        App.navigateToApp(card.dataset.slug);
      });
      // One pointerdown handler per card: touch long-press opens the
      // actions menu everywhere, and "Your apps" cards additionally
      // promote to drag-to-reorder (mouse-move, or held-move on touch).
      // When the widget strip is showing, every running card not yet in
      // the widget can also be picked up and dropped onto the strip.
      card.addEventListener('pointerdown', (e) => Home._onCardPointerDown(
        e, card, listEl,
        canDragYours && card.dataset.yours === 'true',
        !!widgetSlugs
          && card.dataset.status === 'running'
          && !widgetSlugs.has(card.dataset.slug)
      ));
    });

    // Retry stays visible on errored cards (it's the card's primary
    // recovery action); it is also offered in the hamburger menu.
    listEl.querySelectorAll('.retry-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.textContent = '...';
        await fetch(`/api/apps/${btn.dataset.slug}/retry`, { method: 'POST' });
        Home.load();
      });
    });

    listEl.querySelectorAll('.card-menu-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home.openCardMenu(btn.dataset.slug, btn.getBoundingClientRect());
      });
    });
  },

  // Map structured drift-check result → a short, user-readable
  // message. Mirrors the status enum in main-drift-poller.js.
  reportCheckResult(data) {
    if (!data || !data.status) {
      alert('Check finished (no details returned).');
      return;
    }
    switch (data.status) {
      case 'no_drift':
        // The check-updates button is git-drift-only. When SHA hasn't
        // moved but the operator still wants a rebuild (env vars
        // changed, platform code changed, container needs reset),
        // offer a one-click escape hatch into the unconditional
        // /redeploy endpoint instead of dead-ending. The Secrets
        // modal also exposes this same endpoint via "redeploy now",
        // but most operators reach for the home-card ⟳ first.
        if (data.slug && confirm(
          'Latest commit is already running.\n\n' +
          'Force a rebuild anyway? (Useful if env vars or platform code changed.)'
        )) {
          fetch(`/api/apps/${data.slug}/redeploy`, { method: 'POST' })
            .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
            .then(() => alert('Rebuild started — watch the version pill.'))
            .catch((err) => alert(`Rebuild kickoff failed: ${err.message}`));
        }
        return;
      case 'redeployed':
        alert(`Redeployed to ${(data.to || '').slice(0, 7)}.`);
        return;
      case 'in_flight':
        alert('A redeploy is already in progress for this app.');
        return;
      case 'first_seen':
        alert(`Recorded current SHA (${(data.sha || '').slice(0, 7)}). Future drift will trigger a redeploy.`);
        return;
      case 'fetch_failed':
        alert(`Couldn't reach GitHub: ${data.error || 'unknown error'}`);
        return;
      case 'invalid_repo':
        alert('This app has an invalid repo URL.');
        return;
      case 'rebuild_failed':
        alert(`Drift detected (${(data.from || '').slice(0, 7)} → ${(data.attempted || '').slice(0, 7)}) but redeploy failed: ${data.error || 'unknown error'}`);
        return;
      default:
        alert(`Check finished: ${data.status}`);
    }
  },

  // #194: "Your proposals" — one compact row per proposal the viewer
  // currently has open for voting, across all apps. Hidden when empty.
  // Rendered above the Your apps / All Apps sections inside the #app-list
  // grid (col-span-full rows, same section-header pattern). Each row
  // deep-links to the proposal's detail in that app's Proposals tab;
  // refreshed live via the vote_update / session_update WS events
  // (App.refreshHomeProposals → Home.load).
  _myProposals: { proposals: [], governance: [] },

  renderMyProposalsSection() {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const data = Home._myProposals || {};
    const prs = Array.isArray(data.proposals) ? data.proposals : [];
    const govs = Array.isArray(data.governance) ? data.governance : [];
    if (!prs.length && !govs.length) return '';

    const pill = (yes, majority, state) => {
      const cls = state === 'merging'
        ? 'bg-amber-500/10 text-amber-500'
        : (yes >= majority ? 'bg-emerald-500/10 text-emerald-500' : 'bg-violet-500/10 text-violet-400');
      return `<span class="inline-flex items-center text-[0.7rem] font-mono font-medium px-1.5 py-0.5 rounded ${cls}">${yes} / ${majority}</span>`;
    };

    // #405: the merge-status chip is now driven by the shared MergeStatus
    // lifecycle helper so the home strip surfaces the SAME canonical states
    // as the proposal feed card and the dev session header — including the
    // resolving / "Passed — merging shortly" / merging states the bespoke
    // chips here used to drop. The vote pill still carries the tally, so the
    // in-vote/draft states render no extra chip (the pill already says it).
    const lifeChip = (p) => {
      if (!(window.MergeStatus && MergeStatus.lifecycle)) return '';
      const life = MergeStatus.lifecycle(p);
      if (!life || ['in_vote', 'draft', 'none'].indexOf(life.key) !== -1) return '';
      return `<span class="shrink-0">${MergeStatus.badgeHtml(life)}</span>`;
    };

    let rows = '';
    for (const p of prs) {
      const title = p.pr_title || `PR #${p.pr_number || p.id}`;
      rows += `
        <a href="#app/${esc(p.app_slug)}/dev/proposals/${p.id}"
           class="col-span-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-violet-500/50 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(p.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(title)}</span>
          ${lifeChip(p)}
          ${pill(parseInt(p.yes_count) || 0, p.majority || 1, p.status)}
        </a>`;
    }
    for (const g of govs) {
      rows += `
        <a href="#app/${esc(g.app_slug)}/dev/proposals"
           class="col-span-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-violet-500/50 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(g.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(g.title)}</span>
          ${pill(parseInt(g.up_count) || 0, g.majority || 1, 'open')}
          <span class="text-[0.65rem] font-medium text-violet-400 uppercase">In vote</span>
        </a>`;
    }

    return '<div class="home-section-header col-span-full">Your proposals</div>' + rows;
  },

  // "Your active sessions" — one compact row per dev session the viewer
  // currently has in 'active' status, across all apps. Promoted rows are
  // deliberately absent (they render in "Your proposals" just above) and
  // paused rows are idle by definition, so this stays a "what's in
  // progress right now" list. Hidden when empty. Same col-span-full row
  // pattern as the proposals strip; each row deep-links straight into
  // its session via the #app/{slug}/dev/sessions/{id} hash route.
  _activeSessions: [],

  renderActiveSessionsSection() {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const all = Array.isArray(Home._activeSessions) ? Home._activeSessions : [];
    const active = all.filter((s) => s.status === 'active');
    if (!active.length) return '';

    // Busy-first on top of the server's last_activity_at DESC order
    // (Array.prototype.sort is stable, so within each busy bucket the
    // activity order is preserved). Cap at 10 — the per-user slot caps
    // keep the real-world count small, this is just a safety bound.
    const shown = [...active]
      .sort((a, b) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0))
      .slice(0, 10);

    let rows = '';
    for (const s of shown) {
      const title = s.session_title || s.pr_title || s.branch_name || `Session #${s.id}`;
      const rel = formatRelativeTime(s.last_activity_at || s.created_at);
      const busyTag = s.busy
        ? '<span class="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0"><span class="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>working…</span>'
        : '';
      const timeTag = rel
        ? `<span class="text-[0.7rem] text-zinc-400 dark:text-zinc-500 shrink-0">${esc(rel)}</span>`
        : '';
      rows += `
        <a href="#app/${esc(s.app_slug)}/dev/sessions/${s.id}"
           class="col-span-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-violet-500/50 transition-colors">
          <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate">${esc(s.app_name)}</span>
          <span class="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">${esc(title)}</span>
          ${timeTag}
          ${busyTag}
        </a>`;
    }

    return '<div class="home-section-header col-span-full">Your active sessions</div>' + rows;
  },

  // Slow refresh tick for the active-sessions busy spinners while the
  // home screen is visible (same 15s cadence as AppView's dev-sessions
  // strip poll). Turn start/finish doesn't broadcast a session_update,
  // so without this a spinner would only flip on the next WS-driven
  // reload. Self-clears when the home screen is hidden; Home.load()'s
  // _dragActive guard keeps the tick from re-rendering mid-drag.
  _sessionPollTimer: null,

  _syncSessionPolling() {
    if (Home._sessionPollTimer) return;
    Home._sessionPollTimer = setInterval(() => {
      const homeScreen = document.getElementById('home-screen');
      const hasActive = (Home._activeSessions || []).some((s) => s.status === 'active');
      // Stop ticking when home is hidden or the section emptied out —
      // with no active rows there's no spinner to refresh, and any new
      // or resumed session re-arms the poll via the session_update
      // WS event → Home.load() path.
      if (!homeScreen || homeScreen.classList.contains('hidden') || !hasActive) {
        clearInterval(Home._sessionPollTimer);
        Home._sessionPollTimer = null;
        return;
      }
      Home.load();
    }, 15000);
  },

  // Pill builder for an app's status/activity flags, rendered ONLY in
  // the hamburger menu's build-info header now — the card face
  // carries no chips. Order: missing secrets (most urgent), PRs
  // awaiting votes, dev sessions in flight, open issues, privacy chip
  // last. All display-only spans. Returns joined HTML, '' when
  // there's nothing to flag.
  //
  // Development-activity counts (#57) come straight from /api/apps
  // (DB-derived, no GitHub calls); zero-count chips are dropped. The
  // missing-secrets chip deliberately omits the key NAMES — those
  // live in the app view's Secrets panel.
  renderAppPillsHtml(app) {
    const openPrs = parseInt(app.open_prs || 0);
    const activeSessions = parseInt(app.active_sessions || 0);
    const openIssues = parseInt(app.open_issues || 0);
    const hasMissing = Array.isArray(app.missingSecrets) && app.missingSecrets.length;
    const chipDefs = [];
    if (hasMissing) {
      const n = app.missingSecrets.length;
      chipDefs.push({
        cls: 'bg-red-500/10 text-red-500',
        label: 'Missing secrets',
        tip: `${n} required secret${n === 1 ? '' : 's'} unset — set values in the app's Secrets panel`,
      });
    }
    if (openPrs > 0) {
      chipDefs.push({
        cls: 'bg-amber-500/10 text-amber-500',
        label: `${openPrs} to vote`,
        tip: `${openPrs} change${openPrs === 1 ? '' : 's'} awaiting community votes`,
      });
    }
    if (activeSessions > 0) {
      chipDefs.push({
        cls: 'bg-sky-500/10 text-sky-500',
        label: `${activeSessions} in dev`,
        tip: `${activeSessions} build session${activeSessions === 1 ? '' : 's'} in progress`,
      });
    }
    if (openIssues > 0) {
      chipDefs.push({
        cls: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400',
        label: `${openIssues} issue${openIssues === 1 ? '' : 's'}`,
        tip: `${openIssues} open issue${openIssues === 1 ? '' : 's'}`,
      });
    }
    const chipBaseCls = 'activity-chip inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium';
    const chipsHtml = chipDefs.map((c) =>
      `<span class="${chipBaseCls} ${c.cls}" title="${c.tip}">${c.label}</span>`
    ).join('');

    // Visibility chip for non-default settings. View-private dominates
    // (it implies collab-private); collab-private alone reads as
    // "invite-only build" since anyone can still see/use the app.
    // Inline currentColor SVGs (Heroicons v1 outline) instead of emoji
    // so the glyphs tint violet with the chip in both themes.
    const visChipCls = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-violet-500/10 text-violet-500 dark:text-violet-400';
    const visChipIcon = (d) => `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
    const lockIcon = visChipIcon('M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z');
    const mailIcon = visChipIcon('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z');
    const visChipHtml = app.view_visibility === 'private'
      ? `<span class="${visChipCls}" title="Only collaborators can see and use this app">${lockIcon} Private</span>`
      : (app.collab_visibility === 'private'
        ? `<span class="${visChipCls}" title="Anyone can use this app; only invited collaborators can build it">${mailIcon} Invite-only build</span>`
        : '');

    return `${chipsHtml}${visChipHtml}`;
  },

  // Icon-tile inner markup + kind, shared by renderAppCard and the
  // targeted icon_changed refresh (updateAppCardIcon below). Priority:
  // custom image (dapp.json icon.image, served via /app-icons/:id or a
  // staging demo data-URI) > emoji (dapp.json icon.emoji) > the
  // first-letter fallback every app always had. The kind lands on the
  // tile as data-icon so tests and the rename handler (app.js) can tell
  // a custom icon from the letter placeholder.
  iconTileFor(app) {
    if (app.icon_url) {
      return {
        kind: 'image',
        html: `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-14 h-14 rounded-xl object-cover">`,
      };
    }
    if (app.icon_emoji) {
      return {
        kind: 'emoji',
        html: `<span class="text-3xl leading-none" aria-hidden="true">${escapeHtml(app.icon_emoji)}</span>`,
      };
    }
    return { kind: 'letter', html: escapeHtml((app.name || '?').charAt(0).toUpperCase()) };
  },

  renderAppCard(app) {
    const isAwaiting = app.status === 'awaiting_secrets';
    // The status dot is the home tile's single signal for "this app
    // is doing something right now" — so an in-flight redeploy on an
    // already-running app flips the dot back to its pulsing-yellow
    // state, even though `app.status` is still 'running'. This is
    // what makes it safe to render the per-app pill in `quiet` mode
    // below (it skips the yellow `--deploying` modifier and stays a
    // border-only chip; the dot carries the signal instead).
    const isInFlightDeploy = !!(app.deployProgress && app.deployProgress.deploying);
    const statusClass = isInFlightDeploy ? 'creating'
      : app.status === 'running' ? 'running'
      : app.status === 'creating' ? 'creating'
      : isAwaiting ? 'creating'
      : 'error';
    const statusLabel = app.status === 'running' ? ''
      : app.status === 'creating' ? 'Spinning up...'
      : isAwaiting ? 'Awaiting secrets'
      : 'Error';
    const isError = app.status === 'error';
    const isRunning = app.status === 'running';
    // The active-users count (the same sticky 10-day rule as the
    // group-chat dashboard tile — see src/services/active-users.js —
    // so the home card and the dashboard agree) renders as a compact
    // badge beside the title; the tooltip spells it out.
    const activeUsers = parseInt(app.active_users || 0);
    // Awaiting-secrets cards stay clickable so the user can open the
    // app view + Secrets modal to fill values; other non-running
    // statuses show no app surface.
    const cursorClass = (isRunning || isAwaiting) ? 'cursor-pointer' : 'cursor-not-allowed opacity-70';

    // Per-tile sections, computed up front so the template stays
    // readable. Anything that may be empty is collapsed to '' so the
    // tile self-trims without leaving stray padding.
    //
    // The warning line is status-only: the missing-secret detail (and
    // every other pill — to vote / in dev / issues / privacy) lives
    // ONLY in the hamburger menu's build-info header now
    // (renderMenuHeaderHtml → renderAppPillsHtml); the card face
    // carries no chips at all.
    const warningHtml = statusLabel
      ? `<p class="text-xs mt-0.5 ${isAwaiting ? 'text-amber-500' : 'text-yellow-500'}">${statusLabel}</p>`
      : '';

    // Active-users badge beside the title: a tiny person glyph + the
    // bare count, neutral grey, display-only. Always rendered (0
    // included) so the signal is uniform across cards.
    const usersBadgeHtml = `
      <span class="users-badge inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 shrink-0" title="${activeUsers} active user${activeUsers === 1 ? '' : 's'}"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>${activeUsers}</span>`;

    // Hamburger actions-menu trigger, rendered as a round badge
    // overlapping the icon's top-right corner — always in that spot
    // (secondary actions live in the popover it opens; see
    // openCardMenu). Retry on errored cards is the one inline
    // exception: the card's primary recovery action pins to the
    // card's top-right corner (creator-or-full-admin, same gate as
    // before — view-only admins excluded, issue #311).
    const showRetry = isError && (App.user?.canAdminWrite || App.user?.id === app.created_by);
    const isLocked = !!app.locked;
    const menuBadgeHtml = `
      <button class="card-menu-btn absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors" data-slug="${app.slug}" title="App actions" aria-label="App actions" aria-haspopup="menu"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>`;
    const retryHtml = showRetry
      ? `<button class="retry-btn absolute top-2 right-2 text-xs text-emerald-500 hover:text-emerald-400 px-2 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors" data-slug="${app.slug}">Retry</button>`
      : '';

    const icon = Home.iconTileFor(app);

    // Layout: icon first at the top (hamburger badged on its corner),
    // title row centered below it (name + status dot + active-users
    // badge), then the status warning when present. Everything is
    // horizontally centered in the tile — homescreen-launcher style —
    // and the card draws NO border: the violet hover/drop-slot tint
    // (.app-card:hover in app.css) is the affordance. The title row
    // is width-capped (max-w-full + min-w-0) so long names truncate
    // with an ellipsis instead of stretching the layout.
    //
    // Every card carries app-card-draggable + touch-pan-y (not just
    // the reorderable ones): the long-press actions menu applies to
    // every card, so text selection / the mobile callout must be
    // suppressed card-wide, while touch-pan-y keeps vertical
    // scrolling alive until a long-press actually fires (see app.css).
    return `
      <div class="app-card app-card-draggable touch-pan-y relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-2 ${cursorClass}" data-slug="${app.slug}" data-status="${app.status}" data-locked="${isLocked}">
        ${retryHtml}
        <div class="relative w-14 h-14 shrink-0">
          <div class="w-14 h-14 rounded-xl bg-violet-600/20 overflow-hidden flex items-center justify-center text-violet-400 font-bold text-xl" data-icon="${icon.kind}">
            ${icon.html}
          </div>
          ${menuBadgeHtml}
        </div>
        <div class="w-full min-w-0">
          <div class="flex items-center justify-center gap-1.5 min-w-0 max-w-full">
            <span class="font-medium text-sm truncate min-w-0">${escapeHtml(app.name)}</span>
            <span class="status-dot ${statusClass} shrink-0" title="${app.status}"></span>
            ${usersBadgeHtml}
          </div>
          ${warningHtml}
        </div>
      </div>
    `;
  },

  // "Your app here" placeholder rendered as the last tile in the
  // grid. Layout mirrors a real tile (thumbnail + title row, pill
  // stacked on the left) but with a dashed violet border + violet
  // thumbnail to telegraph "this slot is empty, tap to fill it".
  // The click target is just the inner pill (.home-create-btn,
  // wired in Home.wireCreateButtons) — clicking the surrounding
  // tile chrome is intentionally inert so the tile reads as
  // "decorative frame around a button" rather than "button-shaped
  // hover surface". Hover/active styles live on the pill itself.
  renderCreateTile() {
    return `
      <div class="home-create-tile rounded-xl bg-violet-500/[0.02] dark:bg-violet-500/[0.04] p-3 flex flex-col items-center text-center gap-2">
        <div class="w-14 h-14 rounded-xl bg-violet-600/20 flex items-center justify-center text-violet-400 font-bold text-xl shrink-0">
          Y
        </div>
        <div class="italic text-sm text-zinc-500 dark:text-zinc-400 truncate max-w-full">Your app here</div>
        <button type="button" class="home-create-btn inline-flex items-center gap-2 rounded-full border border-violet-500 dark:border-violet-400 px-4 py-2 text-sm font-medium text-violet-600 dark:text-violet-400 bg-white dark:bg-zinc-900 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create new app
        </button>
      </div>`;
  },

  // ── Usernode widget section (iOS in-app only) ──────────────────────
  //
  // A strip above "Your apps" mirroring the pinned grid the iOS
  // homescreen widget renders. Tiles are the device registry, in widget
  // order; entries pinned by other dapps show up too (letter icon, no
  // SV app match) and are just as removable/reorderable.
  // Toggled by the ⓘ button in the section header; survives re-renders
  // within the session like _widgetSectionVisible.
  _widgetHelpVisible: false,

  renderWidgetSection() {
    if (!Home._widgetUiActive()) return '';
    const items = Home._widgetItems;
    const tiles = items.map((it) => Home.renderWidgetTile(it)).join('');
    const hint = items.length
      ? 'Drag tiles to reorder. Drag app cards here to add them.'
      : 'Drag an app card here (or use its menu) to add it to the Usernode widget on your home screen.';
    const helpPanel = Home._widgetHelpVisible
      ? `
      <div id="widget-help-panel" class="w-full text-[0.7rem] leading-relaxed text-zinc-600 dark:text-zinc-300 rounded-lg bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 px-3 py-2">
        <span class="font-medium">Add the widget to your home screen:</span>
        touch and hold an empty area of your iPhone home screen, tap
        <span class="font-medium">Edit</span> → <span class="font-medium">Add Widget</span>
        (or the <span class="font-medium">+</span>), search for
        <span class="font-medium">Usernode</span>, pick a size and tap
        <span class="font-medium">Add Widget</span>. The apps below appear on it automatically.
      </div>`
      : '';
    return `
      <div class="home-section-header col-span-full flex items-center justify-between">
        <span class="flex items-center gap-1.5">Usernode widget
          <button id="widget-section-help" class="w-4 h-4 flex items-center justify-center rounded-full text-zinc-400 dark:text-zinc-500 hover:text-violet-500 dark:hover:text-violet-400 transition-colors" title="How to add the widget to your home screen" aria-label="How to add the widget to your home screen" aria-expanded="${Home._widgetHelpVisible}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </button>
        </span>
        <button id="widget-section-close" class="flex items-center gap-1 text-xs font-normal normal-case tracking-normal text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors" title="Close the widget section" aria-label="Close the widget section">Done
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        </button>
      </div>
      <div id="widget-strip" class="col-span-full flex flex-wrap items-start gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 p-3 transition-colors">
        ${helpPanel}
        ${tiles}
        <div class="widget-strip-hint w-full text-[0.7rem] text-zinc-500 dark:text-zinc-400 ${items.length ? '' : 'py-3 text-center'}">${hint}</div>
      </div>`;
  },

  renderWidgetTile(item) {
    const slug = Home._widgetSlugFor(item);
    const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
    const name = (app && app.name) || item.name || '?';
    let iconHtml;
    if (app && app.icon_url) {
      iconHtml = `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-10 h-10 rounded-lg object-cover">`;
    } else if (app && app.icon_emoji) {
      iconHtml = `<span class="text-xl leading-none" aria-hidden="true">${escapeHtml(app.icon_emoji)}</span>`;
    } else {
      iconHtml = escapeHtml(String(name).charAt(0).toUpperCase());
    }
    // touch-pan-y + select-none for the same reason as app cards: keep
    // vertical scroll native until the tile drag actually claims the
    // gesture (see _onWidgetTilePointerDown).
    return `
      <div class="widget-tile app-card-draggable touch-pan-y relative flex flex-col items-center gap-1 w-16 cursor-grab" data-wid="${escapeHtml(item.id)}"${slug ? ` data-wslug="${escapeHtml(slug)}"` : ''}>
        <div class="w-10 h-10 rounded-lg bg-violet-600/20 overflow-hidden flex items-center justify-center text-violet-400 font-bold text-base">${iconHtml}</div>
        <span class="text-[0.65rem] leading-tight truncate w-full text-center">${escapeHtml(name)}</span>
        <button class="widget-remove-btn absolute -top-1.5 right-0 w-5 h-5 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-[0.6rem] text-zinc-500 dark:text-zinc-300 hover:text-red-500" data-wid="${escapeHtml(item.id)}" title="Remove from widget" aria-label="Remove ${escapeHtml(name)} from widget">✕</button>
      </div>`;
  },

  _wireWidgetStrip(listEl) {
    const strip = listEl.querySelector('#widget-strip');
    if (!strip) return;
    // "Done": hide the section again. State on the device is untouched —
    // "Add/Edit in Usernode widget" brings it back.
    const closeBtn = listEl.querySelector('#widget-section-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home._widgetSectionVisible = false;
        Home._widgetHelpVisible = false;
        Home.render();
      });
    }
    const helpBtn = listEl.querySelector('#widget-section-help');
    if (helpBtn) {
      helpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home._widgetHelpVisible = !Home._widgetHelpVisible;
        Home.render();
      });
    }
    strip.querySelectorAll('.widget-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home._removeWidgetItem(btn.dataset.wid);
      });
    });
    strip.querySelectorAll('.widget-tile').forEach((tile) => {
      tile.addEventListener('pointerdown', (e) =>
        Home._onWidgetTilePointerDown(e, tile, strip));
    });
  },

  // Optimistic remove: the tile disappears immediately; on bridge
  // failure the registry is re-fetched so the UI snaps back to device
  // truth (same optimistic-then-revert shape as _menuToggleFavorite).
  async _removeWidgetItem(id) {
    Home._widgetItems = (Home._widgetItems || []).filter((it) => it.id !== id);
    Home.render();
    try {
      await window.usernode.removeHomeScreenShortcut(id);
    } catch (err) {
      alert(`Remove from widget failed: ${(err && err.message) || err}`);
      await Home._refreshWidgetItems();
      Home.render();
    }
  },

  // Persist whatever order the strip currently shows. The app answers
  // with the authoritative order (unknown ids dropped, missing ids
  // appended), which we mirror back into _widgetItems.
  async _saveWidgetOrder(strip) {
    const ids = [...strip.querySelectorAll('.widget-tile')].map((t) => t.dataset.wid);
    const byId = new Map((Home._widgetItems || []).map((it) => [it.id, it]));
    Home._widgetItems = ids.map((id) => byId.get(id)).filter(Boolean);
    try {
      await window.usernode.reorderHomeScreenShortcuts(ids);
    } catch (err) {
      alert(`Widget reorder failed: ${(err && err.message) || err}`);
      await Home._refreshWidgetItems();
      Home.render();
    }
  },

  // Drag-to-reorder for widget tiles. A slimmed-down cousin of the app
  // card drag below: same ghost-plus-in-flow-slot idea, but tiles are
  // small and live in one flex row, so there's no FLIP animation or
  // edge auto-scroll. Mouse promotes on >6px movement; touch arms
  // after a ~250ms hold (no actions menu on tiles, so the hold goes
  // straight to pickup).
  _onWidgetTilePointerDown(e, tile, strip) {
    if (e.button !== 0) return;
    if (Home._dragActive) return;
    if (e.target.closest('.widget-remove-btn')) return;
    // Only one tile: nothing to reorder.
    if (strip.querySelectorAll('.widget-tile').length < 2) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType === 'touch';
    let armed = !isTouch;
    let dragging = false;
    let longPressTimer = null;
    let ghost = null;
    let grabX = 0;
    let grabY = 0;

    if (isTouch) {
      longPressTimer = setTimeout(() => {
        armed = true;
        tile.style.transform = 'scale(1.08)';
      }, 250);
    }
    const onTouchMove = (ev) => { if (dragging || armed) ev.preventDefault(); };
    const onContextMenu = (ev) => { if (dragging || armed) ev.preventDefault(); };
    if (isTouch) {
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('contextmenu', onContextMenu);
    }

    const beginDrag = (refX, refY) => {
      dragging = true;
      Home._dragActive = true;
      grabX = refX;
      grabY = refY;
      try { strip.setPointerCapture(pointerId); } catch {}
      const rect = tile.getBoundingClientRect();
      ghost = tile.cloneNode(true);
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        zIndex: '1000',
        pointerEvents: 'none',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.3)',
        transform: 'scale(1.04)',
        transition: 'none',
      });
      document.body.appendChild(ghost);
      // Same drop-slot treatment as app-card drags: contents hidden,
      // box restyled as a dashed violet gap (inline styles so the look
      // doesn't depend on the CDN JIT mid-gesture).
      tile.style.transform = '';
      for (const child of tile.children) child.style.visibility = 'hidden';
      Object.assign(tile.style, {
        borderWidth: '1px',
        borderStyle: 'dashed',
        borderColor: 'rgba(139, 92, 246, 0.55)',
        backgroundColor: 'rgba(139, 92, 246, 0.07)',
        borderRadius: '0.75rem',
      });
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      document.body.style.cursor = 'grabbing';
    };

    const detach = () => {
      clearTimeout(longPressTimer);
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('contextmenu', onContextMenu);
      try { strip.releasePointerCapture(pointerId); } catch {}
    };

    const teardown = () => {
      if (ghost) { ghost.remove(); ghost = null; }
      tile.style.transform = '';
      for (const child of tile.children) child.style.visibility = '';
      tile.style.borderWidth = '';
      tile.style.borderStyle = '';
      tile.style.borderColor = '';
      tile.style.backgroundColor = '';
      tile.style.borderRadius = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.body.style.cursor = '';
      Home._dragActive = false;
      if (Home._reloadPending) {
        Home._reloadPending = false;
        Home.load();
      }
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!armed) {
          // Finger moved before the hold armed the drag → scrolling.
          if (dist > 10) detach();
          return;
        }
        if (dist > (isTouch ? 10 : 6)) beginDrag(ev.clientX, ev.clientY);
        if (!dragging) return;
      }
      ev.preventDefault();
      ghost.style.transform =
        `translate(${ev.clientX - grabX}px, ${ev.clientY - grabY}px) scale(1.08)`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest('.widget-tile');
      if (!over || over === tile || !strip.contains(over)) return;
      const rect = over.getBoundingClientRect();
      if (ev.clientX < rect.left + rect.width / 2) {
        if (tile.nextElementSibling !== over) over.before(tile);
      } else {
        if (over.nextElementSibling !== tile) over.after(tile);
      }
    };

    const onUp = async (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      if (!didDrag) { teardown(); return; }
      teardown();
      await Home._saveWidgetOrder(strip);
    };

    const onCancel = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      teardown();
      // Abort without persisting — re-render restores the saved order.
      if (didDrag) Home.render();
    };

    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onCancel);
  },

  // Targeted lock-state refresh for a single app card, called from the
  // WS app_update handler (app.js handleAppUpdate) and the menu's own
  // toggle. The menu is built lazily from the Home._apps cache at open
  // time, so keeping the cache + the card's data-locked attribute fresh
  // is all that's needed — no live button swap, and no full Home.load()
  // that would blow away hover/scroll state on other cards. Safe no-op
  // if the card isn't mounted (different screen, not loaded yet, etc.).
  updateAppCardLock(slug, isLocked) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (app) app.locked = !!isLocked;
    const card = document.querySelector(`.app-card[data-slug="${slug}"]`);
    if (card) card.dataset.locked = String(!!isLocked);
  },

  // ── Native homescreen-shortcut support ─────────────────────────────
  //
  // Probed once per page via the bridge (usernode-bridge.js is loaded
  // by index.html). The bridge resolves { mechanism: "unsupported" } in
  // plain browsers AND on old app builds (it races the native call
  // against a timeout), so this never hangs — worst case the cache just
  // stays null and the menu item doesn't render. Fired from load(), so
  // it has long settled by the time a user opens a card menu.
  _shortcutSupport: null,
  _shortcutProbeStarted: false,
  _probeShortcutSupport() {
    if (Home._shortcutProbeStarted) return;
    Home._shortcutProbeStarted = true;
    const bridge = window.usernode;
    if (!bridge || typeof bridge.getHomeScreenShortcutSupport !== 'function') return;
    bridge.getHomeScreenShortcutSupport().then((support) => {
      Home._shortcutSupport = (support && support.mechanism) ? support : null;
      // iOS: shortcuts live in a shared widget grid, which SV can mirror
      // as a manageable section above "Your apps" (see
      // renderWidgetSection). Fetch the registry eagerly — the menu's
      // ✓-state and the capacity check need it — but the section itself
      // stays hidden until the user asks for it (_widgetSectionVisible).
      if (Home._shortcutSupport?.mechanism === 'widget') {
        return Home._refreshWidgetItems();
      }
    }).catch(() => { /* stay null — item simply never renders */ });
  },

  // ── iOS widget mirror ───────────────────────────────────────────────
  //
  // Home._widgetItems is the device-wide pinned registry as reported by
  // the app: null until (unless) a fetch succeeds, then an array of
  // { id, name, url, pinnedAtMs } in widget display order. null hides
  // the section entirely — old app builds resolve null (bridge timeout),
  // so the management UI only appears where every management call works.
  _widgetItems: null,
  // The section is opt-in per page load: hidden until the user clicks
  // "Add to Usernode widget" (see _menuAddShortcut), then it stays up
  // for the rest of the session as the management surface.
  _widgetSectionVisible: false,
  // The iOS medium widget renders at most 8 tiles (see
  // UsernodeDappsWidget.swift, mediumView prefix(8)); adds beyond that
  // wouldn't be visible on the homescreen, so SV refuses them with a
  // shake instead.
  WIDGET_CAPACITY: 8,

  async _refreshWidgetItems() {
    const bridge = window.usernode;
    if (!bridge || typeof bridge.getHomeScreenShortcuts !== 'function') return;
    try {
      const resp = await bridge.getHomeScreenShortcuts();
      Home._widgetItems = (resp && Array.isArray(resp.items)) ? resp.items : null;
    } catch (_) {
      Home._widgetItems = null;
    }
  },

  // The widget section (and drag-into-widget affordance) is active only
  // when the app reports the widget mechanism, the registry fetch
  // succeeded, AND the user has revealed the section this session.
  _widgetUiActive() {
    return Home._widgetSectionVisible
      && Home._shortcutSupport?.mechanism === 'widget'
      && Array.isArray(Home._widgetItems);
  },

  // Widget entries deep-link `origin/#app/<slug>`; anything else in the
  // grid was pinned by a different dapp. Returns the SV slug or null.
  _widgetSlugFor(item) {
    const url = String(item?.url || '');
    const prefix = `${location.origin}/#app/`;
    if (!url.startsWith(prefix)) return null;
    try {
      return decodeURIComponent(url.slice(prefix.length));
    } catch (_) {
      return null;
    }
  },

  // Set of SV slugs currently in the widget — drives the "already
  // added" state in menus and drag targets.
  _widgetSlugs() {
    const out = new Set();
    for (const item of Home._widgetItems || []) {
      const slug = Home._widgetSlugFor(item);
      if (slug) out.add(slug);
    }
    return out;
  },

  // Targeted icon refresh for a single app card, called from the WS
  // app_update handler (app.js handleAppUpdate, action 'icon_changed')
  // after a deploy reconciled the dapp.json icon block. Same shape as
  // updateAppCardLock: patch the Home._apps cache + the mounted tile in
  // place, no full Home.load() that would blow away hover/scroll state.
  // Safe no-op if the card isn't mounted.
  updateAppCardIcon(slug, iconEmoji, iconUrl) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (app) {
      app.icon_emoji = iconEmoji || null;
      app.icon_url = iconUrl || null;
    }
    const card = document.querySelector(`.app-card[data-slug="${slug}"]`);
    const tile = card?.querySelector('[data-icon]');
    if (!tile) return;
    const name = app?.name || card.querySelector('.font-medium')?.textContent || '?';
    const icon = Home.iconTileFor({ icon_emoji: iconEmoji || null, icon_url: iconUrl || null, name });
    tile.dataset.icon = icon.kind;
    tile.innerHTML = icon.html;
  },

  // ===== "…" card actions menu =====
  //
  // One popover implementation shared by the desktop "⋯" button and
  // the mobile long-press (see _onCardPointerDown). Built lazily on
  // open from the app object in the Home._apps cache — no hidden
  // per-card menus in the DOM. Anchored to the trigger rect, appended
  // to document.body, closed on outside pointerdown / Escape / scroll
  // / resize / (by default) running an action.
  _menuEl: null,
  _menuCleanup: null,

  // Pure item builder, separate from the DOM so tests can pin the
  // permission gating. Mutating controls gate on canAdminWrite (full
  // admin) — view-only admins don't get them (issue #311); Retry stays
  // creator-or-full-admin.
  //
  // The Your-apps entry renders for EVERY app so the affordance is
  // always discoverable. Membership (is_collaborator — you created or
  // help build the app) isn't removable, so member apps get a
  // disabled, informational "In Your apps" row instead of a Remove —
  // without it, a user who is a member of every app they open (e.g.
  // the creator of most apps on an instance) would never see the
  // selector anywhere and reasonably conclude it's missing.
  menuItemsFor(app) {
    const items = [];
    const user = App.user || {};
    const isRunning = app.status === 'running';
    const isError = app.status === 'error';
    if (app.is_collaborator) {
      items.push({
        key: 'favorite',
        label: '✓ In Your apps',
        disabled: true,
        title: 'You build this app, so it is always in Your apps.',
      });
    } else {
      items.push({
        key: 'favorite',
        label: app.is_favorited ? 'Remove from Your apps' : 'Add to Your apps',
        run: () => Home._menuToggleFavorite(app),
      });
    }
    // Native homescreen shortcut — only when the page runs inside a
    // Usernode app build whose bridge reports the feature (see
    // _probeShortcutSupport; Home._shortcutSupport stays null in plain
    // browsers and on old app builds, so the item never renders there).
    const shortcutSupport = Home._shortcutSupport;
    // "Your apps" only: the homescreen widget is for the apps you keep,
    // not something to offer on every card in the directory.
    if (isRunning && Home.isYours(app)
        && shortcutSupport && shortcutSupport.mechanism !== 'unsupported') {
      // iOS shortcuts land in the shared widget grid, so the item names
      // that destination; Android pins straight to the launcher.
      const isWidget = shortcutSupport.mechanism === 'widget';
      // Data-based, not visibility-based: the ✓ must show even while
      // the widget section itself is still hidden.
      const inWidget = isWidget
        && Array.isArray(Home._widgetItems)
        && Home._widgetSlugs().has(app.slug);
      if (inWidget) {
        // Already pinned: the item becomes the way back to the (hidden
        // by default) management section — reorder or remove from there.
        items.push({
          key: 'add-to-homescreen',
          label: 'Edit in Usernode widget',
          run: () => Home._revealWidgetSection(),
        });
      } else {
        items.push({
          key: 'add-to-homescreen',
          label: isWidget ? 'Add to Usernode widget' : 'Add to phone home screen',
          run: () => Home._menuAddShortcut(app),
        });
      }
    }
    if (isError && (user.canAdminWrite || user.id === app.created_by)) {
      items.push({ key: 'retry', label: 'Retry', run: () => Home._menuRetry(app) });
    }
    if (user.canAdminWrite && app.repo_url && isRunning && !app.self_hosted) {
      // keepOpen: the drift check can take 30-90s when a rebuild kicks
      // off, so the item flips to "Checking…" in place instead of the
      // menu vanishing with zero feedback.
      items.push({
        key: 'check-updates',
        label: 'Check for updates',
        keepOpen: true,
        run: (itemEl) => Home._menuCheckUpdates(app, itemEl),
      });
    }
    if (user.canAdminWrite) {
      items.push({
        key: 'lock',
        label: app.locked ? 'Unlock app' : 'Lock app',
        title: app.locked
          ? 'App locked — merges also need an admin yes vote. Click to unlock.'
          : 'Lock this app — admin yes vote will also be required to merge changes.',
        run: () => Home._menuToggleLock(app),
      });
      items.push({ key: 'delete', label: 'Delete app', danger: true, run: () => Home._menuDelete(app) });
    }
    return items;
  },

  // Build-info header at the top of the "…" menu: the app's FULL,
  // untruncated name (the card face truncates it), the slug, and the
  // currently deployed commit — the version pill that used to sit on
  // the card face. Reuses AppView.renderAppVersionPillHTML (non-quiet,
  // like the AppView header) so the commit chip looks identical
  // everywhere and shows the live deploying state when a redeploy is
  // in flight. NOTE: classic-script `const AppView` from app-view.js
  // is in the shared script-global lexical env but is NOT a property
  // of window, so we reference it directly (a `window.AppView` guard
  // would silently short-circuit to false and drop the pill).
  renderMenuHeaderHtml(app) {
    const pillHtml = (typeof AppView !== 'undefined' && AppView.renderAppVersionPillHTML)
      ? AppView.renderAppVersionPillHTML({
          slug: app.slug,
          version: app.version || null,
          deployProgress: app.deployProgress || null,
          includePrContext: false,
        })
      : `<span class="text-xs font-mono">${escapeHtml(app.slug)} · ${escapeHtml(app.version?.shortSha || 'dev')}</span>`;
    // "Updated Xh ago" lives here rather than on the card face; falls
    // back to created_at when last_deploy_at is null (pre-migration
    // apps — schema.sql backfills last_deploy_at = created_at, so this
    // is mostly defensive).
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    // The app's FULL pill set (missing secrets / to vote / in dev /
    // issues / privacy) — the card face carries no chips at all, so
    // this header is the one place they render.
    const pillsHtml = Home.renderAppPillsHtml(app);
    return `
      <div class="card-menu-title">${escapeHtml(app.name || app.slug)}</div>
      <div class="card-menu-slug">${escapeHtml(app.slug)}</div>
      <div class="card-menu-version">${pillHtml}</div>
      ${updatedRel ? `<div class="card-menu-updated">Updated ${escapeHtml(updatedRel)}</div>` : ''}
      ${pillsHtml ? `<div class="card-menu-pills">${pillsHtml}</div>` : ''}`;
  },

  openCardMenu(slug, anchorRect) {
    Home.closeCardMenu();
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    const items = Home.menuItemsFor(app);
    if (!items.length) return;

    const el = document.createElement('div');
    el.className = 'card-menu';
    el.setAttribute('role', 'menu');
    const header = document.createElement('div');
    header.className = 'card-menu-header';
    header.innerHTML = Home.renderMenuHeaderHtml(app);
    el.appendChild(header);
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-menu-item' + (item.danger ? ' card-menu-item-danger' : '');
      btn.textContent = item.label;
      btn.dataset.key = item.key;
      if (item.title) btn.title = item.title;
      if (item.disabled) {
        // Informational row (e.g. "In Your apps" on member apps):
        // rendered but inert, so the affordance stays discoverable.
        btn.disabled = true;
      } else {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!item.keepOpen) Home.closeCardMenu();
          item.run(btn);
        });
      }
      el.appendChild(btn);
    }

    // Measure hidden, then anchor below the rect LEFT-aligned — the
    // panel's left edge lines up with the hamburger and the list
    // opens rightward (right-edge alignment made it hang leftward
    // across the card). Clamp back toward the left when the right
    // edge would overflow the viewport; flip above when it would poke
    // past the bottom edge.
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - w - 8));
    let top = anchorRect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchorRect.top - h - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = '';

    const onDocPointerDown = (ev) => {
      if (!el.contains(ev.target)) Home.closeCardMenu();
    };
    const onKeyDown = (ev) => { if (ev.key === 'Escape') Home.closeCardMenu(); };
    const onScroll = () => Home.closeCardMenu();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    Home._menuEl = el;
    Home._menuCleanup = () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  },

  closeCardMenu() {
    if (Home._menuCleanup) {
      Home._menuCleanup();
      Home._menuCleanup = null;
    }
    if (Home._menuEl) {
      Home._menuEl.remove();
      Home._menuEl = null;
    }
  },

  // ── Menu actions ──────────────────────────────────────────────────

  // Ask the Usernode app to pin this app to the device homescreen. The
  // shortcut URL is the platform's own hash deep link (#app/<slug>), so
  // tapping it reopens the SV shell already navigated to the app — same
  // surface as tapping the card, with the platform session intact. The
  // app shows its own native confirmation screen; a user decline
  // surfaces as a rejection, which we swallow (it's not an error).
  // Menu entry point. Android: direct launcher pin, unchanged. iOS: the
  // click is what reveals the widget section — then the app is added
  // automatically when the widget has room, and when it's full the
  // section shakes instead so the user sees why nothing was added (and
  // can ✕ something to make room).
  async _menuAddShortcut(app) {
    if (Home._shortcutSupport?.mechanism !== 'widget') {
      return Home._addShortcutForApp(app);
    }
    if (!Array.isArray(Home._widgetItems)) await Home._refreshWidgetItems();
    if (!Array.isArray(Home._widgetItems)) {
      // Registry unreachable (old build mid-probe?) — plain add, no
      // management section to show.
      return Home._addShortcutForApp(app);
    }
    Home._revealWidgetSection();
    if (Home._widgetSlugs().has(app.slug)) return; // already in — just reveal
    if (Home._widgetItems.length >= Home.WIDGET_CAPACITY) {
      Home._shakeWidgetStrip();
      return;
    }
    return Home._addShortcutForApp(app);
  },

  // Show the widget management section (idempotent) and bring it into
  // view. Shared by "Add to Usernode widget" and "Edit in Usernode
  // widget".
  _revealWidgetSection() {
    Home._widgetSectionVisible = true;
    Home.render();
    const strip = document.getElementById('widget-strip');
    if (strip) strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  _shakeWidgetStrip() {
    const strip = document.getElementById('widget-strip');
    if (!strip || typeof strip.animate !== 'function') return;
    strip.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-8px)' },
        { transform: 'translateX(7px)' },
        { transform: 'translateX(-5px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(-2px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 450, easing: 'ease-in-out' }
    );
  },

  // Renders the SV emoji/letter tile to a PNG data URI so the native
  // homescreen widget shows the exact tile the app shows — same violet
  // tint (violet-600/20 background, violet-400 letter) over a
  // transparent background that adapts to the widget's light/dark
  // surface. Apps with a real icon image skip this (the image URL is
  // passed through instead).
  _widgetIconDataUrl(app) {
    try {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = 'rgba(124, 58, 237, 0.20)'; // violet-600/20
      ctx.fillRect(0, 0, size, size);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (app.icon_emoji) {
        ctx.font = '72px system-ui, sans-serif';
        ctx.fillText(app.icon_emoji, size / 2, size / 2 + 4);
      } else {
        ctx.fillStyle = '#a78bfa'; // violet-400
        ctx.font = 'bold 64px system-ui, sans-serif';
        ctx.fillText(
          String(app.name || '?').charAt(0).toUpperCase(),
          size / 2, size / 2 + 2
        );
      }
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  },

  // Shared by the hamburger item and the drag-onto-strip drop. On iOS a
  // successful add lands in the widget registry, so the strip is
  // re-fetched and re-rendered to show the new tile.
  async _addShortcutForApp(app) {
    try {
      await window.usernode.addHomeScreenShortcut({
        name: app.name,
        url: `${location.origin}/#app/${encodeURIComponent(app.slug)}`,
        // Real icon image: absolute URL the app downloads. Emoji/letter
        // tiles: canvas-rendered PNG data URI so the widget matches the
        // in-app tile exactly.
        icon_url: app.icon_url
          ? new URL(app.icon_url, location.origin).href
          : Home._widgetIconDataUrl(app),
      });
      if (Home._shortcutSupport?.mechanism === 'widget') {
        await Home._refreshWidgetItems();
        Home.render();
      }
      return true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/denied/i.test(msg)) alert(`Add to home screen failed: ${msg}`);
      return false;
    }
  },

  async _menuToggleFavorite(app) {
    const next = !app.is_favorited;
    try {
      const res = await fetch(`/api/apps/${app.slug}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      app.is_favorited = next;
      await Home.load();
    } catch (err) {
      alert(`Update failed: ${err.message}`);
    }
  },

  async _menuRetry(app) {
    await fetch(`/api/apps/${app.slug}/retry`, { method: 'POST' });
    Home.load();
  },

  async _menuCheckUpdates(app, itemEl) {
    if (itemEl) {
      itemEl.disabled = true;
      itemEl.textContent = 'Checking…';
    }
    try {
      const res = await fetch(`/api/apps/${app.slug}/check-updates`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || `Check failed (HTTP ${res.status})`);
      } else {
        Home.reportCheckResult(data);
      }
    } catch (err) {
      alert(`Check failed: ${err.message}`);
    } finally {
      Home.closeCardMenu();
      await Home.load();
    }
  },

  async _menuToggleLock(app) {
    const nextLocked = !app.locked;
    try {
      const res = await fetch(`/api/apps/${app.slug}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: nextLocked }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Lock toggle failed (HTTP ${res.status})`);
        return;
      }
      Home.updateAppCardLock(app.slug, nextLocked);
    } catch (err) {
      alert(`Lock toggle failed: ${err.message}`);
    }
  },

  async _menuDelete(app) {
    if (!confirm('Delete this app?')) return;
    const res = await fetch(`/api/apps/${app.slug}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `Delete failed (HTTP ${res.status})`);
    }
    await Home.load();
  },

  // ===== "Your apps" drag-and-drop (issue #128) =====
  //
  // Vanilla Pointer Events (same pattern as the spec-viewer resizer in
  // dev-chat.js — setPointerCapture + move/up/cancel on the captured
  // element), no library and no HTML5 draggable (poor touch support).
  //
  // Homescreen-style visuals: picking a card up spawns a floating
  // clone ("ghost") that tracks the pointer, while the real card stays
  // in the grid restyled as a dashed drop slot. As the slot moves
  // among its "Your apps" siblings, the siblings FLIP-animate into their
  // new grid positions; on drop the ghost glides into the slot and the
  // real card is swapped back in. The in-flow card doubles as the drop
  // indicator, so the 1/2/3-column grid layout stays correct for free.

  // True while a drag gesture is in progress; Home.load() defers to
  // _reloadPending instead of re-rendering (see the guard in load()).
  _dragActive: false,
  _reloadPending: false,
  // Eats the synthetic click the browser fires right after the
  // pointerup that ends a drag (see the card click handler in load()).
  _suppressClick: false,

  // Unified card pointer handler, attached to EVERY card by
  // _wireCards. Two gestures share it:
  //   - touch long-press (~350ms, finger still) → opens the "…"
  //     actions menu for any card;
  //   - drag-to-reorder (canDrag — "Your apps" cards only, and only
  //     in the sectioned view): mouse promotes on >6px movement as
  //     before; on touch, keeping the finger down after the menu
  //     opened and moving >10px dismisses the menu and picks the card
  //     up, so both gestures coexist on one press.
  // canDrag: "Your apps" reorder. canWidgetDrop: the widget strip is
  // showing and this running card isn't in it yet — the card can be
  // picked up (even outside "Your apps") and dropped onto the strip to
  // pin it. Both may be true; the drop target decides what happens.
  _onCardPointerDown(e, card, listEl, canDrag, canWidgetDrop = false) {
    if (e.button !== 0) return;
    // A previous drag may still be settling (the ghost glides into the
    // slot for ~190ms after pointerup, with _dragActive held true).
    // Starting a second gesture mid-settle would let the old gesture's
    // teardown clear _dragActive and sibling styles under the new one.
    if (Home._dragActive) return;
    // Same guard list as the navigation click handler — a press that
    // starts on a button is a button press, never a drag or a
    // long-press.
    if (
      e.target.closest('.card-menu-btn') ||
      e.target.closest('.retry-btn')
    ) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType === 'touch';
    let dragging = false;
    let menuOpened = false;
    let longPressTimer = null;
    let ghost = null;
    // Pointer position at pickup + the ghost's fixed-position origin;
    // every move translates the ghost by the pointer's delta from here.
    let grabX = 0;
    let grabY = 0;
    let ghostLeft = 0;
    let ghostTop = 0;
    // Latest pointer position, kept fresh on every move so the
    // edge auto-scroll loop can re-run the hit-test while the finger
    // holds still against the edge and the content scrolls underneath.
    let lastClientX = 0;
    let lastClientY = 0;
    // rAF handle for the edge auto-scroll loop (null when not scrolling).
    let autoScrollRAF = null;
    // The scrollable viewport the favorites live in (#home-screen has
    // overflow-y-auto). Falling back to the document scroller keeps the
    // feature working if the markup ever changes.
    const scrollEl = listEl.closest('.overflow-y-auto') || document.scrollingElement;
    // Widget-strip drop target (iOS in-app only, see renderWidgetSection).
    const strip = canWidgetDrop ? document.getElementById('widget-strip') : null;

    const yoursCards = () =>
      [...listEl.querySelectorAll('.app-card[data-yours="true"]')];

    // Advertise / spotlight the strip while a droppable card is in
    // flight. Inline styles for the same reason as the drop slot below:
    // no dependency on the Tailwind JIT mid-gesture.
    const setStripHighlight = (mode) => {
      if (!strip) return;
      if (mode === 'none') {
        strip.style.borderColor = '';
        strip.style.backgroundColor = '';
        strip.style.borderStyle = '';
      } else {
        strip.style.borderStyle = 'dashed';
        strip.style.borderColor = mode === 'hover'
          ? 'rgba(139, 92, 246, 0.9)'
          : 'rgba(139, 92, 246, 0.55)';
        strip.style.backgroundColor = mode === 'hover'
          ? 'rgba(139, 92, 246, 0.14)'
          : 'rgba(139, 92, 246, 0.05)';
      }
    };

    const isOverStrip = (x, y) =>
      !!strip && !!document.elementFromPoint(x, y)?.closest('#widget-strip');

    const beginDrag = (refX, refY) => {
      dragging = true;
      Home._dragActive = true;
      grabX = refX;
      grabY = refY;
      // Capture on the grid container, NOT the card: the live reflow
      // below removes + reinserts the card, and Chromium releases
      // pointer capture the moment the captured element leaves the
      // DOM — capture on the card dies on the first reflow and every
      // subsequent pointer event lands on whatever card is under the
      // cursor instead. listEl never moves during a drag (Home.load()
      // is deferred via _dragActive), so capture on it survives.
      try { listEl.setPointerCapture(pointerId); } catch {}

      // "Pick up": a fixed-position clone floats above the page and
      // tracks the pointer, slightly scaled + elevated like a
      // homescreen icon. pointer-events: none keeps it invisible to
      // the elementFromPoint hit-test in onMove.
      const rect = card.getBoundingClientRect();
      ghostLeft = rect.left;
      ghostTop = rect.top;
      ghost = card.cloneNode(true);
      ghost.removeAttribute('data-yours');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        zIndex: '1000',
        pointerEvents: 'none',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.3)',
        transform: 'scale(1.04)',
        transition: 'none',
      });
      document.body.appendChild(ghost);

      // The real card stays in the grid as the drop slot: contents
      // hidden, box restyled as a dashed violet gap. Inline styles
      // rather than Tailwind utilities so the look doesn't depend on
      // the CDN JIT generating classes mid-gesture. The explicit
      // borderWidth matters: the resting card is borderless now, so
      // dashed style alone would render nothing.
      for (const child of card.children) child.style.visibility = 'hidden';
      Object.assign(card.style, {
        borderWidth: '1px',
        borderStyle: 'dashed',
        borderColor: 'rgba(139, 92, 246, 0.55)',
        backgroundColor: 'rgba(139, 92, 246, 0.07)',
        // touch-action is evaluated at touchstart and immutable for
        // the gesture, so this only shields NEW touches that land
        // mid-drag/settle — the in-flight gesture is claimed by
        // onTouchMove's preventDefault below, the one veto browsers
        // still honor after the gesture has started.
        touchAction: 'none',
      });
      // The cards themselves are already select-none via
      // .app-card-draggable; this covers the rest of the page so a
      // mouse drag that sweeps across headers / other sections
      // doesn't paint a selection. webkitUserSelect alongside the
      // standard property for older WebKit.
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      document.body.style.cursor = 'grabbing';
      setStripHighlight('ready');
    };

    // Touch: a ~350ms long-press during which the finger stays put
    // (< 10px) opens the "…" actions menu (every card). On a
    // draggable card, continuing to hold and moving the finger then
    // promotes to a drag (see onMove). Movement before the timer
    // fires means the user is scrolling — bail and let the browser
    // pan (touch-pan-y on the card keeps that path native).
    if (isTouch) {
      longPressTimer = setTimeout(() => {
        menuOpened = true;
        // Eat the synthetic click the browser fires when the finger
        // lifts, so releasing the long-press doesn't also open the
        // app. The card click handler resets the flag; onUp's timeout
        // clears it when no click follows.
        Home._suppressClick = true;
        Home.openCardMenu(card.dataset.slug, card.getBoundingClientRect());
      }, 350);
    }

    // Pointer Events alone can't hold off the browser's pan once the
    // long-press promotes to a drag: the card's touch-action (pan-y)
    // was locked in at touchstart, and preventDefault() on pointermove
    // has no effect on scrolling — so the first finger movement would
    // start a page scroll and pointercancel the drag. The one veto
    // browsers still honor is preventDefault() on the raw touchmove,
    // which works here because the finger held still through the
    // long-press, so no scroll has been committed yet. Must be
    // registered non-passive (document-level touchmove defaults to
    // passive). While the gesture is still ambiguous (!dragging) it
    // does nothing and scrolling stays native.
    // (menuOpened counts too: once the long-press menu is up we keep
    // the gesture claimed, so held-move can still promote to a drag
    // instead of scrolling the page out from under the open menu.)
    const onTouchMove = (ev) => { if (dragging || menuOpened) ev.preventDefault(); };
    // Android fires contextmenu at ~500ms of long-press — after our
    // 350ms menu/pickup — which would pop the native menu on top; eat it.
    const onContextMenu = (ev) => { if (dragging || menuOpened) ev.preventDefault(); };
    if (isTouch) {
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('contextmenu', onContextMenu);
    }

    const moveGhost = (x, y) => {
      ghost.style.transform =
        `translate(${x - grabX}px, ${y - grabY}px) scale(1.04)`;
    };

    // FLIP-animate the other "Your apps" cards when the drop slot
    // moves: measure where each sibling is right now (mid-animation
    // positions included, so rapid slot changes retarget smoothly),
    // apply the reorder, then play each one from its old spot to its
    // new grid position.
    const flipReorder = (applyReorder) => {
      const sibs = yoursCards().filter((c) => c !== card);
      const firstRects = new Map(sibs.map((c) => [c, c.getBoundingClientRect()]));
      applyReorder();
      // Clear in-flight transforms so the post-reorder measurement is
      // the true layout position, not a mid-transition one.
      for (const c of sibs) {
        c.style.transition = 'none';
        c.style.transform = '';
      }
      for (const c of sibs) {
        const first = firstRects.get(c);
        const last = c.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (dx || dy) c.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      // Flush the inverted transforms before enabling transitions, so
      // the jump back to the old position isn't itself animated.
      void listEl.offsetHeight;
      requestAnimationFrame(() => {
        for (const c of sibs) {
          c.style.transition = 'transform 200ms ease';
          c.style.transform = '';
        }
      });
    };

    // Move the drop slot to wherever (x, y) points. Hit-tests against
    // the other "Your apps" cards (the ghost is pointer-events: none,
    // so it never occludes this). Hits on "All Apps" cards, the create
    // tile, or section headers fall through (no [data-yours] ancestor)
    // and the slot stays put — drops are constrained to the Your apps
    // section by construction. Shared by pointer moves and the
    // auto-scroll loop.
    const updateSlot = (x, y) => {
      // A widget-drop-only pickup (card outside "Your apps") must not
      // reorder the grid — its slot stays put and only the strip reacts.
      if (!canDrag) return;
      const over = document.elementFromPoint(x, y)
        ?.closest('.app-card[data-yours="true"]');
      if (!over || over === card || !listEl.contains(over)) return;
      // Insert before when the pointer is in the leading half of the
      // hovered card, after otherwise. "Leading" follows reading order:
      // the left half at 2-3 grid columns, the top half when the grid is
      // single-column (card spans the full row).
      const rect = over.getBoundingClientRect();
      const multiCol = rect.width < listEl.getBoundingClientRect().width * 0.9;
      const before = multiCol
        ? x < rect.left + rect.width / 2
        : y < rect.top + rect.height / 2;
      // Skip no-op reinserts: before()/after() always remove + re-add the
      // node even when it already sits in the target slot, which would
      // churn layout and re-fire FLIP for nothing.
      if (before) {
        if (card.nextElementSibling !== over) flipReorder(() => over.before(card));
      } else {
        if (over.nextElementSibling !== card) flipReorder(() => over.after(card));
      }
    };

    // ===== Edge auto-scroll (touch) =====
    // When the finger nears the top/bottom of the scroll viewport, pan
    // the page so favorites below/above the fold can be reordered past
    // the visible area. The distance the finger sits INTO the edge zone
    // sets the speed (closer to the edge = faster), so a gentle hover
    // creeps and pressing right up to the edge races.
    const EDGE_ZONE = 72;      // px from an edge where auto-scroll kicks in
    const MAX_SCROLL_STEP = 18; // px/frame at the very edge

    // Signed px/frame to scroll for a finger at viewport-y `y`
    // (negative = up), 0 when outside both edge zones.
    const edgeScrollStep = (y) => {
      const rect = scrollEl === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scrollEl.getBoundingClientRect();
      if (y < rect.top + EDGE_ZONE) {
        const t = Math.min(1, (rect.top + EDGE_ZONE - y) / EDGE_ZONE);
        return -Math.ceil(t * MAX_SCROLL_STEP);
      }
      if (y > rect.bottom - EDGE_ZONE) {
        const t = Math.min(1, (y - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
        return Math.ceil(t * MAX_SCROLL_STEP);
      }
      return 0;
    };

    const autoScrollTick = () => {
      if (!dragging) { autoScrollRAF = null; return; }
      const step = edgeScrollStep(lastClientY);
      if (step === 0) { autoScrollRAF = null; return; }
      const before = scrollEl.scrollTop;
      scrollEl.scrollTop += step;
      // Only if the container actually moved (not already pinned at
      // top/bottom) does the card under the stationary finger change —
      // re-run the hit-test so the slot follows the scrolling content.
      // The ghost is fixed-position and pinned to the finger, so it
      // needs no update while the finger holds still.
      if (scrollEl.scrollTop !== before) updateSlot(lastClientX, lastClientY);
      autoScrollRAF = requestAnimationFrame(autoScrollTick);
    };

    // Start the loop if the finger is in an edge zone, stop it otherwise.
    // Touch-only: desktop mouse drag is intentionally left unchanged.
    const syncAutoScroll = () => {
      if (isTouch && edgeScrollStep(lastClientY) !== 0) {
        if (autoScrollRAF == null) autoScrollRAF = requestAnimationFrame(autoScrollTick);
      } else if (autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
      }
    };

    const stopAutoScroll = () => {
      if (autoScrollRAF != null) {
        cancelAnimationFrame(autoScrollRAF);
        autoScrollRAF = null;
      }
    };

    const detach = () => {
      clearTimeout(longPressTimer);
      stopAutoScroll();
      listEl.removeEventListener('pointermove', onMove);
      listEl.removeEventListener('pointerup', onUp);
      listEl.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('contextmenu', onContextMenu);
      try { listEl.releasePointerCapture(pointerId); } catch {}
    };

    // Remove the ghost, turn the drop slot back into the real card,
    // and clear every style this gesture touched. Ends the re-render
    // deferral window.
    const restoreCard = () => {
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
      for (const child of card.children) child.style.visibility = '';
      card.style.borderWidth = '';
      card.style.borderStyle = '';
      card.style.borderColor = '';
      card.style.backgroundColor = '';
      card.style.touchAction = '';
      for (const c of yoursCards()) {
        c.style.transition = '';
        c.style.transform = '';
      }
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.body.style.cursor = '';
      setStripHighlight('none');
      Home._dragActive = false;
    };

    const runPendingReload = () => {
      if (Home._reloadPending) {
        Home._reloadPending = false;
        Home.load();
      }
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (isTouch) {
          if (!menuOpened) {
            // Finger moved before the long-press fired → it's a scroll.
            if (dist > 10) detach();
          } else if ((canDrag || canWidgetDrop) && dist > 10) {
            // Held past the long-press and moved on a reorderable
            // card: the menu steps aside and the drag takes over.
            Home.closeCardMenu();
            beginDrag(ev.clientX, ev.clientY);
          }
        } else if ((canDrag || canWidgetDrop) && dist > 6) {
          // Mouse/pen: > 6px from the down point promotes to a drag;
          // below that it stays a click for the navigation handler.
          beginDrag(ev.clientX, ev.clientY);
        }
        if (!dragging) return;
      }
      ev.preventDefault();
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      moveGhost(ev.clientX, ev.clientY);
      updateSlot(ev.clientX, ev.clientY);
      if (strip) {
        setStripHighlight(isOverStrip(ev.clientX, ev.clientY) ? 'hover' : 'ready');
      }
      // Start/stop edge auto-scroll based on where the finger now sits.
      syncAutoScroll();
    };

    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      if (!didDrag) {
        // A long-press that opened the menu set _suppressClick so the
        // release doesn't navigate; clear it on the next tick in case
        // no synthetic click follows (it would otherwise eat a later
        // genuine tap).
        if (menuOpened) setTimeout(() => { Home._suppressClick = false; }, 0);
        runPendingReload();
        return;
      }
      // Eat the synthetic click that follows pointerup. It dispatches
      // synchronously before any timer below runs; the timeout just
      // clears a stale flag when no click follows (e.g. touch drags).
      Home._suppressClick = true;
      setTimeout(() => { Home._suppressClick = false; }, 0);
      // Dropped onto the widget strip: this drag was an "add to
      // widget", not a reorder. Glide the ghost onto the strip, put the
      // card back where it was (updateSlot never moved a widget-only
      // pickup; a "Your apps" card may have shuffled in flight, but
      // nothing was persisted, so the next render restores the saved
      // order), and hand off to the shortcut flow — the app shows its
      // native confirmation from here.
      if (canWidgetDrop && isOverStrip(ev.clientX, ev.clientY)) {
        const stripRect = strip.getBoundingClientRect();
        ghost.style.transition = 'transform 180ms ease, opacity 180ms ease';
        ghost.style.opacity = '0';
        ghost.style.transform =
          `translate(${stripRect.left + 16 - ghostLeft}px, ${stripRect.top + 8 - ghostTop}px) scale(0.4)`;
        const slug = card.dataset.slug;
        setTimeout(async () => {
          restoreCard();
          runPendingReload();
          // Same capacity rule as the menu path: a full widget shakes
          // instead of accepting the drop.
          if ((Home._widgetItems || []).length >= Home.WIDGET_CAPACITY) {
            Home._shakeWidgetStrip();
            return;
          }
          const app = (Home._apps || []).find((a) => a.slug === slug);
          if (app) await Home._addShortcutForApp(app);
        }, 190);
        return;
      }
      // "Put down": glide the ghost into the drop slot, then swap the
      // real card back in and persist. _dragActive stays true during
      // the settle so a WS-driven Home.load() can't delete the slot
      // out from under the animation.
      const target = card.getBoundingClientRect();
      ghost.style.transition = 'transform 180ms ease, box-shadow 180ms ease';
      ghost.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)';
      ghost.style.transform =
        `translate(${target.left - ghostLeft}px, ${target.top - ghostTop}px) scale(1)`;
      setTimeout(async () => {
        restoreCard();
        if (canDrag) await Home._saveYoursOrder(listEl);
        runPendingReload();
      }, 190);
    };

    // Browser took over the gesture mid-drag (or the pointer died).
    // Dropping at the current position would persist an order the user
    // may not have meant — abort without saving and reload server truth.
    const onCancel = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      if (didDrag) {
        restoreCard();
        Home._reloadPending = false;
        Home.load();
      } else {
        runPendingReload();
      }
    };

    // Listen on the grid container rather than the card: before the
    // drag starts, events on the card bubble up here; once listEl
    // takes pointer capture in beginDrag, events retarget here
    // directly — either way these handlers keep firing across card
    // reflows (a card-level listener would go silent as soon as the
    // pointer left the card, since the card loses capture when the
    // reflow reinserts it).
    listEl.addEventListener('pointermove', onMove);
    listEl.addEventListener('pointerup', onUp);
    listEl.addEventListener('pointercancel', onCancel);
  },

  // Persist the "Your apps" order currently shown in the DOM (the
  // server upserts app_favorites rows, so member apps that were never
  // manually added hold a position too). On success the DOM is already
  // correct — no reload needed, the server now agrees. On failure,
  // alert + full Home.load() to restore server truth (same
  // optimistic-then-revert shape as _menuToggleFavorite).
  async _saveYoursOrder(listEl) {
    const order = [...listEl.querySelectorAll('.app-card[data-yours="true"]')]
      .map((c) => c.dataset.slug);
    try {
      const res = await fetch('/api/favorites/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      alert(`Reorder failed: ${err.message}`);
      await Home.load();
    }
  },

  // Empty-state ("No apps yet") has two variants — the existing
  // "Create your first app" CTA for users with permission, and a
  // muted "Ask an admin to enable app creation" hint for users
  // without. Toggle the CTA button on/off in place rather than
  // rebuilding the static DOM, so the surrounding "No apps yet"
  // copy stays put.
  applyEmptyStateForPermissions(canCreate) {
    const emptyEl = document.getElementById('empty-state');
    if (!emptyEl) return;
    const btn = emptyEl.querySelector('.home-create-btn');
    let hint = emptyEl.querySelector('.home-create-disabled-hint');
    if (canCreate) {
      if (btn) btn.classList.remove('hidden');
      if (hint) hint.remove();
    } else {
      if (btn) btn.classList.add('hidden');
      if (!hint) {
        hint = document.createElement('p');
        hint.className = 'home-create-disabled-hint text-sm text-zinc-400 dark:text-zinc-500 max-w-sm text-center';
        hint.textContent = 'Ask an admin to enable app creation for your account.';
        emptyEl.appendChild(hint);
      }
    }
  },

  // Idempotent click-wiring for every `.home-create-btn` currently
  // mounted (the empty-state CTA, the per-tile placeholder pill,
  // etc.). Listeners are re-bound on every Home.load(); cloneNode
  // swap clears any stale ones from a prior render so the modal
  // doesn't open twice. The non-<button> branch is a defensive
  // fallback — both current call sites use real <button> elements
  // and get Enter/Space activation for free — but kept so future
  // div-based variants don't silently lose keyboard support.
  wireCreateButtons() {
    document.querySelectorAll('.home-create-btn').forEach((btn) => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', () => App.showCreateModal());
      if (fresh.tagName !== 'BUTTON') {
        fresh.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            App.showCreateModal();
          }
        });
      }
    });
  },

  // Targeted deploy-state update for a single app. Called from the
  // `app_redeploy_status` WS handler (deploy END triggers a full
  // Home.load() instead — see app.js) so the home screen flips into
  // the deploying state without a full re-render that would blow away
  // pending hover/scroll state on other cards.
  //
  // The commit pill no longer renders on the card face — build info
  // lives in the "…" menu's header, which is built lazily from the
  // Home._apps cache at open time. So this (1) refreshes the cached
  // app's version/deployProgress so an already-open-next-time menu
  // shows fresh info, and (2) re-classes the card's status dot — the
  // tile's only visible "this app is redeploying" signal. Without the
  // dot update, a redeploy arriving over WS on an already-running card
  // wouldn't change any visible state until a full Home.load().
  updateAppCardPill(slug, opts) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (app) {
      app.deployProgress = opts && opts.deployProgress ? opts.deployProgress : null;
      // The deploy-start event carries version: null (the old SHA is
      // hidden while deploying anyway); keep the cached SHA so the
      // menu's fallback text stays meaningful, and only overwrite when
      // an event actually supplies one.
      if (opts && opts.version) app.version = opts.version;
    }
    const card = document.querySelector(`.app-card[data-slug="${slug}"]`);
    if (!card) return;
    const isInFlightDeploy = !!(opts && opts.deployProgress && opts.deployProgress.deploying);
    const dot = card.querySelector('.status-dot');
    if (dot) {
      const baseStatus = card.dataset.status;
      const next = isInFlightDeploy ? 'creating'
        : baseStatus === 'running' ? 'running'
        : (baseStatus === 'creating' || baseStatus === 'awaiting_secrets') ? 'creating'
        : 'error';
      dot.classList.remove('running', 'creating', 'error');
      dot.classList.add(next);
    }
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Compact "Nx ago" formatter shared by the home-card meta line. Kept
// locally instead of pulling in a date library — the granularity here
// only needs to be readable at a glance, not exact to the second.
// Returns null for unparseable input so callers can drop the segment
// rather than render "NaN ago".
function formatRelativeTime(input) {
  if (!input) return null;
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) return null;
  const seconds = Math.floor((Date.now() - t.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}mo ago`;
  return `${Math.floor(seconds / (86400 * 365))}y ago`;
}
