// The platform shell's markup: a STATIC TREE CONTAINING STATEFUL ISLANDS.
//
// Generated once from the pre-migration public/index.html and maintained here
// by hand ever since. This file is the SOURCE OF TRUTH for the shell's markup;
// public/index.html is a committed build artifact produced from it (see
// frontend/scripts/build-shell.mjs).
//
// ── Three constraints this component must keep ─────────────────────────
//
// 1. A REGION MAY BECOME STATEFUL ONLY WHEN ITS ENTIRE SUBTREE IS
//    REACT-OWNED. This component itself has no state: it renders 57,000 lines
//    of public/js/**'s containers, and React reconciling over DOM another
//    owner writes into is the failure mode the whole migration is designed to
//    avoid. So statefulness arrives one island at a time, and only for a
//    region whose legacy module is retired in the SAME change — after which
//    no public/js/** module writes into any node inside it. Everything else
//    stays inert markup. (Step 1's rule was "this component is static
//    everywhere"; #1078 replaced it with this one.)
//
//    Two corollaries hold for every island:
//      - Its FIRST render must emit exactly the markup the hand-written shell
//        shipped — hidden regions render hidden, empty lists render empty.
//        Data loads in effects. A first render that disagrees with the
//        prerendered document is a hydration mismatch, and a console error on
//        any route fails proposal checks.
//      - It must not re-render `className` on a node public/js/** also writes
//        classes to (the native kit's modal adoption does, at runtime). Those
//        class strings are constant props and the toggles go through
//        lib/legacy-dom.ts. Screen visibility is published through
//        lib/visibility-store.ts rather than toggled from outside React.
//
// 2. IT RENDERS THE LEGACY <script> TAGS in their original order, at the end
//    of <body> — because that order is load-bearing: app.js is last, so
//    App.init() registers its DOMContentLoaded handler last and therefore runs
//    after every other module's init. Adding or retiring one means updating
//    public/sw.js's SHELL_ASSETS and tests/shell-script-order.test.js.
//
// 3. CONVERSION IS LIKE-FOR-LIKE. Component boundaries, props and state are
//    free; rendered output is not. Same ids, same class strings, same `hidden`
//    semantics, same data-*/aria-* attributes — public/js/** looks these up by
//    getElementById and dapp.json's 227 declared tests select against these
//    exact structures. tests/baselines/shell-markup.json is the frozen
//    inventory; deliberate changes are recorded in the RETIRED_*/ADDED_* maps
//    in tests/shell-id-inventory.test.js and tests/shell-script-order.test.js,
//    never by refreshing the baseline.

import { Button } from '@/components/ui/button';
import { LandingScreen } from './features/auth/landing';
import { LoginScreen } from './features/auth/login';
import { RegisterScreen } from './features/auth/register';
import { WaitingScreen } from './features/auth/waiting';
import { WaitlistScreen } from './features/auth/waitlist';
import { MoreScreen } from './features/auth/more';
import { DevConsolePanel } from './features/dev-console';
import { HeaderMenu } from './features/header/header-menu';
import { PlatformHeader } from './features/header/platform-header';
import { NotificationsPanel } from './features/notifications';
import { WorkDrawerPanel } from './features/work-drawer';
import { Dialogs } from './features/dialogs';
import { OfflineBanner, ViewAsNonAdminBanner } from './features/shell/banners';

