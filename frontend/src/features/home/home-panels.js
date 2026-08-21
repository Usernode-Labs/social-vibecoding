// Home-screen sections (issue #911) — the three blocks stacked under the
// launcher grid. THE UI OVERHAUL fixed their order and their hosts:
//
//   discover   — the admin-curated featured tiles, the Popular lane, and
//                "Browse all apps". The shell's ONLY door to the app
//                directory, which is why it cannot be hidden.
//   challenges — the season's open challenges with the viewer's progress,
//                and under them the LEADERBOARD standings preview. That
//                preview is where the standings live on the home screen now
//                that the hamburger's Leaderboard row is gone.
//   create     — the create-an-app block. On EVERY home screen, for every
//                account: an account with no app quota gets the same block,
//                dimmed, explaining itself on tap (see renderCreatePanel for
//                why this is unconditional rather than conditionally shown).
//
// PLACEMENT IS GONE, and with it a whole dimension of this module. Each
// block used to be a draggable ITEM of the launcher grid — home.js planted a
// `[data-panel-slot="<key>"]` host inside #app-list at the viewer's stored
// (column, row) cell, HomeLayout carried a per-breakpoint footprint table for
// each one, and PUT /api/home-layout persisted where they had been dropped.
// They are three fixed <section> hosts in a fixed order now, outside
// #app-list, and the drag gesture belongs to app tiles alone. The hosts still
// carry `data-panel-slot="<key>"` — the attribute names WHICH block a host is
// for, which is as true of a section as it was of a grid cell, and it is what
// the dapp.json checks and the screenshot assertions select on.
//
// What that removed, in this file: `gridSlotKeys()`/`hasLayoutRegistry()`
// (the placement membership list), the `#home-panels` stacked fallback host
// (it existed only because a block inside #app-list vanished whenever
// #app-list did — a search keystroke, or the moment before the first paint),
// and the whole `inGrid` / `cols` split described below.
//
// NAMING — "panel", not "widget". home.js already owns a DIFFERENT concept
// called "widget" (Home.renderWidgetSection / #widget-strip / .widget-tile:
// the iOS home-screen widget's pinned app grid, whose UI says "Usernode
// widget"). Both render on this same screen, so everything here says
// `panel`. Nothing user-facing says either: the blocks are titled by their
// own headings.
//
// LAYOUT — each panel is its OWN bordered <article class="home-panel">, so a
// block reads as a distinct box rather than another row inside a shared card.
// The title (and the ⋮ menu) travel INSIDE each block: three blocks with
// three titles cannot share the heading-above-the-section shape "Featured
// apps" used. Blocks are plain full-width children — .home-column bounds the
// feed (see app.css; #922 removed the per-box bound).
//
// DENSITY — a section sizes to its own CONTENT. That is the shape the full
// render branch was always written for, and it is now the only one: the
// capped variants (`inGrid: true`, the phone one-cell branch with its
// two-row budget and its footer-less title bar) were concessions to a fixed
// rectangle of the launcher canvas and went with the placement. What
// survives is the four-row budget itself — a ~26px title bar, up to FOUR
// 40px single-line rows, a ~27px footer — because it is a good density for
// a home-screen block, and the leaderboard fill that spends whatever the
// challenge rows leave (see fillSlots). Overflow is still handled by
// rendering fewer rows plus the footer's expand toggle — never an inner
// scroller (a nested scroll region inside the page scroller is a touch trap)
// and never a horizontal pager (invisible to the screenshot capture and to
// dapp.json checks, which can only navigate).
//
// THE LEADERBOARD FILL is the standings preview under the challenge rows:
// the top few rows of the same board the Leaderboard screen's primary tab
// shows — the Topochain standings — plus the viewer's own row when they have
// one. The server sends it as `panel.leaderboard`, already carrying its
// `kind` ('topochain', or 'kudos' for the fallback board a deployment with
// no public standings falls back to), its `label` and the `you` flags;
// src/services/topochain/event-standings.js and
// src/services/leaderboard-users.js are the one copy of each board's
// ordering. See fillSlots below for the row budget.
//
// FETCH DISCIPLINE. Home.load() is called from a dozen WS/event paths, so
// this module must NOT fetch per Home.load(): ensureLoaded() is TTL-guarded
// and de-duped on an in-flight promise, while render() is pure paint from
// the cache. The three section hosts are static markup the home island
// renders once (frontend/src/features/home/index.tsx) and they live OUTSIDE
// #app-list, so Home.render()'s wholesale innerHTML rewrite of the grid
// never destroys them — and React never reconciles over what this module
// paints into them, because the island renders each host empty and leaves it
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

  // ── The row budget ─────────────────────────────────────────────────
  //
  // How many challenge rows the block draws before the footer takes over
  // with "See all N". The server returns at most this many challenges
  // (CHALLENGE_ROW_LIMIT, kept in step with it).
  //
  // It used to be a per-breakpoint pair — four here, and a PHONE_ROW_SLOTS of
  // two for the single grid cell the block owned below 640px (#968). A fixed
  // section has no cell to fit into, so there is one budget at every width,
  // and the phone half went with the placement. Four survives as a PREVIEW
  // cap; the footer's "See all N challenges" is the way past it.
  ROW_SLOTS: 4,

  // ── The leaderboard fill's budget ──────────────────────────────────
  //
  // THIS USED TO BE THE LEFTOVER, and that was right while the block was a
  // fixed 2x2 tile among app icons: something had to spend the rectangle the
  // challenge rows didn't, so `fillSlots(n) = 4 - max(n, 1)` handed the
  // remainder to the standings — 3 rows at zero or one challenge, 0 at four.
  //
  // A section has no rectangle to spend, and THE UI OVERHAUL made this
  // preview the POINT of the area rather than its packing material: the
  // hamburger's Leaderboard row is gone, so these rows are how the home
  // screen shows the standings at all. Leftover-sizing meant a season with
  // four open challenges — the ordinary case, since the server sends at most
  // four — showed none of them, which is the one outcome the move was
  // supposed to prevent.
  //
  // So it is a CONSTANT now: the head of the board plus the viewer's own row
  // (see renderFillBlock, which spends the last slot on them when they are
  // not already in the head). That is what a standings preview is at any
  // size.
  FILL_SLOTS: 3,

  fillSlots() {
    return HomePanels.FILL_SLOTS;
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

  // How many rows to draw. Collapsed spends the budget on at most `slots`
  // rows (ROW_SLOTS unless a caller says otherwise); the overflow affordance
  // is the footer's expand toggle, so it costs no row slot of its own (it
  // used to take the fourth).
  // Expanded draws everything the server sent and the CSS cap lifts.
  //
  // `collapsed` forced the un-expanded rendering for the phone branch, whose
  // one-cell footprint could not grow (#968). Nothing forces it now — the
  // section grows with its content — but it stays honoured so the option is
  // still the way to render a preview of a block somebody has expanded.
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
  // Home._dragActive: these sections are outside #app-list, so painting them
  // mid-drag can't yank a card out from under the pointer.
  //
  // ── One host per section, in a fixed order ─────────────────────────
  //
  // This used to paint into TWO shapes: `[data-panel-slot="<key>"]` hosts
  // that Home.render() planted inside #app-list at each widget's stored
  // (column, row) cell, and a standalone #home-panels stack below the grid as
  // the fallback for views with no grid to ride in (an active search, or a
  // grid that had not painted yet).
  //
  // THE UI OVERHAUL retired the placement, so both shapes collapse into one:
  // three fixed section hosts, rendered in a fixed order, that no search
  // keystroke or grid re-render can take away. The fallback existed only
  // because a widget inside #app-list vanished whenever #app-list did.
  SECTION_HOSTS: {
    discover: 'home-discover-section',
    challenges: 'home-challenges-section',
    create: 'home-create-section',
  },

  render() {
    // Signed out draws NOTHING — every block here is me-scoped (your
    // challenge progress, the apps you don't have yet, your app quota), and
    // the guard used to live in renderAll(), the one entry point there was.
    const signedIn = !!(window.App && App.user);
    for (const [key, hostId] of Object.entries(HomePanels.SECTION_HOSTS)) {
      const host = document.getElementById(hostId);
      if (!host) continue;
      const panel = signedIn ? HomePanels.panelFor(key) : null;
      const html = panel ? HomePanels.renderPanel(panel) : '';
      host.innerHTML = html;
      host.classList.toggle('hidden', !html);
      HomePanels._stampState(host);
      if (html) HomePanels._wire(host);
    }
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

  // `hasLayoutRegistry()` and `gridSlotKeys()` lived here: the list of widgets
  // HomeLayout should place for this viewer, and the flag that told home.js
  // the authoritative footprints had arrived so a derived layout was safe to
  // persist. Both went with the placement — the three sections are in the
  // markup at fixed positions now, so nothing has to be placed and nothing
  // has to wait for a registry to know where it goes.

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

  // `renderAll()` — one article per visible panel, joined into a stack —
  // lived here for the #home-panels fallback host. Both went together: the
  // three sections have hosts of their own and render() paints each one
  // directly, so nothing needs the blocks as one string any more.

  // Dispatch on panel key. An unknown key renders nothing rather than
  // throwing, so a server that ships a new panel before the client knows
  // it degrades to "not shown" instead of a blank home screen.
  renderPanel(panel) {
    if (!panel) return '';
    if (panel.key === 'challenges') return HomePanels.renderChallengesPanel(panel);
    if (panel.key === 'discover') return HomePanels.renderDiscoverPanel(panel);
    if (panel.key === 'create') return HomePanels.renderCreatePanel(panel);
    return '';
  },

  // The bordered block: title bar, rows list, optional footer. `flex-none`
  // on the bar/footer and .home-panel-rows on the list are what make the CSS
  // cap clip rather than grow (app.css --home-panel-max-h);
  // `.home-panel--expanded` lifts the cap entirely.
  //
  // THE TITLE BAR WAS THE DRAG HANDLE, and is not one any more. The whole bar
  // was the grab surface of a grid item — no ⠿ grip, a grab cursor from
  // app.css, a "Drag to move this widget" tooltip — and the ⋮ menu was
  // deliberately excluded from it (see _wire, which used to stop the button's
  // pointerdown before the grid's recognizer could see it). THE UI OVERHAUL
  // fixed the blocks into sections, so all three went: a bar that says it can
  // be dragged and cannot is worse than one that says nothing.
  //
  // `stamps` carries extra per-panel state onto the article. Two shapes ride
  // through here: the challenges block's `{ attrs }` (a pre-built
  // `data-rows`/`data-fill` string — a COMPOSITION change, and one that is
  // invisible to a CSS selector, so the dapp.json checks and the screenshot
  // assertions need something to hold on to), and Discover's plain
  // `{ name: value }` bag (its two lane counts, which _stampState mirrors
  // onto the section host so one selector can ask for the host AND the
  // state).
  _panelShell(key, titleHtml, bodyHtml, footerHtml, stamps) {
    const esc = HomePanels.esc;
    const expanded = !!HomePanels._expanded[key];
    const extra = (stamps && typeof stamps.attrs === 'string')
      ? ` ${stamps.attrs}`
      : Object.entries(stamps || {})
        .map(([name, value]) => ` ${name}="${esc(value)}"`).join('');
    return `
      <article class="home-panel home-panel-card${expanded ? ' home-panel--expanded' : ''} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden" data-panel="${esc(key)}"${extra}>
        <div class="home-panel-bar flex-none flex items-center gap-2 px-2.5 py-1 border-b border-zinc-200 dark:border-zinc-800">
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
  // It renders in EVERY branch and at EVERY width, for Discover's reason: a
  // discovery path that depends on there being content to discover is not a
  // path. Between seasons — the empty branch, which draws no footer — it is
  // the block's only control.
  //
  // The label used to shorten to "Leaderboard" in the compact phone shape,
  // where it sat beside a title already reading "CHALLENGES · 1 of 6" in one
  // grid cell. A section's bar has room for the full label at every width.
  _leaderboardLink() {
    return `
      <button type="button" class="home-panel-lb-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-600 dark:text-violet-400 hover:underline whitespace-nowrap"
        title="Open the Leaderboard screen" aria-label="Open leaderboard">
        <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-7.322c.983.143 1.954.317 2.916.52a6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"/></svg>
        <span class="whitespace-nowrap">Open leaderboard</span>
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

  // THE PHONE SHAPE (#968) IS GONE. It existed because the widget owned ONE
  // grid cell below five columns — two rows, the way out in the title bar, no
  // footer, never expanded — and every one of those was a concession to a
  // 116px rectangle. THE UI OVERHAUL made this a fixed SECTION that sizes to
  // its own content, so there is no cell to fit into and the full shape is
  // right at every width. The `opts`/`inGrid`/`cols` triple that chose between
  // them went with it; the four-row budget below is now simply THE budget.
  renderChallengesPanel(panel) {
    const esc = HomePanels.esc;
    const total = Number(panel.total) || 0;
    const title = esc(panel.title || 'Challenges');
    const expanded = !!HomePanels._expanded[panel.key];
    // THE LEADERBOARD FILL — the standings preview under the challenge rows.
    // It used to be a desktop-tile affordance: something had to spend the
    // fixed 2x2 rectangle, and the standings were the best thing to spend it
    // on. THE UI OVERHAUL made it the point. The hamburger's Leaderboard row
    // is gone and this section is where the standings live on the home screen
    // now, so the fill draws at every width. Only an EXPANDED challenge list
    // suppresses it: that state exists to show every row the season has, and
    // a standings preview under thirty challenges is not a preview.
    const canFill = !expanded;
    // `data-rows` / `data-fill` describe the block's COMPOSITION — how many
    // challenge rows it drew and how many leaderboard rows the fill spent the
    // rest on. A height is invisible to a CSS selector, so the dapp.json
    // checks and the screenshot assertions need something to hold on to.
    //
    // The `home-panel--fit` class that rode alongside them is gone: it was the
    // hook for the phone-only release from the grid slot's stretch-to-fill,
    // and a section has nothing to be released from.
    const rowsOf = (n, fillRows) => ({
      attrs: `data-rows="${n}" data-fill="${fillRows}"`,
    });

    // Nothing open. The block STAYS — for everyone, admins included — and
    // says why: a block that silently vanishes between seasons leaves the
    // viewer with no way to tell "nothing is running" from "this broke".
    // That line leads and the LEADERBOARD fill takes the rest, which between
    // seasons is the only thing this area has to show.
    if (!total || !Array.isArray(panel.challenges) || !panel.challenges.length) {
      // A payload that came back empty can't be expanded — and leaving the
      // flag set would keep ?expand=challenges on every later fetch, asking
      // for a finished-challenge list that would repopulate the block.
      if (HomePanels._expanded[panel.key]) HomePanels._expanded[panel.key] = false;
      const fillHtml = canFill
        ? HomePanels.renderFillBlock(panel.leaderboard, HomePanels.fillSlots())
        : '';
      const fillRows = HomePanels._countFillRows(fillHtml);
      const noteHtml = `<p class="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors" title="Go to the Challenges tab on the Leaderboard screen">No challenges are running right now</p>`;
      return HomePanels._panelShell(
        panel.key,
        // flex-1 so the ⋮ menu sits at the right edge, same as the populated
        // branch — this state is on every home screen now, so its chrome has
        // to match the one beside it. The leaderboard link rides along (#980):
        // between seasons the standings are the ONLY thing this area has to
        // point at, and this branch draws no footer at all, so the bar is
        // where the door has to be.
        `<span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}</span>${
          HomePanels._leaderboardLink()}`,
        `<div class="home-panel-body">${noteHtml}${fillHtml}</div>`,
        // Nothing to expand, nothing to count — the footer is the fill's
        // own, offering the one destination those rows point at.
        fillRows ? HomePanels._fillFooter(panel.leaderboard && panel.leaderboard.kind) : '',
        rowsOf(0, fillRows)
      );
    }

    const { rows } = HomePanels.visibleSlots(panel, { slots: HomePanels.ROW_SLOTS });
    const summary = esc(HomePanels.summaryLine(panel));
    // truncate (which carries white-space: nowrap) + an explicit nowrap on
    // the inner span: the counter must never push the title onto a second
    // line, it gets clipped with an ellipsis instead. The leaderboard link
    // sits beside it as a shrink-0 sibling, so a long summary truncates
    // rather than pushing the control off the bar.
    const titleHtml = `
      <span class="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${title}<span class="normal-case tracking-normal whitespace-nowrap"> · ${summary}</span></span>${
      HomePanels._leaderboardLink()}`;

    const rowsHtml = rows.map((c) => HomePanels.renderChallengeRow(c)).join('');
    // The meter lane is a property of the LIST, not of the row that draws
    // a bar: reserving it on every row is what keeps the goals on one
    // baseline. A panel with no numeric challenge at all reserves nothing
    // and its rows centre plainly — see app.css. The fill block sits OUTSIDE
    // this list, so leaderboard rows never inherit the lane's padding.
    const metered = rows.some((c) => HomePanels.hasMeter(c));
    const fillHtml = canFill
      ? HomePanels.renderFillBlock(panel.leaderboard, HomePanels.fillSlots())
      : '';
    const fillRows = HomePanels._countFillRows(fillHtml);

    return HomePanels._panelShell(panel.key, titleHtml,
      `<div class="home-panel-body"><div class="home-panel-rows${metered ? ' home-panel-rows--metered' : ''}">${rowsHtml}</div>${fillHtml}</div>`,
      HomePanels._panelFooter(panel.key, total, expanded),
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
  // ONE SHAPE AT EVERY WIDTH. It used to be two (#949), because the widget's
  // registry footprint was asymmetric — 4x1 on a phone, 2x2 on desktop — and
  // the content had to follow: a phone got the title bar and the featured
  // lane and nothing else, because the second lane would not fit the one row
  // it owned. THE UI OVERHAUL made Discover a fixed section, so the Popular
  // lane — the most-used apps this viewer doesn't have yet
  // (Home.popularApps) — renders everywhere. That is the point of an area
  // called Discover rather than a strip of curated tiles: the curated lane
  // alone is whatever an admin got round to featuring.
  //
  // THE BROWSE CONTROL RIDES IN THE TITLE BAR, not in a footer of its own.
  // Discover has ONE destination, so it belongs beside the title rather than
  // in 27px of chrome under two lanes. (Challenges keeps _panelFooter for its
  // expand toggle, and #980 moved its leaderboard door up to the bar for the
  // same reason this one lives there.) _wire() needs no change for this: its
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
    // The "Popular" lane was DESKTOP ONLY: it was the second row the widget
    // earned at its 2x2 desktop footprint, and there was no room for it in the
    // one cell it owned on a phone. A fixed section has room at every width, so
    // it always renders now — which is the point of the area being called
    // Discover rather than being a strip of curated tiles.
    const popular = (hasHome && typeof Home.popularApps === 'function')
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
    // The whole block is the button, and .home-create-btn is what
    // Home.wireCreateButtons() binds.
    //
    // ONE SHAPE. It used to be two: the widget's grid footprint was 4x1 below
    // 640px and 1x1 at and above it, so the content flipped on the same
    // Tailwind `sm:` breakpoint the grid did — a full-width row laid the icon
    // and label out side by side, a single cell stacked them. THE UI OVERHAUL
    // made this a full-width SECTION at every width, so the row shape is the
    // only one left; the stacked variant existed for a 150px cell that no
    // longer exists. `h-full` went with the cell too — there is no rectangle
    // to fill, so the block is as tall as its own padding.
    return `
      <div class="home-create-widget ${canCreate ? '' : 'home-create-widget--disabled'}" data-panel="${esc(panel.key)}" data-create-enabled="${canCreate}">
        <button type="button" class="home-create-btn home-create-tile w-full rounded-xl p-4 flex flex-row items-center justify-center text-center gap-3 transition-colors"
          ${canCreate ? '' : 'aria-disabled="true" '}title="${canCreate ? 'Create a new app' : esc(hint)}"
          aria-label="${canCreate ? 'Create a new app' : esc(hint)}">
          <span class="app-icon-tile app-icon-tile--empty w-14 h-14 rounded-xl flex items-center justify-center shrink-0" aria-hidden="true">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          </span>
          <span class="home-create-label text-sm leading-tight max-w-full ${canCreate ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-400 dark:text-zinc-500'}">Create app</span>
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
    // A `pointerdown` guard on every `.home-panel button` lived here: the
    // grid's reorder recognizer listened on #app-list, of which a block was
    // one item, and the event bubbles — so stopping it AT the button was what
    // kept a press on ⋮ from arming a desktop drag, or a finger resting on it
    // from tripping the kit's long-press lift. These sections are outside
    // #app-list now, so no recognizer can see any of it.

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
