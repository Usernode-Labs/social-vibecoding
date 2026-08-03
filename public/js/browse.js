'use strict';

// Browse-all-apps screen (#apps) — the directory half of the home-screen
// split, laid out as an app store. The home feed is "Your apps" only (see
// public/js/home.js render()), so every OTHER app this viewer may see
// lives here.
//
// TWO LEVELS inside the one #browse-screen <main>, the same shape the
// admin console uses for its menu → section drill-in:
//
//   level 1  #apps          #browse-list-level — the row/box list
//   level 2  #apps/<slug>   #browse-detail     — one app's page
//
// The list renders ONE row markup and lets CSS pick the layout: a
// hairline-divided vertical list of full-width rows on a phone, bordered
// boxes in a 2/3-column grid on a wide screen. The grid is Tailwind
// responsive classes on #browse-list, the box treatment is .browse-row in
// app.css — no matchMedia, no re-render on resize.
//
// The detail page ABSORBS the per-row "…" menu the rows used to carry: its
// action rows are derived by filtering Home.menuItemsFor(app), so every
// permission gate (admin-only lock/delete, creator-or-admin retry,
// involved-user build log, non-self-hosted fork) stays in exactly one
// place and a new menu item shows up here for free.
//
// Still deliberately thin on the shared pieces: the icon tile, the
// added-state predicate, the status pills, the search matcher and the
// add/remove write are all Home's (iconTileFor, isYours, renderAppPillsHtml,
// matchesQuery, toggleAdded), so this screen and the home grid cannot drift.
//
// Mounted by App.navigateToBrowse; PTR is wired once by
// App._wirePullToRefresh and covers both levels.

