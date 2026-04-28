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
        return;
      }

      emptyEl.classList.add('hidden');
      listEl.innerHTML = apps.map(Home.renderAppCard).join('');

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
        alert('Already up to date.');
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
    const activity = parseInt(app.message_count || 0) + parseInt(app.total_seconds || 0);
    const isError = app.status === 'error';
    const isRunning = app.status === 'running';
    const hasMissing = Array.isArray(app.missingSecrets) && app.missingSecrets.length;
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
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${pillHtml ? `<span class="app-version-pill-slot" data-slug="${app.slug}">${pillHtml}</span>` : `<span class="app-version-pill-slot" data-slug="${app.slug}"></span>`}
          ${!isError ? `<span class="text-xs text-zinc-500 dark:text-zinc-400">${formatActivity(activity)}</span>` : ''}
          ${isError && (App.user?.isAdmin || App.user?.id === app.created_by) ? `<button class="retry-btn text-xs text-emerald-400 hover:text-emerald-300 px-1" data-slug="${app.slug}">Retry</button>` : ''}
          ${App.user?.isAdmin && app.repo_url && isRunning ? `<button class="check-updates-btn text-xs text-zinc-400 hover:text-emerald-300 px-1" data-slug="${app.slug}" title="Check for updates and redeploy if changed">⟳</button>` : ''}
          ${App.user?.isAdmin ? `<button class="delete-btn text-xs text-red-400 hover:text-red-300 px-1" data-slug="${app.slug}">&times;</button>` : ''}
        </div>
      </div>
    `;
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

function formatActivity(score) {
  if (score === 0) return 'new';
  if (score < 60) return `${score}s`;
  if (score < 3600) return `${Math.floor(score / 60)}m`;
  return `${Math.floor(score / 3600)}h`;
}
