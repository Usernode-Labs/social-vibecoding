/**
 * The home screen — `#home-screen`, the launcher grid a signed-in viewer lands
 * on (#1083 chunk F, step 4; the last of the chunk's four regions).
 *
 * ── What the island owns ───────────────────────────────────────────────
 *
 * The screen's STRUCTURE, and nothing else: the pull-to-reveal search bar, the
 * `.home-column` body, and the three hosts inside it — the iOS widget strip, the
 * launcher grid `#app-list`, and the `#home-panels` fallback stack. Every one of
 * those is an innerHTML host that `home.js` / `home-panels.js` fill, exactly as
 * before. This component renders once and never again: it holds no state, and
 * the only effect it runs is the visibility subscription below.
 *
 * That is deliberate rather than incidental. Two things depend on it:
 *
 *   * **The search input keeps its focus and caret.** `Home.render()` replaces
 *     `#app-list`'s innerHTML on every WS app event and every keystroke, so the
 *     input has always had to live OUTSIDE the grid — that is why the bar is the
 *     scroller's first child and not part of it. Rendering it from React would
 *     regress the same thing in a new way if the island ever re-rendered, so it
 *     doesn't: `#home-search-input` is emitted once at hydration and no React
 *     update ever touches it again.
 *   * **Drag-to-rearrange stays with PlatformUI and the native kit.** The
 *     gesture, its grid overlay, the drop-cell maths and the layout write all
 *     stay in `home.js`, driving `#app-list`'s own children. React never
 *     reconciles inside that subtree, so a drag cannot race a render.
 *
 * ── Why nothing here is stateful ───────────────────────────────────────
 *
 * The stateful-island rule (AGENTS.md): a region may hold state only when its
 * whole subtree is React-owned. Every dynamic part of this screen is written by
 * a `public/js`-era module, so the whole screen is static markup plus legacy
 * hosts. Making the grid stateful would mean moving the layout engine, the drag
 * gesture, the widget renderers and the WS fan-out inside React at once — a
 * rewrite, not this chunk's conversion.
 *
 * `data-revealed` on the search bar and `hidden` on the two `<section>`s are
 * written by `home.js` at runtime through `classList` / `dataset`, which is safe
 * for exactly the reason `frontend/src/lib/legacy-dom.ts` documents: React
 * renders their `className` once, as a constant prop, and never writes the
 * attribute again.
 *
 * ── Visibility ─────────────────────────────────────────────────────────
 *
 * `#home-screen` is the first converted root that ships VISIBLE, so
 * `shippedVisible` is `true` here where every other island passes `false`. The
 * matching read-side change is in `App._isScreenVisible` (public/js/app.js),
 * which now falls back to the DOM for a converted screen nobody has published
 * yet — see the comment there.
 *
 * ── Prerender parity ───────────────────────────────────────────────────
 *
 * The initial render is byte-for-byte the markup the hand-written shell shipped:
 * an empty widget strip, an empty grid, an empty panels section, and no `hidden`
 * on the root. Nothing fetches from render — `Home.load()` is still called by
 * app.js's router.
 */

import { useRef } from 'react';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';

// The three modules that fill this screen, imported in the order their
// <script> tags had: HomeLayout (pure geometry) is read by both of the others,
// and home-panels.js is read by home.js's grid renderer. Each still publishes
// its global for the classic half — see the note at the bottom of each file.
import './home-layout.js';
import './home-panels.js';
import './home.js';

