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
import { AdminScreen } from './features/admin';
import { BrowseScreen } from './features/apps/browse-screen';
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
import { SettingsScreen } from './features/settings';
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
          by the drawer's "Platform version" row (which turns into a
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
          A React island since #1083 chunk F — the markup and the module that
          fills it both live in frontend/src/features/apps/. Still mounted by
          App.navigateToBrowse, which now shows it through the visibility store.
      */}
      <BrowseScreen />
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
          icon). Hash route #admin[/section]; mounted by
          App.navigateToAdminConsole, which gates on App.user.isAdmin (both
          full and view-only admins) — every /api/admin/* endpoint the page
          calls is independently enforced server-side. The two `public`
          sections (#admin/status, #admin/node) also mount for a signed-in
          non-admin; see the PUBLIC MODE note in features/admin/admin-console.js.

          An island since #1082 chunk E: the chassis markup, the full-width
          column, the view-only banner and the temporary-password dialog are
          React's; the nineteen sections' contents still belong to the ten
          modules the island imports (the retired public/js/admin-*.js). Ships
          hidden like its sibling screens, but through the visibility store —
          #admin-screen is in App.REACT_SCREEN_IDS.
      */}
      <AdminScreen />
      <SettingsScreen />
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
          dev-chat.js, home.js, leaderboard.js and (from inside the React
          bundle) features/apps/browse.js, so it loads ahead of the whole
          bundle.
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
          The admin console's ten modules used to load here as classic
          scripts, between topochain-challenges.js and build-log.js:
          admin-console.js, admin-topochain.js, and the eight folded-in
          section modules from #860 (status / node / analytics / estimator /
          merges / gallery / campaigns / mail). #1082 chunk E moved all ten
          into the React bundle, imported by the #admin-screen island
          (frontend/src/features/admin/index.tsx), so they now arrive with
          /shell/assets/shell.js instead.

          They moved TOGETHER because they were one load-order cluster: the
          nine section modules read the AdminUI class-string registry that
          admin-console.js defines, and admin-topochain.js reads it while its
          own module body evaluates. Inside the bundle that is an ordinary
          `import`, so the dependency is declared in code rather than implied
          by the order of these tags.

          NOT moved: topochain-event-context.js / topochain-leaderboard.js /
          topochain-challenges.js above, and public/js/topochain-events.js —
          those serve the public Leaderboard screen, not the console.
      */}
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
          /js/browse.js used to load here, after home.js, because it reached
          the shared card markup through `window.Home`. #1083 chunk F moved it
          into the bundle (features/apps/browse.js, imported by the
          #browse-screen island) and split that markup out as
          features/apps/app-card.js, which home.js now delegates to. Load
          order stopped mattering for the pair: the bundle is a module script,
          so it evaluates after every classic script here, and the two
          remaining `window.Home` reads are inside methods that only run once
          a viewer opens #apps.
      */}
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
