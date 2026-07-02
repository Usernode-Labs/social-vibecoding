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
    const listEl = document.getElementById('app-list');
    const emptyEl = document.getElementById('empty-state');
    const canCreate = Home.canCreate();

    try {
      // #194: the viewer's own open proposals ride along with the app
      // grid, and the viewer's own active dev sessions ride along the
      // same way. Both non-fatal — a failure just hides the section.
      // #405: forward ?demo=1 (preserved on the page URL) so the "Your
      // proposals" strip's canonical merge-lifecycle chips populate from the
      // staging demo fixtures. No-op outside a ?demo=1 staging preview.
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const [res, proposalsRes, sessionsRes] = await Promise.all([
        fetch('/api/apps'),
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
      const starred = apps.filter((a) => a.is_favorited);
      const rest = apps.filter((a) => !a.is_favorited);
      const hasStarred = starred.length > 0;
      // Personal ordering (issue #128): explicit favorite_order first
      // (ascending), NULLs after. Array.prototype.sort is stable, so
      // returning 0 for two NULLs preserves the server's activity
      // order among un-ordered favorites.
      starred.sort((x, y) => {
        if (x.favorite_order == null && y.favorite_order == null) return 0;
        if (x.favorite_order == null) return 1;
        if (y.favorite_order == null) return -1;
        return x.favorite_order - y.favorite_order;
      });
      // Reordering is meaningless with a single card — skip the grab
      // affordance and the drag wiring below when there's only one.
      const canDragStars = starred.length >= 2;

      let html = Home.renderMyProposalsSection();
      html += Home.renderActiveSessionsSection();
      if (hasStarred) {
        html += '<div class="home-section-header col-span-full">Starred</div>';
        // Starred apps only ever render in this section, so tag the
        // cards at render time: data-starred drives the drag wiring's
        // selector, touch-pan-y keeps vertical scrolling alive until a
        // long-press actually starts a drag, app-card-draggable kills
        // text selection / the mobile callout during that long-press
        // (see app.css), and cursor-grab replaces cursor-pointer as
        // the discoverability hint.
        html += starred.map((a) => {
          let card = Home.renderAppCard(a);
          card = card.replace('class="app-card ', 'data-starred="true" class="app-card ');
          if (canDragStars) {
            card = card.replace('class="app-card ', 'class="app-card app-card-draggable touch-pan-y ');
            card = card.replace('cursor-pointer', 'cursor-grab');
          }
          return card;
        }).join('');
        html += '<div class="home-section-header col-span-full mt-2">All Apps</div>';
      }
      html += rest.map(Home.renderAppCard).join('');
      html += canCreate ? Home.renderCreateTile() : '';
      listEl.innerHTML = html;
      if (canCreate) Home.wireCreateButtons();

      listEl.querySelectorAll('.app-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          // A completed drag ends with the pointer still on the card,
          // so the browser fires a click right after pointerup — eat
          // it so dropping a card doesn't also open the app.
          if (Home._suppressClick) {
            Home._suppressClick = false;
            return;
          }
          if (
            e.target.closest('.retry-btn') ||
            e.target.closest('.delete-btn') ||
            e.target.closest('.check-updates-btn') ||
            e.target.closest('.activity-chip')
          ) return;
          // Disabled while spinning up / errored — there's no iframe or
          // chat history to render and the WS `app_status` handler will
          // re-bind the card as soon as the container goes live.
          if (card.dataset.status !== 'running' && card.dataset.status !== 'awaiting_secrets') return;
          App.navigateToApp(card.dataset.slug);
        });
      });

      // Activity-chip deep links (#57). Only clickable chips carry
      // data-target (inert spans on non-interactive cards don't), so
      // this selector is also the interactivity gate. stopPropagation
      // keeps the card's own open-the-app navigation from double-firing.
      listEl.querySelectorAll('.activity-chip[data-target]').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const slug = chip.dataset.slug;
          const target = chip.dataset.target === 'dev'
            ? `#app/${slug}/dev`
            : `#app/${slug}/dev/${chip.dataset.target}`;
          window.location.hash = target;
        });
      });

      listEl.querySelectorAll('.retry-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.textContent = '...';
          await fetch(`/api/apps/${btn.dataset.slug}/retry`, { method: 'POST' });
          Home.load();
        });
      });

      listEl.querySelectorAll('.delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this app?')) return;
          btn.textContent = '...';
          const res = await fetch(`/api/apps/${btn.dataset.slug}`, { method: 'DELETE' });
          if (res.ok) {
            btn.closest('.app-card').remove();
          }
          await Home.load();
        });
      });

      // Lock/unlock toggle. Admin-only; the corner button renders as an
      // open padlock when the app is unlocked (default for every app) and
      // as a closed padlock when locked. When locked, applying any group-
      // voted change additionally requires at least one admin yes/up vote
      // (enforced server-side in routes/votes.js + routes/issues.js).
      // The click handler optimistically swaps the icon; the WS
      // `app_update` event reconciles every other open tab.
      listEl.querySelectorAll('.lock-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => Home.handleLockClick(e, btn));
      });

      listEl.querySelectorAll('.star-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => Home.handleStarClick(e, btn));
      });

      if (canDragStars) Home.wireStarredDrag(listEl);

      listEl.querySelectorAll('.check-updates-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Disable + spinner while the request is in flight. The
          // server-side check can take 30-90s if drift is detected
          // (rebuild + healthcheck), so the visual feedback matters.
          const original = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = '⟳';
          btn.classList.add('animate-spin');
          try {
            const res = await fetch(`/api/apps/${btn.dataset.slug}/check-updates`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              alert(data.error || `Check failed (HTTP ${res.status})`);
            } else {
              Home.reportCheckResult(data);
            }
          } catch (err) {
            alert(`Check failed: ${err.message}`);
          } finally {
            btn.disabled = false;
            btn.classList.remove('animate-spin');
            btn.innerHTML = original;
            await Home.load();
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="p-4 text-red-400 text-sm">Failed to load apps</div>`;
    }
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
  // Rendered above the Starred / All Apps sections inside the #app-list
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
    const hasMissing = Array.isArray(app.missingSecrets) && app.missingSecrets.length;
    // Three at-a-glance signals rendered as stacked rows in the tile
    // body (see statRows below). activeUsers uses the same sticky
    // 10-day rule as the group-chat dashboard tile (see
    // src/services/active-users.js), so the home card and the
    // dashboard agree on the count. createdRel comes straight from
    // created_at; updatedRel falls back to created_at when
    // last_deploy_at is null (pre-migration apps that haven't
    // redeployed — backfill in schema.sql sets last_deploy_at =
    // created_at, so this path is mostly defensive).
    const activeUsers = parseInt(app.active_users || 0);
    const createdRel = formatRelativeTime(app.created_at);
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    // Awaiting-secrets cards stay clickable so the user can open the
    // app view + Secrets modal to fill values; other non-running
    // statuses show no app surface.
    const cursorClass = (isRunning || isAwaiting) ? 'cursor-pointer' : 'cursor-not-allowed opacity-70';

    // Same per-app pill renderer as the header (AppView), so the two
    // surfaces stay visually identical and turn yellow + spin in
    // lockstep when a redeploy is in flight. The home pill omits the
    // PR-context tooltip — that's only meaningful in the app view.
    // NOTE: classic-script `const AppView` from app-view.js is in the
    // shared script-global lexical env but is NOT a property of window,
    // so we reference it directly (a `window.AppView` guard would
    // silently short-circuit to false and drop the pill).
    const pillHtml = (typeof AppView !== 'undefined' && AppView.renderAppVersionPillHTML)
      ? AppView.renderAppVersionPillHTML({
          slug: app.slug,
          version: app.version || null,
          deployProgress: app.deployProgress || null,
          includePrContext: false,
          // Quiet on home tiles — the status dot up top covers the
          // "redeploying" signal, so this pill only ever shows the
          // idle border-only chip.
          quiet: true,
        })
      : '';

    // Per-tile sections, computed up front so the template stays
    // readable. Anything that may be empty is collapsed to '' so the
    // tile self-trims without leaving stray padding. Stat rows are
    // each on their own line so they read cleanly inside the
    // constrained tile width — at 3 columns the dot-separated single-
    // line variant we use elsewhere wraps awkwardly.
    const warningHtml = statusLabel
      ? `<p class="text-xs mt-0.5 ${isAwaiting ? 'text-amber-500' : 'text-yellow-500'}">${statusLabel}${
          isAwaiting && hasMissing ? `: ${escapeHtml(app.missingSecrets.join(', '))}` : ''
        }</p>`
      : (hasMissing
        ? `<p class="text-xs mt-0.5 text-red-500">Missing secrets: ${escapeHtml(app.missingSecrets.join(', '))}</p>`
        : '');

    // Visibility chip for non-default settings. View-private dominates
    // (it implies collab-private); collab-private alone reads as
    // "invite-only build" since anyone can still see/use the app.
    const visChipCls = 'inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-violet-500/10 text-violet-500 dark:text-violet-400';
    // Inline currentColor SVGs (Heroicons v1 outline) instead of emoji
    // so the glyphs tint violet with the chip in both themes.
    const visChipIcon = (d) => `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
    const lockIcon = visChipIcon('M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z');
    const mailIcon = visChipIcon('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z');
    const visBadgeHtml = app.view_visibility === 'private'
      ? `<p><span class="${visChipCls}" title="Only collaborators can see and use this app">${lockIcon} Private</span></p>`
      : (app.collab_visibility === 'private'
        ? `<p><span class="${visChipCls}" title="Anyone can use this app; only invited collaborators can build it">${mailIcon} Invite-only build</span></p>`
        : '');

    // Development-activity chips (#57): PRs awaiting votes, dev sessions
    // in flight, open issues. Counts come straight from /api/apps (DB-
    // derived, no GitHub calls). Zero-count chips are dropped so quiet
    // apps keep today's clean tile; an all-zero card collapses the row
    // entirely, same self-trimming pattern as warningHtml/visBadgeHtml.
    // Chips deep-link into the app's dev surfaces, but only when the
    // card itself is interactive (same running/awaiting condition as
    // the card click handler) — otherwise they render as inert spans.
    const openPrs = parseInt(app.open_prs || 0);
    const activeSessions = parseInt(app.active_sessions || 0);
    const openIssues = parseInt(app.open_issues || 0);
    const chipDefs = [];
    if (openPrs > 0) {
      chipDefs.push({
        target: 'proposals',
        cls: 'bg-amber-500/10 text-amber-500',
        label: `${openPrs} to vote`,
        tip: `${openPrs} change${openPrs === 1 ? '' : 's'} awaiting community votes`,
      });
    }
    if (activeSessions > 0) {
      chipDefs.push({
        target: 'dev',
        cls: 'bg-sky-500/10 text-sky-500',
        label: `${activeSessions} in dev`,
        tip: `${activeSessions} build session${activeSessions === 1 ? '' : 's'} in progress`,
      });
    }
    if (openIssues > 0) {
      chipDefs.push({
        target: 'issues',
        cls: 'bg-zinc-500/10 text-zinc-500 dark:text-zinc-400',
        label: `${openIssues} issue${openIssues === 1 ? '' : 's'}`,
        tip: `${openIssues} open issue${openIssues === 1 ? '' : 's'}`,
      });
    }
    const chipsClickable = isRunning || isAwaiting;
    const chipBaseCls = 'activity-chip inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium';
    const chipsRowHtml = chipDefs.length
      ? `<div class="flex flex-wrap items-center gap-1.5">${chipDefs.map((c) => (
          chipsClickable
            ? `<button class="${chipBaseCls} ${c.cls} hover:opacity-75 transition-opacity" data-slug="${app.slug}" data-target="${c.target}" title="${c.tip}">${c.label}</button>`
            : `<span class="${chipBaseCls} ${c.cls}" title="${c.tip}">${c.label}</span>`
        )).join('')}</div>`
      : '';

    const statRows = [];
    if (activeUsers > 0) {
      statRows.push(`<div><span class="font-semibold text-zinc-700 dark:text-zinc-300">${activeUsers}</span> active user${activeUsers === 1 ? '' : 's'}</div>`);
    } else {
      statRows.push(`<div class="text-zinc-400 dark:text-zinc-500">No active users yet</div>`);
    }
    if (createdRel) statRows.push(`<div>Created ${createdRel}</div>`);
    if (updatedRel && updatedRel !== createdRel) statRows.push(`<div>Updated ${updatedRel}</div>`);
    // `min-w-0` on the stats column lets it shrink under the pill on
    // narrow tiles instead of forcing the pill off the right edge.
    const statsHtml = `<div class="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5 min-w-0">${statRows.join('')}</div>`;

    // Admin / creator buttons — all corner-pinned at the top-right of
    // the tile so the bottom of the card is reserved for the muted
    // commit pill alone. Retry is creator-or-admin (only on errored
    // apps); check-updates and delete are admin-only. The corner div
    // is rendered conditionally so we don't reserve right padding on
    // tiles that have no buttons there at all.
    const isFavorited = !!app.is_favorited;
    // Mutating controls gate on canAdminWrite (full admin) — view-only
    // admins don't get them (issue #311). Retry stays creator-or-full-admin.
    const showRetry = isError && (App.user?.canAdminWrite || App.user?.id === app.created_by);
    const showCheck = App.user?.canAdminWrite && app.repo_url && isRunning && !app.self_hosted;
    const showDelete = !!App.user?.canAdminWrite;
    const showLock = !!App.user?.canAdminWrite;
    const isLocked = !!app.locked;
    const hasCornerBtns = true;
    // `Retry` is text rather than a glyph so we widen the title-row's
    // right padding when it's present; otherwise pr-14 is enough for
    // the two icon buttons + gap. With lock added we widen slightly
    // when there are 3 glyph buttons (check + lock + delete).
    const glyphCount = 1 + (showCheck ? 1 : 0) + (showLock ? 1 : 0) + (showDelete ? 1 : 0);
    const titlePadClass = showRetry
      ? 'pr-24'
      : (glyphCount >= 3 ? 'pr-20' : 'pr-14');
    const starBtnHtml = `<button class="star-btn w-6 h-6 flex items-center justify-center rounded-md transition-colors text-sm leading-none ${isFavorited ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10'}" data-slug="${app.slug}" data-favorited="${isFavorited}" title="${isFavorited ? 'Unstar app' : 'Star app'}" aria-label="${isFavorited ? 'Unstar app' : 'Star app'}">${isFavorited ? '★' : '☆'}</button>`;
    const cornerBtnsHtml = `
      <div class="absolute top-2 right-2 flex items-center gap-1">
        ${starBtnHtml}
        ${showRetry ? `<button class="retry-btn text-xs text-emerald-500 hover:text-emerald-400 px-2 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors" data-slug="${app.slug}">Retry</button>` : ''}
        ${showCheck ? `<button class="check-updates-btn w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors text-sm leading-none" data-slug="${app.slug}" title="Check for updates and redeploy if changed" aria-label="Check for updates">⟳</button>` : ''}
        ${showLock ? Home.renderLockButton(app.slug, isLocked) : ''}
        ${showDelete ? `<button class="delete-btn w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-500/10 transition-colors text-base leading-none" data-slug="${app.slug}" title="Delete app" aria-label="Delete app">&times;</button>` : ''}
      </div>`;

    // Stats column (left) + commit pill (right) share one flex row at
    // the bottom of the tile. `items-end` baselines the pill against
    // the last stat row ("Updated Yt ago") so the two read across
    // horizontally; `mt-auto` pushes the whole block to the foot of
    // the card so tiles in the same grid row line up nicely. The pill
    // slot is always rendered (the renderer emits a "<slug> · dev"
    // placeholder when there's no SHA) so .app-version-pill-slot is
    // reachable by Home.updateAppCardPill on WS deploy events.
    const statsAndPillHtml = `
      <div class="flex items-end justify-between gap-3 pt-1 mt-auto">
        ${statsHtml}
        <span class="app-version-pill-slot min-w-0 truncate text-right shrink-0" data-slug="${app.slug}">${pillHtml}</span>
      </div>`;

    return `
      <div class="app-card relative rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:border-violet-300 dark:hover:border-violet-700 transition-colors p-4 flex flex-col gap-3 ${cursorClass}" data-slug="${app.slug}" data-status="${app.status}" data-locked="${isLocked}">
        ${cornerBtnsHtml}
        <div class="flex items-start gap-3 ${titlePadClass}">
          <div class="w-11 h-11 rounded-xl bg-violet-600/20 flex items-center justify-center text-violet-400 font-bold text-base shrink-0">
            ${app.name.charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium truncate">${escapeHtml(app.name)}</span>
              <span class="status-dot ${statusClass}" title="${app.status}"></span>
            </div>
            ${warningHtml}
            ${visBadgeHtml}
          </div>
        </div>
        ${chipsRowHtml}
        ${statsAndPillHtml}
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
      <div class="home-create-tile rounded-xl border border-transparent bg-violet-500/[0.02] dark:bg-violet-500/[0.04] p-4 flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-xl bg-violet-600/20 flex items-center justify-center text-violet-400 font-bold text-base shrink-0">
            Y
          </div>
          <div class="flex-1 min-w-0">
            <div class="italic text-zinc-500 dark:text-zinc-400 truncate">Your app here</div>
          </div>
        </div>
        <button type="button" class="home-create-btn self-start inline-flex items-center gap-2 rounded-full border border-violet-500 dark:border-violet-400 px-4 py-2 text-sm font-medium text-violet-600 dark:text-violet-400 bg-white dark:bg-zinc-900 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create new app
        </button>
      </div>`;
  },

  // Lock-toggle button renderer. Two visual states keyed off `locked`:
  //   - unlocked (default): open-padlock glyph, zinc/violet hover. The
  //     icon tells the user "click to lock this app".
  //   - locked: closed-padlock glyph, violet text + violet-tinted hover
  //     background. The icon tells the user "this app is locked; click
  //     to unlock". We tint locked icons violet (rather than red or
  //     amber) because a lock is a governance setting, not an error —
  //     red would read as "danger / something is wrong".
  //
  // Both states share the same `.lock-btn` class so the click handler
  // in Home.load() can wire them uniformly. `data-locked` carries the
  // current state so the handler knows which direction to toggle. The
  // tooltip text adapts so admins know what clicking will do.
  renderLockButton(slug, isLocked) {
    const lockedSvg = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>`;
    const unlockedSvg = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>`;
    const cls = isLocked
      ? 'lock-btn w-6 h-6 flex items-center justify-center rounded-md text-violet-500 hover:text-violet-400 hover:bg-violet-500/10 transition-colors leading-none'
      : 'lock-btn w-6 h-6 flex items-center justify-center rounded-md text-zinc-400 hover:text-violet-400 hover:bg-violet-500/10 transition-colors leading-none';
    const title = isLocked
      ? 'App locked — merges also need an admin yes vote. Click to unlock.'
      : 'Lock this app — admin yes vote will also be required to merge changes.';
    const label = isLocked ? 'Unlock app' : 'Lock app';
    return `<button class="${cls}" data-slug="${slug}" data-locked="${isLocked}" title="${title}" aria-label="${label}">${isLocked ? lockedSvg : unlockedSvg}</button>`;
  },

  // Targeted lock-button refresh for a single app card. Both the
  // optimistic-click path (in Home.load) and the WS app_update handler
  // (in app.js handleAppUpdate) route through here so the icon swap is
  // identical, and so we don't blow away hover/scroll state on other
  // cards with a full Home.load(). Safe no-op if the card isn't
  // mounted (different screen, not loaded yet, etc.).
  updateAppCardLock(slug, isLocked) {
    if (!slug) return;
    const card = document.querySelector(`.app-card[data-slug="${slug}"]`);
    if (!card) return;
    card.dataset.locked = String(!!isLocked);
    const btn = card.querySelector('.lock-btn');
    if (!btn) return;
    const replacement = document.createElement('div');
    replacement.innerHTML = Home.renderLockButton(slug, isLocked).trim();
    const fresh = replacement.firstChild;
    if (!fresh) return;
    fresh.addEventListener('click', (e) => Home.handleLockClick(e, fresh));
    btn.replaceWith(fresh);
  },

  // Click-handler body for the lock button. Shared by Home.load (on the
  // first render of each card) and Home.updateAppCardLock (on every
  // subsequent re-render driven by either the optimistic local swap or
  // a WS app_update event). One source of truth so the toggle behavior
  // can't drift between the two paths.
  async handleLockClick(e, btn) {
    e.stopPropagation();
    const slug = btn.dataset.slug;
    const wasLocked = btn.dataset.locked === 'true';
    const nextLocked = !wasLocked;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/apps/${slug}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: nextLocked }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Lock toggle failed (HTTP ${res.status})`);
        return;
      }
      Home.updateAppCardLock(slug, nextLocked);
    } catch (err) {
      alert(`Lock toggle failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  },

  async handleStarClick(e, btn) {
    e.stopPropagation();
    const slug = btn.dataset.slug;
    const wasFavorited = btn.dataset.favorited === 'true';
    const next = !wasFavorited;
    btn.dataset.favorited = String(next);
    btn.textContent = next ? '★' : '☆';
    btn.classList.toggle('text-amber-400', next);
    btn.classList.toggle('hover:text-amber-300', next);
    btn.classList.toggle('text-zinc-400', !next);
    btn.classList.toggle('hover:text-amber-400', !next);
    btn.classList.toggle('hover:bg-amber-500/10', !next);
    btn.title = next ? 'Unstar app' : 'Star app';
    btn.disabled = true;
    try {
      const res = await fetch(`/api/apps/${slug}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await Home.load();
    } catch (err) {
      btn.dataset.favorited = String(wasFavorited);
      btn.textContent = wasFavorited ? '★' : '☆';
      btn.title = wasFavorited ? 'Unstar app' : 'Star app';
      alert(`Star toggle failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  },

  // ===== Starred-section drag-and-drop (issue #128) =====
  //
  // Vanilla Pointer Events (same pattern as the spec-viewer resizer in
  // dev-chat.js — setPointerCapture + move/up/cancel on the captured
  // element), no library and no HTML5 draggable (poor touch support).
  //
  // Homescreen-style visuals: picking a card up spawns a floating
  // clone ("ghost") that tracks the pointer, while the real card stays
  // in the grid restyled as a dashed drop slot. As the slot moves
  // among its starred siblings, the siblings FLIP-animate into their
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

  wireStarredDrag(listEl) {
    listEl.querySelectorAll('.app-card[data-starred="true"]').forEach((card) => {
      card.addEventListener('pointerdown', (e) => Home._onStarredPointerDown(e, card, listEl));
    });
  },

  _onStarredPointerDown(e, card, listEl) {
    if (e.button !== 0) return;
    // A previous drag may still be settling (the ghost glides into the
    // slot for ~190ms after pointerup, with _dragActive held true).
    // Starting a second gesture mid-settle would let the old gesture's
    // teardown clear _dragActive and sibling styles under the new one.
    if (Home._dragActive) return;
    // Same guard list as the navigation click handler — a press that
    // starts on a corner button is a button press, never a drag.
    if (
      e.target.closest('.star-btn') ||
      e.target.closest('.lock-btn') ||
      e.target.closest('.delete-btn') ||
      e.target.closest('.retry-btn') ||
      e.target.closest('.check-updates-btn')
    ) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const isTouch = e.pointerType === 'touch';
    let dragging = false;
    let longPressTimer = null;
    let ghost = null;
    // Pointer position at pickup + the ghost's fixed-position origin;
    // every move translates the ghost by the pointer's delta from here.
    let grabX = 0;
    let grabY = 0;
    let ghostLeft = 0;
    let ghostTop = 0;

    const starredCards = () =>
      [...listEl.querySelectorAll('.app-card[data-starred="true"]')];

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
      ghost.removeAttribute('data-starred');
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
      // the CDN JIT generating classes mid-gesture.
      for (const child of card.children) child.style.visibility = 'hidden';
      Object.assign(card.style, {
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
    };

    // Touch: a drag starts only after a ~350ms long-press during which
    // the finger stays put (< 10px). Movement before the timer fires
    // means the user is scrolling — bail and let the browser pan
    // (touch-pan-y on the card keeps that path native).
    if (isTouch) longPressTimer = setTimeout(() => beginDrag(startX, startY), 350);

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
    const onTouchMove = (ev) => { if (dragging) ev.preventDefault(); };
    // Android fires contextmenu at ~500ms of long-press — after our
    // 350ms pickup — which would pop a menu mid-drag; eat it.
    const onContextMenu = (ev) => { if (dragging) ev.preventDefault(); };
    if (isTouch) {
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('contextmenu', onContextMenu);
    }

    const moveGhost = (x, y) => {
      ghost.style.transform =
        `translate(${x - grabX}px, ${y - grabY}px) scale(1.04)`;
    };

    // FLIP-animate the other starred cards when the drop slot moves:
    // measure where each sibling is right now (mid-animation positions
    // included, so rapid slot changes retarget smoothly), apply the
    // reorder, then play each one from its old spot to its new grid
    // position.
    const flipReorder = (applyReorder) => {
      const sibs = starredCards().filter((c) => c !== card);
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

    const detach = () => {
      clearTimeout(longPressTimer);
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
      card.style.borderStyle = '';
      card.style.borderColor = '';
      card.style.backgroundColor = '';
      card.style.touchAction = '';
      for (const c of starredCards()) {
        c.style.transition = '';
        c.style.transform = '';
      }
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.body.style.cursor = '';
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
          // Finger moved before the long-press fired → it's a scroll.
          if (dist > 10) detach();
        } else if (dist > 6) {
          // Mouse/pen: > 6px from the down point promotes to a drag;
          // below that it stays a click for the navigation handler.
          beginDrag(ev.clientX, ev.clientY);
        }
        if (!dragging) return;
      }
      ev.preventDefault();
      moveGhost(ev.clientX, ev.clientY);
      // Hit-test against the other starred cards (the ghost is
      // pointer-events: none, so it never occludes this). Hits on
      // "All Apps" cards, the create tile, or section headers fall
      // through (no [data-starred] ancestor) and the slot stays where
      // it is — drops are constrained to the Starred section by
      // construction.
      const over = document.elementFromPoint(ev.clientX, ev.clientY)
        ?.closest('.app-card[data-starred="true"]');
      if (!over || over === card || !listEl.contains(over)) return;
      // Insert before when the pointer is in the leading half of the
      // hovered card, after otherwise. "Leading" follows reading
      // order: the left half at 2-3 grid columns, the top half when
      // the grid is single-column (card spans the full row).
      const rect = over.getBoundingClientRect();
      const multiCol = rect.width < listEl.getBoundingClientRect().width * 0.9;
      const before = multiCol
        ? ev.clientX < rect.left + rect.width / 2
        : ev.clientY < rect.top + rect.height / 2;
      // Skip no-op reinserts: before()/after() always remove + re-add
      // the node even when it already sits in the target slot, which
      // would churn layout and re-fire FLIP for nothing.
      if (before) {
        if (card.nextElementSibling !== over) flipReorder(() => over.before(card));
      } else {
        if (over.nextElementSibling !== card) flipReorder(() => over.after(card));
      }
    };

    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const didDrag = dragging;
      detach();
      if (!didDrag) {
        runPendingReload();
        return;
      }
      // Eat the synthetic click that follows pointerup. It dispatches
      // synchronously before any timer below runs; the timeout just
      // clears a stale flag when no click follows (e.g. touch drags).
      Home._suppressClick = true;
      setTimeout(() => { Home._suppressClick = false; }, 0);
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
        await Home._saveStarredOrder(listEl);
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

  // Persist the order currently shown in the DOM. On success the DOM
  // is already correct — no reload needed, the server now agrees. On
  // failure, alert + full Home.load() to restore server truth (same
  // optimistic-then-revert shape as handleStarClick).
  async _saveStarredOrder(listEl) {
    const order = [...listEl.querySelectorAll('.app-card[data-starred="true"]')]
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

  // Targeted pill update for a single app card. Called from the
  // `app_redeploy_status` and `app_version_changed` WS handlers so
  // the home screen flips into the deploying state (and back) without
  // a full Home.load() re-render that would also blow away pending
  // hover/scroll state on other cards.
  //
  // Also re-classes the card's status dot, since the home tile uses
  // the dot (not the pill's `--deploying` modifier) as the visible
  // "this app is redeploying" signal. Without this, a redeploy that
  // arrives over WS on an already-running card wouldn't change any
  // visible state — the pill stays quiet (we ask for it that way) and
  // the dot would remain green until a full Home.load().
  updateAppCardPill(slug, opts) {
    if (!slug) return;
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
    const slot = card.querySelector('.app-version-pill-slot');
    if (!slot || typeof AppView === 'undefined' || !AppView.renderAppVersionPillHTML) return;
    slot.innerHTML = AppView.renderAppVersionPillHTML({
      slug,
      version: opts && opts.version ? opts.version : null,
      deployProgress: opts && opts.deployProgress ? opts.deployProgress : null,
      includePrContext: false,
      // Same quiet rule as renderAppCard above — this pill never shows
      // the yellow deploying state on home tiles; the status dot does.
      quiet: true,
    });
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
