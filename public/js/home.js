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
      // The viewer's own proposals / active sessions used to ride along
      // here as two strips at the top of the grid; both moved into the
      // header cog's drawer (public/js/work-drawer.js), which owns those
      // fetches now.
      // ?demo=1 rides on /api/apps: staging injects the icon-demo
      // tiles there (routes/apps.js demoIconApps). No-op in production.
      const demoQS = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
      const res = await fetch(`/api/apps${demoQS}`);
      if (!res.ok) throw new Error('Failed to load apps');
      const { apps } = await res.json();
      Home._apps = apps;
      Home.render();
      // The shortcut probe's heal pass may have run before _apps was
      // populated (it needs the app objects for icon payloads); retry
      // now that they're here. No-op when everything has an icon.
      Home._healWidgetIcons();
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
  // old "star", now the menu's "Add to Your apps"). #618: the member
  // pin is a per-user preference now — your_apps_hidden (a hidden
  // app_favorites row) suppresses it, so members can take their own
  // apps out of the section without giving up membership. An explicit
  // favorite still wins (is_favorited is served as false for hidden
  // rows, so both flags can't disagree).
  isYours(app) {
    return !!(app && ((app.is_collaborator && !app.your_apps_hidden) || app.is_favorited));
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

  // How many admin-featured tiles the "Find more apps" row shows.
  FEATURED_LIMIT: 6,

  // The featured row's contents for this viewer: admin-curated apps
  // (the `featured` flag served by GET /api/apps) that are NOT already
  // in "Your apps" — those are one screen-section up, so repeating
  // them would be noise. Ordered by the admin's featured_order
  // (ascending, NULLs last) and capped at FEATURED_LIMIT.
  // Pure — unit-tested in tests/home-find-more.test.js.
  featuredApps(apps) {
    return (apps || [])
      .filter((a) => a && a.featured && !Home.isYours(a))
      .sort((x, y) => {
        const xo = x.featured_order == null ? Infinity : x.featured_order;
        const yo = y.featured_order == null ? Infinity : y.featured_order;
        return xo - yo;
      })
      .slice(0, Home.FEATURED_LIMIT);
  },

  render() {
    // Same deferral as load(): a search keystroke must not yank the
    // grid out from under an in-flight drag either.
    if (Home._dragActive) {
      Home._reloadPending = true;
      return;
    }
    const listEl = document.getElementById('app-list');
    if (!listEl) return;
    const canCreate = Home.canCreate();
    const apps = Home._apps || [];
    Home._wireSearch();

    const query = (Home._query || '').trim();
    // Home is "Your apps" only now — every other app lives on the
    // #apps browse screen (public/js/browse.js), so the old All Apps
    // section and its drag-to-add gesture are gone.
    const { yours } = Home.partitionApps(apps);
    let html = '';
    let canDragYours = false;
    // Non-null only in the un-queried view: the count of "Your apps"
    // cards. null = drag fully disabled (search results are a flat,
    // transient ordering that must not be persisted as a reorder).
    let yoursCount = null;

    if (query) {
      // Active search over YOUR apps: one flat grid of matches. Section
      // header, widget strip and drag affordance all step aside until
      // the query clears — reorder is only meaningful against the
      // canonical ordering.
      const matches = Home.filterApps(yours, query);
      if (!matches.length) {
        html = `<div class="col-span-full py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No apps match &ldquo;${escapeHtml(query)}&rdquo; — try <span class="text-violet-500">Browse all apps</span> below.</div>`;
      } else {
        html = `<div class="home-section-header col-span-full">${matches.length} result${matches.length === 1 ? '' : 's'}</div>`;
        html += matches.map((a) => Home.renderAppCard(a)).join('');
      }
    } else {
      yoursCount = yours.length;
      // Legacy-path gate only: reordering is meaningless with a single
      // card. The kit path drags every card in the section, so it
      // ignores this.
      canDragYours = yours.length >= 2;
      const kitDrag = Home._useKitReorder();
      // iOS-in-app only: mirror of the homescreen widget's pinned grid,
      // manageable in place (drag in / reorder / ✕). Empty string
      // everywhere else — see _widgetUiActive.
      html = Home.renderWidgetSection();
      html += '<div class="home-section-header col-span-full">Your apps</div>';
      if (yours.length) {
        // Tag the cards at render time: data-yours drives both the
        // drag wiring's selector and the drop classification;
        // cursor-grab replaces cursor-pointer as the discoverability
        // hint when the card is draggable.
        html += yours.map((a) => {
          let card = Home.renderAppCard(a);
          card = card.replace('class="app-card ', 'data-yours="true" class="app-card ');
          if (kitDrag || canDragYours) card = card.replace('cursor-pointer', 'cursor-grab');
          return card;
        }).join('');
      } else {
        // Compact inline line, NOT a full-height empty state: the
        // sections below ("Find more apps", "Create an app") are what
        // this user needs to see, and a centered hero would push them
        // off the fold. Most accounts have zero apps here.
        html += `<div class="col-span-full pb-2 text-sm text-zinc-500 dark:text-zinc-400">You haven&rsquo;t added any apps yet — pick one below.</div>`;
      }
    }

    listEl.innerHTML = html;
    Home._wireCards(listEl, canDragYours, yoursCount);
    Home._wireWidgetStrip(listEl);
    Home.renderFindMore(apps);
    Home.renderCreateSection(canCreate);
    Home._maybeOpenShotMenu(listEl);
    Home._searchReveal.sync();
  },

  // "Find more apps": one contained card holding the admin-curated
  // featured tiles and, as its attached footer row, the way into the
  // #apps browse screen (see the card markup in index.html).
  //
  // The footer always renders — it is THE discovery path, so it must not
  // depend on curation existing. When there is nothing left to feature
  // for this viewer the tile grid is swapped for a one-line note rather
  // than hidden outright, so the card never collapses to a bare heading
  // sitting on top of a button.
  renderFindMore(apps) {
    const listEl = document.getElementById('home-featured-list');
    if (!listEl) return;
    const featured = Home.featuredApps(apps);
    listEl.innerHTML = featured
      .map((a) => Home.renderAppCard(a, { mode: 'featured' }))
      .join('');
    listEl.classList.toggle('hidden', featured.length === 0);
    const emptyEl = document.getElementById('home-featured-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', featured.length > 0);
    Home._wireDiscoveryCards(listEl);
    const btn = document.getElementById('home-browse-btn');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      // Route through the hash so the browse screen gets a real history
      // entry (the OS/browser back gesture returns here).
      btn.addEventListener('click', () => { location.hash = '#apps'; });
    }
  },

  // "Create an app": the former in-grid tile, now the page's trailing
  // section. Non-creators get the same "ask an admin" hint the old
  // empty state showed.
  renderCreateSection(canCreate) {
    const host = document.getElementById('home-create-body');
    if (!host) return;
    if (canCreate) {
      host.innerHTML = Home.renderCreateTile();
      Home.wireCreateButtons();
    } else {
      host.innerHTML = `<p class="home-create-disabled-hint text-sm text-zinc-400 dark:text-zinc-500 max-w-sm">${escapeHtml(Home.CREATE_DISABLED_HINT)}</p>`;
    }
  },

  // ===== Hidden search bar (pull-to-reveal) =====
  //
  // The bar is the first child INSIDE #home-screen and is not sticky,
  // so it occupies real scroll space above the content. Parking the
  // scroller at scrollTop = barHeight hides it; a slight pull down (a
  // scroll up on desktop) reveals it. Past that, scrollTop is 0 and
  // the kit's attachPullToRefresh — which only engages from a resting
  // scrollTop of 0 — arms the refresh. No new gesture code: the two
  // stages compose for free.
  _searchReveal: {
    _pinned: false,
    _scrollWired: false,
    _rafPending: false,

    screenEl() { return document.getElementById('home-screen'); },
    barEl() { return document.getElementById('home-search-bar'); },

    // Screenshot-state deep link (?shot=home-search): the revealed bar
    // is otherwise interaction-only, so before/after captures and
    // dapp.json tests could never see it. Pure UI state — no writes,
    // no env gate — so it works in production the moment it ships.
    shotRevealed() {
      try {
        return new URLSearchParams(location.search).get('shot') === 'home-search';
      } catch (err) { return false; }
    },

    // Focused, mid-query, or deep-linked: leave the bar wherever the
    // user put it. Anything else may be tucked away on the next render.
    isPinned() {
      if (Home._searchReveal._pinned) return true;
      if ((Home._query || '').trim()) return true;
      return Home._searchReveal.shotRevealed();
    },

    pin() { Home._searchReveal._pinned = true; },
    unpin() {
      Home._searchReveal._pinned = false;
      Home._searchReveal.sync();
    },

    // Stamp the current state on the bar so tests / screenshot checks
    // can assert it without measuring scroll offsets.
    mark() {
      const screen = Home._searchReveal.screenEl();
      const bar = Home._searchReveal.barEl();
      if (!screen || !bar) return;
      const h = bar.offsetHeight || 0;
      // Half the bar showing already reads as "revealed".
      const revealed = !h || screen.scrollTop < h / 2;
      bar.dataset.revealed = revealed ? 'true' : 'false';
    },

    // Called after every render. Tucks the bar away unless it is
    // pinned — and never yanks a user who has scrolled DOWN past it,
    // which is what makes WS-driven re-renders safe.
    sync() {
      const screen = Home._searchReveal.screenEl();
      const bar = Home._searchReveal.barEl();
      if (!screen || !bar) return;
      Home._searchReveal._wireScroll(screen);
      const h = bar.offsetHeight || 0;
      if (!Home._searchReveal.isPinned() && h && screen.scrollTop < h) {
        screen.scrollTop = h;
      }
      Home._searchReveal.mark();
    },

    _wireScroll(screen) {
      if (Home._searchReveal._scrollWired) return;
      Home._searchReveal._scrollWired = true;
      screen.addEventListener('scroll', () => {
        if (Home._searchReveal._rafPending) return;
        Home._searchReveal._rafPending = true;
        const run = () => {
          Home._searchReveal._rafPending = false;
          Home._searchReveal.mark();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
      }, { passive: true });
    },
  },

  // Screenshot-state deep link (`?shot=card-menu`, #847): the card's "…"
  // actions menu only exists after a click, so neither the before/after
  // captures nor a dapp.json test can reach it — and it's exactly the
  // surface whose missing background this param exists to prove. Opening
  // it from the URL makes it capturable and testable. Pure UI state (it
  // opens the same kit popover a click opens, writes nothing, and is not
  // env-gated), so the production "before" side works too once shipped.
  //
  // Anchored to the FIRST card in the grid so the shot is deterministic;
  // pair it with `?demo=1` in staging to pin that to a seeded demo tile
  // (routes/apps.js demoIconApps, which unshifts them to the front).
  // Fires once per page load — a later re-render (a WS app_update, a
  // search keystroke) must not pop the menu back open under the user.
  _shotMenuDone: false,

  _maybeOpenShotMenu(listEl) {
    if (Home._shotMenuDone) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'card-menu') return;
    Home._shotMenuDone = true;
    // Deferred a frame: the grid was written synchronously just above,
    // and the kit's flip/clamp placement needs the button's settled rect.
    requestAnimationFrame(() => {
      const btn = listEl.querySelector('.card-menu-btn');
      if (!btn || !btn.dataset.slug) return;
      Home.openCardMenu(btn.dataset.slug, btn);
      requestAnimationFrame(() => Home._assertMenuOpaque());
    });
  },

  // Regression lock for #847, and the second reason the deep link above
  // exists: a translucent menu is invisible to a selector/text test (every
  // row is present and correct — you just read the app grid through them),
  // so assert the SURFACE. The verdict is stamped on the popover as
  // data-surface, which a dapp.json test asserts on, and a violation also
  // logs console.error so it trips the baseline no-console-errors check on
  // the same route. Scoped to ?shot=card-menu, so a real user's menu never
  // runs this.
  _assertMenuOpaque() {
    const pop = document.querySelector('.un-popover');
    if (!pop) return; // touch idiom: an action sheet over the kit's own backdrop
    const bg = getComputedStyle(pop).backgroundColor || '';
    const m = bg.match(/^rgba?\(([^)]+)\)$/);
    const parts = m ? m[1].split(',').map((s) => parseFloat(s.trim())) : [];
    // 3 components = rgb(), fully opaque. No match at all (`transparent`,
    // an unresolved var) counts as alpha 0 — the bug this guards against.
    const alpha = parts.length >= 4 ? parts[3] : (parts.length === 3 ? 1 : 0);
    const opaque = alpha >= 0.99;
    pop.dataset.surface = opaque ? 'opaque' : 'translucent';
    if (!opaque) {
      console.error(
        `[home] card actions menu surface is translucent (${bg}) — the page reads`
        + ' through it (#847). --un-popover-bg must resolve to an opaque color.'
      );
    }
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
      // Typing pins the bar open — a re-render must never scroll the
      // field the user is typing into off the top of the screen.
      Home._searchReveal.pin();
      clearTimeout(Home._searchDebounce);
      Home._searchDebounce = setTimeout(apply, 100);
    });
    input.addEventListener('focus', () => Home._searchReveal.pin());
    // Leaving an empty field releases the pin, so the next render (or a
    // scroll down) can tuck the bar away again. A field with text in it
    // stays pinned by isPinned()'s query check.
    input.addEventListener('blur', () => {
      if (!input.value) Home._searchReveal.unpin();
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

  // ===== Discovery-grid card wiring (featured row, browse screen) =====
  //
  // Shared by Home.renderFindMore and public/js/browse.js: tiles open
  // the app on a body tap and toggle "Your apps" membership from the
  // corner badge. No drag, no "…" menu — these grids are not the
  // user's own ordering.
  //
  // `onChange` (optional) is called after a successful toggle so the
  // host can re-render its own grid; home just reloads.
  _wireDiscoveryCards(listEl, onChange) {
    if (!listEl) return;
    listEl.querySelectorAll('.app-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-add-btn')) return;
        if (card.dataset.demo === 'true') return;
        if (card.dataset.status !== 'running' && card.dataset.status !== 'awaiting_secrets') return;
        App.navigateToApp(card.dataset.slug);
      });
    });
    listEl.querySelectorAll('.card-add-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home.toggleAdded(btn.dataset.slug, btn.dataset.added !== 'true', onChange);
      });
    });
  },

  // Add / remove one app from "Your apps" from a discovery grid.
  // Same endpoint and same semantics as the card menu's entry
  // (_menuToggleFavorite): for a member, favorited=false writes the
  // per-user `hidden` opt-out rather than dropping membership.
  //
  // Optimistic: flip the flags on the cached app object, let the caller
  // re-render, and revert to server truth by reloading on failure.
  async toggleAdded(slug, desired, onChange) {
    const app = (Home._apps || []).find((a) => a.slug === slug);
    // Staging ?demo=1 tiles have no DB row — a POST would 404.
    if (!app || app.demo) return;
    const prev = { is_favorited: app.is_favorited, your_apps_hidden: app.your_apps_hidden };
    app.is_favorited = desired;
    if (app.is_collaborator) app.your_apps_hidden = !desired;
    if (typeof onChange === 'function') onChange();
    try {
      const res = await fetch(`/api/apps/${slug}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorited: desired }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      PlatformUI.toast(desired ? 'Added to Your apps' : 'Removed from Your apps');
    } catch (err) {
      app.is_favorited = prev.is_favorited;
      app.your_apps_hidden = prev.your_apps_hidden;
      PlatformUI.toast(`Update failed: ${err.message}`);
      await Home.load();
      if (typeof onChange === 'function') onChange();
    }
  },

  // ===== Per-render card wiring =====

  // `yoursCount` is the "Your apps" section size in the sectioned view
  // (0 included — adds must work with an empty section), or null when
  // drag is off entirely (search view). Only the kit path consumes it;
  // the legacy path still keys off canDragYours.
  _wireCards(listEl, canDragYours, yoursCount = null) {
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
      // Gesture wiring, two eras (spec: reorder migration, old path
      // kept behind a temporary flag for one release):
      //
      // Kit era (default): the kit's attachReorder (below, after this
      // loop) owns long-press-lift-drag on EVERY card in the sectioned
      // view (issue #746 — All Apps cards drag into "Your apps", yours
      // cards reorder or drag out). The long-press actions menu
      // survives only where the kit doesn't own the gesture: the
      // search view and inert staging demo tiles. All other cards
      // reach the menu through their "…" button. Drag-a-card-onto-
      // the-widget-strip is retired on this path (the card menu's
      // "Add to widget" covers it).
      //
      // Legacy era (localStorage platform-legacy-reorder = '1', or kit
      // failed to load): the original hand-rolled pointer machinery
      // ("Your apps" reorder only — no cross-section drags).
      if (Home._useKitReorder()) {
        if (yoursCount == null || card.dataset.demo === 'true') {
          Home._wireCardLongPressMenu(card);
        }
      } else {
        card.addEventListener('pointerdown', (e) => Home._onCardPointerDown(
          e, card, listEl,
          canDragYours && card.dataset.yours === 'true',
          !!widgetSlugs
            && card.dataset.status === 'running'
            && !widgetSlugs.has(card.dataset.slug)
        ));
      }
    });

    // Kit drag on every app card, in the kit's grid (displacement)
    // mode: long-press lifts a floating ghost that tracks the finger on
    // both axes, the real card stays in the grid as a dashed drop slot,
    // siblings FLIP aside as the slot moves, and drops are cell-accurate
    // (XY hit-testing, not row-only). Edge auto-scroll, springs, and the
    // gesture arbiter come from the kit.
    // The grid holds ONE section now ("Your apps" — every other app
    // moved to the #apps browse screen), so every drop is a reorder:
    // canDropCard vetoes nothing and _onKitCardDrop always persists an
    // order. Removing an app is the card menu's "Remove from Your apps"
    // (or the browse screen's ✓ badge). onLift/onSettle hold
    // _dragActive so a WS-driven Home.load() can't replace the grid
    // under the gesture (the legacy path's guard, now shared).
    if (Home._useKitReorder() && yoursCount != null) {
      if (Home._reorderHandle) { try { Home._reorderHandle.detach(); } catch {} }
      Home._reorderHandle = window.unNative.attachReorder(listEl, {
        grid: true,
        itemSelector: '.app-card:not([data-demo])',
        canDrop: (item, to) => Home.canDropCard(item.dataset.yours === 'true', to, yoursCount),
        onLift: () => { Home._dragActive = true; },
        onSettle: () => {
          Home._dragActive = false;
          if (Home._reloadPending) {
            Home._reloadPending = false;
            Home._rerenderPending = false;
            Home.load();
          } else if (Home._rerenderPending) {
            Home._rerenderPending = false;
            Home.render();
          }
        },
        onReorder: (from, to, item) => { Home._onKitCardDrop(from, to, item, yoursCount); },
      });
    }

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
        // Pass the element itself so the kit popover can toggle closed
        // on a re-click and manage aria-expanded.
        Home.openCardMenu(btn.dataset.slug, btn);
      });
    });
  },

  // Map structured drift-check result → a short, user-readable
  // message. Mirrors the status enum in main-drift-poller.js.
  reportCheckResult(data) {
    if (!data || !data.status) {
      PlatformUI.toast('Check finished (no details returned).');
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
        if (data.slug) {
          PlatformUI.confirm({
            title: 'Latest commit is already running',
            message: 'Force a rebuild anyway? (Useful if env vars or platform code changed.)',
            confirmLabel: 'Rebuild',
          }).then((ok) => {
            if (!ok) return;
            fetch(`/api/apps/${data.slug}/redeploy`, { method: 'POST' })
              .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `HTTP ${r.status}`))))
              .then(() => PlatformUI.toast('Rebuild started — watch the version pill.'))
              .catch((err) => PlatformUI.toast(`Rebuild kickoff failed: ${err.message}`));
          });
        }
        return;
      case 'redeployed':
        PlatformUI.toast(`Redeployed to ${(data.to || '').slice(0, 7)}.`);
        return;
      case 'in_flight':
        PlatformUI.toast('A redeploy is already in progress for this app.');
        return;
      case 'first_seen':
        PlatformUI.toast(`Recorded current SHA (${(data.sha || '').slice(0, 7)}). Future drift will trigger a redeploy.`);
        return;
      case 'fetch_failed':
        PlatformUI.toast(`Couldn't reach GitHub: ${data.error || 'unknown error'}`);
        return;
      case 'invalid_repo':
        PlatformUI.toast('This app has an invalid repo URL.');
        return;
      case 'rebuild_failed':
        PlatformUI.toast(`Drift detected (${(data.from || '').slice(0, 7)} → ${(data.attempted || '').slice(0, 7)}) but redeploy failed: ${data.error || 'unknown error'}`);
        return;
      default:
        PlatformUI.toast(`Check finished: ${data.status}`);
    }
  },

  // The "Your proposals" / "Your active sessions" strips that used to
  // render here (#194) moved into the header cog's drawer — see
  // public/js/work-drawer.js, which owns their fetches, rendering and
  // busy-state polling now.

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
        // w-full/h-full (not w-14/h-14): the tile now draws a 1px
        // hairline border, so the image fills the border box's *content*
        // area and stays flush inside the ring instead of being cropped.
        html: `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-full h-full rounded-xl object-cover">`,
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

  // `opts.mode` picks the corner control:
  //   'home' (default) — the "…" actions menu (the user's own grid)
  //   'featured' / 'browse' — an add/remove badge (`.card-add-btn`,
  //     ✓ when the app is already in "Your apps"), because a discovery
  //     grid's one meaningful per-tile action is "keep this".
  // Everything else — icon tile, status dot, users badge, fork tag,
  // click-to-open rule — is shared, so the launcher grids can't drift.
  renderAppCard(app, opts) {
    const mode = (opts && opts.mode) || 'home';
    const discovery = mode === 'featured' || mode === 'browse';
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
    // #416: hovering an errored card reveals the one-line failure
    // reason. `last_failure_reason` only rides the list payload for the
    // app's creator / collaborators / admins (server-gated), so the
    // tooltip simply doesn't render for outsiders. escapeHtml here
    // doesn't cover quotes (textContent→innerHTML), so add the
    // attribute-safe pass explicitly.
    const failureTip = isError && app.last_failure_reason
      ? ` title="${escapeHtml(String(app.last_failure_reason)).replace(/"/g, '&quot;')}"`
      : '';
    const warningHtml = statusLabel
      ? `<p class="text-xs mt-0.5 ${isAwaiting ? 'text-amber-500' : 'text-yellow-500'}"${failureTip}>${statusLabel}</p>`
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
    const showRetry = !discovery && isError
      && (App.user?.canAdminWrite || App.user?.id === app.created_by);
    const isLocked = !!app.locked;
    // Discovery grids swap the hamburger for the add/remove badge: a ✓
    // when the app is already in "Your apps", a + when it isn't. The
    // added state derives from the same isYours() predicate the home
    // grid partitions on, so the two can never disagree.
    const isAdded = Home.isYours(app);
    const addBadgeHtml = `
      <button class="card-add-btn absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full border shadow-sm transition-colors ${
        isAdded
          ? 'bg-emerald-500 border-emerald-500 text-white'
          : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-violet-600 dark:text-violet-400 hover:border-violet-400'
      }" data-slug="${app.slug}" data-added="${isAdded}" title="${
        isAdded ? 'Added — tap to remove from Your apps' : 'Add to Your apps'
      }" aria-label="${
        isAdded ? `Remove ${escapeHtml(app.name)} from Your apps` : `Add ${escapeHtml(app.name)} to Your apps`
      }" aria-pressed="${isAdded}">${
        isAdded
          ? '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
          : '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>'
      }</button>`;
    const menuBadgeHtml = discovery ? addBadgeHtml : `
      <button class="card-menu-btn absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors" data-slug="${app.slug}" title="App actions" aria-label="App actions" aria-haspopup="menu"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>`;
    const retryHtml = showRetry
      ? `<button class="retry-btn absolute top-2 right-2 text-xs text-emerald-500 hover:text-emerald-400 px-2 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors" data-slug="${app.slug}">Retry</button>`
      : '';

    // Fork lineage tag: a small amber ⑂ badge on the icon's bottom-left
    // corner (opposite the hamburger badge) marking this tile as a fork.
    // The full "Forked from <name>" label lives in the app-view header;
    // here it's glyph-only with the resolved live name (or "<deleted>")
    // in the tooltip. `forked_from` is null for non-forks.
    const forkName = app.forked_from && typeof app.forked_from === 'object'
      ? (app.forked_from.name || '<deleted>') : null;
    const forkTagHtml = forkName
      ? `<span class="fork-tag absolute -bottom-1 -left-1 w-5 h-5 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold shadow-sm" title="Forked from ${escapeHtml(forkName)}" aria-label="Forked from ${escapeHtml(forkName)}">⑂</span>`
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
    // Staging ?demo=1 tiles (routes/apps.js demoIconApps) carry
    // data-demo so the kit drag's :not([data-demo]) selector skips
    // them — their slugs don't exist in the DB, so a drag-to-favorite
    // would 404. They keep the long-press menu instead.
    const demoAttr = app.demo ? ' data-demo="true"' : '';
    return `
      <div class="app-card app-card-draggable touch-pan-y relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-2 ${cursorClass}" data-slug="${app.slug}" data-status="${app.status}" data-locked="${isLocked}"${demoAttr}>
        ${retryHtml}
        <div class="relative w-14 h-14 shrink-0">
          <div class="app-icon-tile w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center font-bold text-xl" data-icon="${icon.kind}">
            ${icon.html}
          </div>
          ${menuBadgeHtml}
          ${forkTagHtml}
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

  // "Build your own app" placeholder, rendered in the home screen's
  // "Create an app" section (it used to be the last tile in the grid).
  // Layout mirrors a real tile (thumbnail + title row, pill
  // stacked on the left) but with a dashed violet outline around the
  // card and a dashed, muted thumbnail (.app-icon-tile--empty) to
  // telegraph "this slot is empty, tap to fill it".
  // The click target is just the inner pill (.home-create-btn,
  // wired in Home.wireCreateButtons) — clicking the surrounding
  // tile chrome is intentionally inert so the tile reads as
  // "decorative frame around a button" rather than "button-shaped
  // hover surface". Hover/active styles live on the pill itself.
  renderCreateTile() {
    return `
      <div class="home-create-tile rounded-xl bg-violet-500/[0.02] dark:bg-violet-500/[0.04] p-3 flex flex-col items-center text-center gap-2">
        <div class="app-icon-tile app-icon-tile--empty w-14 h-14 rounded-xl flex items-center justify-center font-bold text-xl shrink-0">
          Y
        </div>
        <div class="italic text-sm text-zinc-500 dark:text-zinc-400 truncate max-w-full">Build your own app</div>
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
      ? 'Drag tiles to reorder. Drag cards from Your apps here to add them.'
      : 'Drag a card from Your apps here (or use its menu) to add it to the Usernode widget on your home screen.';
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
    // Same three kinds as the home card's iconTileFor, tagged with the
    // same data-icon so the tile treatment (app.css) can single out the
    // letter fallback for its fainter glyph colour.
    let iconHtml;
    let iconKind;
    if (app && app.icon_url) {
      iconKind = 'image';
      iconHtml = `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-full h-full rounded-lg object-cover">`;
    } else if (app && app.icon_emoji) {
      iconKind = 'emoji';
      iconHtml = `<span class="text-xl leading-none" aria-hidden="true">${escapeHtml(app.icon_emoji)}</span>`;
    } else {
      iconKind = 'letter';
      iconHtml = escapeHtml(String(name).charAt(0).toUpperCase());
    }
    // touch-pan-y + select-none for the same reason as app cards: keep
    // vertical scroll native until the tile drag actually claims the
    // gesture (see _onWidgetTilePointerDown).
    return `
      <div class="widget-tile app-card-draggable touch-pan-y relative flex flex-col items-center gap-1 w-16 cursor-grab" data-wid="${escapeHtml(item.id)}"${slug ? ` data-wslug="${escapeHtml(slug)}"` : ''}>
        <div class="app-icon-tile w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center font-bold text-base" data-icon="${iconKind}">${iconHtml}</div>
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
    if (Home._useKitReorder()) {
      // Kit reorder on the widget tiles (same flag as the card grid), in
      // the kit's grid (displacement) mode — the list model's Y-only
      // ghost and drop line are degenerate for a one-row tile strip
      // (issue #770). onLift/onSettle hold _dragActive so a WS-driven
      // Home.load() can't replace the strip mid-gesture (same guard as
      // the card grid above).
      if (Home._widgetReorderHandle) { try { Home._widgetReorderHandle.detach(); } catch {} }
      Home._widgetReorderHandle = window.unNative.attachReorder(strip, {
        grid: true,
        itemSelector: '.widget-tile',
        onLift: () => { Home._dragActive = true; },
        onSettle: () => {
          Home._dragActive = false;
          if (Home._reloadPending) {
            Home._reloadPending = false;
            Home._rerenderPending = false;
            Home.load();
          } else if (Home._rerenderPending) {
            Home._rerenderPending = false;
            Home.render();
          }
        },
        onReorder: () => { Home._saveWidgetOrder(strip); },
      });
    } else {
      strip.querySelectorAll('.widget-tile').forEach((tile) => {
        tile.addEventListener('pointerdown', (e) =>
          Home._onWidgetTilePointerDown(e, tile, strip));
      });
    }
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
      PlatformUI.toast(`Remove from widget failed: ${(err && err.message) || err}`);
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
      PlatformUI.toast(`Widget reorder failed: ${(err && err.message) || err}`);
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
    // Start watching the system appearance here rather than inside the
    // widget branch below: the probe resolves asynchronously, so the
    // registration would otherwise race a flip that happens during it.
    // The handler is inert until the widget mechanism is known anyway.
    Home._watchWidgetScheme();
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
    await Home._healWidgetIcons();
  },

  // Widget icons drift out of sync with SV app data in two ways:
  //   - The icon PNG never landed in the app's widget store (pinned by
  //     an older page build, or the download failed) — the registry
  //     reports has_icon:false.
  //   - The stored PNG is stale: the app gained/changed/lost its
  //     icon_url after pinning (e.g. an icon proposal passed), or the
  //     canvas-tile rendering changed (WIDGET_ICON_GEN bump). The
  //     registry still reports has_icon:true, so staleness is detected
  //     by remembering which icon source was last sent per shortcut id
  //     (localStorage) and comparing against the current desired source.
  // Either way the fix is the same: silently re-add with the current
  // icon payload — re-pinning the same URL is an in-place refresh, so
  // order is kept and no instruction walkthrough pops. One attempt per
  // shortcut id per page load so a persistently failing icon can't loop.
  //
  // WIDGET_ICON_GEN versions the canvas-tile rendering; it's part of
  // the recorded source string for tile-based icons, so bumping it
  // makes every canvas tile read as stale and re-send once.
  //   gen 2: pixel-centered glyphs (_drawGlyphCentered) — emoji tiles
  //          used to come out anchored bottom-left on iOS WebKit.
  //   gen 3: white rounded-tile face + faint grey hairline + dark-grey
  //          letter, matching the new .app-icon-tile treatment (was a
  //          flat violet-600/20 square with a violet-400 letter).
  //   gen 4: the letter glyph steps down to the faint grey the in-app
  //          letter tiles now use (--text-faint); emoji unchanged.
  //   gen 5: the tile is rendered per colour scheme instead of pinning
  //          the light face — gen 3/4 baked an opaque #ffffff square,
  //          which read as a bright white tile on a dark homescreen.
  //          The scheme is also part of the source marker below, so a
  //          light↔dark flip re-sends on top of this one-time bump.
  WIDGET_ICON_GEN: 5,
  // The two faces the canvas tile can wear, mirroring `.app-icon-tile`
  // in app.css. Light is the pre-existing treatment, unchanged; dark
  // uses the same tokens the CSS tile resolves to under `.dark`
  // (--bg-secondary / --border / --text-faint). Emoji glyphs are never
  // recoloured — they carry their own colours in both schemes.
  WIDGET_TILE_PALETTE: {
    light: { face: '#ffffff', hairline: '#e4e4e7', letter: '#a1a1aa' },
    dark: { face: '#1a1a30', hairline: '#2e2e50', letter: '#9898b0' },
  },
  // The colour scheme the widget PNG should be painted for.
  //
  // Deliberately the SYSTEM appearance (prefers-color-scheme), NOT the
  // `.dark` class / Theme.get(): the PNG is consumed by the iOS
  // homescreen widget, which renders under the system appearance and
  // cannot see SV's in-app Light/Dark/System override. Keying off the
  // in-app theme would paint a light widget onto a dark homescreen
  // whenever someone forces SV to light.
  //
  // Falls back to 'light' wherever matchMedia is missing (old WebViews,
  // the vm sandbox in tests) — _desiredIconSrcFor runs on every heal
  // pass, so throwing here would break icon healing outright.
  _schemeQuery() {
    try {
      return typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    } catch (_) { return null; }
  },
  _widgetScheme() {
    const mq = Home._schemeQuery();
    return (mq && mq.matches) ? 'dark' : 'light';
  },
  _iconSrcKey: 'sv:widget_icon_src',
  _iconHealTried: null,
  // The icon source the widget *should* have for this app right now.
  // Image icons: the absolute URL (matches _shortcutPayloadFor). Canvas
  // tiles: an opaque marker keyed by emoji + rendering generation + the
  // scheme the PNG was painted for, so flipping the system appearance
  // marks every canvas tile stale and re-sends it. The scheme is NOT
  // part of the image-icon marker — that payload is the app's own URL
  // and looks identical in both schemes, so folding it in would re-send
  // every image tile on each flip for no visual change.
  _desiredIconSrcFor(app) {
    return app.icon_url
      ? new URL(app.icon_url, location.origin).href
      : `tile:${Home.WIDGET_ICON_GEN}:${Home._widgetScheme()}:${app.icon_emoji || ''}`;
  },
  // Re-paint pinned canvas tiles when the system appearance flips.
  //
  // Registered once per page load. The heal pass itself is gated on the
  // widget mechanism + the bridge, so this is inert on web, Android and
  // desktop; the handler only does work when the scheme ACTUALLY moved,
  // so a spurious media event can't re-send the whole grid.
  _widgetSchemeWatching: false,
  _widgetSchemeSeen: null,
  _watchWidgetScheme() {
    if (Home._widgetSchemeWatching) return;
    Home._widgetSchemeWatching = true;
    Home._widgetSchemeSeen = Home._widgetScheme();
    const mq = Home._schemeQuery();
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', Home._onWidgetSchemeChange);
    }
    // Theme also re-broadcasts OS changes while the user is in "system"
    // mode. Redundant with the query above, but free: the equality
    // guard below turns a duplicate notification into a no-op, and it
    // costs nothing where window.Theme isn't loaded (tests, standalone).
    if (window.Theme && typeof window.Theme.onChange === 'function') {
      window.Theme.onChange(Home._onWidgetSchemeChange);
    }
  },
  _onWidgetSchemeChange() {
    const scheme = Home._widgetScheme();
    if (scheme === Home._widgetSchemeSeen) return;
    Home._widgetSchemeSeen = scheme;
    // Load-bearing: _iconHealTried caps sends to one attempt per
    // shortcut id per page load. Without clearing it the flip would
    // mark every tile stale and then skip all of them.
    Home._iconHealTried = null;
    Promise.resolve(Home._healWidgetIcons()).catch(() => {});
  },
  _loadIconSrcMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(Home._iconSrcKey));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; /* private mode / corrupt */ }
  },
  async _healWidgetIcons() {
    if (Home._shortcutSupport?.mechanism !== 'widget') return;
    const bridge = window.usernode;
    if (!bridge || typeof bridge.addHomeScreenShortcut !== 'function') return;
    const tried = (Home._iconHealTried ||= new Set());
    const srcMap = Home._loadIconSrcMap();
    let mapDirty = false;
    let healed = false;
    const liveIds = new Set();
    for (const item of Home._widgetItems || []) {
      liveIds.add(item.id);
      if (tried.has(item.id)) continue;
      const slug = Home._widgetSlugFor(item);
      const app = slug ? (Home._apps || []).find((a) => a.slug === slug) : null;
      // Foreign shortcuts (no SV slug) can never be healed here; SV
      // entries whose app hasn't loaded yet are left un-tried so a
      // later pass retries once the apps list lands.
      if (!app) continue;
      const desired = Home._desiredIconSrcFor(app);
      const needsIcon = item.has_icon === false;
      const stale = srcMap[item.id] !== desired;
      if (!needsIcon && !stale) continue;
      tried.add(item.id);
      try {
        await bridge.addHomeScreenShortcut({
          ...Home._shortcutPayloadFor(app),
          silent: true,
        });
        healed = true;
        srcMap[item.id] = desired;
        mapDirty = true;
      } catch (_) { /* denied / old build — leave the fallback tile */ }
    }
    // Drop records for shortcuts no longer in the registry so the map
    // can't grow without bound as apps are pinned and unpinned.
    for (const id of Object.keys(srcMap)) {
      if (!liveIds.has(id)) {
        delete srcMap[id];
        mapDirty = true;
      }
    }
    if (mapDirty) {
      try {
        localStorage.setItem(Home._iconSrcKey, JSON.stringify(srcMap));
      } catch (_) { /* private mode — retried next load, sends deduped by `tried` */ }
    }
    if (healed) {
      try {
        const resp = await bridge.getHomeScreenShortcuts();
        if (resp && Array.isArray(resp.items)) Home._widgetItems = resp.items;
      } catch (_) { /* keep the pre-heal snapshot */ }
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
  // One adaptive menu shared by the desktop "⋯" button and the mobile
  // long-press (see _onCardPointerDown). Built lazily on open from the
  // app object in the Home._apps cache — no hidden per-card menus in
  // the DOM. Presentation is kit-owned via PlatformUI.menu (#741):
  // bottom action sheet on touch, anchored popover (flip/clamp
  // positioning, outside-pointerdown / Escape / scroll / resize
  // dismissal, menu focus handling) on desktop.
  _menu: null,

  // Pure item builder, separate from the DOM so tests can pin the
  // permission gating. Mutating controls gate on canAdminWrite (full
  // admin) — view-only admins don't get them (issue #311); Retry stays
  // creator-or-full-admin.
  //
  // The Your-apps entry renders for EVERY app so the affordance is
  // always discoverable. #618: membership (is_collaborator — you
  // created or help build the app) no longer hard-pins the app there;
  // members get a working Remove/Add pair driven by your_apps_hidden
  // (a per-user, display-only opt-out — access and permissions are
  // untouched). The explicit desired value is passed through because
  // a pinned member app usually has is_favorited=false, so the
  // non-member "!is_favorited" derivation would send the wrong
  // direction.
  menuItemsFor(app) {
    const items = [];
    const user = App.user || {};
    const isRunning = app.status === 'running';
    const isError = app.status === 'error';
    if (app.is_collaborator) {
      items.push({
        key: 'favorite',
        label: app.your_apps_hidden ? 'Add to Your apps' : 'Remove from Your apps',
        title: app.your_apps_hidden
          ? 'Show this app in Your apps again. You keep your builder access either way.'
          : 'Hide this app from Your apps — it stays live and you keep your builder access.',
        run: () => Home._menuToggleFavorite(app, !!app.your_apps_hidden),
      });
    } else {
      items.push({
        key: 'favorite',
        label: app.is_favorited ? 'Remove from Your apps' : 'Add to Your apps',
        run: () => Home._menuToggleFavorite(app, !app.is_favorited),
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
    // #416: "View build log" for involved users — on errored apps, and
    // on running apps whose last recorded failure post-dates the last
    // successful deploy (a failed rebuild: the old container keeps
    // serving, but the rebuild died). `last_failure_reason/_at` only
    // ride the list payload when the server-side involved-user gate
    // passed, so the timestamp check below can't fire for outsiders.
    const canSeeBuildLog = app.is_collaborator || user.canAdminWrite || user.id === app.created_by;
    const rebuildFailed = isRunning && app.last_failure_at
      && (!app.last_deploy_at || new Date(app.last_failure_at) > new Date(app.last_deploy_at));
    if (canSeeBuildLog && (isError || rebuildFailed)) {
      items.push({
        key: 'build-log',
        label: 'View build log',
        title: app.last_failure_reason || 'See why the last build/deploy failed',
        run: () => window.BuildLog && BuildLog.open(app.slug),
      });
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
    // Fork: available to anyone who can see the app (every card in this
    // list is already visibility-filtered server-side, so presence here
    // implies view access). Hidden for the platform self-app, which has
    // no per-app repo/DB/container to clone. Reuses the same fork dialog
    // + POST /api/apps/:slug/fork flow as the app-view header action.
    if (!app.self_hosted && typeof AppView !== 'undefined' && AppView.promptFork) {
      items.push({
        key: 'fork',
        label: 'Fork this app',
        title: 'Create your own independent copy of this app',
        run: () => AppView.promptFork({ slug: app.slug, name: app.name }),
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

  // anchor: the trigger Element (the "…" button — lets the kit toggle
  // the menu closed on a re-click) or a plain rect (the card's
  // bounding box from the long-press paths).
  openCardMenu(slug, anchor) {
    Home.closeCardMenu();
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    const items = Home.menuItemsFor(app);
    if (!items.length) return;

    // Rich build-info header is a desktop-popover affordance; the
    // touch action sheet falls back to the plain title. The kit menu
    // owns positioning, dismissal and focus; disabled rows render
    // inert in the popover and are omitted from the sheet; keepOpen
    // items (Check for updates) flip their label in place via the row
    // element the popover hands the handler (null on the sheet path —
    // run() already copes).
    const headerEl = document.createElement('div');
    headerEl.className = 'card-menu-header';
    headerEl.innerHTML = Home.renderMenuHeaderHtml(app);
    const anchorIsEl = !!(anchor && typeof anchor.getBoundingClientRect === 'function');
    const menu = PlatformUI.menu({
      anchorEl: anchorIsEl ? anchor : undefined,
      anchorRect: anchorIsEl ? undefined : anchor,
      title: app.name || app.slug,
      headerEl,
      items: items.map((i) => ({
        label: i.label,
        destructive: !!i.danger,
        disabled: !!i.disabled,
        keepOpen: !!i.keepOpen,
        title: i.title,
        handler: (btn) => i.run(btn || null),
      })),
    });
    Home._menu = menu;
    menu.then(() => {
      if (Home._menu === menu) Home._menu = null;
    });
  },

  closeCardMenu() {
    const menu = Home._menu;
    Home._menu = null;
    if (menu && typeof menu.dismiss === 'function') menu.dismiss();
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

  // Draws `text` onto a scratch canvas, finds its ink (alpha) bounding
  // box, and blits it centered into the size x size target. Returns
  // false when the 2D APIs needed aren't available or nothing was
  // drawn, so callers can fall back to plain fillText.
  _drawGlyphCentered(ctx, size, text, font, color) {
    try {
      const scratch = document.createElement('canvas');
      const s = size * 2; // headroom for glyphs that overflow their box
      scratch.width = s;
      scratch.height = s;
      const sctx = scratch.getContext('2d');
      if (!sctx || typeof sctx.getImageData !== 'function'
        || typeof ctx.drawImage !== 'function') return false;
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = font;
      if (color) sctx.fillStyle = color;
      sctx.fillText(text, s / 2, s / 2);
      const data = sctx.getImageData(0, 0, s, s).data;
      let minX = s, minY = s, maxX = -1, maxY = -1;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          if (data[(y * s + x) * 4 + 3] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return false; // nothing drawn (blank glyph?)
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      ctx.drawImage(
        scratch, minX, minY, w, h,
        Math.round((size - w) / 2), Math.round((size - h) / 2), w, h
      );
      return true;
    } catch (_) {
      return false;
    }
  },

  // Renders the SV emoji/letter tile to a PNG data URI so the native
  // homescreen widget shows the exact tile the app shows — the same
  // face + hairline + faint letter as `.app-icon-tile` (app.css). Drawn
  // as a rounded rect (radius scaled from the in-app 12px-on-56px tile)
  // so the corners stay transparent and the shape reads correctly on the
  // widget's own surface, light or dark.
  //
  // A PNG can't follow the system theme the way the CSS tile does, so
  // the palette is chosen at render time from the CURRENT system
  // appearance (_widgetScheme) and the scheme rides along in the source
  // marker — a light↔dark flip makes every pinned tile stale and
  // _healWidgetIcons re-sends it in the other palette. Apps with a real
  // icon image skip this (the image URL is passed through instead).
  _widgetIconDataUrl(app) {
    try {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const stroke = 2;
      const inset = stroke / 2;
      const radius = Math.round(size * (12 / 56)); // rounded-xl at 56px
      const box = size - stroke;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(inset, inset, box, box, radius);
      } else {
        // Safari < 16.4 / older WebViews: hand-rolled rounded rect.
        ctx.beginPath();
        ctx.moveTo(inset + radius, inset);
        ctx.arcTo(inset + box, inset, inset + box, inset + box, radius);
        ctx.arcTo(inset + box, inset + box, inset, inset + box, radius);
        ctx.arcTo(inset, inset + box, inset, inset, radius);
        ctx.arcTo(inset, inset, inset + box, inset, radius);
        ctx.closePath();
      }
      // Light: #ffffff face / #e4e4e7 hairline (unchanged).
      // Dark: #1a1a30 face / #2e2e50 hairline — the tokens `.dark
      // .app-icon-tile` resolves to. The hairline is what keeps the
      // tile shape legible against iOS's own dark widget material, so
      // it must not be dropped in the dark palette.
      const palette = Home.WIDGET_TILE_PALETTE[Home._widgetScheme()]
        || Home.WIDGET_TILE_PALETTE.light;
      ctx.fillStyle = palette.face;
      ctx.fill();
      ctx.strokeStyle = palette.hairline;
      ctx.lineWidth = stroke;
      ctx.stroke();
      const text = app.icon_emoji
        || String(app.name || '?').charAt(0).toUpperCase();
      const font = app.icon_emoji
        ? '72px system-ui, sans-serif'
        : 'bold 64px system-ui, sans-serif';
      // Letters only — emoji keep their own colour glyphs. The faint
      // grey matches .app-icon-tile[data-icon="letter"] (--text-faint).
      const color = app.icon_emoji ? null : palette.letter;
      // Pixel-centering first: textAlign/textBaseline metrics misplace
      // emoji glyphs in iOS WebKit (tiles came out anchored bottom-left),
      // and measured glyph bounds are just as unreliable across engines.
      // Ink bounds never lie. Fall back to the anchor heuristic where
      // getImageData isn't available.
      if (!Home._drawGlyphCentered(ctx, size, text, font, color)) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font;
        if (color) ctx.fillStyle = color;
        ctx.fillText(text, size / 2, size / 2 + (app.icon_emoji ? 4 : 2));
      }
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  },

  // The addHomeScreenShortcut payload for an SV app — shared by the add
  // flows and the icon-heal pass so every path sends the same icon.
  _shortcutPayloadFor(app) {
    return {
      name: app.name,
      url: `${location.origin}/#app/${encodeURIComponent(app.slug)}`,
      // Real icon image: absolute URL the app downloads. Emoji/letter
      // tiles: canvas-rendered PNG data URI so the widget matches the
      // in-app tile exactly.
      icon_url: app.icon_url
        ? new URL(app.icon_url, location.origin).href
        : Home._widgetIconDataUrl(app),
    };
  },

  // Shared by the hamburger item and the drag-onto-strip drop. On iOS a
  // successful add lands in the widget registry, so the strip is
  // re-fetched and re-rendered to show the new tile.
  async _addShortcutForApp(app) {
    try {
      await window.usernode.addHomeScreenShortcut(Home._shortcutPayloadFor(app));
      if (Home._shortcutSupport?.mechanism === 'widget') {
        await Home._refreshWidgetItems();
        Home.render();
      }
      return true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/denied/i.test(msg)) PlatformUI.toast(`Add to home screen failed: ${msg}`);
      return false;
    }
  },

  // `desired` is the explicit favorited value to send. menuItemsFor
  // always passes it; the !is_favorited fallback keeps any legacy
  // caller working for non-member apps. For member apps the server
  // maps favorited=false to a hidden opt-out row rather than a delete
  // (#618), so the same endpoint drives both card menu states.
  async _menuToggleFavorite(app, desired) {
    const next = typeof desired === 'boolean' ? desired : !app.is_favorited;
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
      if (app.is_collaborator) app.your_apps_hidden = !next;
      await Home.load();
    } catch (err) {
      PlatformUI.toast(`Update failed: ${err.message}`);
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
        PlatformUI.toast(data.error || `Check failed (HTTP ${res.status})`);
      } else {
        Home.reportCheckResult(data);
      }
    } catch (err) {
      PlatformUI.toast(`Check failed: ${err.message}`);
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
        PlatformUI.toast(data.error || `Lock toggle failed (HTTP ${res.status})`);
        return;
      }
      Home.updateAppCardLock(app.slug, nextLocked);
    } catch (err) {
      PlatformUI.toast(`Lock toggle failed: ${err.message}`);
    }
  },

  async _menuDelete(app) {
    if (!await PlatformUI.confirm({ title: 'Delete this app?', message: 'This removes the app for everyone.', confirmLabel: 'Delete', danger: true })) return;
    const res = await fetch(`/api/apps/${app.slug}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      PlatformUI.toast(data.error || `Delete failed (HTTP ${res.status})`);
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
  // Kit path: a cross-section drop updates Home._apps inside onReorder
  // (which fires while _dragActive still holds) and schedules the
  // cheap local re-render here; onSettle consumes it. A full
  // _reloadPending (server refetch) wins when both are set.
  _rerenderPending: false,
  // Eats the synthetic click the browser fires right after the
  // pointerup that ends a drag (see the card click handler in load()).
  _suppressClick: false,
  _reorderHandle: null,
  _widgetReorderHandle: null,

  // Kit-vs-legacy reorder switch (spec: keep the old code path behind a
  // temporary flag for one release). Kit path is the default; set
  // localStorage['platform-legacy-reorder'] = '1' to fall back to the
  // hand-rolled drag if the kit physics regress on some device.
  _useKitReorder() {
    let legacy = false;
    try { legacy = localStorage.getItem('platform-legacy-reorder') === '1'; } catch {}
    return !legacy && !!(window.unNative && typeof window.unNative.attachReorder === 'function');
  },

  // ===== Drop classification =====
  //
  // The home grid is "Your apps" only now (every other app lives on the
  // #apps browse screen), so there is no second section to drag into or
  // out of: the old cross-section add / remove drops (issue #746) have
  // no target left, and removal is the card menu's "Remove from Your
  // apps" (or the browse screen's ✓ badge) instead.
  //
  // Both helpers are kept — rather than inlined — because they are the
  // unit-tested seam for this behaviour (tests/home-drag-add.test.js).
  //
  // Every in-grid slot is now a legal reorder target.
  canDropCard(_isYours, _to, _yoursCount) {
    return true;
  },

  // Pure classifier for a completed kit drop: always a reorder within
  // "Your apps", clamped to the section so a drop past the last card
  // appends rather than writing an out-of-range index.
  classifyCardDrop(from, to, yoursCount) {
    // yoursCount == null means the caller doesn't know the section size
    // (drag is disabled in that view anyway) — take `to` as given rather
    // than clamping against a number we don't have.
    if (yoursCount == null) return { kind: 'reorder', index: Math.max(0, to) };
    const last = Math.max(0, yoursCount - 1);
    return { kind: 'reorder', index: Math.max(0, Math.min(to, last)) };
  },

  // Pure builder for the new "Your apps" slug order after a drop:
  // moves `slug` to `index` within `yoursSlugs`. (It also tolerates a
  // slug absent from the list — it inserts in that case — which is why
  // it needs no change now that only reorders reach it.)
  buildYoursOrder(yoursSlugs, slug, index) {
    const order = (yoursSlugs || []).filter((s) => s !== slug);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, slug);
    return order;
  },

  // Completed kit drop: classify, update the Home._apps cache
  // optimistically (the re-render is deferred to onSettle via
  // _rerenderPending — onReorder fires while _dragActive still holds),
  // then persist. Failure reverts to server truth via Home.load(),
  // same optimistic-then-revert shape as _menuToggleFavorite.
  _onKitCardDrop(from, to, item, yoursCount) {
    const drop = Home.classifyCardDrop(from, to, yoursCount);
    const slug = item?.dataset?.slug;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    // New section order: current yours slugs with the dragged one at its
    // drop index. Mirror the server's contiguous sort_order rewrite
    // locally so the deferred re-render agrees with what
    // PUT /api/favorites/order is about to persist.
    const yoursSlugs = Home.partitionApps(Home._apps).yours.map((a) => a.slug);
    const order = Home.buildYoursOrder(yoursSlugs, slug, drop.index);
    order.forEach((s, i) => {
      const a = (Home._apps || []).find((x) => x.slug === s);
      if (a) a.favorite_order = i;
    });
    Home._rerenderPending = true;
    Home._persistYoursDrop(drop.kind, app, order);
  },

  // Persist a classified drop. Reorders (the only kind the home grid
  // produces now) skip the favorite POST — membership is unchanged. The
  // non-reorder branch is retained for the legacy pointer path's
  // remove-by-drag, which passes 'remove'.
  async _persistYoursDrop(kind, app, order) {
    try {
      if (kind !== 'reorder') {
        const res = await fetch(`/api/apps/${app.slug}/favorite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favorited: kind === 'add' }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }
      if (order) {
        const res = await fetch('/api/favorites/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }
      // Confirmation on removal only: the card jumps to its
      // activity-ordered slot in All Apps (possibly off-screen), so
      // the move needs a word; adds and reorders are self-evident.
      if (kind === 'remove') PlatformUI.toast('Removed from Your apps');
    } catch (err) {
      PlatformUI.toast(`Update failed: ${err.message}`);
      await Home.load();
    }
  },

  // Kit-era long-press actions menu for cards the kit reorder does NOT
  // own (non-"Your apps" cards). Joins the kit's gesture arbiter at
  // fire time — if the touch is already claimed (swipe, PTR, a reorder
  // lift), the menu backs off, so the two long-presses can't fight.
  _wireCardLongPressMenu(card) {
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.button !== 0) return;
      if (e.target.closest('.card-menu-btn') || e.target.closest('.retry-btn')) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let timer = setTimeout(() => {
        timer = null;
        const g = PlatformUI.gestures();
        if (g && !g.claim('touch', 'home-card-menu')) return;
        // Eat the synthetic click the browser fires on finger lift so
        // releasing the long-press doesn't also open the app.
        Home._suppressClick = true;
        setTimeout(() => { Home._suppressClick = false; }, 700);
        Home.openCardMenu(card.dataset.slug, card.getBoundingClientRect());
      }, 350);
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', cleanup);
        card.removeEventListener('pointercancel', cleanup);
      };
      const onMove = (ev) => {
        // Movement before the timer fires means scrolling — bail.
        if (Math.abs(ev.clientX - startX) > 10 || Math.abs(ev.clientY - startY) > 10) cleanup();
      };
      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', cleanup);
      card.addEventListener('pointercancel', cleanup);
    });
  },

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
      PlatformUI.toast(`Reorder failed: ${err.message}`);
      await Home.load();
    }
  },

  // Empty-state ("No apps yet") has two variants — the existing
  // "Create your first app" CTA for users with permission, and a
  // muted "Ask an admin to enable app creation" hint for users
  // without. Toggle the CTA button on/off in place rather than
  // rebuilding the static DOM, so the surrounding "No apps yet"
  // copy stays put.
  // Shown in the "Create an app" section (Home.renderCreateSection)
  // instead of the create tile when this account has no app quota.
  // Kept as a constant so both that renderer and any future surface
  // word it the same way.
  CREATE_DISABLED_HINT: 'Ask an admin to enable app creation for your account.',

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
