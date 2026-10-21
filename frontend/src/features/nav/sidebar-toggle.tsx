/**
 * #sidebar-toggle — collapse and expand the desktop rail, and an app's way back.
 *
 * ── Why the bar needs one at all ───────────────────────────────────────
 *
 * The rail spends 224px of every desktop window, permanently, on five links
 * a reader may know by heart after a day. Every host in the design study that
 * draws a persistent rail also draws a way to fold it — VS Code, Slack,
 * Linear, Notion — and the prototype drew one in the top bar's left corner,
 * which is where every one of those puts it.
 *
 * ── It is a TOGGLE, and says so ────────────────────────────────────────
 *
 * `aria-pressed` carries the state, so the label can stay the ACTION ("Hide
 * sidebar" / "Show sidebar") rather than describing the current arrangement.
 * The glyph does not flip with it, for the reason its own note in
 * @/components/ui/icons.tsx gives: an icon that changes as well makes the
 * reader work out whether it is showing where they are or where the press
 * would take them.
 *
 * ── Where it is, and where it is not ───────────────────────────────────
 *
 * The header's LEFT GROUP, beside the back slot. That slot is empty on a tab
 * root (App._BACK_SLOT) and carries a chevron on a sub-page, and this sits
 * before either — the same corner the prototype and all four of those
 * products use.
 *
 * DESKTOP ONLY, and app.css decides where it is SEEN, not this component:
 * below 768px a phone's bar is at the foot and folding it would leave a
 * reader with no navigation and no hover to bring it back. The route decides
 * whether there is a rail at all, and the note on the component below says
 * why none of that may be a render-time question.
 *
 * ── The press is the only door in an open app (#3138) ──────────────────
 *
 * An app used to raise the rail whenever the pointer reached the window's
 * left edge. That made navigation appear over somebody working in the app's
 * own left column, so the edge is the app's again. This button, which the
 * header carries in an app, is the way back: one press fades the rail in over
 * the app and PINS it there, and the same press fades it away. Going
 * somewhere from the rail leaves the app the way tapping a tab always does.
 *
 * The peek keeps its old pointer behaviour where the route HAS a rail: with
 * the rail folded, pointing at this button still fades it in, which is what
 * #2764 added. A press-opened peek is pinned instead (`peekPinned`), because
 * the pointer never summoned it and leaving is not a signal to take it away.
 *
 * ── Collapsed is the app view's state, reached another way ─────────────
 *
 * Folding the rail puts the shell in exactly the arrangement an open app
 * already produces: no band reserved, the page full width, and this button
 * to bring it back. That is why this needs no CSS of its own beyond being
 * hidden on a phone and shown in an app — the layout it asks for is one the
 * stylesheet already draws.
 *
 * The enter/leave pair is ./rail-peek.ts's, shared with the rail so the
 * pointer can cross from here onto it inside one grace period. Handlers
 * only — nothing about the markup changes with the peek.
 */

import { useState } from 'react';

import { SidebarIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { readVisibility, useVisibility } from '../../lib/visibility-store';
import { navStore } from './nav-store.js';
import { clearPeekTimer, dismissPeek, enterPeek, leavePeek } from './rail-peek';

// THE SAME DISC the back slot beside it wears — ../header/platform-header.tsx
// hoists its own for the same reason: a class string that spans lines ships
// its newlines into the attribute, and every class here has to stay a
// complete literal for Tailwind's extractor, which is a regex over this text.
//
// No `inline-flex`: app.css owns this control's `display`, because whether it
// exists at all is a question about the VIEWPORT and React does not know the
// viewport. `items-center justify-center` are inert until it does.
//
// NO DISC AT REST (#2798). The periwinkle tint used to sit behind the glyph
// all the time, which made a plain toggle read as a pressed, highlighted
// control. It shows on HOVER now, the same tint and hairline, and the border
// is transparent at rest so the hover does not shift the glyph by a pixel.
const TOGGLE_CLASS = 'platform-sidebar-toggle shrink-0 w-7 h-7 items-center justify-center'
  + ' rounded-full un-touch-target border border-transparent text-[color:var(--brand-ink)]'
  + ' hover:bg-[color:var(--brand-tint)] hover:border-[color:var(--brand-line)]';

export function SidebarToggle() {
  // IT ALWAYS RENDERS, and app.css decides whether it is seen (#2718 review).
  //
  // This read `useVisibility('platform-tabs')` and returned null on a route
  // with no rail, which is the right ANSWER reached the wrong way: the
  // visibility store is published by public/js/app.js — a classic script,
  // which runs before this deferred module hydrates — so the prerender drew
  // the button from the default `true` and the first client render dropped
  // it. React error #418 on every route, and a console error fails every
  // declared check.
  //
  // The markup is therefore constant and CSS decides where it is shown: the
  // rules in app.css read `#platform-tabs` (a route with a rail) and
  // `#app-view` (a running app, #3138).
  const { railOpen, peek } = useStoreState(navStore);
  // THE ROUTE'S RAIL. An app publishes `platform-tabs` hidden — the app covers
  // the rail — and this button is what brings it back over the app. It also
  // decides whether pointing at the button may peek: only a rail the route
  // HAS can be folded and peeked back.
  const routeHasRail = useVisibility('platform-tabs', true);
  // THE FIRST RENDER IS THE PRERENDER (#3138). `routeHasRail` can already be
  // false here — app.js publishes it before this deferred bundle hydrates —
  // so computing the attributes from it during the hydrating render would say
  // "Show sidebar" where the prerendered button says "Hide sidebar". They
  // settle after hydration; the markup itself never varies.
  const [hydrated, setHydrated] = useState(false);
  useIsomorphicLayoutEffect(() => { setHydrated(true); }, []);
  // WHAT THE BUTTON IS DOING THE TOGGLE OF: the rail itself on a route that
  // has one, and the peek over a running app, where the route has none.
  const showing = hydrated ? (routeHasRail ? railOpen : peek) : railOpen;

  const onPress = () => {
    // THE ROUTE'S ANSWER, read live rather than from the render: a route with
    // a rail folds and unfolds it exactly as before.
    if (readVisibility('platform-tabs') !== false) {
      clearPeekTimer();
      navStore.set({ railOpen: !navStore.get().railOpen, peek: false, peekOut: false });
      return;
    }
    // A RUNNING APP HAS NO RAIL OF THE ROUTE'S, so the press owns the peek:
    // a showing, non-fading one is put away; otherwise the press brings it
    // back — cancelling a fade in progress — and pins it there.
    const { peek: showingPeek, peekOut } = navStore.get();
    if (showingPeek && !peekOut) {
      dismissPeek();
      return;
    }
    enterPeek();
    navStore.set({ peekPinned: true, railOpen: true });
  };

  const onHoverIn = () => {
    // POINTING STILL PEEKS A FOLDED RAIL ON THE PLATFORM'S OWN SCREENS. In a
    // running app there is no rail of the route's to fold, and the edge no
    // longer summons one; only the press above acts there.
    if (readVisibility('platform-tabs') === false) return;
    if (!navStore.get().railOpen) enterPeek();
  };

  return (
    <button
      id="sidebar-toggle"
      type="button"
      className={TOGGLE_CLASS}
      aria-pressed={showing ? 'true' : 'false'}
      aria-controls="platform-tabs"
      aria-label={showing ? 'Hide sidebar' : 'Show sidebar'}
      // A PRESS THAT FOLDS ENDS ANY HOVER PEEK. Docking the rail makes the
      // peek moot, and left standing it would come straight back as an
      // overlay the moment the next press folded the rail under the same
      // pointer. In an app the same handler is the peek's own door.
      onClick={onPress}
      onMouseEnter={onHoverIn}
      onMouseLeave={peek ? leavePeek : undefined}
    >
      <SidebarIcon className="w-5 h-5" />
    </button>
  );
}
