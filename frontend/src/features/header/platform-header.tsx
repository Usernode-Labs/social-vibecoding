/**
 * #platform-header — the shell's top bar, as a React island (#1079 chunk B).
 *
 * The markup is the shell's, moved here verbatim: same ids, same class strings,
 * same order. What makes it an island rather than an extracted static component
 * is ./use-header-layout.ts, the port of the retired public/js/header-layout.js
 * — the one module that owned nodes in here, and now the only thing that writes
 * to this subtree from React's side.
 *
 * Everything INSIDE this bar is still written by public/js/app.js by id
 * (App.setBackIcon on #back-btn, the title text, #app-mode-switch's visibility,
 * the badges), so React must never reconcile over those nodes: every class
 * string below is a constant prop, rendered once at hydration and never again.
 *
 * The bar's OWN visibility is the one piece of state it holds. Chromeless mode
 * (`#app/<slug>/app`) hides the whole header, and App.setChromeless used to do
 * that with a classList toggle from outside React — the thing the migration's
 * visibility rule exists to stop. It publishes through
 * ../../lib/visibility-store now and this component subscribes, with `true` as
 * the initial value because the shipped markup ships the header visible.
 *
 * Even so the toggle lands via useHiddenClass rather than a rendered
 * `className`: PlatformUI.attachScreenFx is handed this element as its top bar
 * (app-view.js, group-chat.js) and the kit writes to it at runtime, so React
 * re-rendering the attribute would drop whatever the kit put there.
 */

import { useRef } from 'react';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { ChromelessPill } from './chromeless-pill';
import { useHeaderLayout } from './use-header-layout';

export function PlatformHeader() {
  // The four elements the centering measurement needs. Passing them as refs
  // replaces the classic script's document.querySelector('header') +
  // previousElementSibling / nextElementSibling walk.
  const headerRef = useRef<HTMLElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);

  useHeaderLayout(headerRef, leftGroupRef, titleRef, rightGroupRef);

  // Chromeless mode hides the bar and floats the "Open in Usernode" pill in
  // its place; App.setChromeless publishes the flag, this reads it.
  const visible = useVisibility('platform-header', true);
  useHiddenClass(headerRef, !visible);

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
          ./use-header-layout.ts, which observes header / right-group /
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
        ref={headerRef}
        id="platform-header"
        className="un-safe-top-extend relative flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0"
      >
        {/*
            20px wide (never changes — use-header-layout.ts measures this as
            the title's left side group, via leftGroupRef), 28px tall (the
            header's content-row floor), with the 20px icon centred inside it.
        */}
        <div ref={leftGroupRef} className="w-5 h-7 shrink-0 flex items-center">
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
          ref={titleRef}
          id="header-title"
          className={"flex-1 min-w-0 text-lg font-bold pointer-events-none truncate\n               text-left"}
        >
          dApps
        </h1>
        <div ref={rightGroupRef} className="ml-auto shrink-0 flex items-center">
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
              #drawer-row-wallet, populated by ./node-pill.js /
              ./wallet-sheet.js in the native top frame. Capability and state
              availability change their contents, never whether the rows exist.
          */}
          {/*
              App/Dev mode switch — replaced the full-width bottom tab bar
              that used to sit at the foot of #app-view. It MUST
              stay inside this right-group div: rightGroupRef is what
              use-header-layout.ts measures as the title's right side group, so
              a control moved out of it stops counting towards the clearance
              the centering measurement needs. (Until #1079 chunk B the group
              was resolved as the <h1>'s nextElementSibling, and a sibling
              wedged in between broke the measurement silently; the ref removed
              that particular trap, not the requirement.)
              
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
              Header cog: the "your work" drawer
              (features/work-drawer/work-drawer.js) —
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
          The chromeless-mode pill, mounted as a SIBLING of the bar it replaces
          (App._mountChromelessPill used to document.body.appendChild it, which
          put an un-hydrated node inside a body React now owns). It renders
          nothing at all until the flag flips, which is exactly what the shipped
          markup had here.
      */}
      <ChromelessPill />
    </>
  );
}
