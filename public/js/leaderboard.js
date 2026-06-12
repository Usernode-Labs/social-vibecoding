// Kudos leaderboard screen.
//
// Two sub-views (Top PRs, Top Users), two window tabs (All-time, This
// week). 2x2 = four cached fetches; switching tabs is instant once the
// data is in. Live `kudos_update` events bump the count of any
// already-rendered row and (less precisely) re-fetch when the changed
// row isn't in the current top-N — cheap given the screen is rarely
// open.
//
// Hosted in #leaderboard-root; mounted/unmounted by App.navigateToLeaderboard
// when the #leaderboard hash route is active.

const Leaderboard = {
  open: false,
  sub: 'prs',           // 'prs' | 'users'
  window: 'all',         // 'all' | 'week'
  // sub+window => last fetched payload. Invalidated by refresh().
  _cache: new Map(),
  _loadingKey: null,

  isOpen() { return Leaderboard.open; },

  async open() {
    Leaderboard.open = true;
    Leaderboard._render();
    Leaderboard._load();
    // Header budget badge tells the user how many kudos they have
    // left; the leaderboard screen is exactly where they're most
    // likely to want to give kudos, so refresh just before render so
    // the badge tone is up-to-date.
    if (window.Kudos?.Budget?.refresh) Kudos.Budget.refresh();
  },

  close() {
    Leaderboard.open = false;
  },

  // Re-fetch every cached pane (or just the active one) and re-render.
  // Called on `kudos_update` WS events while the screen is open.
  refresh() {
    if (!Leaderboard.open) return;
    // Just invalidate the active pane; the other three stay cached
    // and re-fetch on next tab click. Refresh is cheap (one query
    // each), but spamming all four on every kudos give would be
    // wasteful.
    const k = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    Leaderboard._cache.delete(k);
    Leaderboard._load();
  },

  _key(sub, win) { return `${sub}|${win}`; },

  _setSub(sub) {
    if (sub !== 'prs' && sub !== 'users') return;
    Leaderboard.sub = sub;
    Leaderboard._render();
    Leaderboard._load();
  },

  _setWindow(win) {
    if (win !== 'all' && win !== 'week') return;
    Leaderboard.window = win;
    Leaderboard._render();
    Leaderboard._load();
  },

  async _load() {
    const key = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    if (Leaderboard._cache.has(key)) {
      Leaderboard._renderBody();
      return;
    }
    Leaderboard._loadingKey = key;
    try {
      const path = Leaderboard.sub === 'prs' ? 'prs' : 'users';
      const res = await fetch(`/api/leaderboard/${path}?window=${Leaderboard.window}&limit=20`);
      if (!res.ok) {
        Leaderboard._cache.set(key, { error: true });
      } else {
        const data = await res.json();
        Leaderboard._cache.set(key, data);
      }
    } catch (err) {
      console.warn('[leaderboard] load failed', err);
      Leaderboard._cache.set(key, { error: true });
    } finally {
      if (Leaderboard._loadingKey === key) {
        Leaderboard._loadingKey = null;
        Leaderboard._renderBody();
      }
    }
  },

  _render() {
    const root = document.getElementById('leaderboard-root');
    if (!root) return;
    const subTabs = ['prs', 'users'].map((s) => {
      const active = s === Leaderboard.sub;
      const label = s === 'prs' ? 'Top PRs' : 'Top users';
      const cls = active
        ? 'border-violet-500 text-violet-700 dark:text-violet-300'
        : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200';
      return `<button data-lb-sub="${s}" class="px-3 py-2 text-sm font-medium border-b-2 ${cls}">${label}</button>`;
    }).join('');
    const winTabs = ['all', 'week'].map((w) => {
      const active = w === Leaderboard.window;
      const label = w === 'all' ? 'All-time' : 'This week';
      const cls = active
        ? 'bg-violet-600 text-white'
        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700';
      return `<button data-lb-win="${w}" class="px-3 py-1 text-xs font-medium rounded-full ${cls}">${label}</button>`;
    }).join('');

    root.innerHTML = `
      <header class="mb-4">
        <h2 class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">Kudos leaderboard</h2>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">5 kudos per week, resets Monday 00:00 UTC. Give them to PRs you appreciate.</p>
      </header>
      <div class="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 mb-3">
        <div class="flex gap-4">${subTabs}</div>
        <div class="flex gap-2 pb-1">${winTabs}</div>
      </div>
      <div id="leaderboard-body" class="mt-2"></div>
    `;
    root.querySelectorAll('[data-lb-sub]').forEach((btn) => {
      btn.addEventListener('click', () => Leaderboard._setSub(btn.dataset.lbSub));
    });
    root.querySelectorAll('[data-lb-win]').forEach((btn) => {
      btn.addEventListener('click', () => Leaderboard._setWindow(btn.dataset.lbWin));
    });
    Leaderboard._renderBody();
  },

  _renderBody() {
    const body = document.getElementById('leaderboard-body');
    if (!body) return;
    const key = Leaderboard._key(Leaderboard.sub, Leaderboard.window);
    const data = Leaderboard._cache.get(key);

    if (!data) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-zinc-500">Loading…</div>`;
      return;
    }
    if (data.error) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-red-500">Couldn\u2019t load leaderboard. Try again later.</div>`;
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      body.innerHTML = `<div class="py-8 text-center text-sm text-zinc-500">
        No kudos ${Leaderboard.window === 'week' ? 'this week ' : ''}yet.
        ${Leaderboard.sub === 'prs' ? 'When someone gives a PR kudos, it shows up here.' : 'When a user gets kudos on a PR they authored, they show up here.'}
      </div>`;
      return;
    }
    body.innerHTML = Leaderboard.sub === 'prs'
      ? Leaderboard._renderPrRows(items)
      : Leaderboard._renderUserRows(items);
    // Buttons inside the PR rows route to the PR's app group chat —
    // wire them lazily here so we don't fight with the table rerender.
    body.querySelectorAll('[data-lb-pr-route]').forEach((el) => {
      el.addEventListener('click', () => {
        const slug = el.dataset.lbPrRoute;
        const sid = el.dataset.lbPrSession;
        if (!slug) return;
        // Land on the app's Proposals tab. The PR appears in the
        // open/merged list there; the user can hit kudos right
        // from the card. Deep-link to the session when we have it.
        window.location.hash = sid
          ? `#app/${slug}/dev/proposals/${sid}`
          : `#app/${slug}/dev/proposals`;
      });
    });
  },

  _renderPrRows(items) {
    const rows = items.map((row, i) => {
      const rank = i + 1;
      const title = row.pr_title || `PR #${row.pr_number || row.session_id}`;
      const author = row.author_username || 'unknown';
      const appName = row.app_name || row.app_slug || 'app';
      const status = row.status || '';
      const statusBadge = status === 'merged'
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">merged</span>'
        : status === 'merging'
          ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">merging</span>'
          : '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">open</span>';
      return `
        <button data-lb-pr-route="${escapeAttr(row.app_slug)}" data-lb-pr-session="${row.session_id}"
                class="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">
          <div class="w-7 text-center text-sm font-mono text-zinc-500">${rank}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">${escapeHtml(title)}</div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              ${statusBadge}
              <span>by @${escapeHtml(author)}</span>
              <span class="text-zinc-400">·</span>
              <span>${escapeHtml(appName)}</span>
            </div>
          </div>
          <div class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-sm font-semibold">
            <span aria-hidden="true">\u{1F44F}</span>
            <span>${row.kudos_count}</span>
          </div>
        </button>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  },

  _renderUserRows(items) {
    const rows = items.map((row, i) => {
      const rank = i + 1;
      const who = row.username || 'unknown';
      const initial = (who[0] || '?').toUpperCase();
      const prsMerged = row.prs_merged || 0;
      const kudosOnUnmerged = row.kudos_received_prs_unmerged || 0;
      // Headline score = kudos earned on MERGED PRs. This is what the
      // leaderboard now ranks by (issue #59), so the big badge shows it
      // rather than total kudos across all PRs.
      const mergedKudos = row.kudos_received_prs_merged || 0;
      // prs_merged is all-time (no merge timestamp to window by), so only
      // show it in the all-time view to avoid implying a weekly figure.
      // Kept as a secondary detail now that ranking is by kudos, not
      // merge count.
      const mergedMeta = (Leaderboard.window === 'all' && prsMerged > 0)
        ? `<span class="text-zinc-400">\u00b7</span><span>${prsMerged} merged</span>`
        : '';
      // Footnote on the kudos badge: how many additional kudos sit on
      // PRs that haven't landed yet (and so don't count toward the
      // ranking score). Only meaningful when > 0.
      const unmergedKudosNote = kudosOnUnmerged > 0
        ? `<span class="shrink-0 text-[11px] text-amber-600 dark:text-amber-400" title="Kudos on PRs that haven\u2019t merged yet \u2014 not counted toward ranking">+${kudosOnUnmerged} on unmerged</span>`
        : '';
      return `
        <div class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div class="w-7 text-center text-sm font-mono text-zinc-500">${rank}</div>
          <div class="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-sm">${escapeHtml(initial)}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">@${escapeHtml(who)}</div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>${row.prs_kudosed} PR${row.prs_kudosed === 1 ? '' : 's'} kudosed</span>
              ${mergedMeta}
            </div>
          </div>
          ${unmergedKudosNote}
          <div class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-sm font-semibold" title="Kudos earned on merged PRs">
            <span aria-hidden="true">\u{1F44F}</span>
            <span>${mergedKudos}</span>
          </div>
        </div>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

window.Leaderboard = Leaderboard;
