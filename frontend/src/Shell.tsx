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
import { Dialogs } from './features/dialogs';
import { OfflineBanner, ViewAsNonAdminBanner } from './features/shell/banners';

export function Shell() {
  return (
    <>
      {/*
          Top bar.
          Layout note: the title is *absolutely* positioned at the geometric
          center of the header (left:50%, translate-x:-50%) rather than living
          between two flex spacers. The flex-spacer approach drifted the title
          leftward as right-side icons accumulated, because the spacers split
          only the space *not* consumed by content — so an unbalanced left/right
          made the title's center point unbalanced too. Absolute positioning
          decouples the title from the flow entirely, so left and right groups
          can grow independently without ever moving it. `pointer-events-none`
          prevents the (potentially overlapping) title from blocking icon
          clicks; `truncate` + max-width keeps long app names from running
          into the right-side group.
      */}
      {/*
          Two-mode header: title is *viewport-centered* when there's room
          for it without overlapping the back-btn area or the variable-width
          right group, otherwise it falls back to *flex-flow* (left-aligned,
          truncating from the right). The mode switch is driven by
          public/js/header-layout.js, which observes header / right-group /
          title size changes and toggles `.is-centered` accordingly.
          
          Layout invariants:
          - The back-btn wrapper is always 20px wide (`w-5 shrink-0`) so
          toggling the button's `hidden` class doesn't collapse the
          leftmost column and shift the title.
          - The right group has `ml-auto` so when the title goes absolute
          (centered mode) and is removed from flex flow, the right group
          still sits at the right edge instead of collapsing next to the
          back-btn.
          - The title's default state is flow mode (left-aligned). JS
          upgrades to centered after measurement, so first paint is safe
          even if the JS is slow to run.
          
          HEADER HEIGHT INVARIANT (see the matching block in
          public/css/app.css): this bar is `py-3` + a 1px hairline around a
          28px content row, so it is 53px + safe-area on EVERY screen. The
          row height must not depend on which children happen to be
          present — the `h-7` on the back-btn wrapper below is the floor
          (it survives #header-title being display:none in the native
          WebView), and no direct child may exceed 28px (the ceiling).
      */}
      <header
        id="platform-header"
        className="un-safe-top-extend relative flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0"
      >
        {/*
            20px wide (never changes — header-layout.js measures this as the
            title's left side group), 28px tall (the header's content-row
            floor), with the 20px icon centred inside it.
        */}
        <div className="w-5 h-7 shrink-0 flex items-center">
          {/*
              #1036: a real anchor, not a button, so cmd/ctrl-click,
              middle-click and right-click → "Open in new tab" work on it.
              Its href is maintained by App.setBackIcon(mode, href) — the
              single choke point every screen entry already goes through
              (App._showOnlyScreen). `inline-flex items-center` keeps the
              20px icon centred: an <a> is `inline` where a <button> was
              `inline-block`, and while this element is a flex item today
              (so it is blockified anyway) the 28px header content-row floor
              is load-bearing enough not to leave to that. No target=_blank:
              in the native WebView that would push a plain tap out to the
              system browser.
          */}
          <a id="back-btn" className="inline-flex items-center text-zinc-400 hover:text-zinc-100 hidden" aria-label="Home">
            <svg id="back-icon-home" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"
              />
            </svg>
            <svg
              id="back-icon-arrow"
              className="w-5 h-5 hidden"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
          </a>
        </div>
        <h1
          id="header-title"
          className={"flex-1 min-w-0 text-lg font-bold pointer-events-none truncate\n               text-left"}
        >
          dApps
        </h1>
        <div className="ml-auto shrink-0 flex items-center">
          {/*
              HEADER SLIM-DOWN: the fork label, the platform + app build pills
              and the kudos-budget badge used to live here as four inline
              slots. They are rows of the slide-out drawer now — same element
              ids, same renderers, just a new parent: the kudos + AI-credit
              meters in its status pane (#drawer-status-pane), the two build
              lines + fork label in its bottom-anchored footer
              (#drawer-footer). The trophy (#leaderboard-btn) became
              #drawer-row-leaderboard and the admin shield
              (#admin-dashboard-btn) became #drawer-row-admin.
              
              What's left here is navigation + alerting only, in DOM order:
              dev console, feedback, work cog, bell, hamburger (last).
          */}
          {/*
              Node status + wallet (native app chrome absorbed into SV,
              NATIVE-BRIDGE.md) live as rows in the slide-out drawer below —
              never here in the header. See #drawer-row-node /
              #drawer-row-wallet, populated by public/js/node-pill.js /
              wallet-sheet.js when the Usernode bridge reports the matching
              capability.
          */}
          {/*
              App/Dev mode switch — replaced the full-width bottom tab bar
              that used to sit at the foot of #app-view. It MUST
              stay inside this right-group div: public/js/header-layout.js
              resolves the title's side groups as previousElementSibling /
              nextElementSibling, so a sibling wedged between the <h1> and
              this div would silently break the centering measurement.
              
              Visibility is owned by App.DrawerStatus.setAppOpen() — shown
              only while an app is open, and never for the self-hosted
              platform row (whose App mode has no iframe target).
              
              `h-7` is load-bearing, not decoration: this control is the only
              thing that appears in the header when an app opens, so its
              height IS the header's height there. It used to be sized by its
              segments' `py-1` (24px) plus `p-0.5` (4px) plus its 1px border
              top and bottom = 30px, which quietly made the in-app header 2px
              taller than every other screen's. Pinned to the header's 28px
              content row instead; the segments stretch to fill it
              (`items-stretch` + `flex items-center` on each, no vertical
              padding of their own) so the tap area still spans the track and
              the labels stay centred. Keep it 28px — the header's height and
              the `top-14` anchoring of #notifications-panel /
              #work-drawer-panel both depend on it.
          */}
          <div
            id="app-mode-switch"
            role="radiogroup"
            aria-label="App mode"
            className="hidden relative flex items-stretch h-7 p-0.5 mr-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
          >
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-tab="app"
              className="app-mode-seg flex items-center rounded-md px-2.5 transition-colors"
            >
              App
            </button>
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-tab="dev"
              className="app-mode-seg flex items-center rounded-md px-2.5 transition-colors"
            >
              Dev
            </button>
          </div>
          <button
            id="dev-console-btn"
            className="hidden relative text-zinc-400 hover:text-zinc-200 mr-2"
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
              id="dev-console-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
            >
            </span>
          </button>
          {/*
              App secrets used to live as a header icon here; it's been moved
              into the dev-chat tab's "Edit" section (see AppView.renderDevChatTab).
              The badge it used to show now lives on the in-tab button.
          */}
          <button id="feedback-btn" className="text-zinc-400 hover:text-zinc-200 mr-2" aria-label="Send feedback">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </button>
          {/*
              Header cog: the "your work" drawer (public/js/work-drawer.js) —
              the viewer's sessions & proposals plus their session-related
              notifications, rerouted out of the bell. The icon spins (CSS
              class work-cog-spinning) while an AI turn or a merge-pipeline
              step is in flight for the viewer. Carries the green badge that
              used to sit on the bell (same #notifications-badge-ai id — it's
              still painted by Notifications._renderBadge).
              
              The badge is positioned IDENTICALLY to the bell's
              #notifications-badge below — same top-right corner, same size,
              same pill geometry — so the two read as one badge convention
              rather than two. Only the colour differs (emerald = your work in
              flight, red = unread notifications). It sat at -bottom-1 until
              the header slim-down; keep the two class lists in sync.
          */}
          <button
            id="work-drawer-btn"
            className="relative text-zinc-400 hover:text-zinc-200 mr-2"
            aria-label="Your sessions and proposals"
            title="Your sessions and proposals"
          >
            <svg
              id="work-drawer-icon"
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span
              id="notifications-badge-ai"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-emerald-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
            >
            </span>
          </button>
          <button
            id="notifications-btn"
            className="relative text-zinc-400 hover:text-zinc-200 mr-2"
            aria-label="Notifications"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            <span
              id="notifications-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
            >
            </span>
          </button>
          {/*
              Hamburger: LAST in the group at every width — it's the catch-all
              menu now (build status, kudos, standings, admin, theme), so the
              rightmost slot is the conventional home for it.
              
              #header-menu-deploy-dot is the amber "something is building"
              cue: the drawer's status-pane pills are the only place a deploy
              state renders now, so the dot is what tells you to look in
              there. Toggled by App.DrawerStatus.refreshDeployDot().
          */}
          <button
            id="header-menu-btn"
            className="relative text-zinc-400 hover:text-zinc-200 mr-2"
            aria-label="Open menu"
            aria-expanded="false"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span
              id="header-menu-deploy-dot"
              className="hidden absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500"
              aria-hidden="true"
            >
            </span>
          </button>
          {/*
              The "Create new app" entry point used to live here in the header
              as a "+" pill; it's been moved into the home-screen feed itself,
              rendered below the app list (and as the empty-state CTA when no
              apps exist). See public/js/home.js.
          */}
        </div>
      </header>
      {/*
          Offline indicator (#487) — a React island since #1078. Shown while
          the /health connectivity probe in src/lib/offline.ts fails;
          everything on screen is the last version that loaded successfully.
          Hidden the moment the probe succeeds.
      */}
      <OfflineBanner />
      {/*
          Slide-out navigation drawer (all viewport widths — #122).
          Overlay dims the page; panel slides in from the right. Both are
          controlled by HeaderMenu.open() / HeaderMenu.close() in app.js.
          On touch the panel below is ADOPTED into a kit side drawer
          (unNative.presentPanel — drag-to-dismiss), which supplies its own
          backdrop; the overlay here and the CSS transform transition are
          the desktop / kit-missing path.
      */}
      <div id="header-menu-overlay" className="hidden fixed inset-0 z-40 bg-black/40" aria-hidden="true">
      </div>
      <div
        id="header-menu-panel"
        role="dialog"
        aria-label="Navigation menu"
        className={"fixed top-0 right-0 bottom-0 z-50 w-60 max-w-[85vw] flex flex-col\n              bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-700\n              shadow-2xl header-menu-panel-transition"}
      >
        {/* Panel header with close button */}
        <div className="flex items-center justify-end px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <button id="header-menu-close" className="text-zinc-400 hover:text-zinc-200" aria-label="Close menu">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/*
            Panel body — ONE scroller, laid out as a COLUMN FLEX so the
            footer block at its end can be bottom-anchored with `mt-auto`:
            when the rows above are short the free space collects above the
            footer and it hugs the bottom of the panel; when they overflow
            (a short viewport) there is no free space and the footer simply
            sits at the end of the scroll. One rule, both behaviours, no
            measurement. On touch the panel fills a full-height kit side
            drawer (.platform-panel-adopted), so the footer sits at the
            bottom of the screen there too.
            
            The theme selector and the status pane are first in DOM order
            rather than pinned outside the scroller: pinning blocks above
            the list would leave a short viewport almost no room for the
            navigation rows. Being first means they're on screen the moment
            the drawer opens at any realistic viewport.
        */}
        <div id="header-menu-rows" className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          <div id="drawer-main-rows" className="shrink-0">
            {/*
                Theme — Light / Dark / System, the FIRST thing in the menu.
                Unlike every row below it this is a live control, not a
                navigation action: a non-clickable container (no hover bg) whose
                only interactive descendants are the three segment buttons, and
                tapping a mode does NOT close the drawer.
                
                Deliberately compact — text-xs faces on a py-1 track — so the
                control reads as a setting rather than a banner and costs the
                rows below it as little height as possible.
                
                Wired in App.HeaderMenu (app.js); active segment + caret position
                are driven from Theme.get() via _renderThemeButtons(). All the
                persistence lives in public/js/theme.js and is untouched by the
                segmented restyle.
            */}
            <div
              id="drawer-row-theme"
              className="px-4 pt-2 pb-2.5 border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300"
            >
              <div className="flex items-center gap-3 mb-1.5">
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
                <span className="text-xs font-medium">
                  Theme
                </span>
              </div>
              {/*
                  Segmented track + caret. The caret is positioned purely in CSS
                  from the --theme-caret-index custom property (0|1|2) that
                  _renderThemeButtons sets on the track: a thirds-width element
                  translated by index * 100%. Deliberately NOT measured in JS —
                  _renderThemeButtons runs before PlatformUI.sheet resizes the
                  panel from w-60 to the sheet's full width, so any pixel read
                  at that moment would be wrong. Percentages are right at both.
              */}
              <div
                id="drawer-theme-track"
                role="radiogroup"
                aria-label="Theme"
                className="relative flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-xs font-medium"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked="false"
                  data-theme-mode="light"
                  className="theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors"
                >
                  Light
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked="false"
                  data-theme-mode="dark"
                  className="theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors"
                >
                  Dark
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked="false"
                  data-theme-mode="system"
                  className="theme-seg flex-1 basis-0 rounded-md px-1.5 py-1 transition-colors"
                >
                  System
                </button>
                <span id="drawer-theme-caret-track" aria-hidden="true">
                  <span id="drawer-theme-caret">
                  </span>
                </span>
              </div>
            </div>
            {/*
                Status pane: the viewer's remaining weekly kudos and their daily
                AI credit. Every <span> below is the SAME element (same id) that
                used to sit in the header, so Kudos.Budget._render /
                AiCredit.Budget._render keep resolving their slot by
                getElementById with no change.
                
                The build/version rows moved OUT of this pane and into
                #drawer-footer at the bottom of the panel (they're reference
                information, not something you act on), where they render as
                plain text rather than pills. Their slot ids are unchanged.
                
                The rows are plain <div>s, never <a>/<button>: the values render
                their own anchor/button where one is warranted, and nesting
                those inside a clickable row would be invalid markup.
            */}
            <div id="drawer-status-pane" className="border-b border-zinc-100 dark:border-zinc-800">
              <div
                id="drawer-row-kudos"
                className="flex items-center gap-3 px-4 min-h-[44px] text-zinc-600 dark:text-zinc-300"
              >
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"
                  />
                </svg>
                <span className="text-sm font-medium">
                  Kudos
                </span>
                <span id="kudos-budget-slot" className="ml-auto inline-flex min-w-0">
                </span>
              </div>
              {/*
                  AI credit (#555): the viewer's own daily LLM-spend allowance,
                  used vs. remaining. Shown to EVERY signed-in user — the first
                  place in the product that tells you where you stand before a
                  turn is refused with "Daily limit reached".
                  
                  Ships hidden and is revealed by AiCredit.Budget once
                  /api/me/ai-budget answers, so a signed-out visitor (or someone
                  still in the waiting room) never sees an empty row. Carries no
                  global spend or global cap: those are admin-only, per
                  services/status.js redact().
              */}
              <div
                id="drawer-row-ai-budget"
                className="hidden flex flex-wrap items-center gap-3 px-4 py-1 min-h-[44px] text-zinc-600 dark:text-zinc-300"
              >
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                <span className="text-sm font-medium">
                  AI credit
                </span>
                {/*
                    `grow text-right` (rather than the plain `ml-auto inline-flex`
                    the other value slots use) is what keeps this value hard against
                    the panel's right edge in BOTH of its layouts. `ml-auto` alone
                    only right-aligns it while it shares the line with the label;
                    the figure is usually too wide for the 15rem panel, so the
                    row's `flex-wrap` drops it to its own line — where an
                    auto-width item sits flush LEFT under the icon. Growing to fill
                    that line and right-aligning the text inside means the wrapped
                    value ends where the label's value would have, and the two
                    halves of a `·`-broken figure stack right-aligned under each
                    other.
                */}
                <span id="ai-budget-slot" className="ml-auto grow min-w-0 text-right">
                </span>
              </div>
              {/*
                  An "Anthropic credits" row (the ORGANISATION's remaining
                  Anthropic balance) used to sit here for admins. It was removed:
                  Anthropic publishes no credit balance, so the figure had to be
                  recorded by hand and the row read "Not set up" indefinitely.
                  The balance now lives only in the admin console's Spend limits
                  section (see AdminConsole.renderLimitsSection) — the
                  /api/admin/anthropic-credits endpoints are unchanged.
              */}
            </div>
            {/*
                Node status + Wallet: native app chrome absorbed into SV
                (app-as-SV-chrome migration, NATIVE-BRIDGE.md). Hidden unless the
                Usernode bridge reports the matching capability — populated and
                wired by public/js/node-pill.js / wallet-sheet.js. Tapping opens
                the same detail sheets the old header pill/chip opened.
            */}
            <button
              id="drawer-row-node"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <span id="drawer-node-dot" className="w-2.5 h-2.5 rounded-full bg-zinc-400 shrink-0" aria-hidden="true">
              </span>
              <span className="text-sm font-medium">
                Node
              </span>
              <span id="drawer-node-status" className="ml-auto text-xs font-medium text-zinc-400">
              </span>
            </button>
            <button
              id="drawer-row-wallet"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
                />
              </svg>
              <span className="text-sm font-medium">
                Wallet
              </span>
              <span
                id="drawer-wallet-balance"
                className="ml-auto text-xs font-semibold text-violet-600 dark:text-violet-400"
              >
              </span>
            </button>
            {/*
                Members & visibility used to be a drawer row here; #645 moved it
                into the Dev tab's "+" menu (see AppView._wirePlusMenu).
                "View on GitHub" and "Share App" used to be here too; they are
                the LAST two items of #drawer-footer at the bottom of the panel
                now (same ids, same lifecycle).
            */}
            {/*
                MAIN NAV ORDER — Profile, Leaderboard, Settings, Admin &
                moderation. Personal-first, then shared, then configuration,
                then the admin surface; the app-scoped and reference rows sit
                outside this group (status pane above, footer below).
            */}
            {/*
                Profile — web screen (#profile hash route, public/js/profile.js;
                profile-and-settings-to-web migration). Always visible: the row
                used to be hidden until the Usernode bridge reported the
                getProfileInfo capability, but /challenges-api/me/* scopes to
                the platform session server-side since the topochain merge, so
                the screen works in any browser. Real anchor (like Challenges)
                so hash navigation drives the screen. The former native-push
                Profile / App Settings rows are gone: App Settings merged into
                the Settings modal as capability-gated sections (settings.js).
                
                #982: when the viewer has set a profile picture, it REPLACES the
                generic person glyph here — App.applyUserAvatar (public/js/app.js)
                swaps which of the two is `hidden` from App.user.avatarUrl, so the
                row shows the same face the profile screen does. The <img> ships
                hidden with no src: a signed-out shell and a user with no picture
                both keep the glyph, and nothing requests /avatars/ until there is
                something to request.
            */}
            <a
              id="drawer-row-profile"
              href="#profile"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg
                id="drawer-profile-glyph"
                className="w-5 h-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              <img
                id="drawer-avatar"
                alt=""
                className="hidden w-5 h-5 shrink-0 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800"
              />
              <span className="text-sm font-medium">
                Profile
              </span>
            </a>
            {/*
                Leaderboard — the one entry point for shared progress: the
                Topochain standings (the primary tab, and what the bare
                #leaderboard hash opens), the Kudos leaderboard and the season's
                challenges, three tabs on a single screen. This row replaces the header
                trophy (#leaderboard-btn), the old
                #drawer-row-topochain-leaderboard, and the separate Challenges /
                Topochain-seasons rows that used to sit under it. Keeps the
                trophy icon the header used. Real anchor so hash navigation
                drives the screen; the handler in HeaderMenu.init just closes
                the drawer.
            */}
            <a
              id="drawer-row-leaderboard"
              href="#leaderboard"
              className="flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6"
                />
              </svg>
              <span className="text-sm font-medium">
                Leaderboard
              </span>
            </a>
            {/*
                Settings — always shown; green dot is the BYOK "key configured"
                indicator, toggled directly by settings.js _renderIndicator().
                Real anchor (like Challenges / Profile) since Settings became the
                #settings screen: navigation rides the anchor's hash and the click
                handler in App.HeaderMenu.init just closes the drawer.
            */}
            <a
              id="drawer-row-settings"
              href="#settings"
              className="flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="text-sm font-medium">
                Settings
              </span>
              <span
                id="drawer-byok-dot"
                className="hidden ml-auto w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                aria-hidden="true"
              >
              </span>
            </a>
            {/*
                Admin & moderation console entry point (#588 shipped it as a
                header shield icon; the header slim-down moved it here). Sits
                immediately after Settings.
                
                Ships `hidden` and is revealed by App.renderAdminButton() for
                platform admins AND view-only admins — i.e. gated on
                `App.user.isAdmin`, which BOTH roles carry, and deliberately NOT
                on `canAdminWrite` (that's the full-admin-only mutation gate, so
                it would hide the console from view-only admins who are exactly
                the moderation audience). Never gated on USERNODE_ENV: the row
                must exist identically in staging and production. Navigation
                rides the anchor's #admin hash, which navigateToAdminConsole
                re-gates server-side-enforced.
            */}
            <a
              id="drawer-row-admin"
              href="#admin"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] border-b border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
              <span className="text-sm font-medium">
                Admin &amp; moderation
              </span>
            </a>
          </div>
          {/*
              ── Drawer footer ────────────────────────────────────────────────
              Reference + app-scoped link rows, pinned to the FOOT of the
              panel: `mt-auto` inside #header-menu-rows' column flex hugs the
              bottom of the viewport whenever the rows above leave free space,
              and degrades to "just at the end of the scroll" when they don't
              (touch sheet, short viewport). No JS, no measurement.
              
              The two build lines render as PLAIN TEXT rather than pills — the
              old "usernode · 1a2b3c4" pill overflowed the 15rem panel, and a
              version you can't act on doesn't need pill chrome. The slots keep
              their ids, so App.renderPlatformVersionPill /
              AppView.refreshVersionPill / AppView.renderForkBadge all still
              resolve them by getElementById; the renderers just emit the
              .drawer-ver text form for these two (see the `plain` flag on
              AppView.renderAppVersionPillHTML).
              
              GitHub + Share are the last two items, on the same
              app-open lifecycle they had as mid-list rows (App.openApp /
              navigate* toggle their `hidden`).
          */}
          <div id="drawer-footer" className="mt-auto shrink-0 border-t border-zinc-100 dark:border-zinc-800">
            {/*
                Display utilities stay in the markup (never in .drawer-ver-row)
                so the `hidden`-toggling rows below keep behaving exactly as
                they did: Tailwind's `hidden` must win over the row's own
                `flex`, which it can only do reliably against another Tailwind
                utility. .drawer-ver-row carries typography + metrics only.
            */}
            <div id="drawer-row-platform-version" className="drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                Platform version
              </span>
              <span
                id="platform-version-pill-slot"
                className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end"
              >
              </span>
            </div>
            {/*
                App build — revealed by App.DrawerStatus.setAppOpen() whenever an
                app is open, on the same lifecycle as #drawer-row-github /
                #drawer-row-share.
            */}
            <div id="drawer-row-app-version" className="hidden drawer-ver-row flex items-center gap-2 px-4">
              <span className="drawer-ver-label">
                App version
              </span>
              <span id="app-version-pill-slot" className="drawer-ver-value ml-auto inline-flex min-w-0 justify-end">
              </span>
            </div>
            {/*
                Fork lineage: amber "⑂ Forked from <name>" label, written by
                AppView.renderForkBadge() and revealed by
                App.DrawerStatus.setForkVisible(). Sits directly under the app
                build line so the two read as one app-scoped block.
            */}
            <div id="drawer-row-app-fork" className="hidden drawer-ver-row items-center gap-2 px-4">
              <span id="app-fork-badge-slot" className="ml-auto inline-flex min-w-0 justify-end">
              </span>
            </div>
            {/* View on GitHub — only shown when app is open and has a repo */}
            <a
              id="drawer-row-github"
              href="#"
              target="_blank"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] border-t border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span className="text-sm font-medium">
                View on GitHub
              </span>
            </a>
            {/* Share App — only shown when app is open and running */}
            <button
              id="drawer-row-share"
              className="hidden flex items-center gap-3 px-4 min-h-[44px] w-full text-left border-t border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
              <span className="text-sm font-medium">
                Share App
              </span>
            </button>
          </div>
        </div>
      </div>
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
      {/* Register screen (activation-code flow) */}
      <main
        id="auth-register-screen"
        className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
      >
        <a
          href="#"
          data-auth-back=""
          className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
        >
          &larr; Back
        </a>
        <div className="min-h-full flex items-center justify-center">
          <div className="w-full max-w-sm px-6 py-16">
            <h1 className="text-2xl font-bold text-center mb-1">
              Usernode Social Vibecoding
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center mb-2 italic">
              A place where users own and build apps together
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mb-8">
              Create your account
            </p>
            <form id="register-form" className="space-y-4">
              <div>
                <label htmlFor="reg-code" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Activation Code
                </label>
                <input
                  id="reg-code"
                  name="code"
                  type="text"
                  required={true}
                  autoComplete="off"
                  className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono"
                  placeholder="enter activation code"
                />
              </div>
              <div>
                <label
                  htmlFor="reg-username"
                  className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
                >
                  Username
                </label>
                <input
                  id="reg-username"
                  name="username"
                  type="text"
                  required={true}
                  autoComplete="username"
                  className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  placeholder="choose a username"
                />
              </div>
              <div>
                <label
                  htmlFor="reg-password"
                  className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
                >
                  Password
                </label>
                <input
                  id="reg-password"
                  name="password"
                  type="password"
                  required={true}
                  autoComplete="new-password"
                  className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  placeholder="choose a password"
                />
              </div>
              <div id="reg-error" className="text-red-400 text-sm hidden">
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 font-medium transition-colors text-white"
              >
                Register
              </button>
            </form>
            <p className="text-center text-sm text-zinc-500 dark:text-zinc-400 mt-6">
              Already have an account?
              <a href="#login" className="text-violet-400 hover:text-violet-300">
                Log in
              </a>
            </p>
          </div>
        </div>
      </main>
      {/*
          Waiting-room screen (platform-access gate, onboarding flow
          alignment): an authed session without hasPlatformAccess lands
          here; polls /api/auth/me and boots the full shell in place when
          access is granted.
      */}
      <main
        id="auth-waiting-screen"
        className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
      >
        <div className="min-h-full flex items-center justify-center">
          <div className="w-full max-w-sm px-6 py-16 text-center">
            <h1 className="text-2xl font-bold mb-1">
              You're in the queue
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-8 italic">
              Usernode Social Vibecoding
            </p>
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-5 text-left space-y-3">
              <p className="text-sm">
                Your account
                <span id="waiting-who" className="font-semibold">
                </span>
                doesn't have
            platform access yet. We let people in from the waitlist in batches —
            you'll get in automatically when your turn comes.
              </p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                This page checks for you every so often; you can also just come back later.
              </p>
              <p id="waiting-check-state" className="text-xs text-zinc-400 dark:text-zinc-500">
              </p>
            </div>
            <div className="mt-6 space-y-3">
              <a
                href="#landing"
                className="block w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 font-medium transition-colors text-white"
              >
                Browse public apps while you wait
              </a>
              <button
                id="waiting-logout"
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </main>
      {/*
          Stage-1 waitlist survey — its own screen (#waitlist), reached from
          the landing CTA block's link and the persistent header's "Join
          waitlist" button. It used to render flat inside the landing CTA
          block, which pushed the app directory far down the page. Same shape
          as #auth-more-screen: a corner Back link (data-auth-back → #landing)
          over a narrow scrolling column. Deliberately NOT a <header> element —
          header-layout.js measures document.querySelector('header') and must
          keep resolving to #platform-header.
      */}
      <main
        id="auth-waitlist-screen"
        className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
      >
        <a
          href="#landing"
          data-auth-back=""
          className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
        >
          &larr; Back
        </a>
        <div className="max-w-2xl mx-auto px-6 py-16">
          <h1 className="text-2xl font-bold">
            Join the waitlist
          </h1>
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Usernode Social Vibecoding is a place where users describe the app
        they want in chat, an AI builds it, and the community votes the
        changes in. Every app in the directory was built here by the people
        who use it — they run on the Usernode chain, and contributors own a
        share of what they build.
          </p>
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Platform access opens in batches. Join the waitlist and we'll email
        you when your spot opens — the public apps are open to everyone right
        now.
            <span className="font-medium text-zinc-700 dark:text-zinc-200">
              Four questions to join.
            </span>
          </p>
          {/*
              Stage-1 waitlist survey (two-stage waitlist, ported from the
              original topochain waitlist): email, something you've made,
              where you are, how you found us. Option chips and the country
              list render from GET /api/public/waitlist/options so the form
              and server validation share one definition.
          */}
          <form id="waitlist-form" className="mt-8 space-y-5">
            <div>
              <label htmlFor="waitlist-email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Your email address
                <span className="text-red-500">
                  *
                </span>
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                We only email you when your spot comes up. No newsletter.
              </p>
              <input
                id="waitlist-email"
                type="email"
                required={true}
                maxLength={255}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div>
              <label
                htmlFor="waitlist-made-url"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                Link something you&rsquo;ve made
                <span className="text-red-500">
                  *
                </span>
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                A repo, a site, a bot, a mod, a newsletter, a spreadsheet that runs your fantasy league. Built with AI counts — we care that it exists, not how you made it.
              </p>
              <input
                id="waitlist-made-url"
                type="url"
                maxLength={2000}
                placeholder="https://"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <input
                id="waitlist-made-note"
                type="text"
                maxLength={140}
                placeholder="What is it, in one line? — optional"
                className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Where are you?
                <span className="text-zinc-400 font-normal">
                  Optional
                </span>
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                We balance each group across regions. It&rsquo;s never used to reject anyone — leave it blank if you&rsquo;d rather not say.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  id="waitlist-country"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                >
                  <option value="">
                    Select a country&hellip;
                  </option>
                </select>
                <input
                  id="waitlist-city"
                  type="text"
                  maxLength={120}
                  placeholder="City"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                How did you find us?
                <span className="text-red-500">
                  *
                </span>
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
                Pick the closest one.
              </p>
              <div id="waitlist-discovery-chips" className="flex flex-wrap gap-1.5">
              </div>
              <input
                id="waitlist-discovery-detail"
                type="text"
                maxLength={255}
                placeholder="Which one? — optional"
                className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <input
                id="waitlist-referrer"
                type="text"
                maxLength={255}
                placeholder="Did someone refer you? Their handle — optional"
                className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <button
              type="submit"
              id="waitlist-submit"
              className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-5 py-2 text-sm font-medium text-white transition-colors"
            >
              Join the waitlist
            </button>
          </form>
          <p id="waitlist-msg" className="hidden text-sm mt-3">
          </p>
          {/*
              Success state: joined. Stage 2 is offered straight away —
              people are most willing to keep answering right after they
              commit; the join email carries the same link for anyone who
              stops here.
          */}
          <div id="waitlist-joined" className="hidden mt-8">
            <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
              You're on the waitlist — we'll email you when your spot opens.
            </p>
            <div
              id="waitlist-more-offer"
              className="hidden mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 p-4"
            >
              <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">
                Optional — moves you up the list
              </p>
              <h3 className="mt-1 text-base font-semibold">
                Want in sooner?
              </h3>
              <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                Four more questions, about three minutes — the group you&rsquo;d bring,
            a tool you&rsquo;ve lost, where else you are. These are the answers we
            actually read when we pick the next group.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <a
                  id="waitlist-more-link"
                  href="#landing"
                  className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                >
                  Answer them now
                </a>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Or stop here — you&rsquo;re on the list either way, and the link is in your email.
                </span>
              </div>
            </div>
          </div>
          {/*
              Swapped in for the form when a (waiting-room) session exists —
              they already have an account in the queue, so asking them to
              join again is wrong. Mirrors #landing-cta-queued.
          */}
          <p id="waitlist-queued" className="hidden mt-8 text-sm text-zinc-500 dark:text-zinc-400">
            You're already on the waitlist — we'll email you when your spot opens.
          </p>
        </div>
      </main>
      {/*
          Stage-2 waitlist survey — "Want in sooner?" (#more/<token>, two-
          stage waitlist ported from the original topochain waitlist). All
          questions optional; answers merge server-side so the form is
          re-openable from the join email. GitHub / X verify via the
          /waitlist/connect OAuth round-trip when the platform has creds.
      */}
      <main
        id="auth-more-screen"
        className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
      >
        <a
          href="#landing"
          className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
        >
          &larr; Back
        </a>
        <div className="max-w-2xl mx-auto px-6 py-16">
          <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">
            Optional — moves you up the list
          </p>
          <h1 className="mt-1 text-2xl font-bold">
            Want in sooner?
          </h1>
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Four more questions, about three minutes. These are the answers we
        actually read when we pick the next group, so they&rsquo;re worth more
        than the order you signed up in. Every one is optional, and you can
        come back and add to this any time.
          </p>
          {/* Bad/expired token state */}
          <div
            id="more-invalid"
            className="hidden mt-6 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300"
          >
            This link doesn't look right — use the one from your waitlist email,
        or
            <a href="#landing" className="underline">
              join the waitlist
            </a>
            first.
          </div>
          <form id="more-form" className="hidden mt-6 space-y-8">
            {/* 5 · The group */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Tell us about a group you&rsquo;re part of that could use its own app.
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
                A team, a server, a club, a group chat, a co-op, a band, a league, a neighbourhood. Not a hypothetical one — a real group you&rsquo;re actually in.
              </p>
              <input
                id="more-group-name"
                type="text"
                maxLength={255}
                placeholder="A 200-person Discord for indie game devs in Lagos"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  id="more-group-size"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                >
                  <option value="">
                    Roughly how many people?
                  </option>
                </select>
                <select
                  id="more-group-role"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                >
                  <option value="">
                    Your role in it
                  </option>
                </select>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 mb-1.5">
                What does it run on today? — pick any
              </p>
              <div id="more-group-tools" className="flex flex-wrap gap-1.5">
              </div>
              <textarea
                id="more-group-need"
                rows={3}
                maxLength={800}
                placeholder="What would its own app do that those tools can't? Money, membership, voting, scheduling, reputation, records…"
                className="mt-3 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              >
              </textarea>
            </div>
            {/* 6 · The loss */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Ever had a tool you relied on get killed, paywalled, or ruined?
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
                An app, a platform, a service, a game, a community. The kind of thing that made you look for something like this in the first place.
              </p>
              <div id="more-loss-had" className="flex flex-wrap gap-1.5">
              </div>
              <div id="more-loss-detail" className="hidden mt-3 space-y-2">
                <input
                  id="more-loss-product"
                  type="text"
                  maxLength={255}
                  placeholder="Which one? Google Reader, a Discord server, a game's private servers, an API…"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
                  What happened? — pick any
                </p>
                <div id="more-loss-kinds" className="flex flex-wrap gap-1.5">
                </div>
                <textarea
                  id="more-loss-story"
                  rows={3}
                  maxLength={800}
                  placeholder="What happened, and what did you do next? Where did everyone go? Did you move them somewhere? Rebuild it? Give up?"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                >
                </textarea>
              </div>
            </div>
            {/* 7 · Handles */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Where else are you?
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
                Connecting an account proves you&rsquo;re a person with a history, which is most of what gets a signup read quickly.
              </p>
              <div id="more-connect-row" className="flex flex-wrap gap-2 mb-3">
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  id="more-handle-farcaster"
                  type="text"
                  maxLength={255}
                  placeholder="Farcaster — @handle"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
                <input
                  id="more-handle-discord"
                  type="text"
                  maxLength={255}
                  placeholder="Discord — username"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
                <input
                  id="more-handle-telegram"
                  type="text"
                  maxLength={255}
                  placeholder="Telegram — @handle"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
                <input
                  id="more-handle-other"
                  type="text"
                  maxLength={255}
                  placeholder="Anywhere else — Twitch, YouTube, Mastodon…"
                  className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
              </div>
            </div>
            {/* 8 · Friends */}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Would you join with friends?
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
                A network is more fun with people you already know. Drop their handles or emails and we&rsquo;ll try to bring you in together.
              </p>
              <div id="more-invites" className="space-y-2">
              </div>
              <button
                type="button"
                id="more-invite-add"
                className="mt-2 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline"
              >
                + Add another
              </button>
              <label className="mt-3 flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer">
                <input
                  id="more-admit-together"
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 rounded accent-violet-600"
                />
                Only let me in when at least one of them gets in too
              </label>
              <input
                id="more-referrer"
                type="text"
                maxLength={255}
                placeholder="Did someone here refer you? Their handle — optional"
                className="mt-3 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5">
              <button
                type="submit"
                id="more-save"
                className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-6 py-2 text-sm font-medium text-white transition-colors"
              >
                Save my answers
              </button>
              <p id="more-msg" className="hidden text-sm mt-3">
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-3">
                A blank answer just means we have less to go on — nothing here is required.
              </p>
            </div>
          </form>
        </div>
      </main>
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
      {/* Notifications dropdown (top-right anchored). */}
      <div
        id="notifications-panel"
        className="hidden fixed top-14 right-3 z-50 w-80 max-w-[95vw] max-h-[70vh] flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Notifications
          </span>
          <span className="flex-1">
          </span>
          <button
            id="notifications-mark-all"
            className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-40"
            disabled={true}
          >
            Mark all read
          </button>
        </div>
        {/*
            Pinned collaborator-invites section: rendered above the grouped
            notification list, driven by the authoritative pendingInvites
            payload (see public/js/notifications.js renderInvites).
        */}
        <div id="notifications-invites" className="shrink-0 overflow-y-auto max-h-48">
        </div>
        <div id="notifications-list" className="flex-1 overflow-y-auto">
        </div>
        <div id="notifications-empty" className="hidden px-4 py-6 text-sm text-zinc-500 text-center">
          You'll get pinged here when someone proposes a change to an app you use.
        </div>
      </div>
      {/*
          Header-cog "your work" drawer (public/js/work-drawer.js): the
          viewer's session-related notifications (pinned "Needs attention"
          section), dev sessions and open proposals. Same chrome/position
          as the notifications panel above.
      */}
      <div
        id="work-drawer-panel"
        className="hidden fixed top-14 right-3 z-50 w-80 max-w-[95vw] max-h-[70vh] flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Your work
          </span>
          <span className="flex-1">
          </span>
          <button
            id="work-drawer-mark-all"
            className="hidden text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Mark all read
          </button>
          <button
            id="work-drawer-close"
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div id="work-drawer-list" className="flex-1 overflow-y-auto">
        </div>
        <div id="work-drawer-empty" className="hidden px-4 py-6 text-sm text-zinc-500 text-center">
          Nothing in flight — start a dev session from any app's Dev tab.
        </div>
      </div>
      {/* Developer console (slide-up panel, anchored to bottom) */}
      <div
        id="dev-console-panel"
        className="hidden fixed left-0 right-0 bottom-0 z-50 flex flex-col bg-zinc-950 border-t border-zinc-700"
        style={{ height: "40vh", maxHeight: "60vh" }}
      >
        <div className="flex items-center gap-3 px-3 py-2 border-b border-zinc-800 shrink-0 text-sm">
          <span className="font-medium text-zinc-200">
            Developer console
          </span>
          <span id="dev-console-counts" className="text-xs text-zinc-500">
          </span>
          <span className="flex-1">
          </span>
          <select
            id="dev-console-filter"
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200"
          >
            <option value="all">
              All
            </option>
            <option value="error">
              Errors
            </option>
            <option value="warn">
              Warnings
            </option>
            <option value="info">
              Info
            </option>
            <option value="log">
              Log
            </option>
            <option value="debug">
              Debug
            </option>
          </select>
          <button id="dev-console-clear" className="text-xs text-zinc-400 hover:text-zinc-200">
            Clear
          </button>
          <button id="dev-console-close" className="text-zinc-400 hover:text-zinc-100" aria-label="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div
          id="dev-console-log"
          className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed p-2 space-y-0.5"
        >
        </div>
        <div
          id="dev-console-empty-hint"
          className="hidden px-3 py-2 text-xs text-zinc-500 border-t border-zinc-800 shrink-0"
        >
          No messages yet. If this app was created before dev-console support shipped, ask the coding agent in Dev Chat to "add dev-console forwarding to public/index.html".
        </div>
      </div>
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
          App-as-SV-chrome (NATIVE-BRIDGE.md): shared capability probe +
          drawer native rows, then the header node pill and wallet sheet.
          native-chrome.js must load before node-pill.js / wallet-sheet.js
          (both consume NativeChrome.has). All three no-op outside the
          Usernode app webview.
      */}
      <script src="/js/native-chrome.js" />
      <script src="/js/node-pill.js" />
      <script src="/js/wallet-sheet.js" />
      <script src="/js/dev-host.js" />
      <script src="/js/header-layout.js" />
      <script src="/js/dev-console.js" />
      {/*
          #138: dev-chat completion alerts (chime + OS notification). Loaded
          before notifications.js / dev-chat.js, which both reference DevAlerts.
      */}
      <script src="/js/dev-alerts.js" />
      <script src="/js/notifications.js" />
      <script src="/js/social-push.js" />
      {/*
          Webview-safe replacement for window.confirm(). Loaded before any
          feature script that wants a "really?" gate (dev-chat archive,
          future settings/home destructive actions).
      */}
      <script src="/js/confirm-modal.js" />
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
      {/*
          Header-cog "your work" drawer. Loaded after notifications.js
          (whose shared renderRow / items store it reuses) and after
          merge-status.js (whose lifecycle helper drives the spin state and
          the proposal chips).
      */}
      <script src="/js/work-drawer.js" />
      <script src="/js/dev-chat.js" />
      {/*
          Kudos widget (button + budget badge) and leaderboard screen.
          Loaded BEFORE app-view.js so the panel renderer can use
          Kudos.renderButton directly.
      */}
      <script src="/js/kudos.js" />
      {/*
          AI-credit status rows (#555): the viewer's daily AI allowance, and
          (admins only) the org's remaining Anthropic credit. Modelled on
          Kudos.Budget above — same status-pane slot pattern, same
          poll-then-render shape — so it loads alongside it.
      */}
      <script src="/js/ai-credit.js" />
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
