const Home = {
  // Can this viewer create apps right now? Derived per request by
  // /api/auth/me as `isAdmin || live app count < app_quota`, so it flips
  // without any user action — creating your one allowed app, an admin
  // editing your quota, an app erroring out.
  //
  // It gates the create WIDGET's appearance only, never whether the widget
  // exists: the widget is on every home screen, in the layout, for every
  // account (see HomePanels.renderCreatePanel for why).
  //
  // ?shot=create-disabled forces the locked rendering regardless. That is
  // not a convenience: every capture identity is an admin, and the only
  // zero-quota staging fixture carries a sentinel password and cannot be
  // signed into — so without a URL the MAJORITY rendering (most accounts
  // carry no quota) would be invisible to before/after screenshots and to
  // every declared check. Pure UI state: it flips one boolean at render
  // time, writes nothing, and is not env-gated, so it works in production
  // the moment it ships.
  canCreate() {
    try {
      if (new URLSearchParams(location.search).get('shot') === 'create-disabled') return false;
    } catch (err) { /* ignore */ }
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
    // Home-screen widgets (#911, public/js/home-panels.js) and the viewer's
    // stored grid layout (public/js/home-layout.js). Both are TTL-guarded /
    // de-duped inside, so the dozen WS/event paths that call load() don't
    // turn into a dozen fetches.
    //
    // Deliberately NOT awaited — the grid must not wait on a second request
    // to paint. But the fetches race, and losing that race used to cost the
    // widgets their drag: with no registry yet, render() plants no slots, so
    // the blocks fell back to the #home-panels section, which has no drag
    // wiring at all. Re-render once either lands if the grid is already
    // painted without slots. Self-terminating — the slots then exist — and
    // render() defers itself mid-drag like every other path.
    const repaint = () => {
      // Gated on _apps, not on the DOM: "the grid has painted a payload" is
      // the condition, and #app-list is non-empty for the failure state too.
      if (!Home._apps) return;
      // An active search legitimately has no slots — the section below the
      // grid is that view's host on purpose. Re-rendering would be a no-op
      // at best and would rebuild the results grid for nothing.
      if ((Home._query || '').trim()) return;
      Home.render();
    };
    window.HomePanels?.ensureLoaded()?.then(repaint);
    Home._ensureLayoutLoaded()?.then(repaint);
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
      // The #apps browse screen shares this payload and can be the screen
      // actually on top — its cards run the same "…" menu, whose actions
      // (add/remove, retry, lock, delete) all settle by calling back into
      // Home.load(). Without this hand-off the browse grid would keep
      // rendering pre-action state until the user navigated away.
      if (window.Browse?.isOpen?.()) Browse.syncFrom(apps);
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

  // How many admin-featured tiles the "Featured apps" row shows.
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

  // ===== Free-form grid layout =====
  //
  // The viewer's arrangement, per column count: { "4": [item…], "5": […] }.
  // Populated from GET /api/home-layout; a width with an empty array has
  // never been dragged and is DERIVED on demand (see currentLayout).
  _layouts: null,
  _layoutFetchedAt: 0,
  _layoutInflight: null,
  LAYOUT_TTL_MS: 60 * 1000,

  // True when `_layouts` came from the staging ?demo=1 payload rather than
  // this viewer's own rows. That payload is READ-ONLY by contract — it
  // exists so a reviewer signed in as any cloned identity can see the
  // feature — so nothing derived from it may be written back. Without this
  // flag the very first paint persists it: the demo layout references demo
  // apps that don't exist for the viewer, repair() drops them, and the
  // "stored layout was corrected" path then overwrites their real cells
  // with a repaired copy of the fixture.
  _layoutIsDemo: false,

  // The column count the grid is rendering at right now. Read from the
  // viewport, NOT from the DOM: it has to be answerable before the first
  // paint, and it must agree with the `grid-cols-4 sm:grid-cols-5` classes
  // on #app-list — HomeLayout.BREAKPOINT_PX is the single source for that
  // 640px boundary.
  currentCols() {
    const w = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    return HomeLayout.columnsForWidth(w);
  },

  // Every item that should be on the grid right now, as stable ids: the
  // viewer's apps plus the widgets they haven't hidden. This is the input
  // HomeLayout.repair reconciles a stored layout against.
  //
  // The `create` widget is in here for EVERY account — HomePanels.gridSlotKeys
  // filters on hidden-ness alone and never on app quota. A quota change must
  // never look like "this item disappeared", or losing quota would delete the
  // widget from the layout and re-place it somewhere else on the way back.
  presentIds() {
    const { yours } = Home.partitionApps(Home._apps || []);
    const ids = yours.map((a) => `app:${a.slug}`);
    for (const key of (window.HomePanels?.gridSlotKeys?.() || [])) ids.push(`widget:${key}`);
    return ids;
  },

  // The layout to render at this column count, always repaired against what
  // actually exists. Resolution order:
  //   1. this width's stored arrangement (the viewer dragged here);
  //   2. the OTHER width's, reflowed (they dragged on their other device);
  //   3. flow order from favorite_order — i.e. exactly today's home screen.
  // Only (1) is authoritative; (2) and (3) are derivations and are NOT
  // persisted until the viewer actually drags at this width. That is what
  // makes this feature need no backfill and what keeps a phone visit from
  // silently rewriting a desktop arrangement.
  currentLayout(cols) {
    const present = Home.presentIds();
    const stored = Home._layouts && Home._layouts[String(cols)];
    let base;
    if (Array.isArray(stored) && stored.length) {
      base = stored;
    } else {
      const other = cols === 4 ? 5 : 4;
      const otherStored = Home._layouts && Home._layouts[String(other)];
      if (Array.isArray(otherStored) && otherStored.length) {
        base = HomeLayout.reflow(otherStored, other, cols);
      } else {
        const { yours } = Home.partitionApps(Home._apps || []);
        base = HomeLayout.deriveDefault({
          apps: yours.map((a) => a.slug),
          widgets: window.HomePanels?.gridSlotKeys?.() || [],
          cols,
        });
      }
    }
    const { layout, changed } = HomeLayout.repair(base, cols, present);
    // ALWAYS cache what we are about to render. The drag handlers resolve a
    // dragged element to its layout item through this (Home._itemFor), so a
    // path that left it stale made every drop a no-op — canPlace could not
    // find the item and vetoed the whole gesture.
    Home._layoutCache = layout;
    // A repair of a STORED layout is a real correction (an app was added or
    // deleted, a widget was hidden, a size changed) and is worth persisting
    // so the next load is clean. A repair of a derivation is not — writing it
    // would turn a passive visit into a claim on this width.
    if (changed && Array.isArray(stored) && stored.length) {
      Home._layouts[String(cols)] = layout;
      Home._persistLayout(cols, layout);
    }
    return layout;
  },

  // One fetch per TTL, shared by concurrent callers — Home.load() runs from
  // a dozen WS/event paths and must not turn into a dozen requests.
  _ensureLayoutLoaded(opts) {
    const force = !!(opts && opts.force);
    if (!window.App || !App.user) return Promise.resolve();
    if (Home._layoutInflight) return Home._layoutInflight;
    if (!force && Home._layouts
        && Date.now() - Home._layoutFetchedAt < Home.LAYOUT_TTL_MS) {
      return Promise.resolve();
    }
    let qs = '';
    try {
      if (new URLSearchParams(location.search).get('demo') === '1') qs = '?demo=1';
    } catch (err) { /* ignore */ }
    Home._layoutInflight = fetch(`/api/home-layout${qs}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!json || !json.layouts) return;
        // The server's widget registry is the authority on footprints —
        // adopt it before anything lays out against it.
        HomeLayout.setRegistry(json.widgets);
        Home._layouts = json.layouts;
        Home._layoutIsDemo = !!json.demo;
        Home._layoutFetchedAt = Date.now();
      })
      // Silent on failure: a home screen must never break (or shout in the
      // console) because the layout read hiccuped — it falls back to the
      // derived default, which is exactly today's arrangement.
      .catch(() => {})
      .then(() => { Home._layoutInflight = null; });
    return Home._layoutInflight;
  },

  // Write one width's whole arrangement. Fire-and-forget with a revert:
  // the grid has already repainted optimistically, so this only records
  // where things landed. Same optimistic-then-revert shape the favourite
  // toggle uses.
  async _persistLayout(cols, layout) {
    // The staging demo payload is read-only by contract — it is a fixture,
    // not the viewer's arrangement, and writing it back would overwrite
    // their real cells with it. The grid still repaints optimistically, so
    // a reviewer can drag things around; nothing survives the reload.
    if (Home._layoutIsDemo) return true;
    try {
      const res = await fetch('/api/home-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ cols, items: HomeLayout.toWire(layout) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.layouts) {
        Home._layouts = json.layouts;
        Home._layoutFetchedAt = Date.now();
      }
      return true;
    } catch (err) {
      PlatformUI.toast('Couldn’t save your home screen layout.');
      await Home._ensureLayoutLoaded({ force: true });
      Home.render();
      return false;
    }
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
        html = `<div class="col-span-full py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No apps match &ldquo;${escapeHtml(query)}&rdquo; — clear the search and try the <span class="text-violet-500">Discover</span> widget.</div>`;
      } else {
        html = `<div class="home-section-header col-span-full">${matches.length} result${matches.length === 1 ? '' : 's'}</div>`;
        html += matches.map((a) => Home.renderAppCard(a)).join('');
      }
    } else {
      yoursCount = yours.length;
      canDragYours = true;
      // FREE-FORM PLACEMENT. Every app tile and every visible widget is a
      // grid item at an explicit (column, row) cell the viewer chose —
      // holes and all. There is no flow: an item's position comes from the
      // layout model, never from its order in this array.
      const cols = Home.currentCols();
      const layout = Home.currentLayout(cols);
      const canvas = HomeLayout.canvasItems(layout);
      const overflow = HomeLayout.overflowItems(layout);
      const parts = canvas.map((it) => Home.renderGridItem(it, cols));
      // Items past the 8-row canvas render after it in plain flow, packed
      // densely. The row cap bounds free PLACEMENT, never how many apps a
      // viewer may have — stranding a tile would be far worse than an
      // extra row.
      parts.push(...overflow.map((it) => Home.renderGridItem(it, cols, true)));
      html += parts.join('');
    }

    // The search view is a flat, transient list — it must not inherit the
    // canvas's fixed row height (its "N results" header and empty-state
    // line would each claim a whole 100px tile row). app.css keys the
    // auto-rows off this attribute.
    listEl.dataset.view = query ? 'search' : 'grid';
    listEl.innerHTML = html;
    Home._wireCards(listEl, canDragYours, yoursCount);
    // The iOS widget-editing strip renders ABOVE the grid, in its own
    // section: a full-width flow item cannot coexist with explicit cell
    // placement inside #app-list, which is where it used to live.
    const stripSection = document.getElementById('home-widget-strip-section');
    if (stripSection) {
      const stripHtml = Home.renderWidgetSection();
      stripSection.innerHTML = stripHtml;
      stripSection.classList.toggle('hidden', !stripHtml);
      if (stripHtml) Home._wireWidgetStrip(stripSection);
    }
    // Pure paint from the widgets cache (#911) — no network. Keeps each
    // block present through the grid's wholesale innerHTML re-renders.
    window.HomePanels?.render();
    Home._maybeOpenShotMenu(listEl);
    Home._searchReveal.sync();
    // Screenshot-state deep link: paint the drag overlay in its resting
    // visible state so the gesture-only surface is capturable and testable.
    Home._maybeShowShotGrid(listEl);
  },

  // One placed item → its grid markup, carrying its cell as an INLINE
  // style. Inline and not Tailwind classes: Tailwind here is the CDN JIT
  // (see index.html), so per-cell arbitrary classes would be generated at
  // runtime — and a cell that paints a frame late is a tile visibly jumping
  // into place. `overflow` items get no placement at all so they flow.
  renderGridItem(item, cols, overflow) {
    const [w, h] = HomeLayout.sizeOf(item, cols);
    const style = overflow
      ? ''
      : ` style="grid-column:${item.col + 1}/span ${w};grid-row:${item.row + 1}/span ${h}"`;
    if (item.type === 'widget') {
      return `<div class="home-panel-slot app-card-draggable touch-pan-y" data-panel-slot="${escapeHtml(item.key)}"${style}></div>`;
    }
    const app = (Home._apps || []).find((a) => a.slug === item.slug);
    if (!app) return '';
    let card = Home.renderAppCard(app);
    // ONE splice for both attributes, onto the card's root element. Two
    // sequential replaces looked equivalent and was not: inserting
    // `data-yours` ahead of `class=` moved the anchor the placement replace
    // was matching on, so every app tile silently lost its cell and fell
    // back to flowing — the grid looked plausible and was not placed at all.
    card = card.replace('class="app-card ',
      `data-yours="true"${style} class="app-card `);
    card = card.replace('cursor-pointer', 'cursor-grab');
    return card;
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
  //
  // Called by BOTH launcher grids that carry the menu: home's #app-list
  // and the #apps browse screen's #browse-list. Whichever one is actually
  // on screen wins — a hidden grid has no offsetParent, so it neither
  // opens a menu the user can't see nor burns the once-only flag. That is
  // what makes `/?shot=card-menu#apps` land on the browse grid even
  // though home rendered first during boot.
  _shotMenuDone: false,

  _maybeOpenShotMenu(listEl) {
    if (Home._shotMenuDone) return;
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'card-menu') return;
    if (!listEl || listEl.offsetParent === null) return; // not the visible grid
    Home._shotMenuDone = true;
    // Deferred a frame: the grid was written synchronously just above,
    // and the kit's flip/clamp placement needs the button's settled rect.
    requestAnimationFrame(() => {
      // Prefer the grid's own "…" trigger: a real anchor element is what
      // lets the desktop popover toggle closed on a re-click.
      const btn = listEl.querySelector('.card-menu-btn');
      let slug = btn && btn.dataset.slug;
      let anchor = btn;
      // #929: a fresh checks database has an EMPTY "Your apps" grid, so
      // that selector finds nothing and the link used to open no menu at
      // all — which is how the touch idiom (a kit action sheet, the thing
      // that actually broke) went two releases without a check. Fall back
      // to the featured row's first tile, anchored to the card itself:
      // the same call a long-press makes.
      if (!slug) {
        const featured = document.getElementById('home-featured-list');
        const card = featured && featured.offsetParent !== null
          ? featured.querySelector('.app-card[data-slug]')
          : null;
        if (card) {
          slug = card.dataset.slug;
          anchor = card.getBoundingClientRect();
        }
      }
      if (!slug) return;
      Home.openCardMenu(slug, anchor);
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
  // the app on a body tap, toggle "Your apps" membership from the add
  // badge, and — where the grid rendered one — open the SAME "…" actions
  // menu the home cards use (Home.openCardMenu, which resolves the app
  // from Home._apps and adapts to an action sheet on touch / an anchored
  // popover on desktop via PlatformUI.menu). No drag: these grids are not
  // the user's own ordering.
  //
  // `onChange` (optional) is called after a successful toggle so the
  // host can re-render its own grid; home just reloads.
  _wireDiscoveryCards(listEl, onChange) {
    if (!listEl) return;
    listEl.querySelectorAll('.app-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-add-btn') || e.target.closest('.card-menu-btn')) return;
        if (card.dataset.demo === 'true') return;
        if (card.dataset.status !== 'running' && card.dataset.status !== 'awaiting_secrets') return;
        App.navigateToApp(card.dataset.slug);
      });
      Home._wirePrewarm(card);
    });
    listEl.querySelectorAll('.card-add-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Home.toggleAdded(btn.dataset.slug, btn.dataset.added !== 'true', onChange);
      });
    });
    listEl.querySelectorAll('.card-menu-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Pass the element so the kit popover can toggle closed on a
        // re-click and manage aria-expanded — same call as the home grid.
        Home.openCardMenu(btn.dataset.slug, btn);
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

  // #931: start warming the app the finger is already on — the token mint
  // and the TCP/TLS handshake to its origin — so the tap that follows can
  // point the iframe at the app in its own tick. `pointerdown` is the real
  // lever on touch (it fires ~100ms before click, and long-press-to-drag
  // still ends up here harmlessly); `mouseenter` buys much more on desktop.
  // Passive: this never calls preventDefault and must not delay scrolling.
  _wirePrewarm(card) {
    const slug = card.dataset.slug;
    if (!slug || card.dataset.demo === 'true') return;
    if (card.dataset.status !== 'running') return;
    const warm = () => { try { App.prewarmApp(slug); } catch (err) { /* ignore */ } };
    card.addEventListener('pointerdown', warm, { passive: true });
    card.addEventListener('mouseenter', warm);
  },

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
      Home._wirePrewarm(card);
      // The placement recognizer (below) owns long-press-lift-drag on every
      // card it matches. The long-press actions menu survives only where it
      // does NOT: the search view (a transient view with no layout to write)
      // and inert staging demo tiles. All other cards reach the menu through
      // their "…" button.
      if (yoursCount == null || card.dataset.demo === 'true') {
        Home._wireCardLongPressMenu(card);
      }
    });

    // FREE-FORM PLACEMENT on the whole grid: long-press (or a desktop drag
    // past the slop) lifts a floating ghost that tracks the finger on both
    // axes, the real item holds its cell as a dashed slot, the grid draws
    // itself underneath, and the drop lands in whatever cell the pointer is
    // over — including an empty one with nothing around it. Nothing
    // re-packs; the holes the viewer leaves are the point.
    //
    // The kit owns the gesture, this owns the geometry: cellFromPoint hits
    // the overlay's own cell elements, so the highlight the user sees and
    // the cell the drop commits to come from one code path with no
    // arithmetic over grid-template-columns.
    //
    // The item selector deliberately matches EVERY widget host, including a
    // create widget rendered in its disabled state — being unable to create
    // apps must not make the widget unmovable.
    if (yoursCount != null && window.unNative?.attachGridPlacement) {
      if (Home._placementHandle) { try { Home._placementHandle.detach(); } catch {} }
      const cols = Home.currentCols();
      Home._placementHandle = window.unNative.attachGridPlacement(listEl, {
        itemSelector: '.app-card[data-yours]:not([data-demo]), .home-panel-slot',
        cellFromPoint: (x, y) => Home._cellFromPoint(x, y),
        // canPlace runs first on every cell change and onHover right after,
        // and both need the SAME displacement plan — so compute it once here
        // and memo it for the paint. Recomputing would risk the highlight
        // describing a different outcome than the one that commits.
        canPlace: (item, cell) => !!Home._planFor(item, cell, cols),
        onLift: (item) => {
          Home._dragActive = true;
          Home._showGridOverlay(listEl, cols, item);
        },
        onHover: (item, cell, ok) => { Home._previewDrop(item, cell, ok, cols); },
        onPlace: (item, cell) => { Home._onGridPlace(item, cell, cols); },
        onSettle: () => {
          Home._dragActive = false;
          Home._hideGridOverlay();
          if (Home._reloadPending) {
            Home._reloadPending = false;
            Home._rerenderPending = false;
            Home.load();
          } else if (Home._rerenderPending) {
            Home._rerenderPending = false;
            Home.render();
          }
        },
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

  // `opts.mode` picks the corner controls:
  //   'home' (default) — the "…" actions menu alone, top-right.
  //   'featured' / 'browse' — an add/remove badge (`.card-add-btn`,
  //     ✓ when the app is already in "Your apps") top-right, because a
  //     discovery grid's primary per-tile action is "keep this", PLUS the
  //     same "…" menu top-left when `opts.menu` is set.
  // Everything else — icon tile, status dot, users badge, fork tag,
  // click-to-open rule — is shared, so the launcher grids can't drift.
  renderAppCard(app, opts) {
    const mode = (opts && opts.mode) || 'home';
    const discovery = mode === 'featured' || mode === 'browse';
    const isAwaiting = app.status === 'awaiting_secrets';
    // The status DOT is gone from the tile face — a launcher icon should
    // read as an app, not as a dashboard row. What it signalled that no
    // other tile element does is an in-flight redeploy of an
    // ALREADY-RUNNING app; that state now lives only in the "…" menu's
    // version pill (renderMenuHeaderHtml), which renders it explicitly.
    // Every non-running status still says so in words on the tile — see
    // statusLabel / warningHtml below — so "Spinning up…", "Awaiting
    // secrets" and "Error" are unaffected.
    const statusLabel = app.status === 'running' ? ''
      : app.status === 'creating' ? 'Spinning up...'
      : isAwaiting ? 'Awaiting secrets'
      : 'Error';
    const isError = app.status === 'error';
    const isRunning = app.status === 'running';
    // The active-users badge is gone from the tile face too. The count is
    // still served (and still shown where it is actually information: the
    // Browse-all directory, which is a ranked list — see browse.js).
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
    // The "…" actions menu trigger. One markup, two corners: it owns the
    // icon's top-RIGHT corner on the home grid (where it is the card's only
    // badge), and moves to the top-LEFT on a discovery grid so the add
    // badge keeps the primary right-hand spot and the two never overlap.
    // (The fork tag sits bottom-left, so top-left is free.)
    const hamburgerHtml = (corner) => `
      <button class="card-menu-btn absolute -top-1.5 ${corner} w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors" data-slug="${app.slug}" title="App actions" aria-label="App actions" aria-haspopup="menu"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg></button>`;
    // Discovery grids show BOTH: the add/remove badge as the primary
    // affordance, plus the same "…" menu the home cards have, so an app
    // you haven't added still offers Fork / build log / admin actions
    // without a detour through home. `opts.menu` opts a grid in — the
    // browse screen passes it; the home featured row doesn't (yet).
    // Staging ?demo=1 tiles never get it: their slugs have no DB row, so
    // every action in the menu would 404.
    const wantsMenu = !!(opts && opts.menu) && !app.demo;
    const menuBadgeHtml = discovery
      ? `${addBadgeHtml}${wantsMenu ? hamburgerHtml('-left-1.5') : ''}`
      : hamburgerHtml('-right-1.5');
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
    // the name centered below it, then the status warning when present
    // (the status dot and the active-users badge that used to flank the
    // name are both gone — a launcher tile is an icon and a label).
    // Everything is
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
          <div class="flex items-center justify-center min-w-0 max-w-full">
            <span class="font-medium text-sm truncate min-w-0">${escapeHtml(app.name)}</span>
          </div>
          ${warningHtml}
        </div>
      </div>
    `;
  },

  // NOTE: renderCreateTile() is gone. "Create an app" is a WIDGET in the
  // grid now (HomePanels.renderCreatePanel), present on every home screen
  // for every account — dimmed and self-explaining where the viewer has no
  // app quota, rather than swapped for a hint paragraph in a trailing
  // section. Home.wireCreateButtons() below still binds its button, and
  // CREATE_DISABLED_HINT is still the one wording of the locked case.

  // ── Usernode widget section (iOS in-app only) ──────────────────────
  //
  // A strip above the launcher grid mirroring the pinned grid the iOS
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
      <div class="home-section-header flex items-center justify-between">
        <span class="flex items-center gap-1.5">Usernode widget
          <button id="widget-section-help" class="w-4 h-4 flex items-center justify-center rounded-full text-zinc-400 dark:text-zinc-500 hover:text-violet-500 dark:hover:text-violet-400 transition-colors" title="How to add the widget to your home screen" aria-label="How to add the widget to your home screen" aria-expanded="${Home._widgetHelpVisible}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </button>
        </span>
        <button id="widget-section-close" class="flex items-center gap-1 text-xs font-normal normal-case tracking-normal text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors" title="Close the widget section" aria-label="Close the widget section">Done
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        </button>
      </div>
      <div id="widget-strip" class="flex flex-wrap items-start gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 p-3 transition-colors">
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
    if (window.unNative && typeof window.unNative.attachReorder === 'function') {
      // The strip keeps attachREORDER, not the grid's attachGridPlacement,
      // and that is the right call: the iOS widget's pinned shortcuts are a
      // genuine ORDERED LIST on the device (the bridge's
      // reorderHomeScreenShortcuts takes a sequence), not a canvas with
      // holes. Displacement mode is used because the list model's Y-only
      // ghost and drop line are degenerate for a one-row tile strip
      // (issue #770). onLift/onSettle hold _dragActive so a WS-driven
      // Home.load() can't replace the strip mid-gesture (same guard as
      // the card grid).
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
    // The way to the app's own page (#apps/<slug>) — the same destination a
    // row in the browse-all-apps list opens, so both entry points land on
    // one screen rather than the page duplicating the menu. First in the
    // list because it's navigation, not an action.
    //
    // Routed by assigning location.hash so the browser/OS back gesture
    // works, exactly as Browse._wireRows does. Skipped for the inert
    // ?demo=1 tiles, whose slugs 404 on GET /api/apps/:slug — and filtered
    // out of the detail page's own action rows by
    // Browse.DETAIL_EXCLUDED_KEYS, so the page can never link to itself.
    //
    // noteDetailOrigin('home') first: the browse list is never shown on
    // this path, so the detail page's back button has to return HERE
    // rather than to a list the user never saw.
    if (!app.demo && app.slug) {
      items.push({
        key: 'app-details',
        label: 'App details',
        title: 'Version, status and everything you can do with this app',
        run: () => {
          window.Browse?.noteDetailOrigin?.('home');
          location.hash = `#apps/${encodeURIComponent(app.slug)}`;
        },
      });
    }
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
  _placementHandle: null,
  _widgetReorderHandle: null,
  // The layout the CURRENT drag is resolving against. Snapshotted at lift so
  // canPlace/onPlace can't disagree with each other, and so a mid-gesture
  // fetch landing can't move the target cells under the finger.
  _layoutCache: null,

  // ===== Free-form placement =====

  // The layout the drag is working against — the same array render() painted
  // from. Falls back to computing one if a drag somehow starts before a
  // render (it can't, but a null here would be a silent no-op drop).
  currentLayoutCached(cols) {
    return Home._layoutCache || Home.currentLayout(cols);
  },

  // A dragged DOM element → its layout item. The element carries only its
  // identity (data-slug / data-panel-slot); the cell comes from the model,
  // so the DOM never becomes a second source of truth about position.
  _itemFor(el) {
    if (!el) return null;
    const layout = Home._layoutCache || [];
    if (el.classList?.contains('home-panel-slot')) {
      const key = el.dataset.panelSlot;
      return layout.find((it) => it.type === 'widget' && it.key === key) || null;
    }
    const slug = el.dataset?.slug;
    return layout.find((it) => it.type === 'app' && it.slug === slug) || null;
  },

  // Which cell is the pointer over? Answered by hit-testing the OVERLAY's
  // own cell elements rather than by arithmetic over the grid's computed
  // template — that is the whole reason the overlay is real DOM. The kit's
  // ghost is pointer-events:none, so it never occludes them.
  _cellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const cell = el && el.closest ? el.closest('[data-cell]') : null;
    if (!cell) return null;
    const [col, row] = String(cell.dataset.cell).split(',').map(Number);
    if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
    return { col, row };
  },

  // A committed drop. Mutate the model, keep the write to the width that is
  // actually on screen, and defer the repaint to onSettle (this fires while
  // _dragActive still holds, so an immediate render() would be swallowed).
  _onGridPlace(el, cell, cols) {
    const item = Home._itemFor(el);
    if (!item) return;
    const next = HomeLayout.place(Home.currentLayoutCached(cols), item, cell.col, cell.row, cols);
    if (!next) return;
    Home._layoutCache = next;
    if (!Home._layouts) Home._layouts = {};
    Home._layouts[String(cols)] = next;
    Home._rerenderPending = true;
    Home._persistLayout(cols, next);
  },

  // ===== The drag-time grid overlay =====
  //
  // While something is lifted, the grid it snaps to is drawn underneath it:
  // every cell of the canvas outlined, including the empty ones, so "you can
  // drop this anywhere" is visible rather than something to discover.
  //
  // The overlay is a real GRID sharing #app-list's own template, gap and row
  // height — that is what guarantees pixel alignment with zero arithmetic,
  // and it doubles as the hit-test surface (_cellFromPoint). The layer is
  // pointer-events:none; the individual cells re-enable them so
  // elementFromPoint lands on a cell rather than on a tile behind it.
  _overlayEl: null,

  _showGridOverlay(listEl, cols, liftedEl) {
    Home._hideGridOverlay();
    if (!listEl) return;
    const overlay = document.createElement('div');
    overlay.id = 'home-grid-overlay';
    overlay.className = 'home-grid-overlay';
    overlay.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    let cells = '';
    for (let row = 0; row < HomeLayout.MAX_ROWS; row++) {
      for (let col = 0; col < cols; col++) {
        cells += `<div class="home-grid-cell" data-cell="${col},${row}"></div>`;
      }
    }
    overlay.innerHTML = cells;
    listEl.appendChild(overlay);
    Home._overlayEl = overlay;
  },

  _hideGridOverlay() {
    Home._clearPreview();
    Home._planMemo = null;
    if (Home._overlayEl && Home._overlayEl.parentNode) {
      Home._overlayEl.parentNode.removeChild(Home._overlayEl);
    }
    Home._overlayEl = null;
  },

  // ===== The live displacement preview =====
  //
  // While an item hovers a target, the occupants that WOULD be pushed move to
  // the cells they'd land in, right now — so the drop is never a surprise.
  // This is the same information the flow reorder gave for free (everything
  // shuffled as you dragged); free placement has to show it deliberately,
  // because only the items that actually collide move.
  //
  // The plan is HomeLayout.place's own output, so what is previewed and what
  // commits are one computation, not two that can disagree.

  // Memo of the last plan, keyed by (item, cell). canPlace runs immediately
  // before onHover on every cell change; sharing the result means the
  // highlight can never describe a different outcome than the drop.
  _planMemo: null,

  _planFor(el, cell, cols) {
    const item = Home._itemFor(el);
    if (!item || !cell) return null;
    const key = `${HomeLayout.idOf(item)}@${cell.col},${cell.row},${cols}`;
    if (Home._planMemo && Home._planMemo.key === key) return Home._planMemo.plan;
    const layout = Home.currentLayoutCached(cols);
    const next = HomeLayout.place(layout, item, cell.col, cell.row, cols);
    const plan = next ? { item, layout, next } : null;
    Home._planMemo = { key, plan };
    return plan;
  },

  // Elements currently wearing a preview transform, so the next hover can put
  // them back without re-deriving which ones moved.
  _previewEls: null,

  // Restores the transforms only. It must NOT drop _planMemo: _previewDrop
  // calls this first, and the memo it needs is the one canPlace computed a
  // moment earlier — clearing it here made every hover recompute the plan,
  // which is exactly the two-computations-that-can-disagree this memo exists
  // to prevent. The memo is keyed by (item, cell, cols), so a stale entry can
  // never be read; _hideGridOverlay drops it when the gesture ends.
  _clearPreview() {
    if (!Home._previewEls) return;
    for (const el of Home._previewEls) {
      el.style.transform = '';
      el.classList.remove('home-item-displaced', 'home-item-to-overflow');
    }
    Home._previewEls = null;
  },

  // The DOM element for a layout item, or null. Identity only — an item's
  // cell lives in the model, never in the DOM.
  _elFor(item, listEl) {
    const root = listEl || document.getElementById('app-list');
    if (!root || !item) return null;
    return item.type === 'widget'
      ? root.querySelector(`[data-panel-slot="${item.key}"]`)
      : root.querySelector(`.app-card[data-slug="${item.slug}"]`);
  },

  // Tint the cells the drop would land in — the whole footprint for a widget,
  // so the user sees the block they are about to occupy rather than just the
  // cell under the finger — and move the items it would displace.
  //
  // Occupied targets tint too: a drop there DISPLACES the occupant rather
  // than being refused (HomeLayout.place), so refusing to highlight it would
  // be the grid lying about where a release lands. The only untinted state is
  // the pointer genuinely leaving the canvas.
  _previewDrop(el, cell, ok, cols) {
    const overlay = Home._overlayEl;
    if (!overlay) return;
    Home._clearPreview();
    overlay.querySelectorAll('.home-grid-cell--on').forEach((c) => {
      c.classList.remove('home-grid-cell--on');
    });
    if (!cell || !ok) return;

    const plan = Home._planFor(el, cell, cols);
    if (!plan) return;
    const { item, layout, next } = plan;
    const draggedId = HomeLayout.idOf(item);

    // The target footprint, read off the PLAN rather than re-clamped here, so
    // the tint sits exactly where the item lands after an edge nudge.
    const placed = next.find((it) => HomeLayout.idOf(it) === draggedId);
    const [w, h] = HomeLayout.sizeOf(item, cols);
    if (placed) {
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          const t = overlay.querySelector(`[data-cell="${placed.col + dx},${placed.row + dy}"]`);
          if (t) t.classList.add('home-grid-cell--on');
        }
      }
    }

    // Everything the plan moves EXCEPT the dragged item — that one is
    // represented by the ghost under the finger and its dashed origin slot.
    const before = new Map(layout.map((it) => [HomeLayout.idOf(it), it]));
    const moved = new Set();
    const listEl = overlay.parentNode;
    for (const to of next) {
      const id = HomeLayout.idOf(to);
      if (id === draggedId) continue;
      const from = before.get(id);
      if (!from || (from.col === to.col && from.row === to.row)) continue;
      const node = Home._elFor(to, listEl);
      if (!node) continue;

      if (to.row >= HomeLayout.MAX_ROWS) {
        // Pushed off the canvas into the dense overflow rows. There is no
        // overlay cell to translate to, so say it in place instead of
        // sliding the tile to a position that doesn't exist yet.
        node.classList.add('home-item-to-overflow');
        moved.add(node);
        continue;
      }
      // The delta comes from the overlay's OWN cell rects — the same grid the
      // tiles are laid out in — so the preview lands pixel-exact with no
      // arithmetic over column widths or row heights.
      const fromCell = overlay.querySelector(`[data-cell="${from.col},${from.row}"]`);
      const toCell = overlay.querySelector(`[data-cell="${to.col},${to.row}"]`);
      if (!fromCell || !toCell) continue;
      const a = fromCell.getBoundingClientRect();
      const b = toCell.getBoundingClientRect();
      node.classList.add('home-item-displaced');
      node.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
      moved.add(node);
    }
    Home._previewEls = moved.size ? moved : null;
  },

  // Screenshot-state deep link (?shot=home-grid): the drag overlay only
  // exists mid-gesture, so neither the before/after captures nor a dapp.json
  // test could ever see it. Paint it in its resting visible state with the
  // first cell tinted. Pure UI state — no writes, no env gate — so the
  // production "before" side works too once shipped.
  //
  // Deliberately NOT once-per-page-load, unlike ?shot=card-menu: the grid's
  // innerHTML is replaced on every WS app event and every payload that lands
  // after the first paint, which wipes the overlay with it. A menu must not
  // pop back open under the user; an overlay is idempotent decoration, so
  // re-painting it is exactly right — a once-only guard here just meant the
  // capture raced the second render and shot a bare grid.
  _maybeShowShotGrid(listEl) {
    let shot = null;
    try { shot = new URLSearchParams(location.search).get('shot'); } catch (err) { /* ignore */ }
    if (shot !== 'home-grid') return;
    if (!listEl || listEl.offsetParent === null) return; // not the visible grid
    if (Home._dragActive) return; // a real gesture owns the overlay
    const cols = Home.currentCols();
    Home._showGridOverlay(listEl, cols, null);
    // The kit sets .un-reordering for the span of a real lift, and the CSS
    // hangs the tiles' pointer-events:none off it — the thing that makes an
    // occupied cell resolvable as a drop target at all. Setting it here makes
    // this link a TRUE rendering of the mid-drag state rather than just the
    // outlines, so a check at this URL can catch that regression instead of
    // only noticing the overlay went missing.
    listEl.classList.add('un-reordering');

    // Render a REAL displacement preview, not just the outlines: pick the
    // last canvas item as the notional dragged one and hover it over (0,0).
    // Whatever sits there gets pushed and shows it. That is the whole point
    // of the link — the preview is the part a reviewer needs to see and the
    // part nothing can navigate to, and it makes the state assertable by a
    // declared check instead of only by a live gesture.
    const layout = Home.currentLayoutCached(cols);
    const canvas = HomeLayout.canvasItems(layout);
    const dragged = canvas.length > 1 ? canvas[canvas.length - 1] : null;
    const el = dragged ? Home._elFor(dragged, listEl) : null;
    if (el) {
      // The same dashed, contents-hidden drop slot a real lift gives the
      // dragged item (native.css .un-reorder-slot). Without it the tile stays
      // fully painted in its origin cell while the item it displaced slides
      // over that spot, and the shot reads as two things overlapping rather
      // than one thing making way for another.
      el.classList.add('un-reorder-slot');
      Home._previewDrop(el, { col: 0, row: 0 }, true, cols);
    } else {
      // Nothing to displace (an empty or single-item grid) — still tint the
      // target so the outlines have a subject.
      const first = Home._overlayEl && Home._overlayEl.querySelector('[data-cell="0,0"]');
      if (first) first.classList.add('home-grid-cell--on');
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

  // NOTE: the legacy hand-rolled pointer drag (_onCardPointerDown, ~500
  // lines of ghost / hit-test / auto-scroll machinery behind the
  // `platform-legacy-reorder` localStorage flag) is GONE. It only ever
  // implemented FLOW reordering — pick a card up, everything re-packs — and
  // that model cannot express a layout with holes. Keeping it as a fallback
  // would have meant two incompatible ideas of what the home screen is,
  // with the fallback silently destroying the arrangement the primary path
  // exists to preserve. The kit's attachGridPlacement is now the only
  // recognizer, and it carries the same physics the flag was insurance for.


  // Empty-state ("No apps yet") has two variants — the existing
  // "Create your first app" CTA for users with permission, and a
  // muted "Ask an admin to enable app creation" hint for users
  // without. Toggle the CTA button on/off in place rather than
  // rebuilding the static DOM, so the surrounding "No apps yet"
  // copy stays put.
  // The one wording of "you can't create apps right now". The create WIDGET
  // is on every home screen regardless of quota, so this string is what the
  // disabled tile shows in three places at once: its tooltip, the toast a
  // tap produces, and the inert note in its ⋮ menu. One constant so those
  // three can never drift.
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
  // Home._apps cache at open time. So this refreshes the cached app's
  // version/deployProgress, so a menu opened next shows fresh info.
  //
  // It used to ALSO re-class the tile's status dot, which was the only
  // visible "this app is redeploying" signal on an already-running card.
  // That dot is gone from the tile face on purpose (see renderAppCard), so
  // an in-flight redeploy of a running app now changes nothing visible on
  // the tile — it shows in the "…" menu's version pill instead. Nothing
  // else regressed: every non-running status still says so in words, and
  // those come from a full Home.load() as before.
  updateAppCardPill(slug, opts) {
    if (!slug) return;
    const app = (Home._apps || []).find((a) => a.slug === slug);
    if (!app) return;
    app.deployProgress = opts && opts.deployProgress ? opts.deployProgress : null;
    // The deploy-start event carries version: null (the old SHA is
    // hidden while deploying anyway); keep the cached SHA so the
    // menu's fallback text stays meaningful, and only overwrite when
    // an event actually supplies one.
    if (opts && opts.version) app.version = opts.version;
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
