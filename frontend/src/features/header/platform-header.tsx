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
 * (App.setBackIcon on #back-btn, the title text, the badges), so React must
 * never reconcile over those nodes: every class string below is a constant
 * prop, rendered once at hydration and never again. The ONE exception is
 * <ImproveButton/>, which is React-owned end to end — see its own header.
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
  ChatIcon,
  ChevronLeftIcon,
  HomeIcon,
} from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { ChromelessPill } from './chromeless-pill';
import { ImproveButton } from '../improve/improve-button';
import { ImproveViewToggle } from '../improve/view-toggle';
import { improveStore } from '../improve/improve-store.js';
import { SwitcherChip } from '../switcher/switcher-chip';
import { useStoreState } from '../../lib/use-store-state';
import { NotificationsSheet } from '../notifications/sheet-controller.js';
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

  // #1436: the title names the SCREEN (Settings, Profile, Messages…) and the
  // chip names the APP, so exactly one of them shows. `improveStore.target` is
  // the same condition the chip renders on, which keeps them from ever both
  // being on screen or both being absent.
  //
  // Via useHiddenClass rather than a rendered `className` for the usual
  // reason: use-header-layout.ts toggles `.is-centered` on this same node at
  // runtime, so React re-rendering the attribute would drop it.
  const { target } = useStoreState(improveStore);
  useHiddenClass(titleRef, !!target);

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
            20px wide (never changes — use-header-layout.ts measures this as
            the title's left side group, via leftGroupRef), 28px tall (the
            header's content-row floor), with the 20px icon centred inside it.
        */}
        {/*
            #1436: the left group holds the back affordance AND the app-switcher
            chip now, so it is no longer a fixed 20px column — the `w-5` moved
            onto an inner wrapper so the back button keeps its own invariant
            width (toggling its `hidden` must not collapse the column and shift
            the title) while the chip adds width only when it is showing.
        */}
        <div ref={leftGroupRef} className="h-7 shrink-0 flex items-center gap-2">
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
          <a id="back-btn" className="inline-flex items-center text-zinc-900 hover:text-zinc-500 dark:text-zinc-100 dark:hover:text-zinc-400 un-touch-target hidden" aria-label="Home">
            <HomeIcon id="back-icon-home" className="w-5 h-5" />
            <ChevronLeftIcon id="back-icon-arrow" className="w-5 h-5 hidden" />
          </a>
        </div>
          {/* The app-switcher chip (#1436). Renders only where
              improve-store.js carries a target, which is the same lifecycle
              #improve-btn has — and is what makes it mutually exclusive with
              the title below. */}
          <SwitcherChip />
        </div>
        <h1
          ref={titleRef}
          id="header-title"
          className={"flex-1 min-w-0 text-lg font-bold pointer-events-none truncate\n               text-left"}
        >
          Social Vibecoding
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
              The App / Feed / Kanban toggle, immediately LEFT of the Improve
              button (#1367), on wide screens only — the component carries its
              own `hidden sm:inline-flex`, and below that breakpoint the copy
              inside the Improve panel is the one on screen. Switching views is
              the thing people do most often in an app, and behind a sheet it
              cost two taps and a dismissal.

              Inside the right-group div for the same reason #improve-btn is:
              rightGroupRef is what use-header-layout.ts measures as the
              title's right side group. A control parked outside it would not
              count towards the clearance the centering decision needs, and the
              title would overlap it at exactly the widths where this renders.
          */}
          <ImproveViewToggle compact={true} />
          {/*
              The bell (#notifications-btn) used to sit here, between Improve
              and the hamburger. THE UI OVERHAUL merged it INTO the hamburger:
              two top-right drawers that opened the same way, one slot apart,
              were one affordance too many, and the notifications list is the
              first thing in that panel now. Its unread badge merged too — see
              #notifications-badge on the hamburger below, which
              Notifications._renderBadge paints exactly as it painted this one.
          */}
          {/*
              #1436: MESSAGES and the BELL, the two inboxes, each with its own
              control and its own badge.

              They were one row and one list inside the hamburger, which is
              also why a single incoming direct message used to light TWO
              badges: `conversation_message` is a notification kind, so it
              counted once on #drawer-messages-badge and again on the red
              count of the button that contained it. Two colours, one event.
              The rule now is one event, one badge, on the surface that owns
              it — see Notifications._renderBadge, which excludes the
              conversation kind from the bell's count.

              Messages is a real ANCHOR, not a button: `#messages` is a route
              with per-conversation routes under it, so cmd/ctrl-click and
              middle-click have to work. The bell opens a sheet, so it is a
              button.
          */}
          <a
            id="messages-btn"
            href="#messages"
            className="relative w-7 h-7 flex items-center justify-center rounded-full bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 shadow-sm transition-colors un-touch-target text-zinc-900 dark:text-zinc-100 mr-2.5"
            aria-label="Messages"
          >
            <ChatIcon className="w-4 h-4" />
            {/* Same id and same writer as the drawer row's badge, so the
                Messages store keeps painting it with no change. Violet, not
                red: it is a count of conversations, and the bell beside it is
                the red one. */}
            <span
              id="drawer-messages-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-violet-600 text-white text-[0.65rem] font-bold flex items-center justify-center"
              aria-label="Unread messages"
            >
            </span>
          </a>
          <button
            id="notifications-btn"
            type="button"
            className="relative w-7 h-7 flex items-center justify-center rounded-full bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 shadow-sm transition-colors un-touch-target text-zinc-900 dark:text-zinc-100 mr-2.5"
            aria-label="Notifications"
            aria-haspopup="dialog"
            onClick={() => NotificationsSheet.toggle()}
          >
            {/* 16px, matching #improve-btn's lightbulb and the chip's
                chevron, so every glyph on this bar carries one optical
                weight. */}
            <BellIcon className="w-4 h-4" />
            {/* THE RED UNREAD COUNT, back on the bell it was named for.
                Unchanged id, unchanged writer (Notifications._renderBadge),
                unchanged geometry — so it still reads as one badge convention
                with the green session count on #improve-btn. */}
            <span
              id="notifications-badge"
              className="hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-bold flex items-center justify-center"
            >
            </span>
          </button>
          {/* Improve is LAST, i.e. rightmost. It is the only control here
              that opens a list of choices rather than going somewhere, and
              the only one with a word on it — the thumb-nearest slot on a
              phone belongs to the product's primary action. */}
          <ImproveButton />
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
