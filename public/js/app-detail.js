// App detail page (#app/<slug>/detail) — the pre-open confidence
// layer between the home directory and the iframe. Reached from rail
// cards, search results, and All-apps tiles (Favorites keep one-tap
// direct launch); renders identity (icon, name, category chip,
// "N active", tagline), the action row (Open / Improve / heart /
// More), and the Builders list.
//
// Data comes from AppView.appData — App.navigateToApp always runs
// AppView.open(slug) before switchTab dispatches here, so the
// /api/apps/:slug payload (category, tagline, active_users, favorite
// and permission flags) is already in hand — plus one extra fetch for
// GET /api/apps/:slug/builders.
//
// Renderers are pure (HTML-string in, string out) and separated from
// render()'s DOM wiring so tests can exercise the markup contract in a
// vm sandbox, same harness as home.js's card tests.
const AppDetail = {
  // Same plain-language status vocabulary as the home cards
  // (Home.renderAppCard) — the disabled Open button reuses it rather
  // than inventing new strings.
  statusLabelFor(app) {
    return app.status === 'running' ? ''
      : app.status === 'creating' ? 'Spinning up...'
      : app.status === 'awaiting_secrets' ? 'Awaiting secrets'
      : 'Error';
  },

  // "More" overflow items. Mirrors the home card menu's gates exactly:
  // the shortcut item needs bridge-reported support AND a running app
  // AND membership/favorite (Home.isYours); Fork rides the existing
  // fork dialog and hides for the platform self-app (no per-app
  // repo/DB/container to clone). Labels follow the detail-page copy
  // spec: "Add to home screen" (Android pinned shortcut) / "Add to
  // Usernode widget" (iOS).
  moreItemsFor(app) {
    const items = [];
    const support = typeof Home !== 'undefined' ? Home._shortcutSupport : null;
    if (app.status === 'running'
        && typeof Home !== 'undefined' && Home.isYours(app)
        && support && support.mechanism !== 'unsupported') {
      items.push({
        key: 'add-to-homescreen',
        label: support.mechanism === 'widget' ? 'Add to Usernode widget' : 'Add to home screen',
        run: () => Home._menuAddShortcut(app),
      });
    }
    if (!app.self_hosted && typeof AppView !== 'undefined' && AppView.promptFork) {
      items.push({
        key: 'fork',
        label: 'Fork',
        run: () => AppView.promptFork({ slug: app.slug, name: app.name }),
      });
    }
    return items;
  },

  // Heart toggle markup. Filled when favorited; member apps show it
  // filled AND disabled — membership keeps the app in Favorites, so
  // there is nothing to un-heart (same rule as the card menu's inert
  // "✓ In favorites" row).
  heartHtml(app) {
    const filled = !!(app.is_favorited || app.is_collaborator);
    const disabled = !!app.is_collaborator;
    const label = filled ? 'Remove from favorites' : 'Add to favorites';
    const heartPath = 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z';
    return `
      <button id="detail-heart" ${disabled ? 'disabled' : ''}
        class="w-10 h-10 flex items-center justify-center rounded-xl border border-zinc-200 dark:border-zinc-700 ${disabled ? 'opacity-60 cursor-default' : 'hover:border-rose-300 dark:hover:border-rose-700'} transition-colors shrink-0"
        aria-label="${label}" aria-pressed="${filled}"
        ${disabled ? 'title="You build this app, so it is always in your favorites"' : ''}>
        <svg class="w-5 h-5 ${filled ? 'text-rose-500' : 'text-zinc-400 dark:text-zinc-500'}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${heartPath}"/></svg>
      </button>`;
  },

  // Builders section. Omitted entirely (empty string) when nobody has
  // a merged PR yet — an empty header would just advertise absence.
  renderBuildersHtml(builders) {
    if (!Array.isArray(builders) || !builders.length) return '';
    const rows = builders.map((b) => {
      const name = escapeHtml(b.username || '');
      const count = parseInt(b.merged_count, 10) || 0;
      return `
        <div class="flex items-center gap-3 py-2">
          <div class="w-8 h-8 rounded-full bg-violet-600/20 text-violet-500 dark:text-violet-400 flex items-center justify-center text-sm font-semibold shrink-0">${escapeHtml((b.username || '?').charAt(0).toUpperCase())}</div>
          <span class="flex-1 min-w-0 text-sm font-medium truncate">${name}</span>
          <span class="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">${count} change${count === 1 ? '' : 's'} merged</span>
        </div>`;
    }).join('');
    return `
      <div class="home-section-header mt-4">Builders</div>
      <div class="divide-y divide-zinc-100 dark:divide-zinc-800">${rows}</div>`;
  },

  // The full page, minus builders (they arrive from their own fetch
  // and are mounted into #detail-builders when ready).
  renderHtml(app) {
    const isRunning = app.status === 'running';
    const statusLabel = AppDetail.statusLabelFor(app);
    const activeUsers = parseInt(app.active_users || 0);
    const icon = typeof Home !== 'undefined'
      ? Home.iconTileFor(app)
      : { kind: 'letter', html: escapeHtml((app.name || '?').charAt(0).toUpperCase()) };
    const chipHtml = typeof Home !== 'undefined' ? Home.categoryChipHtml(app.category) : '';
    const taglineHtml = app.tagline
      ? `<p class="text-sm text-zinc-600 dark:text-zinc-300 mt-2">${escapeHtml(app.tagline)}</p>`
      : '';
    const moreItems = AppDetail.moreItemsFor(app);
    const showImprove = app.can_collaborate !== false;

    // Open stays primary; when the app isn't running it renders
    // disabled with the card vocabulary's status label inline so the
    // page explains itself.
    const openBtn = isRunning
      ? `<button id="detail-open" class="flex-1 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2.5 transition-colors">Open</button>`
      : `<button id="detail-open" disabled class="flex-1 rounded-xl bg-zinc-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-sm font-medium px-4 py-2.5 cursor-not-allowed">${escapeHtml(statusLabel)}</button>`;
    const improveBtn = showImprove
      ? `<button id="detail-improve" class="flex-1 rounded-xl border border-violet-500 dark:border-violet-400 text-violet-600 dark:text-violet-400 text-sm font-medium px-4 py-2.5 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors">Improve</button>`
      : '';
    const moreBtn = moreItems.length
      ? `
      <div class="relative shrink-0">
        <button id="detail-more" aria-haspopup="menu" aria-expanded="false"
          class="w-10 h-10 flex items-center justify-center rounded-xl border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors">More</button>
        <div id="detail-more-menu" class="hidden absolute right-0 top-12 z-30 w-56 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
          ${moreItems.map((i) => `<button data-more="${i.key}" class="w-full text-left px-3 py-2.5 text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">${escapeHtml(i.label)}</button>`).join('')}
        </div>
      </div>`
      : '';

    return `
      <div class="h-full overflow-y-auto overscroll-contain">
        <div class="max-w-xl mx-auto px-4 py-5">
          <div class="flex items-start gap-4">
            <div class="w-14 h-14 rounded-xl bg-violet-600/20 overflow-hidden flex items-center justify-center text-violet-400 font-bold text-xl shrink-0" data-icon="${icon.kind}">
              ${icon.html}
            </div>
            <div class="flex-1 min-w-0">
              <h2 class="text-lg font-semibold truncate">${escapeHtml(app.name || app.slug)}</h2>
              <div class="flex items-center gap-1.5 mt-1">
                ${chipHtml}
                <span class="users-badge inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 shrink-0" title="People who used this app in the last 10 days">${activeUsers} active</span>
              </div>
            </div>
          </div>
          ${taglineHtml}
          <p class="text-xs text-zinc-400 dark:text-zinc-500 mt-1">People who used this app in the last 10 days</p>
          <div class="flex items-center gap-2 mt-4">
            ${openBtn}
            ${improveBtn}
            ${AppDetail.heartHtml(app)}
            ${moreBtn}
          </div>
          <div id="detail-builders"></div>
        </div>
      </div>`;
  },

  async render() {
    const content = document.getElementById('app-content');
    if (!content) return;
    const app = typeof AppView !== 'undefined' ? AppView.appData : null;
    if (!app) {
      // AppView.open couldn't load the slug (gated or gone) — same
      // dead-end wording the API's 404 uses; no existence leak.
      content.innerHTML = '<div class="p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">App not found</div>';
      return;
    }
    const slug = app.slug;
    content.innerHTML = AppDetail.renderHtml(app);
    AppDetail._wire(content, app);

    // Builders arrive from their own endpoint; the section mounts only
    // when there is at least one merged PR. Best-effort — a fetch
    // hiccup just leaves the section out.
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/builders`);
      if (!res.ok) return;
      const { builders } = await res.json();
      // The user may have navigated on while the fetch was in flight.
      if (App.currentApp !== slug || App.currentTab !== 'detail') return;
      const mount = document.getElementById('detail-builders');
      if (mount) mount.innerHTML = AppDetail.renderBuildersHtml(builders);
    } catch { /* section stays out */ }
  },

  _wire(content, app) {
    const openBtn = content.querySelector('#detail-open');
    if (openBtn && !openBtn.disabled) {
      // switchTab coerces the App tab to Dev for the self-app (no
      // per-slug subdomain to iframe), so Open is safe unconditionally.
      openBtn.addEventListener('click', () => App.navigateToApp(app.slug, 'app'));
    }
    const improveBtn = content.querySelector('#detail-improve');
    if (improveBtn) {
      improveBtn.addEventListener('click', () => App.navigateToApp(app.slug, 'dev'));
    }

    AppDetail._wireHeart(content, app);

    const moreBtn = content.querySelector('#detail-more');
    const moreMenu = content.querySelector('#detail-more-menu');
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = moreMenu.classList.contains('hidden');
        moreMenu.classList.toggle('hidden', !opening);
        moreBtn.setAttribute('aria-expanded', String(opening));
      });
      // One document-level closer for the lifetime of the page: any
      // outside click hides whatever detail menu is currently mounted.
      // Installed once (the menu nodes themselves are replaced on every
      // navigation, so the closer re-queries by id each time).
      if (!AppDetail._outsideCloserInstalled) {
        AppDetail._outsideCloserInstalled = true;
        document.addEventListener('click', () => {
          const menu = document.getElementById('detail-more-menu');
          const btn = document.getElementById('detail-more');
          if (menu) menu.classList.add('hidden');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        });
      }
      const items = AppDetail.moreItemsFor(app);
      moreMenu.querySelectorAll('[data-more]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          moreMenu.classList.add('hidden');
          const item = items.find((i) => i.key === btn.dataset.more);
          if (item) item.run();
        });
      });
    }
  },

  _outsideCloserInstalled: false,

  // Heart wiring is separate from _wire so the in-place outerHTML swap
  // after a toggle can re-bind ONLY the heart — re-running _wire would
  // stack duplicate listeners on Open/Improve/More.
  _wireHeart(content, app) {
    const heart = content.querySelector('#detail-heart');
    if (!heart || heart.disabled) return;
    heart.addEventListener('click', async () => {
      const next = !app.is_favorited;
      heart.disabled = true;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(app.slug)}/favorite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favorited: next }),
        });
        if (res.ok) {
          app.is_favorited = next;
          // Re-render the heart in place rather than the whole page.
          heart.outerHTML = AppDetail.heartHtml(app);
          AppDetail._wireHeart(content, app);
          return;
        }
      } catch { /* fall through to re-enable */ }
      heart.disabled = false;
    });
  },
};
