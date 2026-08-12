// Home-screen panels (issue #911) — the widget blocks that live IN the
// launcher grid alongside the app tiles. Three exist:
//
//   challenges — the season's open challenges with the viewer's progress.
//   discover   — the admin-curated featured tiles, with "Browse all apps"
//                as the block's footer. The shell's ONLY door to the app
//                directory, which is why it cannot be hidden.
//   create     — the create-an-app tile. On EVERY home screen, for every
//                account: an account with no app quota gets the same widget,
//                dimmed, explaining itself on tap (see renderCreatePanel for
//                why this is unconditional rather than conditionally placed).
//
// PLACEMENT is not this module's business any more. Each widget occupies a
// real (column, row) cell chosen by the viewer, stored per breakpoint and
// written for the whole grid at once — see frontend/src/features/home/home-layout.js and
// PUT /api/home-layout. This module owns the registry view (which widgets
// exist, which are hidden, which may be hidden) and the CONTENT of each
// block; home.js plants a slot per widget and this paints into it.
//
// NAMING — "panel", not "widget". home.js already owns a DIFFERENT
// concept called "widget" (Home.renderWidgetSection / #widget-strip /
// .widget-tile: the iOS home-screen widget's pinned app grid, whose UI
// says "Usernode widget"). Both render on this same screen, so everything
// here says `panel`. Nothing user-facing says it: the block is titled
// "Challenges" and the Settings row is "Home screen widgets".
//
// LAYOUT — each panel is its OWN bordered <article class="home-panel">,
// stacked with a gap, so a second widget lands as a distinct block rather
// than another row inside a shared card. The title (and the ⋮ menu) travel
// INSIDE each block: the panel area holds N widgets with N titles, so the
// shared heading-above-the-section shape that "Featured apps" uses cannot
// work here. Blocks are plain full-width children — .home-column bounds
// the feed (see app.css; #922 removed the per-box bound).
//
// DRAGGING — each block is an item of the app grid itself (home.js plants a
// `[data-panel-slot="<key>"]` host inside #app-list at the widget's stored
// cell), so ONE recognizer — the kit's attachGridPlacement the app tiles
// also use — carries them. The whole title bar is the handle; the ⋮ button
// and the widgets' own controls are excluded from it (_wire).
//
// DENSITY — the DESKTOP tile is capped at two app-grid rows
// (--home-panel-max-h, derived in app.css) and spends that budget on a
// ~26px title bar, FOUR 40px single-line rows and a ~27px footer. The PHONE
// block owns ONE cell (#968) and spends it on a ~27px title bar carrying its
// own leaderboard link plus TWO rows — no footer, which is what buys the
// second row. Overflow is handled by rendering fewer rows (and, on desktop,
// the footer's expand toggle) — never an inner scroller (a nested scroll
// region inside the page scroller is a touch trap) and never a horizontal
// pager (invisible to the screenshot capture and to dapp.json checks, which
// can only navigate). That mirrors the removed mobile Challenges tab, which
// paged by navigation: it was a plain vertical list of bordered cards on a
// screen of its own.
//
// UNDERFLOW is the other half, and it splits by breakpoint (#947, #968). On
// a PHONE the widget is full-width and ONE ROW TALL, so a short list ends
// sooner AND the page moves up with it: the block draws at its content
// height (the `home-panel--fit` rule inside app.css's phone media block) and
// its footprint is a single cell, so what it doesn't draw is a row of the
// grid nobody reserved. On DESKTOP it
// is a tile among app icons, where shrinking would leave a notch, so it
// keeps its exact two-row height and spends the leftover on a LEADERBOARD
// section: the top few rows of the same board the Leaderboard screen's
// primary tab shows — the Topochain standings — plus the viewer's own row
// when they have one. The server sends it as `panel.leaderboard`, already
// carrying its `kind` ('topochain', or 'kudos' for the fallback board a
// deployment with no public standings falls back to), its `label` and the
// `you` flags; src/services/topochain/event-standings.js and
// src/services/leaderboard-users.js are the one copy of each board's
// ordering. See fillSlots/currentCols below for the row budget.
//
// FETCH DISCIPLINE. Home.load() is called from a dozen WS/event paths, so
// this module must NOT fetch per Home.load(): ensureLoaded() is
// TTL-guarded and de-duped on an in-flight promise, while render() is
// pure paint from the cache. The #home-panels host is static markup the
// home island renders once (frontend/src/features/home/index.tsx) and lives
// OUTSIDE #app-list, so Home.render()'s wholesale innerHTML rewrite of the
// grid never destroys it — and React never reconciles over what this module
// paints into it, because the island renders that host empty and leaves it
// alone for good.
'use strict';

