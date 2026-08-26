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
 * (App.setBackIcon on #back-btn, the title text, the red unread badge), so
 * React must never reconcile over those nodes: every class string below is a
 * constant prop, rendered once at hydration and never again. The exceptions
 * are React-owned end to end: <ImproveButton/> (which carries the work-in-
 * flight indicators), <HeaderTitleTab/> and <HeaderAppIcon/> — all of whose
 * writers publish through improveStore rather than touching the DOM.
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

import {
  BellIcon,
  ChatBubbleTailIcon,
  ChevronLeftIcon,
  HomeIcon,
} from '@/components/ui/icons';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { backButtonStore } from './back-button-store.js';
import { ChromelessPill } from './chromeless-pill';
import { HeaderAppIcon } from './header-app-icon';
import { HeaderTitleTab } from './header-title-tab';
import { ImproveButton } from '../improve/improve-button';
import { improveStore } from '../improve/improve-store.js';
import { MergeStatusPill } from '../dev-chat/session-header';
import { sessionHeaderStore } from '../dev-chat/session-header-store';
import { useHeaderLayout } from './use-header-layout';
// ── The bundle's boot seam ────────────────────────────────────────────
//
// These six imports and the four inits below rode on the hamburger drawer's
// island for as long as there was one. They were never ABOUT the drawer: each
// installs a `window.*` global that app.js's boot looks for, and the drawer
// island simply happened to be the earliest thing in the bundle. This island
// is earlier still — it is the first one in Shell.tsx and it never unmounts —
// so the seam moves here rather than following any single row to its new home.
// Hanging a boot-time global off a surface nobody has opened yet would be a
// boot-order regression dressed up as tidiness.
//
// The AI-credit renderer, whose ROW is Settings → Anthropic API key. It
// installs window.AiCredit and App.init() calls AiCredit.Budget.init().
import './ai-credit.js';
// The installed mobile-app version, whose row is Settings' About block.
import './native-app-version.js';
import './node-pill.js';
import './wallet-sheet.js';
import './header-menu-controller.js';
// The Improve button's two publishers — what it is about, and what its
// version dot says. A side-effect module like the rest: it installs
// window.ImproveStatus, which app.js forwards onto as App.ImproveStatus.
import '../improve/improve-status.js';
// The bell's module. ../notifications/mount.ts installs the store's flush and
// publishes the controller; this pulls both in.
import '../notifications/mount';

/**
 * The session lifecycle pill, IN THE TOP BAR (Streamlined Concept): the
 * Figma session bar leads with ← and a `Checks run…` status pill, so the
 * MergeStatus lifecycle renders here — beside the back arrow — while a
 * session is on screen, instead of in the in-content strip it used to
 * share with the title. Same descriptor, same component, new seat: it
 * reads the session-header store dev-chat.js already publishes on every
 * lifecycle transition, so nothing new keeps it live.
 *
 * Renders nothing off the session screen (and at SSG, where no target
 * exists), so hydration matches the shipped bar byte for byte. ON the
 * session screen the HOST span always renders — the same always-there
 * contract the strip's #dc-status-pill kept — with the pill inside only
 * while the session has a lifecycle worth drawing.
 */
function SessionStatusPill() {
  const { tab, subTab } = useStoreState(improveStore);
  const { life } = useStoreState(sessionHeaderStore);
  if (tab !== 'dev' || subTab !== 'sessions') return null;
  return (
    <span id="header-status-pill" className="min-w-0 truncate">
      {life ? <MergeStatusPill life={life} /> : null}
    </span>
  );
}

// The anchor's own classes, hoisted out of the JSX so the `hidden` suffix is
// the ONLY thing that varies between the two states — the string itself has to
// stay byte-identical to the hand-written shell's (tests/baselines).
const BACK_BTN_CLASS = 'inline-flex items-center text-zinc-900 hover:text-zinc-500'
  + ' dark:text-zinc-100 dark:hover:text-zinc-400 un-touch-target';

export function PlatformHeader() {
  // The four elements the centering measurement needs. Passing them as refs
  // replaces the classic script's document.querySelector('header') +
  // previousElementSibling / nextElementSibling walk.
  const headerRef = useRef<HTMLElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);

  useHeaderLayout(headerRef, leftGroupRef, titleRef, rightGroupRef);

  // The back slot's state (see ./back-button-store.js): App.setBackIcon
  // publishes here rather than writing `hidden` into React-owned DOM.
  const { mode: backMode, href: backHref } = useStoreState(backButtonStore);
  const backArrow = backMode === 'arrow';

  // A LAYOUT effect, and that is load-bearing: it runs inside main.tsx's
  // flushSync(hydrateRoot), which is after hydration has adopted these nodes
  // and still before DOMContentLoaded — where the classic scripts' own init()
  // used to run. A passive effect could be scheduled after app.js's init, and
  // `sv:authed` fires at most once, so a late Notifications listener would
  // never get the first fetch.
  useIsomorphicLayoutEffect(() => {
    window.NodePill?.init();
    window.WalletSheet?.init();
    window.NativeAppVersion?.init();
    window.HeaderMenu?.init();
    window.Notifications?.init();
  }, []);

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
          public/css/app.css): this bar is `py-3` around a 28px content
          row, so it is 52px + safe-area on EVERY screen. The row height
          must not depend on which children happen to be present — the
          `h-7` on the back-btn wrapper below is the floor (it survives
          #header-title being display:none in the native WebView), and no
          direct child may exceed 28px (the ceiling).

          It was 53px until the reskin: there used to be a 1px `border-b`
          hairline here, and the border box counted it. The widget language
          draws NO rule under a top bar — the page ground runs to the top of
          the screen and the controls float on it — so the hairline went,
          from this bar and from #landing-header together. Parity is the
          invariant, not the number: both bars lost the same pixel.
      */}
      <header
        ref={headerRef}
        id="platform-header"
        className="un-safe-top-extend relative flex items-center gap-3 px-4 py-3 shrink-0"
      >
        {/*
            The LEFT group, and it is the board's own header cluster: ONE
            28px icon slot, then the title tab beside it.

            The slot has two occupants and they are disjoint BY ROUTING, not
            by a branch. The back anchor shows exactly when
            App.setBackIcon('arrow') has run — a dev session, a drilled
            settings/admin/browse level, or any of the root platform screens —
            and in every one of those states the improve store either has no
            target or is on the sessions subtab, which is precisely when
            <HeaderAppIcon/> renders null. Two owners, no shared state, no
            way for both to draw at once.

            The hamburger that used to lead this group is gone. Its badge
            cluster went with it, onto #improve-btn where the work it reports
            actually lives (see ../improve/improve-button.tsx).
        */}
        <div ref={leftGroupRef} className="h-7 shrink-0 flex items-center gap-1">
          <div className="w-7 h-7 shrink-0 flex items-center justify-center">
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

                RENDERED FROM A STORE, not written by classList from outside.
                setBackIcon used to toggle `hidden` on all three of these
                nodes directly, which held only while this island never
                re-rendered. It does now — the slot is `#back-btn` XOR
                <HeaderAppIcon/>, and the bar carries <SessionStatusPill/> —
                and React rewrites a rendered className from its own props on
                every render, so the legacy write was being undone. The store
                is ./back-button-store.js; setBackIcon publishes into it.
            */}
            <a
              id="back-btn"
              className={BACK_BTN_CLASS + (backArrow ? '' : ' hidden')}
              aria-label={backArrow ? 'Back' : 'Home'}
              {...(backHref ? { href: backHref } : {})}
            >
              <HomeIcon id="back-icon-home" className={'w-5 h-5' + (backArrow ? ' hidden' : '')} />
              <ChevronLeftIcon id="back-icon-arrow" className={'w-5 h-5' + (backArrow ? '' : ' hidden')} />
            </a>
            <HeaderAppIcon />
          </div>
          <SessionStatusPill />
        </div>
        {/*
            The center tab (Streamlined Concept): the screen's only h1, and —
            while an app context is on screen — a tappable "name ⌄" control
            that opens the app-context sheet. See header-title-tab.tsx.
        */}
        <HeaderTitleTab titleRef={titleRef} />
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

              THE UI OVERHAUL took four more out, and they all went to the
              same place — the Improve panel:

                #app-mode-switch   the App/Dev segmented control. An app is
                                   just an app now; "Dev" is a destination the
                                   panel links to rather than a mode the header
                                   toggles. `#improve-btn` inherits its exact
                                   show/hide lifecycle.
                #feedback-btn      → the panel's "Give feedback" row. Its
                                   outbox dot (#feedback-queue-dot) moved onto
                                   #improve-btn, keeping its id and its writer.
                #work-drawer-btn   → the panel's session sections, split into
                                   this app's and everything else.
                #dev-console-btn   → the panel's "Developer terminal" row,
                                   shown on the same DevConsole signal that
                                   used to show the button.

              What is left here is navigation + alerting only, in DOM order:
              improve, bell, hamburger (last).
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
              The Improve button. It MUST stay inside this right-group div:
              rightGroupRef is what use-header-layout.ts measures as the
              title's right side group, so a control moved out of it stops
              counting towards the clearance the centering measurement needs.
              (Until #1079 chunk B the group was resolved as the <h1>'s
              nextElementSibling, and a sibling wedged in between broke the
              measurement silently; the ref removed that particular trap, not
              the requirement.)

              Unlike everything else in this bar it is React-owned end to end —
              no public/js/** module writes to it — so its className is
              rendered rather than constant. See ../improve/improve-button.tsx.
          */}
          {/*
              The App / Feed / Kanban segmented control rode here between
              #1367 and the Streamlined Concept. The app-context sheet behind
              the center title tab is the view switcher now — a segmented
              control and a dropdown tab announcing the same three
              destinations would be two owners of one decision.
          */}
          {/*
              MESSAGES and NOTIFICATIONS, as the board's app-opened bar draws
              them: two glyphs to the left of Improve, each carrying its own
              unread badge.

              THE UI OVERHAUL folded both into the hamburger and the
              Streamlined Concept takes that back, for a reason the drawer
              makes concrete: that drawer is the APP's surface now (its views
              and its changes), so platform-wide alerting has no business
              inside it. Real anchors, so a modified click opens a tab, and
              the same hrefs the retired drawer rows carried.

              Both badges keep the ids and the writer they had as rows
              (Notifications._renderBadge), so nothing about how a count is
              computed changes — only which control wears it.
          */}
          <a
            id="messages-btn"
            href="#messages"
            className="relative w-7 h-7 mr-1 flex items-center justify-center un-touch-target text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Messages"
          >
            <ChatBubbleTailIcon className="w-5 h-5" />
            <span
              id="drawer-messages-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-violet-600 text-white text-[0.65rem] font-bold flex items-center justify-center"
              aria-label="Unread messages"
            >
            </span>
          </a>
          <a
            id="notifications-btn"
            href="#notifications"
            className="relative w-7 h-7 mr-1 flex items-center justify-center un-touch-target text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Notifications"
          >
            <BellIcon className="w-5 h-5" />
            <span
              id="notifications-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
              aria-label="Unread notifications"
            >
            </span>
          </a>
          <ImproveButton />
          {/*
              The bell (#notifications-btn) used to sit here, then THE UI
              OVERHAUL merged it into the hamburger — and the Streamlined
              Concept moved the hamburger itself to the LEFT group, badges
              and all, mirroring the drawer it opens. What remains on the
              right is the one contextual action: Improve (or the eye that
              returns to the app — see improve-button.tsx).
          */}
          {/*
              The "Create new app" entry point used to live here in the header
              as a "+" pill; it's been moved into the home-screen feed itself,
              rendered below the app list (and as the empty-state CTA when no
              apps exist). See frontend/src/features/home/home.js.
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