export function HomeScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'home-screen', true);

  return (
    <main ref={screenRef} id="home-screen" className="flex-1 overflow-y-auto" style={{ position: 'relative' }}>
      {/*
          Hidden-until-pulled search bar (iOS idiom). Deliberately the FIRST
          child of the scroller and NOT sticky: it occupies real scroll space
          above the content, so Home._searchReveal can park the scroller at
          scrollTop = <bar height> and a slight pull down (a scroll up on
          desktop) slides it into view. Keep pulling once it is fully shown
          and the kit's pull-to-refresh takes over — attachPullToRefresh only
          engages from scrollTop 0, so the two stages compose with no extra
          gesture code.
          Still OUTSIDE #app-list: Home.render() wholesale-replaces the
          grid's innerHTML on every WS app event and every keystroke, and the
          input must keep its focus/caret through those re-renders. Wired
          once by Home._wireSearch().
      */}
      <div id="home-search-bar" data-revealed="false" className="bg-white dark:bg-zinc-950">
        {/*
            The bar's BACKGROUND stays full-bleed; only its content sits in
            the 1024px column, and the px-3 gutter lives here (not on the
            bar) so this column's content edges match #home-body's exactly.
        */}
        <div className="home-column px-3 pt-3 pb-2">
          <div className="relative max-w-xl">
            <svg
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              id="home-search-input"
              type="text"
              autoComplete="off"
              placeholder="Search your apps…"
              aria-label="Search your apps"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            />
            <button
              id="home-search-clear"
              className="hidden absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none"
              title="Clear search"
              aria-label="Clear search"
            >
              &times;
            </button>
          </div>
        </div>
      </div>
      {/*
          .home-body-fill (app.css) makes this a min-height:100% flex column:
          the min-height guarantees the scroller can always be scrolled by at
          least the search bar's height, even with an empty "Your apps" — a
          short page would otherwise leave the bar permanently on screen.
          (It used to do double duty as the flex context for
          .home-bottom-anchor on the two trailing sections; those are widgets
          in the grid now, so nothing below the grid is anchored any more.)
      */}
      <div id="home-body" className="home-column home-body-fill">
        {/*
            iOS in-app only: the "Usernode widget" editing strip, mirroring
            the pinned grid the homescreen widget renders. It lives ABOVE the
            launcher grid rather than inside it — a full-width flow item
            cannot coexist with the explicit cell placement #app-list now
            uses. Filled + wired by Home.renderWidgetSection /
            _wireWidgetStrip; empty everywhere but the iOS app.
        */}
        <section id="home-widget-strip-section" className="hidden px-3 pt-2">
        </section>
        {/*
            THE LAUNCHER GRID. Every child is placed at an explicit
            (column, row) cell by Home.render() — app tiles and widgets
            alike — so a viewer's arrangement can have holes in it, exactly
            like a phone home screen. Nothing here flows.

            4 columns on a phone, 5 from `sm` (640px) up, and never more:
            the canvas is capped at 5 x 8. That 640px boundary is mirrored
            in HomeLayout.BREAKPOINT_PX (features/home/home-layout.js) — the
            JS has to lay out against the same column count the CSS renders,
            and tests/home-layout-model.test.js pins the pair.

            Tighter gutters and gaps below `sm` than the old 2-column grid
            had: four 56px icons only read as a home screen at phone
            density. `grid-auto-rows` and `position: relative` (needed by
            the drag-time grid overlay) live in app.css.
        */}
        <div id="app-list" className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 sm:gap-2 p-2 pt-1.5 sm:p-3 sm:pt-2">
        </div>
        {/*
            Home-screen widgets (#911) — the FALLBACK host.

            Widgets normally live IN the launcher grid above, each at its own
            (column, row) cell: home.js plants a `[data-panel-slot]` host per
            widget for HomePanels.render() to paint into. This section is
            where they go when there is no grid to ride in — an active search
            (a transient view with no layout to place against), and the moment
            before the first grid paint. Without it a widget would vanish
            whenever the grid did.

            Deliberately OUTSIDE #app-list, like the search bar above: the
            grid's innerHTML is replaced on every WS app event and every
            search keystroke, which would otherwise destroy these blocks and
            their listeners.

            HomePanels fills it with a STACK of sibling bordered
            <article class="home-panel"> blocks — one per widget, each
            carrying its own title bar and ⋮ menu. The blocks are plain
            FULL-WIDTH children: .home-column on #home-body bounds and centres
            the feed, so don't wrap them in a per-box width bound (see
            app.css .home-column).

            NOTE "panel" ≠ the "Usernode widget" strip above the grid — that
            is the iOS home-screen widget's pinned app list.
        */}
        <section id="home-panels" className="hidden px-3 pb-3">
        </section>
        {/*
            NOTE: #home-find-more ("Featured apps" + its "Browse all apps"
            footer) and #home-create-section ("Create an app") used to sit
            here as fixed, unmovable trailing sections below the grid. Both
            are WIDGETS in the grid above now — `discover` and `create` — so
            they can be placed anywhere the viewer likes, alongside their app
            tiles, instead of being pinned under everything. See
            PANEL_REGISTRY in src/routes/home-panels.js and the renderers
            (renderDiscoverPanel / renderCreatePanel) in
            features/home/home-panels.js.
        */}
      </div>
    </main>
  );
}