export function Shell() {
  return (
    <>
      {/*
          Top bar — a React island since #1079 chunk B. The markup and every
          layout note that came with it now live in
          features/header/platform-header.tsx, alongside the port of the
          retired public/js/header-layout.js that measures it.
      */}
      <PlatformHeader />
      {/*
          Offline indicator (#487) — a React island since #1078. Shown while
          the /health connectivity probe in src/lib/offline.ts fails;
          everything on screen is the last version that loaded successfully.
          Hidden the moment the probe succeeds.
      */}
      <OfflineBanner />
      {/*
          Slide-out navigation drawer (all viewport widths — #122) — a React
          island since #1079 chunk B. Overlay dims the page; panel slides in
          from the right. Both nodes, the three native/credit modules that
          write into the panel, and the theme row live in
          features/header/header-menu.tsx; opening and closing is still
          App.HeaderMenu in app.js.
      */}
      <HeaderMenu />
      {/*
          Persistent banner shown only while an admin has flipped the
          "View as non-admin" toggle in Settings — a React island since
          #1078. Visibility is still driven entirely by the
          `is-view-as-non-admin` body class app.js sets, through app.css:
          a JS error elsewhere on the page then can't strand an admin in
          masked mode without the visible reminder.
      */}
      <ViewAsNonAdminBanner />
      {/*
          The "Platform updating… write actions are paused" banner that used
          to live here is GONE (#1015). It existed because a self-app merge
          restarted the single platform container; blue-green deploys
          (#1008) keep the live color serving until the new one is
          health-gated and cut over, so there is nothing to announce and no
          reason to pause writes. A tab running an older build is caught up
          by the drawer's "Web revision" row (which turns into a
          tappable "<sha> · reload") or by pull-to-refresh.
      */}
      {/*
          Home screen: app list. Rendered as a responsive grid of compact
          tiles — see Home.renderAppCard. The "Create new app" container
          that Home.render() appends after the tiles uses `col-span-full`
          so it spans the full grid row at every breakpoint.
          
          The whole feed lives in a 1024px-max, viewport-centred column
          (.home-column, in public/css/app.css) — applied to #home-body and,
          separately, to the search bar's inner content so the bar's
          background stays full-bleed. Horizontal gutters stay on the blocks
          inside it, so narrow screens are unaffected.
      */}
      <main id="home-screen" className="flex-1 overflow-y-auto" style={{ position: "relative" }}>
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
              in HomeLayout.BREAKPOINT_PX (public/js/home-layout.js) — the JS
              has to lay out against the same column count the CSS renders,
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
              public/js/home-panels.js.
          */}
        </div>
      </main>
      {/*
          Browse-all-apps screen (#apps). Sibling of #home-screen: every app
          this viewer may see, featured first, with per-tile add/remove badges.
          Owned by public/js/browse.js; mounted by App.navigateToBrowse.
      */}
      <main
        id="browse-screen"
        className="hidden flex-1 overflow-y-auto platform-safe-scroll"
        style={{ position: "relative" }}
      >
        <div id="browse-search-bar" className="sticky top-0 z-20 px-3 pt-3 pb-2 bg-white dark:bg-zinc-950">
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
              id="browse-search-input"
              type="text"
              autoComplete="off"
              placeholder="Search all apps…"
              aria-label="Search all apps"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            />
            <button
              id="browse-search-clear"
              className="hidden absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-500/10 text-base leading-none"
              title="Clear search"
              aria-label="Clear search"
            >
              &times;
            </button>
          </div>
        </div>
        {/*
            Level 1: the app-store list. ONE row markup, two layouts, and the
            switch is pure CSS — no matchMedia, no re-render on resize.
            Narrow: a hairline-divided vertical list of full-width rows (the
            App Store idiom). md and up: a 2/3-column grid whose rows pick up
            a bordered-box treatment from .browse-row in app.css.
        */}
        <div id="browse-list-level">
          {/*
              Grid only. Every border — the phone hairline AND the desktop box —
              is .browse-row in app.css; a divide-* utility here would win the
              cascade against it and strip the boxes' top/bottom edges.
          */}
          <div id="browse-list" className="md:grid md:grid-cols-2 lg:grid-cols-3 md:gap-3 md:p-3">
          </div>
          <div id="browse-empty" className="hidden px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400">
          </div>
        </div>
        {/*
            Level 2: the per-app detail page (#apps/<slug>). Absorbs what the
            browse rows' "…" menu used to offer — see Browse._renderDetail.
        */}
        <div id="browse-detail" className="hidden max-w-2xl mx-auto p-4">
        </div>
      </main>
      {/*
          Leaderboard screen (hidden by default): the one place the group's
          shared progress lives — the Topochain standings, the Kudos
          leaderboard and the season's challenges, as a three-tab strip.
          Hash routes #leaderboard (the STANDINGS — the primary tab, labelled
          simply "Leaderboard"), #leaderboard/[prs|users|history|users/<name>]
          (Kudos) and #leaderboard/challenges.
          The legacy #topochain/leaderboard and #leaderboard/topochain hashes
          alias onto the standings tab and self-heal to the bare
          #leaderboard; #challenges and #topochain/seasons alias onto the
          challenges tab. Mounted by App.navigateToLeaderboard.
          
          Three panes, one visible at a time, each owned by its own module:
          #topochain-leaderboard-root by public/js/topochain-leaderboard.js
          (the DEFAULT pane, so it and the event bar are the two that ship
          visible), #leaderboard-root by public/js/leaderboard.js (the Kudos
          pane — that module also renders the tab strip and owns
          Leaderboard.section), and #challenges-root by
          public/js/topochain-challenges.js. The two Topochain-domain panes
          share one event selection, rendered into #leaderboard-event-bar by
          public/js/topochain-event-context.js and hidden while the Kudos tab
          is active.
          
          The wrapper is max-w-5xl for the Topochain table's sake; the Kudos
          pane keeps its narrower max-w-3xl reading column.
      */}
      <main
        id="leaderboard-screen"
        className="hidden flex-1 overflow-y-auto platform-safe-scroll"
        style={{ position: "relative" }}
      >
        <div className="max-w-5xl mx-auto p-4 w-full">
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-3">
            Leaderboard
          </h2>
          <div id="standings-tabs" className="flex gap-2 border-b border-zinc-200 dark:border-zinc-800 mb-4">
          </div>
          <div id="leaderboard-event-bar" className="w-full mb-4">
          </div>
          <div id="leaderboard-root" className="hidden max-w-3xl">
          </div>
          <div id="topochain-leaderboard-root" className="w-full">
          </div>
          <div id="challenges-root" className="hidden w-full">
          </div>
        </div>
      </main>
      {/*
          The Challenges screen used to be its own <main> here
          (#challenges-screen, app-as-SV-chrome migration), rendered by the
          now-deleted public/js/challenges.js. It is the third tab of the
          Leaderboard screen above: #challenges-root lives inside
          #leaderboard-screen and public/js/topochain-challenges.js renders
          the merged (public grid + your own contributions) view into it.
          The legacy #challenges hash still works — the router replaceStates
          it to #leaderboard/challenges.
      */}
      {/*
          Profile screen (profile-and-settings-to-web migration): the mobile
          app's native Profile screen rendered by public/js/profile.js from
          the in-process /challenges-api/me/* routes, scoped to the signed-in
          platform session server-side (the bridge's getProfileInfo
          participant id is no longer consulted). Hash route #profile;
          mounted by App.navigateToProfile.
      */}
      <main
        id="profile-screen"
        className="hidden flex-1 overflow-y-auto platform-safe-scroll"
        style={{ position: "relative" }}
      >
        <div id="profile-root" className="max-w-3xl mx-auto p-4">
        </div>
      </main>
      {/*
          Admin & moderation console screen (#818, extended by #860): the
          full-page console behind the header shield icon (#588 shipped the
          icon), rendered by public/js/admin-console.js plus one module per
          heavy section (admin-status / admin-node / admin-analytics /
          admin-merges / admin-gallery / admin-campaigns / admin-topochain).
          Hash route #admin[/section]; mounted by App.navigateToAdminConsole,
          which gates on App.user.isAdmin (both full and view-only admins) —
          every /api/admin/* endpoint the page calls is independently enforced
          server-side. The two `public` sections (#admin/status, #admin/node)
          also mount for a signed-in non-admin; see the PUBLIC MODE note in
          admin-console.js. Ships hidden like its sibling screens.
          
          FULL WIDTH (no max-w / mx-auto, unlike every other screen): this is a
          dense operator console, not a reading surface. The folded-in Health &
          status and Analytics sections were always the widest thing in the app
          — a 6-across tile grid, wide SVG charts, and user/limit/code tables
          that were horizontally scrolling inside a capped column — so the
          constraint cost information rather than protecting legibility. The
          gutter stays modest (p-4, a little roomier from lg up) and everything
          inside is percentage/grid-based, so mobile is byte-for-byte
          unchanged.
      */}
      <main
        id="admin-screen"
        className="hidden flex-1 overflow-y-auto platform-safe-scroll"
        style={{ position: "relative" }}
      >
        <div id="admin-root" className="w-full p-4 lg:px-6">
        </div>
      </main>
      {/*
          Settings screen (#settings hash route). Was a modal overlay
          (#settings-modal) until it was converted into a real screen laid
          out like the Admin & moderation console: a grouped sidebar on md+,
          a two-level menu -> section hierarchy below it. Rendered by
          public/js/settings.js; mounted by App.navigateToSettings. Ships
          hidden like its sibling screens.
          
          MOVE, DON'T REWRITE: every section below is the modal markup
          verbatim, only re-parented into a [data-settings-section] wrapper
          (and with the stacked-column divider classes dropped, since each
          section now renders alone). settings.js binds every control by id
          ONCE at DOMContentLoaded, so the nodes must stay in the document
          and must never be innerHTML-rebuilt — the router only toggles
          `hidden` on the WRAPPERS, leaving each section's own `hidden`
          (wallet / usernode / admin-preview capability gates) untouched.
          Only #settings-nav-desktop and #settings-mobile-menu-host are ever
          innerHTML-rendered.
          
          max-w-5xl (not the admin console's 7xl): every section here is a
          form column, none is a wide chart grid.
      */}
      <main
        id="settings-screen"
        className="hidden flex-1 overflow-y-auto platform-safe-scroll"
        style={{ position: "relative" }}
      >
        <div id="settings-root" className="max-w-5xl mx-auto p-4 w-full">
          <div className="md:flex md:items-start md:gap-6">
            {/*
                Desktop sidebar menu. Below md there is no nav here at all:
                phones get the two-level hierarchy instead (the level-1 menu
                renders into #settings-mobile-menu-host).
            */}
            <div id="settings-sidebar-col" className="hidden md:block md:w-56 shrink-0">
              <nav id="settings-nav-desktop" aria-label="Settings sections" className="space-y-1">
              </nav>
              {/*
                  Log out is pinned below the section list rather than buried
                  inside a section. On mobile it moves under the level-1 menu
                  (see Settings._renderMobileMenu).
              */}
              <div id="settings-footer" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-700">
                <button
                  id="settings-logout"
                  className="w-full rounded-lg border border-red-400 dark:border-red-700 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                >
                  Log out
                </button>
              </div>
            </div>
            <div id="settings-content-col" className="flex-1 min-w-0">
              {/*
                  Mobile level 1: the grouped section menu. Empty (and
                  md:hidden) on desktop.
              */}
              <div id="settings-mobile-menu-host" className="md:hidden">
              </div>
              {/*
                  Every section lives here permanently; the router unhides
                  exactly one wrapper (or hides the host entirely on mobile
                  level 1). max-w-xl keeps form controls from stretching the
                  full width of the wide shell.
              */}
              <div id="settings-section-content" className="pb-8 max-w-xl">
                <div data-settings-section="api-key" className="hidden">
                  <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                    Anthropic API key
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                    Bring your own Anthropic API key to keep working past the daily limit. Your platform daily allowance is used first; once it runs out, your key takes over automatically &mdash; even in the middle of a running turn &mdash; and usage bills directly to your Anthropic account.
                  </p>
                  <label
                    className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1"
                    htmlFor="settings-api-key"
                  >
                    Anthropic API key
                  </label>
                  <div
                    id="settings-key-display"
                    className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2"
                  >
                    sk-ant-…
                    <span id="settings-key-last4">
                    </span>
                  </div>
                  {/*
                      #119 — daily spend breakdown for BYOK users. Filled by
                      Settings._refreshSpend() on modal open; hidden while loading,
                      on fetch failure, or when no key is saved. Rows are ordered
                      limit-first to match the billing order (#212).
                  */}
                  <div
                    id="settings-spend"
                    className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2"
                  >
                    <div className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                      Today's spend
                    </div>
                    <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>
                        Platform daily limit
                      </span>
                      <span id="settings-spend-platform" className="font-mono">
                      </span>
                    </div>
                    <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>
                        Your key
                      </span>
                      <span id="settings-spend-byok" className="font-mono">
                      </span>
                    </div>
                    <div className="text-zinc-500 dark:text-zinc-500 mt-1">
                      Resets at midnight UTC.
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      id="settings-api-key"
                      type="password"
                      placeholder="sk-ant-..."
                      autoComplete="off"
                      spellCheck="false"
                      className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono"
                    />
                    {/*
                        THE ONE LIVE shadcn CONVERSION IN STEP 1.

                        <Button>'s default variant + default size emit
                        `rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2
                        text-sm font-medium text-white transition-colors`, so with
                        `shrink-0` passed through className this renders the exact
                        DOM node the hand-written button did — same tag, same id,
                        same class set. settings.js still finds it by
                        getElementById and binds its click.

                        It is here so that "shadcn is wired up and produces
                        byte-identical output against the platform's own palette"
                        is something the screenshot-parity gate actually TESTS,
                        rather than something this migration merely claims.
                        Every other control in this file is still raw JSX; they
                        convert one screen at a time in step 2.
                    */}
                    <Button id="settings-save" className="shrink-0">
                      Save
                    </Button>
                    <button
                      id="settings-remove"
                      className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
                    Encrypted at rest, verified against Anthropic before saving, never shown in full after save.
                The server decrypts it in memory to call Anthropic on your behalf &mdash; don't paste keys into services you don't trust with that level of access.
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener"
                      className="text-violet-500 hover:text-violet-400 underline"
                    >
                      Set tight spend limits
                    </a>
                    on the key itself for defense in depth.
                  </p>
                  <div id="settings-status" className="text-sm mt-3 hidden">
                  </div>
                </div>
                {/*
                    Hosted MCP connector: connect Claude.ai / ChatGPT so their
                    built-in coding agent (Claude Code on the web, Codex) can do
                    the work on the user's own subscription. Also holds the
                    verified GitHub account link, because that link exists only
                    to serve this flow: it is IDENTITY ONLY (no OAuth scope, no
                    stored token) and its whole job is attributing a submitted
                    pull request to the account that verified it. The fork the
                    agent pushes to is made by that agent, not by the platform.
                    Rendered by Settings._renderConnectors() /
                    _renderGithubLink() from GET /api/me/connectors and
                    GET /api/me/github (?demo=1 passthrough in staging — mcp_tokens
                    is staging:private and the link needs a real OAuth round-trip,
                    so a staging clone has neither).
                */}
                <div data-settings-section="connectors" className="hidden">
                  <div id="connectors-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Claude &amp; ChatGPT connectors
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Connect Usernode to Claude.ai or ChatGPT and you can browse apps, file requests and turn finished work into proposals from the chat you already have open &mdash; with the coding done by Claude Code or Codex on your own plan, not your Usernode daily allowance.
                    </p>
                    <label
                      className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1"
                      htmlFor="connector-url"
                    >
                      Connector URL
                    </label>
                    <div className="flex gap-2 mb-2">
                      <input
                        id="connector-url"
                        type="text"
                        readOnly={true}
                        spellCheck="false"
                        className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                      <button
                        id="connector-url-copy"
                        type="button"
                        className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
                      In Claude.ai: Settings &rarr; Connectors &rarr; Add custom connector. In ChatGPT: Settings &rarr; Connectors. Paste the URL above, then approve the connection in the browser page that opens. You can disconnect here at any time.
                    </p>
                    <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                      Connected
                    </h4>
                    <div id="connectors-list" className="space-y-2">
                    </div>
                    <div id="connectors-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                  <div id="github-link-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      GitHub account
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Linking GitHub proves which GitHub account is yours, so work built by your own coding agent can be submitted under your name. Usernode asks for
                      <strong className="font-semibold text-zinc-600 dark:text-zinc-400">
                        no access to your repositories
                      </strong>
                      &mdash; read-only public profile information only &mdash; and stores no GitHub token. Your coding agent (Claude Code or Codex) makes your fork of an app using its own GitHub connection.
                    </p>
                    <div id="github-link-body" className="space-y-2">
                    </div>
                    <div id="github-link-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="openrouter" className="hidden">
                  <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                    OpenRouter &amp; Codex
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                    Use Codex (via OpenRouter) as your coding agent, billed to your own OpenRouter API key. Your platform Claude allowance is not consumed for Codex turns (though the surrounding Mayor/wrap-up still use Claude credits). Your key is stored encrypted by the platform, is injected into the per-turn worker environment where the code running in your worker can see it, and is fully deleted when you remove it below &mdash; it is never persisted in the worker's warm environment or filesystem.
                  </p>
                  <div id="settings-openrouter-beta-gated" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400 mb-3">
                    Codex/OpenRouter is being rolled out gradually and isn't available for your account yet.
                  </div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1" htmlFor="settings-openrouter-key">
                    OpenRouter API key
                  </label>
                  <div id="settings-openrouter-key-display" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-300 mb-2">
                    sk-or-&hellip;<span id="settings-openrouter-key-last4"></span>
                  </div>
                  <div id="settings-openrouter-key-info" className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-2 text-zinc-600 dark:text-zinc-400"></div>
                  <div className="flex gap-2">
                    <input id="settings-openrouter-key" type="password" placeholder="sk-or-..." autoComplete="off" spellCheck={false} className="flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono" />
                    <button id="settings-openrouter-save" className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors">
                      Test &amp; save
                    </button>
                    <button id="settings-openrouter-remove" className="hidden shrink-0 rounded-lg border border-red-400 dark:border-red-700 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
                      Remove
                    </button>
                  </div>
                  <div id="settings-openrouter-models-wrap" className="hidden mt-4">
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1" htmlFor="settings-openrouter-model">
                      Codex model
                    </label>
                    <select id="settings-openrouter-model" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"></select>
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mt-2 mb-1" htmlFor="settings-openrouter-reasoning">
                      Reasoning effort
                    </label>
                    <select id="settings-openrouter-reasoning" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500">
                      <option value="">Default</option>
                      <option value="minimal">Minimal</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Extra high</option>
                    </select>
                    <button id="settings-openrouter-set-default" className="mt-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium transition-colors">
                      Save as my default coding agent
                    </button>
                    <button id="settings-claude-set-default" className="mt-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                      Use Claude Code as my default instead
                    </button>
                  </div>
                  <div id="settings-openrouter-status" className="text-sm mt-3 hidden"></div>
                </div>
                <div data-settings-section="app-ai" className="hidden">
                  {/*
                      App AI permissions (issue #34). Lists every app the user has
                      granted access to their daily AI budget: today's spend vs the
                      per-app cap, a cap editor, the BYOK spillover toggle, and
                      Revoke. Rendered by Settings._renderLlmGrants() on modal open
                      from GET /api/me/llm-grants (?demo=1 passthrough in staging).
                  */}
                  <div id="llm-grants-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      App AI permissions
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Apps you've allowed to use AI on your behalf. Their spend counts against your normal daily budget, plus the per-app cap you set. Revoking takes effect immediately.
                    </p>
                    <div id="llm-grants-list" className="space-y-2">
                    </div>
                    <div id="llm-grants-status" className="text-sm mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="agent-files" className="hidden">
                  {/*
                      Agent instructions & skills (issue #460). Per-user global files
                      the coding agent loads on every build/scout run this user
                      dispatches, in any app: instruction files are assembled into the
                      worker's ~/.claude/CLAUDE.md, skills land in ~/.claude/skills/.
                      Rendered by Settings._renderAgentFilesSection() on modal open
                      from GET /api/me/agent-files (?demo=1 passthrough in staging,
                      since user_agent_files is staging:private).
                  */}
                  <div id="agent-files-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Agent instructions &amp; skills
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Personal files the coding agent follows on every build or spec run you start, in any app. Markdown or plain text only, up to 10 of each kind, 48&nbsp;KB per file. Changes apply from your next run.
                    </p>
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          Instructions
                        </h4>
                        <button
                          data-agent-files-upload="instruction"
                          className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          Upload
                        </button>
                      </div>
                      <div id="agent-files-instructions-list" className="space-y-1.5">
                      </div>
                    </div>
                    <div className="mb-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          Skills
                        </h4>
                        <button
                          data-agent-files-upload="skill"
                          className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          Upload
                        </button>
                      </div>
                      <div id="agent-files-skills-list" className="space-y-1.5">
                      </div>
                    </div>
                    <input
                      id="agent-files-input"
                      type="file"
                      accept=".md,.txt,text/markdown,text/plain"
                      className="hidden"
                    />
                    {/*
                        Pending-upload form: revealed after a file is picked so the
                        user can adjust the (slugified) name and, for skills, the
                        one-line description before saving.
                    */}
                    <div
                      id="agent-files-form"
                      className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 mt-2 text-xs"
                    >
                      <div id="agent-files-form-title" className="font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                      </div>
                      <label className="block text-zinc-600 dark:text-zinc-400 mb-2">
                        Name
                        <input
                          id="agent-files-name"
                          type="text"
                          maxLength={64}
                          className="mt-1 w-full rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 font-mono text-zinc-900 dark:text-zinc-100"
                        />
                      </label>
                      <label
                        id="agent-files-desc-wrap"
                        className="block text-zinc-600 dark:text-zinc-400 mb-2 hidden"
                      >
                        Description
                        <input
                          id="agent-files-desc"
                          type="text"
                          maxLength={200}
                          placeholder="One line: what this skill does"
                          className="mt-1 w-full rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-zinc-900 dark:text-zinc-100"
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          id="agent-files-save"
                          className="rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 font-medium text-white transition-colors"
                        >
                          Save
                        </button>
                        <button
                          id="agent-files-cancel"
                          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    <div id="agent-files-status" className="text-sm mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="password" className="hidden">
                  {/*
                      Change password (issue #282). Default form calls POST
                      /api/me/password (current password required). In the Usernode
                      native app with a linked wallet, a "Use your wallet instead"
                      link switches to wallet mode (cp-wallet-mode shown, current
                      password hidden) which signs a wallet-check challenge and calls
                      POST /api/me/wallet-change-password — the way back for a
                      logged-in user who's forgotten the password they'd need to type.
                      settings.js wires the mode switch and both submit paths.
                  */}
                  <div id="change-password-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Change password
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Set a new password for web login. If an admin gave you a temporary password, enter it as your current password here.
                    </p>
                    <div className="space-y-2">
                      <div id="cp-current-row">
                        <input
                          id="cp-current"
                          type="password"
                          autoComplete="current-password"
                          placeholder="Current password"
                          className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                      </div>
                      <input
                        id="cp-new"
                        type="password"
                        autoComplete="new-password"
                        placeholder="New password (at least 8 characters)"
                        className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                      <input
                        id="cp-confirm"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirm new password"
                        className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      />
                    </div>
                    {/* Default (password) submit */}
                    <button
                      id="cp-save"
                      className="mt-2 w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                    >
                      Change password
                    </button>
                    {/* Wallet (signature) submit — shown only in wallet mode */}
                    <button
                      id="cp-wallet-save"
                      className="hidden mt-2 w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                    >
                      Sign &amp; change password
                    </button>
                    {/*
                        Mode switches. cp-wallet-mode is itself hidden unless the user
                        is in the native app with a linked wallet (settings.js).
                    */}
                    <p id="cp-wallet-mode" className="hidden text-xs text-center mt-2">
                      <a id="cp-use-wallet" href="#" className="text-violet-500 hover:text-violet-400">
                        Forgot it? Use your wallet instead
                      </a>
                    </p>
                    <p id="cp-password-mode" className="hidden text-xs text-center mt-2">
                      <a id="cp-use-password" href="#" className="text-violet-500 hover:text-violet-400">
                        Use current password instead
                      </a>
                    </p>
                    <div id="cp-status" className="text-sm mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="wallet" className="hidden">
                  {/* Wallet linking section */}
                  <div id="wallet-section" className="hidden">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Usernode Wallet
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Link your on-chain identity. Scan the QR code with the Usernode mobile app.
                    </p>
                    {/* Unlinked: show link button */}
                    <div id="wallet-unlinked" className="hidden">
                      <button
                        id="wallet-link-btn"
                        className="w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                      >
                        Link Usernode Wallet
                      </button>
                    </div>
                    {/* Linking: show QR */}
                    <div id="wallet-linking" className="hidden text-center">
                      <div id="wallet-qr-canvas" className="inline-block rounded-lg bg-white p-2">
                      </div>
                      <p id="wallet-link-timer" className="text-xs text-zinc-500 mt-2">
                      </p>
                      <button
                        id="wallet-link-cancel"
                        className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 underline"
                      >
                        Cancel
                      </button>
                    </div>
                    {/* Linked: show pubkey + unlink */}
                    <div id="wallet-linked" className="hidden">
                      <div className="flex items-center gap-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2">
                        <span className="text-xs text-emerald-500 font-bold">
                          &#x2713;
                        </span>
                        <span
                          id="wallet-pubkey-display"
                          className="text-sm font-mono text-zinc-700 dark:text-zinc-300 truncate flex-1"
                        >
                        </span>
                      </div>
                      {/*
                          Unlink intentionally hidden for now: unlinking only clears the
                          server-side pubkey (no on-chain unlink), and wallet is the
                          primary native sign-in path, so an accidental unlink is more
                          footgun than feature. The DELETE /api/me/wallet-link endpoint
                          and its (null-guarded) handler remain, so re-adding this button
                          is all that's needed to restore the option.
                      */}
                    </div>
                    <div id="wallet-status" className="text-sm mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="language" className="hidden">
                  {/*
                      Platform-level user language preference (issue #757). A single
                      per-user BCP-47 locale apps read as their default language —
                      via the iframe JWT `locale` claim and the bridge's
                      usernode.getUserLocale(). "" (Auto) = unset (NULL in the DB).
                      Saves on change; settings.js wires the handler to
                      POST /api/me/locale and pushes a live `usernode:locale-changed`
                      notification into any open app iframe.
                  */}
                  <div id="settings-language-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Language
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Apps on Usernode use this as their default language. Apps may offer their own override.
                    </p>
                    <select
                      id="settings-locale"
                      className="w-full rounded-lg bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200"
                    >
                      <option value="">
                        Auto — use device language
                      </option>
                      <option value="en">
                        English
                      </option>
                      <option value="es">
                        Español
                      </option>
                      <option value="fr">
                        Français
                      </option>
                      <option value="de">
                        Deutsch
                      </option>
                      <option value="id">
                        Bahasa Indonesia
                      </option>
                      <option value="pt-BR">
                        Português (Brasil)
                      </option>
                      <option value="it">
                        Italiano
                      </option>
                      <option value="nl">
                        Nederlands
                      </option>
                      <option value="pl">
                        Polski
                      </option>
                      <option value="tr">
                        Türkçe
                      </option>
                      <option value="ru">
                        Русский
                      </option>
                      <option value="uk">
                        Українська
                      </option>
                      <option value="ar">
                        العربية
                      </option>
                      <option value="hi">
                        हिन्दी
                      </option>
                      <option value="vi">
                        Tiếng Việt
                      </option>
                      <option value="th">
                        ไทย
                      </option>
                      <option value="ja">
                        日本語
                      </option>
                      <option value="ko">
                        한국어
                      </option>
                      <option value="zh-CN">
                        中文（简体）
                      </option>
                      <option value="zh-TW">
                        中文（繁體）
                      </option>
                    </select>
                    <div id="settings-locale-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="alerts" className="hidden">
                  {/*
                      #138: Dev-chat sound & alerts (default ON). Client-only
                      preference (localStorage key devchat_alerts_enabled); wired in
                      settings.js. Plays a chime when an AI dev-chat turn finishes
                      while you're in the app, or a system notification when it's in
                      the background.
                  */}
                  <div id="settings-alerts-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Dev-chat sound &amp; alerts
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Get a heads-up when a dev-chat AI agent finishes and is waiting for your reply.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input id="devchat-alerts-toggle" type="checkbox" className="un-switch" />
                      <span className="text-sm text-zinc-800 dark:text-zinc-200">
                        Play a sound, and notify me when the app is in the background
                      </span>
                    </label>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
                      When you're in the app a soft chime plays; when the app is backgrounded or closed you get a system notification instead. Your browser or device may ask permission to show notifications the first time.
                    </p>
                    <button
                      id="devchat-alerts-test"
                      type="button"
                      className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      Send a test alert
                    </button>
                    <p
                      id="devchat-alerts-test-status"
                      className="text-xs mt-2 hidden text-zinc-500 dark:text-zinc-400"
                    >
                    </p>

                    <div
                      id="settings-mobile-push-preferences"
                      className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
                    >
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                        Mobile push categories
                      </h3>
                      <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3 leading-relaxed">
                        Choose which Social activity can send a phone notification. Your phone&apos;s Activity notifications switch remains the master control for that device.
                      </p>
                      <div className="space-y-3">
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="direct_interactions">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Direct interactions</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Mentions and replies to your messages.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="invitations">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Invitations</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Collaboration and approver invitations, including when yours are accepted.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="shared_work">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Shared work</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Specs that someone privately shares with you.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="developer_sessions">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Developer sessions</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Interactive and unattended coding sessions that finish while you are away.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="proposal_alerts">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Proposal alerts</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Proposals needing attention, failed previews, and new proposals ready for voting.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                        <label className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category="lightweight_activity">
                          <span>
                            <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">Lightweight activity</span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Reactions and kudos on your work.</span>
                          </span>
                          <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
                        </label>
                      </div>
                      <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400">
                        Loading mobile push preferences…
                      </p>
                    </div>
                  </div>
                </div>
                <div data-settings-section="home-panels" className="hidden">
                  {/*
                      #911: which home-screen cards ("widgets" to the user,
                      panels in the code) are shown. Every registry entry is
                      on by default — users.home_panels_hidden lists only the
                      ones this viewer dismissed from the card's own ⋮ menu
                      ("Hide widget"), so an unticked box here is the way to
                      get one back. Rows are rendered by settings.js
                      _renderHomePanelsSection() from GET /api/home-panels's
                      `registry` + `hidden`.
                  */}
                  <div id="settings-home-panels-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Home screen widgets
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Cards shown on your home screen below your apps. Untick one to hide it — the same as pressing the &times; on the card itself.
                    </p>
                    <div id="settings-home-panels-list" className="space-y-2">
                    </div>
                    <p id="settings-home-panels-status" className="text-xs mt-2 hidden">
                    </p>
                  </div>
                </div>
                <div data-settings-section="cli" className="hidden">
                  {/*
                      Global CLI/coding-agent credentials. The server returns only a short token
                      hint and non-secret metadata; raw bearer values never enter the
                      browser Settings surface.
                  */}
                  <div id="cli-tokens-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      CLI &amp; coding-agent access
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Credentials approved for the Social Vibecoding CLI, Codex, or Claude Code. Revoking an active credential takes effect immediately.
                    </p>
                    <div id="cli-tokens-list" className="space-y-2">
                    </div>
                    <button
                      id="cli-tokens-more"
                      type="button"
                      className="hidden mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      Load more
                    </button>
                    <div id="cli-tokens-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="dev-console" className="hidden">
                  {/*
                      Developer console visibility. The bug-icon in the header opens
                      a slide-up log of forwarded console output and errors from
                      the running app's iframe. By default the icon stays hidden
                      until the app actually logs an error so the header doesn't
                      get cluttered for users who never need it. This toggle pins
                      it to always-visible whenever an iframe is on screen.
                  */}
                  <div id="settings-devconsole-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Developer console
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      The bug icon in the header opens a slide-up log of console output and errors forwarded from the running app.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input id="dev-console-always-show" type="checkbox" className="un-switch" />
                      <span className="text-sm text-zinc-800 dark:text-zinc-200">
                        Always show the icon
                      </span>
                    </label>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
                      When unchecked (the default), the icon only appears once the current app has logged at least one error.
                    </p>
                  </div>
                </div>
                <div data-settings-section="experimental" className="hidden">
                  {/*
                      Experimental: AI progress estimate (default OFF). When enabled,
                      a small Haiku call skims the in-flight Claude Code progress log
                      about once a minute and shows a vague "AI guess" plus a live
                      countdown next to the timer on the running line in dev-chat.
                      #892: the model is now given the MEASURED run-length
                      distribution as prompt input (llm.js RUN_LENGTH_PRIORS) rather
                      than the old "bias toward 2-10 minutes" instruction that
                      flattened its output; nothing scales its answer afterwards.
                      Server-gated per user; settings.js wires the change handler to
                      POST /api/me/ai-progress-estimate.
                  */}
                  <div id="settings-experimental-section">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Experimental
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Early features we're still testing. They may change or disappear.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input id="ai-progress-estimate" type="checkbox" className="un-switch" />
                      <span className="text-sm text-zinc-800 dark:text-zinc-200">
                        AI progress estimate
                      </span>
                    </label>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
                      While the coding agent works, a small AI model skims its progress log about once a minute and guesses how far along it is and roughly how long is left. It's calibrated against how long real runs actually take, but it's still a guess and can be wrong. Adds a tiny per-run cost (billed to your own API key if you've saved one above).
                    </p>
                    <div id="ai-progress-estimate-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                  {/*
                      #907 Local coding agent. Lives inside Experimental (not the
                      CLI section) because it is a preview of the same feature the
                      dev chat's "Run on" selector exposes, and because a lease is
                      NOT a credential: revoking a CLI token is a security action,
                      detaching a machine is a routing one. Painted by
                      settings.js _renderLocalAgentsSection() from
                      GET /api/me/local-agents; the whole block hides itself when
                      no machine has ever attached, so it costs nothing for the
                      overwhelming majority who never run the CLI.
                  */}
                  <div id="settings-local-agents-section" className="hidden mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Local coding agent
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Machines running <span className="font-mono">social-vibecoding agent run</span>. While one is attached, that session's spec and coding turns run there on your own Claude subscription instead of on Usernode. Each turn asks in your terminal before it starts; spec turns are read-only, and after a coding turn Usernode still opens the pull request, builds the preview and runs the checks. Detaching sends the next turn back to Usernode.
                    </p>
                    <div id="settings-local-agents-list" className="space-y-2">
                    </div>
                    <div id="settings-local-agents-status" className="text-xs mt-2 hidden">
                    </div>
                  </div>
                </div>
                <div data-settings-section="usernode" className="hidden">
                  {/*
                      "Usernode app" sections (profile-and-settings-to-web migration):
                      the mobile app's native App Settings absorbed into this modal.
                      Hidden unless the Usernode bridge reports the getSettingsState
                      capability; fully rendered by settings.js
                      _renderUsernodeSection() from the bridge's settings snapshot.
                      Covers device permissions, node sleep, privacy & identity,
                      diagnostics, about & legal (FAQ), and the app account.
                  */}
                  <div id="settings-usernode-section" className="hidden">
                  </div>
                </div>
                <div data-settings-section="admin-preview" className="hidden">
                  {/*
                      Admin-only: "view as non-admin" preview. Visible only when the
                      server reports the user as a real admin (settings.js gates the
                      visibility based on App._realIsAdmin). Toggling reloads the
                      page so all admin-gated UI (home retry/delete/lock buttons,
                      app-secrets editor, etc.) re-renders against the masked
                      App.user.isAdmin.
                  */}
                  <div id="settings-admin-section" className="hidden">
                    <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                      Admin preview
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3">
                      Hide admin-only UI so the app looks the way it does for a regular user. Useful for spotting UX issues that only affect non-admins.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input id="view-as-non-admin" type="checkbox" className="un-switch" />
                      <span className="text-sm text-zinc-800 dark:text-zinc-200">
                        View as non-admin
                      </span>
                    </label>
                    <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
                      Purely a client-side display toggle &mdash; your server-side admin privileges are unaffected. The page will reload so the rest of the UI picks up the change.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      {/*
          The Topochain leaderboard used to be its own <main> screen here
          (#topochain-leaderboard-screen, Task 14). The header slim-down
          merged it into the Leaderboard screen above, where it is now the
          PRIMARY (default) tab: #topochain-leaderboard-root lives inside
          #leaderboard-screen and TopochainLeaderboard renders into it
          unchanged. The legacy #topochain/leaderboard hash still works —
          the router replaceStates it to the bare #leaderboard.
      */}
      {/*
          The Topochain seasons/events screen used to be its own <main> here
          (#topochain-seasons-screen, Task 14). Its event hero moved up into
          the Leaderboard screen's shared event bar and its challenge grid
          became that screen's third tab, so the module (renamed
          public/js/topochain-challenges.js) now renders into
          #challenges-root. The legacy #topochain/seasons hash still works —
          the router replaceStates it to #leaderboard/challenges.
      */}
      {/*
          ── Anonymous shell screens (fold-auth-pages-into-SPA) ──────────
          Landing / login / register / waiting were standalone documents
          (landing.html etc.); they're now in-SPA screens rendered by
          public/js/auth-screens.js with kit push/pop transitions and hash
          routes (#landing, #login, #signup, #register, #waiting). They are
          fixed full-viewport overlays ABOVE the platform chrome (z-40 —
          under kit sheets/modals) so the anonymous shell never has to
          coordinate header/tab visibility with the authed shell.
      */}
      {/*
          Landing screen — features/auth/landing.tsx (#1080 chunk C).

          Column layout: a PERSISTENT header (Back + title + Sign in / Join
          waitlist) over a content region that holds either the directory
          scroller or the in-page app viewer. The header stays put while an
          app is open, so a visitor who likes what they just used can sign
          up without backing out first.
      */}
      <LandingScreen />
      {/*
          Login screen — features/auth/login.tsx (#1080 chunk C). Also hosts
          the #signup email-code sub-view, the forgot-password recovery
          sub-view, and the #reset-password/<token> redeem view.
      */}
      <LoginScreen />
      {/* Register screen (activation-code flow) — features/auth/register.tsx */}
      <RegisterScreen />
      {/*
          Waiting-room screen — features/auth/waiting.tsx (#1080 chunk C).
          The platform-access gate: an authed session without
          hasPlatformAccess lands here; it polls /api/auth/me and boots the
          full shell in place when access is granted.
      */}
      <WaitingScreen />
      {/*
          Stage-1 waitlist survey — features/auth/waitlist.tsx (#1080 chunk C).
          Its own screen (#waitlist), reached from the landing CTA block's link
          and the persistent header's "Join waitlist" button; it used to render
          flat inside the landing CTA block, which pushed the app directory far
          down the page. Same shape as #auth-more-screen: a corner Back link
          (data-auth-back → #landing) over a narrow scrolling column.
          Deliberately NOT a <header> element — the header centering
          measurement (features/header/use-header-layout.ts) used to resolve
          document.querySelector('header'), and a second <header> in the
          document would have hijacked it.
      */}
      <WaitlistScreen />
      {/*
          Stage-2 waitlist survey — features/auth/more.tsx (#1080 chunk C).
          "Want in sooner?" (#more/<token>, two-stage waitlist ported from the
          original topochain waitlist). All questions optional; answers merge
          server-side so the form is re-openable from the join email. GitHub / X
          verify via the /waitlist/connect OAuth round-trip when the platform
          has creds.
      */}
      <MoreScreen />
      {/*
          App view (hidden by default).
          
          The two modes (#194) — App (the running iframe) and Dev (the card
          list, rendered by AppView.renderDevView with full-screen chat /
          session / topic sub-views) — are switched from #app-mode-switch in
          the platform header. The full-width tab-bar nav that used to live
          here at the foot of this column is gone.
          
          The bottom safe-area inset is SURFACE-DEPENDENT (#970), which is
          why this element no longer carries a blanket `un-safe-bottom`.
          That class moved here from the deleted tab bar and reserved the
          home-indicator strip for EVERY surface inside #app-content —
          including the running app's iframe, which is how apps ended up
          cut off short of the screen's rounded bottom edge while the shell
          around them ran edge-to-edge.
          
          `data-app-surface` is the switch: AppView._setSurface() sets it to
          `app` wherever an app iframe / launch cover is mounted (no inset —
          the app fills the screen and receives the insets over the
          __usernode_safe_area bridge instead) and to `platform` for every
          platform-rendered surface (Dev mode, status placeholders), which
          keeps its clearance via the rule in app.css. It defaults to
          `platform` so a first paint before any render behaves as before,
          and chromeless needs no special case any more — it always lands on
          an app surface.
      */}
      <div
        id="app-view"
        className="hidden flex flex-col"
        data-app-surface="platform"
        style={{ flex: "1", minHeight: "0", height: "0" }}
      >
        <div id="app-content" className="flex-1" style={{ minHeight: "0", overflow: "hidden" }}>
          {/* Tab content renders here */}
        </div>
      </div>
      {/* Notifications dropdown (top-right anchored) — an ISLAND since #1079
          chunk B: features/notifications owns the whole subtree and
          public/js/notifications.js is retired. */}
      <NotificationsPanel />
      {/* Header-cog "your work" drawer — same chrome and position as the
          notifications panel, same story: features/work-drawer owns it and
          public/js/work-drawer.js is retired (#1079 chunk B). */}
      <WorkDrawerPanel />
      {/* Developer console (slide-up panel, anchored to bottom) — an ISLAND
          since #1079 chunk B: features/dev-console owns the whole subtree and
          public/js/dev-console.js is retired. */}
      <DevConsolePanel />
      {/* Staging preview (fullscreen overlay) */}
      <div id="staging-overlay" className="hidden fixed inset-0 z-40 bg-zinc-950 flex flex-col">
        {/*
            `staging-chrome-bar` is a STYLE HOOK, not decoration: fullscreen,
            this overlay is `inset: 0` and covers the status bar, so app.css
            adds the top safe-area inset to this bar (and only in the
            non-docked state — a docked panel is pinned mid-page and needs
            none). The bar's bottom edge needs nothing: everything below it
            is the staging iframe, which reaches the true bottom edge and
            receives the real insets over the safe-area bridge.
        */}
        <div className="staging-chrome-bar flex items-center gap-3 px-4 py-2 border-b border-zinc-800 shrink-0">
          <button id="staging-back" className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
            Back to session
          </button>
          <span className="flex-1">
          </span>
          {/*
              #127: bot-generated testing guidance. Hidden unless the session
              carries testing_md / testing_path; wired in AppView.swapToStaging.
          */}
          <button
            id="staging-test-btn"
            className="hidden text-xs font-medium px-2.5 py-1 rounded bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 shrink-0"
          >
            Test this change
          </button>
          {/*
              #771: docked-mode toggle. In the docked side panel it reads
              "Full screen" (expand to today's fullscreen overlay); in
              fullscreen — when the preview was opened from dev chat and can
              re-dock — it reads "Exit full screen". Same element, same
              iframe: toggling never reloads the preview. Wired in
              AppView._updateStagingModeUi.
          */}
          <button
            id="staging-fullscreen-btn"
            className="hidden text-xs font-medium px-2.5 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 shrink-0"
          >
            Full screen
          </button>
          <span id="staging-url-label" className="text-xs text-zinc-500 font-mono truncate">
          </span>
          {/*
              Mirror of the main dev-console button. The overlay covers the
              global header (z-40), so the original button is obscured —
              we surface a duplicate inside the overlay's own chrome and
              delegate its click to DevConsole.toggle().
          */}
          <button
            id="staging-dev-console-btn"
            className="relative text-zinc-400 hover:text-zinc-200"
            aria-label="Open developer console"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 9l3 3-3 3m5 0h3M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z"
              />
            </svg>
            <span
              id="staging-dev-console-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
            >
            </span>
          </button>
          {/*
              #771: close button for the docked side panel. CSS shows it only
              in docked mode (where "Back to session" is hidden — closing the
              panel IS going back to the session, which never left).
          */}
          <button
            id="staging-dock-close"
            className="staging-dock-only text-zinc-400 hover:text-zinc-100 text-lg leading-none px-1 shrink-0"
            aria-label="Close preview"
          >
            &times;
          </button>
        </div>
        {/*
            Explains why this change isn't live yet — a common point of
            confusion the first time someone previews their own PR.
        */}
        <div className="px-4 py-1.5 bg-violet-500/10 border-b border-violet-500/20 text-xs text-zinc-400 shrink-0">
          Private preview — only you can see this until the app's users vote your change in.
        </div>
        <div className="relative flex-1">
          <iframe
            id="staging-iframe"
            className="absolute inset-0 w-full h-full border-0"
            style={{ background: "#08080f" }}
            allow="pointer-lock"
          >
          </iframe>
          {/*
              #127: collapsible "How to test" panel overlaying the top of the
              preview. Hidden until requested via the "Test this change" button
              (auto-shown only for that explicit entry path, #237). Content is
              bot-authored markdown rendered through the escaping markdown
              pipeline in AppView._renderTestingControls.
          */}
          <div
            id="staging-testing-panel"
            className="hidden absolute top-2 left-2 right-2 sm:left-auto sm:w-96 z-10 rounded-lg border border-violet-500/30 bg-zinc-900/95 backdrop-blur shadow-xl"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <span className="text-xs font-semibold text-violet-300">
                How to test
              </span>
              <span className="flex-1">
              </span>
              <button
                id="staging-testing-close"
                className="text-zinc-500 hover:text-zinc-200 text-sm leading-none px-1"
                aria-label="Dismiss testing instructions"
              >
                &times;
              </button>
            </div>
            <div
              id="staging-testing-content"
              className="px-3 py-2 text-xs text-zinc-300 leading-relaxed max-h-48 overflow-y-auto"
            >
            </div>
          </div>
          {/*
              Spinner shown over the iframe while a preview is being opened, so
              the load never reads as a black void. app-view.js owns the copy:
              a neutral "Opening preview…" while ensure-staging is asked,
              "Loading the preview…" across the iframe's own render, the
              rebuild estimate ONLY when a rebuild is genuinely running, and a
              waiting state when the host hasn't answered yet. The defaults
              below are neutral on purpose (#816) — a first paint before JS
              sets the text must not promise a wait that isn't happening.
          */}
          <div
            id="staging-loader"
            className="hidden absolute inset-0 flex flex-col items-center justify-center gap-4 bg-zinc-950 text-center px-6"
          >
            <div className="w-9 h-9 border-2 border-zinc-700 border-t-violet-400 rounded-full animate-spin">
            </div>
            <div id="staging-loader-title" className="text-sm text-zinc-200 font-medium">
              Opening preview…
            </div>
            <div id="staging-loader-sub" className="text-xs text-zinc-500 max-w-xs leading-relaxed">
            </div>
          </div>
        </div>
      </div>
      {/*
          #353: before/after comparison (fullscreen overlay). Opened by
          clicking either tile rendered by AppView.visualsTilesHtml — shows
          the before + after for one capture group side-by-side at full size
          (stacked on narrow screens), instead of dumping the raw asset into
          a new tab. Built dynamically by AppView.openVisualComparison;
          closed via Back / backdrop / Escape (closeVisualComparison).
      */}
      <div
        id="visual-compare-overlay"
        className="hidden fixed inset-0 z-50 bg-zinc-950/95 flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Before / after comparison"
      >
        <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 shrink-0">
          <button
            id="visual-compare-back"
            className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
            Close
          </button>
          <span className="flex-1">
          </span>
          <span id="visual-compare-label" className="text-xs text-zinc-400 font-mono truncate">
          </span>
        </div>
        <div id="visual-compare-body" className="usn-compare-body flex-1 overflow-auto p-4">
        </div>
      </div>
      {/*
          Every dialog in the shell (#1078 chunk A). One component per modal
          root, rendered in the same order they were spelled out here — see
          features/dialogs/index.tsx.
      */}
      <Dialogs />
      {/*
          PlatformUI — the platform's single wrapper over the native kit
          (toasts, alerts, confirms, sheets). Loaded FIRST in the bundle:
          every other platform script calls PlatformUI, never unNative.
      */}
      {/*
          NavLink (#1036) — the "navigation controls behave like real links"
          seam (cmd/ctrl-click, middle-click and shift-click open a new tab).
          No dependencies of its own and consumed by app.js, app-view.js,
          browse.js, dev-chat.js, home.js and leaderboard.js, so it loads
          ahead of the whole bundle.
      */}
      <script src="/js/nav-link.js" />
      <script src="/js/platform-ui.js" />
      {/*
          /js/offline.js used to load here. #1078 retired it: the banner it
          owned is a React island (features/shell/banners.tsx), the
          connectivity engine is src/lib/offline.ts and still installs
          `window.Offline` before DOMContentLoaded, and service-worker
          registration is src/lib/service-worker.ts. Both are imported by
          main.tsx, which runs after every script below.
      */}
      {/*
          App-as-SV-chrome (NATIVE-BRIDGE.md): the shared capability probe.
          node-pill.js and wallet-sheet.js used to load here, right after it,
          because both consume NativeChrome.has; they are in the React bundle
          now (features/header/), which is deferred and therefore still runs
          after this tag. header-layout.js was retired here too — it is
          features/header/use-header-layout.ts. All of them no-op outside the
          Usernode app webview.
      */}
      <script src="/js/native-chrome.js" />
      <script src="/js/dev-host.js" />
      {/*
          #138: dev-chat completion alerts (chime + OS notification). Loaded
          before dev-chat.js, which references DevAlerts. The notifications
          module is in the React bundle now (#1079 chunk B) and runs later
          still, so it sees DevAlerts too.
      */}
      <script src="/js/dev-alerts.js" />
      <script src="/js/social-push.js" />
      {/*
          Webview-safe replacement for window.confirm(). Loaded before any
          feature script that wants a "really?" gate (dev-chat archive,
          future settings/home destructive actions).
      */}
      <script src="/js/confirm-modal.js" />
      {/*
          The six build venues — the single list behind every "where should
          this be built?" surface. Pure data + copy + presentation; it reads
          nothing and fetches nothing. credit-options.js, session-options.js,
          dev-chat.js and app-view.js all read window.BuildVenues, so it must
          load before all four.
      */}
      <script src="/js/build-venues.js" />
      {/*
          Shared "you're out of daily AI credits — here's how to keep building"
          copy + destinations, used by the dev-chat card, the credits banner and
          the Generate-proposal modal. Loaded before its three consumers.
      */}
      <script src="/js/credit-options.js" />
      {/*
          #1049: the "how do you want to build this?" picker and its guided
          Claude Code / Codex walkthrough. Pure render + wire, no fetching —
          dev-chat.js owns the state and must load AFTER it.
      */}
      <script src="/js/dev-flow-select.js" />
      {/*
          #1055: the "session and billing options" menu behind the ⋯ beside
          the dev-chat credit meter. Pure copy + gating + presentation;
          dev-chat.js owns the state and must load AFTER it.
      */}
      <script src="/js/session-options.js" />
      <script src="/js/settings.js" />
      <script src="/js/group-chat.js" />
      {/*
          Pure two-half spec splitter (#196). Must load BEFORE dev-chat.js,
          whose spec viewer calls window.splitSpecSections.
      */}
      <script src="/js/spec-sections.js" />
      {/*
          Read-only renderer for a SHARED dev-chat transcript. Pure string
          builder; app-view.js's topic page calls SessionTranscript.renderHtml.
          Load order is unconstrained relative to dev-chat.js — it looks up
          DevChat.renderMarkdown at CALL time (and falls back to escaped text
          if it's missing), not at load time.
      */}
      <script src="/js/session-transcript.js" />
      {/*
          Pure progress-indicator helpers (#50). Must load BEFORE dev-chat.js,
          whose elapsed ticker / live-activity summary call formatElapsed and
          summarizeCcProgress.
      */}
      <script src="/js/cc-progress-summary.js" />
      {/*
          Pure streaming/holdback helpers. Must load BEFORE dev-chat.js, whose
          live assistant bubble and spec-preview snippet call
          renderStreamingHtml / clipSpecSnippet to stop the task-checkbox
          flicker while output streams.
      */}
      <script src="/js/streaming-markdown.js" />
      {/*
          #405: canonical merge-lifecycle helper (window.MergeStatus). Loaded
          before dev-chat.js / app-view.js / home.js so all three derive and
          label proposal merge states from one place.
      */}
      <script src="/js/merge-status.js" />
      <script src="/js/dev-chat.js" />
      {/*
          Kudos widget (button + budget badge) and leaderboard screen.
          Loaded BEFORE app-view.js so the panel renderer can use
          Kudos.renderButton directly.
      */}
      <script src="/js/kudos.js" />
      {/*
          /js/ai-credit.js used to load here, alongside kudos.js above: same
          status-pane slot pattern, same poll-then-render shape. #1079 chunk B
          moved it into the React bundle with the drawer rows it renders into
          (features/header/ai-credit.js). App.init still calls
          AiCredit.Budget.init() on the same authed-boot tick.
      */}
      <script src="/js/leaderboard.js" />
      {/*
          Shared "which event should this screen open on?" rule, consumed by
          the event-context module and both Topochain-domain panes. Must load
          before /js/topochain-event-context.js.
      */}
      <script src="/js/topochain-events.js" />
      {/*
          Profile screen (#profile hash route — profile-and-settings-to-web
          migration). Loaded before app.js, whose restoreFromHash calls
          App.navigateToProfile → Profile.open().
      */}
      <script src="/js/profile.js" />
      {/*
          Admin & moderation console (#admin hash route, #818). Loaded before
          app.js, whose restoreFromHash calls App.navigateToAdminConsole →
          AdminConsole.open().
      */}
      <script src="/js/admin-console.js" />
      {/*
          Topochain-domain panes of the Leaderboard screen (Task 14, public
          screens; merged into one screen by the leaderboard merge). The
          Leaderboard module mounts these lazily when their tab is first
          shown — #leaderboard -> TopochainLeaderboard.open() (the default
          tab, so this one mounts on the screen's first open),
          #leaderboard/challenges -> TopochainChallenges.open() — and both
          read the event selection from TopochainEventContext, which owns
          the shared picker + hero. Loaded before app.js.
      */}
      <script src="/js/topochain-event-context.js" />
      <script src="/js/topochain-leaderboard.js" />
      <script src="/js/topochain-challenges.js" />
      {/*
          Seasons, Events & Challenges admin console screens (Task 15): the
          'seasons' entry in AdminConsole.SECTION_MODULES delegates to
          AdminTopochain.render(), which owns its own sub-nav under
          #admin/seasons/<sub> (the old #admin/topochain/<sub> address still
          resolves and is rewritten to the canonical one). The file name and
          the AdminTopochain global are historical — renaming them would
          churn the service-worker precache list for no user-visible gain.
          Loaded after admin-console.js (which it extends) and before app.js.
      */}
      <script src="/js/admin-topochain.js" />
      {/*
          Folded-in admin console sections (#860): the seven standalone pages
          (/status, /node-status, /dashboard, /debug, /gallery, /admin,
          /admin-features) are now sections here, one module each. Same
          contract as admin-topochain.js — AdminConsole.SECTION_MODULES maps a
          section key to the global these define, and calls render(host) /
          destroy(host) on it. Load order is unconstrained: the console
          resolves each module by name at section-render time (AdminGallery
          likewise looks up AppView, loaded below, only when it renders).
      */}
      <script src="/js/admin-status.js" />
      <script src="/js/admin-node.js" />
      <script src="/js/admin-analytics.js" />
      {/*
          Estimator accuracy (#898): the platform-analytics card split out of
          the Analytics section into its own #admin/estimator section.
      */}
      <script src="/js/admin-estimator.js" />
      <script src="/js/admin-merges.js" />
      <script src="/js/admin-gallery.js" />
      <script src="/js/admin-campaigns.js" />
      <script src="/js/admin-mail.js" />
      {/*
          Build-failure log panel (#416). Loaded before app-view.js/home.js
          so both surfaces can reference window.BuildLog.
      */}
      <script src="/js/build-log.js" />
      <script src="/js/app-view.js" />
      <script src="/js/app-secrets.js" />
      {/*
          Drag-to-select screenshot capture for the feedback modal (#683).
          Loaded before app.js so the modal wiring can gate the attach
          button on ScreenshotSelect.isSupported().
      */}
      <script src="/js/screenshot-select.js" />
      {/*
          Home-screen panels (#911): the Challenges card between the launcher
          grid and "Featured apps". Loaded BEFORE home.js, whose load() /
          render() call into HomePanels.
      */}
      {/*
          Grid geometry (pure functions over the layout model) before the two
          modules that lay out against it.
      */}
      <script src="/js/home-layout.js" />
      <script src="/js/home-panels.js" />
      <script src="/js/home.js" />
      {/*
          Browse-all-apps screen (#apps). After home.js: it reuses
          Home.renderAppCard / Home.isYours / Home.matchesQuery so the two
          launcher grids can't drift apart.
      */}
      <script src="/js/browse.js" />
      {/*
          Anonymous shell screens (fold-auth-pages-into-SPA): landing /
          login / register / waiting logic. Must load before app.js so
          window.AuthScreens exists when App.init routes the boot.
      */}
      <script src="/js/auth-screens.js" />
      <script src="/js/app.js" />
    </>
  );
}
