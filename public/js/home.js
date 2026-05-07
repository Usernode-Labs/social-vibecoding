const Home = {
  async load() {
    const listEl = document.getElementById('app-list');
    const emptyEl = document.getElementById('empty-state');

    try {
      const res = await fetch('/api/apps');
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();

      if (apps.length === 0) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
        // Wire the empty-state's create button (rendered statically in
        // index.html). Same `.home-create-btn` class as the in-list
        // variant below so a single querySelectorAll covers both.
        Home.wireCreateButtons();
        return;
      }

      emptyEl.classList.add('hidden');
      // Render the apps, then append a "Create new app" pill below
      // them. Lives at the bottom of the divided list so it follows
      // the natural reading flow ("here are your apps... and here's
      // how you'd add another"). Replaces the old header "+" pill.
      listEl.innerHTML =
        apps.map(Home.renderAppCard).join('') +
        `<div class="flex justify-center px-4 py-6">
          <button class="home-create-btn inline-flex items-center gap-2 rounded-full border border-violet-500 dark:border-violet-400 px-5 py-2.5 text-sm font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
            Create new app
          </button>
        </div>`;
      Home.wireCreateButtons();

      listEl.querySelectorAll('.app-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (
            e.target.closest('.retry-btn') ||
            e.target.closest('.delete-btn') ||
            e.target.closest('.check-updates-btn')
          ) return;
          // Disabled while spinning up / errored — there's no iframe or
          // chat history to render and the WS `app_status` handler will
          // re-bind the card as soon as the container goes live.
          if (card.dataset.status !== 'running' && card.dataset.status !== 'awaiting_secrets') return;
          App.navigateToApp(card.dataset.slug);
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

  renderAppCard(app) {
    const isAwaiting = app.status === 'awaiting_secrets';
    const statusClass = app.status === 'running' ? 'running'
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
    // Three at-a-glance signals shown beneath the app name. activeUsers
    // uses the same sticky 10-day rule as the group-chat dashboard tile
    // (see src/services/active-users.js), so the home card and the
    // dashboard agree on the count. createdRel falls back to created_at
    // unconditionally; updatedRel falls back to created_at when
    // last_deploy_at is null (pre-migration apps that haven't redeployed
    // yet — backfill in schema.sql sets last_deploy_at = created_at, so
    // this path is mostly defensive).
    const activeUsers = parseInt(app.active_users || 0);
    const createdRel = formatRelativeTime(app.created_at);
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    const metaParts = [];
    if (activeUsers > 0) metaParts.push(`${activeUsers} active`);
    if (createdRel) metaParts.push(`created ${createdRel}`);
    if (updatedRel && updatedRel !== createdRel) metaParts.push(`updated ${updatedRel}`);
    const metaLine = metaParts.join(' · ');
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
        })
      : '';

    return `
      <div class="app-card px-4 py-3 ${cursorClass} flex items-center gap-3" data-slug="${app.slug}" data-status="${app.status}">
        <div class="w-10 h-10 rounded-xl bg-violet-600/20 flex items-center justify-center text-violet-400 font-bold text-sm shrink-0">
          ${app.name.charAt(0).toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium truncate">${escapeHtml(app.name)}</span>
            <span class="status-dot ${statusClass}" title="${app.status}"></span>
          </div>
          ${statusLabel ? `<p class="text-xs ${isAwaiting ? 'text-amber-500' : 'text-yellow-500'}">${statusLabel}${
            isAwaiting && hasMissing ? `: ${escapeHtml(app.missingSecrets.join(', '))}` : ''
          }</p>` : (hasMissing ? `<p class="text-xs text-red-500">Missing secrets: ${escapeHtml(app.missingSecrets.join(', '))}</p>` : '')}
          ${metaLine ? `<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">${metaLine}</p>` : ''}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${pillHtml ? `<span class="app-version-pill-slot" data-slug="${app.slug}">${pillHtml}</span>` : `<span class="app-version-pill-slot" data-slug="${app.slug}"></span>`}
          ${isError && (App.user?.isAdmin || App.user?.id === app.created_by) ? `<button class="retry-btn text-xs text-emerald-400 hover:text-emerald-300 px-1" data-slug="${app.slug}">Retry</button>` : ''}
          ${App.user?.isAdmin && app.repo_url && isRunning ? `<button class="check-updates-btn text-xs text-zinc-400 hover:text-emerald-300 px-1" data-slug="${app.slug}" title="Check for updates and redeploy if changed">⟳</button>` : ''}
          ${App.user?.isAdmin ? `<button class="delete-btn text-xs text-red-400 hover:text-red-300 px-1" data-slug="${app.slug}">&times;</button>` : ''}
        </div>
      </div>
    `;
  },

  // Idempotent click-wiring for every `.home-create-btn` currently
  // mounted (the empty-state CTA + the in-list pill). Listeners are
  // re-bound on every Home.load(); cloneNode swap clears any stale
  // ones from a prior render so the modal doesn't open twice.
  wireCreateButtons() {
    document.querySelectorAll('.home-create-btn').forEach((btn) => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', () => App.showCreateModal());
    });
  },

  // Targeted pill update for a single app card. Called from the
  // `app_redeploy_status` and `app_version_changed` WS handlers so
  // the home screen flips into the deploying state (and back) without
  // a full Home.load() re-render that would also blow away pending
  // hover/scroll state on other cards.
  updateAppCardPill(slug, opts) {
    if (!slug) return;
    const slot = document.querySelector(`.app-card[data-slug="${slug}"] .app-version-pill-slot`);
    if (!slot || typeof AppView === 'undefined' || !AppView.renderAppVersionPillHTML) return;
    slot.innerHTML = AppView.renderAppVersionPillHTML({
      slug,
      version: opts && opts.version ? opts.version : null,
      deployProgress: opts && opts.deployProgress ? opts.deployProgress : null,
      includePrContext: false,
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