const Browse = {
  _open: false,
  _apps: [],
  _query: '',
  _searchWired: false,
  _searchDebounce: null,
  // Slug of the app whose detail page is showing; null = the list level.
  _slug: null,
  // Guards the cold-deep-link fetch below so a miss can't loop.
  _detailFetching: null,
  _detailMissing: false,
  // Where the CURRENT detail page was entered from, so the header's back
  // button lands where the user actually came from:
  //   'list' — a browse row tap, or a deep link / screenshot state. Back
  //            means up to the list (the default: it is the enclosing
  //            screen, and a deep link has no better answer).
  //   'home' — a home app card's "App details" menu item. The list was
  //            never on screen, so backing out to it would strand the user
  //            on a screen they never visited; back means home. (The
  //            browser/OS back gesture already does this on its own — it
  //            pops the hash entry home returned from — so this only
  //            teaches the header button to agree with it.)
  _detailOrigin: 'list',
  // Set by the opener BEFORE it writes the hash, consumed when the detail
  // level actually opens. A separate field from _detailOrigin so a stale
  // note can't relabel a later, differently-entered page.
  _pendingOrigin: null,

  isOpen() { return Browse._open; },

  // Declared by whoever is about to open a detail page, immediately before
  // it assigns location.hash (the hashchange lands in a later task, so the
  // note is always in place by the time route()/open() reads it).
  noteDetailOrigin(origin) {
    Browse._pendingOrigin = origin === 'home' ? 'home' : 'list';
  },

  // Consume the pending note exactly once per detail entry.
  _takeOrigin() {
    Browse._detailOrigin = Browse._pendingOrigin || 'list';
    Browse._pendingOrigin = null;
  },

  // Screen entry. `slug` (from #apps/<slug>) opens straight onto a detail
  // page. First paint borrows Home's cache when it has one — the user
  // almost always arrives from the home feed — then the refetch reconciles.
  open(slug) {
    Browse._open = true;
    Browse._slug = slug || null;
    Browse._detailMissing = false;
    if (Browse._slug) Browse._takeOrigin();
    else Browse._pendingOrigin = null;
    if (!Browse._apps.length && Array.isArray(Home._apps) && Home._apps.length) {
      Browse._apps = Home._apps;
    }
    Browse._syncLevel();
    Browse.render();
    Browse._load();
  },

  close() {
    Browse._open = false;
    Browse._slug = null;
    Browse._detailMissing = false;
    // Leaving the screen retires the entry note with it — the next detail
    // page declares its own origin.
    Browse._detailOrigin = 'list';
    Browse._pendingOrigin = null;
  },

  // ── Level switching ───────────────────────────────────────────────
  //
  // The hash is the source of truth for WHICH level shows (#apps vs
  // #apps/<slug>); these just apply it. route() is the in-screen
  // navigation entry point App.navigateToBrowse hands off to when the
  // screen is already mounted.

  route(slug) {
    const next = slug || null;
    if (next === Browse._slug) {
      // Same level re-entered (a repeat hash write) — repaint, no animation.
      Browse.render();
      return;
    }
    const goingDeeper = !!next && !Browse._slug;
    Browse._slug = next;
    Browse._detailMissing = false;
    if (next) Browse._takeOrigin();
    else Browse._pendingOrigin = null;
    PlatformUI.transition(() => {
      Browse._syncLevel();
      Browse.render();
    }, { type: goingDeeper ? 'push' : 'pop' });
  },

  showDetail(slug) {
    if (!slug) return;
    Browse._slug = slug;
    Browse._detailMissing = false;
    Browse._takeOrigin();
    Browse._syncLevel();
    Browse.render();
  },

  showList() {
    Browse._slug = null;
    Browse._detailMissing = false;
    Browse._pendingOrigin = null;
    Browse._syncLevel();
    Browse.render();
  },

  // The header's single back button. Inside a detail page it goes back the
  // way the user came in — up to the list for a row tap or a deep link,
  // out to home when the page was opened from a home card's "App details"
  // menu (see _detailOrigin). Both routes match what the browser/OS back
  // gesture does from the same state. On the list it declines and the
  // #back-btn handler's App.navigateHome runs.
  handleBack() {
    if (!Browse._slug) return false;
    if (Browse._detailOrigin === 'home') {
      // navigateHome() runs _exitBrowse() and updateHash(), so the URL
      // stops naming a screen that is no longer showing.
      App.navigateHome();
      return true;
    }
    location.hash = '#apps';
    return true;
  },

  // Container + chrome for the current level. Borrows the admin console's
  // arrow-vs-house back icon convention for a drill-in.
  _syncLevel() {
    const onDetail = !!Browse._slug;
    const listLevel = document.getElementById('browse-list-level');
    const detail = document.getElementById('browse-detail');
    const searchBar = document.getElementById('browse-search-bar');
    if (listLevel) listLevel.classList.toggle('hidden', onDetail);
    if (detail) detail.classList.toggle('hidden', !onDetail);
    // Searching the directory is a level-1 affordance; on a detail page the
    // field would filter a list nobody can see.
    if (searchBar) searchBar.classList.toggle('hidden', onDetail);
    App.setBackIcon(onDetail ? 'arrow' : 'home');
    if (onDetail) {
      const app = Browse.appBySlug(Browse._slug);
      App.setHeaderTitle(app?.name || Browse._slug);
    } else {
      App.setHeaderTitle('All apps');
    }
  },

  // ── Data ──────────────────────────────────────────────────────────

  appBySlug(slug) {
    return (Browse._apps || []).find((a) => a && a.slug === slug) || null;
  },

  // Adopt a fresh /api/apps payload that somebody ELSE fetched, and
  // repaint. Home.load() calls this while this screen is on top, which is
  // how the detail page's actions (add/remove, retry, lock, delete — they
  // all settle through Home.load()) land here without this file knowing
  // anything about them.
  syncFrom(apps) {
    if (!Array.isArray(apps)) return;
    Browse._apps = apps;
    // A delete that succeeded takes its app out of the payload — there is
    // no page left to show, so fall back to the list.
    if (Browse._slug && !Browse.appBySlug(Browse._slug)) {
      if (Browse._detailFetching) return; // a cold-load fetch is still in flight
      location.hash = '#apps';
      return;
    }
    Browse.render();
    // The name can change under us (a merged rename), so re-title.
    if (Browse._slug) Browse._syncLevel();
  },

  // Same endpoint (and same ?demo=1 passthrough) as Home.load: one
  // visibility-filtered payload backs home, this list and the detail page,
  // so a private app is simply absent for a viewer who can't see it — no
  // extra gating here. Writes land in Home._apps too, so returning home
  // shows the adds made here even before its own reload.
  async _load() {
    try {
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const res = await fetch(`/api/apps${demoQS}`);
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      Browse._apps = apps;
      Home._apps = apps;
      Browse.render();
      if (Browse._slug) Browse._syncLevel();
    } catch (err) {
      const listEl = document.getElementById('browse-list');
      if (listEl && !Browse._slug) {
        listEl.innerHTML = '<div class="p-4 text-red-400 text-sm">Failed to load apps</div>';
      }
    }
  },

  // Featured first (by the admin's featured_order, ascending), then
  // everything else by NUMBER OF USERS, most-used first — the directory's
  // "what are people actually using" ordering. Ties fall back to the order
  // /api/apps returned (its own activity ranking), which Array.prototype
  // .sort preserves because it is stable.
  //
  // Featured apps keep the admin's order among themselves rather than being
  // re-sorted by users: that list IS a curation, and reordering it would
  // silently override the choice made in the admin console.
  // Pure — unit-tested in tests/browse-screen.test.js.
  sortApps(apps) {
    const featuredRank = (a) => (a && a.featured
      ? (a.featured_order == null ? Number.MAX_SAFE_INTEGER - 1 : a.featured_order)
      : Number.MAX_SAFE_INTEGER);
    const users = (a) => (parseInt(a && a.active_users, 10) || 0);
    return (apps || []).slice().sort((x, y) => {
      const fx = featuredRank(x);
      const fy = featuredRank(y);
      if (fx !== fy) return fx - fy;
      // Same bucket. Inside the featured bucket the ranks already differ
      // (distinct sort_order), so this only orders the non-featured tail.
      return users(y) - users(x);
    });
  },

  // The rows for the current query. Search covers EVERY visible app here
  // (home's own search is scoped to "Your apps"), reusing Home's matcher
  // so both fields behave identically.
  visibleApps() {
    const sorted = Browse.sortApps(Browse._apps);
    return sorted.filter((a) => Home.matchesQuery(a, Browse._query));
  },

  // ── Row rendering ─────────────────────────────────────────────────

  // The row's second line. There is no description column on `apps` (and
  // dapp.json carries descriptions only per-secret), so this is derived
  // META, not prose: who's using it, when it last shipped, and the status
  // word when the app isn't actually running. Pure — unit-tested.
  metaLine(app) {
    if (!app) return '';
    const bits = [];
    const users = parseInt(app.active_users || 0, 10) || 0;
    bits.push(`${users} user${users === 1 ? '' : 's'}`);
    const rel = formatRelativeTime(app.last_deploy_at || app.created_at);
    if (rel) bits.push(`Updated ${rel}`);
    const status = app.status === 'running' ? ''
      : app.status === 'creating' ? 'Spinning up…'
      : app.status === 'awaiting_secrets' ? 'Awaiting secrets'
      : app.status === 'error' ? 'Error'
      : app.status || '';
    if (status) bits.push(status);
    return bits.join(' · ');
  },

  // One app-store row: icon · name + meta + status pills · Add button.
  // The same markup is the desktop box — see .browse-row in app.css.
  renderAppRow(app) {
    const isAdded = Home.isYours(app);
    const icon = Home.iconTileFor(app);
    const pills = Home.renderAppPillsHtml(app);
    const isDemo = !!app.demo;
    // Staging ?demo=1 rows are inert: their slugs have no DB row, so the
    // detail page would 404 and the favorite POST would too.
    const openable = !isDemo;
    return `
      <div class="browse-row flex items-center gap-3 px-3 py-2.5 ${openable ? 'cursor-pointer' : 'cursor-default'}" data-slug="${escapeHtml(app.slug)}"${isDemo ? ' data-demo="true"' : ''}>
        <div class="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg" data-icon="${icon.kind}">
          ${icon.html}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="font-medium text-sm truncate">${escapeHtml(app.name || app.slug)}</span>
            <span class="status-dot ${app.status === 'running' ? 'running' : app.status === 'error' ? 'error' : 'creating'} shrink-0" title="${escapeHtml(app.status || '')}"></span>
          </div>
          <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate">${escapeHtml(Browse.metaLine(app))}</div>
          ${pills ? `<div class="flex flex-wrap items-center gap-1 mt-1">${pills}</div>` : ''}
        </div>
        <button class="browse-add-btn shrink-0 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          isAdded
            ? 'bg-emerald-500 border-emerald-500 text-white'
            : 'border-violet-500 dark:border-violet-400 text-violet-600 dark:text-violet-400 bg-white dark:bg-zinc-900 hover:bg-violet-50 dark:hover:bg-violet-950'
        }" data-slug="${escapeHtml(app.slug)}" data-added="${isAdded}" aria-pressed="${isAdded}" title="${
          isAdded ? 'Added — tap to remove from Your apps' : 'Add to Your apps'
        }">${
          isAdded
            ? '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>Added'
            : 'Add'
        }</button>
      </div>`;
  },

  // ── Render (dispatches to the level that is showing) ──────────────

  render() {
    if (!Browse._slug) Browse._renderList();
    else Browse._renderDetail();
  },

  _renderList() {
    const listEl = document.getElementById('browse-list');
    const emptyEl = document.getElementById('browse-empty');
    if (!listEl) return;
    Browse._wireSearch();
    const apps = Browse.visibleApps();
    const query = (Browse._query || '').trim();

    listEl.innerHTML = apps.map((a) => Browse.renderAppRow(a)).join('');
    Browse._wireRows(listEl);

    if (emptyEl) {
      if (apps.length) {
        emptyEl.classList.add('hidden');
        emptyEl.textContent = '';
      } else {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = query
          ? `No apps match “${query}”.`
          : 'No apps to show yet.';
      }
    }

    Browse._maybeShotDetail(listEl);
  },

  // Row taps route through the hash so the browser/OS back gesture works;
  // the Add button is the one part of the row that doesn't drill in.
  _wireRows(listEl) {
    listEl.querySelectorAll('.browse-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.browse-add-btn')) return;
        if (row.dataset.demo === 'true') return;
        const slug = row.dataset.slug;
        if (!slug) return;
        // Back from here means up to this list.
        Browse.noteDetailOrigin('list');
        location.hash = `#apps/${encodeURIComponent(slug)}`;
      });
    });
    listEl.querySelectorAll('.browse-add-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home.toggleAdded(btn.dataset.slug, btn.dataset.added !== 'true', () => Browse.render());
      });
    });
  },

  // Screenshot-state deep link (?shot=browse-detail): the detail page is
  // interaction-gated, and the before/after captures can never click. This
  // drills into the FIRST real row so the link keeps working as the seeded
  // data changes. Pure UI state — no writes, no env gate — so it works in
  // production the moment it ships. Fires once per page load.
  //
  // Drills in directly AND aligns the URL with replaceState (rather than
  // assigning location.hash): this runs during boot, inside the very
  // restoreFromHash that mounted the screen, so a hashchange round-trip
  // races the rest of boot and loses — the level was reverted to the list
  // by a later re-derivation. Setting _slug is immediate, and the matching
  // #apps/<slug> in the URL means any later re-derivation resolves to the
  // same level instead of undoing it.
  _shotDetailDone: false,

  _maybeShotDetail(listEl) {
    if (Browse._shotDetailDone || Browse._slug) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'browse-detail') return;
    const row = listEl.querySelector('.browse-row:not([data-demo])');
    if (!row || !row.dataset.slug) return;
    Browse._shotDetailDone = true;
    const slug = row.dataset.slug;
    try {
      history.replaceState(null, '', `${location.search}#apps/${encodeURIComponent(slug)}`);
    } catch (err) { /* non-fatal: the level change below still happens */ }
    Browse.showDetail(slug);
  },

  // ── Detail page ───────────────────────────────────────────────────

  // The action rows, derived from the home card's menu rather than
  // re-implemented: every permission gate lives in Home.menuItemsFor, so
  // this only decides what does NOT belong on a page that already has
  // dedicated Open and Add/Remove buttons above it.
  //   favorite           — the Add/Remove button IS this action
  //   add-to-homescreen  — "Your apps" only; it belongs on the home grid
  //   app-details        — THIS page; a row linking here would be a no-op
  //                        that looks broken (the hash never changes)
  // Pure — unit-tested in tests/browse-screen.test.js.
  DETAIL_EXCLUDED_KEYS: ['favorite', 'add-to-homescreen', 'app-details'],

  detailActionsFor(app) {
    if (!app) return [];
    let items = [];
    try { items = Home.menuItemsFor(app) || []; } catch (err) { items = []; }
    return items.filter((i) => i && !Browse.DETAIL_EXCLUDED_KEYS.includes(i.key));
  },

  _renderDetail() {
    const host = document.getElementById('browse-detail');
    if (!host) return;
    const slug = Browse._slug;
    const app = Browse.appBySlug(slug);

    if (!app) {
      if (Browse._detailMissing) {
        host.innerHTML = `
          <div class="text-sm text-zinc-500 dark:text-zinc-400">
            <p class="mb-3">That app isn&rsquo;t available.</p>
            <button type="button" id="browse-detail-back" class="text-violet-500 hover:text-violet-400">&larr; Back to all apps</button>
          </div>`;
        host.querySelector('#browse-detail-back')
          ?.addEventListener('click', () => { location.hash = '#apps'; });
        return;
      }
      host.innerHTML = '<p class="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>';
      Browse._fetchDetail(slug);
      return;
    }

    const isAdded = Home.isYours(app);
    const icon = Home.iconTileFor(app);
    const pills = Home.renderAppPillsHtml(app);
    const canOpen = app.status === 'running' || app.status === 'awaiting_secrets';
    // Same build-info block the "…" menu header assembles, so the version
    // chip looks identical everywhere and shows a live deploying state.
    const pillHtml = (typeof AppView !== 'undefined' && AppView.renderAppVersionPillHTML)
      ? AppView.renderAppVersionPillHTML({
          slug: app.slug,
          version: app.version || null,
          deployProgress: app.deployProgress || null,
          includePrContext: false,
        })
      : '';
    const updatedRel = formatRelativeTime(app.last_deploy_at || app.created_at);
    const actions = Browse.detailActionsFor(app);

    host.innerHTML = `
      <div class="flex items-start gap-4">
        <div class="app-icon-tile w-16 h-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-2xl" data-icon="${icon.kind}">
          ${icon.html}
        </div>
        <div class="min-w-0 flex-1">
          <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-words">${escapeHtml(app.name || app.slug)}</h2>
          <p class="text-xs font-mono text-zinc-400 dark:text-zinc-500 break-all">${escapeHtml(app.slug)}</p>
          ${pillHtml ? `<div class="mt-2">${pillHtml}</div>` : ''}
          ${updatedRel ? `<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Updated ${escapeHtml(updatedRel)}</p>` : ''}
          ${pills ? `<div class="flex flex-wrap items-center gap-1 mt-2">${pills}</div>` : ''}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 mt-4">
        <button type="button" id="browse-detail-open" class="inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors ${
          canOpen
            ? 'bg-violet-600 hover:bg-violet-500 text-white'
            : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 cursor-not-allowed'
        }"${canOpen ? '' : ' disabled'}>
          ${canOpen
            ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>Open'
            : escapeHtml(app.status === 'creating' ? 'Spinning up…' : app.status === 'error' ? 'Not running' : (app.status || 'Unavailable'))}
        </button>
        <button type="button" id="browse-detail-fav" class="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
          isAdded
            ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950'
            : 'border-violet-500 dark:border-violet-400 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950'
        }" data-added="${isAdded}">${isAdded ? 'Remove from Your apps' : 'Add to Your apps'}</button>
      </div>

      ${actions.length ? `
      <div class="mt-5 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden divide-y divide-zinc-200 dark:divide-zinc-800">
        ${actions.map((a, i) => `
          <button type="button" class="browse-detail-action w-full flex items-center justify-between gap-2 px-3 py-3 text-sm text-left transition-colors hover:bg-zinc-500/5 ${
            a.danger ? 'text-red-500' : 'text-zinc-700 dark:text-zinc-200'
          }" data-action-index="${i}"${a.title ? ` title="${escapeHtml(a.title).replace(/"/g, '&quot;')}"` : ''}${a.disabled ? ' disabled' : ''}>
            <span>${escapeHtml(a.label)}</span>
            <svg class="w-4 h-4 shrink-0 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>`).join('')}
      </div>` : ''}`;

    if (canOpen) {
      host.querySelector('#browse-detail-open')
        ?.addEventListener('click', () => App.navigateToApp(app.slug));
    }
    host.querySelector('#browse-detail-fav')?.addEventListener('click', () => {
      Home.toggleAdded(app.slug, !Home.isYours(app), () => Browse.render());
    });
    // Each row runs the menu item's own handler, and is handed its button
    // element so a keepOpen item (Check for updates) can flip its label in
    // place exactly as it does inside the popover.
    host.querySelectorAll('.browse-detail-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = actions[parseInt(btn.dataset.actionIndex, 10)];
        if (item && typeof item.run === 'function') item.run(btn);
      });
    });
  },

  // Cold deep link (#apps/<slug> on a fresh load, or a link from
  // elsewhere): the list payload hasn't arrived or doesn't carry this
  // slug, so read the one app directly and merge it into the cache.
  async _fetchDetail(slug) {
    if (Browse._detailFetching === slug) return;
    Browse._detailFetching = slug;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const app = await res.json();
      if (app && app.slug) {
        Browse._apps = [...(Browse._apps || []).filter((a) => a.slug !== app.slug), app];
      }
      Browse._detailMissing = !app || !app.slug;
    } catch (err) {
      Browse._detailMissing = true;
    } finally {
      Browse._detailFetching = null;
      if (Browse._slug === slug) {
        Browse.render();
        Browse._syncLevel();
      }
    }
  },

  // ── Search (level 1) ──────────────────────────────────────────────
  //
  // Bound once, lazily — the input is static markup in index.html, so
  // there is no per-render listener churn and no focus loss (the same
  // discipline as Home._wireSearch).
  _wireSearch() {
    if (Browse._searchWired) return;
    const input = document.getElementById('browse-search-input');
    const clearBtn = document.getElementById('browse-search-clear');
    if (!input) return;
    Browse._searchWired = true;
    const apply = () => {
      Browse._query = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !input.value);
      Browse.render();
    };
    input.addEventListener('input', () => {
      clearTimeout(Browse._searchDebounce);
      Browse._searchDebounce = setTimeout(apply, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        input.value = '';
        clearTimeout(Browse._searchDebounce);
        apply();
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearTimeout(Browse._searchDebounce);
        apply();
        input.focus();
      });
    }
  },
};

window.Browse = Browse;