const HomePanels = {
  // Cache of GET /api/home-panels: { registry, hidden, positions, panels }.
  _data: null,
  _fetchedAt: 0,
  _inflight: null,
  TTL_MS: 60 * 1000,

  // Which panels the viewer has expanded in place, this visit only. The
  // expand toggle grows the block past its height cap and asks the server
  // for the full list (finished challenges included); nothing is
  // persisted, so a reload comes back collapsed. Deliberate: the cap is
  // the default contract, and an expansion the user forgot about would
  // quietly eat the fold forever.
  _expanded: Object.create(null),

  // How many row slots fit under the DESKTOP tile's height cap. The server
  // returns at most this many challenges (CHALLENGE_ROW_LIMIT, kept in step
  // with it); when more are open, the footer reads "See all N".
  ROW_SLOTS: 4,

  // …and how many fit the PHONE's single cell (#968). The server still sends
  // four — it has no idea what viewport is asking — so a window dragged
  // across 640px repaints the desktop shape from the same cache with no
  // refetch. This is a DRAW budget, not a fetch one.
  PHONE_ROW_SLOTS: 2,

  // ── The breakpoint split (#947, #968) ──────────────────────────────
  //
  // PHONE (4 columns): the widget spans the full grid width and is ONE cell
  // tall (registry `sizes` 4: [4, 1]), so a shorter block ends sooner and
  // nothing beneath it is left holding blank space. It draws at its CONTENT
  // height — that half is pure CSS: the article always carries
  // `home-panel--fit`, and the `align-self: flex-start` rule lives inside
  // app.css's `@media (max-width: 639.98px)` block, so a window dragged
  // across the breakpoint resizes instantly, before any re-render.
  //
  // The CONTENT has to fit that one cell, and that half is decided here (see
  // the compact branch of renderChallengesPanel). Budget, against
  // --home-cell-h 7.25rem (116px) on a phone:
  //   border 2 + title bar 27 + 2 rows x --home-panel-row-h (40) = 109px
  // ~7px of headroom. The 14px meter lane is padding INSIDE the 40px row
  // (border-box), so a metered list costs no extra height. There is no
  // footer: a .home-panel-footer is 27px more and that is the second row.
  // The way out lives in the title bar instead, exactly as Discover's browse
  // control does for the same reason (#949).
  //
  // DESKTOP (5 columns): the widget is a TILE in a grid of app icons —
  // shrinking it would leave a notch — so it keeps its exact two-row height
  // and spends whatever the challenge rows don't use on a LEADERBOARD
  // section (top builders + the viewer's own rank).
  //
  // The row budget, from app.css's own tokens:
  //   tile 256 - border 2 - title bar 25.5 - footer 27  = 201.5px
  //   a row is 40px (--home-panel-row-h); the label costs 16px
  // so `fillRows = 4 - max(challengeRows, 1)` — 3 at zero or one challenge,
  // 2 at two, 1 at three, 0 at four (a 40px row plus its 16px label does not
  // fit in the ~41px the four-row state leaves).
  DESKTOP_COLS: 5,

  fillSlots(challengeRows) {
    return Math.max(0, HomePanels.ROW_SLOTS - Math.max(Number(challengeRows) || 0, 1));
  },

  // The column count the grid is rendering at. Home owns this (it reads the
  // viewport against HomeLayout.BREAKPOINT_PX, the same 640px as the CSS);
  // the fallbacks keep this module usable — and testable — with neither on
  // the window. Unknown width defaults to the COMPACT rendering: it claims
  // no space it can't fill and needs no fill data, so it is always safe.
  currentCols() {
    const w = window.Home;
    if (w && typeof w.currentCols === 'function') {
      const cols = Number(w.currentCols());
      if (Number.isFinite(cols) && cols > 0) return cols;
    }
    const layout = window.HomeLayout;
    const width = Number(window.innerWidth);
    if (layout && typeof layout.columnsForWidth === 'function' && Number.isFinite(width)) {
      return layout.columnsForWidth(width);
    }
    if (Number.isFinite(width)) return width >= 640 ? 5 : 4;
    return 4;
  },

  // Escapes every character that is dangerous in EITHER a text node OR a
  // double-quoted attribute value. Organiser-authored strings (challenge
  // goals, metric labels) land in both here, and home.js's escapeHtml()
  // only covers & < > — an unescaped `"` would let a goal break out of
  // title="…" and inject attributes. (That one used to be a global this
  // module could have called; since #1083 chunk F step 4 both files are
  // bundle modules and it is module-local to home.js. This one was always
  // separate, and still is.)
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // Only http(s) links ever become a real anchor. esc() stops attribute
  // breakout but does nothing about a `javascript:` href, which executes
  // on click with no markup injection at all.
  safeHref(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  },

  // Rewards are organiser prose — rendered verbatim ("Up to 6,500 pts",
  // "½ of your final credits"). The single exception: a bare number gets
  // " pts" appended, because organisers do type just "1500".
  formatReward(reward) {
    const s = String(reward == null ? '' : reward).trim();
    if (!s) return '';
    return /^[\d][\d.,]*$/.test(s) ? `${s} pts` : s;
  },

  // Bar fill, 0-100. A missing/zero/NaN target is 0 (the caller renders no
  // bar in that case anyway); over-target is clamped so a viewer who blew
  // past the goal doesn't get a bar wider than its track.
  progressPercent(current, target) {
    const t = Number(target);
    const c = Number(current);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
  },

  // Client mirror of the server's ORDER BY, so a cached or demo payload
  // renders in exactly the order a fresh query would produce: not-done
  // first (lead with something actionable), then the server's own order.
  // Stable — Array#sort is stable, so equal rows keep the server sequence.
  orderRows(rows) {
    return (rows || []).slice().sort((a, b) => {
      const ad = a?.progress?.done ? 1 : 0;
      const bd = b?.progress?.done ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return 0;
    });
  },

  // How many rows to draw. Collapsed spends the height cap on at most
  // `slots` rows (ROW_SLOTS on the desktop tile, PHONE_ROW_SLOTS in the
  // phone's single cell); the overflow affordance is the footer's expand
  // toggle on desktop and, on a phone, tapping any row (every one of them
  // opens the Challenges tab), so it no longer costs a row slot (it used to
  // take the fourth).
  // Expanded draws everything the server sent and the CSS cap lifts.
  //
  // `expanded` is only ever honoured for the caller that HAS an expanded
  // state — the phone branch passes `collapsed: true`, because growing past
  // the cell is exactly what its footprint no longer allows (#968).
  //
  // `link` stays in the return shape as a compatibility flag for anything
  // still reading it, but it is always false: the footer owns overflow.
  visibleSlots(panel, opts) {
    const rows = HomePanels.orderRows(panel && panel.challenges);
    const total = Number(panel && panel.total) || 0;
    const key = panel && panel.key;
    const slots = Number(opts && opts.slots) > 0
      ? Number(opts.slots) : HomePanels.ROW_SLOTS;
    const collapsed = !!(opts && opts.collapsed);
    if (!collapsed && key && HomePanels._expanded[key]) {
      return { rows, link: false, total, expanded: true };
    }
    return {
      rows: rows.slice(0, slots),
      link: false, total, expanded: false,
    };
  },

  // "1 of 6 · 3,900 pts left" — folded into the title bar rather than
  // spending a row of its own. The points clause only appears when the
  // server could total the open rewards honestly (organiser prose can't
  // be summed; see parseRewardPoints server-side).
  summaryLine(panel) {
    if (!panel) return '';
    const total = Number(panel.total) || 0;
    const done = Number(panel.done) || 0;
    let line = `${done} of ${total}`;
    const remaining = panel.points_remaining;
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0) {
      line += ` · ${remaining.toLocaleString('en-US')} pts left`;
    }
    return line;
  },

  // ── Data ───────────────────────────────────────────────────────────

  // Called from Home.load(). At most one fetch per TTL, and concurrent
  // callers share the in-flight promise.
  ensureLoaded(opts) {
    const force = !!(opts && opts.force);
    if (!window.App || !App.user) return Promise.resolve();
    if (HomePanels._inflight) return HomePanels._inflight;
    if (!force && HomePanels._data
        && Date.now() - HomePanels._fetchedAt < HomePanels.TTL_MS) {
      return Promise.resolve();
    }
    // ?demo=1 rides along exactly like Home.load()'s own demoQS — the
    // server only honours it in staging. `expand` names the one panel the
    // viewer has opened in place, so the fetch brings its full list.
    //
    // `challenges=few|none` and `board=kudos` ride along WITH it: both demo
    // variants are chosen server-side, so a param left in the address bar but
    // not on the fetch would silently serve the default payload — which is
    // what the deep link, the dapp.json check and the before/after
    // screenshots would then all capture.
    const params = new URLSearchParams();
    try {
      const here = new URLSearchParams(location.search);
      if (here.get('demo') === '1') {
        params.set('demo', '1');
        const variant = here.get('challenges');
        if (variant) params.set('challenges', variant);
        const board = here.get('board');
        if (board) params.set('board', board);
      }
    } catch (err) { /* ignore */ }
    const expandKey = Object.keys(HomePanels._expanded)
      .find((k) => HomePanels._expanded[k]);
    if (expandKey) params.set('expand', expandKey);
    const qs = params.toString() ? `?${params.toString()}` : '';

    HomePanels._inflight = fetch(`/api/home-panels${qs}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && Array.isArray(json.panels)) {
          HomePanels._data = json;
          HomePanels._fetchedAt = Date.now();
        }
      })
      // Silent on failure: a home screen must never break (or shout in the
      // console) because the challenge read hiccuped. The block just stays
      // absent until the next mount.
      .catch(() => {})
      .then(() => {
        HomePanels._inflight = null;
        HomePanels.render();
      });
    return HomePanels._inflight;
  },

  panelFor(key) {
    const panels = HomePanels._data && HomePanels._data.panels;
    if (!Array.isArray(panels)) return null;
    return panels.find((p) => p && p.key === key) || null;
  },

  // ── Rendering ──────────────────────────────────────────────────────

  // Painted from the cache only — never fetches. Deliberately NOT gated on
  // Home._dragActive: this section is outside #app-list, so painting it
  // mid-drag can't yank a card out from under the pointer.
  render() {
    // Hosts, in two shapes. Home.render() plants one multi-cell slot INSIDE
    // #app-list per placed widget — `[data-panel-slot="<key>"]` — and those
    // win when they exist; the standalone #home-panels section below the
    // grid is the fallback for views that have no grid to ride in (an active
    // search, or a grid that hasn't painted yet). Painting whichever exists
    // keeps one render path for both.
    const slots = Array.from(document.querySelectorAll('[data-panel-slot]'));
    const section = document.getElementById('home-panels');
    if (!slots.length && !section) return;

    if (slots.length) {
      // Don't leave a stale copy in the section when the slots own it.
      if (section) {
        section.innerHTML = '';
        section.classList.add('hidden');
      }
      for (const slot of slots) {
        const key = slot.dataset.panelSlot;
        const panel = HomePanels.panelFor(key);
        // IN-GRID: this host is a real (column, row) rectangle of #app-list,
        // so the desktop fill has a fixed height to fill. `cols` decides
        // whether it does — see fillSlots / currentCols.
        const html = panel
          ? HomePanels.renderPanel(panel, { inGrid: true, cols: HomePanels.currentCols() })
          : '';
        slot.innerHTML = html;
        slot.classList.toggle('hidden', !html);
        HomePanels._stampState(slot);
        if (html) HomePanels._wire(slot);
      }
      return;
    }

    const html = HomePanels.renderAll();
    section.innerHTML = html;
    section.classList.toggle('hidden', !html);
    if (html) HomePanels._wire(section);
  },

  // Lift a widget's own state attributes onto its HOST.
  //
  // The create widget stamps `data-create-enabled` on the markup it returns
  // (and Discover stamps `data-featured` / `data-popular` with its two lane
  // counts), but that markup is painted INSIDE the `[data-panel-slot]` host
  // — so a selector written the way the spec describes it ("stamped on the
  // host"), and the way the dapp.json checks and screenshot assertions write
  // it, `[data-panel-slot="create"][data-create-enabled="true"]`, asks for
  // both attributes on ONE element and matches nothing. Mirroring the value
  // up is cheaper and less brittle than teaching every caller the
  // two-element shape, and it keeps the widget itself the single place that
  // decides.
  //
  // Every attribute here is mirrored or CLEARED on each paint, so a host can
  // never keep a stale value a later render stopped emitting.
  STATE_ATTRS: ['data-create-enabled', 'data-featured', 'data-popular'],

  _stampState(host) {
    if (!host || !host.querySelector) return;
    for (const attr of HomePanels.STATE_ATTRS) {
      const inner = host.querySelector(`[${attr}]`);
      if (inner) host.setAttribute(attr, inner.getAttribute(attr));
      else if (host.hasAttribute && host.hasAttribute(attr)) host.removeAttribute(attr);
    }
  },

  // Every widget the grid should place for this viewer, in registry order:
  // the registry minus what they've hidden. This — NOT the built `panels`
  // array — is what HomeLayout places, because `discover` and `create` are
  // marker entries with no payload and would otherwise never get a cell.
  gridSlotKeys() {
    const data = HomePanels._data;
    if (!data) return [];
    const hidden = new Set(Array.isArray(data.hidden) ? data.hidden : []);
    // The registry is the authority — it carries the marker widgets
    // (discover, create) that build no payload and so never appear in
    // `panels`. Falling back to the built panels when it is absent keeps a
    // partial payload rendering something rather than blanking the grid.
    const source = Array.isArray(data.registry) && data.registry.length
      ? data.registry
      : (Array.isArray(data.panels) ? data.panels : []);
    return source.map((r) => r.key).filter((k) => k && !hidden.has(k));
  },

  // Is this widget allowed to be hidden? Discover is not (its footer is the
  // shell's only door to the app directory). Everything else is — including
  // `create`, for every account regardless of app quota.
  isRemovable(key) {
    const data = HomePanels._data;
    const entry = data && Array.isArray(data.registry)
      ? data.registry.find((r) => r.key === key) : null;
    return !entry || entry.removable !== false;
  },

  titleFor(key) {
    const data = HomePanels._data;
    const entry = data && Array.isArray(data.registry)
      ? data.registry.find((r) => r.key === key) : null;
    if (entry && entry.title) return entry.title;
    // A built payload carries its own title; fall back to it so a partial
    // response (panels but no registry) still names the widget in its menu
    // rather than heading the action sheet "Widget".
    const built = data && Array.isArray(data.panels)
      ? data.panels.find((p) => p && p.key === key) : null;
    return (built && built.title) || 'Widget';
  },

  // The widget CONTENT for one key, whether or not the server built a
  // payload for it. `challenges` has a real builder; `discover` and `create`
  // are markers, so panelFor() may hand back a bare `{ key }` — enough for
  // renderPanel() to dispatch on.
  panelFor(key) {
    if (!key) return null;
    const data = HomePanels._data;
    const panels = data && data.panels;
    if (Array.isArray(panels)) {
      const built = panels.find((p) => p && p.key === key);
      if (built) return built;
    }
    // Not in `panels` (a marker widget, or one whose build failed): still
    // renderable if the registry knows it and the viewer hasn't hidden it.
    if (!data || !Array.isArray(data.registry)) return null;
    if (!data.registry.some((r) => r.key === key)) return null;
    const hidden = Array.isArray(data.hidden) ? data.hidden : [];
    if (hidden.includes(key)) return null;
    return { key, title: HomePanels.titleFor(key) };
  },

  // One article per visible panel, stacked. Used ONLY by the #home-panels
  // fallback host (the search view) — the in-grid path paints each slot
  // individually so each widget lands in its own cell.
  // Empty string = render nothing at all (the section is hidden).
  //
  // NOT in the grid, so there is no fixed-height rectangle to fill: this host
  // never draws the desktop leaderboard fill, at any width. (The article is a
  // plain block-level flex container here, so it already sizes to its
  // content.) That is `inGrid: false`, which is all the fill is gated on —
  // `cols` is the REAL viewport now (#968), because it also decides the
  // challenges widget's phone SHAPE, and a desktop search view must not be
  // handed the two-row phone rendering.
  renderAll() {
    if (!window.App || !App.user) return '';
    if (!HomePanels._data) return '';
    const cols = HomePanels.currentCols();
    const blocks = HomePanels.gridSlotKeys()
      .map((k) => HomePanels.panelFor(k))
      .map((p) => (p ? HomePanels.renderPanel(p, { inGrid: false, cols }) : ''))
      .filter(Boolean);
    if (!blocks.length) return '';
    // space-y-2 between blocks: each widget reads as its own box.
    return `<div class="space-y-2">${blocks.join('')}</div>`;
  },

  // Dispatch on panel key. An unknown key renders nothing rather than
  // throwing, so a server that ships a new panel before the client knows
  // it degrades to "not shown" instead of a blank home screen.
  renderPanel(panel, opts) {
    if (!panel) return '';
    if (panel.key === 'challenges') return HomePanels.renderChallengesPanel(panel, opts);
    if (panel.key === 'discover') return HomePanels.renderDiscoverPanel(panel);
    if (panel.key === 'create') return HomePanels.renderCreatePanel(panel);
    return '';
  },

  // The bordered block: title bar, rows list, optional footer. `flex-none`
  // on the bar/footer and .home-panel-rows on the list are what make the CSS
  // cap clip rather than grow (app.css --home-panel-max-h);
  // `.home-panel--expanded` lifts the cap entirely.
  //
  // THE WHOLE TITLE BAR IS THE DRAG HANDLE. It carries no ⠿ grip any more:
  // the grip never owned the gesture (the drag surface has always been the
  // whole grid item), so a dedicated grabber beside a bar that is ITSELF
  // grabbable read as "only this glyph works" — which is how the widget got
  // reported as undraggable. `select-none` is what stops a desktop drag from
  // sweeping a text selection across the title instead; app.css supplies the
  // grab cursor, scoped to the in-grid host that can actually move.
  //
  // The one control on the bar is the ⋮ menu, and it is deliberately NOT
  // part of the handle — see _wire, which stops its pointerdown before the
  // grid's reorder recognizer can see it.
  //
  // `stamps` carries extra per-panel state onto the article. Two shapes ride
  // through here: the challenges widget's `{ cls, attrs }` (an extra CSS
  // class plus a pre-built `data-rows`/`data-fill` attribute string — a
  // HEIGHT/COMPOSITION change, and a height is invisible to a CSS selector,
  // so the dapp.json checks and screenshot assertions need something to hold
  // on to), and Discover's plain `{ name: value }` bag (its two lane counts,
  // which _stampState mirrors onto the [data-panel-slot] host so one selector
  // can ask for the slot AND the state).
  //
  // `stamps.collapsed` forces the article to render un-expanded whatever the
  // per-visit `_expanded` flag says — the phone branch's contract (#968): its
  // one-cell footprint has nowhere to grow, and `_expanded` survives a
  // desktop→phone resize, so honouring it there would drop every row of an
  // expanded season into a 116px cell.
  _panelShell(key, titleHtml, bodyHtml, footerHtml, stamps) {
    const esc = HomePanels.esc;
    const expanded = !(stamps && stamps.collapsed) && !!HomePanels._expanded[key];
    const extraCls = (stamps && stamps.cls) ? ` ${stamps.cls}` : '';
    const extra = (stamps && typeof stamps.attrs === 'string')
      ? ` ${stamps.attrs}`
      : Object.entries(stamps || {})
        // `cls` and `collapsed` are shell CONTROLS, not data attributes.
        .filter(([name]) => name !== 'cls' && name !== 'collapsed')
        .map(([name, value]) => ` ${name}="${esc(value)}"`).join('');
    return `
      <article class="home-panel home-panel-card${expanded ? ' home-panel--expanded' : ''}${extraCls} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden" data-panel="${esc(key)}"${extra}>
        <div class="home-panel-bar flex-none flex items-center gap-2 px-2.5 py-1 border-b border-zinc-200 dark:border-zinc-800 select-none" title="Drag to move this widget">
          ${titleHtml}
          <button type="button" class="home-panel-menu un-touch-target shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 leading-none"
            data-panel-key="${esc(key)}" aria-haspopup="menu"
            title="Widget options" aria-label="Widget options">
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="10" cy="4.2" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="10" cy="15.8" r="1.6"/></svg>
          </button>
        </div>
        ${bodyHtml}
        ${footerHtml || ''}
      </article>`;
  },

  // THE LEADERBOARD LINK (#980). The Challenges widget's standing door to the
  // Leaderboard screen, and it is Discover's browse control verbatim — same
  // violet 12px link, same icon-then-label shape, same place in the TITLE BAR,
  // same real hash navigation — because it answers the same question ("where
  // is the full version of this?") on the same home screen. Discover's is the
  // shell's only door to the app directory; before this the Challenges widget
  // had NO door to the leaderboard at all unless the season happened to be
  // empty (see _fillFooter) — the rows and the footer both went to the
  // Challenges TAB instead.
  //
  // It renders in EVERY branch and at EVERY breakpoint, for Discover's reason:
  // a discovery path that depends on there being content to discover is not a
  // path. On a phone it is the bar's ONE control (it replaced the "See all"
  // this widget used to carry there — see renderChallengesPanel), so the
  // one-cell footprint from #968 is unchanged: still no footer, still two rows.
  //
  // `compact` only shortens the LABEL. Beside a title that already reads
  // "CHALLENGES · 1 of 6", "Leaderboard" is what fits without truncating the
  // counter away; the aria-label stays the full sentence in both shapes.
  _leaderboardLink(compact) {
    return `
      <button type="button" class="home-panel-lb-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap"
        title="Open the Leaderboard screen" aria-label="Open leaderboard">
        <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-7.322c.983.143 1.954.317 2.916.52a6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"/></svg>
        <span class="whitespace-nowrap">${compact ? 'Leaderboard' : 'Open leaderboard'}</span>
      </button>`;
  },

  // The footer bar: the expand/collapse toggle on the LEFT (it grows the
  // block past its cap in place, and the same control collapses it), and
  // the way out to the full Challenges screen on the RIGHT.
  //
  // That right-hand control says "Open challenges", not "Go to leaderboard"
  // (#980): it navigates to #leaderboard/challenges, and the title bar now
  // carries a control that goes to the bare #leaderboard. Two affordances one
  // card apart, both reading "leaderboard", landing on DIFFERENT tabs is worse
  // than the ambiguity this label was written to fix — so each one names the
  // screen it actually opens, and "Open challenges" is the wording the ⋮
  // menu's row for the same destination already used.
  _panelFooter(key, total, expanded) {
    const esc = HomePanels.esc;
    const label = expanded
      ? 'Show less'
      : (total ? `See all ${esc(total)} challenges` : 'See all challenges');
    return `
      <div class="home-panel-footer flex-none flex items-center justify-between gap-2 px-2.5 border-t border-zinc-200 dark:border-zinc-800">
        <button type="button" class="home-panel-expand flex items-center gap-1 text-[12px] font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap"
          data-panel-key="${esc(key)}" aria-expanded="${expanded ? 'true' : 'false'}"
          title="${expanded ? 'Collapse this widget' : 'Show every challenge in this widget'}">
          <svg class="w-3 h-3 shrink-0 transition-transform${expanded ? ' rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
          <span class="whitespace-nowrap">${label}</span>
        </button>
        <button type="button" class="home-panel-open flex items-center gap-1 text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 whitespace-nowrap"
          title="Go to the Challenges tab on the Leaderboard screen" aria-label="Open challenges">
          <span class="whitespace-nowrap">Open challenges</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      </div>`;
  },

  // The footer for the ZERO-challenge desktop tile: there is nothing to
  // expand and nothing to count, so the expand toggle would be a control
  // that does nothing. One way out instead, and it names THE BOARD ABOVE IT
  // rather than "the leaderboard" (#980): the title bar's link already goes to
  // the Leaderboard screen, so a footer repeating that word one card away —
  // and, for the kudos fallback, landing on a different tab — would read as
  // two doors to one place. This control belongs to the fill block, so it says
  // which board it is the full version of.
  // `kind` follows the rows: the standings go to the Leaderboard screen's
  // primary tab, the kudos fallback to the Kudos tab's Top users view.
  _fillFooter(kind) {
    const esc = HomePanels.esc;
    const k = kind === 'kudos' ? 'kudos' : 'topochain';
    const title = k === 'kudos'
      ? 'Go to the Top users view on the Leaderboard screen’s Kudos tab'
      : 'Go to the Leaderboard screen';
    const label = k === 'kudos' ? 'See full kudos board' : 'See full standings';
    return `
      <div class="home-panel-footer flex-none flex items-center justify-end gap-2 px-2.5 border-t border-zinc-200 dark:border-zinc-800">
        <button type="button" class="home-panel-lb-open flex items-center gap-1 text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 whitespace-nowrap"
          data-lb-kind="${esc(k)}"
          title="${esc(title)}" aria-label="${esc(label)}">
          <span class="whitespace-nowrap">${label}</span>
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </button>
      </div>`;
  },

  // The LEADERBOARD block: a hairline label plus `slots` rows, drawn only on
  // the desktop tile and only when the challenge rows leave room.
  //
  // Composition: the top rows in order, and the VIEWER'S OWN ROW last,
  // tinted — the pattern every standings surface uses, and the reason the
  // fill is worth the space at all ("where am I?"). A viewer already inside
  // the top slice is highlighted in place rather than repeated, and the freed
  // slot goes to the next entry down. A viewer with NO row on the board (the
  // common case on the Topochain standings, which are keyed by participation
  // rather than by having an account) simply doesn't get a line — the slot
  // goes to one more participant instead of inventing a rank.
  //
  // The server decides which rows are the viewer's (`row.you`) and what the
  // block is called (`fill.label` — "Leaderboard" for the Topochain
  // standings, "Kudos" for the fallback board), so the client never has to
  // string-match names or know which board it was handed.
  //
  // Returns '' when there is no room or no data, which is also what makes
  // `data-fill="0"` honest.
  renderFillBlock(fill, slots) {
    if (!fill || slots < 1) return '';
    const esc = HomePanels.esc;
    const top = Array.isArray(fill.top) ? fill.top : [];
    const viewer = fill.viewer || null;
    const total = Number(fill.total) || 0;
    const kind = fill.kind === 'kudos' ? 'kudos' : 'topochain';
    const label = fill.label || 'Leaderboard';
    // Is the viewer inside the part of the top list we can actually show?
    const viewerInTop = !!viewer && top.slice(0, slots).some((r) => r && r.you);
    let picks;
    if (viewer && !viewerInTop) {
      // Last slot belongs to the viewer; the rest is the head of the board.
      picks = top.slice(0, slots - 1).map((r) => ({ row: r, you: false }));
      picks.push({ row: viewer, you: true });
    } else {
      picks = top.slice(0, slots).map((r) => ({ row: r, you: !!(r && r.you) }));
    }
    if (!picks.length) return '';
    const rowsHtml = picks
      .map((p) => HomePanels.renderFillRow(p.row, p.you, total, fill))
      .join('');
    return `
      <div class="home-panel-fill flex-none" data-fill-kind="${esc(kind)}">
        <div class="home-panel-fill-label flex items-center px-2.5 text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 border-t border-zinc-200 dark:border-zinc-800">${esc(label)}</div>
        ${rowsHtml}
      </div>`;
  },

  // Points are five-figure numbers on the Topochain standings (production's
  // top score is ~59,000) against single digits on the kudos board, so the
  // primary board's score is shortened — "59.1k" — to keep the name lane
  // readable. The screen's own table keeps the full figures.
  formatFillScore(score, kind) {
    const n = Number(score) || 0;
    if (kind === 'kudos' || n < 1000) return String(n);
    try {
      return new Intl.NumberFormat('en-US', {
        notation: 'compact', maximumFractionDigits: 1,
      }).format(n).toLowerCase();
    } catch (err) {
      return String(n);
    }
  },

  // One leaderboard line, on the challenge row's geometry: the rank sits in
  // the glyph's 10px column, the name takes the goal's lane, and the score
  // takes the reward chip's slot — so the two kinds of row line up rather
  // than reading as two different lists jammed together.
  //
  // `.home-panel-lb-row` is load-bearing and not decoration: _wire() excludes
  // it from the challenges click handler, because these rows go to the
  // Leaderboard screen, not to Challenges.
  renderFillRow(row, isYou, total, fill) {
    const esc = HomePanels.esc;
    const kind = fill && fill.kind === 'kudos' ? 'kudos' : 'topochain';
    // A podium-excluded standings row carries no rank — the screen's table
    // draws those as an em dash, so the fill does too.
    const rank = Number(row.rank) || 0;
    const rankLabel = rank ? String(rank) : '—';
    const score = Number(row.score) || 0;
    const who = String(row.name || '');
    const name = isYou ? 'You' : who;
    const metric = kind === 'kudos'
      ? 'by kudos on merged proposals'
      : `by points${fill && fill.event && fill.event.name ? ` in ${fill.event.name}` : ''}`;
    const where = rank ? `#${rank}` : 'unranked';
    const tip = isYou
      ? `You are ${where}${total ? ` of ${total}` : ''} ${metric}`
      : `${who} — ${where} ${metric}`;
    // A zero score is muted rather than a violet chip: "0" shouted in the
    // accent colour reads as a warning, not as a starting point.
    const scoreHtml = score > 0
      ? `<span class="shrink-0 whitespace-nowrap text-[11px] font-semibold text-violet-600 dark:text-violet-400">${esc(HomePanels.formatFillScore(score, kind))}</span>`
      : `<span class="shrink-0 whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">0</span>`;
    return `
      <div class="home-panel-row home-panel-lb-row flex items-center gap-2 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors${
        isYou ? ' home-panel-lb-you bg-violet-500/[0.06] dark:bg-violet-500/10' : ''
      }" data-lb-kind="${esc(kind)}" title="${esc(tip)}">
        <span class="home-panel-glyph shrink-0 w-2.5 text-[10px] leading-none tabular-nums text-right text-zinc-400 dark:text-zinc-500" aria-hidden="true">${esc(rankLabel)}</span>
        <span class="home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] ${
          isYou ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-900 dark:text-zinc-100'
        }">${esc(name)}</span>
        ${scoreHtml}
      </div>`;
  },

  renderChallengesPanel(panel, opts) {
    const esc = HomePanels.esc;
    const total = Number(panel.total) || 0;
    const title = esc(panel.title || 'Challenges');
    const inGrid = !!(opts && opts.inGrid);
    const cols = Number(opts && opts.cols) || 4;
    // THE PHONE SHAPE (#968). Below five columns the widget owns ONE grid
    // cell, so its content is reshaped to fit: two rows, the way out in the
    // title bar, no footer, and never expanded. Keyed on the REAL column
    // count, which is why renderAll() passes currentCols() rather than a
    // hardcoded 4 — a desktop search view is not a phone.
    const compact = cols < HomePanels.DESKTOP_COLS;
    // …and expansion is a desktop-only state now, so the flag only counts
    // there. It survives a resize (it is per-visit client state), and
    // honouring it on a phone would drop every row of an expanded season
    // into a 116px cell.
    const expanded = !compact && !!HomePanels._expanded[panel.key];
    // The desktop tile is the only place with a fixed height to fill.
    const canFill = inGrid && !compact && !expanded;
    // `home-panel--fit` is stamped in BOTH branches; app.css only honours it
    // below 640px, which is what keeps the desktop tile a fixed 2x2.
    const rowsOf = (n, fillRows) => ({
      cls: 'home-panel--fit',
      attrs: `data-rows="${n}" data-fill="${fillRows}"`,
      collapsed: compact,
    });

    // Nothing open. The block STAYS — for everyone, admins included — and
    // says why: a widget that silently vanishes between seasons leaves the
    // viewer with no way to tell "nothing is running" from "this broke".
    // On a phone that is the whole block (one line, no footer, ~68px); on
    // desktop the same line leads and the LEADERBOARD fill spends the rest
    // of the tile.
    if (!total || !Array.isArray(panel.challenges) || !panel.challenges.length) {
      // A payload that came back empty can't be expanded — and leaving the
      // flag set would keep ?expand=challenges on every later fetch, asking
      // for a finished-challenge list that would repopulate the block.
      if (HomePanels._expanded[panel.key]) HomePanels._expanded[panel.key] = false;
      const fillHtml = canFill
        ? HomePanels.renderFillBlock(panel.leaderboard, HomePanels.fillSlots(0))
        : '';
      const fillRows = HomePanels._countFillRows(fillHtml);
      const noteHtml = `<p class="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors" title="Go to the Challenges tab on the Leaderboard screen">No challenges are running right now</p>`;
      return HomePanels._panelShell(
        panel.key,
        // flex-1 so the ⋮ menu sits at the right edge, same as the populated
        // branch — this state is on every home screen now, so its chrome has
        // to match the one beside it. The leaderboard link rides along (#980):
        // between seasons the standings are the ONLY thing this widget has to
        // point at, and on a phone this branch draws no footer at all, so the
        // bar is where the door has to be.
        `<span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}</span>${
          HomePanels._leaderboardLink(compact)}`,
        `<div class="home-panel-body">${noteHtml}${fillHtml}</div>`,
        // Nothing to expand, nothing to count: the phone block ends at the
        // note, and the desktop tile offers the one destination its rows
        // actually point at.
        fillRows ? HomePanels._fillFooter(panel.leaderboard && panel.leaderboard.kind) : '',
        rowsOf(0, fillRows)
      );
    }

    const { rows } = HomePanels.visibleSlots(panel, {
      slots: compact ? HomePanels.PHONE_ROW_SLOTS : HomePanels.ROW_SLOTS,
      collapsed: compact,
    });
    const summary = esc(HomePanels.summaryLine(panel));
    // truncate (which carries white-space: nowrap) + an explicit nowrap on
    // the inner span: the counter must never push the title onto a second
    // line, it gets clipped with an ellipsis instead. The leaderboard link
    // sits beside it as a shrink-0 sibling, so a long summary truncates
    // rather than pushing the control off the bar.
    const titleHtml = `
      <span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}<span class="normal-case tracking-normal whitespace-nowrap"> · ${summary}</span></span>${
      HomePanels._leaderboardLink(compact)}`;

    const rowsHtml = rows.map((c) => HomePanels.renderChallengeRow(c)).join('');
    // The meter lane is a property of the LIST, not of the row that draws
    // a bar: reserving it on every row is what keeps the goals on one
    // baseline. A panel with no numeric challenge at all reserves nothing
    // and its rows centre plainly — see app.css. The fill block sits OUTSIDE
    // this list, so leaderboard rows never inherit the lane's padding.
    const metered = rows.some((c) => HomePanels.hasMeter(c));
    const fillHtml = canFill
      ? HomePanels.renderFillBlock(panel.leaderboard, HomePanels.fillSlots(rows.length))
      : '';
    const fillRows = HomePanels._countFillRows(fillHtml);

    return HomePanels._panelShell(panel.key, titleHtml,
      `<div class="home-panel-body"><div class="home-panel-rows${metered ? ' home-panel-rows--metered' : ''}">${rowsHtml}</div>${fillHtml}</div>`,
      // NO FOOTER on a phone: its 27px is the widget's second row, and both
      // of its controls are accounted for — the title bar's leaderboard link
      // is the way off this screen, tapping a row still opens the Challenges
      // tab, and expanding in place is a state a one-cell footprint cannot
      // hold.
      compact ? '' : HomePanels._panelFooter(panel.key, total, expanded),
      rowsOf(rows.length, fillRows));
  },

  // How many leaderboard rows a rendered fill block actually drew. Counting
  // the markup (rather than threading the number back out of the renderer)
  // keeps `data-fill` describing what is ON SCREEN — it can never claim rows
  // that renderFillBlock declined to draw.
  // (The "you" highlight is `home-panel-lb-you`, deliberately NOT a
  // `home-panel-lb-row--you` modifier: a class that contains the row class as
  // a substring would count that row twice here and in every check written
  // the same way.)
  _countFillRows(html) {
    if (!html) return 0;
    return (html.match(/home-panel-lb-row/g) || []).length;
  },

  // ── Discover ───────────────────────────────────────────────────────
  //
  // The former "Featured apps" section, now a widget in the grid: the
  // admin-curated tiles plus the way into the #apps directory. The tiles are
  // the same per-viewer `featured` flags GET /api/apps already serializes
  // (Home.featuredApps derives them; no second query), and the browse
  // control is the same #home-browse-btn that used to sit under the old card.
  //
  // Tiles are the COMPACT 40px treatment (the widget-strip tile, not the
  // 56px launcher card): the block is ~366px wide on a phone and ~397px on
  // desktop, and a full card simply does not fit.
  //
  // TWO SHAPES, ONE PER BREAKPOINT (#949) — the widget's registry footprint
  // is asymmetric (4x1 on a phone, 2x2 on desktop), and the content follows:
  //
  //   PHONE (4 cols, one row): the title bar and the featured lane, and
  //     that is the whole widget. It is full width there, so the row this
  //     gives back is a clean full-width gap.
  //   DESKTOP (5 cols, two rows): the same, plus a hairline, a "Popular"
  //     caption and a second lane — the most-used apps this viewer doesn't
  //     have yet (Home.popularApps). The footprint is unchanged from before
  //     this issue, so no stored desktop arrangement moves; the row that was
  //     dead space is earned instead of trimmed.
  //
  // The column count is read from Home.currentCols() — the viewport, not the
  // DOM, so it is answerable before the first paint — and a breakpoint
  // crossing re-renders through Home._applyColumnCount() → Home.render() →
  // HomePanels.render(), which only fires when the count actually moved.
  //
  // THE BROWSE CONTROL RIDES IN THE TITLE BAR, not in a footer of its own.
  // A .home-panel-footer costs 27px, which on a phone is exactly the
  // difference between a tile lane that fits its one cell and one that clips
  // its captions. Discover has ONE destination, so it belongs beside the
  // title. (Challenges keeps _panelFooter on desktop for its expand toggle,
  // and #980 moved its leaderboard door up here for the same reasons this one
  // lives here.) _wire() needs no change for this: its
  // pointerdown guard is on `.home-panel button` generally, so the button is
  // excluded from the drag handle the bar otherwise is.
  //
  // The browse control ALWAYS renders — it is THE discovery path, so it must
  // not depend on curation existing. With nothing left to feature the tile
  // lane is dropped entirely (rather than drawn empty) and one centred line
  // takes its place.
  renderDiscoverPanel(panel) {
    const esc = HomePanels.esc;
    const hasHome = !!(window.Home && typeof Home.featuredApps === 'function');
    const featured = hasHome ? Home.featuredApps(Home._apps || []) : [];
    // Desktop only. With no Home there is no app list either, so the widget
    // is down to its note whatever this answers — 5 is the honest default.
    const cols = (window.Home && typeof Home.currentCols === 'function')
      ? Home.currentCols() : 5;
    const popular = (cols === 5 && hasHome && typeof Home.popularApps === 'function')
      ? Home.popularApps(Home._apps || []) : [];

    const titleHtml = `
      <span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${esc(panel.title || 'Discover')}</span>
      <button type="button" id="home-browse-btn" class="home-panel-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap"
        title="Browse every app in the directory" aria-label="Browse all apps">
        <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        <span class="whitespace-nowrap">Browse all apps</span>
      </button>`;

    const lane = (apps, extraClass) => `<div class="home-panel-rows home-discover-lane home-discover-tiles${
      extraClass ? ` ${extraClass}` : ''
    }">${apps.map((a) => HomePanels.renderDiscoverTile(a)).join('')}</div>`;

    const featuredHtml = featured.length
      ? lane(featured)
      : `<p class="home-panel-rows home-discover-lane home-discover-empty flex items-center justify-center px-2.5 text-center text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">Nothing featured right now — browse the directory.</p>`;

    // No popular apps → no divider and no second lane, rather than a second
    // apology stacked under the first. The featured lane (or its note) then
    // has the whole box, which is exactly the pre-#949 rendering.
    const popularHtml = popular.length
      ? `<div class="home-discover-divider flex-none flex items-center px-2.5 border-t border-zinc-200 dark:border-zinc-800">
          <span class="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Popular</span>
        </div>${lane(popular, 'home-discover-popular')}`
      : '';

    return HomePanels._panelShell(panel.key, titleHtml, featuredHtml + popularHtml, null, {
      'data-featured': String(featured.length),
      'data-popular': String(popular.length),
    });
  },

  // One compact discovery tile — the same markup in both lanes. Carries
  // .app-card + data-slug so Home._wireDiscoveryCards binds it exactly as it
  // bound the old featured row — same tap-to-open, same +/✓ add badge, same
  // optimistic toggle.
  //
  // The icon carries NO w-10 h-10: app.css sizes it fluidly (100% of its
  // track, capped at the same 2.5rem it always drew at) because a lane's six
  // tracks are only ~32px wide in the narrowest 5-column window, where a
  // fixed 40px box would overflow its track and be clipped by the panel.
  renderDiscoverTile(app) {
    const esc = HomePanels.esc;
    const added = !!(window.Home && Home.isYours && Home.isYours(app));
    let iconHtml;
    let iconKind;
    if (app.icon_url) {
      iconKind = 'image';
      iconHtml = `<img src="${esc(app.icon_url)}" alt="" loading="lazy" draggable="false" class="w-full h-full rounded-lg object-cover">`;
    } else if (app.icon_emoji) {
      iconKind = 'emoji';
      iconHtml = `<span class="text-xl leading-none" aria-hidden="true">${esc(app.icon_emoji)}</span>`;
    } else {
      iconKind = 'letter';
      iconHtml = esc(String(app.name || '?').charAt(0).toUpperCase());
    }
    return `
      <div class="app-card home-discover-tile relative flex flex-col items-center gap-1 cursor-pointer" data-slug="${esc(app.slug)}" data-status="${esc(app.status || '')}"${app.demo ? ' data-demo="true"' : ''}>
        <div class="home-discover-icon-wrap relative">
          <div class="app-icon-tile home-discover-icon rounded-lg overflow-hidden flex items-center justify-center font-bold text-base" data-icon="${iconKind}">${iconHtml}</div>
          <button class="card-add-btn absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full border shadow-sm transition-colors ${
            added
              ? 'bg-emerald-500 border-emerald-500 text-white'
              : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-violet-600 dark:text-violet-400 hover:border-violet-400'
          }" data-slug="${esc(app.slug)}" data-added="${added}" title="${
            added ? 'Added — tap to remove from Your apps' : 'Add to Your apps'
          }" aria-label="${
            added ? `Remove ${esc(app.name)} from Your apps` : `Add ${esc(app.name)} to Your apps`
          }" aria-pressed="${added}">${
            added
              ? '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
              : '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>'
          }</button>
        </div>
        <span class="text-[0.6rem] leading-tight truncate w-full text-center text-zinc-600 dark:text-zinc-300">${esc(app.name)}</span>
      </div>`;
  },

  // ── Create app ─────────────────────────────────────────────────────
  //
  // The former "Create an app" section, now a 1x1 tile-sized widget.
  //
  // IT IS ON EVERY HOME SCREEN, FOR EVERY ACCOUNT. An account with no app
  // quota gets the same widget in the same cell — dimmed, and tapping it
  // says why — rather than having it silently absent. Two reasons this is
  // the right shape and not a conditional placement:
  //
  //   1. canCreateApps is DERIVED per request (isAdmin || live app count <
  //      app_quota — see /api/auth/me), so it flips without any user action:
  //      creating your one allowed app, an admin editing your quota, an app
  //      erroring out. Conditional placement would turn each of those flips
  //      into a layout mutation that re-packs the grid under the user.
  //   2. It's the majority rendering — most accounts carry no quota — so
  //      "absent" would read as a missing feature rather than a locked one.
  //
  // The disabled state must NOT be a `disabled` attribute: a disabled
  // element swallows pointer events, which would kill both the explanatory
  // toast AND the widget's participation in the drag recognizer. aria-disabled
  // plus a branch in the click handler keeps it draggable and tappable.
  renderCreatePanel(panel) {
    const esc = HomePanels.esc;
    const canCreate = !!(window.Home && typeof Home.canCreate === 'function' && Home.canCreate());
    const hint = (window.Home && Home.CREATE_DISABLED_HINT)
      || 'Ask an admin to enable app creation for your account.';
    // The whole tile is the button (a 1x1 cell has no room for chrome around
    // one), and .home-create-btn is what Home.wireCreateButtons() binds.
    //
    // TWO SHAPES, ONE MARKUP. The widget's footprint is 4x1 below 640px and
    // 1x1 at and above it (PANEL_REGISTRY `sizes`), so the content flips with
    // the SAME Tailwind `sm:` breakpoint the grid does: a full-width row lays
    // the icon and label out side by side (stacking them in a 116px row would
    // leave the label clipped against the tile's own padding), a single cell
    // stacks them as before. Whole class literals, so the compiled stylesheet
    // carries both.
    return `
      <div class="home-create-widget ${canCreate ? '' : 'home-create-widget--disabled'} h-full" data-panel="${esc(panel.key)}" data-create-enabled="${canCreate}">
        <button type="button" class="home-create-btn home-create-tile w-full h-full rounded-xl p-3 flex flex-row sm:flex-col items-center justify-center text-center gap-3 sm:gap-2 transition-colors"
          ${canCreate ? '' : 'aria-disabled="true" '}title="${canCreate ? 'Create a new app' : esc(hint)}"
          aria-label="${canCreate ? 'Create a new app' : esc(hint)}">
          <span class="app-icon-tile app-icon-tile--empty w-14 h-14 rounded-xl flex items-center justify-center shrink-0" aria-hidden="true">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          </span>
          <span class="home-create-label text-sm sm:text-xs leading-tight max-w-full ${canCreate ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-400 dark:text-zinc-500'}">Create app</span>
        </button>
      </div>`;
  },

  // Does this challenge draw a progress bar? One definition, used by the
  // row (to draw one) and by the panel (to reserve the lane every row
  // shares), so the two can't disagree and leave a bar in a row with no
  // room for it.
  hasMeter(c) {
    return !!(c && c.metric && c.progress && c.progress.target != null);
  },

  // One 40px line: glyph · goal · count · reward, plus a 9px progress bar
  // in the meter lane along the row's bottom edge on numeric rows.
  // Category, task, the organiser CTA and the earned-points line are
  // deliberately absent — they don't fit at this density and all four live
  // one tap away on the Challenges screen.
  renderChallengeRow(c) {
    const esc = HomePanels.esc;
    const done = !!(c.progress && c.progress.done);
    const numeric = HomePanels.hasMeter(c);

    // A glyph, not a chip: same signal, a fraction of the width.
    //
    // Both states occupy the SAME 10px box (w-2.5). That is not cosmetic
    // symmetry: the goal text's left edge and the progress bar's `left-7`
    // are both computed from this width (px-2.5 10 + glyph 10 + gap-2 8 =
    // 28px), so a ✓ that sized itself intrinsically would shift the goal —
    // and desynchronise the bar from it — on exactly the done rows.
    const glyph = done
      ? '<span class="home-panel-glyph shrink-0 w-2.5 h-2.5 flex items-center justify-center text-emerald-500 text-[11px] leading-none" aria-hidden="true">&#10003;</span>'
      : '<span class="home-panel-glyph shrink-0 w-2.5 h-2.5 rounded-full border border-zinc-300 dark:border-zinc-600" aria-hidden="true"></span>';

    // whitespace-nowrap on the chip is load-bearing, not decoration: the
    // reward is organiser prose and multi-word ("Up to 6,500 pts",
    // "½ of your final credits"), so without it a tight row wraps the chip
    // to a second line that the fixed row height then clips.
    const reward = HomePanels.formatReward(c.reward);
    const rewardHtml = reward
      ? `<span class="shrink-0 whitespace-nowrap text-[11px] font-semibold text-violet-600 dark:text-violet-400">${esc(reward)}</span>`
      : '';

    let countHtml = '';
    let barHtml = '';
    if (numeric) {
      const current = Number(c.progress.current) || 0;
      const target = Number(c.progress.target);
      const pct = HomePanels.progressPercent(current, target);
      const label = c.metric.label ? ` ${c.metric.label}` : '';
      countHtml = `<span class="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">${esc(current)}/${esc(target)}</span>`;
      // An OUTLINED bar: a HAIRLINE border plus a light interior (white in
      // light mode, near-black in dark), so an EMPTY 0/5 track still reads
      // as an empty bar. A borderless 2px grey fill was indistinguishable
      // from the row's hairline divider — it looked like a rendering
      // artefact rather than "none of five done".
      //
      // The outline is deliberately FAINT (a /60 alpha on both skins): its
      // whole job is to describe where the bar's extent is, and at full
      // zinc-300/600 it competed with the violet fill for attention and
      // made a mostly-empty bar look like the loud element in the row. The
      // fill is the signal; the outline is the ruler behind it.
      //
      // Its GEOMETRY — 9px tall, 5px clear of the row divider, spanning
      // from the goal text's own left edge (28px, see the glyph comment
      // above) to 12px short of the right — is in app.css, derived there
      // from --home-panel-meter-lane, the strip every row of a metered
      // panel reserves along its bottom. Keeping it out of utility classes
      // is what lets the lane and the bar move together: the bar's whole
      // problem was that it was jammed against the text above it and the
      // divider below, and those two clearances are properties of the
      // lane, not of this span.
      barHtml = `
        <span class="home-panel-bar-track absolute rounded-full border border-zinc-300/60 dark:border-zinc-600/60 bg-white dark:bg-zinc-900 overflow-hidden"
              role="progressbar" aria-valuenow="${esc(current)}" aria-valuemin="0" aria-valuemax="${esc(target)}"
              aria-label="${esc(c.goal || 'Challenge')}: ${esc(current)} of ${esc(target)}${esc(label)}">
          <span class="home-panel-bar-fill block h-full bg-violet-500" style="width:${pct}%"></span>
        </span>`;
    }

    // The task is the row's tooltip — the one place the dropped detail
    // still surfaces without costing height.
    const tip = c.task ? `${c.goal || ''} — ${c.task}` : (c.goal || '');
    return `
      <div class="home-panel-row flex items-center gap-2 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
           data-challenge-id="${esc(c.id)}" title="${esc(tip)}">
        ${glyph}
        <span class="home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] text-zinc-900 dark:text-zinc-100">${esc(c.goal || '')}</span>
        ${countHtml}
        ${rewardHtml}
        ${barHtml}
      </div>`;
  },

  // Real hash navigation (not a router call) so the Challenges screen gets a
  // history entry and the device back gesture returns to the home screen.
  goToChallenges() {
    location.hash = '#leaderboard/challenges';
  },

  // The desktop fill's destination: the full version of whichever board the
  // fill previewed. The Topochain standings ARE the Leaderboard screen's
  // primary tab, so they address as the bare hash; the kudos fallback goes to
  // the Kudos tab's Top users view. Same real hash navigation as
  // goToChallenges, so the device back gesture returns home.
  goToLeaderboard(kind) {
    location.hash = kind === 'kudos' ? '#leaderboard/users' : '#leaderboard';
  },

  _wire(section) {
    // EVERY control in the block is excluded from the drag. The grid's
    // reorder recognizer listens for pointerdown on #app-list, of which this
    // block is one item (home.js: itemSelector includes .home-panel-slot),
    // and it bubbles — so stopping pointerdown AT the button is what keeps a
    // press on ⋮ from arming a desktop drag, and a finger resting on it from
    // tripping the kit's long-press lift. Without this, opening the menu on a
    // phone would grab the widget instead. Everything the guard does NOT
    // cover — the title bar, the counter, the rows — stays the drag surface.
    section.querySelectorAll('.home-panel button').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    });

    // Rows and the footer's "Open" button both go to the Challenges screen.
    // NOT the leaderboard fill's rows, though — they are a different list
    // with a different destination, and inheriting this handler would send a
    // tap on "#1 alice" to the Challenges tab.
    section.querySelectorAll('.home-panel-row:not(.home-panel-lb-row)').forEach((row) => {
      row.addEventListener('click', HomePanels.goToChallenges);
    });
    section.querySelectorAll('.home-panel-open').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); HomePanels.goToChallenges(); });
    });
    // The fill's rows and its footer control go to the Leaderboard screen —
    // to the tab that shows the board they previewed, which each element
    // carries on `data-lb-kind`.
    section.querySelectorAll('.home-panel-lb-row').forEach((row) => {
      row.addEventListener('click', () => {
        HomePanels.goToLeaderboard(row.dataset.lbKind);
      });
    });
    section.querySelectorAll('.home-panel-lb-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.goToLeaderboard(btn.dataset.lbKind);
      });
    });
    // The title bar's leaderboard link (#980) — the Challenges widget's
    // counterpart to Discover's browse control, and wired the same way: no
    // `data-lb-kind`, so it lands on the bare #leaderboard whatever the fill
    // below it happened to preview. It is the widget's door to the SCREEN, not
    // to one board on it.
    section.querySelectorAll('.home-panel-lb-browse').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.goToLeaderboard();
      });
    });
    section.querySelectorAll('.home-panel-expand').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.toggleExpanded(btn.dataset.panelKey);
      });
    });
    section.querySelectorAll('.home-panel-menu').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        HomePanels.openMenu(btn.dataset.panelKey, btn);
      });
    });

    // Discover: the footer's way into the app directory, plus the featured
    // tiles. The tiles reuse Home's discovery wiring wholesale (tap opens,
    // the badge toggles "Your apps") so the widget can't drift from the row
    // it replaced. Route through the hash so the browse screen gets a real
    // history entry and the OS back gesture returns here.
    section.querySelectorAll('.home-panel-browse').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        location.hash = '#apps';
      });
    });
    // querySelectorAll, not querySelector: Discover draws TWO lanes on
    // desktop (featured + popular), and a lane whose tiles were never wired
    // looks identical in a screenshot while every tap and every + badge in
    // it is dead.
    section.querySelectorAll('.home-discover-tiles').forEach((tiles) => {
      if (window.Home && typeof Home._wireDiscoveryCards === 'function') {
        Home._wireDiscoveryCards(tiles);
      }
    });

    // Create: the enabled tile opens the create modal through
    // Home.wireCreateButtons (which owns the cloneNode re-bind discipline).
    // The DISABLED tile explains itself instead — same string as the tooltip
    // and the ⋮ note, and deliberately not a no-op: a dead tap on a dimmed
    // tile reads as broken, where a toast reads as locked.
    const createHost = section.querySelector('.home-create-widget');
    if (createHost) {
      if (createHost.dataset.createEnabled === 'true') {
        if (window.Home && typeof Home.wireCreateButtons === 'function') {
          Home.wireCreateButtons();
        }
      } else {
        const btn = createHost.querySelector('.home-create-btn');
        if (btn) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const hint = (window.Home && Home.CREATE_DISABLED_HINT)
              || 'Ask an admin to enable app creation for your account.';
            if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast(hint);
          });
        }
      }
    }
  },

  // ── The widget menu ────────────────────────────────────────────────
  //
  // Replaces the bare ✕ the title bar used to carry. A single destructive
  // control with no undo, one press away, on a block whose whole job is to
  // sit quietly on the home screen was too easy to hit by accident — and it
  // left nowhere to put anything else. The menu is the standard home-screen
  // widget affordance and it makes "Hide widget" a deliberate two-step.

  // The rows, as data so they can be asserted without a DOM. `Hide widget`
  // is exactly what the ✕ did: persisted per user, restorable from
  // Settings → Preferences → Home screen widgets.
  menuItems(key) {
    const items = [];
    // Only where the panel HAS a destination. A future widget without one
    // still gets a working menu rather than a row that goes nowhere.
    if (key === 'challenges') {
      items.push({ label: 'Open challenges', handler: () => { HomePanels.goToChallenges(); } });
      // Both of the widget's destinations, named the same way its two visible
      // controls name them (#980) — the bar's link and the footer's button.
      items.push({ label: 'Open leaderboard', handler: () => { HomePanels.goToLeaderboard(); } });
    }
    if (key === 'discover') {
      items.push({ label: 'Browse all apps', handler: () => { location.hash = '#apps'; } });
    }
    // The create widget's menu carries the ask-an-admin sentence as an inert
    // note when the viewer has no quota — the same string the tile's tooltip
    // and its tap toast use, so the explanation is reachable from the
    // widget's own affordance rather than only by tapping it.
    if (key === 'create' && window.Home && typeof Home.canCreate === 'function' && !Home.canCreate()) {
      items.push({
        label: Home.CREATE_DISABLED_HINT || 'Ask an admin to enable app creation for your account.',
        disabled: true,
      });
    }
    // Discover is the shell's only door to the app directory — it has no
    // Hide row at all (and the server refuses the write besides).
    if (HomePanels.isRemovable(key)) {
      items.push({
        label: 'Hide widget',
        destructive: true,
        handler: () => { HomePanels.setHidden(key, true); },
      });
    }
    return items;
  },

  // The kit's ADAPTIVE menu: a bottom action sheet on touch, an anchored
  // popover on desktop, from one call site with no platform branching.
  // PlatformUI.menu is the repo's wrapper for it (platform-ui.js) and is
  // preferred; unNative.menu is the direct fallback for a page that loads the
  // kit without the wrapper.
  _menuApi() {
    const pui = window.PlatformUI;
    if (pui && typeof pui.menu === 'function') return (o) => pui.menu(o);
    const un = window.unNative;
    if (un && typeof un.menu === 'function') return (o) => un.menu(o);
    return null;
  },

  openMenu(key, anchorEl) {
    if (!key) return Promise.resolve(null);
    const present = HomePanels._menuApi();
    // No kit at all (the legacy/no-JS-kit path): send the press where the
    // widget's own primary row goes rather than swallowing it. Hiding stays
    // reachable in Settings.
    if (!present) {
      if (key === 'challenges') HomePanels.goToChallenges();
      else if (key === 'discover') location.hash = '#apps';
      return Promise.resolve(null);
    }
    return present({
      anchorEl,
      title: HomePanels.titleFor(key),
      items: HomePanels.menuItems(key),
    });
  },

  // Grow the block past its height cap in place, showing every challenge
  // including the organiser-finished ones; the same control collapses it.
  // Expanding needs a refetch because the collapsed payload is filtered
  // server-side (finished challenges never left the database), so the
  // toggle paints the state it can immediately and fills in when the
  // wider list lands.
  async toggleExpanded(key) {
    if (!key) return false;
    const next = !HomePanels._expanded[key];
    HomePanels._expanded[key] = next;
    HomePanels.render();
    try {
      await HomePanels.ensureLoaded({ force: true });
      return true;
    } catch (err) {
      // A failed refetch leaves the rows as they were rather than emptying
      // the block; the toggle can simply be pressed again.
      return false;
    }
  },

  // NOTE: setPosition() is gone. A widget's place on the home screen is a
  // real (column, row) cell now, written for the whole grid at once through
  // PUT /api/home-layout — see HomeLayout + Home._persistLayout in home.js.

  // Per-user show/hide. Optimistic: the block disappears immediately and
  // comes back if the write fails.
  //
  // Discover refuses to hide (the server 400s it too): its footer is the
  // shell's only door to the app directory. Create hides like any other
  // widget REGARDLESS of app quota — the widget is on every home screen,
  // so removing it must be equally available to everyone.
  async setHidden(key, hidden) {
    if (!key) return false;
    if (hidden && !HomePanels.isRemovable(key)) return false;
    const prev = HomePanels._data;
    if (prev) {
      HomePanels._data = {
        ...prev,
        hidden: hidden
          ? Array.from(new Set([...(prev.hidden || []), key]))
          : (prev.hidden || []).filter((k) => k !== key),
        panels: hidden
          ? (prev.panels || []).filter((p) => p.key !== key)
          : (prev.panels || []),
      };
      HomePanels.render();
    }
    try {
      const res = await fetch(`/api/home-panels/${encodeURIComponent(key)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ hidden: !!hidden }),
      });
      if (!res.ok) throw new Error('save failed');
      // Un-hiding needs the payload rebuilt — it was never fetched, or was
      // filtered out of the cache above.
      if (!hidden) await HomePanels.ensureLoaded({ force: true });
      // Showing/hiding a widget changes which items the grid places, so the
      // layout has to be re-derived (and re-persisted) around it. Home owns
      // that; a missing Home just means the next load picks it up.
      if (window.Home && typeof Home.load === 'function') Home.load();
      return true;
    } catch (err) {
      HomePanels._data = prev;
      HomePanels.render();
      return false;
    }
  },
};

// Still published as a global. This module rides in the React bundle as of
// #1083 chunk F step 4, but home.js's grid renderer, the Settings screen's
// "Home screen widgets" rows and the server-side PANEL_REGISTRY's client
// counterpart all reach it by name, and its own nine `window.Home` /
// `window.HomeLayout` reads are the mirror of that arrangement. The guard is for
// the SSG prerender pass — frontend/scripts/build-shell.mjs evaluates the
// island's whole module graph in Node, where there is no window.
if (typeof window !== 'undefined') window.HomePanels = HomePanels;
